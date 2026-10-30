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
const HUMAN = USER;
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
  if (m.type === 'run') return send(m.inputs.channel.endsWith('fail') ? { id: m.id, ok: false, error: 'no such channel' } : { id: m.id, ok: true, result: { message: 'posted to ' + m.inputs.channel, ticket: m.ticket, item: m.item } });
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
    assert.deepStrictEqual(ev.data, { n: '1' }); // a bare field name is a text field
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

test('plugin actions as powers: only the human grants them, the grant scopes the inputs, runs wait for the human when it says so (INT-473)', async () => {
  const USER = { ...HUMAN, token: 'u-473' }; // grants are set only by a human the board can tell is one
  const s = await startServer({ manifest: { auth: { userToken: 'u-473' } }, agents: { agents: {
    ann: { enabled: false, grants: [{ power: 'plugin.fake.post', where: { channel: ['#deploys', '#ops-*'] } }] },
    bob: { enabled: false, grants: [{ power: 'plugin.fake.post', approve: 'human' }] },
    cal: { enabled: false, grants: [{ power: 'plugin.fake.post', where: { nope: 'x' } }, 'plugin.fake.ghost'] }, // both ignored
  } } });
  const ANN = { agent: 'ann' }, BOB = { agent: 'bob' };
  const run = (inputs, as, extra = {}) => s.api('POST', '/api/plugins/fake/actions/post/run', { inputs, ...extra }, as);
  const runEvents = async (id) => (await s.ok('GET', '/api/events?since=0&types=plugin.run.*')).events.filter((e) => e.runId === id);
  try {
    const added = await s.ok('POST', '/api/plugins', { path: pluginFolder() }, USER);
    // off: the grant is no power yet
    assert.deepStrictEqual(added.actions[0].holders, []);
    assert.strictEqual((await run({ channel: '#deploys' }, ANN)).body.code, 'PLUGIN_OFF');
    assert.strictEqual((await s.api('POST', '/api/agents', { name: 'ann', grants: ['plugin.fake.post'] }, USER)).body.code, 'BAD_REQUEST');
    await s.ok('POST', '/api/plugins/fake/enable', { hash: added.hash }, USER);
    assert.strictEqual((await run({ channel: '#deploys' }, ANN)).body.code, 'NOT_CONNECTED');
    await s.ok('PUT', '/api/plugins/fake/connection', { values: { token: 'abcdefghijkl1234' } }, USER);

    // on: who holds it; a grant scoped on an input the action doesn't take is dropped, never widened
    assert.deepStrictEqual((await s.ok('GET', '/api/plugins/fake')).actions[0].holders, [
      { name: 'ann', where: { channel: ['#deploys', '#ops-*'] } }, { name: 'bob', approve: 'human' }]);
    assert.strictEqual((await run({ channel: '#deploys' }, { agent: 'cal' })).body.code, 'FORBIDDEN');
    assert.strictEqual((await run({ channel: '#deploys' }, { agent: 'tester' })).body.code, 'FORBIDDEN');

    // inputs are checked against the declared types first, then the grant's scope
    assert.strictEqual((await run({}, { agent: 'tester' })).status, 400);
    assert.strictEqual((await run({ channel: '#deploys', nope: 1 }, ANN)).status, 400);
    const out = await run({ channel: '#random' }, ANN);
    assert.strictEqual(out.status, 403);
    assert.strictEqual(out.body.code, 'OUT_OF_SCOPE');
    assert.match(out.body.error, /channel is "#random"/);

    // in scope: it runs, and the outcome is in the reply, so it wakes nobody
    const card = await s.ok('POST', '/api/boards/main/items', { title: 'Deploy', description: 'not for the plugin', properties: { pr: 7 } }, USER);
    const ok = await run({ channel: '#ops-alerts' }, ANN, { item: card.id.toLowerCase() });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.status, 'succeeded');
    // the plugin has no board address or token: it gets the ticket's own data (INT-464's contract), no bare id
    assert.deepStrictEqual(ok.body.result, { message: 'posted to #ops-alerts', ticket: { id: card.id, title: 'Deploy', fields: {}, properties: { pr: 7 } } });
    assert.strictEqual(ok.body.item, card.id, 'the run still names its ticket');
    const evs = await runEvents(ok.body.id);
    assert.deepStrictEqual(evs.map((e) => e.type), ['plugin.run.started', 'plugin.run.succeeded']);
    assert.ok(evs.every((e) => e.recipients.join() === 'ann' && !e.addressed));
    const failed = (await run({ channel: '#ops-fail' }, ANN)).body;
    assert.strictEqual(failed.status, 'failed');
    assert.strictEqual(failed.error, 'no such channel');
    // the human needs no grant
    assert.strictEqual((await run({ channel: '#anything' }, USER)).body.status, 'succeeded');

    // approve: "human": the run waits; only the human decides; the outcome wakes the agent
    const w = (await run({ channel: '#x' }, BOB)).body;
    assert.strictEqual(w.status, 'waiting');
    assert.deepStrictEqual((await s.ok('GET', '/api/plugins/fake')).runs, { waiting: 1, running: 0 });
    assert.deepStrictEqual((await s.ok('GET', '/api/plugins/runs?status=waiting')).runs.map((r) => r.id), [w.id]);
    assert.strictEqual((await s.api('POST', `/api/plugins/runs/${w.id}/approve`, {}, BOB)).body.code, 'HUMAN_ONLY');
    const approved = await s.ok('POST', `/api/plugins/runs/${w.id}/approve`, {}, USER);
    assert.strictEqual(approved.status, 'succeeded');
    assert.strictEqual(approved.approval.verdict, 'approved');
    assert.deepStrictEqual((await runEvents(w.id)).map((e) => [e.type, e.addressed?.join() || null]),
      [['plugin.run.waiting', null], ['plugin.run.started', null], ['plugin.run.succeeded', 'bob']]);
    assert.strictEqual((await s.api('POST', `/api/plugins/runs/${w.id}/approve`, {}, USER)).body.code, 'ALREADY_DECIDED');

    const r2 = (await run({ channel: '#y' }, BOB)).body;
    const rejected = await s.ok('POST', `/api/plugins/runs/${r2.id}/reject`, { note: 'not today' }, USER);
    assert.deepStrictEqual([rejected.status, rejected.approval.note], ['rejected', 'not today']);
    assert.strictEqual((await runEvents(r2.id)).at(-1).addressed.join(), 'bob');

    const r3 = (await run({ channel: '#z' }, BOB)).body;
    assert.strictEqual((await s.api('POST', `/api/plugins/runs/${r3.id}/cancel`, {}, ANN)).body.code, 'FORBIDDEN');
    assert.strictEqual((await s.ok('POST', `/api/plugins/runs/${r3.id}/cancel`, {}, BOB)).status, 'canceled');
    assert.ok(!(await runEvents(r3.id)).at(-1).addressed, 'canceling its own run wakes nobody');
    assert.strictEqual((await s.api('POST', `/api/plugins/runs/${r3.id}/cancel`, {}, BOB)).body.code, 'CONFLICT');

    // the grant is checked again when the human approves: narrowed since, the run is outside it
    const r4 = (await run({ channel: '#x' }, BOB)).body;
    for (const bad of [[{ power: 'plugin.fake.post', where: { nope: 'x' } }], ['plugin.fake.ghost'], [{ power: 'plugin.fake.post', approve: 'robot' }], [{ power: 'review.decide', approve: 'human' }]]) {
      assert.strictEqual((await s.api('POST', '/api/agents', { name: 'bob', grants: bad }, USER)).status, 400, JSON.stringify(bad));
    }
    await s.ok('POST', '/api/agents', { name: 'bob', grants: [{ power: 'plugin.fake.post', where: { channel: '#only' }, approve: 'human' }] }, USER);
    const late = await s.api('POST', `/api/plugins/runs/${r4.id}/approve`, {}, USER);
    assert.deepStrictEqual([late.status, late.body.code], [409, 'OUT_OF_SCOPE']);

    // the agent reads it in its brief, with the call to make
    const brief = String((await s.api('GET', '/api/boards/main/brief?agent=ann', undefined, ANN)).body);
    assert.match(brief, /\*\*plugin\.fake\.post\*\* — run post on the fake plugin \(only where \{"channel":\["#deploys","#ops-\*"\]\}\): intellagent api POST \/api\/plugins\/fake\/actions\/post\/run/);

    // never in the library, a role or a bundle
    assert.strictEqual((await s.api('POST', '/api/permissions', { key: 'plugin.fake.post', kind: 'command', name: 'x', commands: ['node:*'] }, USER)).status, 400);

    // removed: its grants go from agents.json, and its open runs are canceled
    const gone = await s.ok('DELETE', '/api/plugins/fake', undefined, USER);
    assert.deepStrictEqual([gone.grantsDropped.sort(), gone.runsCanceled], [['ann', 'bob', 'cal'], 1]);
    assert.strictEqual((await s.ok('GET', `/api/plugins/runs/${r4.id}`)).status, 'canceled');
    assert.deepStrictEqual((await s.ok('GET', '/api/agents/ann', undefined, USER)).grants || [], []);
  } finally { await s.stop(); }
});

