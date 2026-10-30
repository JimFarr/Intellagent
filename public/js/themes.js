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
  label, mode, style, css,
  vars: {
    bg: c[0], panel: c[1], surface: c[2], text: c[3], muted: c[4], border: c[5], accent: c[6], 'accent-2': c[7],
    issue: c[8], task: c[9], spike: c[10], ok: c[11], warn: c[12], danger: c[13], blob1: c[14], blob2: c[15], blob3: c[16],
    shadow: mode === 'dark' ? 'rgb(0 0 0 / .6)' : 'rgb(60 45 30 / .22)',
    // set on every theme, so switching away from one that changes them never leaves them behind
    'on-accent': '#fff', 'accent-fill': c[6],
  },
});
// Clear: thin lines, no shadows or motion to speak of, sentence-case headings. The type shows as a line on top and
// "needs you" as a bar on the left, so the two never compete for one place. Links are underlined at full strength,
// every control shows a focus ring, and form fields get an edge of 3:1 so they can be found.
const CLEAR_STYLE = { card: 6, col: 10, modal: 12, ctl: 6, bw: 1, shadow: 'flat', cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'bar', enter: 'fade', lanes: 'solid', chips: 'tag', heads: 'normal', avatar: 'round', avStyle: 'tint', drop: 'tint', groups: 'rule', titleW: 500, font: "'Inter'", display: "'Inter'", colAlpha: 100 };
const CLEAR_CSS = '.c-title { font-size: 14px; line-height: 1.45; } .col-name { font-weight: 600; } .app-name { background: none; color: var(--text); -webkit-text-fill-color: currentColor; font-weight: 700; }'
  + ' .md a { border-bottom-color: currentColor; }'
  + ' :is(button, a, summary, [tabindex]):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }'
  + ' :is(.inp, textarea, .dd) { border-color: color-mix(in oklab, var(--muted) 70%, var(--border)); }';
export const THEMES = {
  // Clear (INT-451): calm and legible. Neutral greys, one blue for what you can act on, violet only for what
  // needs you; text 12:1 or more, secondary text 5.9:1 or more on every surface. Type and status colours were
  // picked to stay apart under protan, deutan and tritan vision, and each also has its own shape or place.
  clear: T('Clear', 'light', ['#f6f7f9', '#eef0f3', '#ffffff', '#16191f', '#555c68', '#ccd1d8', '#3a64ae', '#674fa7', '#a54b6e', '#3a64ae', '#856635', '#397582', '#896535', '#9e3b4a', '#a5b8e0', '#c1b5dd', '#accdd3'],
    CLEAR_STYLE, CLEAR_CSS),
  'clear-dark': T('Clear Dark', 'dark', ['#15171b', '#1b1e23', '#22262c', '#e7e9ed', '#a5abb6', '#464d59', '#89a9e6', '#b2a3e8', '#de8aa6', '#89a9e6', '#d7b475', '#75becb', '#e3bd7d', '#e57682', '#475c87', '#5a4f7f', '#446c72'],
    CLEAR_STYLE, CLEAR_CSS),
};
// Imported themes (INT-465): a theme is a .css file (lib/themes.js, themes/README.md). Its :root block is the palette,
// the header's style: line the look options, and every other rule is scoped to the theme when it is applied.
// Text on accent fills reaches 4.5:1. White where it does; in a dark theme, else its background ink (a pale accent
// reads far better with ink); else the fill (--accent-fill) is deepened toward the theme's ink until white reads.
// --accent itself is untouched, so links, rings and tints keep the theme's colour.
const finish = (t) => {
  const v = t.vars, ink = luminance(v.bg) < luminance(v.text) ? v.bg : v.text;
  v['on-accent'] ??= '#fff'; v['accent-fill'] ??= v.accent;
  // muted text keeps 4.5:1 on the surface, the panel and the page: mixed toward the text until it does (docs/design.md, Colour audit)
  const m0 = v.muted;
  for (let i = 1; i <= 50 && Math.min(contrast(v.muted, v.surface), contrast(v.muted, v.panel), contrast(v.muted, v.bg)) < 4.5; i++) v.muted = mixHex(m0, v.text, i / 50);
  if (contrast('#fff', v.accent) >= 4.5) return t;
  if (t.mode === 'dark' && contrast(ink, v.accent) >= 4.5) v['on-accent'] = ink;
  else for (let i = 1; i <= 50 && contrast('#fff', v['accent-fill']) < 4.5; i++) v['accent-fill'] = mixHex(v.accent, ink, i / 50);
  return t;
};
for (const t of Object.values(THEMES)) finish(t);
// An imported theme from the server's { id, name, mode, css }; it replaces one of the same id.
export const addTheme = ({ id, name, mode, css }) => {
  const head = /^\s*\/\*([\s\S]*?)\*\//.exec(css)?.[1] || '';
  const vars = {};
  for (const m of (/:root\s*\{([^{}]*)\}/.exec(css)?.[1] || '').matchAll(/--([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) vars[m[1]] = m[2];
  let style = {};
  try { style = JSON.parse(/^\s*style\s*:\s*(.+?)\s*$/m.exec(head)?.[1] || '{}'); } catch { /* the server checked it */ }
  const rules = css.replace(/^\s*\/\*[\s\S]*?\*\//, '').replace(/:root\s*\{[^{}]*\}/, '').trim();
  return (THEMES[id] = finish({ label: name, mode, style, css: rules, glow: !!style.glow, vars }));
};
export const BUILT_IN = ['clear', 'clear-dark'];
export const removeTheme = (id) => { if (!BUILT_IN.includes(id)) delete THEMES[id]; };
// Group (parent) colours, --tag-0…7, come from the theme's own palette: in this order, each that shows on the
// card surface (moved toward the text until it reaches 3:1, as any non-text mark must) and differs clearly from
// those already taken. A narrow palette adds deeper shades of what it has while they still differ; then repeats.
const TAG_SRC = ['accent', 'accent-2', 'task', 'spike', 'ok', 'issue', 'warn', 'blob1', 'blob2', 'blob3', 'danger'];
// Text tinted by a group colour (app.css): [variable, usual share of the tag in the text, share in its ground,
// ground]. A theme whose colours can't carry the usual share at 4.5:1 gets a smaller one, never a duller colour.
const TAG_TEXT = [['tag-chip', 55, 17, 'surface'], ['tag-head', 50, 0, 'panel']];
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
