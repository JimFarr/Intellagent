'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Warm sessions by need (INT-404). A keep-alive session saves a fresh start's floor (the system prompt, tools and
// brief) only while the model's prompt cache still holds it: a turn after the cache has lapsed re-writes the whole
// conversation, which by then is bigger than a fresh start. So "auto" keeps a session warm only for an agent that
// wakes often enough to find its cache still there, and only while its context stays a small multiple of a fresh
// start. Pure: the runner applies it after each turn, and arms an idle timer that ends the session once the cache
// has lapsed.

const GAPS = 6; // the gaps between its last runs that say how often it wakes

/** True when this agent's sessions are kept warm by need ("keepAlive": "auto", or "warm": "auto" on a stream run). */
const isAuto = (def) => def.keepAlive === 'auto' || def.warm === 'auto';
const ttlOf = (def, defaults) => { const m = Number(def.cacheTtlMinutes ?? defaults.cacheTtlMinutes); return (m > 0 ? m : 5) * 60_000; };
const factorOf = (def, defaults) => Math.max(1.2, Number(def.warmFactor ?? defaults.warmFactor) || 3);

// The typical gap between an agent's runs: the median of its last few, from their start times (oldest first).
function typicalGap(runStarts) {
  const t = runStarts.map((x) => Date.parse(x)).filter(Number.isFinite).slice(-(GAPS + 1));
  const gaps = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
}

/**
 * Should the session stay after this turn? → { keep, why, until? }
 * s: { turns, context (tokens per model call now), floor (the same at its first turn), runs: [ISO start times] }
 * Every mode: a failed turn, a paused or switched-off agent, too many turns or too big a context end it. "auto"
 * also ends it when the agent wakes less often than the cache lasts, or its context has grown to `warmFactor` × a
 * fresh start; a session it keeps ends by itself once idle for the cache's lifetime (`until`).
 */
function warmDecision(def, defaults, s, { ok, paused, nowMs }) {
  const end = (why) => ({ keep: false, why });
  if (!ok) return end('the turn failed: a fresh session next time');
  if (paused || !def.enabled || !def.keepAlive) return end('paused or switched off');
  const after = Number(def.recycleAfterRuns) || defaults.recycleAfterRuns;
  if (s.turns >= after) return end(`${s.turns} turns: replaced after ${after}`);
  const cap = def.recycleAboveTokens === 0 ? 0 : Number(def.recycleAboveTokens) || defaults.recycleAboveTokens;
  if (cap && s.context > cap) return end(`context ${Math.round(s.context / 1000)}k tokens per call, over ${Math.round(cap / 1000)}k`);
  if (!isAuto(def)) return { keep: true, why: 'keep-alive' };
  const ttl = ttlOf(def, defaults);
  const gap = typicalGap(s.runs || []);
  if (gap != null && gap > ttl) return end(`wakes about every ${Math.round(gap / 60_000)} min and the cache lasts ${Math.round(ttl / 60_000)}: a fresh start costs less than a cold session`);
  const factor = factorOf(def, defaults);
  if (s.floor && s.context && s.context > factor * s.floor) return end(`context grew to ${(s.context / s.floor).toFixed(1)}× a fresh start (over ${factor}×): a fresh start costs less per call`);
  return { keep: true, why: gap == null ? 'warm until it has a wake pattern' : `wakes about every ${Math.max(1, Math.round(gap / 60_000))} min, within the cache's ${Math.round(ttl / 60_000)}`, until: new Date(nowMs + ttl).toISOString() };
}

module.exports = { warmDecision, typicalGap, isAuto, ttlOf };
