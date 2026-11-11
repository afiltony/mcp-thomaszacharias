import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../config/env.js';
import type { AppContext } from '../context.js';
import { authenticateSubscriber, hashKey, meterCall } from '../billing/billing.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    principal?: string;
    /** Set when the caller authenticated with a paid subscription key. */
    subscriptionId?: string;
  }
}

function sha(v: string) {
  return createHash('sha256').update(v).digest();
}

export function bearer(req: Request): string | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '');
  return m ? m[1]!.trim() : undefined;
}

/**
 * Bearer auth. Accepts either an operator key (API_KEYS env, unlimited) or a
 * subscriber key issued after an on-chain USDC payment to the billing domain.
 */
export function requireApiKey(ctx: AppContext) {
  const { env } = ctx;
  const operators = [...env.apiKeys.entries()].map(([k, name]) => ({ h: sha(k), name }));
  let warned = false;
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = bearer(req);
      if (!token) {
        if (operators.length === 0 && env.NODE_ENV !== 'production' && !(await ctx.billing.hasSubscriptions())) {
          if (!warned) {
            log.warn('auth_disabled', { note: 'No API keys configured — authentication disabled (development only)' });
            warned = true;
          }
          req.principal = 'dev';
          return next();
        }
        throw new AppError('UNAUTHORIZED', `Missing bearer token. Subscribe with USDC paid to ${env.BILLING_DOMAIN} to get an API key.`);
      }
      const h = sha(token);
      const op = operators.find((x) => timingSafeEqual(x.h, h));
      if (op) {
        req.principal = op.name;
        return next();
      }
      const sub = env.BILLING_ENABLED ? await authenticateSubscriber(ctx, token) : undefined;
      if (!sub) throw new AppError('UNAUTHORIZED', 'Invalid API key');
      req.principal = `sub:${sub.id}`;
      req.subscriptionId = sub.id;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Counts billable calls against the subscriber's plan quota. Operator keys are not metered. */
export function meter(ctx: AppContext, isBillable: (req: Request) => number) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.subscriptionId) return next();
    try {
      const n = isBillable(req);
      for (let i = 0; i < n; i++) await meterCall(ctx, req.subscriptionId);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Looks up a subscriber key without enforcing expiry (used to renew an expired plan). */
export async function subscriptionForRenewal(ctx: AppContext, req: Request): Promise<string | undefined> {
  const token = bearer(req);
  if (!token) return undefined;
  const sub = await ctx.billing.findSubscriptionByKeyHash(hashKey(token));
  if (!sub) throw new AppError('UNAUTHORIZED', 'Unknown API key for renewal');
  if (sub.revoked) throw new AppError('UNAUTHORIZED', 'API key revoked');
  return sub.id;
}

/**
 * Origin validation (DNS-rebinding / CSRF defence). Requests without an Origin
 * header (server-to-server MCP clients) are allowed; browser requests must come
 * from an allowlisted origin.
 */
export function validateOrigin(env: Env) {
  const allowed = new Set(env.allowedOrigins);
  return (req: Request, _res: Response, next: NextFunction) => {
    const origin = req.get('origin');
    if (!origin) return next();
    if (allowed.has(origin)) return next();
    log.warn('origin_rejected', { origin, path: req.path });
    next(new AppError('FORBIDDEN_ORIGIN', 'Origin not allowed'));
  };
}
