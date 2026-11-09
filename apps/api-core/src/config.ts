import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  DATABASE_URL_APP: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  API_PORT: z.coerce.number().int().default(3000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  ENTITLEMENT_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(30),

  // Redis: shared rate limits + entitlement cache across API tasks.
  // Optional in local dev (falls back to in-process memory); required in AWS.
  REDIS_URL: z.string().url().optional(),

  // Object storage. In AWS, credentials come from the ECS task role.
  S3_BUCKET: z.string().min(3),
  S3_REGION: z.string().default('af-south-1'),
  S3_ENDPOINT: z.string().url().optional(), // local S3 mock only
  // Endpoint the BROWSER uses for presigned URLs, when it differs from the one
  // the API uses (e.g. API in a container: s3:9090 inside, localhost:9094 outside).
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: bool.default('false'),
  S3_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  S3_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
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
