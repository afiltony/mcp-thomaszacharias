import { getAddress, type Address } from 'viem';
import type { NetworkId } from './networks.js';

/**
 * Native (Circle-issued) USDC deployments.
 * Source: Circle developer docs — https://developers.circle.com/stablecoins/usdc-contract-addresses
 * Verified 2026-10-28. Bridged variants (USDC.e on Polygon, USDbC on Base) are deliberately NOT allowlisted.
 * Re-verify against Circle's page whenever this file changes.
 */
export interface TokenDeployment {
  symbol: 'USDC';
  network: NetworkId;
  address: Address;
  decimals: 6;
  issuer: 'Circle';
  native: true;
}

export const USDC: Record<NetworkId, TokenDeployment> = {
  ethereum: {
    symbol: 'USDC',
    network: 'ethereum',
    address: getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
    decimals: 6,
    issuer: 'Circle',
    native: true,
  },
  base: {
    symbol: 'USDC',
    network: 'base',
    address: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    decimals: 6,
    issuer: 'Circle',
    native: true,
  },
  polygon: {
    symbol: 'USDC',
    network: 'polygon',
    address: getAddress('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'),
    decimals: 6,
    issuer: 'Circle',
    native: true,
  },
};

/** Known look-alike / bridged contracts. Used only to give a clearer error, never to send. */
export const KNOWN_NON_NATIVE_USDC: Record<string, string> = {
  [getAddress('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174')]: 'USDC.e (bridged) on Polygon PoS',
  [getAddress('0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA')]: 'USDbC (bridged) on Base',
};

export const SUPPORTED_TOKENS = ['USDC'] as const;
export type SupportedToken = (typeof SUPPORTED_TOKENS)[number];
