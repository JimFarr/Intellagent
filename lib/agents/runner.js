'use strict';
// Running a standing agent: the one-shot process or the keep-alive session a run goes through, the processes it
// leaves behind, and what a run's end means (failure, retry, recycle). When to run is the scheduler's.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { killTree, lives } = require('./proc');
const { DEFAULTS, specialityText, keepAliveCmd, withJsonOutput } = require('./config');
const { promptFor } = require('./prompt');
const { usageOf, bloated, parseUsage, dayOf } = require('./usage');

const HISTORY_KEPT = 10;
const LOGS_KEPT = 20;

/**
 * core: the pieces every part of createAgents shares (see agents.js).
 */
function createRunner(core) {
  const { deps, defs, st, save, requeueInflight, running, sessions, procs, held } = core;
  const { logDir, cwd, emit } = deps;
  const schedule = (...a) => core.scheduler.schedule(...a);
  const setStatus = (...a) => core.scheduler.setStatus(...a);
  const checkPending = (...a) => core.scheduler.checkPending(...a);
  const readContext = (...a) => core.config.readContext(...a);

  // One agent, one process: two would share its worktree and pay for every wake twice. Each process a run
  // or session starts is recorded (in memory, and by pid in the state so a board that dies without a clean
  // stop finds it again: Windows never kills a dead parent's children) until it exits.
  function track(name, child) {
    if (!child.pid) return;
    const s = st(name);
    const at = Date.now();
    (procs.get(name) || procs.set(name, new Set()).get(name)).add(child);
    s.procs = [...(s.procs || []), { pid: child.pid, at }];
    save();
    child.on('exit', () => {
      procs.get(name)?.delete(child);
      s.procs = (s.procs || []).filter((p) => p.pid !== child.pid);
      save();
    });
  }
  // How many processes of this agent, other than its reusable keep-alive session, are still alive: an ended
  // session finishing up, a killed run, or one from before a restart. The next run waits for them.
  function lingering(name) {
    const keep = sessions.get(name);
    const mine = [...(procs.get(name) || [])].filter((c) => !(keep && !keep.closed && keep.child === c) && c.exitCode == null && c.signalCode == null);
    // a pid from before the restart is waited on for a minute at most: Windows may hand it to someone else
    const h = held.get(name);
    const before = h && Date.now() < h.until ? h.pids.filter(lives) : [];
    if (before.length) held.set(name, { ...h, pids: before }); else held.delete(name);
    return mine.length + before.length;
  }

  // Keep-alive: one process per agent, fed one turn at a time.
  function session(name, def, runCwd) {
    const cmd = keepAliveCmd(def.run);
    let x = sessions.get(name);
    if (x && !x.closed && x.cmd === cmd && x.cwd === runCwd) return x;
    // a session for another command or folder: the old one is idle (no turn runs while dispatch could start
    // this one), so stop it outright rather than letting it finish up beside the new one
    if (x) { endSession(name); if (x.child.exitCode == null) killTree(x.child); }
    const runFile = path.join(logDir, name.replace(/[^\w.-]+/g, '_'), 'current-run.json');
    fs.mkdirSync(path.dirname(runFile), { recursive: true });
    const child = spawn(cmd, [], {
      cwd: runCwd,
      shell: true, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...deps.env, ...(def.env || {}), INTELLAGENT_AGENT: name, INTELLAGENT_RUN_FILE: runFile },
    });
    track(name, child);
    x = { child, cmd, cwd: runCwd, runFile, turns: 0, startedAt: new Date().toISOString(), turn: null, closed: false, buf: '' };
    const log = (d) => { if (x.turn) try { fs.writeSync(x.turn.out, d); } catch { /* closed */ } };
    child.stdin.on('error', () => {});
    child.stderr.on('data', log);
    child.stdout.on('data', (d) => {
      log(d);
      x.buf += d;
      let i;
      while ((i = x.buf.indexOf('\n')) >= 0) {
        const line = x.buf.slice(0, i).trim();
        x.buf = x.buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type !== 'result' || !x.turn) continue;
        const t = x.turn;
        x.turn = null;
        x.turns++;
        t.done(m.is_error ? 1 : 0, usageOf(m));
      }
    });
    child.on('error', (e) => log(`\n[spawn error] ${e.message}\n`));
    child.on('close', (code) => {
      x.closed = true;
      if (sessions.get(name) === x) sessions.delete(name);
      const t = x.turn;
      x.turn = null;
      if (t) t.done(code === 0 ? 'exited' : code ?? 'exited'); // died mid-turn: retried like any failed run
    });
    sessions.set(name, x);
    return x;
  }
  function endSession(name) {
    const x = sessions.get(name);
    if (!x) return;
    sessions.delete(name);
    x.closed = true;
    try { x.child.stdin.end(); } catch { /* gone */ }
    setTimeout(() => { if (x.child.exitCode == null) killTree(x.child); }, 5000).unref?.();
  }

  function start(name, def, s) {
    // A sandbox board (intellagent sandbox) never runs anything: its agents stay queued, so an agent testing
    // a board can't set off runs of its own (which could start sandboxes of their own).
    if (deps.noRuns) return setStatus(name, 'paused', { reason: 'sandbox board: standing agents never run here' });
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
    // Every run starts by reading its brief, which lists its own pending work: count that as seen so an
    // assignment doesn't wake it twice (once for the event, once as pending work). Unassigned tickets
    // (pickup) aren't in the brief: they count as seen only once a work.pending event has carried them.
    try {
      const own = (deps.pending?.(name, def) || []).filter((w) => w.action !== 'triage' && w.action !== 'pickup').map((w) => w.key);
      s.seenWork = [...new Set([...(s.seenWork || []), ...own])];
    } catch { /* best effort */ }
    const startedAt = new Date().toISOString();
    s.runs.push(startedAt);
    const dir = path.join(logDir, name.replace(/[^\w.-]+/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    const stamp = startedAt.replace(/[:.]/g, '-');
    const evFile = path.join(dir, `${stamp}.events.json`);
    const logFile = path.join(dir, `${stamp}.log`);
    fs.writeFileSync(evFile, JSON.stringify(events, null, 2));
    const out = fs.openSync(logFile, 'a');
    const live = def.keepAlive ? sessions.get(name) : null;
    // Its own worktree, caught up with main (a failure here fails the run: never fall back to the shared checkout)
    let workspace = null;
    if (def.worktree && deps.worktrees) {
      try { workspace = deps.worktrees.ensure(name); } catch (e) {
        fs.writeSync(out, `[worktree] ${e.message}\n`);
        fs.closeSync(out);
        return finish(name, def, { code: -1, error: `worktree: ${e.message}`, startedAt, logFile });
      }
    }
    const runCwd = workspace?.path || (def.cwd ? path.resolve(cwd, def.cwd) : cwd);
    const warm = !!live && !live.closed && live.turns > 0 && live.cmd === keepAliveCmd(def.run) && live.cwd === runCwd;
    const prompt = promptFor(name, events, { listen: [].concat(def.listen || 'inbox').includes('human') ? 'other' : 'inbox', evFile, interrupted, failures: s.failures, earlier, brief: def.brief, warm, workspace, speciality: warm ? '' : specialityText(def, readContext) });
    fs.writeSync(out, `$ ${[].concat(def.keepAlive ? def.run : withJsonOutput(def.run)).join(' ')}\n--- prompt ---\n${prompt}\n--- output ---\n`);

    const why = [...new Set(events.map((e) => e.type))].join(', ');
    // Where this run is expected to answer, so the UI can show a "thinking" bubble there: request threads
    // it was woken for, and tickets whose new comment woke it. Kept in lastRun after the run ends.
    const about = {
      requests: [...new Set(events.filter((e) => e.type.startsWith('request.') && e.request?.id).map((e) => e.request.id))],
      comments: [...new Set(events.filter((e) => e.type === 'comment.added' && e.itemId).map((e) => e.itemId))],
    };
    const items = [...new Set(events.flatMap((e) => e.itemId || (e.work || []).map((w) => w.id)).filter(Boolean))];
    const begin = (child) => {
      const timer = setTimeout(() => { running.get(name).timedOut = true; killTree(child); }, def.timeoutMinutes * 60_000);
      running.set(name, { child, timer, startedAt, logFile, keepAlive: !!def.keepAlive, items });
      setStatus(name, 'running', { lastRun: { startedAt, runId, events: events.length, why, about, items, log: logFile } });
      try { deps.onRunStart?.(name, events); } catch { /* best effort */ }
      emit({ type: 'agent.run.started', actor: { kind: 'system', name: 'intellagent' }, agent: name, why, events: events.map((e) => e.seq), items, ...(def.keepAlive ? { turn: true } : {}) });
      return timer;
    };
    const end = (code, turnUsage) => {
      const r = running.get(name);
      if (!r) return;
      clearTimeout(r.timer);
      running.delete(name);
      try { fs.closeSync(out); } catch { /* already closed */ }
      let usage = turnUsage || null;
      if (!def.keepAlive) try { usage = parseUsage(fs.readFileSync(logFile, 'utf8')); } catch { /* no log */ }
      finish(name, def, { code: r.stopped ? 'stopped' : r.timedOut ? 'timeout' : code, startedAt, logFile, usage });
    };
    if (def.keepAlive) {
      let x;
      try { x = session(name, def, runCwd); } catch (e) { fs.closeSync(out); return finish(name, def, { code: -1, error: e.message, startedAt, logFile }); }
      fs.writeFileSync(x.runFile, JSON.stringify({ run: runId, batch, events: evFile }));
      fs.writeSync(out, `[keep-alive session since ${x.startedAt}, turn ${x.turns + 1}]\n`);
      x.turn = { out, done: end };
      begin(x.child);
      x.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
      pruneLogs(dir);
      return;
    }
    let child;
    try {
      const cmd = [].concat(withJsonOutput(def.run));
      child = spawn(cmd[0], cmd.slice(1), {
        cwd: runCwd,
        shell: true, detached: process.platform !== 'win32', windowsHide: true,
        stdio: ['pipe', out, out],
        env: { ...process.env, ...deps.env, ...(def.env || {}), INTELLAGENT_AGENT: name, INTELLAGENT_EVENTS: evFile, INTELLAGENT_RUN: runId, INTELLAGENT_BATCH: batch,
          // an inherited run file (a board started from inside an agent session) would win over INTELLAGENT_RUN
          INTELLAGENT_RUN_FILE: '' },
      });
    } catch (e) {
      fs.closeSync(out);
      return finish(name, def, { code: -1, error: e.message, startedAt, logFile });
    }
    track(name, child);
    child.stdin.on('error', () => {}); // a command that ignores stdin closes it early
    child.stdin.end(prompt);
    begin(child);
    child.on('error', (e) => fs.writeSync(out, `\n[spawn error] ${e.message}\n`));
    child.on('close', (code) => end(code));
    pruneLogs(dir);
  }

  function finish(name, def, { code, error, startedAt, logFile, usage = null }) {
    const s = st(name);
    const ok = code === 0;
    const durationMs = Date.now() - Date.parse(startedAt);
    // why, about and items outlive the run: the UI says "ended without a reply" where it was expected to answer
    const same = s.lastRun?.startedAt === startedAt ? s.lastRun : null;
    s.lastRun = { ...(same ? { why: same.why, ...(same.about ? { about: same.about } : {}), ...(same.items ? { items: same.items } : {}) } : {}), startedAt, endedAt: new Date().toISOString(), code, durationMs, log: logFile, usage, ...(error ? { error } : {}) };
    // the last few runs, for the activity panel (not s.runs: that is the throttle's list of start times)
    s.history = [...(s.history || []), { startedAt, durationMs, code, why: same?.why ?? null, items: same?.items || [] }].slice(-HISTORY_KEPT);
    try { deps.onRunOver?.(name); } catch { /* best effort */ }
    if (usage) {
      // a per-day running total in the agent's state, so it survives a restart
      const day = dayOf();
      const t = s.usageToday?.day === day ? s.usageToday : (s.usageToday = { day, input: 0, output: 0, cacheRead: 0, cacheCreated: 0, runs: 0 });
      for (const k of ['input', 'output', 'cacheRead', 'cacheCreated']) t[k] += usage[k];
      t.runs++;
    }
    if (code === 'stopped') {
      // the human stopped it: keep its events for when it resumes, and don't count it as a failure
      requeueInflight(s);
      s.interrupted = true;
      emit({ type: 'agent.run.finished', actor: { kind: 'system', name: 'intellagent' }, agent: name, code, durationMs, failures: s.failures });
      endSession(name);
      setStatus(name, 'paused');
      return;
    }
    if (ok) {
      s.inflight = null;
      s.failures = 0;
      s.attempts = [];
      deps.onRunEnd?.(name); // a finished run holds nothing: free leases it forgot to release
    } else {
      // retry the same events, ahead of anything that arrived meanwhile
      requeueInflight(s);
      s.interrupted = true; // the retry must check for half-finished work, whatever stopped this run
      s.failures++;
    }
    emit({ type: 'agent.run.finished', actor: { kind: 'system', name: 'intellagent' }, agent: name, code, durationMs, failures: s.failures });
    // keep-alive: a fresh session after enough turns, after a failed turn (its memory may be the problem) or once paused
    const x = sessions.get(name);
    if (x && usage?.context != null) x.context = usage.context;
    if (x && (!ok || x.turns >= (Number(def.recycleAfterRuns) || DEFAULTS.recycleAfterRuns) || bloated(def, usage) || s.paused || !def.enabled || !def.keepAlive)) endSession(name);
    if (!ok && s.failures >= def.maxFailures) {
      setStatus(name, 'failed', { failedAt: new Date().toISOString() });
      emit({ type: 'agent.failed', actor: { kind: 'system', name: 'intellagent' }, agent: name, failures: s.failures, code, log: logFile });
      return;
    }
    setStatus(name, s.queue.length ? (ok ? 'queued' : 'retrying') : 'idle');
    if (ok && !s.queue.length) checkPending(name);
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

  // A running agent's last sign of life: its last call to the board (deps.lastSeen) or the last output in its
  // run log, whichever is later. One-shot runs print nothing until they end, so for them it is board calls only.
  function lastActivity(name, r) {
    let t = Date.parse(r.startedAt);
    try { t = Math.max(t, Date.parse(deps.lastSeen?.(name) || 0) || 0); } catch { /* none */ }
    try { t = Math.max(t, fs.statSync(r.logFile).mtimeMs); } catch { /* no log */ }
    return new Date(t).toISOString();
  }

  // Kill every run and session in flight (board stop).
  function killAll() {
    for (const { child } of running.values()) killTree(child);
    for (const n of [...sessions.keys()]) { const x = sessions.get(n); endSession(n); try { killTree(x.child); } catch { /* gone */ } }
  }

  const api = { isRunning: (name) => running.has(name) };

  return { api, start, endSession, lingering, lastActivity, killAll };
}

module.exports = { createRunner };
