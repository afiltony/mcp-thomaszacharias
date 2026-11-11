import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { toHex, type Address, type Hex } from 'viem';
import { NETWORKS, type NetworkId } from '../config/networks.js';
import { USDC } from '../config/tokens.js';
import type { AppContext } from '../context.js';
import { encodeUsdcTransfer } from '../evm/gateway.js';
import { AppError } from '../lib/errors.js';
import { formatUnitsExact } from '../lib/decimal.js';
import { log } from '../lib/logger.js';
import { evaluateRoute, publicRoute, type RouteResult } from '../quote/compare-routes.js';

export interface PreparationRecord {
  preparationId: string;
  quoteId: string;
  createdAt: string;
  expiresAt: string;
  network: NetworkId;
  chainId: number;
  domain: string;
  from: Address;
  /** The USDC contract — a token transfer calls the token, not the recipient wallet. */
  to: Address;
  tokenContract: Address;
  recipient: Address;
  recipientRecordKey: string;
  amount: string;
  amountRaw: string;
  data: Hex;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  route: Omit<RouteResult, '_sort'>;
  binding: { digest: Hex; signature: Hex };
  submittedTxHash?: Hex;
}

let devSecret: Buffer | undefined;
function bindingSecret(ctx: AppContext): Buffer {
  if (ctx.env.MCP_AUTH_SECRET) return Buffer.from(ctx.env.MCP_AUTH_SECRET, 'utf8');
  if (!devSecret) {
    devSecret = randomBytes(32);
    log.warn('binding_secret_ephemeral', { note: 'MCP_AUTH_SECRET not set; using a per-process secret (dev only)' });
  }
  return devSecret;
}

/** The fields that must not change between preparation and wallet approval. */
export function bindingPayload(p: Pick<PreparationRecord, 'preparationId' | 'quoteId' | 'chainId' | 'from' | 'to' | 'tokenContract' | 'recipient' | 'amountRaw' | 'data' | 'expiresAt'>) {
  return JSON.stringify([
    'tz-mcp-usdc-transfer-v1',
    p.preparationId,
    p.quoteId,
    p.chainId,
    p.from.toLowerCase(),
    p.to.toLowerCase(),
    p.tokenContract.toLowerCase(),
    p.recipient.toLowerCase(),
    p.amountRaw,
    p.data.toLowerCase(),
    p.expiresAt,
  ]);
}

export function signBinding(ctx: AppContext, payload: string) {
  const digest = ('0x' + createHash('sha256').update(payload).digest('hex')) as Hex;
  const signature = ('0x' + createHmac('sha256', bindingSecret(ctx)).update(digest).digest('hex')) as Hex;
  return { digest, signature };
}

export function verifyBinding(ctx: AppContext, prep: PreparationRecord): boolean {
  const { digest, signature } = signBinding(ctx, bindingPayload(prep));
  const a = Buffer.from(signature.slice(2), 'hex');
  const b = Buffer.from(prep.binding.signature.slice(2), 'hex');
  return digest === prep.binding.digest && a.length === b.length && timingSafeEqual(a, b);
}

export async function prepareTransfer(ctx: AppContext, input: { quoteId: string; sender: Address; network: NetworkId }) {
  const quote = await ctx.quotes.get(input.quoteId);
  if (!quote) throw new AppError('QUOTE_NOT_FOUND', 'Quote not found; request a new quote');
  if (Date.parse(quote.expiresAt) <= ctx.now()) throw new AppError('QUOTE_EXPIRED', 'Quote has expired; request a new quote');
  if (quote.sender && quote.sender.toLowerCase() !== input.sender.toLowerCase()) {
    throw new AppError('INVALID_REQUEST', 'Sender does not match the sender used for this quote');
  }
  const quotedRoute = quote.routes.find((r) => r.network === input.network);
  if (!quotedRoute) throw new AppError('ROUTE_NOT_ELIGIBLE', `Network ${input.network} was not part of this quote`);
  if (!quotedRoute.recipient) {
    throw new AppError('ROUTE_NOT_ELIGIBLE', `Network ${input.network} had no valid recipient in this quote`, { reasons: quotedRoute.reasons });
  }

  // Re-validate everything live: fresh domain records (no cache), chain id, token, balances, gas, price.
  const records = await ctx.records.getRecords(quote.domain, { bypassCache: true });
  const amountRaw = BigInt(quote.amountRaw);
  const route = await evaluateRoute(ctx, { records, network: input.network, amountRaw, sender: input.sender, requireLive: true });

  if (route.recipient!.address !== quotedRoute.recipient.address) {
    await ctx.audit.write('recipient_changed', { quoteId: quote.quoteId, network: input.network, quoted: quotedRoute.recipient.address, current: route.recipient!.address });
    throw new AppError('RECIPIENT_CHANGED', 'The domain\'s USDC receiving address changed since the quote. Request a new quote and review the new address.', {
      quoted: quotedRoute.recipient.address,
      current: route.recipient!.address,
    });
  }

  const net = NETWORKS[input.network];
  const token = USDC[input.network];
  const gw = ctx.gateways[input.network]!;
  await gw.simulateTransfer({ token: token.address, from: input.sender, to: route.recipient!.address, amount: amountRaw });

  const data = encodeUsdcTransfer(route.recipient!.address, amountRaw);
  const now = ctx.now();
  const preparationId = ctx.preparations.newId();
  const base = {
    preparationId,
    quoteId: quote.quoteId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ctx.env.PREPARATION_TTL_SECONDS * 1000).toISOString(),
    network: input.network,
    chainId: net.chainId,
    domain: quote.domain,
    from: input.sender,
    to: token.address,
    tokenContract: token.address,
    recipient: route.recipient!.address,
    recipientRecordKey: route.recipient!.recordKey,
    amount: formatUnitsExact(amountRaw, token.decimals),
    amountRaw: amountRaw.toString(),
    data,
    gasLimit: route.gas!.gasLimit,
    maxFeePerGas: route.gas!.maxFeePerGasWei,
    maxPriorityFeePerGas: route.gas!.maxPriorityFeePerGasWei,
    route: publicRoute(route),
  };
  const prep: PreparationRecord = { ...base, binding: signBinding(ctx, bindingPayload(base)) };
  await ctx.preparations.put(preparationId, prep);
  await ctx.audit.write('transfer_prepared', {
    preparationId,
    quoteId: quote.quoteId,
    network: input.network,
    from: prep.from,
    recipient: prep.recipient,
    amount: prep.amount,
    digest: prep.binding.digest,
  });
  return prep;
}

