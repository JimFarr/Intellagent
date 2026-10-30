#!/usr/bin/env node
'use strict';
/* An MCP server for making Intellagent themes (INT-500): start from a theme, set the palette and look, and check the
   file the way the board imports it, with its contrast against the board's rules. No board is needed: the human
   imports the finished file in Settings › Appearance. Tools: theme_guide, theme_list, theme_new, theme_check.
   Start: node theme-mcp.js (or intellagent theme-mcp). The guide it serves is themes/README.md. */
const fs = require('node:fs');
const path = require('node:path');
const { parse, PALETTE } = require('./lib/themes');
const { THEMES, addTheme, contrast } = require('./public/js/themes.js');
const { serve, launched } = require('./lib/mcp-serve');

const ROOT = __dirname;
const VERSION = require('./package.json').version;
const PACK = path.join(ROOT, 'themes');
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

// The pairs the board's own themes are held to: [colour, ground, least ratio, what it is]. Text 4.5:1 (WCAG AA),
// marks that only need to be seen (type and status colours, the accent) 3:1 on the card surface.
const RULES = [
  ...['bg', 'panel', 'surface'].flatMap((g) => [['text', g, 4.5, 'text'], ['muted', g, 4.5, 'secondary text']]),
  ...['accent', 'issue', 'task', 'spike', 'ok', 'warn', 'danger'].map((c) => [c, 'surface', 3, 'a mark on a card']),
  ['on-accent', 'accent-fill', 4.5, 'text on an accent button'],
];

