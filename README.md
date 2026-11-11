# thomaszacharias-mcp

A remote MCP server that turns a request like **"Send 25 USDC to ThomasZacharias.nft — find the cheapest network and show me the total before I approve"** into a verified, ranked, *unsigned* USDC transfer that the user signs in their own wallet.

- **Asset:** USDC only (Circle-native contracts; bridged USDC.e / USDbC are rejected)
- **Networks:** Ethereum Mainnet, Base, Polygon PoS (EVM)
- **Capability:** resolve → compare → prepare unsigned tx → user approves in wallet → verify receipt
- **Never:** signs, broadcasts, bridges, swaps, holds keys, or asks for a seed phrase

## How it works

```
AI client (Claude) ──POST /mcp──▶ MCP tools ─┐
Your web app ───────POST /api/*──▶ REST     ─┼─▶ shared ops (validation, policy, audit)
                                             │      ├─ Unstoppable Domains Resolution API (records)
                                             │      ├─ viem → allowlisted RPCs (chain id, USDC contract, balances, gas, simulation, receipts)
                                             │      └─ CoinGecko-compatible price API (ETH, POL in USD, timestamped)
User's browser ─────/approve/:id ──▶ approval page → user's wallet (EIP-1193) signs & sends → /verify
```

### MCP tools

| Tool | What it does | Side effects |
|---|---|---|
| `resolve_web3_domain` | USDC receiving address per network, with the exact UD record key used and confidence warnings | read-only |
| `get_supported_networks` | Allowlisted networks, official USDC contracts, gas tokens, fee models, configured status | read-only |
| `estimate_transfer_fee` | Fee for one network (live with a sender, indicative without) | read-only |
| `compare_payment_routes` | Ranks direct routes by expected USD cost; returns `quoteId` | stores quote (TTL) |
| `prepare_transfer` | Re-validates everything, simulates, returns unsigned tx + approval summary + `approvalUrl` | stores preparation (TTL), **no signing** |
| `verify_transfer` | Receipt status, official contract, Transfer event matches sender/recipient/amount, confirmations | read-only |
| `get_transfer` | Fetch a quote (`q_…`) or preparation (`p_…`) | read-only |

### REST API (same logic; `Authorization: Bearer <API key>`)

| Method & path | Purpose |
|---|---|
| `GET /health` | Health (public, no secrets) |
| `POST /api/resolve` | `{ domain }` |
| `GET /api/networks` | Supported networks |
| `POST /api/fees/estimate` | `{ domain, amount, network, sender? }` |
| `POST /api/quotes` | `{ domain, amount, token?: "USDC", networks?, sender? }` |
| `POST /api/transfers/prepare` | `{ quoteId, sender, network }` |
| `POST /api/transfers/verify` | `{ txHash, network? , preparationId? }` |
| `GET /api/transfers/:id` | Quote or preparation |
| `GET /approve/:preparationId` | Wallet approval page (public; id is a 128-bit secret) |

Amounts are **decimal strings** (`"25"`, `"25.50"`, max 6 decimals). Numbers, exponent notation, zero and excess precision are rejected. Requests cannot supply RPC URLs or token contracts.

## Subscriptions — crypto only, paid to vimatons.dao

Access to `/mcp` and `/api` is sold as subscriptions. **The only accepted payment is USDC** sent from the customer's own wallet to the USDC wallet linked to **`vimatons.dao`** (`BILLING_DOMAIN`) on Ethereum, Base or Polygon. There is no card, bank or fiat processor anywhere.

| Plan (defaults — set your own via `BILLING_PLANS`) | Price | Period | Billable calls |
|---|---|---|---|
| Starter | 10 USDC | 30 days | 1,000 |
| Pro | 49 USDC | 30 days | 10,000 |
| Business | 199 USDC | 30 days | 100,000 |

**Flow:** customer opens `/subscribe` → picks plan + network → connects wallet → server resolves vimatons.dao's USDC record for that network and creates an invoice (exact amount, payer, receiving wallet, start block) → customer pays in their wallet → server verifies the receipt on-chain → after the network's required confirmations it issues an API key (`tzk_…`, shown for 24 h, stored only as a hash). Renewal: create an invoice with the existing key in `Authorization`; the period is extended from the current expiry.

A payment is accepted only if: the transaction succeeded, it called the official USDC contract, it contains a USDC `Transfer` from the invoice's payer to the invoice's vimatons.dao wallet for at least the invoice amount, it was mined after the invoice was created, it has the required confirmations, and its hash hasn't paid another invoice. Everything else is rejected with a reason.

