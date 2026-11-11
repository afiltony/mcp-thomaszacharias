import { describe, expect, it } from 'vitest';
import { getAddress, namehash } from 'viem';
import { OnchainRecordsSource, RECORD_KEYS, UNS_REGISTRIES, type RegistryReader } from '../src/domain/onchain.js';
import { resolveUsdcRecipient } from '../src/domain/unstoppable.js';
import { loadEnv } from '../src/config/env.js';
import { AppError } from '../src/lib/errors.js';
import { RECIPIENT } from './helpers.js';

const OWNER = getAddress('0x414E2489CA4a53c06326671F3c05854EB44eedb2');

/** Fake UNS registry: a map of tokenId -> records; can be made to throw. */
function registry(domains: Record<string, Record<string, string>>, opts: { fail?: boolean } = {}) {
  const byId = new Map(Object.entries(domains).map(([d, r]) => [BigInt(namehash(d)), r]));
  const calls: string[] = [];
  const client: RegistryReader = {
    async readContract({ functionName, args }) {
      calls.push(functionName);
      if (opts.fail) throw new Error('rpc down');
      const id = (functionName === 'getMany' ? args[1] : args[0]) as bigint;
      const rec = byId.get(id);
      if (functionName === 'exists') return !!rec;
      if (functionName === 'ownerOf') return OWNER;
      const keys = args[0] as string[];
      return keys.map((k) => rec?.[k] ?? '');
    },
  };
  return { client, calls };
}

describe('On-chain UNS resolution (no API key)', () => {
  it('uses the namehash UD documents as the token id', () => {
    // Reference value from UD's namehashing docs.
    expect(namehash('crypto')).toBe('0x0f4a10a4f46c288cea365fcf45cccf0e9d901b945b9829ccdb54c10dc3cb7a6f');
  });

  it('reads Polygon first and returns only the USDC-relevant records', async () => {
    const poly = registry({ 'thomaszacharias.nft': { 'token.EVM.BASE.USDC.address': RECIPIENT, 'crypto.ETH.address': OWNER } });
    const eth = registry({});
    const src = new OnchainRecordsSource({ rpcUrls: {}, timeoutMs: 1000, clients: { polygon: poly.client, ethereum: eth.client } });
    const r = await src.getRecords('ThomasZacharias.nft');
    expect(r.domain).toBe('thomaszacharias.nft');
    expect(r.owner).toBe(OWNER);
    expect(r.blockchain).toBe('MATIC');
    expect(r.records['token.EVM.BASE.USDC.address']).toBe(RECIPIENT);
    expect(r.records['crypto.ETH.address']).toBeUndefined(); // never requested, never used for USDC
    expect(eth.calls).toEqual([]);
    expect(resolveUsdcRecipient(r, 'base', 'ud-precedence').address).toBe(RECIPIENT);
  });

  it('falls back to Ethereum when the domain is not on Polygon', async () => {
    const src = new OnchainRecordsSource({
      rpcUrls: {},
      timeoutMs: 1000,
      clients: { polygon: registry({}).client, ethereum: registry({ 'old.crypto': { 'crypto.USDC.version.ERC20.address': RECIPIENT } }).client },
    });
    const r = await src.getRecords('old.crypto');
    expect(r.blockchain).toBe('ETH');
    expect(resolveUsdcRecipient(r, 'ethereum', 'ud-precedence').address).toBe(RECIPIENT);
  });

  it('reports DOMAIN_NOT_FOUND when no registry has the domain', async () => {
    const src = new OnchainRecordsSource({ rpcUrls: {}, timeoutMs: 1000, clients: { polygon: registry({}).client, ethereum: registry({}).client, base: registry({}).client } });
    await expect(src.getRecords('nobody.nft')).rejects.toMatchObject({ code: 'DOMAIN_NOT_FOUND' });
  });

  it('never falls through to a stale lower-priority chain when Polygon fails', async () => {
    const eth = registry({ 'thomaszacharias.nft': { 'token.EVM.ETH.USDC.address': RECIPIENT } });
    const src = new OnchainRecordsSource({ rpcUrls: {}, timeoutMs: 1000, clients: { polygon: registry({}, { fail: true }).client, ethereum: eth.client } });
    const err = await src.getRecords('thomaszacharias.nft').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('RESOLVER_UNAVAILABLE');
    expect(eth.calls).toEqual([]);
  });

  it('requires a Polygon RPC and caches unless bypassed', async () => {
    const noPoly = new OnchainRecordsSource({ rpcUrls: {}, timeoutMs: 1000, clients: { ethereum: registry({}).client } });
    await expect(noPoly.getRecords('x.nft')).rejects.toMatchObject({ code: 'RESOLVER_UNAVAILABLE' });

    const poly = registry({ 'thomaszacharias.nft': { 'token.EVM.MATIC.USDC.address': RECIPIENT } });
    const src = new OnchainRecordsSource({ rpcUrls: {}, timeoutMs: 1000, clients: { polygon: poly.client } });
    await src.getRecords('thomaszacharias.nft');
    await src.getRecords('thomaszacharias.nft');
    expect(poly.calls.filter((c) => c === 'exists')).toHaveLength(1);
    await src.getRecords('thomaszacharias.nft', { bypassCache: true });
    expect(poly.calls.filter((c) => c === 'exists')).toHaveLength(2);
  });

  it('requests every key the USDC rules can use, on the documented registries', () => {
    for (const k of ['token.EVM.ETH.USDC.address', 'token.EVM.BASE.USDC.address', 'token.EVM.MATIC.USDC.address', 'crypto.USDC.address', 'token.EVM.address']) {
      expect(RECORD_KEYS).toContain(k);
    }
    expect(RECORD_KEYS).not.toContain('crypto.ETH.address');
    expect(UNS_REGISTRIES.map((r) => r.id)).toEqual(['polygon', 'ethereum', 'base']);
  });
});

describe('Resolver selection', () => {
  const prod = { NODE_ENV: 'production', API_KEYS: 'op:' + 'k'.repeat(32), MCP_AUTH_SECRET: 's'.repeat(40), PUBLIC_BASE_URL: 'https://api.example.com', DATABASE_URL: 'postgresql://u:p@db.example:6543/postgres' };
  it('runs in production without an Unstoppable API key using on-chain resolution', () => {
    const env = loadEnv({ ...prod, POLYGON_RPC_URL: 'https://polygon.example' });
    expect(env.resolver).toBe('onchain');
  });
  it('requires a Polygon RPC for on-chain resolution, and a key for api mode', () => {
    expect(() => loadEnv(prod)).toThrow(/POLYGON_RPC_URL/);
    expect(() => loadEnv({ ...prod, UD_RESOLVER: 'api', POLYGON_RPC_URL: 'https://polygon.example' })).toThrow(/UNSTOPPABLE_API_KEY/);
    expect(loadEnv({ ...prod, UNSTOPPABLE_API_KEY: 'key' }).resolver).toBe('api');
  });
});
