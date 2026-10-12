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
  listen: 'addressed', // wake only when addressed: mentioned, assigned, handed a lease, answered, given a verdict
  maxRunsPerHour: 20,   // null = no limit
  maxFailures: 3,
  timeoutMinutes: 60,
  settleSeconds: 3,   // let a burst of edits land in one run
  throttleMinutes: 3, // after a run starts, further events wait and land together in one run when the window ends (0 = off)
  retrySeconds: 30,   // first retry delay after a failure; doubles each time (max 10 min)
  pickup: false,      // also wake for unassigned tickets: 'ready' (true) = in the pickup columns, 'all' = anywhere open
  sweepMinutes: 10,   // how often an idle agent checks the board for work already waiting for it (0 = only on start/resume/run end)
};

/* Roles: presets that give an agent a brief, wake-up settings and permissions, so nobody has to write
   --allowedTools by hand. Permissions come from a fixed set (PERMS); the run command is built from them.
   An explicit "run" in agents.json still wins (that file is the only place raw commands come from). */
const PERMS = {
  edit: { label: 'Edit files', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] },
  read: { label: 'Read files', tools: ['Read', 'Grep', 'Glob'] },
  test: { label: 'Run tests', tools: ['Bash(npm test)', 'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npx vitest:*)', 'Bash(npx jest:*)', 'Bash(pnpm test:*)', 'Bash(yarn test:*)', 'Bash(node --test:*)'] },
  build: { label: 'Build & lint', tools: ['Bash(npm run build:*)', 'Bash(npm run lint:*)', 'Bash(npx tsc:*)', 'Bash(npx eslint:*)'] },
  git: { label: 'Git (status, diff, commit)', tools: ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)'] },
  web: { label: 'Web research', tools: ['WebSearch', 'WebFetch'] },
};
const ROLES = {
  coordinator: {
    // Wakes on its inbox AND on every ticket the human creates, so new tickets get triaged and assigned.
    label: 'Coordinator', icon: 'send', listen: ['addressed', 'new-tickets'], pickup: 'all', perms: ['read'], throttleMinutes: 3,
    description: 'Turns requests into well-formed tickets (using the board\'s templates and fields), sets priorities and assigns work to the other agents.',
    brief: 'Your role: coordinator. You plan and route; you do not write code. When the human creates a ticket, triage it: fill fields and priority, add an acceptance checklist if missing, and assign it to the right agent (or ask on the card if unclear). Turn requests into clear tickets (prefer the board\'s ticket templates, fill fields, add acceptance checklists, link blockers), keep the board tidy, and hand work to the right agent by setting "assignee". Reply on every request with the ticket ids you created. A work.pending list of unassigned tickets is the untriaged work on the board: assign what clearly belongs to an agent, ask on the card when the owner or scope is unclear, and leave the rest alone without commenting (parked Backlog ideas are fine unassigned) — you will not be woken for them again until they change. A ticket with an agentDraft marker was filed as rough notes for you to write up: rewrite the title, description (with an acceptance checklist), type, priority, fields, parent and blockers, but never the keys listed in agentDraft.explicit (the board refuses those). Quote the original title and description in a comment, and send "agentDraft": null in the same PATCH as your rewrite.',
  },
  builder: {
    label: 'Builder', icon: 'pencil', listen: 'addressed', perms: ['edit', 'test', 'build', 'git'], throttleMinutes: 3,
    description: 'Implements tickets assigned to it: small, tested changes, then requests review with how to verify.',
    brief: 'Your role: builder. Implement the tickets assigned to you with small, tested changes. Start each with start_work, keep a live status, run the tests, then request review in four parts (changed / why / verify / risks). Ask on the card before anything the project marks as needing approval.',
  },
  reviewer: {
    label: 'Reviewer', icon: 'eye', listen: 'addressed', perms: ['read', 'test', 'git'], throttleMinutes: 5,
    description: 'Reviews work in Review: reads the change, runs the tests, and comments with findings before the human decides.',
    brief: 'Your role: reviewer. You do not change code. For tickets you are asked about, read the change (git diff), run the tests, and comment with concrete findings — what is right, what is risky, what to change. Never approve or move tickets; the human decides.',
  },
  researcher: {
    label: 'Researcher', icon: 'spike', listen: 'addressed', perms: ['read', 'web'], throttleMinutes: 5,
    description: 'Answers questions and spikes: investigates the code and the web, and writes findings with sources and a recommendation.',
    brief: 'Your role: researcher. Investigate spikes and questions — read the code, search the web — and write findings on the card with sources, the options you weighed and a recommendation. Do not change code.',
  },
  designer: {
    label: 'Designer', icon: 'sparkle', listen: 'addressed', perms: ['edit', 'test', 'git'], throttleMinutes: 5,
    description: 'Owns the look and feel: themes, CSS, layout and motion. Takes design tickets, makes careful token-based changes, and explains the choices.',
    brief: 'Your role: designer, with sign-off on visual design. Work from theme tokens (never hard-coded colours), keep motion calm (ease in/out, no bounce), make every change work in dark and light themes, and keep the code style of the surrounding CSS/JS. You cannot see the screen in a headless run: reason carefully about layout, prefer small reviewable changes, and in your review say exactly which themes and states a human should look at.',
  },
  writer: {
    label: 'Writer', icon: 'text', listen: 'addressed', perms: ['edit', 'git'], throttleMinutes: 5,
    description: 'Writes and updates documentation (README, docs/, changelogs) for the tickets assigned to it.',
    brief: 'Your role: writer. Keep documentation accurate: README, docs/ and changelogs. Only edit documentation files unless a ticket says otherwise, then request review.',
  },
};
const PROMPT_ARG = '"Handle the Intellagent events described on stdin."';
// The command a role (or a custom permission list) runs with.
function runFor(perms = []) {
  const tools = ['Bash(intellagent:*)', 'mcp__intellagent', ...new Set(perms.flatMap((k) => PERMS[k]?.tools || []))];
  const edits = perms.includes('edit');
  return `claude -p ${PROMPT_ARG}${edits ? ' --permission-mode acceptEdits' : ''} --allowedTools ${tools.map((t) => `"${t}"`).join(' ')}`;
}

