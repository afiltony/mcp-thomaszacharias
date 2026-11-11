import { z } from 'zod';

/**
 * Subscription plans. Prices are in USDC (decimal strings) and are paid only in crypto
 * to the billing domain's wallets. Override with the BILLING_PLANS env var (JSON array).
 * The defaults below are placeholders — set your own prices before launch.
 */
const PlanSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,32}$/),
  name: z.string().min(1).max(60),
  priceUsdc: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/),
  periodDays: z.number().int().min(1).max(366),
  /** Billable calls per period (MCP tools/call + REST /api requests). */
  monthlyCalls: z.number().int().positive(),
  description: z.string().max(200).default(''),
});
export type Plan = z.infer<typeof PlanSchema>;

export const DEFAULT_PLANS: Plan[] = [
  { id: 'starter', name: 'Starter', priceUsdc: '10', periodDays: 30, monthlyCalls: 1_000, description: 'Domain resolution and route comparison for individuals' },
  { id: 'pro', name: 'Pro', priceUsdc: '49', periodDays: 30, monthlyCalls: 10_000, description: 'For wallets, apps and AI agents' },
  { id: 'business', name: 'Business', priceUsdc: '199', periodDays: 30, monthlyCalls: 100_000, description: 'High-volume integrations' },
];

export function loadPlans(json?: string): Plan[] {
  if (!json) return DEFAULT_PLANS;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('BILLING_PLANS is not valid JSON');
  }
  const parsed = z.array(PlanSchema).min(1).safeParse(raw);
  if (!parsed.success) throw new Error(`BILLING_PLANS invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const ids = new Set(parsed.data.map((p) => p.id));
  if (ids.size !== parsed.data.length) throw new Error('BILLING_PLANS has duplicate ids');
  return parsed.data;
}
