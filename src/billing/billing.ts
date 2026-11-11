import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { decodeEventLog, erc20Abi, getAddress, toHex, type Address, type Hash } from 'viem';
import { NETWORKS, type NetworkId } from '../config/networks.js';
import { USDC } from '../config/tokens.js';
import type { Plan } from '../config/plans.js';
import type { AppContext } from '../context.js';
import { resolveUsdcRecipient } from '../domain/unstoppable.js';
import { encodeUsdcTransfer } from '../evm/gateway.js';
import { AppError } from '../lib/errors.js';
import { formatUnitsExact, parseDecimalAmount } from '../lib/decimal.js';
import type { Invoice, Payment, Subscription } from './types.js';

/**
 * Crypto-only subscription billing.
 * Customers pay USDC on an allowlisted EVM network to the wallet linked to BILLING_DOMAIN
 * (vimatons.dao). Payment is verified on-chain before an API key is issued or a plan extended.
 * No card, bank or fiat processor is involved anywhere.
 */
const KEY_PICKUP_WINDOW_MS = 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

function newId(prefix: string) {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}


function encKey(ctx: AppContext): Buffer {
  return createHash('sha256').update(`billing-key-pickup:${ctx.env.MCP_AUTH_SECRET ?? 'dev-only'}`).digest();
}
function seal(ctx: AppContext, plaintext: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(ctx), iv);
  const data = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex') };
}
function unseal(ctx: AppContext, s: { iv: string; tag: string; data: string }) {
  const d = createDecipheriv('aes-256-gcm', encKey(ctx), Buffer.from(s.iv, 'hex'));
  d.setAuthTag(Buffer.from(s.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(s.data, 'hex')), d.final()]).toString('utf8');
}

function requireBilling(ctx: AppContext) {
  if (!ctx.env.BILLING_ENABLED) throw new AppError('BILLING_DISABLED', 'Subscriptions are not enabled on this server');
}

export function getPlan(ctx: AppContext, id: string): Plan {
  const p = ctx.plans.find((x) => x.id === id);
  if (!p) throw new AppError('PLAN_NOT_FOUND', `Unknown plan "${id}"`);
  return p;
}

export function parsePinned(spec?: string): Partial<Record<NetworkId, Address>> {
  const out: Partial<Record<NetworkId, Address>> = {};
  for (const part of (spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [net, addr] = part.split(':');
    if (!net || !addr || !(net in NETWORKS)) throw new Error(`BILLING_PINNED_ADDRESSES entry "${part}" is invalid`);
    out[net as NetworkId] = getAddress(addr);
  }
  return out;
}

/** Resolve the billing domain's USDC wallet on a network, optionally enforcing a pinned address. */
export async function resolveTreasury(ctx: AppContext, network: NetworkId) {
  const records = await ctx.records.getRecords(ctx.env.BILLING_DOMAIN, { bypassCache: true });
  const r = resolveUsdcRecipient(records, network, ctx.env.RECIPIENT_RECORD_POLICY);
  if (r.status !== 'resolved' || !r.address) {
    throw new AppError('TREASURY_UNAVAILABLE', `${ctx.env.BILLING_DOMAIN} has no USDC receiving wallet on ${NETWORKS[network].name}; choose another network`);
  }
  const pinned = parsePinned(ctx.env.BILLING_PINNED_ADDRESSES)[network];
  if (pinned && pinned !== r.address) {
    await ctx.audit.write('treasury_mismatch', { network, resolved: r.address, pinned });
    throw new AppError('TREASURY_MISMATCH', `${ctx.env.BILLING_DOMAIN}'s wallet on ${NETWORKS[network].name} does not match the pinned address; payments are paused for safety`);
  }
  return { address: r.address, recordKey: r.recordKey!, domain: records.domain, warnings: r.warnings };
}

export function plansView(ctx: AppContext) {
  return {
    currency: 'USDC',
    paymentMethod: 'crypto only — USDC sent from your own wallet',
    payTo: ctx.env.BILLING_DOMAIN,
    networks: Object.values(NETWORKS).map((n) => ({ id: n.id, name: n.name, chainId: n.chainId, usdcContract: USDC[n.id].address, configured: Boolean(ctx.gateways[n.id]) })),
    plans: ctx.plans.map((p) => ({ id: p.id, name: p.name, priceUsdc: p.priceUsdc, periodDays: p.periodDays, callsPerPeriod: p.monthlyCalls, description: p.description })),
  };
}

export async function createInvoice(
  ctx: AppContext,
  input: { planId: string; network: NetworkId; payer: Address; renewSubscriptionId?: string },
) {
  requireBilling(ctx);
  const plan = getPlan(ctx, input.planId);
  const net = NETWORKS[input.network];
  const gw = ctx.gateways[input.network];
  if (!gw) throw new AppError('NETWORK_NOT_CONFIGURED', `${net.name} RPC is not configured on this server`);
  const chainId = await gw.getChainId();
  if (chainId !== net.chainId) throw new AppError('CHAIN_ID_MISMATCH', `${net.name} RPC reports chain ID ${chainId}`);

  const treasury = await resolveTreasury(ctx, input.network);
  if (treasury.address === input.payer) throw new AppError('INVALID_REQUEST', 'Payer cannot be the treasury wallet');
  const startBlock = await gw.getBlockNumber();
  const amountRaw = parseDecimalAmount(plan.priceUsdc, USDC[input.network].decimals);
  const now = ctx.now();
  const inv: Invoice = {
    id: newId('inv'),
    status: 'awaiting_payment',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ctx.env.BILLING_INVOICE_TTL_SECONDS * 1000).toISOString(),
    planId: plan.id,
    amount: plan.priceUsdc,
    amountRaw: amountRaw.toString(),
    network: input.network,
    chainId: net.chainId,
    tokenContract: USDC[input.network].address,
    payer: input.payer,
    treasury: treasury.address,
    treasuryDomain: treasury.domain,
    treasuryRecordKey: treasury.recordKey,
    startBlock: startBlock.toString(),
    renewSubscriptionId: input.renewSubscriptionId,
  };
  await ctx.billing.putInvoice(inv);
  await ctx.audit.write('invoice_created', { invoiceId: inv.id, plan: plan.id, network: inv.network, payer: inv.payer, treasury: inv.treasury, renew: inv.renewSubscriptionId });
  return invoiceView(ctx, inv);
}

