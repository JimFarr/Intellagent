'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Agent stalls (INT-483): a standing agent that stopped getting work done, whatever the reason, raised once per stall
// so a rule ("an agent stalls") can wake someone who can unblock it. Pure rules over the agents' views: the board
// checks with them once a minute and whenever an agent's status changes.
//
//   ledger: { [agent]: { why, since, fired? } }   (since, fired: ms)
//
// why: failed   its runs fail (retrying, or in the failed state)
//      limited  held by the usage limit or the run throttle for longer than limitedMs
//      paused   paused (by the human or stop-all) while it has work waiting
//      refused  its last run's tool permissions refused something (lastRun.denied, INT-487), or the board answered
//               its last run 401/403 (refusals, INT-506), while work waits for it
//      waiting  events queued for it, not paused, and no run has started for waitMs

const WHYS = ['failed', 'limited', 'paused', 'refused', 'waiting'];
// pausedMs: Stop all pauses every agent at once, so a short hold keeps one stall per agent from waking the coordinator (INT-501)
const TIMINGS = Object.freeze({ waitMs: 15 * 60_000, limitedMs: 15 * 60_000, pausedMs: 2 * 60_000 });
// The manifest's "stalls" block: { "waitMinutes", "limitedMinutes", "pausedMinutes" }; anything missing or not a positive number keeps the default
function timingsOf(cfg) {
  const n = (v) => (Number(v) > 0 ? Number(v) * 60_000 : null);
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  return Object.freeze({ waitMs: n(c.waitMinutes) ?? TIMINGS.waitMs, limitedMs: n(c.limitedMinutes) ?? TIMINGS.limitedMs, pausedMs: n(c.pausedMinutes) ?? TIMINGS.pausedMs });
}

// Why this agent is stalled now, or null. a: the agent's view (lib/agents.js); work(): what waits for it on the boards.
// A running agent is not stalled here: a run that hangs is the agent view's own `stalled` (INT-379).
function whyOf(a, work) {
  if (a.runningSince) return null;
  if (a.status === 'failed') return 'failed';
  if (a.status === 'paused') return a.queued > 0 || work().length ? 'paused' : null;
  if (a.limitedUntil || a.status === 'throttled' || (a.status === 'waiting' && a.waitingFor === 'usage limit')) return 'limited';
  if (a.failures >= 2) return 'failed'; // two runs in a row failed and it is retrying: one transient timeout wakes nobody (INT-501)
  if ((a.lastRun?.denied?.length || a.refusals > 0) && (a.queued > 0 || work().length)) return 'refused';
  return a.queued > 0 ? 'waiting' : null;
}
const holdOf = (why, t) => (why === 'waiting' ? t.waitMs : why === 'limited' ? t.limitedMs : why === 'paused' ? t.pausedMs : 0);

/**
 * One check of every agent. → { ledger: the new ledger, stalls: [{ agent, why, since, minutes, evidence }] }, where
 * stalls are the ones raised now: each stall once, until the agent is out of it (or stalls for another reason).
 */
function check(agents, workOf, ledger, nowMs, t = TIMINGS) {
  const next = {};
  const stalls = [];
  for (const a of agents) {
    let work = null;
    const waiting = () => (work ??= workOf(a) || []);
    const why = whyOf(a, waiting);
    if (!why) continue;
    const prev = ledger[a.name];
    const entry = prev?.why === why ? { ...prev } : { why, since: nowMs };
    if (!entry.fired && nowMs - entry.since >= holdOf(why, t)) {
      entry.fired = nowMs;
      const r = a.lastRun;
      stalls.push({
        agent: a.name, why, since: new Date(entry.since).toISOString(), minutes: Math.round((nowMs - entry.since) / 60_000),
        evidence: {
          status: a.status, queued: a.queued || 0, failures: a.failures || 0,
          lastRun: r ? { startedAt: r.startedAt || null, endedAt: r.endedAt || null, code: r.code ?? null, ...(r.error ? { error: r.error } : {}) } : null,
          ...(r?.denied?.length ? { denied: r.denied } : {}),
          ...(a.refusals > 0 ? { refusals: a.refusals } : {}),
          ...(a.limitedUntil ? { limitedUntil: a.limitedUntil } : {}),
          waiting: waiting().slice(0, 10).map((w) => ({ board: w.board, action: w.action, id: w.id || null, ...(w.title ? { title: w.title } : {}) })),
        },
      });
    }
    next[a.name] = entry;
  }
  return { ledger: next, stalls };
}

module.exports = { WHYS, TIMINGS, timingsOf, whyOf, check };
