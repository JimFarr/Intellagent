'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Agent analytics over a window (GET /api/analytics, INT-311): time in each state, queue depth, runs, tokens,
// cost, tools and commands per agent, and runs, tokens and cost per ticket. Everything is derived on each call
// from two files the server already writes, never stored twice:
//   - agent.status events in events.jsonl and its rolled events-<ms>.jsonl files (state changes, with a time)
//   - run records in agent-stats.jsonl and its rolled agent-stats-<ms>.jsonl files (INT-310: one line per run)
// It reads files only; it never changes anything.

const fs = require('fs');
const path = require('path');

const DAY = 86_400_000;
const TOP = 10; // tools and commands listed per agent
const SEGMENTS = 500; // state segments kept per agent (the newest): bounds the reply however busy the window was

// Files of one log, oldest first: the rolled ones (named for when they rolled) and then the live one.
// A rolled file holds only what came before its roll time, so one that rolled before `from` is skipped unread:
// that is what keeps a call's cost to the window, however long the history.
function logFiles(dir, base, from) {
  const re = new RegExp(`^${base}-(\\d+)\\.jsonl$`);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const rolled = names.map((f) => [f, re.exec(f)]).filter(([, m]) => m).map(([f, m]) => [f, Number(m[1])])
    .sort((a, b) => a[1] - b[1]);
  const out = rolled.filter(([, at]) => at >= from).map(([f]) => path.join(dir, f));
  // the newest file that rolled before the window still knows each agent's state when the window opened
  const before = rolled.filter(([, at]) => at < from).at(-1);
  if (before) out.unshift(path.join(dir, before[0]));
  out.push(path.join(dir, `${base}.jsonl`));
  return out;
}

// Each parsed line of the files that contains `needle` (checked before parsing: most lines are skipped cheaply).
function* lines(files, needle) {
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const l of text.split('\n')) {
      if (!l || !l.includes(needle)) continue;
      try { yield JSON.parse(l); } catch { /* torn line */ }
    }
  }
}

const add = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP).map(([name, count]) => ({ name, count }));
const money = (n) => Math.round(n * 1e6) / 1e6;
const sumTokens = (acc, t) => { if (!t) return; for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) acc[k] += Number(t[k]) || 0; };
const noTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
// cost is null when no run in the group reported one; `unpriced` counts the runs that did not
const newCost = () => ({ cost: null, unpriced: 0 });
const addCost = (c, v) => { if (v == null) c.unpriced++; else c.cost = money((c.cost || 0) + v); };
// The day (UTC) a run ended in, for the daily series. A day nobody ran on has runs 0 and cost null: unknown, never 0.
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const newDay = (day) => ({ day, runs: 0, ...newCost() });

// One stretch of an agent's state, for a lane on a time axis: { from, to, status, note? }. The note is the board's own
// words for why (a usage limit, a throttle's end), so a failure or a wait can be written out beside the bar.
const noteOf = (e) => {
  const text = (v) => (typeof v === 'string' && v ? v.slice(0, 120) : null);
  return text(e.waitingFor) || text(e.reason) || text(e.error) || (text(e.resumesAt) ? `until ${e.resumesAt}` : null);
};
function segment(a, st, from, to) {
  if (to <= from) return;
  a.segments.push({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), status: st.status, ...(st.note ? { note: st.note } : {}) });
  if (a.segments.length > SEGMENTS) a.segments.shift();
}

