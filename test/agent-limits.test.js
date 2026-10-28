// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// What an agent must not reach: the human's token, another agent's token, files outside its folders, writes a
// read-only setting or a lease forbids, script in the human's page, and the board's own secrets in its runs.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { startServer, freePort, until, cleanEnv, USER } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const B = '/api/boards/main';
const run = (file, args, { cwd, env = {} }) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, file), ...args], { cwd, env: cleanEnv(env) });
  let out = ''; let err = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
  p.stdin.end();
  p.on('close', (code) => resolve({ code, out, err }));
});
// A board folder with tokens in local.json before it starts
function boardDir(local) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-limits-'));
  fs.writeFileSync(path.join(dir, 'local.json'), JSON.stringify(local));
  return dir;
}

describe('tokens and read-only', () => {
  let s;
  before(async () => {
    s = await startServer({
      dir: boardDir({ agentTokens: { bob: 'bob-1', carl: 'carl-1', amy: 'amy-1' } }),
      manifest: { auth: { requireAgentTokens: true }, permissions: { carl: { readOnly: true } } },
      agents: { agents: {} },
    });
  });
  after(async () => { await s?.stop(); });

  it('a read-only agent that sends its token still cannot write', async () => {
    const r = await s.api('POST', `${B}/items`, { title: 'no', column: 'Ready' }, { agent: 'carl', token: 'carl-1' });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /read-only/);
  });

  it('a rotated token counts at once, and the old one stops working', async () => {
    assert.equal((await s.api('GET', `${B}/work`, undefined, { agent: 'bob', token: 'bob-1' })).status, 200);
    const file = path.join(s.dir, 'local.json');
    fs.chmodSync(file, 0o666);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), agentTokens: { bob: 'bob-2', carl: 'carl-1', amy: 'amy-1' } }));
    assert.equal((await s.api('GET', `${B}/work`, undefined, { agent: 'bob', token: 'bob-1' })).status, 401, 'the old token');
    assert.equal((await s.api('GET', `${B}/work`, undefined, { agent: 'bob', token: 'bob-2' })).status, 200, 'the new one');
  });

  it('attachments respect another agent\'s lease, and a link is http(s) only', async () => {
    const it = await s.ok('POST', `${B}/items`, { title: 'held', column: 'Ready' }, { agent: 'amy', token: 'amy-1' });
    await s.ok('POST', `${B}/items/${it.id}/start`, {}, { agent: 'amy', token: 'amy-1' });
    const other = await s.api('POST', `${B}/items/${it.id}/attachments`, { url: 'https://example.com/x' }, { agent: 'bob', token: 'bob-2' });
    assert.deepEqual([other.status, other.body.code], [423, 'LEASED']);
    const js = await s.api('POST', `${B}/items/${it.id}/attachments`, { url: 'javascript:alert(1)' }, { agent: 'amy', token: 'amy-1' });
    assert.equal(js.status, 400);
    assert.equal((await s.api('POST', `${B}/items/${it.id}/attachments`, { url: 'https://example.com/x' }, { agent: 'amy', token: 'amy-1' })).status, 201);
  });

  it('a colour is a colour: nothing that adds CSS to the card', async () => {
    const r = await s.api('PATCH', `${B}/columns/Ready`, { color: '0;background:url(//e.io/p)' }, USER);
    assert.equal(r.status, 400);
    assert.equal((await s.api('PATCH', `${B}/columns/Ready`, { color: '#4cc38a' }, USER)).status, 200);
    await s.ok('POST', `${B}/schema/fields`, { key: 'risk', type: 'enum', options: [{ value: 'low', color: '0;background:url(//e.io/p)' }, { value: 'high', color: '#ff5d73' }] }, USER);
    const opts = (await s.ok('GET', `${B}/schema`, undefined, USER)).fields.find((f) => f.key === 'risk').options;
    assert.deepEqual(opts.map((o) => o.color ?? null), [null, '#ff5d73']);
  });
});

