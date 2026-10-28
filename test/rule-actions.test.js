// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// What rules can do beyond the basics: fill values from the ticket and the event ({pr.url}…), set a property, style
// a card, extract from a ticket (a pattern or AI), merge into any branch and push it, react to a PR raised in Azure
// DevOps, and run the DevStack.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { startServer, until, USER: HUMAN } = require('./helpers');
const RULES = require('../lib/rules');

const B = '/api/boards/main';
const AUTH = { userToken: 'user-token', requireAgentTokens: false };
const USER = { ...HUMAN, token: AUTH.userToken };
const rule = (s, r) => s.ok('POST', `${B}/rules`, r, USER);
const item = async (s, id) => s.ok('GET', `${B}/items/${id}`, undefined, USER);

describe('placeholders', () => {
  it('fill the ticket, its fields and properties, and the event; an unknown one stays as written', () => {
    const it = { id: 'T-1', title: 'Odds $& feed', fields: { risk: 'high' }, properties: { svc: 'placement' } };
    assert.equal(RULES.fill('{id} {title} {field.risk} {property.svc} {pr.url} {nope}', it, { pr: { url: 'https://x/pr/7' } }), 'T-1 Odds $& feed high placement https://x/pr/7 {nope}');
    assert.equal(RULES.fillValue(3, it), 3, 'a value that is not text is kept');
  });
});

