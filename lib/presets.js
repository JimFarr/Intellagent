'use strict';
// Presets: a package for a kind of team. For now its board (columns, fields, ticket templates, rules); permissions
// and roles join it later. A preset is a folder with preset.json:
//   { name, version, label?, description?, extends?, board: { columns, schema, ticketTemplates, directives } }
// The built-in board templates (lib/templates.js) are presets too, at version "1". Shipped presets live in presets/
// in the package, the ones `preset add` brings in in <board folder>/presets/. What is installed, and as which
// values, is kept in <board folder>/presets.json, so an update can tell what the human has edited since.
const fs = require('fs');
const path = require('path');
const BUILTIN = require('./templates');
const jsonfile = require('./jsonfile');

const PACKAGE_DIR = path.join(__dirname, '..', 'presets');
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const clone = (v) => JSON.parse(JSON.stringify(v));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function builtin(name) {
  const t = BUILTIN[name];
  const { label, description, ...board } = t;
  return { name, version: '1', label, description, board: clone(board), source: 'built-in' };
}

// Why a preset.json is not usable, or null.
function validate(p) {
  if (!isObj(p)) return 'preset.json must be an object';
  if (!NAME_RE.test(String(p.name || ''))) return 'name must be lowercase letters, digits and dashes (at most 40)';
  if (!/^\d+(\.\d+)*$/.test(String(p.version || ''))) return 'version must be numbers with dots, like 1 or 1.2';
  if (p.extends != null && !NAME_RE.test(String(p.extends))) return 'extends must name another preset';
  if (!isObj(p.board)) return 'board is required: { columns, schema, ticketTemplates, directives }';
  const b = p.board;
  if (b.columns != null && !(Array.isArray(b.columns) && b.columns.every((c) => isObj(c) && String(c.name || '').trim()))) return 'board.columns must be a list of { name, … }';
  if (b.schema?.fields != null && !(Array.isArray(b.schema.fields) && b.schema.fields.every((f) => isObj(f) && f.key && f.type))) return 'board.schema.fields must be a list of { key, type, … }';
  if (b.ticketTemplates != null && !(Array.isArray(b.ticketTemplates) && b.ticketTemplates.every((t) => isObj(t) && t.key))) return 'board.ticketTemplates must be a list of { key, … }';
  if (b.directives != null && typeof b.directives !== 'string') return 'board.directives must be text';
  if (p.team != null) return validateTeam(p.team);
  return null;
}

// The team (INT-302): { roles: { key: {…} }, slots: { slot: {…} }, base: "base-context.md" }. A slot is a place in the
// team (a role, a model, what it owns), never a name: the human names it at install. A preset is refused, not
// filtered, when it carries what must be set by hand on the machine (run, env, inheritEnv, commands, MCP configs).
const TEAM_NEVER = /^(run|env|inheritenv|commands|mcp.*)$/i;
const ROLE_KEYS = ['label', 'brief', 'perms', 'model', 'provider', 'listen', 'pickup', 'supervise', 'reviewer', 'throttleMinutes'];
const SLOT_KEYS = ['role', 'model', 'provider', 'description', 'areas', 'concerns', 'listen', 'pickup', 'reviewer', 'supervise', 'keepAlive', 'idleAlarm', 'grants', 'context'];
const CONTEXT_MAX = 8000; // what the board allows for a note
const MODEL_RE = /^[\w.:-]{1,60}$/;
const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
function validateTeam(t) {
  if (!isObj(t)) return 'team must be { roles, slots, base }';
  for (const k of Object.keys(t)) if (!['roles', 'slots', 'base'].includes(k)) return `team.${k} is not part of a team (roles, slots, base)`;
  if (t.base != null && t.base !== 'base-context.md') return 'team.base must be "base-context.md", a file in the preset folder';
  for (const [kind, keys] of [['roles', ROLE_KEYS], ['slots', SLOT_KEYS]]) {
    if (t[kind] == null) continue;
    if (!isObj(t[kind])) return `team.${kind} must be an object keyed by ${kind === 'roles' ? 'role' : 'slot'} name`;
    for (const [name, e] of Object.entries(t[kind])) {
      const at = `team.${kind}.${name}`;
      if (!NAME_RE.test(name)) return `${at}: the name must be lowercase letters, digits and dashes (at most 40)`;
      if (!isObj(e)) return `${at} must be an object`;
      for (const k of Object.keys(e)) {
        if (TEAM_NEVER.test(k)) return `${at} carries "${k}": a preset never brings it, it is set by hand on the machine (remove the key; set it on the installed agent)`;
        if (!keys.includes(k)) return `${at}.${k} is not a ${kind === 'roles' ? 'role' : 'slot'} setting (${keys.join(', ')})`;
      }
      if (e.model != null && !MODEL_RE.test(String(e.model))) return `${at}.model must be a plain model name`;
      if (kind === 'slots') {
        if (!NAME_RE.test(String(e.role || ''))) return `${at}.role is required: the role this slot plays`;
        if (e.areas != null && !isStrings(e.areas)) return `${at}.areas must be a list of paths`;
        if (e.concerns != null && !isStrings(e.concerns)) return `${at}.concerns must be a list of sentences`;
        if (e.context != null && e.context !== `agent-context/${name}.md`) return `${at}.context must be "agent-context/${name}.md", a file in the preset folder`;
        if (e.grants != null) {
          if (!Array.isArray(e.grants)) return `${at}.grants must be a list of proposed grants`;
          for (const g of e.grants) {
            if (typeof g !== 'string' && !(isObj(g) && typeof g.power === 'string')) return `${at}.grants: each is a power name or { power, where?, minOks?, from? }`;
            for (const k of isObj(g) ? Object.keys(g) : []) if (TEAM_NEVER.test(k)) return `${at}.grants carries "${k}": a preset never brings it`;
          }
        }
      } else if (e.perms != null && !isStrings(e.perms)) return `${at}.perms must be a list of permission names`;
    }
  }
  return null;
}