describe('the CLI keeps an agent to its own files and token', () => {
  let dir;
  before(() => {
    dir = boardDir({ userToken: 'HUMAN-SECRET', agentTokens: { builder: 'B-LOCAL', reviewer: 'R-LOCAL' } });
    fs.writeFileSync(path.join(dir, 'intellagent.manifest.json'), JSON.stringify({ port: 1, dataDir: './data' }));
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data', 'items.json'), '{"private":true}');
  });

  it('a whole body from a file follows the key=@path rules: never local.json', async () => {
    const r = await run('cli.js', ['POST', '/api/x', '@local.json'], { cwd: dir, env: { INTELLAGENT_AGENT: 'builder', INTELLAGENT_URL: 'http://127.0.0.1:1' } });
    assert.equal(r.code, 2);
    assert.match(r.err, /FORBIDDEN/);
  });

  it('key=@path judges files by the board where the agent runs, not by a --manifest it made itself', async () => {
    const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-evil-'));
    fs.writeFileSync(path.join(evil, 'intellagent.manifest.json'), JSON.stringify({ port: 1, projectRoot: path.parse(dir).root }));
    const r = await run('cli.js', ['POST', '/api/x', `body=@${path.join(dir, 'data', 'items.json')}`], { cwd: dir, env: { INTELLAGENT_AGENT: 'builder', INTELLAGENT_URL: 'http://127.0.0.1:1', INTELLAGENT_MANIFEST: path.join(evil, 'intellagent.manifest.json') } });
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /FORBIDDEN/);
  });

  it('--manifest with --as another agent keeps the run\'s own token instead of borrowing that agent\'s', async () => {
    const seen = [];
    const stub = http.createServer((req, res) => { seen.push(req.headers.authorization); res.setHeader('content-type', 'application/json'); res.end('{}'); });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${stub.address().port}`;
      const env = { INTELLAGENT_AGENT: 'builder', INTELLAGENT_TOKEN: 'B-RUN' };
      const mf = path.join(dir, 'intellagent.manifest.json');
      await run('bin/intellagent.js', ['--manifest', mf, '--url', url, '--as', 'reviewer', 'api', 'GET', '/api/x'], { cwd: os.tmpdir(), env });
      await run('bin/intellagent.js', ['--manifest', mf, '--url', url, 'api', 'GET', '/api/x'], { cwd: os.tmpdir(), env });
      assert.deepEqual(seen, ['Bearer B-RUN', 'Bearer B-LOCAL'], 'as reviewer: its own token (refused); as itself: its token for that board');
    } finally { stub.close(); }
  });

  it('wait --timeout ends on time while the board is down', async () => {
    const down = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-down-'));
    fs.writeFileSync(path.join(down, 'intellagent.manifest.json'), JSON.stringify({ port: await freePort() }));
    fs.mkdirSync(path.join(down, 'cursors'));
    fs.writeFileSync(path.join(down, 'cursors', 'waiter.json'), JSON.stringify({ cursor: 5 }));
    const t = Date.now();
    const r = await run('bin/intellagent.js', ['wait', '--agent', 'waiter', '--timeout', '2'], { cwd: down, env: {} });
    assert.ok(Date.now() - t < 15000, `took ${Date.now() - t} ms`);
    assert.equal(r.code, 2, r.err);
    assert.match(r.out, /no events before timeout/);
  });
});

describe('the board\'s own secrets stay out of agent runs', () => {
  it('a claude run inherits no INTELLAGENT_* from the board, and still gets its own', () => {
    const { childEnv } = require('../lib/agents/runner');
    process.env.INTELLAGENT_SOME_SECRET = 'secret-pat';
    try {
      const env = childEnv({ run: 'claude -p go' }, { INTELLAGENT_URL: 'u' }, { INTELLAGENT_AGENT: 'me' });
      assert.equal(env.INTELLAGENT_SOME_SECRET, undefined);
      assert.equal(env.INTELLAGENT_URL, 'u');
      assert.equal(env.INTELLAGENT_AGENT, 'me');
      assert.equal(childEnv({ inheritEnv: ['INTELLAGENT_SOME_SECRET'] }, {}, {}).INTELLAGENT_SOME_SECRET, 'secret-pat', 'unless inheritEnv names it');
    } finally { delete process.env.INTELLAGENT_SOME_SECRET; }
  });
});

describe('the event log', () => {
  it('keeps numbering after it was set aside and the board restarted before the next event', async () => {
    let s = await startServer({ agents: { agents: {} } });
    for (let i = 0; i < 10; i++) await s.ok('POST', `${B}/items`, { title: `t${i}`, column: 'Ready' }, USER);
    const seq = (await s.ok('GET', '/api/app')).seq;
    await s.stop({ keep: true });
    const data = path.join(s.dir, 'data');
    fs.renameSync(path.join(data, 'events.jsonl'), path.join(data, `events-${Date.now()}.jsonl`));
    s = await startServer({ dir: s.dir, agents: { agents: {} } });
    try {
      const next = await s.ok('POST', `${B}/items`, { title: 'after', column: 'Ready' }, USER);
      const ev = await until(async () => (await s.ok('GET', `/api/events?itemId=${next.id}&tail=true`)).events[0]);
      assert.ok(ev.seq > seq, `seq ${ev.seq} after ${seq}`);
    } finally { await s.stop(); }
  });
});
