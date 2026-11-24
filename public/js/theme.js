'use strict';
(function () {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { preference = localStorage.getItem('kryston.appearance') || 'system'; } catch { /* Storage may be disabled. */ }
  if (!['system', 'light', 'dark'].includes(preference)) preference = 'system';
  function apply() {
    document.documentElement.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
  }
  apply();
  media.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('themeSelect');
    select.value = preference;
    select.addEventListener('change', () => {
      preference = select.value;
      try { localStorage.setItem('kryston.appearance', preference); } catch { /* Keep the session preference. */ }
      apply();
    });
  });
})();
