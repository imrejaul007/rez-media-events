import winston from 'winston';

const serviceName = process.env.SERVICE_NAME || 'microservice';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    process.env.NODE_ENV === 'production'
      ? winston.format.json()
      : winston.format.combine(winston.format.colorize(), winston.format.simple()),
  ),
  defaultMeta: { service: serviceName },
  transports: [new winston.transports.Console()],
});

export const createServiceLogger = (name: string) => ({
  info: (message: string, meta?: any) => logger.info(message, { component: name, ...meta }),
  warn: (message: string, meta?: any) => logger.warn(message, { component: name, ...meta }),
  error: (message: string, meta?: any) => logger.error(message, { component: name, ...meta }),
  debug: (message: string, meta?: any) => logger.debug(message, { component: name, ...meta }),
});