export function invoiceView(ctx: AppContext, inv: Invoice) {
  const plan = ctx.plans.find((p) => p.id === inv.planId);
  const net = NETWORKS[inv.network];
  const expired = inv.status === 'awaiting_payment' && Date.parse(inv.expiresAt) <= ctx.now();
  return {
    invoiceId: inv.id,
    status: expired ? 'expired' : inv.status,
    plan: plan ? { id: plan.id, name: plan.name, periodDays: plan.periodDays, callsPerPeriod: plan.monthlyCalls } : { id: inv.planId },
    amount: `${inv.amount} USDC`,
    amountRaw: inv.amountRaw,
    network: inv.network,
    networkName: net.name,
    chainId: inv.chainId,
    payTo: { domain: inv.treasuryDomain, address: inv.treasury, recordKey: inv.treasuryRecordKey },
    payer: inv.payer,
    tokenContract: inv.tokenContract,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    renewal: Boolean(inv.renewSubscriptionId),
    /** EIP-1193 eth_sendTransaction params; the payer's wallet estimates gas, signs and sends. */
    unsignedTransaction: {
      chainId: toHex(inv.chainId),
      from: inv.payer,
      to: inv.tokenContract,
      value: '0x0',
      data: encodeUsdcTransfer(inv.treasury, BigInt(inv.amountRaw)),
    },
    paymentUrl: `${(ctx.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/subscribe?invoice=${inv.id}`,
    instructions:
      `Send exactly ${inv.amount} USDC on ${net.name} from ${inv.payer} to ${inv.treasuryDomain} (${inv.treasury}), then confirm with the transaction hash. ` +
      'Only USDC from the payer wallet on this network counts. Never share a seed phrase or private key.',
    txHash: inv.txHash ?? null,
    subscriptionId: inv.subscriptionId ?? null,
  };
}

function subscriptionView(ctx: AppContext, s: Subscription) {
  const plan = ctx.plans.find((p) => p.id === s.planId);
  const active = !s.revoked && Date.parse(s.expiresAt) > ctx.now();
  return {
    subscriptionId: s.id,
    status: s.revoked ? 'revoked' : active ? 'active' : 'expired',
    plan: plan ? { id: plan.id, name: plan.name, priceUsdc: plan.priceUsdc } : { id: s.planId },
    keyPrefix: s.keyPrefix,
    payer: s.payer,
    expiresAt: s.expiresAt,
    usage: { periodStart: s.usage.periodStart, calls: s.usage.calls, limit: s.monthlyCalls, remaining: Math.max(0, s.monthlyCalls - s.usage.calls) },
    payments: s.payments,
    renew: `Create a new invoice with this API key in the Authorization header to extend by another period (paid in USDC to ${ctx.env.BILLING_DOMAIN}).`,
  };
}

