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
  return null;
}

function readFolder(dir, source) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const n of names) {
    let p;
    try { p = jsonfile.read(path.join(dir, n, 'preset.json')); } catch { continue; }
    const why = validate(p);
    out[p.name || n] = why ? { name: n, broken: why, source } : { ...p, source };
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
  return {
    ...p,
    board: {
      columns: merge(base.board.columns, p.board.columns, 'name'),
      schema: { ...base.board.schema, ...p.board.schema, fields: merge(base.board.schema?.fields, p.board.schema?.fields, 'key') },
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
  const why = validate(p);
  if (why) throw Object.assign(new Error(`${file}: ${why}`), { code: 'BAD_PRESET' });
  const own = { ...p, source: 'added', dir };
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
  for (const f of p.board.schema?.fields || []) out[`field:${f.key}`] = f;
  for (const t of p.board.ticketTemplates || []) out[`ticket-template:${t.key}`] = t;
  if (p.board.directives) out.directives = p.board.directives;
  return out;
}

// What installing gives the preset power over, for the prompt before anything is written.
// Commands and tools are listed when a preset carries them (roles and permissions come later).
function powers(p) {
  const out = [];
  for (const c of p.board.columns || []) {
    const f = c.flags || {};
    const gate = ['humanOnlyIn', 'humanOnlyOut'].filter((k) => f[k]);
    if (gate.length) out.push(`column "${c.name}": ${gate.join(', ')} (agents cannot ${gate.includes('humanOnlyIn') ? 'move tickets in' : 'move tickets out'})`);
    if (f.releaseLeaseOnEnter) out.push(`column "${c.name}": releases a ticket's lease when a ticket enters`);
    if (f.autoArchiveAfterDays) out.push(`column "${c.name}": archives tickets after ${f.autoArchiveAfterDays} days`);
    if (f.wipLimit) out.push(`column "${c.name}": at most ${f.wipLimit} tickets at once`);
  }
  for (const f of p.board.schema?.fields || []) if (f.ui === 'read' || f.ui === 'hidden') out.push(`field "${f.key}": ${f.ui === 'read' ? 'only agents and the API can change it' : 'hidden from the human, API only'}`);
  if (p.board.directives) out.push('board rules (directives): agents are told to follow them');
  for (const c of p.commands || []) out.push(`command: ${c}`);
  for (const t of p.tools || []) out.push(`tool: ${t}`);
  return out;
}

// every key of `want` is in `have` with the same value (deep); `have` may carry more (ids, defaults)
function covers(have, want) {
  if (isObj(want)) return isObj(have) && Object.keys(want).every((k) => covers(have[k], want[k]));
  if (Array.isArray(want)) return Array.isArray(have) && want.length === have.length && want.every((w, i) => covers(have[i], w));
  return have === want || (want == null && have == null);
}

// The pieces of the board a preset covers, as the API shows them: id → value.
function liveParts(board) {
  const out = {};
  for (const c of board.columns || []) out[`column:${c.name}`] = c;
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

module.exports = { all, resolve, load, template, templates, parts, powers, plan, covers, validate, readLock, record, addFolder, NAME_RE };
