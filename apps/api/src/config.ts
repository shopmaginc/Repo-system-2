import { z } from 'zod';

/** Validated runtime configuration. Fails fast on missing/invalid values. */
const configSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  PORT: z.coerce.number().int().positive().default(3000),
  // Directory where case photos / document scans are stored. Never served
  // as executable content; paths are internal only.
  UPLOADS_DIR: z.string().min(1).default('./uploads'),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().max(100).default(25),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // File storage backend. `local` = disk under UPLOADS_DIR (dev default).
  // `s3` = S3-compatible object storage (Cloudflare R2: S3_ENDPOINT=
  // https://<account-id>.r2.cloudflarestorage.com, S3_REGION=auto).
  // The bucket stays private — downloads always go through the
  // authenticated API endpoints, never public URLs.
  // Optional so test configs can omit it; unset means `local`.
  STORAGE_BACKEND: z.enum(['local', 's3']).optional(),
  S3_ENDPOINT: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_REGION: z.string().min(1).optional(),
  // Comma-separated CORS allowlist (e.g. the Cloudflare Pages URL).
  // Unset = reflect the request origin (fine for dev; set in production).
  CORS_ORIGIN: z.string().min(1).optional(),
}).superRefine((cfg, ctx) => {
  if (cfg.STORAGE_BACKEND === 's3') {
    for (const [key, value] of [
      ['S3_ENDPOINT', cfg.S3_ENDPOINT],
      ['S3_BUCKET', cfg.S3_BUCKET],
      ['S3_ACCESS_KEY_ID', cfg.S3_ACCESS_KEY_ID],
      ['S3_SECRET_ACCESS_KEY', cfg.S3_SECRET_ACCESS_KEY],
    ] as const) {
      if (!value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when STORAGE_BACKEND=s3`,
        });
      }
    }
  }
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
