// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Azure DevOps pull request actions: reply on a comment's thread, resolve it, comment on the PR, approve it, with the
// board's token. Each is ado.action.<id>, judged on the PR's repo. A "PR is commented on" rule passes its PR and
// thread on, and the board's own reply, coming back through the webhook, sets nothing off.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startServer, until, USER: HUMAN } = require('./helpers');

const AUTH = { userToken: 'user-token', requireAgentTokens: false };
const USER = { ...HUMAN, token: AUTH.userToken };
const PAT = 'pr-pat-1234';

// A stand-in Azure DevOps for org "acme": PR 77 in Sportsteam/placement; it keeps every write
function fakeAdo() {
  const writes = [];
  let nextComment = 50, nextThread = 900;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const json = (st, b) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.headers.authorization !== `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`) { res.writeHead(302, { location: '/_signin' }); return res.end(); }
    const p = new URL(req.url, 'http://x').pathname;
    const body = raw ? JSON.parse(raw) : null;
    if (p === '/acme/_apis/connectionData') return json(200, { authenticatedUser: { id: 'svc-1', providerDisplayName: 'Auto SportsBook', properties: { Account: { $value: 'svc@example.com' } } } });
    if (p === '/acme/_apis/git/pullrequests/77') return json(200, { pullRequestId: 77, title: 'T-1 odds cache', status: 'active', sourceRefName: 'refs/heads/feature/T-1', targetRefName: 'refs/heads/develop', repository: { id: 'r1', name: 'placement', project: { name: 'Sportsteam' } } });
    const base = '/acme/Sportsteam/_apis/git/repositories/r1/pullRequests/77';
    let m;
    if (req.method === 'POST' && (m = new RegExp(`^${base}/threads/(\\d+)/comments$`).exec(p))) { writes.push({ do: 'reply', thread: Number(m[1]), text: body.content }); return json(200, { id: nextComment++ }); }
    if (req.method === 'PATCH' && (m = new RegExp(`^${base}/threads/(\\d+)$`).exec(p))) { writes.push({ do: 'status', thread: Number(m[1]), status: body.status }); return json(200, {}); }
    if (req.method === 'POST' && p === `${base}/threads`) { const id = nextThread++; writes.push({ do: 'thread', thread: id, text: body.comments[0].content }); return json(200, { id, comments: [{ id: 1 }] }); }
    if (req.method === 'PUT' && (m = new RegExp(`^${base}/reviewers/(.+)$`).exec(p))) { writes.push({ do: 'vote', reviewer: decodeURIComponent(m[1]), vote: body.vote }); return json(200, {}); }
    json(404, { message: `fake ADO has no ${req.method} ${p}` });
  });
  return { server, writes };
}

// A "Pull request commented on" service hook call for PR 77
const commented = (id, thread, text) => ({
  eventType: 'ms.vss-code.git-pullrequest-comment-event',
  resource: {
    comment: { id, content: text, commentType: 'text', author: { displayName: 'Ann Reviewer' }, _links: { threads: { href: `https://x/pullRequests/77/threads/${thread}` } } },
    pullRequest: { pullRequestId: 77, title: 'T-1 odds cache', sourceRefName: 'refs/heads/feature/T-1', repository: { name: 'placement', remoteUrl: 'https://dev.azure.com/acme/Sportsteam/_git/placement', project: { name: 'Sportsteam' } } },
  },
});

