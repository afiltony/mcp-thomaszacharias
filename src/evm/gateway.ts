import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from 'viem';
import { publicActionsL2 } from 'viem/op-stack';
import { NETWORKS, type NetworkConfig, type NetworkId } from '../config/networks.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

export const fiatTokenAbi = parseAbi(['function isBlacklisted(address account) view returns (bool)']);

export interface FeeData {
  baseFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  blockNumber: bigint;
  fetchedAt: string;
}

export interface TxReceiptLite {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  from: Address;
  to: Address | null;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  l1Fee?: bigint;
  logs: { address: Address; topics: Hex[]; data: Hex }[];
}

/** Everything the engine needs from a chain. Mocked in tests. */
export interface ChainGateway {
  readonly network: NetworkConfig;
  getChainId(): Promise<number>;
  getFeeData(): Promise<FeeData>;
  getBlockNumber(): Promise<bigint>;
  readTokenMeta(token: Address): Promise<{ hasCode: boolean; symbol: string; decimals: number }>;
  tokenBalance(token: Address, owner: Address): Promise<bigint>;
  nativeBalance(owner: Address): Promise<bigint>;
  isBlacklisted(token: Address, account: Address): Promise<boolean | null>;
  isContract(address: Address): Promise<boolean>;
  estimateGas(p: { from: Address; to: Address; data: Hex }): Promise<bigint>;
  estimateL1Fee(p: { from?: Address; to: Address; data: Hex }): Promise<bigint>;
  simulateTransfer(p: { token: Address; from: Address; to: Address; amount: bigint }): Promise<void>;
  getReceipt(hash: Hash): Promise<TxReceiptLite | null>;
  getTransaction(hash: Hash): Promise<{ from: Address; to: Address | null; input: Hex; chainId?: number } | null>;
}

function rpcError(network: NetworkConfig, op: string, err: unknown): AppError {
  log.warn('rpc_error', { network: network.id, op, err: err instanceof Error ? err.message.slice(0, 300) : String(err) });
  return new AppError('RPC_UNAVAILABLE', `${network.name} RPC failed during ${op}`, { network: network.id });
}

export class ViemChainGateway implements ChainGateway {
  private client: PublicClient;
  private chainIdCache?: { at: number; value: number };

  constructor(
    readonly network: NetworkConfig,
    rpcUrl: string,
    timeoutMs: number,
  ) {
    this.client = createPublicClient({
      chain: network.viemChain,
      transport: http(rpcUrl, { timeout: timeoutMs, retryCount: 1, retryDelay: 250 }),
    }) as PublicClient;
  }

  private async wrap<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw rpcError(this.network, op, err);
    }
  }

  getChainId() {
    if (this.chainIdCache && Date.now() - this.chainIdCache.at < 10 * 60_000) return Promise.resolve(this.chainIdCache.value);
    return this.wrap('getChainId', async () => {
      const value = await this.client.getChainId();
      this.chainIdCache = { at: Date.now(), value };
      return value;
    });
  }

  getBlockNumber() {
    return this.wrap('getBlockNumber', () => this.client.getBlockNumber({ cacheTime: 0 }));
  }

  getFeeData() {
    return this.wrap('getFeeData', async () => {
      const block = await this.client.getBlock({ blockTag: 'latest' });
      if (block.baseFeePerGas == null) throw new AppError('RPC_UNAVAILABLE', `${this.network.name} did not return an EIP-1559 base fee`);
      const fees = await this.client.estimateFeesPerGas({ type: 'eip1559', chain: this.network.viemChain });
      return {
        baseFeePerGas: block.baseFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        maxFeePerGas: fees.maxFeePerGas,
        blockNumber: block.number ?? 0n,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  readTokenMeta(token: Address) {
    return this.wrap('readTokenMeta', async () => {
      const code = await this.client.getCode({ address: token });
      if (!code || code === '0x') return { hasCode: false, symbol: '', decimals: 0 };
      const [symbol, decimals] = await Promise.all([
        this.client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
        this.client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
      ]);
      return { hasCode: true, symbol, decimals };
    });
  }

  tokenBalance(token: Address, owner: Address) {
    return this.wrap('tokenBalance', () => this.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }));
  }

  nativeBalance(owner: Address) {
    return this.wrap('nativeBalance', () => this.client.getBalance({ address: owner }));
  }

  async isBlacklisted(token: Address, account: Address): Promise<boolean | null> {
    try {
      return await this.client.readContract({ address: token, abi: fiatTokenAbi, functionName: 'isBlacklisted', args: [account] });
    } catch {
      return null; // unknown — reported as a warning, never treated as "clean"
    }
  }

  isContract(address: Address) {
    return this.wrap('isContract', async () => {
      const code = await this.client.getCode({ address });
      return !!code && code !== '0x';
    });
  }

  estimateGas(p: { from: Address; to: Address; data: Hex }) {
    return this.wrap('estimateGas', () => this.client.estimateGas({ account: p.from, to: p.to, data: p.data, value: 0n }));
  }

  estimateL1Fee(p: { from?: Address; to: Address; data: Hex }) {
    if (!this.network.opStackL1Fee) return Promise.resolve(0n);
    return this.wrap('estimateL1Fee', () =>
      this.client.extend(publicActionsL2()).estimateL1Fee({ account: p.from, to: p.to, data: p.data, value: 0n, chain: this.network.viemChain } as never),
    );
  }

  async simulateTransfer(p: { token: Address; from: Address; to: Address; amount: bigint }) {
    try {
      const { result } = await this.client.simulateContract({
        account: p.from,
        address: p.token,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [p.to, p.amount],
      });
      if (result !== true) throw new Error('transfer() did not return true');
    } catch (err) {
      const msg = err instanceof Error ? (err as { shortMessage?: string }).shortMessage ?? err.message : String(err);
      throw new AppError('SIMULATION_FAILED', `Transfer simulation failed on ${this.network.name}: ${msg.slice(0, 200)}`);
    }
  }

  getReceipt(hash: Hash) {
    return this.wrap('getReceipt', async () => {
      try {
        const r = await this.client.getTransactionReceipt({ hash });
        return {
          status: r.status,
          blockNumber: r.blockNumber,
          from: r.from,
          to: r.to,
          gasUsed: r.gasUsed,
          effectiveGasPrice: r.effectiveGasPrice,
          l1Fee: (r as { l1Fee?: bigint | null }).l1Fee ?? undefined,
          logs: r.logs.map((l) => ({ address: l.address, topics: l.topics as Hex[], data: l.data })),
        } satisfies TxReceiptLite;
      } catch (err) {
        if ((err as { name?: string }).name === 'TransactionReceiptNotFoundError') return null;
        throw err;
      }
    });
  }

  getTransaction(hash: Hash) {
    return this.wrap('getTransaction', async () => {
      try {
        const t = await this.client.getTransaction({ hash });
        return { from: t.from, to: t.to, input: t.input, chainId: t.chainId };
      } catch (err) {
        if ((err as { name?: string }).name === 'TransactionNotFoundError') return null;
        throw err;
      }
    });
  }
}

export function encodeUsdcTransfer(to: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
}

export type GatewayRegistry = Partial<Record<NetworkId, ChainGateway>>;

export function buildGateways(env: Record<string, unknown>, timeoutMs: number): GatewayRegistry {
  const out: GatewayRegistry = {};
  for (const n of Object.values(NETWORKS)) {
    const url = env[n.rpcEnvVar];
    if (typeof url === 'string' && url) out[n.id] = new ViemChainGateway(n, url, timeoutMs);
  }
  return out;
}
