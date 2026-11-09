/**
 * Minimal forward-only migration runner.
 * Applies migrations/*.sql in filename order, each in its own transaction,
 * recording applied versions in schema_migrations. Must run as the owner role.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from 'postgres';

export async function migrate(url: string, log: (msg: string) => void = console.log) {
  const dir = resolve(__dirname, '../migrations');
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`
      create table if not exists schema_migrations (
        version    text primary key,
        applied_at timestamptz not null default now()
      )`;
    const applied = new Set(
      (await sql<{ version: string }[]>`select version from schema_migrations`).map(
        (r) => r.version,
      ),
    );
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const body = readFileSync(join(dir, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (version) values (${file})`;
      });
      log(`applied ${file}`);
    }
    log('migrations up to date');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) {
    console.error('DATABASE_URL_OWNER is not set');
    process.exit(1);
  }
  migrate(url).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
