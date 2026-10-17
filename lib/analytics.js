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

// deps: { dataDir }. Returns analytics({ days, agent?, now? }).
function createAnalytics({ dataDir }) {
  return function analytics({ days = 7, agent = null, now = Date.now() } = {}) {
    const from = now - days * DAY;
    const agents = new Map();
    const of = (name) => {
      if (!agents.has(name)) {
        agents.set(name, {
          agent: name, states: {}, unknownMs: 0, queue: [],
          runs: { count: 0, ok: 0, failed: 0, timeout: 0, stopped: 0, limited: 0, ms: 0 },
          tokens: noTokens(), ...newCost(), models: {}, tools: {}, commands: {}, toolsUnknown: 0,
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
      if (prev && at > from) add(of(e.agent).states, prev.status, at - Math.max(prev.at, from));
      last.set(e.agent, { status: e.status, at });
      if (at < from) continue;
      // queue depth at each change: what the event says it was, or for a run, the batch it started with
      const depth = Number.isFinite(e.queue) ? e.queue : e.status === 'running' ? e.lastRun?.events : undefined;
      if (Number.isFinite(depth)) of(e.agent).queue.push({ at: e.ts, status: e.status, depth });
    }
    for (const [name, s] of last) add(of(name).states, s.status, now - Math.max(s.at, from));

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
    const list = [...agents.values()].map((a) => ({
      ...a, unknownMs: Math.max(0, now - from - Object.values(a.states).reduce((x, y) => x + y, 0)),
      tools: top(a.tools), commands: top(a.commands),
    })).sort((x, y) => x.agent.localeCompare(y.agent));
    const totals = { runs: 0, tokens: noTokens(), ...newCost() };
    for (const a of list) {
      totals.runs += a.runs.count;
      sumTokens(totals.tokens, a.tokens);
      if (a.cost != null) totals.cost = money((totals.cost || 0) + a.cost);
      totals.unpriced += a.unpriced;
    }
    return {
      days, from: new Date(from).toISOString(), to: new Date(now).toISOString(), agent: agent || null,
      totals, agents: list,
      tickets: [...tickets.values()].sort((x, y) => (y.cost || 0) - (x.cost || 0) || y.runs - x.runs || x.id.localeCompare(y.id)),
    };
  };
}

module.exports = { createAnalytics, logFiles };
