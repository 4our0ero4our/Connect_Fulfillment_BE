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

// Invalid API key attempt tracking and ban enforcement

const DEFAULT_INVALID_LIMIT = 3; // after 3 wrong trials
const DEFAULT_BAN_SECONDS = 60 * 60 * 3; // 3 hours

const getClientIp = (req: Request): string => {
  return (
    req.ip ||
    (req.headers['x-forwarded-for']?.toString().split(',')[0].trim()) ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown'
  );
};

const getBucket = (req: Request, bucketName?: string): string => bucketName || req.path || 'unknown';

const makeKeys = (ip: string, bucket: string) => ({
  attemptsKey: `invalidKey:${bucket}:${ip}`,
  banKey: `ban:${bucket}:${ip}`,
});

export const checkInvalidApiKeyBan = (bucketName?: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ip = getClientIp(req);
      const bucket = getBucket(req, bucketName);
      const { banKey } = makeKeys(ip, bucket);
      const ttl = await redis.ttl(banKey);
      if (ttl && ttl > 0) {
        return res.status(429).json({
          error: 'Too many invalid API key attempts. Access temporarily blocked.',
          retryAfterSeconds: ttl,
        });
      }
      return next();
    } catch (err: any) {
      console.error('checkInvalidApiKeyBan error:', err?.message || err);
      return next();
    }
  };
};

export const recordInvalidApiKeyAttempt = async (
  req: Request,
  limit: number = DEFAULT_INVALID_LIMIT,
  banSeconds: number = DEFAULT_BAN_SECONDS,
  bucketName?: string
): Promise<{ bannedNow: boolean; remainingAttempts: number; retryAfterSeconds?: number }> => {
  try {
    const ip = getClientIp(req);
    const bucket = getBucket(req, bucketName);
    const { attemptsKey, banKey } = makeKeys(ip, bucket);

    // If already banned, just return TTL
    const existingTtl = await redis.ttl(banKey);
    if (existingTtl && existingTtl > 0) {
      return { bannedNow: true, remainingAttempts: 0, retryAfterSeconds: existingTtl };
    }

    const attempts = await redis.incr(attemptsKey);
    if (attempts === 1) {
      await redis.expire(attemptsKey, banSeconds);
    }

    const remaining = Math.max(0, limit - attempts);

    if (attempts >= limit) {
      await redis.set(banKey, '1', 'EX', banSeconds);
      const ttl = await redis.ttl(banKey);
      return { bannedNow: true, remainingAttempts: 0, retryAfterSeconds: ttl > 0 ? ttl : banSeconds };
    }

    return { bannedNow: false, remainingAttempts: remaining };
  } catch (err: any) {
    // Fail open on Redis errors
    console.error('recordInvalidApiKeyAttempt error:', err?.message || err);
    return { bannedNow: false, remainingAttempts: Number.MAX_SAFE_INTEGER };
  }
};