const QUEUE_MAX = 200;
const LOGS_KEPT = 20;

const eventLine = (e) => e.type === 'work.pending'
  ? ['work.pending — work waiting for you on the board:',
    ...e.work.map((w) => `    · ${w.action} ${w.id || w.requestId}${w.title ? ` "${w.title}"` : ''} — ${w.why}`)].join('\n')
  : e.type === 'request.created'
  ? `#${e.seq} REQUEST ${e.request.id} from ${e.actor?.name || '?'}: ${e.request.body}${e.request.attachments?.length ? ` [attached files — open them: ${e.request.attachments.map((a) => a.path || a.url).join(', ')}]` : ''}  → do it, then reply: intellagent api POST /api/boards/${e.board}/requests/${e.request.id}/reply body="what you did (ticket ids)" done=true`
  : `#${e.seq} ${e.type}${e.intent === 'explain' ? ' [EXPLAIN ONLY]' : ''}${e.draft ? ' [WRITE THIS TICKET — see the write action in your brief]' : ''}${e.itemId ? ` ${e.itemId}` : ''}${e.item?.title ? ` "${e.item.title}"` : ''} by ${e.actor?.name || '?'}${e.reply ? ` — reply: ${e.reply}` : e.comment?.body ? ` — ${e.comment.body}` : e.reason ? ` — ${e.reason}` : ''}`;

