import Redis from 'ioredis';
import { Request, Response, NextFunction } from 'express';

const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';
const redis = new Redis(redisUrl);

export const rateLimit = (limit: number, windowSeconds: number, bucketName?: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ip = req.ip || req.headers['x-forwarded-for']?.toString() || req.socket.remoteAddress || 'unknown';
      const bucket = bucketName || req.path;
      const key = `rate:${bucket}:${ip}`;

      const requests = await redis.incr(key);
      if (requests === 1) {
        await redis.expire(key, windowSeconds);
      }

      if (requests > limit) {
        const ttl = await redis.ttl(key);
        return res.status(429).json({
          error: 'Too many requests. Try again later.',
          retryAfterSeconds: ttl >= 0 ? ttl : undefined,
        });
      }

      return next();
    } catch (err: any) {
      // On Redis failure, fail open to avoid blocking traffic
      console.error('RateLimit error:', err?.message || err);
      return next();
    }
  };
};

export default rateLimit;


