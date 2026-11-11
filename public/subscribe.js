/* Subscription checkout: USDC only, paid from the user's own EIP-1193 wallet. No third-party code. */
(function () {
  'use strict';
  const $ = (s) => document.getElementById(s);
  const TRANSFER_SELECTOR = '0xa9059cbb';
  let plans = null;
  let selected = null;
  let account = null;
  let invoice = null;

  function status(text, kind) {
    const el = $('result');
    el.hidden = false;
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  async function api(path, opts) {
    const res = await fetch('/billing' + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body.error && body.error.message) || 'Request failed (' + res.status + ')');
    return body;
  }

  function refresh() {
    $('create').disabled = !(selected && account && $('network').value);
  }

  function renderPlans() {
    $('payto').textContent = plans.payTo;
    $('plans').innerHTML = '';
    plans.plans.forEach((p) => {
      const d = document.createElement('div');
      d.className = 'plan';
      const name = document.createElement('strong');
      name.textContent = p.name;
      const price = document.createElement('div');
      price.className = 'price';
      price.textContent = p.priceUsdc + ' USDC';
      const meta = document.createElement('div');
      meta.className = 'sub';
      meta.style.margin = '0';
      meta.textContent = p.callsPerPeriod.toLocaleString() + ' calls / ' + p.periodDays + ' days. ' + (p.description || '');
      d.append(name, price, meta);
      d.addEventListener('click', () => {
        selected = p.id;
        document.querySelectorAll('.plan').forEach((x) => x.classList.remove('sel'));
        d.classList.add('sel');
        refresh();
      });
      $('plans').appendChild(d);
    });
    $('network').innerHTML = '';
    plans.networks.filter((n) => n.configured).forEach((n) => {
      const o = document.createElement('option');
      o.value = n.id;
      o.textContent = n.name;
      $('network').appendChild(o);
    });
    if (!$('network').options.length) status('No payment networks are configured on this server yet.', 'err');
  }

  function renderInvoice() {
    $('choose').hidden = true;
    $('invoice').hidden = false;
    $('i-plan').textContent = invoice.plan.name || invoice.plan.id;
    $('i-amount').textContent = invoice.amount;
    $('i-domain').textContent = invoice.payTo.domain;
    $('i-treasury').textContent = invoice.payTo.address;
    $('i-network').textContent = invoice.networkName + ' (chain ID ' + invoice.chainId + ')';
    $('i-token').textContent = invoice.tokenContract;
    $('i-payer').textContent = invoice.payer;
    $('i-expires').textContent = new Date(invoice.expiresAt).toLocaleString();
    $('pay').disabled = invoice.status !== 'awaiting_payment';
    if (invoice.status === 'paid' || invoice.txHash) poll(invoice.txHash);
  }

  /** Local check that the transaction pays exactly the shown wallet and amount. */
  function checkTx() {
    const tx = invoice.unsignedTransaction;
    const d = String(tx.data).toLowerCase();
    if (!d.startsWith(TRANSFER_SELECTOR) || d.length !== 138) return 'Unexpected call data';
    if ('0x' + d.slice(34, 74) !== invoice.payTo.address.toLowerCase()) return 'Encoded recipient does not match the shown wallet';
    if (BigInt('0x' + d.slice(74)).toString() !== invoice.amountRaw) return 'Encoded amount does not match the invoice';
    if (tx.to.toLowerCase() !== invoice.tokenContract.toLowerCase()) return 'Transaction does not target the USDC contract shown';
    if (parseInt(tx.chainId, 16) !== invoice.chainId || tx.value !== '0x0') return 'Chain or value mismatch';
    if (account && account.toLowerCase() !== invoice.payer.toLowerCase()) return 'Connected wallet is not the invoice payer';
    return null;
  }

  async function connect() {
    if (!window.ethereum) return status('No browser wallet found. Open this page in a wallet browser or install MetaMask / Coinbase Wallet.', 'err');
    try {
      const a = await window.ethereum.request({ method: 'eth_requestAccounts' });
      account = a && a[0];
      $('connect').textContent = 'Connected: ' + account.slice(0, 6) + '…' + account.slice(-4);
      refresh();
    } catch (e) {
      status(e.code === 4001 ? 'Wallet connection rejected.' : 'Wallet connection failed: ' + e.message, 'err');
    }
  }

  async function create() {
    try {
      invoice = await api('/invoices', { method: 'POST', body: JSON.stringify({ plan: selected, network: $('network').value, payer: account }) });
      history.replaceState(null, '', '/subscribe?invoice=' + invoice.invoiceId);
      renderInvoice();
    } catch (e) {
      status(e.message, 'err');
    }
  }

  async function pay() {
    $('pay').disabled = true;
    try {
      const fresh = await api('/invoices/' + invoice.invoiceId);
      if (fresh.status !== 'awaiting_payment') throw new Error('Invoice is ' + fresh.status);
      if (fresh.payTo.address !== invoice.payTo.address) throw new Error('Receiving wallet changed; create a new invoice');
      const problem = checkTx();
      if (problem) throw new Error(problem);
      const tx = invoice.unsignedTransaction;
      const current = await window.ethereum.request({ method: 'eth_chainId' });
      if (parseInt(current, 16) !== invoice.chainId) {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: tx.chainId }] });
      }
      status('Approve the USDC payment in your wallet…');
      const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value }] });
      status('Payment sent: ' + hash + '. Waiting for confirmations…');
      poll(hash);
    } catch (e) {
      status(e && e.code === 4001 ? 'You rejected the payment. Nothing was sent.' : 'Not paid: ' + (e.message || e), 'err');
      $('pay').disabled = false;
    }
  }

  async function poll(hash) {
    for (let i = 0; i < 240; i++) {
      try {
        const r = await api('/invoices/' + invoice.invoiceId + '/confirm', { method: 'POST', body: JSON.stringify({ txHash: hash }) });
        if (r.paid) {
          status('✓ Payment confirmed. Subscription active until ' + new Date(r.subscription.expiresAt).toLocaleString() + '.', 'ok');
          if (r.apiKey) {
            $('keybox').hidden = false;
            $('apikey').textContent = r.apiKey;
          } else status('✓ ' + r.apiKeyNote, 'ok');
          return;
        }
        status((r.message || r.status) + (r.explorerUrl ? ' ' + r.explorerUrl : ''));
      } catch (e) {
        status(e.message, 'err');
        if (/reverted|did not call|No USDC transfer|Underpaid|already used|predates/.test(e.message)) return;
      }
      await new Promise((res) => setTimeout(res, 5000));
    }
    status('Still not confirmed. Re-open this page later to finish activation.', 'err');
  }

  $('connect').addEventListener('click', connect);
  $('create').addEventListener('click', create);
  $('pay').addEventListener('click', pay);
  $('network').addEventListener('change', refresh);

  const existing = new URLSearchParams(location.search).get('invoice');
  api('/plans')
    .then((p) => {
      plans = p;
      renderPlans();
      if (existing && /^inv_[0-9a-f]{32}$/.test(existing)) {
        return api('/invoices/' + existing).then((inv) => {
          invoice = inv;
          renderInvoice();
        });
      }
    })
    .catch((e) => status(e.message, 'err'));
})();