export function publicPreparation(ctx: AppContext, prep: PreparationRecord) {
  const net = NETWORKS[prep.network];
  const expired = Date.parse(prep.expiresAt) <= ctx.now();
  const r = prep.route;
  return {
    preparationId: prep.preparationId,
    quoteId: prep.quoteId,
    status: expired ? 'expired' : prep.submittedTxHash ? 'submitted' : 'awaiting_wallet_approval',
    createdAt: prep.createdAt,
    expiresAt: prep.expiresAt,
    network: prep.network,
    chainId: prep.chainId,
    signed: false,
    broadcast: false,
    /** EIP-1193 `eth_sendTransaction` params. The wallet signs; this server never does. */
    unsignedTransaction: {
      chainId: toHex(prep.chainId),
      from: prep.from,
      to: prep.to,
      value: '0x0',
      data: prep.data,
      gas: toHex(BigInt(prep.gasLimit)),
      maxFeePerGas: toHex(BigInt(prep.maxFeePerGas)),
      maxPriorityFeePerGas: toHex(BigInt(prep.maxPriorityFeePerGas)),
      type: '0x2',
    },
    decoded: {
      method: 'transfer(address,uint256)',
      tokenContract: prep.tokenContract,
      recipient: prep.recipient,
      amountRaw: prep.amountRaw,
    },
    approvalSummary: {
      domain: prep.domain,
      recipient: prep.recipient,
      recipientRecord: prep.recipientRecordKey,
      token: 'USDC (native, issued by Circle)',
      tokenContract: prep.tokenContract,
      transactionTo: `${prep.to} (the USDC contract — the recipient is encoded in the call data)`,
      network: `${net.name} (chain ID ${prep.chainId})`,
      amount: `${prep.amount} USDC`,
      estimatedNetworkFee: `${r.fees?.expectedFeeNative} ${r.fees?.nativeSymbol} (≈ $${r.fees?.expectedFeeUsd})`,
      maximumNetworkFee: `${r.fees?.maxFeeNative} ${r.fees?.nativeSymbol} (≈ $${r.fees?.maxFeeUsd})`,
      totalDebit: `${prep.amount} USDC + up to ${r.fees?.maxFeeNative} ${r.fees?.nativeSymbol} for gas`,
      warnings: r.warnings,
      text:
        `Send ${prep.amount} USDC to ${prep.domain} (${prep.recipient}) on ${net.name}. ` +
        `Expected fee ≈ $${r.fees?.expectedFeeUsd} in ${r.fees?.nativeSymbol} (max ≈ $${r.fees?.maxFeeUsd}). ` +
        `Your wallet will call the USDC contract ${prep.tokenContract}. Only approve if every detail matches.`,
    },
    binding: prep.binding,
    approvalUrl: ctx.env.PUBLIC_BASE_URL ? `${ctx.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/approve/${prep.preparationId}` : `/approve/${prep.preparationId}`,
    submittedTxHash: prep.submittedTxHash ?? null,
  };
}

/** Called right before the user signs: re-checks recipient record, balances and expiry. */
export async function recheckPreparation(ctx: AppContext, preparationId: string) {
  const prep = await ctx.preparations.get(preparationId);
  if (!prep) throw new AppError('PREPARATION_NOT_FOUND', 'Prepared transfer not found');
  if (Date.parse(prep.expiresAt) <= ctx.now()) throw new AppError('PREPARATION_EXPIRED', 'Prepared transfer expired; prepare it again');
  if (!verifyBinding(ctx, prep)) throw new AppError('TX_MISMATCH', 'Prepared transfer failed its integrity check');
  const records = await ctx.records.getRecords(prep.domain, { bypassCache: true });
  const route = await evaluateRoute(ctx, { records, network: prep.network, amountRaw: BigInt(prep.amountRaw), sender: prep.from, requireLive: true });
  if (route.recipient!.address !== prep.recipient) {
    throw new AppError('RECIPIENT_CHANGED', 'The domain\'s USDC receiving address changed. Do not sign; prepare a new transfer.');
  }
  return { ok: true as const, checkedAt: new Date(ctx.now()).toISOString(), currentExpectedFeeUsd: route.fees?.expectedFeeUsd, currentMaxFeeUsd: route.fees?.maxFeeUsd };
}
