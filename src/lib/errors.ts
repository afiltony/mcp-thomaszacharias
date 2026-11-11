/**
 * Every failure in this service is explicit and machine-readable.
 * `code` is stable for clients; `message` is safe to show to end users.
 */
export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN_ORIGIN'
  | 'RATE_LIMITED'
  | 'DOMAIN_INVALID'
  | 'DOMAIN_NOT_FOUND'
  | 'RESOLVER_UNAVAILABLE'
  | 'RECIPIENT_RECORD_MISSING'
  | 'RECIPIENT_INVALID'
  | 'RECIPIENT_CHANGED'
  | 'RECIPIENT_BLOCKED'
  | 'NETWORK_UNSUPPORTED'
  | 'NETWORK_NOT_CONFIGURED'
  | 'CHAIN_ID_MISMATCH'
  | 'TOKEN_CONTRACT_MISMATCH'
  | 'RPC_UNAVAILABLE'
  | 'PRICE_UNAVAILABLE'
  | 'PRICE_STALE'
  | 'INSUFFICIENT_TOKEN_BALANCE'
  | 'INSUFFICIENT_GAS_BALANCE'
  | 'SIMULATION_FAILED'
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_EXPIRED'
  | 'ROUTE_NOT_ELIGIBLE'
  | 'PREPARATION_NOT_FOUND'
  | 'PREPARATION_EXPIRED'
  | 'TX_NOT_FOUND'
  | 'TX_MISMATCH'
  | 'BILLING_DISABLED'
  | 'PLAN_NOT_FOUND'
  | 'INVOICE_NOT_FOUND'
  | 'INVOICE_EXPIRED'
  | 'TREASURY_UNAVAILABLE'
  | 'TREASURY_MISMATCH'
  | 'PAYMENT_INVALID'
  | 'PAYMENT_ALREADY_USED'
  | 'SUBSCRIPTION_EXPIRED'
  | 'QUOTA_EXCEEDED'
  | 'INTERNAL';

const STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_REQUEST: 400,
  DOMAIN_INVALID: 400,
  RECIPIENT_INVALID: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN_ORIGIN: 403,
  RATE_LIMITED: 429,
  DOMAIN_NOT_FOUND: 404,
  QUOTE_NOT_FOUND: 404,
  PREPARATION_NOT_FOUND: 404,
  TX_NOT_FOUND: 404,
  QUOTE_EXPIRED: 410,
  PREPARATION_EXPIRED: 410,
  RESOLVER_UNAVAILABLE: 503,
  RPC_UNAVAILABLE: 503,
  PRICE_UNAVAILABLE: 503,
  NETWORK_NOT_CONFIGURED: 503,
  INTERNAL: 500,
  BILLING_DISABLED: 503,
  PLAN_NOT_FOUND: 404,
  INVOICE_NOT_FOUND: 404,
  INVOICE_EXPIRED: 410,
  TREASURY_UNAVAILABLE: 503,
  TREASURY_MISMATCH: 503,
  PAYMENT_ALREADY_USED: 409,
  SUBSCRIPTION_EXPIRED: 402,
  QUOTA_EXCEEDED: 429,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code] ?? 422;
    this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError('INTERNAL', 'Unexpected internal error');
}
