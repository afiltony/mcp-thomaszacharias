import { encodeAbiParameters, getAddress, keccak256, toHex, type Address, type Hash, type Hex } from 'viem';
import { loadEnv } from '../src/config/env.js';
import { NETWORKS, type NetworkId } from '../src/config/networks.js';
import { USDC } from '../src/config/tokens.js';
import type { AppContext } from '../src/context.js';
import type { DomainRecords, RecordsSource } from '../src/domain/unstoppable.js';
import { normalizeDomain } from '../src/domain/unstoppable.js';
import type { ChainGateway, FeeData, TxReceiptLite } from '../src/evm/gateway.js';
import { AppError } from '../src/lib/errors.js';
import type { PriceQuote, PriceSource } from '../src/pricing/prices.js';
import { MemoryAuditLog } from '../src/store/audit.js';
import { loadPlans } from '../src/config/plans.js';
import { memoryStores, postgresStores, type Stores } from '../src/store/index.js';
import { migrate } from '../src/store/migrate.js';
import type { Db } from '../src/store/db.js';

export const RECIPIENT = getAddress('0x8aaD44321A86b170879d7A244c1e8d360c99DdA8');
export const OTHER = getAddress('0x1111111111111111111111111111111111111111');
export const SENDER = getAddress('0x2222222222222222222222222222222222222222');
export const GWEI = 1_000_000_000n;
export const ETH = 10n ** 18n;

export class FakeRecords implements RecordsSource {
  calls = 0;
  constructor(public records: Record<string, string>, public owner: string | null = '0x9999999999999999999999999999999999999999') {}
  async getRecords(domain: string): Promise<DomainRecords> {
    this.calls++;
    const name = normalizeDomain(domain);
    if (!this.owner) throw new AppError('DOMAIN_NOT_FOUND', 'not found');
    return { domain: name, owner: this.owner, blockchain: 'MATIC', records: { ...this.records }, fetchedAt: new Date().toISOString() };
  }
}

export interface FakeChainOpts {
  chainId?: number;
  baseFee?: bigint;
  tip?: bigint;
  gas?: bigint;
  l1Fee?: bigint;
  usdcBalance?: bigint;
  nativeBalance?: bigint;
  tokenSymbol?: string;
  tokenDecimals?: number;
  failFees?: boolean;
  blacklisted?: Address[];
  simulateFails?: boolean;
  receipt?: TxReceiptLite | null;
  pendingTx?: boolean;
  blockNumber?: bigint;
}

export class FakeGateway implements ChainGateway {
  estimateCalls = 0;
  constructor(readonly network = NETWORKS.base, public o: FakeChainOpts = {}) {}
  async getChainId() {
    return this.o.chainId ?? this.network.chainId;
  }
  async getFeeData(): Promise<FeeData> {
    if (this.o.failFees) throw new AppError('RPC_UNAVAILABLE', `${this.network.name} RPC failed during getFeeData`);
    const baseFeePerGas = this.o.baseFee ?? 1n * GWEI;
    const maxPriorityFeePerGas = this.o.tip ?? 1n * GWEI;
    return { baseFeePerGas, maxPriorityFeePerGas, maxFeePerGas: baseFeePerGas * 2n + maxPriorityFeePerGas, blockNumber: 100n, fetchedAt: new Date().toISOString() };
  }
  async getBlockNumber() {
    return this.o.blockNumber ?? 1000n;
  }
  async readTokenMeta(_t: Address) {
    return { hasCode: true, symbol: this.o.tokenSymbol ?? 'USDC', decimals: this.o.tokenDecimals ?? 6 };
  }
  async tokenBalance() {
    return this.o.usdcBalance ?? 1_000_000_000n;
  }
  async nativeBalance() {
    return this.o.nativeBalance ?? ETH;
  }
  async isBlacklisted(_t: Address, a: Address) {
    return (this.o.blacklisted ?? []).includes(a);
  }
  async isContract() {
    return false;
  }
  async estimateGas() {
    this.estimateCalls++;
    return this.o.gas ?? 60_000n;
  }
  async estimateL1Fee() {
    return this.network.opStackL1Fee ? (this.o.l1Fee ?? 0n) : 0n;
  }
  async simulateTransfer() {
    if (this.o.simulateFails) throw new AppError('SIMULATION_FAILED', 'Transfer simulation failed: ERC20: transfer amount exceeds balance');
  }
  async getReceipt(_h: Hash) {
    return this.o.receipt === undefined ? null : this.o.receipt;
  }
  async getTransaction(_h: Hash) {
    return this.o.pendingTx ? { from: SENDER, to: USDC[this.network.id].address, input: '0x' as Hex } : null;
  }
}

