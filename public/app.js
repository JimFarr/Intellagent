/* Intellagent — client. Stateless view over the board JSON served by server.js. */
'use strict';

(() => {
  /* ═════════════════════════ helpers ═════════════════════════ */

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const hue = (s) => hashStr(String(s)) % 360;
  const initials = (n) => String(n).split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  const tagColor = (p) => `hsl(${hue(p)} 72% 62%)`;
  const tilt = (id) => (((hashStr(id) % 1000) / 1000) - 0.5) * 2.6;
  const nowMs = () => Date.now() + state.offset;
  const reduced = () => settings.motion === 'reduced';
  const autosize = (ta) => { if (!ta) return; ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
  const isImage = (a) => a?.kind !== 'link' && /^image\//.test(a?.mime || '');

  function rel(ts) {
    if (!ts) return '';
    const s = (nowMs() - Date.parse(ts)) / 1000;
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    if (s < 604800) return `${Math.round(s / 86400)}d`;
    return new Date(ts).toLocaleDateString();
  }
  const fmtLeft = (ms) => (ms <= 0 ? '0:00' : ms >= 3600000 ? `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m` : `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`);

  const ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 13v2M15 13v2"/><circle cx="12" cy="3" r="1"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    pin: '<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 14v7"/>',
    checks: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    archive: '<rect x="2" y="3" width="20" height="5" rx="1.5"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    ask: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M10 8.5a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.4M12 14h.01"/>',
    chev: '<path d="m6 9 6 6 6-6"/>',
    layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    move: '<path d="m8 3-4 4 4 4M4 7h16M16 21l4-4-4-4M20 17H4"/>',
    flag: '<path d="M4 22V4M4 4h13l-2 4 2 4H4"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    issue: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>',
    task: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    spike: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/>',
    palette: '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A5.7 5.7 0 0 0 22 9.8C22 5.5 17.5 2 12 2z"/>',
    card: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h10M7 13h6"/>',
    board: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18M15 3v18"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    terminal: '<path d="M4 17l6-5-6-5M12 19h8"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    sparkle: '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>',
    tag: '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    cal: '<rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    num: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    toggle: '<rect x="2" y="6" width="20" height="12" rx="6"/><circle cx="16" cy="12" r="3"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    eyeoff: '<path d="M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6M2 2l20 20"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/>',
    radio: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
    news: '<path d="M4 22h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8M15 18h-5M10 6h8v4h-8z"/>',
    wave: '<path d="M2 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0"/><path d="M2 18c2-4 4-4 6 0s4 4 6 0 4-4 6 0" opacity=".5"/>',
  };
  const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ICONS.sparkle}</svg>`;
  const TYPES = ['issue', 'task', 'spike'];
  const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
  const PRIO_VAR = { Low: 'var(--muted)', Medium: 'var(--task)', High: 'var(--warn)', Critical: 'var(--danger)' };
  const TYPE_VAR = { issue: 'var(--issue)', task: 'var(--task)', spike: 'var(--spike)' };
  const FIELD_ICON = { text: 'text', markdown: 'text', number: 'num', boolean: 'toggle', enum: 'list', tags: 'tag', date: 'cal', url: 'link', user: 'user' };
  const LOGO = '<svg viewBox="0 0 32 32"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent-2)"/></linearGradient></defs><rect x="2" y="2" width="28" height="28" rx="9" fill="url(#lg)"/><path d="M9.5 11h11M9.5 16h7M9.5 21h4" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><path d="M23 17.5l1.1 2.4 2.4 1.1-2.4 1.1-1.1 2.4-1.1-2.4-2.4-1.1 2.4-1.1z" fill="#fff"/></svg>';

  // Agents (and you) can set colour / glyph / image via PATCH /api/profiles/me; otherwise colour comes from the name.
  function avatar(actor, cls = '') {
    const name = actor?.name || '?';
    const p = state.profiles[name];
    const kind = (p?.kind || actor?.kind) === 'user' ? 'user' : 'agent';
    const color = p?.color || `hsl(${hue(name)} 62% 56%)`;
    const style = `--av:${esc(color)}${p?.image ? `;background-image:url(&quot;${esc(p.image)}&quot;)` : ''}`;
    const run = state.standing[name]?.status;
    return `<span class="avatar ${kind} ${p?.image ? 'img' : ''} ${p?.glyph ? 'glyph' : ''} ${cls}" data-name="${esc(name)}"${run && run !== 'idle' ? ` data-run="${run}"` : ''} style="${style}" title="${esc(p?.label || name)}|${kind === 'agent' ? 'Agent' : 'Person'}${p?.label ? ` · ${esc(name)}` : ''} — click for profile">${p?.image ? '' : esc(p?.glyph || initials(name))}</span>`;
  }

  /* ═════════════════════════ themes + settings ═════════════════════════ */

  // A theme = palette + style spec + optional CSS. The style spec drives data-attributes on <html>
  // (CSS branches on them); `css` is injected for one-off touches that make each theme its own.
  const STYLE = {
    card: 12, col: 20, modal: 22, ctl: 10, bw: 1, colAlpha: 84, titleW: 600,
    shadow: 'soft', // soft | flat | hard | glow
    cards: 'sticky', // sticky | clean
    tape: 'tape', // tape | pin | clip | corner | none
    attn: 'orbit', // needs-you styling: orbit | glow | bar | outline | ribbon
    enter: 'rise', // modal opening: rise | sheet | fade | pop | zoom
    lanes: 'glass', // columns: glass | solid | outline | lane
    typeInd: 'bar', // clean cards show type as: bar | top | tint | dot
    chips: 'pill', // pill | tag | outline
    heads: 'normal', // column titles: normal | caps
    avatar: 'mixed', // mixed (agents square, people round) | round | square
    bg: 'blobs', texture: true,
    corner: null, // px kept clear in each card's top-right (auto: 16 when the fold decoration is on)
    avatars: 'color', // color | accent | ink
    colColor: 'own', // own | accent | ink — column dots and rules
  };
  const T = (label, mode, c, style = {}, css = '') => ({
    label, mode, style, css, glow: !!style.glow,
    vars: {
      bg: c[0], panel: c[1], surface: c[2], text: c[3], muted: c[4], border: c[5], accent: c[6], 'accent-2': c[7],
      issue: c[8], task: c[9], spike: c[10], ok: c[11], warn: c[12], danger: c[13], blob1: c[14], blob2: c[15], blob3: c[16],
      shadow: mode === 'dark' ? 'rgb(0 0 0 / .6)' : 'rgb(60 45 30 / .22)', 'fx-o': mode === 'dark' ? '.34' : '.5', grain: mode === 'dark' ? '.07' : '.09',
    },
  });
  const THEMES = {
    intellagent: T('Intellagent', 'dark', ['#0d0e1a', '#161829', '#1d2035', '#eceefe', '#8e93b8', '#2b2f4a', '#8b7bff', '#2fe0c4', '#ff6b8b', '#6aa8ff', '#ffc857', '#3ddc97', '#ffb454', '#ff5d73', '#7b5cff', '#00d4b0', '#ff5fa2']),
    daylight: T('Daylight', 'light', ['#f4f1ec', '#ebe6de', '#fffdf9', '#23212b', '#7a7585', '#ddd6cb', '#6c5cff', '#0fb59a', '#e5486b', '#3b7bea', '#e3a019', '#1f9e66', '#d9822b', '#d93c56', '#b6a8ff', '#8ff0dc', '#ffc2d9'],
      { attn: 'glow' }),
    dracula: T('Dracula', 'dark', ['#21222c', '#282a36', '#343746', '#f8f8f2', '#8b93c4', '#44475a', '#bd93f9', '#ff79c6', '#ff5555', '#8be9fd', '#f1fa8c', '#50fa7b', '#ffb86c', '#ff5555', '#bd93f9', '#ff79c6', '#8be9fd'],
      { cards: 'clean', typeInd: 'top', tape: 'none', attn: 'glow', enter: 'zoom', bg: 'stars' },
      '.c-id { color: var(--accent-2); } .col-name { color: var(--accent); }'),
    nord: T('Nord', 'dark', ['#2a303c', '#2e3440', '#3b4252', '#eceff4', '#a3adc2', '#434c5e', '#88c0d0', '#b48ead', '#bf616a', '#81a1c1', '#ebcb8b', '#a3be8c', '#d08770', '#bf616a', '#5e81ac', '#88c0d0', '#b48ead'],
      { card: 10, col: 16, modal: 18, ctl: 8, cards: 'clean', tape: 'none', typeInd: 'tint', attn: 'outline', enter: 'fade', lanes: 'solid', bg: 'none' },
      '.col-head { border-bottom: 1px solid var(--border); margin: 0 4px 10px; }'),
    mocha: T('Catppuccin Mocha', 'dark', ['#11111b', '#1e1e2e', '#313244', '#cdd6f4', '#a6adc8', '#45475a', '#cba6f7', '#94e2d5', '#f38ba8', '#89b4fa', '#f9e2af', '#a6e3a1', '#fab387', '#f38ba8', '#cba6f7', '#89b4fa', '#f5c2e7'],
      { attn: 'glow' }, '.card { --card-line: color-mix(in oklab, var(--accent) 18%, transparent); }'),
    latte: T('Catppuccin Latte', 'light', ['#dce0e8', '#e6e9ef', '#eff1f5', '#4c4f69', '#6c6f85', '#ccd0da', '#8839ef', '#179299', '#d20f39', '#1e66f5', '#df8e1d', '#40a02b', '#fe640b', '#d20f39', '#8839ef', '#04a5e5', '#ea76cb'],
      { attn: 'glow' }),
    tokyo: T('Tokyo Night', 'dark', ['#16161e', '#1a1b26', '#24283b', '#c0caf5', '#8089b3', '#2f3549', '#7aa2f7', '#bb9af7', '#f7768e', '#7dcfff', '#e0af68', '#9ece6a', '#ff9e64', '#f7768e', '#7aa2f7', '#bb9af7', '#2ac3de'],
      { cards: 'clean', tape: 'none', typeInd: 'dot', attn: 'glow', enter: 'zoom', bg: 'stars', chips: 'outline' },
      '.column { border-top: 2px solid color-mix(in oklab, var(--col) 80%, transparent); }'),
    gruvbox: T('Gruvbox', 'dark', ['#1d2021', '#282828', '#3c3836', '#ebdbb2', '#a89984', '#504945', '#fabd2f', '#8ec07c', '#fb4934', '#83a598', '#fabd2f', '#b8bb26', '#fe8019', '#fb4934', '#d79921', '#689d6a', '#cc241d'],
      { card: 6, tape: 'pin', attn: 'ribbon', enter: 'pop', bg: 'none', heads: 'caps', display: "'JetBrains Mono', monospace" },
      '.c-title { font-family: var(--mono); font-size: 13px; }'),
    rosepine: T('Rosé Pine', 'dark', ['#191724', '#1f1d2e', '#26233a', '#e0def4', '#908caa', '#393552', '#c4a7e7', '#ebbcba', '#eb6f92', '#9ccfd8', '#f6c177', '#3e8fb0', '#f6c177', '#eb6f92', '#c4a7e7', '#ebbcba', '#31748f'],
      { cards: 'clean', tape: 'none', typeInd: 'tint', attn: 'glow', enter: 'fade', bg: 'aurora' }),
    solarized: T('Solarized Light', 'light', ['#eee8d5', '#f5efdc', '#fdf6e3', '#073642', '#657b83', '#ddd6c1', '#268bd2', '#2aa198', '#dc322f', '#268bd2', '#b58900', '#859900', '#cb4b16', '#dc322f', '#268bd2', '#2aa198', '#d33682'],
      { card: 6, col: 12, modal: 14, ctl: 6, cards: 'clean', tape: 'corner', shadow: 'flat', attn: 'bar', enter: 'fade', lanes: 'solid', bg: 'none' }),
    github: T('GitHub Light', 'light', ['#f6f8fa', '#eef1f4', '#ffffff', '#1f2328', '#656d76', '#d0d7de', '#0969da', '#8250df', '#cf222e', '#0969da', '#9a6700', '#1a7f37', '#bc4c00', '#cf222e', '#54aeff', '#c297ff', '#ffd8b5'],
      { card: 8, col: 12, modal: 14, ctl: 7, cards: 'clean', tape: 'none', shadow: 'flat', attn: 'outline', enter: 'sheet', lanes: 'solid', chips: 'tag', bg: 'none', texture: false, avatar: 'round', titleW: 600 },
      '.c-title { font-size: 13.5px; } .c-id { color: var(--muted); }'),
    synthwave: T("Synthwave '84", 'dark', ['#1a1025', '#241b2f', '#2a2139', '#f4eee4', '#a29bc8', '#3b2f52', '#ff7edb', '#36f9f6', '#fe4450', '#36f9f6', '#fede5d', '#72f1b8', '#f97e72', '#fe4450', '#ff7edb', '#36f9f6', '#fede5d'],
      { glow: true, shadow: 'glow', cards: 'clean', tape: 'none', typeInd: 'top', attn: 'orbit', enter: 'zoom', bg: 'mesh', heads: 'caps' },
      '.col-name { color: var(--accent); text-shadow: 0 0 8px var(--accent); }'),
    slate: T('Slate', 'light', ['#f5f7fa', '#eef1f5', '#ffffff', '#1b2430', '#64748b', '#dbe2ea', '#2563eb', '#0ea5e9', '#dc2626', '#2563eb', '#d97706', '#16a34a', '#ea580c', '#dc2626', '#93c5fd', '#a5f3fc', '#e2e8f0'],
      { card: 6, col: 10, modal: 12, ctl: 6, shadow: 'flat', tape: 'none', cards: 'clean', attn: 'bar', enter: 'sheet', lanes: 'lane', chips: 'tag', heads: 'caps', bg: 'none', texture: false, avatar: 'round', titleW: 500, font: "'IBM Plex Sans'", display: "'IBM Plex Sans'", colAlpha: 92 },
      '.topbar { background: var(--surface); border-bottom: 1px solid var(--border); margin-bottom: 10px; padding-bottom: 12px; } .app-name { background: none; color: var(--text); -webkit-text-fill-color: currentColor; }'),
    graphite: T('Graphite', 'dark', ['#0f1012', '#16171a', '#1c1d21', '#e6e7ea', '#8b8f98', '#2a2c31', '#6e9fff', '#58d0b4', '#f87171', '#6e9fff', '#fbbf24', '#4ade80', '#fb923c', '#f87171', '#3b4252', '#2a3a4a', '#3a2e3e'],
      { card: 5, col: 8, modal: 10, ctl: 6, tape: 'none', cards: 'clean', typeInd: 'dot', attn: 'outline', enter: 'sheet', lanes: 'solid', chips: 'outline', bg: 'none', texture: false, display: "'Inter'", colAlpha: 92 },
      '.column { border-color: transparent; } .card:hover { translate: 0 -1px; }'),
    midnight: T('Midnight Pro', 'dark', ['#08090c', '#101116', '#15161c', '#ededf0', '#8a8f98', '#23252d', '#5e6ad2', '#4cb782', '#eb5757', '#5e6ad2', '#f2c94c', '#4cb782', '#f2994a', '#eb5757', '#5e6ad2', '#26b5ce', '#8e4ec6'],
      { card: 8, col: 14, modal: 16, ctl: 8, tape: 'none', cards: 'clean', typeInd: 'dot', attn: 'glow', enter: 'rise', lanes: 'outline', chips: 'tag', bg: 'aurora', titleW: 500, display: "'Inter'" },
      '.col-name { font-weight: 500; font-size: 13px; color: var(--muted); } .c-title { font-size: 13.5px; }'),
    paper: T('Paper', 'light', ['#f3efe6', '#ece6d9', '#fbf8f2', '#2b2a26', '#7b756a', '#d9d1c0', '#b4532a', '#2f6f62', '#b4362a', '#2f5d8a', '#b98a1b', '#3d7a4a', '#c06a2b', '#b4362a', '#e8d9bd', '#d9e4d6', '#efd3c8'],
      { card: 2, col: 4, modal: 6, ctl: 4, shadow: 'flat', tape: 'corner', cards: 'clean', typeInd: 'top', attn: 'ribbon', enter: 'fade', lanes: 'lane', chips: 'outline', heads: 'caps', bg: 'none', display: "'Fraunces', serif", colAlpha: 90 },
      '.c-title { font-family: var(--display); font-size: 15.5px; } .board { background-image: repeating-linear-gradient(transparent 0 27px, color-mix(in oklab, var(--accent-2) 9%, transparent) 27px 28px); background-size: auto; } .col-name { font-style: italic; }'),
    brutalist: T('Brutalist', 'light', ['#f4f1ea', '#ffffff', '#ffffff', '#111111', '#555555', '#111111', '#ff4d00', '#0047ff', '#ff2e2e', '#0047ff', '#ffcc00', '#00a651', '#ff8a00', '#ff2e2e', '#ffcc00', '#0047ff', '#ff4d00'],
      { card: 0, col: 0, modal: 0, ctl: 0, bw: 2, shadow: 'hard', tape: 'none', cards: 'clean', typeInd: 'top', attn: 'outline', enter: 'pop', lanes: 'solid', chips: 'tag', heads: 'caps', bg: 'none', texture: false, avatar: 'square', titleW: 700, font: "'Space Grotesk'", display: "'Space Grotesk'", colAlpha: 100 },
      '.c-title { font-size: 15px; } .app-name { background: none; color: var(--text); -webkit-text-fill-color: currentColor; } .btn.primary { background: var(--accent); border: 2px solid var(--text); box-shadow: 3px 3px 0 var(--text); } .pill-btn:hover { translate: -2px -2px; box-shadow: 3px 3px 0 var(--text); }'),
    cork: T('Corkboard', 'light', ['#c9a77c', '#b8946a', '#fff8d2', '#2b2014', '#6b5537', '#9c7a52', '#c0392b', '#2e86ab', '#ff9aa2', '#7fb7e6', '#f4d35e', '#4c9a2a', '#d9822b', '#c0392b', '#e0c39a', '#b88e5f', '#d8b38a'],
      { card: 2, col: 16, modal: 18, ctl: 10, tape: 'pin', cards: 'sticky', attn: 'ribbon', bg: 'none', avatar: 'round', colAlpha: 55, grain: '.22' },
      ".c-title { font-family: 'Caveat', cursive; font-size: 20px; line-height: 1.1; font-weight: 600; }"),
    blueprint: T('Blueprint', 'dark', ['#0b2545', '#0f2f57', '#13396a', '#e8f1ff', '#8fb3e0', '#2f5d93', '#7cc4ff', '#ffd166', '#ff8fa3', '#7cc4ff', '#ffd166', '#8ef0b0', '#ffb86b', '#ff8fa3', '#1d4e89', '#2b6cb0', '#0b3d73'],
      { card: 3, col: 6, modal: 8, ctl: 4, shadow: 'flat', tape: 'clip', cards: 'clean', typeInd: 'dot', attn: 'outline', enter: 'fade', lanes: 'outline', chips: 'outline', heads: 'caps', bg: 'none', texture: false, display: "'JetBrains Mono', monospace" },
      '.board { background-image: linear-gradient(color-mix(in oklab, var(--text) 8%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in oklab, var(--text) 8%, transparent) 1px, transparent 1px); background-size: 24px 24px; } .column, .card { border-style: dashed; } .c-title { text-transform: uppercase; font-size: 12.5px; letter-spacing: .04em; }'),
    vision: T('Vision', 'light', ['#e9eef8', '#ffffff', '#ffffff', '#0f1222', '#5b6380', '#d9e0ee', '#5b5bf6', '#0ea5e9', '#f43f5e', '#3b82f6', '#f59e0b', '#10b981', '#f97316', '#ef4444', '#a78bfa', '#67e8f9', '#f9a8d4'],
      { card: 18, col: 28, modal: 30, ctl: 14, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'glow', enter: 'rise', lanes: 'glass', bg: 'mesh', texture: false, avatar: 'round', colAlpha: 45 },
      '.column { background: linear-gradient(180deg, rgb(255 255 255 / .6), rgb(255 255 255 / .28)); border: 1px solid rgb(255 255 255 / .75); box-shadow: 0 1px 0 rgb(255 255 255 / .9) inset, 0 30px 60px -30px rgb(30 40 90 / .35); } .card { background: rgb(255 255 255 / .8); border-color: rgb(255 255 255 / .95); box-shadow: 0 1px 0 #fff inset, 0 12px 30px -14px rgb(30 40 90 / .32); } .modal, .drawer, .menu { background: rgb(255 255 255 / .93); } .pill-btn, .search input { background: rgb(255 255 255 / .62); border-color: rgb(255 255 255 / .85); } .app-name { background: linear-gradient(90deg, #5b5bf6, #0ea5e9); -webkit-background-clip: text; background-clip: text; }'),
    phosphor: T('Phosphor', 'dark', ['#050805', '#081008', '#0b160b', '#b8ffb0', '#5f9a5a', '#1d3a1c', '#39ff14', '#a3ff7a', '#ff5f5f', '#39ff14', '#ffd84d', '#39ff14', '#ffb000', '#ff4040', '#0f3d0f', '#123a12', '#0a2a0a'],
      { card: 0, col: 0, modal: 0, ctl: 0, shadow: 'flat', cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'outline', enter: 'fade', lanes: 'outline', chips: 'outline', heads: 'caps', bg: 'none', texture: false, avatar: 'square', avatars: 'accent', colColor: 'accent', titleW: 400, font: "'JetBrains Mono', monospace", display: "'VT323', monospace" },
      'body::after { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 1000; background: repeating-linear-gradient(0deg, rgb(0 0 0 / .22) 0 1px, transparent 1px 3px); } .board { background-image: radial-gradient(ellipse at 50% 40%, rgb(57 255 20 / .07), transparent 70%); } .c-title, .col-name, .app-name { text-shadow: 0 0 6px color-mix(in oklab, var(--accent) 65%, transparent); } .c-title { font-family: var(--display); font-size: 20px; line-height: 1.05; letter-spacing: .02em; } .col-name { font-family: var(--display); font-size: 19px; letter-spacing: .04em; } .app-name { background: none; color: var(--accent); -webkit-text-fill-color: currentColor; font-family: var(--display); font-size: 23px; } .card:hover .c-title::after { content: "_"; animation: breathe 1s steps(1) infinite; }'),
    swiss: T('Swiss', 'light', ['#f2f2ee', '#f2f2ee', '#ffffff', '#111111', '#6b6b6b', '#111111', '#e3000f', '#e3000f', '#e3000f', '#111111', '#ffb800', '#00875a', '#ff6b00', '#e3000f', '#f2f2ee', '#f2f2ee', '#f2f2ee'],
      { card: 0, col: 0, modal: 0, ctl: 0, shadow: 'flat', cards: 'clean', typeInd: 'top', tape: 'none', attn: 'bar', enter: 'fade', lanes: 'lane', chips: 'tag', bg: 'none', texture: false, avatar: 'square', avatars: 'ink', colColor: 'ink', titleW: 700, font: "'Inter'", display: "'Inter'", colAlpha: 100 },
      '.col-head { border-bottom: 3px solid var(--text) !important; align-items: flex-end; } .col-name { font-size: 30px; font-weight: 800; letter-spacing: -.045em; text-transform: lowercase; line-height: 1; } .col-count { background: none; padding: 0; font: 300 30px/1 var(--display); letter-spacing: -.04em; color: var(--accent); } .col-dot, .col-icon { display: none; } .card { background: transparent; border-width: 0 0 1px; border-color: var(--text); border-radius: 0; box-shadow: none; padding: 12px 0 11px; } .card::before { display: none; } .card:hover { background: rgb(0 0 0 / .03); } .c-title { font-size: 15.5px; letter-spacing: -.02em; } .app-name { background: none; color: var(--text); -webkit-text-fill-color: currentColor; font-weight: 800; letter-spacing: -.045em; font-size: 22px; } .logo { filter: grayscale(1) contrast(1.6); }'),
    bauhaus: T('Bauhaus', 'light', ['#f1ebdd', '#e8e0cd', '#fbf7ee', '#1a1a1a', '#6a645a', '#1a1a1a', '#d6312a', '#1f4fa3', '#d6312a', '#1f4fa3', '#f2b705', '#2e7d32', '#e8701a', '#d6312a', '#d6312a', '#1f4fa3', '#f2b705'],
      { card: 0, col: 0, modal: 0, ctl: 20, bw: 2, shadow: 'hard', cards: 'clean', typeInd: 'top', tape: 'none', attn: 'ribbon', enter: 'pop', lanes: 'solid', chips: 'pill', heads: 'caps', bg: 'none', texture: true, avatar: 'round', corner: 30, titleW: 700, font: "'Archivo'", display: "'Archivo'" },
      '.card { background: radial-gradient(circle at 100% 0, var(--type-c) 0 22px, transparent 23px), var(--surface); } .card[data-type="task"] { background: linear-gradient(var(--type-c), var(--type-c)) 100% 0 / 22px 22px no-repeat, var(--surface); } .card[data-type="spike"] { background: linear-gradient(225deg, var(--type-c) 50%, transparent 50%) 100% 0 / 30px 30px no-repeat, var(--surface); } .card::before { display: none; } .column { border-top: 10px solid var(--col); } .col-name { font-weight: 900; letter-spacing: .06em; } .app-name { background: none; color: var(--text); -webkit-text-fill-color: currentColor; font-weight: 900; }'),
    soft: T('Soft', 'light', ['#e6e9ef', '#e6e9ef', '#e6e9ef', '#2d3346', '#7b8196', '#d5d9e2', '#6c63ff', '#00b8a9', '#ef5d7a', '#5b8def', '#f0a93b', '#2bb673', '#f08c3b', '#e5484d', '#e6e9ef', '#e6e9ef', '#e6e9ef'],
      { card: 16, col: 26, modal: 28, ctl: 14, bw: 0, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'glow', enter: 'rise', lanes: 'solid', bg: 'none', texture: false, avatar: 'round', colAlpha: 100 },
      '.column { box-shadow: 10px 10px 24px #c5c9d3, -10px -10px 24px #ffffff; } .card { box-shadow: 6px 6px 14px #c8ccd6, -6px -6px 14px #ffffff; } .card:hover { box-shadow: 2px 2px 6px #c8ccd6, -2px -2px 6px #ffffff; } .card::before { display: none; } .search input, .inp, .dd, .tbox, .seg { background: var(--bg); box-shadow: inset 3px 3px 7px #c8ccd6, inset -3px -3px 7px #ffffff; border-color: transparent; } .pill-btn, .btn:not(.primary), .car-nav { background: var(--bg); border-color: transparent; box-shadow: 4px 4px 10px #c8ccd6, -4px -4px 10px #ffffff; } .pill-btn:active, .btn:active { box-shadow: inset 3px 3px 7px #c8ccd6, inset -3px -3px 7px #ffffff; } .modal, .drawer { box-shadow: 20px 20px 50px #c5c9d3, -20px -20px 50px #ffffff; } .seg button.on { box-shadow: 3px 3px 6px #c8ccd6, -3px -3px 6px #ffffff; }'),
    iridescent: T('Iridescent', 'dark', ['#07070b', '#0e0e15', '#13131c', '#f1f0ff', '#8d8ba8', '#24233a', '#c084fc', '#5eead4', '#fb7185', '#60a5fa', '#fcd34d', '#4ade80', '#fb923c', '#f43f5e', '#7c3aed', '#06b6d4', '#ec4899'],
      { card: 14, col: 20, modal: 22, ctl: 12, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'orbit', enter: 'zoom', lanes: 'outline', chips: 'outline', bg: 'aurora', texture: true },
      '.card { border: 1px solid transparent; background: linear-gradient(var(--surface), var(--surface)) padding-box, conic-gradient(from 210deg, #c084fc, #5eead4, #60a5fa, #f472b6, #fcd34d, #c084fc) border-box; } .card:hover { box-shadow: 0 18px 40px -16px rgb(192 132 252 / .5), 0 0 24px -10px rgb(94 234 212 / .5); } .column { border-color: rgb(255 255 255 / .07); background: rgb(14 14 21 / .55); } .app-name { background: linear-gradient(90deg, #c084fc, #5eead4, #f472b6); -webkit-background-clip: text; background-clip: text; } .btn.primary { background: linear-gradient(120deg, #c084fc, #60a5fa, #5eead4); }'),
    riso: T('Riso', 'light', ['#f5f0e6', '#efe8da', '#fbf8f1', '#1d2b6b', '#5c6aa3', '#1d2b6b', '#ff48b0', '#0078bf', '#ff48b0', '#0078bf', '#ffe800', '#00a95c', '#ff6c2f', '#ff48b0', '#ff48b0', '#0078bf', '#ffe800'],
      { card: 4, col: 6, modal: 8, ctl: 6, bw: 2, shadow: 'hard', cards: 'clean', typeInd: 'tint', tape: 'none', attn: 'ribbon', enter: 'pop', lanes: 'outline', chips: 'tag', heads: 'caps', bg: 'none', texture: true, grain: '.4', titleW: 700, font: "'Bricolage Grotesque'", display: "'Bricolage Grotesque'" },
      '.card { --card-line: var(--text); box-shadow: 3px 3px 0 var(--accent); } .card:hover { box-shadow: 5px 5px 0 var(--accent), -2px -2px 0 color-mix(in oklab, var(--accent-2) 70%, transparent); } .c-title { text-shadow: 1.5px 1px 0 color-mix(in oklab, var(--accent) 50%, transparent); } .col-name { color: var(--accent-2); text-shadow: 2px 1px 0 color-mix(in oklab, var(--accent) 60%, transparent); } .column { box-shadow: 6px 6px 0 color-mix(in oklab, var(--accent-2) 28%, transparent); } .app-name { background: none; color: var(--accent-2); -webkit-text-fill-color: currentColor; text-shadow: 2px 1.5px 0 var(--accent); } .btn.primary { background: var(--accent); box-shadow: 3px 3px 0 var(--accent-2); }'),
  };
  const BACKGROUNDS = [['blobs', 'Blobs'], ['aurora', 'Aurora'], ['stars', 'Stars'], ['mesh', 'Mesh'], ['none', 'None']];
  const themeStyle = () => ({ ...STYLE, ...(THEMES[settings.theme] || THEMES.intellagent).style });
  // A user setting of "theme" (or unset) defers to the theme's own choice.
  const pick = (k) => (settings[k] != null && settings[k] !== 'theme' ? settings[k] : themeStyle()[k]);

  const KEY = 'intellagent.settings.v1';
  const DEFAULTS = {
    theme: matchMedia('(prefers-color-scheme: light)').matches ? 'daylight' : 'intellagent',
    v3: true, bg: 'theme', cards: 'theme', tape: 'theme', attn: 'theme', enter: 'theme', lanes: 'theme', texture: 'theme',
    density: 'cozy', colw: 300, ageDays: '7',
    motion: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full',
    stub: { id: true, type: true, priority: true, parent: true, author: true, lease: true, comments: true, attachments: true, blocked: true, properties: false, description: false, thumbnail: true, fields: true, assignee: true, status: true, checklist: true, listeners: true },
    grouping: 'stack', saveMode: 'accept', userName: 'You', notify: false, notifyHidden: true, sound: false, toasts: true,
  };
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || '{}');
      if (!s.v2) { if (s.cards === 'sticky') s.cards = 'theme'; s.v2 = true; }
      if (!s.v3) { s.bg = 'theme'; s.texture = 'theme'; s.v3 = true; } // themes now pick background + texture
      return { ...DEFAULTS, ...s, stub: { ...DEFAULTS.stub, ...(s.stub || {}) } };
    } catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
  }
  let settings = loadSettings();
  let settingsVersion = 0;
  function saveSettings() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ }
    settingsVersion++;
    applySettings();
    render();
  }
  function applySettings() {
    const t = THEMES[settings.theme] || THEMES.intellagent;
    const st = themeStyle();
    const r = document.documentElement;
    for (const [k, v] of Object.entries(t.vars)) r.style.setProperty(`--${k}`, v);
    for (const [k, v] of [['--r-card', st.card], ['--r-col', st.col], ['--r-modal', st.modal], ['--r-ctl', st.ctl], ['--bw', st.bw]]) r.style.setProperty(k, `${v}px`);
    r.style.setProperty('--col-alpha', `${st.colAlpha}%`);
    r.style.setProperty('--title-w', st.titleW);
    if (st.grain) r.style.setProperty('--grain', st.grain);
    if (st.font) r.style.setProperty('--font', `${st.font}, system-ui, -apple-system, 'Segoe UI', sans-serif`); else r.style.removeProperty('--font');
    if (st.display) r.style.setProperty('--display', `${st.display}, var(--font)`); else r.style.removeProperty('--display');
    Object.assign(r.dataset, {
      theme: settings.theme in THEMES ? settings.theme : 'intellagent', mode: t.mode, glow: t.glow ? '1' : '',
      shadow: st.shadow, typeind: st.typeInd, chips: st.chips, heads: st.heads, avatar: st.avatar,
      tape: pick('tape'), cards: pick('cards'), attn: pick('attn'), enter: pick('enter'), lanes: pick('lanes'), bg: pick('bg'),
      density: settings.density,
    });
    const texture = settings.texture === 'theme' || settings.texture == null ? st.texture : settings.texture === 'on' || settings.texture === true;
    r.classList.toggle('no-texture', !texture);
    r.classList.toggle('reduced', reduced());
    r.style.setProperty('--colw', `${settings.colw}px`);
    const corner = st.corner ?? (pick('tape') === 'corner' ? 16 : 0);
    r.style.setProperty('--corner', `${corner}px`);
    r.dataset.avatars = st.avatars;
    r.dataset.colcolor = st.colColor;
    let css = $('#theme-css');
    if (!css) { css = document.createElement('style'); css.id = 'theme-css'; document.head.append(css); }
    css.textContent = t.css ? `:root[data-theme="${r.dataset.theme}"] { } ${t.css.replace(/(^|\})\s*([^{}]+)\{/g, (m, b, sel) => `${b} ${sel.split(',').map((x) => `:root[data-theme="${r.dataset.theme}"] ${x.trim()}`).join(', ')} {`)}` : '';
    let meta = $('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.append(meta); }
    meta.content = t.vars.bg;
    stars.sync();
  }
  function switchTheme(name, x = innerWidth / 2, y = 0) {
    const apply = () => { settings.theme = name; saveSettings(); };
    if (!document.startViewTransition || reduced()) { apply(); return; }
    const vt = document.startViewTransition(apply);
    vt.ready.then(() => {
      const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      document.documentElement.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 700, easing: 'cubic-bezier(.6,0,.2,1)', pseudoElement: '::view-transition-new(root)' });
    }).catch(() => {});
  }

  /* ─── starfield (canvas) ─── */
  const stars = (() => {
    let cv = null;
    let ctx = null;
    let pts = [];
    let raf = 0;
    let cols = ['#fff', '#fff', '#fff'];
    let mx = 0;
    let my = 0;
    const seed = () => {
      const n = Math.min(280, Math.round((innerWidth * innerHeight) / 6500));
      pts = Array.from({ length: n }, () => ({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, z: Math.random() ** 1.7 * 0.9 + 0.1, t: Math.random() * 6.28, c: Math.random() < 0.2 }));
    };
    const resize = () => {
      if (!cv) return;
      const d = devicePixelRatio || 1;
      cv.width = innerWidth * d; cv.height = innerHeight * d;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      seed();
      if (!raf) frame();
    };
    const frame = () => {
      raf = 0;
      if (!cv) return;
      const move = !reduced() && !document.hidden;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      const light = document.documentElement.dataset.mode === 'light';
      for (const p of pts) {
        if (move) {
          p.y -= p.z * 0.14; p.x += p.z * 0.05; p.t += 0.025 * p.z;
          if (p.y < -4) { p.y = innerHeight + 4; p.x = Math.random() * innerWidth; }
          if (p.x > innerWidth + 4) p.x = -4;
        }
        ctx.globalAlpha = (0.3 + 0.7 * (0.5 + 0.5 * Math.sin(p.t))) * p.z * (light ? 0.55 : 0.95);
        ctx.fillStyle = p.c ? (p.z > 0.55 ? cols[1] : cols[2]) : cols[0];
        ctx.beginPath();
        ctx.arc(p.x + mx * p.z * 16, p.y + my * p.z * 16, p.z * 1.7, 0, 6.283);
        ctx.fill();
      }
      if (move && document.documentElement.dataset.bg === 'stars') raf = requestAnimationFrame(frame);
    };
    addEventListener('resize', resize);
    addEventListener('pointermove', (e) => { mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5; });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && document.documentElement.dataset.bg === 'stars' && !raf) frame(); });
    return {
      sync() {
        const on = document.documentElement.dataset.bg === 'stars';
        if (!cv) { cv = document.getElementById('stars'); if (!cv) return; ctx = cv.getContext('2d'); }
        if (!on) { cancelAnimationFrame(raf); raf = 0; ctx.clearRect(0, 0, cv.width, cv.height); return; }
        const cs = getComputedStyle(document.documentElement);
        cols = [cs.getPropertyValue('--text').trim(), cs.getPropertyValue('--accent').trim(), cs.getPropertyValue('--accent-2').trim()];
        if (!pts.length) resize();
        cancelAnimationFrame(raf); raf = 0; frame();
      },
    };
  })();

  /* ═════════════════════════ state + api ═════════════════════════ */

  const state = {
    app: { name: 'Intellagent' }, boards: [], boardId: null, board: null, hash: null, seq: 0, offset: 0, archivedCount: 0,
    presence: [], standing: {}, profiles: {}, listeners: {}, listenersSig: '', inbox: [], bulk: false, selected: new Set(), query: '', expanded: new Set(), folded: new Set(),
    modal: null, live: false, refreshing: false, refreshAgain: false,
  };

  const TOKEN_KEY = 'intellagent.token';
  const AUTH = { token: (() => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } })() };

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-User': (settings.userName || 'You').replace(/[^\x20-\x7e]/g, '') || 'You',
        ...(AUTH.token ? { Authorization: `Bearer ${AUTH.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && data?.auth === 'user' && await promptToken()) return api(method, url, body);
    if (!res.ok) { const e = new Error(data?.error || res.statusText); e.status = res.status; e.data = data; throw e; }
    return data;
  }
  const B = (p = '') => `/api/boards/${encodeURIComponent(state.boardId)}${p}`;
  const I = (id, p = '') => B(`/items/${encodeURIComponent(id)}${p}`);
  const colById = (id) => state.board?.columns.find((c) => c.id === id);
  const activeLease = (it) => (it?.lease && Date.parse(it.lease.expiresAt) > nowMs() ? it.lease : null);
  const schema = () => state.board?.schema || { builtins: {}, fields: [] };
  const bi = (k) => schema().builtins[k] || { ui: 'edit', stub: true, label: k };
  const canEdit = (k) => bi(k).ui === 'edit';
  const shown = (k) => bi(k).ui !== 'hidden';
  const needsIds = () => (state.board ? state.board.columns.flatMap((c) => c.itemIds).filter((id) => state.board.items[id]?.needsHuman) : []);
  function openBlockers(it) {
    const last = state.board.columns[state.board.columns.length - 1]?.id;
    return (it.blockedBy || []).filter((id) => { const b = state.board.items[id]; return b && b.columnId !== last; });
  }
  function coverOf(it) {
    if (it.cover === 'none') return null;
    if (it.cover && it.cover !== 'auto') return it.attachments.find((a) => a.id === it.cover) || null;
    return it.attachments.find(isImage) || null;
  }

  async function loadBoard(id) {
    const data = await api('GET', `/api/boards/${encodeURIComponent(id)}`);
    if (state.boardId !== data.board.id) resetBoardDom();
    state.boardId = data.board.id;
    state.board = data.board;
    state.hash = data.hash;
    state.seq = data.seq;
    state.offset = Date.parse(data.serverTime) - Date.now();
    state.archivedCount = data.archivedCount;
    Object.assign(state.app, data.app);
    if (location.hash !== `#/${data.board.id}`) history.replaceState(null, '', `#/${data.board.id}`);
    renderHeader();
    render();
    state.modal?.refresh();
    scheduleListeners();
    renderCatch();
    const dg = $('#digestDrawer .drawer-body');
    if (dg?._redraw && !dg.contains(document.activeElement)) dg._redraw();
    if (!catchupDone.has(state.boardId)) { catchupDone.add(state.boardId); catchUp(state.boardId); }
  }

  let refreshTimer = null;
  function scheduleRefresh(delay = 50) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (state.refreshing) { state.refreshAgain = true; return; }
      state.refreshing = true;
      try { await loadBoard(state.boardId); } catch (e) { console.warn(e); }
      state.refreshing = false;
      if (state.refreshAgain) { state.refreshAgain = false; scheduleRefresh(0); }
    }, delay);
  }

  /* ═════════════════════════ generic UI: menu / dropdown / text box ═════════════════════════ */

  function closeMenus() { $$('.menu').forEach((m) => { m._onClose?.(); m.remove(); }); }

  // A positioned popover list. Items: { label, value?, icon?, color?, avatar?, hint?, cls?, disabled?, run? } or '-'.
  function menu(anchor, items, { up = false, search = false, creatable = null, placeholder = 'Search…', onClose = null, keepOpen = false, width = null } = {}) {
    const open = $('.menu');
    if (open && open._anchor === anchor) { closeMenus(); return null; }
    closeMenus();
    const m = el(`<div class="menu" role="listbox">${search || creatable ? `<input class="inp m-search" placeholder="${esc(placeholder)}" spellcheck="false">` : ''}<div class="m-list"></div></div>`);
    m._onClose = onClose;
    m._anchor = anchor;
    const list = $('.m-list', m);
    const input = $('.m-search', m);
    let active = -1;
    const draw = () => {
      const q = (input?.value || '').trim().toLowerCase();
      list.innerHTML = '';
      const vis = items.filter((it) => it === '-' ? !q : !q || String(it.label).toLowerCase().includes(q));
      for (const it of vis) {
        if (it === '-') { list.append(el('<hr>')); continue; }
        const lead = it.avatar ? avatar(it.avatar) : it.color ? `<span class="sw" style="--c:${esc(it.color)}"></span>` : it.icon ? icon(it.icon) : '';
        const b = el(`<button class="mi ${it.cls || ''}" ${it.disabled ? 'disabled' : ''}>${lead}<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</button>`);
        b.onclick = (e) => { if (!keepOpen) closeMenus(); it.run?.(e); if (keepOpen) draw(); };
        list.append(b);
      }
      if (creatable && q && !items.some((it) => it !== '-' && String(it.label).toLowerCase() === q)) {
        const raw = input.value.trim();
        const b = el(`<button class="mi create">${icon('plus')}<span>${esc(raw)}</span></button>`);
        b.onclick = () => { closeMenus(); creatable(raw); };
        list.append(b);
      }
      if (!list.children.length) list.append(el('<div class="m-empty">—</div>'));
      active = -1;
    };
    draw();
    document.body.append(m);
    if (width) m.style.width = `${width}px`;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const mr = m.getBoundingClientRect();
      const left = clamp(r.left, 8, innerWidth - mr.width - 8);
      const below = innerHeight - r.bottom - 8;
      const goUp = up || (below < mr.height && r.top > below);
      const top = goUp ? r.top - mr.height - 6 : r.bottom + 6;
      Object.assign(m.style, { left: `${left}px`, top: `${clamp(top, 8, innerHeight - mr.height - 8)}px`, transformOrigin: goUp ? 'bottom left' : 'top left' });
    };
    place();
    if (input) {
      input.oninput = () => { draw(); place(); };
      input.onkeydown = (e) => {
        const btns = $$('button.mi:not(:disabled)', list);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          active = clamp(active + (e.key === 'ArrowDown' ? 1 : -1), 0, btns.length - 1);
          btns.forEach((b, i) => b.classList.toggle('act', i === active));
          btns[active]?.scrollIntoView({ block: 'nearest' });
        }
        if (e.key === 'Enter') { e.preventDefault(); (btns[active] || btns[0])?.click(); }
        if (e.key === 'Escape') { e.stopPropagation(); closeMenus(); }
      };
      setTimeout(() => input.focus(), 10);
    }
    setTimeout(() => {
      const off = (e) => {
        if (!m.isConnected) { document.removeEventListener('pointerdown', off, true); return; }
        if (!m.contains(e.target) && !anchor.contains(e.target)) { closeMenus(); document.removeEventListener('pointerdown', off, true); }
      };
      document.addEventListener('pointerdown', off, true);
    });
    return m;
  }

  // Styled replacement for <select>: renders a trigger button and opens a searchable menu.
  function ddHTML(key, labelHTML, { placeholder = '—', disabled = false } = {}) {
    return `<button class="dd" data-dd="${esc(key)}" ${disabled ? 'disabled' : ''}><span class="v ${labelHTML ? '' : 'ph'}">${labelHTML || esc(placeholder)}</span>${icon('chev', 'sm')}</button>`;
  }
  function openDd(btn, items, opts = {}) {
    if (btn.classList.contains('open')) { closeMenus(); return; }
    btn.classList.add('open');
    menu(btn, items, { ...opts, width: Math.max(btn.offsetWidth, 200), onClose: () => btn.classList.remove('open') });
  }

  // Text area with an accept button bottom-right (and optional extra tool buttons on the left).
  function tboxHTML({ cls = '', ph = '', okIcon = 'check', okTitle = 'Save', tools = '', hint = 'Ctrl+Enter', mono = false, rows = 1 } = {}) {
    return `<div class="tbox ${cls}"><textarea rows="${rows}" class="${mono ? 'mono' : ''}" placeholder="${esc(ph)}" spellcheck="true"></textarea><div class="staged"></div>
      <div class="tbox-bar">${tools}<span class="grow"></span><span class="hint">${esc(hint)}</span><button class="tb-ok" title="${esc(okTitle)}">${icon(okIcon)}</button></div></div>`;
  }
  function wireTbox(box, onAccept, { escape = null, submitOnEnter = false } = {}) {
    const ta = $('textarea', box);
    ta.addEventListener('input', () => autosize(ta));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (submitOnEnter && !e.shiftKey))) { e.preventDefault(); onAccept(); }
      if (e.key === 'Escape' && escape) { e.preventDefault(); e.stopPropagation(); escape(); }
    });
    $('.tb-ok', box).addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus so blur-save doesn't double fire
    $('.tb-ok', box).onclick = onAccept;
    return ta;
  }

  /* ═════════════════════════ chrome / header ═════════════════════════ */

  function buildChrome() {
    $('#topbar').innerHTML = `
      <div class="brand"><span class="logo" title="Next theme|Click to cycle through themes">${LOGO}</span><span class="app-name" id="appName"></span></div>
      <button class="pill-btn board-btn" id="boardBtn"><span id="boardName"></span>${icon('chev', 'sm')}</button>
      <label class="search">${icon('search')}<input id="search" placeholder="Filter" autocomplete="off" spellcheck="false"><kbd>/</kbd></label>
      <span class="grow"></span>
      <button class="pill-btn master-btn" id="masterBtn" hidden></button>
      <button class="pill-btn needs-btn" id="needsBtn" title="Needs you|Tickets where an agent is waiting for your answer" hidden>${icon('ask')}<span id="needsCount"></span></button>
      <button class="pill-btn catch-btn" id="catchBtn" title="While you were away|Tickets agents changed since you last looked" hidden>${icon('sparkle')}<span id="catchCount"></span></button>
      <button class="pill-btn icon-btn" id="inboxBtn" title="Inbox|Everything addressed to you — mentions, replies, questions and handoffs">${icon('bell')}<span class="badge" hidden></span></button>
      <button class="pill-btn icon-btn" id="digestBtn" title="Digest|Daily end-of-session summaries from agents and you">${icon('news')}<span class="dot" hidden></span></button>
      <button class="pill-btn icon-btn" id="rulesBtn" title="Standing rules|Instructions every agent reads before it starts work">${icon('pin')}<span class="dot" hidden></span></button>
      <button class="pill-btn agents-btn" id="agentsBtn" title="Agents|Who is connected, what they hold and what they listen to"><span class="stack-av" id="agentAvs"></span><span id="agentCount"></span></button>
      <button class="pill-btn icon-btn" id="bulkBtn" title="Select|Pick several tickets to move, re-prioritise or archive">${icon('checks')}</button>
      <button class="pill-btn icon-btn" id="settingsBtn" title="Settings|Themes, card contents, ticket fields and alerts">${icon('sliders')}</button>`;
    $('#boardBtn').onclick = (e) => boardMenu(e.currentTarget);
    $('#search').oninput = (e) => { state.query = e.target.value; applyFilter(); };
    $('#masterBtn').onclick = (e) => masterMenu(e.currentTarget);
    $('#needsBtn').onclick = () => { const ids = needsIds(); if (ids.length) openItem(ids[0], cardEls.get(ids[0]), { rail: true }); };
    $('#rulesBtn').onclick = openRules;
    $('#catchBtn').onclick = openCatchup;
    $('#digestBtn').onclick = openDigest;
    $('#inboxBtn').onclick = openInbox;
    $('#agentsBtn').onclick = openAgents;
    $('#bulkBtn').onclick = () => setBulk(!state.bulk);
    $('#settingsBtn').onclick = () => openSettings();
    $('.logo').onclick = (e) => {
      const keys = Object.keys(THEMES);
      switchTheme(keys[(keys.indexOf(settings.theme) + 1) % keys.length], e.clientX, e.clientY);
    };
    $('#board').addEventListener('scroll', updateOverflow, { passive: true });
    addEventListener('resize', updateOverflow);
  }

  function updateOverflow() {
    const b = $('#board');
    const ov = [];
    if (b.scrollLeft > 4) ov.push('l');
    if (b.scrollLeft + b.clientWidth < b.scrollWidth - 4) ov.push('r');
    b.dataset.ov = ov.join(' ');
    // Align the header with the column group, so the logo and the last button line up with the outer columns.
    const cols = $$('.column', b);
    const r = document.documentElement.style;
    if (!cols.length || ov.length || innerWidth < 640) { r.removeProperty('--frame-l'); r.removeProperty('--frame-r'); return; }
    const first = cols[0].getBoundingClientRect();
    const last = cols[cols.length - 1].getBoundingClientRect();
    r.setProperty('--frame-l', `${Math.max(12, Math.round(first.left))}px`);
    r.setProperty('--frame-r', `${Math.max(12, Math.round(innerWidth - last.right))}px`);
  }

  function renderHeader() {
    if (!state.board) return;
    $('#appName').textContent = state.app.name;
    document.title = `${state.board.name} · ${state.app.name}`;
    $('#boardName').textContent = state.board.name;
    const needs = needsIds().length;
    $('#needsBtn').hidden = !needs;
    $('#needsCount').textContent = needs;
    $('#rulesBtn .dot').hidden = !state.board.directives?.trim();
    const ms = activeMaster();
    const mb = $('#masterBtn');
    mb.hidden = !ms;
    if (ms) {
      mb.innerHTML = `${icon('lock', 'sm')}${avatar({ kind: ms.kind === 'user' ? 'user' : 'agent', name: ms.holder })}<span class="ms">${esc(ms.status || 'holds the board')}</span>`;
      mb.dataset.tip = `Board held by ${ms.holder}|Working alone — other agents can only comment or ask${ms.expiresAt ? ` · until ${new Date(ms.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}. Click to release.`;
    }
    const lastDigest = state.board.digest?.[state.board.digest.length - 1]?.ts || '';
    $('#digestBtn .dot').hidden = !lastDigest || lastDigest <= (digestSeen[state.boardId] || '');
    $('#bulkBtn').classList.toggle('on', state.bulk);
    renderPresenceButton();
    $('#build').innerHTML = `<span class="live-dot ${state.live ? 'on' : ''}" title="${state.live ? 'Live' : 'Reconnecting'}"></span>
      <span title="Build|Version · build · board hash — the hash changes on every board edit">v${esc(state.app.version || '')} · ${esc(state.app.build || '')} · ${esc((state.hash || '').slice(0, 8))}</span>`;
  }

  function renderPresenceButton() {
    const online = state.presence.filter((p) => p.online);
    $('#agentAvs').innerHTML = online.length ? online.slice(0, 3).map((p) => avatar({ kind: 'agent', name: p.name })).join('') : icon('bot');
    $('#agentCount').innerHTML = online.length ? `<span class="live"></span>${online.length}` : '';
  }

  async function refreshPresence() {
    try {
      const [pres, st] = await Promise.all([api('GET', '/api/presence'), api('GET', '/api/agents')]);
      state.presence = pres;
      state.standing = Object.fromEntries(st.agents.map((a) => [a.name, a]));
    } catch { return; }
    // run-state dots on every avatar already on screen (cards only re-render when they change)
    for (const av of $$('.avatar[data-name]')) {
      const run = state.standing[av.dataset.name]?.status;
      if (run && run !== 'idle') av.dataset.run = run; else delete av.dataset.run;
    }
    renderPresenceButton();
    if ($('#agentsDrawer')) fillAgents($('#agentsDrawer .drawer-body'));
  }

  function boardMenu(anchor) {
    const items = state.boards.map((b) => ({
      label: b.name, icon: 'board', hint: b.needsHuman ? `${b.needsHuman}?` : String(b.items), cls: b.id === state.boardId ? 'on' : '',
      run: () => { closeModal(true); loadBoard(b.id); },
    }));
    items.push('-', { label: 'Archive', icon: 'archive', hint: String(state.archivedCount), run: openArchive });
    menu(anchor, items);
  }

  async function refreshProfiles() {
    try { state.profiles = await api('GET', '/api/profiles'); } catch { return; }
    settingsVersion++;
    render();
    renderPresenceButton();
    state.modal?.refresh();
  }

  const activeMaster = () => {
    const m = state.board?.master;
    return m && (!m.expiresAt || Date.parse(m.expiresAt) > nowMs()) ? m : null;
  };
  function masterMenu(anchor) {
    const ms = activeMaster();
    if (!ms) return;
    const mine = ms.holder === settings.userName;
    menu(anchor, [{ label: mine ? 'Release the board' : `Revoke ${ms.holder}'s hold`, icon: 'x', cls: mine ? '' : 'danger',
      run: async () => { try { await api('DELETE', B('/master')); scheduleRefresh(0); } catch (e) { toast(e.message, { kind: 'error' }); } } }]);
  }

  async function refreshBoards() { try { state.boards = await api('GET', '/api/boards'); } catch { /* offline */ } }

  /* ═════════════════════════ board render (keyed + FLIP) ═════════════════════════ */

  const colEls = new Map();
  const cardEls = new Map();
  const groupEls = new Map();
  let drag = null;

  function resetBoardDom() {
    $('#board').innerHTML = '';
    colEls.clear(); cardEls.clear(); groupEls.clear();
    state.selected.clear();
  }

  function snapshotRects() {
    const m = new Map();
    for (const [id, c] of cardEls) if (c.isConnected) m.set(c, { r: c.getBoundingClientRect(), col: c.closest('.column')?.dataset.id, id });
    for (const g of groupEls.values()) if (g.isConnected) m.set(g, { r: g.getBoundingClientRect() });
    return m;
  }

  function layoutColumn(col) {
    const items = state.board.items;
    const ids = col.itemIds.filter((id) => items[id]);
    if (settings.grouping === 'off' || !shown('parent')) return ids.map((id) => ({ kind: 'card', id }));
    const byParent = new Map();
    for (const id of ids) {
      const p = items[id].parent;
      if (p) { if (!byParent.has(p)) byParent.set(p, []); byParent.get(p).push(id); }
    }
    const out = [];
    const done = new Set();
    for (const id of ids) {
      const p = items[id].parent;
      if (p && byParent.get(p).length > 1) {
        if (done.has(p)) continue;
        done.add(p);
        out.push({ kind: 'group', key: `${col.id}::${p}`, parent: p, ids: byParent.get(p) });
      } else out.push({ kind: 'card', id });
    }
    return out;
  }

  function render() {
    if (!state.board || drag) return;
    const before = snapshotRects();
    const boardEl = $('#board');
    const b = state.board;

    b.columns.forEach((col, i) => {
      let c = colEls.get(col.id);
      if (!c) { c = buildColumn(col.id); colEls.set(col.id, c); }
      updateColumn(c, col);
      if (boardEl.children[i] !== c) boardEl.insertBefore(c, boardEl.children[i] || null);
    });
    for (const [id, c] of colEls) if (!b.columns.some((x) => x.id === id)) { c.remove(); colEls.delete(id); }

    const seenCards = new Set();
    const seenGroups = new Set();
    for (const col of b.columns) {
      const list = $('.list', colEls.get(col.id));
      layoutColumn(col).forEach((n, idx) => {
        let node;
        if (n.kind === 'card') { node = ensureCard(n.id); seenCards.add(n.id); node.style.removeProperty('--si'); }
        else {
          node = ensureGroup(n.key);
          seenGroups.add(n.key);
          updateGroup(node, n);
          const inner = $('.group-cards', node);
          inner.dataset.n = n.ids.length;
          n.ids.forEach((id, j) => {
            const c = ensureCard(id);
            seenCards.add(id);
            c.style.setProperty('--si', j);
            if (inner.children[j] !== c) inner.insertBefore(c, inner.children[j] || null);
          });
        }
        if (list.children[idx] !== node) list.insertBefore(node, list.children[idx] || null);
      });
    }

    for (const [id, c] of cardEls) if (!seenCards.has(id)) { animateOut(c, before.get(c)?.r); cardEls.delete(id); state.selected.delete(id); }
    for (const [k, g] of groupEls) if (!seenGroups.has(k)) { g.remove(); groupEls.delete(k); }
    for (const id of seenCards) updateCard(cardEls.get(id), b.items[id]);

    applyFilter();
    flip(before);
    renderBulkBar();
    requestAnimationFrame(updateOverflow);
  }

  const SPRING = 'cubic-bezier(.2,.9,.25,1.12)';
  function flip(before, { flights = true } = {}) {
    if (reduced()) return;
    for (const [node, a] of before) {
      if (!node.isConnected) continue;
      const r = node.getBoundingClientRect();
      const dx = a.r.left - r.left;
      const dy = a.r.top - r.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const newCol = node.closest('.column')?.dataset.id;
      if (flights && a.col && newCol && a.col !== newCol) { fly(node, a.r, r); continue; }
      node.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0px 0px' }], { duration: 520, easing: SPRING });
    }
    for (const node of [...cardEls.values(), ...groupEls.values()]) {
      if (before.has(node) || !node.isConnected || !node.getBoundingClientRect().width) continue;
      node.animate([{ opacity: 0, scale: 0.86 }, { opacity: 1, scale: 1 }], { duration: 420, easing: SPRING });
    }
  }

  // Cross-column moves fly a ghost above everything so overflow clipping never hides the trip.
  function fly(node, from, to) {
    const ghost = node.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('flash', 'morph-src');
    Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    document.body.append(ghost);
    // Hide instantly: the card's CSS opacity transition would otherwise fade it out at its destination.
    node.style.transition = 'none';
    node.style.opacity = '0';
    const lift = Math.min(60, Math.abs(to.left - from.left) * 0.12);
    ghost.animate([
      { translate: '0px 0px', rotate: '0deg', scale: 1 },
      { translate: `${(to.left - from.left) / 2}px ${(to.top - from.top) / 2 - lift}px`, rotate: `${Math.sign(to.left - from.left) * 4}deg`, scale: 1.05, offset: 0.5 },
      { translate: `${to.left - from.left}px ${to.top - from.top}px`, rotate: '0deg', scale: 1 },
    ], { duration: 700, easing: 'cubic-bezier(.5,0,.25,1)' }).onfinish = () => {
      ghost.remove(); node.style.opacity = ''; void node.offsetWidth; node.style.transition = '';
      node.classList.remove('landed'); void node.offsetWidth; node.classList.add('landed');
    };
  }

  function animateOut(node, rect) {
    if (!rect || reduced() || !node.isConnected) { node.remove(); return; }
    Object.assign(node.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, margin: 0, zIndex: 50, pointerEvents: 'none' });
    document.body.append(node);
    node.animate([{ opacity: 1, scale: 1, filter: 'blur(0)' }, { opacity: 0, scale: 0.7, filter: 'blur(6px)', translate: '0 -20px' }], { duration: 380, easing: 'ease-in' }).onfinish = () => node.remove();
  }

  /* ─── columns ─── */

  function buildColumn(id) {
    const c = el(`<section class="column" data-id="${esc(id)}">
      <header class="col-head"><span class="col-dot"></span><span class="col-icon"></span><h2 class="col-name"></h2><span class="col-gate" hidden>${icon('user', 'sm')}</span><span class="col-count"></span><span class="grow"></span>
        <button class="col-add" title="New ticket|Quick syntax: Fix login #auth !high /issue">${icon('plus')}</button></header>
      <div class="col-wip" hidden><i></i></div>
      <div class="composer">${tboxHTML({ ph: 'New ticket…', okIcon: 'plus', okTitle: 'Create', hint: 'Enter', rows: 2 })}</div>
      <div class="list"></div></section>`);
    $('.col-add', c).onclick = () => openComposer(id);
    $('.col-count', c).onclick = () => {
      if (!state.bulk) return;
      const ids = colById(id)?.itemIds || [];
      const all = ids.every((x) => state.selected.has(x));
      ids.forEach((x) => (all ? state.selected.delete(x) : state.selected.add(x)));
      render();
    };
    const ta = wireTbox($('.composer .tbox', c), () => submitComposer(id), { escape: () => closeComposer(id), submitOnEnter: true });
    ta.addEventListener('blur', () => setTimeout(() => { if (!ta.value.trim() && document.activeElement !== ta) closeComposer(id); }, 120));
    return c;
  }

  function updateColumn(c, col) {
    c.style.setProperty('--col', col.color || 'var(--accent)');
    $('.col-name', c).textContent = col.name;
    $('.col-icon', c).innerHTML = ICONS[col.icon] ? icon(col.icon, 'sm') : col.icon && col.icon.length <= 2 ? esc(col.icon) : '';
    const n = col.itemIds.length;
    const wip = col.flags.wipLimit;
    const cnt = $('.col-count', c);
    cnt.textContent = wip ? `${n}/${wip}` : n;
    cnt.classList.toggle('full', !!wip && n >= wip);
    const bar = $('.col-wip', c);
    bar.hidden = !wip;
    if (wip) { bar.style.setProperty('--w', `${Math.min(100, (n / wip) * 100)}%`); bar.classList.toggle('full', n >= wip); }
    $('.col-add', c).hidden = !col.flags.allowCreate || (!!wip && n >= wip);
    if (!col.flags.allowCreate) c.classList.remove('composing');
    const gate = $('.col-gate', c);
    gate.hidden = !(col.flags.humanOnlyIn || col.flags.humanOnlyOut);
    gate.dataset.tip = `Approval gate|${[col.flags.humanOnlyIn && 'only humans move tickets in', col.flags.humanOnlyOut && 'only humans move tickets out'].filter(Boolean).join(' · ')}`;
    cnt.dataset.tip = wip ? `WIP limit|${n} of ${wip} slots used` : `${n} ticket${n === 1 ? '' : 's'}`;
  }

  function openComposer(colId) {
    const c = colEls.get(colId);
    c.classList.add('composing');
    $('.composer textarea', c).focus();
  }
  function closeComposer(colId) {
    const c = colEls.get(colId);
    if (!c) return;
    c.classList.remove('composing');
    $('.composer textarea', c).value = '';
  }
  // Quick syntax: "Fix login #auth !high /issue"
  async function submitComposer(colId) {
    const c = colEls.get(colId);
    const ta = $('.composer textarea', c);
    let text = ta.value;
    const body = { column: colId, position: 'top' };
    text = text.replace(/(^|\s)#([\w./-]+)/g, (_, s, p) => { body.parent = p; return s; });
    text = text.replace(/(^|\s)!(low|med(?:ium)?|high|crit(?:ical)?)\b/gi, (_, s, p) => { body.priority = PRIORITIES.find((x) => x.toLowerCase().startsWith(p.toLowerCase().slice(0, 3))); return s; });
    text = text.replace(/(^|\s)\/(issue|task|spike)\b/gi, (_, s, t) => { body.type = t.toLowerCase(); return s; });
    body.title = text.replace(/\s+/g, ' ').trim();
    const box = $('.composer', c);
    if (!body.title) { box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); return; }
    ta.value = '';
    autosize(ta);
    ta.focus();
    try { await api('POST', B('/items'), body); scheduleRefresh(0); } catch (e) { toast(e.message, { kind: 'error' }); ta.value = text; }
  }

  /* ─── groups ─── */

  function ensureGroup(key) {
    let g = groupEls.get(key);
    if (g) return g;
    g = el(`<section class="group" data-key="${esc(key)}"><button class="group-head"><span class="g-dot"></span><span class="g-name"></span><span class="g-count"></span><span class="grow"></span>${icon('chev', 'g-chev')}</button><div class="group-cards"></div></section>`);
    $('.group-head', g).onclick = () => toggleGroup(key);
    $('.group-cards', g).addEventListener('click', () => { if (g.classList.contains('stack') && !g.classList.contains('open')) toggleGroup(key); });
    groupEls.set(key, g);
    return g;
  }
  function updateGroup(g, n) {
    const mode = settings.grouping;
    g.className = `group ${mode}${mode === 'stack' && state.expanded.has(n.key) ? ' open' : ''}${mode === 'list' && state.folded.has(n.key) ? ' folded' : ''}`;
    g.style.setProperty('--tagc', tagColor(n.parent));
    $('.g-name', g).textContent = n.parent;
    $('.g-count', g).textContent = n.ids.length;
  }
  function toggleGroup(key) {
    const set = settings.grouping === 'stack' ? state.expanded : state.folded;
    if (set.has(key)) set.delete(key); else set.add(key);
    render();
  }

  /* ─── cards ─── */

  function ensureCard(id) {
    let c = cardEls.get(id);
    if (c) return c;
    c = el(`<article class="card" data-id="${esc(id)}" tabindex="0"><i class="tape"></i><div class="c-body"></div><span class="c-check">${icon('check')}</span><span class="c-ask" title="Needs you|An agent is waiting for your answer">?</span></article>`);
    c.addEventListener('pointerdown', onCardPointerDown);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') openItem(id, c); });
    cardEls.set(id, c);
    return c;
  }

  function updateCard(c, it) {
    if (!c || !it) return;
    const lease = activeLease(it);
    const blockers = openBlockers(it);
    const inGroup = !!c.closest('.group');
    c.dataset.type = it.type;
    c.style.setProperty('--tilt', `${tilt(it.id)}deg`);
    c.classList.toggle('needs', !!it.needsHuman);
    c.classList.toggle('selected', state.selected.has(it.id));
    const ageN = Number(settings.ageDays);
    const age = ageN ? clamp((idleDays(it) - 1) / Math.max(1, ageN - 1), 0, 1) : 0;
    c.style.setProperty('--age', age.toFixed(2));
    c.classList.toggle('aged', age > 0.05);
    c.classList.toggle('review', it.needsHuman?.kind === 'review');
    c.classList.toggle('unseen', !!(state.boardId && seenFor(state.boardId).items[it.id]));
    const sig = [it.version, settingsVersion, state.board.schema && JSON.stringify(state.board.schema).length, lease?.claimant, lease?.expiresAt, lease?.status, blockers.length, inGroup, state.listeners[it.id]?.join(','), Math.floor(idleDays(it))].join('|');
    if (c._sig === sig) return;
    const changed = c._v != null && c._v !== it.version;
    c._sig = sig;
    c._v = it.version;
    $('.c-body', c).innerHTML = cardHTML(it, lease, blockers, inGroup);
    tickRings(c);
    if (changed && !c.classList.contains('placeholder')) { c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); }
  }

  function idleDays(it) {
    const last = state.board?.columns[state.board.columns.length - 1]?.id;
    if (!it || it.columnId === last) return 0;
    const t = Math.max(Date.parse(it.updatedAt) || 0, Date.parse(it.enteredColumnAt) || 0);
    return Math.max(0, (nowMs() - t) / 86400000);
  }

  function checklist(d) {
    let total = 0;
    let done = 0;
    for (const l of String(d || '').split('\n')) { const m = /^\s*[-*+]\s+\[( |x|X)\]/.exec(l); if (m) { total++; if (m[1] !== ' ') done++; } }
    return { total, done };
  }

  const TYPE_TIPS = { issue: 'Issue|Something is broken', task: 'Task|A piece of work to do', spike: 'Spike|Time-boxed research or investigation' };

  function stripMd(s) { return String(s).replace(/```[\s\S]*?```/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#>*_`~-]+/g, ' ').replace(/\s+/g, ' ').trim(); }

  function ringHTML(lease) {
    const kind = lease.claimant === settings.userName ? 'user' : 'agent';
    return `<span class="ring" data-exp="${esc(lease.expiresAt)}" data-min="${lease.minutes || 30}" title="Lease|${esc(lease.claimant)} is working on this until ${new Date(lease.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}">${avatar({ kind, name: lease.claimant })}<svg viewBox="0 0 24 24"><circle class="trk" cx="12" cy="12" r="10.5" pathLength="100"/><circle class="prg" cx="12" cy="12" r="10.5" pathLength="100"/></svg></span>`;
  }

  // Human-readable rendering of a declared field value (cards, read-only views).
  function fieldText(def, v) {
    if (v == null) return '';
    switch (def.type) {
      case 'boolean': return v ? def.label : '';
      case 'tags': return v.join(', ');
      case 'date': { const d = new Date(v); return Number.isNaN(+d) ? String(v) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
      case 'url': try { return new URL(v).host; } catch { return v; }
      case 'markdown': return stripMd(v).slice(0, 60);
      default: return String(v);
    }
  }
  const optColor = (def, v) => def.options?.find((o) => o.value === v)?.color;

  function cardHTML(it, lease, blockers, inGroup, ls = state.listeners[it.id]) {
    const s = settings.stub;
    const PREF = { blockedBy: 'blocked', cover: 'thumbnail', assignee: 'assignee' };
    const stub = (k) => s[PREF[k] || k] && bi(k).stub && shown(k);
    const fields = schema().fields.filter((f) => f.ui !== 'hidden' && it.fields?.[f.key] != null && s.fields);
    const top = [];
    if (stub('type')) top.push(`<span class="c-type" title="${TYPE_TIPS[it.type]}">${icon(it.type, 'sm')}</span>`);
    if (s.id) top.push(`<span class="c-id">${esc(it.id)}</span>`);
    top.push('<span class="grow"></span>');
    for (const f of fields.filter((x) => x.stub === 'top')) {
      const t = fieldText(f, it.fields[f.key]);
      if (t) top.push(`<span class="fbadge" style="--fc:${esc(optColor(f, it.fields[f.key]) || 'var(--accent)')}" title="${esc(f.label)}|${esc(f.help || t)}">${esc(t)}</span>`);
    }
    if (stub('priority') && it.priority !== 'Medium') {
      const p = it.priority.toLowerCase();
      top.push(`<span class="prio" data-p="${p}" title="Priority|${it.priority}">${icon('flag')}${p === 'high' || p === 'critical' ? it.priority : ''}</span>`);
    }
    if (s.lease && lease) top.push(ringHTML(lease));
    const meta = [];
    if (stub('parent') && it.parent && !inGroup) meta.push(`<span class="chip parent" title="Parent|Grouped with other #${esc(it.parent)} tickets" style="--tagc:${tagColor(it.parent)}">${esc(it.parent)}</span>`);
    if (stub('blockedBy') && blockers.length) meta.push(`<span class="chip blocked" title="Blocked|Waiting on ${esc(blockers.join(', '))}">${icon('lock', 'sm')}${blockers.length}</span>`);
    for (const f of fields.filter((x) => x.stub === 'meta')) {
      const v = it.fields[f.key];
      const t = fieldText(f, v);
      if (!t) continue;
      const ic = ICONS[f.icon] ? f.icon : FIELD_ICON[f.type];
      meta.push(f.type === 'boolean'
        ? `<span class="fchip" style="--fc:var(--ok)" title="${esc(f.label)}">${icon(ic, 'sm')}${esc(f.label)}</span>`
        : `<span class="fchip" style="--fc:${esc(optColor(f, v) || 'var(--muted)')}" title="${esc(f.label)}">${icon(ic, 'sm')}<b>${esc(t)}</b></span>`);
    }
    const idle = Math.floor(idleDays(it));
    if (Number(settings.ageDays) && idle >= Math.ceil(Number(settings.ageDays) / 2)) meta.push(`<span class="m age" title="Untouched|No activity for ${idle} days">${icon('clock', 'sm')}${idle}d</span>`);
    if (s.comments && it.comments.length) meta.push(`<span class="m" title="Comments|${it.comments.length} in the thread">${icon('msg', 'sm')}${it.comments.length}</span>`);
    if (s.attachments && stub('attachments') && it.attachments.length) meta.push(`<span class="m" title="Files|${it.attachments.length} attached">${icon('clip', 'sm')}${it.attachments.length}</span>`);
    const nProps = Object.keys(it.properties || {}).length;
    if (s.properties && shown('properties') && nProps) meta.push(`<span class="m" title="Properties|Free-form data agents attached">${icon('braces', 'sm')}${nProps}</span>`);
    if (stub('assignee') && it.assignee) meta.push(`<span class="m assn" title="${esc(bi('assignee').label)}|Handed to ${esc(it.assignee)} — they get its events">${icon('move', 'sm')}${avatar({ name: it.assignee })}</span>`);
    const ck = checklist(it.description);
    if (s.checklist && ck.total) meta.push(`<span class="m" title="Checklist|${ck.done} of ${ck.total} done">${icon('checks', 'sm')}${ck.done}/${ck.total}</span>`);
    if (s.listeners && ls?.length) meta.push(`<span class="m listen" title="Listening|${esc(ls.join(', '))} ${ls.length > 1 ? 'get' : 'gets'} events about this ticket">${icon('radio', 'sm')}<span class="stack-av">${ls.slice(0, 3).map((n) => avatar({ kind: 'agent', name: n })).join('')}</span>${ls.length > 3 ? `+${ls.length - 3}` : ''}</span>`);
    const hasMeta = meta.length > 0;
    if (s.author) meta.push('<span class="grow"></span>', avatar(it.author));
    const desc = s.description && shown('description') && it.description ? `<p class="c-desc">${esc(stripMd(it.description).slice(0, 220))}</p>` : '';
    const img = stub('cover') ? coverOf(it) : null;
    const thumb = img ? `<div class="c-thumb"><img src="${esc(img.url)}" alt="" loading="lazy" draggable="false"></div>` : '';
    return `<div class="c-top">${top.join('')}</div><h3 class="c-title">${esc(it.title)}</h3>${s.status && lease?.status ? `<div class="c-status" title="Live status|Posted by ${esc(lease.claimant)} while working"><i></i><span>${esc(lease.status)}</span></div>` : ''}${desc}${s.checklist && ck.total ? `<div class="c-prog ${ck.done === ck.total ? 'full' : ''}"><i style="width:${(ck.done / ck.total) * 100}%"></i></div>` : ''}${thumb}${hasMeta || s.author ? `<div class="c-meta">${meta.join('')}</div>` : ''}`;
  }

  function tickRings(root = document) {
    for (const r of $$('.ring[data-exp]', root)) {
      const left = Date.parse(r.dataset.exp) - nowMs();
      const frac = clamp(left / (Number(r.dataset.min) * 60000), 0, 1);
      const prg = $('.prg', r);
      if (prg) prg.style.strokeDashoffset = String(100 - frac * 100);
      r.classList.toggle('warn', left < 5 * 60000 && left >= 60000);
      r.classList.toggle('crit', left < 60000);
      if (left <= 0) scheduleRefresh(800);
    }
  }

  /* ─── filter ─── */

  function parseQuery(q) {
    const f = { text: [], parent: null, prio: null, type: null, who: null, props: [], is: [] };
    for (const t of q.trim().split(/\s+/).filter(Boolean)) {
      const low = t.toLowerCase();
      if (t[0] === '#' && t.length > 1) f.parent = low.slice(1);
      else if (t[0] === '!' && t.length > 1) f.prio = low.slice(1);
      else if (t[0] === '/' && t.length > 1) f.type = low.slice(1);
      else if (t[0] === '@' && t.length > 1) f.who = low.slice(1);
      else if (low.startsWith('is:')) f.is.push(low.slice(3));
      else if (/^[\w.-]+[:=].+/.test(t)) { const i = t.search(/[:=]/); f.props.push([low.slice(0, i), low.slice(i + 1)]); }
      else f.text.push(low);
    }
    return f;
  }
  function matches(it, f) {
    if (f.parent && !(it.parent || '').toLowerCase().includes(f.parent)) return false;
    if (f.prio && !it.priority.toLowerCase().startsWith(f.prio)) return false;
    if (f.type && !it.type.startsWith(f.type)) return false;
    if (f.who) {
      const names = [it.author?.name, activeLease(it)?.claimant].filter(Boolean).map((x) => x.toLowerCase());
      if (!names.some((n) => n.includes(f.who))) return false;
    }
    for (const flag of f.is) {
      if (flag === 'needs' && !it.needsHuman) return false;
      if (flag === 'blocked' && !openBlockers(it).length) return false;
      if (flag === 'leased' && !activeLease(it)) return false;
      if (flag === 'free' && activeLease(it)) return false;
    }
    const bag = { ...(it.properties || {}), ...(it.fields || {}) };
    for (const [k, v] of f.props) {
      const key = Object.keys(bag).find((x) => x.toLowerCase() === k);
      if (!key || !JSON.stringify(bag[key]).toLowerCase().includes(v)) return false;
    }
    if (f.text.length) {
      const hay = `${it.id} ${it.title} ${it.description} ${it.parent || ''}`.toLowerCase();
      if (!f.text.every((t) => hay.includes(t))) return false;
    }
    return true;
  }
  function applyFilter() {
    const q = state.query.trim();
    const f = q ? parseQuery(q) : null;
    for (const [id, c] of cardEls) c.classList.toggle('dim', !!f && !matches(state.board.items[id], f));
  }

  /* ═════════════════════════ drag & drop ═════════════════════════ */

  function onCardPointerDown(e) {
    if (e.button !== 0 || e.target.closest('button, a, input, textarea, .avatar')) return;
    const card = e.currentTarget;
    if (card.closest('.group.stack:not(.open)')) return;
    const id = card.dataset.id;
    const start = { x: e.clientX, y: e.clientY };
    const move = (ev) => {
      if (!drag) {
        if (state.bulk || Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        beginDrag(card, id, start);
      }
      ev.preventDefault();
      dragMove(ev);
    };
    const up = (ev) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      if (drag) endDrag(ev.type === 'pointercancel');
      else if (ev.type === 'pointerup') { if (state.bulk) toggleSelect(id); else openItem(id, card); }
    };
    addEventListener('pointermove', move, { passive: false });
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }

  function beginDrag(card, id, start) {
    const r = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('flash', 'landed');
    Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px` });
    document.body.append(ghost);
    const from = colById(state.board.items[id].columnId);
    ghost.style.willChange = 'translate, rotate';
    drag = { id, card, ghost, x0: r.left, y0: r.top, off: { x: start.x - r.left, y: start.y - r.top }, fromCol: from.id, targetCol: from.id, beforeId: undefined, key: null, px: start.x, tilt: 0, pointer: start };
    card.classList.add('placeholder');
    document.body.classList.add('dragging');
    for (const col of state.board.columns) {
      const full = col.flags.wipLimit > 0 && col.itemIds.length >= col.flags.wipLimit;
      const ok = col.id === from.id || (from.flags.allowMoveOut && col.flags.allowMoveIn && !full);
      colEls.get(col.id).classList.add(ok ? 'drop-ok' : 'drop-no');
    }
    ghost.animate([{ scale: 1 }, { scale: 1.04 }], { duration: 180, fill: 'forwards', easing: SPRING });
    autoScrollLoop();
  }

  function dropSlots(list, exclude) {
    const slots = [];
    for (const child of list.children) {
      if (child === exclude) continue;
      if (child.classList.contains('card')) slots.push({ el: child, firstId: child.dataset.id });
      else if (child.classList.contains('group')) {
        const cards = $$('.card', child).filter((x) => x !== exclude);
        if (!cards.length) continue;
        if ((child.classList.contains('stack') && !child.classList.contains('open')) || child.classList.contains('folded')) slots.push({ el: child, firstId: cards[0].dataset.id });
        else for (const c of cards) slots.push({ el: c, firstId: c.dataset.id });
      }
    }
    return slots;
  }

  function dragMove(ev) {
    const d = drag;
    d.pointer = { x: ev.clientX, y: ev.clientY };
    const vx = ev.clientX - d.px;
    d.px = ev.clientX;
    d.tilt = clamp(d.tilt * 0.75 + vx * 0.5, -10, 10);
    d.ghost.style.translate = `${ev.clientX - d.off.x - d.x0}px ${ev.clientY - d.off.y - d.y0}px`;
    d.ghost.style.rotate = `${2 + d.tilt * 0.6}deg`;
    const colEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.column');
    $$('.column.hover').forEach((x) => x !== colEl && x.classList.remove('hover'));
    if (!colEl || !colEl.classList.contains('drop-ok')) return;
    colEl.classList.add('hover');
    const list = $('.list', colEl);
    let target = null;
    for (const s of dropSlots(list, d.card)) {
      const r = s.el.getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) { target = s; break; }
    }
    const key = `${colEl.dataset.id}:${target ? target.firstId : '$end'}`;
    if (key === d.key) return;
    d.key = key;
    const before = snapshotRects();
    before.delete(d.card);
    if (target) target.el.parentNode.insertBefore(d.card, target.el);
    else list.appendChild(d.card);
    d.targetCol = colEl.dataset.id;
    d.beforeId = target ? target.firstId : null;
    flip(before, { flights: false });
  }

  function autoScrollLoop() {
    if (!drag) return;
    const { x, y } = drag.pointer;
    const board = $('#board');
    const edge = 70;
    if (x < edge) board.scrollLeft -= (edge - x) / 4;
    else if (x > innerWidth - edge) board.scrollLeft += (x - (innerWidth - edge)) / 4;
    const list = document.elementFromPoint(x, y)?.closest('.column')?.querySelector('.list');
    if (list) {
      const r = list.getBoundingClientRect();
      if (y < r.top + 50) list.scrollTop -= (r.top + 50 - y) / 4;
      else if (y > r.bottom - 50) list.scrollTop += (y - (r.bottom - 50)) / 4;
    }
    requestAnimationFrame(autoScrollLoop);
  }

  async function endDrag(cancelled) {
    const d = drag;
    drag = null;
    document.body.classList.remove('dragging');
    $$('.column').forEach((c) => c.classList.remove('drop-ok', 'drop-no', 'hover'));
    const r = d.card.getBoundingClientRect();
    d.ghost.animate([
      { translate: d.ghost.style.translate || '0px 0px', rotate: d.ghost.style.rotate, scale: 1.04 },
      { translate: `${r.left - d.x0}px ${r.top - d.y0}px`, rotate: `${tilt(d.id)}deg`, scale: 1 },
    ], { duration: reduced() ? 1 : 260, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'forwards' }).onfinish = () => {
      d.ghost.remove(); d.card.classList.remove('placeholder', 'landed'); void d.card.offsetWidth; d.card.classList.add('landed');
    };
    const col = colById(d.fromCol);
    const origIdx = col.itemIds.indexOf(d.id);
    const nextOrig = col.itemIds[origIdx + 1] ?? null;
    const unchanged = d.key === null || (d.targetCol === d.fromCol && (d.beforeId === nextOrig || d.beforeId === d.id));
    if (cancelled || unchanged) { setTimeout(render, 280); return; }
    // optimistic local move so a re-render doesn't snap back before the server answers
    col.itemIds.splice(origIdx, 1);
    const to = colById(d.targetCol);
    const at = d.beforeId ? to.itemIds.indexOf(d.beforeId) : -1;
    to.itemIds.splice(at < 0 ? to.itemIds.length : at, 0, d.id);
    state.board.items[d.id].columnId = to.id;
    setTimeout(render, 270);
    const body = { column: d.targetCol };
    if (d.beforeId) body.beforeId = d.beforeId; else body.position = 'bottom';
    try { await api('POST', I(d.id, '/move'), body); } catch (e) { toast(e.message, { kind: 'error' }); }
    scheduleRefresh(0);
  }

  /* ═════════════════════════ bulk ═════════════════════════ */

  function setBulk(on) {
    state.bulk = on;
    state.selected.clear();
    document.body.classList.toggle('bulk', on);
    $('#bulkBtn').classList.toggle('on', on);
    render();
  }
  function toggleSelect(id) {
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    updateCard(cardEls.get(id), state.board.items[id]);
    renderBulkBar(true);
  }
  function renderBulkBar(bump) {
    const bar = $('#bulkbar');
    const n = state.selected.size;
    bar.classList.toggle('show', state.bulk);
    if (!bar.firstChild) {
      bar.innerHTML = `<span class="count"></span>
        <button class="btn ghost" data-a="move">${icon('move')}<span>Move</span></button>
        <button class="btn ghost" data-a="prio">${icon('flag')}<span>Priority</span></button>
        <button class="btn danger" data-a="archive">${icon('archive')}<span>Archive</span></button>
        <button class="btn ghost" data-a="close" title="Done">${icon('x')}</button>`;
      bar.onclick = (e) => {
        const btn = e.target.closest('button');
        const a = btn?.dataset.a;
        if (a === 'close') setBulk(false);
        if (a === 'archive') bulkArchive();
        if (a === 'move') menu(btn, state.board.columns.map((c) => ({ label: c.name, color: c.color, disabled: !c.flags.allowMoveIn, run: () => bulkPatch({ column: c.id }) })), { up: true });
        if (a === 'prio') menu(btn, PRIORITIES.map((p) => ({ label: p, color: PRIO_VAR[p], run: () => bulkPatch({ priority: p }) })), { up: true });
      };
    }
    const cnt = $('.count', bar);
    cnt.textContent = n;
    if (bump) { cnt.classList.remove('bump'); void cnt.offsetWidth; cnt.classList.add('bump'); }
    $$('button[data-a]:not([data-a="close"])', bar).forEach((b) => { b.disabled = !n; });
  }
  async function bulkPatch(patch) {
    const res = await api('POST', B('/items/bulk'), { ids: [...state.selected], patch });
    const failed = res.filter((r) => !r.ok);
    if (failed.length) toast(`${failed.length} skipped · ${failed[0].error}`, { kind: 'error' });
    scheduleRefresh(0);
  }
  async function bulkArchive() {
    const ids = [...state.selected];
    try {
      await api('POST', B('/archive'), { ids });
      state.selected.clear();
      toast(`Archived ${ids.length}`, { icon: 'archive', action: 'Undo', onAction: () => restoreMany(ids) });
      scheduleRefresh(0);
    } catch (e) { toast(e.message, { kind: 'error' }); }
  }
  async function restoreMany(ids) {
    for (const id of ids) { try { await api('POST', B(`/archive/${encodeURIComponent(id)}/restore`), {}); } catch { /* already restored */ } }
    scheduleRefresh(0);
  }

  /* ═════════════════════════ markdown ═════════════════════════ */

  const safeUrl = (u) => /^(https?:|\/|#|mailto:)/i.test(u) || /^data:image\//i.test(u);
  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => `\u0001${codes.push(c) - 1}\u0001`);
    s = esc(s)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => (safeUrl(u) ? `<img alt="${a}" src="${u}" loading="lazy">` : a))
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => (safeUrl(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : t))
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(.+?)~~/g, '<del>$1</del>')
      .replace(/(^|[^\w/-])([A-Z][A-Z0-9]{1,7}-\d+)\b/g, '$1<a class="ref" data-ref="$2">$2</a>')
      .replace(/(^|\s)@([\w.-]+)/g, '$1<span class="mention">@$2</span>');
    return s.replace(/\u0001(\d+)\u0001/g, (_, n) => `<code>${esc(codes[n])}</code>`);
  }
  function md(src, { tasks = false } = {}) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    let out = '';
    const para = [];
    const flush = () => { if (para.length) { out += `<p>${para.map(inline).join('<br>')}</p>`; para.length = 0; } };
    const LIST = /^\s*([-*+]|\d+[.)])\s+/;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if ((m = /^\s*(```|~~~)/.exec(line))) {
        flush();
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(m[1])) buf.push(lines[i++]);
        i++;
        out += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
      } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flush(); out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; i++;
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush(); out += '<hr>'; i++;
      } else if (/^\s*>/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out += `<blockquote>${md(buf.join('\n'))}</blockquote>`;
      } else if (LIST.test(line)) {
        flush();
        const ordered = /^\s*\d/.test(line);
        let html = '';
        while (i < lines.length && LIST.test(lines[i])) {
          const nested = /^\s*/.exec(lines[i])[0].length >= 2 ? ' nested' : '';
          const raw = lines[i].replace(LIST, '');
          const task = /^\[( |x|X)\]\s+(.*)$/.exec(raw);
          html += task
            ? `<li class="task${nested}"><input type="checkbox" class="ck" data-line="${i}"${task[1] !== ' ' ? ' checked' : ''}${tasks ? '' : ' disabled'}><span>${inline(task[2])}</span></li>`
            : `<li class="${nested.trim()}">${inline(raw)}</li>`;
          i++;
        }
        out += ordered ? `<ol>${html}</ol>` : `<ul>${html}</ul>`;
      } else if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flush();
        const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = row(line);
        i += 2;
        let body = '';
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { body += `<tr>${row(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`; i++; }
        out += `<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
      } else if (!line.trim()) {
        flush(); i++;
      } else { para.push(line); i++; }
    }
    flush();
    return out;
  }

  document.addEventListener('click', (e) => {
    const av = e.target.closest('.avatar[data-name]');
    if (av && !e.target.closest('button, .dd, .menu, .tile, .swatches')) { e.preventDefault(); openAgent(av.dataset.name); return; }
    const ref = e.target.closest('a.ref');
    if (ref) { e.preventDefault(); if (state.board.items[ref.dataset.ref]) openItem(ref.dataset.ref); return; }
    const img = e.target.closest('.md img, .att img, .cmt-atts img');
    if (img) { e.preventDefault(); lightbox(img.src); }
  });

  function lightbox(src) {
    const lb = el(`<div class="lightbox"><img src="${esc(src)}" alt=""></div>`);
    lb.onclick = () => lb.remove();
    document.body.append(lb);
  }

  /* ═════════════════════════ scrims, shared-element morph ═════════════════════════ */

  function syncScrimmed() { document.body.classList.toggle('scrimmed', !!$('.scrim:not(.closing):not(.closing-morph)')); }

  // Grow the modal out of the card: start at the card's exact rect, cross-fade a copy of the card away.
  function morphOpen(modal, fromEl) {
    if (reduced() || !fromEl?.isConnected) { modal.classList.add('pop'); return null; }
    const r = fromEl.getBoundingClientRect();
    if (!r.width || r.bottom < 0 || r.top > innerHeight) { modal.classList.add('pop'); return null; }
    const mr = modal.getBoundingClientRect();
    const sx = r.width / mr.width;
    const sy = r.height / mr.height;
    const ghost = fromEl.cloneNode(true);
    ghost.classList.add('morph-ghost');
    ghost.classList.remove('flash', 'landed', 'morph-src', 'selected');
    Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    document.body.append(ghost);
    fromEl.classList.add('morph-src');
    const dur = 280;
    const ease = 'cubic-bezier(.2,.8,.2,1)';
    modal.animate([
      { transformOrigin: '0 0', transform: `translate(${r.left - mr.left}px, ${r.top - mr.top}px) scale(${sx}, ${sy})` },
      { transformOrigin: '0 0', transform: 'none' },
    ], { duration: dur, easing: ease });
    for (const c of modal.children) c.animate([{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1 }], { duration: dur, easing: 'ease-out' });
    ghost.animate([
      { transform: 'none', opacity: 1 },
      { transform: `translate(${mr.left - r.left}px, ${mr.top - r.top}px) scale(${mr.width / r.width}, ${mr.height / r.height})`, opacity: 0, offset: 0.55 },
      { transform: `translate(${mr.left - r.left}px, ${mr.top - r.top}px) scale(${mr.width / r.width}, ${mr.height / r.height})`, opacity: 0 },
    ], { duration: dur, easing: ease }).onfinish = () => ghost.remove();
    return fromEl;
  }

  function closeModal(instant) {
    const m = state.modal;
    if (!m) return;
    if (!instant && isDirty(m)) {
      if (Date.now() - (m.nudgedAt || 0) > 1500) { nudgeDraft(m); return; }
      m.draft = {};
      toast('Changes discarded', { icon: 'x', timeout: 1800 });
    }
    state.modal = null;
    closeMenus();
    // Prefer the live card for this item (the board may have re-rendered while the modal was open).
    const src = (m.kind === 'item' && cardEls.get(m.id)) || m.src;
    const finish = () => {
      m.root.remove();
      for (const c of [m.src, src]) c?.classList.remove('morph-src', 'is-open');
      syncScrimmed();
    };
    const r = src?.isConnected ? src.getBoundingClientRect() : null;
    const morph = m.enter === 'zoom' && !instant && !reduced() && r && r.width && r.bottom > 0 && r.top < innerHeight;
    // A morph keeps the modal visible and only fades the scrim's tint; otherwise the whole scrim fades.
    m.root.classList.add(morph ? 'closing-morph' : 'closing');
    syncScrimmed();
    if (instant || reduced()) { finish(); return; }
    if (morph) {
      src.classList.add('morph-src');
      const mr = m.modal.getBoundingClientRect();
      const sx = r.width / mr.width;
      const sy = r.height / mr.height;
      const dur = 240;
      const ease = 'cubic-bezier(.4,0,.2,1)';
      for (const c of m.modal.children) c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, fill: 'forwards' });
      m.modal.animate([
        { transformOrigin: '0 0', transform: 'none', opacity: 1 },
        { transformOrigin: '0 0', transform: `translate(${r.left - mr.left}px, ${r.top - mr.top}px) scale(${sx}, ${sy})`, opacity: 1, offset: 0.85 },
        { transformOrigin: '0 0', transform: `translate(${r.left - mr.left}px, ${r.top - mr.top}px) scale(${sx}, ${sy})`, opacity: 0 },
      ], { duration: dur, easing: ease, fill: 'forwards' });
      // The card itself fades in as the modal arrives, so the panel visibly "becomes" the stub.
      const ghost = src.cloneNode(true);
      ghost.classList.add('morph-ghost');
      ghost.classList.remove('flash', 'landed', 'morph-src', 'selected');
      Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      document.body.append(ghost);
      ghost.animate([
        { transform: `translate(${mr.left - r.left}px, ${mr.top - r.top}px) scale(${1 / sx}, ${1 / sy})`, opacity: 0 },
        { opacity: 0, offset: 0.35 },
        { transform: 'none', opacity: 1 },
      ], { duration: dur, easing: ease, fill: 'forwards' }).onfinish = () => {
        finish();
        ghost.remove();
        src.classList.remove('landed'); void src.offsetWidth; src.classList.add('landed');
      };
    } else {
      m.modal.classList.remove('entering');
      m.modal.classList.add('leaving');
      setTimeout(() => { finish(); if (src && m.kind === 'item') { src.classList.remove('landed'); void src.offsetWidth; src.classList.add('landed'); } }, 170);
    }
  }

  function pulseSaved() {
    const s = state.modal && $('.saved', state.modal.root);
    if (!s) return;
    s.classList.add('show');
    clearTimeout(s._t);
    s._t = setTimeout(() => s.classList.remove('show'), 1400);
  }

  /* ═════════════════════════ item modal ═════════════════════════ */

  async function fetchItem(id) {
    if (state.board.items[id]) return { item: state.board.items[id], archived: false };
    const it = await api('GET', I(id));
    return { item: it, archived: !!it.archived };
  }

  async function openItem(id, fromEl, { rail = false } = {}) {
    let got;
    try { got = await fetchItem(id); } catch (e) { toast(e.message, { kind: 'error' }); return; }
    closePalette();
    clearUnseen(id);
    markInboxItemRead(id);
    const cur = state.modal;
    if (cur?.kind === 'item') { cur.rail = rail || cur.rail; cur.switchTo(id, got); return; }
    closeModal(true);
    const root = el(`<div class="scrim"><div class="modal item-modal" role="dialog" aria-modal="true">
      <header class="m-head"><span class="m-type"></span><span class="m-id" title="Copy ID|Copy the ticket number to the clipboard"></span><span class="saved">${icon('check', 'sm')}</span><span class="grow"></span>
        <button class="pill-btn icon-btn sm" data-a="archive" title="Archive|Kept in the archive and restorable — tickets are never deleted">${icon('archive')}</button>
        <button class="pill-btn icon-btn sm" data-a="close" title="Close">${icon('x')}</button></header>
      <div class="m-frame"><nav class="m-rail" hidden></nav><div class="m-main"></div><aside class="m-side"></aside></div>
      <div class="m-save" hidden><span class="dot"></span><span class="txt"></span><span class="grow"></span>
        <button class="btn ghost sm" data-draft="discard">Discard</button><button class="btn primary sm" data-draft="save" title="Save|Apply your changes (Ctrl+S)">${icon('check', 'sm')}Save</button></div>
      <footer class="m-foot"></footer></div></div>`);
    document.body.append(root);
    syncScrimmed();
    const m = { kind: 'item', id, root, modal: $('.modal', root), item: got.item, archived: got.archived, rail, tab: 'comments', editingDesc: false, staged: [], draft: {}, baseVersion: null };
    state.modal = m;
    m.enter = pick('enter');
    if (m.enter === 'zoom') m.src = morphOpen(m.modal, fromEl);
    else { m.modal.classList.add('entering'); m.src = fromEl?.isConnected ? fromEl : null; m.src?.classList.add('is-open'); }
    m.refresh = () => {
      if (m.rail) renderRail(m);
      const fresh = state.board.items[m.id];
      if (!fresh) {
        if (!m.archived) { if (m.rail && needsIds().length) { m.switchTo(needsIds()[0]); return; } closeModal(); toast(`${m.id} archived`, { icon: 'archive' }); }
        return;
      }
      const changed = fresh.version !== m.item.version;
      const answered = !!m.item.needsHuman && !fresh.needsHuman;
      m.item = fresh;
      if (m.rail && answered) { advanceRail(m); return; }
      pruneDraft(m);
      fillModal(m);
      renderSaveBar(m);
      if (changed && m.tab === 'activity') loadActivity(m);
    };
    m.switchTo = async (nid, pre) => {
      if (nid === m.id && !pre) return;
      if (isDirty(m) && !pre?.force) { nudgeDraft(m); return; }
      const g = pre || await fetchItem(nid).catch(() => null);
      if (!g) return;
      if (m.src) m.src.classList.remove('morph-src', 'is-open');
      m.src = cardEls.get(nid) || null;
      if (m.src && state.modal === m) m.src.classList.add(m.enter === 'zoom' ? 'morph-src' : 'is-open');
      Object.assign(m, { id: nid, item: g.item, archived: g.archived, editingDesc: false, staged: [], tab: 'comments', draft: {}, baseVersion: null });
      renderSaveBar(m);
      buildModalBody(m);
      for (const n of [$('.m-main', root), $('.m-side', root)]) { n.classList.remove('swap-in'); void n.offsetWidth; n.classList.add('swap-in'); n.scrollTop = 0; }
    };
    wireModalShell(m);
    buildModalBody(m);
  }

  function wireModalShell(m) {
    const { root } = m;
    root.addEventListener('pointerdown', (e) => { root._down = e.target === root; });
    root.addEventListener('click', (e) => { if (e.target === root && root._down) closeModal(); });
    $('[data-a="close"]', root).onclick = () => closeModal();
    $('.m-save', root).onclick = (e) => {
      const a = e.target.closest('[data-draft]')?.dataset.draft;
      if (a === 'save') saveDraft(m);
      if (a === 'discard') discardDraft(m);
    };
    $('[data-a="archive"]', root).onclick = async () => {
      if (m.archived) return;
      const keep = m.id;
      try {
        await api('POST', I(keep, '/archive'), {});
        m.draft = {};
        if (!m.rail || !needsIds().filter((x) => x !== keep).length) closeModal();
        toast(`Archived ${keep}`, { icon: 'archive', action: 'Undo', onAction: () => restoreMany([keep]) });
        scheduleRefresh(0);
      } catch (e) { toast(e.message, { kind: 'error' }); }
    };
    $('.m-id', root).onclick = () => { navigator.clipboard?.writeText(m.id); toast(`Copied ${m.id}`, { icon: 'copy', timeout: 1500 }); };

    const modal = m.modal;
    modal.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      const box = e.target.closest('.cmt-compose .tbox');
      $$('.tbox.drop', modal).forEach((b) => b !== box && b.classList.remove('drop'));
      if (box) box.classList.add('drop');
      modal.classList.toggle('dropping', !box);
    });
    modal.addEventListener('dragleave', (e) => { if (!modal.contains(e.relatedTarget)) { modal.classList.remove('dropping'); $$('.tbox.drop', modal).forEach((b) => b.classList.remove('drop')); } });
    modal.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      modal.classList.remove('dropping');
      const box = e.target.closest('.cmt-compose .tbox');
      $$('.tbox.drop', modal).forEach((b) => b.classList.remove('drop'));
      if (box) stageFiles(m, [...e.dataTransfer.files]);
      else if (canEdit('attachments') && !m.archived) uploadFiles(m, [...e.dataTransfer.files]);
    });
    modal.addEventListener('paste', async (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return;
      const target = e.target.closest('textarea');
      e.preventDefault();
      if (target?.closest('.cmt-compose')) { stageFiles(m, files); return; }
      if (!canEdit('attachments') || m.archived) return;
      const atts = await uploadFiles(m, files);
      if (target && target.closest('.desc-edit')) {
        const snippet = atts.map((a) => (isImage(a) ? `![${a.name}](${a.url})` : `[${a.name}](${a.url})`)).join('\n');
        const s = target.selectionStart;
        target.value = target.value.slice(0, s) + snippet + target.value.slice(target.selectionEnd);
        autosize(target);
      }
    });
  }

  /* ─── needs-you rail ─── */

  function renderRail(m) {
    const rail = $('.m-rail', m.root);
    const frame = $('.m-frame', m.root);
    rail.hidden = !m.rail;
    frame.classList.toggle('has-rail', m.rail);
    if (!m.rail) return;
    const ids = needsIds();
    if (!rail.firstChild) rail.innerHTML = `<div class="rail-head">${icon('ask', 'sm')}<span>Needs you</span><span class="n"></span></div>`;
    $('.rail-head .n', rail).textContent = ids.length;
    const existing = new Map($$('.rail-tab', rail).map((t) => [t.dataset.id, t]));
    for (const [id, t] of existing) {
      if (!ids.includes(id) && !t.classList.contains('leaving')) { t.classList.add('leaving'); setTimeout(() => t.remove(), 400); }
    }
    let prev = $('.rail-head', rail);
    ids.forEach((id, i) => {
      const it = state.board.items[id];
      let t = existing.get(id);
      if (!t || t.classList.contains('leaving')) {
        t = el(`<button class="rail-tab" data-id="${esc(id)}" style="animation-delay:${i * 40}ms"></button>`);
        t.onclick = () => m.switchTo(id);
      }
      t.innerHTML = `${avatar({ kind: 'agent', name: it.needsHuman.raisedBy })}<span class="t">${esc(it.title)}</span><span class="s">${esc(id)} · ${rel(it.needsHuman.raisedAt)}</span>`;
      t.classList.toggle('on', id === m.id);
      if (prev.nextSibling !== t) prev.after(t);
      prev = t;
    });
  }

  function advanceRail(m) {
    const left = needsIds();
    renderRail(m);
    if (left.length) { setTimeout(() => { if (state.modal === m) m.switchTo(left[0]); }, 450); return; }
    $('.m-main', m.root).innerHTML = `<div class="all-clear">${icon('check')}<span>All clear</span></div>`;
    $('.m-side', m.root).innerHTML = '';
    setTimeout(() => { if (state.modal === m) closeModal(); }, 1100);
  }

  /* ─── body ─── */

  function buildModalBody(m) {
    const main = $('.m-main', m.root);
    const editDesc = canEdit('description') && !m.archived;
    main.innerHTML = `
      <div class="ask-slot"></div>
      <div class="m-title-wrap"><textarea class="m-title" rows="1" spellcheck="true"></textarea><button class="tb-ok" title="Save title">${icon('check')}</button></div>
      <div class="m-sub"></div>
      ${shown('description') ? `<div class="desc"><div class="md desc-view ${editDesc ? 'editable' : ''}" data-ph="${editDesc ? 'Description…' : '—'}"></div><div class="desc-edit" hidden>${tboxHTML({ mono: true, okTitle: 'Save (Ctrl+Enter)', hint: 'Ctrl+Enter · Esc' })}</div></div>` : ''}
      ${shown('attachments') ? `<div class="section"><div class="section-head">${icon('clip', 'sm')}<span>${esc(bi('attachments').label)}</span><span class="att-n"></span><span class="rule"></span></div><div class="atts"></div></div>` : ''}
      <nav class="tabs"><button data-t="comments" class="on">${icon('msg', 'sm')}<span class="n c-n">0</span></button><button data-t="activity">${icon('activity', 'sm')}</button></nav>
      <div class="tab-comments"><div class="cmts"></div>
        <div class="cmt-compose">${tboxHTML({ ph: 'Comment…', okIcon: 'send', okTitle: 'Send (Ctrl+Enter)', tools: `<label class="tb-btn" title="Attach">${icon('clip')}<input type="file" multiple hidden></label>` })}</div></div>
      <div class="tab-activity" hidden></div>`;
    wireModalBody(m);
    renderRail(m);
    fillModal(m, true);
    const foot = $('.m-foot', m.root);
    foot.dataset.id = m.id;
  }

  /* ─── drafts: modal edits wait for Save (Settings → Board → Ticket edits) ─── */

  const DRAFT_SCALARS = ['title', 'description', 'type', 'priority', 'parent', 'assignee', 'blockedBy', 'cover'];
  const isDirty = (m) => m?.kind === 'item' && Object.keys(m.draft || {}).length > 0;
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  // The item as the modal should show it: stored values with the unsaved draft laid over them.
  function draftView(m) {
    const it = m.item;
    const d = m.draft || {};
    if (!Object.keys(d).length) return it;
    const out = { ...it };
    for (const k of DRAFT_SCALARS) if (k in d) out[k] = d[k];
    if (d.column) out.columnId = d.column;
    for (const bag of ['properties', 'fields']) {
      if (!d[bag]) continue;
      out[bag] = { ...(it[bag] || {}) };
      for (const [k, v] of Object.entries(d[bag])) { if (v === null) delete out[bag][k]; else out[bag][k] = v; }
    }
    return out;
  }

  // Drop draft entries that now match what is stored (e.g. changed back), so "unsaved" stays honest.
  function pruneDraft(m) {
    const d = m.draft;
    const it = m.item;
    for (const k of DRAFT_SCALARS) if (k in d && same(d[k], it[k])) delete d[k];
    if (d.column === it.columnId) { delete d.column; delete d.position; }
    for (const bag of ['properties', 'fields']) {
      if (!d[bag]) continue;
      for (const [k, v] of Object.entries(d[bag])) if (same(v, (it[bag] || {})[k])) delete d[bag][k];
      if (!Object.keys(d[bag]).length) delete d[bag];
    }
    if (!Object.keys(d).length) m.baseVersion = null;
  }

  function editItem(m, body) {
    if (settings.saveMode === 'instant' || m.kind !== 'item') return patchItem(m.id, body);
    if (m.baseVersion == null) m.baseVersion = m.item.version;
    for (const [k, v] of Object.entries(body)) {
      if (k === 'properties' || k === 'fields') m.draft[k] = { ...(m.draft[k] || {}), ...v };
      else m.draft[k] = v;
    }
    pruneDraft(m);
    fillModal(m);
    renderSaveBar(m);
    return Promise.resolve(null);
  }

  function draftLabels(m) {
    const d = m.draft;
    const names = [];
    const label = (k) => ({ column: 'column', blockedBy: bi('blockedBy').label.toLowerCase(), cover: 'card image' }[k] || k);
    for (const k of Object.keys(d)) {
      if (k === 'position') continue;
      if (k === 'fields') names.push(...Object.keys(d.fields).map((x) => schema().fields.find((f) => f.key === x)?.label || x));
      else if (k === 'properties') names.push(...Object.keys(d.properties));
      else names.push(label(k));
    }
    return names;
  }

  function renderSaveBar(m) {
    const bar = $('.m-save', m.root);
    if (!bar) return;
    const names = isDirty(m) ? draftLabels(m) : [];
    const was = !bar.hidden;
    bar.hidden = !names.length;
    if (!names.length) return;
    const stale = m.baseVersion != null && m.item.version > m.baseVersion;
    $('.txt', bar).innerHTML = `<b>${names.length} unsaved</b> · ${esc(names.join(', '))}${stale ? ' · <span class="stale">updated meanwhile</span>' : ''}`;
    if (!was) bar.animate([{ opacity: 0, translate: '0 10px' }, { opacity: 1, translate: '0 0' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  function nudgeDraft(m) {
    m.nudgedAt = Date.now();
    const bar = $('.m-save', m.root);
    if (!bar) return;
    bar.classList.remove('nudge');
    void bar.offsetWidth;
    bar.classList.add('nudge');
    $('.txt', bar).insertAdjacentHTML('beforeend', ' · <span class="stale">save or discard — close again to discard</span>');
    $('[data-draft="save"]', bar).focus();
  }

  async function saveDraft(m) {
    if (!isDirty(m)) return;
    const body = { ...m.draft };
    m.draft = {};
    m.baseVersion = null;
    renderSaveBar(m);
    const ok = await patchItem(m.id, body);
    if (!ok) { m.draft = body; renderSaveBar(m); fillModal(m); }
  }

  function discardDraft(m) {
    m.draft = {};
    m.baseVersion = null;
    renderSaveBar(m);
    fillModal(m);
  }

  async function patchItem(id, body) {
    try {
      const it = await api('PATCH', I(id), body);
      const { board: _b, column: _c, blocks: _bl, archived: _a, ...plain } = it;
      if (state.board.items[id]) {
        const prevCol = state.board.items[id].columnId;
        state.board.items[id] = { ...plain, lease: state.board.items[id].lease };
        if (prevCol === plain.columnId) { render(); state.modal?.refresh(); }
      }
      pulseSaved();
      scheduleRefresh(0);
      return it;
    } catch (e) {
      toast(e.message, { kind: 'error' });
      state.modal?.refresh();
      return null;
    }
  }

  function wireModalBody(m) {
    const main = $('.m-main', m.root);
    const title = $('.m-title', main);
    const saveTitle = () => {
      const v = title.value.replace(/\s+/g, ' ').trim();
      if (!v) { title.value = draftView(m).title; return; }
      if (v !== draftView(m).title && !m.archived) editItem(m, { title: v });
    };
    title.addEventListener('input', () => autosize(title));
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
    title.addEventListener('blur', saveTitle);
    $('.m-title-wrap .tb-ok', main).addEventListener('pointerdown', (e) => e.preventDefault());
    $('.m-title-wrap .tb-ok', main).onclick = () => title.blur();
    title.readOnly = m.archived;

    const view = $('.desc-view', main);
    if (view) {
      const editWrap = $('.desc-edit', main);
      const box = $('.tbox', editWrap);
      const finish = (save) => {
        if (!m.editingDesc) return;
        m.editingDesc = false;
        const v = $('textarea', box).value;
        editWrap.hidden = true; view.hidden = false;
        if (save && v !== (draftView(m).description || '')) editItem(m, { description: v });
      };
      const ta = wireTbox(box, () => finish(true), { escape: () => finish(true) });
      ta.addEventListener('blur', () => setTimeout(() => { if (!box.contains(document.activeElement)) finish(true); }, 150));
      view.addEventListener('click', (e) => {
        const cb = e.target.closest('input[type="checkbox"][data-line]');
        if (cb) {
          if (!canEdit('description') || m.archived) { e.preventDefault(); return; }
          const lines = (draftView(m).description || '').split('\n');
          const n = Number(cb.dataset.line);
          lines[n] = lines[n].replace(/\[( |x|X)\]/, cb.checked ? '[x]' : '[ ]');
          editItem(m, { description: lines.join('\n') });
          return;
        }
        if (e.target.closest('a, img') || !canEdit('description') || m.archived) return;
        m.editingDesc = true;
        ta.value = draftView(m).description || '';
        view.hidden = true; editWrap.hidden = false;
        autosize(ta); ta.focus();
      });
    }

    for (const t of $$('.tabs button', main)) {
      t.onclick = () => {
        m.tab = t.dataset.t;
        $$('.tabs button', main).forEach((b) => b.classList.toggle('on', b === t));
        $('.tab-comments', main).hidden = m.tab !== 'comments';
        $('.tab-activity', main).hidden = m.tab !== 'activity';
        if (m.tab === 'activity') loadActivity(m);
      };
    }

    const cbox = $('.cmt-compose .tbox', main);
    const send = async () => {
      const ta = $('textarea', cbox);
      const body = ta.value.trim();
      if (!body && !m.staged.length) { ta.focus(); return; }
      const files = m.staged.slice();
      ta.value = ''; autosize(ta);
      m.staged = []; drawStaged(m);
      try {
        const attachments = [];
        for (const f of files) attachments.push({ name: f.name || 'pasted.png', mime: f.type, dataBase64: await readFile(f) });
        await api('POST', I(m.id, '/comments'), { body, attachments });
        scheduleRefresh(0);
      } catch (e) { toast(e.message, { kind: 'error' }); ta.value = body; m.staged = files; drawStaged(m); }
    };
    wireTbox(cbox, send);
    const fi = $('input[type="file"]', cbox);
    fi.onchange = () => { stageFiles(m, [...fi.files]); fi.value = ''; };
    $('.cmt-compose', main).hidden = m.archived;
  }

  function stageFiles(m, files) {
    for (const f of files) {
      if (f.size > 15 * 1024 * 1024) { toast(`${f.name} is over 15 MB`, { kind: 'error' }); continue; }
      m.staged.push(f);
    }
    drawStaged(m);
    $('.cmt-compose textarea', m.root)?.focus();
  }
  function drawStaged(m) {
    const box = $('.cmt-compose .staged', m.root);
    if (!box) return;
    for (const u of box._urls || []) URL.revokeObjectURL(u);
    box._urls = [];
    box.innerHTML = m.staged.map((f, i) => {
      if (/^image\//.test(f.type)) { const u = URL.createObjectURL(f); box._urls.push(u); return `<div class="st"><img src="${u}" alt=""><button data-i="${i}">${icon('x', 'sm')}</button></div>`; }
      return `<div class="st"><span>${esc(f.name.slice(0, 18))}</span><button data-i="${i}">${icon('x', 'sm')}</button></div>`;
    }).join('');
    box.onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) { m.staged.splice(Number(b.dataset.i), 1); drawStaged(m); } };
  }

  function readFile(f) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
  }
  async function uploadFiles(m, files) {
    const out = [];
    for (const f of files) {
      if (f.size > 15 * 1024 * 1024) { toast(`${f.name} is over 15 MB`, { kind: 'error' }); continue; }
      try { out.push(await api('POST', I(m.id, '/attachments'), { name: f.name || 'pasted.png', mime: f.type, dataBase64: await readFile(f) })); }
      catch (e) { toast(e.message, { kind: 'error' }); }
    }
    if (out.length) { pulseSaved(); scheduleRefresh(0); }
    return out;
  }

  function fillModal(m, first = false) {
    const { root } = m;
    const it = draftView(m);
    const main = $('.m-main', root);
    if (!$('.m-title', main)) return; // all-clear screen
    const focus = document.activeElement;
    m.modal.style.setProperty('--type-c', TYPE_VAR[it.type]);
    $('.m-type', root).innerHTML = icon(it.type);
    $('.m-id', root).textContent = it.id;
    $('[data-a="archive"]', root).hidden = m.archived;

    const title = $('.m-title', main);
    if (focus !== title) { title.value = it.title; autosize(title); }
    if (first) requestAnimationFrame(() => autosize(title));

    const col = colById(it.columnId);
    $('.m-sub', main).innerHTML = `${avatar(it.author)}<span>${esc(it.author?.name)}</span><span>·</span><span title="${esc(it.createdAt)}">${rel(it.createdAt)}</span>${col ? `<span>·</span><span class="chip" style="color:${esc(col.color)}">${esc(col.name)}</span>` : ''}${m.archived ? `<span class="chip">${icon('archive', 'sm')}${esc(rel(it.archivedAt))}</span>` : ''}`;

    // needs-you banner
    const slot = $('.ask-slot', main);
    if (it.needsHuman && !m.archived) {
      const key = `${it.id}:${it.needsHuman.raisedAt}`;
      if (slot.dataset.key !== key) {
        slot.dataset.key = key;
        const isReview = it.needsHuman.kind === 'review';
        slot.innerHTML = `<div class="m-ask ${isReview ? 'is-review' : ''}"><div class="ask-head">${icon(isReview ? 'eye' : 'ask')}${avatar({ kind: 'agent', name: it.needsHuman.raisedBy })}<b>${esc(it.needsHuman.raisedBy)}</b><span>${rel(it.needsHuman.raisedAt)}</span>${isReview ? '<span class="chip review-chip">Review</span>' : ''}</div>
          <div class="md">${md(it.needsHuman.reason)}</div>
          ${isReview
    ? tboxHTML({ ph: 'Feedback…', okIcon: 'send', okTitle: 'Request changes (Ctrl+Enter)', tools: `<button class="btn primary sm" data-r="approve">${icon('check', 'sm')}Approve</button>` })
    : tboxHTML({ ph: 'Reply…', okIcon: 'send', okTitle: 'Reply & resolve (Ctrl+Enter)', tools: `<button class="tb-btn" data-r="resolve" title="Resolve|Mark the question answered without replying">${icon('check')}</button>` })}</div>`;
        const box = $('.tbox', slot);
        const resolve = async (withReply) => {
          const ta = $('textarea', box);
          const reply = withReply ? ta.value.trim() : '';
          if (withReply && !reply) { ta.focus(); return; }
          try { await api('DELETE', I(m.id, '/attention'), { reply }); pulseSaved(); scheduleRefresh(0); } catch (e) { toast(e.message, { kind: 'error' }); }
        };
        // Review: approve moves the ticket on through the gate; feedback sends it back a column.
        const review = async (approve) => {
          const ta = $('textarea', box);
          const text = ta.value.trim();
          if (!approve && !text) { ta.focus(); return; }
          const cols = state.board.columns;
          const idx = cols.findIndex((c) => c.id === m.item.columnId);
          const target = approve ? (cols.slice(idx + 1).find((c) => c.flags.humanOnlyIn) || cols[idx + 1]) : cols[idx - 1];
          try {
            await api('DELETE', I(m.id, '/attention'), { reply: text || 'Approved ✓' });
            if (target) await api('POST', I(m.id, '/move'), { column: target.id, position: 'top' });
            pulseSaved();
            toast(approve ? `Approved ${m.id}` : `Sent ${m.id} back`, { kind: approve ? 'ok' : '', icon: approve ? 'check' : 'restore' });
            scheduleRefresh(0);
          } catch (e) { toast(e.message, { kind: 'error' }); }
        };
        if (isReview) {
          wireTbox(box, () => review(false));
          $('[data-r="approve"]', slot).onclick = () => review(true);
        } else {
          wireTbox(box, () => resolve(true));
          $('[data-r="resolve"]', slot).onclick = () => resolve(false);
        }
        if (first || m.rail) setTimeout(() => $('textarea', box)?.focus(), 300);
      }
    } else { slot.innerHTML = ''; slot.dataset.key = ''; }

    const view = $('.desc-view', main);
    if (view && !m.editingDesc) {
      view.innerHTML = md(it.description, { tasks: canEdit('description') && !m.archived });
      view.classList.toggle('empty', !it.description?.trim());
    }

    const atts = $('.atts', main);
    if (atts) fillAttachments(m, atts);

    $('.c-n', main).textContent = it.comments.length;
    const cmts = $('.cmts', main);
    const sig = `${it.id}:${it.comments.length}`;
    if (cmts.dataset.sig !== sig) {
      cmts.dataset.sig = sig;
      cmts.innerHTML = it.comments.map((c) => `<div class="cmt">${avatar(c.author, 'lg')}<div><div class="cmt-head"><b>${esc(c.author?.name)}</b>${c.author?.kind === 'agent' ? `<span class="kind">${icon('bot', 'sm')}</span>` : ''}<span title="${esc(c.createdAt)}">${rel(c.createdAt)}</span></div>${c.body ? `<div class="md">${md(c.body)}</div>` : ''}${commentAtts(c)}</div></div>`).join('');
    }

    fillSide(m);
    const foot = $('.m-foot', root);
    foot.innerHTML = `<span>v${it.version}</span><span>updated ${esc(rel(it.updatedAt))}</span><span>created ${esc(new Date(it.createdAt).toLocaleString())}</span>`;
  }

  function commentAtts(c) {
    if (!c.attachments?.length) return '';
    return `<div class="cmt-atts">${c.attachments.map((a) => (isImage(a)
      ? `<img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy">`
      : `<a class="file" href="${esc(a.url)}" target="_blank" rel="noopener">${icon(a.kind === 'link' ? 'link' : 'clip', 'sm')}${esc(a.name)}</a>`)).join('')}</div>`;
  }

  function fillAttachments(m, atts) {
    const it = draftView(m);
    const edit = canEdit('attachments') && !m.archived;
    const coverEdit = canEdit('cover') && shown('cover') && !m.archived;
    const cover = coverOf(it);
    $('.att-n', m.root).textContent = it.attachments.length || '';
    atts.innerHTML = it.attachments.map((a) => {
      const img = isImage(a);
      const isCover = cover && cover.id === a.id;
      const inner = img ? `<img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy">`
        : `<a href="${esc(a.url)}" target="_blank" rel="noopener">${icon(a.kind === 'link' ? 'link' : 'clip')}<span>${esc(a.name)}</span></a>`;
      const tag = isCover && shown('cover') ? `<span class="cover-tag ${it.cover === 'auto' ? 'auto' : ''}">${icon('card', 'sm')}</span>` : '';
      const tools = [
        img && coverEdit ? `<button class="cv ${isCover && it.cover !== 'auto' ? 'on' : ''}" data-cover="${esc(a.id)}" title="${isCover && it.cover !== 'auto' ? 'Hide from card' : 'Show on card'}">${icon(isCover && it.cover !== 'auto' ? 'eyeoff' : 'card', 'sm')}</button>` : '',
        edit ? `<button class="rm" data-rm="${esc(a.id)}" title="Remove">${icon('x', 'sm')}</button>` : '',
      ].join('');
      return `<div class="att ${img ? '' : 'file'} ${isCover && shown('cover') ? 'is-cover' : ''}" title="${esc(a.name)} · ${esc(a.author?.name)}">${inner}${tag}${tools ? `<div class="att-tools">${tools}</div>` : ''}</div>`;
    }).join('') + (edit ? `<label class="att-add" title="Attach">${icon('plus')}<input type="file" multiple hidden></label>` : '');
    if (!it.attachments.length && !edit) atts.innerHTML = '<div class="empty-note">—</div>';
    atts.onclick = async (e) => {
      const rm = e.target.closest('[data-rm]');
      const cv = e.target.closest('[data-cover]');
      if (!rm && !cv) return;
      e.stopPropagation();
      e.preventDefault();
      try {
        if (rm) { await api('DELETE', I(m.id, `/attachments/${rm.dataset.rm}`)); toast('Removed', { icon: 'x', timeout: 1800 }); }
        if (cv) {
          const explicit = it.cover === cv.dataset.cover;
          await editItem(m, { cover: explicit ? 'none' : cv.dataset.cover });
        }
        scheduleRefresh(0);
      } catch (err) { toast(err.message, { kind: 'error' }); }
    };
    const fi = $('input[type="file"]', atts);
    if (fi) fi.onchange = () => uploadFiles(m, [...fi.files]);
  }

  /* ─── side panel (schema-driven) ─── */

  function fillSide(m) {
    const side = $('.m-side', m.root);
    if (side.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return;
    const it = draftView(m);
    const b = state.board;
    const lock = (k) => !canEdit(k) || m.archived;
    const roIcon = (k) => (lock(k) && !m.archived ? `<span class="ro" title="Read-only|Only agents can change this, through the API">${icon('lock', 'sm')}</span>` : '');
    const lbl = (k, ic, text) => `<div class="lbl">${icon(ic, 'sm')}${esc(text ?? bi(k).label)}${roIcon(k)}</div>`;
    const lease = activeLease(it);
    const col = colById(it.columnId);
    const parts = [];

    // details
    const det = [];
    det.push(`<div class="field">${'<div class="lbl">'}${icon('board', 'sm')}Column</div>${m.archived ? `<div class="ro-val">${esc(col?.name || '—')}</div>` : ddHTML('column', col ? `<span class="sw" style="--c:${esc(col.color)}"></span>${esc(col.name)}` : '')}</div>`);
    if (shown('type')) {
      det.push(`<div class="field">${lbl('type', 'layers')}${lock('type')
        ? `<div class="ro-val" style="color:${TYPE_VAR[it.type]}">${icon(it.type, 'sm')}${it.type}</div>`
        : `<div class="seg" data-f="type">${TYPES.map((t) => `<button class="${t === it.type ? 'on' : ''}" data-v="${t}" style="--c:${TYPE_VAR[t]}">${icon(t, 'sm')}${t}</button>`).join('')}</div>`}</div>`);
    }
    if (shown('priority')) {
      det.push(`<div class="field">${lbl('priority', 'flag')}${lock('priority')
        ? `<div class="ro-val" style="color:${PRIO_VAR[it.priority]}">${icon('flag', 'sm')}${it.priority}</div>`
        : `<div class="seg" data-f="priority">${PRIORITIES.map((p) => `<button class="${p === it.priority ? 'on' : ''}" data-v="${p}" style="--c:${PRIO_VAR[p]}">${p === 'Critical' ? 'Crit' : p}</button>`).join('')}</div>`}</div>`);
    }
    if (shown('parent')) {
      const v = it.parent ? `<span class="sw" style="--c:${tagColor(it.parent)}"></span>${esc(it.parent)}` : '';
      det.push(`<div class="field">${lbl('parent', 'hash')}${lock('parent') ? `<div class="ro-val ${it.parent ? '' : 'empty'}">${v || '—'}</div>` : ddHTML('parent', v, { placeholder: 'None' })}</div>`);
    }
    if (shown('assignee')) {
      const v = it.assignee ? `${avatar({ name: it.assignee })}${esc(it.assignee)}` : '';
      det.push(`<div class="field">${lbl('assignee', 'user')}${lock('assignee') ? `<div class="ro-val ${it.assignee ? '' : 'empty'}">${v || '—'}</div>` : ddHTML('assignee', v, { placeholder: 'Nobody' })}</div>`);
    }
    parts.push(`<div class="fgroup">${det.join('')}</div>`);

    // lease + dependencies
    const work = [];
    work.push(`<div class="field"><div class="lbl">${icon('clock', 'sm')}Lease</div>${lease
      ? `<div class="lease-box">${ringHTML(lease)}<div style="min-width:0"><div class="who">${esc(lease.claimant)}</div><div class="left" data-left="${esc(lease.expiresAt)}"></div></div>${m.archived ? '' : `<button class="btn ghost sm" data-act="revoke" title="Revoke lease|Take the ticket back from this agent">${icon('x', 'sm')}</button>`}${lease.status ? `<div class="lstatus">${esc(lease.status)}</div>` : ''}</div>`
      : m.archived ? '<div class="ro-val empty">—</div>' : `<button class="btn sm" data-act="claim" title="Hold|Lease it yourself — agents can't change it until you release it">${icon('lock', 'sm')}Hold</button>`}</div>`);
    if (shown('blockedBy')) {
      const last = b.columns[b.columns.length - 1]?.id;
      const chip = (id, removable) => {
        const d = b.items[id];
        const cls = !d || d.columnId === last ? 'done' : removable ? 'open' : '';
        return `<span class="dep ${cls} ${removable ? '' : 'readonly'}" data-open="${esc(id)}" title="${esc(d?.title || 'archived')}">${esc(id)}${removable ? `<button class="x" data-rmdep="${esc(id)}">${icon('x', 'sm')}</button>` : ''}</span>`;
      };
      const deps = (it.blockedBy || []);
      const blocks = Object.values(b.items).filter((x) => x.blockedBy?.includes(it.id)).map((x) => x.id);
      work.push(`<div class="field">${lbl('blockedBy', 'lock')}${deps.length ? `<div class="deps">${deps.map((x) => chip(x, !lock('blockedBy'))).join('')}</div>` : lock('blockedBy') ? '<div class="ro-val empty">—</div>' : ''}${lock('blockedBy') ? '' : ddHTML('blockedBy', '', { placeholder: 'Add blocker…' })}</div>`);
      if (blocks.length) work.push(`<div class="field"><div class="lbl">${icon('move', 'sm')}Blocks</div><div class="deps">${blocks.map((x) => chip(x, false)).join('')}</div></div>`);
    }
    parts.push(`<div class="fgroup">${work.join('')}</div>`);

    // declared fields
    const defs = schema().fields.filter((f) => f.ui !== 'hidden');
    if (defs.length) parts.push(`<div class="fgroup"><div class="fgroup-title">${icon('layers', 'sm')}Fields</div>${defs.map((f) => fieldControl(f, it.fields?.[f.key], f.ui !== 'edit' || m.archived)).join('')}</div>`);

    // free-form properties
    if (shown('properties')) {
      const props = Object.entries(it.properties || {});
      const ro = lock('properties');
      const showVal = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
      parts.push(`<div class="fgroup"><div class="fgroup-title">${icon('braces', 'sm')}${esc(bi('properties').label)}${roIcon('properties')}</div>
        <div class="props">${props.map(([k, v]) => `<div class="prop"><input class="inp k" data-k="${esc(k)}" value="${esc(k)}" ${ro ? 'readonly' : ''}><input class="inp" data-v="${esc(k)}" value="${esc(showVal(v))}" ${ro ? 'readonly' : ''}>${ro ? '<span></span>' : `<button class="x" data-del="${esc(k)}" title="Remove">${icon('x', 'sm')}</button>`}</div>`).join('')}</div>
        ${ro ? (props.length ? '' : '<div class="ro-val empty">—</div>') : `<button class="add-row">${icon('plus', 'sm')}Add</button>`}</div>`);
    }

    if (m.archived) parts.unshift(`<button class="btn primary" data-act="restore" style="width:100%;margin-bottom:14px">${icon('restore')}Restore</button>`);
    side.innerHTML = parts.join('');
    tickRings(side);
    tickModal();
    wireSide(m, side);
  }

  function fieldControl(f, v, ro) {
    const ic = ICONS[f.icon] ? f.icon : FIELD_ICON[f.type];
    const head = `<div class="lbl" ${f.help ? `title="${esc(f.help)}"` : ''}>${icon(ic, 'sm')}${esc(f.label)}${ro ? `<span class="ro" title="Read-only|Only agents can change this, through the API">${icon('lock', 'sm')}</span>` : ''}</div>`;
    const key = esc(f.key);
    if (f.type === 'boolean') return `<div class="field inline">${head}<button class="switch ${v ? 'on' : ''}" data-fbool="${key}" ${ro ? 'disabled' : ''}></button></div>`;
    if (ro) {
      let val;
      if (v == null) val = '—';
      else if (f.type === 'enum') val = `<span class="sw" style="--c:${esc(optColor(f, v) || 'var(--accent)')}"></span>${esc(v)}`;
      else if (f.type === 'tags') val = v.map((t) => `<span class="tagchip" style="--fc:${esc(optColor(f, t) || 'var(--accent)')}">${esc(t)}</span>`).join('');
      else if (f.type === 'url') val = `<a href="${esc(v)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(fieldText(f, v))}</a>`;
      else if (f.type === 'markdown') val = `<div class="md">${md(v)}</div>`;
      else if (f.type === 'user') val = `${avatar({ name: v })}${esc(v)}`;
      else val = esc(f.type === 'date' ? new Date(v).toLocaleDateString() : v);
      return `<div class="field">${head}<div class="ro-val ${v == null ? 'empty' : ''}">${val}</div></div>`;
    }
    switch (f.type) {
      case 'enum': return `<div class="field">${head}${ddHTML(`f:${f.key}`, v != null ? `<span class="sw" style="--c:${esc(optColor(f, v) || 'var(--accent)')}"></span>${esc(v)}` : '', { placeholder: 'None' })}</div>`;
      case 'user': return `<div class="field">${head}${ddHTML(`f:${f.key}`, v ? `${avatar({ name: v })}${esc(v)}` : '', { placeholder: 'Nobody' })}</div>`;
      case 'tags': return `<div class="field">${head}${v?.length ? `<div class="deps">${v.map((t) => `<span class="tagchip" style="--fc:${esc(optColor(f, t) || 'var(--accent)')}">${esc(t)}<button class="x" data-rmtag="${key}" data-tag="${esc(t)}">${icon('x', 'sm')}</button></span>`).join('')}</div>` : ''}${ddHTML(`f:${f.key}`, '', { placeholder: 'Add…' })}</div>`;
      case 'number': return `<div class="field">${head}<input class="inp" type="number" data-fval="${key}" value="${v ?? ''}" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} placeholder="—"></div>`;
      case 'date': return `<div class="field">${head}<input class="inp" type="date" data-fval="${key}" value="${esc(v ? String(v).slice(0, 10) : '')}"></div>`;
      case 'url': return `<div class="field">${head}<div class="url-row"><input class="inp" type="url" data-fval="${key}" value="${esc(v ?? '')}" placeholder="https://…">${v ? `<a class="btn" href="${esc(v)}" target="_blank" rel="noopener" title="Open">${icon('ext', 'sm')}</a>` : ''}</div></div>`;
      case 'markdown': return `<div class="field">${head}<div class="fmd" data-fmd="${key}">${tboxHTML({ okTitle: 'Save', rows: 3 })}</div></div>`;
      default: return `<div class="field">${head}<input class="inp" data-fval="${key}" value="${esc(v ?? '')}" placeholder="—"></div>`;
    }
  }

  function wireSide(m, side) {
    const it = draftView(m);
    const b = state.board;
    const setField = (k, v) => editItem(m, { fields: { [k]: v } });
    for (const box of $$('[data-fmd]', side)) {
      const k = box.dataset.fmd;
      const ta = wireTbox($('.tbox', box), () => setField(k, $('textarea', box).value));
      ta.value = it.fields?.[k] ?? '';
      requestAnimationFrame(() => autosize(ta));
    }
    side.onchange = (e) => {
      const t = e.target;
      if (t.dataset.fval) {
        const k = t.dataset.fval;
        const prev = it.fields?.[k] ?? '';
        const v = t.value.trim();
        if (String(prev) !== v) setField(k, v === '' ? null : v);
      }
      if (t.dataset.v !== undefined || t.dataset.k !== undefined) savePropsFromSide(m);
    };
    side.onkeydown = (e) => { if (e.key === 'Enter' && e.target.matches('input.inp')) e.target.blur(); };
    side.onclick = async (e) => {
      const segBtn = e.target.closest('.seg button');
      if (segBtn && !segBtn.classList.contains('on')) {
        segBtn.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === segBtn));
        editItem(m, { [segBtn.parentElement.dataset.f]: segBtn.dataset.v });
        return;
      }
      const sw = e.target.closest('[data-fbool]');
      if (sw && !sw.disabled) { sw.classList.toggle('on'); setField(sw.dataset.fbool, sw.classList.contains('on')); return; }
      const rmdep = e.target.closest('[data-rmdep]');
      if (rmdep) { e.stopPropagation(); editItem(m, { blockedBy: it.blockedBy.filter((x) => x !== rmdep.dataset.rmdep) }); return; }
      const rmtag = e.target.closest('[data-rmtag]');
      if (rmtag) { const k = rmtag.dataset.rmtag; const next = (it.fields[k] || []).filter((x) => x !== rmtag.dataset.tag); setField(k, next.length ? next : null); return; }
      const dep = e.target.closest('[data-open]');
      if (dep) { openItem(dep.dataset.open); return; }
      const del = e.target.closest('[data-del]');
      if (del) { editItem(m, { properties: { [del.dataset.del]: null } }); return; }
      if (e.target.closest('.add-row')) {
        const props = $('.props', side);
        const row = el(`<div class="prop"><input class="inp k" data-k="" placeholder="key"><input class="inp" data-v="" placeholder="value"><button class="x" title="Cancel">${icon('x', 'sm')}</button></div>`);
        $('.x', row).onclick = () => row.remove();
        props.append(row);
        $('input', row).focus();
        return;
      }
      const dd = e.target.closest('[data-dd]');
      if (dd) { openSideDropdown(m, dd); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      try {
        if (act === 'revoke') { await api('DELETE', I(m.id, '/lease')); scheduleRefresh(0); }
        if (act === 'claim') {
          menu(e.target.closest('button'), [15, 30, 60, 240].map((min) => ({
            label: min < 60 ? `${min} min` : `${min / 60} h`, icon: 'clock',
            run: async () => { try { await api('POST', I(m.id, '/lease'), { minutes: min, force: true }); scheduleRefresh(0); } catch (err) { toast(err.message, { kind: 'error' }); } },
          })));
        }
        if (act === 'restore') {
          await api('POST', B(`/archive/${encodeURIComponent(m.id)}/restore`), {});
          await loadBoard(state.boardId);
          m.switchTo(m.id, { item: state.board.items[m.id], archived: false });
        }
      } catch (err) { toast(err.message, { kind: 'error' }); }
    };
  }

  function knownPeople() {
    const s = new Set([settings.userName]);
    for (const p of state.presence) s.add(p.name);
    for (const n of Object.keys(state.profiles)) s.add(n);
    for (const it of Object.values(state.board.items)) { if (it.author?.name) s.add(it.author.name); if (it.lease?.claimant) s.add(it.lease.claimant); }
    return [...s].filter(Boolean);
  }

  function openSideDropdown(m, btn) {
    const it = draftView(m);
    const b = state.board;
    const key = btn.dataset.dd;
    if (key === 'column') {
      const from = colById(it.columnId);
      openDd(btn, b.columns.map((c) => ({
        label: c.name, color: c.color, cls: c.id === it.columnId ? 'on' : '',
        disabled: c.id !== it.columnId && !(from?.flags.allowMoveOut && c.flags.allowMoveIn),
        run: () => { if (c.id !== it.columnId) editItem(m, { column: c.id, position: 'top' }); },
      })));
    } else if (key === 'parent') {
      const parents = [...new Set(Object.values(b.items).map((x) => x.parent).filter(Boolean))].sort();
      openDd(btn, [
        { label: 'None', icon: 'x', cls: !it.parent ? 'on' : '', run: () => it.parent && editItem(m, { parent: null }) },
        ...(parents.length ? ['-'] : []),
        ...parents.map((p) => ({ label: p, color: tagColor(p), cls: p === it.parent ? 'on' : '', hint: String(Object.values(b.items).filter((x) => x.parent === p).length), run: () => p !== it.parent && editItem(m, { parent: p }) })),
      ], { search: true, creatable: (v) => editItem(m, { parent: v.replace(/^#/, '') }), placeholder: 'Find or add…' });
    } else if (key === 'assignee') {
      openDd(btn, [{ label: 'Nobody', icon: 'x', cls: !it.assignee ? 'on' : '', run: () => it.assignee && editItem(m, { assignee: null }) }, '-',
        ...knownPeople().map((n) => ({ label: n, avatar: { name: n, kind: n === settings.userName ? 'user' : 'agent' }, cls: n === it.assignee ? 'on' : '', run: () => n !== it.assignee && editItem(m, { assignee: n }) }))],
      { search: true, creatable: (v) => editItem(m, { assignee: v }), placeholder: 'Find or add…' });
    } else if (key === 'blockedBy') {
      const pool = Object.values(b.items).filter((x) => x.id !== it.id && !it.blockedBy?.includes(x.id));
      openDd(btn, pool.map((x) => ({ label: `${x.id} · ${x.title}`, icon: x.type, run: () => editItem(m, { blockedBy: [...(it.blockedBy || []), x.id] }) })), { search: true });
    } else if (key.startsWith('f:')) {
      const f = schema().fields.find((x) => x.key === key.slice(2));
      if (!f) return;
      const cur = it.fields?.[f.key];
      const set = (v) => editItem(m, { fields: { [f.key]: v } });
      if (f.type === 'enum') {
        openDd(btn, [{ label: 'None', icon: 'x', cls: cur == null ? 'on' : '', run: () => cur != null && set(null) }, '-',
          ...f.options.map((o) => ({ label: o.value, color: o.color || 'var(--accent)', cls: o.value === cur ? 'on' : '', run: () => set(o.value) }))], { search: f.options.length > 7 });
      } else if (f.type === 'user') {
        openDd(btn, [{ label: 'Nobody', icon: 'x', run: () => cur && set(null) }, '-',
          ...knownPeople().map((n) => ({ label: n, avatar: { name: n, kind: n === settings.userName ? 'user' : 'agent' }, cls: n === cur ? 'on' : '', run: () => set(n) }))],
        { search: true, creatable: (v) => set(v), placeholder: 'Find or add…' });
      } else if (f.type === 'tags') {
        const have = cur || [];
        const pool = f.options?.length ? f.options.map((o) => o.value)
          : [...new Set(Object.values(b.items).flatMap((x) => x.fields?.[f.key] || []))];
        openDd(btn, pool.filter((t) => !have.includes(t)).map((t) => ({ label: t, color: optColor(f, t) || 'var(--accent)', run: () => set([...have, t]) })),
          { search: true, creatable: f.options?.length ? null : (v) => set([...have, v]), placeholder: f.options?.length ? 'Search…' : 'Find or add…' });
      }
    }
  }

  function parseVal(s) {
    const t = s.trim();
    if (t === '') return '';
    try { return JSON.parse(t); } catch { return s; }
  }
  // Diff the key/value rows against the stored bag; renamed keys become delete + add.
  function savePropsFromSide(m) {
    const side = $('.m-side', m.root);
    const rows = $$('.prop', side);
    const next = {};
    for (const r of rows) { const k = $('[data-k]', r).value.trim(); if (k) next[k] = parseVal($('[data-v]', r).value); }
    const cur = draftView(m).properties || {};
    const patch = {};
    for (const k of Object.keys(cur)) if (!(k in next)) patch[k] = null;
    for (const [k, v] of Object.entries(next)) if (JSON.stringify(cur[k]) !== JSON.stringify(v)) patch[k] = v;
    if (Object.keys(patch).length) editItem(m, { properties: patch });
  }

  function tickModal() {
    for (const n of $$('[data-left]')) {
      const left = Date.parse(n.dataset.left) - nowMs();
      n.textContent = left > 0 ? `${fmtLeft(left)} left` : 'expired';
    }
  }

  async function loadActivity(m) {
    const box = $('.tab-activity', m.root);
    try {
      const evs = await api('GET', I(m.id, '/history'));
      box.innerHTML = evs.length ? evs.slice().reverse().map((ev) => `<div class="act">${icon(eventIcon(ev.type), 'sm')}<div>${describe(ev, true)}</div><time title="${esc(ev.ts)}">${rel(ev.ts)}</time></div>`).join('')
        : `<div class="empty-note">${icon('activity')}</div>`;
    } catch { box.innerHTML = ''; }
  }

  /* ═════════════════════════ events → words ═════════════════════════ */

  function eventIcon(t) {
    if (t === 'lease.status') return 'activity';
    if (t === 'item.assigned') return 'user';
    if (t === 'item.unblocked') return 'sparkle';
    if (t === 'review.requested') return 'eye';
    if (t.startsWith('master')) return 'lock';
    if (t === 'digest.added') return 'news';
    if (t.startsWith('lease')) return 'clock';
    if (t.startsWith('attention')) return 'ask';
    if (t.startsWith('comment')) return 'msg';
    if (t === 'item.moved' || t === 'item.reordered') return 'move';
    if (t === 'item.archived') return 'archive';
    if (t === 'item.restored') return 'restore';
    if (t === 'item.created') return 'plus';
    if (t === 'schema.updated') return 'layers';
    return 'pencil';
  }

  function describe(ev, html = false) {
    const b = (s) => (html ? `<b>${esc(s)}</b>` : s);
    const who = b(ev.actor?.name || 'someone');
    const id = ev.item?.id || ev.itemId || '';
    const fields = Object.keys(ev.changes || {}).map((k) => k.replace(/^(properties|fields)\./, '')).join(', ');
    switch (ev.type) {
      case 'item.created': return `${who} created ${b(id)}${html ? '' : ` · ${ev.item?.title}`}`;
      case 'item.updated': return `${who} changed ${b(id)} ${fields}`;
      case 'item.moved': return `${who} moved ${b(id)} → ${b(ev.item?.column || '')}`;
      case 'item.reordered': return `${who} reordered ${b(id)}`;
      case 'item.archived': return `${who} archived ${b(id)}`;
      case 'item.restored': return `${who} restored ${b(id)}`;
      case 'comment.added': return `${who} on ${b(id)}: ${html ? esc(ev.comment?.body?.slice(0, 120)) : ev.comment?.body?.slice(0, 80)}${ev.comment?.attachments ? ` ${html ? icon('clip', 'sm') : '📎'}` : ''}`;
      case 'lease.claimed': return `${b(ev.claimant)} claimed ${b(id)}`;
      case 'lease.renewed': return `${b(ev.claimant)} renewed ${b(id)}`;
      case 'lease.released': return `${b(ev.claimant)} released ${b(id)}`;
      case 'lease.revoked': return `${who} revoked ${b(ev.claimant)}'s lease on ${b(id)}`;
      case 'lease.warning': return `${b(ev.claimant)}'s lease on ${b(id)} ends in ${ev.minutesLeft}m`;
      case 'lease.expired': return `${b(ev.claimant)}'s lease on ${b(id)} expired`;
      case 'attention.raised': return `${who} needs you on ${b(id)}`;
      case 'attention.resolved': return `${who} answered ${b(id)}`;
      case 'column.created': return `${who} added column ${b(ev.column?.name || '')}`;
      case 'column.updated': return `${who} updated column ${b(ev.column?.name || '')}`;
      case 'schema.updated': return `${who} changed the ticket schema`;
      case 'board.updated': return `${who} updated the board`;
      case 'board.external-edit': return 'Board file changed on disk';
      case 'lease.status': return `${b(ev.claimant)} on ${b(id)}: ${html ? esc(ev.status || '—') : ev.status || '—'}`;
      case 'item.assigned': return `${who} assigned ${b(id)} to ${b(ev.assignee || 'nobody')}`;
      case 'agent.run.started': return `${b(ev.agent)} woke up${ev.items?.length ? ` for ${ev.items.map(b).join(', ')}` : ''}`;
      case 'agent.run.finished': return ev.code === 0 ? `${b(ev.agent)} finished a run` : `${b(ev.agent)}'s run failed (${ev.code}) — retrying`;
      case 'agent.failed': return `${b(ev.agent)} keeps failing — paused until you resume it`;
      case 'agent.status': return `${b(ev.agent)} is ${RUN_LABEL[ev.status] || ev.status}`;
      case 'agents.changed': return ev.error ? `agents.json: ${ev.error}` : 'Standing agents updated';
      case 'master.claimed': return `${b(ev.holder)} is holding the whole board`;
      case 'master.renewed': return `${b(ev.holder)} renewed the board hold`;
      case 'master.released': return `${b(ev.holder)} released the board`;
      case 'master.revoked': return `${who} revoked ${b(ev.holder)}'s board hold`;
      case 'master.expired': return `${b(ev.holder)}'s board hold expired`;
      case 'master.status': return `${b(ev.holder)}: ${html ? esc(ev.status || '—') : ev.status || '—'}`;
      case 'review.requested': return `${who} asked you to review ${b(id)}`;
      case 'digest.added': return `${who} posted to the digest`;
      case 'item.unblocked': return `${b(id)} is unblocked (${b(ev.resolvedBy)} done)`;
      case 'app.renamed': return `${who} renamed the app to ${b(ev.to)}`;
      default: return `${who} · ${ev.type}`;
    }
  }

  /* ═════════════════════════ live: SSE + fallback ═════════════════════════ */

  let liveES = null;
  function reconnect() { liveES?.close(); connect(); }
  function connect() {
    const es = new EventSource(`/api/stream?ui=1${AUTH.token ? `&token=${encodeURIComponent(AUTH.token)}` : ''}`);
    liveES = es;
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = (msg) => {
      let ev;
      try { ev = JSON.parse(msg.data); } catch { return; }
      onEvent(ev);
    };
  }
  function setLive(on) {
    if (state.live === on) return;
    state.live = on;
    $('.live-dot')?.classList.toggle('on', on);
    if (on) { scheduleRefresh(0); refreshPresence(); }
  }

  const QUIET = new Set(['item.reordered', 'presence.changed', 'lease.renewed', 'board.external-edit', 'profile.updated', 'schema.updated', 'lease.status', 'master.status', 'master.renewed', 'agent.status', 'agent.run.finished']);
  function onEvent(ev) {
    if (ev.type === 'hello') return;
    if (ev.type === 'presence.changed' || (ev.type?.startsWith('lease.') && ev.type !== 'lease.status')) refreshPresence();
    if (ev.type === 'presence.changed') scheduleListeners();
    if (ev.type?.startsWith('agent.') || ev.type === 'agents.changed') refreshPresence();
    if (ev.board && ev.itemId) {
      if (document.hidden) { if (newsworthy(ev)) { noteUnseen(ev); saveSeen(); } }
      else if (ev.board === state.boardId) seenFor(ev.board).seq = ev.seq;
    }
    if (forMe(ev) && !state.inbox.some((x) => x.seq === ev.seq)) { state.inbox.unshift(ev); state.inbox.length = Math.min(200, state.inbox.length); renderInboxBtn(); }
    if (ev.type === 'app.renamed') { state.app.name = ev.to; renderHeader(); }
    if (ev.type === 'profile.updated') refreshProfiles();
    if (ev.type === 'board.created' || ev.type === 'board.updated' || ev.type?.startsWith('item.')) refreshBoards();
    if (ev.board === state.boardId && ev.hash && ev.hash !== state.hash) scheduleRefresh();
    const m = state.modal;
    if (m?.kind === 'item' && ev.itemId === m.id && m.tab === 'activity') setTimeout(() => state.modal === m && loadActivity(m), 120);
    announce(ev);
  }

  function announce(ev) {
    if (ev.actor?.kind === 'user' && ev.actor.name === settings.userName) return;
    if (ev.actor?.kind === 'user' && ev.type !== 'comment.added') return;
    if (QUIET.has(ev.type)) return;
    const important = ev.type === 'attention.raised' || (ev.type === 'comment.added' && ev.mentions?.some((n) => n.toLowerCase() === settings.userName.toLowerCase()));
    if (ev.type === 'agent.failed') {
      toast(describe(ev), { kind: 'needs', icon: 'bot', action: 'Log', onAction: () => showRunLog(ev.agent), onClick: () => openAgent(ev.agent), timeout: 9000 });
      return;
    }
    if (settings.toasts && (ev.board === state.boardId || (!ev.board && ev.type.startsWith('agent')))) {
      toast(describe(ev), { actor: ev.actor, kind: important ? 'needs' : '', onClick: ev.itemId ? () => openItem(ev.itemId, cardEls.get(ev.itemId), { rail: ev.type === 'attention.raised' }) : null, timeout: important ? 7000 : 3800 });
    }
    if (settings.sound) blip(important);
    if (settings.notify && 'Notification' in window && Notification.permission === 'granted' && (!settings.notifyHidden || document.hidden)) {
      try {
        const n = new Notification(important ? `${state.app.name} · needs you` : state.app.name, { body: describe(ev), tag: ev.itemId || ev.type, icon: '/favicon.svg', silent: !important });
        n.onclick = () => { window.focus(); if (ev.itemId) { if (ev.board !== state.boardId) loadBoard(ev.board).then(() => openItem(ev.itemId)); else openItem(ev.itemId); } n.close(); };
      } catch { /* notifications blocked */ }
    }
  }

  let audioCtx = null;
  function blip(important) {
    try {
      audioCtx ||= new AudioContext();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      const t = audioCtx.currentTime;
      o.type = 'sine';
      o.frequency.setValueAtTime(important ? 660 : 880, t);
      o.frequency.exponentialRampToValueAtTime(important ? 990 : 1320, t + 0.09);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.26);
    } catch { /* no audio */ }
  }

  async function fallbackPoll() {
    if (state.live || !state.boardId) return;
    try { const h = await api('GET', B('/hash')); if (h.hash !== state.hash) scheduleRefresh(0); } catch { /* server down */ }
  }

  /* ═════════════════════════ drawers + toasts ═════════════════════════ */

  function openDrawer(id, title, iconName) {
    closeDrawers();
    const d = el(`<aside class="drawer" id="${id}"><div class="drawer-head">${icon(iconName)}<span>${esc(title)}</span><span class="grow"></span><button class="pill-btn icon-btn sm" data-close>${icon('x')}</button></div><div class="drawer-body"></div></aside>`);
    document.body.append(d);
    $('[data-close]', d).onclick = closeDrawers;
    requestAnimationFrame(() => requestAnimationFrame(() => d.classList.add('open')));
    setTimeout(() => {
      const off = (e) => {
        if (!d.isConnected) { document.removeEventListener('pointerdown', off, true); return; }
        if (!d.contains(e.target) && !e.target.closest('.menu, .scrim, .lightbox, #topbar')) closeDrawers();
      };
      document.addEventListener('pointerdown', off, true);
    });
    return $('.drawer-body', d);
  }
  function closeDrawers() {
    for (const d of $$('.drawer')) { d.classList.remove('open'); d.id = ''; setTimeout(() => d.remove(), 450); }
  }

  function openRules() {
    const body = openDrawer('rulesDrawer', 'Standing rules', 'pin');
    let project = [];
    api('GET', B('/directives')).then((r) => { project = r.projectRules || []; if (!body.querySelector('.tbox')) show(); }, () => {});
    const show = () => {
      const txt = state.board.directives || '';
      const proj = project.map((r) => `<details class="proj-rules"><summary>${icon('text', 'sm')}<b>${esc(r.file)}</b><span>project conventions · read-only</span></summary><div class="md">${md(r.content)}</div></details>`).join('');
      body.innerHTML = `${proj}${proj ? `<div class="section-head" style="margin-top:14px">${icon('pin', 'sm')}<span>Board rules</span><span class="rule"></span></div>` : ''}<div class="md desc-view editable ${txt.trim() ? '' : 'empty'}" data-ph="How agents should use this board…" style="margin:0">${md(txt)}</div>`;
      $('.desc-view', body).onclick = (e) => { if (!e.target.closest('a')) edit(); };
    };
    const edit = () => {
      body.innerHTML = tboxHTML({ mono: true, okTitle: 'Save (Ctrl+Enter)', hint: 'Ctrl+Enter · Esc' });
      const box = $('.tbox', body);
      const save = async () => {
        const v = $('textarea', box).value;
        try { await api('PUT', B('/directives'), { directives: v }); state.board.directives = v; renderHeader(); show(); toast('Rules saved', { kind: 'ok', icon: 'check', timeout: 1600 }); scheduleRefresh(0); }
        catch (e) { toast(e.message, { kind: 'error' }); }
      };
      const ta = wireTbox(box, save, { escape: show });
      ta.style.minHeight = '320px';
      ta.value = state.board.directives || '';
      autosize(ta);
      ta.focus();
    };
    show();
  }

  async function openArchive() {
    const body = openDrawer('archiveDrawer', 'Archive', 'archive');
    body.innerHTML = '<input class="inp" placeholder="Filter" style="margin-bottom:12px"><div class="arch-list"></div>';
    let rows = [];
    try { rows = await api('GET', B('/archive')); } catch (e) { toast(e.message, { kind: 'error' }); }
    const list = $('.arch-list', body);
    const draw = (q = '') => {
      const f = rows.filter((r) => `${r.id} ${r.title} ${r.parent || ''}`.toLowerCase().includes(q.toLowerCase()));
      list.innerHTML = f.length ? f.map((r, i) => `<div class="arch-row" style="animation-delay:${Math.min(i, 12) * 25}ms"><div style="min-width:0;cursor:pointer" data-open="${esc(r.id)}"><div class="t">${icon(r.type, 'sm')}<span>${esc(r.title)}</span></div><div class="s">${esc(r.id)} · ${new Date(r.archivedAt).toLocaleString()} · ${esc(r.archivedBy?.name || '')}</div></div><button class="btn sm" data-restore="${esc(r.id)}" title="Restore">${icon('restore', 'sm')}</button></div>`).join('')
        : `<div class="empty-note">${icon('archive')}</div>`;
    };
    $('input', body).oninput = (e) => draw(e.target.value);
    list.onclick = async (e) => {
      const r = e.target.closest('[data-restore]');
      if (r) {
        try { await api('POST', B(`/archive/${encodeURIComponent(r.dataset.restore)}/restore`), {}); rows = rows.filter((x) => x.id !== r.dataset.restore); draw($('input', body).value); scheduleRefresh(0); toast(`Restored ${r.dataset.restore}`, { icon: 'restore', kind: 'ok' }); }
        catch (err) { toast(err.message, { kind: 'error' }); }
        return;
      }
      const o = e.target.closest('[data-open]');
      if (o) openItem(o.dataset.open);
    };
    draw();
  }

  function openAgents() {
    const body = openDrawer('agentsDrawer', 'Agents', 'bot');
    fillAgents(body);
    refreshPresence();
  }
  const RUN_LABEL = { running: 'running', queued: 'queued', retrying: 'retrying', throttled: 'throttled', failed: 'failed — needs you', paused: 'paused', idle: 'idle' };
  // Controls for a standing agent (one the board runs itself, from agents.json).
  function standingControls(a) {
    const btn = (act, ic, label, tip) => `<button class="btn sm ghost" data-standing="${act}" data-name="${esc(a.name)}" title="${tip}">${icon(ic, 'sm')}<span>${label}</span></button>`;
    return `<div class="standing-ctl">
      <span class="run-state" data-run="${a.status}">${esc(RUN_LABEL[a.status] || a.status)}${a.queued ? ` · ${a.queued} waiting` : ''}</span>
      ${a.status === 'paused' || a.status === 'failed' ? btn('resume', 'play', 'Resume', 'Resume|Clear failures and run any waiting events') : btn('pause', 'pause', 'Pause', 'Pause|The current run finishes; new events wait')}
      ${btn('run', 'sparkle', 'Run now', 'Run now|Start a run with whatever is waiting, or just to check the board')}
      ${btn('log', 'terminal', 'Log', 'Last run|Output of the most recent run')}</div>`;
  }
  async function standingAction(btn) {
    const { standing: act, name } = btn.dataset;
    if (act === 'log') return showRunLog(name);
    try { await api('POST', `/api/agents/${encodeURIComponent(name)}/${act}`, {}); await refreshPresence(); }
    catch (e) { toast(e.message, { kind: 'error' }); }
  }
  async function showRunLog(name) {
    const body = openDrawer('runLogDrawer', `${name} · last run`, 'terminal');
    body.innerHTML = '<pre class="run-log">…</pre>';
    try {
      const r = await api('GET', `/api/agents/${encodeURIComponent(name)}/log`);
      $('.run-log', body).textContent = r.log || 'No runs yet.';
      $('.run-log', body).scrollTop = 1e9;
    } catch (e) { $('.run-log', body).textContent = e.message; }
  }

  function fillAgents(body) {
    const seen = new Set(state.presence.map((p) => p.name));
    const rows = [...Object.keys(state.standing).filter((n) => !seen.has(n)).map((name) => ({ name, connections: {}, leases: [], subscriptions: [], online: false })), ...state.presence]
      .sort((a, b) => Number(!!state.standing[b.name]) - Number(!!state.standing[a.name]));
    body.innerHTML = rows.length ? rows.map((p, i) => {
      const sa = state.standing[p.name];
      const mode = sa?.status === 'running' ? 'running now' : p.connections.stream ? 'stream' : p.connections.waiting ? 'polling' : p.online ? 'active' : sa ? 'standing by' : 'offline';
      const leases = p.leases.map((l) => `<span class="mini-chip link" data-board="${esc(l.board)}" data-open="${esc(l.id)}" title="${esc(l.title)}">${icon('clock', 'sm')}${esc(l.id)}</span>`).join('');
      const subs = p.subscriptions.map((s) => `<span class="mini-chip" title="${esc(JSON.stringify(s.filter))}">${icon('bell', 'sm')}${esc(s.label || Object.entries(s.filter).map(([k, v]) => `${k}=${v}`).join(' ') || 'all')}</span>`).join('');
      return `<div class="agent-row ${p.online || sa ? '' : 'off'}" data-agent="${esc(p.name)}" style="animation-delay:${i * 40}ms">${avatar({ kind: 'agent', name: p.name }, 'lg')}
        <div style="min-width:0"><div class="nm"><span class="status-dot ${p.online ? 'on' : ''}"></span>${esc(p.name)}</div><div class="sub" title="${esc(p.lastAction || '')}">${mode} · ${p.lastSeen ? rel(p.lastSeen) : '—'}${p.lastAction ? ` · ${esc(p.lastAction)}` : ''}</div></div>
        ${leases || subs ? `<div class="extra">${leases}${subs}</div>` : ''}${sa ? standingControls(sa) : ''}</div>`;
    }).join('') : `<div class="empty-note">${icon('bot')}</div>`;
    body.onclick = async (e) => {
      const sb = e.target.closest('[data-standing]');
      if (sb) { e.stopPropagation(); standingAction(sb); return; }
      const o = e.target.closest('[data-open]');
      if (!o) { const a = e.target.closest('[data-agent]'); if (a && !e.target.closest('.avatar')) openAgent(a.dataset.agent); return; }
      if (o.dataset.board !== state.boardId) await loadBoard(o.dataset.board);
      openItem(o.dataset.open);
    };
  }

  function toast(msg, { kind = '', icon: ic = null, actor = null, action = null, onAction = null, onClick = null, timeout = 3800 } = {}) {
    const lead = actor ? avatar(actor) : ic ? icon(ic) : kind === 'error' ? icon('x') : kind === 'needs' ? icon('ask') : icon('sparkle');
    const t = el(`<div class="toast ${kind === 'needs' ? '' : kind} ${onClick ? 'click' : ''}" ${kind === 'needs' ? 'style="--tc:var(--accent-2)"' : ''}>${lead}<span class="msg"></span>${action ? `<button>${esc(action)}</button>` : ''}<i class="bar" style="animation-duration:${timeout}ms"></i></div>`);
    $('.msg', t).textContent = msg;
    const host = $('#toasts');
    host.append(t);
    while (host.children.length > 4) host.firstChild.remove();
    const kill = () => { t.classList.add('out'); setTimeout(() => t.remove(), 250); };
    if (action) $('button', t).onclick = (e) => { e.stopPropagation(); onAction?.(); kill(); };
    if (onClick) t.onclick = () => { onClick(); kill(); };
    let timer = setTimeout(kill, timeout);
    t.onmouseenter = () => clearTimeout(timer);
    t.onmouseleave = () => { timer = setTimeout(kill, 1500); };
  }

  /* ═════════════════════════ token prompt ═════════════════════════ */

  let tokenPrompt = null;
  function promptToken() {
    if (tokenPrompt) return tokenPrompt;
    tokenPrompt = new Promise((resolve) => {
      const root = el(`<div class="scrim" style="z-index:700"><div class="modal token-modal pop">${icon('lock', 'big')}<div style="font:700 16px var(--display)">${esc(state.app.name)}</div>
        <div class="row2"><input class="inp" type="password" placeholder="Access token" autocomplete="off"><button class="btn primary">${icon('check')}</button></div></div></div>`);
      document.body.append(root);
      syncScrimmed();
      const inp = $('input', root);
      const done = () => {
        const v = inp.value.trim();
        if (!v) { inp.focus(); return; }
        AUTH.token = v;
        try { localStorage.setItem(TOKEN_KEY, v); } catch { /* private mode */ }
        root.remove();
        syncScrimmed();
        tokenPrompt = null;
        reconnect();
        resolve(true);
      };
      $('button', root).onclick = done;
      inp.onkeydown = (e) => { if (e.key === 'Enter') done(); };
      setTimeout(() => inp.focus(), 50);
    });
    return tokenPrompt;
  }

  /* ═════════════════════════ listeners ═════════════════════════ */

  let listenTimer = null;
  function scheduleListeners() { clearTimeout(listenTimer); listenTimer = setTimeout(refreshListeners, 300); }
  async function refreshListeners() {
    if (!state.boardId) return;
    try {
      const l = await api('GET', B('/listeners'));
      const sig = JSON.stringify(l);
      if (sig !== state.listenersSig) { state.listeners = l; state.listenersSig = sig; render(); }
    } catch { /* offline */ }
  }

  /* ═════════════════════════ while you were away ═════════════════════════ */

  const SEEN_KEY = 'intellagent.seen.v1';
  const seen = (() => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch { return {}; } })();
  function saveSeen() { try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* private mode */ } }
  const seenFor = (b) => (seen[b] ||= { seq: null, items: {} });
  const catchupDone = new Set();
  const newsworthy = (ev) => !!ev.itemId && !QUIET.has(ev.type) && ev.type !== 'lease.warning' && !(ev.actor?.kind === 'user' && ev.actor.name === settings.userName);

  function noteUnseen(ev) {
    const list = (seenFor(ev.board).items[ev.itemId] ||= []);
    if (list.some((x) => x.seq === ev.seq)) return;
    list.push({ seq: ev.seq, ts: ev.ts, actor: ev.actor, text: describe(ev) });
    if (list.length > 12) list.shift();
  }
  async function catchUp(b) {
    const s = seenFor(b);
    if (s.seq == null) { s.seq = state.seq; saveSeen(); return; }
    if (s.seq < state.seq) {
      try {
        const r = await api('GET', `/api/events?since=${s.seq}&board=${encodeURIComponent(b)}&limit=1000`);
        for (const ev of r.events) if (newsworthy(ev)) noteUnseen(ev);
      } catch { return; }
      s.seq = state.seq;
      saveSeen();
    }
    render();
    renderCatch();
    const n = Object.keys(s.items).filter((id) => state.board.items[id]).length;
    if (n) toast(`${n} ticket${n > 1 ? 's' : ''} changed while you were away`, { icon: 'sparkle', action: 'Show', onAction: openCatchup, timeout: 6000 });
  }
  function clearUnseen(id) {
    if (!state.boardId) return;
    const s = seenFor(state.boardId);
    if (!s.items[id]) return;
    delete s.items[id];
    saveSeen();
    updateCard(cardEls.get(id), state.board.items[id]);
    renderCatch();
    if ($('#catchDrawer')) drawCatch($('#catchDrawer .drawer-body'));
  }
  function renderCatch() {
    const btn = $('#catchBtn');
    if (!btn || !state.board) return;
    const n = Object.keys(seenFor(state.boardId).items).filter((id) => state.board.items[id]).length;
    btn.hidden = !n;
    $('#catchCount').textContent = n;
  }
  function drawCatch(body) {
    const s = seenFor(state.boardId);
    const ids = Object.keys(s.items).filter((id) => state.board.items[id]);
    body.innerHTML = ids.length
      ? `<div class="feed-head"><span class="grow"></span><button class="btn sm" data-allseen>${icon('check', 'sm')}Mark all seen</button></div>${ids.map((id, i) => {
        const it = state.board.items[id];
        return `<div class="catch-item" data-open="${esc(id)}" style="animation-delay:${Math.min(i, 12) * 30}ms"><div class="t">${icon(it.type, 'sm')}<span style="font:11px var(--mono);color:var(--muted)">${esc(id)}</span>${esc(it.title)}</div>
          ${s.items[id].slice(-5).reverse().map((e) => `<div class="ev">${avatar(e.actor)}<span>${esc(e.text)}</span><time>${rel(e.ts)}</time></div>`).join('')}</div>`;
      }).join('')}`
      : `<div class="empty-note">${icon('check')}</div>`;
  }
  function openCatchup() {
    const body = openDrawer('catchDrawer', 'While you were away', 'sparkle');
    drawCatch(body);
    body.onclick = (e) => {
      if (e.target.closest('[data-allseen]')) { seenFor(state.boardId).items = {}; saveSeen(); render(); renderCatch(); drawCatch(body); return; }
      const o = e.target.closest('[data-open]');
      if (o && !e.target.closest('.avatar')) openItem(o.dataset.open, cardEls.get(o.dataset.open));
    };
  }

  /* ═════════════════════════ inbox ═════════════════════════ */

  const INBOX_KEY = 'intellagent.inbox.v1';
  const inboxRead = (() => { try { return JSON.parse(localStorage.getItem(INBOX_KEY) || 'null') || { seq: 0, ids: [] }; } catch { return { seq: 0, ids: [] }; } })();
  function saveInbox() { try { localStorage.setItem(INBOX_KEY, JSON.stringify(inboxRead)); } catch { /* private mode */ } }
  const myName = () => (settings.userName || 'You').toLowerCase();
  const forMe = (ev) => ev.actor?.name?.toLowerCase() !== myName() && !QUIET.has(ev.type)
    && ((ev.recipients || []).some((r) => r.toLowerCase() === myName()) || ev.type === 'attention.raised');
  const isUnread = (ev) => ev.seq > inboxRead.seq && !inboxRead.ids.includes(ev.seq);

  async function refreshInbox() {
    const n = encodeURIComponent(settings.userName || 'You');
    try {
      const [a, b] = await Promise.all([
        api('GET', `/api/events?since=0&limit=400&tail=true&for=${n}`),
        api('GET', '/api/events?since=0&limit=200&tail=true&types=attention.raised'),
      ]);
      const map = new Map();
      for (const ev of [...a.events, ...b.events]) if (forMe(ev)) map.set(ev.seq, ev);
      state.inbox = [...map.values()].sort((x, y) => y.seq - x.seq).slice(0, 200);
    } catch { return; }
    renderInboxBtn();
  }
  function renderInboxBtn() {
    const badge = $('#inboxBtn .badge');
    if (!badge) return;
    const n = state.inbox.filter(isUnread).length;
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : n;
    if ($('#inboxDrawer')) drawInbox($('#inboxDrawer .drawer-body'));
  }
  function markRead(seq) { if (!inboxRead.ids.includes(seq)) { inboxRead.ids.push(seq); inboxRead.ids = inboxRead.ids.slice(-500); saveInbox(); } }
  function markInboxItemRead(id) {
    const hits = state.inbox.filter((ev) => ev.itemId === id && isUnread(ev));
    if (!hits.length) return;
    hits.forEach((ev) => markRead(ev.seq));
    renderInboxBtn();
  }
  function drawInbox(body) {
    const unread = state.inbox.filter(isUnread).length;
    body.innerHTML = `<div class="feed-head"><span class="grow"></span>${unread ? `<button class="btn sm" data-allread>${icon('check', 'sm')}Mark all read</button>` : ''}</div>`
      + (state.inbox.length ? state.inbox.map((ev, i) => `<div class="feed-row ${isUnread(ev) ? 'unread' : ''}" data-seq="${ev.seq}" data-board="${esc(ev.board || '')}" data-item="${esc(ev.itemId || '')}" style="animation-delay:${Math.min(i, 15) * 20}ms">
          <span class="dot"></span>${avatar(ev.actor)}<div>${describe(ev, true)}${ev.board && ev.board !== state.boardId ? `<span class="brd">${esc(ev.board)}</span>` : ''}</div><time>${rel(ev.ts)}</time></div>`).join('')
        : `<div class="empty-note">${icon('bell')}</div>`);
  }
  function openInbox() {
    const body = openDrawer('inboxDrawer', 'Inbox', 'bell');
    drawInbox(body);
    body.onclick = async (e) => {
      if (e.target.closest('[data-allread]')) { inboxRead.seq = Math.max(inboxRead.seq, ...state.inbox.map((x) => x.seq)); inboxRead.ids = []; saveInbox(); renderInboxBtn(); return; }
      if (e.target.closest('.avatar')) return;
      const row = e.target.closest('[data-seq]');
      if (!row) return;
      markRead(Number(row.dataset.seq));
      renderInboxBtn();
      if (!row.dataset.item) return;
      if (row.dataset.board && row.dataset.board !== state.boardId) await loadBoard(row.dataset.board);
      openItem(row.dataset.item, cardEls.get(row.dataset.item));
    };
  }

  /* ═════════════════════════ digest ═════════════════════════ */

  const DIGEST_KEY = 'intellagent.digest.v1';
  const digestSeen = (() => { try { return JSON.parse(localStorage.getItem(DIGEST_KEY) || '{}'); } catch { return {}; } })();
  function markDigestSeen() {
    digestSeen[state.boardId] = state.board.digest?.[state.board.digest.length - 1]?.ts || '';
    try { localStorage.setItem(DIGEST_KEY, JSON.stringify(digestSeen)); } catch { /* private mode */ }
    renderHeader();
  }
  function dayLabel(d) {
    const today = new Date(nowMs()).toLocaleDateString('en-CA');
    const yday = new Date(nowMs() - 86400000).toLocaleDateString('en-CA');
    if (d === today) return 'Today';
    if (d === yday) return 'Yesterday';
    return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }
  function openDigest() {
    const body = openDrawer('digestDrawer', 'Digest', 'news');
    const post = async () => {
      const ta = $('.digest-compose textarea', body);
      const v = ta.value.trim();
      if (!v) { ta.focus(); return; }
      try { await api('POST', B('/digest'), { summary: v }); ta.value = ''; await loadBoard(state.boardId); draw(); markDigestSeen(); }
      catch (e) { toast(e.message, { kind: 'error' }); }
    };
    const draw = () => {
      const byDay = new Map();
      for (const e of (state.board.digest || []).slice().reverse()) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e); }
      body.innerHTML = `<div class="digest-compose">${tboxHTML({ ph: 'Add a note…', okIcon: 'send', okTitle: 'Post (Ctrl+Enter)' })}</div>${[...byDay].map(([d, list]) => `<div class="dg-day"><div class="section-head"><span>${esc(dayLabel(d))}</span><span class="rule"></span></div>
        ${list.map((e) => `<div class="dg-entry">${avatar(e.author, 'lg')}<div style="min-width:0"><div class="cmt-head"><b>${esc(e.author?.name)}</b><span>${new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>${(e.items || []).map((id) => `<span class="mini-chip link" data-open="${esc(id)}">${esc(id)}</span>`).join('')}</div><div class="md">${md(e.summary)}</div></div></div>`).join('')}</div>`).join('') || `<div class="empty-note">${icon('news')}</div>`}`;
      wireTbox($('.tbox', body), post);
    };
    body._redraw = draw;
    body.onclick = (e) => { const o = e.target.closest('[data-open]'); if (o && !e.target.closest('.avatar')) openItem(o.dataset.open, cardEls.get(o.dataset.open)); };
    draw();
    markDigestSeen();
  }

  /* ═════════════════════════ agent profile ═════════════════════════ */

  function standingSection(a) {
    const l = a.lastRun;
    const listen = typeof a.listen === 'string' ? a.listen : Object.entries(a.listen).map(([k, v]) => `${k}=${v}`).join(' ');
    const meta = `wakes on ${esc(listen)} · ${a.runsLastHour}/${a.maxRunsPerHour ?? '∞'} runs this hour${l ? ` · last run ${rel(l.endedAt || l.startedAt)}${l.code != null && l.code !== 0 ? ` (exit ${esc(l.code)})` : ''}` : ''}`;
    return `<div class="section"><div class="section-head">${icon('radio', 'sm')}<span>Standing agent</span><span class="rule"></span></div>${standingControls(a)}<div class="standing-meta">${meta}</div></div>`;
  }

  async function openAgent(name) {
    const body = openDrawer('agentDrawer', name, 'bot');
    const draw = (activity = null) => {
      const p = state.profiles[name] || {};
      const pres = state.presence.find((x) => x.name === name);
      const items = Object.values(state.board?.items || {});
      const chip = (id, ic) => `<span class="mini-chip link" data-open="${esc(id)}" title="${esc(state.board.items[id]?.title || '')}">${icon(ic, 'sm')}${esc(id)}</span>`;
      const section = (title, ic, html) => (html ? `<div class="section"><div class="section-head">${icon(ic, 'sm')}<span>${title}</span><span class="rule"></span></div><div class="deps">${html}</div></div>` : '');
      const mode = pres ? (pres.connections.stream ? 'stream' : pres.connections.waiting ? 'polling' : pres.online ? 'active' : 'offline') : 'never seen';
      body.innerHTML = `<div class="agent-hero">${avatar({ kind: p.kind || 'agent', name }, 'xl')}<div style="min-width:0"><div class="ah-name">${esc(p.label || name)}</div>
          <div class="ah-sub"><span class="status-dot ${pres?.online ? 'on' : ''}"></span><span>${esc(name)}</span><span>· ${mode}</span>${pres?.lastSeen ? `<span>· ${rel(pres.lastSeen)}</span>` : ''}</div></div></div>
        ${p.description || state.standing[name]?.description ? `<div class="md ah-desc">${md(p.description || state.standing[name].description)}</div>` : ''}
        ${state.standing[name] ? standingSection(state.standing[name]) : ''}
        ${section('Holding', 'clock', (pres?.leases || []).map((l) => chip(l.id, 'clock')).join(''))}
        ${section('Assigned', 'user', items.filter((i) => i.assignee === name).map((i) => chip(i.id, i.type)).join(''))}
        ${section('Listening to', 'radio', Object.entries(state.listeners).filter(([, ns]) => ns.includes(name)).map(([id]) => chip(id, 'radio')).join(''))}
        ${section('Subscriptions', 'bell', (pres?.subscriptions || []).map((x) => `<span class="mini-chip" title="${esc(JSON.stringify(x.filter))}">${icon('bell', 'sm')}${esc(x.label || Object.entries(x.filter).map(([k, v]) => `${k}=${v}`).join(' ') || 'all')}</span>`).join(''))}
        <div class="section"><div class="section-head">${icon('activity', 'sm')}<span>Activity</span><span class="rule"></span></div>
          <div class="ah-act">${activity == null ? '' : activity.length ? activity.map((ev) => `<div class="act">${icon(eventIcon(ev.type), 'sm')}<div>${describe(ev, true)}</div><time>${rel(ev.ts)}</time></div>`).join('') : `<div class="empty-note">${icon('activity')}</div>`}</div></div>`;
    };
    draw();
    body.onclick = (e) => {
      const sb = e.target.closest('[data-standing]');
      if (sb) { standingAction(sb).then(() => draw()); return; }
      const o = e.target.closest('[data-open]'); if (o) openItem(o.dataset.open, cardEls.get(o.dataset.open));
    };
    try {
      const r = await api('GET', `/api/events?since=0&limit=30&tail=true&actor=${encodeURIComponent(name)}`);
      if ($('#agentDrawer')) draw(r.events.slice().reverse());
    } catch { /* offline */ }
  }

  /* ═════════════════════════ command palette (Ctrl+K) ═════════════════════════ */

  function togglePalette() { if ($('.palette-scrim')) closePalette(); else openPalette(); }
  function closePalette() { const p = $('.palette-scrim'); if (p) { p.remove(); syncScrimmed(); } }

  function ticketStage(it) {
    const lease = activeLease(it);
    const fail = (e) => toast(e.message, { kind: 'error' });
    return {
      title: it.id,
      items: [
        { label: 'Open', icon: 'eye', run: () => openItem(it.id, cardEls.get(it.id)) },
        { label: 'Move to…', icon: 'move', run: () => ({ title: 'Move', items: state.board.columns.filter((c) => c.id !== it.columnId).map((c) => ({ label: c.name, color: c.color, run: () => patchItem(it.id, { column: c.id, position: 'top' }) })) }) },
        { label: 'Priority…', icon: 'flag', run: () => ({ title: 'Priority', items: PRIORITIES.map((p) => ({ label: p, color: PRIO_VAR[p], hint: p === it.priority ? '●' : '', run: () => patchItem(it.id, { priority: p }) })) }) },
        { label: 'Assign…', icon: 'user', run: () => ({ title: 'Assign', items: [{ label: 'Nobody', icon: 'x', run: () => patchItem(it.id, { assignee: null }) }, ...knownPeople().map((n) => ({ label: n, avatar: { name: n }, run: () => patchItem(it.id, { assignee: n }) }))] }) },
        lease
          ? { label: `Revoke ${lease.claimant}'s lease`, icon: 'x', run: () => api('DELETE', I(it.id, '/lease')).then(() => scheduleRefresh(0), fail) }
          : { label: 'Hold 30 min', icon: 'lock', run: () => api('POST', I(it.id, '/lease'), { minutes: 30, force: true }).then(() => scheduleRefresh(0), fail) },
        { label: 'Copy ID', icon: 'copy', run: () => { navigator.clipboard?.writeText(it.id); toast(`Copied ${it.id}`, { icon: 'copy', timeout: 1500 }); } },
        { label: 'Archive', icon: 'archive', run: () => api('POST', I(it.id, '/archive'), {}).then(() => { toast(`Archived ${it.id}`, { icon: 'archive', action: 'Undo', onAction: () => restoreMany([it.id]) }); scheduleRefresh(0); }, fail) },
      ],
    };
  }

  function rootStage() {
    const b = state.board;
    const A = 'Actions';
    const cmds = [
      ...(b ? b.columns.filter((c) => c.flags.allowCreate).map((c) => ({ section: A, label: `New ticket in ${c.name}`, icon: 'plus', run: () => openComposer(c.id) })) : []),
      { section: A, label: 'Needs you', icon: 'ask', hint: String(needsIds().length), run: () => { const ids = needsIds(); if (ids.length) openItem(ids[0], cardEls.get(ids[0]), { rail: true }); } },
      { section: A, label: 'Inbox', icon: 'bell', run: openInbox },
      { section: A, label: 'While you were away', icon: 'sparkle', run: openCatchup },
      { section: A, label: 'Standing rules', icon: 'pin', run: openRules },
      { section: A, label: 'Digest', icon: 'news', run: openDigest },
      activeMaster()
        ? { section: A, label: `Release the board (${activeMaster().holder})`, icon: 'x', run: () => api('DELETE', B('/master')).then(() => scheduleRefresh(0), (e) => toast(e.message, { kind: 'error' })) }
        : { section: A, label: 'Hold the whole board', icon: 'lock', hint: 'master lease', run: () => api('POST', B('/master'), { force: true }).then(() => scheduleRefresh(0), (e) => toast(e.message, { kind: 'error' })) },
      { section: A, label: 'Agents', icon: 'bot', run: openAgents },
      { section: A, label: 'Archive', icon: 'archive', run: openArchive },
      { section: A, label: 'Select mode', icon: 'checks', run: () => setBulk(!state.bulk) },
      { section: A, label: 'Settings', icon: 'sliders', run: () => openSettings() },
      { section: A, label: 'Ticket fields', icon: 'layers', run: () => openSettings('fields') },
      { section: 'Go to', label: 'Switch board…', icon: 'board', run: () => ({ title: 'Board', items: state.boards.map((x) => ({ label: x.name, icon: 'board', hint: String(x.items), run: () => { closeModal(true); loadBoard(x.id); } })) }) },
      { section: 'Look', label: 'Theme…', icon: 'palette', run: () => ({ title: 'Theme', items: Object.entries(THEMES).map(([k, t]) => ({ label: t.label, color: t.vars.accent, hint: k === settings.theme ? '●' : '', run: () => switchTheme(k) })) }) },
      { section: 'Look', label: 'Background…', icon: 'wave', run: () => ({ title: 'Background', items: BACKGROUNDS.map(([k, l]) => ({ label: l, icon: 'wave', hint: k === pick('bg') ? '●' : '', run: () => { settings.bg = k; saveSettings(); } })) }) },
    ];
    const tickets = b ? b.columns.flatMap((c) => c.itemIds).map((id) => b.items[id]).filter(Boolean)
      .map((it) => ({ section: 'Tickets', label: `${it.id}  ${it.title}`, icon: it.type, hint: colById(it.columnId)?.name, keys: `${it.parent || ''} ${it.assignee || ''}`, run: () => ticketStage(it) })) : [];
    return { title: '', items: [...cmds, ...tickets] };
  }

  function openPalette() {
    closeMenus();
    const root = el(`<div class="scrim palette-scrim"><div class="palette" role="dialog" aria-modal="true">
      <div class="pal-head">${icon('search')}<span class="pal-crumb"></span><input class="pal-input" spellcheck="false" placeholder="Search tickets or type a command…"></div>
      <div class="pal-list"></div>
      <div class="pal-foot"><span><kbd>↑↓</kbd></span><span><kbd>Enter</kbd></span><span><kbd>⌫</kbd> back</span><span><kbd>Esc</kbd></span></div></div></div>`);
    document.body.append(root);
    syncScrimmed();
    root.addEventListener('pointerdown', (e) => { if (e.target === root) closePalette(); });
    const input = $('.pal-input', root);
    const list = $('.pal-list', root);
    const crumb = $('.pal-crumb', root);
    const stack = [rootStage()];
    let active = 0;
    let shownItems = [];
    const draw = () => {
      const st = stack[stack.length - 1];
      crumb.innerHTML = stack.slice(1).map((x) => `<span>${esc(x.title)}</span>`).join('');
      const q = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      shownItems = st.items.filter((it) => !q.length || q.every((t) => `${it.label} ${it.hint || ''} ${it.keys || ''}`.toLowerCase().includes(t))).slice(0, 60);
      active = clamp(active, 0, Math.max(0, shownItems.length - 1));
      let sec = null;
      let html = '';
      shownItems.forEach((it, i) => {
        if (it.section && it.section !== sec && !q.length) { sec = it.section; html += `<div class="pal-sec">${esc(sec)}</div>`; }
        const lead = it.avatar ? avatar(it.avatar) : it.color ? `<span class="sw" style="--c:${esc(it.color)}"></span>` : icon(it.icon || 'sparkle');
        html += `<button class="pal-item ${i === active ? 'act' : ''}" data-i="${i}">${lead}<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</button>`;
      });
      list.innerHTML = html || '<div class="empty-note">—</div>';
      $('.pal-item.act', list)?.scrollIntoView({ block: 'nearest' });
    };
    const run = (it) => {
      if (!it) return;
      const next = it.run?.();
      if (next && Array.isArray(next.items)) { stack.push(next); input.value = ''; active = 0; draw(); input.focus(); }
      else closePalette();
    };
    input.oninput = () => { active = 0; draw(); };
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = clamp(active + (e.key === 'ArrowDown' ? 1 : -1), 0, shownItems.length - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); run(shownItems[active]); }
      else if (e.key === 'Backspace' && !input.value && stack.length > 1) { stack.pop(); active = 0; draw(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (stack.length > 1) { stack.pop(); input.value = ''; active = 0; draw(); } else closePalette(); }
    };
    list.onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) run(shownItems[Number(b.dataset.i)]); };
    list.onmousemove = (e) => {
      const b = e.target.closest('[data-i]');
      if (!b || Number(b.dataset.i) === active) return;
      active = Number(b.dataset.i);
      $$('.pal-item', list).forEach((x) => x.classList.toggle('act', Number(x.dataset.i) === active));
    };
    draw();
    input.focus();
  }

  /* ═════════════════════════ settings ═════════════════════════ */

  const STUB_TIPS = {
    id: 'The ticket number, e.g. INT-12', type: 'Issue, task or spike icon', priority: 'Shown when not Medium', parent: 'The #group tag (hidden inside groups)',
    author: 'Who created it', lease: 'Who is working on it, with a countdown ring', comments: 'How many comments', attachments: 'How many files',
    blocked: 'Blockers that are not done yet', fields: 'Custom fields set to show on cards', properties: 'Count of free-form agent data',
    description: 'First lines of the description', thumbnail: 'The chosen card image', assignee: 'Who it is handed to',
    status: 'The live status line from the agent holding it', checklist: 'Progress of description checkboxes', listeners: 'Agents subscribed to this ticket',
  };
  const STUB_FIELDS = [
    ['id', 'ID', 'hash'], ['type', 'Type', 'layers'], ['priority', 'Priority', 'flag'], ['parent', 'Parent', 'hash'],
    ['author', 'Author', 'user'], ['lease', 'Lease', 'clock'], ['comments', 'Comments', 'msg'], ['attachments', 'Files', 'clip'],
    ['blocked', 'Blocked', 'lock'], ['fields', 'Fields', 'layers'], ['properties', 'Properties', 'braces'], ['description', 'Description', 'text'], ['thumbnail', 'Image', 'image'],
    ['assignee', 'Assignee', 'user'], ['status', 'Status', 'activity'], ['checklist', 'Checklist', 'checks'], ['listeners', 'Listeners', 'radio'],
  ];

  function openSettings(tab = 'look') {
    closeModal(true);
    const root = el(`<div class="scrim"><div class="modal settings entering" role="dialog" aria-modal="true">
      <header class="m-head"><span class="m-type" style="color:var(--accent)">${icon('sliders')}</span><span style="font:700 16px var(--display);color:var(--text)">Settings</span><span class="saved">${icon('check', 'sm')}</span><span class="grow"></span><button class="pill-btn icon-btn sm" data-close>${icon('x')}</button></header>
      <div class="m-frame"><nav class="set-nav">
        <button data-tab="look">${icon('palette')}Appearance</button>
        <button data-tab="cards">${icon('card')}Cards</button>
        <button data-tab="board">${icon('board')}Board</button>
        <button data-tab="fields">${icon('layers')}Fields</button>
        <button data-tab="notify">${icon('bell')}Alerts</button>
        <button data-tab="about">${icon('info')}About</button>
      </nav><div class="set-pane"></div></div></div></div>`);
    document.body.append(root);
    const m = { kind: 'settings', id: null, root, modal: $('.modal', root), tab, refresh: () => {} };
    state.modal = m;
    syncScrimmed();
    root.addEventListener('pointerdown', (e) => { root._down = e.target === root; });
    root.addEventListener('click', (e) => { if (e.target === root && root._down) closeModal(); });
    $('[data-close]', root).onclick = () => closeModal();
    const pane = $('.set-pane', root);
    const show = (t, quiet = false) => {
      m.tab = t;
      const scroll = pane.scrollTop;
      const carScroll = $('.car-track', pane)?.scrollLeft;
      $$('.set-nav button', root).forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
      pane.innerHTML = settingsPane(t);
      if (quiet) pane.scrollTop = scroll;
      else pane.animate([{ opacity: 0, translate: '0 6px' }, { opacity: 1, translate: '0 0' }], { duration: 260, easing: SPRING });
      centerCarousel(pane, carScroll);
      for (const r of $$('input[type="range"]', pane)) paintRange(r);
      wirePane(t, pane, show);
    };
    $$('.set-nav button', root).forEach((b) => { b.onclick = () => show(b.dataset.tab); });
    // Live data (schema, profiles) changed elsewhere: redraw quietly unless the user is typing in the pane.
    m.refresh = () => {
      const typing = pane.contains(document.activeElement) && document.activeElement.matches('input, textarea');
      if (['fields', 'board'].includes(m.tab) && !typing) show(m.tab, true);
    };
    show(tab);
  }

  const paintRange = (r) => r.style.setProperty('--p', `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
  const seg = (key, opts, val) => `<div class="seg" data-set="${key}">${opts.map(([v, label, tip]) => `<button class="${v === val ? 'on' : ''}" data-v="${v}"${tip ? ` title="${label}|${tip}"` : ''}>${label}</button>`).join('')}</div>`;
  const sw = (key, on) => `<button class="switch ${on ? 'on' : ''}" data-sw="${key}" role="switch" aria-checked="${on}"></button>`;

  /* ─── live previews (same cardHTML as the board) ─── */
  function sampleValue(f) {
    switch (f.type) {
      case 'number': return f.min ?? 3;
      case 'boolean': return true;
      case 'enum': return f.options?.[0]?.value ?? null;
      case 'tags': return [f.options?.[0]?.value || 'ui'];
      case 'date': return new Date(nowMs()).toISOString().slice(0, 10);
      case 'url': return 'https://example.com/pull/12';
      case 'user': return 'storage-bot';
      default: return 'Sample';
    }
  }
  function sampleItem(o = {}) {
    const t = new Date(nowMs()).toISOString();
    const fields = {};
    for (const f of schema().fields) fields[f.key] = sampleValue(f);
    return {
      id: 'DEMO-7', title: 'Ship the onboarding flow', type: 'task', priority: 'High', parent: 'onboarding', columnId: '__preview',
      author: { kind: 'agent', name: 'claude-builder' }, assignee: 'storage-bot',
      description: 'Polish the first-run experience.\n- [x] Copy\n- [x] Layout\n- [ ] Analytics',
      comments: [{}, {}], attachments: [{ id: 'img', kind: 'file', mime: 'image/svg+xml', name: 'mockup.svg', url: SAMPLE_IMG }, { id: 'a', kind: 'file', mime: 'text/plain', name: 'notes.txt', url: '#' }],
      properties: { env: 'staging' }, fields, blockedBy: [], cover: 'auto', version: 1, createdAt: t, updatedAt: t, ...o,
    };
  }
  // A tiny inline landscape so the "Image" card option has something to show in previews.
  const SAMPLE_IMG = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b7bff"/><stop offset="1" stop-color="#2fe0c4"/></linearGradient></defs><rect width="320" height="180" fill="url(#s)"/><circle cx="240" cy="52" r="22" fill="#fff" opacity=".85"/><path d="M0 150 L70 92 L120 128 L190 70 L320 160 V180 H0Z" fill="#1d2035" opacity=".55"/></svg>')}`;
  const demoLease = () => ({ claimant: 'claude-builder', expiresAt: new Date(nowMs() + 18 * 60000).toISOString(), minutes: 30, status: 'running tests 4/12' });
  function previewCard(it, { lease = null, blockers = [], listeners = [], needs = false, inGroup = false, si = null } = {}) {
    return `<article class="card ${needs ? 'needs' : ''}" data-type="${it.type}" style="--tilt:${tilt(it.id)}deg${si != null ? `;--si:${si}` : ''}"><i class="tape"></i><div class="c-body">${cardHTML(it, lease, blockers, inGroup, listeners)}</div><span class="c-check">${icon('check')}</span><span class="c-ask">?</span></article>`;
  }
  function previewStage(kind) {
    const col = (name, color, inner, n) => `<section class="column pv-col" style="--col:${color}"><header class="col-head"><span class="col-dot"></span><h2 class="col-name">${name}</h2><span class="col-count">${n}</span></header><div class="list">${inner}</div></section>`;
    const bare = { parent: null, assignee: null, description: '', comments: [], attachments: [], fields: {}, properties: {} };
    if (kind === 'cards') {
      return `<div class="pv-stage">${col('In Progress', '#f2a541', previewCard(sampleItem(), { lease: demoLease(), blockers: ['DEMO-3'], listeners: ['storage-bot'] }), 1)}</div>`;
    }
    if (kind === 'style') {
      const a = previewCard(sampleItem({ ...bare, id: 'DEMO-4', title: 'Token refresh race on wake', type: 'issue', priority: 'Critical' }), { needs: true });
      const b = previewCard(sampleItem({ ...bare, id: 'DEMO-9', title: 'Benchmark cache options', type: 'spike', priority: 'Medium', parent: 'storage' }), { lease: demoLease() });
      return `<div class="pv-stage pv-wide">${col('Review', '#b07cf2', a + b, 2)}<div class="pv-side"><button class="pill-btn">${icon('board', 'sm')}Main${icon('chev', 'sm')}</button><button class="btn primary">${icon('check', 'sm')}Save</button><button class="btn">${icon('archive', 'sm')}Archive</button><span class="chip parent" style="--tagc:${tagColor('storage')}">storage</span><div class="seg"><button class="on">Edit</button><button>Read</button></div>${avatar({ kind: 'agent', name: 'claude-builder' })}</div></div>`;
    }
    const items = ['Login form', 'Session cookie', 'Refresh endpoint'].map((title, i) => sampleItem({ ...bare, id: `DEMO-${i + 1}`, title, type: i === 2 ? 'issue' : 'task', priority: ['Medium', 'Low', 'High'][i], parent: 'auth' }));
    const inner = settings.grouping === 'off'
      ? items.map((it) => previewCard(it)).join('')
      : `<section class="group ${settings.grouping}" style="--tagc:${tagColor('auth')}"><button class="group-head"><span class="g-dot"></span><span class="g-name">auth</span><span class="g-count">3</span><span class="grow"></span>${icon('chev', 'g-chev')}</button><div class="group-cards" data-n="3">${items.map((it, i) => previewCard(it, { inGroup: true, si: i })).join('')}</div></section>`;
    return `<div class="pv-stage">${col('Ready', '#5aa9e6', inner, 3)}</div>`;
  }

  // Keep the active theme centred: restore the old scroll position first, then glide to the new tile.
  function centerCarousel(pane, from) {
    const track = $('.car-track', pane);
    const on = track && $('.tile.on', track);
    if (!on) return;
    wireCarousel(track);
    track.style.scrollBehavior = 'auto';
    if (from != null) track.scrollLeft = from;
    requestAnimationFrame(() => {
      track.style.scrollBehavior = from != null && !reduced() ? 'smooth' : 'auto';
      track.scrollLeft = on.offsetLeft - (track.clientWidth - on.offsetWidth) / 2;
    });
  }

  // Wheel scrolls sideways; click-drag pans. A drag never counts as a click on a theme tile.
  function wireCarousel(track) {
    track.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      track.style.scrollBehavior = 'auto';
      track.scrollLeft += e.deltaY;
    }, { passive: false });
    let pan = null;
    track.addEventListener('pointerdown', (e) => { if (e.button === 0) pan = { x: e.clientX, left: track.scrollLeft, moved: false, id: e.pointerId }; });
    track.addEventListener('pointermove', (e) => {
      if (!pan) return;
      const dx = e.clientX - pan.x;
      if (!pan.moved && Math.abs(dx) < 5) return;
      if (!pan.moved) { pan.moved = true; track.setPointerCapture(pan.id); track.classList.add('panning'); }
      track.style.scrollBehavior = 'auto';
      track.scrollLeft = pan.left - dx;
    });
    const end = () => { if (pan?.moved) track._noClick = true; pan = null; track.classList.remove('panning'); };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    track.addEventListener('click', (e) => { if (track._noClick) { track._noClick = false; e.stopPropagation(); e.preventDefault(); } }, true);
  }

  function settingsPane(t) {
    if (t === 'look') {
      const tiles = Object.entries(THEMES).map(([k, th]) => {
        const v = th.vars;
        return `<button class="tile ${settings.theme === k ? 'on' : ''}" data-pick-theme="${k}"><span class="pv" style="background:${v.bg}">
          <i style="background:${v.panel}"><b style="background:${v.issue};opacity:.85"></b><b style="background:${v.surface}"></b></i>
          <i style="background:${v.panel}"><b style="background:${v.task};opacity:.85"></b><b style="background:${v.accent}"></b></i>
          <i style="background:${v.panel}"><b style="background:${v.spike};opacity:.85"></b></i></span><span class="nm">${th.label}</span></button>`;
      }).join('');
      const themeBg = themeStyle().bg;
      const bgs = [['theme', `Theme · ${BACKGROUNDS.find(([k]) => k === themeBg)?.[1] || ''}`], ...BACKGROUNDS].map(([k, label]) => `<button class="tile ${(settings.bg || 'theme') === k ? 'on' : ''}" data-bgfx="${k}"><span class="bgpv ${k === 'theme' ? themeBg : k}"></span><span class="nm">${label}</span></button>`).join('');
      const opt = (key, list) => seg(key, [['theme', 'Theme', 'Use what the current theme chooses'], ...list], settings[key] ?? 'theme');
      return `<div class="look-sticky">
          <div class="carousel"><button class="car-nav" data-car="-1" title="Scroll left">${icon('chev', 'car-l')}</button><div class="car-track">${tiles}</div><button class="car-nav" data-car="1" title="Scroll right">${icon('chev', 'car-r')}</button></div>
          ${previewStage('style')}</div>
        <h3>Style</h3>
        <div class="row"><span>Cards</span>${opt('cards', [['sticky', 'Sticky', 'Tinted sticky notes, slightly tilted'], ['clean', 'Clean', 'Flat cards with a type marker']])}</div>
        <div class="row"><span>Decoration</span>${opt('tape', [['tape', 'Tape', 'A strip of tape on sticky notes'], ['pin', 'Pin', 'A push-pin at the top'], ['clip', 'Clip', 'A binder clip on the edge'], ['corner', 'Fold', 'A folded top corner'], ['none', 'None', 'No decoration']])}</div>
        <div class="row"><span>Needs you</span>${opt('attn', [['orbit', 'Orbit', 'Spinning ring and a bouncing badge'], ['glow', 'Glow', 'A soft breathing halo'], ['bar', 'Bar', 'Accent edge and tint — calm'], ['outline', 'Outline', 'A solid outline and small badge'], ['ribbon', 'Ribbon', 'A bookmark tab on the card']])}</div>
        <div class="row"><span>Opening</span>${opt('enter', [['rise', 'Rise', 'Fades in with a small lift'], ['sheet', 'Sheet', 'Slides in from the right as a side panel'], ['fade', 'Fade', 'A quick cross-fade'], ['pop', 'Pop', 'Snaps in with a little bounce'], ['zoom', 'Zoom', 'Grows out of the ticket']])}</div>
        <div class="row"><span>Columns</span>${opt('lanes', [['glass', 'Glass', 'Translucent panels'], ['solid', 'Solid', 'Opaque panels'], ['outline', 'Outline', 'Bordered, see-through'], ['lane', 'Lanes', 'No panels — dividers between lanes']])}</div>
        <div class="row"><span>Texture</span>${opt('texture', [['on', 'On', 'Film grain and dotted board'], ['off', 'Off', 'Plain surfaces']])}</div>
        <div class="row"><span>Density</span>${seg('density', [['cozy', 'Cozy'], ['compact', 'Compact']], settings.density)}</div>
        <div class="row"><span>Motion</span>${seg('motion', [['full', 'Full'], ['reduced', 'Reduced']], settings.motion)}</div>
        <div class="row"><span>Column width</span><input type="range" min="240" max="440" step="10" value="${settings.colw}" data-range="colw"></div>
        <h3>Background</h3><div class="tiles">${bgs}</div>`;
    }
    if (t === 'cards') {
      return `<div class="look-sticky">${previewStage('cards')}</div><h3>Show on card</h3><div class="chips-grid">${STUB_FIELDS.map(([k, label, ic]) => `<button class="toggle-chip ${settings.stub[k] ? 'on' : ''}" data-stub="${k}" title="${label}|${STUB_TIPS[k] || ''}">${icon(ic)}${label}</button>`).join('')}</div>`;
    }
    if (t === 'board') {
      const me = state.profiles[settings.userName] || {};
      return `<h3>Parent groups</h3>
        <div class="row"><span>Grouping</span>${seg('grouping', [['off', 'Off', 'Show every ticket separately'], ['list', 'List', 'Group tickets sharing a parent under a heading'], ['stack', 'Stack', 'Pile tickets sharing a parent — click to fan out']], settings.grouping)}</div>
        ${previewStage('grouping')}
        <h3>Ticket edits</h3>
        <div class="row"><span>Apply changes</span>${seg('saveMode', [['accept', 'Save button', 'Edits wait until you press Save'], ['instant', 'Instant', 'Every change applies immediately']], settings.saveMode)}</div>
        <h3>Ageing</h3>
        <div class="row"><span>Fade untouched tickets after</span>${seg('ageDays', [['0', 'Off', 'Never fade tickets'], ['3', '3d', 'Fully faded after 3 idle days'], ['7', '7d', 'Fully faded after a week'], ['14', '14d', 'Fully faded after two weeks']], String(settings.ageDays))}</div>
        <h3>You</h3>
        <div class="row"><span>Name</span>${avatar({ kind: 'user', name: settings.userName }, 'lg')}<input class="inp" data-text="userName" value="${esc(settings.userName)}" style="max-width:200px"></div>
        <div class="row"><span>Colour</span><div class="swatches">${SWATCHES.map((c) => `<button class="swatch ${me.color === c ? 'on' : ''}" data-ucolor="${c}" style="--c:${c}"></button>`).join('')}<button class="swatch none ${me.color ? '' : 'on'}" data-ucolor="" title="Automatic">${icon('x', 'sm')}</button></div></div>
        <div class="row"><span>Glyph</span><input class="inp" data-uglyph value="${esc(me.glyph || '')}" placeholder="${esc(initials(settings.userName))}" maxlength="4" style="max-width:80px;text-align:center"></div>`;
    }
    if (t === 'fields') return fieldsPane();
    if (t === 'notify') {
      const perm = 'Notification' in window ? Notification.permission : 'unsupported';
      return `<h3>Alerts</h3>
        <div class="row"><span>Toasts</span>${sw('toasts', settings.toasts)}</div>
        <div class="row"><span>Sound</span>${sw('sound', settings.sound)}</div>
        <div class="row"><span>Desktop notifications</span>${perm === 'denied' ? '<span class="chip blocked">blocked</span>' : sw('notify', settings.notify && perm === 'granted')}</div>
        <div class="row"><span>Only when hidden</span>${sw('notifyHidden', settings.notifyHidden)}</div>`;
    }
    return `<h3>${esc(state.app.name)}</h3><div class="about-grid">
        <span>Version</span><code>${esc(state.app.version)}</code>
        <span>Build</span><code>${esc(state.app.build)}</code>
        <span>Board</span><code>${esc(state.boardId)}</code>
        <span>Hash</span><code>${esc(state.hash)}</code>
        <span>API</span><code>${esc(location.origin)}/api</code></div>
      <h3>Agents</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-copy>${icon('copy')}Copy agent prompt</button><a class="btn" href="/api/docs" target="_blank" rel="noopener">${icon('ext')}Docs</a></div>
      <pre class="md" style="margin-top:12px"><code>${esc(agentPrompt())}</code></pre>`;
  }

  const SWATCHES = ['#8b7bff', '#5aa9e6', '#2fe0c4', '#3ddc97', '#ffc857', '#ffb454', '#ff6b8b', '#ff5fa2', '#b07cf2', '#a3adc2'];
  const UI_LABEL = { edit: ['Edit', 'Humans can edit'], read: ['Read', 'Humans see it; only agents/API can change it'], hidden: ['Hidden', 'API only'] };
  const uiSeg = (val) => `<div class="seg mini" data-uiseg>${Object.entries(UI_LABEL).map(([v, [l, tip]]) => `<button class="${v === val ? 'on' : ''}" data-v="${v}" title="${tip}">${l}</button>`).join('')}</div>`;
  const BUILTIN_ROWS = [['type', 'layers'], ['priority', 'flag'], ['parent', 'hash'], ['description', 'text'], ['blockedBy', 'lock'], ['attachments', 'clip'], ['cover', 'image'], ['assignee', 'user'], ['properties', 'braces']];

  // Schema editor: built-in field config + the board's custom typed fields.
  function fieldsPane() {
    const sc = schema();
    const bis = BUILTIN_ROWS.map(([k, ic]) => {
      const c = bi(k);
      return `<div class="srow" data-bi="${k}"><span class="ficon">${icon(ic)}</span><input class="inp lab" data-bilabel value="${esc(c.label)}">${uiSeg(c.ui)}<button class="switch ${c.stub ? 'on' : ''}" data-bistub title="Show on card|Display this field on the ticket stub"></button></div>`;
    }).join('');
    const customs = sc.fields.map((f) => {
      const opts = f.type === 'enum' || f.type === 'tags'
        ? `<div class="opts">${(f.options || []).map((o) => `<span class="tagchip" style="--fc:${esc(o.color || 'var(--accent)')}"><button class="sw-btn" data-ocolor="${esc(o.value)}" style="--c:${esc(o.color || 'var(--accent)')}" title="Colour"></button>${esc(o.value)}<button class="x" data-orm="${esc(o.value)}">${icon('x', 'sm')}</button></span>`).join('')}<input class="inp opt-add" data-oadd placeholder="+ option"></div>` : '';
      const nums = f.type === 'number'
        ? `<div class="srow sub"><span class="mini-lbl">min</span><input class="inp num" type="number" data-fmin value="${f.min ?? ''}"><span class="mini-lbl">max</span><input class="inp num" type="number" data-fmax value="${f.max ?? ''}"></div>` : '';
      return `<div class="fcard" data-key="${esc(f.key)}">
        <div class="srow"><span class="ficon">${icon(ICONS[f.icon] ? f.icon : FIELD_ICON[f.type])}</span><input class="inp lab" data-flabel value="${esc(f.label)}"><code class="fkey">${esc(f.key)}</code><button class="dd tiny" data-ftype>${esc(f.type)}${icon('chev', 'sm')}</button><button class="icon-x" data-fdel title="Remove">${icon('x', 'sm')}</button></div>
        <div class="srow sub">${uiSeg(f.ui)}<div class="seg mini" data-stubseg>${[['none', 'Off'], ['top', 'Top'], ['meta', 'Footer']].map(([v, l]) => `<button class="${v === f.stub ? 'on' : ''}" data-v="${v}" title="On card: ${l}">${icon('card', 'sm')}${l}</button>`).join('')}</div></div>
        ${opts}${nums}</div>`;
    }).join('');
    return `<h3>${esc(state.board?.name || '')} · built-in</h3><div class="bi-list">${bis}</div>
      <h3>Custom</h3>${customs || ''}
      <div class="fadd"><input class="inp" data-newlabel placeholder="New field"><button class="dd tiny" data-newtype data-type="text">text${icon('chev', 'sm')}</button><button class="btn primary sm" data-newadd>${icon('plus', 'sm')}Add</button></div>`;
  }

  async function schemaCall(method, path, body, undo) {
    try { await api(method, B(`/schema${path}`), body); pulseSaved(); scheduleRefresh(0); if (undo) toast(undo.msg, { icon: 'layers', action: 'Undo', onAction: undo.run }); }
    catch (e) { toast(e.message, { kind: 'error' }); state.modal?.refresh(); }
  }
  const fieldKey = (label) => { let k = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 38); if (!/^[a-z]/.test(k)) k = `f-${k}`; return k; };

  function wireFields(pane) {
    pane.addEventListener('click', (e) => {
      const card = e.target.closest('.fcard');
      const row = e.target.closest('[data-bi]');
      const key = card?.dataset.key;
      const f = key && schema().fields.find((x) => x.key === key);
      const segHit = e.target.closest('[data-uiseg] button, [data-stubseg] button');
      if (segHit) segHit.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === segHit));
      const uiBtn = e.target.closest('[data-uiseg] button');
      if (uiBtn) {
        if (row) schemaCall('PUT', '', { builtins: { [row.dataset.bi]: { ui: uiBtn.dataset.v } } });
        else if (f) schemaCall('PATCH', `/fields/${encodeURIComponent(key)}`, { ui: uiBtn.dataset.v });
        return;
      }
      const stubBtn = e.target.closest('[data-stubseg] button');
      if (stubBtn && f) { schemaCall('PATCH', `/fields/${encodeURIComponent(key)}`, { stub: stubBtn.dataset.v }); return; }
      const sw = e.target.closest('[data-bistub]');
      if (sw && row) { sw.classList.toggle('on'); schemaCall('PUT', '', { builtins: { [row.dataset.bi]: { stub: sw.classList.contains('on') } } }); return; }
      if (e.target.closest('[data-fdel]') && f) { schemaCall('DELETE', `/fields/${encodeURIComponent(key)}`, undefined, { msg: `Removed ${f.label}`, run: () => schemaCall('POST', '/fields', f) }); return; }
      const rm = e.target.closest('[data-orm]');
      if (rm && f) { schemaCall('PATCH', `/fields/${encodeURIComponent(key)}`, { options: f.options.filter((o) => o.value !== rm.dataset.orm) }); return; }
      const oc = e.target.closest('[data-ocolor]');
      if (oc && f) {
        menu(oc, SWATCHES.map((c) => ({ label: c, color: c, run: () => schemaCall('PATCH', `/fields/${encodeURIComponent(key)}`, { options: f.options.map((o) => (o.value === oc.dataset.ocolor ? { ...o, color: c } : o)) }) })));
        return;
      }
      const ft = e.target.closest('[data-ftype]');
      if (ft && f) {
        menu(ft, Object.keys(FIELD_ICON).map((t) => ({ label: t, icon: FIELD_ICON[t], cls: t === f.type ? 'on' : '',
          run: () => schemaCall('PATCH', `/fields/${encodeURIComponent(key)}`, { type: t, ...((t === 'enum' || t === 'tags') && !f.options?.length ? { options: t === 'enum' ? ['Option'] : [] } : {}) }) })));
        return;
      }
      const nt = e.target.closest('[data-newtype]');
      if (nt) {
        menu(nt, Object.keys(FIELD_ICON).map((t) => ({ label: t, icon: FIELD_ICON[t], cls: t === nt.dataset.type ? 'on' : '', run: () => { nt.dataset.type = t; nt.innerHTML = `${t}${icon('chev', 'sm')}`; } })));
        return;
      }
      if (e.target.closest('[data-newadd]')) addField(pane);
    });
    pane.addEventListener('change', (e) => {
      const t = e.target;
      const row = t.closest('[data-bi]');
      const key = t.closest('.fcard')?.dataset.key;
      if (t.matches('[data-bilabel]') && row) schemaCall('PUT', '', { builtins: { [row.dataset.bi]: { label: t.value.trim() } } });
      if (t.matches('[data-flabel]') && key && t.value.trim()) schemaCall('PATCH', `/fields/${encodeURIComponent(key)}`, { label: t.value.trim() });
      if (t.matches('[data-fmin], [data-fmax]') && key) schemaCall('PATCH', `/fields/${encodeURIComponent(key)}`, { [t.matches('[data-fmin]') ? 'min' : 'max']: t.value === '' ? null : Number(t.value) });
    });
    pane.addEventListener('keydown', (e) => {
      const t = e.target;
      if (e.key !== 'Enter') return;
      if (t.matches('[data-oadd]')) {
        const key = t.closest('.fcard').dataset.key;
        const f = schema().fields.find((x) => x.key === key);
        const v = t.value.trim();
        if (!v || f.options?.some((o) => o.value.toLowerCase() === v.toLowerCase())) return;
        const color = SWATCHES[(f.options?.length || 0) % SWATCHES.length];
        t.value = '';
        schemaCall('PATCH', `/fields/${encodeURIComponent(key)}`, { options: [...(f.options || []), { value: v, color }] });
        setTimeout(() => $(`.fcard[data-key="${CSS.escape(key)}"] [data-oadd]`, pane)?.focus(), 400);
      } else if (t.matches('[data-newlabel]')) addField(pane);
      else if (t.matches('input.inp')) t.blur();
    });
  }

  function addField(pane) {
    const input = $('[data-newlabel]', pane);
    const label = input.value.trim();
    if (!label) { input.focus(); return; }
    const type = $('[data-newtype]', pane).dataset.type;
    schemaCall('POST', '/fields', { key: fieldKey(label), label, type, stub: 'none', ...(type === 'enum' ? { options: ['Option'] } : {}) });
    input.value = '';
  }

  function agentPrompt() {
    return `Use the ${state.app.name} kanban at ${location.origin} (board "${state.boardId}") to coordinate work with me.\n`
      + `First read ${location.origin}/api/docs and follow it. Send the header "X-Agent: <your-name>" on every request.`;
  }

  function wirePane(t, pane, show) {
    if (t === 'fields' && !pane._fieldsWired) { pane._fieldsWired = true; wireFields(pane); }
    pane.onclick = async (e) => {
      const uc = e.target.closest('[data-ucolor]');
      if (uc) { try { await api('PATCH', '/api/profiles/me', { color: uc.dataset.ucolor || null }); pulseSaved(); } catch (err) { toast(err.message, { kind: 'error' }); } return; }
      const nav = e.target.closest('[data-car]');
      if (nav) {
        const track = $('.car-track', pane);
        track.style.scrollBehavior = 'auto';
        track.scrollBy({ left: Number(nav.dataset.car) * track.clientWidth * 0.8, behavior: reduced() ? 'auto' : 'smooth' });
        return;
      }
      const th = e.target.closest("[data-pick-theme]");
      if (th) { switchTheme(th.dataset.pickTheme, e.clientX, e.clientY); setTimeout(() => show('look', true), 30); return; }
      const bg = e.target.closest('[data-bgfx]');
      if (bg) { settings.bg = bg.dataset.bgfx; saveSettings(); show('look', true); return; }
      const sb = e.target.closest('.seg[data-set] button');
      if (sb) { settings[sb.parentElement.dataset.set] = sb.dataset.v; saveSettings(); pulseSaved(); show(t, true); return; }
      const s = e.target.closest('[data-sw]');
      if (s) {
        const k = s.dataset.sw;
        if (k === 'notify' && !settings.notify && 'Notification' in window && Notification.permission !== 'granted') {
          if (await Notification.requestPermission() !== 'granted') { show(t); return; }
        }
        settings[k] = !settings[k];
        saveSettings(); pulseSaved(); show(t);
        if (k === 'sound' && settings.sound) blip(false);
        return;
      }
      const st = e.target.closest('[data-stub]');
      if (st) { settings.stub[st.dataset.stub] = !settings.stub[st.dataset.stub]; saveSettings(); pulseSaved(); show(t, true); return; }
      if (e.target.closest('[data-copy]')) { navigator.clipboard?.writeText(agentPrompt()); toast('Copied', { icon: 'copy', kind: 'ok', timeout: 1500 }); }
    };
    pane.oninput = (e) => {
      const r = e.target.dataset.range;
      if (r) { paintRange(e.target); settings[r] = Number(e.target.value); applySettings(); updateOverflow(); }
    };
    pane.onchange = (e) => {
      if (e.target.dataset.range) { saveSettings(); pulseSaved(); }
      const k = e.target.dataset.text;
      if (k) { settings[k] = e.target.value.trim() || DEFAULTS[k]; saveSettings(); pulseSaved(); show(t, true); if (k === 'userName') refreshInbox(); }
      if (e.target.matches('[data-uglyph]')) api('PATCH', '/api/profiles/me', { glyph: e.target.value.trim() || null }).then(pulseSaved, (err) => toast(err.message, { kind: 'error' }));
    };
  }

  /* ═════════════════════════ tooltips ═════════════════════════ */
  // One themed tooltip for the whole app. Any element with title="Title|Explanation" (or data-tip) gets it:
  // the native title is moved aside on hover so the browser's own tooltip never appears.
  const tip = el('<div class="tip" role="tooltip"></div>');
  let tipTimer = null;
  let tipFor = null;
  let warmUntil = 0;
  function hideTip() {
    clearTimeout(tipTimer);
    if (tip.classList.contains('show')) warmUntil = Date.now() + 450;
    tip.classList.remove('show');
    tipFor = null;
  }
  function showTip(t) {
    if (!t.isConnected || drag || !t.dataset.tip) return;
    const [title, desc] = t.dataset.tip.split('|');
    tip.innerHTML = desc ? `<b>${esc(title)}</b><span>${esc(desc)}</span>` : `<b>${esc(title)}</b>`;
    tip.style.left = '0px';
    tip.style.top = '0px';
    const r = t.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let top = r.top - tr.height - 9;
    let place = 'top';
    if (top < 8) { top = r.bottom + 9; place = 'bottom'; }
    const left = clamp(r.left + r.width / 2 - tr.width / 2, 8, innerWidth - tr.width - 8);
    Object.assign(tip.style, { left: `${left}px`, top: `${top}px` });
    tip.style.setProperty('--ax', `${clamp(r.left + r.width / 2 - left, 12, tr.width - 12)}px`);
    tip.dataset.place = place;
    tip.classList.add('show');
  }
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest?.('[title], [data-tip]');
    if (!t || t === tipFor) return;
    if (t.hasAttribute('title')) { const v = t.getAttribute('title'); if (v) t.dataset.tip = v; t.removeAttribute('title'); }
    if (!t.dataset.tip) return;
    hideTip();
    tipFor = t;
    tipTimer = setTimeout(() => showTip(t), Date.now() < warmUntil ? 40 : 550);
  }, true);
  document.addEventListener('pointerout', (e) => { if (tipFor && !tipFor.contains(e.relatedTarget)) hideTip(); }, true);
  for (const ev of ['pointerdown', 'keydown', 'wheel']) addEventListener(ev, hideTip, true);
  addEventListener('scroll', hideTip, true);

  /* ═════════════════════════ keyboard + boot ═════════════════════════ */

  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input, textarea, select, [contenteditable]');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); togglePalette(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && state.modal?.kind === 'item') {
      e.preventDefault();
      if (document.activeElement?.matches('input, textarea')) document.activeElement.blur(); // commit the field being typed in
      setTimeout(() => saveDraft(state.modal), 0);
      return;
    }
    if (e.key === 'Escape') {
      if ($('.menu')) { closeMenus(); return; }
      if ($('.palette-scrim')) { closePalette(); return; }
      if ($('.lightbox')) { $('.lightbox').remove(); return; }
      if (state.modal) { if (typing) e.target.blur(); closeModal(); return; }
      if ($('.drawer.open')) { closeDrawers(); return; }
      if (state.bulk) { setBulk(false); return; }
      if (state.query) { $('#search').value = ''; state.query = ''; applyFilter(); $('#search').blur(); }
      return;
    }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
    const m = state.modal;
    if (m?.kind === 'item' && m.rail && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const ids = needsIds();
      const i = ids.indexOf(m.id);
      const n = ids[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, ids.length - 1)];
      if (n && n !== m.id) { e.preventDefault(); m.switchTo(n); }
    }
  });

  addEventListener('hashchange', () => {
    const id = location.hash.replace(/^#\/?/, '');
    if (id && id !== state.boardId) { closeModal(true); loadBoard(id).catch((e) => toast(e.message, { kind: 'error' })); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { saveSeen(); return; }
    scheduleRefresh(0);
    renderCatch();
    if (state.boardId) { seenFor(state.boardId).seq = state.seq; saveSeen(); }
  });
  addEventListener('beforeunload', saveSeen);

  async function boot() {
    document.body.append(tip);
    applySettings();
    buildChrome();
    try {
      Object.assign(state.app, await api('GET', '/api/app'));
      try { state.profiles = await api('GET', '/api/profiles'); } catch { /* none yet */ }
      await refreshBoards();
      const id = location.hash.replace(/^#\/?/, '') || state.app.defaultBoard || state.boards[0]?.id;
      await loadBoard(id);
    } catch (e) {
      toast(`Can't reach the server · ${e.message}`, { kind: 'error', timeout: 10000 });
    }
    connect();
    refreshPresence();
    setInterval(() => { tickRings(); tickModal(); }, 1000);
    setInterval(fallbackPoll, 5000);
    setInterval(refreshPresence, 20000);
    setInterval(refreshListeners, 15000);
    refreshInbox();
  }
  boot();
})();
