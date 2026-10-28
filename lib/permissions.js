'use strict';
/* The permission library (INT-228): every permission a standing agent can hold, as data.

   Built-ins come from code and can't be changed or removed:
     PERMS   tools a run is built from (read, edit, test, build, git, web, run-authors-code, call-helpers); held through "perms"
     POWERS  board powers that are human-only by default; held through "grants" (server.js checks them)
   Custom ones are the human's, in agents.json under "perms", beside "agents":
     "perms": { "deploy-staging": { "kind": "command", "name": "Deploy to staging", "commands": ["npm run deploy:staging"] } }
   and an agent holds them like a built-in: "perms": ["edit", "test", "deploy-staging"].

   Kinds of custom permission:
     command  exact commands, or one ending in ":*" (same rule as an agent's "commands")
     tool     a Claude or MCP tool by name (never Bash: that is a command)
     folders  Edit and Write limited to globs relative to the agent's folder
     bundle   several permissions under one name ("includes")
     verbal   only words: the agent reads it in its brief and nothing enforces it
   "needs" lists other permissions that come with it; holding it brings them too.
   Bundles and needs never reach a power: powers are only ever held through grants. */

// Null-prototype maps: keys come from people's files and requests, so "constructor" or "toString" must not
// look like a permission or a power.
const map = (o) => Object.assign(Object.create(null), o);
const PERMS = map({
  edit: { label: 'Edit files', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] },
  read: { label: 'Read files', tools: ['Read', 'Grep', 'Glob'] },
  test: { label: 'Run tests', tools: ['Bash(npm test)', 'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npx vitest:*)', 'Bash(npx jest:*)', 'Bash(pnpm test:*)', 'Bash(yarn test:*)', 'Bash(node --test)', 'Bash(node --test:*)'] },
  build: { label: 'Build & lint', tools: ['Bash(npm run build:*)', 'Bash(npm run lint:*)', 'Bash(npx tsc:*)', 'Bash(npx eslint:*)'] },
  // git merge main (and --abort) only: an agent catches its own branch up and resolves its own conflicts;
  // its worktree is its own branch, so this never touches main (landing stays with the human's approval).
  git: { label: 'Git', tools: ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git merge main)', 'Bash(git merge --abort)'] },
  web: { label: 'Web research', tools: ['WebSearch', 'WebFetch'] },
  // Running code from another agent's branch (INT-258): intellagent sandbox exec, which asks the board for it
  // (GET /api/permissions/me), and another worktree's tests, which a run without it is denied (RUN_OTHERS).
  'run-authors-code': { label: "Run an author's code", tools: [], needs: ['read', 'test'] },
  // Sending a request to a helper agent ("helper": true in agents.json, INT-252): no tool, the board checks it
  // when the request is made. The Builder role holds it.
  'call-helpers': { label: 'Call on the helpers', tools: [] },
});
// What a run without run-authors-code may not do: run the tests of another folder (npm test --prefix
// .worktrees/<author>). Prefix rules, so a speed bump like the other deny rules, not a wall.
const RUN_OTHERS = ['Bash(npm test --prefix:*)', 'Bash(npm --prefix:*)', 'Bash(npm run test --prefix:*)', 'Bash(pnpm test --dir:*)', 'Bash(pnpm --dir:*)', 'Bash(yarn test --cwd:*)', 'Bash(yarn --cwd:*)', 'Bash(intellagent sandbox exec:*)'];
// node --test takes files, never flags (INT-195, INT-431): "--import=data:…" would run any code. Node reads options
// only up to the first file, so denying a flag right after --test (bare or quoted) is enough; a deny beats node --test:*.
const TEST_FLAGS = ['Bash(node --test -*)', 'Bash(node --test "-*)', "Bash(node --test '-*)"];
const POWERS = map({
  'review.decide': 'Decide reviews (approve / request changes)',
  'column.gate': 'Move tickets into / out of human-only columns',
  'agents.control': 'Pause, resume and run other standing agents',
  'agents.manage': "Change other standing agents' label, role, personality and model (allowlist), and narrow their permissions",
  'work.land': 'Land work that was already approved on main (resolving conflicts on its own branch first)',
});
// Short titles for the library and the permission pages: one line each. POWERS keeps the full sentence, for briefs
// and descriptions.
const POWER_NAMES = {
  'review.decide': 'Approve reviews',
  'column.gate': 'Move through gates',
  'agents.control': 'Run other agents',
  'agents.manage': 'Manage other agents',
  'work.land': 'Merge approved work into main',
};
const PERM_TEXT = {
  edit: 'Read, create and change files in its folder.',
  read: 'Read and search files; change nothing.',
  test: 'Run the project\'s tests (npm test and the usual test runners).',
  build: 'Run the build, the linter and the type checker.',
  git: 'Status, diff and log; commit its changes and merge main into its own branch. Never push or touch main.',
  web: 'Search the web and fetch pages.',
  'run-authors-code': "Run another agent's code to review it: intellagent sandbox exec, and the tests in another agent's worktree. Only for a ticket you are reviewing, only in your own sandbox.",
  'call-helpers': 'Send a request to a helper agent for a chore on your ticket: a test run, logs or numbers, a fixture, a small exact edit. Never a whole ticket: you keep the ticket, its lease and its review.',
};

