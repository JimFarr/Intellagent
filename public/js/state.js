/* Shared client state: the board, the settings and the token. Everything that reads or writes them imports from here. */
import { THEMES } from './themes.js';

// With no theme picked, the board follows the system: Clear when it is light, else Clear Dark, live as it changes.
const systemLight = matchMedia('(prefers-color-scheme: light)');
export const onSystemTheme = (fn) => systemLight.addEventListener('change', fn);
// A picked theme that isn't loaded (an imported one before /api/themes answers, or one since removed) shows the system's.
export const themeKey = () => (Object.hasOwn(THEMES, settings.theme || '') ? settings.theme : systemLight.matches ? 'clear' : 'clear-dark');

// The only place that touches localStorage: a missing or unreadable value gives the fallback, and a failed write is dropped.
// `raw` keeps a plain string (the token) as it is instead of JSON.
export const stored = (key, fallback, raw = false) => ({
  get() {
    try { return (raw ? localStorage.getItem(key) : JSON.parse(localStorage.getItem(key))) || fallback; } catch { return fallback; }
  },
  save(value) {
    try { localStorage.setItem(key, raw ? value : JSON.stringify(value)); } catch { /* private mode */ }
  },
});

const KEY = 'intellagent.settings.v1';
export const settingsStore = stored(KEY, {});
export const DEFAULTS = {
  colw: 300, ageDays: '7',
  motion: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full',
  stub: { id: true, type: true, priority: true, parent: true, author: true, lease: true, comments: true, attachments: true, blocked: true, properties: false, description: false, thumbnail: true, fields: true, assignee: true, status: true, checklist: true, listeners: true, writing: true },
  grouping: 'stack', saveMode: 'accept', thread: 'below', userName: 'You', notify: false, notifyHidden: true, sound: false, toasts: true,
  metrics: true, metricsDays: 7,
};
function loadSettings() {
  try {
    const s = settingsStore.get();
    return { ...DEFAULTS, ...s, stub: { ...DEFAULTS.stub, ...(s.stub || {}) } };
  } catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
}
export const settings = loadSettings();

export const state = {
  app: { name: 'Intellagent' }, boards: [], boardId: null, board: null, hash: null, seq: 0, offset: 0, archivedCount: 0,
  presence: [], standing: {}, profiles: {}, listeners: {}, listenersSig: '', looks: {}, looksSig: '', inbox: [], bulk: false, selected: new Set(), focusId: null, query: '', expanded: new Set(), folded: new Set(),
  settingsVersion: 0, modal: null, live: false, refreshing: false, refreshAgain: false,
  section: 'board', // manager | board | agents | deployments | rules (app.js: sections)
};

const TOKEN_KEY = 'intellagent.token';
export const tokenStore = stored(TOKEN_KEY, '', true);
export const AUTH = { token: tokenStore.get() };
// `intellagent open` passes the user token in the fragment (#token=…): keep it, then drop it from the address bar.
{
  const m = /^#token=([\w-]+)/.exec(location.hash);
  if (m) {
    AUTH.token = m[1];
    tokenStore.save(m[1]);
    history.replaceState(null, '', location.pathname);
  }
}
