import { AppError } from './errors.js';

/**
 * Exact decimal-string <-> integer base-unit conversion.
 * Never uses floating point. Rejects (rather than rounds) excess precision.
 */
export function parseDecimalAmount(input: string, decimals: number): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new AppError('INVALID_REQUEST', 'Amount must be a positive decimal string such as "25" or "25.50"');
  }
  const [whole = '0', frac = ''] = s.split('.');
  if (frac.length > decimals) {
    throw new AppError('INVALID_REQUEST', `Amount has more than ${decimals} decimal places`);
  }
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (raw <= 0n) throw new AppError('INVALID_REQUEST', 'Amount must be greater than zero');
  return raw;
}

export function formatUnitsExact(raw: bigint, decimals: number, maxFractionDigits?: number): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0');
  if (maxFractionDigits !== undefined && frac.length > maxFractionDigits) {
    // round half-up for display only
    const cut = BigInt(frac.slice(0, maxFractionDigits) || '0');
    const next = Number(frac[maxFractionDigits] ?? '0');
    let rounded = cut + (next >= 5 ? 1n : 0n);
    let w = whole;
    if (maxFractionDigits === 0) return `${neg ? '-' : ''}${w + rounded}`;
    if (rounded >= 10n ** BigInt(maxFractionDigits)) {
      w += 1n;
      rounded = 0n;
    }
    frac = rounded.toString().padStart(maxFractionDigits, '0');
    return `${neg ? '-' : ''}${w}.${frac}`;
  }
  frac = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Fixed-point USD with 8 decimals. */
export const USD_DECIMALS = 8;

/** Convert a JS number price (from a price API) into 1e8 fixed point. */
export function priceToFixed8(price: number): bigint {
  if (!Number.isFinite(price) || price <= 0) throw new AppError('PRICE_UNAVAILABLE', 'Invalid price received from price source');
  return BigInt(Math.round(price * 1e8));
}

/** native wei (18 decimals) * price(1e8) => USD in 1e8 fixed point (rounded up so we never understate cost). */
export function weiToUsd8(wei: bigint, price8: bigint, nativeDecimals = 18): bigint {
  const num = wei * price8;
  const den = 10n ** BigInt(nativeDecimals);
  return (num + den - 1n) / den;
}

export function usd8ToString(usd8: bigint, digits = 4): string {
  return formatUnitsExact(usd8, USD_DECIMALS, digits);
}

/** Multiply by a basis-points factor, rounding up. 12000 bps = 1.2x */
export function mulBps(v: bigint, bps: number): bigint {
  const b = BigInt(bps);
  return (v * b + 9999n) / 10000n;
}
