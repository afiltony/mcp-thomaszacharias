import type { Invoice, Subscription } from '../billing/types.js';
import { iso, type Db, type Sql } from './db.js';
import { newId, revive, toJson, type BillingRepo, type CompletePaymentArgs, type KvStore, type RateLimiter } from './types.js';

/** Opportunistic cleanup instead of a scheduler: Cloud Run has no background workers. */
function maybe(p = 0.02) {
  return Math.random() < p;
}

export class PgKvStore<T extends { expiresAt: string }> implements KvStore<T> {
  constructor(private readonly db: Sql, private readonly kind: 'quote' | 'preparation', private readonly prefix: string) {}

  newId() {
    return newId(this.prefix);
  }

  async put(id: string, value: T) {
    await this.db.query(
      `insert into kv_records (id, kind, data, expires_at) values ($1, $2, $3::jsonb, $4)
       on conflict (id) do update set data = excluded.data, expires_at = excluded.expires_at`,
      [id, this.kind, toJson(value), value.expiresAt],
    );
    // Keep expired records for a day so clients get "expired" rather than "not found".
    if (maybe()) await this.db.query(`delete from kv_records where expires_at < now() - interval '1 day'`);
  }

  async get(id: string) {
    const { rows } = await this.db.query<{ data: unknown }>('select data from kv_records where id = $1 and kind = $2', [id, this.kind]);
    return rows[0] ? revive<T>(rows[0].data) : undefined;
  }

  async update(id: string, patch: Partial<T>) {
    const { rows } = await this.db.query<{ data: unknown }>(
      'update kv_records set data = data || $3::jsonb where id = $1 and kind = $2 returning data',
      [id, this.kind, toJson(patch)],
    );
    return rows[0] ? revive<T>(rows[0].data) : undefined;
  }
}

interface SubRow {
  id: string;
  key_hash: string;
  key_prefix: string;
  plan_id: string;
  payer: string;
  created_at: unknown;
  expires_at: unknown;
  monthly_calls: number;
  period_start: unknown;
  calls: number;
  revoked: boolean;
  payments: unknown;
}

function toSub(r: SubRow): Subscription {
  return {
    id: r.id,
    keyHash: r.key_hash,
    keyPrefix: r.key_prefix,
    planId: r.plan_id,
    payer: r.payer as Subscription['payer'],
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    monthlyCalls: Number(r.monthly_calls),
    usage: { periodStart: iso(r.period_start), calls: Number(r.calls) },
    payments: revive(r.payments),
    revoked: r.revoked || undefined,
  };
}

export class PgBillingRepo implements BillingRepo {
  constructor(private readonly db: Db) {}

  async putInvoice(inv: Invoice) {
    await this.db.query('insert into invoices (id, status, data) values ($1, $2, $3::jsonb)', [inv.id, inv.status, toJson(inv)]);
  }

  async getInvoice(id: string) {
    const { rows } = await this.db.query<{ status: Invoice['status']; data: unknown }>('select status, data from invoices where id = $1', [id]);
    return rows[0] ? { ...revive<Invoice>(rows[0].data), status: rows[0].status } : undefined;
  }

  async updateInvoice(id: string, patch: Partial<Invoice>) {
    // `null` removes a key (used to wipe the encrypted key-pickup blob).
    const removals = Object.entries(patch).filter(([, v]) => v === undefined).map(([k]) => k);
    const sets = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    await this.db.query(
      `update invoices set data = (data - $3::text[]) || $2::jsonb, status = coalesce($4, status), updated_at = now() where id = $1`,
      [id, toJson(sets), removals, patch.status ?? null],
    );
  }

  async txOwner(txHash: string) {
    const { rows } = await this.db.query<{ invoice_id: string }>('select invoice_id from used_tx_hashes where tx_hash = $1', [txHash]);
    return rows[0]?.invoice_id;
  }

