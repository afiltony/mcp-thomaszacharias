import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { makeCtx, RECIPIENT, SENDER } from './helpers.js';

const KEY = 'test-key-0123456789abcdefghij';
const records = { 'token.EVM.BASE.USDC.address': RECIPIENT, 'token.EVM.MATIC.USDC.address': RECIPIENT };

async function app(envOver: Record<string, string> = {}) {
  const ctx = await makeCtx({ records, env: { API_KEYS: `claude:${KEY}`, ALLOWED_ORIGINS: 'https://thomaszacharias.com', RATE_LIMIT_PER_MINUTE: '1000', ...envOver } });
  return { ctx, app: createApp(ctx) };
}
const auth = { Authorization: `Bearer ${KEY}` };
const mcpHeaders = { ...auth, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };

async function mcp(a: Awaited<ReturnType<typeof app>>['app'], method: string, params: unknown = {}, id = 1) {
  const res = await request(a).post('/mcp').set(mcpHeaders).send({ jsonrpc: '2.0', id, method, params });
  return res;
}

describe('HTTP surface', () => {
  it('health is public and leaks no secrets', async () => {
    const res = await request((await app()).app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it('requires a valid API key for /api and /mcp', async () => {
    const { app: a } = (await app());
    expect((await request(a).post('/api/resolve').send({ domain: 'x.nft' })).status).toBe(401);
    expect((await request(a).post('/api/resolve').set({ Authorization: 'Bearer wrong' }).send({ domain: 'x.nft' })).status).toBe(401);
    expect((await request(a).post('/mcp').send({})).status).toBe(401);
  });

  it('rejects disallowed browser origins', async () => {
    const res = await request((await app()).app).post('/api/resolve').set({ ...auth, Origin: 'https://evil.example' }).send({ domain: 'x.nft' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ORIGIN');
  });

  it('enforces request-size limits and rate limits', async () => {
    const { app: a } = (await app({ REQUEST_BODY_LIMIT: '1kb', RATE_LIMIT_PER_MINUTE: '2' }));
    expect((await request(a).post('/api/resolve').set(auth).send({ domain: 'x'.repeat(5000) })).status).toBe(413);
    await request(a).get('/api/networks').set(auth);
    await request(a).get('/api/networks').set(auth);
    const third = await request(a).get('/api/networks').set(auth);
    expect(third.status).toBe(429);
  });

  it('REST quote → prepare → fetch flow', async () => {
    const { app: a } = (await app());
    const q = await request(a).post('/api/quotes').set(auth).send({ domain: 'ThomasZacharias.nft', amount: '25', sender: SENDER });
    expect(q.status).toBe(200);
    expect(q.body.recommendedNetwork).toBe('base');
    expect(q.body.routes[0]._sort).toBeUndefined();
    const p = await request(a).post('/api/transfers/prepare').set(auth).send({ quoteId: q.body.quoteId, sender: SENDER, network: 'base' });
    expect(p.status).toBe(200);
    const pub = await request(a).get(`/public/transfers/${p.body.preparationId}`);
    expect(pub.status).toBe(200);
    expect(pub.body.status).toBe('awaiting_wallet_approval');
    const page = await request(a).get(`/approve/${p.body.preparationId}`);
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect((await request(a).get('/public/transfers/q_' + '0'.repeat(32))).status).toBe(404);
  });

  it('returns explicit errors for bad input', async () => {
    const res = await request((await app()).app).post('/api/quotes').set(auth).send({ domain: 'x.nft', amount: 25 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });
});

describe('MCP over Streamable HTTP', () => {
  it('initializes and lists the payment tools', async () => {
    const { app: a } = (await app());
    const init = await mcp(a, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe('thomaszacharias-mcp');
    const list = await mcp(a, 'tools/list');
    const names = list.body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      'compare_payment_routes',
      'confirm_subscription_payment',
      'create_subscription_invoice',
      'estimate_transfer_fee',
      'get_my_subscription',
      'get_subscription_plans',
      'get_supported_networks',
      'get_transfer',
      'prepare_transfer',
      'resolve_web3_domain',
      'verify_transfer',
    ]);
  });

  it('compare_payment_routes and prepare_transfer work through MCP', async () => {
    const { app: a } = (await app());
    const cmp = await mcp(a, 'tools/call', { name: 'compare_payment_routes', arguments: { domain: 'thomaszacharias.nft', amount: '25', sender: SENDER } });
    const quote = JSON.parse(cmp.body.result.content[0].text);
    expect(quote.recommendedNetwork).toBe('base');
    const prep = await mcp(a, 'tools/call', { name: 'prepare_transfer', arguments: { quoteId: quote.quoteId, sender: SENDER, network: 'base' } });
    const body = JSON.parse(prep.body.result.content[0].text);
    expect(body.signed).toBe(false);
    expect(body.unsignedTransaction.data.startsWith('0xa9059cbb')).toBe(true);
  });

  it('returns tool errors as isError results, not crashes', async () => {
    const { app: a } = (await app());
    const res = await mcp(a, 'tools/call', { name: 'prepare_transfer', arguments: { quoteId: 'q_' + '0'.repeat(32), sender: SENDER, network: 'base' } });
    expect(res.body.result.isError).toBe(true);
    expect(JSON.parse(res.body.result.content[0].text).error.code).toBe('QUOTE_NOT_FOUND');
  });

  it('GET /mcp is not allowed on the stateless server', async () => {
    expect((await request((await app()).app).get('/mcp').set(auth)).status).toBe(405);
  });
});
