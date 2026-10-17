'use strict';
// When a standing agent runs: which events wake it, the queue, the settle delay, the throttle and the hourly
// cap, the sweeps for work already waiting, recovery after a restart, and the human's controls (pause, resume,
// run now, stop all). It never starts a process itself: it calls the runner's start().
const { killTree, leftovers } = require('./proc');
const { TIERS, DEFAULTS, isClaudeRun } = require('./config');

const QUEUE_MAX = 200;

/**
 * core: the pieces every part of createAgents shares (see agents.js). Time comes from Date.now and setTimeout,
 * so a test drives it with node:test's mock timers.
 */
function createScheduler(core) {
  const { deps, defs, state, st, save, requeueInflight, running, timers, held } = core;
  const { emit } = deps;
  const wakes = (...a) => core.config.wakes(...a);
  const need = (...a) => core.config.need(...a);
  const lingering = (...a) => core.runner.lingering(...a);
  const start = (...a) => core.runner.start(...a);
  const endSession = (...a) => core.runner.endSession(...a);
  const view = (...a) => core.view(...a);

  function enqueue(name, events) { enqueueAll([[name, events]]); }
  // Queue for several agents with one write of the state file (an event that wakes seven agents is one save,
  // not seven: INT-213). Saved before any run is scheduled or ⏳ promised, so a power cut never loses a queue.
  function enqueueAll(batches) {
    for (const [name, events] of batches) {
      const s = st(name);
      for (const e of events) if (!s.queue.some((q) => q.seq === e.seq && q.type === e.type)) s.queue.push(e);
      if (s.queue.length > QUEUE_MAX) reportQueue(name, s.queue.splice(0, s.queue.length - QUEUE_MAX), { gone: true });
      const last = events[events.length - 1];
      if (last) s.cursor = Math.max(s.cursor || 0, last.seq);
    }
    if (!batches.length) return;
    save();
    for (const [name, events] of batches) {
      schedule(name, defs[name].settleSeconds * 1000);
      try { const when = whenRuns(name); if (when) deps.onQueued?.(name, events, when); } catch { /* best effort */ }
    }
  }
  // INT-293: when the usage limit of the agent's account resets (ms; 0 when it isn't held)
  const limitedUntil = (name) => Date.parse(st(name).limitedUntil || 0) || 0;
  // A run was refused for the usage limit: the limit is the account's, so every agent served by the same provider
  // waits for the same reset instead of each spending a run to find out. An agent with no provider waits alone.
  function holdForLimit(name, until) {
    const provider = defs[name]?.provider || null;
    const iso = new Date(until).toISOString();
    const agents = Object.values(defs).filter((d) => d.name === name || (provider && d.provider === provider)).map((d) => d.name);
    for (const n of agents) {
      const s = st(n);
      if (limitedUntil(n) >= until) continue;
      s.limitedUntil = iso;
      if (running.has(n) || !defs[n].enabled || s.paused || s.status === 'failed') continue;
      if (s.queue.length) { setStatus(n, 'waiting', { resumesAt: iso, waitingFor: 'usage limit' }); schedule(n, until - Date.now() + 1000); }
    }
    save();
    deps.log?.(`usage limit reached (${provider || name}): ${agents.join(', ')} wait until ${iso}`);
    emit({ type: 'agent.usage_limited', actor: { kind: 'system', name: 'intellagent' }, agent: name, provider, until: iso, agents });
    armIdle(until + 1000); // the idle alarm counts again once they can run
  }

  // INT-296: the account's usage, from the rate_limit_event every claude run prints. Kept per provider (one account,
  // one set of windows); a custom run with no provider has no account the board can see.
  const rateKey = (def) => def?.provider || (isClaudeRun(def?.run) ? 'anthropic' : null);
  const HOLDS_KEPT = 200;
  function noteRate(name, windows) {
    const key = rateKey(defs[name]);
    if (!key) return;
    state.usage ||= {};
    state.usage[key] = { windows, at: new Date().toISOString() };
    holding(key);
    save();
  }
  const holdAbove = () => (Number(Object.values(defs)[0]?.holdBackAbovePercent ?? DEFAULTS.holdBackAbovePercent) || DEFAULTS.holdBackAbovePercent) / 100;
  // Is optional work held back for this account now? Above the threshold of the five-hour window until it resets.
  // Each stretch is kept (state.usageHolds: { provider, from, to }) for the metrics; one that the reset ended closes
  // at the reset, not whenever someone next looks.
  function holding(key) {
    const w = state.usage?.[key]?.windows?.five_hour;
    const resetsAt = w?.resetsAt || 0;
    const now = Date.now();
    const on = !!w && w.utilization >= holdAbove() && (!resetsAt || now < resetsAt);
    state.usageHolds ||= [];
    const open = state.usageHolds.findLast((h) => h.provider === key && !h.to);
    if (on && !open) {
      state.usageHolds = [...state.usageHolds, { provider: key, from: new Date(now).toISOString(), until: resetsAt ? new Date(resetsAt).toISOString() : null }].slice(-HOLDS_KEPT);
      deps.log?.(`usage ${Math.round(w.utilization * 100)}% of the five-hour window (${key}): optional work waits${resetsAt ? ` until ${new Date(resetsAt).toISOString()}` : ''}`);
    } else if (!on && open) {
      open.to = new Date(resetsAt && now >= resetsAt && Date.parse(open.from) < resetsAt ? resetsAt : now).toISOString();
    }
    return on;
  }
  const heldBack = (def) => { const key = rateKey(def); return !!key && holding(key); };
  // Pickup of unassigned tickets and supervise nudges are optional (James, on INT-296): what is left of the window
  // goes to work already started, reviews and the human's requests. Triage of new tickets is not pickup: it stays.
  const OPTIONAL = new Set(['pickup', 'supervise']);
  function usageView() {
    const out = {};
    for (const [key, u] of Object.entries(state.usage || {})) {
      const w = u.windows?.five_hour;
      const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
      out[key] = { window: w ? 'five_hour' : Object.keys(u.windows || {})[0] || null, utilization: (w || Object.values(u.windows || {})[0])?.utilization ?? null,
        resetsAt: iso((w || Object.values(u.windows || {})[0])?.resetsAt), windows: Object.fromEntries(Object.entries(u.windows || {}).map(([k, x]) => [k, { utilization: x.utilization, resetsAt: iso(x.resetsAt) }])),
        at: u.at, heldBack: holding(key), holdAbove: holdAbove() };
    }
    return out;
  }
  // Minutes optional work was held back since `sinceMs`. An open stretch counts up to now, but never past its own
  // reset (nobody may have looked since), and stretches of two accounts that overlap count once.
  function heldMinutes(sinceMs, untilMs = Date.now()) {
    const now = Date.now();
    const spans = [];
    for (const h of state.usageHolds || []) {
      const from = Math.max(sinceMs, Date.parse(h.from));
      const end = h.to ? Date.parse(h.to) : Math.min(now, h.until ? Date.parse(h.until) : now);
      const to = Math.min(untilMs, end);
      if (to > from) spans.push([from, to]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    let ms = 0;
    let edge = -Infinity;
    for (const [from, to] of spans) {
      if (to <= edge) continue;
      ms += to - Math.max(from, edge);
      edge = to;
    }
    return Math.round(ms / 60_000);
  }

  // When what was just queued will run, as far as it can be known: { busy } while a run is going (it follows
  // that one), else { at } — the settle delay, pushed out by throttleMinutes or maxRunsPerHour.
  function whenRuns(name) {
    const def = defs[name];
    const s = st(name);
    if (!def.enabled || s.paused || s.status === 'failed') return null; // nothing is coming: no ⏳ promise
    if (running.has(name)) return { busy: true };
    let at = Date.now() + def.settleSeconds * 1000;
    const gap = (Number(def.throttleMinutes) || 0) * 60_000;
    if (gap && !s.failures) at = Math.max(at, Date.parse(s.runs.at(-1) || 0) + gap);
    const hourAgo = Date.now() - 3600_000;
    const recent = s.runs.filter((t) => Date.parse(t) > hourAgo);
    if (def.maxRunsPerHour != null && recent.length >= def.maxRunsPerHour) at = Math.max(at, Date.parse(recent[0]) + 3600_000);
    at = Math.max(at, limitedUntil(name) + 1000);
    return { at: new Date(at).toISOString() };
  }

  function schedule(name, ms) {
    clearTimeout(timers.get(name));
    timers.set(name, setTimeout(() => { timers.delete(name); dispatch(name); }, ms));
  }

  // Work already on the board (assigned and not started, answered questions, feedback, requests, and with
  // pickup unassigned tickets) wakes an idle agent with one synthetic work.pending event. Each piece of
  // work wakes it once: it is remembered until it leaves the pending list, so leaving it alone never loops.
  function checkPending(name) {
    checkIdle(); // after a run ends, the idle-board alarm counts its quiet stretch from there
    const def = defs[name];
    const s = st(name);
    if (!def || !deps.pending || !def.enabled || def.probation || s.paused || s.status === 'failed' || running.has(name)) return;
    let work;
    try { work = deps.pending(name, def); } catch { return; }
    const seen = new Set(s.seenWork || []);
    // the account is nearly spent (INT-296): optional work isn't offered. A held key it had already seen stays seen,
    // so the reset doesn't wake it again for work it left alone; one it never saw is fresh after the reset.
    const held = heldBack(def) ? work.filter((w) => OPTIONAL.has(w.action)) : [];
    const offered = held.length ? work.filter((w) => !OPTIONAL.has(w.action)) : work;
    const fresh = offered.filter((w) => !seen.has(w.key));
    s.seenWork = [...offered.map((w) => w.key), ...held.filter((w) => seen.has(w.key)).map((w) => w.key)];
    if (!fresh.length) return save();
    s.queue = s.queue.filter((e) => e.type !== 'work.pending'); // one summary, never a pile of them
    s.queue.push({ seq: deps.seq(), type: 'work.pending', actor: { kind: 'system', name: 'intellagent' }, at: new Date().toISOString(), work: fresh.slice(0, 25) });
    save();
    schedule(name, def.settleSeconds * 1000);
  }

  function setStatus(name, status, extra = {}) {
    const s = st(name);
    const was = s.status;
    s.status = status;
    Object.assign(s, extra);
    save();
    if (was === status) return;
    emit({ type: 'agent.status', actor: { kind: 'system', name: 'intellagent' }, agent: name, status, ...extra });
    // A stopped agent breaks the ⏳ promise on its queued comments: say so, and promise again once it is back.
    // A run starting clears the ⏳ itself (onRunStart).
    if (status === 'paused' || status === 'failed') reportQueue(name, s.queue, { [status]: true, refresh: true });
    else if ((was === 'paused' || was === 'failed') && status !== 'running') reportQueue(name, s.queue, { ...whenRuns(name), refresh: true });
  }
  // Tell the server about comments in the queue: when they will run (refresh: only where a ⏳ is already
  // shown), or gone: they left the queue without a run, so their ⏳ comes off.
  function reportQueue(name, events, when) {
    const comments = events.filter((e) => e.type === 'comment.added');
    if (!comments.length || (!when.gone && !when.paused && !when.failed && !when.busy && !when.at)) return;
    try { deps.onQueued?.(name, comments, when); } catch { /* best effort */ }
  }

  function dispatch(name) {
    const def = defs[name];
    const s = st(name);
    if (!def || running.has(name) || !s.queue.length) return;
    if (!def.enabled || s.paused) return setStatus(name, 'paused');
    if (s.status === 'failed') {
      // waits for the human to resume, except for its one probe run once the cool-off is over (INT-295)
      const probe = s.probeAt ? Date.parse(s.probeAt) : NaN; // never Date.parse(0): that is the year 2000, long due
      if (!Number.isFinite(probe)) return;
      if (Date.now() < probe) return schedule(name, probe - Date.now() + 50);
      delete s.probeAt;
      s.probing = true;
      setStatus(name, 'retrying');
    }
    if (lingering(name)) return schedule(name, 1000);
    // the account's usage limit is spent (INT-293): wait for its reset, then run as usual
    const held = limitedUntil(name) - Date.now();
    if (held > 0) {
      setStatus(name, 'waiting', { resumesAt: s.limitedUntil, waitingFor: 'usage limit' });
      return schedule(name, held + 1000);
    }
    delete s.limitedUntil;
    delete s.waitingFor;
    const hourAgo = Date.now() - 3600_000;
    s.runs = s.runs.filter((t) => Date.parse(t) > hourAgo);
    // Throttle: a quiet agent wakes at once; while it was woken less than throttleMinutes ago, events
    // pile up and arrive together. Retries after a failure follow their own back-off instead.
    const gap = (Number(def.throttleMinutes) || 0) * 60_000;
    const last = Date.parse(s.runs.at(-1) || 0);
    // (INT-308) the re-run of a triage run that found it must build waits for nothing but the hourly cap
    if (gap && !s.failures && !s.escalate && Date.now() - last < gap) {
      const wait = last + gap - Date.now() + 250;
      setStatus(name, 'waiting', { resumesAt: new Date(Date.now() + wait).toISOString() });
      return schedule(name, wait);
    }
    if (def.maxRunsPerHour != null && s.runs.length >= def.maxRunsPerHour) {
      const wait = Date.parse(s.runs[0]) + 3600_000 - Date.now() + 1000;
      setStatus(name, 'throttled', { resumesAt: new Date(Date.now() + wait).toISOString() });
      return schedule(name, wait);
    }
    start(name, def, s);
  }

  // Called for every board event.
  function onEvent(e) {
    if (e.type.startsWith('agent.')) return;
    enqueueAll(Object.values(defs).filter((def) => wakes(def, e)).map((def) => [def.name, [e]]));
    // A ticket landing in a pickup column (moved, created, unassigned, restored) is waiting work for agents
    // with "pickup": let them re-check soon, instead of at their next sweep.
    if (/^item\.(moved|created|assigned|restored)$/.test(e.type)) {
      for (const def of Object.values(defs)) if (def.pickup && def.enabled) soonPending(def.name);
    }
  }
  const pendTimers = new Map();
  function soonPending(name) {
    clearTimeout(pendTimers.get(name));
    pendTimers.set(name, setTimeout(() => { pendTimers.delete(name); if (!st(name).queue.length) checkPending(name); }, (defs[name]?.settleSeconds ?? 3) * 1000));
  }

  // After a reboot or server restart: runs that were in flight are retried, and anything that
  // happened while the agent wasn't listening (e.g. it was just added) is caught up from its cursor.
  function recover() {
    // A board that died without a clean stop leaves its agents' processes running, still working in their
    // worktrees. Stop each one that is provably ours (see leftovers) before any run starts again; dispatch
    // waits until they are gone.
    const found = leftovers(Object.values(state.agents).flatMap((s) => (s.procs || []).filter((p) => Number.isFinite(p?.pid) && p.pid !== process.pid)));
    for (const [name, s] of Object.entries(state.agents)) {
      const left = (s.procs || []).flatMap((p) => found.get(p) || []);
      s.procs = [];
      if (!left.length) continue;
      (deps.log || console.log)(`agents:${name}'s run from before the restart is still alive (pid ${left.join(', ')}); stopping it`);
      for (const pid of left) killTree({ pid });
      held.set(name, { pids: left, until: Date.now() + 60_000 });
      // one more try in case the first kill raced the process starting a child of its own
      setTimeout(() => { for (const pid of held.get(name)?.pids || []) killTree({ pid }); }, 5000).unref?.();
    }
    const batches = [];
    for (const def of Object.values(defs)) {
      const s = st(def.name);
      if (s.inflight) { requeueInflight(s); s.interrupted = true; }
      if ((s.cursor || 0) > deps.seq()) s.cursor = deps.seq(); // the event log was reset
      const missed = deps.recent().filter((e) => e.seq > (s.cursor || 0) && !e.type.startsWith('agent.') && wakes(def, e));
      if (s.status === 'running' || s.status === 'retrying' || s.status === 'queued') s.status = 'idle';
      if (missed.length || s.queue.length) batches.push([def.name, missed]);
    }
    if (batches.length) enqueueAll(batches); else save();
  }

  // Board start: catch up on work that piled up while nobody was listening. Deferred so the server can
  // finish loading boards first; then a slow sweep in case nothing else wakes an idle agent.
  const sweepAll = () => { for (const name of Object.keys(defs)) if (!st(name).queue.length) checkPending(name); };

  // The idle-board alarm: tickets wait to be started, yet no builder (an agent that edits files) has run for the
  // board's alarm minutes. It wakes the agents the human picked (the board's setting, deps.idleAlarms; else the
  // agents with "idleAlarm": true) with a board.idle event naming what waits, how each builder stands and the
  // human's note. A plain check: it costs no model run until it fires. Quiet while the builders are paused (stop
  // all), running or queued, and for the first stretch after the board starts.
  // Keyed on the set of waiting tickets, not on the quiet stretch: the alarm's own nudge wakes a builder, and a
  // builder that answers "waiting on X" and starts nothing must not restart the clock into a loop. A new set
  // alarms as soon as the builders have been quiet long enough; the same set again only after twice the wait
  // each time (20, 40, 80… minutes), so a ticket stuck for a reason the board can't see costs a few runs a day.
  const bootAt = Date.now();
  let idleTimer = null;
  const usable = (d) => d.enabled && !st(d.name).paused && st(d.name).status !== 'failed';
  const lastRunOf = (d) => Math.max(Date.parse(st(d.name).runs?.at(-1) || 0) || 0, Date.parse(st(d.name).lastRun?.startedAt || 0) || 0);
  function alarmSettings() {
    if (deps.idleAlarms) { try { return deps.idleAlarms(); } catch { return []; } }
    const flagged = Object.values(defs).filter((d) => d.idleAlarm);
    return [{ board: null, on: flagged.length > 0, minutes: Math.min(...flagged.map((d) => Number(d.idleAlarmMinutes) || 20)), wake: flagged.map((d) => d.name), note: '' }];
  }
  // An agent the alarm names that can't be woken, and why: what the human needs to bring it back (INT-294)
  const downOf = (d) => ({ name: d.name, status: !d.enabled ? 'disabled' : st(d.name).status === 'failed' ? 'failed' : 'paused',
    ...(st(d.name).status === 'failed' ? { code: st(d.name).lastRun?.code ?? null, failures: st(d.name).failures || 0 } : {}) });
  function checkIdle() {
    if (!deps.waiting) return;
    let next = Infinity;
    for (const cfg of alarmSettings()) {
      if (!cfg.on) continue;
      const named = [].concat(cfg.wake || []).map((n) => defs[n]).filter(Boolean);
      const alarm = named.filter(usable);
      // Nobody it names can be woken (failed, paused, or none named): that is when a person is needed most, so the
      // alarm goes to the human instead (INT-294), unless they switched that off. Same backoff, kept per board.
      const toHuman = !alarm.length && cfg.human !== false;
      if (!alarm.length && !toHuman) continue;
      const builders = Object.values(defs).filter((d) => d.worktree && usable(d) && !alarm.includes(d));
      // busy builders: checkPending (after their run) checks again
      if (!builders.length || builders.some((d) => running.has(d.name) || st(d.name).queue.length)) continue;
      // waiting for the usage limit to reset is not idling: nobody could run. The quiet stretch counts from the reset.
      const heldTill = Math.max(...builders.map((d) => limitedUntil(d.name)));
      if (heldTill > Date.now()) { next = Math.min(next, heldTill + 1000); continue; }
      const last = Math.max(bootAt, heldTill, ...builders.map(lastRunOf));
      const limit = (Number(cfg.minutes) || 20) * 60_000;
      if (Date.now() - last < limit) { next = Math.min(next, last + limit); continue; }
      let waiting;
      try { waiting = deps.waiting(cfg.board); } catch { continue; }
      if (!waiting.length) continue;
      const key = waiting.map((w) => `${w.board}:${w.id}`).sort().join(',');
      const slot = cfg.board || '*';
      const now = new Date().toISOString();
      const woke = [];
      let repeat = 1;
      const builderStates = () => builders.map((b) => ({ name: b.name, status: st(b.name).status, lastRunAt: lastRunOf(b) ? new Date(lastRunOf(b)).toISOString() : null }));
      if (toHuman) {
        state.idleHuman ||= {};
        const prev = state.idleHuman[slot]?.key === key ? state.idleHuman[slot] : null;
        const due = prev ? Date.parse(prev.at) + limit * 2 ** prev.repeats : 0;
        if (Date.now() < due) { next = Math.min(next, due); continue; }
        state.idleHuman[slot] = { key, at: now, repeats: prev ? prev.repeats + 1 : 1 };
        save();
        try {
          deps.onIdleAlarm?.(cfg.board, { at: now, idleSince: new Date(last).toISOString(), idleMinutes: Math.round((Date.now() - last) / 60_000),
            waitingCount: waiting.length, waiting: waiting.slice(0, 25).map((w) => w.id), woke: ['human'], repeat: state.idleHuman[slot].repeats,
            human: true, down: named.map(downOf), builders: builderStates() });
        } catch { /* best effort, like the agents' record */ }
        deps.log?.(`idle alarm${cfg.board ? ` (${cfg.board})` : ''}: nobody it names can be woken${named.length ? ` (${named.map((d) => d.name).join(', ')})` : ''}; told the human`);
        continue;
      }
      for (const d of alarm) {
        const s = st(d.name);
        s.idleAlarms ||= {};
        const prev = s.idleAlarms[slot]?.key === key ? s.idleAlarms[slot] : null;
        const due = prev ? Date.parse(prev.at) + limit * 2 ** prev.repeats : 0;
        if (Date.now() < due) { next = Math.min(next, due); continue; }
        s.idleAlarms[slot] = { key, at: now, repeats: prev ? prev.repeats + 1 : 1 };
        repeat = s.idleAlarms[slot].repeats;
        enqueue(d.name, [{ seq: deps.seq(), type: 'board.idle', actor: { kind: 'system', name: 'intellagent' }, at: now, ...(cfg.board ? { board: cfg.board } : {}),
          idleMinutes: Math.round((Date.now() - last) / 60_000), waitingCount: waiting.length, waiting: waiting.slice(0, 25), note: cfg.note || '',
          builders: builderStates() }]);
        woke.push(d.name);
      }
      if (woke.length) {
        try {
          deps.onIdleAlarm?.(cfg.board, { at: now, idleSince: new Date(last).toISOString(), idleMinutes: Math.round((Date.now() - last) / 60_000),
            waitingCount: waiting.length, waiting: waiting.slice(0, 25).map((w) => w.id), woke, repeat });
        } catch { /* the record is best effort; the wake already happened */ }
      }
    }
    if (next < Infinity) armIdle(next);
  }
  // Check again exactly when the quiet stretch would reach the limit (the 30 s sweep is the backstop)
  function armIdle(at) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(checkIdle, Math.max(200, at - Date.now() + 50));
    idleTimer.unref?.();
  }

  // Automatic rebalancing (INT-234). The scheduler says when, and which agents are active, away or gone; the board
  // (deps.rebalance) plans with lib/agents/rebalance.js and applies the moves. Only the sweep and a change to
  // agents.json call it, never an event, so a move (an item.assigned that wakes its new owner) can't set off another.
  const AWAY_MS = 60 * 60_000;
  const REBALANCE_MS = 10 * 60_000;
  const REMOVED_KEPT_MS = 24 * 3600_000;
  // A removal counts only once it has stood this long: one save of agents.json mid-edit, a rename, or remove then
  // re-add must not drain a queue. Back in the file before then, nothing happened. (Manifest: removalGraceMinutes.)
  const REMOVED_GRACE_MS = Number.isFinite(deps.removalGraceMs) && deps.removalGraceMs >= 0 ? deps.removalGraceMs : 10 * 60_000;
  // Paused or failed on its own, and since when. Stop all is the human pausing everyone at once: it never counts,
  // or resuming after an hour would set off a wave of moves.
  function awayOf(name) {
    const s = st(name);
    if (s.status === 'failed') return { as: 'failed', since: Date.parse(s.failedAt || 0) || null };
    if (s.paused && s.pausedAt && !s.stoppedAll) return { as: 'paused', since: Date.parse(s.pausedAt) };
    return null;
  }
  function rebalanceAgents() {
    const now = Date.now();
    const out = Object.values(defs).map((d) => {
      const away = awayOf(d.name);
      const state = away?.since && now - away.since >= AWAY_MS ? 'away' : usable(d) ? 'active' : 'off';
      return { name: d.name, state, ...(state === 'away' ? { awayAs: away.as } : {}), edits: !!d.worktree && !d.helper, role: d.role || null, tier: TIERS[String(d.model || '').toLowerCase()] || null, areas: [].concat(d.areas || []) };
    });
    // agents taken out of agents.json in the last day, and gone for the grace: their unstarted tickets move (once;
    // then there are none). Inside the grace the agent is in no list, so its tickets neither count nor move.
    const gone = state.removed || {};
    for (const [name, at] of Object.entries(gone)) {
      if (defs[name] || now - Date.parse(at) > REMOVED_KEPT_MS) { delete gone[name]; continue; }
      if (now - Date.parse(at) < REMOVED_GRACE_MS) continue;
      out.push({ name, state: 'removed', edits: false, role: null, tier: null, areas: [] });
    }
    return out;
  }
  let lastRebalance = 0;
  // reason: 'sweep' (at most every REBALANCE_MS) or 'agents.changed' (an agent added, removed or given a new role)
  function checkRebalance(reason = 'sweep') {
    if (!deps.rebalance) return;
    if (reason === 'sweep' && Date.now() - lastRebalance < REBALANCE_MS) return;
    lastRebalance = Date.now();
    // the next sweep tries again, but say so: a pass that always throws must not fail silently forever
    try { deps.rebalance({ reason, agents: rebalanceAgents() }); } catch (e) { (deps.log || console.log)(`agents: rebalancing (${reason}) failed: ${e?.message || e}`); }
  }
  // agents.json was re-read: remember who left (for a day), forget who came back, and rebalance if the team changed
  function agentsChanged(before) {
    const now = new Date().toISOString();
    state.removed ||= {};
    const names = Object.keys(before);
    // A file with a problem (an entry skipped, the file gone) can drop an agent the human never removed: moving its
    // queue then would be the board guessing. Only a clean read that still has a team counts as a removal.
    let problem = null;
    try { problem = core.config.loadError?.() || null; } catch { /* none */ }
    const trusted = !problem && Object.keys(defs).length > 0;
    if (trusted) for (const n of names) if (!defs[n]) state.removed[n] = state.removed[n] || now;
    for (const n of Object.keys(defs)) delete state.removed[n];
    const changed = names.length !== Object.keys(defs).length || Object.keys(defs).some((n) => !(n in before) || before[n] !== (defs[n].role || null));
    save();
    if (changed) checkRebalance('agents.changed');
  }

  let firstSweep = null;
  let sweepTimer = null;
  function startSweeps() {
    firstSweep = setTimeout(sweepAll, 1500);
    sweepTimer = setInterval(() => {
      for (const [name, def] of Object.entries(defs)) {
        const every = Number(def.sweepMinutes) || 0;
        const last = Date.parse(st(name).lastSweep || 0);
        if (!every || Date.now() - last < every * 60_000 - 1000) continue;
        st(name).lastSweep = new Date().toISOString();
        if (!st(name).queue.length) checkPending(name);
      }
      checkIdle();
      checkRebalance('sweep');
    }, 30_000);
    firstSweep.unref?.(); sweepTimer.unref?.();
    checkIdle();
  }
  function stopSweeps() { clearTimeout(firstSweep); clearInterval(sweepTimer); clearTimeout(idleTimer); }

  const api = {
    // Human controls. Commands only ever come from agents.json, never from the API.
    resume(name) {
      name = need(name);
      const s = st(name);
      s.failures = 0;
      delete s.probeAt; delete s.probing; // the human ends the streak: a later one gets its own probe
      if (!s.paused) { delete s.pausedAt; delete s.stoppedAll; }
      setStatus(name, s.queue.length ? 'queued' : 'idle');
      dispatch(name);
      checkPending(name);
      return view(name);
    },
    // Pausing lets a current run finish; events keep queueing until unpaused.
    pause(name) {
      name = need(name);
      const s = st(name);
      // since when it is away on its own (rebalancing counts from here; stop all doesn't)
      if (!s.paused || s.stoppedAll) { s.pausedAt = new Date().toISOString(); s.stoppedAll = false; }
      s.paused = true;
      if (!running.has(name)) endSession(name);
      setStatus(name, 'paused');
      return view(name);
    },
    unpause(name) { name = need(name); st(name).paused = false; return api.resume(name); },
    // Stop everything now: pause every agent and kill the runs in flight (their events stay queued).
    stopAll() {
      const stopped = [];
      for (const name of Object.keys(defs)) {
        const s = st(name);
        // an agent already paused on its own stays away from when it was; the rest are stopped, not away
        if (!s.paused) s.stoppedAll = true;
        s.paused = true;
        clearTimeout(timers.get(name));
        const r = running.get(name);
        // a run still catching up its worktree has no process yet: marked stopped, it never starts one
        if (r) { r.stopped = true; if (r.child) killTree(r.child); stopped.push(name); } else { endSession(name); setStatus(name, 'paused'); }
      }
      save();
      return { paused: Object.keys(defs), stopped };
    },
    resumeAll() {
      for (const name of Object.keys(defs)) { st(name).paused = false; api.resume(name); }
      return { resumed: Object.keys(defs) };
    },
    // by: who asked for the run (the human, or an agent with agents.control), so the prompt names them
    runNow(name, note, by = { kind: 'user', name: 'human' }) {
      name = need(name);
      const s = st(name);
      if (!s.queue.length) s.queue.push({ seq: deps.seq(), type: 'agent.poke', actor: { kind: by.kind, name: by.name }, reason: note || 'Check the board for anything that needs you.' });
      s.failures = 0;
      delete s.probeAt; delete s.probing;
      if (running.has(name)) return view(name); // picked up by the next run
      clearTimeout(timers.get(name));
      if (s.status === 'failed' || s.status === 'throttled') s.status = 'idle';
      if (lingering(name)) { schedule(name, 1000); return view(name); }
      start(name, defs[name], s);
      return view(name);
    },
  };

  return { api, onEvent, enqueue, schedule, dispatch, checkPending, checkIdle, holdForLimit, noteRate, usageView, heldMinutes, checkRebalance, rebalanceAgents, agentsChanged, setStatus, reportQueue, recover, sweepAll, startSweeps, stopSweeps, whenRuns };
}

module.exports = { createScheduler, QUEUE_MAX };
