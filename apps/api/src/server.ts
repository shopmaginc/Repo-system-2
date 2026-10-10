import { loadConfig } from './config.js';
import { getDb } from './db.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config, db: getDb(), logger: true });

  // Fail fast if the database is unreachable.
  await app.db.user.findMany({ take: 1 }).catch((err) => {
    app.log.error(err, 'Database unreachable — is Postgres running? (docker compose up -d)');
    process.exit(1);
  });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info(`repo-system API listening on :${config.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
