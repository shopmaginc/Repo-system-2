import http from 'http';
import { loadConfig } from './config.js';

const results: string[] = [];
try {
  loadConfig();
  results.push('OK loadConfig');
} catch (e: any) {
  results.push('FAIL loadConfig: ' + String(e.message || e).substring(0, 200));
}

const port = Number(process.env.PORT) || 3000;
http.createServer((_, res) => res.end(results.join('\n'))).listen(port, '0.0.0.0');
