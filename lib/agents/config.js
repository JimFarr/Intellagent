'use strict';
// What a standing agent is: the defaults and roles, the command a role runs with, and the one place
// agents.json is read and written (load, define, manage, remove, context pages).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jsonfile = require('../jsonfile');
const { PERMS, COMMAND_RE, RUN_OTHERS, cleanPerm, createLibrary, cleanGuidance, cleanGuidanceBy } = require('../permissions');
const { BUILTIN: BUILTIN_ROLES, createRoles, cleanRole } = require('./roles');
const { createBase } = require('./base');
const { layersFor, promptFor } = require('./prompt');

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
// The one way agents.json is written, for the board and the CLI: through a temp file and a rename, because the
// board watches the file and must never read half of it.
const writeAgentsFile = (file, raw) => jsonfile.writeAtomic(file, raw);

const DEFAULTS = {
  // Headless runs can't ask for permission: allow the board's CLI and MCP tools up front.
  // Add the project's own commands (tests, build) per agent in agents.json.
  run: 'claude -p "Handle the Intellagent events described on stdin." --permission-mode acceptEdits --allowedTools "Bash(intellagent:*)" "mcp__intellagent"',
  listen: 'addressed', // wake only when addressed: mentioned, assigned, handed a lease, answered, given a verdict
  // 'work' (INT-390): an addressed event alone doesn't wake the agent; it is kept as context and the agent wakes when its
  // work gains an item (a mention is one). 'events': every addressed event wakes it, as before.
  wakeFrom: 'events',
  maxRunsPerHour: 20,   // null = no limit
  helperMaxRunsPerHour: 6, // a helper's ("helper": true) cap when it sets none of its own: every builder can call it (INT-252)
  maxFailures: 3,
  failedRetryMinutes: 30, // a failed agent gets one probe run this long after it failed, then waits for the human (0 = off)
  holdBackAbovePercent: 85, // above this share of the five-hour window, optional work (pickup, supervise nudges) waits for the reset (INT-296); board-wide, read from `defaults` (the first agent's value)
  timeoutMinutes: 60,
  settleSeconds: 3,   // let a burst of edits land in one run
  throttleMinutes: 3, // after a run starts, further events wait and land together in one run when the window ends (0 = off)
  retrySeconds: 30,   // first retry delay after a failure; doubles each time (max 10 min)
  pickup: false,      // also wake for unassigned tickets: 'ready' (true) = in the pickup columns, 'all' = anywhere open
  sweepMinutes: 10,       // how often an idle agent checks the board for work already waiting for it (0 = only on start/resume/run end)
  keepAlive: false,       // one long-lived claude session per agent; each wake is a new turn in it. "auto": only while it pays (INT-404)
  cacheTtlMinutes: 5,     // how long the model's prompt cache lasts: an "auto" session idle this long ends, and one that wakes less often isn't kept
  warmFactor: 3,          // an "auto" session ends once its context per call passes this many times a fresh start's
  recycleAboveTokens: 120000, // ...or once its context per model call (input + cache read + cache created, averaged over a turn's calls) passes this; 0 = off
  stallMinutes: 10,       // a run with no board call and no output for this long shows as stalled (0 = never)
  recycleAfterRuns: 20,   // a keep-alive session is replaced after this many turns (context grows, memory goes stale)
};

/* Roles: templates that give an agent a brief, wake-up settings and permissions, so nobody has to write
   --allowedTools by hand. They are data (roles.js: the built-ins in roles.json plus the human's own under
   "roles" in agents.json). Permissions come from the library (lib/permissions.js); the run command is built
   from them. An explicit "run" in agents.json still wins (that file is the only place raw commands come from). */