// A plugin with a webhook: the x-sig header must be its token; the body is { ticket } (raises ping) or "hello" (nothing)
const HOOK_MAIN = `
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); handle(JSON.parse(line)); }
});
function handle(m) {
  if (m.type === 'run') return send({ id: m.id, ok: true, result: { message: 'posted ' + m.inputs.channel, ticket: m.ticket && m.ticket.id } });
  if (m.type !== 'webhook') return send({ id: m.id, ok: true, result: { message: 'ok' } });
  const h = m.webhook;
  if (h.headers['x-sig'] !== m.connection.token) return send({ id: m.id, ok: false, error: 'bad signature' });
  if (h.body === 'hello') return send({ id: m.id, ok: true, result: null });
  if (h.body === 'liar') return send({ id: m.id, ok: true, result: { event: 'undeclared' } });
  const b = JSON.parse(h.body);
  send({ id: m.id, ok: true, result: { event: 'ping', data: { ...b, cookie: h.headers.cookie ? 'yes' : 'no' }, item: b.item } });
}
`;
test('plugins in rules and webhooks: a plugin event sets a rule off, a rule runs an action as the board, a webhook is checked by its plugin (INT-474)', async () => {
  const s = await startServer();
  const hook = (body, headers = {}) => fetch(`${s.base}/hooks/fake`, { method: 'POST', headers: { 'content-type': 'text/plain', ...headers }, body }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    // typed fields (a bare name is text), and the ticket found by its jira property
    const json = { ...FAKE_JSON, events: [{ id: 'ping', fields: [{ key: 'room' }, { key: 'n', type: 'number' }, 'cookie', 'key'], ticket: { field: 'key', matches: 'properties.jira' } }] };
    assert.ok(validate({ ...json, events: [{ id: 'ping', fields: ['a'], ticket: { field: 'b', matches: 'title' } }] }, 'fake', pluginFolder()).problems.some((p) => p.includes('ticket.field')));
    const added = await s.ok('POST', '/api/plugins', { path: pluginFolder(json, HOOK_MAIN) }, USER);
    // off: the open route says nothing about what is installed
    assert.strictEqual((await hook('hello', { 'x-sig': 'abcdefghijkl1234' })).status, 404);
    await s.ok('POST', '/api/plugins/fake/enable', { hash: added.hash }, USER);
    await s.ok('PUT', '/api/plugins/fake/connection', { values: { token: 'abcdefghijkl1234' } }, USER);

    // the rule names what the plugin declares, and only the human writes one
    const rule = { name: 'Ping posts', when: { on: 'plugin_event', plugin: 'fake', event: 'ping' }, then: [{ do: 'run', plugin: 'fake', action: 'post', inputs: { channel: '#{event.room}' } }, { do: 'comment', text: 'pinged by {event.room}' }] };
    assert.strictEqual((await s.api('POST', '/api/boards/main/rules', rule)).body.code, 'HUMAN_ONLY');
    assert.match((await s.api('POST', '/api/boards/main/rules', { ...rule, when: { ...rule.when, event: 'pong' } }, USER)).body.error, /no event "pong"/);
    assert.match((await s.api('POST', '/api/boards/main/rules', { ...rule, then: [{ do: 'run', plugin: 'ghost', action: 'post' }] }, USER)).body.error, /No plugin "ghost"/);
    const saved = await s.ok('POST', '/api/boards/main/rules', rule, USER);
    assert.strictEqual(saved.text, "If fake raises ping → run fake's post, comment on it");
    const card = await s.ok('POST', '/api/boards/main/items', { title: 'Hooked' }, USER);

    // the plugin checks the request; the board acts only on the event it returns
    assert.deepStrictEqual(await hook('{}', { 'x-sig': 'wrong' }), { status: 401, body: { error: 'bad signature', code: 'UNAUTHORIZED', status: 401 } });
    assert.deepStrictEqual((await hook('hello', { 'x-sig': 'abcdefghijkl1234' })).body, { accepted: true, event: null });
    assert.strictEqual((await hook('liar', { 'x-sig': 'abcdefghijkl1234' })).status, 502);
    assert.strictEqual((await hook('x'.repeat(300 * 1024), { 'x-sig': 'abcdefghijkl1234' })).status, 413);
    const got = await hook(JSON.stringify({ room: 'ops', n: 'many', extra: 'x', item: card.id.toLowerCase() }), { 'x-sig': 'abcdefghijkl1234', cookie: 'session=human' });
    assert.deepStrictEqual(got, { status: 202, body: { accepted: true, event: 'ping' } });
    const logOf = (n) => until(async () => (await s.ok('GET', '/api/boards/main/rules/log')).filter((l) => l.rule === saved.id).reverse()[n]);

    // the rule fired for the ticket the event named: the run is the board's, under the rule's name, with no grant
    const log = await logOf(0);
    assert.strictEqual(log.item, card.id);
    assert.deepStrictEqual(log.results.map((r) => [r.do, r.ok, r.status || null]), [['run', true, 'succeeded'], ['comment', true, null]]);
    const run = await s.ok('GET', `/api/plugins/runs/${log.results[0].run}`);
    assert.deepStrictEqual([run.by, run.inputs, run.item, run.result.ticket], [{ kind: 'system', name: 'rule: Ping posts' }, { channel: '#ops' }, card.id, card.id]);
    const item = await s.ok('GET', `/api/boards/main/items/${card.id}`);
    assert.strictEqual(item.comments.at(-1).body, 'pinged by ops');
    // only declared fields that fit their types; cookies never reach the plugin
    const ev = (await s.ok('GET', '/api/events?since=0&types=plugin.event')).events.at(-1);
    assert.deepStrictEqual([ev.data, ev.item], [{ room: 'ops', cookie: 'no' }, card.id.toLowerCase()]);
    assert.ok((await s.ok('GET', '/api/plugins/fake')).webhook.lastAt);

    // the ticket by its linked field: the one whose jira property equals the event's key
    const linked = await s.ok('POST', '/api/boards/main/items', { title: 'Linked', properties: { jira: 'BET-7' } }, USER);
    await hook(JSON.stringify({ room: 'dev', key: 'bet-7' }), { 'x-sig': 'abcdefghijkl1234' });
    assert.strictEqual((await logOf(1)).item, linked.id);
    // no ticket: the run still goes, the ticket action fails and the log says why
    await hook(JSON.stringify({ room: 'nowhere', key: 'BET-404' }), { 'x-sig': 'abcdefghijkl1234' });
    const none = await logOf(2);
    assert.deepStrictEqual([none.item, none.results.map((r) => r.ok)], [null, [true, false]]);
    assert.match(none.results[1].error, /no ticket/);

    // changed files: the webhook goes quiet (404), the same as no plugin
    fs.appendFileSync(path.join(s.dir, 'plugins', 'fake', 'index.js'), '\n// changed');
    assert.strictEqual((await hook('hello', { 'x-sig': 'abcdefghijkl1234' })).status, 404);
    assert.strictEqual((await fetch(`${s.base}/hooks/nobody`, { method: 'POST', body: 'x' })).status, 404);
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
