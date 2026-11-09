/**
 * Local demo data: two rival contractors with separate users and projects.
 * Runs as the owner role but still sets the tenant context per tenant, so it
 * works identically on Aurora where the owner is subject to FORCE RLS.
 */
import { randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { createDb, withTenant } from './client';
import { projects, tenants, users } from './schema';
import type { ModuleId } from './modules';

interface DemoTenant {
  slug: string;
  name: string;
  tier: 'standard' | 'mid_market' | 'enterprise';
  modules: ModuleId[];
  ownerEmail: string;
  projects: { code: string; name: string; contractForm: string; contractValue: string }[];
}

const DEMO: DemoTenant[] = [
  {
    slug: 'demo-civils',
    name: 'Demo Civils (Pty) Ltd',
    tier: 'mid_market',
    modules: ['mod_commercial', 'mod_field', 'mod_finance'],
    ownerEmail: 'owner@demo-civils.test',
    projects: [
      { code: 'DC-001', name: 'N3 Interchange Upgrade', contractForm: 'GCC_2015', contractValue: '48500000.00' },
      { code: 'DC-002', name: 'Bulk Water Pipeline Phase 2', contractForm: 'NEC4_ECC', contractValue: '126750000.00' },
    ],
  },
  {
    slug: 'demo-mining',
    name: 'Demo Mining Contractors (Pty) Ltd',
    tier: 'enterprise',
    modules: [
      'mod_commercial', 'mod_payroll', 'mod_crm', 'mod_finance', 'mod_estimating', 'mod_procurement',
      'mod_field', 'mod_fleet', 'mod_hse', 'mod_portal', 'mod_ai',
    ],
    ownerEmail: 'owner@demo-mining.test',
    projects: [
      { code: 'DM-101', name: 'Shaft 4 Refurbishment', contractForm: 'FIDIC_YELLOW', contractValue: '312000000.00' },
      { code: 'DM-102', name: 'Tailings Dam Raise Phase 3', contractForm: 'NEC4_ECC', contractValue: '186400000.00' },
      { code: 'DM-103', name: 'Processing Plant Conveyor Upgrade', contractForm: 'FIDIC_RED', contractValue: '94750000.00' },
      { code: 'DM-104', name: 'Haul Road Rehabilitation', contractForm: 'GCC_2015', contractValue: '41200000.00' },
    ],
  },
];

async function main() {
  const url = process.env.DATABASE_URL_OWNER;
  const password = process.env.SEED_PASSWORD;
  if (!url) throw new Error('DATABASE_URL_OWNER is not set');
  if (!password || password.length < 12) {
    throw new Error('Set SEED_PASSWORD (min 12 chars) for the local demo users');
  }

  const { db, close } = createDb(url, { max: 1 });
  try {
    const passwordHash = await hash(password);
    for (const t of DEMO) {
      const tenantId = randomUUID();
      await withTenant(db, tenantId, async (tx) => {
        const inserted = await tx
          .insert(tenants)
          .values({ id: tenantId, slug: t.slug, name: t.name, tier: t.tier, activeModules: t.modules })
          .onConflictDoNothing({ target: tenants.slug })
          .returning({ id: tenants.id });
        if (inserted.length === 0) {
          console.log(`skip ${t.slug} (already seeded)`);
          return;
        }
        await tx.insert(users).values({
          tenantId,
          email: t.ownerEmail,
          fullName: `${t.name} Owner`,
          passwordHash,
          role: 'owner',
        });
        await tx.insert(projects).values(t.projects.map((p) => ({ ...p, tenantId })));
        console.log(`seeded ${t.slug} -> login: tenant=${t.slug} email=${t.ownerEmail}`);
      });
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
