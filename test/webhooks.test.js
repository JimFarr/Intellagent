// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Azure DevOps service hooks: the board takes "Pull request commented on" calls that carry the hook's own username and
// password, buffers them, and every flush turns each comment on a PR that names a ticket into a pr.commented event,
// which sets off "a PR is commented on" rules. A retried call is taken once.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, until, USER: HUMAN } = require('./helpers');
const { createAdoWebhooks, parse } = require('../lib/deploy/webhooks.ts');

const AUTH = { userToken: 'user-token', requireAgentTokens: false };
const USER = { ...HUMAN, token: AUTH.userToken };

// A "Pull request commented on" call, as Azure DevOps sends it (the parts the board reads)
const commented = ({ pr = 42, title = 'Odds cache', source = 'refs/heads/feature/odds', id = 1, thread = 7, text = 'Rename this', type = 'text' } = {}) => ({
  eventType: 'ms.vss-code.git-pullrequest-comment-event',
  resource: {
    comment: { id, parentCommentId: 0, content: text, commentType: type, author: { displayName: 'Ann Reviewer' }, publishedDate: '2026-10-28T10:00:00Z',
      _links: { threads: { href: `https://dev.azure.com/acme/p/_apis/git/repositories/r1/pullRequests/${pr}/threads/${thread}` } } },
    pullRequest: { pullRequestId: pr, title, sourceRefName: source, targetRefName: 'refs/heads/main', createdBy: { displayName: 'Ben Builder' },
      repository: { name: 'placement', remoteUrl: 'https://dev.azure.com/acme/Sportsteam/_git/placement', project: { name: 'Sportsteam' } } },
  },
});

describe('Azure DevOps webhooks: the buffer', () => {
  it('reads a PR comment, and leaves out system comments and other events', () => {
    const ev = parse(commented());
    assert.equal(ev.key, 'comment:42:7:1');
    assert.deepEqual([ev.pr.id, ev.pr.source, ev.pr.url], [42, 'feature/odds', 'https://dev.azure.com/acme/Sportsteam/_git/placement/pullrequest/42']);
    assert.deepEqual([ev.comment.text, ev.comment.author, ev.comment.threadId, ev.comment.url], ['Rename this', 'Ann Reviewer', 7, 'https://dev.azure.com/acme/Sportsteam/_git/placement/pullrequest/42?discussionId=7']);
    assert.equal(parse(commented({ type: 'system' })), null, 'Azure DevOps\'s own notes');
    assert.equal(parse({ eventType: 'git.push' }), null);
  });

  it('takes a retried call once, hands the buffer on at a flush, and keeps what lands meanwhile for the next', async () => {
    const batches = [];
    let release;
    const hooks = createAdoWebhooks({ creds: () => ({ username: 'u', password: 'p' }), flushMs: 3_600_000, onFlush: (b) => { batches.push(b.map((e) => e.comment.id)); return new Promise((r) => { release = r; }); } });
    try {
      assert.equal(hooks.allowed(`Basic ${Buffer.from('u:p').toString('base64')}`), true);
      assert.equal(hooks.allowed(`Basic ${Buffer.from('u:x').toString('base64')}`), false);
      assert.equal(hooks.allowed(undefined), false);
      assert.deepEqual([hooks.receive(commented({ id: 1 })), hooks.receive(commented({ id: 1 })), hooks.receive(commented({ id: 2 }))], ['buffered', 'repeat', 'buffered']);
      const first = hooks.flush();
      hooks.receive(commented({ id: 3 })); // lands while the first pass runs
      release();
      await first;
      assert.deepEqual(batches, [[1, 2]]);
      assert.equal(hooks.view().buffered, 1, 'only what the pass handed on is cleared');
      const second = hooks.flush(); release(); await second;
      assert.deepEqual(batches, [[1, 2], [3]]);
      assert.equal(hooks.view().buffered, 0);
    } finally { hooks.stop(); }
  });
});

