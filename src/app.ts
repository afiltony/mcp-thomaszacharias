import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { AppContext } from './context.js';
import { apiRouter, billingRouter, publicApprovalRouter } from './api/routes.js';
import { webAppRouter, webOriginPolicy } from './api/web.js';
import { createMcpServer, FREE_TOOLS } from './mcp/tools.js';
import { meter, requireApiKey, validateOrigin } from './security/auth.js';

const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
import { rateLimit } from './security/rate-limit.js';
import { AppError, toAppError } from './lib/errors.js';
import { log } from './lib/logger.js';
import { NETWORK_IDS } from './config/networks.js';

const here = dirname(fileURLToPath(import.meta.url));
function publicDir() {
  for (const p of [join(here, '..', 'public'), join(process.cwd(), 'public')]) if (existsSync(p)) return p;
  return join(process.cwd(), 'public');
}

export function createApp(ctx: AppContext) {
  const { env } = ctx;
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', true); // Cloud Run (and Cloudflare, if used) terminate TLS in front of Node

  app.use((req, res, next) => {
    const start = Date.now();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.on('finish', () => log.info('http', { method: req.method, path: req.path.replace(/p_[0-9a-f]{32}/, 'p_…'), status: res.statusCode, ms: Date.now() - start }));
    next();
  });
  app.use(express.json({ limit: env.REQUEST_BODY_LIMIT, strict: true }));

  // ---- Health (unauthenticated, no secrets) ----
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'thomaszacharias-mcp',
      version: '0.2.0',
      time: new Date().toISOString(),
      resolver: env.resolver,
      resolverConfigured: env.resolver === 'api' ? Boolean(env.UNSTOPPABLE_API_KEY) : Boolean(env.POLYGON_RPC_URL),
      store: ctx.storeHealth.kind,
      billing: env.BILLING_ENABLED ? { payTo: env.BILLING_DOMAIN, currency: 'USDC' } : 'disabled',
      networks: Object.fromEntries(NETWORK_IDS.map((n) => [n, Boolean(ctx.gateways[n])])),
    });
  });

  // Readiness: confirms the Supabase connection (no secrets in the response).
  app.get('/health/ready', async (_req, res) => {
    try {
      await ctx.storeHealth.ping();
      res.json({ status: 'ready', store: ctx.storeHealth.kind });
    } catch {
      res.status(503).json({ status: 'unavailable', store: ctx.storeHealth.kind });
    }
  });

  // ---- MCP (Streamable HTTP, stateless JSON responses: fits Cloud Run's request model) ----
  const auth = requireApiKey(ctx);
  // Per-IP limit runs before the API-key lookup, so floods of bad keys never reach the database lookup.
  const ipLimit = rateLimit(ctx.limiter, { perMinute: env.RATE_LIMIT_PER_MINUTE * 2, scope: 'ip' });
  const mcpAuth = [validateOrigin(env), ipLimit, auth, rateLimit(ctx.limiter, { perMinute: env.RATE_LIMIT_PER_MINUTE, scope: 'mcp' })];
  // Billable MCP calls = tools/call requests (handshakes and tools/list are free).
  const mcpBillable = (req: Request) => {
    const msgs = Array.isArray(req.body) ? req.body : [req.body];
    return msgs.filter((m) => m && m.method === 'tools/call' && !FREE_TOOLS.has(m.params?.name)).length;
  };
  app.post('/mcp', ...mcpAuth, meter(ctx, mcpBillable), async (req: Request, res: Response) => {
    const server = createMcpServer(ctx, req.principal, req.subscriptionId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error('mcp_transport_error', { err: String(err) });
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  const methodNotAllowed = (_req: Request, res: Response) =>
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: use POST)' }, id: null });
  app.get('/mcp', ...mcpAuth, methodNotAllowed);
  app.delete('/mcp', ...mcpAuth, methodNotAllowed);

  // ---- REST API ----
  const apiBillable = (req: Request) => (req.path === '/subscription' || req.path === '/networks' ? 0 : 1);
  app.use('/api', validateOrigin(env), ipLimit, auth, rateLimit(ctx.limiter, { perMinute: env.RATE_LIMIT_PER_MINUTE, scope: 'api' }), meter(ctx, apiBillable), apiRouter(ctx));

  // ---- Subscriptions: crypto only, USDC paid to BILLING_DOMAIN (vimatons.dao) ----
  app.use('/billing', validateOrigin(env), rateLimit(ctx.limiter, { perMinute: env.PUBLIC_RATE_LIMIT_PER_MINUTE, scope: 'billing' }), billingRouter(ctx));
  app.get('/subscribe', (_req, res) => {
    res.setHeader('Content-Security-Policy', PAGE_CSP);
    res.sendFile(join(publicDir(), 'subscribe.html'));
  });
  app.get('/subscribe.js', (_req, res) => res.sendFile(join(publicDir(), 'subscribe.js')));

  // ---- Wallet approval page + its narrow public endpoints ----
  app.use('/public/transfers', validateOrigin(env), rateLimit(ctx.limiter, { perMinute: env.PUBLIC_RATE_LIMIT_PER_MINUTE, scope: 'public' }), publicApprovalRouter(ctx));
  app.get('/approve/:id', (req, res) => {
    if (!/^p_[0-9a-f]{32}$/.test(String(req.params.id))) return res.status(404).send('Not found');
    res.setHeader('Content-Security-Policy', PAGE_CSP);
    res.sendFile(join(publicDir(), 'approve.html'));
  });
  app.get('/approve.js', (_req, res) => res.sendFile(join(publicDir(), 'approve.js')));

  // ---- Keyless browser API (used by this server's web app and by the IPFS-hosted copy) ----
  // Not metered against subscriptions: it is per-IP rate-limited and origin-checked instead.
  if (env.WEB_API_ENABLED) {
    app.use('/web-api', webOriginPolicy(ctx), rateLimit(ctx.limiter, { perMinute: env.WEB_RATE_LIMIT_PER_MINUTE, scope: 'web' }), webAppRouter(ctx));
  }

  // ---- Browser web app (static SPA) ----
  if (env.WEB_APP_ENABLED) {
    const webDir = join(publicDir(), 'app');
    const webCsp =
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    const cache = env.NODE_ENV === 'production' ? '1h' : 0;
    const setCsp = (res: Response) => res.setHeader('Content-Security-Policy', webCsp);
    if (env.MEDIA_DIR) app.use('/assets/media', express.static(env.MEDIA_DIR, { index: false, maxAge: cache, setHeaders: setCsp }));
    app.use('/assets', express.static(join(webDir, 'assets'), { index: false, maxAge: cache, setHeaders: setCsp }));
    // Client-side routes all serve the same shell.
    app.get(['/', '/pay', '/resolve', '/compare', '/history', '/saved', '/networks', '/pricing', '/docs'], (_req, res) => {
      setCsp(res);
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(webDir, 'index.html'));
    });
  }

  app.use((_req, _res, next) => next(new AppError('INVALID_REQUEST', 'Not found')));

  // ---- Errors ----
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if ((err as { type?: string })?.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'INVALID_REQUEST', message: 'Request body too large' } });
    }
    if ((err as { type?: string })?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Malformed JSON body' } });
    }
    const e = toAppError(err);
    if (e.code === 'INTERNAL') log.error('unhandled_error', { path: req.path, err: String(err), stack: (err as Error)?.stack });
    const status = e.message === 'Not found' ? 404 : e.status;
    res.status(status).json(e.toJSON());
  });

  return app;
}
