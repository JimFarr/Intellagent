'use strict';
// Writes every theme in a themes table as a .css file the board can import (Settings › Appearance).
// Usage: node scripts/export-themes.js <path to a themes.js with the full table> [out folder, default themes/]
const fs = require('node:fs');
const path = require('node:path');

const { THEMES } = require(path.resolve(process.argv[2] || 'public/js/themes.js'));
const out = path.resolve(process.argv[3] || 'themes');
fs.mkdirSync(out, { recursive: true });
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

for (const [key, t] of Object.entries(THEMES)) {
  if (key === 'clear' || key === 'clear-dark') continue; // built into the page
  const style = JSON.stringify(t.style);
  const vars = Object.entries(t.vars).map(([k, v]) => `  --${k}: ${v};`).join('\n');
  const rules = (t.css || '').trim().replace(/\}\s*/g, '}\n').trim();
  const text = `/* intellagent-theme\nname: ${t.label}\nmode: ${t.mode}\nstyle: ${style}\n*/\n:root {\n${vars}\n}\n${rules ? `${rules}\n` : ''}`;
  fs.writeFileSync(path.join(out, `${slug(t.label)}.css`), text);
}
console.log(`wrote ${Object.keys(THEMES).length - 2} themes to ${out}`);
