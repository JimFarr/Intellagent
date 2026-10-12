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
