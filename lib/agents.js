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
const { spawn, execFile, execFileSync } = require('child_process');
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
  sweepMinutes: 10,       // how often an idle agent checks the board for work already waiting for it (0 = only on start/resume/run end)
  keepAlive: false,       // one long-lived claude session per agent; each wake is a new turn in it
  recycleAboveTokens: 120000, // ...or once its context per model call (input + cache read + cache created, averaged over a turn's calls) passes this; 0 = off
  stallMinutes: 10,       // a run with no board call and no output for this long shows as stalled (0 = never)
  recycleAfterRuns: 20,   // a keep-alive session is replaced after this many turns (context grows, memory goes stale)
};

/* Roles: presets that give an agent a brief, wake-up settings and permissions, so nobody has to write
   --allowedTools by hand. Permissions come from a fixed set (PERMS); the run command is built from them.
   An explicit "run" in agents.json still wins (that file is the only place raw commands come from). */
const PERMS = {
  edit: { label: 'Edit files', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] },
  read: { label: 'Read files', tools: ['Read', 'Grep', 'Glob'] },
  test: { label: 'Run tests', tools: ['Bash(npm test)', 'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npx vitest:*)', 'Bash(npx jest:*)', 'Bash(pnpm test:*)', 'Bash(yarn test:*)', 'Bash(node --test:*)'] },
  build: { label: 'Build & lint', tools: ['Bash(npm run build:*)', 'Bash(npm run lint:*)', 'Bash(npx tsc:*)', 'Bash(npx eslint:*)'] },
  // git merge main (and --abort) only: an agent catches its own branch up and resolves its own conflicts;
  // its worktree is its own branch, so this never touches main (landing stays with the human's approval).
  git: { label: 'Git (status, diff, commit, merge main)', tools: ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git merge main)', 'Bash(git merge --abort)'] },
  web: { label: 'Web research', tools: ['WebSearch', 'WebFetch'] },
};
const ROLES = {
  coordinator: {
    // Wakes on its inbox AND on every ticket the human creates, so new tickets get triaged and assigned.
    label: 'Coordinator', icon: 'send', listen: ['addressed', 'new-tickets'], pickup: 'all', supervise: true, perms: ['read'], throttleMinutes: 3,
    description: 'Turns requests into well-formed tickets (using the board\'s templates and fields), sets priorities and assigns work to the other agents.',
    brief: 'Your role: coordinator. You plan and route; you do not write code. When the human creates a ticket, triage it: fill fields and priority, add an acceptance checklist if missing, and assign it to the right agent (or ask on the card if unclear). Turn requests into clear tickets (prefer the board\'s ticket templates, fill fields, add acceptance checklists, link blockers), keep the board tidy, and hand work to the right agent by setting "assignee". Reply on every request with the ticket ids you created. When a ticket reaches review and an agent marked as a reviewer covers its code or concerns, assign that agent as a reviewer (never the author); reviewers only comment, the human still approves. A work.pending list of unassigned tickets is the untriaged work on the board: assign what clearly belongs to an agent, ask on the card when the owner or scope is unclear, and leave the rest alone without commenting (parked Backlog ideas are fine unassigned) — you will not be woken for them again until they change. A ticket with an agentDraft marker was filed as rough notes for you to write up: rewrite the title, description (with an acceptance checklist), type, priority, fields, parent and blockers, but never the keys listed in agentDraft.explicit (the board refuses those). Quote the original title and description in a comment, and send "agentDraft": null in the same PATCH as your rewrite. A supervise item is a ticket another standing agent was given but is not working on: if that agent is paused or failed, resume it (POST /api/agents/<name>/resume, your agents.control grant); otherwise run it with a note (POST /api/agents/<name>/run note="…") or @mention it on the card with what it should do. Say on the card what you did. If two nudges get no answer, ask the human on the card or reassign the ticket.',
  },
  builder: {
    label: 'Builder', icon: 'pencil', listen: 'addressed', perms: ['edit', 'test', 'build', 'git'], throttleMinutes: 3,
    description: 'Implements tickets assigned to it: small, tested changes, then requests review with how to verify.',
    brief: 'Your role: builder. Implement the tickets assigned to you with small, tested changes. Start each with start_work, keep a live status, run the tests, then request review in four parts (changed / why / verify / risks). Ask on the card before anything the project marks as needing approval.',
  },
  reviewer: {
    label: 'Reviewer', icon: 'eye', listen: 'addressed', perms: ['read', 'test', 'git'], throttleMinutes: 5, reviewer: true,
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
// Model tiers: "model" (per agent or in defaults) reaches a claude run as --model. Runs go through a shell,
// so only plain model names pass. A run that already names a --model keeps it; non-claude runs are left alone.
const MODEL_RE = /^[\w.:-]{1,64}$/;
const TIERS = { haiku: 'junior', sonnet: 'mid', opus: 'senior' };
function withModel(run, model) {
  if (!model || Array.isArray(run) || /(^|\s)--model(\s|=)/.test(run) || !/^\s*claude(\.cmd|\.exe)?\s/.test(run)) return run;
  return MODEL_RE.test(model) ? `${run} --model ${model}` : run;
}
// One-shot claude runs print plain text, which carries no token counts. Asking for JSON output makes the
// run end with a single result object that does. Keep-alive sessions get stream-json from keepAliveCmd.
function withJsonOutput(run) {
  if (Array.isArray(run) || /(^|\s)--output-format(\s|=)/.test(run) || !/^\s*claude(\.cmd|\.exe)?\s/.test(run)) return run;
  return `${run} --output-format json`;
}
// Token usage from a claude "result" object: { input, output, cacheRead, cacheCreated }, or null when it
// reports none (callers show "n/a" rather than a made-up zero).
function usageOf(m) {
  const u = m && typeof m === 'object' ? m.usage : null;
  if (!u || typeof u !== 'object') return null;
  if (!Number.isFinite(u.input_tokens) && !Number.isFinite(u.output_tokens)) return null;
  const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  const out = { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheCreated: n(u.cache_creation_input_tokens) };
  // what the model read per call: a result's usage sums every call of the turn, num_turns says how many
  if (Number.isFinite(m.num_turns) && m.num_turns > 0) out.context = Math.round((out.input + out.cacheRead + out.cacheCreated) / m.num_turns);
  return out;
}
const recycleTokens = (def) => (def.recycleAboveTokens === 0 ? 0 : Number(def.recycleAboveTokens) || DEFAULTS.recycleAboveTokens);
const bloated = (def, usage) => { const t = recycleTokens(def); return !!t && !!usage?.context && usage.context > t; };
// Usage from the last result object in a one-shot run's log (everything after the prompt).
function parseUsage(text) {
  const out = String(text || '');
  const lines = out.slice(Math.max(0, out.lastIndexOf('--- output ---'))).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try { const m = JSON.parse(line); if (m.type === 'result' || m.usage) return usageOf(m); } catch { /* not a result line */ }
  }
  return null;
}
const dayOf = (d = new Date()) => d.toLocaleDateString('en-CA'); // local YYYY-MM-DD: "today" is the human's today

// The command a role (or a custom permission list) runs with. It loads only the built-in tools the perms
// can use (--tools; every definition loaded costs context on every call) and no MCP servers but the
// board's own (--strict-mcp-config; mcpConfig is the project's .mcp.json when it registers one).
const BASE_TOOLS = ['Bash', 'Read', 'Grep', 'Glob']; // Bash for the intellagent CLI; reading is always allowed
// commands: extra commands the human allows this agent in agents.json ("commands": ["npm run x"]), each
// allowed exactly as written; a trailing ":*" allows that one command with any arguments
// ("npm run measure:board:*"). No other wildcards, no quotes or shell punctuation.
const COMMAND_RE = /^[\w@./=+, -][\w@./:=+, -]{0,199}?(:\*)?$/;
function runFor(perms = [], { mcpConfig = null, commands = [] } = {}) {
  const extra = [].concat(commands || []).map((c) => String(c).trim()).filter((c) => COMMAND_RE.test(c)).map((c) => `Bash(${c})`);
  const allowed = [...new Set([...perms.flatMap((k) => PERMS[k]?.tools || []), ...extra])];
  const tools = [...new Set([...BASE_TOOLS, ...allowed.map((t) => t.replace(/\(.*$/, ''))])];
  const edits = perms.includes('edit');
  return `claude -p ${PROMPT_ARG}${edits ? ' --permission-mode acceptEdits' : ''} --tools "${tools.join(',')}" --strict-mcp-config${mcpConfig ? ` --mcp-config "${mcpConfig}"` : ''}`
    + ` --allowedTools ${['Bash(intellagent:*)', 'mcp__intellagent', ...allowed].map((t) => `"${t}"`).join(' ')}`;
}
// The project's MCP config when it registers the board's server (intellagent init writes it), relative to
// the run's folder; null otherwise, and the run gets no MCP tools (the CLI still works).
function boardMcpConfig(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8').replace(/^﻿/, ''));
    return raw?.mcpServers?.intellagent ? '.mcp.json' : null;
  } catch { return null; }
}

const QUEUE_MAX = 200;
const HISTORY_KEPT = 10;
const LOGS_KEPT = 20;

const eventLine = (e) => e.type === 'work.pending'
  ? ['work.pending — work waiting for you on the board:',
    ...e.work.map((w) => `    · ${w.action} ${w.id || w.requestId}${w.title ? ` "${w.title}"` : ''} — ${w.why}`)].join('\n')
  : e.type === 'request.created'
  ? `#${e.seq} REQUEST ${e.request.id} from ${e.actor?.name || '?'}${e.request.history?.length ? ` (a follow-up; the conversation so far, oldest first:${e.request.history.map((m) => `\n      ${m.from}: ${String(m.body).replace(/\s+/g, ' ')}`).join('')}\n    now:)` : ''}: ${e.request.body}${e.request.attachments?.length ? ` [attached files — open them: ${e.request.attachments.map((a) => a.path || a.url).join(', ')}]` : ''}  → do it, then reply: intellagent api POST /api/boards/${e.board}/requests/${e.request.id}/reply body="what you did (ticket ids)" done=true`
  : `#${e.seq} ${e.type}${e.intent === 'explain' ? ' [EXPLAIN ONLY]' : ''}${e.draft ? ' [WRITE THIS TICKET — see the write action in your brief]' : ''}${e.itemId ? ` ${e.itemId}` : ''}${e.item?.title ? ` "${e.item.title}"` : ''} by ${e.actor?.name || '?'}${e.reply ? ` — reply: ${e.reply}` : e.comment?.body ? ` — ${e.comment.body}` : e.reason ? ` — ${e.reason}` : ''}`;

// warm: a later turn in a live keep-alive session. The role brief and fixed rules are already in its
// context from the first turn, so it gets only what is new: the events, any retry notes and a reminder.
function promptFor(name, events, { listen, evFile, interrupted, failures, earlier = [], brief = '', warm = false, workspace = null, speciality = '' }) {
  const ws = workspace ? [
    ...(warm ? [] : [`You work in your own git worktree, ${workspace.path} (branch ${workspace.branch}), not the main checkout — other agents have their own. Edit, test and commit there, and put the ticket id in every commit message, e.g. "Fix the stack badge (INT-12)". When the human approves the ticket's review, its commits land on ${workspace.main}; nothing reaches ${workspace.main} otherwise.`]),
    ...(workspace.note ? [workspace.note] : []),
    '',
  ] : [];
  const notes = [
    ...(interrupted ? ['Your previous run on these events did not finish (error, timeout or restart). It may have done part of the work: check the cards (comments, status, column) and the working tree before redoing anything.', ''] : []),
    ...(events.some((e) => e.intent === 'explain') ? ['Events marked [EXPLAIN ONLY] are questions about work already done: answer them in a comment on the card — your reasoning, what you considered, the trade-offs — and change nothing else (no code, no ticket fields, no column, no review).', ''] : []),
    ...(earlier.length ? ['What the earlier attempt already did on the board (do not repeat it):', ...earlier.slice(-30).map((e) => `- ${eventLine(e)}`), ''] : []),
    ...(failures ? [`Attempt ${failures + 1}: the previous run exited with an error.`, ''] : []),
  ];
  if (warm) {
    const board = events.find((e) => e.board)?.board || '<board>';
    return [
      'New events for you:',
      ...events.map((e) => `- ${eventLine(e)}`),
      '',
      ...notes,
      `Same session, same rules as before. Check \`intellagent api GET /api/boards/${board}/work\` (the brief only if you need the board rules again), act, reply on the card, then finish. If nothing here needs you, end without commenting.`,
      ...ws,
      `Full event JSON: ${evFile}`,
    ].join('\n');
  }
  return [
    ...(speciality ? [speciality, ''] : []),
    ...(brief ? [brief, ''] : []),
    listen === 'inbox'
      ? `You are "${name}", working on this project's Intellagent board. These events are for you:`
      : `You are "${name}", coordinating this project's Intellagent board. New activity:`,
    ...events.map((e) => `- ${eventLine(e)}`),
    '',
    ...notes,
    'Start with: intellagent brief   (your situation, the board\'s rules and the exact next calls). Then act on it following the board\'s standing rules and the project\'s CLAUDE.md, and reply on the card.',
    'Finish with: intellagent api POST /api/boards/<board>/finish summary="…" — it releases anything you still hold.',
    'Anything worth remembering must go on the card — this run ends when you finish and nothing else is kept.',
    // Agents that once commented on a ticket hear about everything on it; most of that needs nothing from them.
    'If none of these events asks you to do or answer something, do nothing and end the run: no "noted"/"nothing to do" comments (your 👀 already says you saw it). Only post when you have work, an answer or a question.',
    // Agents tend to write `cd … && VAR=x intellagent …`, which no longer matches a `Bash(intellagent …)`
    // allowlist rule — so say plainly that neither is needed.
    `You are already "${name}" (INTELLAGENT_AGENT is set) and already in the project folder: run commands bare — \`intellagent …\`, \`npm test\` — with no \`cd\` and no environment-variable prefixes, or the permission allowlist will refuse them. The board's MCP tools (get_briefing, start_work, request_review, finish_session…) work too.`,
    ...ws,
    `Full event JSON: ${evFile}`,
  ].join('\n');
}

// A keep-alive claude reads turns as stream-json on stdin and reports each one's end as a "result" line.
// The prompt arrives per turn, so the fixed prompt argument goes. A custom (non-claude) run used with
// keepAlive must speak the same protocol itself.
function keepAliveCmd(run) {
  if (Array.isArray(run) || !/^\s*claude(\.cmd|\.exe)?\s/.test(run)) return run;
  let r = run.split(PROMPT_ARG).join('').replace(/\s+/g, ' ').trim();
  for (const [flag, v] of [['--input-format', 'stream-json'], ['--output-format', 'stream-json']]) if (!r.includes(flag)) r += ` ${flag} ${v}`;
  if (!/(^|\s)--verbose(\s|$)/.test(r)) r += ' --verbose';
  return r;
}

// What makes an agent a specialist: the code it owns (guidance, not a limit), what it always checks, and
// its own context page (agent-context/<name>.md next to agents.json, or inline "context"). Capped so a long
// page can't inflate every first turn.
const CONTEXT_MAX = 8000;
function specialityText(def, readContext) {
  const areas = [].concat(def.areas || []).filter(Boolean);
  const concerns = [].concat(def.concerns || []).filter(Boolean);
  let ctx = '';
  try { ctx = readContext(def) || ''; } catch { /* missing file */ }
  if (ctx.length > CONTEXT_MAX) ctx = `${ctx.slice(0, CONTEXT_MAX)}\n…(context cut at ${CONTEXT_MAX} characters)`;
  if (!areas.length && !concerns.length && !ctx.trim()) return '';
  return [
    '## Your speciality',
    ...(areas.length ? ['Code you own — your home ground. Prefer tickets here; when a ticket takes you elsewhere, go, but say so on the card:', ...areas.map((a) => `- \`${a}\``)] : []),
    ...(concerns.length ? ['Concerns you always check before requesting review (say in your review how each was handled):', ...concerns.map((c) => `- ${c}`)] : []),
    ...(ctx.trim() ? ['', ctx.trim()] : []),
  ].join('\n');
}

function killTree(child) {
  if (process.platform === 'win32') execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => {});
  else try { process.kill(-child.pid, 'SIGTERM'); } catch { try { (child.kill ? child.kill('SIGTERM') : process.kill(child.pid, 'SIGTERM')); } catch { /* gone */ } }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Which of the processes recorded before a restart ({ pid, at }: the shell a run was spawned in, and when) are
// still running, as pids to stop. Only what is provably ours: pids get reused, and the wrong one could be the
// human's. Windows: the shell may be gone while its child (claude) runs on, orphaned but still naming it as
// parent, so its children count too if they started with it; one process query covers every agent.
function leftovers(recorded) {
  const found = new Map(); // recorded entry → pids
  if (!recorded.length) return found;
  try {
    if (process.platform === 'win32') {
      const ids = [...new Set(recorded.map((p) => Number(p.pid)))];
      const filter = ids.map((id) => `ProcessId=${id} OR ParentProcessId=${id}`).join(' OR ');
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [string]$_.ProcessId + ' ' + $_.ParentProcessId + ' ' + ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }`],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      const rows = out.split(/\r?\n/).map((l) => l.trim().split(' ').map(Number)).filter((r) => r.length === 3 && r.every(Number.isFinite));
      for (const p of recorded) {
        const self = rows.find(([id]) => id === p.pid);
        if (self && Math.abs(self[2] - p.at) < 5000) { found.set(p, [p.pid]); continue; } // taskkill /T takes its children
        // the shell is gone (or its pid now belongs to someone else, started later): children it started itself
        const kids = rows.filter(([id, parent, t]) => parent === p.pid && id !== p.pid && t >= p.at - 1000 && t - p.at < 30_000 && (!self || t < self[2]));
        if (kids.length) found.set(p, kids.map(([id]) => id));
      }
      return found;
    }
    // elsewhere a run leads its own process group (detached), and a pid is never reused while its group lives
    for (const p of recorded) {
      if (!alive(-p.pid)) continue;
      if (alive(p.pid)) {
        const secs = Number(execFileSync('ps', ['-o', 'etimes=', '-p', String(Number(p.pid))], { encoding: 'utf8', timeout: 5000 }).trim());
        if (!Number.isFinite(secs) || Math.abs(Date.now() - secs * 1000 - p.at) > 5000) continue;
      }
      found.set(p, [p.pid]);
    }
  } catch { /* the OS won't say: leave them */ }
  return found;
}
// a process stopped after a restart is gone once neither it nor (elsewhere) its process group is left
const lives = (pid) => alive(pid) || (process.platform !== 'win32' && alive(-pid));

/**
 * deps: { file, stateFile, logDir, cwd, env, emit, matchesFilter, parseFilter, recent: () => events[], seq: () => number, log }
 */
function createAgents(deps) {
  const { file, stateFile, logDir, cwd, emit, matchesFilter, parseFilter } = deps;
  // where context pages live: agent-context/<name>.md beside agents.json
  const contextDir = path.join(path.dirname(file), 'agent-context');
  const contextPath = (def) => (def.contextFile ? path.resolve(path.dirname(file), def.contextFile) : path.join(contextDir, `${String(def.name).replace(/[^\w.-]+/g, '_')}.md`));
  const readContext = (def) => (def.context ? String(def.context) : fs.existsSync(contextPath(def)) ? fs.readFileSync(contextPath(def), 'utf8') : '');
  let defs = {};      // name → resolved definition
  let defaults = { ...DEFAULTS };
  let loadError = null;
  const state = readState();
  const running = new Map(); // name → { child, timer }
  const sessions = new Map(); // name → keep-alive session { child, turns, startedAt, turn, closed, cmd }
  const timers = new Map();  // name → pending dispatch timer
  const procs = new Map();   // name → Set of child processes not yet exited (runs and sessions)
  const held = new Map();    // name → { pids, until } of processes that outlived a board restart, being stopped

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

  function load() {
    loadError = null;
    let raw = { agents: {} };
    if (fs.existsSync(file)) {
      // strip a BOM: Notepad and PowerShell add one
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { loadError = `${path.basename(file)}: ${e.message}`; return; }
    }
    defaults = { ...DEFAULTS, ...(raw.defaults || {}) };
    const before = Object.keys(defs);
    defs = {};
    for (const [name, d] of Object.entries(raw.agents || {})) {
      if (!/^[\w.-]{1,64}$/.test(name)) { loadError = `invalid agent name "${name}"`; continue; }
      const role = ROLES[d.role] || null;
      const perms = Array.isArray(d.perms) ? d.perms : role?.perms;
      defs[name] = {
        ...defaults, ...(role ? { listen: role.listen, throttleMinutes: role.throttleMinutes, description: role.description, ...(role.pickup ? { pickup: role.pickup } : {}), ...(role.supervise ? { supervise: role.supervise } : {}), ...(role.reviewer ? { reviewer: role.reviewer } : {}) } : {}), ...d,
        name, enabled: d.enabled !== false,
        // no explicit run: build it from the role's (or listed) permissions
        run: d.run || (perms ? runFor(perms, { mcpConfig: boardMcpConfig(d.cwd ? path.resolve(cwd, d.cwd) : cwd), commands: d.commands }) : defaults.run), perms: perms || null, brief: role?.brief || '',
        // where the perms come from: its own list, or its role (then a role change changes its tools)
        permsFrom: Array.isArray(d.perms) ? 'own' : role?.perms ? 'role' : null,
        // agents that edit files get their own git worktree unless told otherwise
        worktree: d.worktree ?? defaults.worktree ?? (perms || []).includes('edit'),
      };
      const model = d.model ?? defaults.model ?? null;
      if (model != null && !MODEL_RE.test(String(model))) { loadError = `agent "${name}": model must be a plain name like haiku, sonnet or opus`; defs[name].model = null; }
      else defs[name].model = model;
      defs[name].run = withModel(defs[name].run, defs[name].model);
      st(name);
    }
    // a removed agent will never run its queue: take back its ⏳
    for (const name of before) if (!defs[name] && state.agents[name]) reportQueue(name, state.agents[name].queue || [], { gone: true });
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
    return [].concat(def.listen || 'inbox').map((l) => {
      const f = parseFilter({ ...one(l), excludeActor: def.name });
      // a new ticket the human already gave to someone else needs no triage
      if (l === 'new-tickets') f.skip = (e) => !!e.item?.assignee && e.item.assignee !== def.name;
      return f;
    });
  }
  const wakes = (def, e) => filtersFor(def).some((f) => matchesFilter(e, f) && !f.skip?.(e));

  function enqueue(name, events) {
    const s = st(name);
    for (const e of events) if (!s.queue.some((q) => q.seq === e.seq && q.type === e.type)) s.queue.push(e);
    if (s.queue.length > QUEUE_MAX) reportQueue(name, s.queue.splice(0, s.queue.length - QUEUE_MAX), { gone: true });
    const last = events[events.length - 1];
    if (last) s.cursor = Math.max(s.cursor || 0, last.seq);
    save();
    schedule(name, defs[name].settleSeconds * 1000);
    try { const when = whenRuns(name); if (when) deps.onQueued?.(name, events, when); } catch { /* best effort */ }
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
    if (s.status === 'failed') return; // waits for the human to resume
    if (lingering(name)) return schedule(name, 1000);
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
      s.queue = [...(s.inflight || []), ...s.queue.filter((e) => !(s.inflight || []).some((i) => i.seq === e.seq))];
      s.inflight = null;
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
      s.queue = [...(s.inflight || []), ...s.queue.filter((e) => !(s.inflight || []).some((i) => i.seq === e.seq))];
      s.inflight = null;
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

  // Called for every board event.
  function onEvent(e) {
    if (e.type.startsWith('agent.')) return;
    for (const def of Object.values(defs)) if (wakes(def, e)) enqueue(def.name, [e]);
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

  // A running agent's last sign of life: its last call to the board (deps.lastSeen) or the last output in its
  // run log, whichever is later. One-shot runs print nothing until they end, so for them it is board calls only.
  function lastActivity(name, r) {
    let t = Date.parse(r.startedAt);
    try { t = Math.max(t, Date.parse(deps.lastSeen?.(name) || 0) || 0); } catch { /* none */ }
    try { t = Math.max(t, fs.statSync(r.logFile).mtimeMs); } catch { /* no log */ }
    return new Date(t).toISOString();
  }

  function view(name) {
    const def = defs[name];
    const s = st(name);
    const r = running.get(name);
    const active = r ? lastActivity(name, r) : null;
    const stallMs = (Number(def.stallMinutes ?? DEFAULTS.stallMinutes) || 0) * 60_000;
    // What the run is doing now: the newest of its own status line and the status of a ticket it holds (deps.activityOf)
    let now = null;
    if (r) {
      let act = null;
      try { act = deps.activityOf?.(name, r.startedAt) || null; } catch { /* none */ }
      now = { since: r.startedAt, why: s.lastRun?.why || null, items: [...new Set([...(r.items || []), ...(act?.items || [])])], line: act?.line || null };
    }
    return {
      name, role: def.role || null, model: def.model || null, tier: TIERS[String(def.model || '').toLowerCase()] || null, perms: def.perms, permsFrom: def.permsFrom || null, enabled: def.enabled && !s.paused, listen: def.listen, description: def.description || null,
      run: def.run, maxRunsPerHour: def.maxRunsPerHour, throttleMinutes: def.throttleMinutes, maxFailures: def.maxFailures, timeoutMinutes: def.timeoutMinutes,
      status: def.enabled && !s.paused ? s.status : 'paused', queued: s.queue.length, failures: s.failures,
      runsLastHour: s.runs.filter((t) => Date.parse(t) > Date.now() - 3600_000).length,
      grants: [].concat(def.grants || []), reviewer: !!def.reviewer, areas: [].concat(def.areas || []), concerns: [].concat(def.concerns || []), contextFile: def.context ? null : path.relative(path.dirname(file), contextPath(def)).replace(/\\/g, '/'), hasContext: !!readContext(def).trim(),
      limits: def.limits || null, worktree: def.worktree && deps.worktrees ? deps.worktrees.where(name) : null, changes: (s.changes || []).slice(-10),
      pickup: def.pickup || false, keepAlive: !!def.keepAlive, session: sessions.get(name) ? { alive: true, turns: sessions.get(name).turns, context: sessions.get(name).context ?? null, recycleAboveTokens: recycleTokens(def), since: sessions.get(name).startedAt, recycleAfter: Number(def.recycleAfterRuns) || DEFAULTS.recycleAfterRuns } : null,
      lastRun: s.lastRun, usageToday: s.usageToday?.day === dayOf() ? s.usageToday : null, runningSince: r?.startedAt || null,
      lastActivityAt: active, stalled: !!active && !!stallMs && Date.now() - Date.parse(active) > stallMs, now, history: s.history || [], resumesAt: s.status === 'throttled' || s.status === 'waiting' ? s.resumesAt : undefined,
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
    // An agent added by editing the file (intellagent agents add) needs its token before its first run.
    deps.onAgentsChanged?.(Object.keys(defs));
    for (const name of [...sessions.keys()]) if (!defs[name] || !defs[name].keepAlive || !defs[name].enabled) { if (!running.has(name)) endSession(name); }
    for (const name of Object.keys(defs)) dispatch(name);
    sweepAll();
    emit({ type: 'agents.changed', actor: { kind: 'system', name: 'intellagent' }, agents: Object.keys(defs), ...(loadError ? { error: loadError } : {}) });
  });

  return {
    file,
    onEvent,
    // recent: also the newest runs across all agents (newest first), for the activity strip
    list: ({ recent = 0 } = {}) => {
      const agents = Object.keys(defs).map(view);
      if (!recent) return { file, error: loadError, agents };
      const runs = agents.flatMap((a) => a.history.map((h) => ({ agent: a.name, ...h }))).sort((x, y) => y.startedAt.localeCompare(x.startedAt)).slice(0, recent);
      return { file, error: loadError, agents, recent: runs };
    },
    // Define or replace a standing agent from a role and permission keys — never a raw command.
    define(name, d, by = null) {
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
      if (d.model !== undefined) {
        if (d.model && !MODEL_RE.test(String(d.model))) { const e = new Error('Model: a plain name like haiku, sonnet or opus'); e.status = 400; throw e; }
        if (d.model) next.model = String(d.model); else delete next.model;
      }
      if (d.pickup !== undefined) next.pickup = d.pickup === true || d.pickup === 'ready' ? 'ready' : d.pickup === 'all' ? 'all' : false;
      // keep-alive, board access (limits) and grants: null or false removes them. Grants arrive already
      // checked by the server (human only, signed in); this file never decides who may set them.
      if (d.keepAlive !== undefined) { if (d.keepAlive == null) delete next.keepAlive; else next.keepAlive = !!d.keepAlive; }
      for (const k of ['limits', 'grants']) {
        if (d[k] === undefined) continue;
        const empty = d[k] == null || (Array.isArray(d[k]) ? !d[k].length : !Object.keys(d[k]).length);
        if (empty) delete next[k]; else next[k] = d[k];
      }
      if (next.throttleMinutes === null) delete next.throttleMinutes; // blank: back to the role default (maxRunsPerHour null stays: no limit)
      raw.agents[name] = next;
      // the agent's Recent changes (with Revert on the Agents page)
      const changes = {};
      for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
        if (JSON.stringify(prev[k] ?? null) !== JSON.stringify(next[k] ?? null)) changes[k] = { from: prev[k] ?? null, to: next[k] ?? null };
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(raw, null, 2)}\n`);
      fs.renameSync(`${file}.tmp`, file);
      load();
      if (by && Object.keys(changes).length && defs[name]) {
        const s = st(name);
        s.changes = [...(s.changes || []), { id: `chg_${crypto.randomBytes(4).toString('hex')}`, at: new Date().toISOString(), by, changes }].slice(-30);
        save();
      }
      emit({ type: 'agents.changed', actor: { kind: 'system', name: 'intellagent' }, agents: Object.keys(defs) });
      return view(name);
    },
    // Edits by an agent manager (or the human) to another agent's config: role, description, model, perms,
    // limits. The caller has already checked what may change; this writes agents.json and keeps a history.
    manage(name, patch, by) {
      name = need(name);
      let raw = { agents: {} };
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { /* new file */ }
      raw.agents ||= {};
      const cur = raw.agents[name] || {};
      const changes = {};
      for (const [k, v] of Object.entries(patch)) {
        const from = cur[k] ?? null;
        if (JSON.stringify(from) === JSON.stringify(v ?? null)) continue;
        changes[k] = { from, to: v ?? null };
        if (v == null) delete cur[k]; else cur[k] = v;
      }
      if (!Object.keys(changes).length) return { changes };
      raw.agents[name] = cur;
      fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(raw, null, 2)}\n`);
      fs.renameSync(`${file}.tmp`, file);
      load();
      const s = st(name);
      s.changes = [...(s.changes || []), { id: `chg_${crypto.randomBytes(4).toString('hex')}`, at: new Date().toISOString(), by, changes }].slice(-30);
      save();
      emit({ type: 'agents.changed', actor: { kind: 'system', name: 'intellagent' }, agents: Object.keys(defs) });
      return { changes };
    },
    specialityOf: (name) => { const d = defs[need(name)]; return specialityText(d, readContext); },
    contextOf: (name) => readContext(defs[need(name)]),
    // Save an agent's context page (markdown); empty removes it. Returns the old text for the audit trail.
    setContext(name, text) {
      name = need(name);
      const d = defs[name];
      const before = readContext(d);
      if (d.context) { this.manage(name, { context: text ? String(text) : null }, { kind: 'system', name: 'intellagent' }); return before; }
      const p = contextPath(d);
      if (text && String(text).trim()) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(text).replace(/\r\n/g, '\n')); }
      else fs.rmSync(p, { force: true });
      return before;
    },
    limitsOf: (name) => defs[Object.keys(defs).find((n) => n.toLowerCase() === String(name).toLowerCase())]?.limits || null,
    remove(name) {
      name = need(name);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      delete raw.agents[name];
      endSession(name);
      fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(raw, null, 2)}\n`);
      fs.renameSync(`${file}.tmp`, file);
      load();
      emit({ type: 'agents.changed', actor: { kind: 'system', name: 'intellagent' }, agents: Object.keys(defs) });
      return { removed: name };
    },
    get: (name) => view(need(name)),
    isRunning: (name) => running.has(name),
    // grants come only from agents.json (define() never writes them)
    grantsOf: (name) => { const k = Object.keys(defs).find((n) => n.toLowerCase() === String(name).toLowerCase()); return (k && defs[k].grants) || []; },
    // A supervising agent (the receptionist) is told about other agents' stalled tickets; returns minutes or 0.
    superviseOf: (name) => { const d = defs[name]; return d?.enabled && d.supervise ? Number(d.superviseMinutes) || 30 : 0; },
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
    pause(name) { name = need(name); st(name).paused = true; if (!running.has(name)) endSession(name); setStatus(name, 'paused'); return view(name); },
    unpause(name) { name = need(name); st(name).paused = false; return this.resume(name); },
    // Stop everything now: pause every agent and kill the runs in flight (their events stay queued).
    stopAll() {
      const stopped = [];
      for (const name of Object.keys(defs)) {
        const s = st(name);
        s.paused = true;
        clearTimeout(timers.get(name));
        const r = running.get(name);
        if (r) { r.stopped = true; killTree(r.child); stopped.push(name); } else { endSession(name); setStatus(name, 'paused'); }
      }
      save();
      return { paused: Object.keys(defs), stopped };
    },
    resumeAll() {
      for (const name of Object.keys(defs)) { st(name).paused = false; this.resume(name); }
      return { resumed: Object.keys(defs) };
    },
    runNow(name, note) {
      name = need(name);
      const s = st(name);
      if (!s.queue.length) s.queue.push({ seq: deps.seq(), type: 'agent.poke', actor: { kind: 'user', name: 'human' }, reason: note || 'Check the board for anything that needs you.' });
      s.failures = 0;
      if (running.has(name)) return view(name); // picked up by the next run
      clearTimeout(timers.get(name));
      if (s.status === 'failed' || s.status === 'throttled') s.status = 'idle';
      if (lingering(name)) { schedule(name, 1000); return view(name); }
      start(name, defs[name], s);
      return view(name);
    },
    stop() { clearTimeout(firstSweep); clearInterval(sweepTimer); for (const { child } of running.values()) killTree(child); for (const n of [...sessions.keys()]) { const x = sessions.get(n); endSession(n); try { killTree(x.child); } catch { /* gone */ } } fs.unwatchFile(file); },
  };
}

module.exports = { createAgents, eventLine, DEFAULTS, ROLES, PERMS, runFor, withModel, withJsonOutput, parseUsage, usageOf, keepAliveCmd, boardMcpConfig, TIERS };
