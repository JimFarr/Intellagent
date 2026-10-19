'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// The stuck watch (INT-394): every unfinished ticket, followed over time. A ticket picked up and not done that has
// been quiet for a while is entered in the board's ledger with why; once it is still stuck a while later the board is
// sure, and the coordinator gets an unstick item, once per round; after two rounds the human is asked instead.
// Pure rules over plain data: the board sweeps with them, and the alerting simulator does the same.
//
//   ledger: { [ticketId]: { since, reason, owner?, escalated? } }

const QUIET_MS = 60 * 60_000;    // nothing on the ticket for this long: stuck
const CONFIRM_MS = 30 * 60_000;  // still stuck this long after it was first seen: sure
const ROUND_MS = 60 * 60_000;    // the coordinator is woken once per round; after ROUNDS rounds, the human
const ROUNDS = 2;
const REASONS = ['waiting_on_human', 'no_owner', 'owner_down', 'owner_quiet', 'held_quiet'];

// When the ticket last moved on: its journey's progress (lib/alerts/autonomy.js), never a lease claimed again, a status
// line or an ask made about it. A journey from before progress was kept: its pickup.
const lastActivity = (it) => Date.parse(it.journey?.lastProgressAt || it.journey?.pickedUpAt || 0) || 0;

/**
 * Is this ticket stuck now, and why? null when it is not.
 * who: { owners: [names with work on it], running(name), status(name) → idle|paused|failed|…, sleeping(columnId) }
 */
function assess(it, nowMs, who, quietMs = QUIET_MS) {
  const j = it.journey;
  if (!j || j.doneAt || it.test || who.sleeping(it.columnId)) return null;
  if (nowMs - lastActivity(it) < quietMs) return null;
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
  const down = owners.find((n) => ['paused', 'failed'].includes(who.status(n)));
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

// Actions that don't make an agent the ticket's owner: housekeeping, conversation and the watch itself
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

const confirmed = (e, nowMs) => nowMs - Date.parse(e.since) >= CONFIRM_MS;
// 0, 1, … rounds since it was confirmed; the coordinator is woken once in each
const roundOf = (e, nowMs) => Math.floor((nowMs - Date.parse(e.since) - CONFIRM_MS) / ROUND_MS);
// Due for the coordinator: confirmed, not the human's, within its rounds
const forCoordinator = (e, nowMs) => e.reason !== 'waiting_on_human' && !e.asked && confirmed(e, nowMs) && roundOf(e, nowMs) < ROUNDS;
// Due for the human: past its rounds and not asked yet
const forHuman = (e, nowMs) => e.reason !== 'waiting_on_human' && confirmed(e, nowMs) && roundOf(e, nowMs) >= ROUNDS && !e.escalated;

module.exports = { QUIET_MS, CONFIRM_MS, ROUND_MS, ROUNDS, REASONS, NOT_OWNING, lastActivity, assess, sweep, ownersOf, confirmed, roundOf, forCoordinator, forHuman };
