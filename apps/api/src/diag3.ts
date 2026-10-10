import http from 'http';
import { loadConfig } from './config.js';
import { getDb } from './db.js';
import { buildApp } from './app.js';

const results: string[] = [];
let config: any = null;
let db: any = null;
try {
  config = loadConfig();
  results.push('OK loadConfig');
} catch (e: any) {
  results.push('FAIL loadConfig: ' + String(e.message || e).substring(0, 200));
}
try {
  db = getDb();
  results.push('OK getDb');
} catch (e: any) {
  results.push('FAIL getDb: ' + String(e.message || e).substring(0, 200));
}
if (config && db) {
  try {
    await buildApp({ config, db, logger: false });
    results.push('OK buildApp');
  } catch (e: any) {
    results.push('FAIL buildApp: ' + String(e.message || e).substring(0, 300));
  }
}

const port = Number(process.env.PORT) || 3000;
http.createServer((_, res) => res.end(results.join('\n'))).listen(port, '0.0.0.0');
