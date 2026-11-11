import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi } from 'viem';
import { NETWORKS } from '../src/config/networks.js';
import { USDC } from '../src/config/tokens.js';
import { ops } from '../src/services.js';
import { verifyBinding } from '../src/transfer/prepare.js';
import { FakeGateway, FakeRecords, makeCtx, OTHER, RECIPIENT, SENDER, transferLog } from './helpers.js';

const TX = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

async function quoteAndPrepare(over: Parameters<typeof makeCtx>[0] = {}) {
  const ctx = await makeCtx(over);
  const quote = await ops.compare(ctx, { domain: 'thomaszacharias.nft', amount: '25', sender: SENDER, networks: ['base'] });
  return { ctx, quote };
}

describe('prepare_transfer', () => {
  it('builds an unsigned ERC-20 transfer to the USDC contract with the recipient in calldata', async () => {
    const { ctx, quote } = await quoteAndPrepare();
    const prep = await ops.prepare(ctx, { quoteId: quote.quoteId, sender: SENDER, network: 'base' });
    expect(prep.signed).toBe(false);
    expect(prep.broadcast).toBe(false);
    expect(prep.unsignedTransaction.to).toBe(USDC.base.address);
    expect(prep.unsignedTransaction.chainId).toBe('0x2105');
    expect(prep.unsignedTransaction.value).toBe('0x0');
    const decoded = decodeFunctionData({ abi: erc20Abi, data: prep.unsignedTransaction.data });
    expect(decoded.functionName).toBe('transfer');
    expect(decoded.args).toEqual([RECIPIENT, 25_000_000n]);
    expect(prep.approvalSummary.transactionTo).toMatch(/USDC contract/);
    expect(prep.approvalUrl).toMatch(/^\/approve\/p_[0-9a-f]{32}$/);
    expect(ctx.audit.events.map((e) => e.event)).toContain('transfer_prepared');
  });

  it('binds fields so silent changes are detected', async () => {
    const { ctx, quote } = await quoteAndPrepare();
    const prep = await ops.prepare(ctx, { quoteId: quote.quoteId, sender: SENDER, network: 'base' });
    const stored = (await ctx.preparations.get(prep.preparationId))!;
    expect(verifyBinding(ctx, stored)).toBe(true);
    expect(verifyBinding(ctx, { ...stored, recipient: OTHER })).toBe(false);
    expect(verifyBinding(ctx, { ...stored, amountRaw: '25000001' })).toBe(false);
    expect(verifyBinding(ctx, { ...stored, chainId: 1 })).toBe(false);
    expect(verifyBinding(ctx, { ...stored, tokenContract: USDC.polygon.address })).toBe(false);
  });

  it('rejects an expired quote', async () => {
    const { ctx, quote } = await quoteAndPrepare();
    await ctx.quotes.update(quote.quoteId, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await expect(ops.prepare(ctx, { quoteId: quote.quoteId, sender: SENDER, network: 'base' })).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
  });

  it('rejects when the domain record changed after quoting', async () => {
    const records = new FakeRecords({ 'token.EVM.BASE.USDC.address': RECIPIENT });
    const { ctx, quote } = await quoteAndPrepare({ recordsSource: records });
    records.records['token.EVM.BASE.USDC.address'] = OTHER;
    await expect(ops.prepare(ctx, { quoteId: quote.quoteId, sender: SENDER, network: 'base' })).rejects.toMatchObject({ code: 'RECIPIENT_CHANGED' });
    expect(ctx.audit.events.map((e) => e.event)).toContain('recipient_changed');
  });

  it('rejects a wrong chain id at preparation time', async () => {
    const gw = new FakeGateway(NETWORKS.base, {});
    const { ctx, quote } = await quoteAndPrepare({ gateways: { base: gw } });
    gw.o.chainId = 84532;
    await expect(ops.prepare(ctx, { quoteId: quote.quoteId, sender: SENDER, network: 'base' })).rejects.toMatchObject({ code: 'CHAIN_ID_MISMATCH' });
  });

  it('rejects a malicious / non-USDC token contract', async () => {
    const { ctx, quote } = await quoteAndPrepare({ gateways: { base: new FakeGateway(NETWORKS.base, { tokenSymbol: 'USDbC' }) } });
    expect(quote.routes[0]!.reasons[0]!.code).toBe('TOKEN_CONTRACT_MISMATCH');
    await expect(ops.prepare(ctx, { quoteId: quote.quoteId, sender: SENDER, network: 'base' })).rejects.toMatchObject({ code: 'TOKEN_CONTRACT_MISMATCH' });
  });

  it('rejects insufficient balance discovered at preparation', async () => {
    const gw = new FakeGateway(NETWORKS.base, {});
    const { ctx, quote } = await quoteAndPrepare({ gateways: { base: gw } });
    gw.o.usdcBalance = 1n;
    await expect(ops.prepare(ctx, { quoteId: quote.quoteId, sender: SENDER, network: 'base' })).rejects.toMatchObject({ code: 'INSUFFICIENT_TOKEN_BALANCE' });
  });

  it('rejects when simulation fails', async () => {
    const gw = new FakeGateway(NETWORKS.base, {});
    const { ctx, quote } = await quoteAndPrepare({ gateways: { base: gw } });
    gw.o.simulateFails = true;
    await expect(ops.prepare(ctx, { quoteId: quote.quoteId, sender: SENDER, network: 'base' })).rejects.toMatchObject({ code: 'SIMULATION_FAILED' });
  });

  it('rejects a different sender than quoted and networks outside the quote', async () => {
    const { ctx, quote } = await quoteAndPrepare();
    await expect(ops.prepare(ctx, { quoteId: quote.quoteId, sender: OTHER, network: 'base' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(ops.prepare(ctx, { quoteId: quote.quoteId, sender: SENDER, network: 'polygon' })).rejects.toMatchObject({ code: 'ROUTE_NOT_ELIGIBLE' });
  });

  it('recheck before signing passes when nothing changed and fails when the record changed', async () => {
    const records = new FakeRecords({ 'token.EVM.BASE.USDC.address': RECIPIENT });
    const { ctx, quote } = await quoteAndPrepare({ recordsSource: records });
    const prep = await ops.prepare(ctx, { quoteId: quote.quoteId, sender: SENDER, network: 'base' });
    await expect(ops.recheck(ctx, prep.preparationId)).resolves.toMatchObject({ ok: true });
    records.records['token.EVM.BASE.USDC.address'] = OTHER;
    await expect(ops.recheck(ctx, prep.preparationId)).rejects.toMatchObject({ code: 'RECIPIENT_CHANGED' });
  });
});

describe('verify_transfer', () => {
  async function prepared(receiptOpts: Partial<ConstructorParameters<typeof FakeGateway>[1]> = {}) {
    const gw = new FakeGateway(NETWORKS.base, {});
    const { ctx, quote } = await quoteAndPrepare({ gateways: { base: gw } });
    const prep = await ops.prepare(ctx, { quoteId: quote.quoteId, sender: SENDER, network: 'base' });
    Object.assign(gw.o, receiptOpts);
    return { ctx, prep, gw };
  }
  const receipt = (over: Record<string, unknown> = {}) => ({
    status: 'success' as const,
    blockNumber: 990n,
    from: SENDER,
    to: USDC.base.address,
    gasUsed: 55_000n,
    effectiveGasPrice: 6_000_000n,
    l1Fee: 1_000_000_000n,
    logs: [transferLog(USDC.base.address, SENDER, RECIPIENT, 25_000_000n)],
    ...over,
  });

  it('confirms only after the required confirmations', async () => {
    const { ctx, prep } = await prepared({ receipt: receipt(), blockNumber: 1000n });
    const v = await ops.verify(ctx, { txHash: TX, preparationId: prep.preparationId });
    expect(v.status).toBe('confirmed');
    expect(v.success).toBe(true);
    expect((v as { confirmations: number }).confirmations).toBe(11);
  });

  it('reports awaiting_confirmations (not success) when too few confirmations', async () => {
    const { ctx, prep } = await prepared({ receipt: receipt({ blockNumber: 998n }), blockNumber: 1000n });
    const v = await ops.verify(ctx, { txHash: TX, preparationId: prep.preparationId });
    expect(v.status).toBe('awaiting_confirmations');
    expect(v.success).toBe(false);
  });

  it('reports reverted transactions as failed', async () => {
    const { ctx, prep } = await prepared({ receipt: receipt({ status: 'reverted', logs: [] }) });
    const v = await ops.verify(ctx, { txHash: TX, preparationId: prep.preparationId });
    expect(v.status).toBe('failed');
    expect(v.success).toBe(false);
  });

  it('flags a transfer to a different recipient or amount', async () => {
    const { ctx, prep } = await prepared({ receipt: receipt({ logs: [transferLog(USDC.base.address, SENDER, OTHER, 25_000_000n)] }) });
    expect((await ops.verify(ctx, { txHash: TX, preparationId: prep.preparationId })).status).toBe('mismatch');
  });

  it('flags a transaction to a non-USDC contract', async () => {
    const fake = '0x3333333333333333333333333333333333333333' as const;
    const { ctx, prep } = await prepared({ receipt: receipt({ to: fake, logs: [transferLog(fake, SENDER, RECIPIENT, 25_000_000n)] }) });
    expect((await ops.verify(ctx, { txHash: TX, preparationId: prep.preparationId })).status).toBe('mismatch');
  });

  it('distinguishes pending from not found', async () => {
    const a = await prepared({ receipt: null, pendingTx: true });
    expect((await ops.verify(a.ctx, { txHash: TX, preparationId: a.prep.preparationId })).status).toBe('pending');
    const b = await prepared({ receipt: null, pendingTx: false });
    expect((await ops.verify(b.ctx, { txHash: TX, network: 'base' })).status).toBe('not_found');
  });

  it('validates input', async () => {
    const ctx = await makeCtx();
    await expect(ops.verify(ctx, { txHash: '0x1234', network: 'base' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(ops.verify(ctx, { txHash: TX })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
