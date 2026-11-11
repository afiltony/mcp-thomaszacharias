import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { decodeFunctionData, erc20Abi, getAddress } from 'viem';
import { createApp } from '../src/app.js';
import { NETWORKS } from '../src/config/networks.js';
import { USDC } from '../src/config/tokens.js';
import { loadPlans } from '../src/config/plans.js';
import { normalizeDomain, type DomainRecords, type RecordsSource } from '../src/domain/unstoppable.js';
import { ops } from '../src/services.js';
import { FakeGateway, makeCtx, OTHER, RECIPIENT, SENDER, transferLog } from './helpers.js';

const TREASURY = getAddress('0x7777777777777777777777777777777777777777');
const TX = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
const TX2 = ('0x' + 'ef'.repeat(32)) as `0x${string}`;

/** vimatons.dao receives subscriptions; thomaszacharias.nft is a normal payment recipient. */
class DomainRecordsFake implements RecordsSource {
  constructor(public byDomain: Record<string, Record<string, string>>) {}
  async getRecords(domain: string): Promise<DomainRecords> {
    const d = normalizeDomain(domain);
    return { domain: d, owner: '0x9999999999999999999999999999999999999999', blockchain: 'MATIC', records: { ...(this.byDomain[d] ?? {}) }, fetchedAt: '' };
  }
}

async function setup(env: Record<string, string> = {}) {
  const records = new DomainRecordsFake({
    'vimatons.dao': { 'token.EVM.BASE.USDC.address': TREASURY },
    'thomaszacharias.nft': { 'token.EVM.BASE.USDC.address': RECIPIENT },
  });
  const gw = new FakeGateway(NETWORKS.base, { blockNumber: 500n });
  const ctx = await makeCtx({ recordsSource: records, gateways: { base: gw }, env: { API_KEYS: 'admin:operator-key-0123456789abcdef', RATE_LIMIT_PER_MINUTE: '1000', ...env } });
  return { ctx, gw, records };
}

const receiptFor = (value: bigint, over: Record<string, unknown> = {}) => ({
  status: 'success' as const,
  blockNumber: 500n,
  from: SENDER,
  to: USDC.base.address,
  gasUsed: 50_000n,
  effectiveGasPrice: 1n,
  logs: [transferLog(USDC.base.address, SENDER, TREASURY, value)],
  ...over,
});

describe('plans', () => {
  it('defaults are USDC-only and payable to vimatons.dao', async () => {
    const { ctx } = (await setup());
    const p = ops.plans(ctx);
    expect(p.payTo).toBe('vimatons.dao');
    expect(p.currency).toBe('USDC');
    expect(p.plans.map((x) => x.id)).toEqual(['starter', 'pro', 'business']);
  });
  it('validates custom plan JSON', () => {
    expect(loadPlans('[{"id":"team","name":"Team","priceUsdc":"99","periodDays":30,"monthlyCalls":5000}]')[0]!.id).toBe('team');
    expect(() => loadPlans('[{"id":"x","name":"X","priceUsdc":"-1","periodDays":30,"monthlyCalls":1}]')).toThrow();
    expect(() => loadPlans('not json')).toThrow();
  });
});

