'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// The stuck watch (INT-394): every unfinished ticket, followed over time. A ticket picked up and not done that has
// been quiet for a while is entered in the board's ledger with why; once it is still stuck a while later the board is
// sure, and the coordinator gets an unstick item, once per round; after two rounds the human is asked instead.
// Pure rules over plain data: the board sweeps with them, and the alerting simulator does the same.
//
//   ledger: { [ticketId]: { since, reason, owner?, escalated? } }

// How long each step takes. The manifest may tune them: "stuck": { "quietMinutes", "sureAfterMinutes", "roundMinutes", "rounds" }
const TIMINGS = Object.freeze({
  quietMs: 60 * 60_000,    // nothing on the ticket for this long: stuck
  confirmMs: 30 * 60_000,  // still stuck this long after it was first seen: sure
  roundMs: 60 * 60_000,    // the coordinator is woken once per round; after `rounds` rounds, the human
  rounds: 2,
});
// The manifest's "stuck" block as timings; anything missing or not a positive number keeps the default
function timingsOf(cfg) {
  const n = (v, unit) => (Number(v) > 0 ? Number(v) * unit : null);
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  return Object.freeze({ quietMs: n(c.quietMinutes, 60_000) ?? TIMINGS.quietMs, confirmMs: n(c.sureAfterMinutes, 60_000) ?? TIMINGS.confirmMs,
    roundMs: n(c.roundMinutes, 60_000) ?? TIMINGS.roundMs, rounds: Math.round(n(c.rounds, 1) ?? TIMINGS.rounds) });
}
const REASONS = ['waiting_on_human', 'no_owner', 'owner_down', 'owner_quiet', 'held_quiet'];

// When the ticket last moved on: its journey's progress (lib/alerts/autonomy.js), never a lease claimed again, a status
// line or an ask made about it. A journey kept before progress was (backfilled, INT-393) has none: its general activity
// stands in, so a board upgraded mid-flight doesn't find every long-running ticket stuck at once.
const lastActivity = (it) => (it.journey?.lastProgressAt ? Date.parse(it.journey.lastProgressAt) || 0
  : Math.max(Date.parse(it.journey?.pickedUpAt || 0) || 0, Date.parse(it.updatedAt || 0) || 0, Date.parse(it.enteredColumnAt || 0) || 0, ...(it.comments || []).map((c) => Date.parse(c.createdAt) || 0)));

/**
 * Is this ticket stuck now, and why? null when it is not.
 * who: { owners: [names with work on it], running(name), status(name) → idle|paused|failed|…, sleeping(columnId) }
 */
function assess(it, nowMs, who, t = TIMINGS) {
  const j = it.journey;
  if (!j || j.doneAt || it.test || who.sleeping(it.columnId)) return null;
  if (nowMs - lastActivity(it) < t.quietMs) return null;
  // an ask still within its time is being handled: it stays stuck (its time and rounds go on) without waking anyone
  const asked = (it.asks || []).some((a) => a.state === 'open' && Date.parse(a.dueAt) > nowMs);
  const r = assessReason(it, nowMs, who);
  return r && asked ? { ...r, asked: true } : r;
}
function assessReason(it, nowMs, who) {
  if ((it.questions || []).length) return { reason: 'waiting_on_human' };
  const holder = it.lease && Date.parse(it.lease.expiresAt) > nowMs ? it.lease.claimant : null;
  if (holder && !who.running(holder)) return { reason: 'held_quiet', owner: holder };
  const owners = who.owners.filter((n) => n !== holder);
  if (!owners.length && !holder) return { reason: 'no_owner' };
  const down = owners.find((n) => ['paused', 'failed', 'disabled'].includes(who.status(n)));
  if (down) return { reason: 'owner_down', owner: down };
  const quiet = owners.find((n) => !who.running(n));
  return quiet ? { reason: 'owner_quiet', owner: quiet } : null; // its owner is at it right now
}

