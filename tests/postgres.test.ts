import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { NETWORKS } from '../src/config/networks.js';
import { USDC } from '../src/config/tokens.js';
import { normalizeDomain, type DomainRecords, type RecordsSource } from '../src/domain/unstoppable.js';
import { ops } from '../src/services.js';
import { postgresStores } from '../src/store/index.js';
import { FakeGateway, makeCtx, pgliteDb, RECIPIENT, SENDER, TEST_STORE, transferLog } from './helpers.js';

const TREASURY = getAddress('0x7777777777777777777777777777777777777777');
const TX = ('0x' + '9a'.repeat(32)) as `0x${string}`;

class Recs implements RecordsSource {
  async getRecords(domain: string): Promise<DomainRecords> {
    const d = normalizeDomain(domain);
    const records: Record<string, string> = d === 'vimatons.dao' ? { 'token.EVM.BASE.USDC.address': TREASURY } : { 'token.EVM.BASE.USDC.address': RECIPIENT };
    return { domain: d, owner: '0x9999999999999999999999999999999999999999', blockchain: 'MATIC', records, fetchedAt: '' };
  }
}

describe.skipIf(TEST_STORE === 'memory')('Supabase Postgres store', () => {
  it('locks every table behind Row Level Security', async () => {
    const db = await pgliteDb();
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname in ('kv_records','invoices','subscriptions','used_tx_hashes','rate_limits','audit_log','schema_migrations')`,
    );
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it('a quote made on one instance can be prepared on another (stateless Cloud Run)', async () => {
    const gw = new FakeGateway(NETWORKS.base, {});
    const a = await makeCtx({ recordsSource: new Recs(), gateways: { base: gw } });
    const b = { ...a, ...postgresStores(await pgliteDb()), audit: a.audit, verifiedTokens: new Map() }; // second instance, same database
    const quote = await ops.compare(a, { domain: 'thomaszacharias.nft', amount: '25', sender: SENDER, networks: ['base'] });
    const prep = await ops.prepare(b, { quoteId: quote.quoteId, sender: SENDER, network: 'base' });
    expect(prep.decoded.recipient).toBe(RECIPIENT);
    expect((await a.preparations.get(prep.preparationId))?.amountRaw).toBe('25000000');
  });

  it('concurrent confirmations activate exactly one subscription', async () => {
    const gw = new FakeGateway(NETWORKS.base, { blockNumber: 500n });
    const ctx = await makeCtx({ recordsSource: new Recs(), gateways: { base: gw }, env: { API_KEYS: 'admin:operator-key-0123456789abcdef' } });
    const inv = await ops.createInvoice(ctx, { plan: 'starter', network: 'base', payer: SENDER });
    gw.o.receipt = { status: 'success', blockNumber: 500n, from: SENDER, to: USDC.base.address, gasUsed: 1n, effectiveGasPrice: 1n, logs: [transferLog(USDC.base.address, SENDER, TREASURY, 10_000_000n)] };
    gw.o.blockNumber = 600n;
    const results = await Promise.all([1, 2, 3].map(() => ops.confirmPayment(ctx, { invoiceId: inv.invoiceId, txHash: TX })));
    const ids = new Set(results.map((r) => (r as { subscription: { subscriptionId: string } }).subscription.subscriptionId));
    expect(ids.size).toBe(1);
    const db = await pgliteDb();
    const subs = await db.query<{ n: number }>('select count(*)::int as n from subscriptions');
    expect(subs.rows[0]!.n).toBe(1);
    const audit = await db.query<{ n: number }>(`select count(*)::int as n from audit_log where event = 'subscription_paid'`);
    expect(audit.rows[0]!.n).toBe(1);
  });

  it('rate limits are shared across instances', async () => {
    const ctx = await makeCtx();
    const other = postgresStores(await pgliteDb());
    const w = Date.now() - (Date.now() % 60_000);
    expect(await ctx.limiter.hit('api:alice', w)).toBe(1);
    expect(await other.limiter.hit('api:alice', w)).toBe(2);
  });
});
