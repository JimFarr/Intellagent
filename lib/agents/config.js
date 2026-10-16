'use strict';
// What a standing agent is: the defaults and roles, the command a role runs with, and the one place
// agents.json is read and written (load, define, manage, remove, context pages).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jsonfile = require('../jsonfile');
const { PERMS, COMMAND_RE, cleanPerm, createLibrary } = require('../permissions');

// agents.json before a write: a file that does not parse is a state problem for the human to fix, so it is a
// 409 with a hint, not a server error, and it is never written over.
function readAgentsFile(file, ...fallback) {
  try { return jsonfile.read(file, ...fallback); } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    const err = new Error(`${path.basename(file)} does not parse (${e.message})`);
    err.status = 409;
    err.code = 'CONFLICT';
    err.extra = { hint: `${path.basename(file)} does not parse (${e.message}); the human fixes the file, then retry` };
    throw err;
  }
}

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
   --allowedTools by hand. Permissions come from the library (lib/permissions.js: the built-in PERMS plus the
   human's own in agents.json); the run command is built from them.
   An explicit "run" in agents.json still wins (that file is the only place raw commands come from). */
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
// A keep-alive claude reads turns as stream-json on stdin and reports each one's end as a "result" line.
// The prompt arrives per turn, so the fixed prompt argument goes. A custom (non-claude) run used with
// keepAlive must speak the same protocol itself.
const isClaudeRun = (run) => !Array.isArray(run) && /^\s*claude(\.cmd|\.exe)?\s/.test(run);
function keepAliveCmd(run) {
  if (!isClaudeRun(run)) return run;
  let r = run.split(PROMPT_ARG).join('').replace(/\s+/g, ' ').trim();
  for (const [flag, v] of [['--input-format', 'stream-json'], ['--output-format', 'stream-json']]) if (!r.includes(flag)) r += ` ${flag} ${v}`;
  if (!/(^|\s)--verbose(\s|$)/.test(r)) r += ' --verbose';
  return r;
}

// The command a role (or a custom permission list) runs with. It loads only the built-in tools the perms
// can use (--tools; every definition loaded costs context on every call) and no MCP servers but the
// board's own (--strict-mcp-config; mcpConfig is the project's .mcp.json when it registers one).
const BASE_TOOLS = ['Bash', 'Read', 'Grep', 'Glob']; // Bash for the intellagent CLI; reading is always allowed
// commands: extra commands the human allows this agent in agents.json ("commands": ["npm run x"]), each
// allowed exactly as written; a trailing ":*" allows that one command with any arguments
// ("npm run measure:board:*"). No other wildcards, no quotes or shell punctuation (COMMAND_RE).
const BUILTIN_LIBRARY = createLibrary();
// The board's own files, which Claude's file tools may never touch: its tokens (local.json), the agents'
// definitions and grants (agents.json, agent-context/), the repo's git hooks and (writing only: a run reads
// its events file there) its data. Each as a pattern anywhere under the run's folder, and by absolute path
// (protect / protectWrites: the real files, which may lie outside an agent's worktree). A speed bump only:
// code the agent runs (a test, a script) is not held by these rules.
const PROTECTED = ['**/.intellagent/local.json', '**/agents.json', '**/agent-context/**', '**/.git/hooks/**'];
// Claude Code matches absolute paths in POSIX form after "//": C:\a\b → //c/a/b, /a/b → //a/b
const absRule = (p) => `/${path.resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`)}`;
function denyRules(protect = [], protectWrites = []) {
  const abs = (list) => list.filter((p) => p && !/["`$%!]/.test(p)).map(absRule);
  const rules = (list, tools) => list.flatMap((p) => tools.map((t) => `${t}(${p})`));
  return [...new Set([...rules([...PROTECTED, ...abs(protect)], ['Read', 'Edit', 'Write']), ...rules(abs(protectWrites), ['Edit', 'Write'])])];
}
// library: the board's permission library (built-ins only when not given). Verbal permissions add no tool.
function runFor(perms = [], { mcpConfig = null, commands = [], protect = [], protectWrites = [], library = BUILTIN_LIBRARY } = {}) {
  const extra = [].concat(commands || []).map((c) => String(c).trim()).filter((c) => COMMAND_RE.test(c)).map((c) => `Bash(${c})`);
  const held = library.resolve(perms);
  const allowed = [...new Set([...held.tools, ...extra])];
  // --tools names built-in tools only; an MCP tool is allowed by name and loads with its server
  const tools = [...new Set([...BASE_TOOLS, ...allowed.filter((t) => !t.startsWith('mcp__')).map((t) => t.replace(/\(.*$/, ''))])];
  const edits = held.keys.includes('edit');
  return `claude -p ${PROMPT_ARG}${edits ? ' --permission-mode acceptEdits' : ''} --tools "${tools.join(',')}" --strict-mcp-config${mcpConfig ? ` --mcp-config "${mcpConfig}"` : ''}`
    + ` --allowedTools ${['Bash(intellagent:*)', 'mcp__intellagent', ...allowed].map((t) => `"${t}"`).join(' ')}`
    + ` --disallowedTools ${denyRules(protect, protectWrites).map((t) => `"${t}"`).join(' ')}`;
}
// The project's MCP config when it registers the board's server (intellagent init writes it), relative to
// the run's folder; null otherwise, and the run gets no MCP tools (the CLI still works).
function boardMcpConfig(dir) {
  try {
    const raw = jsonfile.read(path.join(dir, '.mcp.json'));
    return raw?.mcpServers?.intellagent ? '.mcp.json' : null;
  } catch { return null; }
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
  // the custom permissions it holds, verbal ones flagged (set by load; '' when it holds only built-ins)
  const perms = def.permsBrief ? ['', def.permsBrief] : [];
  if (!areas.length && !concerns.length && !ctx.trim()) return perms.slice(1).join('\n');
  return [
    '## Your speciality',
    ...(areas.length ? ['Code you own — your home ground. Prefer tickets here; when a ticket takes you elsewhere, go, but say so on the card:', ...areas.map((a) => `- \`${a}\``)] : []),
    ...(concerns.length ? ['Concerns you always check before requesting review (say in your review how each was handled):', ...concerns.map((c) => `- ${c}`)] : []),
    ...(ctx.trim() ? ['', ctx.trim()] : []),
    ...perms,
  ].join('\n');
}

const badRequest = (message) => { const e = new Error(message); e.status = 400; e.code = 'BAD_REQUEST'; return e; };

/**
 * agents.json: what the board's agents are. core: the pieces every part of createAgents shares (see agents.js).
 * The scheduler decides when a defined agent runs and the runner runs it; this decides who exists and how.
 */
function createConfig(core) {
  const { deps, defs, st, save } = core;
  const { file, stateFile, cwd, matchesFilter, parseFilter, emit } = deps;
  const reportQueue = (...a) => core.scheduler.reportQueue(...a);
  const endSession = (...a) => core.runner.endSession(...a);
  const view = (...a) => core.view(...a);
  // where context pages live: agent-context/<name>.md beside agents.json
  const contextDir = path.join(path.dirname(file), 'agent-context');
  const contextPath = (def) => (def.contextFile ? path.resolve(path.dirname(file), def.contextFile) : path.join(contextDir, `${String(def.name).replace(/[^\w.-]+/g, '_')}.md`));
  const readContext = (def) => (def.context ? String(def.context) : fs.existsSync(contextPath(def)) ? fs.readFileSync(contextPath(def), 'utf8') : '');
  // the board's own files, wherever they are, for the deny rules of every run built from permissions
  const protect = [file, path.join(path.dirname(file), 'local.json'), path.join(contextDir, '**'), path.join(cwd, '.git', 'hooks', '**'), ...(deps.protect || [])];
  const protectWrites = [path.join(path.dirname(stateFile), '**')];
  let defaults = { ...DEFAULTS };
  let loadError = null;
  let library = BUILTIN_LIBRARY; // built-ins plus agents.json's "perms"

  // Read agents.json into defs (the one object everything shares: emptied and refilled, never replaced).
  function load() {
    loadError = null;
    let raw = { agents: {} };
    if (fs.existsSync(file)) {
      try { raw = jsonfile.read(file); } catch (e) { loadError = `${path.basename(file)}: ${e.message}`; return; }
    }
    defaults = { ...DEFAULTS, ...(raw.defaults || {}) };
    library = createLibrary(raw.perms);
    if (library.errors.length) loadError = `${path.basename(file)}: ${library.errors.join('; ')}`;
    const before = Object.keys(defs);
    for (const name of before) delete defs[name];
    const warn = (msg) => { loadError = loadError ? `${loadError}; ${msg}` : msg; }; // every problem, not just the last
    for (const [name, d] of Object.entries(raw.agents || {})) {
      if (!/^[\w.-]{1,64}$/.test(name)) { warn(`invalid agent name "${name}"`); continue; }
      const role = ROLES[d.role] || null;
      const perms = Array.isArray(d.perms) ? d.perms : role?.perms;
      const held = library.resolve(perms || []);
      if (held.unknown.length) loadError = `agent "${name}": unknown permission(s) ${held.unknown.join(', ')}`;
      defs[name] = {
        ...defaults, ...(role ? { listen: role.listen, throttleMinutes: role.throttleMinutes, description: role.description, ...(role.pickup ? { pickup: role.pickup } : {}), ...(role.supervise ? { supervise: role.supervise } : {}), ...(role.reviewer ? { reviewer: role.reviewer } : {}) } : {}), ...d,
        name, enabled: d.enabled !== false,
        // no explicit run: build it from the role's (or listed) permissions
        run: d.run || (perms ? runFor(perms, { mcpConfig: boardMcpConfig(d.cwd ? path.resolve(cwd, d.cwd) : cwd), commands: d.commands, protect, protectWrites, library }) : defaults.run), perms: perms || null, brief: role?.brief || '',
        permsBrief: library.briefText(perms || []),
        // where the perms come from: its own list, or its role (then a role change changes its tools)
        permsFrom: Array.isArray(d.perms) ? 'own' : role?.perms ? 'role' : null,
        // agents that edit files (all of them, or some folders) get their own git worktree unless told otherwise
        worktree: d.worktree ?? defaults.worktree ?? (held.keys.includes('edit') || held.tools.some((t) => t.startsWith('Edit('))),
      };
      const model = d.model ?? defaults.model ?? null;
      if (model != null && !MODEL_RE.test(String(model))) { warn(`agent "${name}": model must be a plain name like haiku, sonnet or opus`); defs[name].model = null; }
      else defs[name].model = model;
      defs[name].run = withModel(defs[name].run, defs[name].model);
      // who serves the model, for display and routing only: a claude run is Anthropic's unless it says otherwise
      const provider = d.provider ?? defaults.provider ?? (isClaudeRun(defs[name].run) ? 'anthropic' : null);
      if (provider != null && !MODEL_RE.test(String(provider))) { warn(`agent "${name}": provider must be a plain name like anthropic or deepseek`); defs[name].provider = null; }
      else defs[name].provider = provider == null ? null : String(provider).toLowerCase();
      // keep-alive speaks Claude's stream-json: another command says it does too ("stream-json"), or it would get
      // turns it never answers and hang until the timeout, so it runs one-shot instead
      const a = defs[name];
      if (a.keepAlive && a.keepAlive !== 'stream-json' && !isClaudeRun(a.run)) {
        warn(`agent "${name}": keepAlive needs a claude run, so it runs one-shot. Set "keepAlive": "stream-json" if the command speaks Claude's stream-json protocol`);
        a.keepAlive = false;
      }
      // env and inheritEnv narrow what the run sees: a malformed one leaves the agent off rather than
      // running it with everything the board has
      const envBad = a.env != null && (typeof a.env !== 'object' || Array.isArray(a.env) || Object.values(a.env).some((v) => v != null && typeof v === 'object'));
      const inheritBad = a.inheritEnv != null && (!Array.isArray(a.inheritEnv) || a.inheritEnv.some((k) => typeof k !== 'string'));
      if (envBad || inheritBad) {
        warn(`agent "${name}": ${envBad ? '"env" must be an object of names to text (null removes one)' : '"inheritEnv" must be a list of variable names'}, so the agent is off until it is fixed`);
        a.enabled = false;
      }
      st(name);
    }
    // a removed agent will never run its queue: take back its ⏳
    for (const name of before) if (!defs[name] && core.state.agents[name]) reportQueue(name, core.state.agents[name].queue || [], { gone: true });
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

  function need(name) {
    const hit = Object.keys(defs).find((n) => n.toLowerCase() === String(name).toLowerCase());
    if (!hit) { const e = new Error(`No standing agent "${name}" in ${path.basename(file)}`); e.status = 404; throw e; }
    return hit;
  }

  // The agent's Recent changes (with Revert on the Agents page), newest last, 30 kept.
  function recordChange(name, by, changes) {
    const s = st(name);
    s.changes = [...(s.changes || []), { id: `chg_${crypto.randomBytes(4).toString('hex')}`, at: new Date().toISOString(), by, changes }].slice(-30);
    save();
  }
  const changed = () => emit({ type: 'agents.changed', actor: { kind: 'system', name: 'intellagent' }, agents: Object.keys(defs) });

  const api = {
    // Define or replace a standing agent from a role and permission keys — never a raw command.
    define(name, d, by = null) {
      if (!/^[\w.-]{1,64}$/.test(String(name || ''))) throw badRequest('Agent name: letters, digits, dot, dash or underscore (max 64)');
      if (d.role && !ROLES[d.role]) throw badRequest(`Unknown role "${d.role}". Roles: ${Object.keys(ROLES).join(', ')}`);
      const perms = d.perms == null ? undefined : [...new Set([].concat(d.perms))];
      const bad = (perms || []).filter((k) => !library.holdable(k));
      if (bad.length) throw badRequest(`Unknown permission(s): ${bad.join(', ')}. Use: ${Object.keys(library.labels()).join(', ')}${bad.some(library.isPower) ? ' (powers go in grants)' : ''}`);
      // a missing file is a new one; a broken one is an error, not something to write over
      const raw = readAgentsFile(file, { agents: {} });
      raw.agents ||= {};
      const prev = raw.agents[name] || {};
      const next = { ...prev };
      for (const k of ['role', 'description', 'listen']) if (d[k] != null && d[k] !== '') next[k] = String(d[k]).slice(0, 2000);
      if (perms) next.perms = perms;
      for (const k of ['throttleMinutes', 'maxRunsPerHour']) if (d[k] !== undefined) next[k] = d[k] === null ? null : Number(d[k]);
      if (d.model !== undefined) {
        if (d.model && !MODEL_RE.test(String(d.model))) throw badRequest('Model: a plain name like haiku, sonnet or opus');
        if (d.model) next.model = String(d.model); else delete next.model;
      }
      if (d.provider !== undefined) {
        if (d.provider && !MODEL_RE.test(String(d.provider))) throw badRequest('Provider: a plain name like anthropic or deepseek');
        if (d.provider) next.provider = String(d.provider).toLowerCase(); else delete next.provider;
      }
      if (d.pickup !== undefined) next.pickup = d.pickup === true || d.pickup === 'ready' ? 'ready' : d.pickup === 'all' ? 'all' : false;
      // keep-alive, board access (limits) and grants: null or false removes them. Grants arrive already
      // checked by the server (human only, signed in); this file never decides who may set them.
      if (d.keepAlive !== undefined) { if (d.keepAlive == null) delete next.keepAlive; else next.keepAlive = d.keepAlive === 'stream-json' ? 'stream-json' : !!d.keepAlive; }
      for (const k of ['limits', 'grants']) {
        if (d[k] === undefined) continue;
        const empty = d[k] == null || (Array.isArray(d[k]) ? !d[k].length : !Object.keys(d[k]).length);
        if (empty) delete next[k]; else next[k] = d[k];
      }
      if (next.throttleMinutes === null) delete next.throttleMinutes; // blank: back to the role default (maxRunsPerHour null stays: no limit)
      raw.agents[name] = next;
      const changes = {};
      for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
        if (JSON.stringify(prev[k] ?? null) !== JSON.stringify(next[k] ?? null)) changes[k] = { from: prev[k] ?? null, to: next[k] ?? null };
      }
      jsonfile.writeAtomic(file, raw);
      load();
      if (by && Object.keys(changes).length && defs[name]) recordChange(name, by, changes);
      changed();
      return view(name);
    },
    // Edits by an agent manager (or the human) to another agent's config: role, description, model, perms,
    // limits. The caller has already checked what may change; this writes agents.json and keeps a history.
    manage(name, patch, by) {
      name = need(name);
      const raw = readAgentsFile(file, { agents: {} });
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
      jsonfile.writeAtomic(file, raw);
      load();
      recordChange(name, by, changes);
      changed();
      return { changes };
    },
    // The permission library (INT-228). The caller has checked it is the human; agents only read it.
    permissionLibrary: () => library,
    // Add or replace a custom permission (patch: merged over the stored one when merge is set).
    definePerm(key, d, { merge = false } = {}) {
      key = String(key || '').trim();
      const raw = readAgentsFile(file, { agents: {} });
      const perms = raw.perms && typeof raw.perms === 'object' && !Array.isArray(raw.perms) ? raw.perms : {};
      if (merge && !Object.hasOwn(perms, key)) { const e = new Error(`No custom permission "${key}"`); e.status = library.get(key)?.builtin ? 409 : 404; e.code = e.status === 409 ? 'CONFLICT' : 'NOT_FOUND'; throw e; }
      const d2 = merge ? Object.fromEntries(Object.entries({ ...perms[key], ...d }).filter(([, v]) => v != null)) : d;
      const next = { ...perms, [key]: d2 };
      next[key] = cleanPerm(key, d2, (k) => !!PERMS[k] || Object.hasOwn(next, k));
      const lib = createLibrary(next);
      const err = lib.errors.find((m) => m.includes(`"${key}"`));
      if (err) throw badRequest(err);
      const before = perms[key] ?? null;
      raw.perms = next;
      jsonfile.writeAtomic(file, raw);
      load();
      changed();
      return { permission: library.get(key), before };
    },
    // Remove a custom permission no agent and no other permission uses.
    removePerm(key) {
      const raw = readAgentsFile(file, { agents: {} });
      const perms = raw.perms || {};
      if (!Object.hasOwn(perms, key)) { const e = new Error(library.get(key)?.builtin ? `"${key}" is a built-in permission` : `No custom permission "${key}"`); e.status = library.get(key)?.builtin ? 409 : 404; e.code = e.status === 409 ? 'CONFLICT' : 'NOT_FOUND'; throw e; }
      const holders = Object.entries(raw.agents || {}).filter(([, a]) => [].concat(a.perms || []).includes(key)).map(([n]) => n);
      const users = Object.entries(perms).filter(([k, p]) => k !== key && [...[].concat(p?.includes || []), ...[].concat(p?.needs || [])].includes(key)).map(([k]) => k);
      if (holders.length || users.length) {
        const e = new Error(`"${key}" is in use by ${[...holders.map((n) => `agent ${n}`), ...users.map((k) => `permission ${k}`)].join(', ')}`);
        e.status = 409; e.code = 'CONFLICT'; e.extra = { hint: 'Take it off those first', holders, usedBy: users };
        throw e;
      }
      const before = perms[key];
      delete perms[key];
      if (Object.keys(perms).length) raw.perms = perms; else delete raw.perms;
      jsonfile.writeAtomic(file, raw);
      load();
      changed();
      return { removed: key, before };
    },
    specialityOf: (name) => { const d = defs[need(name)]; return specialityText(d, readContext); },
    contextOf: (name) => readContext(defs[need(name)]),
    // Save an agent's context page (markdown); empty removes it. Returns the old text for the audit trail.
    setContext(name, text) {
      name = need(name);
      const d = defs[name];
      const before = readContext(d);
      if (d.context) { api.manage(name, { context: text ? String(text) : null }, { kind: 'system', name: 'intellagent' }); return before; }
      const p = contextPath(d);
      if (text && String(text).trim()) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(text).replace(/\r\n/g, '\n')); }
      else fs.rmSync(p, { force: true });
      return before;
    },
    limitsOf: (name) => defs[Object.keys(defs).find((n) => n.toLowerCase() === String(name).toLowerCase())]?.limits || null,
    remove(name) {
      name = need(name);
      const raw = readAgentsFile(file);
      delete raw.agents[name];
      endSession(name);
      jsonfile.writeAtomic(file, raw);
      load();
      changed();
      return { removed: name };
    },
    // grants come only from agents.json (define() never writes them)
    grantsOf: (name) => { const k = Object.keys(defs).find((n) => n.toLowerCase() === String(name).toLowerCase()); return (k && defs[k].grants) || []; },
    // A supervising agent (the receptionist) is told about other agents' stalled tickets; returns minutes or 0.
    superviseOf: (name) => { const d = defs[name]; return d?.enabled && d.supervise ? Number(d.superviseMinutes) || 30 : 0; },
    pickupOf: (name) => defs[name]?.pickup && defs[name].enabled ? (defs[name].pickup === true ? 'ready' : defs[name].pickup) : false,
  };

  return { api, load, need, wakes, readContext, contextPath, loadError: () => loadError };
}

module.exports = { createConfig, DEFAULTS, ROLES, PERMS, TIERS, MODEL_RE, PROMPT_ARG, runFor, withModel, withJsonOutput, keepAliveCmd, boardMcpConfig, specialityText };
