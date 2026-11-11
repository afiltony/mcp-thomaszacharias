import { decodeEventLog, erc20Abi, getAddress, type Address, type Hash } from 'viem';
import { NETWORKS, type NetworkId } from '../config/networks.js';
import { USDC } from '../config/tokens.js';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { formatUnitsExact } from '../lib/decimal.js';
import { verifyBinding } from './prepare.js';

export type VerifyStatus = 'not_found' | 'pending' | 'failed' | 'mismatch' | 'awaiting_confirmations' | 'confirmed';

export async function verifyTransfer(ctx: AppContext, input: { txHash: Hash; network?: NetworkId; preparationId?: string }) {
  const prep = input.preparationId ? await ctx.preparations.get(input.preparationId) : undefined;
  if (input.preparationId && !prep) throw new AppError('PREPARATION_NOT_FOUND', 'Prepared transfer not found');
  if (prep && !verifyBinding(ctx, prep)) throw new AppError('TX_MISMATCH', 'Prepared transfer failed its integrity check');
  const network = input.network ?? prep?.network;
  if (!network) throw new AppError('INVALID_REQUEST', 'network or preparationId is required');
  if (prep && prep.network !== network) throw new AppError('TX_MISMATCH', 'Network does not match the prepared transfer');

  const net = NETWORKS[network];
  const token = USDC[network];
  const gw = ctx.gateways[network];
  if (!gw) throw new AppError('NETWORK_NOT_CONFIGURED', `${net.name} RPC is not configured`);
  const chainId = await gw.getChainId();
  if (chainId !== net.chainId) throw new AppError('CHAIN_ID_MISMATCH', `${net.name} RPC reports chain ID ${chainId}`);

  const base = { txHash: input.txHash, network, chainId: net.chainId, explorerUrl: net.explorerTxUrl + input.txHash, requiredConfirmations: net.requiredConfirmations };
  const done = async (status: VerifyStatus, extra: Record<string, unknown> = {}) => {
    const out = { ...base, status, success: status === 'confirmed', checkedAt: new Date(ctx.now()).toISOString(), ...extra };
    await ctx.audit.write('transfer_verified', { txHash: input.txHash, network, preparationId: input.preparationId, status });
    return out;
  };

  const receipt = await gw.getReceipt(input.txHash);
  if (!receipt) {
    const tx = await gw.getTransaction(input.txHash);
    return done(tx ? 'pending' : 'not_found', {
      message: tx ? 'Transaction is broadcast but not yet included in a block.' : 'Transaction not found on this network (yet). Check the network and hash.',
    });
  }

  if (receipt.status !== 'success') return done('failed', { message: 'Transaction was included but reverted. No USDC was transferred.', blockNumber: receipt.blockNumber.toString() });

  if (!receipt.to || getAddress(receipt.to) !== token.address) {
    return done('mismatch', { message: `Transaction did not call the official USDC contract ${token.address}.` });
  }

  // Find the USDC Transfer event emitted by the official contract
  const transfers: { from: Address; to: Address; value: bigint }[] = [];
  for (const l of receipt.logs) {
    if (getAddress(l.address) !== token.address) continue;
    try {
      const ev = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics as [`0x${string}`, ...`0x${string}`[]] });
      if (ev.eventName === 'Transfer') transfers.push(ev.args as { from: Address; to: Address; value: bigint });
    } catch {
      /* not a Transfer */
    }
  }
  if (transfers.length === 0) return done('mismatch', { message: 'No USDC Transfer event found in the receipt.' });

  if (prep) {
    const match = transfers.find(
      (t) => getAddress(t.from) === getAddress(prep.from) && getAddress(t.to) === prep.recipient && t.value === BigInt(prep.amountRaw),
    );
    if (!match) {
      return done('mismatch', {
        message: 'The on-chain USDC transfer does not match the prepared sender, recipient and amount.',
        observed: transfers.map((t) => ({ from: t.from, to: t.to, amount: formatUnitsExact(t.value, token.decimals) })),
      });
    }
    await ctx.preparations.update(prep.preparationId, { submittedTxHash: input.txHash });
  }

  const latest = await gw.getBlockNumber();
  const confirmations = latest >= receipt.blockNumber ? Number(latest - receipt.blockNumber + 1n) : 0;
  const actualFeeWei = receipt.gasUsed * receipt.effectiveGasPrice + (receipt.l1Fee ?? 0n);
  const t = transfers[0]!;
  const details = {
    blockNumber: receipt.blockNumber.toString(),
    confirmations,
    transfer: { from: t.from, to: t.to, amount: formatUnitsExact(t.value, token.decimals), token: 'USDC', tokenContract: token.address },
    actualFee: { native: formatUnitsExact(actualFeeWei, 18), nativeSymbol: net.nativeSymbol, gasUsed: receipt.gasUsed.toString() },
  };
  if (confirmations < net.requiredConfirmations) {
    return done('awaiting_confirmations', { ...details, message: `Included in a block with ${confirmations}/${net.requiredConfirmations} confirmations. Not final yet.` });
  }
  return done('confirmed', { ...details, message: `Confirmed with ${confirmations} confirmations.` });
}
