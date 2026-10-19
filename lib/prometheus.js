'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// GET /metrics in the Prometheus text format (INT-309). Prometheus wants current counters and gauges and keeps
// the history itself. Everything here is read from state the board already holds, so a counter survives a restart:
//   - tickets, questions, reviews, landings, leases and idle alarms from the boards in memory
//   - agent status and queue from the standing agents
//   - runs, run time and tokens from the run records (agent-stats.jsonl, INT-310), read incrementally: a scrape
//     reads only what was appended since the last one, never the whole file again
// No ticket title or comment text is ever a label. Labels are board ids, column names, agent names, model names
// and fixed words, so the number of series stays bounded.

const fs = require('fs');
const { logFiles } = require('./analytics');

const CYCLE_BUCKETS = [60, 300, 900, 3600, 4 * 3600, 12 * 3600, 86400, 3 * 86400, 7 * 86400]; // seconds
const RUN_BUCKETS = [10, 30, 60, 300, 900, 1800, 3600];
const STATUSES = ['idle', 'running', 'waiting', 'throttled', 'failed', 'paused'];
const RESULTS = ['ok', 'failed', 'timeout', 'stopped', 'limited'];
const TOKEN_KINDS = [['input', 'input'], ['output', 'output'], ['cacheRead', 'cache_read'], ['cacheWrite', 'cache_write']];

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const labels = (l) => { const k = Object.keys(l); return k.length ? `{${k.map((n) => `${n}="${esc(l[n])}"`).join(',')}}` : ''; };
const num = (n) => (Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : 'NaN');

// One metric family: HELP and TYPE once, then its samples.
class Out {
  constructor() { this.lines = []; }
  family(name, type, help, samples) {
    this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [suffix, l, v] of samples) this.lines.push(`${name}${suffix}${labels(l)} ${num(v)}`);
  }
  text() { return `${this.lines.join('\n')}\n`; }
}

// A histogram's samples for one label set: cumulative buckets, +Inf, sum and count.
const histogram = (h, l, bounds) => [
  ...bounds.map((b, i) => ['_bucket', { ...l, le: String(b) }, h.buckets[i]]),
  ['_bucket', { ...l, le: '+Inf' }, h.count], ['_sum', l, h.sum], ['_count', l, h.count],
];
const newHist = (bounds) => ({ buckets: bounds.map(() => 0), sum: 0, count: 0 });
function observe(h, bounds, v) {
  bounds.forEach((b, i) => { if (v <= b) h.buckets[i]++; });
  h.sum += v;
  h.count++;
}

// Run records, summed per agent and model. Files only grow, and a roll renames the live file: when the live one
// is smaller than what was read, or a rolled file turns up that was not known, everything is read again (rare).
function createRunTotals(dataDir) {
  let offsets = new Map();
  let agg = null;
  const fresh = () => ({ runs: new Map(), dur: new Map(), tokens: new Map(), wakes: new Map(), measured: new Map(), idle: new Map() });
  function take(r) {
    if (!r || typeof r.agent !== 'string') return;
    const run = agg.runs.get(r.agent) || {};
    const result = RESULTS.includes(r.result) ? r.result : 'failed';
    run[result] = (run[result] || 0) + 1;
    agg.runs.set(r.agent, run);
    const ms = Date.parse(r.endedAt) - Date.parse(r.startedAt);
    if (Number.isFinite(ms) && ms >= 0) {
      const h = agg.dur.get(r.agent) || newHist(RUN_BUCKETS);
      observe(h, RUN_BUCKETS, ms / 1000);
      agg.dur.set(r.agent, h);
    }
    // INT-389: what woke the run, and whether it changed anything (records from before then have neither)
    const reasons = Array.isArray(r.reasons) ? r.reasons : typeof r.why === 'string' && r.why ? r.why.split(', ') : [];
    const w = agg.wakes.get(r.agent) || {};
    for (const reason of reasons) w[reason] = (w[reason] || 0) + 1;
    agg.wakes.set(r.agent, w);
    if (Number.isFinite(r.writes) && result === 'ok') {
      agg.measured.set(r.agent, (agg.measured.get(r.agent) || 0) + 1);
      if (r.writes === 0) agg.idle.set(r.agent, (agg.idle.get(r.agent) || 0) + 1);
    }
    if (r.tokens && typeof r.tokens === 'object') {
      const key = `${r.agent}\u0000${r.model || 'unknown'}`;
      const t = agg.tokens.get(key) || { agent: r.agent, model: r.model || 'unknown', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const [k] of TOKEN_KINDS) t[k] += Number(r.tokens[k]) || 0;
      agg.tokens.set(key, t);
    }
  }
  function readNew(file) {
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    const from = offsets.get(file) || 0;
    if (size <= from) return;
    const buf = Buffer.alloc(size - from);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
    const end = buf.lastIndexOf(10) + 1; // a line still being written is read next time
    if (!end) return;
    for (const l of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!l) continue;
      try { take(JSON.parse(l)); } catch { /* torn line */ }
    }
    offsets.set(file, from + end);
  }
  return function totals() {
    const files = logFiles(dataDir, 'agent-stats', 0);
    let rebuild = !agg;
    for (const f of files) {
      let size = 0;
      try { size = fs.statSync(f).size; } catch { continue; }
      if (offsets.has(f) ? size < offsets.get(f) : offsets.size && size) rebuild = true;
    }
    if (rebuild) { agg = fresh(); offsets = new Map(); }
    for (const f of files) readNew(f);
    return agg;
  };
}