describe('Azure DevOps webhooks on a board', () => {
  let s;
  const hook = (body, auth) => fetch(`${s.base}/hooks/ado`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
  before(async () => { s = await startServer({ env: { INTELLAGENT_WEBHOOK_FLUSH_MS: '50' }, manifest: { auth: AUTH } }); });
  after(async () => { await s?.stop(); });

  it('is off until the human turns it on, and refuses calls without its password', async () => {
    assert.equal((await hook(commented())).status, 401, 'off: refused');
    assert.equal((await s.api('GET', '/api/deploy/webhook', undefined, { agent: 'builder' })).status, 403, 'the password is the human\'s to see');
    assert.equal((await s.api('PUT', '/api/deploy/webhook', {}, { agent: 'builder' })).status, 403);
    const h = await s.ok('PUT', '/api/deploy/webhook', {}, USER);
    assert.deepEqual([h.on, h.path, h.username], [true, '/hooks/ado', 'intellagent']);
    assert.ok(h.password.length >= 24);
    assert.equal((await hook(commented(), `Basic ${Buffer.from('intellagent:wrong').toString('base64')}`)).status, 401);
    const again = await s.ok('PUT', '/api/deploy/webhook', {}, USER);
    assert.equal((await hook(commented(), `Basic ${Buffer.from(`intellagent:${h.password}`).toString('base64')}`)).status, 401, 'a new password ends the old one');
    assert.equal((await hook(commented(), `Basic ${Buffer.from(`intellagent:${again.password}`).toString('base64')}`)).status, 200);
  });

  it('fires "a PR is commented on" for the ticket the PR names, with the comment, once per comment', async () => {
    const { password } = await s.ok('GET', '/api/deploy/webhook', undefined, USER);
    const auth = `Basic ${Buffer.from(`intellagent:${password}`).toString('base64')}`;
    const t = await s.ok('POST', '/api/boards/main/items', { title: 'Odds cache', column: 'Ready' }, USER);
    await s.ok('POST', '/api/boards/main/rules', { name: 'Review notes', when: { on: 'pr_commented' }, then: [{ do: 'comment', text: '{comment.author} on PR {pr.id}: {comment.text} ({comment.url})' }] }, USER);
    const body = commented({ pr: 77, title: `${t.id}: odds cache`, id: 9, thread: 3, text: 'Use a TTL here' });
    const r = await hook(body, auth);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { received: 'buffered' });
    assert.deepEqual(await (await hook(body, auth)).json(), { received: 'repeat' }, 'Azure DevOps retried it');
    await hook(commented({ pr: 78, title: 'Unrelated work', id: 10 }), auth);
    const item = await until(async () => { const it = await s.ok('GET', `/api/boards/main/items/${t.id}`, undefined, USER); return it.comments.some((c) => c.author?.rule) && it; }, 5000, 'the rule to comment');
    const notes = item.comments.filter((c) => c.author?.rule);
    assert.equal(notes.length, 1, 'once, though the call came twice');
    assert.equal(notes[0].body, 'Ann Reviewer on PR 77: Use a TTL here (https://dev.azure.com/acme/Sportsteam/_git/placement/pullrequest/77?discussionId=3)');
    const hist = await s.ok('GET', `/api/boards/main/items/${t.id}/history`, undefined, USER);
    assert.ok(hist.some((e) => e.type === 'pr.commented' && e.comment.text === 'Use a TTL here'), 'on the ticket\'s Activity');
    assert.ok((await s.ok('GET', '/api/deploy/webhook', undefined, USER)).lastAt, 'the page says when Azure DevOps last called');
  });

  it('turns off: its calls are refused again', async () => {
    const { password } = await s.ok('GET', '/api/deploy/webhook', undefined, USER);
    await s.ok('DELETE', '/api/deploy/webhook', undefined, USER);
    assert.equal((await hook(commented(), `Basic ${Buffer.from(`intellagent:${password}`).toString('base64')}`)).status, 401);
    assert.equal((await s.ok('GET', '/api/deploy/webhook', undefined, USER)).on, false);
  });
});
