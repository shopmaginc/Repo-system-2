import http from 'http';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { getDb } from './db.js';
import { registerErrorHandler } from './errors.js';
import { registerAuth } from './middleware/auth.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { casesRoutes } from './routes/cases.js';
import { fieldRoutes } from './routes/field.js';

const results: string[] = [];
const config = loadConfig();
const db = getDb();
const app = Fastify({ logger: false });
app.decorate('config', config);
app.decorate('db', db);
results.push('OK base');

registerErrorHandler(app);
registerAuth(app);
await app.register(healthRoutes);
await app.register(authRoutes);
results.push('OK first-batch');

try { await app.register(adminRoutes, { prefix: '/admin' }); results.push('OK adminRoutes'); }
catch (e: any) { results.push('FAIL adminRoutes: ' + String(e.message || e).substring(0, 150)); }
try { await app.register(casesRoutes, { prefix: '/cases' }); results.push('OK casesRoutes'); }
catch (e: any) { results.push('FAIL casesRoutes: ' + String(e.message || e).substring(0, 150)); }
try { await app.register(fieldRoutes, { prefix: '/field' }); results.push('OK fieldRoutes'); }
catch (e: any) { results.push('FAIL fieldRoutes: ' + String(e.message || e).substring(0, 150)); }

const port = Number(process.env.PORT) || 3000;
http.createServer((_, res) => res.end(results.join('\n'))).listen(port, '0.0.0.0');
