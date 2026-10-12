'use strict';
// Structured agent flows: work → start → ask → answer → review → decision → finish.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, USER } = require('./helpers');

const B = '/api/boards/main';
const A = { agent: 'ada' };

describe('agent flows', () => {
  let s;
  const mk = (body, as = USER) => s.ok('POST', `${B}/items`, { column: 'Ready', ...body }, as);
  const work = (as = A) => s.ok('GET', `${B}/work`, undefined, as);
  before(async () => { s = await startServer(); });
  after(async () => { await s.stop(); });

  it('work suggests the most important ready ticket', async () => {
    await mk({ title: 'low thing', priority: 'Low' });
    const hi = await mk({ title: 'urgent thing', priority: 'High' });
    const w = await work();
    assert.equal(w.next[0].action, 'start');
    assert.equal(w.next[0].id, hi.id);
    assert.match(w.next[0].call, /\/start$/);
  });

  it('start claims, moves to the working column and assigns, in one step', async () => {
    const it = await mk({ title: 'start me' });
    const r = await s.ok('POST', `${B}/items/${it.id}/start`, { status: 'reading code' }, A);
    assert.equal(r.movedTo, 'In Progress');
    assert.equal(r.lease.claimant, 'ada');
    assert.equal(r.lease.status, 'reading code');
    assert.equal(r.item.assignee, 'ada');
    const other = await s.api('POST', `${B}/items/${it.id}/start`, {}, { agent: 'bob' });
    assert.equal(other.status, 423);
    assert.equal(other.body.code, 'LEASED');
    assert.ok(other.body.hint);
    const w = await work();
    assert.ok(w.leases.some((l) => l.id === it.id));
  });

  it('start refuses blocked tickets with a code, and changes nothing', async () => {
    const blocker = await mk({ title: 'blocker' });
    const it = await mk({ title: 'blocked', blockedBy: [blocker.id] });
    const r = await s.api('POST', `${B}/items/${it.id}/start`, {}, A);
    assert.equal(r.body.code, 'BLOCKED');
    const after = await s.ok('GET', `${B}/items/${it.id}`);
    assert.equal(after.columnId, 'ready');
    assert.equal(after.lease, null);
  });

  it('anyone may ask the human, even on a ticket someone else holds', async () => {
    const it = await mk({ title: 'shared' });
    await s.ok('POST', `${B}/items/${it.id}/start`, {}, A);
    await s.ok('POST', `${B}/items/${it.id}/attention`, { reason: 'Which DB?' }, { agent: 'bob' });
    await s.ok('DELETE', `${B}/items/${it.id}/attention`, { reply: 'Postgres' }, USER);
    const w = await work({ agent: 'bob' });
    const a = w.answered.find((x) => x.id === it.id);
    assert.equal(a.answer, 'Postgres');
    assert.equal(w.next.find((n) => n.id === it.id)?.action, 'resume');
  });

  it('a ticket holds several questions, answered one at a time', async () => {
    const it = await mk({ title: 'many questions' });
    const q1 = (await s.ok('POST', `${B}/items/${it.id}/attention`, { reason: 'Which DB?' }, A)).questionId;
    const q2 = (await s.ok('POST', `${B}/items/${it.id}/attention`, { reason: 'Which region?' }, { agent: 'bob' })).questionId;
    const again = (await s.ok('POST', `${B}/items/${it.id}/attention`, { reason: 'Which DB?' }, A)).questionId;
    assert.equal(again, q1, 'asking the same thing twice reuses the open question');
    let full = await s.ok('GET', `${B}/items/${it.id}`);
    assert.equal(full.questions.length, 2);
    assert.equal(full.needsHuman.id, q1, 'needsHuman mirrors the oldest');

    const { seq } = await s.ok('GET', '/api/app');
    await s.ok('DELETE', `${B}/items/${it.id}/attention`, { questionId: q2, reply: 'eu-west' }, USER);
    full = await s.ok('GET', `${B}/items/${it.id}`);
    assert.deepEqual(full.questions.map((q) => q.id), [q1]);
    const evs = (await s.ok('GET', `/api/events?since=${seq}&types=attention.resolved`)).events;
    assert.equal(evs.length, 1);
    assert.equal(evs[0].questionId, q2);
    assert.deepEqual(evs[0].recipients.includes('bob'), true);
    const bob = await work({ agent: 'bob' });
    assert.equal(bob.answered.find((x) => x.id === it.id)?.answer, 'eu-west');
    const ada = await work();
    assert.ok(ada.waitingOnHuman.some((x) => x.questionId === q1), 'ada is still waiting');

    // a review request stacks with open questions; the verdict only closes the review
    await s.ok('POST', `${B}/items/${it.id}/review`, { summary: 'ready' }, { agent: 'bob' });
    assert.equal((await s.ok('GET', `${B}/items/${it.id}`)).questions.length, 2);
    await s.ok('POST', `${B}/items/${it.id}/review/decision`, { verdict: 'changes', comment: 'nope' }, USER);
    assert.deepEqual((await s.ok('GET', `${B}/items/${it.id}`)).questions.map((q) => q.id), [q1]);
    assert.equal((await s.api('DELETE', `${B}/items/${it.id}/attention`, { questionId: 'q_nope' }, USER)).body.code, 'NOT_FOUND');
  });

  it('review feedback comes back as a structured verdict, and start resumes it', async () => {
    const it = await mk({ title: 'review me' });
    await s.ok('POST', `${B}/items/${it.id}/start`, {}, A);
    await s.ok('POST', `${B}/items/${it.id}/review`, { summary: 'done' }, A);
    assert.equal((await s.api('POST', `${B}/items/${it.id}/review/decision`, { verdict: 'approve' }, A)).status, 403, 'agents cannot approve');
    const { seq } = await s.ok('GET', '/api/app');
    await s.ok('POST', `${B}/items/${it.id}/review/decision`, { verdict: 'changes', comment: 'add a test' }, USER);
    const evs = (await s.ok('GET', `/api/events?since=${seq}&for=ada&types=review.*`)).events;
    assert.equal(evs[0].type, 'review.changes_requested');
    assert.equal(evs[0].feedback, 'add a test');
    const w = await work();
    assert.equal(w.feedback.find((x) => x.id === it.id)?.feedback, 'add a test');
    const r = await s.ok('POST', `${B}/items/${it.id}/start`, {}, A);
    assert.equal(r.item.columnId, 'in-progress');
    assert.equal(r.feedback, 'add a test');
    assert.ok(!(await work()).feedback.some((x) => x.id === it.id), 'resuming clears it');

    await s.ok('POST', `${B}/items/${it.id}/review`, { summary: 'test added' }, A);
    await s.ok('POST', `${B}/items/${it.id}/review/decision`, { verdict: 'approve' }, USER);
    assert.equal((await s.ok('GET', `${B}/items/${it.id}`)).columnId, 'done');
  });

  it('metrics count finished work, cycle time and waits on the human', async () => {
    const m = await s.ok('GET', `${B}/metrics?days=7`);
    assert.ok(m.done >= 1, 'the approved ticket counts as done');
    assert.equal(m.perDay.length, 7);
    assert.ok(m.cycleHours.median >= 0);
    assert.ok(m.answerHours.count >= 1, 'answered questions and reviews are timed');
    assert.ok(m.waiting.open >= 1, 'open questions are counted');
    assert.deepEqual(m.columns.map((c) => c.name), ['Backlog', 'Ready', 'In Progress', 'Review', 'Done']);
    assert.equal((await s.ok('GET', `${B}/metrics?days=30`)).perDay.length, 30);
  });

  it('a review explains itself in four parts, carried on the review question', async () => {
    const it = await mk({ title: 'explained review' });
    await s.ok('POST', `${B}/items/${it.id}/start`, {}, A);
    await s.ok('POST', `${B}/items/${it.id}/review`, { changed: 'Cached the session lookup.', why: 'It ran on every request; a TTL cache was simpler than Redis.', verify: 'npm test; hit /me twice.', risks: 'Stale roles for up to 60s.' }, A);
    const full = await s.ok('GET', `${B}/items/${it.id}`);
    const q = full.questions.find((x) => x.kind === 'review');
    assert.equal(q.reason, 'Cached the session lookup.');
    assert.deepEqual(Object.keys(q.notes), ['changed', 'why', 'verify', 'risks']);
    assert.match(full.comments.at(-1).body, /\*\*Why\*\*\nIt ran on every request/);
  });

  it('"explain" questions reach whoever did the work, without changing anything', async () => {
    const it = await mk({ title: 'why like this?' });
    await s.ok('POST', `${B}/items/${it.id}/start`, {}, A);
    await s.ok('POST', `${B}/items/${it.id}/review`, { changed: 'x', why: 'y', verify: 'z' }, A);
    const before = await s.ok('GET', `${B}/items/${it.id}`);
    const { seq } = await s.ok('GET', '/api/app');
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: 'Why not use the existing cache?', intent: 'explain' }, USER);
    const [ev] = (await s.ok('GET', `/api/events?since=${seq}&for=ada&types=comment.added`)).events;
    assert.equal(ev.intent, 'explain', 'addressed to the agent that asked for review');
    const after = await s.ok('GET', `${B}/items/${it.id}`);
    assert.equal(after.columnId, before.columnId);
    assert.equal(after.questions.length, before.questions.length, 'the review stays open');
    let w = await work();
    assert.equal(w.next[0].action, 'explain');
    assert.equal(w.next[0].id, it.id);
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: 'The existing cache is per-process.' }, A);
    w = await work();
    assert.ok(!w.explain.some((x) => x.id === it.id), 'answered');
  });

  it('reactions: on cards and comments, by name or emoji, never waking anyone, allowed while held', async () => {
    const it = await mk({ title: 'react to me' });
    const c = await s.ok('POST', `${B}/items/${it.id}/comments`, { body: 'nice work @ada' }, USER);
    await s.ok('POST', `${B}/items/${it.id}/start`, {}, { agent: 'holder' });
    const { seq } = await s.ok('GET', '/api/app');
    const r1 = await s.ok('POST', `${B}/items/${it.id}/reactions`, { emoji: 'eyes', commentId: c.id }, A);
    assert.deepEqual(r1.reactions, { '👀': ['ada'] }, 'allowed although someone else holds the ticket');
    await s.ok('POST', `${B}/items/${it.id}/reactions`, { emoji: '🎉' }, USER);
    await s.ok('POST', `${B}/items/${it.id}/reactions`, { emoji: '+1', commentId: c.id }, A);
    const full = await s.ok('GET', `${B}/items/${it.id}`);
    assert.deepEqual(full.reactions, { '🎉': ['James'] });
    assert.deepEqual(full.comments.find((x) => x.id === c.id).reactions, { '👀': ['ada'], '👍': ['ada'] });
    const evs = (await s.ok('GET', `/api/events?since=${seq}&types=reaction.*`)).events;
    assert.equal(evs.length, 3);
    assert.ok(evs.every((e) => e.recipients.length === 0), 'reactions never wake anyone');
    await s.ok('DELETE', `${B}/items/${it.id}/reactions`, { emoji: 'eyes', commentId: c.id }, A);
    assert.deepEqual((await s.ok('GET', `${B}/items/${it.id}`)).comments.find((x) => x.id === c.id).reactions, { '👍': ['ada'] });
    assert.equal((await s.api('POST', `${B}/items/${it.id}/reactions`, { emoji: 'banana-split' }, A)).body.code, 'BAD_EMOJI');
    await s.ok('POST', `${B}/finish`, {}, { agent: 'holder' });
  });

  it('requests go to the chosen agent, else the coordinator, and top its work until done', async () => {
    assert.equal((await s.api('POST', `${B}/requests`, { body: 'make tickets for search' }, USER)).body.code, 'NO_AGENT');
    await s.ok('PATCH', B, { coordinator: 'coord' }, USER);
    const { seq } = await s.ok('GET', '/api/app');
    const req = await s.ok('POST', `${B}/requests`, { body: "let's create some tickets for search" }, USER);
    assert.equal(req.to, 'coord');
    const [ev] = (await s.ok('GET', `/api/events?since=${seq}&for=coord&types=request.created`)).events;
    assert.equal(ev.request.id, req.id);
    let w = await work({ agent: 'coord' });
    assert.equal(w.next[0].action, 'handle_request');
    assert.match(await s.ok('GET', `${B}/brief`, undefined, { agent: 'coord' }), /coordinator/);
    await s.ok('POST', `${B}/requests/${req.id}/reply`, { body: 'Created T-90 and T-91', done: true }, { agent: 'coord' });
    w = await work({ agent: 'coord' });
    assert.equal(w.requests.length, 0);
    const [listed] = await s.ok('GET', `${B}/requests`);
    assert.equal(listed.status, 'done');
    assert.equal(listed.replies[0].body, 'Created T-90 and T-91');
    const direct = await s.ok('POST', `${B}/requests`, { body: 'ping', to: 'ada' }, USER);
    assert.equal(direct.to, 'ada');
  });

  it('transitions explain where a ticket can go', async () => {
    const it = await mk({ title: 'where to' });
    const t = await s.ok('GET', `${B}/items/${it.id}/transitions`, undefined, A);
    const done = t.moves.find((m) => m.column === 'Done');
    assert.equal(done.allowed, false);
    assert.equal(done.code, 'HUMAN_ONLY');
    assert.equal(t.moves.find((m) => m.column === 'In Progress').allowed, true);
  });

  it('finish releases everything you hold and posts the digest', async () => {
    const it = await mk({ title: 'finish me' });
    await s.ok('POST', `${B}/items/${it.id}/start`, {}, { agent: 'fin' });
    const r = await s.ok('POST', `${B}/finish`, { summary: 'did things' }, { agent: 'fin' });
    assert.deepEqual(r.released, [it.id]);
    assert.ok(r.digest);
    assert.equal((await s.ok('GET', `${B}/items/${it.id}`)).lease, null);
  });

  it('status lines and renewals do not wake other agents', async () => {
    const it = await mk({ title: 'quiet' });
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: 'I was here' }, { agent: 'watcher' });
    await s.ok('POST', `${B}/items/${it.id}/start`, {}, A);
    const { seq } = await s.ok('GET', '/api/app');
    await s.ok('PUT', `${B}/items/${it.id}/status`, { status: 'step 2' }, A);
    await s.ok('POST', `${B}/items/${it.id}/lease`, { minutes: 20 }, A);
    assert.equal((await s.ok('GET', `/api/events?since=${seq}&for=watcher`)).events.length, 0);
  });

  it('creating with an assignee tells the assignee', async () => {
    const { seq } = await s.ok('GET', '/api/app');
    await mk({ title: 'for carl', assignee: 'carl' });
    const evs = (await s.ok('GET', `/api/events?since=${seq}&for=carl&types=item.assigned`)).events;
    assert.equal(evs.length, 1);
  });

  it('the master lease cannot be dodged with a differently-cased board id', async () => {
    await s.ok('POST', `${B}/finish`, {}, A);
    await s.ok('POST', `${B}/master`, {}, { agent: 'boss' });
    const r = await s.api('POST', '/api/boards/Main/items', { title: 'sneaky', column: 'Ready' }, { agent: 'sneak' });
    assert.equal(r.status, 423);
    assert.equal(r.body.code, 'BOARD_HELD');
    assert.equal((await work({ agent: 'sneak' })).next.length, 0);
    await s.ok('DELETE', `${B}/master`, undefined, { agent: 'boss' });
  });

  it('a cursor from before a reset does not hang', async () => {
    const t = Date.now();
    const r = await s.ok('GET', '/api/events/wait?since=999999&timeout=1', undefined, A);
    assert.ok(Date.now() - t < 1500);
    assert.ok(r.cursor < 999999);
  });
});
