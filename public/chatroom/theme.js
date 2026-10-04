const THEME_STORAGE_KEY = 'agent-chat-room-theme';

/** Presentation only: no room state, transport, or composer event handlers. */
export function initializeShell(document, window) {
  const root = document.documentElement;
  const toggle = document.getElementById('theme-toggle');
  const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)');
  const narrowScreen = window.matchMedia?.('(max-width: 800px)');
  let preference = null;
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') preference = saved;
  } catch { /* Storage can be unavailable; the control still works in memory. */ }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    toggle?.setAttribute('aria-pressed', String(theme === 'dark'));
  }
  function followSystem() {
    if (preference === null) applyTheme(systemTheme?.matches ? 'dark' : 'light');
  }
  function toggleTheme() {
    preference = root.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(preference);
    try { window.localStorage.setItem(THEME_STORAGE_KEY, preference); }
    catch { /* Retain the user's choice for this page even if writing fails. */ }
  }
  function syncTheme(event) {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    preference = event.newValue === 'dark' || event.newValue === 'light' ? event.newValue : null;
    applyTheme(preference ?? (systemTheme?.matches ? 'dark' : 'light'));
  }

  const disclosures = ['rooms-disclosure', 'tasks-disclosure', 'inspector-disclosure']
    .map(id => document.getElementById(id)).filter(Boolean);
  function resizeRails() {
    for (const disclosure of disclosures) {
      // Preserve a reachable focus target before collapsing focused content.
      if (narrowScreen?.matches && disclosure.contains(document.activeElement)) {
        disclosure.querySelector('summary')?.focus();
      }
      disclosure.open = !narrowScreen?.matches;
    }
  }
  function closeRail(event) {
    if (event.key !== 'Escape' || !narrowScreen?.matches) return;
    const disclosure = disclosures.find(item => item.open && item.contains(event.target));
    if (!disclosure) return;
    event.preventDefault();
    disclosure.open = false;
    disclosure.querySelector('summary')?.focus();
  }

  applyTheme(preference ?? (systemTheme?.matches ? 'dark' : 'light'));
  if (toggle) toggle.disabled = false;
  resizeRails();
  toggle?.addEventListener('click', toggleTheme);
  systemTheme?.addEventListener('change', followSystem);
  narrowScreen?.addEventListener('change', resizeRails);
  window.addEventListener('storage', syncTheme);
  document.addEventListener('keydown', closeRail);

  return () => {
    toggle?.removeEventListener('click', toggleTheme);
    systemTheme?.removeEventListener('change', followSystem);
    narrowScreen?.removeEventListener('change', resizeRails);
    window.removeEventListener('storage', syncTheme);
    document.removeEventListener('keydown', closeRail);
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  initializeShell(document, window);
}
