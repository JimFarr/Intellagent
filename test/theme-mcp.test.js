'use strict';
// INT-500: the theme authoring MCP writes a file the board imports, and reports contrast it misses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TOOLS } = require('../theme-mcp');
const { parse } = require('../lib/themes');

const tool = (name) => TOOLS.find(([n]) => n === name)[4];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'theme-mcp-'));

test('theme_new writes an importable file from a starting theme, with the palette on top', () => {
  const dir = tmp();
  const out = tool('theme_new')({ dir, name: 'Night Owl', from: 'clear-dark', palette: { accent: '#7fdbca', '--bg': '#011627' }, style: { cards: 'clean' } });
  const file = path.join(dir, 'night-owl.css');
  const css = fs.readFileSync(file, 'utf8');
  const t = parse(css);
  assert.deepStrictEqual([t.id, t.mode], ['night-owl', 'dark']);
  assert.match(css, /--accent: #7fdbca;/);
  assert.match(css, /--bg: #011627;/);
  assert.match(css, /"cards":"clean"/);
  assert.match(out, /imports cleanly/);
  assert.match(tool('theme_list')({}), /^clear \(light, built in\)/);
});

test('theme_check names each contrast rule a theme misses; a bad colour is never written', () => {
  const dir = tmp();
  const out = tool('theme_new')({ dir, name: 'Faint', from: 'clear', palette: { muted: '#cccccc', warn: '#fafafa' } });
  assert.match(out, /--muted on --surface \(secondary text\): 1\.\d+, needs 4\.5/);
  assert.match(out, /--warn on --surface/);
  assert.match(tool('theme_check')({ path: path.join(dir, 'faint.css') }), /contrast rule\(s\) missed/);
  assert.throws(() => tool('theme_new')({ dir, name: 'Bad', palette: { bg: 'red' } }), /#rgb or #rrggbb/);
  assert.throws(() => tool('theme_new')({ dir, name: 'Clear' }), /built-in/);
  assert.ok(!fs.existsSync(path.join(dir, 'bad.css')));
});

test('the server answers MCP over stdio through the CLI', () => {
  const input = ['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}', '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'].join('\n') + '\n';
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'intellagent.js'), 'theme-mcp'], { input, encoding: 'utf8', timeout: 20000 });
  const [init, list] = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(init.result.serverInfo.name, 'intellagent-themes');
  assert.deepStrictEqual(list.result.tools.map((t) => t.name), ['theme_guide', 'theme_list', 'theme_new', 'theme_check']);
});
