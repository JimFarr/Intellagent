// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// What rules can do beyond the basics: fill values from the ticket and the event ({comment.text}…), set a property,
// style a card, extract from a ticket (a pattern or AI), and merge into any branch and push it.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
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
    assert.equal(RULES.fill('{id} {title} {field.risk} {property.svc} {comment.author} {nope}', it, { comment: { author: 'bob' } }), 'T-1 Odds $& feed high placement bob {nope}');
    assert.equal(RULES.fillValue(3, it), 3, 'a value that is not text is kept');
  });
});

describe('rule actions on a board', () => {
  let s;
  before(async () => {
    s = await startServer({
      manifest: { auth: AUTH, extract: { run: `node "${path.join(__dirname, 'fake-ai.js')}"` } },
      agents: { agents: {} },
    });
  });
  after(async () => { await s?.stop(); });

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

  it('{comment.text}, {comment.author} and {comment.url} fill from the comment that set the rule off', async () => {
    await rule(s, { name: 'Read comments', when: { on: 'commented' }, then: [
      { do: 'set_property', key: 'text', value: '{comment.text}' },
      { do: 'set_property', key: 'author', value: '{comment.author}' },
      { do: 'set_property', key: 'url', value: '{comment.url}' },
    ] });
    const t = await s.ok('POST', `${B}/items`, { title: 'Commented on', column: 'Ready' }, USER);
    const c = await s.ok('POST', `${B}/items/${t.id}/comments`, { body: 'Ship it' }, USER);
    const done = await until(async () => { const x = await item(s, t.id); return x.properties.url && x; }, 8000, 'the comment placeholders');
    assert.equal(done.properties.text, 'Ship it');
    assert.equal(done.properties.author, USER.user);
    assert.equal(done.properties.url, `${B}/items/${t.id}#${c.id}`);
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

