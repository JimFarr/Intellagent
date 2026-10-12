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
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

const DEFAULTS = {
  // Headless runs can't ask for permission: allow the board's CLI and MCP tools up front.
  // Add the project's own commands (tests, build) per agent in agents.json.
  run: 'claude -p "Handle the Intellagent events described on stdin." --permission-mode acceptEdits --allowedTools "Bash(intellagent:*)" "mcp__intellagent"',
  listen: 'inbox',
  maxRunsPerHour: 20,   // null = no limit
  maxFailures: 3,
  timeoutMinutes: 60,
  settleSeconds: 3,   // let a burst of edits land in one run
  throttleMinutes: 3, // after a run starts, further events wait and land together in one run when the window ends (0 = off)
  retrySeconds: 30,   // first retry delay after a failure; doubles each time (max 10 min)
};
const QUEUE_MAX = 200;
const LOGS_KEPT = 20;

const eventLine = (e) => `#${e.seq} ${e.type}${e.itemId ? ` ${e.itemId}` : ''}${e.item?.title ? ` "${e.item.title}"` : ''} by ${e.actor?.name || '?'}${e.reply ? ` — reply: ${e.reply}` : e.comment?.body ? ` — ${e.comment.body}` : e.reason ? ` — ${e.reason}` : ''}`;

function promptFor(name, events, { listen, evFile, interrupted, failures, earlier = [] }) {
  return [
    listen === 'inbox'
      ? `You are "${name}", working on this project's Intellagent board. These events are addressed to you:`
      : `You are "${name}", coordinating this project's Intellagent board. New activity:`,
    ...events.map((e) => `- ${eventLine(e)}`),
    '',
    ...(interrupted ? ['Your previous run on these events did not finish (error, timeout or restart). It may have done part of the work: check the cards (comments, status, column) and the working tree before redoing anything.', ''] : []),
    ...(earlier.length ? ['What the earlier attempt already did on the board (do not repeat it):', ...earlier.slice(-30).map((e) => `- ${eventLine(e)}`), ''] : []),
    ...(failures ? [`Attempt ${failures + 1}: the previous run exited with an error.`, ''] : []),
    'Start with: intellagent brief   (your situation, the board\'s rules and the exact next calls). Then act on it following the board\'s standing rules and the project\'s CLAUDE.md, and reply on the card.',
    'Finish with: intellagent api POST /api/boards/<board>/finish summary="…" — it releases anything you still hold.',
    'Anything worth remembering must go on the card — this run ends when you finish and nothing else is kept.',
    // Agents tend to write `cd … && VAR=x intellagent …`, which no longer matches a `Bash(intellagent …)`
    // allowlist rule — so say plainly that neither is needed.
    `You are already "${name}" (INTELLAGENT_AGENT is set) and already in the project folder: run commands bare — \`intellagent …\`, \`npm test\` — with no \`cd\` and no environment-variable prefixes, or the permission allowlist will refuse them. The board's MCP tools (get_briefing, start_work, request_review, finish_session…) work too.`,
    `Full event JSON: ${evFile}`,
  ].join('\n');
}

function killTree(child) {
  if (process.platform === 'win32') execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], () => {});
  else try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
}

/**
 * deps: { file, stateFile, logDir, cwd, env, emit, matchesFilter, parseFilter, recent: () => events[], seq: () => number, log }
 */