// The ledger after a sweep: stuck tickets kept (with when they were first seen), new ones added, the rest dropped.
// A ticket whose reason changes keeps its time: it has been stuck all along.
function sweep(ledger, found, nowIso) {
  const next = {};
  for (const [id, s] of Object.entries(found)) {
    const was = ledger?.[id];
    next[id] = { since: was?.since || nowIso, reason: s.reason, ...(s.owner ? { owner: s.owner } : {}), ...(s.asked ? { asked: true } : {}), ...(was?.escalated ? { escalated: was.escalated } : {}) };
  }
  return next;
}

// Work items that don't make an agent the ticket's owner: housekeeping, conversation, and the watchers themselves
// (supervision and this watch). The one list for "who will move this ticket on": the stuck watch and the unowned gauge.
const NOT_OWNING = new Set(['reply', 'renew', 'mention', 'unstick', 'supervise', 'ask_answered', 'continue']);
// ticket id → names of the agents whose work moves it on. works: { [name]: workFor(ctx, name) }
function ownersOf(works) {
  const out = new Map();
  for (const [name, w] of Object.entries(works)) for (const n of w.next || []) {
    if (!n.id || NOT_OWNING.has(n.action)) continue;
    (out.get(n.id) || out.set(n.id, new Set()).get(n.id)).add(name);
  }
  return out;
}

const confirmed = (e, nowMs, t = TIMINGS) => nowMs - Date.parse(e.since) >= t.confirmMs;
// 0, 1, … rounds since it was confirmed; the coordinator is woken once in each
const roundOf = (e, nowMs, t = TIMINGS) => Math.floor((nowMs - Date.parse(e.since) - t.confirmMs) / t.roundMs);
// Due for the coordinator: confirmed, not the human's, within its rounds
const forCoordinator = (e, nowMs, t = TIMINGS) => e.reason !== 'waiting_on_human' && !e.asked && confirmed(e, nowMs, t) && roundOf(e, nowMs, t) < t.rounds;
// Due for the human: past its rounds, not asked yet, and nobody is being asked about it within their time
const forHuman = (e, nowMs, t = TIMINGS) => e.reason !== 'waiting_on_human' && confirmed(e, nowMs, t) && roundOf(e, nowMs, t) >= t.rounds && !e.escalated && !e.asked;
const label = (reason) => reason.replaceAll('_', ' ');
// How long the ticket has been quiet: from its last progress, not from when the watch first listed it (that was
// already quietMs later). Without the ticket, worked out from the entry.
const quietFor = (e, nowMs, t = TIMINGS, it = null) => nowMs - (it ? lastActivity(it) : Date.parse(e.since) - t.quietMs);
const hours = (ms) => Math.round(ms / 360_000) / 10;
// What the human is asked once the coordinator's rounds are over
const humanQuestion = (e, nowMs, t = TIMINGS, it = null) => `Quiet for ${hours(quietFor(e, nowMs, t, it))} h (${label(e.reason)}${e.owner ? `: ${e.owner}` : ''}), and the coordinator could not move it on in ${t.rounds} rounds. What should happen to it?`;

/**
 * One sweep of a board, the same on the board and in the simulator: every ticket assessed, the ledger after it, and
 * the tickets now due for the human. The caller commits it (the ledger, and a question for each one due).
 * who: { works: { [name]: workFor(ctx, name) } for every standing agent (paused ones too: an owner that can't run is
 *        down, not absent), running(name), status(name) }
 * → { next, due: [ticketId], owners }
 */
function sweepBoard(board, nowMs, who, t = TIMINGS) {
  const owners = ownersOf(who.works);
  const sleeping = new Set(board.columns.filter((c) => c.flags?.sleeping).map((c) => c.id));
  const found = {};
  for (const it of Object.values(board.items)) {
    const s = assess(it, nowMs, { owners: [...(owners.get(it.id) || [])], running: who.running, status: who.status, sleeping: (c) => sleeping.has(c) }, t);
    if (s) found[it.id] = s;
  }
  const next = sweep(board.stuck, found, new Date(nowMs).toISOString());
  return { next, due: Object.keys(next).filter((id) => forHuman(next[id], nowMs, t)), owners };
}

module.exports = { TIMINGS, timingsOf, REASONS, NOT_OWNING, lastActivity, assess, sweep, sweepBoard, ownersOf, confirmed, roundOf, forCoordinator, forHuman, label, quietFor, humanQuestion };