  async claimTx(txHash: string, invoiceId: string) {
    const { rows } = await this.db.query<{ invoice_id: string }>(
      `with ins as (
         insert into used_tx_hashes (tx_hash, invoice_id) values ($1, $2)
         on conflict (tx_hash) do nothing returning invoice_id
       )
       select invoice_id from ins
       union all
       select invoice_id from used_tx_hashes where tx_hash = $1
       limit 1`,
      [txHash, invoiceId],
    );
    return rows[0]!.invoice_id;
  }

  completePayment(a: CompletePaymentArgs) {
    return this.db.transaction(async (q) => {
      const flipped = await q.query(
        `update invoices set status = 'paid', data = data || $2::jsonb, updated_at = now()
         where id = $1 and status = 'awaiting_payment' returning id`,
        [a.invoiceId, toJson({ ...a.invoicePatch, status: 'paid' })],
      );
      if (flipped.rows.length === 0) return false;
      if (a.create) {
        const s = a.create;
        await q.query(
          `insert into subscriptions (id, key_hash, key_prefix, plan_id, payer, created_at, expires_at, monthly_calls, period_start, calls, payments)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
          [s.id, s.keyHash, s.keyPrefix, s.planId, s.payer, s.createdAt, s.expiresAt, s.monthlyCalls, s.usage.periodStart, s.usage.calls, toJson(s.payments)],
        );
      } else if (a.extend) {
        const e = a.extend;
        const r = await q.query(
          `update subscriptions set
             expires_at    = greatest(expires_at, $5::timestamptz) + ($4::double precision * interval '1 millisecond'),
             plan_id       = $2,
             monthly_calls = $3,
             calls         = case when period_start + interval '30 days' <= $5::timestamptz then 0 else calls end,
             period_start  = case when period_start + interval '30 days' <= $5::timestamptz then $5::timestamptz else period_start end,
             payments      = payments || $6::jsonb
           where id = $1 and not revoked returning id`,
          [e.subscriptionId, e.planId, e.monthlyCalls, e.periodMs, e.nowIso, toJson([e.payment])],
        );
        if (r.rows.length === 0) throw new Error('subscription to extend is missing or revoked');
      }
      return true;
    });
  }

  async getSubscription(id: string) {
    const { rows } = await this.db.query<SubRow>('select * from subscriptions where id = $1', [id]);
    return rows[0] ? toSub(rows[0]) : undefined;
  }

  async findSubscriptionByKeyHash(hash: string) {
    const { rows } = await this.db.query<SubRow>('select * from subscriptions where key_hash = $1', [hash]);
    return rows[0] ? toSub(rows[0]) : undefined;
  }

  async meter(subscriptionId: string, nowMs: number, periodMs: number) {
    const now = new Date(nowMs).toISOString();
    const { rows } = await this.db.query(
      `update subscriptions set
         calls        = case when period_start + ($3::double precision * interval '1 millisecond') <= $2::timestamptz then 1 else calls + 1 end,
         period_start = case when period_start + ($3::double precision * interval '1 millisecond') <= $2::timestamptz then $2::timestamptz else period_start end
       where id = $1
         and (period_start + ($3::double precision * interval '1 millisecond') <= $2::timestamptz or calls < monthly_calls)
       returning calls`,
      [subscriptionId, now, periodMs],
    );
    if (rows.length) return 'ok' as const;
    const exists = await this.db.query('select 1 from subscriptions where id = $1', [subscriptionId]);
    return exists.rows.length ? ('quota' as const) : ('missing' as const);
  }

  async hasSubscriptions() {
    const { rows } = await this.db.query('select 1 from subscriptions limit 1');
    return rows.length > 0;
  }
}

export class PgRateLimiter implements RateLimiter {
  constructor(private readonly db: Sql) {}
  async hit(key: string, windowStartMs: number) {
    const { rows } = await this.db.query<{ count: number }>(
      `insert into rate_limits (key, window_start, count) values ($1, $2, 1)
       on conflict (key, window_start) do update set count = rate_limits.count + 1
       returning count`,
      [key, new Date(windowStartMs).toISOString()],
    );
    if (maybe(0.01)) await this.db.query(`delete from rate_limits where window_start < now() - interval '10 minutes'`);
    return Number(rows[0]!.count);
  }
}
