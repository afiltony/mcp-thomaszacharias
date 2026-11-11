import type { Invoice, Subscription } from '../billing/types.js';
import { newId, revive, toJson, type BillingRepo, type CompletePaymentArgs, type KvStore, type RateLimiter } from './types.js';

/**
 * In-memory implementations for local development and tests. They mirror the Postgres
 * semantics (atomic flips, unique tx hashes, JSON round-trips) so tests exercise the same rules.
 * Not for production: Cloud Run instances do not share memory.
 */
const clone = <T>(v: T): T => revive<T>(JSON.parse(toJson(v)));

export class MemoryKvStore<T extends { expiresAt: string }> implements KvStore<T> {
  items = new Map<string, T>();
  constructor(private readonly prefix: string) {}
  newId() {
    return newId(this.prefix);
  }
  async put(id: string, value: T) {
    this.items.set(id, clone(value));
  }
  async get(id: string) {
    const v = this.items.get(id);
    return v ? clone(v) : undefined;
  }
  async update(id: string, patch: Partial<T>) {
    const cur = this.items.get(id);
    if (!cur) return undefined;
    const next = clone({ ...cur, ...patch });
    this.items.set(id, next);
    return clone(next);
  }
}

export class MemoryBillingRepo implements BillingRepo {
  invoices = new Map<string, Invoice>();
  subscriptions = new Map<string, Subscription>();
  usedTx = new Map<string, string>();

  async putInvoice(inv: Invoice) {
    this.invoices.set(inv.id, clone(inv));
  }
  async getInvoice(id: string) {
    const v = this.invoices.get(id);
    return v ? clone(v) : undefined;
  }
  async updateInvoice(id: string, patch: Partial<Invoice>) {
    const cur = this.invoices.get(id);
    if (!cur) return;
    const next: Record<string, unknown> = { ...cur, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    this.invoices.set(id, clone(next as unknown as Invoice));
  }
  async txOwner(txHash: string) {
    return this.usedTx.get(txHash);
  }
  async claimTx(txHash: string, invoiceId: string) {
    if (!this.usedTx.has(txHash)) this.usedTx.set(txHash, invoiceId);
    return this.usedTx.get(txHash)!;
  }
  async completePayment(a: CompletePaymentArgs) {
    const inv = this.invoices.get(a.invoiceId);
    if (!inv || inv.status !== 'awaiting_payment') return false;
    if (a.extend) {
      const s = this.subscriptions.get(a.extend.subscriptionId);
      if (!s || s.revoked) throw new Error('subscription to extend is missing or revoked');
      const now = Date.parse(a.extend.nowIso);
      s.expiresAt = new Date(Math.max(now, Date.parse(s.expiresAt)) + a.extend.periodMs).toISOString();
      s.planId = a.extend.planId;
      s.monthlyCalls = a.extend.monthlyCalls;
      if (Date.parse(s.usage.periodStart) + 30 * 86_400_000 <= now) s.usage = { periodStart: a.extend.nowIso, calls: 0 };
      s.payments.push(clone(a.extend.payment));
    }
    if (a.create) this.subscriptions.set(a.create.id, clone(a.create));
    this.invoices.set(a.invoiceId, clone({ ...inv, ...a.invoicePatch, status: 'paid' }));
    return true;
  }
  async getSubscription(id: string) {
    const v = this.subscriptions.get(id);
    return v ? clone(v) : undefined;
  }
  async findSubscriptionByKeyHash(hash: string) {
    const v = [...this.subscriptions.values()].find((s) => s.keyHash === hash);
    return v ? clone(v) : undefined;
  }
  async meter(id: string, nowMs: number, periodMs: number) {
    const s = this.subscriptions.get(id);
    if (!s) return 'missing' as const;
    if (Date.parse(s.usage.periodStart) + periodMs <= nowMs) {
      s.usage = { periodStart: new Date(nowMs).toISOString(), calls: 1 };
      return 'ok' as const;
    }
    if (s.usage.calls >= s.monthlyCalls) return 'quota' as const;
    s.usage.calls++;
    return 'ok' as const;
  }
  async hasSubscriptions() {
    return this.subscriptions.size > 0;
  }
}

export class MemoryRateLimiter implements RateLimiter {
  private windows = new Map<string, number>();
  async hit(key: string, windowStartMs: number) {
    const k = `${key}@${windowStartMs}`;
    const n = (this.windows.get(k) ?? 0) + 1;
    this.windows.set(k, n);
    if (this.windows.size > 10_000) for (const kk of this.windows.keys()) if (Number(kk.split('@').pop()) < windowStartMs) this.windows.delete(kk);
    return n;
  }
}
