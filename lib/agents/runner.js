'use strict';
// Running a standing agent: the one-shot process or the keep-alive session a run goes through, the processes it
// leaves behind, and what a run's end means (failure, retry, recycle). When to run is the scheduler's.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { killTree, lives } = require('./proc');
const { DEFAULTS, keepAliveCmd, withJsonOutput, isClaudeRun } = require('./config');
const { promptFor } = require('./prompt');
const { usageOf, bloated, parseUsage, parseLimit, parseRate, dayOf } = require('./usage');

const HISTORY_KEPT = 10;
const LOGS_KEPT = 20;
// What a shell needs to start at all; never dropped by inheritEnv (none of them is a secret)
const ENV_ALWAYS = ['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'];
const foldEnv = process.platform === 'win32' ? (k) => k.toUpperCase() : (k) => k; // Windows names ignore case

// The environment a run's process gets: what it inherits from the board's process, the board's variables,
// the agent's env, where null removes one, then the run's own. Later layers win. A claude run inherits
// everything unless inheritEnv narrows it; any other command (an adapter holding nobody's keys but the
// ones it is given) inherits only ENV_ALWAYS and what its inheritEnv lists (INT-260).
function childEnv(def, boardEnv, own) {
  const names = Array.isArray(def.inheritEnv) ? def.inheritEnv : isClaudeRun(def.run) ? null : [];
  const keep = names ? new Set([...ENV_ALWAYS, ...names].map(foldEnv)) : null;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!keep || keep.has(foldEnv(k))) env[k] = v;
  for (const layer of [boardEnv, def.env, own]) {
    for (const [k, v] of Object.entries(layer || {})) {
      for (const e of Object.keys(env)) if (foldEnv(e) === foldEnv(k)) delete env[e];
      if (v != null) env[k] = String(v);
    }
  }
  return env;
}
// Which model to call and whose: claude gets --model from withModel, any other command reads these
const modelEnv = (def) => ({ INTELLAGENT_MODEL: def.model ?? null, INTELLAGENT_PROVIDER: def.provider ?? null });

/**
 * core: the pieces every part of createAgents shares (see agents.js).
 */
