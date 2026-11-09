import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL_APP: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  API_PORT: z.coerce.number().int().default(3000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  ENTITLEMENT_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(30),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Guard against the most dangerous misconfiguration: running the API as the owner role.
  if (env.DATABASE_URL_APP && /constructos_owner/.test(env.DATABASE_URL_APP)) {
    throw new Error('DATABASE_URL_APP must use the constructos_app role, never the owner');
  }
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  return parsed.data;
}
