import type { NextFunction, Request, Response } from 'express';
import type { RateLimiter } from '../store/types.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

/**
 * Fixed-window rate limiter keyed by principal (API key / subscription) or client IP.
 * Counters live in Supabase, so limits hold across all Cloud Run instances.
 * If the store is briefly unreachable the request is allowed (fail-open) and logged,
 * so a database blip does not take the API down; auth and quotas still apply.
 */
export function rateLimit(limiter: RateLimiter, opts: { perMinute: number; scope: string }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = `${opts.scope}:${req.principal ?? req.ip ?? 'unknown'}`;
    const now = Date.now();
    const windowStart = now - (now % 60_000);
    limiter
      .hit(id, windowStart)
      .then((count) => {
        res.setHeader('RateLimit-Limit', String(opts.perMinute));
        res.setHeader('RateLimit-Remaining', String(Math.max(0, opts.perMinute - count)));
        if (count > opts.perMinute) {
          res.setHeader('Retry-After', String(Math.ceil((windowStart + 60_000 - now) / 1000)));
          return next(new AppError('RATE_LIMITED', 'Too many requests; slow down'));
        }
        next();
      })
      .catch((err) => {
        log.warn('rate_limit_store_error', { err: String(err) });
        next();
      });
  };
}
