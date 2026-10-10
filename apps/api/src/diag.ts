/** Temporary startup diagnostic — reports which boot step fails via HTTP. */
import http from 'http';
import { loadConfig } from './config.js';
import { getDb } from './db.js';
import { buildApp } from './app.js';

const results: string[] = [];
function log(step: string, ok: boolean, detail: string = '') {
  results.push(`${ok ? 'OK' : 'FAIL'} ${step}${detail ? ': ' + detail : ''}`);
}

async function main() {
  let config: any = null;
  try {
    config = loadConfig();
    log('loadConfig', true);
  } catch (e: any) {
    log('loadConfig', false, String(e.message || e).substring(0, 200));
  }

  let db: any = null;
  if (config) {
    try {
      db = getDb();
      log('getDb', true);
    } catch (e: any) {
      log('getDb', false, String(e.message || e).substring(0, 200));
    }
  }

  if (config && db) {
    try {
      const app = await buildApp({ config, db, logger: false });
      log('buildApp', true);
      try {
        await app.db.user.findMany({ take: 1 });
        log('dbCheck', true);
      } catch (e: any) {
        log('dbCheck', false, String(e.message || e).substring(0, 200));
      }
      try {
        await app.listen({ port: config.PORT, host: '0.0.0.0' });
        log('listen', true, `port ${config.PORT}`);
      } catch (e: any) {
        log('listen', false, String(e.message || e).substring(0, 200));
      }
    } catch (e: any) {
      log('buildApp', false, String(e.message || e).substring(0, 300));
    }
  }

  const port = Number(process.env.PORT) || 3000;
  http.createServer((_, res) => {
    res.end(results.join('\n'));
  }).listen(port, '0.0.0.0');
  console.log('diag listening on ' + port);
}

main();
