import pg from 'pg';

/** Minimal query interface satisfied by node-postgres and by PGlite (used in tests). */
export interface Sql {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}
export interface Db extends Sql {
  transaction<T>(fn: (q: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Supabase connection. Use the Supavisor pooler URL (transaction mode, port 6543) on
 * Cloud Run: instances scale to zero and back, so short-lived pooled connections fit best.
 * node-postgres uses unnamed statements, which transaction-mode pooling supports.
 */
export function connectPostgres(url: string, opts: { max?: number; ssl?: boolean; caCert?: string } = {}): Db {
  // TLS is on by default (Supabase requires it). `?sslmode=disable` turns it off for local Postgres only.
  if (/[?&]sslmode=disable\b/.test(url)) opts = { ...opts, ssl: false };
  const pool = new pg.Pool({
    connectionString: url.replace(/[?&]sslmode=[^&]*/, ''),
    max: opts.max ?? 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    // With Supabase's CA certificate (Database settings → SSL) the server certificate is verified.
    ssl: opts.ssl === false ? false : opts.caCert ? { ca: opts.caCert, rejectUnauthorized: true } : { rejectUnauthorized: false },
    application_name: 'thomaszacharias-mcp',
  });
  pool.on('error', () => undefined); // idle-client errors are surfaced on the next query
  return {
    query: (text, params) => pool.query(text, params as unknown[]) as never,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn({ query: (t, p) => client.query(t, p as unknown[]) as never });
        await client.query('commit');
        return out;
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