// The context pages and the base text a team names, read from the preset folder: only agent-context/<slot>.md and
// base-context.md inside it (a link or a path that leaves the folder is refused), each at most CONTEXT_MAX.
// Returns { files } (slot → text, and base), or { why }.
function teamFiles(team, dir) {
  const files = {};
  if (!team) return { files };
  const root = fs.realpathSync(dir);
  const read = (rel, key) => {
    const f = path.join(dir, rel);
    let real;
    try { real = fs.realpathSync(f); } catch { return `${rel} is named by the team but is not in the preset folder`; }
    if (path.relative(root, real).startsWith('..') || path.isAbsolute(path.relative(root, real))) return `${rel} leaves the preset folder`;
    const text = fs.readFileSync(real, 'utf8');
    if (text.length > CONTEXT_MAX) return `${rel} is longer than ${CONTEXT_MAX} characters`;
    files[key] = text.replace(/\r\n/g, '\n');
    return null;
  };
  for (const [slot, e] of Object.entries(team.slots || {})) if (e.context) { const why = read(e.context, slot); if (why) return { why }; }
  if (team.base) { const why = read(team.base, 'base'); if (why) return { why }; }
  return { files };
}

// A folder preset as the library holds it: shape checked, team files read. { preset } or { why }.
function checked(p, dir) {
  const why = validate(p);
  if (why) return { why };
  if (!p.team) return { preset: p };
  const r = teamFiles(p.team, dir);
  return r.why ? { why: r.why } : { preset: { ...p, team: { ...p.team, files: r.files } } };
}

function readFolder(dir, source) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const n of names) {
    let p;
    try { p = jsonfile.read(path.join(dir, n, 'preset.json')); } catch { continue; }
    const { why, preset } = checked(p, path.join(dir, n));
    out[p.name || n] = why ? { name: n, broken: why, source } : { ...preset, source };
  }
  return out;
}

// Every preset this board folder can use: built-in, shipped in the package, added to the board (later ones win).
function all(boardDir) {
  const out = {};
  for (const n of Object.keys(BUILTIN)) out[n] = builtin(n);
  Object.assign(out, readFolder(PACKAGE_DIR, 'shipped'));
  if (boardDir) Object.assign(out, readFolder(path.join(boardDir, 'presets'), 'added'));
  return out;
}

// The preset with its parent folded in: columns, fields and ticket templates by name (the child's wins, new ones
// follow), rules one after the other.
function resolve(name, boardDir, _seen = []) {
  const p = all(boardDir)[name];
  if (!p) throw Object.assign(new Error(`No preset "${name}". Available: ${Object.keys(all(boardDir)).join(', ')}`), { code: 'NOT_FOUND' });
  if (p.broken) throw Object.assign(new Error(`Preset "${name}" is not usable: ${p.broken}`), { code: 'BAD_PRESET' });
  if (!p.extends) return p;
  if (_seen.includes(name)) throw Object.assign(new Error(`Preset "${name}" extends itself (${[..._seen, name].join(' → ')})`), { code: 'BAD_PRESET' });
  return fold(p, resolve(p.extends, boardDir, [..._seen, name]));
}

