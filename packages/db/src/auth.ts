import { sql } from 'drizzle-orm';
import type { Db } from './client';
import type { UserRole } from './schema';

export interface LoginRecord {
  userId: string;
  tenantId: string;
  /** NULL for users who have not accepted their invite yet (they cannot log in). */
  passwordHash: string | null;
  role: UserRole;
}

/**
 * Pre-authentication lookup via the auth_find_login() SECURITY DEFINER function.
 * Returns null when the tenant/user does not exist or the user is inactive.
 */
export async function findLogin(
  db: Db,
  tenantSlug: string,
  email: string,
): Promise<LoginRecord | null> {
  const rows = await db.execute<{
    user_id: string;
    tenant_id: string;
    password_hash: string | null;
    role: UserRole;
  }>(sql`select * from auth_find_login(${tenantSlug}, ${email})`);
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    passwordHash: row.password_hash,
    role: row.role,
  };
}
