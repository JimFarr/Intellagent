'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Board geometry the alerting rules read (INT-382): pure functions of a board context { id, board }. The board
// (server.js), lib/focus.js and the alerting simulator share them, so they can't disagree about what is done,
// where work is picked up, what is blocked or asleep, or who is on the active focus board.

const PRIO_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };

const findColumnById = (b, id) => b.columns.find((c) => c.id === id);
// The last column is the done column: a ticket there counts as finished (and approved).
const doneColumnId = (ctx) => ctx.board.columns[ctx.board.columns.length - 1]?.id;
// A ticket's blockers that are not done yet (a blocker archived or deleted no longer blocks).
const openBlockersOf = (ctx, item) => (item.blockedBy || []).filter((id) => ctx.board.items[id] && ctx.board.items[id].columnId !== doneColumnId(ctx));
// Whether a ticket sits in a sleeping column (work nobody should start yet).
const asleep = (ctx, item) => !!findColumnById(ctx.board, item.columnId)?.flags?.sleeping;
// Where agents pick up work. Flags win; names are the fallback.
function pickupColumns(ctx) {
  const cols = ctx.board.columns;
  const flagged = cols.filter((c) => c.flags?.pickup);
  if (flagged.length) return flagged;
  const named = cols.filter((c) => /^(ready|to ?do|todo|next|up next|selected)$/i.test(c.name));
  return named.length ? named : cols.slice(0, 1);
}
// Questions a person has to answer: those the board raised itself (stuck watch, escalations) don't freeze a ticket (INT-415)
const humanQuestions = (it) => (it.questions || []).filter((q) => q.raisedBy !== 'intellagent');
// A time as milliseconds: 0 when it is missing or unreadable (never NaN, so Math.max and comparisons hold)
const timeOf = (x) => (x ? Date.parse(x) || 0 : 0);
// The human's reply to a closed question: the first comment they wrote after it was asked.
function replyAfter(item, w) {
  const c = (w.id && (item.comments || []).find((x) => x.answers === w.id || (w.withdrawn && x.withdrew === w.id))) || (item.comments || []).find((x) => x.author?.kind === 'user' && x.createdAt >= w.raisedAt);
  return c ? c.body : null;
}
// Did this agent work on the ticket or ask for its review? (It can't then judge or approve it.)
const ownWork = (item, name) => !!item && ((item.workedBy || []).includes(name) || (item.questions || []).some((q) => q.kind === 'review' && q.raisedBy === name)
  || item.review?.requestedBy === name);
// Who counts as an author of a ticket's work: never one of its reviewers.
const authorsOf = (item) => new Set([item.review?.requestedBy, ...(item.questions || []).filter((q) => q.kind === 'review').map((q) => q.raisedBy), ...(item.workedBy || []), item.assignee].filter(Boolean));

// Focus boards: one is active at a time; while it is, agents work only on its tickets.
const activeFocus = (ctx) => (ctx.board.focusBoards || []).find((f) => f.id === ctx.board.activeFocus) || null;
const inActiveFocus = (ctx, it) => { const f = activeFocus(ctx); return !f || f.itemIds.includes(it.id); };
const focusNames = (ctx, id) => (ctx.board.focusBoards || []).filter((f) => f.itemIds.includes(id)).map((f) => f.name);

module.exports = { timeOf, PRIO_RANK, findColumnById, doneColumnId, openBlockersOf, asleep, pickupColumns, humanQuestions, replyAfter, ownWork, authorsOf, activeFocus, inActiveFocus, focusNames };