function promptFor(name, events, { listen, evFile, interrupted, failures, earlier = [], brief = '' }) {
  return [
    ...(brief ? [brief, ''] : []),
    listen === 'inbox'
      ? `You are "${name}", working on this project's Intellagent board. These events are for you:`
      : `You are "${name}", coordinating this project's Intellagent board. New activity:`,
    ...events.map((e) => `- ${eventLine(e)}`),
    '',
    ...(interrupted ? ['Your previous run on these events did not finish (error, timeout or restart). It may have done part of the work: check the cards (comments, status, column) and the working tree before redoing anything.', ''] : []),
    ...(events.some((e) => e.intent === 'explain') ? ['Events marked [EXPLAIN ONLY] are questions about work already done: answer them in a comment on the card — your reasoning, what you considered, the trade-offs — and change nothing else (no code, no ticket fields, no column, no review).', ''] : []),
    ...(earlier.length ? ['What the earlier attempt already did on the board (do not repeat it):', ...earlier.slice(-30).map((e) => `- ${eventLine(e)}`), ''] : []),
    ...(failures ? [`Attempt ${failures + 1}: the previous run exited with an error.`, ''] : []),
    'Start with: intellagent brief   (your situation, the board\'s rules and the exact next calls). Then act on it following the board\'s standing rules and the project\'s CLAUDE.md, and reply on the card.',
    'Finish with: intellagent api POST /api/boards/<board>/finish summary="…" — it releases anything you still hold.',
    'Anything worth remembering must go on the card — this run ends when you finish and nothing else is kept.',
    // Agents that once commented on a ticket hear about everything on it; most of that needs nothing from them.
    'If none of these events asks you to do or answer something, do nothing and end the run: no "noted"/"nothing to do" comments (your 👀 already says you saw it). Only post when you have work, an answer or a question.',
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
      const role = ROLES[d.role] || null;
      const perms = Array.isArray(d.perms) ? d.perms : role?.perms;
      defs[name] = {
        ...defaults, ...(role ? { listen: role.listen, throttleMinutes: role.throttleMinutes, description: role.description, ...(role.pickup ? { pickup: role.pickup } : {}) } : {}), ...d,
        name, enabled: d.enabled !== false,
        // no explicit run: build it from the role's (or listed) permissions
        run: d.run || (perms ? runFor(perms) : defaults.run), perms: perms || null, brief: role?.brief || '',
      };
      st(name);
    }
  }

  // What an agent wakes on — one source or a list of them, never its own actions:
  // 'addressed' (default: mentioned, assigned, handed a lease, answered, given a verdict), 'inbox' (also
  // everything on tickets it worked on or commented on), 'human' (everything the human does), 'new-tickets' (tickets the human
  // creates), or an event filter object.
  function filtersFor(def) {
    const one = (l) => (l === 'addressed' ? { addressed: def.name }
      : l === 'human' ? { actorKind: 'user' }
      : l === 'new-tickets' ? { types: 'item.created', actorKind: 'user' }
        : l && typeof l === 'object' ? l : { for: def.name });
    return [].concat(def.listen || 'inbox').map((l) => parseFilter({ ...one(l), excludeActor: def.name }));
  }
  const wakes = (def, e) => filtersFor(def).some((f) => matchesFilter(e, f));

  function enqueue(name, events) {
    const s = st(name);
    for (const e of events) if (!s.queue.some((q) => q.seq === e.seq && q.type === e.type)) s.queue.push(e);
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

  // Work already on the board (assigned and not started, answered questions, feedback, requests, and with
  // pickup unassigned tickets) wakes an idle agent with one synthetic work.pending event. Each piece of
  // work wakes it once: it is remembered until it leaves the pending list, so leaving it alone never loops.
  function checkPending(name) {
    const def = defs[name];
    const s = st(name);
    if (!def || !deps.pending || !def.enabled || s.paused || s.status === 'failed' || running.has(name)) return;
    let work;
    try { work = deps.pending(name, def); } catch { return; }
    const seen = new Set(s.seenWork || []);
    const fresh = work.filter((w) => !seen.has(w.key));
    s.seenWork = work.map((w) => w.key);
    if (!fresh.length) return save();
    s.queue = s.queue.filter((e) => e.type !== 'work.pending'); // one summary, never a pile of them
    s.queue.push({ seq: deps.seq(), type: 'work.pending', actor: { kind: 'system', name: 'intellagent' }, at: new Date().toISOString(), work: fresh.slice(0, 25) });
    save();
    schedule(name, def.settleSeconds * 1000);
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
    const prompt = promptFor(name, events, { listen: [].concat(def.listen || 'inbox').includes('human') ? 'other' : 'inbox', evFile, interrupted, failures: s.failures, earlier, brief: def.brief });
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
    const why = [...new Set(events.map((e) => e.type))].join(', ');
    setStatus(name, 'running', { lastRun: { startedAt, runId, events: events.length, why, log: logFile } });
    try { deps.onRunStart?.(name, events); } catch { /* best effort */ }
    emit({ type: 'agent.run.started', actor: { kind: 'system', name: 'intellagent' }, agent: name, events: events.map((e) => e.seq), items: [...new Set(events.flatMap((e) => e.itemId || (e.work || []).map((w) => w.id)).filter(Boolean))] });
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
    s.lastRun = { ...(s.lastRun?.startedAt === startedAt ? { why: s.lastRun.why } : {}), startedAt, endedAt: new Date().toISOString(), code, durationMs, log: logFile, ...(error ? { error } : {}) };
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

  // Called for every board event.
  function onEvent(e) {
    if (e.type.startsWith('agent.')) return;
    for (const def of Object.values(defs)) if (wakes(def, e)) enqueue(def.name, [e]);
  }

  // After a reboot or server restart: runs that were in flight are retried, and anything that
  // happened while the agent wasn't listening (e.g. it was just added) is caught up from its cursor.
  function recover() {
    for (const def of Object.values(defs)) {
      const s = st(def.name);
      if (s.inflight) { s.queue = [...s.inflight, ...s.queue]; s.inflight = null; s.interrupted = true; }
      if ((s.cursor || 0) > deps.seq()) s.cursor = deps.seq(); // the event log was reset
      const missed = deps.recent().filter((e) => e.seq > (s.cursor || 0) && !e.type.startsWith('agent.') && wakes(def, e));
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
      name, role: def.role || null, perms: def.perms, enabled: def.enabled && !s.paused, listen: def.listen, description: def.description || null,
      run: def.run, maxRunsPerHour: def.maxRunsPerHour, throttleMinutes: def.throttleMinutes, maxFailures: def.maxFailures, timeoutMinutes: def.timeoutMinutes,
      status: def.enabled && !s.paused ? s.status : 'paused', queued: s.queue.length, failures: s.failures,
      runsLastHour: s.runs.filter((t) => Date.parse(t) > Date.now() - 3600_000).length,
      pickup: def.pickup || false, lastRun: s.lastRun, runningSince: r?.startedAt || null, resumesAt: s.status === 'throttled' || s.status === 'waiting' ? s.resumesAt : undefined,
    };
  }

  function need(name) {
    const hit = Object.keys(defs).find((n) => n.toLowerCase() === String(name).toLowerCase());
    if (!hit) { const e = new Error(`No standing agent "${name}" in ${path.basename(file)}`); e.status = 404; throw e; }
    return hit;
  }

  load();
  recover();
  // Board start: catch up on work that piled up while nobody was listening. Deferred so the server can
  // finish loading boards first; then a slow sweep in case nothing else wakes an idle agent.
  const sweepAll = () => { for (const name of Object.keys(defs)) if (!st(name).queue.length) checkPending(name); };
  const firstSweep = setTimeout(sweepAll, 1500);
  const sweepTimer = setInterval(() => {
    for (const [name, def] of Object.entries(defs)) {
      const every = Number(def.sweepMinutes) || 0;
      const last = Date.parse(st(name).lastSweep || 0);
      if (!every || Date.now() - last < every * 60_000 - 1000) continue;
      st(name).lastSweep = new Date().toISOString();
      if (!st(name).queue.length) checkPending(name);
    }
  }, 30_000);
  firstSweep.unref?.(); sweepTimer.unref?.();
  fs.watchFile(file, { interval: 2000 }, () => {
    load();
    for (const name of Object.keys(defs)) dispatch(name);
    sweepAll();
    emit({ type: 'agents.changed', actor: { kind: 'system', name: 'intellagent' }, agents: Object.keys(defs), ...(loadError ? { error: loadError } : {}) });
  });

  return {
    file,
    onEvent,
    list: () => ({ file, error: loadError, agents: Object.keys(defs).map(view) }),
    // Define or replace a standing agent from a role and permission keys — never a raw command.
    define(name, d) {
      if (!/^[\w.-]{1,64}$/.test(String(name || ''))) { const e = new Error('Agent name: letters, digits, dot, dash or underscore (max 64)'); e.status = 400; throw e; }
      if (d.role && !ROLES[d.role]) { const e = new Error(`Unknown role "${d.role}". Roles: ${Object.keys(ROLES).join(', ')}`); e.status = 400; throw e; }
      const perms = d.perms == null ? undefined : [...new Set([].concat(d.perms))];
      const bad = (perms || []).filter((k) => !PERMS[k]);
      if (bad.length) { const e = new Error(`Unknown permission(s): ${bad.join(', ')}. Use: ${Object.keys(PERMS).join(', ')}`); e.status = 400; throw e; }
      let raw = { agents: {} };
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { /* new file */ }
      raw.agents ||= {};
      const prev = raw.agents[name] || {};
      const next = { ...prev };
      for (const k of ['role', 'description', 'listen']) if (d[k] != null && d[k] !== '') next[k] = String(d[k]).slice(0, 2000);
      if (perms) next.perms = perms;
      for (const k of ['throttleMinutes', 'maxRunsPerHour']) if (d[k] !== undefined) next[k] = d[k] === null ? null : Number(d[k]);
      if (d.pickup !== undefined) next.pickup = d.pickup === true || d.pickup === 'ready' ? 'ready' : d.pickup === 'all' ? 'all' : false;
      raw.agents[name] = next;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(raw, null, 2)}\n`);
      fs.renameSync(`${file}.tmp`, file);
      load();
      emit({ type: 'agents.changed', actor: { kind: 'system', name: 'intellagent' }, agents: Object.keys(defs) });
      return view(name);
    },
    remove(name) {
      name = need(name);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      delete raw.agents[name];
      fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(raw, null, 2)}\n`);
      fs.renameSync(`${file}.tmp`, file);
      load();
      emit({ type: 'agents.changed', actor: { kind: 'system', name: 'intellagent' }, agents: Object.keys(defs) });
      return { removed: name };
    },
    get: (name) => view(need(name)),
    isRunning: (name) => running.has(name),
    pickupOf: (name) => defs[name]?.pickup && defs[name].enabled ? (defs[name].pickup === true ? 'ready' : defs[name].pickup) : false,
    // Human controls. Commands only ever come from agents.json, never from the API.
    resume(name) {
      name = need(name);
      const s = st(name);
      s.failures = 0;
      setStatus(name, s.queue.length ? 'queued' : 'idle');
      dispatch(name);
      checkPending(name);
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
    stop() { clearTimeout(firstSweep); clearInterval(sweepTimer); for (const { child } of running.values()) killTree(child); fs.unwatchFile(file); },
  };
}

module.exports = { createAgents, eventLine, DEFAULTS, ROLES, PERMS, runFor };
