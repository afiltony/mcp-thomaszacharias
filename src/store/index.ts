import type { Env } from '../config/env.js';
import type { QuoteRecord } from '../quote/compare-routes.js';
import type { PreparationRecord } from '../transfer/prepare.js';
import { log } from '../lib/logger.js';
import { MemoryAuditLog, PostgresAuditLog, type AuditLog } from './audit.js';
import { connectPostgres, type Db } from './db.js';
import { MemoryBillingRepo, MemoryKvStore, MemoryRateLimiter } from './memory.js';
import { migrate } from './migrate.js';
import { PgBillingRepo, PgKvStore, PgRateLimiter } from './postgres.js';
import type { BillingRepo, KvStore, RateLimiter, StoreHealth } from './types.js';

export interface Stores {
  quotes: KvStore<QuoteRecord>;
  preparations: KvStore<PreparationRecord>;
  billing: BillingRepo;
  limiter: RateLimiter;
  audit: AuditLog;
  storeHealth: StoreHealth;
}

export function postgresStores(db: Db): Stores {
  return {
    quotes: new PgKvStore<QuoteRecord>(db, 'quote', 'q'),
    preparations: new PgKvStore<PreparationRecord>(db, 'preparation', 'p'),
    billing: new PgBillingRepo(db),
    limiter: new PgRateLimiter(db),
    audit: new PostgresAuditLog(db),
    storeHealth: { kind: 'postgres', ping: async () => void (await db.query('select 1')), close: () => db.close() },
  };
}

export function memoryStores(): Stores {
  return {
    quotes: new MemoryKvStore<QuoteRecord>('q'),
    preparations: new MemoryKvStore<PreparationRecord>('p'),
    billing: new MemoryBillingRepo(),
    limiter: new MemoryRateLimiter(),
    audit: new MemoryAuditLog(),
    storeHealth: { kind: 'memory', ping: async () => undefined, close: async () => undefined },
  };
}

/** Supabase Postgres when DATABASE_URL is set; in-memory (dev only) otherwise. */
export async function createStores(env: Env): Promise<Stores> {
  if (!env.DATABASE_URL) {
    log.warn('store_memory', { note: 'DATABASE_URL not set — using in-memory storage (development only, lost on restart)' });
    return memoryStores();
  }
  const db = connectPostgres(env.DATABASE_URL, { max: env.DATABASE_POOL_MAX, caCert: env.DATABASE_CA_CERT });
  if (!env.DATABASE_CA_CERT && !/sslmode=disable/.test(env.DATABASE_URL)) log.warn('db_tls_unverified', { note: 'Set DATABASE_CA_CERT to verify the Supabase TLS certificate' });
  if (env.AUTO_MIGRATE) {
    const applied = await migrate(db);
    log.info('migrations', { applied });
  }
  await db.query('select 1');
  return postgresStores(db);
}
