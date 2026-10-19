'use strict';
// Standing agents: the board starts a short headless run whenever events arrive for an agent, so
// agents can be ephemeral (a reboot or crash loses nothing) while the board server is the one thing
// that stays up.
//
//   .intellagent/agents.json   definitions — yours, version-controlled, the only place commands come from
//   data/agents.state.json     runtime state — queue, cursor, failures, last run (rewritten constantly)
//
// Rules: one run per agent at a time (events arriving meanwhile wait for the next run); a failed or
// interrupted run is retried automatically with its events; after `maxFailures` in a row the agent is
// flagged as failed and waits for the human; `maxRunsPerHour` (null = no limit) throttles.
//
// createAgents wires four parts, each in lib/agents/:
//   config.js     who the agents are: agents.json (load, define, manage, remove), roles, run commands
//   scheduler.js  when they run: wake filters, queue, throttle, sweeps, recovery, pause/resume/run now
//   runner.js     how they run: one-shot processes, keep-alive sessions, a run's end, retries
//   state.js      the queue, cursor and last run each of them keeps (agents.state.json)
//   guard.js      that runs end when the board dies: a Windows job object, a process-group reaper elsewhere
const fs = require('fs');
const path = require('path');
const { createState } = require('./agents/state');
const { createConfig, readAgentsFile, writeAgentsFile, DEFAULTS, ROLES, PERMS, TIERS, runFor, commandRule, withModel, withJsonOutput, keepAliveCmd, boardMcpConfig } = require('./agents/config');
const { createScheduler } = require('./agents/scheduler');
const { createRunner } = require('./agents/runner');
const { createGuard } = require('./agents/guard');
const { eventLine } = require('./agents/prompt');
const { usageOf, recycleTokens, parseUsage, dayOf } = require('./agents/usage');

/**
 * deps: { file, stateFile, logDir, cwd, env, emit, matchesFilter, parseFilter, recent: () => events[], seq: () => number, log }
 */
