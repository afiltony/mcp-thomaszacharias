import type { Address } from 'viem';
import { NETWORKS, NETWORK_IDS, type NetworkId } from '../config/networks.js';
import { USDC } from '../config/tokens.js';
import type { AppContext } from '../context.js';
import { resolveUsdcRecipient, type DomainRecords, type RecordConfidence } from '../domain/unstoppable.js';
import { encodeUsdcTransfer, type ChainGateway } from '../evm/gateway.js';
import { AppError, type ErrorCode } from '../lib/errors.js';
import { formatUnitsExact, usd8ToString, weiToUsd8 } from '../lib/decimal.js';
import { priceAgeSeconds } from '../pricing/prices.js';
import { computeFees } from './fees.js';

export interface RouteReason {
  code: ErrorCode;
  message: string;
}

export interface RouteResult {
  network: NetworkId;
  networkName: string;
  chainId: number;
  eligible: boolean;
  /** live = gas estimated for this exact sender; indicative = reference gas units (no sender supplied) */
  quoteType: 'live' | 'indicative' | 'none';
  routeType: 'direct-transfer';
  requiresBridge: false;
  requiresSwap: false;
  reasons: RouteReason[];
  warnings: string[];
  recipient?: { address: Address; recordKey: string; confidence: RecordConfidence; isContract?: boolean };
  token: { symbol: 'USDC'; contract: Address; decimals: number; issuer: 'Circle'; native: true };
  gas?: {
    source: 'eth_estimateGas' | 'reference';
    gasUnits: string;
    gasLimit: string;
    baseFeePerGasWei: string;
    maxPriorityFeePerGasWei: string;
    maxFeePerGasWei: string;
    expectedGasPriceWei: string;
    l1DataFeeWei: string;
    feeBlock: string;
    feeDataAt: string;
  };
  fees?: {
    nativeSymbol: string;
    expectedFeeNative: string;
    maxFeeNative: string;
    safetyMarginNative: string;
    expectedFeeUsd: string;
    maxFeeUsd: string;
  };
  costBreakdownUsd?: { networkFee: string; conversionFee: '0'; bridgeFee: '0'; otherRouteFees: '0'; total: string };
  totalDebit?: { usdc: string; nativeGasUpTo: string; nativeSymbol: string };
  price?: { nativeUsd: string; asOf: string; ageSeconds: number; source: string };
  sender?: { address: Address; usdcBalance: string; nativeBalance: string };
  /** internal sort keys (not part of the public contract) */
  _sort?: { expectedUsd8: bigint; maxUsd8: bigint };
}

export interface QuoteRecord {
  quoteId: string;
  createdAt: string;
  expiresAt: string;
  domain: string;
  token: 'USDC';
  amount: string;
  amountRaw: string;
  sender: Address | null;
  routes: RouteResult[];
  recommendedNetwork: NetworkId | null;
}

export interface EvaluateInput {
  records: DomainRecords;
  network: NetworkId;
  amountRaw: bigint;
  sender?: Address;
  /** When true, ineligible routes throw instead of returning a result (used by prepare). */
  requireLive?: boolean;
}

const TOKEN_VERIFY_TTL_MS = 10 * 60_000;

export async function verifyChainAndToken(ctx: AppContext, gw: ChainGateway, network: NetworkId): Promise<void> {
  const net = NETWORKS[network];
  const chainId = await gw.getChainId();
  if (chainId !== net.chainId) {
    throw new AppError('CHAIN_ID_MISMATCH', `${net.name} RPC reports chain ID ${chainId}; expected ${net.chainId}`, { network });
  }
  const token = USDC[network];
  const key = `${network}:${token.address}`;
  const until = ctx.verifiedTokens.get(key);
  if (until && until > ctx.now()) return;
  const meta = await gw.readTokenMeta(token.address);
  if (!meta.hasCode || meta.symbol !== 'USDC' || meta.decimals !== token.decimals) {
    throw new AppError('TOKEN_CONTRACT_MISMATCH', `Allowlisted USDC contract on ${net.name} failed on-chain verification`, {
      network,
      contract: token.address,
      observed: meta,
    });
  }
  ctx.verifiedTokens.set(key, ctx.now() + TOKEN_VERIFY_TTL_MS);
}

