/**
 * PLATFORM PROVISIONING: create a customer organisation (tenant) and its first
 * owner. Runs as the database owner role: in production as a one-off ECS task
 * started by the Buildkite "provision" pipeline, locally with tsx.
 *
 * The owner gets NO password. The script prints a one-time invite link
 * (valid 72 hours). The owner opens it and sets their own password; from then on
 * they invite everyone else from Settings → Users & access.
 *
 * Environment:
 *   TENANT_SLUG     organisation ID used at sign-in, e.g. "acme-civils"
 *   TENANT_NAME     legal/display name, e.g. "Acme Civils (Pty) Ltd"
 *   TENANT_TIER     standard | mid_market | enterprise          (default standard)
 *   TENANT_MODULES  comma-separated module ids, or "all"        (default mod_commercial,mod_field)
 *   OWNER_EMAIL     first owner's work email
 *   OWNER_NAME      first owner's full name
 *   PUBLIC_URL      e.g. https://baheka-construct-os.com
 *   DATABASE_URL_OWNER
 */
import { randomUUID } from 'node:crypto';
import { createDb, withTenant } from './client';
import { createInvite, inviteUrl } from './invites';
import { appendAudit } from './audit';
import { MODULE_IDS, isModuleId } from './modules';
import { tenants, users } from './schema';

function env(name: string, fallback?: string): string {
  const v = process.env[name]?.trim() || fallback;
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function main() {
  const slug = env('TENANT_SLUG').toLowerCase();
  const name = env('TENANT_NAME');
  const tier = env('TENANT_TIER', 'standard') as 'standard' | 'mid_market' | 'enterprise';
  const modulesRaw = env('TENANT_MODULES', 'mod_commercial,mod_field');
  const ownerEmail = env('OWNER_EMAIL').toLowerCase();
  const ownerName = env('OWNER_NAME');
  const publicUrl = env('PUBLIC_URL');

  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) throw new Error('TENANT_SLUG: lowercase letters, digits and hyphens, 2-63 chars');
  if (!['standard', 'mid_market', 'enterprise'].includes(tier)) throw new Error('TENANT_TIER must be standard, mid_market or enterprise');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) throw new Error('OWNER_EMAIL is not a valid email');
  const modules = modulesRaw === 'all' ? [...MODULE_IDS] : modulesRaw.split(',').map((m) => m.trim()).filter(Boolean);
  const unknown = modules.filter((m) => !isModuleId(m));
  if (unknown.length) throw new Error(`Unknown modules: ${unknown.join(', ')}. Valid: ${MODULE_IDS.join(', ')}`);

  const { db, close } = createDb(env('DATABASE_URL_OWNER'), { max: 1 });
  try {
    const tenantId = randomUUID();
    const ownerId = randomUUID();
    const { token, expiresAt } = await withTenant(db, tenantId, async (tx) => {
      const inserted = await tx
        .insert(tenants)
        .values({ id: tenantId, slug, name, tier, activeModules: modules })
        .onConflictDoNothing({ target: tenants.slug })
        .returning({ id: tenants.id });
      if (inserted.length === 0) throw new Error(`An organisation with ID "${slug}" already exists`);
      await tx.insert(users).values({
        id: ownerId,
        tenantId,
        email: ownerEmail,
        fullName: ownerName,
        passwordHash: null,
        role: 'owner',
        isActive: false,
      });
      await appendAudit(tx, {
        tenantId,
        actorUserId: null,
        action: 'tenant.provisioned',
        entityType: 'tenant',
        entityId: tenantId,
        payload: { slug, name, tier, modules, ownerEmail },
      });
      return createInvite(tx, { tenantId, userId: ownerId, purpose: 'invite', createdBy: null });
    });

    console.log(`Provisioned organisation "${name}" (ID: ${slug}, tier: ${tier})`);
    console.log(`Modules: ${modules.join(', ')}`);
    console.log(`Owner: ${ownerName} <${ownerEmail}>`);
    console.log(`Invite expires: ${expiresAt.toISOString()}`);
    // Single machine-readable line; the provisioning pipeline extracts it.
    console.log(`INVITE_URL=${inviteUrl(publicUrl, token)}`);
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