// `p` on top of its parent `base`.
function fold(p, base) {
  const merge = (a, b, key) => { const m = new Map((a || []).map((x) => [x[key], x])); for (const x of b || []) m.set(x[key], x); return [...m.values()]; };
  // the team: roles and slots by name (the child's wins, new ones follow), context pages by slot, the child's base wins
  const team = p.team || base.team ? {
    roles: { ...base.team?.roles, ...p.team?.roles },
    slots: { ...base.team?.slots, ...p.team?.slots },
    ...(p.team?.base || base.team?.base ? { base: p.team?.base || base.team.base } : {}),
    files: { ...base.team?.files, ...p.team?.files },
  } : undefined;
  return {
    ...p,
    ...(team ? { team } : {}),
    board: {
      columns: merge(base.board.columns, p.board.columns, 'name'),
      schema: { ...base.board.schema, ...p.board.schema, builtins: { ...base.board.schema?.builtins, ...p.board.schema?.builtins }, fields: merge(base.board.schema?.fields, p.board.schema?.fields, 'key') },
      ticketTemplates: merge(base.board.ticketTemplates, p.board.ticketTemplates, 'key'),
      directives: [base.board.directives, p.board.directives].filter(Boolean).join('\n'),
    },
  };
}

// A preset by name, or by the path of a folder with a preset.json (not copied anywhere: `addFolder` does that).
// Returns the resolved preset, plus `dir` for a folder. Throws with .code NOT_FOUND or BAD_PRESET.
function load(spec, boardDir) {
  const dir = path.resolve(spec);
  if (!fs.existsSync(path.join(dir, 'preset.json'))) return resolve(spec, boardDir);
  const file = path.join(dir, 'preset.json');
  let p;
  try { p = jsonfile.read(file); } catch (e) { throw Object.assign(new Error(`${file} does not parse: ${e.message}`), { code: 'BAD_PRESET' }); }
  const { why, preset } = checked(p, dir);
  if (why) throw Object.assign(new Error(`${file}: ${why}`), { code: 'BAD_PRESET' });
  const own = { ...preset, source: 'added', dir };
  return p.extends ? fold(own, resolve(p.extends, boardDir)) : own;
}

// The shape the server wants for POST /api/boards { template } and manifest.template.
function template(p) {
  return { label: p.label || p.name, description: p.description || '', ...p.board };
}
// Folder presets as templates, for the server to add to its list.
function templates(boardDir) {
  const out = {};
  for (const [n, p] of Object.entries(all(boardDir))) {
    if (p.source === 'built-in' || p.broken) continue;
    try { out[n] = template(resolve(n, boardDir)); } catch { /* left out; `preset list` says why */ }
  }
  return out;
}

// The preset as separate pieces that are installed, compared and updated one by one: id → value.
function parts(p) {
  const out = {};
  for (const c of p.board.columns || []) out[`column:${c.name}`] = c;
  for (const [k, v] of Object.entries(p.board.schema?.builtins || {})) out[`builtin:${k}`] = v;
  for (const f of p.board.schema?.fields || []) out[`field:${f.key}`] = f;
  for (const t of p.board.ticketTemplates || []) out[`ticket-template:${t.key}`] = t;
  if (p.board.directives) out.directives = p.board.directives;
  return out;
}

// The team as pieces too, kept apart from `parts` until the CLI installs them (a piece listed in `parts` is recorded as
// installed): a role, a slot (without its proposed grants: those are never installed as they are), a context page, the base.
function teamParts(p) {
  const out = {};
  for (const [k, r] of Object.entries(p.team?.roles || {})) out[`role:${k}`] = r;
  for (const [k, s] of Object.entries(p.team?.slots || {})) { const { grants, context, ...rest } = s; out[`slot:${k}`] = rest; }
  for (const [k, text] of Object.entries(p.team?.files || {})) out[k === 'base' ? 'base' : `context:${k}`] = text;
  return out;
}

