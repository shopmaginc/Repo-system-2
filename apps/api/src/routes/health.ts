import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    { config: { public: true } },
    async () => ({ ok: true, service: 'repo-system-api', version: '0.1.0' }),
  );
}
