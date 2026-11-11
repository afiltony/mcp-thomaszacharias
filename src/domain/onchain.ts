import { createPublicClient, getAddress, http, namehash, parseAbi, zeroAddress, type Address, type Chain } from 'viem';
import { base, mainnet, polygon } from 'viem/chains';
import { NETWORK_IDS } from '../config/networks.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { normalizeDomain, usdcRecordKeys, type DomainRecords, type RecordsSource } from './unstoppable.js';

/**
 * UNS registries (Unstoppable Domains). Source: UD developer docs,
 * https://docs.unstoppabledomains.com/web3/smart-contracts/quick-start/reverse-resolve-domains
 * Verified on-chain 2026-10-29 (exists/ownerOf/getMany for thomaszacharias.nft on Polygon).
 * Read order follows UD guidance: Polygon first, then Ethereum; Base last.
 */
export const UNS_REGISTRIES = [
  { id: 'polygon', blockchain: 'MATIC', chain: polygon as Chain, registry: getAddress('0xa9a6A3626993D487d2Dbda3173cf58cA1a9D9e9f') },
  { id: 'ethereum', blockchain: 'ETH', chain: mainnet as Chain, registry: getAddress('0x049aba7510f45BA5b64ea9E658E342F904DB358D') },
  { id: 'base', blockchain: 'BASE', chain: base as Chain, registry: getAddress('0xF6c1b83977DE3dEffC476f5048A0a84d3375d498') },
] as const;
type RegistryId = (typeof UNS_REGISTRIES)[number]['id'];

const UNS_ABI = parseAbi([
  'function exists(uint256 tokenId) view returns (bool)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getMany(string[] keys, uint256 tokenId) view returns (string[])',
]);

/** Every record the USDC resolution rules can look at, for all networks (superset of both policies). */
export const RECORD_KEYS: string[] = [...new Set(NETWORK_IDS.flatMap((n) => usdcRecordKeys(n, 'ud-precedence').map((k) => k.key)))];

export interface RegistryReader {
  readContract(args: { address: Address; abi: typeof UNS_ABI; functionName: 'exists' | 'ownerOf' | 'getMany'; args: readonly unknown[] }): Promise<unknown>;
}

/**
 * Reads domain records straight from the UNS registry contracts over JSON-RPC.
 * No Unstoppable Domains API key is needed; it uses the same RPC endpoints as the rest of the server.
 */
export class OnchainRecordsSource implements RecordsSource {
  private cache = new Map<string, { at: number; value: DomainRecords }>();
  private readers: { id: RegistryId; blockchain: string; registry: Address; client: RegistryReader }[];
  private readonly cacheMs: number;

  constructor(opts: { rpcUrls: Partial<Record<RegistryId, string | undefined>>; timeoutMs: number; cacheSeconds?: number; clients?: Partial<Record<RegistryId, RegistryReader>> }) {
    this.cacheMs = (opts.cacheSeconds ?? 30) * 1000;
    this.readers = UNS_REGISTRIES.flatMap((r) => {
      const client =
        opts.clients?.[r.id] ?? (opts.rpcUrls[r.id] ? (createPublicClient({ chain: r.chain, transport: http(opts.rpcUrls[r.id], { timeout: opts.timeoutMs, retryCount: 1 }) }) as unknown as RegistryReader) : undefined);
      return client ? [{ id: r.id, blockchain: r.blockchain, registry: r.registry, client }] : [];
    });
  }

  get configured(): boolean {
    return this.readers.some((r) => r.id === 'polygon');
  }

  async getRecords(domain: string, { bypassCache = false } = {}): Promise<DomainRecords> {
    const name = normalizeDomain(domain);
    const hit = this.cache.get(name);
    if (!bypassCache && hit && Date.now() - hit.at < this.cacheMs) return hit.value;
    if (!this.configured) throw new AppError('RESOLVER_UNAVAILABLE', 'Domain resolver is not configured (POLYGON_RPC_URL is required for on-chain resolution)');

    const tokenId = BigInt(namehash(name));
    for (const r of this.readers) {
      const read = (functionName: 'exists' | 'ownerOf' | 'getMany', args: readonly unknown[]) =>
        r.client.readContract({ address: r.registry, abi: UNS_ABI, functionName, args });
      let exists: boolean;
      try {
        exists = (await read('exists', [tokenId])) as boolean;
      } catch (err) {
        // Never fall through to a lower-priority chain after a failure: a domain bridged to Polygon
        // still has a stale token on Ethereum, so reading Ethereum here could return old records.
        log.warn('uns_read_failed', { domain: name, chain: r.id, err: String(err).slice(0, 200) });
        throw new AppError('RESOLVER_UNAVAILABLE', `Could not read domain records from ${r.id}; retry shortly`);
      }
      if (!exists) continue;
      try {
        const owner = getAddress((await read('ownerOf', [tokenId])) as string);
        if (owner === zeroAddress) throw new AppError('DOMAIN_NOT_FOUND', `Domain ${name} has no owner`);
        const values = (await read('getMany', [RECORD_KEYS, tokenId])) as string[];
        const records: Record<string, string> = {};
        RECORD_KEYS.forEach((k, i) => {
          const v = values[i];
          if (typeof v === 'string' && v.trim()) records[k] = v.trim();
        });
        const value: DomainRecords = { domain: name, owner, blockchain: r.blockchain, records, fetchedAt: new Date().toISOString() };
        this.cache.set(name, { at: Date.now(), value });
        return value;
      } catch (err) {
        if (err instanceof AppError) throw err;
        log.warn('uns_read_failed', { domain: name, chain: r.id, err: String(err).slice(0, 200) });
        throw new AppError('RESOLVER_UNAVAILABLE', `Could not read domain records from ${r.id}; retry shortly`);
      }
    }
    throw new AppError('DOMAIN_NOT_FOUND', `Domain ${name} is not registered with Unstoppable Domains`);
  }
}
