'use strict';
// Structured agent flows: work → start → ask → answer → review → decision → finish.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, until, USER, cleanEnv } = require('./helpers');

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

  it('an agent withdraws its own question or review, the coordinator anyone\'s, others are refused (INT-90)', async () => {
    await s.ok('PATCH', B, { coordinator: 'gamora' }, USER);
    const it = await mk({ title: 'withdraw me' });
    const mine = (await s.ok('POST', `${B}/items/${it.id}/attention`, { reason: 'Which cache?' }, A)).questionId;
    const bobs = (await s.ok('POST', `${B}/items/${it.id}/attention`, { reason: 'Which queue?' }, { agent: 'bob' })).questionId;
    const wd = (qid, body, as) => s.api('POST', `${B}/items/${it.id}/questions/${qid}/withdraw`, body, as);

    // refused: someone else's, with a code and a hint; no reason; and DELETE …/attention is no way around it
    const refused = await wd(bobs, { reason: 'not needed' }, A);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'FORBIDDEN');
    assert.ok(refused.body.hint);
    assert.equal((await wd(mine, {}, A)).status, 400, 'a reason is required');
    assert.equal((await s.api('DELETE', `${B}/items/${it.id}/attention`, { questionId: bobs }, A)).body.code, 'FORBIDDEN');
    assert.equal((await s.api('DELETE', `${B}/items/${it.id}/attention`, {}, A)).body.code, 'FORBIDDEN', 'closing all would close bob\'s too');
    assert.equal((await s.ok('GET', `${B}/items/${it.id}`)).questions.length, 2, 'nothing closed');

    // the author: gone from the card and from its …/work, recorded on the card, not handed back as an answer
    const before = (await s.ok('GET', `${B}/items/${it.id}`)).columnId;
    const after = (await wd(mine, { reason: 'found it in the config' }, A)).body;
    assert.deepEqual(after.questions.map((q) => q.id), [bobs]);
    assert.equal(after.columnId, before, 'withdrawing moves nothing');
    assert.match(after.comments.at(-1).body, /↩ Withdrew the question: found it in the config/);
    const ada = await work();
    assert.ok(!ada.waitingOnHuman.some((x) => x.questionId === mine));
    assert.ok(!ada.answered.some((x) => x.id === it.id), 'your own withdrawal is no answer');

    // the coordinator cleans up after bob; bob hears it as an answer, marked withdrawn
    const { seq } = await s.ok('GET', '/api/app');
    await s.ok('POST', `${B}/items/${it.id}/questions/${bobs}/withdraw`, { reason: 'decided in INT-1' }, { agent: 'gamora' });
    const ev = (await s.ok('GET', `/api/events?since=${seq}&types=attention.resolved`)).events[0];
    assert.equal(ev.withdrawn, true);
    assert.ok(ev.recipients.includes('bob'));
    const bob = (await work({ agent: 'bob' })).answered.find((x) => x.id === it.id);
    assert.equal(bob.withdrawn, true);
    assert.match(bob.answer, /decided in INT-1/);
    assert.equal((await wd(bobs, { reason: 'again' }, { agent: 'gamora' })).status, 404, 'already closed');
    await s.ok('PATCH', B, { coordinator: null }, USER);
  });

  it('a question carries a form the agent composes; the answers come back as { key: value } (INT-88)', async () => {
    const it = await mk({ title: 'form me' });
    const form = [
      { type: 'note', markdown: 'Pick what **fits**.' },
      { key: 'db', label: 'Database', type: 'choice', options: ['postgres', { value: 'sqlite', label: 'SQLite' }], required: true },
      { key: 'extras', label: 'Extras', type: 'multi', options: ['cache', 'queue', 'search'] },
      { key: 'migrate', label: 'Migrate now?', type: 'yesno', default: false },
      { key: 'replicas', label: 'Replicas', type: 'number', min: 1, max: 5 },
      { key: 'by', label: 'By', type: 'date' },
      { key: 'notes', label: 'Notes', type: 'longtext' },
    ];
    const qid = (await s.ok('POST', `${B}/items/${it.id}/attention`, { reason: 'Storage setup?', form }, A)).questionId;
    const q = (await s.ok('GET', `${B}/items/${it.id}`)).questions.find((x) => x.id === qid);
    assert.equal(q.form.length, 7);
    assert.deepEqual(q.form[1].options, [{ value: 'postgres', label: 'postgres' }, { value: 'sqlite', label: 'SQLite' }]);

    // answers that don't fit the form are refused with a code and a hint, and close nothing
    const ans = (answers, qId = qid) => s.api('DELETE', `${B}/items/${it.id}/attention`, { questionId: qId, answers }, USER);
    for (const [bad, why] of [[{ extras: ['cache'] }, /required/], [{ db: 'mysql' }, /one of/], [{ db: 'sqlite', replicas: 9 }, /between/],
      [{ db: 'sqlite', nope: 1 }, /unknown field/], [{ db: 'sqlite', by: 'tuesday' }, /date/], [{ db: 'sqlite', migrate: 'yes' }, /true or false/]]) {
      const r = await ans(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.body.code, 'BAD_REQUEST');
      assert.match(r.body.error, why);
      assert.match(r.body.hint, /db \(choice, required\)/);
    }
    assert.equal((await s.ok('GET', `${B}/items/${it.id}`)).questions.length, 1, 'still open');

    const { seq } = await s.ok('GET', '/api/app');
    await ans({ db: 'sqlite', extras: ['cache', 'search'], migrate: true, replicas: 2 });
    const want = { db: 'sqlite', extras: ['cache', 'search'], migrate: true, replicas: 2, by: null, notes: null };
    const ev = (await s.ok('GET', `/api/events?since=${seq}&types=attention.resolved`)).events[0];
    assert.equal(ev.questionId, qid);
    assert.deepEqual(ev.form, want);
    assert.ok(ev.recipients.includes('ada'));
    const a = (await work()).answered.find((x) => x.id === it.id);
    assert.deepEqual(a.form, want);
    assert.match(a.answer, /\*\*Database:\*\* SQLite/, 'the answers read as a comment on the card too');
    assert.match(a.answer, /\*\*Migrate now\?:\*\* Yes/);
    const c = (await s.ok('GET', `${B}/items/${it.id}`)).comments.at(-1);
    assert.equal(c.answers, qid);
    assert.deepEqual(c.form, want);
  });

  it('a form that cannot be drawn gets 400 with a code and a hint; a plain question still works (INT-88)', async () => {
    const it = await mk({ title: 'bad forms' });
    for (const form of [[], 'pick one', [{ key: 'x', type: 'slider' }], [{ key: '1x' }], [{ key: 'a' }, { key: 'a' }],
      [{ key: 'c', type: 'choice' }], [{ type: 'note', markdown: 'just words' }], [{ key: 'n', type: 'number', default: 'many' }]]) {
      const r = await s.api('POST', `${B}/items/${it.id}/attention`, { reason: 'Q?', form }, A);
      assert.equal(r.status, 400, JSON.stringify(form));
      assert.equal(r.body.code, 'BAD_REQUEST');
      assert.match(r.body.hint, /type: text\|longtext\|choice/);
    }
    assert.equal((await s.ok('GET', `${B}/items/${it.id}`)).questions.length, 0, 'nothing was asked');

    const qid = (await s.ok('POST', `${B}/items/${it.id}/attention`, { reason: 'Plain?' }, A)).questionId;
    const q = (await s.ok('GET', `${B}/items/${it.id}`)).questions[0];
    assert.equal(q.form, undefined);
    const r = await s.api('DELETE', `${B}/items/${it.id}/attention`, { questionId: qid, answers: { x: 1 } }, USER);
    assert.equal(r.body.code, 'BAD_REQUEST', 'answers to a question without a form');
    await s.ok('DELETE', `${B}/items/${it.id}/attention`, { questionId: qid, reply: 'plainly yes' }, USER);
    const a = (await work()).answered.find((x) => x.id === it.id);
    assert.equal(a.answer, 'plainly yes');
    assert.equal(a.form, undefined);
  });

  it('a withdrawn, undecided review cannot be carried through the gate by an agent; the human still can (INT-90)', async () => {
    const s2 = await startServer({ agents: { agents: { gamora: { role: 'coordinator', grants: ['column.gate'] } } } });
    try {
      const it = await s2.ok('POST', `${B}/items`, { title: 'gated', column: 'Ready' }, USER);
      await s2.ok('POST', `${B}/items/${it.id}/start`, {}, { agent: 'dev' });
      await s2.ok('POST', `${B}/items/${it.id}/review`, { summary: 'done' }, { agent: 'dev' });
      const rq = (await s2.ok('GET', `${B}/items/${it.id}`)).questions.find((q) => q.kind === 'review').id;
      assert.equal((await s2.api('POST', `${B}/items/${it.id}/questions/${rq}/withdraw`, { reason: 'x' }, { agent: 'eve' })).body.code, 'FORBIDDEN');
      await s2.ok('POST', `${B}/items/${it.id}/questions/${rq}/withdraw`, { reason: 'superseded' }, { agent: 'gamora' });
      const sneak = await s2.api('POST', `${B}/items/${it.id}/move`, { column: 'Done' }, { agent: 'gamora' });
      assert.equal(sneak.status, 409);
      assert.equal(sneak.body.code, 'REVIEW_OPEN');
      await s2.ok('POST', `${B}/items/${it.id}/move`, { column: 'Done' }, USER);
    } finally { await s2.stop(); }
  });

  it('a request is withdrawn by its sender or the coordinator, never by the agent it was for (INT-90)', async () => {
    await s.ok('PATCH', B, { coordinator: 'gamora' }, USER);
    const r = await s.ok('POST', `${B}/requests`, { body: 'a lease for the heat solve, please', to: 'guard' }, A);
    const wd = (id, as) => s.api('POST', `${B}/requests/${id}/withdraw`, { reason: 'solve finished early' }, as);
    assert.ok((await work({ agent: 'guard' })).requests.some((x) => x.requestId === r.id));
    const no = await wd(r.id, { agent: 'guard' });
    assert.equal(no.status, 403);
    assert.equal(no.body.code, 'FORBIDDEN');
    const { seq } = await s.ok('GET', '/api/app');
    const done = (await wd(r.id, A)).body;
    assert.equal(done.status, 'done');
    assert.equal(done.withdrawn.reason, 'solve finished early');
    assert.ok(!(await work({ agent: 'guard' })).requests.some((x) => x.requestId === r.id), 'gone from its agent\'s work');
    const ev = (await s.ok('GET', `/api/events?since=${seq}&types=request.withdrawn`)).events[0];
    assert.deepEqual(ev.recipients, [], 'wakes nobody');
    assert.equal((await wd(r.id, A)).body.code, 'CONFLICT');
    const r2 = await s.ok('POST', `${B}/requests`, { body: 'another', to: 'guard' }, A);
    assert.equal((await wd(r2.id, { agent: 'gamora' })).status, 200, 'the coordinator may');
    await s.ok('PATCH', B, { coordinator: null }, USER);
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

  it('an agent asking another agent hears the reply', async () => {
    const { seq } = await s.ok('GET', '/api/app');
    const req = await s.ok('POST', `${B}/requests`, { body: 'May I run a solve? 11 threads, 2048 MB, 20 min', to: 'guard' }, { agent: 'qa' });
    await s.ok('POST', `${B}/requests/${req.id}/reply`, { body: 'Pass. Lease L4 until 09:20.', done: true }, { agent: 'guard' });
    const evs = (await s.ok('GET', `/api/events?since=${seq}&for=qa&types=request.*`)).events;
    assert.equal(evs.length, 1, 'the reply reaches the agent that asked');
    assert.equal(evs[0].reply, 'Pass. Lease L4 until 09:20.');
    assert.deepEqual(evs[0].addressed, ['qa'], 'and wakes it');
    assert.equal(evs[0].request.by, 'qa');
    const { seq: s2 } = await s.ok('GET', '/api/app');
    await s.ok('POST', `${B}/requests/${req.id}/reply`, { body: 'Done with L4.' }, { agent: 'qa' });
    const [back] = (await s.ok('GET', `/api/events?since=${s2}&for=guard&types=request.*`)).events;
    assert.deepEqual(back.addressed, ['guard'], 'the asker saying it is done wakes the agent it asked');
  });

  it('lease requests: ask the holder, who hands over or declines', async () => {
    const it = await mk({ title: 'contested' });
    await s.ok('POST', `${B}/items/${it.id}/start`, {}, { agent: 'holder2' });
    const { seq } = await s.ok('GET', '/api/app');
    await s.ok('POST', `${B}/items/${it.id}/lease/request`, { reason: 'I have the fix ready' }, { agent: 'asker2' });
    assert.equal((await s.ok('GET', `/api/events?since=${seq}&for=holder2&types=lease.requested`)).events.length, 1, 'the holder is told');
    const hw = await work({ agent: 'holder2' });
    assert.equal(hw.next[0].action, 'answer_lease_request');
    assert.equal((await s.api('POST', `${B}/items/${it.id}/lease/handover`, {}, { agent: 'asker2' })).status, 403, 'only the holder hands over');
    await s.ok('POST', `${B}/items/${it.id}/lease/handover`, { note: 'tests are in test/x' }, { agent: 'holder2' });
    assert.equal((await s.ok('GET', `${B}/items/${it.id}`)).lease.claimant, 'asker2');
    assert.equal((await s.ok('GET', `/api/events?since=${seq}&for=asker2&types=lease.handed`)).events.length, 1);
    await s.ok('POST', `${B}/items/${it.id}/lease/request`, { reason: 'mine now?' }, { agent: 'holder2' });
    await s.ok('POST', `${B}/items/${it.id}/lease/decline`, { reason: 'nearly done' }, { agent: 'asker2' });
    const [ev] = (await s.ok('GET', `/api/events?since=${seq}&for=holder2&types=lease.declined`)).events;
    assert.equal(ev.reason, 'nearly done');
    await s.ok('POST', `${B}/finish`, {}, { agent: 'asker2' });
  });

  it('new agents are asked to introduce themselves; names can be generated', async () => {
    const brief = await s.ok('GET', `${B}/brief`, undefined, { agent: 'newbie' });
    assert.match(brief, /First: introduce yourself/);
    const { name } = await s.ok('GET', '/api/names/suggest');
    assert.match(name, /^[a-z]+-[a-z]+$/);
    await s.ok('PATCH', '/api/profiles/me', { role: 'builder', alignment: 'careful' }, { agent: 'newbie' });
    const after = await s.ok('GET', `${B}/brief`, undefined, { agent: 'newbie' });
    assert.doesNotMatch(after, /First: introduce yourself/);
    assert.match(after, /Role: \*\*builder\*\*/);
  });

  it('MCP: introduce_yourself with a blank name picks a name and switches to it', async () => {
    const { spawn } = require('child_process');
    const path = require('path');
    const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'mcp.js')], { env: cleanEnv({ INTELLAGENT_URL: s.base, INTELLAGENT_MANIFEST: path.join(s.dir, 'intellagent.manifest.json') }), stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    mcp.stdout.on('data', (d) => (out += d));
    const send = (m) => mcp.stdin.write(`${JSON.stringify(m)}\n`);
    const reply = (id) => until(() => out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === id), 5000, `mcp reply ${id}`);
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'test-client' } } });
      assert.match((await reply(1)).result.instructions, /introduce_yourself/);
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'introduce_yourself', arguments: { role: 'reviewer', alignment: 'terse' } } });
      const prof = JSON.parse((await reply(2)).result.content[0].text);
      assert.match(prof.name, /^[a-z]+-[a-z]+$/);
      assert.equal(prof.role, 'reviewer');
    } finally { mcp.kill(); }
  });

  it('moving a reviewed ticket into Done approves it; other questions stay; bulk works too', async () => {
    const one = await mk({ title: 'drag-approve' });
    await s.ok('POST', `${B}/items/${one.id}/start`, {}, A);
    await s.ok('POST', `${B}/items/${one.id}/review`, { changed: 'x', why: 'y', verify: 'z' }, A);
    await s.ok('POST', `${B}/items/${one.id}/attention`, { reason: 'unrelated question' }, A);
    const { seq } = await s.ok('GET', '/api/app');
    await s.ok('POST', `${B}/items/${one.id}/move`, { column: 'Done' }, USER);
    const got = await s.ok('GET', `${B}/items/${one.id}`);
    assert.equal(got.review.verdict, 'approve');
    assert.deepEqual(got.questions.map((q) => q.kind), ['question'], 'the other question is left open');
    assert.match(got.comments.at(-1).body, /Approved ✓ \(moved to Done\)/);
    assert.equal((await s.ok('GET', `/api/events?since=${seq}&for=ada&types=review.approved`)).events.length, 1);

    const plain = await mk({ title: 'no review' });
    await s.ok('POST', `${B}/items/${plain.id}/move`, { column: 'Done' }, USER);
    assert.equal((await s.ok('GET', `${B}/items/${plain.id}`)).review, undefined, 'no open review: plain move');

    const two = await mk({ title: 'bulk-approve' });
    await s.ok('POST', `${B}/items/${two.id}/start`, {}, A);
    await s.ok('POST', `${B}/items/${two.id}/review`, { changed: 'x', why: 'y', verify: 'z' }, A);
    await s.ok('POST', `${B}/items/bulk`, { ids: [two.id], patch: { column: 'Done' } }, USER);
    assert.equal((await s.ok('GET', `${B}/items/${two.id}`)).review.verdict, 'approve');
  });

  it('an approval is heard (recipients) but does not address the requester; changes still do', async () => {
    const ok = await mk({ title: 'approve quietly' });
    await s.ok('POST', `${B}/items/${ok.id}/start`, {}, A);
    await s.ok('POST', `${B}/items/${ok.id}/review`, { changed: 'x', why: 'y', verify: 'z' }, A);
    const { seq } = await s.ok('GET', '/api/app');
    await s.ok('POST', `${B}/items/${ok.id}/review/decision`, { verdict: 'approve' }, USER);
    const heard = (await s.ok('GET', `/api/events?since=${seq}&for=ada&itemId=${ok.id}`)).events;
    const got = heard.map((e) => e.type);
    assert.ok(got.includes('review.approved') && got.includes('attention.resolved'), 'still in recipients');
    assert.equal((await s.ok('GET', `/api/events?since=${seq}&addressed=ada&itemId=${ok.id}`)).events.length, 0);

    const no = await mk({ title: 'changes wake' });
    await s.ok('POST', `${B}/items/${no.id}/start`, {}, A);
    await s.ok('POST', `${B}/items/${no.id}/review`, { changed: 'x', why: 'y', verify: 'z' }, A);
    const mark = (await s.ok('GET', '/api/app')).seq;
    await s.ok('POST', `${B}/items/${no.id}/review/decision`, { verdict: 'changes', comment: 'redo' }, USER);
    const types = (await s.ok('GET', `/api/events?since=${mark}&addressed=ada&itemId=${no.id}`)).events.map((e) => e.type);
    assert.ok(types.includes('review.changes_requested'));
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

  it('an approved ticket stays in Done: no new review request, no agent move out', async () => {
    const it = await s.ok('POST', `${B}/items`, { title: 'finished', column: 'Backlog' }, USER);
    await s.ok('POST', `${B}/items/${it.id}/start`, {}, A);
    await s.ok('POST', `${B}/items/${it.id}/review`, { summary: 'done' }, A);
    assert.equal((await s.ok('POST', `${B}/items/${it.id}/review/decision`, { verdict: 'approve' }, USER)).column, 'Done');
    const again = await s.api('POST', `${B}/items/${it.id}/review`, { summary: 'one more look?' }, A);
    assert.equal(again.body.code, 'ALREADY_DONE');
    assert.equal((await s.api('POST', `${B}/items/${it.id}/move`, { column: 'Review' }, A)).body.code, 'HUMAN_ONLY');
    assert.equal((await s.ok('GET', `${B}/items/${it.id}`)).column, 'Done');
  });

  it('review warns when the ticket barely spent time in the working column', async () => {
    const it = await s.ok('POST', `${B}/items`, { title: 'rushed', column: 'Backlog' }, USER);
    await s.ok('POST', `${B}/items/${it.id}/start`, {}, A);
    const r = await s.ok('POST', `${B}/items/${it.id}/review`, { summary: 'done already', evidence: 'npm test' }, A);
    assert.match(r.warnings?.[0] || '', /spent \d+s in/);
    const plain = await s.ok('POST', `${B}/items`, { title: 'never started', column: 'Backlog' }, USER);
    assert.equal((await s.ok('POST', `${B}/items/${plain.id}/review`, { summary: 'x', evidence: 'npm test' }, A)).warnings, undefined, 'no working-column visit, no claim about it');
  });

  it('test tickets: flagged at creation, immutable, deletable by anyone (leases apply); others are refused', async () => {
    const t1 = await s.ok('POST', `${B}/items`, { title: 'throwaway', column: 'Backlog', test: true }, USER);
    const keep = await s.ok('POST', `${B}/items`, { title: 'real work', column: 'Backlog', blockedBy: [t1.id] }, USER);
    assert.equal(t1.test, true);
    const imm = await s.api('PATCH', `${B}/items/${t1.id}`, { test: false }, USER);
    assert.equal(imm.status, 400);
    assert.equal(imm.body.code, 'IMMUTABLE');
    assert.equal((await s.api('PATCH', `${B}/items/${keep.id}`, { test: true }, USER)).body.code, 'IMMUTABLE');
    const refused = await s.api('DELETE', `${B}/items/${keep.id}`, undefined, A);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'NOT_TEST');
    // leased by another agent → refused; by its holder or anyone after release → gone
    await s.ok('POST', `${B}/items/${t1.id}/lease`, { minutes: 5 }, { agent: 'bob' });
    assert.equal((await s.api('DELETE', `${B}/items/${t1.id}`, undefined, A)).status, 423);
    await s.ok('DELETE', `${B}/items/${t1.id}/lease`, undefined, { agent: 'bob' });
    assert.deepEqual((await s.ok('DELETE', `${B}/items/${t1.id}`, undefined, A)).deleted, [t1.id]);
    assert.equal((await s.api('GET', `${B}/items/${t1.id}`)).status, 404, 'gone for good, not archived');
    assert.deepEqual((await s.ok('GET', `${B}/items/${keep.id}`)).blockedBy, [], 'no dangling blocker');
    // bulk: human only
    const t2 = await s.ok('POST', `${B}/items`, { title: 'another', column: 'Backlog', test: true }, USER);
    await s.ok('POST', `${B}/archive`, { ids: [t2.id] }, USER);
    assert.equal((await s.api('DELETE', `${B}/test-items`, undefined, A)).status, 403);
    assert.ok((await s.ok('DELETE', `${B}/test-items`, undefined, USER)).deleted.includes(t2.id), 'archived test tickets go too');
  });

  it('"let the agent write it": the writer rewrites everything except what the human set on purpose', async () => {
    const it = await s.ok('POST', `${B}/items`, { title: 'login thing broken??', column: 'Backlog', priority: 'High', agentWrite: true, writer: 'ada', explicit: ['priority'] }, USER);
    assert.deepEqual(it.agentDraft.explicit, ['priority']);
    assert.equal(it.agentDraft.original.title, 'login thing broken??');
    const w = await s.ok('GET', `${B}/work`, undefined, A);
    assert.ok(w.next.some((n) => n.action === 'write' && n.id === it.id), 'the writer is told to write it');
    // a human edit while it is pending becomes explicit too
    await s.ok('PATCH', `${B}/items/${it.id}`, { properties: { estimate: 3 } }, USER);
    const blocked = await s.api('PATCH', `${B}/items/${it.id}`, { priority: 'Low', type: 'issue' }, A);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'EXPLICIT');
    assert.equal((await s.api('PATCH', `${B}/items/${it.id}`, { properties: { estimate: 8 } }, A)).body.code, 'EXPLICIT');
    const done = await s.ok('PATCH', `${B}/items/${it.id}`, { title: 'Login fails after password reset', type: 'issue', description: '- [ ] reproduce', agentDraft: null }, A);
    assert.equal(done.priority, 'High', 'the explicit priority is untouched');
    assert.equal(done.agentDraft, undefined, 'the marker is cleared');
    assert.equal((await s.ok('PATCH', `${B}/items/${it.id}`, { priority: 'Low' }, A)).priority, 'Low', 'after the rewrite, normal rules again');
    assert.equal((await s.api('PATCH', `${B}/items/${it.id}`, { agentDraft: { explicit: [] } }, A)).status, 400);
  });

  it('requests carry pasted files, and the event gives the agent a local path it can open', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const { seq } = await s.ok('GET', '/api/app');
    const req = await s.ok('POST', `${B}/requests`, { body: 'what is wrong here?', to: 'ada', attachments: [{ name: 'shot.png', mime: 'image/png', dataBase64: png }] }, USER);
    assert.deepEqual(req.attachments.map((a) => a.name), ['shot.png']);
    const ev = (await s.ok('GET', `/api/events?since=${seq}&types=request.created`)).events.at(-1);
    assert.ok(require('fs').existsSync(ev.request.attachments[0].path), 'the agent can read the file');
    const r = await s.ok('POST', `${B}/requests/${req.id}/reply`, { attachments: [{ name: 'answer.png', mime: 'image/png', dataBase64: png }] }, A);
    assert.equal(r.replies.at(-1).attachments[0].name, 'answer.png', 'a reply can be just a file');
    assert.equal((await s.api('POST', `${B}/requests`, { body: 'x', to: 'ada', attachments: 'nope' }, USER)).status, 400);
  });

  it('create with a pasted image: the new ticket gets the attachment and its description points at it', async () => {
    // what the create modal does after Create (INT-33): create, upload each staged file, rewrite its blob: link
    const staged = 'blob:http://127.0.0.1/abc';
    const it = await s.ok('POST', `${B}/items`, { title: 'pasted', column: 'Backlog', description: `see ![shot.png](${staged})` }, USER);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const att = await s.ok('POST', `${B}/items/${it.id}/attachments`, { name: 'shot.png', mime: 'image/png', dataBase64: png }, USER);
    await s.ok('PATCH', `${B}/items/${it.id}`, { description: `see ![shot.png](${att.url})` }, USER);
    const got = await s.ok('GET', `${B}/items/${it.id}`);
    assert.deepEqual(got.attachments.map((a) => a.name), ['shot.png']);
    assert.ok(got.description.includes(att.url) && !got.description.includes('blob:'));
  });
});

