-- thomaszacharias-mcp schema for Supabase Postgres.
-- All server state lives here; the Cloud Run service stores no files.
-- Row Level Security is enabled with NO policies, so Supabase's public REST/GraphQL
-- APIs (anon / authenticated keys) cannot read or write these tables. The server
-- connects with the database password over the pooler and is the only reader/writer.

create table if not exists kv_records (
  id          text primary key,
  kind        text not null check (kind in ('quote', 'preparation')),
  data        jsonb not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists kv_records_expires_idx on kv_records (expires_at);

create table if not exists invoices (
  id          text primary key,
  status      text not null check (status in ('awaiting_payment', 'paid', 'expired')),
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists subscriptions (
  id             text primary key,
  key_hash       text not null unique,
  key_prefix     text not null,
  plan_id        text not null,
  payer          text not null,
  created_at     timestamptz not null,
  expires_at     timestamptz not null,
  monthly_calls  integer not null check (monthly_calls > 0),
  period_start   timestamptz not null,
  calls          integer not null default 0 check (calls >= 0),
  revoked        boolean not null default false,
  payments       jsonb not null default '[]'::jsonb
);
create index if not exists subscriptions_payer_idx on subscriptions (lower(payer));

-- A transaction hash can pay exactly one invoice, ever.
create table if not exists used_tx_hashes (
  tx_hash     text primary key,
  invoice_id  text not null references invoices (id),
  created_at  timestamptz not null default now()
);

create table if not exists rate_limits (
  key           text not null,
  window_start  timestamptz not null,
  count         integer not null default 0,
  primary key (key, window_start)
);
create index if not exists rate_limits_window_idx on rate_limits (window_start);

create table if not exists audit_log (
  id      bigint generated always as identity primary key,
  ts      timestamptz not null default now(),
  event   text not null,
  fields  jsonb not null default '{}'::jsonb
);
create index if not exists audit_log_ts_idx on audit_log (ts desc);
create index if not exists audit_log_event_idx on audit_log (event, ts desc);

-- Lock the tables away from Supabase's public API roles.
alter table kv_records      enable row level security;
alter table invoices        enable row level security;
alter table subscriptions   enable row level security;
alter table used_tx_hashes  enable row level security;
alter table rate_limits     enable row level security;
alter table audit_log       enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on kv_records, invoices, subscriptions, used_tx_hashes, rate_limits, audit_log from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on kv_records, invoices, subscriptions, used_tx_hashes, rate_limits, audit_log from authenticated;
  end if;
end $$;
