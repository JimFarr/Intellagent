'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Asks (INT-391): what one agent needs from another, as data instead of an @mention. An ask has an owner (to), a
// kind, what is needed and a due time; it is a work item for its owner, closes itself when the thing is done (or
// when the owner answers it), and escalates once when it is overdue. Pure rules over a ticket's asks; the board
// (server.js) and the alerting simulator apply them.
//
//   ask on a ticket: { id, by, to, kind, what, options?, at, dueAt, state: open | done | withdrawn,
//                      answer?, doneAt?, doneBy?, escalated? }

// What an ask can be for, and how each one closes itself:
//   review           the owner gives its verdict on the ticket
//   fix              the owner asks for review again (it fixed what was asked)
//   assign_reviewer  a reviewer is assigned to the ticket
//   answer, decide, unblock, other   the owner answers it: POST …/asks/<id>/done { answer }
const KINDS = ['answer', 'decide', 'review', 'fix', 'assign_reviewer', 'unblock', 'other'];
const DUE_MINUTES = 60;
const MAX_DUE_MINUTES = 7 * 24 * 60;

function newAsk({ id, by, to, kind = 'answer', what, options = null, dueMinutes = DUE_MINUTES, escalates = null, now }) {
  const due = Math.min(MAX_DUE_MINUTES, Math.max(1, Number(dueMinutes) || DUE_MINUTES));
  return { id, by, to, kind, what, ...(options?.length ? { options } : {}), ...(escalates ? { escalates } : {}), at: new Date(now).toISOString(), dueAt: new Date(now + due * 60_000).toISOString(), state: 'open' };
}

const openAsks = (item) => (item.asks || []).filter((a) => a.state === 'open');

// What happened on the ticket that may close asks: { kind: 'verdict', who } | { kind: 'review_requested', who } |
// { kind: 'reviewer_assigned' }. Returns the asks it closed (marked done, answered by the board).
function closeBy(item, trigger, nowIso) {
  const closes = (a) => (trigger.kind === 'verdict' && a.kind === 'review' && a.to === trigger.who)
    || (trigger.kind === 'review_requested' && a.kind === 'fix' && a.to === trigger.who)
    || (trigger.kind === 'reviewer_assigned' && a.kind === 'assign_reviewer');
  const closed = openAsks(item).filter(closes);
  const said = { verdict: 'verdict given', review_requested: 'review requested again', reviewer_assigned: 'reviewer assigned' }[trigger.kind];
  for (const a of closed) Object.assign(a, { state: 'done', answer: `(${said})`, doneAt: nowIso, doneBy: trigger.who || null, auto: true });
  return closed;
}

// An ask that is done takes its escalations with it: the coordinator was asked to chase it, and there is nothing left
// to chase. Returns the escalations it closed.
function closeEscalations(item, ask, nowIso) {
  const ups = openAsks(item).filter((a) => a.escalates === ask.id);
  for (const a of ups) Object.assign(a, { state: 'done', answer: `(${ask.to} answered: ${String(ask.answer || '').slice(0, 200)})`, doneAt: nowIso, doneBy: ask.doneBy || null, auto: true });
  return ups;
}

// Open asks past their due time that have not been escalated yet.
const overdueAsks = (item, nowMs) => openAsks(item).filter((a) => !a.escalated && Date.parse(a.dueAt) <= nowMs);

module.exports = { KINDS, DUE_MINUTES, MAX_DUE_MINUTES, newAsk, openAsks, closeBy, closeEscalations, overdueAsks };