describe('rule actions on a board', () => {
  let s, ado, prs;
  before(async () => {
    prs = [{ pullRequestId: 1, title: 'Old work', status: 'completed', repository: { name: 'SB.Placement' }, sourceRefName: 'refs/heads/feature/old', targetRefName: 'refs/heads/develop', createdBy: { displayName: 'Ann' } }];
    ado = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (/\/_apis\/git\/pullrequests/.test(req.url)) return res.end(JSON.stringify({ value: [...prs].reverse() }));
      res.statusCode = 404; res.end('{}');
    });
    await new Promise((r) => ado.listen(0, '127.0.0.1', r));
    s = await startServer({
      manifest: { auth: AUTH, extract: { run: `node "${path.join(__dirname, 'fake-ai.js')}"` } },
      env: { INTELLAGENT_ADO_URL: `http://127.0.0.1:${ado.address().port}`, INTELLAGENT_ADO_ORG: 'acme', INTELLAGENT_ADO_PAT: 'pat', INTELLAGENT_PR_POLL_MS: '200' },
      agents: { agents: {} },
    });
  });
  after(async () => { await s?.stop(); ado?.close(); });

  it('a PR raised for a ticket sets a property to its link and styles its card; an older PR fires nothing', async () => {
    await rule(s, { name: 'PR link', when: { on: 'pr_opened' }, then: [{ do: 'set_property', key: 'pr', value: '{pr.url}' }, { do: 'style', look: { outline: 'ok', badge: { text: 'PR' } } }] });
    const t1 = await s.ok('POST', `${B}/items`, { title: 'Odds feed drops markets', column: 'Ready' }, USER);
    const t10 = await s.ok('POST', `${B}/items`, { title: 'Another', column: 'Ready' }, USER);
    await s.ok('PUT', '/api/deploy/pr-watch', { projects: ['Sportsteam'] }, USER);
    await until(async () => (await s.ok('GET', '/api/deploy/pr-watch', undefined, USER)).checkedAt, 5000, 'the first look');
    prs.push({ pullRequestId: 2, title: 'Fix the feed', status: 'active', repository: { name: 'SB.Placement' }, sourceRefName: `refs/heads/feature/${t1.id}-feed`, targetRefName: 'refs/heads/develop', createdBy: { displayName: 'Bob' } });
    const got = await until(async () => (await item(s, t1.id)).properties.pr, 8000, 'the PR link');
    assert.equal(got, `http://127.0.0.1:${ado.address().port}/acme/Sportsteam/_git/SB.Placement/pullrequest/2`);
    const looks = await s.ok('GET', `${B}/card-rules/matches`, undefined, USER);
    assert.equal(looks[t1.id].outline, 'ok');
    assert.equal(looks[t1.id].badges[0].text, 'PR');
    assert.equal((await item(s, t10.id)).properties.pr, undefined, 'only the ticket the PR names');
    const ev = (await s.ok('GET', `/api/events?types=pr.opened&itemId=${t1.id}`, undefined, USER)).events;
    assert.equal(ev.length, 1, 'once');
    assert.equal(ev[0].pr.by, 'Bob');
  });

  it('extract finds with a pattern or asks AI, and writes a property or a comment; nothing found writes nothing', async () => {
    await rule(s, { name: 'Read services', when: { on: 'created' }, then: [
      { do: 'extract', from: 'description', how: 'pattern', pattern: 'Build: (\\S+)', into: 'property', key: 'build' },
      { do: 'extract', from: 'all', how: 'ai', ask: 'Which services does it touch?', into: 'comment' },
    ] });
    const t = await s.ok('POST', `${B}/items`, { title: 'Settle faster', column: 'Ready', description: 'Touches placement and relay.\nBuild: 1.4.2' }, USER);
    const done = await until(async () => { const x = await item(s, t.id); return x.properties.build && x.comments.length && x; }, 8000, 'the extracts');
    assert.equal(done.properties.build, '1.4.2');
    assert.equal(done.comments[0].body, 'placement, relay');
    const none = await s.ok('POST', `${B}/items`, { title: 'Nothing here', column: 'Ready' }, USER);
    const log = await until(async () => (await s.ok('GET', `${B}/rules/log?item=${none.id}`, undefined, USER)).find((l) => l.name === 'Read services'), 8000, 'the second firing');
    assert.deepEqual(log.results.map((r) => [r.ok, r.found]), [[true, false], [true, false]]);
    assert.deepEqual((await item(s, none.id)).comments, []);
  });

  it('a card\'s style is the human\'s or a rule\'s, never an agent\'s, and a rule clears it', async () => {
    const t = await s.ok('POST', `${B}/items`, { title: 'Styled', column: 'Ready' }, USER);
    assert.equal((await s.api('PATCH', `${B}/items/${t.id}`, { style: { tint: 'warn' } }, { agent: 'drax' })).status, 403);
    await s.ok('PATCH', `${B}/items/${t.id}`, { style: { tint: 'warn' } }, USER);
    assert.equal((await s.api('PATCH', `${B}/items/${t.id}`, { style: { tint: 'nope' } }, USER)).status, 400);
    const done = (await s.ok('GET', `${B}/columns`, undefined, USER)).at(-1).name;
    await rule(s, { name: 'Clear the style', when: { on: 'entered', column: done }, then: [{ do: 'unstyle' }] });
    await s.ok('POST', `${B}/items/${t.id}/move`, { column: done }, USER);
    await until(async () => (await item(s, t.id)).style == null, 5000, 'the style cleared');
  });
});

