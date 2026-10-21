'use strict';
// Running a standing agent: the one-shot process or the keep-alive session a run goes through, the processes it
// leaves behind, and what a run's end means (failure, retry, recycle). When to run is the scheduler's.
const fs = require('fs');
const { seenOnStart } = require('../alerts/seen');
// events that change nothing anyone acts on: they don't count as a run's writes (INT-389)
const HOUSEKEEPING = /^(agent.|presence.|reaction.|lease.(status|renewed)$|subscription.|memory.)/;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { killTree, lives } = require('./proc');
const { DEFAULTS, keepAliveCmd, withJsonOutput, isClaudeRun, withModel } = require('./config');
const { classify, modelFor } = require('./triage');
const { promptFor } = require('./prompt');
const skillsLib = require('./skills');
const { createStats, costOf, turnCost, addTools, newTools, resultOf, lastResult, escalates } = require('./stats');
const { usageOf, parseUsage, parseLimit, parseRate, dayOf } = require('./usage');
const { warmDecision, isAuto, ttlOf } = require('./warm');

const HISTORY_KEPT = 10;
const LOGS_KEPT = 20;
const LOG_MIN_AGE_MS = 24 * 60 * 60 * 1000; // a run's log lives at least a day, however many runs came after it
const LOGS_CAP = 2000; // and never more than this many per agent
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
  // one line per run in agent-stats.jsonl, in the data folder above the run logs (INT-310)
  const stats = createStats(deps.statsDir || path.dirname(logDir));

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
  // Stops what lingering() waits on. On Windows a killed run sometimes never reports its exit, and the next
  // run then waited for it forever (INT-379): the scheduler calls this once the wait has gone on too long.
  function endLingering(name) {
    const keep = sessions.get(name);
    const mine = [...(procs.get(name) || [])].filter((c) => !(keep && !keep.closed && keep.child === c) && c.exitCode == null && c.signalCode == null);
    for (const c of mine) { try { killTree(c); } catch { /* gone */ } procs.get(name)?.delete?.(c); }
    held.delete(name);
    return mine.length;
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
  // A changed skill list does the same: Claude reads skills when a session starts (INT-237).
  const skillsSig = (name) => skillsLib.signature(core.config.api.resolveSkills(name));
  const reusable = (x, def, runCwd, token) => !!x && !x.closed && x.cmd === keepAliveCmd(def.run) && x.cwd === runCwd && x.token === token && x.skills === skillsSig(def.name);

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
    x = { child, cmd, cwd: runCwd, token: id.INTELLAGENT_TOKEN, skills: skillsSig(name), runFile, turns: 0, startedAt: new Date().toISOString(), turn: null, closed: false, buf: '', costTotal: null, acc: newTools() };
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
        if (x.turn) addTools(x.acc, m);
        if (m.type !== 'result' || !x.turn) continue;
        const t = x.turn;
        x.turn = null;
        x.turns++;
        // total_cost_usd is the session's running total: a turn costs the difference from the one before
        const total = costOf(m);
        const extra = { cost: turnCost(x.costTotal, total), ...x.acc };
        if (total != null) x.costTotal = total;
        x.acc = newTools();
        t.done(m.is_error ? 1 : 0, usageOf(m), extra);
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
    clearTimeout(x.idleTimer);
    try { x.child.stdin.end(); } catch { /* gone */ }
    setTimeout(() => { if (x.child.exitCode == null) killTree(x.child); }, 5000).unref?.();
  }

  function start(name, def, s) {
    // A sandbox board (intellagent sandbox) never runs anything: its agents stay queued, so an agent testing
    // a board can't set off runs of its own (which could start sandboxes of their own).
    if (deps.noRuns) return setStatus(name, 'paused', { reason: 'sandbox board: standing agents never run here' });
    const events = s.queue.splice(0, s.queue.length);
    // what concerned it since its last run, kept as context (INT-390), comes along
    if (s.context?.length) { events.push(...s.context.filter((c) => !events.some((x) => x.seq === c.seq && x.type === c.type))); s.context = []; }
    const interrupted = !!s.interrupted;
    // Same events → same batch id across retries: the CLI derives Idempotency-Keys from it, so a retried
    // run that repeats an identical write gets the first reply instead of doing it twice.
    const batch = crypto.createHash('sha1').update(events.map((e) => e.seq).join(',')).digest('hex').slice(0, 16);
    const runId = `run_${crypto.randomBytes(5).toString('hex')}`;
    const earlier = (s.attempts || []).length ? deps.recent().filter((e) => e.actor?.run && s.attempts.includes(e.actor.run)) : [];
    s.attempts = [...(s.attempts || []), runId].slice(-5);
    s.inflight = events;
    s.interrupted = false;
    // what of its pending work counts as seen now: lib/alerts/seen.js
    try {
      const own = seenOnStart(events, deps.pending?.(name, def) || []);
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
  function launch(name, realDef, s, run, workspace) {
    // (INT-308) the model follows the run: a wake that can't need building runs on the agent's triage model, as a
    // process of its own beside its warm keep-alive session. The same events a triage run sent back for building
    // (escalatedBatch) run on the build model, so a retry can't escalate twice.
    const kind = realDef.runModels ? (s.escalatedBatch === run.batch ? 'build' : classify(run.events)) : null;
    const model = kind ? modelFor(realDef, kind) : realDef.model;
    const swapped = !!kind && model !== realDef.model;
    const def = swapped ? { ...realDef, model, run: withModel(realDef.runBase ?? realDef.run, model), ...(kind === 'triage' ? { keepAlive: false } : {}) } : realDef;
    delete s.escalate;
    const { events, interrupted, earlier, batch, runId, startedAt, dir, evFile, logFile, out } = run;
    const live = def.keepAlive ? sessions.get(name) : null;
    const runCwd = workspace?.path || (def.cwd ? path.resolve(cwd, def.cwd) : cwd);
    // The agent's skills go into its own worktree only (never the shared checkout, where every agent would see
    // them); an agent without a worktree has them listed in its prompt, with the path.
    if (workspace?.path) for (const p of skillsLib.deliver(workspace.path, core.config.api.resolveSkills(name))) fs.writeSync(out, `[skills] ${p}\n`);
    const warm = !!live && live.turns > 0 && reusable(live, def, runCwd, idEnv(name, def).INTELLAGENT_TOKEN);
    // the same inputs the preview (config previewOf) builds from, so it shows what a run is given
    const prompt = promptFor(name, events, { ...core.config.promptOpts(def), evFile, interrupted, failures: s.failures, earlier, warm, workspace, triage: swapped && kind === 'triage' });
    fs.writeSync(out, `$ ${[].concat(def.keepAlive ? def.run : withJsonOutput(def.run)).join(' ')}\n--- prompt ---\n${prompt}\n--- output ---\n`);

    const why = [...new Set(events.map((e) => e.type))].join(', ');
    // what woke it, for the metrics (INT-389): the work a work.pending event offered, by action, else the event types
    const reasons = [...new Set(events.flatMap((e) => (e.type === 'work.pending' ? (e.work || []).map((w) => w.action) : [e.type])))];
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
      setStatus(name, 'running', { lastRun: { startedAt, runId, events: events.length, why, reasons, about, items, log: logFile, ...(kind ? { kind, model: def.model ?? null } : {}) } });
      try { deps.onRunStart?.(name, events); } catch { /* best effort */ }
      emit({ type: 'agent.run.started', actor: { kind: 'system', name: 'intellagent' }, agent: name, why, events: events.map((e) => e.seq), items, ...(def.keepAlive ? { turn: true } : {}) });
      return timer;
    };
    let turnOf = null; // the keep-alive session this run is a turn of (INT-404)
    const end = (code, turnUsage, extra) => {
      const r = running.get(name);
      if (!r) return;
      clearTimeout(r.timer);
      running.delete(name);
      try { fs.closeSync(out); } catch { /* already closed */ }
      let usage = turnUsage || null;
      let more = extra || null;
      let escalate = null;
      if (!def.keepAlive) try {
        const text = fs.readFileSync(logFile, 'utf8');
        usage = parseUsage(text);
        const m = lastResult(text);
        more = { cost: costOf(m), tools: null, commands: null }; // a one-shot json run lists no tool calls
        if (swapped && kind === 'triage' && escalates(m)) escalate = batch;
      } catch { /* no log */ }
      finish(name, realDef, { code: r.stopped ? 'stopped' : r.timedOut ? 'timeout' : code, startedAt, logFile, usage, more, items, kind, model: def.model ?? null, escalate, turnOf });
    };
    if (def.keepAlive) {
      let x;
      try { x = session(name, def, runCwd); } catch (e) { fs.closeSync(out); return finish(name, realDef, { code: -1, error: e.message, startedAt, logFile }); }
      fs.writeFileSync(x.runFile, JSON.stringify({ run: runId, batch, events: evFile }));
      fs.writeSync(out, `[keep-alive session since ${x.startedAt}, turn ${x.turns + 1}]\n`);
      clearTimeout(x.idleTimer); // a turn came within the cache's lifetime
      turnOf = { x, turn: x.turns + 1, warm };
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
      return finish(name, realDef, { code: -1, error: e.message, startedAt, logFile });
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

  // kind and model: what the run was given (INT-308); escalate: the batch a triage run sent back for building
  function finish(name, def, { code, error, startedAt, logFile, usage = null, more = null, items = null, kind = null, model = undefined, escalate = null, turnOf = null }) {
    const s = st(name);
    const ok = code === 0;
    const durationMs = Date.now() - Date.parse(startedAt);
    // why, about and items outlive the run: the UI says "ended without a reply" where it was expected to answer
    const same = s.lastRun?.startedAt === startedAt ? s.lastRun : null;
    // why a failed run failed, on the card from the first failure (INT-346): the thrown error, else the log's telling line
    const reason = ok || code === 'stopped' ? null : error || failReason(logFile);
    s.lastRun = { ...(same ? { why: same.why, ...(same.reasons ? { reasons: same.reasons } : {}), ...(same.about ? { about: same.about } : {}), ...(same.items ? { items: same.items } : {}) } : {}), startedAt, endedAt: new Date().toISOString(), code, durationMs, log: logFile, usage, ...(kind ? { kind, model } : {}), ...(reason ? { error: reason } : {}) };
    // the last few runs, for the activity panel (not s.runs: that is the throttle's list of start times)
    s.history = [...(s.history || []), { startedAt, durationMs, code, why: same?.why ?? null, items: same?.items || [], ...(kind ? { kind, model } : {}) }].slice(-HISTORY_KEPT);
    try { deps.onRunOver?.(name); } catch { /* best effort */ }
    if (usage) {
      // a per-day running total in the agent's state, so it survives a restart
      const day = dayOf();
      const t = s.usageToday?.day === day ? s.usageToday : (s.usageToday = { day, input: 0, output: 0, cacheRead: 0, cacheCreated: 0, runs: 0 });
      for (const k of ['input', 'output', 'cacheRead', 'cacheCreated']) t[k] += usage[k];
      t.runs++;
      // and per model, so the Agents page can show what the cheap runs and the building runs each cost (INT-308)
      const m = ((t.byModel ||= {})[model || 'default'] ||= { input: 0, output: 0, cacheRead: 0, cacheCreated: 0, runs: 0 });
      for (const k of ['input', 'output', 'cacheRead', 'cacheCreated']) m[k] += usage[k];
      m.runs++;
    }
    // how much of the account's windows is spent, for the meter and the hold-back of optional work (INT-296)
    let rate = null;
    if (logFile) try { rate = parseRate(fs.readFileSync(logFile, 'utf8')); } catch { /* no log */ }
    if (rate) noteRate(name, rate);
    let limited = null;
    if (!ok && code !== 'stopped') try { limited = parseLimit(fs.readFileSync(logFile, 'utf8')); } catch { /* no log */ }
    // what the run changed on the board: events it caused (tagged with its run id), housekeeping aside (INT-389)
    const writes = same?.runId ? (deps.recent?.() || []).filter((e) => e.actor?.run === same.runId && !HOUSEKEEPING.test(e.type)).length : null;
    recordRun(name, def, { code, startedAt, usage, more, items: items || same?.items || [], why: same?.why ?? null, reasons: same?.reasons ?? null, writes, limited: !!limited, kind, model, session: turnOf ? { turn: turnOf.turn, warm: turnOf.warm } : null });
    if (code === 'stopped') {
      // the human stopped it: keep its events for when it resumes, and don't count it as a failure
      requeueInflight(s);
      s.interrupted = true;
      emit({ type: 'agent.run.finished', actor: { kind: 'system', name: 'intellagent' }, agent: name, code, durationMs, failures: s.failures });
      endSession(name);
      // Resume all can arrive before the killed process exits: then it is not paused any more and must run again (INT-416)
      if (s.paused || !defs[name]?.enabled) setStatus(name, 'paused');
      else { setStatus(name, s.queue.length ? 'queued' : 'idle'); if (s.queue.length) schedule(name, 0); }
      return;
    }
    // Refused for the usage limit (INT-293): the run did nothing and the agent isn't broken, so it is no failure.
    // Its events go back in the queue and every agent on the same account waits for the reset.
    if (limited) {
      delete s.lastRun.error; // waiting for the reset is no failure: the card must not say why it "failed"
      requeueInflight(s);
      emit({ type: 'agent.run.finished', actor: { kind: 'system', name: 'intellagent' }, agent: name, code, durationMs, failures: s.failures, limitedUntil: new Date(limited).toISOString() });
      endSession(name);
      holdForLimit(name, limited);
      return;
    }
    if (ok && escalate && s.escalatedBatch !== escalate) {
      // (INT-308) a triage run found it must build: the same events run again on the build model, once, without
      // the throttle. escalatedBatch makes that run build whatever it says, so it can never loop.
      requeueInflight(s);
      s.escalatedBatch = escalate;
      s.escalate = true;
      s.failures = 0;
      s.attempts = [];
      deps.onRunEnd?.(name);
    } else if (ok) {
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
    // keep-alive (lib/agents/warm.js): after a turn of its session, whether the session stays warm. Only that session's
    // own turn decides: a triage run beside it (INT-308) is a process of its own and leaves it alone.
    const x = sessions.get(name);
    if (x && turnOf?.x === x) {
      if (usage?.context != null) { x.context = usage.context; x.floor ??= usage.context; } // its first turn: a fresh start's size
      const d = warmDecision(def, DEFAULTS, { turns: x.turns, context: x.context, floor: x.floor, runs: s.runs }, { ok, paused: s.paused, nowMs: Date.now() });
      x.warm = { ...d, at: new Date().toISOString() };
      if (!d.keep) { s.lastWarm = x.warm; endSession(name); } else if (isAuto(def)) {
        // the cache lapses after its lifetime: a session still idle then would cost more to wake than a fresh start
        const ttl = ttlOf(def, DEFAULTS);
        x.idleTimer = setTimeout(() => {
          if (sessions.get(name) !== x || x.turn) return;
          s.lastWarm = { keep: false, why: `idle for the cache's ${Math.round(ttl / 60_000)} min: the next wake starts fresh`, at: new Date().toISOString() };
          endSession(name);
          save();
        }, ttl);
        x.idleTimer.unref?.();
      }
    } else if (x && (s.paused || !def.enabled || !def.keepAlive)) endSession(name);
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

  // The run's line in agent-stats.jsonl. Cost stays null when the run printed no result (timeout, stopped, crash).
  function recordRun(name, def, { code, startedAt, usage, more, items, why, reasons = null, writes = null, limited, kind = null, model, session = null }) {
    stats.append({
      agent: name, model: (model === undefined ? def.model : model) ?? null, ...(kind ? { kind } : {}), provider: def.provider ?? (isClaudeRun(def.run) ? 'anthropic' : null),
      startedAt, endedAt: new Date().toISOString(), why, items, ...(reasons ? { reasons } : {}), ...(writes != null ? { writes } : {}),
      code, result: resultOf(code, limited), ...(session ? { session } : {}),
      tokens: usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheCreated } : null,
      cost: more?.cost ?? null, tools: more?.tools ?? null, commands: more?.commands ?? null,
    });
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

  // The first-turn prompt the board would send now, before any event (ensure() is not called: it would reset the worktree)
  const preview = (name) => {
    const def = defs[name];
    const wt = def.worktree && deps.worktrees?.isRepo() ? { ...deps.worktrees.where(name), main: deps.worktrees.mainBranch() } : null;
    return core.config.api.previewOf(name, { workspace: wt, evFile: '<the events file of the run>' }).text;
  };
  const api = { isRunning: (name) => running.has(name), preview };

  return { api, start, endSession, lingering, endLingering, lastActivity, killAll };
}

// A log goes only when it is beyond the newest LOGS_KEPT *and* older than LOG_MIN_AGE_MS (INT-343): an agent that runs
// every few seconds would otherwise lose a run's log within minutes. LOGS_CAP bounds the disk either way.
// Names are the start time (2026-10-17T17-34-39-220Z), so the sort is by age.
function pruneLogs(dir, nowMs = Date.now()) {
  try {
    const logs = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
    const ageOf = (f) => { const m = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d+)Z/.exec(f); return m ? nowMs - Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : Infinity; };
    const drop = logs.slice(0, Math.max(0, logs.length - LOGS_KEPT)).filter((f, i) => ageOf(f) > LOG_MIN_AGE_MS || logs.length - i > LOGS_CAP);
    for (const f of drop) {
      fs.rmSync(path.join(dir, f), { force: true });
      fs.rmSync(path.join(dir, f.replace(/\.log$/, '.events.json')), { force: true });
    }
  } catch { /* ignore */ }
}

module.exports = { createRunner, childEnv, pruneLogs, HOUSEKEEPING };
