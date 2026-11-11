import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import { NETWORK_IDS } from '../config/networks.js';

/** Accepts all-lowercase / all-uppercase hex, or mixed case only with a valid EIP-55 checksum. */
export function isValidEvmAddress(v: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return false;
  const hex = v.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  return isAddress(v, { strict: true });
}

export const NetworkIdSchema = z.enum(NETWORK_IDS).describe('Allowlisted network id: ethereum | base | polygon');

export const DomainSchema = z
  .string()
  .min(3)
  .max(253)
  .describe('Web3 domain, e.g. thomaszacharias.nft');

export const AmountSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, 'Amount must be a decimal string with at most 6 decimals, e.g. "25" or "25.50"')
  .describe('USDC amount as a decimal string (never a float)');

export const AddressSchema = z
  .string()
  .refine(isValidEvmAddress, 'Invalid EVM address (or bad EIP-55 checksum)')
  .transform((v) => getAddress(v))
  .describe('EVM address (0x…)');

export const TxHashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid transaction hash')
  .transform((v) => v.toLowerCase() as `0x${string}`);

export const TokenSchema = z.literal('USDC').default('USDC').describe('Only USDC is supported in this release');

export const ResolveRequest = z.object({ domain: DomainSchema }).strict();

export const QuoteRequest = z
  .object({
    domain: DomainSchema,
    token: TokenSchema,
    amount: AmountSchema,
    networks: z.array(NetworkIdSchema).min(1).max(NETWORK_IDS.length).optional(),
    sender: AddressSchema.optional().describe('Sender wallet. Needed for live gas estimates and balance checks.'),
  })
  .strict();

export const EstimateFeeRequest = z
  .object({
    domain: DomainSchema,
    token: TokenSchema,
    amount: AmountSchema,
    network: NetworkIdSchema,
    sender: AddressSchema.optional(),
  })
  .strict();

export const PrepareRequest = z
  .object({
    quoteId: z.string().regex(/^q_[0-9a-f]{32}$/, 'Invalid quoteId'),
    sender: AddressSchema,
    network: NetworkIdSchema.describe('Network explicitly selected by the user'),
  })
  .strict();

export const VerifyRequest = z
  .object({
    txHash: TxHashSchema,
    network: NetworkIdSchema.optional(),
    preparationId: z.string().regex(/^p_[0-9a-f]{32}$/, 'Invalid preparationId').optional(),
  })
  .strict()
  .refine((v) => v.network || v.preparationId, 'network or preparationId is required');

export const InvoiceRequest = z
  .object({
    plan: z.string().regex(/^[a-z0-9-]{2,32}$/, 'Invalid plan id'),
    network: NetworkIdSchema,
    payer: AddressSchema.describe('Wallet that will send the USDC payment'),
  })
  .strict();

export const InvoiceId = z.string().regex(/^inv_[0-9a-f]{32}$/, 'Invalid invoice id');

export const ConfirmPaymentRequest = z.object({ invoiceId: InvoiceId, txHash: TxHashSchema }).strict();

export const IdParam =z.string().regex(/^[qp]_[0-9a-f]{32}$/, 'Invalid id');
