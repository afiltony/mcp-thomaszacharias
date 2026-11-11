import { describe, expect, it, vi } from 'vitest';
import { normalizeDomain, resolveUsdcRecipient, UnstoppableRecordsSource, type DomainRecords } from '../src/domain/unstoppable.js';
import { parseDecimalAmount, formatUnitsExact, weiToUsd8, usd8ToString } from '../src/lib/decimal.js';
import { RECIPIENT, OTHER } from './helpers.js';

const recs = (records: Record<string, string>): DomainRecords => ({ domain: 'thomaszacharias.nft', owner: '0xabc', blockchain: 'MATIC', records, fetchedAt: '' });

describe('decimal amounts', () => {
  it('parses exact decimal strings into base units', () => {
    expect(parseDecimalAmount('25', 6)).toBe(25_000_000n);
    expect(parseDecimalAmount('25.5', 6)).toBe(25_500_000n);
    expect(parseDecimalAmount('0.000001', 6)).toBe(1n);
  });
  it('rejects zero, negatives, floats in exponent form and excess precision', () => {
    for (const bad of ['0', '0.0', '-1', '1e6', '1.0000001', 'abc', '']) expect(() => parseDecimalAmount(bad, 6)).toThrow();
  });
  it('formats without floating point', () => {
    expect(formatUnitsExact(25_500_000n, 6)).toBe('25.5');
    expect(formatUnitsExact(1n, 18)).toBe('0.000000000000000001');
    expect(usd8ToString(weiToUsd8(10n ** 15n, 300_000_000_000n), 4)).toBe('3.0000'); // 0.001 ETH @ $3000
  });
});

describe('domain normalization', () => {
  it('lower-cases and trims', () => expect(normalizeDomain('  ThomasZacharias.NFT ')).toBe('thomaszacharias.nft'));
  it('rejects bare labels and junk', () => {
    expect(() => normalizeDomain('thomaszacharias')).toThrow();
    expect(() => normalizeDomain('bad_name.nft')).toThrow();
    expect(() => normalizeDomain('a/../b.nft')).toThrow();
  });
});

describe('USDC recipient record precedence (UD getAddress order)', () => {
  it('prefers token.EVM.<NET>.USDC.address over family records', () => {
    const r = resolveUsdcRecipient(recs({ 'token.EVM.address': OTHER, 'token.EVM.BASE.USDC.address': RECIPIENT }), 'base');
    expect(r.status).toBe('resolved');
    expect(r.address).toBe(RECIPIENT);
    expect(r.recordKey).toBe('token.EVM.BASE.USDC.address');
    expect(r.confidence).toBe('token-network');
    expect(r.warnings).toHaveLength(0);
  });

  it('uses the legacy Polygon version key', () => {
    const r = resolveUsdcRecipient(recs({ 'crypto.USDC.version.MATIC.address': RECIPIENT }), 'polygon');
    expect(r.recordKey).toBe('crypto.USDC.version.MATIC.address');
    expect(r.confidence).toBe('token-legacy-version');
  });

  it('falls back to EVM family record with a warning (ud-precedence)', () => {
    const r = resolveUsdcRecipient(recs({ 'token.EVM.address': RECIPIENT }), 'ethereum');
    expect(r.status).toBe('resolved');
    expect(r.confidence).toBe('evm-family');
    expect(r.warnings[0]).toMatch(/all EVM networks/);
  });

  it('strict policy refuses family-level records', () => {
    const r = resolveUsdcRecipient(recs({ 'token.EVM.address': RECIPIENT }), 'ethereum', 'strict');
    expect(r.status).toBe('missing');
  });

  it('never treats crypto.ETH.address as a USDC address', () => {
    const r = resolveUsdcRecipient(recs({ 'crypto.ETH.address': RECIPIENT }), 'ethereum');
    expect(r.status).toBe('missing');
    expect(r.candidatesChecked).not.toContain('crypto.ETH.address');
  });

  it('does not reuse an Ethereum-specific USDC record on Base', () => {
    const r = resolveUsdcRecipient(recs({ 'token.EVM.ETH.USDC.address': RECIPIENT }), 'base');
    expect(r.status).toBe('missing');
  });

  it('rejects malformed, bad-checksum, zero and token-contract addresses', () => {
    expect(resolveUsdcRecipient(recs({ 'token.EVM.BASE.USDC.address': '0x1234' }), 'base').status).toBe('invalid');
    expect(resolveUsdcRecipient(recs({ 'token.EVM.BASE.USDC.address': '0x8aaD44321A86b170879d7A244c1e8d360c99DdA9'.replace('aaD', 'AAd') }), 'base').status).toBe('invalid');
    expect(resolveUsdcRecipient(recs({ 'token.EVM.BASE.USDC.address': '0x0000000000000000000000000000000000000000' }), 'base').status).toBe('invalid');
    expect(resolveUsdcRecipient(recs({ 'token.EVM.BASE.USDC.address': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }), 'base').status).toBe('invalid');
  });

  it('accepts all-lowercase addresses', () => {
    const r = resolveUsdcRecipient(recs({ 'token.EVM.BASE.USDC.address': RECIPIENT.toLowerCase() }), 'base');
    expect(r.address).toBe(RECIPIENT);
  });
});