// What installing gives the preset power over, for the prompt before anything is written.
// Commands and tools are listed when a preset carries them (roles and permissions come later).
function powers(p) {
  const out = [];
  const SAYS = {
    humanOnlyIn: 'agents cannot move tickets in', humanOnlyOut: 'agents cannot move tickets out',
    allowMoveIn: 'tickets can be moved in', allowMoveOut: 'tickets can be moved out', allowCreate: 'tickets can be created here',
    review: 'a review column', sleeping: 'a sleeping column: nobody starts its tickets', pickup: 'where agents pick up work', working: 'where work happens',
    releaseLeaseOnEnter: "releases a ticket's lease when a ticket enters",
  };
  const OFF = ['allowMoveIn', 'allowMoveOut', 'allowCreate']; // these matter when false: they close the column
  for (const c of p.board.columns || []) {
    for (const [k, v] of Object.entries(c.flags || {})) {
      if (k === 'autoArchiveAfterDays') { if (v) out.push(`column "${c.name}": archives tickets after ${v} days`); continue; }
      if (k === 'wipLimit') { if (v) out.push(`column "${c.name}": at most ${v} tickets at once`); continue; }
      if (v === false && OFF.includes(k)) out.push(`column "${c.name}": ${k} off (${SAYS[k].replace('can be', 'cannot be')})`);
      else if (v && k in SAYS) out.push(`column "${c.name}": ${k} (${SAYS[k]})`);
      else if (v) out.push(`column "${c.name}": ${k} (a custom flag, stored as it is)`);
    }
  }
  for (const [k, v] of Object.entries(p.board.schema?.builtins || {})) {
    const set = Object.entries(v || {}).map(([x, y]) => `${x} ${JSON.stringify(y)}`).join(', ');
    if (set) out.push(`built-in field "${k}": ${set}${v.ui ? ' (changes who can edit it)' : ''}`);
  }
  for (const f of p.board.schema?.fields || []) if (f.ui === 'read' || f.ui === 'hidden') out.push(`field "${f.key}": ${f.ui === 'read' ? 'only agents and the API can change it' : 'hidden from the human, API only'}`);
  if (p.board.directives) out.push('board rules (directives): agents are told to follow them');
  // the team: everything the human is asked to accept. Slots are new agents, so they start on probation (INT-233).
  const grantText = (g) => (typeof g === 'string' ? g : `${g.power}${g.where ? ` where ${JSON.stringify(g.where)}` : ''}${g.minOks != null ? `, needs ${g.minOks} oks` : ''}${g.from ? ` from ${[].concat(g.from).join(', ')}` : ''}`);
  for (const [k, r] of Object.entries(p.team?.roles || {})) out.push(`role "${k}"${r.model ? ` (model ${r.model})` : ''}${(r.perms || []).length ? `: permissions ${r.perms.join(', ')}` : ''}`);
  for (const [k, s] of Object.entries(p.team?.slots || {})) {
    const how = ['listen', 'pickup', 'reviewer', 'supervise', 'keepAlive'].filter((x) => s[x] != null).map((x) => `${x} ${JSON.stringify(s[x])}`).join(', ');
    out.push(`agent slot "${k}": role ${s.role}${s.model ? `, model ${s.model}` : ''}${how ? `, ${how}` : ''}; you name it at install, it starts on probation and runs nothing until you accept it`);
    for (const g of s.grants || []) out.push(`PROPOSED grant for "${k}": ${grantText(g)} (not written unless you accept it; --yes alone writes none)`);
    if (s.context) out.push(`agent slot "${k}": a context page of ${p.team.files?.[k]?.length ?? '?'} characters the agent is taught`);
  }
  if (p.team?.base) out.push(`base context (${p.team.files?.base?.length ?? '?'} characters): every agent on the board is taught it`);
  for (const c of p.commands || []) out.push(`command: ${c}`);
  for (const t of p.tools || []) out.push(`tool: ${t}`);
  return out;
}

// every key of `want` is in `have` with the same value (deep); `have` may carry more (ids, defaults)
function covers(have, want) {
  if (typeof want === 'string' && isObj(have)) return have.value === want; // an option written as "low" is stored as { value: "low" }
  if (isObj(want)) return isObj(have) && Object.keys(want).every((k) => covers(have[k], want[k]));
  if (Array.isArray(want)) return Array.isArray(have) && want.length === have.length && want.every((w, i) => covers(have[i], w));
  return have === want || (want == null && have == null);
}

// The pieces of the board a preset covers, as the API shows them: id → value.
function liveParts(board) {
  const out = {};
  for (const c of board.columns || []) out[`column:${c.name}`] = c;
  for (const [k, v] of Object.entries(board.schema?.builtins || {})) out[`builtin:${k}`] = v;
  for (const f of board.schema?.fields || []) out[`field:${f.key}`] = f;
  for (const t of board.ticketTemplates || []) out[`ticket-template:${t.key}`] = t;
  if (board.directives) out.directives = board.directives;
  return out;
}

