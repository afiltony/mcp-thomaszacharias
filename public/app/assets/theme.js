/* Applies the saved theme before first paint (external because of the strict CSP). */
(function () {
  try {
    var t = localStorage.getItem('tz.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow the OS */ }
})();
