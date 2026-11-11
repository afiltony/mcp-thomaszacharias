import { getAddress, isAddress, zeroAddress, type Address } from 'viem';
import { NETWORKS, type NetworkId } from '../config/networks.js';
import { USDC } from '../config/tokens.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

export interface DomainRecords {
  domain: string;
  owner: string | null;
  blockchain: string | null;
  records: Record<string, string>;
  fetchedAt: string;
}

/** Abstract so tests (and future resolvers, e.g. ENS) can be swapped in. */
export interface RecordsSource {
  getRecords(domain: string, opts?: { bypassCache?: boolean }): Promise<DomainRecords>;
}

/** Normalize and validate a Web3 domain name. Does not hard-code TLDs (UD best practice). */
export function normalizeDomain(input: string): string {
  const d = input.normalize('NFC').trim().toLowerCase().replace(/\.$/, '');
  if (d.length < 3 || d.length > 253) throw new AppError('DOMAIN_INVALID', 'Domain name length is invalid');
  const labels = d.split('.');
  if (labels.length < 2) throw new AppError('DOMAIN_INVALID', 'Domain must include an extension, e.g. name.nft');
  for (const l of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) {
      throw new AppError('DOMAIN_INVALID', `Domain label "${l}" contains unsupported characters`);
    }
  }
  return d;
}

export class UnstoppableRecordsSource implements RecordsSource {
  private cache = new Map<string, { at: number; value: DomainRecords }>();

  constructor(
    private readonly opts: { apiKey?: string; baseUrl: string; timeoutMs: number; cacheSeconds?: number; fetchImpl?: typeof fetch },
  ) {}

