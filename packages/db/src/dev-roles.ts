/**
 * LOCAL DEVELOPMENT ONLY: give the per-service roles a login + well-known dev
 * password so the three services can connect to the docker-compose Postgres.
 * Refuses to run against anything but localhost. In AWS, passwords come from
 * Secrets Manager (see infra/README.md).
 */
import postgres from 'postgres';

const DEV_ROLES: Record<string, string> = {
  constructos_app: 'app_local_dev',
  constructos_sync: 'sync_local_dev',
  constructos_ai: 'ai_local_dev',
};

async function main() {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error('DATABASE_URL_OWNER is not set');
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1', 'postgres'].includes(host)) {
    throw new Error(`Refusing to set dev passwords on non-local host "${host}"`);
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    for (const [role, password] of Object.entries(DEV_ROLES)) {
      // Identifiers can't be parameterised; role names are fixed constants above.
      await sql.unsafe(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
      console.log(`enabled login for ${role}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
