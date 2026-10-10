import http from 'http';
const port = Number(process.env.PORT) || 3000;
http.createServer((_, res) => res.end('DIAG3_OK')).listen(port, '0.0.0.0');
