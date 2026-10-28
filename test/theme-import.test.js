// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Themes as CSS files (INT-465): import, list, remove, and what an import strips.
const { describe, it: test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, USER } = require('./helpers');

const PALETTE = '--bg:#101010;--panel:#181818;--surface:#202020;--text:#f0f0f0;--muted:#a0a0a0;--border:#303030;--accent:#88aaff;--accent-2:#aa88ff;--issue:#ff8888;--task:#88aaff;--spike:#ffcc66;--ok:#66cc88;--warn:#ffaa55;--danger:#ff6666;--blob1:#335;--blob2:#353;--blob3:#533;';
const theme = (head, body = '') => `/* intellagent-theme\n${head}\n*/\n:root{${PALETTE}}\n${body}`;

let s;
describe('theme import', () => {
  before(async () => { s = await startServer(); });
  after(async () => { await s.stop(); });

  test('import, list and remove', async () => {
    assert.deepEqual((await s.ok('GET', '/api/themes')).themes, []);
    const t = await s.ok('POST', '/api/themes', { css: theme('name: Night Owl\nmode: dark\nstyle: {"cards":"clean"}', '.col-name { color: var(--accent); }') }, USER);
    assert.equal(t.id, 'night-owl');
    assert.equal(t.mode, 'dark');
    assert.deepEqual((await s.ok('GET', '/api/themes')).themes.map((x) => x.id), ['night-owl']);
    await s.ok('DELETE', '/api/themes/night-owl', null, USER);
    assert.deepEqual((await s.ok('GET', '/api/themes')).themes, []);
    assert.equal((await s.api('DELETE', '/api/themes/night-owl', null, USER)).status, 404);
  });

  test('an import cannot reach the internet', async () => {
    const t = await s.ok('POST', '/api/themes', {
      css: theme('name: Leaky\nmode: light', '@import url(https://evil.example/x.css);\n.a { background: url(https://evil.example/p.png); }\n.b { background: url("data:image/png;base64,AAAA"); }\n.c { background: u\\rl(https://evil.example/q.png); }'),
    }, USER);
    assert.doesNotMatch(t.css, /evil\.example|@import/);
    assert.match(t.css, /data:image\/png/, 'data: URLs stay');
  });

  test('refuses what it cannot use, and agents', async () => {
    const bad = async (css) => (await s.api('POST', '/api/themes', { css }, USER)).status;
    assert.equal(await bad('.a { color: red }'), 400, 'no header');
    assert.equal(await bad(theme('name: X\nmode: purple')), 400, 'mode');
    assert.equal(await bad(theme('name: Clear\nmode: light')), 400, 'built-in name');
    assert.equal(await bad(`/* intellagent-theme\nname: Thin\nmode: dark\n*/\n:root{--bg:#000}`), 400, 'palette incomplete');
    assert.equal((await s.api('POST', '/api/themes', { css: theme('name: Agent\nmode: dark') })).status, 403, 'human only');
  });
});