describe('Azure DevOps pull request actions', () => {
  let ado, s, t;
  before(async () => {
    ado = fakeAdo();
    await new Promise((r) => ado.server.listen(0, '127.0.0.1', r));
    s = await startServer({
      env: { INTELLAGENT_ADO_URL: `http://127.0.0.1:${ado.server.address().port}`, INTELLAGENT_WEBHOOK_FLUSH_MS: '50' },
      manifest: { auth: AUTH, permissions: { builder: { grants: [{ power: 'ado.action.reply-to-reviewer', where: { repo: 'placement' } }, { power: 'ado.action.approve-it', approve: 'human' }] } } },
    });
    await s.ok('PUT', '/api/deploy/connection', { org: 'acme', pat: PAT }, USER);
    t = await s.ok('POST', '/api/boards/main/items', { title: 'Odds cache', column: 'Ready' }, USER);
  });
  after(async () => { await s?.stop(); ado?.server.close(); });

  it('keeps a library only the human changes, each action a permission', async () => {
    assert.equal((await s.api('POST', '/api/ado/actions', { name: 'x', does: 'reply' }, { agent: 'builder' })).status, 403);
    assert.equal((await s.api('POST', '/api/ado/actions', { name: 'x', does: 'merge' }, USER)).status, 400);
    for (const a of [{ name: 'Reply to reviewer', does: 'reply' }, { name: 'Mark fixed', does: 'resolve', status: 'fixed', text: 'Fixed in {id}' }, { name: 'Note on PR', does: 'comment', text: 'Built for {id}' }, { name: 'Approve it', does: 'approve' }]) {
      await s.ok('POST', '/api/ado/actions', a, USER);
    }
    const list = await s.ok('GET', '/api/ado/actions', undefined, USER);
    assert.deepEqual(list.map((a) => a.power), ['ado.action.reply-to-reviewer', 'ado.action.mark-fixed', 'ado.action.note-on-pr', 'ado.action.approve-it']);
    assert.ok((await s.ok('GET', '/api/permissions', undefined, USER)).permissions.some((p) => p.key === 'ado.action.mark-fixed'));
  });

  it('runs each kind on the PR given, or the ticket\'s pr', async () => {
    const before = ado.writes.length;
    const reply = await s.ok('POST', '/api/ado/actions/reply-to-reviewer/run', { item: t.id, pr: 'https://dev.azure.com/acme/Sportsteam/_git/placement/pullrequest/77', thread: 3, text: 'On it: {id}' }, USER);
    assert.equal(reply.status, 'succeeded', reply.message);
    assert.match(reply.url, /pullrequest\/77\?discussionId=3$/);
    await s.ok('PATCH', `/api/boards/main/items/${t.id}`, { properties: { pr: 'https://dev.azure.com/acme/Sportsteam/_git/placement/pullrequest/77' } }, USER);
    assert.equal((await s.ok('POST', '/api/ado/actions/mark-fixed/run', { item: t.id, thread: 3 }, USER)).status, 'succeeded', 'the ticket\'s pr');
    assert.equal((await s.ok('POST', '/api/ado/actions/note-on-pr/run', { item: t.id }, USER)).status, 'succeeded');
    assert.equal((await s.ok('POST', '/api/ado/actions/approve-it/run', { item: t.id }, USER)).message, 'Approved PR 77 (placement)');
    assert.deepEqual(ado.writes.slice(before), [
      { do: 'reply', thread: 3, text: `On it: ${t.id}` },
      { do: 'reply', thread: 3, text: `Fixed in ${t.id}` }, { do: 'status', thread: 3, status: 'fixed' },
      { do: 'thread', thread: 900, text: `Built for ${t.id}` },
      { do: 'vote', reviewer: 'svc-1', vote: 10 },
    ]);
    assert.equal((await s.api('POST', '/api/ado/actions/reply-to-reviewer/run', { item: t.id, text: 'x' }, USER)).body.code, 'BAD_REQUEST', 'a reply needs its thread');
  });

  it('lets an agent run what its grant covers, and files an approval for the human\'s OK', async () => {
    assert.equal((await s.api('POST', '/api/ado/actions/mark-fixed/run', { item: t.id, thread: 3 }, { agent: 'builder' })).body.code, 'HUMAN_ONLY');
    assert.equal((await s.ok('POST', '/api/ado/actions/reply-to-reviewer/run', { item: t.id, thread: 4, text: 'Done' }, { agent: 'builder' })).status, 'succeeded');
    const waiting = await s.ok('POST', '/api/ado/actions/approve-it/run', { item: t.id }, { agent: 'builder' });
    assert.equal(waiting.status, 'waiting');
    const votes = ado.writes.filter((w) => w.do === 'vote').length;
    const done = await s.ok('POST', `/api/deploy/runs/${waiting.id}/approve`, {}, USER);
    assert.equal(done.status, 'succeeded');
    assert.equal(ado.writes.filter((w) => w.do === 'vote').length, votes + 1, 'approved only once the human said OK');
  });

  it('a "PR is commented on" rule replies on that thread, and its own reply coming back sets nothing off', async () => {
    const { password } = await s.ok('PUT', '/api/deploy/webhook', {}, USER);
    const hook = (body) => fetch(`${s.base}/hooks/ado`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`intellagent:${password}`).toString('base64')}` }, body: JSON.stringify(body) });
    await s.ok('POST', '/api/boards/main/rules', { name: 'Answer reviewers', when: { on: 'pr_commented' }, then: [{ do: 'deploy', kind: 'ado', id: 'reply-to-reviewer' }] }, USER);
    await s.ok('PUT', '/api/ado/actions/reply-to-reviewer', { name: 'Reply to reviewer', does: 'reply', text: 'Thanks {comment.author}, picked up as {id}' }, USER);
    const before = ado.writes.length;
    await hook(commented(7, 12, 'Rename this'));
    const reply = await until(() => ado.writes.slice(before).find((w) => w.do === 'reply'), 5000, 'the rule\'s reply');
    assert.deepEqual(reply, { do: 'reply', thread: 12, text: `Thanks Ann Reviewer, picked up as ${t.id}` }, 'the ticket the PR names (T-1)');
    // Azure DevOps tells the board about that reply too (comment 2 of thread 12 is the one the fake gave it)
    const myId = 50 + ado.writes.filter((w) => w.do === 'reply').length - 1;
    await hook(commented(myId, 12, reply.text));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(ado.writes.slice(before).filter((w) => w.do === 'reply').length, 1, 'no reply to its own reply');
  });
});