// Board admin (INT-256): the human-only board settings the human can hand out one by one, each a power held
// through grants. The server checks each one (adminGate); the human's "admin off" switch suspends them all.
// admin.permissions (INT-349) is checked by the grid and library routes, through the escalation rules below.
const ADMIN = map({
  'admin.permissions': "Grant and revoke other agents' permissions, rules and guidance, and add or edit custom permissions, never beyond what it holds itself",
  'admin.columns': 'Change column flags, order, and add or delete columns',
  'admin.rules': 'Change the board rules (directives)',
  'admin.coordinator': 'Choose the coordinator',
  'admin.fields': 'Change the built-in field settings',
  'admin.focus': 'Make, retire and activate focus boards',
  'admin.cardRules': 'Change the card rules',
  'admin.rebalancing': 'Change automatic rebalancing (on, off, its settings)',
  // James (2026-10-24): permission requests go to the coordinator, and the coordinator grants them. With
  // admin.permissions, it lifts "only what it holds" and "commands only narrow"; never its own row or a board power.
  'admin.permit': "Grant other agents the command, tool and folder permissions they ask for, beyond what it holds itself (with admin.permissions)",
});
const ADMIN_NAMES = {
  'admin.permissions': 'Can edit permissions',
  'admin.columns': 'Can edit columns',
  'admin.rules': 'Can edit board rules',
  'admin.coordinator': 'Can choose the coordinator',
  'admin.fields': 'Can edit built-in field settings',
  'admin.focus': 'Can run focus boards',
  'admin.cardRules': 'Can edit card rules',
  'admin.rebalancing': 'Can switch rebalancing',
  'admin.permit': 'Can grant permissions',
};
for (const k of Object.keys(ADMIN)) {
  POWERS[k] = ADMIN[k];
  POWER_NAMES[k] = ADMIN_NAMES[k];
}
// "admin": every power at once, for handing the board over. Not a power of its own: a grant of it is read as one
// grant of each power it covers (with the same scope), so every check, switch and limit applies to each.
// The list is frozen, not read from POWERS: a power added later (admin.permissions) never joins it by itself, so
// an agent the human gave "admin" gains nothing new on an update. A new power is granted by name.
const ADMIN_BUNDLE = 'admin';
const ADMIN_COVERS = Object.freeze(['review.decide', 'column.gate', 'agents.control', 'agents.manage', 'work.land',
  'admin.columns', 'admin.rules', 'admin.coordinator', 'admin.fields', 'admin.focus', 'admin.cardRules', 'admin.rebalancing']);
const adminCovers = () => ADMIN_COVERS.filter((k) => POWERS[k]);
const isPowerKey = (k) => !!POWERS[k] || !!ADMIN[k] || k === ADMIN_BUNDLE;

