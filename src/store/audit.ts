import { log, redact } from '../lib/logger.js';
import type { Sql } from './db.js';
import { toJson } from './types.js';

/** Append-only audit trail. Never contains secrets (fields are redacted). */
export interface AuditLog {
  write(event: string, fields: Record<string, unknown>): Promise<void>;
}

/** Writes to the Supabase `audit_log` table. A failed write is logged, never fatal. */
export class PostgresAuditLog implements AuditLog {
  constructor(private readonly db: Sql) {}
  async write(event: string, fields: Record<string, unknown>) {
    try {
      await this.db.query('insert into audit_log (event, fields) values ($1, $2::jsonb)', [event, toJson(redact(fields))]);
    } catch (err) {
      log.error('audit_write_failed', { event, err: String(err) });
    }
    log.info('audit', { event });
  }
}

export class MemoryAuditLog implements AuditLog {
  events: { event: string; fields: Record<string, unknown> }[] = [];
  async write(event: string, fields: Record<string, unknown>) {
    this.events.push({ event, fields });
  }
}
