#!/usr/bin/env node
/**
 * Smoke test against a running server.
 *   BASE_URL=https://mcp.example.com API_KEY=... node scripts/smoke.mjs [domain] [sender]
 * Read-only: it resolves, lists tools over MCP and requests a quote. It never prepares or sends.
 */
const base = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const key = process.env.API_KEY || '';
const domain = process.argv[2] || 'thomaszacharias.nft';
const sender = process.argv[3];
const auth = key ? { Authorization: `Bearer ${key}` } : {};

let failed = 0;
async function step(name, fn) {
  try {
    const out = await fn();
    console.log(`✓ ${name}`);
    if (out !== undefined) console.log(JSON.stringify(out, null, 2).split('\n').slice(0, 40).join('\n'));
  } catch (e) {
    failed++;
    console.error(`✗ ${name}: ${e.message}`);
  }
}
async function call(path, opts = {}) {
  const res = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...auth, ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(body)}`);
  return body;
}

await step('GET /health', () => call('/health'));
await step('GET /health/ready (Supabase)', () => call('/health/ready'));
await step('MCP tools/list', async () => {
  const r = await call('/mcp', {
    method: 'POST',
    headers: { Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  return r.result.tools.map((t) => t.name);
});
await step(`POST /api/resolve ${domain}`, () => call('/api/resolve', { method: 'POST', body: JSON.stringify({ domain }) }));
await step('POST /api/quotes (25 USDC)', async () => {
  const q = await call('/api/quotes', { method: 'POST', body: JSON.stringify({ domain, amount: '25', ...(sender ? { sender } : {}) }) });
  return { summary: q.summary, routes: q.routes.map((r) => ({ network: r.network, eligible: r.eligible, quoteType: r.quoteType, feeUsd: r.fees?.expectedFeeUsd, reasons: r.reasons })) };
});
process.exit(failed ? 1 : 0);
