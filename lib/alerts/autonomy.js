'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// How self-sufficient a board is (INT-393): each ticket's journey from pickup to Done, and every time a human stepped
// in along the way. Pure: the board steps a ticket's journey with the events of each change it saves, the simulator
// does the same, and the board's metrics count the journeys.
//
//   journey: { pickedUpAt, doneAt?, level?, touches: { kind: n }, moves, back }
//     pickedUpAt  the first time the ticket entered the working column, or a column after it
//     doneAt      the last time it entered the final column; a ticket reopened and picked up again starts a new journey
//     touches     human interventions between the two, by kind:
//                   answer (an agent's question answered), comment, move, assign, edit, stop (a lease revoked),
//                   changes (a review sent back), decision (the approval)
//     moves/back  column moves during the journey, and how many went backwards (rework)
//     lastProgressAt  the last time something moved it on (INT-394): a move, a review asked for, a verdict, an answer or
//                 a decision, an ask answered, or a comment from the human or from the ticket's own owner. Not a lease
//                 claimed or renewed, nor a status line: an agent re-claiming a ticket it never finishes makes no progress.
//     level       once done: autonomous (no human at all: the approval was delegated), approved (the only human touch
//                 was the approval) or helped (a human stepped in during the work)

const LEVELS = ['autonomous', 'approved', 'helped'];
const PROGRESS = new Set(['item.moved', 'review.requested', 'review.reviewed', 'review.approved', 'review.changes_requested', 'attention.raised', 'attention.resolved', 'ask.done', 'lease.handed', 'item.unblocked']);
// A comment moves a ticket on when the human writes it, or the ticket's owner (its assignee or holder): not a nudge
// The board's own doings (an escalation question, a sweep's note) are never progress: they say a ticket is stuck.
const progressOf = (e) => e.actor?.kind !== 'system' && (PROGRESS.has(e.type) || (e.type === 'comment.added' && (e.actor?.kind === 'user' || [e.item?.assignee, e.item?.claimant].includes(e.actor?.name))));
const TOUCH_KINDS = ['answer', 'comment', 'move', 'assign', 'edit', 'stop', 'changes', 'decision'];

function levelOf(touches) {
  const kinds = Object.keys(touches).filter((k) => touches[k] > 0);
  if (!kinds.length) return 'autonomous';
  return kinds.every((k) => k === 'decision') ? 'approved' : 'helped';
}

// What kind of intervention a human's event is, or null when it isn't one (a reaction, a review request, …).
function touchOf(e, cols) {
  switch (e.type) {
    case 'comment.added': return 'comment';
    case 'attention.resolved': return e.kind === 'review' ? null : 'answer'; // a review's decision counts once, below
    case 'review.approved': return 'decision';
    case 'review.changes_requested': return 'changes';
    case 'item.moved': return cols.indexOf(e.columnId) === cols.done ? 'decision' : 'move';
    case 'item.assigned': return 'assign';
    case 'item.updated': return 'edit';
    case 'lease.revoked': return 'stop';
    default: return null;
  }
}

/**
 * The ticket's journey after one saved change. events: the change's events about this ticket, in order.
 * cols: { indexOf(columnId) → index, working: index of the working column, done: index of the final column }.
 * nowIso: when the change happened, for events not yet stamped (inside the board's transaction they aren't).
 */
function stepJourney(journey, events, cols, nowIso = new Date().toISOString()) {
  let j = journey ? { ...journey, touches: { ...journey.touches } } : null;
  // A human decision moves the ticket in the same change: that move is part of the decision, not a move of its own.
  const decided = events.some((e) => e.actor?.kind === 'user' && (e.type === 'review.approved' || e.type === 'review.changes_requested'));
  for (const e of events) {
    const at = e.ts || nowIso;
    if (e.type === 'item.moved') {
      const to = cols.indexOf(e.columnId);
      const from = cols.indexOf(e.fromColumnId);
      if (j?.doneAt && to !== cols.done) j = null; // reopened: a new journey begins when it is picked up again
      if (!j) {
        if (to >= cols.working && to !== cols.done && cols.working >= 0) j = { pickedUpAt: at, lastProgressAt: at, touches: {}, moves: 0, back: 0 };
        continue;
      }
      if (j.doneAt) continue;
      j.moves++;
      if (from >= 0 && to < from) j.back++;
    }
    if (!j || j.doneAt) continue; // not picked up yet, or already done: nothing to count
    if (progressOf(e)) j.lastProgressAt = at;
    if (e.actor?.kind === 'user') {
      let kind = touchOf(e, cols);
      if (kind === 'move' && decided) kind = null;
      if (kind === 'decision') j.touches.decision = 1; // one approval, however many events say so
      else if (kind) j.touches[kind] = (j.touches[kind] || 0) + 1;
    }
    if (e.type === 'item.moved' && cols.indexOf(e.columnId) === cols.done && !j.doneAt) {
      j.doneAt = at;
      j.level = levelOf(j.touches);
    }
  }
  return j;
}

// The columns a journey is measured against: the working column (flag working, else the second column) and the last.
function columnsOf(board) {
  const ids = board.columns.map((c) => c.id);
  const working = board.columns.findIndex((c) => c.flags?.working);
  return { indexOf: (id) => ids.indexOf(id), working: working >= 0 ? working : Math.min(1, ids.length - 1), done: ids.length - 1 };
}

module.exports = { LEVELS, TOUCH_KINDS, PROGRESS, progressOf, levelOf, touchOf, stepJourney, columnsOf };