// Decisions, not a hire: plain rules over the states above, as data the page can write out.
// `waiting` is [{ id, since }]: tickets waiting on the human, from the board (this file reads logs only).
const WAIT_SHARE = 0.2; // of the window queued, throttled or waiting before an agent counts as backed up
const IDLE_SHARE = 0.5; // of the window idle before an agent counts as having room
const HUMAN_WAIT = DAY; // a question or review open this long is worth saying
function suggest(list, windowMs, waiting, now) {
  const out = [];
  const share = (a, keys) => keys.reduce((n, k) => n + (a.states[k] || 0), 0) / windowMs;
  const pct = (x) => `${Math.round(x * 100)}%`;
  for (const a of list) {
    const backed = share(a, ['queued', 'throttled', 'waiting']);
    if (backed < WAIT_SHARE) continue;
    const room = list.filter((b) => b !== a && share(b, ['idle']) >= IDLE_SHARE).sort((x, y) => share(y, ['idle']) - share(x, ['idle']))[0];
    if (!room) continue;
    out.push({ kind: 'rebalance', agents: [a.agent, room.agent],
      text: `${a.agent} spent ${pct(backed)} of the window queued, throttled or waiting while ${room.agent} sat idle ${pct(share(room, ['idle']))} of it: hand some of ${a.agent}'s tickets to ${room.agent}. A decision, not a hire.` });
  }
  const old = (waiting || []).filter((w) => now - Date.parse(w.since) >= HUMAN_WAIT).sort((x, y) => Date.parse(x.since) - Date.parse(y.since));
  if (old.length) {
    const many = old.length > 1;
    out.push({ kind: 'waiting-on-human', items: old.map((w) => w.id),
      text: `${old.length} ticket${many ? 's have' : ' has'} waited on you for over a day, the oldest ${old[0].id}: answering ${many ? 'them' : 'it'} frees the agents that raised ${many ? 'them' : 'it'}.` });
  }
  return out;
}

// Tickets waiting on the human, for suggest(): [{ id, since }] from the boards' open items. Test tickets stay out of
// metrics and the digest, so they stay out of this too; a `since` that is not a date is left out.
function waitingOnHuman(boards) {
  const out = [];
  for (const c of boards) for (const it of Object.values(c.board.items)) {
    if (it.test || !Number.isFinite(Date.parse(it.needsHuman?.raisedAt))) continue;
    out.push({ id: it.id, since: it.needsHuman.raisedAt });
  }
  return out;
}

