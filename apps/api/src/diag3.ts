import http from 'http';
import { loadConfig } from './config.js';
import { createStorage } from './lib/storage.js';

const results: string[] = [];
let config: any = null;
try {
  config = loadConfig();
  results.push('OK loadConfig STORAGE=' + config.STORAGE_BACKEND);
} catch (e: any) {
  results.push('FAIL loadConfig: ' + String(e.message || e).substring(0, 200));
}
if (config) {
  try {
    const s = createStorage(config);
    results.push('OK createStorage: ' + s.constructor.name);
  } catch (e: any) {
    results.push('FAIL createStorage: ' + String(e.message || e).substring(0, 300));
  }
}

const port = Number(process.env.PORT) || 3000;
http.createServer((_, res) => res.end(results.join('\n'))).listen(port, '0.0.0.0');
