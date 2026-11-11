import { randomUUID } from 'node:crypto';
import type { Invoice, Payment, Subscription } from '../billing/types.js';

/**
 * Storage contracts. All durable state lives in Supabase Postgres in production
 * (see supabase/migrations). The server keeps no files, so Cloud Run instances stay
 * stateless and interchangeable.
 */
export interface KvStore<T extends { expiresAt: string }> {
  newId(): string;
  put(id: string, value: T): Promise<void>;
  get(id: string): Promise<T | undefined>;
  update(id: string, patch: Partial<T>): Promise<T | undefined>;
}

export interface CompletePaymentArgs {
  invoiceId: string;
  invoicePatch: Partial<Invoice>;
  /** Create this new subscription … */
  create?: Subscription;
  /** … or extend an existing one by one period. */
  extend?: { subscriptionId: string; planId: string; monthlyCalls: number; periodMs: number; nowIso: string; payment: Payment };
}

export interface BillingRepo {
  putInvoice(inv: Invoice): Promise<void>;
  getInvoice(id: string): Promise<Invoice | undefined>;
  updateInvoice(id: string, patch: Partial<Invoice>): Promise<void>;
  /** Invoice that already owns a tx hash, if any (read-only). */
  txOwner(txHash: string): Promise<string | undefined>;
  /** Reserve a tx hash for an invoice. Returns the invoice id that owns the hash (may be another invoice). */
  claimTx(txHash: string, invoiceId: string): Promise<string>;
  /**
   * Atomically flip the invoice from awaiting_payment to paid and create/extend the
   * subscription in the same transaction. Returns false if another request already did it.
   */
  completePayment(args: CompletePaymentArgs): Promise<boolean>;
  getSubscription(id: string): Promise<Subscription | undefined>;
  findSubscriptionByKeyHash(hash: string): Promise<Subscription | undefined>;
  /** Count one billable call atomically; resets the usage window when it has elapsed. */
  meter(subscriptionId: string, nowMs: number, periodMs: number): Promise<'ok' | 'quota' | 'missing'>;
  hasSubscriptions(): Promise<boolean>;
}

export interface RateLimiter {
  /** Increment and return the hit count for (key, window). */
  hit(key: string, windowStartMs: number): Promise<number>;
}

export interface StoreHealth {
  kind: 'postgres' | 'memory';
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

/** JSON with bigint support (bigints are tagged so they round-trip exactly). */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v));
}
export function revive<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value), (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$bigint === 'string' ? BigInt(v.$bigint) : v,
  ) as T;
}