function createAgents(deps) {
  const { file, stateFile, emit } = deps;
  const { state, save, st, requeueInflight } = createState({ stateFile, seq: () => deps.seq() });
  // What the parts share. defs is one object, emptied and refilled when agents.json loads, never replaced.
  const core = {
    deps, state, save, st, requeueInflight,
    defs: {},                 // name → resolved definition
    running: new Map(),       // name → { child, timer }
    sessions: new Map(),      // name → keep-alive session { child, turns, startedAt, turn, closed, cmd }
    timers: new Map(),        // name → pending dispatch timer
    procs: new Map(),         // name → Set of child processes not yet exited (runs and sessions)
    held: new Map(),          // name → { pids, until } of processes that outlived a board restart, being stopped
  };
  const { defs, running, sessions } = core;
  // runs end when the board dies (INT-262); a sandbox runs nothing, and INTELLAGENT_RUN_GUARD=off leaves only the pid list.
  // The helper lives in the board's data folder; INTELLAGENT_RUN_GUARD_BIN shares one folder (the tests' many boards).
  core.guard = createGuard({
    log: deps.log, off: !!deps.noRuns || process.env.INTELLAGENT_RUN_GUARD === 'off',
    binDir: process.env.INTELLAGENT_RUN_GUARD_BIN || path.join(path.dirname(stateFile), 'bin'),
  });
  const config = core.config = createConfig(core);
  const scheduler = core.scheduler = createScheduler(core);
  const runner = core.runner = createRunner(core);

  function view(name) {
    const def = defs[name];
    const s = st(name);
    const r = running.get(name);
    const active = r ? runner.lastActivity(name, r) : null;
    const stallMs = (Number(def.stallMinutes ?? DEFAULTS.stallMinutes) || 0) * 60_000;
    // What the run is doing now: the newest of its own status line and the status of a ticket it holds (deps.activityOf)
    let now = null;
    if (r) {
      let act = null;
      try { act = deps.activityOf?.(name, r.startedAt) || null; } catch { /* none */ }
      now = { since: r.startedAt, why: s.lastRun?.why || null, items: [...new Set([...(r.items || []), ...(act?.items || [])])], line: act?.line || null };
    }
    return {
      name, role: def.role || null, model: def.model || null, runModels: def.runModels || null, provider: def.provider || null, tier: (def.provider || 'anthropic') === 'anthropic' ? TIERS[String(def.model || '').toLowerCase()] || null : null, perms: def.perms, permsFrom: def.permsFrom || null, differsFromRole: def.differsFromRole || null, enabled: def.enabled && !s.paused, listen: def.listen, wakeFrom: def.wakeFrom || 'events', context: { held: (s.context || []).length, dropped: s.contextDropped || 0 }, description: def.description || null,
      run: def.run, maxRunsPerHour: def.maxRunsPerHour, throttleMinutes: def.throttleMinutes, maxFailures: def.maxFailures, timeoutMinutes: def.timeoutMinutes,
      status: def.enabled && !s.paused ? s.status : 'paused', queued: s.queue.length, failures: s.failures,
      runsLastHour: s.runs.filter((t) => Date.parse(t) > Date.now() - 3600_000).length,
      grants: [].concat(def.grants || []), guidance: { ...(def.guidance || {}) }, guidanceBy: { ...(def.guidanceBy || {}) }, reviewer: !!def.reviewer, helper: !!def.helper, areas: [].concat(def.areas || []), concerns: [].concat(def.concerns || []), contextFile: def.context ? null : path.relative(path.dirname(file), config.contextPath(def)).replace(/\\/g, '/'), hasContext: !!config.readContext(def).trim(), personality: def.personality || null, contextItems: Array.isArray(def.contextItems) ? def.contextItems.map((i) => (i.kind === 'file' ? { ...i, check: config.api.checkContextPath(i.path) } : i)) : null,
      limits: def.limits || null, worktree: def.worktree && deps.worktrees ? deps.worktrees.where(name) : null, changes: (s.changes || []).slice(-10),
      idleAlarm: def.idleAlarm ? { minutes: Number(def.idleAlarmMinutes) || 20 } : null, supervise: !!def.supervise,
      pickup: def.pickup || false, keepAlive: def.keepAlive || false, session: sessions.get(name) ? { alive: true, turns: sessions.get(name).turns, context: sessions.get(name).context ?? null, floor: sessions.get(name).floor ?? null, recycleAboveTokens: recycleTokens(def), since: sessions.get(name).startedAt, recycleAfter: Number(def.recycleAfterRuns) || DEFAULTS.recycleAfterRuns, warm: sessions.get(name).warm || null } : null, lastWarm: s.lastWarm || null,
      probation: def.probation || null,
      lastRun: s.lastRun, usageToday: s.usageToday?.day === dayOf() ? s.usageToday : null, runningSince: r?.startedAt || null,
      // stalled also covers a resume that is minutes late (INT-379)
      lastActivityAt: active, stalled: (!!active && !!stallMs && Date.now() - Date.parse(active) > stallMs) || (['throttled', 'waiting'].includes(s.status) && !!s.resumesAt && Date.now() - Date.parse(s.resumesAt) > 5 * 60_000),
      now, history: s.history || [], resumesAt: s.status === 'throttled' || s.status === 'waiting' ? s.resumesAt : undefined,
      // INT-293: the account's usage limit is spent; the agent runs again by itself at resumesAt
      waitingFor: s.status === 'waiting' ? s.waitingFor || null : undefined,
      // INT-295: a failed agent's one more try ("failed, one more try at HH:MM"); probing while that run is the try
      probeAt: s.status === 'failed' ? s.probeAt || null : undefined, probing: s.probing ? true : undefined, limitedUntil: Date.parse(s.limitedUntil || 0) > Date.now() ? s.limitedUntil : null,
    };
  }
  core.view = view;

  config.load();
  config.migrateContext(); // old context pages become context items, once
  core.guard.start();
  scheduler.recover();
  scheduler.startSweeps();
  // who, in which role, as of the last time the file was read here: remove() reloads before the watcher fires,
  // so the live defs would already have lost the agent that left
  const teamOf = () => Object.fromEntries(Object.entries(defs).map(([n, d]) => [n, d.role || null]));
  let team = teamOf();
  fs.watchFile(file, { interval: 2000 }, () => {
    config.load();
    config.migrateContext();
    scheduler.agentsChanged(team);
    team = teamOf();
    // An agent added by editing the file (intellagent agents add) needs its token before its first run.
    deps.onAgentsChanged?.(Object.keys(defs));
    for (const name of [...sessions.keys()]) if (!defs[name] || !defs[name].keepAlive || !defs[name].enabled) { if (!running.has(name)) runner.endSession(name); }
    for (const name of Object.keys(defs)) scheduler.dispatch(name);
    scheduler.sweepAll();
    emit({ type: 'agents.changed', actor: { kind: 'system', name: 'intellagent' }, agents: Object.keys(defs), ...(config.loadError() ? { error: config.loadError() } : {}) });
  });

  return {
    file,
    onEvent: scheduler.onEvent,
    // recent: also the newest runs across all agents (newest first), for the activity strip
    list: ({ recent = 0 } = {}) => {
      const agents = Object.keys(defs).map(view);
      // INT-296: each account's windows, and whether optional work is held back
      const usage = scheduler.usageView();
      if (!recent) return { file, error: config.loadError(), agents, usage };
      const runs = agents.flatMap((a) => a.history.map((h) => ({ agent: a.name, ...h }))).sort((x, y) => y.startedAt.localeCompare(x.startedAt)).slice(0, recent);
      return { file, error: config.loadError(), agents, usage, recent: runs };
    },
    // minutes optional work was held back for the usage, in [sinceMs, untilMs) (the metrics)
    usageHeldMinutes: (sinceMs, untilMs) => scheduler.heldMinutes(sinceMs, untilMs),
    get: (name) => view(config.need(name)),
    // a cheap "is a run live now" for the board's seen-not-answered check (INT-343); unknown names are not running
    isRunning: (name) => { const k = Object.keys(defs).find((n) => n.toLowerCase() === String(name).toLowerCase()); return !!k && running.has(k); },
    ...config.api,
    ...runner.api,
    ...scheduler.api,
    stop() { scheduler.stopSweeps(); runner.killAll(); core.guard.stop(); fs.unwatchFile(file); },
  };
}

module.exports = { createAgents, readAgentsFile, writeAgentsFile, eventLine, DEFAULTS, ROLES, PERMS, runFor, commandRule, withModel, withJsonOutput, parseUsage, usageOf, keepAliveCmd, boardMcpConfig, TIERS, specialityText: require('./agents/config').specialityText };