export async function getInvoice(ctx: AppContext, id: string) {
  const inv = await ctx.billing.getInvoice(id);
  if (!inv) throw new AppError('INVOICE_NOT_FOUND', 'Invoice not found');
  return inv;
}

/** Verify the payment on-chain and activate/extend the subscription. Idempotent and safe under concurrency. */
export async function confirmInvoice(ctx: AppContext, input: { invoiceId: string; txHash: Hash }) {
  requireBilling(ctx);
  const inv = await getInvoice(ctx, input.invoiceId);

  if (inv.status === 'paid') {
    if (inv.txHash !== input.txHash) throw new AppError('PAYMENT_ALREADY_USED', 'This invoice is already paid by a different transaction');
    return paidResult(ctx, inv);
  }

  const usedBy = await ctx.billing.txOwner(input.txHash);
  if (usedBy && usedBy !== inv.id) throw new AppError('PAYMENT_ALREADY_USED', 'This transaction was already used to pay another invoice');

  const net = NETWORKS[inv.network];
  const gw = ctx.gateways[inv.network];
  if (!gw) throw new AppError('NETWORK_NOT_CONFIGURED', `${net.name} RPC is not configured on this server`);
  if ((await gw.getChainId()) !== net.chainId) throw new AppError('CHAIN_ID_MISMATCH', `${net.name} RPC chain ID mismatch`);

  const base = { invoiceId: inv.id, txHash: input.txHash, explorerUrl: net.explorerTxUrl + input.txHash };
  const receipt = await gw.getReceipt(input.txHash);
  if (!receipt) {
    const tx = await gw.getTransaction(input.txHash);
    // An unconfirmed payment may still land after expiry; we keep accepting it if the tx was sent.
    if (!tx && Date.parse(inv.expiresAt) <= ctx.now()) throw new AppError('INVOICE_EXPIRED', 'Invoice expired and no payment was found; create a new invoice');
    return { ...base, status: tx ? 'pending' : 'not_found', paid: false, message: tx ? 'Payment broadcast; waiting to be included in a block.' : 'Transaction not found on this network yet.' };
  }
  const fail = async (msg: string): Promise<never> => {
    await ctx.audit.write('payment_rejected', { invoiceId: inv.id, txHash: input.txHash, reason: msg });
    throw new AppError('PAYMENT_INVALID', msg);
  };
  if (receipt.status !== 'success') await fail('Payment transaction reverted; no USDC was transferred');
  if (!receipt.to || getAddress(receipt.to) !== inv.tokenContract) await fail('Transaction did not call the official USDC contract');
  if (receipt.blockNumber < BigInt(inv.startBlock)) await fail('Transaction predates this invoice');

  let paid = 0n;
  for (const l of receipt.logs) {
    if (getAddress(l.address) !== inv.tokenContract) continue;
    try {
      const ev = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics as [`0x${string}`, ...`0x${string}`[]] });
      if (ev.eventName !== 'Transfer') continue;
      const a = ev.args as { from: Address; to: Address; value: bigint };
      if (getAddress(a.from) === inv.payer && getAddress(a.to) === inv.treasury) paid += a.value;
    } catch {
      /* not a Transfer */
    }
  }
  if (paid === 0n) await fail(`No USDC transfer from ${inv.payer} to ${inv.treasuryDomain} (${inv.treasury}) in this transaction`);
  if (paid < BigInt(inv.amountRaw)) await fail(`Underpaid: received ${formatUnitsExact(paid, 6)} USDC, invoice is ${inv.amount} USDC`);

  // Reserve the hash for this invoice (unique in the database). Another invoice cannot reuse it.
  const owner = await ctx.billing.claimTx(input.txHash, inv.id);
  if (owner !== inv.id) throw new AppError('PAYMENT_ALREADY_USED', 'This transaction was already used to pay another invoice');

  const latest = await gw.getBlockNumber();
  const confirmations = latest >= receipt.blockNumber ? Number(latest - receipt.blockNumber + 1n) : 0;
  if (confirmations < net.requiredConfirmations) {
    return { ...base, status: 'awaiting_confirmations', paid: false, confirmations, requiredConfirmations: net.requiredConfirmations, message: 'Payment found; waiting for confirmations. Call again shortly.' };
  }

  // ---- Activate or extend (atomic with marking the invoice paid) ----
  const plan = getPlan(ctx, inv.planId);
  const now = ctx.now();
  const nowIso = new Date(now).toISOString();
  const payment: Payment = { invoiceId: inv.id, txHash: input.txHash, network: inv.network, amount: formatUnitsExact(paid, 6), paidAt: nowIso };
  const existing = inv.renewSubscriptionId ? await ctx.billing.getSubscription(inv.renewSubscriptionId) : undefined;
  let won: boolean;
  let subscriptionId: string;
  if (existing && !existing.revoked) {
    subscriptionId = existing.id;
    won = await ctx.billing.completePayment({
      invoiceId: inv.id,
      invoicePatch: { txHash: input.txHash, paidAt: nowIso, subscriptionId },
      extend: { subscriptionId, planId: plan.id, monthlyCalls: plan.monthlyCalls, periodMs: plan.periodDays * DAY_MS, nowIso, payment },
    });
  } else {
    const apiKey = `tzk_${randomBytes(32).toString('hex')}`;
    subscriptionId = newId('sub');
    const sub: Subscription = {
      id: subscriptionId,
      keyHash: hashKey(apiKey),
      keyPrefix: apiKey.slice(0, 12),
      planId: plan.id,
      payer: inv.payer,
      createdAt: nowIso,
      expiresAt: new Date(now + plan.periodDays * DAY_MS).toISOString(),
      monthlyCalls: plan.monthlyCalls,
      usage: { periodStart: nowIso, calls: 0 },
      payments: [payment],
    };
    won = await ctx.billing.completePayment({
      invoiceId: inv.id,
      invoicePatch: {
        txHash: input.txHash,
        paidAt: nowIso,
        subscriptionId,
        pendingKey: { ...seal(ctx, apiKey), until: new Date(now + KEY_PICKUP_WINDOW_MS).toISOString() },
      },
      create: sub,
    });
  }
  const fresh = (await ctx.billing.getInvoice(inv.id))!;
  if (won) {
    await ctx.audit.write('subscription_paid', {
      invoiceId: inv.id,
      subscriptionId,
      plan: plan.id,
      txHash: input.txHash,
      network: inv.network,
      amount: payment.amount,
      renewal: Boolean(existing && !existing.revoked),
    });
  }
  // If a concurrent request activated it first, return that result instead.
  return { ...(await paidResult(ctx, fresh)), confirmations };
}

