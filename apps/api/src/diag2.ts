/** Minimal import test — serves which import crashes. */
import http from 'http';

const results: string[] = [];

async function main() {
  try {
    await import('@prisma/client');
    results.push('OK prisma-client');
  } catch (e: any) {
    results.push('FAIL prisma-client: ' + String(e.message || e).substring(0, 200));
  }

  try {
    await import('./config.js');
    results.push('OK config');
  } catch (e: any) {
    results.push('FAIL config: ' + String(e.message || e).substring(0, 200));
  }

  try {
    await import('./app.js');
    results.push('OK app');
  } catch (e: any) {
    results.push('FAIL app: ' + String(e.message || e).substring(0, 200));
  }

  const port = Number(process.env.PORT) || 3000;
  http.createServer((_, res) => res.end(results.join('\n'))).listen(port, '0.0.0.0');
}

main();
