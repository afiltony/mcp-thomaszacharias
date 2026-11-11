import type { Address } from 'viem';
import { z } from 'zod';
import { NETWORKS, NETWORK_IDS, type NetworkId } from './config/networks.js';
import { USDC } from './config/tokens.js';
import type { AppContext } from './context.js';
import { resolveUsdcRecipient } from './domain/unstoppable.js';
import { AppError } from './lib/errors.js';
import { parseDecimalAmount } from './lib/decimal.js';
import { compareRoutes, evaluateRoute, publicQuote, publicRoute } from './quote/compare-routes.js';
import { prepareTransfer, publicPreparation, recheckPreparation } from './transfer/prepare.js';
import { verifyTransfer } from './transfer/verify.js';
import {
  ConfirmPaymentRequest,
  EstimateFeeRequest,
  IdParam,
  InvoiceId,
  InvoiceRequest,
  PrepareRequest,
  QuoteRequest,
  ResolveRequest,
  VerifyRequest,
} from './schemas/requests.js';
import { confirmInvoice, createInvoice, getInvoice, invoiceView, mySubscription, plansView } from './billing/billing.js';

/**
 * Shared operations. Both the REST API and the MCP tools call these, so the
 * validation, policy checks and audit trail are identical on both surfaces.
 */
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new AppError('INVALID_REQUEST', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  }
  return r.data;
}

function usdcAmount(ctx: AppContext, amount: string): bigint {
  const raw = parseDecimalAmount(amount, 6);
  const max = parseDecimalAmount(ctx.env.MAX_TRANSFER_USDC, 6);
  if (raw > max) throw new AppError('INVALID_REQUEST', `Amount exceeds the per-transfer limit of ${ctx.env.MAX_TRANSFER_USDC} USDC`);
  return raw;
}

export const ops = {
  async resolveDomain(ctx: AppContext, input: unknown) {
    const { domain } = parse(ResolveRequest, input);
    const records = await ctx.records.getRecords(domain);
    const networks = NETWORK_IDS.map((n) => {
      const r = resolveUsdcRecipient(records, n, ctx.env.RECIPIENT_RECORD_POLICY);
      return {
        network: n,
        networkName: NETWORKS[n].name,
        chainId: NETWORKS[n].chainId,
        token: 'USDC',
        status: r.status,
        address: r.address ?? null,
        recordKey: r.recordKey ?? null,
        confidence: r.confidence ?? null,
        warnings: r.warnings,
        reason: r.reason ?? null,
      };
    });
    return {
      domain: records.domain,
      owner: records.owner,
      registry: records.blockchain,
      resolvedAt: records.fetchedAt,
      recordPolicy: ctx.env.RECIPIENT_RECORD_POLICY,
      usdcReceivingAddresses: networks,
      note: 'Only USDC-related records are used. An Ethereum (crypto.ETH.address) record is never treated as a USDC address. Always show the resolved address to the user before sending.',
    };
  },

  supportedNetworks(ctx: AppContext) {
    return {
      token: 'USDC',
      routeTypes: ['direct-transfer'],
      bridging: 'not supported (routes requiring bridging/swapping are reported as ineligible)',
      networks: NETWORK_IDS.map((n) => ({
        id: n,
        name: NETWORKS[n].name,
        chainId: NETWORKS[n].chainId,
        family: 'EVM',
        tokenStandard: 'ERC-20',
        gasToken: NETWORKS[n].nativeSymbol,
        usdc: { contract: USDC[n].address, decimals: USDC[n].decimals, issuer: 'Circle', native: true },
        feeModel: NETWORKS[n].opStackL1Fee ? 'EIP-1559 L2 execution + L1 data fee' : 'EIP-1559',
        requiredConfirmations: NETWORKS[n].requiredConfirmations,
        configured: Boolean(ctx.gateways[n]),
      })),
    };
  },

  async estimateFee(ctx: AppContext, input: unknown) {
    const req = parse(EstimateFeeRequest, input);
    const amountRaw = usdcAmount(ctx, req.amount);
    const records = await ctx.records.getRecords(req.domain);
    const route = await evaluateRoute(ctx, { records, network: req.network, amountRaw, sender: req.sender as Address | undefined });
    return { domain: records.domain, amount: req.amount, token: 'USDC', estimatedAt: new Date(ctx.now()).toISOString(), route: publicRoute(route) };
  },

  async compare(ctx: AppContext, input: unknown) {
    const req = parse(QuoteRequest, input);
    const amountRaw = usdcAmount(ctx, req.amount);
    const quote = await compareRoutes(ctx, {
      domain: req.domain,
      amount: req.amount,
      amountRaw,
      networks: req.networks as NetworkId[] | undefined,
      sender: req.sender as Address | undefined,
    });
    return publicQuote(quote);
  },

  async prepare(ctx: AppContext, input: unknown) {
    const req = parse(PrepareRequest, input);
    const prep = await prepareTransfer(ctx, { quoteId: req.quoteId, sender: req.sender as Address, network: req.network });
    return publicPreparation(ctx, prep);
  },

  async getById(ctx: AppContext, id: string) {
    const valid = parse(IdParam, id);
    if (valid.startsWith('q_')) {
      const q = await ctx.quotes.get(valid);
      if (!q) throw new AppError('QUOTE_NOT_FOUND', 'Quote not found');
      return { kind: 'quote', expired: Date.parse(q.expiresAt) <= ctx.now(), ...publicQuote(q) };
    }
    const p = await ctx.preparations.get(valid);
    if (!p) throw new AppError('PREPARATION_NOT_FOUND', 'Prepared transfer not found');
    return { kind: 'preparation', ...publicPreparation(ctx, p) };
  },

  async recheck(ctx: AppContext, id: string) {
    return recheckPreparation(ctx, parse(IdParam, id));
  },

  async verify(ctx: AppContext, input: unknown) {
    const req = parse(VerifyRequest, input);
    return verifyTransfer(ctx, { txHash: req.txHash, network: req.network, preparationId: req.preparationId });
  },

  // ---- Crypto-only subscription billing (USDC to BILLING_DOMAIN) ----
  plans(ctx: AppContext) {
    return plansView(ctx);
  },

  async createInvoice(ctx: AppContext, input: unknown, renewSubscriptionId?: string) {
    const req = parse(InvoiceRequest, input);
    return createInvoice(ctx, { planId: req.plan, network: req.network, payer: req.payer as Address, renewSubscriptionId });
  },

  async getInvoice(ctx: AppContext, id: string) {
    return invoiceView(ctx, await getInvoice(ctx, parse(InvoiceId, id)));
  },

  async confirmPayment(ctx: AppContext, input: unknown) {
    const req = parse(ConfirmPaymentRequest, input);
    return confirmInvoice(ctx, { invoiceId: req.invoiceId, txHash: req.txHash });
  },

  mySubscription(ctx: AppContext, subscriptionId?: string) {
    return mySubscription(ctx, subscriptionId);
  },
};
