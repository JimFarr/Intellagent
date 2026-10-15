'use strict';
// The card markdown renderer (md, inline) never lets the ticket-ref, mention or emphasis passes reach inside a tag's
// attributes: a rule that rewrote an href or alt would be one step from stored XSS from any agent comment.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The renderer lives inside the browser app; evaluate just that slice of public/app.js.
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const escLine = /^ {2}const esc = .*$/m.exec(src)[0];
const from = src.indexOf('  /* ═════════════════════════ markdown'), to = src.indexOf("  document.addEventListener('click'", from);
const { md } = new Function(`${escLine}\n${src.slice(from, to)}; return { md };`)();

// Every attribute value in the output, and the output with them blanked.
const attrs = (html) => [...html.matchAll(/\s[\w-]+="([^"]*)"/g)].map((m) => m[1]);
const text = (html) => html.replace(/<[^>]*>/g, '');

describe('markdown renderer', () => {
  it('evaluates the renderer', () => {
    assert.ok(from > 0 && to > from, 'markers around the markdown block in public/app.js');
    assert.equal(md('**a**'), '<p><strong>a</strong></p>');
  });

  it('keeps ticket refs out of a link href', () => {
    const html = md('[x](https://h/?id=INT-12&b=OPS-3)');
    assert.deepEqual(attrs(html), ['https://h/?id=INT-12&amp;b=OPS-3', '_blank', 'noopener']);
    assert.equal(text(html), 'x');
  });

  it('keeps ticket refs out of a bare URL', () => {
    const html = md('see https://h/INT-12/x_y_z done');
    assert.match(html, /<a href="https:\/\/h\/INT-12\/x_y_z" target="_blank" rel="noopener">https:\/\/h\/INT-12\/x_y_z<\/a>/);
    assert.ok(!html.includes('class="ref"'));
  });

  it('keeps mentions, refs and emphasis out of image alt and src', () => {
    const html = md('![a @bob INT-4 _x_](https://h/@bob/INT-4_a_.png)');
    assert.deepEqual(attrs(html), ['a @bob INT-4 _x_', 'https://h/@bob/INT-4_a_.png', 'lazy']);
  });

  it('keeps underscores and asterisks in a URL as they are', () => {
    const html = md('[a](https://h/a_b_c*d*) and _real_');
    assert.equal(attrs(html)[0], 'https://h/a_b_c*d*');
    assert.match(html, /<em>real<\/em>/);
  });

  it('still renders refs and mentions in plain text and link text', () => {
    const html = md('INT-7 for @nebula, see [INT-9](#x)');
    assert.match(html, /<a class="ref" data-ref="INT-7">INT-7<\/a>/);
    assert.match(html, /<span class="mention">@nebula<\/span>/);
    assert.match(html, /<a href="#x"[^>]*>INT-9<\/a>/);
  });

  it('never nests a ref link inside a link', () => {
    const html = md('[see INT-9 now](https://h/)');
    assert.equal((html.match(/<a\b/g) || []).length, 1);
  });

  it('drops links and images with an unsafe URL', () => {
    assert.ok(!md('[x](javascript:alert(1))').includes('href'));
    assert.ok(!md('![x](javascript:alert(1))').includes('<img'));
  });

  it('escapes quotes so text cannot leave an attribute', () => {
    const html = md('[x](https://h/"onmouseover="alert(1)) ![a" onerror="x](https://h/i.png)');
    const names = [...html.matchAll(/<\w+((?:\s[\w-]+="[^"]*")*)\s*>/g)].flatMap((m) => [...m[1].replace(/"[^"]*"/g, '').matchAll(/\s([\w-]+)=/g)].map((n) => n[1]));
    assert.deepEqual(names, ['href', 'target', 'rel', 'alt', 'src', 'loading']);
    assert.equal(attrs(html)[3], 'a&quot; onerror=&quot;x');
  });

  it('ignores placeholder control characters typed into the text', () => {
    const html = md('[x](https://h/) \u00020\u0002 \u00010\u0001 `c`');
    assert.equal((html.match(/<a\b/g) || []).length, 1);
    assert.equal((html.match(/<code>/g) || []).length, 1);
  });
});
