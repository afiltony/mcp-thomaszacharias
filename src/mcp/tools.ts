import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NETWORK_IDS } from '../config/networks.js';
import type { AppContext } from '../context.js';
import { toAppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { ops } from '../services.js';

/**
 * MCP tool layer. Input shapes here are deliberately plain (strings/enums) so they
 * convert cleanly to JSON Schema; the shared `ops` re-validate with the strict schemas.
 */
const network = z.enum(NETWORK_IDS);
const amount = z.string().describe('USDC amount as a decimal string, e.g. "25" or "25.50" (max 6 decimals)');
const domain = z.string().describe('Web3 domain, e.g. thomaszacharias.nft');
const address = z.string().describe('EVM address 0x…');

function json(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }],
  };
}

async function run(tool: string, principal: string | undefined, fn: () => unknown | Promise<unknown>) {
  try {
    return json(await fn());
  } catch (err) {
    const e = toAppError(err);
    if (e.code === 'INTERNAL') log.error('mcp_tool_error', { tool, principal, err: String(err), stack: (err as Error)?.stack });
    return { ...json(e.toJSON()), isError: true };
  }
}

/** Tools that never count against a subscriber's quota. */
export const FREE_TOOLS = new Set(['get_subscription_plans', 'get_my_subscription', 'create_subscription_invoice', 'confirm_subscription_payment', 'get_supported_networks']);

export function createMcpServer(ctx: AppContext, principal?: string, subscriptionId?: string): McpServer {
  const server = new McpServer(
    { name: 'thomaszacharias-mcp', version: '0.2.0' },
    {
      instructions:
        'Cross-chain USDC payment route engine for Web3 domains (Unstoppable Domains). ' +
        'Typical flow: compare_payment_routes (with the sender address if known) → show the user the recommended route, recipient address, network, amount and fees → ' +
        'only after the user picks a network, call prepare_transfer → give the user the approvalUrl or unsignedTransaction to sign in THEIR OWN wallet → verify_transfer with the tx hash. ' +
        'This server never signs, never broadcasts, never bridges or swaps, and never needs a private key or seed phrase — never ask the user for one. ' +
        'Never report a payment as successful unless verify_transfer returns status "confirmed".',
    },
  );

  server.registerTool(
    'resolve_web3_domain',
    {
      title: 'Resolve Web3 domain',
      description: 'Resolve an Unstoppable Domains name to its USDC receiving address on each supported EVM network, with the exact record key used and any warnings.',
      inputSchema: { domain },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run('resolve_web3_domain', principal, () => ops.resolveDomain(ctx, args)),
  );

  server.registerTool(
    'get_supported_networks',
    {
      title: 'Supported networks',
      description: 'List the allowlisted networks, official native USDC contracts, gas tokens, fee models and whether each network is configured on this server.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => run('get_supported_networks', principal, () => ops.supportedNetworks(ctx)),
  );

  server.registerTool(
    'estimate_transfer_fee',
    {
      title: 'Estimate USDC transfer fee',
      description:
        'Estimate the network fee for sending USDC to a domain on ONE network. With a sender address the gas estimate is live for that exact transfer; without one it is indicative.',
      inputSchema: { domain, amount, network, sender: address.optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run('estimate_transfer_fee', principal, () => ops.estimateFee(ctx, { ...args, token: 'USDC' })),
  );

  server.registerTool(
    'compare_payment_routes',
    {
      title: 'Compare USDC payment routes',
      description:
        'Rank direct USDC transfer routes to a domain across Ethereum, Base and Polygon PoS by expected total cost in USD. ' +
        'Routes where the recipient has no USDC record, the sender lacks USDC or gas, or data is stale are returned as ineligible with reasons. Returns a quoteId used by prepare_transfer.',
      inputSchema: {
        domain,
        amount,
        sender: address.optional().describe('Sender wallet address — strongly recommended for live gas and balance checks'),
        networks: z.array(network).optional().describe('Subset of networks to compare (default: all)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run('compare_payment_routes', principal, () => ops.compare(ctx, { ...args, token: 'USDC' })),
  );

  server.registerTool(
    'prepare_transfer',
    {
      title: 'Prepare unsigned USDC transfer',
      description:
        'Build an UNSIGNED ERC-20 USDC transfer for a network the user explicitly chose from a quote. Re-validates the domain record, chain, token contract, balances, gas and price, ' +
        'and simulates the transfer. Returns the unsigned transaction, a human-readable approval summary and an approvalUrl where the user signs in their own wallet. Does not sign or broadcast.',
      inputSchema: { quoteId: z.string(), sender: address, network: network.describe('Network the user explicitly selected') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => run('prepare_transfer', principal, () => ops.prepare(ctx, args)),
  );

  server.registerTool(
    'verify_transfer',
    {
      title: 'Verify transfer',
      description:
        'Check a submitted transaction on-chain: receipt status, that it called the official USDC contract, that the Transfer matches the prepared sender/recipient/amount, and confirmations. ' +
        'Only status "confirmed" means success.',
      inputSchema: {
        txHash: z.string().describe('Transaction hash 0x…'),
        network: network.optional(),
        preparationId: z.string().optional().describe('preparationId from prepare_transfer, to match sender/recipient/amount'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run('verify_transfer', principal, () => ops.verify(ctx, args)),
  );

  server.registerTool(
    'get_transfer',
    {
      title: 'Get quote or prepared transfer',
      description: 'Retrieve a saved quote (q_…) or prepared transfer (p_…) by id, including its expiry and status.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => run('get_transfer', principal, () => ops.getById(ctx, args.id)),
  );

  // ---- Subscription billing: crypto only, USDC paid to the billing domain's wallets ----
  server.registerTool(
    'get_subscription_plans',
    {
      title: 'Subscription plans',
      description: `List subscription plans for this MCP. Payment is crypto only: USDC sent from the customer's own wallet to ${ctx.env.BILLING_DOMAIN}.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => run('get_subscription_plans', principal, () => ops.plans(ctx)),
  );

  server.registerTool(
    'get_my_subscription',
    {
      title: 'My subscription',
      description: 'Show the caller\'s plan, expiry date and remaining calls for this period.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => run('get_my_subscription', principal, () => ops.mySubscription(ctx, subscriptionId)),
  );

  server.registerTool(
    'create_subscription_invoice',
    {
      title: 'Create subscription invoice',
      description:
        `Create a USDC invoice payable to ${ctx.env.BILLING_DOMAIN} for a plan. When called with a subscriber key it RENEWS that subscription. ` +
        'Returns the resolved receiving wallet, exact amount, an unsigned transfer and a paymentUrl. The user pays from their own wallet; this server never signs.',
      inputSchema: {
        plan: z.string().describe('Plan id from get_subscription_plans'),
        network,
        payer: address.describe('Wallet that will send the USDC'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => run('create_subscription_invoice', principal, () => ops.createInvoice(ctx, args, subscriptionId)),
  );

  server.registerTool(
    'confirm_subscription_payment',
    {
      title: 'Confirm subscription payment',
      description: 'Verify the USDC payment for an invoice on-chain (correct contract, payer, receiving wallet, amount, confirmations) and activate or extend the subscription.',
      inputSchema: { invoiceId: z.string(), txHash: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => run('confirm_subscription_payment', principal, () => ops.confirmPayment(ctx, args)),
  );

  return server;
}
