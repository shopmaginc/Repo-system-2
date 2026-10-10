import http from 'http';

const results: string[] = [];
try {
  const shared = await import('@repo/shared');
  results.push('OK shared: ' + Object.keys(shared).slice(0, 5).join(','));
} catch (e: any) {
  results.push('FAIL shared: ' + String(e.message || e).substring(0, 200));
}

const port = Number(process.env.PORT) || 3000;
http.createServer((_, res) => res.end(results.join('\n'))).listen(port, '0.0.0.0');