// What an agent holds, for the escalation rule: its permissions with bundles and needs expanded, and its powers
// (a grant's scope and rules aside: a scoped grant still counts as holding the power).
function holdings(lib, agent) {
  const powers = [].concat(agent?.grants || []).map((g) => (typeof g === 'string' ? g : g?.power)).filter(Boolean);
  return new Set([...lib.resolve(agent?.perms || []).keys, ...powers]);
}
// What turning these keys on brings: permissions expanded the same way, powers as they are.
function brings(lib, keys) {
  const ks = [].concat(keys || []).map(String);
  return new Set([...lib.resolve(ks.filter((k) => !isPowerKey(k))).keys, ...ks.filter(isPowerKey)]);
}

/* The escalation rule (INT-256): may `holder`, an agent with admin.permissions, turn `keys` on or off for
   `target`? holder: its agents.json entry ({ name, perms, grants }); target: the other agent's name; keys:
   permission and power keys the change turns on, or off (James, on the card: it takes away only what it could
   grant, so one admin agent can't strip another).
   Board powers are never its to hand out or take, whether it holds them or not: they stay the human's.
   Returns the refusals, [] when allowed. Each is { code, reason, missing?, powers? }; the server answers any of
   them with 403 NO_ESCALATION. Codes: OWN_ROW, BEYOND_HELD (missing: the permissions it doesn't hold, sorted),
   BOARD_POWER (powers: the power keys, sorted; admin.permissions among them). */
function escalation(lib, holder, target, keys) {
  const held = holdings(lib, holder);
  const adds = brings(lib, keys);
  const out = [];
  if (String(target || '').toLowerCase() === String(holder?.name || '').toLowerCase()) {
    out.push({ code: 'OWN_ROW', reason: 'An agent never changes its own permissions' });
  }
  const missing = held.has('admin.permit') ? [] : [...adds].filter((k) => !isPowerKey(k) && !held.has(k)).sort();
  if (missing.length) out.push({ code: 'BEYOND_HELD', reason: `Only what it holds itself; it does not hold ${missing.join(', ')}`, missing });
  const powers = [...adds].filter(isPowerKey).sort();
  if (powers.length) out.push({ code: 'BOARD_POWER', reason: `Board powers are the human's to give and take: ${powers.join(', ')}`, powers });
  return out;
}

/* The same rule for the library (INT-349): editing a permission hands its new contents to everyone who holds it.
   before / after: the stored definitions (cleanPerm's shape), null for a create / a delete. Codes, besides
   BEYOND_HELD (new includes or needs it doesn't hold):
     HELD_ITSELF  a permission the editor holds: editing it would widen its own row through a side door
     HUMAN_KIND   command, tool and folders permissions allow tools: creating, removing or turning another kind
                  into one is the human's
     NARROW_ONLY  a command, tool or folders permission may only lose entries (added: what it would gain) */
const NARROW = { command: 'commands', tool: 'tools', folders: 'folders' };
function libraryEscalation(lib, holder, key, before, after) {
  const held = holdings(lib, holder);
  const out = [];
  if (before && held.has(key)) out.push({ code: 'HELD_ITSELF', reason: `${holder.name} holds ${key} itself: changing it would change its own permissions` });
  const was = before?.kind;
  const now = after?.kind;
  if (held.has('admin.permit')) {
    // may add, widen or remove command, tool and folders permissions; HELD_ITSELF above still guards its own row
  } else if ((!before && NARROW[now]) || (!after && NARROW[was]) || (before && after && NARROW[now] && was !== now)) {
    out.push({ code: 'HUMAN_KIND', reason: `Only the human ${!before ? 'adds' : !after ? 'removes' : 'makes'} a ${now || was} permission: it allows tools` });
  } else if (before && after && NARROW[now]) {
    const f = NARROW[now];
    const added = (after[f] || []).filter((x) => !(before[f] || []).includes(x));
    if (added.length) out.push({ code: 'NARROW_ONLY', reason: `A ${now} permission may only narrow; ${key} would gain ${added.join(', ')}`, added });
  }
  const old = new Set([...(before?.includes || []), ...(before?.needs || [])]);
  const fresh = [...(after?.includes || []), ...(after?.needs || [])].filter((k) => !old.has(k));
  const missing = [...brings(lib, fresh)].filter((k) => !held.has(k) && !(held.has('admin.permit') && !isPowerKey(k))).sort();
  if (missing.length) out.push({ code: 'BEYOND_HELD', reason: `Only what it holds itself; it does not hold ${missing.join(', ')}`, missing });
  return out;
}