describe('grants: powers the human delegates in agents.json', () => {
  let s;
  const ag = (agent) => ({ agent });
  before(async () => {
    s = await startServer({ agents: { agents: {
      approver: { enabled: false, grants: ['review.decide'] },
      gatekeeper: { enabled: false, grants: [{ power: 'column.gate', where: { 'properties.risk': 'low' } }] },
      boss: { enabled: false, grants: ['agents.control'] },
      worker: { enabled: false },
    } } });
  });
  after(async () => { await s.stop(); });
  const reviewed = async (title, by = 'worker', extra = {}) => {
    const it = await s.ok('POST', `${B}/items`, { title, column: 'Backlog', ...extra }, USER);
    await s.ok('POST', `${B}/items/${it.id}/start`, {}, ag(by));
    await s.ok('POST', `${B}/items/${it.id}/review`, { summary: 'ready' }, ag(by));
    return it;
  };

  it('review.decide: a granted agent decides (final, recorded as delegated); never its own work; the human can override', async () => {
    const it = await reviewed('feature');
    const no = await s.api('POST', `${B}/items/${it.id}/review/decision`, { verdict: 'approve' }, ag('worker'));
    assert.equal(no.body.code, 'HUMAN_ONLY');
    const { seq } = await s.ok('GET', '/api/app');
    const done = await s.ok('POST', `${B}/items/${it.id}/review/decision`, { verdict: 'approve', comment: 'tests pass, small change' }, ag('approver'));
    assert.equal(done.column, 'Done', 'a delegated approval goes through the gate');
    assert.deepEqual(done.review.delegated, { power: 'review.decide', onBehalfOf: 'human' });
    const ev = (await s.ok('GET', `/api/events?since=${seq}&types=review.approved`)).events.at(-1);
    assert.equal(ev.delegated.power, 'review.decide');
    // the human overrides
    const back = await s.ok('POST', `${B}/items/${it.id}/review/decision`, { verdict: 'changes', comment: 'not yet' }, USER);
    assert.equal(back.review.verdict, 'changes');
    assert.equal(back.review.delegated, undefined);
    // own work
    const mine = await reviewed('approver did this', 'approver');
    assert.equal((await s.api('POST', `${B}/items/${mine.id}/review/decision`, { verdict: 'approve' }, ag('approver'))).body.code, 'OWN_WORK');
  });

  it('column.gate: moves through human-only columns within its scope only', async () => {
    const low = await s.ok('POST', `${B}/items`, { title: 'low', column: 'Backlog', properties: { risk: 'low' } }, USER);
    const high = await s.ok('POST', `${B}/items`, { title: 'high', column: 'Backlog', properties: { risk: 'high' } }, USER);
    assert.equal((await s.api('POST', `${B}/items/${low.id}/move`, { column: 'Done' }, ag('worker'))).body.code, 'HUMAN_ONLY');
    const { seq } = await s.ok('GET', '/api/app');
    await s.ok('POST', `${B}/items/${low.id}/move`, { column: 'Done' }, ag('gatekeeper'));
    const ev = (await s.ok('GET', `/api/events?since=${seq}&types=item.moved`)).events.at(-1);
    assert.equal(ev.delegated.power, 'column.gate');
    assert.equal((await s.api('POST', `${B}/items/${high.id}/move`, { column: 'Done' }, ag('gatekeeper'))).body.code, 'OUT_OF_SCOPE');
    const open = await reviewed('open review', 'worker', { properties: { risk: 'low' } });
    assert.equal((await s.api('POST', `${B}/items/${open.id}/move`, { column: 'Done' }, ag('gatekeeper'))).body.code, 'REVIEW_OPEN');
  });

  it('agents.control: pause / resume others, never itself; grants show in permissions, the brief and metrics', async () => {
    assert.equal((await s.api('POST', '/api/agents/worker/pause', {}, ag('worker'))).body.code, 'HUMAN_ONLY');
    assert.equal((await s.ok('POST', '/api/agents/worker/pause', {}, ag('boss'))).status, 'paused');
    await s.ok('POST', '/api/agents/worker/resume', {}, ag('boss'));
    assert.equal((await s.api('POST', '/api/agents/boss/pause', {}, ag('boss'))).body.code, 'OWN_WORK');
    assert.equal((await s.api('POST', '/api/agents', { name: 'x', role: 'builder', grants: ['review.decide'] }, ag('boss'))).status, 403, 'defining agents stays human-only');
    const me = await s.ok('GET', '/api/permissions/me', undefined, ag('approver'));
    assert.deepEqual(me.grants.map((g) => g.power), ['review.decide']);
    const brief = (await s.api('GET', `${B}/brief`, undefined, ag('approver'))).body;
    assert.match(typeof brief === 'string' ? brief : brief.markdown, /Powers the human delegated to you/);
    const m = await s.ok('GET', `${B}/metrics?days=7`, undefined, USER);
    assert.ok(m.delegated.reviews >= 1 && m.delegated.moves >= 1);
  });
});

