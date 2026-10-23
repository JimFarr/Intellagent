'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Ticket triggers (INT-435): a card that waits on a condition, not an event. A fast sweep checks every active trigger;
// one that fires is buffered for the agent it names (the coordinator unless it says otherwise) and sent as one wake
// listing that agent's cards: at once for priority "now", after the batch window for "batch". Pure rules; the board
// (server.js sweepTriggers) applies them.
//
//   trigger on a ticket: { id, when, priority: now | batch, wake?, note?, by, at, active,
//                          firedAt?, wasTrue? (machine), quietFrom? (quietFor) }
//   when: { machine: "exclusive", busyBelow? }  the PC is free for a timing run: no machine lease held, processor quiet
//         { quietFor: "30m" }                    nothing moved the ticket on for that long (once per quiet stretch)
//         { idle: "60m" }                        quiet that long, then again every 60m while it stays quiet: the default
//                                                on every picked-up card (low priority) until someone removes it
//         { every: "15m" }                       at most once per interval
//         { until: ISO time }                    once, at that time; then it switches off
//   queue entry on the board: { wake, itemId, triggerId, priority, why, note, firedAt }

const PRIORITIES = ['now', 'batch'];
const MAX_PER_TICKET = 5;
const UNIT = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

const duration = (v) => {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(String(v ?? '').trim());
  return m ? Number(m[1]) * UNIT[m[2]] : NaN;
};

// The condition, checked and normalised: { kind, ms?, at?, busyBelow? }. bad(message) throws the caller's error.
function parseWhen(when, bad) {
  if (!when || typeof when !== 'object' || Array.isArray(when)) bad('"when" is required: { machine: "exclusive" }, { idle: "60m" }, { quietFor: "30m" }, { every: "15m" } or { until: "<ISO time>" }');
  const keys = Object.keys(when).filter((k) => k !== 'busyBelow');
  if (keys.length !== 1) bad('"when" takes exactly one of machine, idle, quietFor, every, until');
  const [kind] = keys;
  if (kind === 'machine') {
    if (when.machine !== 'exclusive') bad('"machine" takes "exclusive": the PC free for a timing run');
    const busyBelow = when.busyBelow == null ? 15 : Number(when.busyBelow);
    if (!(busyBelow > 0 && busyBelow <= 100)) bad('"busyBelow" is a percentage of the processor, 1 to 100');
    return { kind, busyBelow };
  }
  if (kind === 'quietFor' || kind === 'every' || kind === 'idle') {
    // every firing costs the woken agent a run: a repeating trigger waits at least 5 minutes between them
    const least = kind === 'quietFor' ? 1 : 5;
    const ms = duration(when[kind]);
    if (!(ms >= least * 60_000)) bad(`"${kind}" is a duration of at least ${least === 1 ? 'a minute' : `${least} minutes`}, e.g. "30m", "2h"`);
    return { kind, ms };
  }
  if (kind === 'until') {
    const at = Date.parse(when.until);
    if (!Number.isFinite(at)) bad('"until" is an ISO time, e.g. "2026-10-24T09:00:00Z"');
    return { kind, at: new Date(at).toISOString() };
  }
  return bad(`unknown condition "${kind}": machine, idle, quietFor, every or until`);
}

// Does this trigger fire now? Edge-triggered, so leaving it on never loops. Returns { fire, why, set } where set is
// what to store on the trigger.
//   world: { nowMs, lastActivityMs (when the ticket last moved on), machineFree (true | false | null: no reading) }
function evaluate(t, world) {
  const w = t.when;
  if (w.kind === 'machine') {
    const free = world.machineFree;
    if (free == null) return { fire: false, set: {} };
    return { fire: free && !t.wasTrue, why: 'the machine is free for a timing run', set: { wasTrue: free } };
  }
  if (w.kind === 'every') {
    const since = Date.parse(t.firedAt || t.at);
    return world.nowMs - since >= w.ms ? { fire: true, why: `its ${Math.round(w.ms / 60_000)}-minute check-in`, set: {} } : { fire: false, set: {} };
  }
  if (w.kind === 'quietFor') {
    const quiet = world.nowMs - world.lastActivityMs >= w.ms;
    const stretch = new Date(world.lastActivityMs).toISOString(); // one firing per quiet stretch
    return quiet && t.quietFrom !== stretch
      ? { fire: true, why: `quiet for ${Math.round((world.nowMs - world.lastActivityMs) / 60_000)} min`, set: { quietFrom: stretch } }
      : { fire: false, set: {} };
  }
  if (w.kind === 'idle') {
    // quiet that long, then again every interval while nothing moves: a nudge nobody acted on comes back
    const quiet = world.nowMs - world.lastActivityMs >= w.ms;
    const last = Math.max(world.lastActivityMs, Date.parse(t.firedAt || 0) || 0);
    return quiet && world.nowMs - last >= w.ms
      ? { fire: true, why: `idle for ${Math.round((world.nowMs - world.lastActivityMs) / 60_000)} min`, set: {} }
      : { fire: false, set: {} };
  }
  if (w.kind === 'until') {
    return world.nowMs >= Date.parse(w.at) ? { fire: true, why: `it is ${w.at.slice(0, 16).replace('T', ' ')} UTC`, set: { active: false } } : { fire: false, set: {} };
  }
  return { fire: false, set: {} };
}

// Put a fired trigger in the queue: a card fired again before it was sent replaces its entry, so nothing piles up.
function enqueue(queue, entry) {
  const rest = queue.filter((e) => !(e.wake === entry.wake && e.itemId === entry.itemId && e.triggerId === entry.triggerId));
  return [...rest, entry];
}

// What to send now, grouped by the agent to wake: everything for an agent with a "now" entry, or whose oldest entry
// has waited the batch window. → { send: { [wake]: [entries] }, keep: [entries] }
function due(queue, nowMs, batchMs) {
  const byWake = new Map();
  for (const e of queue) (byWake.get(e.wake) || byWake.set(e.wake, []).get(e.wake)).push(e);
  const send = {};
  const keep = [];
  for (const [wake, list] of byWake) {
    const urgent = list.some((e) => e.priority === 'now');
    const oldest = Math.min(...list.map((e) => Date.parse(e.firedAt)));
    if (urgent || nowMs - oldest >= batchMs) send[wake] = list; else keep.push(...list);
  }
  return { send, keep };
}

const activeOn = (item) => (item.triggers || []).filter((t) => t.active);
// The idle check every picked-up card gets, unless someone removed it (item.idleCheck === false)
const idleDefault = ({ id, minutes, nowIso }) => ({ id, when: { kind: 'idle', ms: minutes * 60_000 }, priority: 'batch', by: 'intellagent', at: nowIso, active: true, default: true });
// Is this trigger held for now? The idle check waits while the card waits on the human (a question or a review
// for him, not the board's own): that quiet is on purpose, as the stuck watch says, and nudging the coordinator
// about it only makes work. A trigger someone set on purpose is never held.
const holds = (t, item) => !!t.default && (item.questions || []).some((q) => q.raisedBy !== 'intellagent');

module.exports = { PRIORITIES, MAX_PER_TICKET, duration, parseWhen, evaluate, enqueue, due, activeOn, idleDefault, holds };