const KINDS = ['command', 'tool', 'folders', 'bundle', 'verbal'];
const KEY_RE = /^[a-z][\w.-]{0,63}$/i;
// an agent's "commands" rule: each allowed exactly as written; a trailing ":*" allows any arguments
const COMMAND_RE = /^[\w@./=+, -][\w@./:=+, -]{0,199}?(:\*)?$/;
// a Claude tool (WebFetch) or an MCP tool (mcp__server or mcp__server__tool); no rule in brackets
const TOOL_RE = /^(mcp__[\w-]{1,64}(__[\w-]{1,64})?|[A-Z][A-Za-z]{1,63})$/;
// a glob relative to the agent's folder: no absolute paths, no "..", nothing a shell or a rule would read
const FOLDER_RE = /^(?!\/|[A-Za-z]:|~)(?!.*(^|\/)\.\.(\/|$))[\w@.*/+-]{1,200}$/;
const NOT_ENFORCED = 'not enforced: the agent is trusted to follow it, and it could be dangerous on its own';

const badRequest = (message, hint) => { const e = new Error(message); e.status = 400; e.code = 'BAD_REQUEST'; if (hint) e.extra = { hint }; return e; };
const conflict = (message, hint) => { const e = new Error(message); e.status = 409; e.code = 'CONFLICT'; if (hint) e.extra = { hint }; return e; };
const list = (v) => [...new Set([].concat(v ?? []).map((x) => String(x).trim()).filter(Boolean))];
const text = (v, n) => (v == null ? '' : String(v).trim().slice(0, n));

/* Guidance (INT-230): the human's words beside a permission an agent holds, read in its brief and never
   enforced. In agents.json, per agent: "guidance": { "review.decide": "Docs tickets only, and say why", "edit": "…" }.
   Keys are permission or power keys; entries that aren't text under a known-looking key are dropped, never
   guessed at. Returns { guidance, errors }. */
const GUIDANCE_MAX = 1000;
function cleanGuidance(raw) {
  const guidance = map({});
  const errors = [];
  if (raw == null) return { guidance, errors };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { guidance, errors: ['"guidance" must be an object of permission keys to text'] };
  for (const [k, v] of Object.entries(raw)) {
    if (!KEY_RE.test(k)) { errors.push(`guidance "${k}": not a permission key`); continue; }
    if (v == null || v === '') continue;
    if (typeof v !== 'string') { errors.push(`guidance "${k}": must be text`); continue; }
    const t = v.trim().slice(0, GUIDANCE_MAX);
    if (t) guidance[k] = t;
  }
  return { guidance, errors };
}
/* Who wrote each guidance entry an agent with admin.permissions wrote (INT-349): "guidanceBy": { "<key>": "<agent>" }
   beside "guidance". A key without an entry is the human's, so every agents.json written before stays as it reads. */
const AGENT_NAME_RE = /^[\w.-]{1,64}$/;
function cleanGuidanceBy(raw, guidance) {
  const by = map({});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return by;
  for (const [k, v] of Object.entries(raw)) if (Object.hasOwn(guidance, k) && typeof v === 'string' && AGENT_NAME_RE.test(v)) by[k] = v;
  return by;
}
// How guidance reads in a brief: always marked, so the agent never mistakes it for something the board checks,
// nor an agent's words for the human's.
const guidanceLine = (t, by = null) => `Guidance from ${by ? `${by}, an agent acting for the human,` : 'the human'} (not enforced): ${String(t).replace(/\s*\n\s*/g, ' ')}`;
// A library entry's words as they read in a brief: marked when an agent wrote them.
const briefOf = (n) => (n.brief ? ` — ${n.brief}${n.by ? ` (written by ${n.by}, an agent acting for the human)` : ''}` : '');

