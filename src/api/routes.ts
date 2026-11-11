import { Router, type Request, type Response, type NextFunction } from 'express';
import type { AppContext } from '../context.js';
import { ops } from '../services.js';
import { TxHashSchema } from '../schemas/requests.js';
import { AppError } from '../lib/errors.js';
import { subscriptionForRenewal } from '../security/auth.js';

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .then((body) => {
      if (!res.headersSent) res.json(body);
    })
    .catch(next);
};

/**
 * Public billing endpoints: plans, invoices and payment confirmation.
 * Payment is crypto only — USDC sent from the customer's wallet to BILLING_DOMAIN.
 */
export function billingRouter(ctx: AppContext): Router {
  const r = Router();
  r.get('/plans', h(() => ops.plans(ctx)));
  // Optional Authorization header with an existing subscriber key => renewal of that subscription.
  r.post('/invoices', h(async (req) => ops.createInvoice(ctx, req.body, await subscriptionForRenewal(ctx, req))));
  r.get('/invoices/:id', h((req) => ops.getInvoice(ctx, String(req.params.id))));
  r.post('/invoices/:id/confirm', h((req) => ops.confirmPayment(ctx, { invoiceId: String(req.params.id), txHash: req.body?.txHash })));
  return r;
}

/** Authenticated REST API (same business logic as the MCP tools). */
export function apiRouter(ctx: AppContext): Router {
  const r = Router();
  r.get('/subscription', h((req) => ops.mySubscription(ctx, req.subscriptionId)));
  r.post('/resolve', h((req) => ops.resolveDomain(ctx, req.body)));
  r.get('/networks', h(() => ops.supportedNetworks(ctx)));
  r.post('/fees/estimate', h((req) => ops.estimateFee(ctx, req.body)));
  r.post('/quotes', h((req) => ops.compare(ctx, req.body)));
  r.post('/transfers/prepare', h((req) => ops.prepare(ctx, req.body)));
  r.post('/transfers/verify', h((req) => ops.verify(ctx, req.body)));
  r.get('/transfers/:id', h((req) => ops.getById(ctx, String(req.params.id))));
  return r;
}

/**
 * Unauthenticated endpoints used by the wallet approval page. Access requires the
 * unguessable preparation id (128-bit random). They expose only what the signer must
 * see, perform read-only checks, and never sign or broadcast.
 */
export function publicApprovalRouter(ctx: AppContext): Router {
  const r = Router();
  r.get(
    '/:id',
    h((req) => {
      const id = String(req.params.id);
      if (!id.startsWith('p_')) throw new AppError('PREPARATION_NOT_FOUND', 'Prepared transfer not found');
      return ops.getById(ctx, id);
    }),
  );
  r.post('/:id/recheck', h((req) => ops.recheck(ctx, String(req.params.id))));
  r.post(
    '/:id/verify',
    h((req) => {
      const tx = TxHashSchema.safeParse(req.body?.txHash);
      if (!tx.success) throw new AppError('INVALID_REQUEST', 'Invalid transaction hash');
      return ops.verify(ctx, { txHash: tx.data, preparationId: String(req.params.id) });
    }),
  );
  return r;
}
