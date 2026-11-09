import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

export interface CreateDbOptions {
  /** Max pooled connections. */
  max?: number;
}

export function createDb(url: string, options: CreateDbOptions = {}): DbHandle {
  const client = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
  });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {}

/**
 * Run `fn` in a transaction scoped to one tenant.
 *
 * This is the ONLY supported way to touch tenant data. It uses
 * set_config(..., is_local => true), the parameterised equivalent of SET LOCAL,
 * so the tenant setting ends with the transaction and can never leak to the
 * next request that borrows the same pooled connection.
 */
export async function withTenant<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new TenantContextError('withTenant requires a valid tenant UUID');
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`);
    return fn(tx);
  });
}