const BUILTINS = [
  ...Object.entries(PERMS).map(([key, p]) => ({
    key, kind: 'builtin', name: p.label, description: PERM_TEXT[key], allows: { tools: p.tools }, needs: p.needs || [], brief: '', builtin: true, enforced: true, heldBy: 'perms',
  })),
  ...Object.entries(POWERS).map(([key, label]) => ({
    key, kind: 'power', name: POWER_NAMES[key] || label, description: `${label}. Human-only unless the human grants it.`, allows: { powers: [key] }, needs: [], brief: '', builtin: true, enforced: true, heldBy: 'grants',
    ...(ADMIN[key] ? { group: 'Board admin' } : {}),
  })),
  { key: ADMIN_BUNDLE, kind: 'power', name: 'Admin', description: 'Every board power at once (each one checked, switched off and limited on its own). Human-only unless the human grants it.', allows: { powers: adminCovers() }, needs: [], brief: '', builtin: true, enforced: true, heldBy: 'grants', group: 'Board admin' },
];

// A custom definition as stored, checked. known(key): is that key in the library (for includes and needs)?
function cleanPerm(key, d, known) {
  if (!KEY_RE.test(String(key || ''))) throw badRequest('Permission key: a letter, then letters, digits, dot, dash or underscore (max 64)');
  if (BUILTINS.some((b) => b.key.toLowerCase() === String(key).toLowerCase())) throw conflict(`"${key}" is a built-in permission`, 'Built-ins can\'t be changed; pick another key');
  if (String(key).toLowerCase() === 'me') throw badRequest('"me" is reserved');
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw badRequest(`Permission "${key}" must be an object`);
  if (!KINDS.includes(d.kind)) throw badRequest(`Permission "${key}": kind must be one of ${KINDS.join(', ')}`);
  const out = { kind: d.kind, name: text(d.name, 120) || key };
  if (d.description) out.description = text(d.description, 2000);
  if (d.brief) out.brief = text(d.brief, 2000);
  // the agent that last wrote its name, description or brief (INT-349); the server sets it, never the body
  if (typeof d.by === 'string' && AGENT_NAME_RE.test(d.by)) out.by = d.by;
  const needs = list(d.needs);
  if (d.kind === 'command') {
    const cs = list(d.commands ?? d.command);
    if (!cs.length) throw badRequest(`Permission "${key}": give "commands", e.g. ["npm run deploy:staging"]`);
    const bad = cs.filter((c) => !COMMAND_RE.test(c));
    if (bad.length) throw badRequest(`Permission "${key}": ${bad.join(', ')} is not a plain command`, 'Exact words, or one trailing ":*" for any arguments; no quotes, wildcards or shell punctuation');
    out.commands = cs;
  } else if (d.kind === 'tool') {
    const ts = list(d.tools ?? d.tool);
    if (!ts.length) throw badRequest(`Permission "${key}": give "tools", e.g. ["WebFetch"] or ["mcp__github"]`);
    const bad = ts.filter((t) => !TOOL_RE.test(t) || t === 'Bash');
    if (bad.length) throw badRequest(`Permission "${key}": ${bad.join(', ')} is not a tool name`, 'A Claude tool (WebFetch) or an MCP tool (mcp__server__tool); commands go in a "command" permission');
    out.tools = ts;
  } else if (d.kind === 'folders') {
    const globs = list(d.folders).map((f) => f.replace(/\\/g, '/'));
    if (!globs.length) throw badRequest(`Permission "${key}": give "folders", e.g. ["docs/**"]`);
    const bad = globs.filter((f) => !FOLDER_RE.test(f));
    if (bad.length) throw badRequest(`Permission "${key}": ${bad.join(', ')} is not a relative glob`, 'Relative to the agent\'s folder, no "..", e.g. docs/** or src/ui/*.css');
    out.folders = globs;
  } else if (d.kind === 'bundle') {
    const inc = list(d.includes);
    if (!inc.length) throw badRequest(`Permission "${key}": a bundle "includes" other permissions`);
    out.includes = inc;
  } else if (d.kind === 'verbal' && !out.brief) {
    throw badRequest(`Permission "${key}": a verbal permission is its words — give "brief", the line the agent reads`);
  }
  for (const k of [...(out.includes || []), ...needs]) {
    if (isPowerKey(k)) throw badRequest(`Permission "${key}": ${k} is a power`, 'Powers are held only through grants, never inside a bundle or as a need');
    if (!known(k)) throw badRequest(`Permission "${key}": unknown permission "${k}"`);
  }
  if (needs.length) out.needs = needs;
  return out;
}

