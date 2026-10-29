// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Integration plugins (INT-462): added off, enabled by the human with a pinned hash, run in a node process that
// reads only its own folder and gets nothing of the board's.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { startServer, until, USER } = require('./helpers');
const { validate, unzip } = require('../lib/plugins');

// The fake plugin answers "test" with what it could and couldn't do from inside its sandbox.
const FAKE_MAIN = `
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const helper = require('./lib/helper.js');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const tryIt = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code || e.message; } };
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); handle(JSON.parse(line)); }
});
function handle(m) {
  const token = m.connection.token;
  if (token === 'crash') process.exit(3);
  if (token === 'event') { send({ type: 'event', event: 'ping', data: { n: 1 } }); send({ type: 'event', event: 'undeclared', data: {} }); }
  const probe = {
    readLocal: tryIt(() => fs.readFileSync(m.connection.probe, 'utf8')),
    readSibling: tryIt(() => fs.readFileSync(path.join(__dirname, '..', 'fake-2', 'x.txt'), 'utf8')),
    writeData: tryIt(() => fs.writeFileSync(path.join(__dirname, 'data', 'x.txt'), 'x')),
    writeOwn: tryIt(() => fs.writeFileSync(path.join(__dirname, 'index.js'), 'x')),
    spawn: tryIt(() => require('node:child_process').execFileSync(process.execPath, ['-e', '1'])),
    env: Object.keys(process.env).filter((k) => /INTELLAGENT|SECRET/i.test(k)),
    helper, https: typeof https.request, token,
  };
  send({ id: m.id, ok: true, result: { message: JSON.stringify(probe) } });
}
`;
const FAKE_JSON = {
  name: 'fake', label: 'Fake', version: '1.0.0', description: 'A plugin for the tests',
  connection: [{ key: 'token', label: 'Token', type: 'text', secret: true, required: true }, { key: 'probe', type: 'text' }],
  hosts: ['example.com'],
  actions: [{ id: 'post', inputs: [{ key: 'channel', type: 'text', required: true }] }],
  events: [{ id: 'ping', fields: ['n'] }],
  webhook: true,
};
function pluginFolder(json = FAKE_JSON, main = FAKE_MAIN) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-plugin-'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(json));
  fs.writeFileSync(path.join(dir, 'index.js'), main);
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'helper.js'), 'module.exports = 42;');
  return dir;
}
// A stored (uncompressed) zip of { name: text }.
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body), n = Buffer.from(name), crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    centrals.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('plugin.json: strict, with every problem named', () => {
  const dir = pluginFolder();
  assert.deepStrictEqual(validate(FAKE_JSON, 'fake', dir).problems, []);
  const { problems } = validate({ ...FAKE_JSON, colour: 'red', entry: '../x.js', actions: [{ id: 'a', inputs: [{ key: 'k', type: 'blob' }] }, { id: 'a' }] }, 'other', dir);
  for (const want of ['colour: unknown key', 'must match its folder', 'entry:', 'actions[0].inputs[0].type: "blob"', 'actions: "a" appears twice']) {
    assert.ok(problems.some((p) => p.includes(want)), `${want} in ${JSON.stringify(problems)}`);
  }
  // needs.read never opens a whole drive, the board's folder, or anything holding it
  const board = path.join(dir, 'board');
  const read = (r) => validate({ ...FAKE_JSON, needs: { read: [r] } }, 'fake', dir, [board]).problems;
  assert.ok(read(path.parse(dir).root).some((p) => p.includes('whole drive')));
  assert.ok(read(board).some((p) => p.includes("board's own")));
  assert.ok(read(path.join(board, 'data')).some((p) => p.includes("board's own")));
  assert.ok(read(dir).some((p) => p.includes("board's own")));
  assert.deepStrictEqual(read(path.join(dir, 'elsewhere')), []);
});

