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
const { THEMES, THEME_KINDS, themeGroups, contrast, oklab } = new Function(`${src.slice(from, to)}; return { THEMES, THEME_KINDS, themeGroups, contrast, oklab };`)();

// color-mix(in oklab, x p, y): back from oklab to #rrggbb.
const fromOklab = ([L, a, b]) => {
  const [l, m, s] = [L + 0.3963377774 * a + 0.2158037573 * b, L - 0.1055613458 * a - 0.0638541728 * b, L - 0.0894841775 * a - 1.291485548 * b].map((c) => c ** 3);
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${lin.map((c) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055))).toString(16).padStart(2, '0')).join('')}`;
};
const mix = (x, p, y) => fromOklab(oklab(x).map((c, i) => c * p + oklab(y)[i] * (1 - p)));

// Where a group colour carries text: [label, the theme's share variable, share of the tag in its ground, ground, the
// rule in public/app.css that sets that text and its ground]. If app.css changes one, change it here and in TAG_TEXT.
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
const GROUP_TEXT = [
  ['cover head', 'tag-cover', 0.09, 'surface', /\[data-groups="cover"\] \.group-head \{[^}]*background: color-mix\(in oklab, var\(--tagc\) 9%, var\(--surface\)\);[^}]*color: color-mix\(in oklab, var\(--tagc\) var\(--tag-cover, 42%\), var\(--text\)\)/],
  ['tab head', 'tag-tab', 0.14, 'surface', /\[data-groups="tab"\] \.group-head \{[^}]*background: color-mix\(in oklab, var\(--tagc\) 14%, var\(--surface\)\); color: color-mix\(in oklab, var\(--tagc\) var\(--tag-tab, 40%\), var\(--text\)\)/],
  ['parent chip', 'tag-chip', 0.17, 'surface', /\.chip\.parent \{[^}]*17%, transparent\); color: color-mix\(in oklab, var\(--tagc\) var\(--tag-chip, 55%\), var\(--text\)\)/],
  ['group head', 'tag-head', 0, 'panel', /\n\.group-head \{[^}]*background: none; color: color-mix\(in oklab, var\(--tagc\) var\(--tag-head, 50%\), var\(--text\)\)/],
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

  it('every theme is listed under exactly one kind in Appearance (INT-222)', () => {
    const listed = THEME_KINDS.flatMap(([, , keys]) => keys);
    assert.deepEqual([...listed].sort(), Object.keys(THEMES).sort());
    assert.equal(new Set(listed).size, listed.length, 'no theme in two kinds');
  });

  it('the group text rules match public/app.css', () => {
    for (const [where, , , , rule] of GROUP_TEXT) assert.match(css, rule, where);
  });

  for (const [k, t] of Object.entries(THEMES)) {
    it(`${k}: eight group colours that show on the surface, and text tinted by them is 4.5:1 or more`, () => {
      const v = t.vars, { tags, count, shares } = themeGroups(t), bad = [];
      assert.equal(tags.length, 8);
      assert.ok(count >= 2 && count <= 8, `${count} distinct colours`);
      assert.equal(new Set(tags.slice(0, count)).size, count, 'the first `count` colours differ');
      for (const [i, c] of tags.entries()) {
        assert.match(c, /^#[0-9a-f]{6}$/i, `tag-${i}`);
        if (contrast(c, v.surface) < 3) bad.push(`tag-${i} ${c} on the surface ${contrast(c, v.surface).toFixed(2)}`);
        for (const [where, key, inGround, ground] of GROUP_TEXT) {
          const r = contrast(mix(c, shares[key] / 100, v.text), mix(c, inGround, v[ground]));
          if (r < 4.5) bad.push(`tag-${i} ${c} ${where} at ${shares[key]}%: ${r.toFixed(2)}`);
        }
      }
      assert.deepEqual(bad, []);
    });
  }

  // The focus strip (INT-223, INT-224): its quiet text leans from --muted toward --text, on the surface or an accent tint.
  it('every theme: quiet text on the focus strip is 4.5:1 or more', () => {
    const bar = css.match(/\n\.focusbar \{[^}]*--fb-muted: color-mix\(in oklab, var\(--muted\) (\d+)%, var\(--text\)\);[^}]*background: (?:color-mix\(in oklab, var\(--accent\) (\d+)%, var\(--surface\)\)|var\(--surface\));/);
    assert.ok(bar, '.focusbar sets --fb-muted and its background in public/app.css');
    assert.doesNotMatch(css, /\n\.focusbar\.viewing \{[^}]*background/, 'the test covers the base strip\'s background only');
    const [share, tint] = [bar[1] / 100, (bar[2] || 0) / 100], bad = [];
    for (const [k, t] of Object.entries(THEMES)) {
      const v = t.vars, r = contrast(mix(v.muted, share, v.text), mix(v.accent, tint, v.surface));
      if (r < 4.5) bad.push(`${k} ${r.toFixed(2)}`);
    }
    assert.deepEqual(bad, []);
  });

  // A met gate's pill (INT-104): --ok 20% into the text, on --ok 14% over the surface. If app.css changes the rule,
  // change the shares here. (--ok is one bright green for every theme: 55%, the first design, is 2.8:1 on the light
  // themes, and 35% still 3.8:1 on latte.)
  const ok = /--ok: (#[0-9a-f]{6})/i.exec(css)?.[1];
  it('the met gate pill rule matches public/app.css', () => {
    assert.ok(ok, '--ok in :root');
    assert.match(css, /\.gate\.met \{ background: color-mix\(in oklab, var\(--ok\) 14%, transparent\); color: color-mix\(in oklab, var\(--ok\) 20%, var\(--text\)\); \}/);
  });
  for (const [k, t] of Object.entries(THEMES)) {
    it(`${k}: a met gate's text is 4.5:1 or more`, () => {
      const v = t.vars, r = contrast(mix(ok, 0.2, v.text), mix(ok, 0.14, v.surface));
      assert.ok(r >= 4.5, `${r.toFixed(2)}:1`);
    });
  }

  it('leaves --accent alone; only the fill deepens', () => {
    for (const t of Object.values(THEMES)) assert.match(t.vars.accent, /^#[0-9a-f]{6}$/i);
    for (const [k, t] of Object.entries(THEMES)) if (t.vars['accent-fill'] !== t.vars.accent) assert.equal(t.vars['on-accent'], '#fff', k);
  });
});