function createAgents(deps) {
  const { file, stateFile, logDir, cwd, emit, matchesFilter, parseFilter } = deps;
  let defs = {};      // name → resolved definition
  let defaults = { ...DEFAULTS };
  let loadError = null;
  const state = readState();
  const running = new Map(); // name → { child, timer }
  const timers = new Map();  // name → pending dispatch timer

  function readState() {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { agents: {} }; }
  }
  // Written immediately, not debounced: a power cut right after a run starts must still find it here.
  function save() {
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile);
  }
  const st = (name) => (state.agents[name] ||= { status: 'idle', cursor: deps.seq(), queue: [], inflight: null, runs: [], failures: 0, lastRun: null });

  function load() {
    loadError = null;
    let raw = { agents: {} };
    if (fs.existsSync(file)) {
      // strip a BOM: Notepad and PowerShell add one
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { loadError = `${path.basename(file)}: ${e.message}`; return; }
    }
    defaults = { ...DEFAULTS, ...(raw.defaults || {}) };
    defs = {};
    for (const [name, d] of Object.entries(raw.agents || {})) {
      if (!/^[\w.-]{1,64}$/.test(name)) { loadError = `invalid agent name "${name}"`; continue; }
      defs[name] = { ...defaults, ...d, name, enabled: d.enabled !== false };
      st(name);
    }
  }

  // The filter an agent wakes on; never its own actions.
  function filterFor(def) {
    const base = def.listen === 'human' ? { actorKind: 'user' }
      : def.listen && typeof def.listen === 'object' ? def.listen
        : { for: def.name };
    return parseFilter({ ...base, excludeActor: def.name });
  }

  function enqueue(name, events) {
    const s = st(name);
    for (const e of events) if (!s.queue.some((q) => q.seq === e.seq)) s.queue.push(e);
    if (s.queue.length > QUEUE_MAX) s.queue.splice(0, s.queue.length - QUEUE_MAX);
    const last = events[events.length - 1];
    if (last) s.cursor = Math.max(s.cursor || 0, last.seq);
    save();
    schedule(name, defs[name].settleSeconds * 1000);
  }

  function schedule(name, ms) {
    clearTimeout(timers.get(name));
    timers.set(name, setTimeout(() => { timers.delete(name); dispatch(name); }, ms));
  }

  function setStatus(name, status, extra = {}) {
    const s = st(name);
    const changed = s.status !== status;
    s.status = status;
    Object.assign(s, extra);
    save();
    if (changed) emit({ type: 'agent.status', actor: { kind: 'system', name: 'intellagent' }, agent: name, status, ...extra });
  }

  function dispatch(name) {
    const def = defs[name];
    const s = st(name);
    if (!def || running.has(name) || !s.queue.length) return;
    if (!def.enabled || s.paused) return setStatus(name, 'paused');
    if (s.status === 'failed') return; // waits for the human to resume
    const hourAgo = Date.now() - 3600_000;
    s.runs = s.runs.filter((t) => Date.parse(t) > hourAgo);
    // Throttle: a quiet agent wakes at once; while it was woken less than throttleMinutes ago, events
    // pile up and arrive together. Retries after a failure follow their own back-off instead.
    const gap = (Number(def.throttleMinutes) || 0) * 60_000;
    const last = Date.parse(s.runs.at(-1) || 0);
    if (gap && !s.failures && Date.now() - last < gap) {
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

  function start(name, def, s) {
    const events = s.queue.splice(0, s.queue.length);
    const interrupted = !!s.interrupted;
    // Same events → same batch id across retries: the CLI derives Idempotency-Keys from it, so a retried
    // run that repeats an identical write gets the first reply instead of doing it twice.
    const batch = crypto.createHash('sha1').update(events.map((e) => e.seq).join(',')).digest('hex').slice(0, 16);
    const runId = `run_${crypto.randomBytes(5).toString('hex')}`;
    const earlier = (s.attempts || []).length ? deps.recent().filter((e) => e.actor?.run && s.attempts.includes(e.actor.run)) : [];
    s.attempts = [...(s.attempts || []), runId].slice(-5);
    s.inflight = events;
    s.interrupted = false;
    const startedAt = new Date().toISOString();
    s.runs.push(startedAt);
    const dir = path.join(logDir, name.replace(/[^\w.-]+/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    const stamp = startedAt.replace(/[:.]/g, '-');
    const evFile = path.join(dir, `${stamp}.events.json`);
    const logFile = path.join(dir, `${stamp}.log`);
    fs.writeFileSync(evFile, JSON.stringify(events, null, 2));
    const out = fs.openSync(logFile, 'a');
    const prompt = promptFor(name, events, { listen: def.listen === 'inbox' || !def.listen ? 'inbox' : 'other', evFile, interrupted, failures: s.failures, earlier });
    fs.writeSync(out, `$ ${Array.isArray(def.run) ? def.run.join(' ') : def.run}\n--- prompt ---\n${prompt}\n--- output ---\n`);

    let child;
    try {
      const cmd = Array.isArray(def.run) ? def.run : [def.run];
      child = spawn(cmd[0], cmd.slice(1), {
        cwd: def.cwd ? path.resolve(cwd, def.cwd) : cwd,
        shell: true, detached: process.platform !== 'win32', windowsHide: true,
        stdio: ['pipe', out, out],
        env: { ...process.env, ...deps.env, ...(def.env || {}), INTELLAGENT_AGENT: name, INTELLAGENT_EVENTS: evFile, INTELLAGENT_RUN: runId, INTELLAGENT_BATCH: batch },
      });
    } catch (e) {
      fs.closeSync(out);
      return finish(name, def, { code: -1, error: e.message, startedAt, logFile });
    }
    child.stdin.on('error', () => {}); // a command that ignores stdin closes it early
    child.stdin.end(prompt);
    const timer = setTimeout(() => { running.get(name).timedOut = true; killTree(child); }, def.timeoutMinutes * 60_000);
    running.set(name, { child, timer, startedAt, logFile });
    setStatus(name, 'running', { lastRun: { startedAt, runId, events: events.length, log: logFile } });
    emit({ type: 'agent.run.started', actor: { kind: 'system', name: 'intellagent' }, agent: name, events: events.map((e) => e.seq), items: [...new Set(events.map((e) => e.itemId).filter(Boolean))] });
    child.on('error', (e) => fs.writeSync(out, `\n[spawn error] ${e.message}\n`));
    child.on('close', (code) => {
      const r = running.get(name);
      clearTimeout(timer);
      running.delete(name);
      try { fs.closeSync(out); } catch { /* already closed */ }
      finish(name, def, { code: r?.timedOut ? 'timeout' : code, startedAt, logFile });
    });
    pruneLogs(dir);
  }

  function finish(name, def, { code, error, startedAt, logFile }) {
    const s = st(name);
    const ok = code === 0;
    const durationMs = Date.now() - Date.parse(startedAt);
    s.lastRun = { startedAt, endedAt: new Date().toISOString(), code, durationMs, log: logFile, ...(error ? { error } : {}) };
    if (ok) {
      s.inflight = null;
      s.failures = 0;
      s.attempts = [];
      deps.onRunEnd?.(name); // a finished run holds nothing: free leases it forgot to release
    } else {
      // retry the same events, ahead of anything that arrived meanwhile
      s.queue = [...(s.inflight || []), ...s.queue.filter((e) => !(s.inflight || []).some((i) => i.seq === e.seq))];
      s.inflight = null;
      s.interrupted = true; // the retry must check for half-finished work, whatever stopped this run
      s.failures++;
    }
    emit({ type: 'agent.run.finished', actor: { kind: 'system', name: 'intellagent' }, agent: name, code, durationMs, failures: s.failures });
    if (!ok && s.failures >= def.maxFailures) {
      setStatus(name, 'failed', { failedAt: new Date().toISOString() });
      emit({ type: 'agent.failed', actor: { kind: 'system', name: 'intellagent' }, agent: name, failures: s.failures, code, log: logFile });
      return;
    }
    setStatus(name, s.queue.length ? (ok ? 'queued' : 'retrying') : 'idle');
    if (s.queue.length) schedule(name, ok ? def.settleSeconds * 1000 : Math.min(def.retrySeconds * 1000 * 2 ** (s.failures - 1), 10 * 60_000));
  }

  function pruneLogs(dir) {
    try {
      const logs = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
      for (const f of logs.slice(0, Math.max(0, logs.length - LOGS_KEPT))) {
        fs.rmSync(path.join(dir, f), { force: true });
        fs.rmSync(path.join(dir, f.replace(/\.log$/, '.events.json')), { force: true });
      }
    } catch { /* ignore */ }
  }

  // Called for every board event.
  function onEvent(e) {
    if (e.type.startsWith('agent.')) return;
    for (const def of Object.values(defs)) if (matchesFilter(e, filterFor(def))) enqueue(def.name, [e]);
  }

  // After a reboot or server restart: runs that were in flight are retried, and anything that
  // happened while the agent wasn't listening (e.g. it was just added) is caught up from its cursor.
  function recover() {
    for (const def of Object.values(defs)) {
      const s = st(def.name);
      if (s.inflight) { s.queue = [...s.inflight, ...s.queue]; s.inflight = null; s.interrupted = true; }
      if ((s.cursor || 0) > deps.seq()) s.cursor = deps.seq(); // the event log was reset
      const missed = deps.recent().filter((e) => e.seq > (s.cursor || 0) && !e.type.startsWith('agent.') && matchesFilter(e, filterFor(def)));
      if (s.status === 'running' || s.status === 'retrying' || s.status === 'queued') s.status = 'idle';
      if (missed.length || s.queue.length) enqueue(def.name, missed);
    }
    save();
  }

  function view(name) {
    const def = defs[name];
    const s = st(name);
    const r = running.get(name);
    return {
      name, enabled: def.enabled && !s.paused, listen: def.listen, description: def.description || null,
      run: def.run, maxRunsPerHour: def.maxRunsPerHour, throttleMinutes: def.throttleMinutes, maxFailures: def.maxFailures, timeoutMinutes: def.timeoutMinutes,
      status: def.enabled && !s.paused ? s.status : 'paused', queued: s.queue.length, failures: s.failures,
      runsLastHour: s.runs.filter((t) => Date.parse(t) > Date.now() - 3600_000).length,
      lastRun: s.lastRun, runningSince: r?.startedAt || null, resumesAt: s.status === 'throttled' || s.status === 'waiting' ? s.resumesAt : undefined,
    };
  }

  function need(name) {
    const hit = Object.keys(defs).find((n) => n.toLowerCase() === String(name).toLowerCase());
    if (!hit) { const e = new Error(`No standing agent "${name}" in ${path.basename(file)}`); e.status = 404; throw e; }
    return hit;
  }

  load();
  recover();
  fs.watchFile(file, { interval: 2000 }, () => {
    load();
    for (const name of Object.keys(defs)) dispatch(name);
    emit({ type: 'agents.changed', actor: { kind: 'system', name: 'intellagent' }, agents: Object.keys(defs), ...(loadError ? { error: loadError } : {}) });
  });

  return {
    file,
    onEvent,
    list: () => ({ file, error: loadError, agents: Object.keys(defs).map(view) }),
    get: (name) => view(need(name)),
    isRunning: (name) => running.has(name),
    // Human controls. Commands only ever come from agents.json, never from the API.
    resume(name) {
      name = need(name);
      const s = st(name);
      s.failures = 0;
      setStatus(name, s.queue.length ? 'queued' : 'idle');
      dispatch(name);
      return view(name);
    },
    // Pausing lets a current run finish; events keep queueing until unpaused.
    pause(name) { name = need(name); st(name).paused = true; setStatus(name, 'paused'); return view(name); },
    unpause(name) { name = need(name); st(name).paused = false; return this.resume(name); },
    runNow(name, note) {
      name = need(name);
      const s = st(name);
      if (!s.queue.length) s.queue.push({ seq: deps.seq(), type: 'agent.poke', actor: { kind: 'user', name: 'human' }, reason: note || 'Check the board for anything that needs you.' });
      s.failures = 0;
      if (running.has(name)) return view(name); // picked up by the next run
      clearTimeout(timers.get(name));
      if (s.status === 'failed' || s.status === 'throttled') s.status = 'idle';
      start(name, defs[name], s);
      return view(name);
    },
    stop() { for (const { child } of running.values()) killTree(child); fs.unwatchFile(file); },
  };
}

module.exports = { createAgents, eventLine, DEFAULTS };
