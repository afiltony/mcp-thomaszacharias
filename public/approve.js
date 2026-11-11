/* Wallet approval client. Vanilla JS, no third-party code. Uses an EIP-1193 browser wallet. */
(function () {
  'use strict';
  const id = location.pathname.split('/').pop();
  const $ = (s) => document.getElementById(s);
  const TRANSFER_SELECTOR = '0xa9059cbb';
  let prep = null;
  let account = null;
  let checksPassed = false;

  function setStatus(el, text, kind) {
    el.hidden = false;
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  async function api(path, opts) {
    const res = await fetch('/public/transfers/' + id + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body.error && body.error.message) || 'Request failed (' + res.status + ')');
    return body;
  }

  /** Decode ERC-20 transfer(address,uint256) calldata locally — do not trust the server's summary alone. */
  function decodeTransfer(data) {
    const d = String(data).toLowerCase();
    if (!d.startsWith(TRANSFER_SELECTOR) || d.length !== 10 + 64 * 2) return null;
    const addrWord = d.slice(10, 74);
    if (!/^0{24}/.test(addrWord)) return null;
    return { recipient: '0x' + addrWord.slice(24), amountRaw: BigInt('0x' + d.slice(74, 138)).toString() };
  }

  function check(label, ok) {
    const li = document.createElement('li');
    li.className = ok ? 'pass' : 'fail';
    li.textContent = label;
    $('checks').appendChild(li);
    return ok;
  }

  function runChecks() {
    $('checks').innerHTML = '';
    const tx = prep.unsignedTransaction;
    const dec = decodeTransfer(tx.data);
    let ok = true;
    ok = check('Call data is a standard USDC transfer', !!dec) && ok;
    ok = check('Encoded recipient matches the displayed recipient', !!dec && dec.recipient === prep.decoded.recipient.toLowerCase()) && ok;
    ok = check('Encoded amount matches the displayed amount', !!dec && dec.amountRaw === prep.decoded.amountRaw) && ok;
    ok = check('Transaction targets the USDC contract shown', tx.to.toLowerCase() === prep.decoded.tokenContract.toLowerCase()) && ok;
    ok = check('Chain ID matches the network shown', parseInt(tx.chainId, 16) === prep.chainId) && ok;
    ok = check('No native coin is sent (value = 0)', tx.value === '0x0') && ok;
    ok = check('Not expired', Date.parse(prep.expiresAt) > Date.now()) && ok;
    if (account) ok = check('Connected wallet is the prepared sender', account.toLowerCase() === tx.from.toLowerCase()) && ok;
    checksPassed = ok;
    updateButtons();
  }

  function updateButtons() {
    $('approve').disabled = !(checksPassed && account && $('confirm').checked && prep && prep.status === 'awaiting_wallet_approval');
  }

  function render() {
    const s = prep.approvalSummary;
    $('amount').textContent = s.amount;
    $('toDomain').textContent = 'to ' + s.domain;
    $('recipient').textContent = s.recipient;
    $('record').textContent = s.recipientRecord;
    $('network').textContent = s.network;
    $('token').textContent = s.tokenContract;
    $('txto').textContent = s.transactionTo;
    $('from').textContent = prep.unsignedTransaction.from;
    $('fee').textContent = s.estimatedNetworkFee;
    $('maxfee').textContent = s.maximumNetworkFee;
    $('total').textContent = s.totalDebit;
    $('expires').textContent = new Date(prep.expiresAt).toLocaleString();
    $('warnings').innerHTML = '';
    (s.warnings || []).forEach((w) => {
      const li = document.createElement('li');
      li.textContent = w;
      $('warnings').appendChild(li);
    });
    $('load').hidden = true;
    $('details').hidden = false;
    runChecks();
    if (prep.status !== 'awaiting_wallet_approval') setStatus($('result'), 'This transfer is ' + prep.status + '.', prep.status === 'expired' ? 'err' : '');
  }

  async function connect() {
    if (!window.ethereum) return setStatus($('result'), 'No browser wallet found. Install or open a wallet such as MetaMask or Coinbase Wallet.', 'err');
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      account = accounts && accounts[0];
      $('connect').textContent = 'Connected: ' + account.slice(0, 6) + '…' + account.slice(-4);
      runChecks();
    } catch (e) {
      setStatus($('result'), e.code === 4001 ? 'Wallet connection was rejected.' : 'Wallet connection failed: ' + e.message, 'err');
    }
  }

  async function ensureChain() {
    const current = await window.ethereum.request({ method: 'eth_chainId' });
    if (parseInt(current, 16) === prep.chainId) return;
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: prep.unsignedTransaction.chainId }] });
    const after = await window.ethereum.request({ method: 'eth_chainId' });
    if (parseInt(after, 16) !== prep.chainId) throw new Error('Wallet is not on ' + prep.approvalSummary.network);
  }

  async function approve() {
    const out = $('result');
    $('approve').disabled = true;
    try {
      setStatus(out, 'Re-checking recipient record, balances and fees…');
      const recheck = await api('/recheck', { method: 'POST', body: '{}' });
      if (!recheck.ok) throw new Error('Re-check failed');
      runChecks();
      if (!checksPassed) throw new Error('Local checks failed; not sending to wallet.');
      await ensureChain();
      setStatus(out, 'Waiting for your approval in the wallet…');
      const tx = prep.unsignedTransaction;
      const hash = await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }],
      });
      setStatus(out, 'Submitted ' + hash + '. Waiting for confirmations — this is not final yet.');
      poll(hash);
    } catch (e) {
      const msg = e && e.code === 4001 ? 'You rejected the transaction in your wallet. Nothing was sent.' : 'Not sent: ' + (e && e.message ? e.message : e);
      setStatus(out, msg, 'err');
      updateButtons();
    }
  }

  async function poll(hash) {
    const out = $('result');
    for (let i = 0; i < 180; i++) {
      try {
        const v = await api('/verify', { method: 'POST', body: JSON.stringify({ txHash: hash }) });
        if (v.status === 'confirmed') return setStatus(out, '✓ Confirmed: ' + v.transfer.amount + ' USDC to ' + v.transfer.to + ' (' + v.confirmations + ' confirmations). Fee paid: ' + v.actualFee.native + ' ' + v.actualFee.nativeSymbol + '. ' + v.explorerUrl, 'ok');
        if (v.status === 'failed' || v.status === 'mismatch') return setStatus(out, '✗ ' + v.message + ' ' + v.explorerUrl, 'err');
        setStatus(out, (v.message || v.status) + ' ' + v.explorerUrl);
      } catch (e) {
        setStatus(out, 'Checking status… (' + e.message + ')');
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    setStatus(out, 'Still not confirmed. Check ' + hash + ' in a block explorer before assuming success.', 'err');
  }

  $('connect').addEventListener('click', connect);
  $('approve').addEventListener('click', approve);
  $('confirm').addEventListener('change', updateButtons);
  if (window.ethereum && window.ethereum.on) window.ethereum.on('accountsChanged', (a) => { account = a && a[0]; runChecks(); });

  api('')
    .then((p) => {
      prep = p;
      render();
    })
    .catch((e) => setStatus($('load'), e.message, 'err'));
})();
