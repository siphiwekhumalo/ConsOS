/**
 * Deployment step (runs after migrate, as the owner role): give each service's
 * database role LOGIN with the password held in AWS Secrets Manager, injected
 * by ECS as environment variables. Idempotent: safe to run on every deploy, and
 * it also rotates passwords when the secrets change.
 *
 *   APP_DB_PASSWORD  -> constructos_app   (core API)
 *   SYNC_DB_PASSWORD -> constructos_sync  (edge-sync service)
 *   AI_DB_PASSWORD   -> constructos_ai    (AI engine)
 */
import postgres from 'postgres';

const ROLES: [role: string, env: string][] = [
  ['constructos_app', 'APP_DB_PASSWORD'],
  ['constructos_sync', 'SYNC_DB_PASSWORD'],
  ['constructos_ai', 'AI_DB_PASSWORD'],
];

/** SQL string literal with quotes escaped (ALTER ROLE cannot take bind parameters). */
const literal = (v: string) => `'${v.replace(/'/g, "''")}'`;

async function main() {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error('DATABASE_URL_OWNER is not set');
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    for (const [role, env] of ROLES) {
      const password = process.env[env];
      if (!password) {
        console.log(`skip ${role}: ${env} not set`);
        continue;
      }
      if (password.length < 24) throw new Error(`${env} must be at least 24 characters`);
      await sql.unsafe(`ALTER ROLE ${role} LOGIN PASSWORD ${literal(password)}`);
      console.log(`provisioned ${role}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