**Pin your wallets.** Set `BILLING_PINNED_ADDRESSES=base:0x…,polygon:0x…` to the vimatons.dao wallets you control. If the domain's record ever changes (e.g. compromise), invoices stop with `TREASURY_MISMATCH` instead of sending customers' money elsewhere.

| Billing endpoint | Auth | Purpose |
|---|---|---|
| `GET /billing/plans` | public | Plans, networks, pay-to domain |
| `POST /billing/invoices` | public (Bearer key = renewal) | `{ plan, network, payer }` |
| `GET /billing/invoices/:id` | public (id is secret) | Invoice status |
| `POST /billing/invoices/:id/confirm` | public | `{ txHash }` — verify payment, activate |
| `GET /api/subscription` | subscriber key | Plan, expiry, usage |
| `GET /subscribe` | public | Checkout page |

MCP tools `get_subscription_plans`, `get_my_subscription`, `create_subscription_invoice` and `confirm_subscription_payment` expose the same flow (and are not metered). Billable = each MCP `tools/call` of a payment tool, and each `/api` request except `/api/subscription` and `/api/networks`. Operator keys in `API_KEYS` are unlimited and unmetered — keep them for yourself. Over quota → HTTP 429 `QUOTA_EXCEEDED`; expired → HTTP 402 `SUBSCRIPTION_EXPIRED`.

The ledger lives in Supabase (`subscriptions`, `invoices`, `used_tx_hashes`). Payment confirmation is a single database transaction, and a transaction hash is unique in the database, so concurrent or repeated confirmations can never create two subscriptions or reuse a payment. Turn on Supabase backups / Point-in-Time Recovery for it.

## Recipient resolution rules

Records are read from `GET https://api.unstoppabledomains.com/resolve/domains/{domain}` (server-side, bearer key). For USDC on each network the lookup order follows UD's documented `getAddress(network, token)` precedence:

1. `token.EVM.<NET>.USDC.address` — `ETH`, `BASE`, `MATIC`
2. `crypto.USDC.address` *(warning: network not specified)*
3. `crypto.USDC.version.ERC20.address` (Ethereum) / `crypto.USDC.version.MATIC.address` (Polygon)
4. `token.EVM.<NET>.address` *(warning: not USDC-specific)*
5. `token.EVM.address` *(warning: one address for all EVM chains)*

`crypto.ETH.address` is **never** used as a USDC address, and an Ethereum USDC record is never reused on Base or Polygon. Set `RECIPIENT_RECORD_POLICY=strict` to accept only steps 1 and 3. Addresses must be valid, checksum-correct (if mixed case), non-zero and not a token contract.

## Fee ranking

For every requested network a route is **eligible only if** the recipient has a valid USDC record there, the RPC's chain ID matches, the allowlisted USDC contract verifies on-chain (code, `symbol() == "USDC"`, `decimals() == 6`), neither party is USDC-blacklisted, the sender (if given) holds enough USDC and enough native gas, the transfer estimates/simulates successfully, and the price quote is fresh.

```
expected fee = gasUnits × (baseFee + priorityFee) + L1 data fee (Base only)
max fee      = gasLimit(×1.2) × maxFeePerGas + L1 fee × 1.25        ← the wallet's reserve, reported separately
USD          = fee in ETH/POL × timestamped USD price (rounded up)
total cost   = network fee + conversion fee (0) + bridge fee (0) + other (0)
```

Eligible routes are sorted by expected USD cost, then max USD cost. If the sender's USDC is on a different chain, that route is **ineligible with a reason** ("would require bridging") — never silently bridged. If any provider fails, the route is ineligible; no number is invented. Without a sender address, gas units use a conservative reference value and the route is labelled `indicative`.

## Security controls

