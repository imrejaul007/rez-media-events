/**
 * rez-media-events — Standalone BullMQ Worker Service
 *
 * Phase C extraction from REZ monolith (Strangler Fig pattern).
 */

import 'dotenv/config';

process.env.SERVICE_NAME = 'rez-media-events';

import { logger } from './config/logger';
import { connectMongoDB, disconnectMongoDB } from './config/mongodb';
import { bullmqRedis } from './config/redis';
import { startHealthServer } from './health';
import { startMediaWorker, stopWorker } from './worker';
import { startHttpServer } from './http';

async function main(): Promise<void> {
  logger.info('[rez-media-events] Starting...');

  await connectMongoDB();
  const worker = startMediaWorker();
  const httpPort = parseInt(process.env.PORT || '3006', 10);
  const httpServer = startHttpServer(httpPort);
  const healthServer = startHealthServer(httpPort + 1);

  const shutdown = async (signal: string) => {
    logger.info(`[${signal}] Graceful shutdown initiated`);
    try {
      await stopWorker();
      httpServer.close();
      healthServer.close();
      await bullmqRedis.quit();
      await disconnectMongoDB();
      logger.info('[rez-media-events] Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('[rez-media-events] Shutdown error:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled promise rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });

  logger.info('[rez-media-events] Ready');
}

main().catch((err) => {
  console.error('[FATAL] Failed to start:', err);
  process.exit(1);
});
