import http from 'http';
import { logger } from './config/logger';

let isHealthy = true;

export function setHealthy(healthy: boolean): void {
  isHealthy = healthy;
}

export function startHealthServer(port: number = 3001): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/healthz') {
      if (isHealthy) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'unhealthy' }));
      }
    } else if (req.url === '/ready') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    logger.info(`[Health] Server listening on port ${port}`);
  });

  return server;
}
