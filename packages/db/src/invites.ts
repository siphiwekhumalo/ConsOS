import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db, Tx } from './client';
import { userInvites } from './schema';

export type InvitePurpose = 'invite' | 'reset';

export const INVITE_TTL_HOURS: Record<InvitePurpose, number> = { invite: 72, reset: 24 };

/** SHA-256 of the token; only the hash is ever stored. */
export function hashInviteToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Create a one-time invite (or password reset) for a user and return the raw
 * token. The token is shown once, to whoever created it, and never stored.
 * Any earlier open invites for the same user are spent first.
 */
export async function createInvite(
  tx: Tx,
  input: { tenantId: string; userId: string; purpose: InvitePurpose; createdBy: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS[input.purpose] * 3600_000);
  await revokeOpenInvites(tx, input.userId);
  await tx.insert(userInvites).values({
    tenantId: input.tenantId,
    userId: input.userId,
    purpose: input.purpose,
    tokenHash: hashInviteToken(token),
    expiresAt,
    createdBy: input.createdBy,
  });
  return { token, expiresAt };
}

export async function revokeOpenInvites(tx: Tx, userId: string) {
  await tx.execute(sql`update user_invites set used_at = now() where user_id = ${userId} and used_at is null`);
}

export interface InviteLookup {
  inviteId: string;
  purpose: InvitePurpose;
  tenantId: string;
  userId: string;
  email: string;
  fullName: string;
  tenantName: string;
  tenantSlug: string;
  expiresAt: Date;
}

/** Pre-auth lookup of a valid invite (auth_find_invite, migration 0006). */
export async function findInvite(db: Db | Tx, token: string): Promise<InviteLookup | null> {
  if (!/^[A-Za-z0-9_-]{30,64}$/.test(token)) return null;
  const rows = await db.execute<{
    invite_id: string;
    purpose: InvitePurpose;
    tenant_id: string;
    user_id: string;
    email: string;
    full_name: string;
    tenant_name: string;
    tenant_slug: string;
    expires_at: string;
  }>(sql`select * from auth_find_invite(${hashInviteToken(token)})`);
  const r = rows[0];
  if (!r) return null;
  return {
    inviteId: r.invite_id,
    purpose: r.purpose,
    tenantId: r.tenant_id,
    userId: r.user_id,
    email: r.email,
    fullName: r.full_name,
    tenantName: r.tenant_name,
    tenantSlug: r.tenant_slug,
    expiresAt: new Date(r.expires_at),
  };
}

export function inviteUrl(publicUrl: string, token: string) {
  return `${publicUrl.replace(/\/$/, '')}/invite/${token}`;
}
