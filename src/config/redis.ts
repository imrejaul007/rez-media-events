import IORedis from 'ioredis';
import { logger } from './logger';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

function parsedUrl() {
  try {
    return new URL(redisUrl);
  } catch {
    return { hostname: 'localhost', port: '6379', password: '' };
  }
}

const u = parsedUrl();

export const bullmqRedis: any = new IORedis({
  host: u.hostname || 'localhost',
  port: parseInt(u.port || '6379', 10),
  password: u.password || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  keepAlive: 10000,
  retryStrategy: (times: number) => {
    const base = Math.min(Math.pow(2, times) * 200, 15000);
    return Math.floor(base + Math.random() * 1000);
  },
  reconnectOnError: (err: Error) => {
    return err.message.includes('ECONNRESET') || err.message.includes('EPIPE') || err.message.includes('READONLY');
  },
  lazyConnect: false,
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
});

bullmqRedis.on('connect', () => logger.info('[Redis] Connection established'));
bullmqRedis.on('ready', () => logger.info('[Redis] Connection ready'));
bullmqRedis.on('reconnecting', () => logger.warn('[Redis] Reconnecting...'));
bullmqRedis.on('error', (err: Error) => logger.error('[Redis] Error: ' + err.message));
bullmqRedis.on('end', () => logger.error('[Redis] Connection closed'));
