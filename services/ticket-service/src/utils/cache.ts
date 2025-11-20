import dotenv from 'dotenv';
import { createClient } from 'redis';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';

export const redisClient = createClient({
  url: redisUrl,
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        return new Error('Redis reconnect attempts exhausted');
      }
      return Math.min(retries * 100, 3000);
    },
  },
});

redisClient.on('error', (err) => {
  console.error('Redis client error:', err.message);
});

redisClient.on('connect', () => {
  console.log('✅ Connected to Redis (ticket-service)');
});

export const initRedis = async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
};

/**
 * This function sets the ticket cache
 * @param ticketId - The ID of the ticket
 * @param payload - The payload to cache
 * @param ttlSeconds - The time to live in seconds
 */
export const setTicketCache = async (ticketId: string, payload: Record<string, unknown>, ttlSeconds = 60 * 60 * 24) => {
  try {
    await redisClient.set(`ticket:${ticketId}`, JSON.stringify(payload), {
      EX: ttlSeconds,
    });
  } catch (error) {
    console.error('Failed to cache ticket payload:', (error as any)?.message);
  }
};

/**
 * This function gets the ticket cache
 * @param ticketId - The ID of the ticket
 * @returns The cached payload or null if not found
 */
export const getTicketCache = async (ticketId: string) => {
  try {
    const cached = await redisClient.get(`ticket:${ticketId}`);
    if (!cached) return null;
    return JSON.parse(cached);
  } catch (error) {
    console.error('Failed to read ticket cache:', (error as any)?.message);
    return null;
  }
};

/**
 * This function marks the ticket as used
 * @param ticketId - The ID of the ticket
 * @param expiresInSeconds - The time to live in seconds
 */
export const markTicketAsUsed = async (ticketId: string, expiresInSeconds = 60 * 60 * 24) => {
  try {
    await redisClient.set(`ticket:${ticketId}:used`, '1', { EX: expiresInSeconds });
  } catch (error) {
    console.error('Failed to set ticket used cache:', (error as any)?.message);
  }
};

/**
 * This function checks if the ticket is already used
 * @param ticketId - The ID of the ticket
 * @returns True if the ticket is already used, false otherwise
 */
export const isTicketAlreadyUsed = async (ticketId: string): Promise<boolean> => {
  try {
    const value = await redisClient.get(`ticket:${ticketId}:used`);
    return value === '1';
  } catch (error) {
    console.error('Failed to read ticket used cache:', (error as any)?.message);
    return false;
  }
};