describe('invoices', () => {
  it('pays the USDC wallet resolved from vimatons.dao, never the payment recipient domain', async () => {
    const { ctx } = (await setup());
    const inv = await ops.createInvoice(ctx, { plan: 'pro', network: 'base', payer: SENDER });
    expect(inv.payTo).toMatchObject({ domain: 'vimatons.dao', address: TREASURY, recordKey: 'token.EVM.BASE.USDC.address' });
    expect(inv.amount).toBe('49 USDC');
    expect(inv.unsignedTransaction.to).toBe(USDC.base.address);
    const d = decodeFunctionData({ abi: erc20Abi, data: inv.unsignedTransaction.data });
    expect(d.args).toEqual([TREASURY, 49_000_000n]);
  });

  it('refuses a network where vimatons.dao has no USDC wallet', async () => {
    const { ctx } = (await setup());
    ctx.gateways.polygon = new FakeGateway(NETWORKS.polygon, {});
    await expect(ops.createInvoice(ctx, { plan: 'pro', network: 'polygon', payer: SENDER })).rejects.toMatchObject({ code: 'TREASURY_UNAVAILABLE' });
  });

  it('pauses payments if the resolved wallet differs from the pinned one', async () => {
    const { ctx } = (await setup({ BILLING_PINNED_ADDRESSES: `base:${OTHER}` }));
    await expect(ops.createInvoice(ctx, { plan: 'pro', network: 'base', payer: SENDER })).rejects.toMatchObject({ code: 'TREASURY_MISMATCH' });
    expect(ctx.audit.events.some((e) => e.event === 'treasury_mismatch')).toBe(true);
  });

  it('rejects unknown plans and bad payers', async () => {
    const { ctx } = (await setup());
    await expect(ops.createInvoice(ctx, { plan: 'gold', network: 'base', payer: SENDER })).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
    await expect(ops.createInvoice(ctx, { plan: 'pro', network: 'base', payer: '0x12' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('payment confirmation', () => {
  async function invoiced() {
    const s = await setup();
    const inv = await ops.createInvoice(s.ctx, { plan: 'starter', network: 'base', payer: SENDER });
    return { ...s, inv };
  }

  it('issues an API key only after a confirmed, correct USDC payment', async () => {
    const { ctx, gw, inv } = await invoiced();
    gw.o.receipt = receiptFor(10_000_000n, { blockNumber: 505n });
    gw.o.blockNumber = 507n;
    const waiting = await ops.confirmPayment(ctx, { invoiceId: inv.invoiceId, txHash: TX });
    expect(waiting).toMatchObject({ status: 'awaiting_confirmations', paid: false });
    expect((waiting as { apiKey?: string }).apiKey).toBeUndefined();

    gw.o.blockNumber = 520n;
    const paid = await ops.confirmPayment(ctx, { invoiceId: inv.invoiceId, txHash: TX });
    expect(paid.paid).toBe(true);
    const key = (paid as { apiKey: string }).apiKey;
    expect(key).toMatch(/^tzk_[0-9a-f]{64}$/);
    expect((paid as { subscription: { status: string; plan: { id: string } } }).subscription).toMatchObject({ status: 'active', plan: { id: 'starter' } });
    // key is hashed at rest
    const subId = (paid as { subscription: { subscriptionId: string } }).subscription.subscriptionId;
    expect(JSON.stringify(await ctx.billing.getSubscription(subId))).not.toContain(key);
    // idempotent re-confirm returns the same key within the pickup window
    expect(((await ops.confirmPayment(ctx, { invoiceId: inv.invoiceId, txHash: TX })) as { apiKey: string }).apiKey).toBe(key);
  });

  it('rejects underpayment, payments to another wallet, from another payer, or to a fake token', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [receiptFor(9_999_999n), /Underpaid/],
      [receiptFor(0n, { logs: [transferLog(USDC.base.address, SENDER, RECIPIENT, 10_000_000n)] }), /No USDC transfer/],
      [receiptFor(0n, { logs: [transferLog(USDC.base.address, OTHER, TREASURY, 10_000_000n)] }), /No USDC transfer/],
      [receiptFor(10_000_000n, { to: OTHER }), /official USDC contract/],
      [receiptFor(10_000_000n, { status: 'reverted' }), /reverted/],
      [receiptFor(10_000_000n, { blockNumber: 400n }), /predates/],
    ];
    for (const [rcpt, msg] of cases) {
      const { ctx, gw, inv } = await invoiced();
      gw.o.receipt = rcpt as never;
      gw.o.blockNumber = 600n;
      await expect(ops.confirmPayment(ctx, { invoiceId: inv.invoiceId, txHash: TX })).rejects.toThrow(msg);
      expect((await ctx.billing.getInvoice(inv.invoiceId))!.status).toBe('awaiting_payment');
    }
  });

  it('does not let one transaction pay two invoices', async () => {
    const { ctx, gw, inv } = await invoiced();
    gw.o.receipt = receiptFor(10_000_000n);
    gw.o.blockNumber = 600n;
    await ops.confirmPayment(ctx, { invoiceId: inv.invoiceId, txHash: TX });
    const inv2 = await ops.createInvoice(ctx, { plan: 'starter', network: 'base', payer: SENDER });
    await expect(ops.confirmPayment(ctx, { invoiceId: inv2.invoiceId, txHash: TX })).rejects.toMatchObject({ code: 'PAYMENT_ALREADY_USED' });
    await expect(ops.confirmPayment(ctx, { invoiceId: inv.invoiceId, txHash: TX2 })).rejects.toMatchObject({ code: 'PAYMENT_ALREADY_USED' });
  });

  it('reports pending and expired invoices', async () => {
    const { ctx, gw, inv } = await invoiced();
    gw.o.receipt = null;
    gw.o.pendingTx = true;
    expect(await ops.confirmPayment(ctx, { invoiceId: inv.invoiceId, txHash: TX })).toMatchObject({ status: 'pending', paid: false });
    gw.o.pendingTx = false;
    const later = Date.now() + 2 * 3600_000;
    ctx.now = () => later; // invoice TTL is 1 hour
    await expect(ops.confirmPayment(ctx, { invoiceId: inv.invoiceId, txHash: TX })).rejects.toMatchObject({ code: 'INVOICE_EXPIRED' });
  });
});

describe('subscriber access over HTTP', () => {
  async function subscribed(planEnv?: string) {
    const s = await setup(planEnv ? { BILLING_PLANS: planEnv } : {});
    const app = createApp(s.ctx);
    const inv = await request(app).post('/billing/invoices').send({ plan: planEnv ? 'tiny' : 'starter', network: 'base', payer: SENDER });
    expect(inv.status).toBe(200);
    s.gw.o.receipt = receiptFor(10_000_000n);
    s.gw.o.blockNumber = 600n;
    const conf = await request(app).post(`/billing/invoices/${inv.body.invoiceId}/confirm`).send({ txHash: TX });
    expect(conf.status).toBe(200);
    return { ...s, app, key: conf.body.apiKey as string, subId: conf.body.subscription.subscriptionId as string };
  }
  const mcpCall = (app: Parameters<typeof request>[0], key: string, name: string, args: unknown = {}) =>
    request(app)
      .post('/mcp')
      .set({ Authorization: `Bearer ${key}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' })
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  it('subscriber key unlocks /mcp and /api; unknown keys are refused', async () => {
    const { app, key } = await subscribed();
    expect((await request(app).get('/api/subscription').set({ Authorization: `Bearer ${key}` })).body.status).toBe('active');
    const r = await mcpCall(app, key, 'get_my_subscription');
    expect(JSON.parse(r.body.result.content[0].text).plan.id).toBe('starter');
    expect((await request(app).get('/api/networks').set({ Authorization: 'Bearer tzk_' + '0'.repeat(64) })).status).toBe(401);
  });

  it('enforces the plan quota on billable tool calls only', async () => {
    const { app, key } = await subscribed('[{"id":"tiny","name":"Tiny","priceUsdc":"10","periodDays":30,"monthlyCalls":2}]');
    expect((await mcpCall(app, key, 'resolve_web3_domain', { domain: 'thomaszacharias.nft' })).status).toBe(200);
    expect((await mcpCall(app, key, 'get_my_subscription')).status).toBe(200); // free
    expect((await mcpCall(app, key, 'resolve_web3_domain', { domain: 'thomaszacharias.nft' })).status).toBe(200);
    const over = await mcpCall(app, key, 'resolve_web3_domain', { domain: 'thomaszacharias.nft' });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(over.body.error.message).toContain('vimatons.dao');
  });

  it('expired subscriptions get 402 and can renew with their key', async () => {
    const { app, ctx, key, subId, gw } = await subscribed();
    const later = Date.now() + 31 * 86_400_000;
    ctx.now = () => later; // past the 30-day period
    const denied = await request(app).get('/api/subscription').set({ Authorization: `Bearer ${key}` });
    expect(denied.status).toBe(402);
    const renew = await request(app).post('/billing/invoices').set({ Authorization: `Bearer ${key}` }).send({ plan: 'starter', network: 'base', payer: SENDER });
    expect(renew.body.renewal).toBe(true);
    gw.o.receipt = receiptFor(10_000_000n, { blockNumber: 610n });
    gw.o.blockNumber = 650n;
    const conf = await request(app).post(`/billing/invoices/${renew.body.invoiceId}/confirm`).send({ txHash: TX2 });
    expect(conf.body.apiKey).toBeNull();
    expect(conf.body.subscription.subscriptionId).toBe(subId);
    expect((await request(app).get('/api/subscription').set({ Authorization: `Bearer ${key}` })).status).toBe(200);
  });

  it('serves the subscribe page with a strict CSP', async () => {
    const s = (await setup());
    const res = await request(createApp(s.ctx)).get('/subscribe');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect((await request(createApp(s.ctx)).get('/health')).body.billing).toEqual({ payTo: 'vimatons.dao', currency: 'USDC' });
  });
});
