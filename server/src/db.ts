import mongoose from 'mongoose';
import { logger } from './sources/core/logger.js';

export async function connect(uri: string): Promise<void> {
  mongoose.connection.on('error', (err) => {
    logger.error('mongo', `connection error: ${err.message}`);
  });
  mongoose.connection.on('disconnected', () => {
    logger.warn('mongo', 'disconnected');
  });
  mongoose.connection.on('reconnected', () => {
    logger.info('mongo', 'reconnected');
  });

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 10,
  });
  // Note: this first "connected" line is emitted before startLogStore() runs (the sink isn't attached yet),
  // so it prints to the console but isn't persisted — every later mongo event (error/disconnected/reconnected) is.
  logger.info('mongo', 'connected');
}

export async function disconnect(): Promise<void> {
  await mongoose.disconnect();
}

export function isConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
