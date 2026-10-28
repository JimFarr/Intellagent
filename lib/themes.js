'use strict';
// Themes beyond Clear and Clear Dark are .css files kept in the board folder (INT-465). A file starts with a header
// comment that names it, then sets the palette in :root { --bg: …; }, then may add rules of its own:
//
//   /* intellagent-theme
//      name: Dracula
//      mode: dark
//      style: {"cards":"clean","attn":"glow"}   (optional: the look options, see themes/README.md) */
//   :root { --bg: #21222c; … }
//   .col-name { color: var(--accent); }
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 200 * 1024;
const BUILT_IN = ['clear', 'clear-dark'];
// The colours every theme must set, as #rgb or #rrggbb: the page measures contrast and picks group colours from them.
const PALETTE = ['bg', 'panel', 'surface', 'text', 'muted', 'border', 'accent', 'accent-2', 'issue', 'task', 'spike', 'ok', 'warn', 'danger', 'blob1', 'blob2', 'blob3'];
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

class ThemeError extends Error {
  constructor(message, hint, status = 400) { super(message); this.status = status; this.hint = hint; }
}

const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// A theme can't reach the internet: no @import, and url() only for data: URLs. Backslash escapes could spell either
// one past these checks, so they go too.
function strip(css) {
  return css
    .replace(/\\/g, '')
    .replace(/@import\b[^;{}]*;?/gi, '')
    .replace(/url\(\s*(?!['"]?data:)[^)]*\)/gi, 'none')
    // image-set("https://…" 1x) and src("…") take a bare string: only data: strings stay
    .replace(/(image-set|src)\(((?:[^()"']|"[^"]*"|'[^']*'|\([^()]*\))*)\)/gi, (m, fn, args) => (/["'](?!data:)/i.test(args.replace(/"data:[^"]*"|'data:[^']*'/gi, '')) ? 'none' : m))
    .replace(/expression\(|-moz-binding|behavior\s*:/gi, '');
}

function parse(text) {
  if (typeof text !== 'string' || !text.trim()) throw new ThemeError('css is required', 'POST { "css": "/* intellagent-theme\\n name: …\\n mode: dark */ :root { --bg: … }" }');
  if (Buffer.byteLength(text) > MAX_BYTES) throw new ThemeError(`A theme is at most ${MAX_BYTES / 1024} KB`, 'Keep the palette and the rules that matter');
  const head = /^\s*\/\*\s*intellagent-theme\b([\s\S]*?)\*\//.exec(text);
  if (!head) throw new ThemeError('A theme starts with a header comment: /* intellagent-theme, then name: and mode: lines */', 'See themes/README.md');
  const field = (k) => new RegExp(`^\\s*${k}\\s*:\\s*(.+?)\\s*$`, 'mi').exec(head[1])?.[1];
  const name = field('name'), mode = field('mode');
  if (!name) throw new ThemeError('The header needs a name: line', 'name: Dracula');
  if (mode !== 'light' && mode !== 'dark') throw new ThemeError('The header needs mode: light or mode: dark', 'mode: dark');
  const id = slug(name);
  if (!id) throw new ThemeError('The name needs letters or digits', 'name: Dracula');
  if (BUILT_IN.includes(id)) throw new ThemeError(`${name} is a built-in theme`, 'Give the theme another name');
  let style = {};
  const rawStyle = field('style');
  if (rawStyle) {
    try { style = JSON.parse(rawStyle); } catch { throw new ThemeError('style: must be one line of JSON', 'style: {"cards":"clean"}'); }
    if (!style || typeof style !== 'object' || Array.isArray(style)) throw new ThemeError('style: must be a JSON object', 'style: {"cards":"clean"}');
  }
  const body = strip(text.slice(head[0].length));
  const root = /:root\s*\{([^{}]*)\}/.exec(body);
  const vars = {};
  for (const m of (root?.[1] || '').matchAll(/--([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) vars[m[1]] = m[2];
  const missing = PALETTE.filter((k) => !HEX.test(vars[k] || ''));
  if (missing.length) throw new ThemeError(`:root must set these as #rgb or #rrggbb: ${missing.map((k) => `--${k}`).join(', ')}`, 'See themes/README.md');
  return { id, name, mode, css: `/* intellagent-theme\nname: ${name}\nmode: ${mode}${rawStyle ? `\nstyle: ${JSON.stringify(style)}` : ''}\n*/\n${body.trim()}\n` };
}

function createThemes({ dir, writeFile }) {
  const file = (id) => path.join(dir, `${id}.css`);
  const read = (f) => {
    try { const t = parse(fs.readFileSync(path.join(dir, f), 'utf8')); return t.id === path.basename(f, '.css') ? t : null; } catch { return null; }
  };
  return {
    list() {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f) => f.endsWith('.css')).sort().map(read).filter(Boolean).map(({ id, name, mode, css }) => ({ id, name, mode, css }));
    },
    add(text) {
      const t = parse(text);
      fs.mkdirSync(dir, { recursive: true });
      writeFile(file(t.id), t.css);
      return { id: t.id, name: t.name, mode: t.mode, css: t.css };
    },
    remove(id) {
      const f = file(slug(id));
      if (!slug(id) || !fs.existsSync(f)) throw new ThemeError(`No theme ${id}`, 'GET /api/themes lists them', 404);
      fs.chmodSync(f, 0o644);
      fs.unlinkSync(f);
      return { removed: slug(id) };
    },
  };
}

module.exports = { createThemes, parse, ThemeError, BUILT_IN, PALETTE };