/** Evaluate a single direct-transfer route. Never fabricates numbers: failures make the route ineligible. */
export async function evaluateRoute(ctx: AppContext, input: EvaluateInput): Promise<RouteResult> {
  const net = NETWORKS[input.network];
  const token = USDC[input.network];
  const result: RouteResult = {
    network: net.id,
    networkName: net.name,
    chainId: net.chainId,
    eligible: false,
    quoteType: 'none',
    routeType: 'direct-transfer',
    requiresBridge: false,
    requiresSwap: false,
    reasons: [],
    warnings: [],
    token: { symbol: 'USDC', contract: token.address, decimals: token.decimals, issuer: 'Circle', native: true },
  };
  const fail = (code: ErrorCode, message: string): RouteResult => {
    result.reasons.push({ code, message });
    if (input.requireLive) throw new AppError(code, message, { network: net.id });
    return result;
  };

  // 1. Recipient record for USDC on *this* network
  const rec = resolveUsdcRecipient(input.records, input.network, ctx.env.RECIPIENT_RECORD_POLICY);
  if (rec.status === 'missing') return fail('RECIPIENT_RECORD_MISSING', rec.reason!);
  if (rec.status === 'invalid') return fail('RECIPIENT_INVALID', rec.reason!);
  result.recipient = { address: rec.address!, recordKey: rec.recordKey!, confidence: rec.confidence! };
  result.warnings.push(...rec.warnings);

  const gw = ctx.gateways[input.network];
  if (!gw) return fail('NETWORK_NOT_CONFIGURED', `${net.name} RPC is not configured on this server`);

  try {
    // 2–3. Chain ID and official token contract
    await verifyChainAndToken(ctx, gw, input.network);

    if (input.sender && input.sender === rec.address) return fail('INVALID_REQUEST', 'Sender and recipient are the same address');

    // Recipient sanity: USDC blacklist and contract detection
    const [recipientBlocked, recipientIsContract] = await Promise.all([
      gw.isBlacklisted(token.address, rec.address!),
      gw.isContract(rec.address!),
    ]);
    if (recipientBlocked === true) return fail('RECIPIENT_BLOCKED', 'Recipient address is blacklisted by the USDC contract; transfer would fail');
    if (recipientBlocked === null) result.warnings.push('Could not check the USDC blacklist status of the recipient.');
    result.recipient.isContract = recipientIsContract;
    if (recipientIsContract) result.warnings.push('Recipient is a smart contract. Confirm it can receive and use USDC on this network.');

    const data = encodeUsdcTransfer(rec.address!, input.amountRaw);

    // 4. Sender balances
    let gasUnits: bigint;
    let gasSource: 'eth_estimateGas' | 'reference';
    let nativeBalance: bigint | undefined;
    if (input.sender) {
      const [usdcBal, nativeBal, senderBlocked] = await Promise.all([
        gw.tokenBalance(token.address, input.sender),
        gw.nativeBalance(input.sender),
        gw.isBlacklisted(token.address, input.sender),
      ]);
      nativeBalance = nativeBal;
      result.sender = {
        address: input.sender,
        usdcBalance: formatUnitsExact(usdcBal, token.decimals),
        nativeBalance: formatUnitsExact(nativeBal, 18),
      };
      if (senderBlocked === true) return fail('RECIPIENT_BLOCKED', 'Sender address is blacklisted by the USDC contract');
      if (usdcBal < input.amountRaw) {
        return fail(
          'INSUFFICIENT_TOKEN_BALANCE',
          `Sender holds ${result.sender.usdcBalance} USDC on ${net.name}; ${formatUnitsExact(input.amountRaw, token.decimals)} needed. ` +
            'Using this network would require bridging or acquiring USDC first — not offered as a direct route.',
        );
      }
      // 5. Live gas estimate for this exact transfer
      try {
        gasUnits = await gw.estimateGas({ from: input.sender, to: token.address, data });
      } catch (err) {
        if (err instanceof AppError && err.code === 'RPC_UNAVAILABLE') {
          // estimateGas reverts surface as RPC errors; probe with a simulation for a clearer reason
          await gw.simulateTransfer({ token: token.address, from: input.sender, to: rec.address!, amount: input.amountRaw });
        }
        throw err;
      }
      gasSource = 'eth_estimateGas';
      result.quoteType = 'live';
    } else {
      gasUnits = net.referenceTransferGas;
      gasSource = 'reference';
      result.quoteType = 'indicative';
      result.warnings.push('No sender address supplied: gas units are a conservative reference value; fee rates are live. Supply a sender for a live quote.');
    }

    // 6. Current fee data (+ L1 data fee on OP-stack chains)
    const [feeData, l1Fee] = await Promise.all([
      gw.getFeeData(),
      gw.estimateL1Fee({ from: input.sender, to: token.address, data }),
    ]);
    const fees = computeFees({
      gasUnits,
      fee: feeData,
      l1FeeWei: l1Fee,
      gasLimitBufferBps: ctx.env.GAS_LIMIT_BUFFER_BPS,
      l1FeeBufferBps: ctx.env.L1_FEE_BUFFER_BPS,
    });

    // 7. Native-coin price with staleness guard
    const price = await ctx.prices.getUsdPrice(net.nativePriceId);
    const age = priceAgeSeconds(price, ctx.now());
    result.price = { nativeUsd: price.usd, asOf: price.asOf, ageSeconds: age, source: price.source };
    if (age > ctx.env.PRICE_MAX_AGE_SECONDS) {
      return fail('PRICE_STALE', `${net.nativeSymbol} price is ${age}s old (limit ${ctx.env.PRICE_MAX_AGE_SECONDS}s)`);
    }

    const expectedUsd8 = weiToUsd8(fees.expectedFeeWei, price.usd8);
    const maxUsd8 = weiToUsd8(fees.maxFeeWei, price.usd8);
    result.gas = {
      source: gasSource,
      gasUnits: fees.gasUnits.toString(),
      gasLimit: fees.gasLimit.toString(),
      baseFeePerGasWei: feeData.baseFeePerGas.toString(),
      maxPriorityFeePerGasWei: feeData.maxPriorityFeePerGas.toString(),
      maxFeePerGasWei: fees.maxFeePerGas.toString(),
      expectedGasPriceWei: fees.expectedGasPrice.toString(),
      l1DataFeeWei: fees.l1FeeExpected.toString(),
      feeBlock: feeData.blockNumber.toString(),
      feeDataAt: feeData.fetchedAt,
    };
    result.fees = {
      nativeSymbol: net.nativeSymbol,
      expectedFeeNative: formatUnitsExact(fees.expectedFeeWei, 18),
      maxFeeNative: formatUnitsExact(fees.maxFeeWei, 18),
      safetyMarginNative: formatUnitsExact(fees.safetyMarginWei, 18),
      expectedFeeUsd: usd8ToString(expectedUsd8, 4),
      maxFeeUsd: usd8ToString(maxUsd8, 4),
    };
    result.costBreakdownUsd = {
      networkFee: usd8ToString(expectedUsd8, 4),
      conversionFee: '0',
      bridgeFee: '0',
      otherRouteFees: '0',
      total: usd8ToString(expectedUsd8, 4),
    };
    result.totalDebit = {
      usdc: formatUnitsExact(input.amountRaw, token.decimals),
      nativeGasUpTo: result.fees.maxFeeNative,
      nativeSymbol: net.nativeSymbol,
    };
    result._sort = { expectedUsd8, maxUsd8 };

    // 8. Gas affordability
    if (nativeBalance !== undefined && nativeBalance < fees.maxFeeWei) {
      return fail(
        'INSUFFICIENT_GAS_BALANCE',
        `Sender has ${formatUnitsExact(nativeBalance, 18)} ${net.nativeSymbol} on ${net.name}; up to ${result.fees.maxFeeNative} may be needed for gas`,
      );
    }

    result.eligible = true;
    return result;
  } catch (err) {
    const e = err instanceof AppError ? err : new AppError('INTERNAL', 'Unexpected error evaluating route');
    return fail(e.code, e.message);
  }
}

