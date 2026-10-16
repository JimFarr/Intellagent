'use strict';
/* The permission library (INT-228): every permission a standing agent can hold, as data.

   Built-ins come from code and can't be changed or removed:
     PERMS   tools a run is built from (read, edit, test, build, git, web); held through an agent's "perms"
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

const PERMS = {
  edit: { label: 'Edit files', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] },
  read: { label: 'Read files', tools: ['Read', 'Grep', 'Glob'] },
  test: { label: 'Run tests', tools: ['Bash(npm test)', 'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npx vitest:*)', 'Bash(npx jest:*)', 'Bash(pnpm test:*)', 'Bash(yarn test:*)', 'Bash(node --test)'] },
  build: { label: 'Build & lint', tools: ['Bash(npm run build:*)', 'Bash(npm run lint:*)', 'Bash(npx tsc:*)', 'Bash(npx eslint:*)'] },
  // git merge main (and --abort) only: an agent catches its own branch up and resolves its own conflicts;
  // its worktree is its own branch, so this never touches main (landing stays with the human's approval).
  git: { label: 'Git (status, diff, commit, merge main)', tools: ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git merge main)', 'Bash(git merge --abort)'] },
  web: { label: 'Web research', tools: ['WebSearch', 'WebFetch'] },
};
const POWERS = {
  'review.decide': 'Decide reviews (approve / request changes)',
  'column.gate': 'Move tickets into / out of human-only columns',
  'agents.control': 'Pause, resume and run other standing agents',
  'agents.manage': "Change other standing agents' label, role, personality and model (allowlist), and narrow their permissions",
  'work.land': 'Land work that was already approved on main (resolving conflicts on its own branch first)',
};
const PERM_TEXT = {
  edit: 'Read, create and change files in its folder.',
  read: 'Read and search files; change nothing.',
  test: 'Run the project\'s tests (npm test and the usual test runners).',
  build: 'Run the build, the linter and the type checker.',
  git: 'See its changes, commit them and merge main into its own branch. Never push or touch main.',
  web: 'Search the web and fetch pages.',
};

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

const BUILTINS = [
  ...Object.entries(PERMS).map(([key, p]) => ({
    key, kind: 'builtin', name: p.label, description: PERM_TEXT[key], allows: { tools: p.tools }, needs: [], brief: '', builtin: true, enforced: true, heldBy: 'perms',
  })),
  ...Object.entries(POWERS).map(([key, label]) => ({
    key, kind: 'power', name: label, description: `${label}. Human-only unless the human grants it.`, allows: { powers: [key] }, needs: [], brief: '', builtin: true, enforced: true, heldBy: 'grants',
  })),
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
    if (POWERS[k]) throw badRequest(`Permission "${key}": ${k} is a power`, 'Powers are held only through grants, never inside a bundle or as a need');
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
  const custom = {};
  const errors = [];
  const entries = Object.entries(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
  const known = (k) => !!PERMS[k] || entries.some(([n]) => n === k);
  for (const [key, d] of entries) {
    try { custom[key] = cleanPerm(key, d, known); } catch (e) { errors.push(e.message); }
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
      for (const n of [...(custom[k]?.includes || []), ...(custom[k]?.needs || [])]) add(n);
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
    const notes = held.filter((k) => custom[k] && custom[k].kind !== 'bundle').map((k) => ({ key: k, name: custom[k].name, brief: custom[k].brief || custom[k].description || '', enforced: custom[k].kind !== 'verbal' }));
    return { keys: held, tools: [...new Set(rules)], notes, unknown };
  }

  // The brief's section for an agent's custom permissions; '' when it holds only built-ins (so existing
  // agents' briefs don't change).
  function briefText(keys) {
    const { notes } = resolve(keys);
    if (!notes.length) return '';
    const on = notes.filter((n) => n.enforced);
    const words = notes.filter((n) => !n.enforced);
    return [
      '## Permissions the human gave you',
      ...on.map((n) => `- **${n.name}**${n.brief ? ` — ${n.brief}` : ''}`),
      ...(words.length ? [
        ...(on.length ? [''] : []),
        `Verbal permissions (${NOT_ENFORCED}). They allow nothing new to your tools; they tell you what the human trusts you to do:`,
        ...words.map((n) => `- **${n.name}** — ${n.brief}`),
      ] : []),
    ].join('\n');
  }

  return {
    errors,
    has,
    // can an agent hold it through "perms"? (powers go in grants)
    holdable: has,
    isPower: (k) => !!POWERS[k],
    custom: () => ({ ...custom }),
    get: (k) => (BUILTINS.find((b) => b.key === k) || (custom[k] ? view(k, custom[k]) : null)),
    list: () => [...BUILTINS, ...Object.entries(custom).map(([k, d]) => view(k, d))],
    resolve,
    briefText,
    // key → label for the agent form: built-ins first, verbal ones marked as not enforced
    labels: () => Object.fromEntries([...Object.entries(PERMS).map(([k, p]) => [k, p.label]), ...Object.entries(custom).map(([k, d]) => [k, d.kind === 'verbal' ? `${d.name} (verbal, not enforced)` : d.name])]),
  };
}

module.exports = { PERMS, POWERS, KINDS, COMMAND_RE, NOT_ENFORCED, BUILTINS, cleanPerm, createLibrary };
