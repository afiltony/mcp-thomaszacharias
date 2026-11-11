import { describe, expect, it } from 'vitest';
import { NETWORKS } from '../src/config/networks.js';
import { computeFees } from '../src/quote/fees.js';
import { compareRoutes } from '../src/quote/compare-routes.js';
import { ops } from '../src/services.js';
import { FakeGateway, FakePrices, GWEI, makeCtx, RECIPIENT, SENDER } from './helpers.js';

const ALL_RECORDS = {
  'token.EVM.ETH.USDC.address': RECIPIENT,
  'token.EVM.BASE.USDC.address': RECIPIENT,
  'token.EVM.MATIC.USDC.address': RECIPIENT,
};

describe('computeFees', () => {
  it('separates expected fee from the max-fee safety bound', () => {
    const f = computeFees({
      gasUnits: 60_000n,
      fee: { baseFeePerGas: 10n * GWEI, maxPriorityFeePerGas: 1n * GWEI, maxFeePerGas: 21n * GWEI, blockNumber: 1n, fetchedAt: '' },
      l1FeeWei: 0n,
      gasLimitBufferBps: 12000,
      l1FeeBufferBps: 12500,
    });
    expect(f.expectedFeeWei).toBe(60_000n * 11n * GWEI);
    expect(f.gasLimit).toBe(72_000n);
    expect(f.maxFeeWei).toBe(72_000n * 21n * GWEI);
    expect(f.safetyMarginWei).toBe(f.maxFeeWei - f.expectedFeeWei);
  });

  it('adds the OP-stack L1 data fee', () => {
    const f = computeFees({
      gasUnits: 60_000n,
      fee: { baseFeePerGas: 1n, maxPriorityFeePerGas: 1n, maxFeePerGas: 3n, blockNumber: 1n, fetchedAt: '' },
      l1FeeWei: 1000n,
      gasLimitBufferBps: 10000,
      l1FeeBufferBps: 12500,
    });
    expect(f.expectedFeeWei).toBe(120_000n + 1000n);
    expect(f.maxFeeWei).toBe(180_000n + 1250n);
  });
});