- No private keys, seed phrases, signing or broadcasting anywhere in the server.
- Network/token allowlist in `src/config/` (verified against Circle's docs on 2026-10-28; re-verify on change).
- `prepare_transfer` re-fetches the domain record (cache bypassed) and rejects with `RECIPIENT_CHANGED` if it differs from the quote; re-checks chain, token, balances, gas, price; runs an `eth_call` simulation.
- Prepared fields (chain, from, to, token, recipient, amount, calldata, expiry, ids) are HMAC-bound with `MCP_AUTH_SECRET`; tampering is detected on recheck/verify.
- The approval page decodes the calldata **in the browser** and checks it against the displayed recipient/amount/contract/chain, requires the connected wallet to equal the prepared sender, calls `/recheck` immediately before opening the wallet, and refuses expired preparations. Wallet rejection (code 4001) is reported, nothing is sent.
- Success is reported only when `verify_transfer` returns `confirmed` (receipt success + matching USDC Transfer event + required confirmations: 12 Ethereum / 10 Base / 32 Polygon).
- Bearer API keys (constant-time compare), per-principal rate limits, request-size limit, Origin allowlist, strict CSP on the approval page, secret redaction in logs, audit log in Supabase.
- Production refuses to start without `API_KEYS`, `MCP_AUTH_SECRET`, `UNSTOPPABLE_API_KEY`, `PUBLIC_BASE_URL` and `DATABASE_URL`.

## Local setup

```bash
npm install
cp .env.example .env      # for local dev: NODE_ENV=development; leave DATABASE_URL empty for in-memory storage
npm test                  # 142 tests: the full suite in memory, then again on real Postgres (PGlite) with the Supabase migration
# Optional: against a real Postgres server
# TEST_STORE=postgres TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres?sslmode=disable npx vitest run
npm run dev               # http://localhost:8080
BASE_URL=http://localhost:8080 API_KEY=<key> npm run smoke -- thomaszacharias.nft 0xYourSenderAddress
```

You need: an Unstoppable Domains Resolution API key (Partner Dashboard), RPC URLs for Ethereum/Base/Polygon (Alchemy, Infura, QuickNode, etc.), optionally a CoinGecko Demo key, and a Supabase project.

## Hosting: Google Cloud Run + Supabase (+ optional Cloudflare)

```
GitHub (code) ──Actions──▶ ghcr.io image (public) ──▶ Google Cloud Run  (compute only: no disks, no buckets)
                                                          │
Cloudflare (optional: DNS / TLS / proxy) ──▶ Cloud Run ───┴──▶ Supabase Postgres  (ALL data)
```

| Piece | Holds | Does **not** hold |
|---|---|---|
| **Google Cloud Run** | the running container; secrets in Secret Manager; stdout logs in Cloud Logging | no files, no volumes, no Cloud Storage buckets, no Artifact Registry images, no source uploads |
| **Supabase Postgres** | subscriptions, invoices, used tx hashes, quotes, prepared transfers, rate-limit counters, audit log | — |
| **GitHub Container Registry** | the container image | — |
| **Cloudflare** (optional) | nothing — the Worker only forwards requests | — |

The service writes **no files at all**, so Supabase Storage and Cloudflare R2 aren't needed. Cloudflare is optional, for your custom domain and DDoS protection.

### 1. Supabase

1. Create a project (pick **Mumbai / ap-south-1** to sit next to Cloud Run `asia-south1`).
2. **Project Settings → Database → Connection string**: copy the **Transaction pooler** URL (port 6543) → `DATABASE_URL`. Copy the **Session pooler** (or direct) URL → `SUPABASE_MIGRATION_DB_URL`.
3. **Database settings → SSL**: download the CA certificate → `DATABASE_CA_CERT` (so TLS is verified), and turn on **Enforce SSL**.
4. Create the tables: `DATABASE_URL=… npm run build && npm run migrate` (the GitHub workflow also runs this on every deploy). Or paste `supabase/migrations/20261111000000_init.sql` into the SQL editor.

Every table has Row Level Security on and no policies, so Supabase's public `anon`/`authenticated` API keys can't read or write anything. Only the server, using the database password, can. Don't expose the database password or `service_role` key anywhere else.

### 2. Google Cloud (one time)

```bash
PROJECT_ID=<your-project> GITHUB_REPO=<owner>/thomaszacharias-mcp REGION=asia-south1 ./deploy/setup-gcp.sh
```

This enables Cloud Run + Secret Manager, creates a runtime service account (it can only read its own secrets) and a deploy service account, stores your secrets in Secret Manager (it prompts for them and generates `MCP_AUTH_SECRET`), and sets up **keyless** GitHub → Google auth (Workload Identity Federation). It doesn't create any buckets, registries or key files. Every secret listed in the workflow needs a value. If you skip an optional one (`DATABASE_CA_CERT`, `PRICE_FEED_API_KEY`), remove its line from `.github/workflows/deploy.yml`.

### 3. GitHub

Push this folder to a GitHub repo, add the variables and secrets the setup script prints, then push to `main`. The workflow runs both test suites, builds the image and pushes it to `ghcr.io`, applies Supabase migrations, deploys to Cloud Run, and smoke-tests `/health` and `/health/ready`.

After the first run, set the `thomaszacharias-mcp` package on GitHub to **Public** (Package settings → Change visibility). Cloud Run pulls public GHCR images directly, which is what keeps the image off Google's storage. The image contains compiled code and no secrets. If you'd rather keep it private, Cloud Run needs an Artifact Registry remote repository, and Google would then cache the image.

### 4. Domain (choose one)

- **Cloudflare (recommended):** put your domain's DNS on Cloudflare, set `ORIGIN` and the route in `cloudflare/wrangler.toml`, then run `npx wrangler deploy` from `cloudflare/`. Set `PUBLIC_BASE_URL=https://mcp.<your-domain>`.
- **No Cloudflare:** use the `https://…run.app` URL Cloud Run gives you as `PUBLIC_BASE_URL`.

Verify: `BASE_URL=https://mcp.<your-domain> API_KEY=<operator key> npm run smoke`

### Cloud Run settings and why

The service is stateless and runs 0–5 instances with up to 40 concurrent requests each and a 60 s timeout. It scales to zero when idle, so expect a cold start of a second or two on the first request. Set `--min-instances=1` to avoid that, at a small monthly cost. Quotes, approvals, subscriptions and rate limits all live in Supabase, so any instance can serve any request.

## Leaving Hostinger

Nothing in this project depends on Hostinger any more. To shut the old deployment down:

1. Deploy here first and confirm `/health/ready` and the smoke test pass on the new URL.
2. Point your domain/subdomain DNS at Cloudflare or Cloud Run (step 4) and wait for it to switch over.
3. In hPanel, delete the Node.js web app and its environment variables, plus any DNS records or subdomains that pointed at it.
4. **Rotate every secret that was stored on Hostinger**: Unstoppable Domains API key, RPC keys, price key, `API_KEYS`, `MCP_AUTH_SECRET`. Put the new values only in Secret Manager.
5. If you had `data/billing.json` there with real subscribers, keep a copy and ask me to import it into Supabase. Otherwise there's nothing to migrate.
6. Before cancelling the plan, check whether your email or other websites also run on it.

## Connect it to Claude

Add a custom connector pointing at `https://<your domain>/mcp`. The server uses bearer API-key auth; if your client can't send an `Authorization` header to a custom connector, put the server behind an OAuth-capable gateway or add OAuth before connecting it.

Example conversation flow: *compare_payment_routes (with sender) → AI shows recipient, network, amount, expected and max fee → user picks a network → prepare_transfer → user opens `approvalUrl`, checks, signs in their wallet → verify_transfer until `confirmed`.*

## Pre-launch checklist

- [ ] Each network resolves the right USDC address for your test domains (try one with only `token.EVM.address` and one with chain-specific records).
- [ ] `get_supported_networks` shows all three networks `configured: true` and contracts match https://developers.circle.com/stablecoins/usdc-contract-addresses
- [ ] A small live transfer on Base and Polygon verifies as `confirmed` with the right recipient.
- [ ] Quotes behave correctly during an RPC outage (route ineligible, no fee shown).
- [ ] Rate limits and API keys are set; `audit_log` rows appear in Supabase.
- [ ] `/health/ready` returns `ready` (Supabase reachable); Supabase backups are on.

## Project layout

```
src/
  server.ts            boot + composition root
  app.ts               Express app: /health, /mcp, /api, /approve
  services.ts          shared ops used by REST and MCP
  mcp/tools.ts         MCP tool definitions
  api/routes.ts        REST + public approval endpoints
  config/              env, network allowlist, USDC contracts
  domain/unstoppable.ts  UD client, domain normalization, record precedence
  evm/gateway.ts       viem: chain id, token checks, balances, gas, L1 fee, simulation, receipts
  pricing/prices.ts    timestamped native-coin prices
  quote/               fee math, route evaluation/ranking
  store/               Supabase Postgres + in-memory stores, migrations runner, audit log
  transfer/            prepare (unsigned + HMAC binding + recheck), verify
  security/            operator + subscriber auth, metering, Origin check, rate limit
  billing/             crypto-only subscriptions: invoices to vimatons.dao, on-chain payment checks
  schemas/requests.ts  strict Zod request schemas
public/approve.*       wallet approval page (vanilla JS, EIP-1193)
public/subscribe.*     USDC subscription checkout page
supabase/migrations/   database schema (RLS locked)
Dockerfile             Cloud Run image (no runtime file writes)
.github/workflows/     test → ghcr.io → migrate → Cloud Run
deploy/setup-gcp.sh    one-time Google Cloud setup (no buckets/registries/keys)
cloudflare/            optional proxy Worker for your custom domain
tests/                 vitest (resolution, fees, transfers, API/MCP, billing, Postgres)
```
