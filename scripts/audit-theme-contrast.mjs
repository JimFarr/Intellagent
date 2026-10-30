import fs from 'node:fs';
const hex = (s) => /^#[0-9a-f]{6}$/i.test(s || '');
const full = (s) => (/^#[0-9a-f]{3}$/i.test(s || '') ? '#' + [...s.slice(1)].map((c) => c + c).join('') : s);
const lin = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
const lum = (h) => { const [r, g, b] = lin(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const checks = [['text', 'surface', 7], ['muted', 'surface', 4.5], ['muted', 'bg', 4.5], ['accent', 'surface', 4.5], ['on-accent', 'accent', 4.5], ['ok', 'surface', 4.5], ['warn', 'surface', 4.5], ['danger', 'surface', 4.5]];
let n = 0, bad = 0;
const tally = {};
for (const f of fs.readdirSync('themes').filter((f) => f.endsWith('.css'))) {
  const css = fs.readFileSync('themes/' + f, 'utf8');
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] || '';
  const v = { 'on-accent': '#ffffff' };
  for (const m of root.matchAll(/--([\w-]+):\s*(#[0-9a-f]{3,6})\b/gi)) v[m[1]] = full(m[2]);
  n++;
  const miss = checks.filter(([a, b, min]) => hex(v[a]) && hex(v[b]) && cr(v[a], v[b]) < min).map(([a, b, min]) => { tally[a] = (tally[a] || 0) + 1; return `${a}/${b} ${cr(v[a], v[b]).toFixed(1)}`; });
  if (miss.length) { bad++; console.log(f + ': ' + miss.join(', ')); }
}
console.log(n, 'themes,', bad, 'with a miss', JSON.stringify(tally));
