import type { Address, Hex } from 'viem';
import type { NetworkId } from '../config/networks.js';

export interface Payment {
  invoiceId: string;
  txHash: Hex;
  network: NetworkId;
  amount: string;
  paidAt: string;
}

export interface Subscription {
  id: string;
  /** sha256 of the API key; the key itself is never stored in plaintext. */
  keyHash: string;
  keyPrefix: string;
  planId: string;
  payer: Address;
  createdAt: string;
  expiresAt: string;
  monthlyCalls: number;
  usage: { periodStart: string; calls: number };
  payments: Payment[];
  revoked?: boolean;
}

export interface Invoice {
  id: string;
  status: 'awaiting_payment' | 'paid' | 'expired';
  createdAt: string;
  expiresAt: string;
  planId: string;
  amount: string;
  amountRaw: string;
  network: NetworkId;
  chainId: number;
  tokenContract: Address;
  payer: Address;
  /** Wallet resolved from the billing domain at invoice time; payment must go here. */
  treasury: Address;
  treasuryDomain: string;
  treasuryRecordKey: string;
  /** Payments in blocks before this are not accepted for this invoice. */
  startBlock: string;
  /** Present when renewing an existing subscription. */
  renewSubscriptionId?: string;
  txHash?: Hex;
  subscriptionId?: string;
  paidAt?: string;
  /** New API key encrypted (AES-256-GCM) for a short pickup window, then wiped. */
  pendingKey?: { iv: string; tag: string; data: string; until: string };
}
