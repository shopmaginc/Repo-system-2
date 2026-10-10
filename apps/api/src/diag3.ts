import http from 'http';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { loadConfig } from './config.js';

const results: string[] = [];
const config = loadConfig();
results.push('OK loadConfig');

const app = Fastify({ logger: false });
try { await app.register(cors, { origin: true }); results.push('OK cors'); }
catch (e: any) { results.push('FAIL cors: ' + String(e.message || e).substring(0, 150)); }
try { await app.register(jwt, { secret: config.JWT_SECRET }); results.push('OK jwt'); }
catch (e: any) { results.push('FAIL jwt: ' + String(e.message || e).substring(0, 150)); }
try { await app.register(multipart, { limits: { files: 1, fileSize: 25 * 1024 * 1024 } }); results.push('OK multipart'); }
catch (e: any) { results.push('FAIL multipart: ' + String(e.message || e).substring(0, 150)); }

const port = Number(process.env.PORT) || 3000;
http.createServer((_, res) => res.end(results.join('\n'))).listen(port, '0.0.0.0');
