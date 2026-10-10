import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import type { AppConfig } from './config.js';
import type { DbClient } from './db.js';
import { createStorage, type Storage } from './lib/storage.js';
import { registerErrorHandler } from './errors.js';
import { registerAuth } from './middleware/auth.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { casesRoutes } from './routes/cases.js';
import { fieldRoutes } from './routes/field.js';
import { recoveryRoutes, reviewQueueRoutes } from './routes/recovery.js';
import { clientContactRoutes, emailRoutes, skipRoutes } from './routes/research.js';
import { companyRoutes } from './routes/company.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    /** File storage (local disk or S3/R2, per STORAGE_BACKEND). */
    storage: Storage;
  }
}

export interface BuildAppOptions {
  config: AppConfig;
  db: DbClient;
  logger?: boolean;
}

/**
 * Build the Fastify application. The database is injected so unit tests can
 * substitute a stub — no live Postgres required to exercise auth, guards,
 * and permission logic.
 */
export async function buildApp({ config, db, logger = false }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger });

  app.decorate('config', config);
  app.decorate('db', db);
  // File storage backend (local disk or S3/R2). Fails fast on bad S3 config.
  app.decorate('storage', createStorage(config));

  // CORS: reflect origin in dev; in production lock to CORS_ORIGIN.
  const corsOrigin = config.CORS_ORIGIN
    ? config.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
    : true;
  await app.register(cors, { origin: corsOrigin });
  await app.register(jwt, { secret: config.JWT_SECRET });
  // Multipart for photo intake / document scans. Limits come from config;
  // per-request file handling validates mime → extension strictly.
  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: config.MAX_UPLOAD_MB * 1024 * 1024,
    },
  });

  registerErrorHandler(app);
  registerAuth(app);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(adminRoutes, { prefix: '/admin' });
  await app.register(casesRoutes, { prefix: '/cases' });
  await app.register(fieldRoutes, { prefix: '/field' });
  await app.register(recoveryRoutes, { prefix: '/cases' });
  await app.register(reviewQueueRoutes);
  await app.register(skipRoutes, { prefix: '/cases' });
  await app.register(clientContactRoutes, { prefix: '/clients' });
  await app.register(emailRoutes);
  await app.register(companyRoutes);

  return app;
}