// What would change, piece by piece:
//   new      not on the board: will be added
//   same     already as the preset has it
//   update   the board still has what was installed and the preset has changed it: can be updated
//   edited   the human changed it (or it was there before): kept, never overwritten
//   dropped  installed before and since removed from the board: kept off
//   gone     installed before, no longer in the preset: kept on the board
// `installed` is the lock entry's parts (id → value) or undefined.
function plan(p, installed, board) {
  const want = parts(p);
  const live = liveParts(board);
  const out = [];
  for (const [id, value] of Object.entries(want)) {
    const was = installed?.[id];
    const have = live[id];
    let state;
    if (have === undefined) state = was === undefined ? 'new' : 'dropped';
    else if (covers(have, value)) state = 'same';
    else if (was !== undefined && covers(have, was)) state = 'update';
    // a built-in field always has a value (the default), so with nothing installed before it cannot be told from an edit:
    // it is offered, the prompt lists it, and from then on the lock tells an edit apart
    else if (was === undefined && id.startsWith('builtin:')) state = 'new';
    else state = 'edited';
    out.push({ id, state, value });
  }
  for (const id of Object.keys(installed || {})) if (!(id in want)) out.push({ id, state: 'gone', value: installed[id] });
  return out;
}

const LOCK = 'presets.json';
// A missing lock is empty; one that does not parse stops the command rather than being taken for empty.
function readLock(boardDir) {
  return jsonfile.read(path.join(boardDir, LOCK), { presets: {} });
}
const writeLock = (boardDir, lock) => jsonfile.writeAtomic(path.join(boardDir, LOCK), lock);
// Remember what was installed from `p`: version, where from, and the value of each piece that is now on the board.
function record(boardDir, p, ids) {
  const lock = readLock(boardDir);
  lock.presets ||= {};
  const prev = lock.presets[p.name]?.parts || {};
  const want = parts(p);
  const next = { ...prev };
  for (const id of ids) if (id in want) next[id] = want[id];
  lock.presets[p.name] = { version: p.version, source: p.source, installedAt: new Date().toISOString(), parts: next };
  writeLock(boardDir, lock);
  return lock.presets[p.name];
}

// Copy a preset folder (already checked by `load`) into the board folder's presets/, so the board keeps its own copy.
function addFolder(p, boardDir) {
  const dest = path.join(boardDir, 'presets', p.name);
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(p.dir, dest, { recursive: true });
}

// A live board written as a preset another board can install: its columns and flags, fields, built-in field settings,
// ticket templates and rules. Returns { preset, left }: `left` lists what was not written and why, so the human sees
// it before sharing the folder. Tickets, ids, leases and anything local never enter; a ticket reference or an
// absolute path in the text is taken out, and said.
const PATH_RE = /(?:[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|etc|opt|mnt)\/)[^\s"'`)\]]*/g;
function fromBoard(board, { name, version = '1', label, description } = {}) {
  const left = [];
  const redact = (text, where) => {
    const out = String(text ?? '').replace(PATH_RE, '<path>');
    if (out !== String(text ?? '')) left.push({ what: `an absolute path in ${where}`, why: 'it only means something on this PC; replaced by <path>' });
    return out;
  };
  const scrub = (v, where) => (typeof v === 'string' ? redact(v, where) : Array.isArray(v) ? v.map((x) => scrub(x, where)) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, where)])) : v);
  const columns = (board.columns || []).map((c) => {
    const { id, itemIds, ...rest } = c; // ids are the board's own; the name is how a preset refers to a column
    return scrub(rest, `column "${c.name}"`);
  });
  const fields = (board.schema?.fields || []).map((f) => scrub(f, `field "${f.key}"`));
  const ticketTemplates = (board.ticketTemplates || []).map((t) => {
    const { parent, ...rest } = t;
    if (parent) left.push({ what: `the parent of ticket template "${t.key}" (${parent})`, why: 'it names a ticket on this board' });
    return scrub({ ...rest, parent: null }, `ticket template "${t.key}"`);
  });
  const preset = {
    name, version: String(version), label: label || board.name || name,
    ...(description ? { description } : {}),
    board: {
      columns,
      schema: { builtins: clone(board.schema?.builtins || {}), fields },
      ticketTemplates,
      directives: redact(board.directives, 'the board rules'),
    },
  };
  left.push({ what: 'the tickets, comments and attachments', why: 'a preset is a method, not the work' });
  left.push({ what: 'tokens, local.json, agents.json (run commands, env, MCP configs), leases and the board\'s data folder', why: 'local or secret' });
  if ((board.cardRules || []).length) left.push({ what: `the ${board.cardRules.length} card rules`, why: 'a preset cannot install card rules yet' });
  left.push({ what: 'the idle-alarm setting', why: 'a preset cannot install it yet' });
  left.push({ what: 'roles, agents, context pages, the base context and grants', why: 'the team part of a preset is not built yet (INT-302)' });
  return { preset, left };
}

module.exports = { all, resolve, load, template, templates, parts, teamParts, powers, plan, covers, validate, fromBoard, readLock, record, addFolder, fold, NAME_RE };