export function rankRoutes(routes: RouteResult[]): RouteResult[] {
  return [...routes].sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (!a._sort || !b._sort) return a._sort ? -1 : b._sort ? 1 : 0;
    if (a._sort.expectedUsd8 !== b._sort.expectedUsd8) return a._sort.expectedUsd8 < b._sort.expectedUsd8 ? -1 : 1;
    if (a._sort.maxUsd8 !== b._sort.maxUsd8) return a._sort.maxUsd8 < b._sort.maxUsd8 ? -1 : 1;
    return 0;
  });
}

export function publicRoute(r: RouteResult): Omit<RouteResult, '_sort'> {
  const { _sort, ...rest } = r;
  return rest;
}

export async function compareRoutes(
  ctx: AppContext,
  input: { domain: string; amount: string; amountRaw: bigint; networks?: NetworkId[]; sender?: Address },
): Promise<QuoteRecord> {
  const records = await ctx.records.getRecords(input.domain);
  const networks = input.networks?.length ? [...new Set(input.networks)] : [...NETWORK_IDS];
  const evaluated = await Promise.all(networks.map((network) => evaluateRoute(ctx, { records, network, amountRaw: input.amountRaw, sender: input.sender })));
  const ranked = rankRoutes(evaluated);
  const now = ctx.now();
  const quote: QuoteRecord = {
    quoteId: ctx.quotes.newId(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ctx.env.QUOTE_TTL_SECONDS * 1000).toISOString(),
    domain: records.domain,
    token: 'USDC',
    amount: input.amount,
    amountRaw: input.amountRaw.toString(),
    sender: input.sender ?? null,
    routes: ranked,
    recommendedNetwork: ranked.find((r) => r.eligible)?.network ?? null,
  };
  await ctx.quotes.put(quote.quoteId, quote);
  await ctx.audit.write('quote_created', {
    quoteId: quote.quoteId,
    domain: quote.domain,
    amount: quote.amount,
    sender: quote.sender,
    recommended: quote.recommendedNetwork,
    eligible: ranked.filter((r) => r.eligible).map((r) => r.network),
  });
  return quote;
}