// deps: { dataDir }. Returns analytics({ days, agent?, now?, waiting? }).
function createAnalytics({ dataDir }) {
  return function analytics({ days = 7, agent = null, now = Date.now(), waiting = [] } = {}) {
    const from = now - days * DAY;
    const agents = new Map();
    const of = (name) => {
      if (!agents.has(name)) {
        agents.set(name, {
          agent: name, states: {}, unknownMs: 0, segments: [], queue: [],
          runs: { count: 0, ok: 0, failed: 0, timeout: 0, stopped: 0, limited: 0, ms: 0 },
          tokens: noTokens(), ...newCost(), models: {}, tools: {}, commands: {}, toolsUnknown: 0, byDay: new Map(),
        });
      }
      return agents.get(name);
    };
    const wanted = (name) => typeof name === 'string' && name && (!agent || name === agent);

    // Time in each state: each agent.status holds until the agent's next one. Clipped to the window; the time
    // before an agent's first known state in the window is `unknownMs`.
    const last = new Map(); // agent -> { status, at }
    for (const e of lines(logFiles(dataDir, 'events', from), '"agent.status"')) {
      if (e.type !== 'agent.status' || !wanted(e.agent)) continue;
      const at = Date.parse(e.ts);
      if (!Number.isFinite(at) || at > now) continue;
      const prev = last.get(e.agent);
      if (prev && at > from) { add(of(e.agent).states, prev.status, at - Math.max(prev.at, from)); segment(of(e.agent), prev, Math.max(prev.at, from), at); }
      last.set(e.agent, { status: e.status, at, note: noteOf(e) });
      if (at < from) continue;
      // queue depth at each change: what the event says it was, or for a run, the batch it started with
      const depth = Number.isFinite(e.queue) ? e.queue : e.status === 'running' ? e.lastRun?.events : undefined;
      if (Number.isFinite(depth)) of(e.agent).queue.push({ at: e.ts, status: e.status, depth });
    }
    for (const [name, s] of last) { add(of(name).states, s.status, now - Math.max(s.at, from)); segment(of(name), s, Math.max(s.at, from), now); }

    // Runs, tokens, cost and tools from the run records that ended in the window.
    const tickets = new Map();
    for (const r of lines(logFiles(dataDir, 'agent-stats', from), '"agent"')) {
      if (!wanted(r.agent)) continue;
      const end = Date.parse(r.endedAt);
      if (!Number.isFinite(end) || end < from || end > now) continue;
      const a = of(r.agent);
      const ms = Math.max(0, end - (Date.parse(r.startedAt) || end));
      a.runs.count++;
      a.runs.ms += ms;
      if (r.result in a.runs) a.runs[r.result]++;
      sumTokens(a.tokens, r.tokens);
      addCost(a, r.cost);
      const dk = dayOf(end);
      if (!a.byDay.has(dk)) a.byDay.set(dk, newDay(dk));
      a.byDay.get(dk).runs++;
      addCost(a.byDay.get(dk), r.cost);
      const model = r.model || 'unknown';
      const m = a.models[model] || (a.models[model] = { runs: 0, tokens: noTokens(), ...newCost() });
      m.runs++;
      sumTokens(m.tokens, r.tokens);
      addCost(m, r.cost);
      if (r.tools && typeof r.tools === 'object') for (const [k, n] of Object.entries(r.tools)) add(a.tools, k, Number(n) || 0);
      else a.toolsUnknown++;
      for (const c of Array.isArray(r.commands) ? r.commands : []) add(a.commands, c);
      // A run woken for several tickets shares its cost and tokens between them equally, so tickets add up to
      // the agents' totals instead of counting one run twice.
      const items = Array.isArray(r.items) ? [...new Set(r.items.filter((x) => typeof x === 'string'))] : [];
      for (const id of items) {
        const t = tickets.get(id) || { id, runs: 0, ms: 0, agents: [], tokens: noTokens(), ...newCost(), shared: 0 };
        t.runs++;
        t.ms += Math.round(ms / items.length);
        if (!t.agents.includes(r.agent)) t.agents.push(r.agent);
        if (r.tokens) for (const k of Object.keys(t.tokens)) t.tokens[k] += Math.round((Number(r.tokens[k]) || 0) / items.length);
        addCost(t, r.cost == null ? null : r.cost / items.length);
        if (items.length > 1) t.shared++;
        tickets.set(id, t);
      }
    }

    // an agent known only from its runs has no state for the whole window
    // every day of the window, oldest first, so a page can draw the series as it is
    const dayKeys = [];
    for (let d = Date.parse(dayOf(from)); d < now; d += DAY) dayKeys.push(dayOf(d));
    const list = [...agents.values()].map(({ byDay, ...a }) => ({
      ...a, daily: dayKeys.map((k) => byDay.get(k) || newDay(k)), unknownMs: Math.max(0, now - from - Object.values(a.states).reduce((x, y) => x + y, 0)),
      tools: top(a.tools), commands: top(a.commands),
    })).sort((x, y) => x.agent.localeCompare(y.agent));
    const totals = { runs: 0, tokens: noTokens(), ...newCost() };
    const perDay = new Map(dayKeys.map((k) => [k, newDay(k)]));
    for (const a of list) {
      for (const d of a.daily) { const s = perDay.get(d.day); s.runs += d.runs; s.unpriced += d.unpriced; if (d.cost != null) s.cost = money((s.cost || 0) + d.cost); }
      totals.runs += a.runs.count;
      sumTokens(totals.tokens, a.tokens);
      if (a.cost != null) totals.cost = money((totals.cost || 0) + a.cost);
      totals.unpriced += a.unpriced;
    }
    totals.daily = [...perDay.values()];
    return {
      days, from: new Date(from).toISOString(), to: new Date(now).toISOString(), agent: agent || null,
      totals, agents: list, suggestions: suggest(list, now - from, waiting, now),
      tickets: [...tickets.values()].sort((x, y) => (y.cost || 0) - (x.cost || 0) || y.runs - x.runs || x.id.localeCompare(y.id)),
    };
  };
}

module.exports = { createAnalytics, logFiles, waitingOnHuman };
