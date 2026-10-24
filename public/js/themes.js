// Palette colours are #rgb or #rrggbb. WCAG relative luminance and contrast ratio, and a plain sRGB mix (p = share of y).
const rgb = (h) => (h.length === 4 ? [...h.slice(1)].map((c) => c + c) : [h.slice(1, 3), h.slice(3, 5), h.slice(5, 7)]).map((x) => parseInt(x, 16));
const luminance = (h) => rgb(h).map((c) => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
export const contrast = (x, y) => { const [a, b] = [luminance(x), luminance(y)].sort((m, n) => n - m); return (a + 0.05) / (b + 0.05); };
export const oklab = (h) => {
  const [r, g, b] = rgb(h).map((c) => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [l, m, s] = [0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b].map(Math.cbrt);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const fromOklab = ([L, a, b]) => {
  const [l, m, s] = [L + 0.3963377774 * a + 0.2158037573 * b, L - 0.1055613458 * a - 0.0638541728 * b, L - 0.0894841775 * a - 1.291485548 * b].map((c) => c ** 3);
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${lin.map((c) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055))).toString(16).padStart(2, '0')).join('')}`;
};
// color-mix(in oklab, x p, y), as CSS does it
const mixOklab = (x, p, y) => fromOklab(oklab(x).map((c, i) => c * p + oklab(y)[i] * (1 - p)));
const mixHex = (x, y, p) => `#${rgb(x).map((c, i) => Math.round(c + (rgb(y)[i] - c) * p).toString(16).padStart(2, '0')).join('')}`;
const T = (label, mode, c, style = {}, css = '') => ({
  label, mode, style, css, glow: !!style.glow,
  vars: {
    bg: c[0], panel: c[1], surface: c[2], text: c[3], muted: c[4], border: c[5], accent: c[6], 'accent-2': c[7],
    issue: c[8], task: c[9], spike: c[10], ok: c[11], warn: c[12], danger: c[13], blob1: c[14], blob2: c[15], blob3: c[16],
    shadow: mode === 'dark' ? 'rgb(0 0 0 / .6)' : 'rgb(60 45 30 / .22)', 'fx-o': mode === 'dark' ? '.34' : '.5', grain: mode === 'dark' ? '.07' : '.09',
    // set on every theme, so switching away from one that changes them never leaves them behind
    'on-accent': '#fff', 'accent-fill': c[6],
  },
});
// The Bauhaus family shares one geometry: a column wears a thick rule on top. `rule` is the rule's
// thickness; `extra` is the variant's own CSS (it comes last, so it wins).
const bauhausCss = (rule, extra = '') => `.card::before { display: none; } .column { border-top: ${rule}px solid var(--col); } .col-name { font-weight: 900; letter-spacing: .06em; } .app-name { background: none; color: var(--text); -webkit-text-fill-color: currentColor; font-weight: 900; } ${extra}`;
// The poster look (Bauhaus, Bauhaus Night) and the quieter studio look (thin borders, small shapes, no offset shadow).
const BAUHAUS_POSTER = { md: 'grid', card: 0, col: 0, modal: 0, ctl: 20, bw: 2, shadow: 'hard', cards: 'clean', typeInd: 'top', tape: 'none', attn: 'ribbon', enter: 'pop', lanes: 'solid', chips: 'pill', heads: 'caps', bg: 'none', texture: true, avatar: 'round', titleW: 700, font: "'Archivo'", display: "'Archivo'" };
const BAUHAUS_STUDIO = { md: 'grid', card: 2, col: 2, modal: 4, ctl: 4, bw: 1, shadow: 'flat', cards: 'clean', typeInd: 'top', tape: 'none', attn: 'bar', enter: 'fade', lanes: 'solid', chips: 'tag', heads: 'caps', bg: 'none', texture: false, avatar: 'square', titleW: 600, font: "'Inter'", display: "'Archivo'", colAlpha: 100 };
const STUDIO_CSS = '.col-name { font-weight: 700; letter-spacing: .1em; font-size: 12px; } .c-title { font-size: 14px; } .app-name { font-weight: 700; letter-spacing: -.01em; }';
// Clear: thin lines, no shadows or motion to speak of, sentence-case headings. The type shows as a line on top and
// "needs you" as a bar on the left, so the two never compete for one place. Links are underlined at full strength,
// every control shows a focus ring, and form fields get an edge of 3:1 so they can be found.
const CLEAR_STYLE = { card: 6, col: 10, modal: 12, ctl: 6, bw: 1, shadow: 'flat', cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'bar', enter: 'fade', lanes: 'solid', chips: 'tag', heads: 'normal', bg: 'none', texture: false, avatar: 'round', titleW: 500, font: "'Inter'", display: "'Inter'", colAlpha: 100 };
const CLEAR_CSS = '.c-title { font-size: 14px; line-height: 1.45; } .col-name { font-weight: 600; } .app-name { background: none; color: var(--text); -webkit-text-fill-color: currentColor; font-weight: 700; }'
  + ' .md a { border-bottom-color: currentColor; }'
  + ' :is(button, a, summary, [tabindex]):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }'
  + ' :is(.inp, textarea, .dd) { border-color: color-mix(in oklab, var(--muted) 70%, var(--border)); }';
export const THEMES = {
  // The first look, now one theme among many: its key stays, so a saved pick still finds it.
  intellagent: T('Amethyst', 'dark', ['#0d0e1a', '#161829', '#1d2035', '#eceefe', '#8e93b8', '#2b2f4a', '#8b7bff', '#2fe0c4', '#ff6b8b', '#6aa8ff', '#ffc857', '#3ddc97', '#ffb454', '#ff5d73', '#7b5cff', '#00d4b0', '#ff5fa2']),
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
    { md: 'paper', card: 6, col: 12, modal: 14, ctl: 6, cards: 'clean', tape: 'none', shadow: 'flat', attn: 'bar', enter: 'fade', lanes: 'solid', bg: 'none' }),
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
  // Clear (INT-451): calm and legible. Neutral greys, one blue for what you can act on, violet only for what
  // needs you; text 12:1 or more, secondary text 5.9:1 or more on every surface. Type and status colours were
  // picked to stay apart under protan, deutan and tritan vision, and each also has its own shape or place.
  clear: T('Clear', 'light', ['#f6f7f9', '#eef0f3', '#ffffff', '#16191f', '#555c68', '#ccd1d8', '#3a64ae', '#674fa7', '#a54b6e', '#3a64ae', '#856635', '#397582', '#896535', '#9e3b4a', '#a5b8e0', '#c1b5dd', '#accdd3'],
    CLEAR_STYLE, CLEAR_CSS),
  'clear-dark': T('Clear Dark', 'dark', ['#15171b', '#1b1e23', '#22262c', '#e7e9ed', '#a5abb6', '#3a404b', '#89a9e6', '#b2a3e8', '#de8aa6', '#89a9e6', '#d7b475', '#75becb', '#e3bd7d', '#e57682', '#475c87', '#5a4f7f', '#446c72'],
    CLEAR_STYLE, CLEAR_CSS),
  paper: T('Paper', 'light', ['#f3efe6', '#ece6d9', '#fbf8f2', '#2b2a26', '#7b756a', '#d9d1c0', '#b4532a', '#2f6f62', '#b4362a', '#2f5d8a', '#b98a1b', '#3d7a4a', '#c06a2b', '#b4362a', '#e8d9bd', '#d9e4d6', '#efd3c8'],
    { md: 'paper', card: 2, col: 4, modal: 6, ctl: 4, shadow: 'flat', tape: 'none', cards: 'clean', typeInd: 'top', attn: 'ribbon', enter: 'fade', lanes: 'lane', chips: 'outline', heads: 'caps', bg: 'doodles', display: "'Fraunces', serif", colAlpha: 90 },
    '.c-title { font-family: var(--display); font-size: 15.5px; } .board { background-image: repeating-linear-gradient(transparent 0 27px, color-mix(in oklab, var(--accent-2) 9%, transparent) 27px 28px); background-size: auto; } .col-name { font-style: italic; }'),
  brutalist: T('Brutalist', 'light', ['#f4f1ea', '#ffffff', '#ffffff', '#111111', '#555555', '#111111', '#ff4d00', '#0047ff', '#ff2e2e', '#0047ff', '#ffcc00', '#00a651', '#ff8a00', '#ff2e2e', '#ffcc00', '#0047ff', '#ff4d00'],
    { md: 'grid', card: 0, col: 0, modal: 0, ctl: 0, bw: 2, shadow: 'hard', tape: 'none', cards: 'clean', typeInd: 'top', attn: 'outline', enter: 'pop', lanes: 'solid', chips: 'tag', heads: 'caps', bg: 'none', texture: false, avatar: 'square', titleW: 700, font: "'Space Grotesk'", display: "'Space Grotesk'", colAlpha: 100 },
    '.c-title { font-size: 15px; } .app-name { background: none; color: var(--text); -webkit-text-fill-color: currentColor; } .btn.primary { background: var(--accent-fill); border: 2px solid var(--text); box-shadow: 3px 3px 0 var(--text); } .pill-btn:hover { translate: -2px -2px; box-shadow: 3px 3px 0 var(--text); }'),
  cork: T('Corkboard', 'light', ['#c9a77c', '#b8946a', '#fff8d2', '#2b2014', '#6b5537', '#9c7a52', '#c0392b', '#2e86ab', '#ff9aa2', '#7fb7e6', '#f4d35e', '#4c9a2a', '#d9822b', '#c0392b', '#e0c39a', '#b88e5f', '#d8b38a'],
    { md: 'paper', card: 2, col: 16, modal: 18, ctl: 10, tape: 'pin', cards: 'sticky', attn: 'ribbon', bg: 'none', avatar: 'round', colAlpha: 55, grain: '.22' },
    ".c-title { font-family: 'Caveat', cursive; font-size: 20px; line-height: 1.1; font-weight: 600; }"),
  blueprint: T('Blueprint', 'dark', ['#0b2545', '#0f2f57', '#13396a', '#e8f1ff', '#8fb3e0', '#2f5d93', '#7cc4ff', '#ffd166', '#ff8fa3', '#7cc4ff', '#ffd166', '#8ef0b0', '#ffb86b', '#ff8fa3', '#1d4e89', '#2b6cb0', '#0b3d73'],
    { md: 'terminal', card: 3, col: 6, modal: 8, ctl: 4, shadow: 'flat', tape: 'clip', cards: 'clean', typeInd: 'dot', attn: 'outline', enter: 'fade', lanes: 'outline', chips: 'outline', heads: 'caps', bg: 'none', texture: false, display: "'JetBrains Mono', monospace" },
    '.board { background-image: linear-gradient(color-mix(in oklab, var(--text) 8%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in oklab, var(--text) 8%, transparent) 1px, transparent 1px); background-size: 24px 24px; } .column, .card { border-style: dashed; } .c-title { text-transform: uppercase; font-size: 12.5px; letter-spacing: .04em; }'),
  vision: T('Vision', 'light', ['#e9eef8', '#ffffff', '#ffffff', '#0f1222', '#5b6380', '#d9e0ee', '#5b5bf6', '#0ea5e9', '#f43f5e', '#3b82f6', '#f59e0b', '#10b981', '#f97316', '#ef4444', '#a78bfa', '#67e8f9', '#f9a8d4'],
    { card: 18, col: 28, modal: 30, ctl: 14, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'glow', enter: 'rise', lanes: 'glass', bg: 'mesh', texture: false, avatar: 'round', colAlpha: 45 },
    '.column { background: linear-gradient(180deg, rgb(255 255 255 / .6), rgb(255 255 255 / .28)); border: 1px solid rgb(255 255 255 / .75); box-shadow: 0 1px 0 rgb(255 255 255 / .9) inset, 0 30px 60px -30px rgb(30 40 90 / .35); } .card { background: rgb(255 255 255 / .8); border-color: rgb(255 255 255 / .95); box-shadow: 0 1px 0 #fff inset, 0 12px 30px -14px rgb(30 40 90 / .32); } .modal, .drawer, .menu { background: rgb(255 255 255 / .93); } .pill-btn, .search input { background: rgb(255 255 255 / .62); border-color: rgb(255 255 255 / .85); } .app-name { background: linear-gradient(90deg, #5b5bf6, #0ea5e9); -webkit-background-clip: text; background-clip: text; }'),
  phosphor: T('Phosphor', 'dark', ['#050805', '#081008', '#0b160b', '#b8ffb0', '#5f9a5a', '#1d3a1c', '#39ff14', '#a3ff7a', '#ff5f5f', '#39ff14', '#ffd84d', '#39ff14', '#ffb000', '#ff4040', '#0f3d0f', '#123a12', '#0a2a0a'],
    { md: 'terminal', card: 0, col: 0, modal: 0, ctl: 0, shadow: 'flat', cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'outline', enter: 'fade', lanes: 'outline', chips: 'outline', heads: 'caps', bg: 'none', texture: false, avatar: 'square', avatars: 'accent', colColor: 'accent', titleW: 400, font: "'JetBrains Mono', monospace", display: "'VT323', monospace" },
    'body::after { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 1000; background: repeating-linear-gradient(0deg, rgb(0 0 0 / .22) 0 1px, transparent 1px 3px); } .board { background-image: radial-gradient(ellipse at 50% 40%, rgb(57 255 20 / .07), transparent 70%); } .c-title, .col-name, .app-name { text-shadow: 0 0 6px color-mix(in oklab, var(--accent) 65%, transparent); } .c-title { font-family: var(--display); font-size: 20px; line-height: 1.05; letter-spacing: .02em; } .col-name { font-family: var(--display); font-size: 19px; letter-spacing: .04em; } .app-name { background: none; color: var(--accent); -webkit-text-fill-color: currentColor; font-family: var(--display); font-size: 23px; } .card:hover .c-title::after { content: "_"; animation: breathe 1s steps(1) infinite; }'),
  swiss: T('Swiss', 'light', ['#f2f2ee', '#f2f2ee', '#ffffff', '#111111', '#6b6b6b', '#111111', '#e3000f', '#e3000f', '#e3000f', '#111111', '#ffb800', '#00875a', '#ff6b00', '#e3000f', '#f2f2ee', '#f2f2ee', '#f2f2ee'],
    { md: 'grid', card: 0, col: 0, modal: 0, ctl: 0, shadow: 'flat', cards: 'clean', typeInd: 'top', tape: 'none', attn: 'bar', enter: 'fade', lanes: 'lane', chips: 'tag', bg: 'none', texture: false, avatar: 'square', avatars: 'ink', colColor: 'ink', titleW: 700, font: "'Inter'", display: "'Inter'", colAlpha: 100 },
    '.col-head { border-bottom: 3px solid var(--text) !important; align-items: flex-end; } .col-name { font-size: 30px; font-weight: 800; letter-spacing: -.045em; text-transform: lowercase; line-height: 1; } .col-count { background: none; padding: 0; font: 300 30px/1 var(--display); letter-spacing: -.04em; color: var(--accent); } .col-dot, .col-icon { display: none; } .card { background: transparent; border-width: 0 0 1px; border-color: var(--text); border-radius: 0; box-shadow: none; padding: 12px 0 11px; } .card::before { display: none; } .card:hover { background: rgb(0 0 0 / .03); } .c-title { font-size: 15.5px; letter-spacing: -.02em; } .app-name { background: none; color: var(--text); -webkit-text-fill-color: currentColor; font-weight: 800; letter-spacing: -.045em; font-size: 22px; } .logo { filter: grayscale(1) contrast(1.6); }'),
  bauhaus: T('Bauhaus', 'light', ['#f1ebdd', '#e8e0cd', '#fbf7ee', '#1a1a1a', '#6a645a', '#1a1a1a', '#d6312a', '#1f4fa3', '#d6312a', '#1f4fa3', '#f2b705', '#2e7d32', '#e8701a', '#d6312a', '#d6312a', '#1f4fa3', '#f2b705'],
    { ...BAUHAUS_POSTER }, bauhausCss(10)),
  // The same poster at night: primaries on warm black, cream ink.
  'bauhaus-night': T('Bauhaus Night', 'dark', ['#14130f', '#1c1b16', '#23211b', '#f1ebdd', '#9a9384', '#d9d1bf', '#e8443a', '#3d6fd6', '#e8443a', '#3d6fd6', '#f5c518', '#43a047', '#ef8a2a', '#e8443a', '#e8443a', '#3d6fd6', '#f5c518'],
    { ...BAUHAUS_POSTER, texture: false }, bauhausCss(10)),
  // Black on paper with one red: the shapes alone tell the types apart.
  'bauhaus-mono': T('Bauhaus Mono', 'light', ['#ecebe7', '#e2e1dc', '#f8f8f6', '#151515', '#6b6b6b', '#151515', '#c8281e', '#151515', '#151515', '#151515', '#151515', '#3d3d3d', '#6b6b6b', '#c8281e', '#151515', '#6b6b6b', '#b5b5b5'],
    { ...BAUHAUS_POSTER, avatars: 'ink', colColor: 'ink' }, bauhausCss(10, '.btn.primary { background: var(--accent-fill); box-shadow: 3px 3px 0 var(--text); }')),
  // Mono, inverted: white geometry on black, red only for danger.
  'bauhaus-noir': T('Bauhaus Noir', 'dark', ['#0e0e0e', '#161616', '#1c1c1c', '#ededea', '#8c8c88', '#ededea', '#ededea', '#8c8c88', '#ededea', '#ededea', '#ededea', '#bdbdbd', '#a0a0a0', '#ff4a3d', '#ededea', '#8c8c88', '#4a4a4a'],
    { ...BAUHAUS_POSTER, texture: false, avatars: 'ink', colColor: 'ink' }, bauhausCss(10, '.btn.primary { background: var(--text); color: var(--bg); box-shadow: none; }')),
  // For work: muted primaries, hairline borders, small shapes — still a circle, a square and a triangle.
  'bauhaus-studio': T('Bauhaus Studio', 'light', ['#f3f2ee', '#eae8e2', '#ffffff', '#1d1f24', '#6b6e76', '#d6d3cb', '#b8402f', '#24407a', '#b8402f', '#24407a', '#c9962a', '#3b7a4a', '#c9772a', '#b8402f', '#b8402f', '#24407a', '#c9962a'],
    { ...BAUHAUS_STUDIO }, bauhausCss(4, STUDIO_CSS)),
  'bauhaus-studio-dark': T('Bauhaus Studio Dark', 'dark', ['#16171b', '#1d1f24', '#23262c', '#e7e6e1', '#8d9099', '#30333b', '#e0584a', '#5b84d6', '#e0584a', '#5b84d6', '#e3b341', '#4caf6e', '#e08a3a', '#e0584a', '#e0584a', '#5b84d6', '#e3b341'],
    { ...BAUHAUS_STUDIO }, bauhausCss(4, STUDIO_CSS)),
  soft: T('Soft', 'light', ['#e6e9ef', '#e6e9ef', '#e6e9ef', '#2d3346', '#7b8196', '#d5d9e2', '#6c63ff', '#00b8a9', '#ef5d7a', '#5b8def', '#f0a93b', '#2bb673', '#f08c3b', '#e5484d', '#e6e9ef', '#e6e9ef', '#e6e9ef'],
    { card: 16, col: 26, modal: 28, ctl: 14, bw: 0, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'glow', enter: 'rise', lanes: 'solid', bg: 'none', texture: false, avatar: 'round', colAlpha: 100 },
    '.column { box-shadow: 10px 10px 24px #c5c9d3, -10px -10px 24px #ffffff; } .card { box-shadow: 6px 6px 14px #c8ccd6, -6px -6px 14px #ffffff; } .card:hover { box-shadow: 2px 2px 6px #c8ccd6, -2px -2px 6px #ffffff; } .card::before { display: none; } .search input, .inp, .dd, .tbox, .seg { background: var(--bg); box-shadow: inset 3px 3px 7px #c8ccd6, inset -3px -3px 7px #ffffff; border-color: transparent; } .pill-btn, .btn:not(.primary) { background: var(--bg); border-color: transparent; box-shadow: 4px 4px 10px #c8ccd6, -4px -4px 10px #ffffff; } .pill-btn:active, .btn:active { box-shadow: inset 3px 3px 7px #c8ccd6, inset -3px -3px 7px #ffffff; } .modal, .drawer { box-shadow: 20px 20px 50px #c5c9d3, -20px -20px 50px #ffffff; } .seg button.on { box-shadow: 3px 3px 6px #c8ccd6, -3px -3px 6px #ffffff; }'),
  dusk: T('Dusk', 'dark', ['#292d36', '#292d36', '#292d36', '#e4e7f0', '#8d93a7', '#343944', '#968fff', '#3fd4c2', '#ff7d95', '#6fa8ff', '#f4b860', '#46cf91', '#f39b5c', '#ff6670', '#292d36', '#292d36', '#292d36'],
    { card: 16, col: 26, modal: 28, ctl: 14, bw: 0, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'glow', enter: 'rise', lanes: 'solid', bg: 'none', texture: false, avatar: 'round', colAlpha: 100 },
    '.column { box-shadow: 10px 10px 24px #1c1f26, -8px -8px 22px #343a46; } .card { box-shadow: 6px 6px 14px #1c1f26, -5px -5px 12px #343a46; } .card:hover { box-shadow: 2px 2px 6px #1c1f26, -2px -2px 6px #343a46; } .card::before { display: none; } .search input, .inp, .dd, .tbox, .seg { background: var(--bg); box-shadow: inset 3px 3px 7px #1c1f26, inset -3px -3px 7px #343a46; border-color: transparent; } .pill-btn, .btn:not(.primary) { background: var(--bg); border-color: transparent; box-shadow: 4px 4px 10px #1c1f26, -4px -4px 10px #343a46; } .pill-btn:active, .btn:active { box-shadow: inset 3px 3px 7px #1c1f26, inset -3px -3px 7px #343a46; } .modal, .drawer { box-shadow: 20px 20px 50px #15171c, -14px -14px 40px #343a46; } .seg button.on { background: var(--bg); box-shadow: 3px 3px 6px #1c1f26, -3px -3px 6px #343a46; } .opt-grid button { background: var(--bg); border-color: transparent; box-shadow: 3px 3px 7px #1c1f26, -3px -3px 7px #343a46; } .opt-grid button.on { box-shadow: inset 3px 3px 7px #1c1f26, inset -3px -3px 7px #343a46; color: var(--accent); } .btn.primary { background: linear-gradient(145deg, #9a93ff, #7a72f0); box-shadow: 4px 4px 10px #1a1c23, -3px -3px 8px #353a47; } .col-name { color: #d9dcf0; }'),
  moss: T('Moss', 'dark', ['#121812', '#182019', '#1e281f', '#e6ecd9', '#8f9c84', '#2b382c', '#a3d16c', '#e2c36b', '#e88a6a', '#7fb6a4', '#e2c36b', '#8fcf6e', '#e0a35a', '#e86a5a', '#2f4a26', '#4a5a1f', '#1f3a33'],
    { card: 18, col: 30, modal: 30, ctl: 14, bw: 1, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'glow', enter: 'rise', lanes: 'solid', chips: 'pill', bg: 'blobs', texture: true, grain: '.11', avatar: 'round', md: 'paper', titleW: 600, display: "'Fraunces'", colAlpha: 88 },
    '.card { border-radius: 28px 14px 30px 12px / 16px 30px 14px 28px; border-color: rgb(163 209 108 / .14); background: radial-gradient(140% 120% at 0% 0%, rgb(163 209 108 / .10), transparent 55%), linear-gradient(165deg, #233024, #1a231b); box-shadow: 0 12px 26px -14px rgb(0 0 0 / .85), inset 0 1px 0 rgb(226 195 107 / .10); } .card:nth-child(3n+2) { border-radius: 14px 30px 16px 26px / 28px 14px 30px 16px; } .card:nth-child(3n) { border-radius: 30px 18px 24px 14px / 14px 26px 18px 30px; } .card:hover { box-shadow: 0 18px 36px -14px rgb(0 0 0 / .9), 0 0 0 1px rgb(163 209 108 / .35), 0 0 30px -10px rgb(163 209 108 / .35); } .column { border-radius: 46px 34px 52px 30px / 34px 52px 30px 46px; border-color: rgb(163 209 108 / .10); background: linear-gradient(180deg, rgb(32 44 30 / .88), rgb(22 30 22 / .82)); } .col-head { border-bottom: 1px dashed rgb(226 195 107 / .18); } .col-name { font-family: var(--display); font-weight: 600; letter-spacing: .01em; color: #e9e2c4; } .app-name { color: #e2c36b; } .btn.primary { background: linear-gradient(140deg, #b5dc7c, #6fae58); color: #10160f; border-radius: 22px 12px 22px 12px; }'),
  clay: T('Clay', 'light', ['#ede2d3', '#e5d6c2', '#f6eee2', '#3b2a22', '#8a7362', '#d8c4ab', '#c2603f', '#6f8f68', '#c2603f', '#5f7f9a', '#d49a3a', '#6f8f68', '#d08a3a', '#b8432e', '#e7b49a', '#c9d3b4', '#f0cf9e'],
    { card: 20, col: 32, modal: 32, ctl: 16, bw: 0, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'outline', enter: 'rise', lanes: 'solid', chips: 'pill', bg: 'blobs', texture: true, grain: '.12', avatar: 'round', md: 'paper', titleW: 600, display: "'Bricolage Grotesque'", colAlpha: 100 },
    '.column { border-radius: 120px 120px 34px 34px / 46px 46px 34px 34px; background: linear-gradient(178deg, #ecdfcd, #e1cfb8); box-shadow: inset 0 3px 0 rgb(255 255 255 / .6), inset 0 -14px 28px -18px rgb(120 70 40 / .3), 0 22px 38px -26px rgb(110 70 40 / .5); } .col-head { padding-top: 26px; justify-content: center; } .col-name { font-weight: 700; color: #6a3a26; } .card { border-radius: 26px 18px 28px 16px / 18px 28px 16px 26px; background: radial-gradient(120% 90% at 20% 0%, #fcf7ef, #f0e3d1); box-shadow: inset 0 1px 0 rgb(255 255 255 / .95), inset 0 -3px 0 rgb(194 96 63 / .10), 0 12px 20px -12px rgb(110 60 30 / .5); } .card:nth-child(2n) { border-radius: 18px 28px 16px 26px / 28px 16px 26px 18px; background: radial-gradient(120% 90% at 80% 0%, #fbf3ea, #ecdcc6); } .card:nth-child(3n) { background: radial-gradient(120% 90% at 30% 0%, #f6f4e8, #e3e2cf); } .card:hover { box-shadow: inset 0 1px 0 #fff, inset 0 -3px 0 rgb(194 96 63 / .18), 0 18px 28px -14px rgb(110 60 30 / .55); } .search input, .inp, .tbox { background: #f3e9db; box-shadow: inset 0 2px 5px rgb(120 70 40 / .16); border-color: transparent; } .btn.primary { background: linear-gradient(150deg, #d27a56, #b3532f); border-radius: 999px; box-shadow: inset 0 1px 0 rgb(255 255 255 / .3), 0 6px 14px -6px rgb(160 70 40 / .6); } .app-name { color: #b3532f; }'),
  tide: T('Tide', 'light', ['#e4eef0', '#d6e6e9', '#f4fafa', '#173b44', '#5f8088', '#c3d9dd', '#0f7a86', '#ff7f6b', '#ff7f6b', '#2f8fb8', '#e8b04a', '#2fae8f', '#f09a4a', '#e35a4f', '#a8dde0', '#ffd1c4', '#c7e7d9'],
    { card: 22, col: 28, modal: 28, ctl: 14, bw: 1, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'glow', enter: 'rise', lanes: 'glass', chips: 'pill', bg: 'mesh', texture: false, avatar: 'round', md: 'clean', titleW: 600, display: "'Outfit'", colAlpha: 62 },
    '.column { border-radius: 34px; border-color: rgb(255 255 255 / .75); box-shadow: 0 22px 44px -30px rgb(15 90 100 / .5); } .col-head { position: relative; } .col-head::after { content: ""; position: absolute; left: 14px; right: 14px; bottom: -6px; height: 9px; background: radial-gradient(circle at 8px -3px, transparent 7px, var(--col, var(--accent)) 7.5px, var(--col, var(--accent)) 9px, transparent 9.5px) 0 0 / 16px 9px repeat-x; opacity: .55; } .card { border-radius: 26px 26px 26px 6px; border-color: rgb(255 255 255 / .95); background: linear-gradient(170deg, rgb(255 255 255 / .95), rgb(232 246 246 / .88)); box-shadow: 0 10px 22px -12px rgb(15 90 100 / .45), inset 0 -2px 0 rgb(15 122 134 / .08); } .card:nth-child(2n) { border-radius: 26px 26px 6px 26px; } .card:hover { box-shadow: 0 16px 30px -12px rgb(15 90 100 / .5), 0 0 0 1px rgb(15 122 134 / .3); } .btn.primary { background: linear-gradient(135deg, #0f7a86, #2f8fb8); border-radius: 999px; } .app-name { color: #0f7a86; }'),
  bloom: T('Bloom', 'dark', ['#170f1c', '#1f1526', '#271b30', '#f3e8f4', '#a08aa8', '#3a2a44', '#e58ad6', '#f6c453', '#ff7a9a', '#9d8cff', '#f6c453', '#7fd6a0', '#f2a05c', '#ff5f7e', '#5b1e5a', '#3a1d63', '#6b4a12'],
    { card: 22, col: 32, modal: 32, ctl: 14, bw: 1, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'orbit', enter: 'zoom', lanes: 'glass', chips: 'pill', bg: 'blobs', texture: true, avatar: 'round', md: 'clean', titleW: 600, display: "'Fraunces'", colAlpha: 70 },
    '.card { border-radius: 34px 6px 34px 6px; border-color: rgb(229 138 214 / .18); background: radial-gradient(120% 100% at 100% 0%, rgb(229 138 214 / .14), transparent 60%), linear-gradient(150deg, #2e2038, #231a2b); box-shadow: 0 14px 28px -16px rgb(0 0 0 / .85); } .card:nth-child(2n) { border-radius: 6px 34px 6px 34px; background: radial-gradient(120% 100% at 0% 0%, rgb(246 196 83 / .10), transparent 60%), linear-gradient(150deg, #2e2038, #231a2b); } .card:hover { box-shadow: 0 20px 40px -16px rgb(229 138 214 / .45), 0 0 0 1px rgb(246 196 83 / .3); } .column { border-radius: 90px 90px 30px 30px / 60px 60px 30px 30px; border-color: rgb(229 138 214 / .14); background: linear-gradient(180deg, rgb(58 30 70 / .55), rgb(31 21 38 / .7)); } .col-head { padding-top: 22px; justify-content: center; } .col-name { font-family: var(--display); font-style: italic; font-weight: 600; } .app-name { background: linear-gradient(90deg, #e58ad6, #f6c453); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; } .btn.primary { background: linear-gradient(135deg, #e58ad6, #b56ae0); color: #1b0f20; border-radius: 18px 4px 18px 4px; } .group { --g-r: calc(34px + var(--gi)) calc(6px + var(--gi)); --cover-r: 34px 6px; --tab-x: 30px; } .group-cards > .card, .group-cards > .card:nth-child(2n) { border-radius: 34px 6px; }'),
  cloud: T('Cloud', 'light', ['#f1efea', '#ebe8e1', '#fbfaf7', '#2f2d35', '#8b8792', '#e3dfd7', '#8d82d6', '#e39aa6', '#e2898c', '#7fa6d6', '#dfb465', '#78b692', '#e0a36c', '#d66f6e', '#ddd7f6', '#f7d9de', '#d3ebde'],
    { card: 18, col: 26, modal: 28, ctl: 14, bw: 1, cards: 'elevated', typeInd: 'dot', tape: 'none', attn: 'glow', enter: 'rise', lanes: 'solid', chips: 'pill', bg: 'blobs', texture: false, md: 'clean', avStyle: 'tint', titleW: 600, display: "'Outfit'", colAlpha: 100 },
    '.column { background: linear-gradient(180deg, #edeae3, #e8e4dc); border-color: transparent; } .card { padding: 14px 15px 12px; } .group { --cpx: 15px; } .c-title { font-size: 14.5px; letter-spacing: -.005em; } .col-name { font-size: 15px; font-weight: 600; letter-spacing: -.01em; } .btn.primary { background: #2f2d35; color: #fbfaf7; } .app-name { color: #2f2d35; }'),
  liquid: T('Liquid', 'light', ['#dfe6f6', '#ffffff', '#ffffff', '#111733', '#5a6482', '#cdd6ec', '#3d6bff', '#ff5aa6', '#ff5d73', '#3d6bff', '#ffb020', '#22c08a', '#ff8a3d', '#ef4058', '#7aa0ff', '#ff9bd2', '#7cf0d6'],
    { card: 18, col: 28, modal: 30, ctl: 14, bw: 1, cards: 'glass', typeInd: 'dot', tape: 'none', attn: 'glow', enter: 'zoom', lanes: 'glass', chips: 'pill', bg: 'mesh', texture: false, md: 'clean', avStyle: 'gem', titleW: 600, display: "'Outfit'", colAlpha: 40 },
    '.column, .card, .modal, .drawer, .pill-btn, .search input { box-shadow: inset 0 1px 0 rgb(255 255 255 / .9), inset 0 0 0 1px rgb(255 255 255 / .35), 0 18px 40px -26px rgb(30 50 140 / .45); } .modal, .drawer { background: rgb(255 255 255 / .72); -webkit-backdrop-filter: blur(24px) saturate(1.5); backdrop-filter: blur(24px) saturate(1.5); } .pill-btn { background: rgb(255 255 255 / .55); } .btn.primary { background: linear-gradient(180deg, #5a83ff, #2f5cf5); border-radius: 999px; box-shadow: inset 0 1px 0 rgb(255 255 255 / .45), 0 8px 18px -8px rgb(47 92 245 / .6); } .app-name { background: linear-gradient(90deg, #3d6bff, #ff5aa6); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }'),
  pop: T('Pop', 'light', ['#fff5e4', '#ffffff', '#ffffff', '#141414', '#5b5550', '#141414', '#ff4f8b', '#2bb5ff', '#ff5a5a', '#4d78ff', '#ffc21f', '#19b36b', '#ff8a1f', '#ff3b3b', '#ffd6e5', '#cdeeff', '#fff0b8'],
    { card: 12, col: 18, modal: 18, ctl: 12, bw: 2, shadow: 'hard', cards: 'clean', typeInd: 'top', tape: 'none', attn: 'ribbon', enter: 'pop', lanes: 'solid', chips: 'tag', heads: 'caps', bg: 'confetti', texture: false, md: 'grid', avStyle: 'stamp', titleW: 700, font: "'Space Grotesk'", display: "'Space Grotesk'", colAlpha: 100 },
    '.column { border: 2.5px solid #141414; box-shadow: 5px 5px 0 #141414; } .column:nth-child(5n+1) { background: #ffd9e6; } .column:nth-child(5n+2) { background: #d4efff; } .column:nth-child(5n+3) { background: #fff1b8; } .column:nth-child(5n+4) { background: #dcf5e3; } .column:nth-child(5n) { background: #e9e0ff; } .card { border: 2px solid #141414; box-shadow: 3px 3px 0 #141414; transition: translate .15s, box-shadow .15s; } .card:hover { translate: -2px -2px; box-shadow: 5px 5px 0 #141414; } .pill-btn, .search input, .btn { border: 2px solid #141414; box-shadow: 2px 2px 0 #141414; } .btn.primary { background: #ff4f8b; color: #141414; } .chip { border: 1.5px solid #141414; } .app-name { color: #141414; font-weight: 800; }'),
  aqua: T('Aqua', 'light', ['#dde6ef', '#eef3f8', '#ffffff', '#1d2b3a', '#5f7286', '#b9c8d8', '#1f86ff', '#7cc63d', '#ff5266', '#1f86ff', '#ffaa1f', '#4fb83a', '#ff8a2a', '#e8394f', '#bfe2ff', '#d8f5c4', '#e8dcff'],
    { card: 12, col: 16, modal: 18, ctl: 10, bw: 1, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'outline', enter: 'pop', lanes: 'solid', chips: 'pill', bg: 'none', texture: false, md: 'clean', avStyle: 'gem', titleW: 600, display: "'Outfit'", colAlpha: 100 },
    '.bg-layer { background: repeating-linear-gradient(0deg, #e6edf4 0 2px, #f2f6fa 2px 4px); } .pill-btn, .btn { border-radius: 999px; } .column { background: linear-gradient(180deg, #f7fafd, #e9f0f7); border: 1px solid #b6c6d8; box-shadow: inset 0 1px 0 #fff, 0 10px 24px -16px rgb(40 70 110 / .5); } .col-head { margin: 6px 6px 8px; padding: 9px 12px; border-radius: 10px; background: linear-gradient(180deg, #ffffff 0%, #e4eef8 49%, #d3e2f2 50%, #e8f1fa 100%); border: 1px solid #b6c6d8; box-shadow: inset 0 1px 0 #fff; } .card { background: linear-gradient(180deg, #ffffff 0%, #fbfdff 48%, #f2f7fc 52%, #ffffff 100%); border-color: #c4d2e1; box-shadow: inset 0 1px 0 #fff, 0 4px 10px -6px rgb(40 70 110 / .45); } .btn.primary { background: linear-gradient(180deg, #b9e1ff 0%, #4aa6ff 48%, #1f86ff 52%, #7cc7ff 100%); border: 1px solid #1b63c4; color: #fff; text-shadow: 0 -1px 0 rgb(0 40 100 / .4); box-shadow: inset 0 1px 0 rgb(255 255 255 / .6), 0 3px 8px -3px rgb(20 90 200 / .6); } .pill-btn { background: linear-gradient(180deg, #ffffff, #e3ebf4); border-color: #b6c6d8; } .app-name { color: #1f86ff; text-shadow: 0 1px 0 #fff; }'),
  iridescent: T('Iridescent', 'dark', ['#07070b', '#0e0e15', '#13131c', '#f1f0ff', '#8d8ba8', '#24233a', '#c084fc', '#5eead4', '#fb7185', '#60a5fa', '#fcd34d', '#4ade80', '#fb923c', '#f43f5e', '#7c3aed', '#06b6d4', '#ec4899'],
    { card: 14, col: 20, modal: 22, ctl: 12, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'orbit', enter: 'zoom', lanes: 'outline', chips: 'outline', bg: 'aurora', texture: true },
    '.card { border: 1px solid transparent; background: linear-gradient(var(--surface), var(--surface)) padding-box, conic-gradient(from 210deg, #c084fc, #5eead4, #60a5fa, #f472b6, #fcd34d, #c084fc) border-box; } .card:hover { box-shadow: 0 18px 40px -16px rgb(192 132 252 / .5), 0 0 24px -10px rgb(94 234 212 / .5); } .column { border-color: rgb(255 255 255 / .07); background: rgb(14 14 21 / .55); } .app-name { background: linear-gradient(90deg, #c084fc, #5eead4, #f472b6); -webkit-background-clip: text; background-clip: text; } .btn.primary { background: linear-gradient(120deg, #c084fc, #60a5fa, #5eead4); }'),
  riso: T('Riso', 'light', ['#f5f0e6', '#efe8da', '#fbf8f1', '#1d2b6b', '#5c6aa3', '#1d2b6b', '#ff48b0', '#0078bf', '#ff48b0', '#0078bf', '#ffe800', '#00a95c', '#ff6c2f', '#ff48b0', '#ff48b0', '#0078bf', '#ffe800'],
    { md: 'paper', card: 4, col: 6, modal: 8, ctl: 6, bw: 2, shadow: 'hard', cards: 'clean', typeInd: 'tint', tape: 'none', attn: 'ribbon', enter: 'pop', lanes: 'outline', chips: 'tag', heads: 'caps', bg: 'halftone', texture: true, grain: '.4', titleW: 700, font: "'Bricolage Grotesque'", display: "'Bricolage Grotesque'" },
    '.card { --card-line: var(--text); box-shadow: 3px 3px 0 var(--accent); } .card:hover { box-shadow: 5px 5px 0 var(--accent), -2px -2px 0 color-mix(in oklab, var(--accent-2) 70%, transparent); } .c-title { text-shadow: 1.5px 1px 0 color-mix(in oklab, var(--accent) 50%, transparent); } .col-name { color: var(--accent-2); text-shadow: 2px 1px 0 color-mix(in oklab, var(--accent) 60%, transparent); } .column { box-shadow: 6px 6px 0 color-mix(in oklab, var(--accent-2) 28%, transparent); } .app-name { background: none; color: var(--accent-2); -webkit-text-fill-color: currentColor; text-shadow: 2px 1.5px 0 var(--accent); } .btn.primary { background: var(--accent-fill); box-shadow: 3px 3px 0 var(--accent-2); }'),
};
// Each theme's avatar look (kept in one table so the set reads as a whole).
const AV_STYLE = {
  intellagent: 'gem', daylight: 'tint', dracula: 'flat', nord: 'tint', mocha: 'tint', latte: 'tint', tokyo: 'ring', gruvbox: 'flat',
  solarized: 'tint', github: 'flat', slate: 'tint', graphite: 'ring', midnight: 'ring', paper: 'ring', brutalist: 'stamp', cork: 'flat',
  blueprint: 'ring', vision: 'gem', phosphor: 'ring', swiss: 'flat', bauhaus: 'flat', soft: 'pebble', dusk: 'pebble', moss: 'pebble',
  'bauhaus-night': 'flat', 'bauhaus-mono': 'flat', 'bauhaus-noir': 'flat', 'bauhaus-studio': 'tint', 'bauhaus-studio-dark': 'tint',
  clay: 'pebble', tide: 'tint', bloom: 'gem', iridescent: 'gem', riso: 'stamp', clear: 'tint', 'clear-dark': 'tint',
};
for (const [k, v] of Object.entries(AV_STYLE)) if (THEMES[k]) THEMES[k].style.avStyle ??= v;
// …and what a column does when a ticket is dragged over it.
const DROP_STYLE = {
  vision: 'tint', tide: 'tint', iridescent: 'tint', liquid: 'tint', cloud: 'tint', daylight: 'tint', latte: 'tint', clear: 'tint', 'clear-dark': 'tint',
  soft: 'lift', dusk: 'lift', clay: 'lift', pop: 'lift', brutalist: 'lift', bauhaus: 'lift', riso: 'lift', aqua: 'lift',
  'bauhaus-night': 'lift', 'bauhaus-mono': 'lift', 'bauhaus-noir': 'lift', 'bauhaus-studio': 'dashed', 'bauhaus-studio-dark': 'dashed',
  blueprint: 'dashed', phosphor: 'dashed', swiss: 'dashed', paper: 'dashed', graphite: 'dashed',
  moss: 'spotlight', midnight: 'spotlight', tokyo: 'spotlight', slate: 'spotlight',
  bloom: 'pulse', dracula: 'pulse', mocha: 'pulse', cork: 'pulse',
};
for (const [k, v] of Object.entries(DROP_STYLE)) if (THEMES[k]) THEMES[k].style.drop ??= v;
// …and how tickets sharing a parent are drawn (tray unless named here). Paper and soft themes file them behind a
// cover card (an index divider) or under folder tabs,
// grid themes set the label on a spine, crisp product themes use a ruled header, bold/neon ones a coloured rail.
const GROUP_LOOK = {
  paper: 'cover', cork: 'cover', clay: 'cover', cloud: 'cover', riso: 'tab', solarized: 'tab',
  swiss: 'spine', bauhaus: 'spine', brutalist: 'spine',
  'bauhaus-night': 'spine', 'bauhaus-mono': 'spine', 'bauhaus-noir': 'spine', 'bauhaus-studio': 'rule', 'bauhaus-studio-dark': 'rule',
  phosphor: 'foot', blueprint: 'foot',
  github: 'rule', slate: 'rule', graphite: 'rule', midnight: 'rule', nord: 'rule', clear: 'rule', 'clear-dark': 'rule',
  dracula: 'rail', tokyo: 'rail', synthwave: 'rail', gruvbox: 'rail', pop: 'rail', iridescent: 'rail',
};
for (const [k, v] of Object.entries(GROUP_LOOK)) if (THEMES[k]) THEMES[k].style.groups ??= v;
// …and the kind it is listed under in Appearance (INT-222): pick a kind, then a theme. Every theme is in one.
export const THEME_KINDS = [
  ['bauhaus', 'Bauhaus', ['bauhaus-studio', 'bauhaus-studio-dark', 'bauhaus', 'bauhaus-night', 'bauhaus-mono', 'bauhaus-noir']],
  ['product', 'Product', ['clear', 'clear-dark', 'intellagent', 'daylight', 'slate', 'graphite', 'midnight']],
  ['editor', 'Editor classics', ['github', 'solarized', 'latte', 'nord', 'dracula', 'mocha', 'tokyo', 'gruvbox', 'rosepine']],
  ['soft', 'Soft & organic', ['cloud', 'soft', 'clay', 'tide', 'dusk', 'moss', 'bloom']],
  ['print', 'Print & retro', ['paper', 'swiss', 'brutalist', 'riso', 'pop', 'cork', 'aqua', 'blueprint', 'phosphor']],
  ['glass', 'Glass & neon', ['vision', 'liquid', 'iridescent', 'synthwave']],
];
export const themeKind = (k) => THEME_KINDS.find(([, , keys]) => keys.includes(k))?.[0] || THEME_KINDS[0][0];
// Organic themes lean on their colour fields: let the background blobs come through more.
for (const [k, o] of [['moss', '.62'], ['clay', '.7'], ['tide', '.75'], ['bloom', '.6'], ['cloud', '.8'], ['liquid', '.95']]) if (THEMES[k]) THEMES[k].vars['fx-o'] = o;
// Blueprint's contours are drawn in one ink, like the sheet itself (index lines in its text white, not gold).
THEMES.blueprint.vars['topo-index'] = THEMES.blueprint.vars.text;
// Text on accent fills reaches 4.5:1. White where it does; in a dark theme, else its background ink (a pale accent
// reads far better with ink); else the fill (--accent-fill) is deepened toward the theme's ink until white reads.
// --accent itself is untouched, so links, rings and tints keep the theme's colour.
for (const t of Object.values(THEMES)) {
  const v = t.vars, ink = luminance(v.bg) < luminance(v.text) ? v.bg : v.text;
  if (contrast('#fff', v.accent) >= 4.5) continue;
  else if (t.mode === 'dark' && contrast(ink, v.accent) >= 4.5) v['on-accent'] = ink;
  else for (let i = 1; i <= 50 && contrast('#fff', v['accent-fill']) < 4.5; i++) v['accent-fill'] = mixHex(v.accent, ink, i / 50);
}
// Group (parent) colours, --tag-0…7, come from the theme's own palette: in this order, each that shows on the
// card surface (moved toward the text until it reaches 3:1, as any non-text mark must) and differs clearly from
// those already taken. A narrow palette adds deeper shades of what it has while they still differ; then repeats.
const TAG_SRC = ['accent', 'accent-2', 'task', 'spike', 'ok', 'issue', 'warn', 'blob1', 'blob2', 'blob3', 'danger'];
// Text tinted by a group colour (app.css): [variable, usual share of the tag in the text, share in its ground,
// ground]. A theme whose colours can't carry the usual share at 4.5:1 gets a smaller one, never a duller colour.
const TAG_TEXT = [['tag-cover', 42, 9, 'surface'], ['tag-tab', 40, 14, 'surface'], ['tag-chip', 55, 17, 'surface'], ['tag-head', 50, 0, 'panel']];
const shows = (c, v) => { for (let i = 1; i <= 100 && contrast(c, v.surface) < 3; i++) c = mixHex(c, v.text, 0.02); return c; };
const apart = (x, y) => Math.hypot(...oklab(x).map((c, i) => c - oklab(y)[i]));
// Worked out when a theme is first shown (about 1 ms), not for every theme at load: { tags, shares }.
export const themeGroups = (t) => t.groupColours ??= (() => {
  const v = t.vars, tags = [];
  const add = (c, d) => tags.length < 8 && tags.every((x) => apart(x, c) > d) && tags.push(c);
  for (const k of TAG_SRC) if (contrast(v[k], v.surface) >= 1.6) add(shows(v[k], v), 0.1);
  if (!tags.length) tags.push(shows(v.accent, v));
  // a shade has to differ more than a hue does to be told apart at the size of a dot
  for (const p of [0.35, 0.6]) for (const c of [...tags]) add(shows(mixHex(c, v.text, p), v), 0.16);
  const count = tags.length; // slots are dealt over this many; the rest repeat so no old theme's colour lingers
  for (let i = 0; tags.length < 8; i++) tags.push(tags[i]);
  const shares = {};
  for (const [key, usual, inGround, ground] of TAG_TEXT) {
    let s = usual;
    while (s > 0 && tags.some((c) => contrast(mixOklab(c, s / 100, v.text), mixOklab(c, inGround / 100, v[ground])) < 4.5)) s -= 5;
    shares[key] = Math.max(0, s);
  }
  return { tags, count, shares };
})();