test('unzip: unwraps one top folder, refuses paths that leave it', () => {
  const files = unzip(zip({ 'p/plugin.json': '{}', 'p/lib/a.js': 'x' }));
  assert.deepStrictEqual(files.map((f) => f.name).sort(), ['lib/a.js', 'plugin.json']);
  assert.throws(() => unzip(zip({ '../evil.js': 'x' })), /outside the plugin folder/);
  assert.throws(() => unzip(zip({ 'C:/evil.js': 'x' })), /outside the plugin folder/);
  assert.throws(() => unzip(zip({ 'index.js:hidden': 'x' })), /outside the plugin folder/);
  assert.throws(() => unzip(zip({ 'p/plugin.json': '{}', 'p/data/x.js': 'x' })), /can't ship a data\/ folder/);
  assert.throws(() => unzip(Buffer.from('not a zip at all, not even close')), /no zip directory/);
});

test('plugins: the human adds, pins and connects one; it runs sandboxed and gets nothing of the board', async () => {
  const s = await startServer({ env: { SECRET_FROM_BOARD: 'x' } });
  try {
    const local = path.join(s.dir, 'local.json');
    const src = pluginFolder();

    // agents can't add one
    const denied = await s.api('POST', '/api/plugins', { path: src });
    assert.strictEqual(denied.status, 403);
    assert.strictEqual(denied.body.code, 'HUMAN_ONLY');

    // a bad plugin.json is refused with its problems
    const bad = pluginFolder({ ...FAKE_JSON, colour: 'red' });
    const r = await s.api('POST', '/api/plugins', { path: bad }, USER);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, 'PLUGIN_INVALID');
    assert.ok(r.body.problems.some((p) => p.startsWith('colour')));

    // added: off, nothing runs; what it asks for is listed
    const added = await s.ok('POST', '/api/plugins', { path: src }, USER);
    assert.strictEqual(added.state, 'off');
    assert.strictEqual(added.running, false);
    assert.deepStrictEqual(added.asks.secrets, ['token']);
    assert.deepStrictEqual(added.asks.hosts, ['example.com']);
    assert.strictEqual(added.asks.webhook, '/hooks/fake');
    assert.strictEqual(added.actions[0].power, 'plugin.fake.post');
    assert.ok(fs.existsSync(path.join(s.dir, 'plugins', 'fake', 'lib', 'helper.js')));
    assert.strictEqual((await s.api('POST', '/api/plugins', { path: src }, USER)).body.code, 'CONFLICT');
    assert.strictEqual((await s.api('POST', '/api/plugins/fake/connection/test', {}, USER)).body.code, 'PLUGIN_OFF');

    // enabling needs the hash the human was shown
    assert.strictEqual((await s.api('POST', '/api/plugins/fake/enable', { hash: 'sha256:nope' }, USER)).body.code, 'PLUGIN_CHANGED');
    assert.strictEqual((await s.api('POST', '/api/plugins/fake/enable', { hash: added.hash })).body.code, 'HUMAN_ONLY');
    const on = await s.ok('POST', '/api/plugins/fake/enable', { hash: added.hash }, USER);
    assert.strictEqual(on.state, 'on');
    assert.strictEqual(on.enabled.by, 'James');

    // nothing saved yet: the board answers "not connected" itself
    assert.deepStrictEqual(await s.ok('POST', '/api/plugins/fake/connection/test', {}, USER), { ok: false, message: 'Not connected: token not set' });

    // the connection: secrets kept in local.json, never read back
    assert.strictEqual((await s.api('PUT', '/api/plugins/fake/connection', { values: { probe: local } }, USER)).body.code, 'BAD_REQUEST'); // token is required
    assert.strictEqual((await s.api('PUT', '/api/plugins/fake/connection', { values: { nope: 1 } }, USER)).status, 400);
    const conn = await s.ok('PUT', '/api/plugins/fake/connection', { values: { token: 'abcdefghijkl1234', probe: local } }, USER);
    assert.strictEqual(conn.connection.values.token, '••••1234');
    assert.strictEqual(conn.connection.connected, true);
    assert.strictEqual((await s.ok('GET', '/api/plugins')).plugins[0].connection.values.token, '••••1234');
    assert.strictEqual(JSON.parse(fs.readFileSync(local, 'utf8')).plugins.fake.connection.token, 'abcdefghijkl1234');
    // a key left out keeps its value
    await s.ok('PUT', '/api/plugins/fake/connection', { values: { probe: local } }, USER);
    assert.strictEqual(JSON.parse(fs.readFileSync(local, 'utf8')).plugins.fake.connection.token, 'abcdefghijkl1234');

    // inside the sandbox: its own folder only (not a sibling sharing its prefix), no programs, no board environment
    fs.mkdirSync(path.join(s.dir, 'plugins', 'fake-2'));
    fs.writeFileSync(path.join(s.dir, 'plugins', 'fake-2', 'x.txt'), 'sibling');
    const t = await s.ok('POST', '/api/plugins/fake/connection/test', {}, USER);
    assert.strictEqual(t.ok, true, JSON.stringify(t));
    const probe = JSON.parse(t.message);
    assert.strictEqual(probe.readLocal, 'ERR_ACCESS_DENIED', 'local.json must be out of reach');
    assert.strictEqual(probe.readSibling, 'ERR_ACCESS_DENIED', 'plugins/fake must not open plugins/fake-2');
    assert.strictEqual(probe.writeData, 'ok');
    assert.strictEqual(probe.writeOwn, 'ERR_ACCESS_DENIED');
    assert.strictEqual(probe.spawn, 'ERR_ACCESS_DENIED');
    assert.deepStrictEqual(probe.env, []);
    assert.strictEqual(probe.helper, 42);
    assert.strictEqual(probe.https, 'function');
    assert.strictEqual(probe.token, 'abcdefghijkl1234');
    assert.strictEqual((await s.ok('GET', '/api/plugins/fake')).connection.test.ok, true);

    // unsaved values are tried, not kept; declared events reach the board, others don't
    await s.ok('POST', '/api/plugins/fake/connection/test', { values: { token: 'event' } }, USER);
    const ev = await until(async () => (await s.ok('GET', '/api/events?since=0&types=plugin.event')).events.find((e) => e.plugin === 'fake'), 5000, 'plugin.event');
    assert.strictEqual(ev.event, 'ping');
    assert.deepStrictEqual(ev.data, { n: 1 });
    assert.deepStrictEqual(ev.recipients, []);
    assert.strictEqual((await s.ok('GET', '/api/events?since=0&types=plugin.event')).events.length, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(local, 'utf8')).plugins.fake.connection.token, 'abcdefghijkl1234');

    // a crash answers the call and the plugin comes back
    const crash = await s.ok('POST', '/api/plugins/fake/connection/test', { values: { token: 'crash' } }, USER);
    assert.strictEqual(crash.ok, false);
    await until(async () => (await s.api('POST', '/api/plugins/fake/connection/test', {}, USER)).body.ok === true, 8000, 'restart');
    assert.strictEqual((await s.ok('GET', '/api/plugins/fake')).crashes.count, 1);

    // changed files stop it until enabled again
    fs.appendFileSync(path.join(s.dir, 'plugins', 'fake', 'lib', 'helper.js'), '\n// changed');
    assert.strictEqual((await s.ok('GET', '/api/plugins/fake')).state, 'changed');
    assert.strictEqual((await s.api('POST', '/api/plugins/fake/connection/test', {}, USER)).body.code, 'PLUGIN_CHANGED');
    const again = await s.ok('GET', '/api/plugins/fake');
    assert.strictEqual((await s.ok('POST', '/api/plugins/fake/enable', { hash: again.hash }, USER)).state, 'on');

    // off, then gone with its connection, even when it is running again (Windows holds the folder until the process exits)
    assert.strictEqual((await s.ok('POST', '/api/plugins/fake/disable', {}, USER)).state, 'off');
    const off = await s.ok('GET', '/api/plugins/fake');
    assert.strictEqual((await s.ok('POST', '/api/plugins/fake/enable', { hash: off.hash }, USER)).state, 'on');
    assert.strictEqual((await s.ok('POST', '/api/plugins/fake/connection/test', {}, USER)).ok, true);
    assert.deepStrictEqual(await s.ok('DELETE', '/api/plugins/fake', undefined, USER), { removed: 'fake', grantsDropped: [], runsCanceled: 0 });
    assert.ok(!fs.existsSync(path.join(s.dir, 'plugins', 'fake')));
    assert.strictEqual(JSON.parse(fs.readFileSync(local, 'utf8')).plugins?.fake, undefined);
    const types = (await s.ok('GET', '/api/events?since=0&types=plugin.*')).events.map((e) => e.type);
    for (const want of ['plugin.added', 'plugin.enabled', 'plugin.connection', 'plugin.disabled', 'plugin.removed']) assert.ok(types.includes(want), want);
  } finally { await s.stop(); }
});

test('plugins: added from a zip; a zip that leaves its folder is refused', async () => {
  const s = await startServer();
  try {
    const json = JSON.stringify({ name: 'zipped', actions: [] });
    const good = await s.api('POST', '/api/plugins', { zipBase64: zip({ 'zipped/plugin.json': json, 'zipped/index.js': '' }).toString('base64'), filename: 'zipped.zip' }, USER);
    assert.strictEqual(good.status, 201, JSON.stringify(good.body));
    assert.strictEqual(good.body.state, 'off');
    const evil = await s.api('POST', '/api/plugins', { zipBase64: zip({ 'plugin.json': json, '../evil.js': 'x' }).toString('base64') }, USER);
    assert.strictEqual(evil.status, 400);
    assert.ok(!fs.existsSync(path.join(s.dir, 'evil.js')));
    assert.deepStrictEqual(fs.readdirSync(path.join(s.dir, 'plugins')), ['zipped']); // no staging folder left behind
  } finally { await s.stop(); }
});