async function paidResult(ctx: AppContext, inv: Invoice) {
  const sub = await ctx.billing.getSubscription(inv.subscriptionId!);
  if (!sub) throw new AppError('INTERNAL', 'Paid invoice has no subscription');
  let apiKey: string | null = null;
  if (inv.pendingKey) {
    if (Date.parse(inv.pendingKey.until) > ctx.now()) apiKey = unseal(ctx, inv.pendingKey);
    else await ctx.billing.updateInvoice(inv.id, { pendingKey: undefined });
  }
  return {
    invoiceId: inv.id,
    txHash: inv.txHash,
    status: 'paid',
    paid: true,
    apiKey,
    apiKeyNote: apiKey
      ? 'Store this API key now. It can be re-shown from this invoice for 24 hours, then only its hash is kept.'
      : inv.renewSubscriptionId
        ? 'Renewal applied to your existing API key.'
        : 'Key pickup window has closed.',
    subscription: subscriptionView(ctx, sub),
  };
}

/** Authenticate a subscriber key. Returns the subscription or throws. */
export async function authenticateSubscriber(ctx: AppContext, key: string): Promise<Subscription | undefined> {
  const sub = await ctx.billing.findSubscriptionByKeyHash(hashKey(key));
  if (!sub) return undefined;
  if (sub.revoked) throw new AppError('UNAUTHORIZED', 'API key revoked');
  if (Date.parse(sub.expiresAt) <= ctx.now()) {
    throw new AppError('SUBSCRIPTION_EXPIRED', `Subscription expired on ${sub.expiresAt}. Renew by paying USDC to ${ctx.env.BILLING_DOMAIN}.`);
  }
  return sub;
}

/** Count one billable call atomically; throws when the period quota is used up. */
export async function meterCall(ctx: AppContext, subId: string) {
  const r = await ctx.billing.meter(subId, ctx.now(), 30 * DAY_MS);
  if (r === 'quota') {
    const sub = await ctx.billing.getSubscription(subId);
    throw new AppError('QUOTA_EXCEEDED', `Plan limit of ${sub?.monthlyCalls ?? ''} calls reached for this period. Upgrade by paying USDC to ${ctx.env.BILLING_DOMAIN}.`);
  }
  if (r === 'missing') throw new AppError('UNAUTHORIZED', 'Subscription not found');
}

export async function mySubscription(ctx: AppContext, subId?: string) {
  if (!subId) return { status: 'operator', note: 'Authenticated with an operator key (no subscription limits).' };
  const sub = await ctx.billing.getSubscription(subId);
  if (!sub) throw new AppError('UNAUTHORIZED', 'Subscription not found');
  return subscriptionView(ctx, sub);
}
