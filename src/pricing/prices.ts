import { AppError } from '../lib/errors.js';
import { priceToFixed8 } from '../lib/decimal.js';
import { log } from '../lib/logger.js';

export interface PriceQuote {
  id: string;
  usd8: bigint; // USD price in 1e8 fixed point
  usd: string;
  /** When the provider says the price was last updated. */
  asOf: string;
  fetchedAt: string;
  source: string;
}

export interface PriceSource {
  getUsdPrice(id: string): Promise<PriceQuote>;
}

/** CoinGecko-compatible `/simple/price` source. Never returns a fabricated price. */
export class CoinGeckoPriceSource implements PriceSource {
  private cache = new Map<string, { at: number; value: PriceQuote }>();

  constructor(
    private readonly opts: { baseUrl: string; apiKey?: string; apiKeyHeader: string; cacheSeconds: number; timeoutMs?: number; fetchImpl?: typeof fetch },
  ) {}

  async getUsdPrice(id: string): Promise<PriceQuote> {
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < this.opts.cacheSeconds * 1000) return hit.value;

    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_last_updated_at=true`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.opts.apiKey) headers[this.opts.apiKeyHeader] = this.opts.apiKey;
    let body: Record<string, { usd?: number; last_updated_at?: number }>;
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(url, { headers, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 6000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = (await res.json()) as typeof body;
    } catch (err) {
      log.warn('price_fetch_failed', { id, err: String(err) });
      throw new AppError('PRICE_UNAVAILABLE', `Native-coin price for ${id} is unavailable; cannot convert fees to USD`);
    }
    const entry = body[id];
    if (!entry?.usd || !entry.last_updated_at) throw new AppError('PRICE_UNAVAILABLE', `Price source returned no USD price for ${id}`);
    const usd8 = priceToFixed8(entry.usd);
    const value: PriceQuote = {
      id,
      usd8,
      usd: entry.usd.toString(),
      asOf: new Date(entry.last_updated_at * 1000).toISOString(),
      fetchedAt: new Date().toISOString(),
      source: 'coingecko',
    };
    this.cache.set(id, { at: Date.now(), value });
    return value;
  }
}

export function priceAgeSeconds(p: PriceQuote, now = Date.now()): number {
  return Math.max(0, Math.round((now - Date.parse(p.asOf)) / 1000));
}
