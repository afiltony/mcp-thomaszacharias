import { Router, type Request, type Response, type NextFunction } from 'express';
import type { AppContext } from '../context.js';
import { ops } from '../services.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .then((body) => {
      if (!res.headersSent) res.json(body);
    })
    .catch(next);
};

/** "https://*.ipfs.dweb.link" → anchored regex; "*" spans host labels only (never "/", ":", "?", "#"). */
export function originMatcher(patterns: string[]): (origin: string) => boolean {
  if (patterns.includes('*')) return () => true;
  const res = patterns.map((p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\/]/g, '\\$&').replace(/\*/g, '[^/:?#]+') + '$', 'i'));
  return (origin) => res.some((r) => r.test(origin));
}

/**
 * Origin policy + CORS for the web app. Writes must carry an Origin header that is this host,
 * an ALLOWED_ORIGINS entry, or a WEB_ALLOWED_ORIGINS pattern (e.g. the IPFS gateways serving
 * the static build), so arbitrary sites cannot drive the API from a visitor's browser.
 * Non-browser callers can forge Origin; the per-IP rate limit and the fact that nothing here
 * signs or moves funds are the real controls.
 */
export function webOriginPolicy(ctx: AppContext) {
  const exact = new Set(ctx.env.allowedOrigins);
  const matches = originMatcher(
    ctx.env.WEB_ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('origin');
    if (!origin) return req.method === 'GET' ? next() : next(new AppError('FORBIDDEN_ORIGIN', 'Origin header required'));
    let host: string | undefined;
    try {
      host = new URL(origin).host;
    } catch {
      /* malformed */
    }
    const sameHost = !!host && host === req.get('host');
    if (!sameHost && !exact.has(origin) && !matches(origin)) {
      log.warn('origin_rejected', { origin, path: req.path });
      return next(new AppError('FORBIDDEN_ORIGIN', 'Origin not allowed'));
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    next();
  };
}

/**
 * Keyless endpoints for the first-party web app. Same operations as the REST API, minus
 * anything a public page doesn't need. Preparations stay unsigned; the visitor's own wallet
 * signs on the page, which re-checks via /public/transfers/:id/recheck first.
 */
export function webAppRouter(ctx: AppContext): Router {
  const r = Router();
  r.post('/resolve', h((req) => ops.resolveDomain(ctx, req.body)));
  r.get('/networks', h(() => ops.supportedNetworks(ctx)));
  r.get('/plans', h(() => ops.plans(ctx)));
  r.post('/quotes', h((req) => ops.compare(ctx, req.body)));
  r.post('/transfers/prepare', h((req) => ops.prepare(ctx, req.body)));
  r.post('/transfers/verify', h((req) => ops.verify(ctx, req.body)));
  r.post('/transfers/:id/recheck', h((req) => ops.recheck(ctx, String(req.params.id))));
  return r;
}