describe('Unstoppable Domains client', () => {
  const ok = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

  it('calls the documented endpoint with a bearer key and parses records', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      ok({ meta: { domain: 'thomaszacharias.nft', owner: '0xowner', blockchain: 'MATIC' }, records: { 'token.EVM.BASE.USDC.address': RECIPIENT, empty: '' } }),
    );
    const src = new UnstoppableRecordsSource({ apiKey: 'secret-key-123', baseUrl: 'https://api.unstoppabledomains.com/resolve', timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await src.getRecords('ThomasZacharias.nft');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://api.unstoppabledomains.com/resolve/domains/thomaszacharias.nft');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer secret-key-123');
    expect(r.records['token.EVM.BASE.USDC.address']).toBe(RECIPIENT);
    expect(r.records.empty).toBeUndefined();
    // cached
    await src.getRecords('thomaszacharias.nft');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await src.getRecords('thomaszacharias.nft', { bypassCache: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('maps 404 and owner-less domains to DOMAIN_NOT_FOUND', async () => {
    const a = new UnstoppableRecordsSource({ apiKey: 'k'.repeat(10), baseUrl: 'https://x.test', timeoutMs: 1000, fetchImpl: (() => ok({}, 404)) as unknown as typeof fetch });
    await expect(a.getRecords('nope.nft')).rejects.toMatchObject({ code: 'DOMAIN_NOT_FOUND' });
    const b = new UnstoppableRecordsSource({ apiKey: 'k'.repeat(10), baseUrl: 'https://x.test', timeoutMs: 1000, fetchImpl: (() => ok({ meta: { owner: null }, records: {} })) as unknown as typeof fetch });
    await expect(b.getRecords('nope.nft')).rejects.toMatchObject({ code: 'DOMAIN_NOT_FOUND' });
  });

  it('reports resolver outages instead of guessing', async () => {
    const src = new UnstoppableRecordsSource({ apiKey: 'k'.repeat(10), baseUrl: 'https://x.test', timeoutMs: 1000, fetchImpl: (() => Promise.reject(new Error('timeout'))) as unknown as typeof fetch });
    await expect(src.getRecords('a.nft')).rejects.toMatchObject({ code: 'RESOLVER_UNAVAILABLE' });
    const noKey = new UnstoppableRecordsSource({ baseUrl: 'https://x.test', timeoutMs: 1000 });
    await expect(noKey.getRecords('a.nft')).rejects.toMatchObject({ code: 'RESOLVER_UNAVAILABLE' });
  });
});
