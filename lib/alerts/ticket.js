'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// The writes on a ticket that raise or settle what someone waits on: questions for the human, a review verdict,
// asks finished or closed, and the human asked about a stuck ticket. The board (inside its tx) and the alerting
// simulator both call these, so the simulator can never drift from the board (INT-420).
//
// deps: { itemEvent(ctx, type, item, actor, extra), rid(prefix), now() → ISO time }
const ASKS = require('./asks');
const STUCK = require('./stuck');

const SYSTEM = { kind: 'system', name: 'intellagent' };
const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
// The coordinator that takes an overdue ask: the board's, else a standing agent with the coordinator role
const coordinatorOf = (board, agents) => board.coordinator || agents.find((a) => a.enabled && a.role === 'coordinator')?.name || null;
// Who last worked a ticket: the five most recent, each once.
function addWorker(item, name) {
  if (!(item.workedBy || []).includes(name)) item.workedBy = [...(item.workedBy || []), name].slice(-5);
}

function createTicketWrites({ itemEvent, rid, now }) {
  // A ticket can carry several open questions. `needsHuman` mirrors the oldest one so older clients,
  // filters and the UI's "needs you" flag keep working.
  function syncNeeds(item) { item.questions ||= item.needsHuman ? [{ id: rid('q'), ...item.needsHuman }] : []; item.needsHuman = item.questions[0] || null; }

  // Closed "needs you" requests, kept for metrics (how long agents waited on the human).
  function closeWait(item, prev, actor, more = {}) {
    (item.waits ||= []).push({ id: prev.id || null, reason: prev.reason || null, raisedBy: prev.raisedBy, raisedAt: prev.raisedAt, resolvedAt: now(), by: actor.name, kind: prev.kind || 'question', ...more });
    if (item.waits.length > 30) item.waits.shift();
  }

  // Open a question (an identical open one from the same asker is reused). Returns it.
  function openQuestion(ctx, item, q, actor, events) {
    syncNeeds(item);
    const same = item.questions.find((x) => x.raisedBy === q.raisedBy && x.reason === q.reason && x.kind === q.kind
      && JSON.stringify(x.form || null) === JSON.stringify(q.form || null));
    if (same) return same;
    item.questions.push(q);
    syncNeeds(item);
    events.push(itemEvent(ctx, 'attention.raised', item, actor, { questionId: q.id, reason: q.reason, kind: q.kind, open: item.questions.length }));
    return q;
  }

  // Close questions (all, or those matching `pick`), each with its own event; the reply is posted once.
  function closeQuestions(ctx, item, actor, events, { pick = () => true, reply = null, extra = {} } = {}) {
    syncNeeds(item);
    const closing = item.questions.filter(pick);
    if (!closing.length) return [];
    item.questions = item.questions.filter((q) => !closing.includes(q));
    syncNeeds(item);
    for (const q of closing) {
      closeWait(item, q, actor, { ...(extra.form ? { form: extra.form } : {}), ...(extra.withdrawn ? { withdrawn: true } : {}) });
      events.push(itemEvent(ctx, 'attention.resolved', item, actor, { questionId: q.id, raisedBy: q.raisedBy, reason: q.reason, kind: q.kind, reply, open: item.questions.length, mentions: [q.raisedBy === SYSTEM.name ? item.assignee || item.workedBy?.at(-1) || q.raisedBy : q.raisedBy], ...extra })); // a board-raised question wakes the ticket's owner (INT-415)
    }
    return closing;
  }

  // Record a review verdict: the human's comment, the review question closed, item.review set, and
  // review.approved / review.changes_requested sent to whoever asked and worked on it. Returns who asked for the
  // review: landing an approval is the caller's (git on the board, a story in the simulator).
  function recordVerdict(ctx, item, actor, events, verdict, comment = '', grant = null) {
    syncNeeds(item);
    const prev = item.questions.find((q) => q.kind === 'review') || null;
    const requestedBy = prev?.raisedBy || item.workedBy?.at(-1) || null;
    const said = comment || 'Approved ✓';
    const body = grant ? `${said}\n\n_Decided on the human's behalf (\`${grant.power}\` grant)._` : said;
    if (comment || verdict === 'approve') item.comments.push({ id: rid('c'), author: actor, body, createdAt: now() });
    closeQuestions(ctx, item, actor, events, { pick: (q) => q.kind === 'review', reply: body, extra: { verdict } });
    const delegated = grant ? { power: grant.power, onBehalfOf: 'human' } : null;
    item.review = { verdict, comment: comment || null, by: actor.name, at: now(), requestedBy, ...(delegated ? { delegated } : {}) };
    const who = [requestedBy, ...(item.workedBy || [])].filter(Boolean);
    events.push(itemEvent(ctx, verdict === 'approve' ? 'review.approved' : 'review.changes_requested', item, actor, { verdict, feedback: comment || null, mentions: who, ...(delegated ? { delegated } : {}) }));
    return requestedBy;
  }

  // Finish an ask and what is linked to it (its escalation, the ask an escalation was for, the human's question an
  // overdue one opened), each said on the board.
  function finishAsk(ctx, it, a, fields, actor, events) {
    const { closed, questionIds } = ASKS.finish(it, a, fields, now());
    const type = fields.state === 'withdrawn' ? 'ask.withdrawn' : 'ask.done';
    events.push(itemEvent(ctx, type, it, actor, { ask: { ...a }, ...(type === 'ask.done' ? { mentions: [a.by].filter((n) => !sameName(n, actor.name)) } : {}) }));
    for (const x of closed) events.push(itemEvent(ctx, type, it, actor, { ask: { ...x } }));
    if (questionIds.length) closeQuestions(ctx, it, actor, events, { pick: (q) => questionIds.includes(q.id), reply: `The ask was ${fields.state === 'withdrawn' ? 'withdrawn' : 'answered'}: ${fields.answer || ''}` });
  }

  // Something happened on the ticket that does what an ask asked for: close those asks (and what is linked to them).
  function closeAsks(ctx, it, events, trigger, actor) {
    for (const { ask, linked } of ASKS.closeBy(it, trigger, now())) {
      events.push(itemEvent(ctx, 'ask.done', it, actor, { ask: { ...ask }, mentions: [ask.by].filter((n) => !sameName(n, actor.name)) }));
      for (const x of linked.closed) events.push(itemEvent(ctx, 'ask.done', it, actor, { ask: { ...x } }));
      if (linked.questionIds.length) closeQuestions(ctx, it, actor, events, { pick: (q) => linked.questionIds.includes(q.id), reply: 'The ask was answered' });
    }
  }

  // The stuck watch's last round: the human is asked once about each ticket due (STUCK.sweepBoard's `due`), and
  // its entry in `next` says so. The caller saves `next` as board.stuck.
  function askAboutStuck(ctx, events, due, next, nowMs, timings) {
    for (const id of due) {
      const reason = STUCK.humanQuestion(next[id], nowMs, timings, ctx.board.items[id]);
      openQuestion(ctx, ctx.board.items[id], { id: rid('q'), reason: String(reason).slice(0, 2000), raisedBy: SYSTEM.name, raisedAt: now(), kind: 'question' }, SYSTEM, events);
      next[id].escalated = new Date(nowMs).toISOString();
    }
  }

  return { syncNeeds, closeWait, openQuestion, closeQuestions, recordVerdict, finishAsk, closeAsks, askAboutStuck };
}

module.exports = { createTicketWrites, coordinatorOf, addWorker, sameName, SYSTEM };
