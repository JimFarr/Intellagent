'use strict';
// Theme palettes: text on accent fills (--on-accent on --accent-fill) reaches WCAG AA, 4.5:1, in every theme.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The theme table lives inside the browser app; evaluate just that slice of public/app.js.
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const from = src.indexOf('  // Palette colours are'), to = src.indexOf('  // Strength of each generated pattern');
const { THEMES, contrast } = new Function(`${src.slice(from, to)}; return { THEMES, contrast };`)();

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

  it('leaves --accent alone; only the fill deepens', () => {
    for (const t of Object.values(THEMES)) assert.match(t.vars.accent, /^#[0-9a-f]{6}$/i);
    for (const [k, t] of Object.entries(THEMES)) if (t.vars['accent-fill'] !== t.vars.accent) assert.equal(t.vars['on-accent'], '#fff', k);
  });
});
