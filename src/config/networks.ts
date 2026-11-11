import type { Chain } from 'viem';
import { base, mainnet, polygon } from 'viem/chains';

/**
 * Reviewed network allowlist. Requests can only *select* from these ids;
 * they can never supply an RPC URL, chain id or token contract.
 */
export const NETWORK_IDS = ['ethereum', 'base', 'polygon'] as const;
export type NetworkId = (typeof NETWORK_IDS)[number];

export interface NetworkConfig {
  id: NetworkId;
  name: string;
  chainId: number;
  viemChain: Chain;
  rpcEnvVar: 'ETHEREUM_RPC_URL' | 'BASE_RPC_URL' | 'POLYGON_RPC_URL';
  nativeSymbol: string;
  nativeDecimals: 18;
  /** CoinGecko id for the native gas coin. */
  nativePriceId: string;
  /** OP-stack rollups charge an extra L1 data fee on top of L2 execution gas. */
  opStackL1Fee: boolean;
  /** Network symbols used in Unstoppable Domains `token.EVM.<NET>...` records. */
  udNetworkSymbols: string[];
  /** Legacy UD multi-chain "version" record keys that denote USDC on this network. */
  udLegacyUsdcKeys: string[];
  /** Confirmations required before a transfer is reported as confirmed. */
  requiredConfirmations: number;
  explorerTxUrl: string;
  /** Conservative gas units used only for indicative quotes when no sender is supplied. */
  referenceTransferGas: bigint;
}

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum Mainnet',
    chainId: 1,
    viemChain: mainnet,
    rpcEnvVar: 'ETHEREUM_RPC_URL',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    nativePriceId: 'ethereum',
    opStackL1Fee: false,
    udNetworkSymbols: ['ETH'],
    udLegacyUsdcKeys: ['crypto.USDC.version.ERC20.address'],
    requiredConfirmations: 12,
    explorerTxUrl: 'https://etherscan.io/tx/',
    referenceTransferGas: 90_000n,
  },
  base: {
    id: 'base',
    name: 'Base',
    chainId: 8453,
    viemChain: base,
    rpcEnvVar: 'BASE_RPC_URL',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    nativePriceId: 'ethereum',
    opStackL1Fee: true,
    udNetworkSymbols: ['BASE'],
    udLegacyUsdcKeys: [],
    requiredConfirmations: 10,
    explorerTxUrl: 'https://basescan.org/tx/',
    referenceTransferGas: 90_000n,
  },
  polygon: {
    id: 'polygon',
    name: 'Polygon PoS',
    chainId: 137,
    viemChain: polygon,
    rpcEnvVar: 'POLYGON_RPC_URL',
    nativeSymbol: 'POL',
    nativeDecimals: 18,
    nativePriceId: 'polygon-ecosystem-token',
    opStackL1Fee: false,
    // UD historically uses MATIC as Polygon's network symbol.
    udNetworkSymbols: ['MATIC'],
    udLegacyUsdcKeys: ['crypto.USDC.version.MATIC.address'],
    requiredConfirmations: 32,
    explorerTxUrl: 'https://polygonscan.com/tx/',
    referenceTransferGas: 90_000n,
  },
};

export function isNetworkId(v: string): v is NetworkId {
  return (NETWORK_IDS as readonly string[]).includes(v);
}

export function getNetworkByChainId(chainId: number): NetworkConfig | undefined {
  return Object.values(NETWORKS).find((n) => n.chainId === chainId);
}
