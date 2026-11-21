// Applies the colour theme before the page paints (no flash). Dark is the default.
// The choice (dark | light | system) is a display preference only, kept in this extension's localStorage,
// so it also applies on the lock screen. Other open Form Filler pages follow a change straight away.
(function () {
  const apply = (t) => { document.documentElement.dataset.theme = /^(dark|light|system)$/.test(t || '') ? t : 'dark'; };
  try { apply(localStorage.getItem('ff_theme')); } catch { apply('dark'); }
  addEventListener('storage', (e) => { if (e.key === 'ff_theme') apply(e.newValue); });
})();