describe('merge into a branch', () => {
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  it('makes the branch from main when origin has none, puts the ticket\'s commits on it and pushes; next time it builds on origin\'s', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-merge-'));
    const origin = path.join(tmp, 'origin.git');
    const root = path.join(tmp, 'repo');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    git(tmp, 'clone', '-q', origin, root);
    git(root, 'config', 'user.email', 't@e.com'); git(root, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
    git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init'); git(root, 'push', '-q', 'origin', 'main');
    git(root, 'checkout', '-q', '-b', 'ticket/dev/T-1');
    fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
    git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'Add b (T-1)');
    git(root, 'checkout', '-q', 'main');
    const wt = require('../lib/worktrees').createWorktrees({ root, dir: path.join(tmp, 'wt'), mainBranch: 'main' });
    const r = await wt.mergeInto('dev', 'T-1', 'integration/next', { push: true });
    assert.equal(r.landed.length, 1, JSON.stringify(r));
    assert.equal(r.created, true);
    assert.equal(r.pushed, true, r.pushError);
    assert.match(git(origin, 'log', '--format=%s', 'integration/next'), /Add b \(T-1\)/);
    assert.equal(git(root, 'rev-parse', 'main'), git(origin, 'rev-parse', 'main'), 'main is untouched');
    // a second ticket, after someone else pushed to integration/next and ours went away: built on origin's
    git(root, 'checkout', '-q', '-b', 'ticket/dev/T-2', 'main');
    fs.writeFileSync(path.join(root, 'c.txt'), 'c\n');
    git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'Add c (T-2)');
    git(root, 'checkout', '-q', 'main');
    git(root, 'branch', '-D', 'integration/next');
    const again = await wt.mergeInto('dev', 'T-2', 'integration/next', { push: true });
    assert.equal(again.created, undefined, 'origin had it');
    assert.equal(again.pushed, true, again.pushError);
    assert.deepEqual(git(origin, 'log', '--format=%s', 'integration/next').split('\n').slice(0, 2), ['Add c (T-2)', 'Add b (T-1)']);
    assert.equal((await wt.mergeInto('dev', 'T-2', 'main')).landed.length, 0, 'main is land\'s');
    assert.throws(() => RULES.cleanRule({ name: 'x', when: { on: 'created' }, then: [{ do: 'merge', branch: '-f' }] }, [], { id: 'r', nowIso: '' }), /branch name/);
  });
});

describe('DevStack', () => {
  let s, log;
  before(async () => {
    log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ia-ds-')), 'calls.jsonl');
    s = await startServer({ manifest: { auth: AUTH }, env: { FAKE_DS_LOG: log, INTELLAGENT_ADO_PAT: 'must-not-leak' }, agents: { agents: {} } });
  });
  after(async () => { await s?.stop(); });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

  it('connects through the devstack MCP server, runs a gate for a ticket to its verdict, and puts the verdict on the ticket', async () => {
    const mcp = path.join(__dirname, 'fake-devstack-mcp.js');
    assert.equal((await s.api('PUT', '/api/devstack/connection', { url: 'http://10.0.0.5:5050', mcp }, USER)).status, 400, 'local only');
    const c = await s.ok('PUT', '/api/devstack/connection', { mcp }, USER);
    assert.equal(c.connected, true);
    const a = await s.ok('POST', '/api/devstack/actions', { name: 'Regression', tool: 'gate', service: 'placement', source: 'branch:develop' }, USER);
    assert.equal(a.power, undefined);
    assert.equal((await s.api('POST', `/api/devstack/actions/${a.id}/run`, {}, { agent: 'drax' })).body.code, 'HUMAN_ONLY', 'an agent needs its grant');
    const t = await s.ok('POST', `${B}/items`, { title: 'BET-12 settle faster', column: 'Ready' }, USER);
    const run = await s.ok('POST', `/api/devstack/actions/${a.id}/run`, { item: t.id }, USER);
    assert.equal(run.status, 'running');
    const done = await until(async () => { const r = await s.ok('GET', `/api/deploy/runs/${run.id}`, undefined, USER); return r.status !== 'running' && r; }, 10000, 'the verdict');
    assert.equal(done.status, 'succeeded', done.message);
    assert.match(done.message, /^PASS/);
    const gate = calls().find((x) => x.tool === 'devstack_gate');
    assert.deepEqual([gate.args.service, gate.args.source, gate.args.kind, gate.args.ticket], ['placement', 'branch:develop', 'upgrade', 'BET-12']);
    assert.deepEqual(gate.env.leaked, [], 'the board\'s INTELLAGENT_* never reach it');
    assert.equal(gate.env.url, 'http://127.0.0.1:5050');
    assert.match((await item(s, t.id)).comments.at(-1).body, /### DevStack\nPASS/);
    const list = await s.ok('GET', '/api/devstack/actions', undefined, USER);
    assert.equal(list[0].power, 'devstack.action.regression');
    assert.ok((await s.ok('GET', '/api/permissions', undefined, USER)).permissions.some((p) => p.key === 'devstack.action.regression'), 'a permission in Assignments');
  });
});