export class FakePrices implements PriceSource {
  constructor(public prices: Record<string, number> = { ethereum: 3000, 'polygon-ecosystem-token': 0.25 }, public ageSeconds = 10, public fail = false) {}
  async getUsdPrice(id: string): Promise<PriceQuote> {
    if (this.fail) throw new AppError('PRICE_UNAVAILABLE', 'price down');
    const p = this.prices[id];
    if (p === undefined) throw new AppError('PRICE_UNAVAILABLE', 'no price');
    return {
      id,
      usd8: BigInt(Math.round(p * 1e8)),
      usd: String(p),
      asOf: new Date(Date.now() - this.ageSeconds * 1000).toISOString(),
      fetchedAt: new Date().toISOString(),
      source: 'fake',
    };
  }
}

/** TEST_STORE=pglite runs every suite against real Postgres (PGlite) with the Supabase migration applied. */
/** TEST_STORE=postgres + TEST_DATABASE_URL runs them against a real Postgres server through node-postgres. */
export const TEST_STORE: 'memory' | 'pglite' | 'postgres' =
  process.env.TEST_STORE === 'pglite' ? 'pglite' : process.env.TEST_STORE === 'postgres' ? 'postgres' : 'memory';

let pgDb: Promise<Db> | undefined;
export function pgliteDb(): Promise<Db> {
  pgDb ??= (async () => {
    if (TEST_STORE === 'postgres') {
      const { connectPostgres } = await import('../src/store/db.js');
      const real = connectPostgres(process.env.TEST_DATABASE_URL!, { ssl: false, max: 10 });
      await migrate(real);
      return real;
    }
    const { PGlite } = await import('@electric-sql/pglite');
    const lite = new PGlite();
    const wrap = (q: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }>; exec: (t: string) => Promise<{ rows: unknown[] }[]> }) => ({
      query: async (text: string, params?: unknown[]) => {
        if (params && params.length) return (await q.query(text, params)) as never;
        const res = await q.exec(text); // allows multi-statement SQL (migrations)
        return { rows: res.at(-1)?.rows ?? [] } as never;
      },
    });
    const db: Db = {
      ...wrap(lite as never),
      transaction: (fn) => lite.transaction((tx) => fn(wrap(tx as never))) as never,
      close: () => lite.close(),
    };
    await migrate(db);
    return db;
  })();
  return pgDb;
}

export async function testStores(): Promise<Stores> {
  if (TEST_STORE === 'memory') return memoryStores();
  const db = await pgliteDb();
  await db.query('truncate kv_records, used_tx_hashes, invoices, subscriptions, rate_limits, audit_log restart identity cascade');
  // Audit rows go to Postgres too; tests read events from the in-memory mirror.
  const pg = postgresStores(db);
  const mirror = new MemoryAuditLog();
  return { ...pg, audit: { events: mirror.events, write: async (e: string, f: Record<string, unknown>) => (await mirror.write(e, f), pg.audit.write(e, f)) } as MemoryAuditLog };
}

export type TestCtx = AppContext & { audit: MemoryAuditLog };

export async function makeCtx(over: {
  records?: Record<string, string>;
  gateways?: Partial<Record<NetworkId, ChainGateway>>;
  prices?: PriceSource;
  env?: Record<string, string>;
  recordsSource?: RecordsSource;
} = {}): Promise<TestCtx> {
  const env = loadEnv({ NODE_ENV: 'test', MCP_AUTH_SECRET: 'x'.repeat(40), ...(over.env ?? {}) });
  const stores = await testStores();
  return {
    env,
    records: over.recordsSource ?? new FakeRecords(over.records ?? { 'token.EVM.BASE.USDC.address': RECIPIENT }),
    gateways: over.gateways ?? {
      ethereum: new FakeGateway(NETWORKS.ethereum, { baseFee: 20n * GWEI, tip: 2n * GWEI }),
      base: new FakeGateway(NETWORKS.base, { baseFee: 5_000_000n, tip: 1_000_000n, l1Fee: 1_000_000_000n }),
      polygon: new FakeGateway(NETWORKS.polygon, { baseFee: 100n * GWEI, tip: 50n * GWEI }),
    },
    prices: over.prices ?? new FakePrices(),
    ...stores,
    audit: stores.audit as MemoryAuditLog,
    plans: loadPlans(env.BILLING_PLANS),
    verifiedTokens: new Map(),
    now: () => Date.now(),
  };
}

export const TRANSFER_TOPIC = keccak256(toHex('Transfer(address,address,uint256)'));
export function transferLog(token: Address, from: Address, to: Address, value: bigint) {
  const pad = (a: Address) => ('0x' + a.slice(2).toLowerCase().padStart(64, '0')) as Hex;
  return { address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)] as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [value]) };
}