// deps: { dataDir, doneColumnId(ctx), workingColumn(ctx) }. Returns render({ boards, agents, seq, version, build, now }).
const AUTONOMY = require('./alerts/autonomy');
const STUCK = require('./alerts/stuck');

function createPrometheus({ dataDir, doneColumnId, workingColumn }) {
  const runTotals = createRunTotals(dataDir);
  // unowned(ctx): open tickets nobody will touch (INT-389), from the board's own rules
  return function render({ boards, agents, seq, version, build, now = Date.now(), unowned = () => 0, stuckTimings = STUCK.TIMINGS }) {
    const out = new Out();
    const t = (x) => Date.parse(x);
    const per = boards.map((ctx) => {
      const b = ctx.board;
      const done = doneColumnId(ctx);
      const work = workingColumn(ctx);
      const open = Object.values(b.items).filter((it) => !it.test);
      const all = [...open, ...Object.values(ctx.archive.items).filter((it) => !it.test)];
      const cycle = newHist(CYCLE_BUCKETS);
      let finished = 0;
      for (const it of all) {
        const end = (it.flow || []).filter((f) => f.col === done).at(-1);
        if (!end) continue;
        finished++;
        const start = (it.flow || []).find((f) => work && f.col === work.id) || { at: it.createdAt };
        observe(cycle, CYCLE_BUCKETS, Math.max(0, t(end.at) - t(start.at)) / 1000);
      }
      const qs = open.flatMap((it) => it.questions || []);
      const age = qs.map((q) => now - t(q.raisedAt)).filter(Number.isFinite);
      const decided = {};
      const landed = { landed: 0, failed: 0, hand: 0 };
      for (const it of all) {
        if (it.review?.verdict) { const k = `${it.review.verdict === 'approve' ? 'approve' : 'changes'}|${it.review.delegated ? 'true' : 'false'}`; decided[k] = (decided[k] || 0) + 1; }
        if (it.landing?.state === 'landed') landed[it.landing.by === 'hand' ? 'hand' : 'landed']++;
        else if (it.landing?.state === 'failed') landed.failed++;
      }
      return {
        ctx, open, finished, cycle, decided, landed,
        kinds: { question: qs.filter((q) => q.kind !== 'review').length, review: qs.filter((q) => q.kind === 'review').length },
        oldest: age.length ? Math.max(0, ...age) / 1000 : 0,
        leases: open.filter((it) => it.lease && t(it.lease.expiresAt) > now).length,
        alarms: (b.idleLog || []).length,
        autonomy: (() => {
          // INT-393: finished journeys by level, the interventions in them, their churn; open ones in flight and stuck
          const a = { levels: Object.fromEntries(AUTONOMY.LEVELS.map((l) => [l, 0])), kinds: Object.fromEntries(AUTONOMY.TOUCH_KINDS.map((k) => [k, 0])), moves: 0, back: 0, inFlight: 0, stuck: {}, oldest: 0 };
          for (const it of all) {
            const j = it.journey;
            if (!j) continue;
            if (j.doneAt) {
              a.levels[j.level] = (a.levels[j.level] || 0) + 1;
              for (const [k, n] of Object.entries(j.touches || {})) a.kinds[k] = (a.kinds[k] || 0) + n;
              a.moves += j.moves || 0;
              a.back += j.back || 0;
            }
          }
          const sleeping = new Set(b.columns.filter((c) => c.flags?.sleeping).map((c) => c.id));
          for (const it of open) if (it.journey && !it.journey.doneAt && !sleeping.has(it.columnId)) a.inFlight++;
          // the stuck watch's ledger (INT-394): by reason and how sure the board is
          a.stuck = {};
          a.oldest = 0;
          for (const e of Object.values(b.stuck || {})) {
            const state = e.escalated ? 'asked_human' : STUCK.confirmed(e, now, stuckTimings) ? 'sure' : 'suspected';
            a.stuck[`${e.reason}|${state}`] = (a.stuck[`${e.reason}|${state}`] || 0) + 1;
            a.oldest = Math.max(a.oldest, (now - Date.parse(e.since)) / 1000);
          }
          return a;
        })(),
      };
    });

    const each = (fn) => per.flatMap((p) => fn(p, { board: p.ctx.id }));
    out.family('intellagent_up', 'gauge', 'The board is running.', [['', {}, 1]]);
    out.family('intellagent_build_info', 'gauge', 'Version and build of the board.', [['', { version, build }, 1]]);
    out.family('intellagent_events_total', 'counter', 'Events emitted so far (the event sequence number).', [['', {}, seq]]);
    out.family('intellagent_tickets', 'gauge', 'Open tickets per column.', each((p, l) =>
      p.ctx.board.columns.map((c) => ['', { ...l, column: c.name }, c.itemIds.filter((id) => p.ctx.board.items[id] && !p.ctx.board.items[id].test).length])));
    out.family('intellagent_tickets_done_total', 'counter', 'Tickets that reached the last column.', each((p, l) => [['', l, p.finished]]));
    out.family('intellagent_cycle_seconds', 'histogram', 'Time from the working column (or creation) to done.', each((p, l) => histogram(p.cycle, l, CYCLE_BUCKETS)));
    out.family('intellagent_questions_open', 'gauge', 'Open questions and review requests waiting on the human.', each((p, l) =>
      ['question', 'review'].map((kind) => ['', { ...l, kind }, p.kinds[kind]])));
    out.family('intellagent_question_oldest_seconds', 'gauge', 'How long the oldest open question has waited.', each((p, l) => [['', l, p.oldest]]));
    out.family('intellagent_reviews_decided', 'gauge', 'Tickets by their latest review verdict (a ticket decided again counts under its newest).', each((p, l) =>
      ['approve', 'changes'].flatMap((verdict) => ['false', 'true'].map((delegated) => ['', { ...l, verdict, delegated }, p.decided[`${verdict}|${delegated}`] || 0]))));
    out.family('intellagent_landings', 'gauge', 'Tickets by how their commits reached main (a failed landing that is later landed moves to landed).', each((p, l) =>
      ['landed', 'failed', 'hand'].map((result) => ['', { ...l, result }, p.landed[result]])));
    out.family('intellagent_idle_alarms', 'gauge', 'Idle-board alarms kept on the board (the newest 500).', each((p, l) => [['', l, p.alarms]]));
    out.family('intellagent_leases_active', 'gauge', 'Ticket leases held now.', each((p, l) => [['', l, p.leases]]));
    out.family('intellagent_tickets_finished_by_autonomy', 'gauge', 'Tickets that went from pickup to done, by how much a human stepped in: autonomous (nobody: the approval was delegated), approved (only the human\'s approval), helped.', each((p, l) =>
      AUTONOMY.LEVELS.map((level) => ['', { ...l, level }, p.autonomy.levels[level]])));
    out.family('intellagent_human_interventions', 'gauge', 'Human interventions between pickup and done in finished tickets, by kind.', each((p, l) =>
      AUTONOMY.TOUCH_KINDS.map((kind) => ['', { ...l, kind }, p.autonomy.kinds[kind]])));
    out.family('intellagent_ticket_moves', 'gauge', 'Column moves between pickup and done in finished tickets: all of them, and the ones that went backwards (rework).', each((p, l) =>
      [['', { ...l, direction: 'all' }, p.autonomy.moves], ['', { ...l, direction: 'back' }, p.autonomy.back]]));
    out.family('intellagent_tickets_in_flight', 'gauge', 'Tickets picked up and not done yet (not asleep).', each((p, l) => [['', l, p.autonomy.inFlight]]));
    out.family('intellagent_tickets_stuck', 'gauge', 'The stuck watch: tickets picked up and not done that have been quiet for an hour, by why and by state: suspected, sure (still stuck half an hour on: the coordinator is woken), asked_human (past the coordinator\'s rounds).', each((p, l) =>
      STUCK.REASONS.flatMap((reason) => ['suspected', 'sure', 'asked_human'].map((state) => ['', { ...l, reason, state }, p.autonomy.stuck[`${reason}|${state}`] || 0]))));
    out.family('intellagent_stuck_oldest_seconds', 'gauge', 'How long the longest-stuck ticket has been stuck (0: none).', each((p, l) => [['', l, p.autonomy.oldest]]));
    out.family('intellagent_tickets_unowned', 'gauge', 'Open tickets, not asleep, that no agent has work on and no question waits on the human for: nobody will touch them.', each((p, l) => [['', l, unowned(p.ctx)]]));

    const id = (a) => ({ agent: a.name, model: a.model || '', provider: a.provider || 'anthropic' });
    out.family('intellagent_agent_status', 'gauge', 'Each standing agent\'s status: 1 for the current one.', agents.flatMap((a) =>
      [...new Set([...STATUSES, a.status])].map((status) => ['', { ...id(a), status }, a.status === status ? 1 : 0])));
    out.family('intellagent_agent_queue', 'gauge', 'Events queued for the agent\'s next run.', agents.map((a) => ['', id(a), a.queued || 0]));
    const limit = (a) => (a.status === 'waiting' && a.waitingFor === 'usage limit' && Number.isFinite(t(a.resumesAt)) ? t(a.resumesAt) / 1000 : 0);
    out.family('intellagent_usage_limit_until_seconds', 'gauge', 'Unix time the usage limit ends for an agent held by it (0: not held).', agents.map((a) => ['', id(a), limit(a)]));

    const tot = runTotals();
    const names = [...new Set([...agents.map((a) => a.name), ...tot.runs.keys()])].sort();
    out.family('intellagent_agent_runs_total', 'counter', 'Agent runs by how they ended.', names.flatMap((agent) =>
      RESULTS.map((result) => ['', { agent, result }, tot.runs.get(agent)?.[result] || 0])));
    out.family('intellagent_agent_run_seconds', 'histogram', 'How long agent runs took.', names.flatMap((agent) =>
      histogram(tot.dur.get(agent) || newHist(RUN_BUCKETS), { agent }, RUN_BUCKETS)));
    out.family('intellagent_agent_tokens_total', 'counter', 'Tokens agents used, by model.', [...tot.tokens.values()].sort((x, y) => `${x.agent}${x.model}`.localeCompare(`${y.agent}${y.model}`)).flatMap((x) =>
      TOKEN_KINDS.map(([k, kind]) => ['', { agent: x.agent, model: x.model, kind }, x[k]])));
    out.family('intellagent_agent_wakes_total', 'counter', 'Agent runs by what woke them: the work action offered, or the event type.', names.flatMap((agent) =>
      Object.entries(tot.wakes.get(agent) || {}).sort().map(([reason, n]) => ['', { agent, reason }, n])));
    out.family('intellagent_agent_measured_runs_total', 'counter', 'Finished runs whose board writes were counted (the denominator for idle runs).', names.map((agent) => ['', { agent }, tot.measured.get(agent) || 0]));
    out.family('intellagent_agent_idle_runs_total', 'counter', 'Finished runs that changed nothing on the board: woken for nothing.', names.map((agent) => ['', { agent }, tot.idle.get(agent) || 0]));
    out.family('intellagent_agent_usage_limited_total', 'counter', 'Runs the account\'s usage limit refused.', names.map((agent) => ['', { agent }, tot.runs.get(agent)?.limited || 0]));
    return out.text();
  };
}

module.exports = { createPrometheus, createRunTotals };