describe('route comparison', () => {
  it('ranks eligible routes by expected USD cost (Base cheapest here)', async () => {
    const ctx = await makeCtx({ records: ALL_RECORDS });
    const q = await compareRoutes(ctx, { domain: 'ThomasZacharias.nft', amount: '25', amountRaw: 25_000_000n, sender: SENDER });
    expect(q.routes.map((r) => r.network)).toEqual(['base', 'polygon', 'ethereum']);
    expect(q.recommendedNetwork).toBe('base');
    const base = q.routes[0]!;
    expect(base.eligible).toBe(true);
    expect(base.quoteType).toBe('live');
    expect(base.costBreakdownUsd).toMatchObject({ bridgeFee: '0', conversionFee: '0' });
    expect(base.gas?.l1DataFeeWei).toBe('1000000000');
    // ethereum: 60000 * 22 gwei = 0.00132 ETH * $3000 = $3.96
    expect(q.routes[2]!.fees?.expectedFeeUsd).toBe('3.9600');
    expect(Date.parse(q.expiresAt) - Date.parse(q.createdAt)).toBe(120_000);
  });

  it('a lower gas fee does not win if the recipient has no USDC record on that network', async () => {
    const ctx = await makeCtx({ records: { 'token.EVM.ETH.USDC.address': RECIPIENT } });
    const q = await compareRoutes(ctx, { domain: 'x.nft', amount: '25', amountRaw: 25_000_000n, sender: SENDER });
    expect(q.recommendedNetwork).toBe('ethereum');
    const base = q.routes.find((r) => r.network === 'base')!;
    expect(base.eligible).toBe(false);
    expect(base.reasons[0]!.code).toBe('RECIPIENT_RECORD_MISSING');
    expect(base.fees).toBeUndefined();
  });

  it('marks routes needing bridging as ineligible (sender has no USDC there)', async () => {
    const ctx = await makeCtx({
      records: ALL_RECORDS,
      gateways: {
        ethereum: new FakeGateway(NETWORKS.ethereum, { baseFee: 20n * GWEI }),
        base: new FakeGateway(NETWORKS.base, { usdcBalance: 0n }),
        polygon: new FakeGateway(NETWORKS.polygon, { usdcBalance: 10n }),
      },
    });
    const q = await compareRoutes(ctx, { domain: 'x.nft', amount: '25', amountRaw: 25_000_000n, sender: SENDER });
    expect(q.recommendedNetwork).toBe('ethereum');
    const base = q.routes.find((r) => r.network === 'base')!;
    expect(base.reasons[0]!.code).toBe('INSUFFICIENT_TOKEN_BALANCE');
    expect(base.reasons[0]!.message).toMatch(/bridging/);
    expect(base.requiresBridge).toBe(false); // never silently bridged
  });

  it('excludes routes where the sender cannot pay gas', async () => {
    const ctx = await makeCtx({ records: ALL_RECORDS, gateways: { base: new FakeGateway(NETWORKS.base, { nativeBalance: 1n }) } });
    const q = await compareRoutes(ctx, { domain: 'x.nft', amount: '1', amountRaw: 1_000_000n, sender: SENDER, networks: ['base'] });
    expect(q.routes[0]!.reasons[0]!.code).toBe('INSUFFICIENT_GAS_BALANCE');
    expect(q.recommendedNetwork).toBeNull();
  });

  it('rejects stale prices and never fabricates a quote when providers fail', async () => {
    const stale = await makeCtx({ records: ALL_RECORDS, prices: new FakePrices(undefined, 3600) });
    const q1 = await compareRoutes(stale, { domain: 'x.nft', amount: '1', amountRaw: 1_000_000n, networks: ['base'] });
    expect(q1.routes[0]!.reasons[0]!.code).toBe('PRICE_STALE');

    const down = await makeCtx({ records: ALL_RECORDS, prices: new FakePrices(undefined, 10, true) });
    const q2 = await compareRoutes(down, { domain: 'x.nft', amount: '1', amountRaw: 1_000_000n, networks: ['base'] });
    expect(q2.routes[0]!.eligible).toBe(false);
    expect(q2.routes[0]!.fees).toBeUndefined();

    const rpc = await makeCtx({ records: ALL_RECORDS, gateways: { base: new FakeGateway(NETWORKS.base, { failFees: true }) } });
    const q3 = await compareRoutes(rpc, { domain: 'x.nft', amount: '1', amountRaw: 1_000_000n, networks: ['base'] });
    expect(q3.routes[0]!.reasons[0]!.code).toBe('RPC_UNAVAILABLE');
    expect(q3.routes[0]!.fees).toBeUndefined();
  });

  it('rejects a wrong chain id and an impostor token contract', async () => {
    const ctx = await makeCtx({
      records: ALL_RECORDS,
      gateways: {
        base: new FakeGateway(NETWORKS.base, { chainId: 10 }),
        polygon: new FakeGateway(NETWORKS.polygon, { tokenSymbol: 'USDC.e' }),
      },
    });
    const q = await compareRoutes(ctx, { domain: 'x.nft', amount: '1', amountRaw: 1_000_000n, networks: ['base', 'polygon'] });
    expect(q.routes.find((r) => r.network === 'base')!.reasons[0]!.code).toBe('CHAIN_ID_MISMATCH');
    expect(q.routes.find((r) => r.network === 'polygon')!.reasons[0]!.code).toBe('TOKEN_CONTRACT_MISMATCH');
  });

  it('reports unconfigured networks instead of guessing', async () => {
    const ctx = await makeCtx({ records: ALL_RECORDS, gateways: {} });
    const q = await compareRoutes(ctx, { domain: 'x.nft', amount: '1', amountRaw: 1_000_000n });
    expect(q.routes.every((r) => r.reasons[0]!.code === 'NETWORK_NOT_CONFIGURED')).toBe(true);
  });

  it('blocks blacklisted recipients', async () => {
    const ctx = await makeCtx({ records: ALL_RECORDS, gateways: { base: new FakeGateway(NETWORKS.base, { blacklisted: [RECIPIENT] }) } });
    const q = await compareRoutes(ctx, { domain: 'x.nft', amount: '1', amountRaw: 1_000_000n, networks: ['base'] });
    expect(q.routes[0]!.reasons[0]!.code).toBe('RECIPIENT_BLOCKED');
  });

  it('labels quotes without a sender as indicative and does not call estimateGas', async () => {
    const gw = new FakeGateway(NETWORKS.base, {});
    const ctx = await makeCtx({ records: ALL_RECORDS, gateways: { base: gw } });
    const q = await compareRoutes(ctx, { domain: 'x.nft', amount: '1', amountRaw: 1_000_000n, networks: ['base'] });
    expect(q.routes[0]!.quoteType).toBe('indicative');
    expect(q.routes[0]!.gas?.source).toBe('reference');
    expect(gw.estimateCalls).toBe(0);
  });

  it('validates amounts through the shared ops layer', async () => {
    const ctx = await makeCtx({ records: ALL_RECORDS });
    await expect(ops.compare(ctx, { domain: 'x.nft', amount: 25, token: 'USDC' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(ops.compare(ctx, { domain: 'x.nft', amount: '25.0000001' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(ops.compare(ctx, { domain: 'x.nft', amount: '20000' })).rejects.toThrow(/limit/);
    await expect(ops.compare(ctx, { domain: 'x.nft', amount: '1', token: 'USDT' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(ops.compare(ctx, { domain: 'x.nft', amount: '1', rpcUrl: 'https://evil' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