export function publicQuote(q: QuoteRecord) {
  const best = q.routes.find((r) => r.eligible);
  return {
    quoteId: q.quoteId,
    domain: q.domain,
    token: q.token,
    amount: q.amount,
    amountRaw: q.amountRaw,
    sender: q.sender,
    createdAt: q.createdAt,
    expiresAt: q.expiresAt,
    recommendedNetwork: q.recommendedNetwork,
    summary: best
      ? `Cheapest direct route: ${best.networkName} — ${q.amount} USDC to ${best.recipient?.address}, expected network fee ≈ $${best.fees?.expectedFeeUsd} (up to $${best.fees?.maxFeeUsd}) paid in ${best.fees?.nativeSymbol}. ${best.quoteType === 'indicative' ? 'Indicative: supply a sender address for a live quote.' : ''}`.trim()
      : 'No eligible direct USDC route. See each route\'s reasons. Bridging/swapping is not performed by this service.',
    routes: q.routes.map(publicRoute),
    notes: [
      'Ranking = expected network fee in USD for a direct USDC transfer. Conversion and bridge fees are 0 because only direct routes are offered.',
      'maxFee is the upper bound the wallet may reserve (gas limit × max fee per gas); it is not the expected cost.',
      'Quotes are estimates. Actual fees are known only from the confirmed receipt.',
    ],
  };
}