function createRunner(core) {
  const { deps, defs, st, save, requeueInflight, running, sessions, procs, held } = core;
  const { logDir, cwd, emit } = deps;
  const schedule = (...a) => core.scheduler.schedule(...a);
  const setStatus = (...a) => core.scheduler.setStatus(...a);
  const checkPending = (...a) => core.scheduler.checkPending(...a);
  const holdForLimit = (...a) => core.scheduler.holdForLimit(...a);
  const noteRate = (...a) => core.scheduler.noteRate(...a);

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
    core.guard?.add(child);
    child.on('exit', () => {
      core.guard?.remove(child);
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

  // Who the run is, in its environment. INTELLAGENT_TOKEN is the agent's own token (deps.tokenOf, from
  // local.json or the manifest), so a run that can't read local.json (a custom run under another OS user or
  // in a container, INT-248) still calls the board as itself. Never anyone else's: a token inherited from the
  // board's own environment is cleared, and the human's token is never handed out. A token the human put in
  // the agent's env in agents.json is kept only when the board has none for it.
  function idEnv(name, def) {
    let token = '';
    try { token = deps.tokenOf?.(name) || ''; } catch { /* no token */ }
    return { INTELLAGENT_AGENT: name, INTELLAGENT_TOKEN: token || def.env?.INTELLAGENT_TOKEN || '' };
  }

  // Can this live session take the next turn? One rule for both session() and the prompt (warm or full), so
  // they never disagree. A rotated token means a new session: the old one's env would send the old token (it
  // wins over local.json).
  const reusable = (x, def, runCwd, token) => !!x && !x.closed && x.cmd === keepAliveCmd(def.run) && x.cwd === runCwd && x.token === token;

  // Keep-alive: one process per agent, fed one turn at a time.
  function session(name, def, runCwd) {
    const cmd = keepAliveCmd(def.run);
    const id = idEnv(name, def);
    let x = sessions.get(name);
    if (reusable(x, def, runCwd, id.INTELLAGENT_TOKEN)) return x;
    // a session for another command or folder: the old one is idle (no turn runs while dispatch could start
    // this one), so stop it outright rather than letting it finish up beside the new one
    if (x) { endSession(name); if (x.child.exitCode == null) killTree(x.child); }
    const runFile = path.join(logDir, name.replace(/[^\w.-]+/g, '_'), 'current-run.json');
    fs.mkdirSync(path.dirname(runFile), { recursive: true });
    const child = spawn(core.guard ? core.guard.wrap(cmd) : cmd, [], {
      cwd: runCwd,
      shell: true, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv(def, deps.env, { ...id, ...modelEnv(def), INTELLAGENT_RUN_FILE: runFile }),
    });
    track(name, child);
    x = { child, cmd, cwd: runCwd, token: id.INTELLAGENT_TOKEN, runFile, turns: 0, startedAt: new Date().toISOString(), turn: null, closed: false, buf: '' };
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
    // Nor is a builder's queue (start): a run woken for a comment answers it and ends, so counting the queue
    // as seen here stranded it for good. It counts once a work.pending event has offered it.
    try {
      const own = (deps.pending?.(name, def) || []).filter((w) => w.action !== 'triage' && w.action !== 'pickup' && w.action !== 'start').map((w) => w.key);
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
    const run = { events, interrupted, earlier, batch, runId, startedAt, dir, evFile, logFile, out };
    if (!(def.worktree && deps.worktrees)) return launch(name, def, s, run, null);
    // Its own worktree, caught up with main (a failure here fails the run: never fall back to the shared checkout).
    // The catch-up runs git async, so the board keeps serving meanwhile. Until it is done the agent holds a
    // "starting" slot in running: every running.has() check (dispatch, run now, the sweeps, pause) sees it as
    // busy, so no second run starts into the same worktree (INT-196, INT-212). Stop all marks the slot stopped.
    const slot = { starting: true, startedAt, logFile, items: [] };
    running.set(name, slot);
    const failed = (e) => {
      running.delete(name);
      try { fs.writeSync(out, `[worktree] ${e.message}\n`); fs.closeSync(out); } catch { /* already closed */ }
      finish(name, def, { code: slot.stopped ? 'stopped' : -1, error: `worktree: ${e.message}`, startedAt, logFile });
    };
    new Promise((resolve) => resolve(deps.worktrees.ensure(name))).then((workspace) => {
      running.delete(name);
      // stopped, paused, switched off or removed while git ran: no process; its events wait for the next run
      const now = defs[name];
      if (slot.stopped || !now || !now.enabled || s.paused) { fs.closeSync(out); return finish(name, now || def, { code: 'stopped', startedAt, logFile }); }
      try { launch(name, now, s, run, workspace); } catch (e) { if (!running.has(name)) failed(e); }
    }, failed);
  }

  // The rest of a run's start, once its folder is ready: the prompt, then the process (or the keep-alive turn).
  function launch(name, def, s, run, workspace) {
    const { events, interrupted, earlier, batch, runId, startedAt, dir, evFile, logFile, out } = run;
    const live = def.keepAlive ? sessions.get(name) : null;
    const runCwd = workspace?.path || (def.cwd ? path.resolve(cwd, def.cwd) : cwd);
    const warm = !!live && live.turns > 0 && reusable(live, def, runCwd, idEnv(name, def).INTELLAGENT_TOKEN);
    // the same inputs the preview (config previewOf) builds from, so it shows what a run is given
    const prompt = promptFor(name, events, { ...core.config.promptOpts(def), evFile, interrupted, failures: s.failures, earlier, warm, workspace });
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
      child = spawn(core.guard ? core.guard.wrap(cmd[0]) : cmd[0], cmd.slice(1), {
        cwd: runCwd,
        shell: true, detached: process.platform !== 'win32', windowsHide: true,
        stdio: ['pipe', out, out],
        env: childEnv(def, deps.env, { ...idEnv(name, def), ...modelEnv(def), INTELLAGENT_EVENTS: evFile, INTELLAGENT_RUN: runId, INTELLAGENT_BATCH: batch,
          // an inherited run file (a board started from inside an agent session) would win over INTELLAGENT_RUN
          INTELLAGENT_RUN_FILE: '' }),
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

  // The line of a failed run's log that says why: the last one naming an error, else the last one; 200 characters at most.
  // Only the run's output counts (never the prompt above it, which quotes tickets), and JSON lines are skipped: a
  // result line gives its own text, a tool_result line is a tool's output, not the reason.
  function failReason(logFile) {
    let text;
    try { text = fs.readFileSync(logFile, 'utf8'); } catch { return null; }
    const at = text.lastIndexOf('--- output ---');
    if (at < 0) return null;
    const out = text.slice(at + '--- output ---'.length);
    let m = null;
    for (const l of out.split('\n').reverse()) {
      if (!l.trim().startsWith('{')) continue;
      try { const j = JSON.parse(l.trim()); if (j.type === 'result') { m = j; break; } } catch { /* not a result line */ }
    }
    const said = typeof m?.result === 'string' ? m.result.split(/\r?\n/).map((l) => l.trim()).find(Boolean) : null;
    if (said && m.is_error) return said.slice(0, 200);
    const lines = out.split(/\r?\n/).map((l) => l.replace(/^\[spawn error\]\s*/, '').trim()).filter((l) => l && !l.startsWith('{')).slice(-40);
    const line = [...lines].reverse().find((l) => /error|invalid|not found|denied|cannot|failed|refused/i.test(l)) || lines.at(-1);
    return line ? line.slice(0, 200) : null;
  }

  function finish(name, def, { code, error, startedAt, logFile, usage = null }) {
    const s = st(name);
    const ok = code === 0;
    const durationMs = Date.now() - Date.parse(startedAt);
    // why, about and items outlive the run: the UI says "ended without a reply" where it was expected to answer
    const same = s.lastRun?.startedAt === startedAt ? s.lastRun : null;
    // why a failed run failed, on the card from the first failure (INT-346): the thrown error, else the log's telling line
    const reason = ok || code === 'stopped' ? null : error || failReason(logFile);
    s.lastRun = { ...(same ? { why: same.why, ...(same.about ? { about: same.about } : {}), ...(same.items ? { items: same.items } : {}) } : {}), startedAt, endedAt: new Date().toISOString(), code, durationMs, log: logFile, usage, ...(reason ? { error: reason } : {}) };
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
    // how much of the account's windows is spent, for the meter and the hold-back of optional work (INT-296)
    let rate = null;
    if (logFile) try { rate = parseRate(fs.readFileSync(logFile, 'utf8')); } catch { /* no log */ }
    if (rate) noteRate(name, rate);
    if (code === 'stopped') {
      // the human stopped it: keep its events for when it resumes, and don't count it as a failure
      requeueInflight(s);
      s.interrupted = true;
      emit({ type: 'agent.run.finished', actor: { kind: 'system', name: 'intellagent' }, agent: name, code, durationMs, failures: s.failures });
      endSession(name);
      setStatus(name, 'paused');
      return;
    }
    // Refused for the usage limit (INT-293): the run did nothing and the agent isn't broken, so it is no failure.
    // Its events go back in the queue and every agent on the same account waits for the reset.
    let limited = null;
    if (!ok) try { limited = parseLimit(fs.readFileSync(logFile, 'utf8')); } catch { /* no log */ }
    if (limited) {
      delete s.lastRun.error; // waiting for the reset is no failure: the card must not say why it "failed"
      requeueInflight(s);
      emit({ type: 'agent.run.finished', actor: { kind: 'system', name: 'intellagent' }, agent: name, code, durationMs, failures: s.failures, limitedUntil: new Date(limited).toISOString() });
      endSession(name);
      holdForLimit(name, limited);
      return;
    }
    if (ok) {
      s.inflight = null;
      s.failures = 0;
      s.attempts = [];
      delete s.probing; // the probe worked (INT-295): the streak is over
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
      // INT-295: a passing cause (a network blip, a git lock, the machine asleep) shouldn't need the human, so a
      // failed agent gets ONE probe run after failedRetryMinutes. A failed probe is final until the human resumes.
      const coolMs = (Number(def.failedRetryMinutes ?? DEFAULTS.failedRetryMinutes) || 0) * 60_000;
      const probeAt = !s.probing && coolMs > 0 ? new Date(Date.now() + coolMs).toISOString() : null;
      delete s.probing;
      if (probeAt) s.probeAt = probeAt; else delete s.probeAt;
      setStatus(name, 'failed', { failedAt: new Date().toISOString() });
      emit({ type: 'agent.failed', actor: { kind: 'system', name: 'intellagent' }, agent: name, failures: s.failures, code, log: logFile, probeAt });
      if (probeAt) schedule(name, coolMs + 50);
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
    // a run still catching up its worktree has no process yet: marked stopped, it never starts one
    for (const r of running.values()) { if (r.starting) r.stopped = true; else killTree(r.child); }
    for (const n of [...sessions.keys()]) { const x = sessions.get(n); endSession(n); try { killTree(x.child); } catch { /* gone */ } }
  }

  const api = { isRunning: (name) => running.has(name) };

  return { api, start, endSession, lingering, lastActivity, killAll };
}

module.exports = { createRunner, childEnv };
