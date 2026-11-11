import type { Env } from './config/env.js';
import type { Plan } from './config/plans.js';
import type { RecordsSource } from './domain/unstoppable.js';
import type { GatewayRegistry } from './evm/gateway.js';
import type { PriceSource } from './pricing/prices.js';
import type { QuoteRecord } from './quote/compare-routes.js';
import type { PreparationRecord } from './transfer/prepare.js';
import type { AuditLog } from './store/audit.js';
import type { BillingRepo, KvStore, RateLimiter, StoreHealth } from './store/types.js';

/**
 * Composition root shared by REST and MCP so both use identical business logic.
 * Every stateful dependency is backed by Supabase Postgres in production; the
 * process itself keeps no files and no state that matters across requests.
 */
export interface AppContext {
  env: Env;
  records: RecordsSource;
  gateways: GatewayRegistry;
  prices: PriceSource;
  quotes: KvStore<QuoteRecord>;
  preparations: KvStore<PreparationRecord>;
  audit: AuditLog;
  /** Crypto-only subscription ledger (USDC paid to BILLING_DOMAIN). */
  billing: BillingRepo;
  limiter: RateLimiter;
  storeHealth: StoreHealth;
  plans: Plan[];
  /** Per-instance cache of token contracts already verified on-chain: "network:address" -> expiry ms */
  verifiedTokens: Map<string, number>;
  now: () => number;
}
