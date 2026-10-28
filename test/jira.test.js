// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Jira: the board holds one service account and a library of Jira actions. Each action is a permission an agent
// runs only within its grant (project, status), and a rule can run one when a ticket moves.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, until, USER: HUMAN } = require('./helpers');
// Jira changes only on a board that can tell the human apart: this board has a sign-in token
const AUTH = { userToken: 'user-token', requireAgentTokens: false };
const USER = { ...HUMAN, token: AUTH.userToken };
const { fakeJira } = require('./fake-jira');
const { issueOfTicket, createJira } = require('../lib/jira/jira.ts');

it('Jira Cloud: assigns by account id, looking up an email or name first', async () => {
  const calls = [];
  const people = [{ accountId: '712020:aaaaaaaa-1111-2222-3333-444444444444', displayName: 'Ann Lee', emailAddress: 'ann@km.com' }, { accountId: '5b10ac8d82e05b22cc7d4ef5', displayName: 'Ann Leeds' }];
  const fetch = async (u, o) => {
    calls.push([o.method, u.replace('https://km.atlassian.net/rest/api/2', ''), o.body && JSON.parse(o.body)]);
    const q = /query=([^&]+)/.exec(u)?.[1];
    const body = q ? people.filter((p) => JSON.stringify(p).toLowerCase().includes(decodeURIComponent(q).toLowerCase())) : {};
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const j = createJira({ url: 'https://km.atlassian.net', username: 'a@km.com', password: 't', fetch });
  await j.assign('BET-1', 'ann@km.com');
  await j.assign('BET-1', 'Ann Lee');
  await j.assign('BET-1', '');
  await assert.rejects(j.assign('BET-1', 'ann'), /matches 2 Jira users/);
  const puts = calls.filter((c) => c[0] === 'PUT').map((c) => c[2]);
  assert.deepEqual(puts, [{ accountId: people[0].accountId }, { accountId: people[0].accountId }, { accountId: null }]);
});

describe('Jira: a service account, its actions and who may run them', () => {
  let jira, s, url;
  before(async () => {
    jira = fakeJira();
    await new Promise((r) => jira.server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${jira.server.address().port}`;
    s = await startServer({
      manifest: { auth: AUTH, permissions: {
        mover: { grants: [{ power: 'jira.action.move-to-in-qa', where: { project: 'BET', status: 'In QA' } }] },
        asker: { grants: [{ power: 'jira.action.move-to-in-qa', approve: 'human' }] },
      } },
    });
  });
  after(async () => { await s?.stop(); jira?.server.close(); });
  const ticket = (title) => s.ok('POST', '/api/boards/main/items', { title, column: 'Ready' }, USER);

  it('connects an account only the human gives, tries it first, and never shows the password', async () => {
    assert.equal((await s.api('PUT', '/api/jira/connection', { url, username: 'svc', password: 's3cret' })).status, 403, 'an agent cannot connect it');
    const bad = await s.api('PUT', '/api/jira/connection', { url, username: 'svc', password: 'wrong' }, USER);
    assert.equal(bad.body.code, 'JIRA_REFUSED');
    const ok = await s.ok('PUT', '/api/jira/connection', { url, username: 'svc', password: 's3cret' }, USER);
    assert.equal(ok.user.displayName, 'Intellagent service');
    assert.ok(!JSON.stringify(await s.ok('GET', '/api/jira', undefined, USER)).includes('s3cret'), 'the password is never in a reply');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'local.json'), 'utf8')).jira.password, 's3cret');
    const again = await s.ok('PUT', '/api/jira/connection', { url, username: 'svc', find: 'field' }, USER);
    assert.equal(again.find, 'field', 'an edit without the password keeps the saved one');
    await s.ok('PUT', '/api/jira/connection', { url, username: 'svc' }, USER);
    assert.deepEqual(await s.ok('GET', '/api/jira/projects/BET/statuses'), ['To Do', 'In Progress', 'In QA', 'Done']);
  });

  it('keeps a library of actions only the human changes, each one a permission', async () => {
    assert.equal((await s.api('POST', '/api/jira/actions', { name: 'x', does: 'comment' })).status, 403);
    assert.equal((await s.api('POST', '/api/jira/actions', { name: 'Bad', does: 'transition', issue: 'fixed', key: 'nope', status: 'Done' }, USER)).status, 400);
    const a = await s.ok('POST', '/api/jira/actions', { name: 'Move to In QA', does: 'transition', status: 'In QA' }, USER);
    assert.deepEqual([a.id, a.issue], ['move-to-in-qa', 'ticket']);
    await s.ok('POST', '/api/jira/actions', { name: 'Move to Done', does: 'transition', status: 'Done' }, USER);
    await s.ok('POST', '/api/jira/actions', { name: 'Note it', does: 'comment', text: '{id} is on the board' }, USER);
    assert.ok(JSON.stringify(await s.ok('GET', '/api/permissions')).includes('"jira.action.move-to-done"'), 'each action is in the permission library');
  });

  it('runs on the ticket\'s Jira issue, finding the transition that reaches the status', async () => {
    const t = await ticket('BET-2 Odds feed');
    const r = await s.ok('POST', '/api/jira/actions/move-to-in-qa/run', { item: t.id }, USER);
    assert.equal(r.status, 'succeeded', r.message);
    assert.equal(jira.issues.get('BET-2').status, 'In QA');
    const same = await s.ok('POST', '/api/jira/actions/move-to-in-qa/run', { item: t.id }, USER);
    assert.match(same.message, /already in In QA/);
    const t1 = await ticket('BET-1 Fix login');
    const far = await s.ok('POST', '/api/jira/actions/move-to-done/run', { item: t1.id }, USER);
    assert.equal(far.status, 'failed');
    assert.match(far.message, /can't move from To Do to Done: from there it can go to In Progress/);
    await s.ok('POST', '/api/jira/actions/note-it/run', { item: t1.id }, USER);
    assert.deepEqual(jira.issues.get('BET-1').comments, [`${t1.id} is on the board`]);
    const none = await s.api('POST', '/api/jira/actions/note-it/run', { item: (await ticket('No key here')).id }, USER);
    assert.equal(none.status, 400);
  });

  it('lets an agent run one only within its grant, and waits for the human when the grant says so', async () => {
    const t = await ticket('BET-1 Fix login');
    jira.issues.get('BET-1').status = 'In Progress';
    assert.equal((await s.api('POST', '/api/jira/actions/move-to-done/run', { item: t.id }, { agent: 'mover' })).body.code, 'HUMAN_ONLY');
    const r = await s.api('POST', '/api/jira/actions/move-to-in-qa/run', { item: t.id }, { agent: 'mover' });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'succeeded');
    jira.issues.get('BET-1').status = 'In Progress';
    const w = await s.ok('POST', '/api/jira/actions/move-to-in-qa/run', { item: t.id }, { agent: 'asker' });
    assert.equal(w.status, 'waiting');
    assert.equal(jira.issues.get('BET-1').status, 'In Progress', 'nothing happens before the OK');
    const done = await s.ok('POST', `/api/deploy/runs/${w.id}/approve`, {}, USER);
    assert.equal(done.status, 'succeeded');
    assert.equal(jira.issues.get('BET-1').status, 'In QA');
  });

  it('runs from a rule when a ticket moves', async () => {
    jira.issues.get('BET-2').status = 'In QA';
    await s.ok('POST', '/api/boards/main/rules', { name: 'Close it in Jira', when: { on: 'entered', column: 'Done' }, then: [{ do: 'deploy', kind: 'jira', id: 'move-to-done' }] }, USER);
    const t = await ticket('BET-2 Odds feed');
    await s.ok('POST', `/api/boards/main/items/${t.id}/move`, { column: 'Done' }, USER);
    await until(() => jira.issues.get('BET-2').status === 'Done', 5000, 'the rule to move BET-2');
  });
});

describe('Jira: which issue a ticket names', () => {
  it('reads its jira field first, then a key in its title that is not one of the board\'s own ids', () => {
    assert.equal(issueOfTicket({ title: 'BET-12 fix', fields: { jira: 'ops-3' } }), 'OPS-3');
    assert.equal(issueOfTicket({ title: 'INT-4 follows BET-12' }, { boardPrefix: 'INT' }), 'BET-12');
    assert.equal(issueOfTicket({ title: 'BET-12 fix' }, { find: 'field' }), null);
    assert.equal(issueOfTicket({ title: 'nothing' }), null);
  });
});