/**
 * The library for one agents.json: built-ins plus the custom "perms" it holds. Read-only; the writes are in
 * config.js (agents.json has one writer). raw: the file's "perms" object (anything malformed is skipped and
 * reported in errors, so one bad entry never takes the agents down).
 */
function createLibrary(raw = {}) {
  const custom = map({});
  const errors = [];
  const entries = Object.entries(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
  const known = (k) => !!PERMS[k] || entries.some(([n]) => n === k);
  for (const [key, d] of entries) {
    try { custom[key] = cleanPerm(key, d, known); } catch (e) { errors.push(e.message); }
  }
  // A folders permission that brings Edit or Write everywhere (needing edit, say) would limit nothing while
  // its name says it does: refuse it.
  const writesEverywhere = (k, seen = new Set()) => {
    if (seen.has(k)) return null;
    seen.add(k);
    const tools = PERMS[k]?.tools || (custom[k]?.kind === 'tool' ? custom[k].tools : []);
    if (tools.some((t) => t === 'Edit' || t === 'Write')) return k;
    for (const n of [...(custom[k]?.includes || []), ...(custom[k]?.needs || [])]) { const w = writesEverywhere(n, seen); if (w) return w; }
    return null;
  };
  for (const [key, d] of Object.entries(custom)) {
    const wide = d.kind === 'folders' && (d.needs || []).map((n) => writesEverywhere(n)).find(Boolean);
    if (wide) { delete custom[key]; errors.push(`Permission "${key}": it needs ${wide}, which allows Edit and Write everywhere, so its folder limit would mean nothing. Need read instead, or give the agent edit itself`); }
  }
  // drop entries that include or need one that was dropped, until nothing changes
  for (let again = true; again;) {
    again = false;
    for (const [key, d] of Object.entries(custom)) {
      const missing = [...(d.includes || []), ...(d.needs || [])].find((k) => !PERMS[k] && !custom[k]);
      if (missing) { delete custom[key]; errors.push(`Permission "${key}": "${missing}" is not usable`); again = true; }
    }
  }
  // a cycle (a bundle including itself, a need needing it back) is harmless to expand, but almost certainly a slip
  for (const key of Object.keys(custom)) {
    const seen = new Set();
    const walk = (k) => { for (const n of [...(custom[k]?.includes || []), ...(custom[k]?.needs || [])]) { if (n === key) return true; if (!seen.has(n)) { seen.add(n); if (walk(n)) return true; } } return false; };
    if (walk(key)) errors.push(`Permission "${key}" includes or needs itself`);
  }

  const view = (key, d) => ({
    key, kind: d.kind, name: d.name, description: d.description || '',
    allows: { ...(d.commands ? { commands: d.commands } : {}), ...(d.tools ? { tools: d.tools } : {}), ...(d.folders ? { folders: d.folders } : {}), ...(d.includes ? { includes: d.includes } : {}) },
    needs: d.needs || [], brief: d.brief || '', builtin: false, enforced: d.kind !== 'verbal', heldBy: 'perms',
    ...(d.by ? { by: d.by } : {}),
    ...(d.kind === 'verbal' ? { warning: NOT_ENFORCED } : {}),
  });
  const has = (k) => !!PERMS[k] || !!custom[k];

  // Everything a list of permission keys brings: bundles and needs expanded (never a power), the tool rules
  // for the run, and the lines for the brief. Unknown keys are reported, never guessed at.
  function resolve(keys = []) {
    const out = new Set();
    const unknown = [];
    const add = (k) => {
      if (out.has(k)) return;
      if (!has(k)) { unknown.push(k); return; }
      out.add(k);
      for (const n of [...(PERMS[k]?.needs || []), ...(custom[k]?.includes || []), ...(custom[k]?.needs || [])]) add(n);
    };
    for (const k of [].concat(keys || [])) add(String(k));
    const held = [...out];
    const rules = held.flatMap((k) => {
      if (PERMS[k]) return PERMS[k].tools;
      const d = custom[k];
      if (d.kind === 'command') return d.commands.map((c) => `Bash(${c})`);
      if (d.kind === 'tool') return d.tools;
      if (d.kind === 'folders') return d.folders.flatMap((f) => [`Edit(${f})`, `Write(${f})`]);
      return []; // bundle: its parts are in held; verbal: words only
    });
    const notes = held.filter((k) => custom[k] && custom[k].kind !== 'bundle').map((k) => ({ key: k, name: custom[k].name, brief: custom[k].brief || custom[k].description || '', enforced: custom[k].kind !== 'verbal', ...(custom[k].by ? { by: custom[k].by } : {}) }));
    return { keys: held, tools: [...new Set(rules)], notes, unknown };
  }

  // The brief's section for an agent's custom permissions, and the human's guidance beside any permission it
  // holds (built-ins too); '' when there is neither (so existing agents' briefs don't change). Powers are
  // listed, with their guidance, in the board's own brief section.
  function briefText(keys, guidance = {}, guidanceBy = {}) {
    const { keys: held, notes } = resolve(keys);
    const said = (k) => (Object.hasOwn(guidance, k) ? guidance[k] : '');
    const saidBy = (k) => (Object.hasOwn(guidanceBy, k) ? guidanceBy[k] : null);
    // built-ins and bundles have no line of their own: they get one only when the human gave guidance for them
    const built = held.filter((k) => (PERMS[k] || custom[k]?.kind === 'bundle') && said(k)).map((k) => ({ key: k, name: PERMS[k]?.label || custom[k].name, brief: '', enforced: true }));
    const all = [...built, ...notes];
    if (!all.length) return '';
    const on = all.filter((n) => n.enforced);
    const words = all.filter((n) => !n.enforced);
    const line = (n) => [`- **${n.name}**${briefOf(n)}`, ...(said(n.key) ? [`  ${guidanceLine(said(n.key), saidBy(n.key))}`] : [])];
    return [
      '## Permissions the human gave you',
      ...on.flatMap(line),
      ...(words.length ? [
        ...(on.length ? [''] : []),
        `Verbal permissions (${NOT_ENFORCED}). They allow nothing new to your tools; they tell you what the human trusts you to do:`,
        ...words.flatMap(line),
      ] : []),
    ].join('\n');
  }

  // The brief lines of one permission, as briefText writes them: its own line, then the human's guidance.
  // Empty for a built-in or bundle without guidance (it has no line of its own) and for a power (the board's
  // brief writes those). The permissions grid shows these (INT-239).
  function linesFor(key, guidance = {}, guidanceBy = {}) {
    const said = Object.hasOwn(guidance, key) ? guidance[key] : '';
    const d = custom[key];
    const plain = PERMS[key] || d?.kind === 'bundle';
    if (!PERMS[key] && !d) return [];
    if (plain && !said) return [];
    const name = PERMS[key]?.label || d.name;
    const brief = plain ? '' : d.brief || d.description || '';
    return [`- **${name}**${briefOf({ brief, by: plain ? null : d.by })}`, ...(said ? [`  ${guidanceLine(said, Object.hasOwn(guidanceBy, key) ? guidanceBy[key] : null)}`] : [])];
  }

  return {
    errors,
    has,
    linesFor,
    // can an agent hold it through "perms"? (powers go in grants)
    holdable: has,
    isPower: isPowerKey,
    custom: () => ({ ...custom }),
    get: (k) => (BUILTINS.find((b) => b.key === k) || (custom[k] ? view(k, custom[k]) : null)),
    list: () => [...BUILTINS, ...Object.entries(custom).map(([k, d]) => view(k, d))],
    resolve,
    briefText,
    // key → label for the agent form: built-ins first, verbal ones marked as not enforced
    labels: () => Object.fromEntries([...Object.entries(PERMS).map(([k, p]) => [k, p.label]), ...Object.entries(custom).map(([k, d]) => [k, d.kind === 'verbal' ? `${d.name} (verbal, not enforced)` : d.name])]),
  };
}

module.exports = { PERMS, POWERS, ADMIN, ADMIN_BUNDLE, adminCovers, escalation, libraryEscalation, KINDS, COMMAND_RE, NOT_ENFORCED, RUN_OTHERS, TEST_FLAGS, BUILTINS, cleanPerm, createLibrary, cleanGuidance, cleanGuidanceBy, guidanceLine };
