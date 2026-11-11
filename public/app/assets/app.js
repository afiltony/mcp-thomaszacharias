/* ThomasZacharias.nft Pay — browser client. Vanilla JS, no third-party code.
 * The server only ever returns UNSIGNED transactions; the visitor's EIP-1193 wallet signs. */
(function () {
  'use strict';

  /* Runtime config (assets/config.js). On Hostinger the API is same-origin and routes are paths;
   * the IPFS build sets apiBase to the Hostinger API and uses #/hash routes (no server fallback there). */
  const CFG = Object.assign({ apiBase: '', router: 'path' }, window.TZ_CONFIG || {});
  CFG.apiBase = String(CFG.apiBase || '').replace(/\/+$/, '');
  const HASH = CFG.router === 'hash';
  function routeUrl() {
    const raw = HASH ? location.hash.replace(/^#/, '') || '/' : location.pathname + location.search;
    const i = raw.indexOf('?');
    return { path: (i < 0 ? raw : raw.slice(0, i)) || '/', query: new URLSearchParams(i < 0 ? '' : raw.slice(i + 1)) };
  }
  const curPath = () => routeUrl().path;
  const toHref = (p) => (HASH ? '#' + p : p);

  const DEFAULT_DOMAIN = 'thomaszacharias.nft';
  const AMOUNT_RE = /^\d{1,12}(\.\d{1,6})?$/;
  const TRANSFER_SELECTOR = '0xa9059cbb';

  /* ---------------------------------------------------------------- data */
  const NET = {
    ethereum: { short: 'Ethereum', name: 'Ethereum Mainnet', blockSec: 12, confs: 12, explorer: 'https://etherscan.io', gas: 'ETH' },
    base: {
      short: 'Base', name: 'Base', blockSec: 2, confs: 10, explorer: 'https://basescan.org', gas: 'ETH',
      add: { chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] },
    },
    polygon: {
      short: 'Polygon', name: 'Polygon PoS', blockSec: 2, confs: 32, explorer: 'https://polygonscan.com', gas: 'POL',
      add: { chainName: 'Polygon PoS', nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 }, rpcUrls: ['https://polygon-rpc.com'], blockExplorerUrls: ['https://polygonscan.com'] },
    },
  };
  const NET_IDS = ['ethereum', 'base', 'polygon'];

  const S = {
    account: null,
    chainId: null,
    networks: null,
    flow: freshFlow(),
    polling: null,
  };
  function freshFlow(domain, amount) {
    return { step: 1, domain: domain || DEFAULT_DOMAIN, resolved: null, amount: amount || '', netFilter: 'auto', quote: null, selected: null, prep: null, txHash: null, submittedAt: null, verify: null, autoResolve: false };
  }

  /* ---------------------------------------------------------------- storage (per-browser conveniences only) */
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('tz.' + k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('tz.' + k, JSON.stringify(v));
      } catch (e) {
        /* blocked */
      }
    },
  };
  const history_ = {
    all: () => store.get('history', []),
    upsert(entry) {
      const list = history_.all().filter((e) => e.txHash !== entry.txHash);
      list.unshift(entry);
      store.set('history', list.slice(0, 200));
    },
    patch(txHash, patch) {
      const list = history_.all().map((e) => (e.txHash === txHash ? Object.assign({}, e, patch) : e));
      store.set('history', list);
    },
  };
  const saved = {
    all: () => store.get('saved', []),
    has: (d) => saved.all().includes(d),
    toggle(d) {
      const list = saved.all();
      store.set('saved', list.includes(d) ? list.filter((x) => x !== d) : [d].concat(list).slice(0, 100));
      return saved.has(d);
    },
  };

  /* ---------------------------------------------------------------- DOM helpers */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) return c.forEach((x) => append(el, x));
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  /** Parses trusted, static SVG markup defined in this file only. */
  function svg(markup, cls) {
    const t = document.createElement('template');
    t.innerHTML = markup.trim();
    const el = t.content.firstChild;
    if (cls) el.setAttribute('class', cls);
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
  const $ = (id) => document.getElementById(id);

  const ICONS = {
    send: '<path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    compare: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    bookmark: '<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
    wallet: '<path d="M20 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15v14H5a2 2 0 0 1-2-2V5"/><path d="M16 14h.01"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    arrowDown: '<path d="M12 3v17M6 14l6 6 6-6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5z"/><path d="M4 19.5V22h16v-5"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  };
  const ico = (name, cls) =>
    svg('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>', cls);

  const CHAIN_SVG = {
    ethereum:
      '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#627EEA"/><path d="M16.5 4v8.9l7.5 3.3z" fill="#fff" fill-opacity=".6"/><path d="M16.5 4 9 16.2l7.5-3.3z" fill="#fff"/><path d="M16.5 22v6L24 17.6z" fill="#fff" fill-opacity=".6"/><path d="M16.5 28v-6L9 17.6z" fill="#fff"/><path d="m16.5 20.6 7.5-4.4-7.5-3.3z" fill="#fff" fill-opacity=".2"/><path d="m9 16.2 7.5 4.4v-7.7z" fill="#fff" fill-opacity=".6"/></svg>',
    base:
      '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#0052FF"/><path d="M15.97 25.5c5.25 0 9.5-4.25 9.5-9.5s-4.25-9.5-9.5-9.5c-4.98 0-9.06 3.83-9.47 8.7h12.56v1.6H6.5c.41 4.87 4.5 8.7 9.47 8.7z" fill="#fff"/></svg>',
    polygon:
      '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#8247E5"/><path transform="translate(4.6 6.2) scale(.95)" d="M17.8 7.2a1.4 1.4 0 0 0-1.3 0l-3.1 1.8-2.1 1.2-3.1 1.8a1.4 1.4 0 0 1-1.3 0l-2.4-1.4a1.3 1.3 0 0 1-.7-1.1V6.7c0-.4.2-.9.7-1.1l2.4-1.4a1.4 1.4 0 0 1 1.3 0l2.4 1.4c.4.2.7.7.7 1.1v1.8l2.1-1.2V5.5c0-.4-.2-.9-.7-1.1L8.2 1.8a1.4 1.4 0 0 0-1.3 0L2.4 4.4c-.5.2-.7.7-.7 1.1v5.1c0 .4.2.9.7 1.1l4.5 2.6c.4.2.9.2 1.3 0l3.1-1.8 2.1-1.2 3.1-1.8a1.4 1.4 0 0 1 1.3 0l2.4 1.4c.4.2.7.7.7 1.1v2.8c0 .4-.2.9-.7 1.1l-2.4 1.4a1.4 1.4 0 0 1-1.3 0l-2.4-1.4a1.3 1.3 0 0 1-.7-1.1v-1.8l-2.1 1.2v1.8c0 .4.2.9.7 1.1l4.5 2.6c.4.2.9.2 1.3 0l4.5-2.6c.4-.2.7-.7.7-1.1v-5.2c0-.4-.2-.9-.7-1.1z" fill="#fff"/></svg>',
    usdc:
      '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#2775CA"/><path d="M12.6 25.6a10.2 10.2 0 0 1 0-19.2M19.4 6.4a10.2 10.2 0 0 1 0 19.2" stroke="#fff" stroke-width="1.6" fill="none"/><path d="M19.4 18.2c0-1.9-1.1-2.5-3.4-2.8-1.6-.2-2-.7-2-1.4s.6-1.3 1.6-1.3c1 0 1.5.3 1.8 1.2.1.2.2.3.4.3h.9c.2 0 .4-.2.4-.4-.2-1.2-1.1-2.1-2.4-2.2V10.2c0-.2-.2-.4-.5-.4h-.8c-.2 0-.4.2-.5.4v1.3c-1.6.2-2.6 1.3-2.6 2.6 0 1.8 1.1 2.5 3.4 2.8 1.5.3 2 .6 2 1.5s-.8 1.5-1.8 1.5c-1.4 0-1.9-.6-2-1.4-.1-.2-.2-.3-.4-.3h-1c-.2 0-.4.2-.4.4.2 1.4 1.1 2.3 2.8 2.6v1.4c0 .2.2.4.5.4h.8c.2 0 .4-.2.5-.4v-1.4c1.6-.3 2.7-1.4 2.7-2.9z" fill="#fff"/></svg>',
    ud:
      '<svg viewBox="0 0 32 32"><path d="M29 3.5v10.3L3 24.6z" fill="#00C9FF"/><path d="M24.2 3v13.6a8.2 8.2 0 0 1-16.4 0v-5.5l-4.8 2.6v2.9a13 13 0 0 0 26 0V3z" fill="#0D67FE"/></svg>',
  };
  const chain = (id, cls) => svg(CHAIN_SVG[id], cls || 'chain-icon');

  /** Duotone line art for the feature cards (64×64, inherits the theme's primary colour). */
  const ART = {
    resolve:
      '<circle cx="27" cy="27" r="19" fill="currentColor" fill-opacity=".14"/><circle cx="27" cy="27" r="19"/><path d="M8 27h38M27 8c7 7 7 31 0 38M27 8c-7 7-7 31 0 38"/><circle cx="45" cy="45" r="9" fill="currentColor" fill-opacity=".22"/><circle cx="45" cy="45" r="9"/><path d="m52 52 7 7"/>',
    compare:
      '<rect x="5" y="7" width="54" height="38" rx="3"/><path d="M5 38h54" /><rect x="5" y="38" width="54" height="7" fill="currentColor" fill-opacity=".2"/><path d="M26 45l-4 11M38 45l4 11M18 56h28"/><circle cx="19" cy="22" r="7" fill="currentColor" fill-opacity=".2"/><path d="M19 15v7h7"/><path d="m32 28 6-7 5 4 8-10"/><path d="M35 33v-2M41 33v-4M47 33v-3"/>',
    send: '<path d="M58 6 38 58 27 37 6 26z" fill="currentColor" fill-opacity=".15"/><path d="M58 6 38 58 27 37 6 26z"/><path d="M58 6 27 37"/>',
    agents:
      '<rect x="5" y="7" width="54" height="48" rx="4"/><path d="M5 17h54"/><path d="M12 12h.01M17 12h.01M22 12h.01"/><circle cx="32" cy="27" r="4" fill="currentColor" fill-opacity=".2"/><path d="M32 31v6M20 37h24M20 37v4M32 37v4M44 37v4"/><rect x="16" y="41" width="8" height="7" rx="1.5" fill="currentColor" fill-opacity=".2"/><rect x="28" y="41" width="8" height="7" rx="1.5" fill="currentColor" fill-opacity=".2"/><rect x="40" y="41" width="8" height="7" rx="1.5" fill="currentColor" fill-opacity=".2"/>',
  };
  const art = (name) =>
    svg('<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--primary)">' + ART[name] + '</svg>', 'art');

  /** Shield badges for the network band: outline shield + cyan line icon. */
  const SHIELD_INNER = {
    ethereum: '<path d="M40 25 30 44l10 6 10-6z"/><path d="m30 47 10 14 10-14-10 6z"/>',
    base: '<circle cx="40" cy="43" r="14"/><path d="M26 43h17"/>',
    polygon: '<path d="m34 32-8 4.5v9l8 4.5 8-4.5v-9z"/><path d="m46 36-8 4.5v9l8 4.5 8-4.5v-9z"/>',
    agents: '<rect x="30" y="33" width="20" height="20" rx="3"/><path d="M36 33v-5M44 33v-5M36 53v5M44 53v5M30 39h-5M30 47h-5M50 39h5M50 47h5"/>',
  };
  const shield = (id) =>
    svg(
      '<svg viewBox="0 0 80 88" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M40 3 75 14v28c0 23-15 37-35 43C20 79 5 65 5 42V14z" stroke="#fff" stroke-opacity=".9" stroke-width="2"/><g stroke="#2bb5ff" stroke-width="2">' +
        SHIELD_INNER[id] +
        '</g></svg>',
    );

  /** Decorative node-and-line network (deterministic, generated here; no external images). */
  const artCache = {};
  function networkArt(key, o) {
    if (!artCache[key]) {
      let s = o.seed >>> 0;
      const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      const pts = [];
      for (let i = 0; i < o.count; i++) {
        // Bias points into a loose globe shape on the right.
        const a = rnd() * Math.PI * 2;
        const r = Math.sqrt(rnd()) * o.h * 0.48;
        pts.push([o.w * 0.58 + Math.cos(a) * r * 1.25, o.h * 0.5 + Math.sin(a) * r, rnd()]);
      }
      let lines = '';
      pts.forEach((p, i) => {
        const near = pts
          .map((q, j) => [j, (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2])
          .filter((x) => x[0] !== i)
          .sort((x, y) => x[1] - y[1])
          .slice(0, 3);
        near.forEach(([j]) => {
          if (j > i) lines += 'M' + p[0].toFixed(1) + ' ' + p[1].toFixed(1) + 'L' + pts[j][0].toFixed(1) + ' ' + pts[j][1].toFixed(1);
        });
      });
      let glow = '';
      for (let i = 0; i < o.blobs; i++) {
        const x = o.w * (0.2 + rnd() * 0.8);
        const y = o.h * rnd();
        glow += '<circle cx="' + x.toFixed(0) + '" cy="' + y.toFixed(0) + '" r="' + (6 + rnd() * 26).toFixed(0) + '" fill="url(#g' + key + ')" opacity="' + (0.25 + rnd() * 0.6).toFixed(2) + '"/>';
      }
      const nodes = pts.map((p) => '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + (1.6 + p[2] * 3.4).toFixed(1) + '"/>').join('');
      artCache[key] =
        '<svg viewBox="0 0 ' + o.w + ' ' + o.h + '" preserveAspectRatio="xMidYMid slice"><defs><radialGradient id="g' + key + '"><stop offset="0" stop-color="' + o.glow + '" stop-opacity=".9"/><stop offset="1" stop-color="' + o.glow + '" stop-opacity="0"/></radialGradient></defs>' +
        glow +
        '<path d="' + lines + '" stroke="' + o.line + '" stroke-width="1.1" fill="none"/><g fill="' + o.node + '">' + nodes + '</g></svg>';
    }
    return svg(artCache[key], 'net-art');
  }
  const heroArt = () => networkArt('hero', { w: 1100, h: 760, count: 120, blobs: 46, seed: 39, line: 'rgba(140,195,255,.38)', node: '#8fc8ff', glow: '#3d8cff' });
  const bannerArt = () => networkArt('banner', { w: 620, h: 420, count: 48, blobs: 14, seed: 7, line: 'rgba(140,195,255,.35)', node: '#8fc8ff', glow: '#3d8cff' });
  const ctaArt = () => networkArt('cta', { w: 900, h: 520, count: 70, blobs: 22, seed: 11, line: 'rgba(12,74,158,.22)', node: 'rgba(12,74,158,.45)', glow: '#7fb2ff' });

  /* ---------------------------------------------------------------- formatting */
  const short = (a, n) => (a && a.length > 14 ? a.slice(0, (n || 6)) + '…' + a.slice(-4) : a || '');
  function fmtUsd(v) {
    const n = Number(v);
    if (!isFinite(n)) return '—';
    if (n === 0) return '$0.00';
    if (n < 0.01) return '$' + n.toPrecision(2);
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtNative(v, sym) {
    const n = Number(v);
    if (!isFinite(n)) return '';
    return (n < 0.0001 ? n.toPrecision(2) : n.toLocaleString('en-US', { maximumFractionDigits: 6 })) + ' ' + sym;
  }
  function fmtDur(sec) {
    if (sec < 90) return '~' + Math.round(sec) + ' sec';
    return '~' + Math.round(sec / 60) + ' min';
  }
  const fmtTime = (iso) => new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  function confTime(id) {
    const n = (S.networks && S.networks.networks.find((x) => x.id === id)) || null;
    return fmtDur((n ? n.requiredConfirmations : NET[id].confs) * NET[id].blockSec);
  }
  const usdcAsUsd = (amount) => fmtUsd(amount);

  /* ---------------------------------------------------------------- API */
  async function api(method, path, body) {
    const res = await fetch(CFG.apiBase + path, {
      method,
      mode: 'cors',
      credentials: 'omit',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      /* non-JSON */
    }
    if (!res.ok) {
      const err = new Error((data.error && data.error.message) || 'Request failed (' + res.status + ')');
      err.code = data.error && data.error.code;
      err.details = data.error && data.error.details;
      throw err;
    }
    return data;
  }
  async function loadNetworks() {
    if (!S.networks) S.networks = await api('GET', '/web-api/networks');
    return S.networks;
  }

  /* ---------------------------------------------------------------- UI bits */
  function toast(msg, kind) {
    const t = h('div', { class: 'toast' + (kind ? ' ' + kind : ''), role: kind === 'bad' ? 'alert' : 'status' }, msg);
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3500);
  }
  function copyBtn(value, label) {
    return h(
      'button',
      {
        class: 'copy',
        type: 'button',
        title: 'Copy ' + (label || ''),
        'aria-label': 'Copy ' + (label || value),
        onclick: async (e) => {
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(value);
            toast('Copied ' + (label || ''));
          } catch (err) {
            toast('Copy failed — select and copy manually', 'bad');
          }
        },
      },
      ico('copy'),
    );
  }
  function notice(kind, title, items) {
    return h('div', { class: 'notice ' + (kind || ''), role: kind === 'bad' ? 'alert' : null }, title, items && items.length ? h('ul', null, items.map((i) => h('li', null, i))) : null);
  }
  async function busy(btn, label, fn) {
    const orig = Array.from(btn.childNodes);
    btn.disabled = true;
    btn.replaceChildren(h('span', { class: 'spin' }), label);
    try {
      return await fn();
    } finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.replaceChildren.apply(btn, orig);
      }
    }
  }
  function countdown(iso) {
    return h('span', { 'data-expires': iso }, '');
  }
  setInterval(tickCountdowns, 1000);
  function tickCountdowns() {
    document.querySelectorAll('[data-expires]').forEach((el) => {
      const ms = Date.parse(el.getAttribute('data-expires')) - Date.now();
      if (ms <= 0) {
        el.textContent = 'expired';
        el.classList.add('expired');
        return;
      }
      const s = Math.ceil(ms / 1000);
      el.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    });
  }
  const expired = (iso) => Date.parse(iso) <= Date.now();

  /* ---------------------------------------------------------------- wallet (EIP-1193) */
  const eth = () => window.ethereum;
  const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  function setAccount(a) {
    const prev = S.account;
    S.account = a ? a.toLowerCase() : null;
    renderWalletBtn();
    const F = S.flow;
    if (prev && S.account !== prev && (F.quote || F.prep) && F.step < 5) {
      if (F.quote && F.quote.sender) {
        F.quote = null;
        F.selected = null;
      }
      F.prep = null;
      if (F.step > 2) F.step = 2;
      toast('Wallet account changed — compare fees again for the new account.');
      if (curPath() === '/pay') render(true);
    }
  }
  async function connectWallet() {
    if (!eth()) {
      if (isMobile()) {
        location.href = 'https://metamask.app.link/dapp/' + location.host + location.pathname + location.search + location.hash;
        return null;
      }
      toast('No browser wallet found. Install MetaMask, Coinbase Wallet, Rabby or another EVM wallet, then reload.', 'bad');
      return null;
    }
    try {
      const accs = await eth().request({ method: 'eth_requestAccounts' });
      setAccount(accs && accs[0]);
      S.chainId = parseInt(await eth().request({ method: 'eth_chainId' }), 16);
      return S.account;
    } catch (e) {
      toast(e && e.code === 4001 ? 'Wallet connection was rejected.' : 'Wallet connection failed: ' + (e && e.message), 'bad');
      return null;
    }
  }
  function renderWalletBtn() {
    const b = $('walletBtn');
    if (S.account) {
      b.className = 'btn wallet-btn connected';
      b.replaceChildren(h('span', { class: 'dot' }), h('span', { class: 'mono' }, short(S.account)));
      b.title = 'Connected: ' + S.account + ' (click to copy)';
    } else {
      b.className = 'btn wallet-btn';
      b.replaceChildren(ico('wallet'), h('span', null, 'Connect', h('span', { class: 'label-long' }, ' Wallet')));
      b.title = 'Connect an EVM browser wallet';
    }
  }
  async function ensureChain(prep) {
    const want = prep.unsignedTransaction.chainId;
    const cur = parseInt(await eth().request({ method: 'eth_chainId' }), 16);
    if (cur === prep.chainId) return;
    try {
      await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
    } catch (e) {
      const meta = NET[prep.network].add;
      if (e && e.code === 4902 && meta) {
        await eth().request({ method: 'wallet_addEthereumChain', params: [Object.assign({ chainId: want }, meta)] });
      } else throw e;
    }
    const after = parseInt(await eth().request({ method: 'eth_chainId' }), 16);
    if (after !== prep.chainId) throw new Error('Your wallet is not on ' + NET[prep.network].name + '.');
  }

  /* ---------------------------------------------------------------- router */
  const ROUTES = {
    '/': pageHome,
    '/pay': pagePay,
    '/resolve': pageResolve,
    '/compare': pageCompare,
    '/history': pageHistory,
    '/saved': pageSaved,
    '/networks': pageNetworks,
    '/pricing': pagePricing,
    '/docs': pageDocs,
  };
  const NAV_GROUP = { '/pay': '/pay', '/compare': '/pay', '/resolve': '/resolve', '/saved': '/resolve', '/history': '/history', '/networks': '/networks', '/pricing': '/pricing', '/docs': '/docs', '/': '/' };

  function navigate(path, replace) {
    history[replace ? 'replaceState' : 'pushState'](null, '', toHref(path));
    render();
  }
  let rendered = null;
  function render(keepScroll) {
    const path = curPath();
    const fn = ROUTES[path] || pageHome;
    const y = window.scrollY;
    rendered = HASH ? location.hash : location.pathname + location.search;
    document.body.classList.toggle('on-hero', path === '/');
    $('view').replaceChildren(fn(), siteFooter());
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', NAV_GROUP[path] === a.getAttribute('data-nav')));
    $('nav').classList.remove('open');
    $('menuBtn').setAttribute('aria-expanded', 'false');
    tickCountdowns();
    window.scrollTo(0, keepScroll ? y : 0);
    onScroll();
  }
  function onScroll() {
    document.body.classList.toggle('scrolled', window.scrollY > 40);
    $('toTop').classList.toggle('show', window.scrollY > 500);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-link]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(a.getAttribute('data-path') || a.getAttribute('href'));
  });
  window.addEventListener('popstate', () => render());
  // Hand-edited #/routes; skip when popstate already rendered this location.
  window.addEventListener('hashchange', () => HASH && location.hash !== rendered && render());

  const link = (path, attrs, ...kids) => h('a', Object.assign({ href: toHref(path), 'data-path': path, 'data-link': true }, attrs || {}), ...kids);

  function banner(title, sub) {
    return h('section', { class: 'page-banner' }, bannerArt(), h('div', { class: 'container' }, h('h1', null, title), sub ? h('p', null, sub) : null));
  }
  function shell(content, title, sub) {
    const items = [
      ['/pay', 'send', 'Send Payment'],
      ['/resolve', 'search', 'Resolve Domain'],
      ['/compare', 'compare', 'Compare Fees'],
      ['/history', 'history', 'History'],
      ['/saved', 'bookmark', 'Saved Domains'],
    ];
    return h(
      'div',
      null,
      banner(title, sub),
      h(
        'div',
        { class: 'shell' },
        h('aside', { class: 'sidebar', 'aria-label': 'Payments' }, items.map(([p, i, t]) => link(p, { class: curPath() === p ? 'active' : null }, ico(i), t))),
        h('main', { class: 'page' }, content),
      ),
    );
  }

  /* ================================================================ HOME */
  /** Background clip for wide screens only (7.7 MB): skipped on phones, reduced motion and data saver. */
  function heroVideo() {
    const conn = navigator.connection;
    if (CFG.heroVideo === false || !matchMedia('(min-width: 900px)').matches || matchMedia('(prefers-reduced-motion: reduce)').matches || (conn && conn.saveData)) return null;
    const v = h('video', { class: 'hero-video', autoplay: true, muted: true, loop: true, playsinline: true, preload: 'auto', 'aria-hidden': 'true', src: 'assets/media/hero.mp4' });
    v.muted = true; // the property, not just the attribute, is what browsers check for autoplay
    v.addEventListener('error', () => v.replaceWith(heroArt()));
    return v;
  }
  function pageHome() {
    const domainIn = h('input', { class: 'input', value: DEFAULT_DOMAIN, 'aria-label': 'Web3 domain', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
    const amountIn = h('input', { class: 'input amt', value: '25', inputmode: 'decimal', 'aria-label': 'USDC amount' });
    const go = () => {
      const d = domainIn.value.trim();
      const a = amountIn.value.trim();
      if (!d) return toast('Enter a Web3 domain', 'bad');
      if (a && !AMOUNT_RE.test(a)) return toast('Amount must be a number like 25 or 25.50', 'bad');
      S.flow = freshFlow(d, a);
      S.flow.autoResolve = true;
      navigate('/pay');
    };
    const video = heroVideo();
    const stats = [
      ['3', 'Networks compared live on every payment: Ethereum, Base and Polygon.'],
      ['0', 'Private keys held. Every payment is signed in your own wallet.'],
      ['11', 'MCP tools so AI assistants can find the cheapest route for you.'],
    ];
    const cards = [
      ['resolve', 'Domain Resolution', 'Type any Unstoppable Domains name. We read its USDC receiving address for Ethereum, Base and Polygon from the domain’s own records, and show exactly which record we used.', '/resolve', 'Resolve domain'],
      ['compare', 'Gas Comparison', 'Live fee quotes on every supported network, ranked by real USD cost, including Base’s L1 data fee. Routes that would need a bridge or swap are flagged, never hidden.', '/compare', 'Compare fees'],
      ['send', 'Secure Payments', 'Review recipient, network, amount and maximum fee, then sign in your own wallet. The call data is decoded in your browser and the payment is verified on-chain.', '/pay', 'Send payment'],
      ['agents', 'Built for AI Agents', 'Claude and other assistants can resolve, compare and prepare payments through our MCP server and REST API. Only you can sign.', '/docs', 'Developer docs'],
    ];
    const shields = [
      ['ethereum', 'Ethereum', 'Mainnet'],
      ['base', 'Base', 'Layer 2'],
      ['polygon', 'Polygon', 'PoS chain'],
      ['agents', 'AI Agents', 'MCP + API'],
    ];
    return h(
      'div',
      null,
      h(
        'section',
        { class: 'hero-band' + (video ? ' has-video' : '') },
        video || heroArt(),
        h(
          'div',
          { class: 'container hero-content' },
          h('p', { class: 'eyebrow' }, 'Web3 Payments, Simplified'),
          h('h1', null, 'Pay any Web3 domain. Pay the lowest gas.'),
          h(
            'p',
            { class: 'lead' },
            'ThomasZacharias.nft finds the USDC address behind any Unstoppable Domains name, compares live fees on Ethereum, Base and Polygon, and prepares a transfer you sign in your own wallet. No custody, no bridges, no surprises.',
          ),
          h('div', { class: 'hero-cta' }, link('/pay', { class: 'btn btn-white btn-lg' }, 'Get started'), link('/docs', { class: 'btn btn-glass btn-lg' }, 'For AI agents')),
        ),
      ),
      h('section', { class: 'stats' }, h('div', { class: 'container stats-grid' }, stats.map(([b, s]) => h('div', { class: 'stat' }, h('b', null, b), h('span', null, s))))),
      h(
        'section',
        { class: 'soft' },
        h(
          'div',
          { class: 'container' },
          h(
            'div',
            { class: 'section-head' },
            h('h2', null, 'Smarter routing. Safer payments. Lower fees.'),
            h('p', null, 'Sending stablecoins to a person should be as easy as typing their name, without paying more gas than you need to.'),
            h('p', null, 'We resolve the name, price every direct route and hand your wallet a transaction you can check line by line.'),
          ),
          h(
            'div',
            { class: 'feat-grid' },
            cards.map(([a, t, p, href, cta]) => h('article', { class: 'feat-card' }, art(a), h('h3', null, t), h('p', null, p), link(href, { class: 'btn btn-primary btn-lg' }, cta))),
          ),
        ),
      ),
      h(
        'section',
        { class: 'band' },
        h(
          'div',
          { class: 'container' },
          h('h2', null, 'The network makes the difference.'),
          h(
            'p',
            null,
            'The same USDC transfer can cost very different amounts in gas depending on the chain it travels on. Every payment is priced on all three networks first, so you pick the cheapest route with the full picture: expected fee, maximum fee and time to finality.',
          ),
          h('div', { class: 'shields' }, shields.map(([id, t, s]) => h('div', { class: 'shield' }, shield(id), t, h('small', null, s)))),
        ),
      ),
      h(
        'section',
        { class: 'cta-band' },
        ctaArt(),
        h(
          'div',
          { class: 'container' },
          h(
            'div',
            { class: 'cta-inner' },
            h('h2', null, 'Ready to pay ThomasZacharias.nft?'),
            h('form', { class: 'quickpay', onsubmit: (e) => (e.preventDefault(), go()) }, domainIn, amountIn, h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Get started')),
          ),
        ),
      ),
    );
  }
  function siteFooter() {
    const col = (title, links) =>
      h(
        'div',
        null,
        h('h4', null, title),
        links.map(([label, href, sub]) =>
          /^https?:/.test(href) ? h('a', { href, target: '_blank', rel: 'noopener', class: sub ? 'sub' : null }, label) : link(href, { class: sub ? 'sub' : null }, label),
        ),
      );
    return h(
      'footer',
      { class: 'site-footer' },
      h(
        'div',
        { class: 'container foot-grid' },
        col('Payments', [
          ['Send Payment', '/pay'],
          ['Resolve Domain', '/resolve', true],
          ['Compare Fees', '/compare', true],
          ['Payment History', '/history', true],
        ]),
        col('Platform', [
          ['Supported Networks', '/networks'],
          ['Saved Domains', '/saved'],
        ]),
        col('Developers', [
          ['MCP Integration', '/docs'],
          ['REST API', '/docs'],
          ['API Pricing', '/pricing'],
        ]),
        col('About', [
          ['ThomasZacharias.nft profile', 'https://ud.me/thomaszacharias.nft'],
          ['Unstoppable Domains', 'https://unstoppabledomains.com'],
        ]),
      ),
      h('div', { class: 'container foot-bottom' }, h('span', null, '© ' + new Date().getFullYear() + ' ThomasZacharias.nft · Non-custodial USDC payments'), h('span', null, 'Fees are estimates until confirmed on-chain.')),
    );
  }

  /* ================================================================ RESOLVE (component + page) */
  function resolveBlock(opts) {
    const F = S.flow;
    const input = h('input', {
      class: 'input',
      value: opts.domain || F.domain,
      placeholder: 'e.g. thomaszacharias.nft',
      'aria-label': 'Web3 domain',
      autocomplete: 'off',
      spellcheck: 'false',
      autocapitalize: 'off',
    });
    const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Resolve');
    const out = h('div', { style: 'margin-top:16px' });
    const run = async () => {
      const domain = input.value.trim();
      if (!domain) return out.replaceChildren(notice('bad', 'Enter a Web3 domain such as thomaszacharias.nft.'));
      await busy(btn, 'Resolving…', async () => {
        try {
          const res = await api('POST', '/web-api/resolve', { domain });
          opts.onResolved && opts.onResolved(res);
          out.replaceChildren(resolvedCard(res, opts.cta));
        } catch (e) {
          out.replaceChildren(notice('bad', e.message));
        }
      });
    };
    const form = h('form', { class: 'input-row', onsubmit: (e) => (e.preventDefault(), run()) }, input, btn);
    if (opts.initial) out.appendChild(resolvedCard(opts.initial, opts.cta));
    if (opts.autorun) setTimeout(run, 0);
    return h('div', null, form, out);
  }

  function resolvedCard(res, cta) {
    const rows = res.usdcReceivingAddresses;
    const ok = rows.filter((r) => r.status === 'resolved');
    const warnings = [];
    rows.forEach((r) => (r.warnings || []).forEach((w) => warnings.push(NET[r.network].short + ': ' + w)));
    const star = h(
      'button',
      {
        class: 'btn btn-outline',
        type: 'button',
        onclick: () => {
          const now = saved.toggle(res.domain);
          star.lastChild.textContent = now ? 'Saved' : 'Save';
          toast(now ? 'Saved ' + res.domain : 'Removed ' + res.domain);
        },
      },
      ico('bookmark'),
      h('span', null, saved.has(res.domain) ? 'Saved' : 'Save'),
    );
    return h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'row between wrap' },
        ok.length ? h('div', { class: 'found' }, ico('checkCircle'), 'Domain found') : h('div', { class: 'found', style: 'color:var(--warn)' }, ico('x'), 'Domain found, but it has no USDC address'),
        h('span', { class: 'row small muted' }, svg(CHAIN_SVG.ud, 'chain-icon sm'), 'Unstoppable Domains'),
      ),
      h(
        'div',
        { class: 'row wrap', style: 'margin:10px 0 4px' },
        h('span', { class: 'big' }, res.domain),
        h('a', { href: 'https://ud.me/' + encodeURIComponent(res.domain), target: '_blank', rel: 'noopener', title: 'Open profile on ud.me', 'aria-label': 'Open profile on ud.me' }, ico('ext', 'chain-icon sm')),
      ),
      res.owner ? h('div', { class: 'small muted', style: 'margin-bottom:14px' }, 'Owner ', h('span', { class: 'mono' }, short(res.owner))) : null,
      h('div', { class: 'card-title', style: 'margin-top:8px' }, 'USDC receiving addresses'),
      h(
        'div',
        { class: 'addr-list' },
        rows.map((r) =>
          h(
            'div',
            { class: 'addr' },
            h('div', { class: 'net' }, chain(r.network), h('div', { style: 'min-width:0' }, NET[r.network].name + ' (USDC)', h('small', { class: 'mono' }, r.recordKey || r.reason || 'No USDC record'))),
            r.status === 'resolved'
              ? [h('span', { class: 'val mono', title: r.address }, short(r.address)), copyBtn(r.address, NET[r.network].short + ' address')]
              : h('span', { class: 'badge badge-gray' }, r.status === 'invalid' ? 'Invalid record' : 'Not set'),
          ),
        ),
      ),
      warnings.length ? h('div', { style: 'margin-top:12px' }, notice('warn', 'Check before sending:', warnings)) : null,
      h(
        'div',
        { class: 'row wrap', style: 'margin-top:16px; justify-content:flex-end' },
        star,
        cta ? h('button', { class: 'btn btn-primary', type: 'button', disabled: !ok.length, onclick: () => cta.onClick(res) }, cta.label, ico('arrowRight')) : null,
      ),
    );
  }

  function pageResolve() {
    return shell(
      h(
        'div',
        { class: 'card' },
        resolveBlock({
          domain: routeUrl().query.get('d') || DEFAULT_DOMAIN,
          autorun: !!routeUrl().query.get('d'),
          cta: {
            label: 'Pay this domain',
            onClick: (res) => {
              S.flow = freshFlow(res.domain);
              S.flow.resolved = res;
              S.flow.step = 2;
              navigate('/pay');
            },
          },
        }),
      ),
      'Resolve a Web3 domain',
      'Look up the USDC receiving address an Unstoppable Domains name has set on each network.',
    );
  }

  /* ================================================================ COMPARE (component) */
  function compareBlock(opts) {
    const F = S.flow;
    const domainIn = opts.withDomain
      ? h('input', { class: 'input', value: F.domain, 'aria-label': 'Web3 domain', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' })
      : null;
    const amountIn = h('input', { class: 'input', value: F.amount, inputmode: 'decimal', placeholder: '25', 'aria-label': 'Amount in USDC', id: 'amount' });
    const usd = h('div', { class: 'hint' }, F.amount && AMOUNT_RE.test(F.amount) ? 'USDC ≈ ' + usdcAsUsd(F.amount) : 'USDC is 1:1 with USD');
    amountIn.addEventListener('input', () => {
      const v = amountIn.value.trim();
      usd.textContent = AMOUNT_RE.test(v) ? 'USDC ≈ ' + usdcAsUsd(v) : 'Up to 6 decimals, e.g. 25 or 25.50';
    });
    const netSel = h(
      'select',
      { class: 'select', 'aria-label': 'Networks to compare' },
      h('option', { value: 'auto', selected: F.netFilter === 'auto' }, 'Auto (all networks)'),
      NET_IDS.map((id) => h('option', { value: id, selected: F.netFilter === id }, NET[id].name + ' only')),
    );
    const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Compare fees');
    const results = h('div', { style: 'margin-top:18px' });

    const run = async () => {
      const amount = amountIn.value.trim();
      const domain = domainIn ? domainIn.value.trim() : F.domain;
      if (!domain) return results.replaceChildren(notice('bad', 'Enter a Web3 domain.'));
      if (!AMOUNT_RE.test(amount) || Number(amount) <= 0) return results.replaceChildren(notice('bad', 'Enter a USDC amount greater than 0, with at most 6 decimals (e.g. 25 or 25.50).'));
      F.domain = domain;
      F.amount = amount;
      F.netFilter = netSel.value;
      await busy(btn, 'Comparing…', async () => {
        try {
          await requote();
          results.replaceChildren(routesTable(opts));
        } catch (e) {
          results.replaceChildren(notice('bad', e.message));
        }
      });
    };

    if (F.quote) results.appendChild(routesTable(opts));
    const form = h(
      'form',
      { onsubmit: (e) => (e.preventDefault(), run()) },
      domainIn ? h('div', { class: 'field', style: 'margin-bottom:14px' }, h('label', null, 'Recipient Web3 domain'), domainIn) : null,
      h(
        'div',
        { class: 'grid-3', style: 'grid-template-columns: 1fr 1fr 1.3fr' },
        h('div', { class: 'field' }, h('label', null, 'Token'), h('select', { class: 'select', 'aria-label': 'Token' }, h('option', null, 'USDC (native, Circle)'))),
        h('div', { class: 'field' }, h('label', { for: 'amount' }, 'Amount'), amountIn, usd),
        h('div', { class: 'field' }, h('label', null, 'Networks'), netSel),
      ),
      h('div', { class: 'row', style: 'margin-top:14px; justify-content:flex-end' }, btn),
    );
    if (opts.autorun && !F.quote && F.amount) setTimeout(run, 0);
    return h('div', null, form, results);
  }

  async function requote() {
    const F = S.flow;
    const body = { domain: F.domain, token: 'USDC', amount: F.amount };
    if (F.netFilter !== 'auto') body.networks = [F.netFilter];
    if (S.account) body.sender = S.account;
    const q = await api('POST', '/web-api/quotes', body);
    F.quote = q;
    F.domain = q.domain;
    const stillOk = F.selected && q.routes.some((r) => r.network === F.selected && r.eligible);
    if (!stillOk) F.selected = q.recommendedNetwork;
    return q;
  }

  function routesTable(opts) {
    const F = S.flow;
    const q = F.quote;
    const eligible = q.routes.filter((r) => r.eligible);
    const indicative = eligible.some((r) => r.quoteType === 'indicative');
    const body = h(
      'tbody',
      null,
      q.routes.map((r, i) => {
        const sel = r.eligible && F.selected === r.network;
        const radio = r.eligible
          ? h('input', { type: 'radio', class: 'radio', name: 'route', 'aria-label': 'Choose ' + r.networkName, checked: sel })
          : null;
        const pick = () => {
          if (!r.eligible) return;
          F.selected = r.network;
          body.querySelectorAll('tr.route').forEach((tr) => tr.classList.toggle('selected', tr.dataset.net === r.network));
          body.querySelectorAll('input.radio').forEach((x) => (x.checked = x.closest('tr').dataset.net === r.network));
          cont.disabled = false;
        };
        let status;
        if (!r.eligible) status = h('span', { class: 'badge badge-bad' }, 'Unavailable');
        else if (i === 0) status = h('span', { class: 'badge badge-ok' }, 'Best choice');
        else status = h('span', { class: 'badge badge-gray' }, 'Available');
        const total = r.fees ? fmtUsd(Number(q.amount) + Number(r.fees.expectedFeeUsd)) : '—';
        return h(
          'tr',
          { class: 'route' + (sel ? ' selected' : '') + (r.eligible ? '' : ' ineligible'), 'data-net': r.network, onclick: pick },
          h('td', null, h('div', { class: 'row' }, chain(r.network, 'chain-icon'), h('b', null, NET[r.network].short))),
          r.eligible
            ? [
                h('td', null, h('b', null, fmtUsd(r.fees.expectedFeeUsd)), h('div', { class: 'small muted' }, fmtNative(r.fees.expectedFeeNative, r.fees.nativeSymbol))),
                h('td', null, fmtUsd(r.fees.maxFeeUsd)),
                h('td', null, h('b', null, total)),
                h('td', null, confTime(r.network)),
              ]
            : h('td', { colspan: '4' }, h('div', { class: 'reason' }, (r.reasons || []).map((x) => x.message).join(' ') || 'Not available for this payment.')),
          h('td', null, status, r.eligible && r.quoteType === 'indicative' ? h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Indicative') : null),
          h('td', null, radio),
        );
      }),
    );
    const cont = h('button', { class: 'btn btn-primary btn-lg', type: 'button', disabled: !F.selected }, 'Continue', ico('arrowRight'));
    cont.addEventListener('click', async () => {
      if (expired(q.expiresAt)) {
        toast('Quote expired — refreshing fees…');
        try {
          await requote();
        } catch (e) {
          return toast(e.message, 'bad');
        }
        return opts.onRefreshed ? opts.onRefreshed() : render(true);
      }
      if (!S.account && !(await connectWallet())) return;
      opts.onContinue();
    });
    const refresh = h('button', { class: 'btn btn-ghost', type: 'button' }, ico('refresh'), 'Refresh');
    refresh.addEventListener('click', () =>
      busy(refresh, 'Refreshing…', async () => {
        try {
          await requote();
          opts.onRefreshed ? opts.onRefreshed() : render(true);
        } catch (e) {
          toast(e.message, 'bad');
        }
      }),
    );
    const gasSyms = Array.from(new Set(eligible.map((r) => r.fees.nativeSymbol))).join(' / ') || 'ETH / POL';
    return h(
      'div',
      { class: 'stack' },
      !S.account || indicative
        ? notice(
            'warn',
            h(
              'span',
              null,
              'Indicative fees. ',
              h('a', { href: '#', onclick: async (e) => (e.preventDefault(), (await connectWallet()) && refresh.click()) }, 'Connect your wallet'),
              ' for a live quote that also checks your USDC and gas balances.',
            ),
          )
        : null,
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          null,
          h('thead', null, h('tr', null, ['Network', 'Est. gas fee', 'Max gas fee', 'Total cost', 'Time to final', 'Status', ''].map((t) => h('th', null, t)))),
          body,
        ),
      ),
      h(
        'div',
        { class: 'row between wrap' },
        h(
          'div',
          { class: 'notice', style: 'flex:1; min-width:240px' },
          'Total = ' + q.amount + ' USDC + estimated network fee. You need a little ' + gasSyms + ' on the chosen network to pay gas. Quote expires in ',
          countdown(q.expiresAt),
          '.',
        ),
        h('div', { class: 'row' }, refresh, cont),
      ),
    );
  }

  function pageCompare() {
    return shell(
      h(
        'div',
        { class: 'card' },
        compareBlock({
          withDomain: true,
          onContinue: () => {
            S.flow.step = 3;
            navigate('/pay');
          },
        }),
      ),
      'Compare fees',
      'Live network fees for sending USDC to a Web3 domain, cheapest first. Only direct transfers: no bridges, no swaps.',
    );
  }

  /* ================================================================ PAY WIZARD */
  const STEPS = ['Domain', 'Compare', 'Review', 'Sign', 'Sent'];
  function stepper(cur) {
    return h(
      'div',
      { class: 'stepper', 'aria-label': 'Progress' },
      STEPS.map((s, i) => h('div', { class: 'step' + (i + 1 === cur ? ' active' : i + 1 < cur ? ' done' : '') }, h('span', { class: 'n' }, i + 1 < cur ? '✓' : i + 1), s)),
    );
  }
  function goStep(n) {
    S.flow.step = n;
    render();
  }

  function pagePay() {
    const F = S.flow;
    const qs = routeUrl().query;
    if (qs.get('to') || qs.get('amount')) {
      S.flow = freshFlow(qs.get('to') || DEFAULT_DOMAIN, qs.get('amount') || '');
      S.flow.autoResolve = !!qs.get('to');
      history.replaceState(null, '', toHref('/pay'));
      rendered = HASH ? location.hash : location.pathname;
      return pagePay();
    }
    const titles = ['1. Enter Web3 domain', '2. Compare payment options', '3. Review and prepare transfer', '4. Sign in your wallet', '5. Transaction sent'];
    let body;
    if (F.step === 1) body = stepDomain();
    else if (F.step === 2) body = stepCompare();
    else if (F.step === 3) body = stepReview();
    else if (F.step === 4) body = stepSign();
    else body = stepSent();
    return shell([stepper(F.step), h('h2', { class: 'page-title', style: 'margin-bottom:16px' }, titles[F.step - 1]), body], 'Send payment', 'Send USDC to any Web3 domain on the cheapest network. You sign in your own wallet.');
  }

  function stepDomain() {
    const F = S.flow;
    const auto = F.autoResolve;
    F.autoResolve = false;
    return h(
      'div',
      { class: 'card' },
      resolveBlock({
        domain: F.domain,
        initial: !auto && F.resolved && F.resolved.domain === F.domain ? F.resolved : null,
        autorun: auto,
        onResolved: (res) => {
          if (F.domain !== res.domain) {
            F.quote = null;
            F.selected = null;
          }
          F.domain = res.domain;
          F.resolved = res;
        },
        cta: {
          label: 'Continue',
          onClick: () => {
            F.step = 2;
            render();
          },
        },
      }),
    );
  }

  function stepCompare() {
    const F = S.flow;
    return h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'row small muted wrap' },
        'Paying ',
        h('b', { style: 'color:var(--ink)' }, F.domain),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => goStep(1) }, 'Change'),
      ),
      h(
        'div',
        { class: 'card' },
        compareBlock({
          autorun: true,
          onContinue: () => goStep(3),
          onRefreshed: () => render(true),
        }),
      ),
    );
  }

  function selectedRoute() {
    const F = S.flow;
    return F.quote && F.quote.routes.find((r) => r.network === F.selected && r.eligible);
  }

  function stepReview() {
    const F = S.flow;
    const r = selectedRoute();
    if (!r) {
      F.step = F.quote ? 2 : 1;
      return F.step === 2 ? stepCompare() : stepDomain();
    }
    const q = F.quote;
    const out = h('div');
    const checks = [
      'I verified the domain and recipient address',
      'I have enough USDC and ' + r.fees.nativeSymbol + ' (for gas) on ' + NET[r.network].short,
      'I understand the transaction is signed in my own wallet and cannot be reversed',
    ];
    const boxes = checks.map((c) => h('input', { type: 'checkbox' }));
    const prepareBtn = h('button', { class: 'btn btn-primary btn-lg', type: 'button', disabled: true }, 'Prepare transaction', ico('arrowRight'));
    const sync = () => (prepareBtn.disabled = !boxes.every((b) => b.checked));
    boxes.forEach((b) => b.addEventListener('change', sync));

    prepareBtn.addEventListener('click', async () => {
      if (!S.account && !(await connectWallet())) return;
      await busy(prepareBtn, 'Preparing…', async () => {
        try {
          if (expired(q.expiresAt)) await requote();
          if (!selectedRoute()) throw new Error('The selected network is no longer available. Compare again.');
          F.prep = await api('POST', '/web-api/transfers/prepare', { quoteId: F.quote.quoteId, sender: S.account, network: F.selected });
          F.step = 4;
          render();
        } catch (e) {
          if (e.code === 'QUOTE_EXPIRED' || e.code === 'QUOTE_NOT_FOUND') {
            F.quote = null;
            F.step = 2;
            toast('Quote expired — fees refreshed, please review again.');
            return render();
          }
          if (e.code === 'RECIPIENT_CHANGED') {
            F.quote = null;
            F.resolved = null;
            F.step = 1;
            toast(e.message, 'bad');
            return render();
          }
          out.replaceChildren(notice('bad', e.message));
        }
      });
    });

    const balances = r.sender
      ? h('div', { class: 'small muted' }, 'Your balance: ' + Number(r.sender.usdcBalance).toLocaleString('en-US', { maximumFractionDigits: 6 }) + ' USDC · ' + fmtNative(r.sender.nativeBalance, r.fees.nativeSymbol))
      : null;

    return h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'kv' },
          h('div', { class: 'k' }, 'Recipient'),
          h('div', { class: 'v' }, h('div', { class: 'row' }, svg(CHAIN_SVG.ud, 'chain-icon sm'), F.domain, copyBtn(r.recipient.address, 'recipient address')), h('span', { class: 'sub mono' }, r.recipient.address)),
          h('div', { class: 'k' }, 'Record used'),
          h('div', { class: 'v' }, h('span', { class: 'mono small' }, r.recipient.recordKey)),
          h('div', { class: 'k' }, 'Network'),
          h('div', { class: 'v' }, h('div', { class: 'row' }, chain(r.network, 'chain-icon sm'), NET[r.network].name, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => goStep(2) }, 'Change'))),
          h('div', { class: 'k' }, 'Token'),
          h(
            'div',
            { class: 'v' },
            h('div', { class: 'row' }, svg(CHAIN_SVG.usdc, 'chain-icon sm'), 'USDC', h('a', { class: 'mono small', href: NET[r.network].explorer + '/token/' + r.token.contract, target: '_blank', rel: 'noopener' }, short(r.token.contract))),
          ),
          h('div', { class: 'k' }, 'Amount'),
          h('div', { class: 'v' }, h('span', { class: 'big' }, q.amount + ' USDC'), h('span', { class: 'sub' }, '≈ ' + usdcAsUsd(q.amount))),
          h('div', { class: 'k' }, 'Estimated gas fee'),
          h('div', { class: 'v' }, fmtUsd(r.fees.expectedFeeUsd), h('span', { class: 'sub' }, fmtNative(r.fees.expectedFeeNative, r.fees.nativeSymbol))),
          h('div', { class: 'k' }, 'Maximum gas fee'),
          h('div', { class: 'v' }, fmtUsd(r.fees.maxFeeUsd), h('span', { class: 'sub' }, 'Upper bound your wallet may reserve; unused gas is not charged.')),
          h('div', { class: 'k' }, 'Estimated total'),
          h('div', { class: 'v' }, h('span', { class: 'big' }, fmtUsd(Number(q.amount) + Number(r.fees.expectedFeeUsd)))),
          h('div', { class: 'k' }, 'From'),
          h('div', { class: 'v' }, S.account ? h('span', { class: 'mono' }, S.account) : h('button', { class: 'btn btn-outline', type: 'button', onclick: async () => (await connectWallet()) && render(true) }, ico('wallet'), 'Connect wallet'), balances),
        ),
      ),
      r.warnings && r.warnings.length ? notice('warn', 'Warnings for this route:', r.warnings) : null,
      h(
        'div',
        { class: 'card row between wrap', style: 'align-items:flex-end' },
        h('div', null, h('b', null, 'Before you continue'), h('ul', { class: 'checklist' }, checks.map((c, i) => h('li', null, h('label', null, boxes[i], c))))),
        prepareBtn,
      ),
      out,
    );
  }

  /** Decode ERC-20 transfer(address,uint256) calldata locally rather than trusting the server summary. */
  function decodeTransfer(data) {
    const d = String(data).toLowerCase();
    if (!d.startsWith(TRANSFER_SELECTOR) || d.length !== 10 + 128) return null;
    const word = d.slice(10, 74);
    if (!/^0{24}/.test(word)) return null;
    return { recipient: '0x' + word.slice(24), amountRaw: BigInt('0x' + d.slice(74, 138)).toString() };
  }
  function localChecks(prep) {
    const tx = prep.unsignedTransaction;
    const dec = decodeTransfer(tx.data);
    const list = [
      ['Call data is a standard USDC transfer', !!dec],
      ['Encoded recipient matches ' + short(prep.decoded.recipient), !!dec && dec.recipient === prep.decoded.recipient.toLowerCase()],
      ['Encoded amount matches ' + prep.approvalSummary.amount, !!dec && dec.amountRaw === prep.decoded.amountRaw],
      ['Transaction targets the official USDC contract', tx.to.toLowerCase() === prep.decoded.tokenContract.toLowerCase()],
      ['Chain ID matches ' + NET[prep.network].name, parseInt(tx.chainId, 16) === prep.chainId],
      ['No ' + NET[prep.network].gas + ' is sent (value = 0)', tx.value === '0x0'],
      ['Connected wallet is the sender', !!S.account && S.account === tx.from.toLowerCase()],
      ['Not expired', !expired(prep.expiresAt)],
    ];
    return { ok: list.every((x) => x[1]), list };
  }

  function stepSign() {
    const F = S.flow;
    const p = F.prep;
    if (!p) {
      F.step = 3;
      return stepReview();
    }
    const r = p.route || selectedRoute();
    const status = h('div');
    const checks = localChecks(p);
    const confirmBtn = h('button', { class: 'btn btn-primary btn-lg', type: 'button', disabled: !checks.ok }, 'Confirm in wallet');
    const cancel = h('button', { class: 'btn btn-outline btn-lg', type: 'button', onclick: () => ((F.prep = null), goStep(3)) }, 'Cancel');
    const fees = selectedRoute() && selectedRoute().fees;

    confirmBtn.addEventListener('click', async () => {
      if (!eth()) return connectWallet();
      cancel.disabled = true;
      await busy(confirmBtn, 'Working…', async () => {
        try {
          status.replaceChildren(notice('', 'Re-checking recipient record, balances and fees…'));
          await api('POST', '/web-api/transfers/' + p.preparationId + '/recheck', {});
          const c = localChecks(p);
          if (!c.ok) throw new Error('Local safety checks failed; nothing was sent to your wallet.');
          await ensureChain(p);
          status.replaceChildren(notice('', 'Waiting for your approval in the wallet…'));
          const tx = p.unsignedTransaction;
          const hash = await eth().request({
            method: 'eth_sendTransaction',
            params: [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }],
          });
          F.txHash = hash;
          F.submittedAt = new Date().toISOString();
          F.verify = null;
          history_.upsert({
            txHash: hash,
            network: p.network,
            domain: p.approvalSummary.domain,
            recipient: p.decoded.recipient,
            amount: F.quote ? F.quote.amount : p.approvalSummary.amount.replace(/ USDC$/, ''),
            from: tx.from,
            time: F.submittedAt,
            status: 'submitted',
            estFeeUsd: fees ? fees.expectedFeeUsd : null,
            preparationId: p.preparationId,
          });
          F.step = 5;
          render();
          startPolling();
        } catch (e) {
          cancel.disabled = false;
          let msg = e && e.code === 4001 ? 'You rejected the request in your wallet. Nothing was sent.' : 'Not sent: ' + ((e && e.message) || e);
          if (e && (e.code === 'PREPARATION_EXPIRED' || e.code === 'PREPARATION_NOT_FOUND')) msg = 'This prepared transfer expired. Go back and prepare it again.';
          if (e && e.code === 'RECIPIENT_CHANGED') msg = e.message;
          status.replaceChildren(notice('bad', msg));
        }
      });
    });

    return h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted', style: 'margin:0' }, 'A transaction request will open in your wallet. This page never sees your keys.'),
      h(
        'div',
        { class: 'sign-card' },
        h('div', { class: 'sign-head' }, h('span', { class: 'row' }, ico('wallet', 'chain-icon sm'), 'Wallet request'), h('span', { class: 'row small' }, chain(p.network, 'chain-icon sm'), NET[p.network].short)),
        h(
          'div',
          { class: 'sign-body' },
          h('div', { class: 'sign-amount' }, svg(CHAIN_SVG.usdc), h('div', null, h('div', { class: 'muted small' }, 'Send USDC'), h('div', { class: 'big' }, p.approvalSummary.amount), h('div', { class: 'small muted' }, '≈ ' + usdcAsUsd(p.decoded.amountRaw / 1e6)))),
          h(
            'div',
            { class: 'kv', style: 'grid-template-columns:110px minmax(0,1fr)' },
            h('div', { class: 'k' }, 'To'),
            h('div', { class: 'v' }, h('span', { class: 'mono' }, short(p.decoded.recipient, 8)), h('span', { class: 'sub' }, '(' + p.approvalSummary.domain + ')')),
            h('div', { class: 'k' }, 'Network'),
            h('div', { class: 'v' }, NET[p.network].name + ' · chain ' + p.chainId),
            h('div', { class: 'k' }, 'Gas fee'),
            h('div', { class: 'v' }, r && r.fees ? fmtNative(r.fees.expectedFeeNative, r.fees.nativeSymbol) + ' (' + fmtUsd(r.fees.expectedFeeUsd) + ')' : p.approvalSummary.estimatedNetworkFee, h('span', { class: 'sub' }, 'max ' + p.approvalSummary.maximumNetworkFee)),
            h('div', { class: 'k' }, 'Expires in'),
            h('div', { class: 'v' }, countdown(p.expiresAt)),
          ),
        ),
        h('div', { class: 'sign-foot' }, cancel, confirmBtn),
      ),
      h('div', { class: 'card', style: 'max-width:480px' }, h('div', { class: 'card-title' }, 'Independent checks (run in this browser)'), h('ul', { class: 'checks' }, checks.list.map(([t, ok]) => h('li', { class: ok ? '' : 'fail' }, t)))),
      status,
      h('p', { class: 'small muted', style: 'margin:0; max-width:480px' }, 'Always verify the domain, address, network and amount in your wallet before confirming.'),
    );
  }

  function stepSent() {
    const F = S.flow;
    const v = F.verify;
    const p = F.prep;
    const network = p ? p.network : F.selected;
    const st = v ? v.status : 'submitted';
    const failed = st === 'failed' || st === 'mismatch';
    const final = st === 'confirmed';
    const confText = v && v.confirmations != null ? ' (' + Math.min(v.confirmations, v.requiredConfirmations) + '/' + v.requiredConfirmations + ' confirmations)' : '';
    const label = {
      submitted: 'Submitted — waiting for the network',
      not_found: 'Broadcasting — not visible on-chain yet',
      pending: 'Pending — not in a block yet',
      awaiting_confirmations: 'Confirming' + confText,
      confirmed: 'Confirmed' + confText,
      failed: 'Failed',
      mismatch: 'Does not match the prepared transfer',
    }[st];
    const explorer = NET[network].explorer + '/tx/' + F.txHash;
    const dotColor = final ? 'var(--ok)' : failed ? 'var(--bad)' : 'var(--warn)';
    const progressStep = (cls, text, inner) => h('div', { class: 'p ' + cls }, h('div', { class: 'dot' }, inner || null), text);
    return h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'success-banner' + (failed ? ' bad' : '') },
          h('div', { class: 'ok-ico' }, ico(failed ? 'x' : 'check', 'chain-icon sm')),
          h(
            'div',
            null,
            h('b', { style: 'font-size:17px' }, failed ? 'Transaction failed' : final ? 'Payment confirmed' : 'Transaction submitted'),
            h('div', { class: 'small' }, failed ? (v && v.message) || '' : final ? 'The USDC transfer is final on-chain and matches what you approved.' : 'Your payment is on the blockchain. Waiting for confirmations — not final yet.'),
          ),
        ),
        h(
          'div',
          { class: 'kv', style: 'margin-top:16px' },
          h('div', { class: 'k' }, 'Transaction hash'),
          h('div', { class: 'v' }, h('div', { class: 'row wrap' }, h('span', { class: 'mono' }, short(F.txHash, 10)), copyBtn(F.txHash, 'transaction hash'), h('a', { href: explorer, target: '_blank', rel: 'noopener', class: 'small' }, 'View on block explorer ↗'))),
          h('div', { class: 'k' }, 'Network'),
          h('div', { class: 'v' }, h('div', { class: 'row' }, chain(network, 'chain-icon sm'), NET[network].name)),
          h('div', { class: 'k' }, 'Status'),
          h('div', { class: 'v' }, h('span', { class: 'row' }, h('span', { style: 'width:10px;height:10px;border-radius:50%;background:' + dotColor }), label)),
          h('div', { class: 'k' }, 'Amount'),
          h('div', { class: 'v' }, (v && v.transfer ? v.transfer.amount : F.quote ? F.quote.amount : '') + ' USDC'),
          h('div', { class: 'k' }, 'Recipient'),
          h('div', { class: 'v' }, p ? p.approvalSummary.domain : F.domain, p ? h('span', { class: 'sub mono' }, p.decoded.recipient) : null),
          h('div', { class: 'k' }, v && v.actualFee ? 'Network fee paid' : 'Estimated fee'),
          h('div', { class: 'v' }, v && v.actualFee ? fmtNative(v.actualFee.native, v.actualFee.nativeSymbol) : selectedRoute() ? fmtUsd(selectedRoute().fees.expectedFeeUsd) : '—'),
          h('div', { class: 'k' }, 'Time'),
          h('div', { class: 'v' }, F.submittedAt ? fmtTime(F.submittedAt) : ''),
        ),
        h(
          'div',
          { class: 'progress' },
          progressStep('done', 'Submitted', ico('check', 'chain-icon sm')),
          failed ? progressStep('bad', 'Failed', ico('x', 'chain-icon sm')) : progressStep(final ? 'done' : 'now', 'Confirming', final ? ico('check', 'chain-icon sm') : null),
          progressStep(final ? 'done' : '', 'Completed', final ? ico('check', 'chain-icon sm') : null),
        ),
      ),
      h(
        'div',
        { class: 'row wrap' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ((S.flow = freshFlow()), stopPolling(), render()) }, 'Send another payment'),
        link('/history', { class: 'btn btn-outline' }, 'View history'),
      ),
    );
  }

  /* ---------------------------------------------------------------- verification polling */
  function stopPolling() {
    if (S.polling) clearTimeout(S.polling);
    S.polling = null;
  }
  async function verifyTx(txHash, network, preparationId) {
    try {
      return await api('POST', '/web-api/transfers/verify', preparationId ? { txHash, preparationId } : { txHash, network });
    } catch (e) {
      if (preparationId && e.code === 'PREPARATION_NOT_FOUND') return api('POST', '/web-api/transfers/verify', { txHash, network });
      throw e;
    }
  }
  function startPolling() {
    stopPolling();
    const F = S.flow;
    const hash = F.txHash;
    const started = Date.now();
    const tick = async () => {
      if (S.flow.txHash !== hash) return;
      try {
        const v = await verifyTx(hash, F.prep.network, F.prep.preparationId);
        F.verify = v;
        history_.patch(hash, { status: v.status, actualFee: v.actualFee || null, confirmations: v.confirmations || null });
        if (curPath() === '/pay' && S.flow.step === 5) render(true);
        if (v.status === 'confirmed') return toast('Payment confirmed on ' + NET[v.network].short);
        if (v.status === 'failed' || v.status === 'mismatch') return;
      } catch (e) {
        /* transient; keep polling */
      }
      if (Date.now() - started < 30 * 60_000) S.polling = setTimeout(tick, 5000);
    };
    S.polling = setTimeout(tick, 3000);
  }

  /* ================================================================ HISTORY */
  function statusBadge(s) {
    const map = {
      confirmed: ['badge-ok-soft', 'Confirmed'],
      awaiting_confirmations: ['badge-blue', 'Confirming'],
      pending: ['badge-blue', 'Pending'],
      submitted: ['badge-blue', 'Submitted'],
      not_found: ['badge-gray', 'Not found'],
      failed: ['badge-bad', 'Failed'],
      mismatch: ['badge-bad', 'Mismatch'],
    };
    const [c, t] = map[s] || ['badge-gray', s];
    return h('span', { class: 'badge ' + c }, t);
  }
  function pageHistory() {
    const filter = h(
      'select',
      { class: 'select', style: 'width:auto; height:38px', 'aria-label': 'Filter by network' },
      h('option', { value: '' }, 'All networks'),
      NET_IDS.map((id) => h('option', { value: id }, NET[id].short)),
    );
    const tableBox = h('div');
    const draw = () => {
      const list = history_.all().filter((e) => !filter.value || e.network === filter.value);
      if (!list.length) {
        tableBox.replaceChildren(
          h('div', { class: 'empty' }, ico('inbox'), h('div', null, 'No payments yet in this browser.'), h('div', { style: 'margin-top:12px' }, link('/pay', { class: 'btn btn-primary' }, 'Send a payment'))),
        );
        return;
      }
      tableBox.replaceChildren(
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'hist' },
            h('thead', null, h('tr', null, ['Date & time', 'Domain', 'Amount', 'Network', 'Status', 'Tx hash'].map((t) => h('th', null, t)))),
            h(
              'tbody',
              null,
              list.map((e) =>
                h(
                  'tr',
                  null,
                  h('td', null, fmtTime(e.time)),
                  h('td', null, h('b', null, e.domain), h('div', { class: 'small muted mono' }, short(e.recipient))),
                  h('td', null, h('b', null, e.amount + ' USDC'), h('div', { class: 'small muted' }, usdcAsUsd(e.amount))),
                  h('td', null, h('div', { class: 'row' }, chain(e.network, 'chain-icon sm'), NET[e.network].short)),
                  h('td', null, statusBadge(e.status)),
                  h('td', null, h('div', { class: 'row' }, h('a', { class: 'mono small', href: NET[e.network].explorer + '/tx/' + e.txHash, target: '_blank', rel: 'noopener' }, short(e.txHash, 8)), copyBtn(e.txHash, 'transaction hash'))),
                ),
              ),
            ),
          ),
        ),
      );
    };
    filter.addEventListener('change', draw);
    draw();
    const refresh = h('button', { class: 'btn btn-outline', type: 'button' }, ico('refresh'), 'Refresh status');
    refresh.addEventListener('click', () =>
      busy(refresh, 'Checking…', async () => {
        const open = history_.all().filter((e) => e.status !== 'confirmed' && e.status !== 'failed' && e.status !== 'mismatch');
        for (const e of open) {
          try {
            const v = await verifyTx(e.txHash, e.network);
            history_.patch(e.txHash, { status: v.status });
          } catch (err) {
            /* leave as is */
          }
        }
        draw();
        toast(open.length ? 'Checked ' + open.length + ' open payment' + (open.length > 1 ? 's' : '') : 'Everything is already final');
      }),
    );
    const clear = h('button', { class: 'btn btn-ghost', type: 'button' }, ico('trash'), 'Clear');
    clear.addEventListener('click', () => {
      if (!history_.all().length || !confirm('Remove all payment history from this browser? On-chain transactions are not affected.')) return;
      store.set('history', []);
      draw();
    });
    return shell(
      [h('div', { class: 'row wrap', style: 'margin-bottom:16px; justify-content:flex-end' }, clear, refresh, filter), h('div', { class: 'card' }, tableBox)],
      'Payment history',
      'Payments sent from this browser. Stored only on this device.',
    );
  }

  /* ================================================================ SAVED */
  function pageSaved() {
    const input = h('input', { class: 'input', placeholder: 'Add a domain, e.g. brahmayya.wallet', 'aria-label': 'Domain to save', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
    const listBox = h('div', { class: 'addr-list' });
    const draw = () => {
      const list = saved.all();
      if (!list.length) {
        listBox.replaceChildren(
          h('div', { class: 'empty' }, ico('bookmark'), h('div', null, 'No saved domains yet.'), h('button', { class: 'btn btn-outline', style: 'margin-top:12px', type: 'button', onclick: () => (saved.toggle(DEFAULT_DOMAIN), draw()) }, 'Save ' + DEFAULT_DOMAIN)),
        );
        return;
      }
      listBox.replaceChildren(
        ...list.map((d) =>
          h(
            'div',
            { class: 'addr' },
            h('div', { class: 'net' }, svg(CHAIN_SVG.ud, 'chain-icon'), d),
            h('div', { class: 'row' }, link('/resolve?d=' + encodeURIComponent(d), { class: 'btn btn-outline' }, 'Resolve'), link('/pay?to=' + encodeURIComponent(d), { class: 'btn btn-primary' }, 'Pay'), h('button', { class: 'copy', type: 'button', title: 'Remove', 'aria-label': 'Remove ' + d, onclick: () => (saved.toggle(d), draw()) }, ico('trash'))),
          ),
        ),
      );
    };
    draw();
    return shell(
      h(
        'div',
        { class: 'card' },
        h(
          'form',
          {
            class: 'input-row',
            style: 'margin-bottom:16px',
            onsubmit: (e) => {
              e.preventDefault();
              const d = input.value.trim().toLowerCase();
              if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return toast('Enter a domain like name.crypto', 'bad');
              if (!saved.has(d)) saved.toggle(d);
              input.value = '';
              draw();
            },
          },
          input,
          h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Save'),
        ),
        listBox,
      ),
      'Saved domains',
      'Quick access to Web3 names you pay often. Stored only in this browser.',
    );
  }

  /* ================================================================ NETWORKS */
  function pageNetworks() {
    const box = h('div', { class: 'grid-3' }, h('div', { class: 'muted' }, 'Loading networks…'));
    loadNetworks()
      .then((n) => {
        box.replaceChildren(
          ...n.networks.map((x) =>
            h(
              'div',
              { class: 'card net-card' },
              h('header', null, chain(x.id, ' '), h('div', null, h('h3', null, x.name), h('div', { class: 'small muted' }, 'Chain ID ' + x.chainId)), h('span', { class: 'badge ' + (x.configured ? 'badge-ok-soft' : 'badge-gray'), style: 'margin-left:auto' }, x.configured ? 'Live' : 'Not configured')),
              h(
                'ul',
                { class: 'feat-list' },
                h('li', null, 'USDC (' + x.tokenStandard + ', native, Circle)'),
                h('li', null, 'Gas paid in ' + x.gasToken),
                h('li', null, x.feeModel),
                h('li', null, x.requiredConfirmations + ' confirmations (' + confTime(x.id) + ')'),
              ),
              h('div', { class: 'small' }, h('span', { class: 'muted' }, 'USDC contract '), h('a', { class: 'mono', href: NET[x.id].explorer + '/token/' + x.usdc.contract, target: '_blank', rel: 'noopener' }, short(x.usdc.contract, 8))),
            ),
          ),
        );
      })
      .catch((e) => box.replaceChildren(notice('bad', e.message)));
    return shell(
      [box, h('div', { style: 'margin-top:16px' }, notice('', 'More networks (Arbitrum, Optimism and others) will be added based on demand.'))],
      'Supported networks',
      'Direct USDC transfers only. Bridged tokens (USDC.e, USDbC) are never used.',
    );
  }

  /* ================================================================ PRICING */
  function pagePricing() {
    const box = h('div', { class: 'plan-grid' }, h('div', { class: 'muted' }, 'Loading plans…'));
    const info = h('div');
    api('GET', '/web-api/plans')
      .then((b) => {
        const nets = b.networks.filter((n) => n.configured).map((n) => n.name);
        info.replaceChildren(
          notice(
            '',
            h(
              'span',
              null,
              'Crypto only: pay ',
              h('b', null, b.currency),
              ' from your own wallet to ',
              h('b', null, b.payTo),
              nets.length ? ' on ' + nets.join(', ') : '',
              '. The payment is verified on-chain before your API key is issued. No cards or bank transfers.',
            ),
          ),
        );
        box.replaceChildren(
          ...b.plans.map((p) =>
            h(
              'article',
              { class: 'plan-card' },
              h('h3', null, p.name),
              h('div', { class: 'plan-price' }, h('b', null, p.priceUsdc), ' USDC'),
              h('div', { class: 'muted small' }, 'per ' + p.periodDays + ' days'),
              h('ul', { class: 'feat-list' }, h('li', null, p.callsPerPeriod.toLocaleString('en-US') + ' API / MCP calls'), p.description ? h('li', null, p.description) : null, h('li', null, 'Renew any time with USDC')),
              h('a', { class: 'btn btn-primary btn-lg btn-block', href: (CFG.apiBase || '') + '/subscribe?plan=' + encodeURIComponent(p.id), rel: 'noopener' }, 'Subscribe'),
            ),
          ),
        );
      })
      .catch((e) => box.replaceChildren(notice('bad', e.code === 'BILLING_DISABLED' ? 'Subscriptions are not enabled on this server.' : e.message)));
    return shell(
      [
        notice('ok', 'Sending payments on this website is free. Plans are for developers and AI agents using the MCP server and REST API.'),
        h('div', { style: 'height:16px' }),
        box,
        h('div', { style: 'height:16px' }),
        info,
      ],
      'API pricing',
      'Subscribe with USDC to use the MCP server and REST API from your own apps and AI agents.',
    );
  }

  /* ================================================================ DOCS */
  function pageDocs() {
    const origin = CFG.apiBase || location.origin;
    const tabs = [
      ['mcp', 'MCP (AI tools)'],
      ['rest', 'REST API'],
      ['flow', 'How payments work'],
    ];
    let active = 'mcp';
    const tabBar = h('div', { class: 'tabs', role: 'tablist' });
    const panel = h('div');
    const tools = [
      ['resolve_web3_domain', 'USDC receiving address per network, with the exact UD record key used', 'read-only'],
      ['get_supported_networks', 'Allowlisted networks, official USDC contracts, gas tokens, fee models', 'read-only'],
      ['estimate_transfer_fee', 'Fee for one network (live with a sender, indicative without)', 'read-only'],
      ['compare_payment_routes', 'Ranks direct routes by expected USD cost; returns quoteId', 'stores quote'],
      ['prepare_transfer', 'Re-validates, simulates, returns an unsigned tx + approvalUrl', 'no signing'],
      ['verify_transfer', 'Receipt, official contract, Transfer event, confirmations', 'read-only'],
      ['get_transfer', 'Fetch a quote (q_…) or preparation (p_…)', 'read-only'],
      ['get_subscription_plans', 'Plans, prices in USDC and the billing domain', 'free'],
      ['get_my_subscription', 'Your plan, period end and calls used', 'free'],
      ['create_subscription_invoice', 'USDC invoice payable to the billing domain', 'free'],
      ['confirm_subscription_payment', 'Verifies the payment on-chain; issues or extends the key', 'free'],
    ];
    const rest = [
      ['GET', '/health', 'Health (public)'],
      ['POST', '/api/resolve', '{ domain }'],
      ['GET', '/api/networks', 'Supported networks'],
      ['POST', '/api/fees/estimate', '{ domain, amount, network, sender? }'],
      ['POST', '/api/quotes', '{ domain, amount, token?, networks?, sender? }'],
      ['POST', '/api/transfers/prepare', '{ quoteId, sender, network }'],
      ['POST', '/api/transfers/verify', '{ txHash, network?, preparationId? }'],
      ['GET', '/api/transfers/:id', 'Quote or preparation'],
    ];
    const toolCall = JSON.stringify({ tool: 'compare_payment_routes', arguments: { domain: 'thomaszacharias.nft', token: 'USDC', amount: '25', networks: ['ethereum', 'base', 'polygon'] } }, null, 2);
    const clientCfg = JSON.stringify({ mcpServers: { 'thomaszacharias-pay': { type: 'http', url: origin + '/mcp', headers: { Authorization: 'Bearer <YOUR_API_KEY>' } } } }, null, 2);
    const curl = "curl -X POST " + origin + "/api/quotes \\\n  -H 'Authorization: Bearer <YOUR_API_KEY>' \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"domain\":\"thomaszacharias.nft\",\"amount\":\"25\"}'";
    const docTable = (head, rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'doc-table' }, h('thead', null, h('tr', null, head.map((t) => h('th', null, t)))), h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', null, i === 0 ? h('code', null, c) : c)))))));
    const views = {
      mcp: () => [
        h('h3', { class: 'doc-h', id: 'mcp' }, 'MCP endpoint'),
        h('div', { class: 'endpoint' }, h('code', { class: 'mono' }, origin + '/mcp'), copyBtn(origin + '/mcp', 'MCP endpoint')),
        h('p', { class: 'small muted' }, 'Streamable HTTP, stateless JSON responses. Use POST only.'),
        h('h3', { class: 'doc-h', id: 'auth' }, 'Authentication'),
        h('p', { class: 'small' }, 'Send ', h('code', null, 'Authorization: Bearer <API key>'), '. Get a key by subscribing with USDC (', link('/pricing', null, 'see pricing'), '); operators can also issue keys via ', h('code', null, 'API_KEYS'), '. Never put a key in client-side code.'),
        h('pre', { class: 'code' }, clientCfg),
        h('h3', { class: 'doc-h', id: 'tools' }, 'Tools'),
        docTable(['Tool', 'What it does', 'Side effects'], tools),
        h('h3', { class: 'doc-h' }, 'Example tool call'),
        h('pre', { class: 'code' }, toolCall),
        h('p', { class: 'small muted' }, 'Typical flow: compare_payment_routes (with sender) → show recipient, network, amount and fees → the user picks a network → prepare_transfer → the user opens approvalUrl and signs → verify_transfer until confirmed.'),
      ],
      rest: () => [
        h('h3', { class: 'doc-h', id: 'api' }, 'REST API'),
        h('p', { class: 'small' }, 'Same logic as the MCP tools. All /api routes need a bearer API key. Amounts are decimal strings ("25", "25.50"), max 6 decimals.'),
        docTable(['Path', 'Method', 'Body / purpose'], rest.map(([m, p, d]) => [p, m, d])),
        h('h3', { class: 'doc-h' }, 'Example'),
        h('pre', { class: 'code' }, curl),
        h('h3', { class: 'doc-h', id: 'limits' }, 'Rate limits'),
        h('p', { class: 'small' }, 'Per API key per minute (default 60). The web app is limited per IP. Responses carry RateLimit-Limit / RateLimit-Remaining; 429 includes Retry-After.'),
      ],
      flow: () => [
        h('h3', { class: 'doc-h', id: 'security' }, 'Security model'),
        h(
          'ul',
          { class: 'feat-list' },
          h('li', null, 'The server never holds keys, signs, broadcasts, bridges or swaps.'),
          h('li', null, 'Recipient addresses come only from USDC records on the Unstoppable Domains name. crypto.ETH.address is never used as a USDC address.'),
          h('li', null, 'Before your wallet opens, the domain record, balances and fees are re-checked, and the calldata is decoded in your browser.'),
          h('li', null, 'Only official Circle USDC contracts are allowlisted on each network.'),
          h('li', null, 'A payment is reported as complete only after the on-chain Transfer event matches and the required confirmations are reached.'),
        ),
        h('h3', { class: 'doc-h' }, 'Record lookup order (per network)'),
        h('pre', { class: 'code' }, '1. token.EVM.<NET>.USDC.address   (ETH, BASE, MATIC)\n2. crypto.USDC.address             (warning: network not specified)\n3. crypto.USDC.version.ERC20 / MATIC.address\n4. token.EVM.<NET>.address          (warning: not USDC-specific)\n5. token.EVM.address                (warning: one address for all EVM chains)'),
        h('h3', { class: 'doc-h' }, 'Receiving USDC at your own domain'),
        h('p', { class: 'small' }, 'In your Unstoppable Domains dashboard, add a USDC address for each network you want to receive on (Ethereum, Base, Polygon). Chain-specific USDC records are the most precise.'),
      ],
    };
    const show = (id) => {
      active = id;
      tabBar.replaceChildren(...tabs.map(([t, l]) => h('button', { class: 'tab' + (t === active ? ' active' : ''), role: 'tab', 'aria-selected': String(t === active), type: 'button', onclick: () => show(t) }, l)));
      panel.replaceChildren(...views[id]());
    };
    show('mcp');
    const jump = (tab, anchor, label) => h('a', { href: '#' + anchor, onclick: (e) => { e.preventDefault(); show(tab); setTimeout(() => { const el = $(anchor); if (el) el.scrollIntoView({ behavior: 'smooth' }); }, 0); } }, label);
    return h(
      'div',
      null,
      banner('Developers', 'Connect AI assistants over MCP or call the REST API. Both use the same validation and safety checks as this website.'),
      h(
        'main',
        { class: 'shell page', style: 'grid-template-columns:minmax(0,1fr)' },
        h(
          'div',
          { class: 'docs-layout' },
          h('div', { class: 'card' }, tabBar, panel),
          h(
            'div',
            { class: 'card' },
            h('div', { class: 'card-title' }, 'Quick links'),
            h('div', { class: 'quick-links' }, jump('mcp', 'mcp', 'MCP integration guide'), jump('mcp', 'tools', 'Tool reference'), jump('rest', 'api', 'API reference'), jump('mcp', 'auth', 'Authentication'), jump('rest', 'limits', 'Rate limits'), jump('flow', 'security', 'Security model')),
          ),
        ),
      ),
    );
  }

  /* ---------------------------------------------------------------- boot */
  function renderThemeBtn() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    $('themeBtn').replaceChildren(ico(dark ? 'sun' : 'moon'));
    return dark;
  }
  $('themeBtn').addEventListener('click', () => {
    const next = renderThemeBtn() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.set('theme', next);
    try {
      localStorage.setItem('tz.theme', next);
    } catch (e) {
      /* blocked */
    }
    renderThemeBtn();
  });
  $('menuBtn').replaceChildren(ico('menu'));
  $('searchBtn').replaceChildren(ico('search'));
  $('toTop').replaceChildren(svg('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>'));
  $('toTop').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  $('menuBtn').addEventListener('click', () => {
    const open = $('nav').classList.toggle('open');
    $('menuBtn').setAttribute('aria-expanded', String(open));
  });
  $('walletBtn').addEventListener('click', async () => {
    if (!S.account) return connectWallet();
    try {
      await navigator.clipboard.writeText(S.account);
      toast('Address copied');
    } catch (e) {
      toast(S.account);
    }
  });

  // Static header links are written as paths; point them at the active router.
  document.querySelectorAll('a[data-link]').forEach((a) => {
    const p = a.getAttribute('data-path') || a.getAttribute('href');
    a.setAttribute('data-path', p);
    a.setAttribute('href', toHref(p));
  });
  renderThemeBtn();
  renderWalletBtn();
  if (eth()) {
    eth()
      .request({ method: 'eth_accounts' })
      .then((a) => a && a[0] && setAccount(a[0]))
      .catch(() => {});
    if (eth().on) {
      eth().on('accountsChanged', (a) => setAccount(a && a[0]));
      eth().on('chainChanged', (c) => (S.chainId = parseInt(c, 16)));
    }
  }
  loadNetworks().catch(() => {});
  render();
})();