  async getRecords(domain: string, { bypassCache = false } = {}): Promise<DomainRecords> {
    const name = normalizeDomain(domain);
    const ttl = (this.opts.cacheSeconds ?? 30) * 1000;
    const hit = this.cache.get(name);
    if (!bypassCache && hit && Date.now() - hit.at < ttl) return hit.value;

    if (!this.opts.apiKey) throw new AppError('RESOLVER_UNAVAILABLE', 'Domain resolver is not configured (missing UNSTOPPABLE_API_KEY)');

    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/domains/${encodeURIComponent(name)}`;
    const f = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(url, {
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      log.warn('ud_request_failed', { domain: name, err: String(err) });
      throw new AppError('RESOLVER_UNAVAILABLE', 'Domain resolver did not respond in time');
    }
    if (res.status === 404) throw new AppError('DOMAIN_NOT_FOUND', `Domain ${name} was not found`);
    if (res.status === 401 || res.status === 403) {
      log.error('ud_auth_failed', { status: res.status });
      throw new AppError('RESOLVER_UNAVAILABLE', 'Domain resolver rejected the server credentials');
    }
    if (res.status === 429) throw new AppError('RESOLVER_UNAVAILABLE', 'Domain resolver rate limit reached; retry shortly');
    if (!res.ok) throw new AppError('RESOLVER_UNAVAILABLE', `Domain resolver returned HTTP ${res.status}`);

    const body = (await res.json()) as { meta?: Record<string, unknown>; records?: Record<string, unknown> };
    const owner = typeof body.meta?.owner === 'string' ? body.meta.owner : null;
    if (!owner || owner.toLowerCase() === zeroAddress) {
      throw new AppError('DOMAIN_NOT_FOUND', `Domain ${name} is not registered or has no owner`);
    }
    const records: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.records ?? {})) if (typeof v === 'string' && v.trim()) records[k] = v.trim();

    const value: DomainRecords = {
      domain: name,
      owner,
      blockchain: typeof body.meta?.blockchain === 'string' ? body.meta.blockchain : null,
      records,
      fetchedAt: new Date().toISOString(),
    };
    this.cache.set(name, { at: Date.now(), value });
    return value;
  }
}

export type RecordConfidence =
  | 'token-network' // USDC on this exact network
  | 'token-legacy-version' // legacy crypto.USDC.version.<V>.address for this network
  | 'token-unspecified-network' // crypto.USDC.address — token is explicit, network is not
  | 'network-family' // token.EVM.<NET>.address — any token on this network
  | 'evm-family'; // token.EVM.address — any EVM network

export interface RecipientResolution {
  network: NetworkId;
  status: 'resolved' | 'missing' | 'invalid';
  address?: Address;
  recordKey?: string;
  confidence?: RecordConfidence;
  candidatesChecked: string[];
  warnings: string[];
  reason?: string;
}

/**
 * Build the ordered record keys for USDC on a network, following UD's documented
 * getAddress(network, token) precedence:
 *   1. token.EVM.<NET>.<TOKEN>.address
 *   2. crypto.<TOKEN>.address
 *   3. crypto.<TOKEN>.version.<VERSION>.address
 *   4. token.EVM.<NET>.address
 *   5. token.EVM.address
 * `crypto.ETH.address` (or any other coin's record) is NEVER used as a USDC fallback.
 */
export function usdcRecordKeys(network: NetworkId, policy: 'ud-precedence' | 'strict'): { key: string; confidence: RecordConfidence }[] {
  const n = NETWORKS[network];
  const keys: { key: string; confidence: RecordConfidence }[] = [];
  for (const sym of n.udNetworkSymbols) keys.push({ key: `token.EVM.${sym}.USDC.address`, confidence: 'token-network' });
  if (policy === 'ud-precedence') keys.push({ key: 'crypto.USDC.address', confidence: 'token-unspecified-network' });
  for (const k of n.udLegacyUsdcKeys) keys.push({ key: k, confidence: 'token-legacy-version' });
  if (policy === 'ud-precedence') {
    for (const sym of n.udNetworkSymbols) keys.push({ key: `token.EVM.${sym}.address`, confidence: 'network-family' });
    keys.push({ key: 'token.EVM.address', confidence: 'evm-family' });
  }
  return keys;
}

const WARNINGS: Partial<Record<RecordConfidence, string>> = {
  'token-unspecified-network':
    'Recipient set a USDC address without naming a network (crypto.USDC.address). Confirm they can receive USDC on this network.',
  'network-family': 'Recipient set a general address for this network, not a USDC-specific record.',
  'evm-family': 'Recipient set one address for all EVM networks (token.EVM.address), not a USDC-specific record. Confirm they control it on this network.',
};

export function resolveUsdcRecipient(
  records: DomainRecords,
  network: NetworkId,
  policy: 'ud-precedence' | 'strict' = 'ud-precedence',
): RecipientResolution {
  const candidates = usdcRecordKeys(network, policy);
  const checked = candidates.map((c) => c.key);
  for (const { key, confidence } of candidates) {
    const raw = records.records[key];
    if (!raw) continue;
    if (!isAddress(raw, { strict: false })) {
      return {
        network,
        status: 'invalid',
        recordKey: key,
        candidatesChecked: checked,
        warnings: [],
        reason: `Record ${key} is not a valid EVM address`,
      };
    }
    // Mixed-case addresses must pass EIP-55 checksum.
    if (raw !== raw.toLowerCase() && raw.slice(2) !== raw.slice(2).toUpperCase() && !isAddress(raw, { strict: true })) {
      return { network, status: 'invalid', recordKey: key, candidatesChecked: checked, warnings: [], reason: `Record ${key} fails EIP-55 checksum` };
    }
    const address = getAddress(raw);
    if (address === zeroAddress) {
      return { network, status: 'invalid', recordKey: key, candidatesChecked: checked, warnings: [], reason: `Record ${key} is the zero address` };
    }
    if (Object.values(USDC).some((t) => t.address === address)) {
      return { network, status: 'invalid', recordKey: key, candidatesChecked: checked, warnings: [], reason: `Record ${key} points at a USDC token contract, not a wallet` };
    }
    const warnings = WARNINGS[confidence] ? [WARNINGS[confidence]!] : [];
    return { network, status: 'resolved', address, recordKey: key, confidence, candidatesChecked: checked, warnings };
  }
  return {
    network,
    status: 'missing',
    candidatesChecked: checked,
    warnings: [],
    reason: `No USDC receiving record for ${NETWORKS[network].name} on this domain`,
  };
}
