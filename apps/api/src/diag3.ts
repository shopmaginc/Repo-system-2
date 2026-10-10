import http from 'http';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { getDb } from './db.js';
import { registerErrorHandler } from './errors.js';
import { registerAuth } from './middleware/auth.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';

const results: string[] = [];
const config = loadConfig();
const db = getDb();
const app = Fastify({ logger: false });
app.decorate('config', config);
app.decorate('db', db);
results.push('OK base');

try { registerErrorHandler(app); results.push('OK errorHandler'); }
catch (e: any) { results.push('FAIL errorHandler: ' + String(e.message || e).substring(0, 150)); }
try { registerAuth(app); results.push('OK registerAuth'); }
catch (e: any) { results.push('FAIL registerAuth: ' + String(e.message || e).substring(0, 150)); }
try { await app.register(healthRoutes); results.push('OK healthRoutes'); }
catch (e: any) { results.push('FAIL healthRoutes: ' + String(e.message || e).substring(0, 150)); }
try { await app.register(authRoutes); results.push('OK authRoutes'); }
catch (e: any) { results.push('FAIL authRoutes: ' + String(e.message || e).substring(0, 150)); }

const port = Number(process.env.PORT) || 3000;
http.createServer((_, res) => res.end(results.join('\n'))).listen(port, '0.0.0.0');
