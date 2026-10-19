'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Asks (INT-391): what one agent needs from another, as data instead of an @mention. An ask has an owner (to), a
// kind, what is needed and a due time; it is a work item for its owner, closes itself when the thing is done (or
// when the owner answers it), and escalates once when it is overdue. Pure rules over a ticket's asks; the board
// (server.js) and the alerting simulator apply them.
//
//   ask on a ticket: { id, by, to, kind, what, options?, escalates?, at, dueAt, state: open | done | withdrawn,
//                      answer?, doneAt?, doneBy?, auto?, escalated?, questionId? }
//     escalates   the ask this one escalates (made by the board for the coordinator when that one went overdue)
//     escalated   when this one went overdue and was escalated; questionId: the human's question it opened, if any

// What an ask can be for, and how each one closes itself:
//   review           the owner gives its verdict on the ticket
//   fix              the owner asks for review again (it fixed what was asked)
//   assign_reviewer  a reviewer is assigned to the ticket
//   answer, decide, unblock, other   the owner answers it: POST …/asks/<id>/done { answer }
const KINDS = ['answer', 'decide', 'review', 'fix', 'assign_reviewer', 'unblock', 'other'];
const SELF_CLOSING = new Set(['review', 'fix', 'assign_reviewer']);
const RULES = { dueMinutes: 60, maxDueMinutes: 7 * 24 * 60, keep: 50 };

function newAsk({ id, by, to, kind = 'answer', what, options = null, dueMinutes, escalates = null, now }, rules = RULES) {
  const due = Math.min(rules.maxDueMinutes, Math.max(1, Number(dueMinutes) || rules.dueMinutes));
  return { id, by, to, kind, what, ...(options?.length ? { options } : {}), ...(escalates ? { escalates } : {}), at: new Date(now).toISOString(), dueAt: new Date(now + due * 60_000).toISOString(), state: 'open' };
}

const openAsks = (item) => (item.asks || []).filter((a) => a.state === 'open');

// Add an ask to a ticket, keeping at most rules.keep: the closed ones go first, never an open one.
function addAsk(item, ask, rules = RULES) {
  const all = [...(item.asks || []), ask];
  const open = all.filter((a) => a.state === 'open');
  const closed = all.filter((a) => a.state !== 'open');
  item.asks = open.length >= rules.keep ? all.filter((a) => a.state === 'open') : [...closed.slice(-(rules.keep - open.length)), ...open].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}

/**
 * Finish an ask (answered, done by itself, or withdrawn) and everything linked to it: the escalation made for it,
 * and, when it is itself an escalation, the ask it escalated (the coordinator answered it for the owner).
 * Returns { closed: [the linked asks closed], questionIds: [the human's questions they had opened, to close] }.
 */
function finish(item, ask, fields, nowIso) {
  Object.assign(ask, { ...fields, doneAt: nowIso });
  const closed = [];
  const questionIds = ask.questionId ? [ask.questionId] : [];
  const note = fields.state === 'withdrawn' ? `(withdrawn: ${fields.answer || 'no longer needed'})` : `(${ask.to} answered: ${String(fields.answer || '').slice(0, 200)})`;
  for (const a of openAsks(item)) {
    if (a.escalates !== ask.id && a.id !== ask.escalates) continue;
    Object.assign(a, { state: fields.state === 'withdrawn' ? 'withdrawn' : 'done', answer: note, doneAt: nowIso, doneBy: fields.doneBy || null, auto: true });
    if (a.questionId) questionIds.push(a.questionId);
    closed.push(a);
  }
  return { closed, questionIds };
}

// What happened on the ticket that may close asks: { kind: 'verdict', who } | { kind: 'review_requested', who } |
// { kind: 'reviewer_assigned' }. Returns [{ ask, linked }] for each ask it closed (answered by the board).
function closeBy(item, trigger, nowIso) {
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const closes = (a) => (trigger.kind === 'verdict' && a.kind === 'review' && same(a.to, trigger.who))
    || (trigger.kind === 'review_requested' && a.kind === 'fix' && same(a.to, trigger.who))
    || (trigger.kind === 'reviewer_assigned' && a.kind === 'assign_reviewer');
  const said = { verdict: 'verdict given', review_requested: 'review requested again', reviewer_assigned: 'reviewer assigned' }[trigger.kind];
  return openAsks(item).filter(closes).map((a) => ({ ask: a, linked: finish(item, a, { state: 'done', answer: `(${said})`, doneBy: trigger.who || null, auto: true }, nowIso) }));
}

// Open asks past their due time that have not been escalated yet.
const overdueAsks = (item, nowMs) => openAsks(item).filter((a) => !a.escalated && Date.parse(a.dueAt) <= nowMs);

/**
 * Where an overdue ask goes: to the coordinator as an ask of its own (unless it is the asker or the owner, who can't
 * chase themselves), else to the human as a question. → { ask } | { question: reason }
 */
function escalationOf(ask, coordinator, { id, now }, rules = RULES) {
  if (coordinator && coordinator !== ask.to && coordinator !== ask.by) {
    const due = new Date(Date.parse(ask.dueAt)).toISOString().slice(11, 16);
    return { ask: newAsk({ id, by: 'intellagent', to: coordinator, kind: 'unblock', escalates: ask.id, now,
      what: `${ask.by} asked ${ask.to} (${ask.kind}): ${ask.what}. Overdue since ${due} UTC: get it done, or answer it for them` }, rules) };
  }
  return { question: `${ask.by} asked ${ask.to} and it is overdue (${ask.kind}): ${ask.what}` };
}

module.exports = { KINDS, SELF_CLOSING, RULES, newAsk, openAsks, addAsk, finish, closeBy, overdueAsks, escalationOf };
