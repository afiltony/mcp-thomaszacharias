import 'dotenv/config';
import { z } from 'zod';
import { registerSecret } from '../lib/logger.js';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_BASE_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * How Unstoppable Domains records are read. "onchain" reads the UNS registry contracts over the
   * RPC URLs below (no API key). "api" uses the Resolution Service API (needs UNSTOPPABLE_API_KEY).
   * "auto" = api when a key is set, otherwise onchain.
   */
  UD_RESOLVER: z.enum(['auto', 'onchain', 'api']).default('auto'),
  // Unstoppable Domains Resolution Service (server-side only; optional with UD_RESOLVER=onchain)
  UNSTOPPABLE_API_KEY: z.string().optional(),
  UNSTOPPABLE_API_BASE: z.string().url().default('https://api.unstoppabledomains.com/resolve'),
  UNSTOPPABLE_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  /** "ud-precedence" follows UD's documented getAddress order incl. EVM family records; "strict" only accepts USDC-specific records. */
  RECIPIENT_RECORD_POLICY: z.enum(['ud-precedence', 'strict']).default('ud-precedence'),

  // RPC endpoints (server-side only). A network without an RPC URL is reported as not configured.
  ETHEREUM_RPC_URL: z.string().url().optional(),
  BASE_RPC_URL: z.string().url().optional(),
  POLYGON_RPC_URL: z.string().url().optional(),
  RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  // Price source (CoinGecko-compatible simple/price API)
  PRICE_API_BASE: z.string().url().default('https://api.coingecko.com/api/v3'),
  PRICE_FEED_API_KEY: z.string().optional(),
  PRICE_API_KEY_HEADER: z.string().default('x-cg-demo-api-key'),
  PRICE_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(300),
  PRICE_CACHE_SECONDS: z.coerce.number().int().nonnegative().default(30),

  // Quotes & preparations
  QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  PREPARATION_TTL_SECONDS: z.coerce.number().int().positive().default(180),
  MAX_TRANSFER_USDC: z.string().regex(/^\d+(\.\d+)?$/).default('10000'),
  GAS_LIMIT_BUFFER_BPS: z.coerce.number().int().min(10000).max(30000).default(12000),
  L1_FEE_BUFFER_BPS: z.coerce.number().int().min(10000).max(30000).default(12500),

  // Security
  /** Comma-separated "name:key" pairs. Required in production. */
  API_KEYS: z.string().optional(),
  /** HMAC secret used to bind prepared transactions. Required in production (>= 32 chars). */
  MCP_AUTH_SECRET: z.string().optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  PUBLIC_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
  REQUEST_BODY_LIMIT: z.string().default('32kb'),
  TRUST_PROXY: bool,
  // ---- Supabase Postgres (all durable state; the server writes no files) ----
  /** Supabase pooler connection string (Supavisor, transaction mode, port 6543). */
  DATABASE_URL: z.string().optional(),
  /** Supabase CA certificate (PEM). When set, the database TLS certificate is verified. */
  DATABASE_CA_CERT: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(50).default(5),
  /** Apply pending supabase/migrations at startup. */
  AUTO_MIGRATE: bool,

  // ---- Subscription billing (crypto only: USDC paid to the billing domain's linked wallets) ----
  BILLING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  /** Web3 domain whose USDC records receive all subscription payments. */
  BILLING_DOMAIN: z.string().default('vimatons.dao'),
  /** Optional pin, e.g. "base:0xabc…,polygon:0xdef…". If set for a network, the resolved address must match it. */
  BILLING_PINNED_ADDRESSES: z.string().optional(),
  /** JSON array of plans; see src/config/plans.ts for the shape and defaults. */
  BILLING_PLANS: z.string().optional(),
  BILLING_INVOICE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
});

export type Env = z.infer<typeof EnvSchema> & {
  apiKeys: Map<string, string>; // key -> principal name
  allowedOrigins: string[];
  /** Effective domain resolver after resolving UD_RESOLVER=auto. */
  resolver: 'onchain' | 'api';
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;

  const apiKeys = new Map<string, string>();
  for (const pair of (e.API_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = pair.indexOf(':');
    const name = idx > 0 ? pair.slice(0, idx) : 'default';
    const key = idx > 0 ? pair.slice(idx + 1) : pair;
    if (key.length < 24) throw new Error(`API key for "${name}" must be at least 24 characters`);
    apiKeys.set(key, name);
  }

  const resolver: 'onchain' | 'api' = e.UD_RESOLVER === 'auto' ? (e.UNSTOPPABLE_API_KEY ? 'api' : 'onchain') : e.UD_RESOLVER;

  if (e.NODE_ENV === 'production') {
    if (apiKeys.size === 0) throw new Error('API_KEYS is required in production');
    if (!e.MCP_AUTH_SECRET || e.MCP_AUTH_SECRET.length < 32) throw new Error('MCP_AUTH_SECRET (>= 32 chars) is required in production');
    if (resolver === 'api' && !e.UNSTOPPABLE_API_KEY) throw new Error('UNSTOPPABLE_API_KEY is required when UD_RESOLVER=api');
    if (resolver === 'onchain' && !e.POLYGON_RPC_URL) throw new Error('POLYGON_RPC_URL is required for on-chain domain resolution');
    if (!e.PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL is required in production');
    if (!e.DATABASE_URL) throw new Error('DATABASE_URL (Supabase) is required in production');
  }

  for (const s of [e.DATABASE_URL, e.UNSTOPPABLE_API_KEY, e.ETHEREUM_RPC_URL, e.BASE_RPC_URL, e.POLYGON_RPC_URL, e.PRICE_FEED_API_KEY, e.MCP_AUTH_SECRET, ...apiKeys.keys()]) {
    registerSecret(s);
  }

  const allowedOrigins = (e.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (e.PUBLIC_BASE_URL) allowedOrigins.push(new URL(e.PUBLIC_BASE_URL).origin);

  return { ...e, apiKeys, allowedOrigins, resolver };
}
