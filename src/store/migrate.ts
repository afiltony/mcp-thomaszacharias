import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

/** Applies supabase/migrations/*.sql in name order, once each, tracked in schema_migrations. */
export function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, '..', '..', 'supabase', 'migrations'), join(process.cwd(), 'supabase', 'migrations')]) if (existsSync(p)) return p;
  throw new Error('supabase/migrations directory not found');
}

export async function migrate(db: Db, dir = migrationsDir()): Promise<string[]> {
  await db.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  await db.query(`alter table schema_migrations enable row level security`);
  const done = new Set((await db.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    await db.transaction(async (q) => {
      await q.query(sql);
      await q.query('insert into schema_migrations (name) values ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}

// CLI: DATABASE_URL=... node dist/store/migrate.js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { connectPostgres } = await import('./db.js');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  // Use the DIRECT or session-mode URL for migrations if your pooler rejects multi-statement SQL.
  const db = connectPostgres(process.env.MIGRATION_DATABASE_URL || url, { max: 1, caCert: process.env.DATABASE_CA_CERT });
  try {
    const applied = await migrate(db);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
  } catch (err) {
    console.error('Migration failed:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
