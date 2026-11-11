/**
 * Optional Cloudflare Worker: serves your custom domain (e.g. mcp.thomaszacharias.com)
 * in front of the Cloud Run service. Stores nothing — it only forwards requests.
 *
 * Use it when you want Cloudflare DNS/TLS/DDoS protection, or because Cloud Run
 * domain mappings aren't available in your region. Set ORIGIN to the *.run.app URL.
 */
export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    const origin = new URL(env.ORIGIN); // e.g. https://thomaszacharias-mcp-xxxx.asia-south1.run.app
    const target = new URL(incoming.pathname + incoming.search, origin);

    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-Host', incoming.host);
    headers.set('X-Forwarded-Proto', 'https');
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) headers.set('X-Forwarded-For', ip);

    const res = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });
    // Never let Cloudflare cache API, MCP, billing or approval responses.
    const out = new Response(res.body, res);
    out.headers.set('Cache-Control', 'no-store');
    return out;
  },
};