const ROLES = BUILTIN_ROLES; // the built-ins; a board's roles (with the human's own) are api.roleLibrary()
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
// The one rule for a command an agent's "commands" may name: exact, or ending in ":*" for any arguments.
// runFor keeps what passes; the check (checkCommand, POST /api/agents/<name>/commands/check) says why the rest does not.
function commandRule(c) {
  const cmd = String(c ?? '').trim();
  if (!cmd) return { command: cmd, kept: false, why: 'The command is empty' };
  if (COMMAND_RE.test(cmd)) return { command: cmd, kept: true, why: cmd.endsWith(':*') ? 'Kept: allows this command with any arguments' : 'Kept: allowed exactly as written' };
  const why = cmd.length > 200 ? 'Dropped: longer than 200 characters'
    : 'Dropped: only letters, digits and @ . / = + , - : are allowed, with at most one ":*" at the end; no quotes, wildcards or shell punctuation';
  return { command: cmd, kept: false, why };
}
// Does a Claude Bash rule ("Bash(npm test:*)", "Bash(npm run x)") cover a command ("npm test foo", "npm run x:*")?
function ruleCovers(rule, command) {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return false;
  if (!m[1].endsWith(':*')) return m[1] === command;
  const prefix = m[1].slice(0, -2);
  const base = command.endsWith(':*') ? command.slice(0, -2) : command;
  return base === prefix || base.startsWith(`${prefix} `);
}
const commandTools = (commands) => [].concat(commands || []).map((c) => String(c).trim()).filter((c) => commandRule(c).kept).map((c) => `Bash(${c})`);
// library: the board's permission library (built-ins only when not given). Verbal permissions add no tool.
// mcpConfig: one config file or a list (the board's, then the agent's own servers: mcpFor); mcpServers: the names
// of the agent's own servers, whose tools are allowed whole (mcp__<name>).
function runFor(perms = [], { mcpConfig = null, mcpServers = [], commands = [], protect = [], protectWrites = [], library = BUILTIN_LIBRARY } = {}) {
  const extra = commandTools(commands);
  const held = library.resolve(perms);
  const allowed = [...new Set([...held.tools, ...mcpServers.map((s) => `mcp__${s}`), ...extra])];
  const configs = [].concat(mcpConfig || []);
  // --tools names built-in tools only; an MCP tool is allowed by name and loads with its server
  const tools = [...new Set([...BASE_TOOLS, ...allowed.filter((t) => !t.startsWith('mcp__')).map((t) => t.replace(/\(.*$/, ''))])];
  const edits = held.keys.includes('edit');
  // another agent's code runs only with run-authors-code (INT-258); a deny beats the npm test:* allow
  const others = held.keys.includes('run-authors-code') ? [] : RUN_OTHERS;
  return `claude -p ${PROMPT_ARG}${edits ? ' --permission-mode acceptEdits' : ''} --tools "${tools.join(',')}" --strict-mcp-config${configs.length ? ` --mcp-config ${configs.map((c) => `"${c}"`).join(' ')}` : ''}`
    + ` --allowedTools ${['Bash(intellagent:*)', 'mcp__intellagent', ...allowed].map((t) => `"${t}"`).join(' ')}`
    + ` --disallowedTools ${[...denyRules(protect, protectWrites), ...others].map((t) => `"${t}"`).join(' ')}`;
}
// The project's MCP config when it registers the board's server (intellagent init writes it), relative to
// the project's absolute path, since an agent's worktree has no copy (.mcp.json is untracked); null otherwise,
// and the run gets no MCP tools (the CLI still works).
function boardMcpConfig(dir) {
  try {
    const file = path.resolve(dir, '.mcp.json');
    const raw = jsonfile.read(file);
    return raw?.mcpServers?.intellagent ? file : null;
  } catch { return null; }
}

// INT-396: MCP servers of an agent's own, from agents.json ("mcp": { "playwright": { "command": "npx", "args": […] } }),
// so a browser agent needs no hand-written run. Only the human's file sets them (presets refuse mcp*, PATCH can't).
// A name is letters, digits and dashes: its tools are mcp__<name>__<tool>, and an underscore would blur that.
const MCP_NAME_RE = /^[A-Za-z0-9-]{1,40}$/;
const MCP_KEYS = ['command', 'args', 'env', 'type', 'url', 'headers'];
const isTextMap = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
function cleanMcp(mcp) {
  const servers = {};
  const errors = [];
  if (mcp == null) return { servers, errors };
  if (typeof mcp !== 'object' || Array.isArray(mcp)) return { servers, errors: ['"mcp" must be an object of server names to { command, args?, env? } or { type, url }'] };
  for (const [n, s] of Object.entries(mcp)) {
    const bad = (why) => errors.push(`mcp server "${n}": ${why}`);
    if (!MCP_NAME_RE.test(n)) { bad('a name is letters, digits and dashes (max 40)'); continue; }
    if (n.toLowerCase() === 'intellagent') { bad('"intellagent" is the board\'s own server, and every run has it already'); continue; }
    if (!s || typeof s !== 'object' || Array.isArray(s)) { bad('must be { command, args?, env? } or { type, url }'); continue; }
    const unknown = Object.keys(s).filter((k) => !MCP_KEYS.includes(k));
    if (unknown.length) { bad(`unknown key(s) ${unknown.join(', ')} (allowed: ${MCP_KEYS.join(', ')})`); continue; }
    const remote = s.type === 'http' || s.type === 'sse';
    if (remote ? typeof s.url !== 'string' || !/^https?:\/\//.test(s.url) : typeof s.command !== 'string' || !s.command.trim()) { bad(remote ? 'needs a url (http or https)' : 'needs a command'); continue; }
    if (s.type != null && !remote && s.type !== 'stdio') { bad('type is stdio, http or sse'); continue; }
    if (s.args != null && (!Array.isArray(s.args) || s.args.some((a) => typeof a !== 'string'))) { bad('args must be a list of text'); continue; }
    if ((s.env != null && !isTextMap(s.env)) || (s.headers != null && !isTextMap(s.headers))) { bad('env and headers must be objects of names to text'); continue; }
    servers[n] = s;
  }
  return { servers, errors };
}

// A custom claude run gets the agent's servers and commands as flags of their own at the end. Claude's tool lists are
// variadic, so whatever followed --disallowedTools used to land in it; a repeated --allowedTools / --mcp-config adds to its own list.
function withExtras(run, { mcpFile = null, servers = [], commands = [] } = {}) {
  if (!isClaudeRun(run)) return run;
  const allow = [...servers.map((s) => `mcp__${s}`), ...commandTools(commands)];
  return `${run}${mcpFile ? ` --mcp-config "${mcpFile}"` : ''}${allow.length ? ` --allowedTools ${allow.map((t) => `"${t}"`).join(' ')}` : ''}`;
}

// What a custom claude run forbids that looks meant to be allowed (INT-396: extras appended after --disallowedTools forbade
// a supervisor's git merge and browser for an afternoon). Flagged: a tool the run also allows, a whole MCP server
// (mcp__name: not loading it does that), the board's own CLI or server as a whole (one of its subcommands, such as
// sandbox exec, is a real deny), or one of the agent's own commands.
function misplacedDenies(run, { commands = [] } = {}) {
  if (!isClaudeRun(run)) return [];
  const tokens = [...String(run).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  const list = (flags) => tokens.flatMap((t, i) => {
    if (!flags.includes(t)) return [];
    const out = [];
    for (let j = i + 1; j < tokens.length && !tokens[j].startsWith('--'); j++) out.push(tokens[j]);
    return out;
  });
  const allowed = new Set(list(['--allowedTools', '--allowed-tools']));
  const mine = new Set(commandTools(commands));
  return [...new Set(list(['--disallowedTools', '--disallowed-tools']))]
    .filter((t) => allowed.has(t) || /^mcp__[A-Za-z0-9-]+$/.test(t) || t === 'Bash(intellagent:*)' || t === 'mcp__intellagent' || mine.has(t));
}

// How an agent should behave: three dials (0 to 4) and free text, written into its brief as one plain line.
// A dial left out says nothing.
const DIALS = {
  explains: ['Say as little as you can', 'Keep it short', 'Explain as much as the reader needs', 'Explain your reasoning', 'Explain everything, step by step'],
  speed: ['Be very careful: check twice before acting', 'Lean careful', 'Balance care and speed', 'Lean fast', 'Move fast and fix as you go'],
  autonomy: ['Ask before you decide anything', 'Ask when in doubt', 'Ask on the big decisions, decide the small ones', 'Decide most things yourself', 'Decide it yourself and say what you chose'],
};
const personalityLine = (p) => {
  if (!p) return '';
  const parts = Object.entries(DIALS).filter(([k]) => Number.isInteger(p[k])).map(([k, words]) => words[p[k]]);
  const text = String(p.text || '').trim();
  return [parts.length ? `${parts.join('. ')}.` : '', text].filter(Boolean).join(' ');
};

// What makes an agent a specialist: the code it owns (guidance, not a limit), what it always checks, how it
// behaves, and its context: items, or the old agent-context/<name>.md page / inline "context" until they move
// into items. Capped so a long page can't inflate every first turn.
const CONTEXT_MAX = 8000;
function specialityText(def, readContext) {
  const areas = [].concat(def.areas || []).filter(Boolean);
  const concerns = [].concat(def.concerns || []).filter(Boolean);
  const manner = personalityLine(def.personality);
  let ctx = '';
  try { ctx = readContext(def) || ''; } catch { /* missing file */ }
  if (ctx.length > CONTEXT_MAX) ctx = `${ctx.slice(0, CONTEXT_MAX)}\n…(context cut at ${CONTEXT_MAX} characters)`;
  // the custom permissions it holds, verbal ones flagged (set by load; '' when it holds only built-ins)
  const perms = def.permsBrief ? ['', def.permsBrief] : [];
  if (!areas.length && !concerns.length && !ctx.trim() && !manner) return perms.slice(1).join('\n');
  return [
    '## Your speciality',
    ...(areas.length ? ['Code you own — your home ground. Prefer tickets here; when a ticket takes you elsewhere, go, but say so on the card:', ...areas.map((a) => `- \`${a}\``)] : []),
    ...(concerns.length ? ['Concerns you always check before requesting review (say in your review how each was handled):', ...concerns.map((c) => `- ${c}`)] : []),
    ...(manner ? [`How to work: ${manner}`] : []),
    ...(ctx.trim() ? ['', ctx.trim()] : []),
    ...perms,
  ].join('\n');
}

const badRequest = (message, hint) => { const e = new Error(message); e.status = 400; e.code = 'BAD_REQUEST'; if (hint) e.extra = { hint }; return e; };

// personality: { explains?, speed?, autonomy?: 0..4, text? }; null or empty clears it
function cleanPersonality(v) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest('personality must be an object', '{ "explains": 0-4, "speed": 0-4, "autonomy": 0-4, "text": "…" }');
  const bad = Object.keys(v).filter((k) => !(k in DIALS) && k !== 'text');
  if (bad.length) throw badRequest(`Unknown personality key(s): ${bad.join(', ')}`, `Use ${[...Object.keys(DIALS), 'text'].join(', ')}`);
  const out = {};
  for (const k of Object.keys(DIALS)) {
    if (v[k] == null) continue;
    if (!Number.isInteger(v[k]) || v[k] < 0 || v[k] > 4) throw badRequest(`personality.${k} must be a whole number from 0 to 4`, '0 is the first end of the dial, 4 the other');
    out[k] = v[k];
  }
  const text = v.text == null ? '' : String(v.text).trim().slice(0, 500);
  if (text) out.text = text;
  return Object.keys(out).length ? out : null;
}

// context items: [{ id?, kind: note | file | link, title, body | path | url, on? }]
const ITEM_KINDS = { note: 'body', file: 'path', link: 'url' };
function cleanContextItems(v, checkPath) {
  if (v == null) return null;
  if (!Array.isArray(v)) throw badRequest('contextItems must be a list', '[{ "kind": "note", "title": "…", "body": "…" }]');
  if (v.length > 30) throw badRequest('At most 30 context items');
  const ids = new Set();
  return v.map((raw, i) => {
    const at = `contextItems[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest(`${at} must be an object`);
    const key = ITEM_KINDS[raw.kind];
    if (!key) throw badRequest(`${at}.kind must be note, file or link`, 'A note holds text, a file pins a project path, a link is listed as a URL');
    const title = String(raw.title || '').trim().slice(0, 120);
    if (!title) throw badRequest(`${at}.title is required`);
    const val = String(raw[key] ?? '').trim();
    if (!val) throw badRequest(`${at}.${key} is required for a ${raw.kind}`);
    if (val.length > (key === 'body' ? 40_000 : 500)) throw badRequest(`${at}.${key} is too long`);
    if (raw.kind === 'link' && !/^https?:\/\/\S+$/i.test(val)) throw badRequest(`${at}.url must be an http or https address`);
    if (raw.kind === 'file') { const c = checkPath(val); if (!c.ok) { const e = badRequest(`${at}.path: ${c.why}`, 'Pin a file inside the project; never the board\'s own files'); e.status = 403; e.code = 'FORBIDDEN'; throw e; } }
    let id = typeof raw.id === 'string' && /^[\w.-]{1,40}$/.test(raw.id) ? raw.id : `ctx_${crypto.randomBytes(4).toString('hex')}`;
    if (ids.has(id)) id = `ctx_${crypto.randomBytes(4).toString('hex')}`;
    ids.add(id);
    return { id, kind: raw.kind, title, [key]: raw.kind === 'note' ? String(raw.body).replace(/\r\n/g, '\n').trim() : val, on: raw.on !== false, ...(typeof raw.migratedFrom === 'string' ? { migratedFrom: raw.migratedFrom.slice(0, 64) } : {}) };
  });
}
const sha = (t) => crypto.createHash('sha1').update(String(t)).digest('hex');

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
  // the old single page: inline "context", else agent-context/<name>.md (kept on disk as a backup once it has moved into items)
  const legacyContext = (def) => (def.context ? String(def.context) : fs.existsSync(contextPath(def)) ? fs.readFileSync(contextPath(def), 'utf8') : '');
  const norm = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const inside = (child, parent) => { const r = path.relative(norm(parent), norm(child)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  // May a file item pin this path? Inside the project, and never the board's own files (the human's token,
  // agents.json, context pages, board data, git hooks). Checked on every read as well as on save.
  function contextFileCheck(p) {
    const abs = real(path.resolve(cwd, String(p || '')));
    if (!inside(abs, real(cwd))) return { ok: false, why: 'outside the project' };
    const base = path.basename(abs).toLowerCase();
    const off = base === 'local.json' || base === 'agents.json' || norm(abs) === norm(real(file)) || inside(abs, real(contextDir)) || inside(abs, real(path.dirname(stateFile))) || inside(abs, real(path.join(cwd, '.git', 'hooks')));
    if (off) return { ok: false, why: "it is one of the board's own files" };
    return { ok: true, abs };
  }
  // The text of an agent's context items (notes in full, files read fresh, links listed, never fetched).
  function itemsText(items) {
    const links = [];
    const out = [];
    for (const i of items) {
      if (!i || i.on === false) continue;
      if (i.kind === 'link') { links.push(`- ${i.title}: ${i.url}`); continue; }
      if (i.kind === 'file') {
        const c = contextFileCheck(i.path);
        let body;
        if (!c.ok) body = `(not read: ${c.why})`;
        else { try { body = fs.readFileSync(c.abs, 'utf8').trim(); } catch { body = '(not read: the file is missing)'; } }
        out.push(`### ${i.title} (${i.path})\n${body}`);
      } else out.push(`### ${i.title}\n${String(i.body || '').trim()}`);
    }
    if (links.length) out.push(`### Links (not opened for you)\n${links.join('\n')}`);
    return out.join('\n\n');
  }
  const readContext = (def) => (Array.isArray(def.contextItems) ? itemsText(def.contextItems) : legacyContext(def));
  // The mirror (INT-291): agent-context/<name>.md, written from the context items on every change to them, so an
  // agent's instructions show in git diffs beside the code. Generated only: the board never reads it (readContext
  // takes the items). Notes in full; a file item is named, not copied (it is read fresh on every run); links listed.
  function mirrorText(def) {
    const head = `<!-- Generated by Intellagent from ${def.name}'s context items in agents.json. The board never reads this file and overwrites it on the next change: edit the items on the Agents page, or with PATCH /api/agents/${def.name} { contextItems }. -->`;
    const parts = (def.contextItems || []).filter(Boolean).map((i) => {
      const title = `### ${i.title}${i.on === false ? ' (off: not given to the agent)' : ''}`;
      if (i.kind === 'file') return `${title}\nThe file \`${i.path}\`, read fresh on every run.`;
      if (i.kind === 'link') return `${title}\nA link, listed for the agent and never opened: ${i.url}`;
      return `${title}\n${String(i.body || '').trim()}`;
    });
    return `${[head, ...(parts.length ? parts : ['(no context items)'])].join('\n\n')}\n`;
  }
  const readMirror = (def) => { try { return fs.readFileSync(contextPath(def), 'utf8'); } catch { return null; } };
  // Edited by hand: the file is neither the mirror of the items nor the page they were migrated from (untouched).
  function mirrorDrift(def) {
    const raw = readMirror(def);
    if (raw == null || raw.replace(/\r\n/g, '\n') === mirrorText(def)) return false;
    const moved = def.contextItems.find((i) => i?.id === 'context' && i.migratedFrom);
    return !(moved && sha(raw) === moved.migratedFrom);
  }
  // Anything there that isn't the mirror (a hand edit, or the page the items were migrated from) is kept once as
  // <name>.md.bak before it is replaced, so writing the mirror never loses text.
  function writeMirror(def) {
    const f = contextPath(def);
    const text = mirrorText(def);
    const raw = readMirror(def);
    if (raw != null && raw.replace(/\r\n/g, '\n') === text) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (raw != null) fs.copyFileSync(f, `${f}.bak`);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    require('../jsonfile').renameRetry(tmp, f);
  }
  const legacyItems = (d) => { const t = legacyContext(d); return t.trim() ? [{ id: 'context', kind: 'note', title: 'Context', body: t.replace(/\r\n/g, '\n').trim(), on: true }] : []; };
  // the base context every agent starts from: shipped, or the human's copy beside agents.json
  const base = createBase(path.dirname(file));
  // What a first turn is built from, apart from the events: the runner and the preview both take it from here
  const promptOpts = (def) => ({
    listen: [].concat(def.listen || 'inbox').includes('human') ? 'other' : 'inbox',
    base: base.read().text, brief: def.brief || '', speciality: specialityText(def, readContext),
  });
  // the board's own files, wherever they are, for the deny rules of every run built from permissions
  // INT-396: each agent's own MCP servers, written where its run can load them; the folder is read-protected too,
  // since a server's env may carry a key
  const mcpDir = path.join(path.dirname(stateFile), 'agent-mcp');
  const protect = [file, path.join(path.dirname(file), 'local.json'), path.join(contextDir, '**'), base.file, path.join(cwd, '.git', 'hooks', '**'), path.join(mcpDir, '**'), ...(deps.protect || [])];
  const protectWrites = [path.join(path.dirname(stateFile), '**')];
  // The config file for an agent's servers (rewritten only when they change); null and no file when it has none.
  function mcpFor(name, servers) {
    const f = path.join(mcpDir, `${name}.json`);
    if (!Object.keys(servers).length) { fs.rmSync(f, { force: true }); return null; }
    const text = `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
    let now = null;
    try { now = fs.readFileSync(f, 'utf8'); } catch { /* new */ }
    if (now !== text) { fs.mkdirSync(mcpDir, { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); require('../jsonfile').renameRetry(tmp, f); }
    return f;
  }
  let defaults = { ...DEFAULTS };
  let loadError = null;
  let library = BUILTIN_LIBRARY; // built-ins plus agents.json's "perms"
  let roles = createRoles(); // built-ins plus agents.json's "roles"

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
    roles = createRoles(raw.roles);
    const before = Object.keys(defs);
    for (const name of before) delete defs[name];
    const warn = (msg) => { loadError = loadError ? `${loadError}; ${msg}` : msg; }; // every problem, not just the last
    for (const msg of roles.errors) warn(msg);
    for (const [name, d] of Object.entries(raw.agents || {})) {
      if (!/^[\w.-]{1,64}$/.test(name)) { warn(`invalid agent name "${name}"`); continue; }
      const role = roles.get(d.role);
      if (d.role && !role) warn(`agent "${name}": unknown role "${d.role}"`);
      const perms = Array.isArray(d.perms) ? d.perms : role?.perms;
      const commands = d.commands ?? role?.commands;
      const held = library.resolve(perms || []);
      if (held.unknown.length) loadError = `agent "${name}": unknown permission(s) ${held.unknown.join(', ')}`;
      // the one place a role's defaults reach an agent: the role's, then the agent's own keys over them
      const { guidance, errors: guidanceErrors } = cleanGuidance(d.guidance);
      for (const e of guidanceErrors) warn(`agent "${name}": ${e}`);
      const guidanceBy = cleanGuidanceBy(d.guidanceBy, guidance);
      // its own MCP servers (INT-396): none while on probation, whose run reads and nothing more
      const mcp = cleanMcp(d.mcp);
      for (const e of mcp.errors) warn(`agent "${name}": ${e}`);
      const servers = d.probation ? {} : mcp.servers;
      let mcpFile = null;
      try { mcpFile = mcpFor(name, servers); } catch (e) { warn(`agent "${name}": its MCP servers could not be written (${e.message})`); }
      const extras = { mcpFile, servers: mcpFile ? Object.keys(servers) : [], commands };
      defs[name] = {
        ...defaults, ...roles.defaultsOf(role), ...d,
        name, enabled: d.enabled !== false,
        // no explicit run: build it from the role's (or listed) permissions; a hand-written claude run gets the
        // agent's servers and commands as flags of their own
        run: !d.run && perms
          ? runFor(perms, { mcpConfig: [boardMcpConfig(d.cwd ? path.resolve(cwd, d.cwd) : cwd), mcpFile].filter(Boolean), mcpServers: extras.servers, commands, protect, protectWrites, library })
          : withExtras(d.run || defaults.run, extras),
        perms: perms || null, brief: role?.brief || '',
        ...(commands ? { commands } : {}),
        // the human's guidance beside each permission it holds (never enforced; powers' guidance is in the board's brief)
        guidance, guidanceBy, permsBrief: library.briefText(perms || [], guidance, guidanceBy),
        // where the perms come from: its own list, or its role (then a role change changes its tools)
        permsFrom: Array.isArray(d.perms) ? 'own' : role?.perms ? 'role' : null,
        // what it sets itself that its role sets differently (the Agents page's "differs from role" dot)
        differsFromRole: roles.differences(d),
        // agents that edit files (all of them, or some folders) get their own git worktree unless told otherwise
        worktree: d.worktree ?? defaults.worktree ?? (held.keys.includes('edit') || held.tools.some((t) => t.startsWith('Edit('))),
      };
      // INT-233: an agent nobody has met yet. Whatever its file says, its run reads and nothing more (no edit, test,
      // git, commands, worktree or extra servers; a custom run is replaced), so "introduce yourself and stop" is
      // enforced by the run, not asked. The key lives in agents.json: losing state never lifts it.
      if (d.probation) {
        Object.assign(defs[name], {
          probation: typeof d.probation === 'object' ? d.probation : { since: null },
          // a hand-written run (the agent's own, or the file's defaults) can't be narrowed, so it is replaced for the
          // time of probation: only a run this module builds from permissions is sandboxed. Accepted, its own comes back.
          run: runFor(['read'], { mcpConfig: boardMcpConfig(d.cwd ? path.resolve(cwd, d.cwd) : cwd), protect, protectWrites, library }),
          perms: ['read'], permsFrom: 'own', permsBrief: '', worktree: false, keepAlive: false, pickup: false, supervise: false, idleAlarm: false,
        });
        delete defs[name].commands;
      }
      const model = d.model ?? role?.model ?? defaults.model ?? null;
      if (model != null && !MODEL_RE.test(String(model))) { warn(`agent "${name}": model must be a plain name like haiku, sonnet or opus`); defs[name].model = null; }
      else defs[name].model = model;
      // a helper (INT-252) is called by many and assigned by nobody: no pickup, and a low cap unless it sets its own
      if (d.helper === true) {
        defs[name].pickup = false;
        if (d.maxRunsPerHour === undefined) defs[name].maxRunsPerHour = Number(defaults.helperMaxRunsPerHour) || DEFAULTS.helperMaxRunsPerHour;
      } else defs[name].helper = false;
      defs[name].runBase = defs[name].run; // without a model: a run with its own model (runModels) starts from here
      defs[name].run = withModel(defs[name].run, defs[name].model);
      // runModels (INT-308): { triage, build } models by kind of run; absent = every run uses `model`
      const rm = d.runModels ?? defaults.runModels;
      const okModels = rm && typeof rm === 'object' && !Array.isArray(rm) ? Object.entries(rm).filter(([k, v]) => (k === 'triage' || k === 'build') && v != null && MODEL_RE.test(String(v))) : [];
      if (rm != null && okModels.length !== Object.keys(rm).length) warn(`agent "${name}": runModels takes triage and build, each a plain model name like haiku or opus`);
      defs[name].runModels = okModels.length ? Object.fromEntries(okModels.map(([k, v]) => [k, String(v)])) : null;
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
      // a hand-written run (INT-396): what it forbids that looks meant to be allowed, and extras it can't take
      const own = !a.probation && (d.run || !perms) ? d.run || defaults.run : null;
      if (own) {
        const misplaced = misplacedDenies(own, { commands });
        if (misplaced.length) warn(`agent "${name}": its run forbids ${misplaced.map((t) => `"${t}"`).join(', ')}, which look meant to be allowed: they come after --disallowedTools, so Claude forbids them. Move them before it, or use "mcp" and "commands" in agents.json, which the board always allows`);
        if (!isClaudeRun(own) && (Object.keys(servers).length || [].concat(commands || []).length)) warn(`agent "${name}": "mcp" and "commands" only reach a claude run; its own run gets neither`);
      }
      st(name);
      // once there are items the page is only their mirror and is never read; say so when someone edited it by hand
      if (Array.isArray(d.contextItems) && !d.context && mirrorDrift(defs[name])) {
        warn(`agent "${name}": ${path.basename(contextDir)}/${path.basename(contextPath(defs[name]))} was edited by hand, and the board never reads it: it mirrors the agent's context items and is overwritten on their next change (the edit is kept as .bak). Copy the change into the items`);
      }
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
      f.source = typeof l === 'string' ? l : 'filter';
      return f;
    });
  }
  // A probationer wakes only for a request addressed to it (the one that asks it to introduce itself): it must not
  // be set working by a mention, an assignment or an answer, and it must cost no run until it is accepted.
  const wakes = (def, e) => def.probation ? e.type === 'request.created' && String(e.request?.to).toLowerCase() === def.name.toLowerCase() : filtersFor(def).some((f) => matchesFilter(e, f) && !f.skip?.(e));

  // Which of an agent's listen sources an event matches ('addressed', 'human', 'new-tickets', 'inbox', 'filter')
  const wakesBy = (def, e) => (def.probation ? (wakes(def, e) ? ['probation'] : []) : filtersFor(def).filter((f) => matchesFilter(e, f) && !f.skip?.(e)).map((f) => f.source));

  // The agent a name means, whatever its case; undefined when there is none.
  const find = (name) => Object.keys(defs).find((n) => n.toLowerCase() === String(name).toLowerCase());
  const byName = (name) => { const k = find(name); return k ? defs[k] : undefined; };
  function need(name) {
    const hit = find(name);
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
      if (d.role && !roles.has(d.role)) throw badRequest(`Unknown role "${d.role}". Roles: ${roles.keys().join(', ')}`);
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
      if (d.keepAlive !== undefined) { if (d.keepAlive == null) delete next.keepAlive; else next.keepAlive = d.keepAlive === 'stream-json' || d.keepAlive === 'auto' ? d.keepAlive : !!d.keepAlive; }
      // wake settings (INT-370), checked by the server (human only): null goes back to the role's, false overrides it
      for (const k of ['supervise', 'idleAlarm']) if (d[k] !== undefined) { if (d[k] == null) delete next[k]; else next[k] = d[k]; }
      if (d.idleAlarmMinutes !== undefined) { if (d.idleAlarmMinutes == null) delete next.idleAlarmMinutes; else next.idleAlarmMinutes = d.idleAlarmMinutes; }
      for (const k of ['limits', 'grants']) {
        if (d[k] === undefined) continue;
        const empty = d[k] == null || (Array.isArray(d[k]) ? !d[k].length : !Object.keys(d[k]).length);
        if (empty) delete next[k]; else next[k] = d[k];
      }
      if (next.throttleMinutes === null) delete next.throttleMinutes; // blank: back to the role default (maxRunsPerHour null stays: no limit)
      // A new agent (also one re-added after it was removed) starts on probation; an update keeps what it had.
      // Nothing in d can set or clear it: only the human's accept does.
      if (!raw.agents[name]) next.probation = { since: new Date().toISOString(), ...(d.introTicket ? { ticket: String(d.introTicket).toUpperCase().slice(0, 40) } : {}) };
      raw.agents[name] = next;
      const changes = {};      for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
        if (JSON.stringify(prev[k] ?? null) !== JSON.stringify(next[k] ?? null)) changes[k] = { from: prev[k] ?? null, to: next[k] ?? null };
      }
      writeAgentsFile(file, raw);
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
      writeAgentsFile(file, raw);
      // agents.json is the source and is saved: a mirror that can't be written is reported, never a failed change
      let mirrorError = null;
      if (changes.contextItems && Array.isArray(cur.contextItems)) {
        try { writeMirror({ ...cur, name }); } catch (e) { mirrorError = `agent "${name}": the mirror ${path.basename(contextPath({ ...cur, name }))} could not be written (${e.message})`; }
      }
      load();
      if (mirrorError) loadError = loadError ? `${loadError}; ${mirrorError}` : mirrorError;
      recordChange(name, by, changes);
      changed();
      return { changes };
    },
    // Probation (INT-233). The caller has checked it is the human: no grant reaches these.
    probationOf: (name) => { const k = Object.keys(defs).find((n) => n.toLowerCase() === String(name).toLowerCase()); return (k && defs[k].probation) || null; },
    // The introduction is accepted: it works like any agent from now on (`wake`: the sweep finds its work).
    acceptProbation(name, by) {
      name = need(name);
      const raw = readAgentsFile(file, { agents: {} });
      const cur = raw.agents?.[name];
      if (!cur?.probation) { const e = new Error(`${name} is not on probation`); e.status = 409; e.code = 'CONFLICT'; throw e; }
      const from = cur.probation;
      delete cur.probation;
      jsonfile.writeAtomic(file, raw);
      load();
      recordChange(name, by, { probation: { from, to: null } });
      changed();
      return view(name);
    },
    // Sent back: it stays on probation, with the human's note kept beside it.
    returnProbation(name, note, by) {
      name = need(name);
      const raw = readAgentsFile(file, { agents: {} });
      const cur = raw.agents?.[name];
      if (!cur?.probation) { const e = new Error(`${name} is not on probation`); e.status = 409; e.code = 'CONFLICT'; throw e; }
      const from = cur.probation;
      cur.probation = { ...(typeof from === 'object' ? from : {}), returned: { note: String(note || '').slice(0, 2000), at: new Date().toISOString() } };
      jsonfile.writeAtomic(file, raw);
      load();
      recordChange(name, by, { probation: { from, to: cur.probation } });
      changed();
      return view(name);
    },
    // The permission library (INT-228). The caller has checked it is the human; agents only read it.
    permissionLibrary: () => library,
    // The roles (INT-229): built-ins plus the human's own from agents.json. Read only through the API.
    roleLibrary: () => roles,
    // Add or replace one of the human's own roles (INT-370). The caller has checked it is the human and that d
    // carries no commands, run, env or grants; cleanRole checks the rest, as load does. Commands the human wrote
    // into agents.json by hand are kept: the API never sets them, so it never takes them away either.
    // → { role (the stored view), before (as stored, or null) }
    defineRole(key, d) {
      key = String(key || '').trim();
      const raw = readAgentsFile(file, { agents: {} });
      const all = raw.roles && typeof raw.roles === 'object' && !Array.isArray(raw.roles) ? raw.roles : {};
      const before = Object.hasOwn(all, key) ? all[key] : null;
      const next = { ...d, ...(before?.commands != null ? { commands: before.commands } : {}) };
      try { cleanRole(key, next); } catch (e) { throw badRequest(e.message); }
      raw.roles = { ...all, [key]: next };
      writeAgentsFile(file, raw);
      load();
      changed();
      return { role: roles.view(key), before };
    },
    // Add or replace a custom permission (patch: merged over the stored one when merge is set). check(before,
    // after), both as cleanPerm stores them (before null for a new one), runs before anything is written and may
    // throw: it sees exactly what would be stored (INT-349).
    definePerm(key, d, { merge = false, check = null } = {}) {
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
      if (check) check(library.custom()[key] || null, lib.custom()[key]);
      const before = perms[key] ?? null;
      raw.perms = next;
      writeAgentsFile(file, raw);
      load();
      changed();
      return { permission: library.get(key), before };
    },
    // Remove a custom permission no agent and no other permission uses.
    // check(before) as for definePerm: before as stored, or null for an entry that doesn't check out.
    removePerm(key, { check = null } = {}) {
      const raw = readAgentsFile(file, { agents: {} });
      const perms = raw.perms || {};
      if (!Object.hasOwn(perms, key)) { const e = new Error(library.get(key)?.builtin ? `"${key}" is a built-in permission` : `No custom permission "${key}"`); e.status = library.get(key)?.builtin ? 409 : 404; e.code = e.status === 409 ? 'CONFLICT' : 'NOT_FOUND'; throw e; }
      if (check) check(library.custom()[key] || null);
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
      writeAgentsFile(file, raw);
      load();
      changed();
      return { removed: key, before };
    },
    specialityOf: (name) => { const d = defs[need(name)]; return specialityText(d, readContext); },
    contextOf: (name) => readContext(defs[need(name)]),
    // { text, shipped, edited } · setBaseContext returns the text agents got before
    baseContext: () => base.read(),
    setBaseContext: (text) => base.write(text),
    // The first-turn prompt's layers for one agent ({ layer, label, text, chars }), for the layers view
    layersOf: (name) => layersFor(promptOpts(defs[need(name)])),
    // The first turn the board would send this agent now, built by the runner's own code with no events
    // (INT-240's preview). Only a worktree catch-up note, known only once a run starts, can differ.
    previewOf(name, { workspace = null, evFile = '<events file>' } = {}) {
      name = need(name);
      const opts = promptOpts(defs[name]);
      return { text: promptFor(name, [], { ...opts, evFile, workspace }), layers: layersFor(opts) };
    },
    contextItemsOf: (name) => (Array.isArray(defs[need(name)].contextItems) ? defs[name].contextItems : null),
    checkContextPath: (p) => { const { ok, why } = contextFileCheck(p); return { ok, ...(ok ? {} : { why }) }; },
    // The agent's items with its "Context" note set to this text (empty removes the note): what the old context
    // page was, as one item. The caller saves the list through manage, so it is in the history in full.
    itemsWithNote(name, text) {
      const d = defs[need(name)];
      const items = (Array.isArray(d.contextItems) ? d.contextItems : legacyItems(d)).filter((i) => i.id !== 'context');
      return String(text || '').trim() ? [{ id: 'context', kind: 'note', title: 'Context', body: String(text).replace(/\r\n/g, '\n').trim(), on: true }, ...items] : items;
    },
    // Move every agent still on the old page (agent-context/<name>.md or inline "context") into one note item,
    // through manage so it shows in its history. Once an agent has items the page is not read again, so a
    // restart never moves it twice. The page stays on disk as a backup.
    migrateContext() {
      for (const name of Object.keys(defs)) {
        const d = defs[name];
        if (Array.isArray(d.contextItems)) continue;
        let text = '';
        try { text = legacyContext(d); } catch { continue; }
        if (!text.trim()) continue;
        api.manage(name, { contextItems: [{ id: 'context', kind: 'note', title: 'Context', body: text.replace(/\r\n/g, '\n').trim().slice(0, 40_000), on: true, migratedFrom: sha(text) }], context: null }, { kind: 'system', name: 'intellagent' });
      }
    },
    // What would become of a command listed in this agent's "commands": kept or dropped (commandRule, the rule
    // runFor applies), already allowed by a permission it holds, and denied by the run (another agent's code
    // without run-authors-code: a deny beats an allow). Changes nothing.
    checkCommand(name, command) {
      const d = defs[need(name)];
      const out = { agent: d.name, ...commandRule(command), listed: [].concat(d.commands || []).map((c) => String(c).trim()).includes(String(command ?? '').trim()), allowedBy: [], denied: null };
      if (!d.perms) {
        if (!isClaudeRun(d.run)) return { ...out, applies: false, note: 'This agent\'s own run is not a claude run, so "commands" does nothing for it' };
        // INT-396: a hand-written claude run gets its commands as an --allowedTools flag of its own; what the run itself forbids still wins
        Object.assign(out, { applies: true, note: 'This agent has its own claude run: the command is added to it as an --allowedTools flag of its own' });
        if (out.kept && misplacedDenies(d.run, { commands: [out.command] }).includes(`Bash(${out.command})`)) {
          out.denied = { needs: null, why: 'its own run lists it after --disallowedTools, and a deny beats an allow: move it out of that list' };
          out.why = `Kept, but denied: ${out.denied.why}`;
        }
        return out;
      }
      out.applies = true;
      if (!out.kept) return out;
      const held = library.resolve(d.perms);
      out.allowedBy = held.keys.filter((k) => library.resolve([k]).tools.some((t) => ruleCovers(t, out.command)));
      if (!held.keys.includes('run-authors-code') && RUN_OTHERS.some((r) => ruleCovers(r, out.command))) {
        out.denied = { needs: 'run-authors-code', why: "it runs another agent's code; the run denies it unless the agent holds run-authors-code, and a deny beats an allow" };
        out.why = `Kept, but denied: ${out.denied.why}`;
      } else if (out.allowedBy.length) out.why = `${out.why}; already allowed by ${out.allowedBy.join(', ')}`;
      return out;
    },
    limitsOf: (name) => byName(name)?.limits || null,
    remove(name) {
      name = need(name);
      const raw = readAgentsFile(file);
      delete raw.agents[name];
      endSession(name);
      writeAgentsFile(file, raw);
      load();
      changed();
      return { removed: name };
    },
    // grants come only from agents.json (define() never writes them)
    grantsOf: (name) => byName(name)?.grants || [],
    // guidance comes only from agents.json too (define() never writes it): { "<permission key>": "text" }
    guidanceOf: (name) => byName(name)?.guidance || {},
    // A supervising agent (the receptionist) is told about other agents' stalled tickets; returns minutes or 0.
    superviseOf: (name) => { const d = defs[name]; return d?.enabled && d.supervise ? Number(d.superviseMinutes) || 30 : 0; },
    // without regard to capitals, as waking matches names: "Cosmo" must not slip past a check that "cosmo" fails
    helperOf: (name) => !!byName(name)?.helper,
    pickupOf: (name) => defs[name]?.pickup && defs[name].enabled ? (defs[name].pickup === true ? 'ready' : defs[name].pickup) : false,
  };

  return { api, load, need, wakes, wakesBy, readContext, contextPath, base, promptOpts, loadError: () => loadError, migrateContext: () => api.migrateContext() };
}

module.exports = { createConfig, readAgentsFile, writeAgentsFile, DEFAULTS, ROLES, PERMS, TIERS, MODEL_RE, PROMPT_ARG, runFor, commandRule, cleanMcp, withExtras, misplacedDenies, withModel, withJsonOutput, keepAliveCmd, isClaudeRun, boardMcpConfig, specialityText, cleanPersonality, cleanContextItems };