// The look of a theme file: { id, name, mode, style, vars, rules } from its css text.
function read(text) {
  const t = parse(text);
  const head = /^\s*\/\*([\s\S]*?)\*\//.exec(t.css)[1];
  const vars = {};
  for (const m of (/:root\s*\{([^{}]*)\}/.exec(t.css)?.[1] || '').matchAll(/--([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) vars[m[1]] = m[2];
  const style = JSON.parse(/^\s*style\s*:\s*(.+?)\s*$/m.exec(head)?.[1] || '{}');
  const rules = t.css.replace(/^\s*\/\*[\s\S]*?\*\//, '').replace(/:root\s*\{[^{}]*\}/, '').trim();
  return { ...t, style, vars, rules };
}

const packFiles = () => (fs.existsSync(PACK) ? fs.readdirSync(PACK).filter((f) => f.endsWith('.css')).sort() : []);
function base(from) {
  const id = String(from || 'clear').toLowerCase();
  if (THEMES[id] && ['clear', 'clear-dark'].includes(id)) {
    const { label, mode, style, vars, css } = THEMES[id];
    return { name: label, mode, style, vars: Object.fromEntries(PALETTE.map((k) => [k, vars[k]])), rules: css };
  }
  const file = fs.existsSync(path.resolve(from)) && from.endsWith('.css') ? path.resolve(from) : path.join(PACK, `${id}.css`);
  if (!fs.existsSync(file)) throw new Error(`no theme ${from}: theme_list names them, or pass a .css path`);
  return read(fs.readFileSync(file, 'utf8'));
}

function write({ name, mode, style, vars, rules }) {
  const keys = [...PALETTE, ...Object.keys(vars).filter((k) => !PALETTE.includes(k))];
  return `/* intellagent-theme\nname: ${name}\nmode: ${mode}${Object.keys(style || {}).length ? `\nstyle: ${JSON.stringify(style)}` : ''}\n*/\n`
    + `:root {\n${keys.filter((k) => vars[k] != null).map((k) => `  --${k}: ${vars[k]};`).join('\n')}\n}\n${rules ? `${rules}\n` : ''}`;
}

// What the page would show: the theme as addTheme finishes it (on-accent, accent-fill), and every rule it misses.
function check(text) {
  const t = read(text);
  const v = addTheme({ id: `check-${t.id}`, name: t.name, mode: t.mode, css: text }).vars;
  delete THEMES[`check-${t.id}`];
  const rows = RULES.map(([c, g, min, what]) => {
    const ok = HEX.test(v[c] || '') && HEX.test(v[g] || '');
    const ratio = ok ? contrast(v[c], v[g]) : null;
    return { colour: c, ground: g, what, min, ratio: ratio && Math.round(ratio * 100) / 100, pass: ratio != null && ratio >= min };
  });
  return { id: t.id, name: t.name, mode: t.mode, style: t.style, onAccent: v['on-accent'], accentFill: v['accent-fill'], fails: rows.filter((r) => !r.pass), rows };
}

const report = (file, c) => [
  `${file}: ${c.name} (${c.mode}, id ${c.id}) imports cleanly.`,
  c.fails.length ? `${c.fails.length} contrast rule(s) missed:` : 'Every contrast rule holds.',
  ...c.fails.map((r) => `  - --${r.colour} on --${r.ground} (${r.what}): ${r.ratio ?? 'not a hex colour'}, needs ${r.min}`),
  `The page will draw accent buttons as ${c.onAccent} on ${c.accentFill}.`,
  '', JSON.stringify(c.rows),
].join('\n');

const TOOLS = [
  ['theme_guide', 'START HERE: how a theme file is made (themes/README.md): the header, the palette every theme sets, the style options, and what an import strips.', {}, [],
    () => fs.readFileSync(path.join(PACK, 'README.md'), 'utf8')],
  ['theme_list', 'The themes to start from: clear and clear-dark (built in) and the pack in themes/, each with its mode.', {}, [],
    () => ['clear (light, built in)', 'clear-dark (dark, built in)', ...packFiles().map((f) => {
      try { const t = read(fs.readFileSync(path.join(PACK, f), 'utf8')); return `${t.id} (${t.mode})`; } catch (e) { return `${f}: ${e.message}`; }
    })].join('\n')],
  ['theme_new', 'Write <dir>/<name>.css from a starting theme with your palette and style on top, then check it. Change it with any editor and theme_check again.', {
    dir: { type: 'string', description: 'Folder to write the file into' },
    name: { type: 'string', description: 'The name shown in the theme list' },
    from: { type: 'string', description: 'Theme to start from: an id from theme_list or a .css path (default clear)' },
    mode: { type: 'string', enum: ['light', 'dark'], description: 'Default: the starting theme\'s' },
    palette: { type: 'object', description: 'Colours to set, without the dashes: { "bg": "#101418", "accent": "#5fb3ff" }' },
    style: { type: 'object', description: 'Look options merged over the starting theme\'s (themes/README.md, style:)' },
    overwrite: { type: 'boolean', description: 'Replace a file of the same name (default: refuse)' },
  }, ['dir', 'name'], ({ dir, name, from, mode, palette, style, overwrite }) => {
    if (mode && mode !== 'light' && mode !== 'dark') throw new Error('mode is light or dark');
    const b = base(from);
    const vars = { ...b.vars };
    for (const [k, c] of Object.entries(palette || {})) {
      const key = k.replace(/^--/, '');
      if (PALETTE.includes(key) && !HEX.test(c)) throw new Error(`--${key} must be #rgb or #rrggbb, not ${c}`);
      vars[key] = c;
    }
    const text = write({ name, mode: mode || b.mode, style: { ...b.style, ...style }, vars, rules: b.rules });
    const c = check(text); // a file the board would refuse is never written
    fs.mkdirSync(path.resolve(dir), { recursive: true });
    const file = path.join(path.resolve(dir), `${c.id}.css`);
    if (fs.existsSync(file) && !overwrite) throw new Error(`${file} exists: edit it and theme_check, or pass overwrite: true`);
    fs.writeFileSync(file, text);
    return report(file, c);
  }],
  ['theme_check', 'Check a theme file as the board imports it, and report every contrast rule it misses with the ratio it has.', {
    path: { type: 'string', description: 'The .css file' },
  }, ['path'], ({ path: p }) => {
    const file = path.resolve(String(p || ''));
    if (!fs.existsSync(file)) throw new Error(`no file ${file}`);
    return report(file, check(fs.readFileSync(file, 'utf8')));
  }],
];

if (launched(module, __filename)) {
  serve({ name: 'intellagent-themes', version: VERSION, tools: TOOLS,
    instructions: 'Makes Intellagent themes. Call theme_guide first; then theme_list, theme_new, edit the file, theme_check until every contrast rule holds. Nothing here touches a board: the human imports the finished file.' });
}

module.exports = { TOOLS, check, read, write };
