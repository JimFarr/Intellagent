'use strict';
// Theme palettes: text on accent fills (--on-accent on --accent-fill), and text tinted by a group colour
// (--tag-0…7), reach WCAG AA, 4.5:1, in every theme.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The theme table lives inside the browser app; evaluate just that slice of public/app.js.
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const from = src.indexOf('  // Palette colours are'), to = src.indexOf('  // Strength of each generated pattern');
const { THEMES, themeTags, contrast, oklab } = new Function(`${src.slice(from, to)}; return { THEMES, themeTags, contrast, oklab };`)();

// color-mix(in oklab, x p, y): back from oklab to #rrggbb.
const fromOklab = ([L, a, b]) => {
  const [l, m, s] = [L + 0.3963377774 * a + 0.2158037573 * b, L - 0.1055613458 * a - 0.0638541728 * b, L - 0.0894841775 * a - 1.291485548 * b].map((c) => c ** 3);
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${lin.map((c) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055))).toString(16).padStart(2, '0')).join('')}`;
};
const mix = (x, p, y) => fromOklab(oklab(x).map((c, i) => c * p + oklab(y)[i] * (1 - p)));

// Where a group colour carries text: [label, share of the tag in the text, share in its ground, ground, the rule in
// public/app.css that sets that text colour]. If app.css changes a share, change it here and in TAG_TEXT (app.js).
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
const GROUP_TEXT = [
  ['cover head', 0.42, 0.09, 'surface', /\[data-groups="cover"\] \.group-head \{[^}]*color: color-mix\(in oklab, var\(--tagc\) 42%, var\(--text\)\)/],
  ['tab head', 0.40, 0.14, 'surface', /\[data-groups="tab"\] \.group-head \{[^}]*background: color-mix\(in oklab, var\(--tagc\) 14%, var\(--surface\)\); color: color-mix\(in oklab, var\(--tagc\) 40%, var\(--text\)\)/],
  ['parent chip', 0.75, 0.17, 'surface', /\.chip\.parent \{[^}]*17%, transparent\); color: color-mix\(in oklab, var\(--tagc\) 75%, var\(--text\)\)/],
  ['group head', 0.50, 0, 'panel', /\n\.group-head \{[^}]*color: color-mix\(in oklab, var\(--tagc\) 50%, var\(--text\)\)/],
];

describe('theme palettes', () => {
  it('evaluates the theme table', () => {
    assert.ok(from > 0 && to > from, 'markers around the theme table in public/app.js');
    assert.ok(Object.keys(THEMES).length > 30);
  });

  for (const [k, t] of Object.entries(THEMES)) {
    it(`${k}: text on the accent fill is 4.5:1 or more`, () => {
      const v = t.vars, c = contrast(v['on-accent'], v['accent-fill']);
      assert.ok(c >= 4.5, `${v['on-accent']} on ${v['accent-fill']} is ${c.toFixed(2)}:1`);
    });
  }

  it('the group text shares match public/app.css', () => {
    for (const [where, , , , rule] of GROUP_TEXT) assert.match(css, rule, where);
  });

  for (const [k, t] of Object.entries(THEMES)) {
    it(`${k}: group colours are eight, and text on them is 4.5:1 or more`, () => {
      const v = t.vars, tags = themeTags(t), bad = [];
      assert.equal(tags.length, 8);
      for (let i = 0; i < 8; i++) {
        const c = tags[i];
        assert.match(c || '', /^#[0-9a-f]{6}$/i, `tag-${i}`);
        for (const [where, inText, inGround, ground] of GROUP_TEXT) {
          const r = contrast(mix(c, inText, v.text), mix(c, inGround, v[ground]));
          if (r < 4.5) bad.push(`tag-${i} ${c} ${where} ${r.toFixed(2)}`);
        }
      }
      assert.deepEqual(bad, []);
    });
  }

  it('leaves --accent alone; only the fill deepens', () => {
    for (const t of Object.values(THEMES)) assert.match(t.vars.accent, /^#[0-9a-f]{6}$/i);
    for (const [k, t] of Object.entries(THEMES)) if (t.vars['accent-fill'] !== t.vars.accent) assert.equal(t.vars['on-accent'], '#fff', k);
  });
});
