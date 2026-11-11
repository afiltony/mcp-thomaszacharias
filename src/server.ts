import { loadEnv, type Env } from './config/env.js';
import type { AppContext } from './context.js';
import { UnstoppableRecordsSource } from './domain/unstoppable.js';
import { buildGateways } from './evm/gateway.js';
import { CoinGeckoPriceSource } from './pricing/prices.js';
import { createApp } from './app.js';
import { log, setLogLevel } from './lib/logger.js';
import { loadPlans } from './config/plans.js';
import { parsePinned } from './billing/billing.js';
import { createStores, type Stores } from './store/index.js';

export function buildContext(env: Env, stores: Stores): AppContext {
  return {
    env,
    records: new UnstoppableRecordsSource({ apiKey: env.UNSTOPPABLE_API_KEY, baseUrl: env.UNSTOPPABLE_API_BASE, timeoutMs: env.UNSTOPPABLE_TIMEOUT_MS }),
    gateways: buildGateways(env as unknown as Record<string, unknown>, env.RPC_TIMEOUT_MS),
    prices: new CoinGeckoPriceSource({
      baseUrl: env.PRICE_API_BASE,
      apiKey: env.PRICE_FEED_API_KEY,
      apiKeyHeader: env.PRICE_API_KEY_HEADER,
      cacheSeconds: env.PRICE_CACHE_SECONDS,
    }),
    ...stores,
    plans: loadPlans(env.BILLING_PLANS),
    verifiedTokens: new Map(),
    now: () => Date.now(),
  };
}

async function main() {
  let env: Env;
  let ctx: AppContext;
  try {
    env = loadEnv();
    setLogLevel(env.LOG_LEVEL);
    parsePinned(env.BILLING_PINNED_ADDRESSES);
    ctx = buildContext(env, await createStores(env));
  } catch (err) {
    log.error('startup_failed', { err: (err as Error).message });
    process.exit(1);
  }
  const app = createApp(ctx);
  // Cloud Run injects PORT (default 8080) and expects the server on 0.0.0.0.
  const server = app.listen(env.PORT, env.HOST, () => {
    log.info('server_started', {
      port: env.PORT,
      env: env.NODE_ENV,
      store: ctx.storeHealth.kind,
      networks: Object.keys(ctx.gateways),
      resolver: Boolean(env.UNSTOPPABLE_API_KEY),
      auth: env.apiKeys.size > 0 ? 'api-key' : 'DISABLED (dev)',
    });
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 45_000;
  const shutdown = (sig: string) => {
    log.info('shutdown', { sig });
    server.close(() => {
      void ctx.storeHealth.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM')); // Cloud Run sends SIGTERM before stopping an instance
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.env.VITEST !== 'true') void main();
