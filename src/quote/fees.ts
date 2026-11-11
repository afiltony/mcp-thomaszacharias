import type { FeeData } from '../evm/gateway.js';
import { mulBps } from '../lib/decimal.js';

export interface FeeComputation {
  gasUnits: bigint;
  gasLimit: bigint;
  /** base fee + priority tip: what the tx is expected to pay per gas at current conditions */
  expectedGasPrice: bigint;
  /** wallet cap per gas (maxFeePerGas); actual cost can never exceed gasLimit * this (+ L1 fee bound) */
  maxFeePerGas: bigint;
  l1FeeExpected: bigint;
  l1FeeMax: bigint;
  expectedFeeWei: bigint;
  maxFeeWei: bigint;
  safetyMarginWei: bigint;
}

/**
 * EVM fee model:
 *   expected = gasUnits × (baseFee + priorityFee) + L1 data fee (OP-stack only)
 *   max      = gasLimit × maxFeePerGas + L1 fee × buffer
 * The difference (max − expected) is the safety margin, reported separately — it is
 * a bound the wallet may reserve, not a cost the user is expected to pay.
 */
export function computeFees(input: {
  gasUnits: bigint;
  fee: FeeData;
  l1FeeWei: bigint;
  gasLimitBufferBps: number;
  l1FeeBufferBps: number;
}): FeeComputation {
  const { gasUnits, fee } = input;
  const expectedGasPrice = fee.baseFeePerGas + fee.maxPriorityFeePerGas;
  const maxFeePerGas = fee.maxFeePerGas > expectedGasPrice ? fee.maxFeePerGas : expectedGasPrice;
  const gasLimit = mulBps(gasUnits, input.gasLimitBufferBps);
  const l1FeeMax = mulBps(input.l1FeeWei, input.l1FeeBufferBps);
  const expectedFeeWei = gasUnits * expectedGasPrice + input.l1FeeWei;
  const maxFeeWei = gasLimit * maxFeePerGas + l1FeeMax;
  return {
    gasUnits,
    gasLimit,
    expectedGasPrice,
    maxFeePerGas,
    l1FeeExpected: input.l1FeeWei,
    l1FeeMax,
    expectedFeeWei,
    maxFeeWei,
    safetyMarginWei: maxFeeWei - expectedFeeWei,
  };
}