describe('agent manager: the agents.manage grant', () => {
  let s;
  const ag = (agent) => ({ agent });
  const patch = (who, target, body) => s.api('PATCH', `/api/agents/${target}`, body, who);
  before(async () => {
    s = await startServer({ agents: { agents: {
      mgr: { enabled: false, grants: ['agents.manage'] },
      scoped: { enabled: false, grants: [{ power: 'agents.manage', where: { agents: ['w1'] } }] },
      w1: { enabled: false, role: 'builder', perms: ['edit', 'test', 'git'] },
      w2: { enabled: false, role: 'builder' },
    } } });
  });
  after(async () => { await s.stop(); });

  it('changes label, role, personality and model of another agent, audited', async () => {
    const { seq } = await s.ok('GET', '/api/app');
    const r = await patch(ag('mgr'), 'w1', { label: 'Junior', alignment: 'careful, small steps', role: 'reviewer', model: 'haiku' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const a = await s.ok('GET', '/api/agents/w1');
    assert.equal(a.model, 'haiku');
    assert.equal(a.role, 'reviewer');
    assert.match(a.run, / --model haiku$/);
    assert.equal(a.changes.at(-1).by.name, 'mgr');
    assert.equal((await s.ok('GET', '/api/profiles')).w1.label, 'Junior');
    const ev = (await s.ok('GET', `/api/events?since=${seq}&types=agent.managed`)).events.at(-1);
    assert.equal(ev.delegated.power, 'agents.manage');
    const digest = (await s.ok('GET', `${B}/digest?days=1`)).flatMap((d) => d.entries);
    assert.ok(digest.some((e) => /Changed \*\*w1\*\*/.test(e.summary)), 'a delegated change leaves a digest line');
  });

  it('refuses escalation: non-delegable keys, models off the allowlist, widening, its own record, out of scope, no grant', async () => {
    assert.equal((await patch(ag('mgr'), 'w1', { run: 'rm -rf /' })).body.code, 'NOT_DELEGABLE');
    assert.equal((await patch(ag('mgr'), 'w1', { grants: ['agents.manage'] })).body.code, 'NOT_DELEGABLE');
    assert.equal((await patch(ag('mgr'), 'w1', { model: 'claude-opus-9000' })).body.code, 'MODEL_NOT_ALLOWED');
    assert.equal((await patch(ag('mgr'), 'mgr', { model: 'opus' })).body.code, 'OWN_WORK');
    assert.equal((await patch(ag('scoped'), 'w2', { label: 'x' })).body.code, 'OUT_OF_SCOPE');
    assert.equal((await patch(ag('w2'), 'w1', { label: 'x' })).body.code, 'HUMAN_ONLY');
    // tool perms and board permissions only narrow
    assert.equal((await patch(ag('mgr'), 'w1', { perms: ['edit'] })).status, 200);
    assert.equal((await patch(ag('mgr'), 'w1', { perms: ['edit', 'web'] })).body.code, 'WIDEN');
    assert.equal((await patch(ag('mgr'), 'w1', { permissions: { columns: ['Backlog', 'Ready'] } })).status, 200);
    assert.deepEqual((await s.ok('GET', '/api/permissions/me', undefined, ag('w1'))).permissions.columns, ['Backlog', 'Ready']);
    assert.equal((await patch(ag('mgr'), 'w1', { permissions: { columns: ['Backlog', 'Ready', 'Done'] } })).body.code, 'WIDEN');
    assert.equal((await patch(ag('mgr'), 'w1', { permissions: { readOnly: true } })).status, 200);
    assert.equal((await patch(ag('mgr'), 'w1', { permissions: { readOnly: false } })).body.code, 'WIDEN');
    // the human can widen again (revert)
    assert.equal((await patch(USER, 'w1', { permissions: { columns: null, readOnly: false }, perms: ['edit', 'test', 'git'] })).status, 200);
    assert.equal((await s.ok('GET', '/api/permissions/me', undefined, ag('w1'))).permissions, null);
    const me = await s.ok('GET', '/api/permissions/me', undefined, ag('mgr'));
    assert.deepEqual(me.grants.map((g) => g.power), ['agents.manage']);
  });
});

describe('a sleeping column: work waits there until the human (or the coordinator) wakes it', () => {
  let s;
  before(async () => {
    s = await startServer();
    await s.ok('PATCH', `${B}/columns/backlog`, { flags: { sleeping: true } }, USER);
    await s.ok('PATCH', B, { coordinator: 'coord' }, USER);
  });
  after(() => s.stop());
  const ev = async (seq, q) => (await s.ok('GET', `/api/events?since=${seq}&${q}`)).events;

  it('assigning a sleeping ticket wakes nobody, and its owner cannot start it', async () => {
    const { seq } = await s.ok('GET', '/api/app');
    const it = await s.ok('POST', `${B}/items`, { title: 'later', column: 'Backlog', assignee: 'ann' }, USER);
    const [assigned] = await ev(seq, 'types=item.assigned');
    assert.equal(assigned.addressed, undefined, 'a note of who will take it, not a call to start');
    const w = await s.ok('GET', `${B}/work`, undefined, { agent: 'ann' });
    assert.ok(!w.next.some((n) => n.id === it.id), 'not in its owner\'s work');
    const r = await s.api('POST', `${B}/items/${it.id}/start`, {}, { agent: 'ann' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'SLEEPING');
  });

  it('moving it to Ready wakes its owner, who can then start it', async () => {
    const it = await s.ok('POST', `${B}/items`, { title: 'now', column: 'Backlog', assignee: 'ann' }, USER);
    const { seq } = await s.ok('GET', '/api/app');
    await s.ok('POST', `${B}/items/${it.id}/move`, { column: 'Ready' }, USER);
    const [moved] = await ev(seq, 'types=item.moved');
    assert.deepEqual(moved.addressed, ['ann']);
    assert.ok((await s.ok('GET', `${B}/work`, undefined, { agent: 'ann' })).next.some((n) => n.id === it.id && n.action === 'start'));
    await s.ok('POST', `${B}/items/${it.id}/start`, {}, { agent: 'ann' });
  });

  it('agents file into the sleeping column; the coordinator chooses where an agent\'s ticket goes', async () => {
    const no = await s.api('POST', `${B}/items`, { title: 'found a bug', column: 'Ready' }, { agent: 'qa' });
    assert.equal(no.status, 403);
    assert.equal(no.body.code, 'SLEEPING');
    const filed = await s.ok('POST', `${B}/items`, { title: 'found a bug', column: 'Backlog' }, { agent: 'qa' });
    assert.equal((await s.api('POST', `${B}/items/${filed.id}/move`, { column: 'Ready' }, { agent: 'qa' })).body.code, 'SLEEPING', 'not by the agent that filed it');
    await s.ok('POST', `${B}/items/${filed.id}/move`, { column: 'Ready' }, { agent: 'coord' });
    await s.ok('POST', `${B}/items`, { title: 'urgent, from triage', column: 'Ready' }, { agent: 'coord' });
  });

  it('the human\'s own sleeping tickets are woken by the human alone', async () => {
    const mine = await s.ok('POST', `${B}/items`, { title: 'my idea', column: 'Backlog' }, USER);
    const r = await s.api('POST', `${B}/items/${mine.id}/move`, { column: 'Ready' }, { agent: 'coord' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'SLEEPING');
  });
});
