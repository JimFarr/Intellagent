#!/usr/bin/env node
/*
 * Intellagent — a portable kanban for humans and agents.
 * Zero dependencies. Node >= 18.   Start:  node server.js
 * Agents: GET /api/docs
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');

const VERSION = '1.0.0';
const BUILD = '2026.10.11-1';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

/* ───────────────────────── manifest ───────────────────────── */

const MANIFEST_PATH = path.resolve(process.env.INTELLAGENT_MANIFEST || path.join(ROOT, 'intellagent.manifest.json'));
const LOCAL_PATH = path.join(path.dirname(MANIFEST_PATH), 'local.json');
const { readLocal } = require('./lib/locate');
const jsonfile = require('./lib/jsonfile');
const MANIFEST_DEFAULTS = {
  appName: 'Intellagent',
  host: '127.0.0.1',
  port: 7420,
  dataDir: './data',
  defaultBoard: 'main',
  lease: { defaultMinutes: 30, maxMinutes: 1440, warningMinutes: 5 },
  presenceTimeoutSeconds: 90,
  readonlyData: true,
  backups: 10,
  // Optional. userToken: humans must send it. agentTokens: { name: token } — that agent must send it.
  // requireAgentTokens: reject agents without a configured token.
  auth: { userToken: null, agentTokens: {}, requireAgentTokens: false },
  // Optional per-agent limits: { "agent-name" | "*": { columns?: [names or ids it may change], readOnly?: bool } }
  permissions: {},
  // A ticket an agent left in the working column with no activity for this long goes back to the pickup
  // column (Ready) with a comment. 0 turns the sweep off.
  staleWorkMinutes: 120,
  staleSweepSeconds: 300,
};

function loadManifest() {
  let m = {};
  if (fs.existsSync(MANIFEST_PATH)) m = jsonfile.read(MANIFEST_PATH);
  else fs.writeFileSync(MANIFEST_PATH, JSON.stringify(MANIFEST_DEFAULTS, null, 2));
  const merged = {
    ...MANIFEST_DEFAULTS, ...m,
    lease: { ...MANIFEST_DEFAULTS.lease, ...(m.lease || {}) },
    auth: { ...MANIFEST_DEFAULTS.auth, ...(m.auth || {}) },
    permissions: m.permissions || {},
  };
  if (process.env.INTELLAGENT_PORT) merged.port = Number(process.env.INTELLAGENT_PORT);
  // local.json next to the manifest (git-ignored) carries machine-local secrets, e.g. the user token. One that
  // exists but can't be read stops the board: starting without the user token would let anyone act as the human.
  let local;
  try { local = readLocal(LOCAL_PATH); } catch (e) { console.error(`Intellagent will not start: ${e.message}`); process.exit(1); }
  if (local.userToken) merged.auth.userToken = local.userToken;
  if (local.agentTokens) merged.auth.agentTokens = { ...(merged.auth.agentTokens || {}), ...local.agentTokens };
  merged.dataDir = path.resolve(path.dirname(MANIFEST_PATH), merged.dataDir);
  return merged;
}

const M = loadManifest();
const DATA = M.dataDir;
const BOARDS_DIR = path.join(DATA, 'boards');
fs.mkdirSync(BOARDS_DIR, { recursive: true });

/* ───────────────────────── utilities ───────────────────────── */

const now = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const slug = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
const str = (v, max) => String(v ?? '').slice(0, max);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const SYSTEM = { kind: 'system', name: 'intellagent' };

// Every error carries a machine-readable `code` (agents branch on it) and often a `hint` (what to do instead).
const DEFAULT_CODE = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 410: 'ARCHIVED', 413: 'TOO_LARGE', 423: 'LOCKED' };
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    const { code, ...rest } = extra || {};
    this.code = code || DEFAULT_CODE[status] || 'ERROR';
    this.extra = Object.keys(rest).length ? rest : undefined;
  }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

class Reply { constructor(status, body) { this.status = status; this.body = body; } }
const created = (body) => new Reply(201, body);
const HANDLED = Symbol('handled');

function setWritable(file, writable) { try { fs.chmodSync(file, writable ? 0o644 : 0o444); } catch { /* best effort */ } }

// Write to a temp file then swap it in, so a crash never leaves a half-written board.
function writeFileAtomic(file, text, readonly = M.readonlyData) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  if (fs.existsSync(file)) setWritable(file, true);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); break; }
    catch (e) { if (i >= 6) throw e; sleepSync(25 * (i + 1)); } // Windows: AV / indexer may hold the file briefly
  }
  if (readonly) setWritable(file, false);
}

function readJson(file, fallback) {
  return jsonfile.readOr(file, fallback);
}

/* ───────────────────────── domain constants ───────────────────────── */

const TYPES = ['issue', 'task', 'spike'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const DEFAULT_FLAGS = {
  allowCreate: false,
  allowMoveIn: true,
  allowMoveOut: true,
  wipLimit: 0,
  releaseLeaseOnEnter: false,
  autoArchiveAfterDays: 0,
  humanOnlyIn: false,
  humanOnlyOut: false,
  review: false,
  // A sleeping column holds work nobody should start yet: tickets can be dropped and assigned there without
  // waking anyone, agents cannot start them, and moving one out (into Ready) wakes its assignee. On a board
  // with one, agents file new tickets there; the coordinator decides where an agent's ticket goes, and only
  // the human wakes the human's own.
  sleeping: false,
};
const TEMPLATES = require('./lib/templates');
// presets (shipped, and added to this board) are board templates too: GET /api/templates, manifest.template, POST /api/boards
Object.assign(TEMPLATES, require('./lib/presets').templates(path.dirname(MANIFEST_PATH)));
const { allowedHosts, hostProblem, jsonProblem } = require('./lib/local-only');

/* ── schema: typed custom fields + configurable built-ins ── */
const FIELD_TYPES = ['text', 'markdown', 'number', 'boolean', 'enum', 'tags', 'date', 'url', 'user'];
const UI_MODES = ['edit', 'read', 'hidden'];
const STUB_SLOTS = ['none', 'top', 'meta'];
const BUILTINS = {
  type: { ui: 'edit', stub: true, label: 'Type' },
  priority: { ui: 'edit', stub: true, label: 'Priority' },
  parent: { ui: 'edit', stub: true, label: 'Parent' },
  description: { ui: 'edit', stub: false, label: 'Description' },
  blockedBy: { ui: 'read', stub: true, label: 'Blocked by' },
  attachments: { ui: 'edit', stub: true, label: 'Files' },
  cover: { ui: 'edit', stub: true, label: 'Card image' },
  assignee: { ui: 'edit', stub: true, label: 'Assignee' },
  properties: { ui: 'edit', stub: false, label: 'Properties' },
};
const RESERVED_KEYS = ['id', 'title', 'column', 'columnId', 'lease', 'comments', 'author', 'fields', 'version', 'needsHuman', ...Object.keys(BUILTINS)];

function oneOf(v, list, dflt) {
  if (v == null || v === '') { if (dflt !== undefined) return dflt; fail(400, `Value required. Use one of: ${list.join(', ')}`); }
  const m = list.find((x) => x.toLowerCase() === String(v).toLowerCase());
  if (!m) fail(400, `Invalid value "${v}". Use one of: ${list.join(', ')}`);
  return m;
}

function findColumnById(b, id) { return b.columns.find((c) => c.id === id); }
// Whether a ticket sits in a sleeping column (see DEFAULT_FLAGS).
function asleep(ctx, item) { return !!findColumnById(ctx.board, item.columnId)?.flags.sleeping; }
// The board's coordinator: the agent requests default to, or a standing agent with the coordinator role.
// Both are the human's to set (PATCH board, POST /api/agents). Every coordinator power asks this, nothing else.
function isCoordinator(ctx, name) {
  if (name && name === ctx.board.coordinator) return true;
  try { return standing?.get?.(name)?.role === 'coordinator'; } catch { return false; }
}
// Known flags are coerced to their type; unknown flags are kept verbatim so agents can invent their own.
function pickFlags(f, base = DEFAULT_FLAGS) {
  const out = { ...base };
  for (const [k, v] of Object.entries(f || {})) {
    if (!(k in DEFAULT_FLAGS)) { out[k] = v; continue; }
    out[k] = typeof DEFAULT_FLAGS[k] === 'boolean' ? v === true || v === 'true' : Math.max(0, Number(v) || 0);
  }
  return out;
}

function normBuiltins(src, lenient = false) {
  const out = JSON.parse(JSON.stringify(BUILTINS));
  for (const [k, v] of Object.entries(isObj(src) ? src : {})) {
    if (!BUILTINS[k] || !isObj(v)) {
      if (lenient) continue;
      fail(400, `Unknown built-in "${k}" or bad config. Built-ins: ${Object.keys(BUILTINS).join(', ')}; config: { ui, stub, label }`);
    }
    if ('ui' in v) out[k].ui = lenient && !UI_MODES.includes(v.ui) ? out[k].ui : oneOf(v.ui, UI_MODES);
    if ('stub' in v) out[k].stub = v.stub === true || v.stub === 'true';
    if ('label' in v) out[k].label = str(v.label || BUILTINS[k].label, 40);
  }
  return out;
}

// One check for a typed value, shared by schema fields (lenient: "3", "true", any-case options) and the
// answers to a question's form (strict: exactly the type). Form types are aliases of the field types.
// `bad(problem, detail)` must throw; each caller words the problem its own way.
const TYPE_ALIAS = { longtext: 'text', choice: 'enum', multi: 'tags', yesno: 'boolean' };
const TEXT_LIMIT = { user: 64, longtext: 20_000 };
function checkValue(def, v, strict, bad) {
  const type = TYPE_ALIAS[def.type] || def.type;
  const options = def.options?.map((o) => o.value) || [];
  const find = (x) => def.options.find((o) => strict ? o.value === x : o.value.toLowerCase() === String(x).toLowerCase());
  switch (type) {
    case 'text': case 'user':
      if (typeof v !== 'string' && (strict || typeof v !== 'number')) bad('text');
      return str(v, TEXT_LIMIT[def.type] || 2000);
    case 'markdown':
      return typeof v === 'string' ? str(v, 100_000) : bad('markdown');
    case 'number': {
      const n = strict || typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (typeof n !== 'number' || !Number.isFinite(n)) bad('number');
      if ((def.min != null && n < def.min) || (def.max != null && n > def.max)) bad('range', n);
      return n;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (!strict && (v === 'true' || v === 'false')) return v === 'true';
      return bad('boolean');
    case 'enum': {
      const o = find(v);
      return o ? o.value : bad('option', options);
    }
    case 'tags': {
      if (strict && !Array.isArray(v)) bad('list', options);
      let list = arr(v);
      if (!strict) list = list.map((x) => str(x, 60).trim()).filter(Boolean);
      if (def.options?.length) list = list.map((t) => find(t)?.value ?? bad('list', options));
      return list.length || strict ? [...new Set(list)] : null;
    }
    case 'date': {
      const ok = typeof v === 'string' && !Number.isNaN(Date.parse(v)) && (!strict || /^\d{4}-\d{2}-\d{2}$/.test(v));
      return ok ? v.slice(0, 40) : bad('date');
    }
    case 'url':
      return typeof v === 'string' && /^https?:\/\//i.test(v) ? str(v, 2000) : bad('url');
    default:
      return bad('type');
  }
}

function coerceField(def, v) {
  if (v === null || v === undefined || v === '') return null;
  const want = { text: 'a string', markdown: 'a markdown string', number: 'a number', boolean: 'true or false', date: 'an ISO date like 2026-10-12', url: 'an http(s) URL', type: 'a known type' };
  return checkValue(def, v, false, (problem, d) => {
    if (problem === 'range') fail(400, `Field "${def.key}" must be ${def.min != null && d < def.min ? `>= ${def.min}` : `<= ${def.max}`}`);
    if (problem === 'option') fail(400, `Field "${def.key}" expects one of: ${d.join(', ')}`);
    if (problem === 'list') fail(400, `Field "${def.key}" tags must be from: ${d.join(', ')}`);
    return fail(400, `Field "${def.key}" expects ${want[problem]}, got ${JSON.stringify(v)}`);
  });
}

function normField(f, base = null) {
  if (!isObj(f)) fail(400, 'Field definition must be an object');
  const d = base ? { ...base } : {};
  const key = base ? base.key : String(f.key || '').trim();
  if (!/^[A-Za-z][\w-]{0,39}$/.test(key)) fail(400, 'Field "key" must start with a letter and use letters, digits, _ or - (max 40)');
  if (RESERVED_KEYS.includes(key)) fail(400, `"${key}" is reserved. Reserved: ${RESERVED_KEYS.join(', ')}`);
  d.key = key;
  if (!base || 'type' in f) d.type = oneOf(f.type ?? 'text', FIELD_TYPES);
  if (!base || 'label' in f) d.label = str(f.label || key, 40);
  if ('icon' in f) d.icon = str(f.icon, 32);
  if ('help' in f) d.help = str(f.help, 300);
  d.ui = 'ui' in f ? oneOf(f.ui, UI_MODES) : d.ui || 'edit';
  d.stub = 'stub' in f ? (f.stub === true ? 'meta' : f.stub === false ? 'none' : oneOf(f.stub, STUB_SLOTS)) : d.stub || 'none';
  if ('required' in f) d.required = f.required === true;
  if (d.type === 'enum' || d.type === 'tags') {
    if ('options' in f || !d.options) {
      d.options = arr(f.options).map((o) => (isObj(o) ? { value: str(o.value, 60).trim(), ...(o.color ? { color: str(o.color, 32) } : {}) } : { value: str(o, 60).trim() })).filter((o) => o.value);
    }
    if (d.type === 'enum' && !d.options.length) fail(400, `Enum field "${key}" needs "options"`);
  } else delete d.options;
  if (d.type === 'number') {
    if ('min' in f) d.min = f.min == null ? undefined : Number(f.min);
    if ('max' in f) d.max = f.max == null ? undefined : Number(f.max);
  } else { delete d.min; delete d.max; }
  if ('default' in f) d.default = f.default == null ? undefined : coerceField(d, f.default);
  return JSON.parse(JSON.stringify(d));
}

function applyFields(ctx, item, src, actor, changes, creating = false) {
  const defs = ctx.board.schema.fields;
  if (src != null && !isObj(src)) fail(400, '"fields" must be an object of { key: value }');
  for (const [k, v] of Object.entries(src || {})) {
    const def = defs.find((f) => f.key === k);
    if (!def) fail(400, `Unknown field "${k}". Declared: ${defs.map((f) => f.key).join(', ') || '(none)'}. Declare it with POST /api/boards/${ctx.id}/schema/fields, or use "properties" for free-form data.`);
    if (!creating && actor.kind === 'user' && def.ui !== 'edit') fail(403, `"${def.label}" is read-only in the UI`);
    const next = coerceField(def, v);
    const prev = item.fields[k] ?? null;
    if (JSON.stringify(prev) === JSON.stringify(next)) continue;
    if (next === null) delete item.fields[k]; else item.fields[k] = next;
    if (changes) changes[`fields.${k}`] = { from: trimChange(prev), to: trimChange(next) };
  }
  if (creating) {
    for (const def of defs) {
      if (item.fields[def.key] == null && def.default != null) item.fields[def.key] = def.default;
      if (def.required && item.fields[def.key] == null) fail(400, `Field "${def.key}" is required`);
    }
  }
}

/* ───────────────────────── app + boards ───────────────────────── */

const APP_FILE = path.join(DATA, 'app.json');
const app = readJson(APP_FILE, null) || { name: M.appName, createdAt: now() };
// A sandbox is named for whoever runs it, even when its data was copied from the real board.
if (M.sandbox && M.appName) app.name = M.appName;
const saveApp = () => writeFileAtomic(APP_FILE, JSON.stringify(app, null, 2));
if (!fs.existsSync(APP_FILE)) saveApp();

// The board's code is Intellagent itself (not a sandbox): its tickets' branches can run as a preview board.
// (Worked out on first use: PROJECT_ROOT is declared further down.)
let previewOk = null;
const previewable = () => (previewOk ??= !M.sandbox && (() => { try { return jsonfile.read(path.join(PROJECT_ROOT, 'package.json')).name === 'intellagent' && fs.existsSync(path.join(PROJECT_ROOT, 'server.js')); } catch { return false; } })());
const appInfo = () => ({
  name: app.name, version: VERSION, build: BUILD, defaultBoard: M.defaultBoard,
  lease: M.lease, serverTime: now(), seq, preview: previewable(),
});

const boards = new Map(); // id -> ctx

function boardPaths(id) {
  const dir = path.join(BOARDS_DIR, id);
  return {
    dir,
    file: path.join(dir, 'board.json'),
    hashFile: path.join(dir, 'board.hash'),
    archiveFile: path.join(dir, 'archive.json'),
    attachDir: path.join(dir, 'attachments'),
    backupDir: path.join(dir, 'backups'),
  };
}

function getCtx(id) {
  const ctx = boards.get(id) || boards.get(slug(id || ''));
  if (!ctx) fail(404, `Board "${id}" not found. Boards: ${[...boards.keys()].join(', ') || '(none)'}`);
  return ctx;
}

function normalizeBoard(b) {
  b.columns = Array.isArray(b.columns) ? b.columns : [];
  b.items = isObj(b.items) ? b.items : {};
  b.directives = b.directives || '';
  b.digest = Array.isArray(b.digest) ? b.digest : [];
  b.master = isObj(b.master) ? b.master : null;
  b.ticketTemplates = Array.isArray(b.ticketTemplates) ? b.ticketTemplates : [];
  b.requests = Array.isArray(b.requests) ? b.requests : [];
  b.coordinator = b.coordinator || null;
  b.schema = { builtins: normBuiltins(b.schema?.builtins, true), fields: Array.isArray(b.schema?.fields) ? b.schema.fields : [] };
  for (const it of Object.values(b.items)) {
    it.fields = isObj(it.fields) ? it.fields : {}; it.cover = it.cover || 'auto'; it.assignee = it.assignee || null;
    // flow: when the item entered each column (metrics). Older boards start from what is known.
    if (!Array.isArray(it.flow)) it.flow = [{ col: it.columnId, at: it.enteredColumnAt || it.createdAt }];
    syncNeeds(it);
  }
  for (const c of b.columns) {
    c.flags = pickFlags(c.flags);
    c.itemIds = (c.itemIds || []).filter((id) => b.items[id]);
  }
  const placed = new Set(b.columns.flatMap((c) => c.itemIds));
  for (const item of Object.values(b.items)) {
    let col = b.columns.find((c) => c.id === item.columnId);
    if (!col && b.columns[0]) { col = b.columns[0]; item.columnId = col.id; }
    if (col && !placed.has(item.id)) col.itemIds.push(item.id);
  }
  // Focus boards: saved views over this board (ticket ids only, never copies), at most one of them active.
  b.focusBoards = (Array.isArray(b.focusBoards) ? b.focusBoards : []).filter((f) => isObj(f) && f.id);
  for (const f of b.focusBoards) { f.itemIds = arr(f.itemIds).filter((id) => b.items[id]); f.startCols = isObj(f.startCols) ? f.startCols : {}; f.archived = arr(f.archived); }
  b.activeFocus = b.focusBoards.some((f) => f.id === b.activeFocus) ? b.activeFocus : null;
  return b;
}

// Every column change goes through here so the flow history (metrics) stays complete.
const FLOW_MAX = 100;
function enterColumn(item, colId) {
  const t = now();
  item.columnId = colId;
  item.enteredColumnAt = t;
  (item.flow ||= []).push({ col: colId, at: t });
  if (item.flow.length > FLOW_MAX) item.flow.splice(0, item.flow.length - FLOW_MAX);
}

// Closed "needs you" requests, kept for metrics (how long agents waited on the human).
function closeWait(item, prev, actor, more = {}) {
  (item.waits ||= []).push({ id: prev.id || null, reason: prev.reason || null, raisedBy: prev.raisedBy, raisedAt: prev.raisedAt, resolvedAt: now(), by: actor.name, kind: prev.kind || 'question', ...more });
  if (item.waits.length > 30) item.waits.shift();
}

/* ticket templates: per-board presets for new tickets ("Bug", "Feature"…) */
function normTicketTemplate(t, base = {}) {
  if (!isObj(t)) fail(400, 'Template must be an object');
  const m = { ...base, ...t };
  const key = slug(m.key || m.label || '');
  if (!m.label && !m.key) fail(400, 'Template needs a "label"');
  const out = {
    key,
    label: str(m.label || key, 60).trim(),
    icon: m.icon ? str(m.icon, 32) : null,
    help: m.help ? str(m.help, 300) : '',
    type: m.type ? oneOf(m.type, TYPES, 'task') : null,
    priority: m.priority ? oneOf(m.priority, PRIORITIES, 'Medium') : null,
    parent: m.parent ? str(m.parent, 60).trim() : null,
    column: m.column ? str(m.column, 60) : null,
    title: m.title ? str(m.title, 200) : '',
    description: str(m.description || '', 20_000),
    fields: isObj(m.fields) ? m.fields : {},
    properties: isObj(m.properties) ? m.properties : {},
  };
  return out;
}
function ticketTemplate(ctx, key) {
  const k = slug(key);
  const t = ctx.board.ticketTemplates.find((x) => x.key === k);
  if (!t) fail(400, `Unknown ticket template "${key}". Available: ${ctx.board.ticketTemplates.map((x) => x.key).join(', ') || '(none)'}`);
  return t;
}
// Template values first, the caller's on top. Fields and properties merge key by key.
function withTemplate(ctx, d) {
  if (!d.template) return d;
  const t = ticketTemplate(ctx, d.template);
  const pickDef = (k) => (d[k] != null && d[k] !== '' ? d[k] : t[k] ?? undefined);
  return {
    ...d,
    title: d.title || t.title,
    type: pickDef('type'), priority: pickDef('priority'), parent: pickDef('parent'),
    column: d.column ?? d.columnId ?? t.column ?? undefined,
    description: d.description != null && d.description !== '' ? d.description : t.description,
    fields: { ...t.fields, ...(isObj(d.fields) ? d.fields : {}) },
    properties: { ...t.properties, ...(isObj(d.properties) ? d.properties : {}) },
  };
}

function writeHash(ctx) { writeFileAtomic(ctx.hashFile, `${ctx.hash}\n`); }

function maybeBackup(ctx) {
  if (Date.now() - ctx.lastBackup < 60_000 || !fs.existsSync(ctx.file)) return;
  ctx.lastBackup = Date.now();
  fs.mkdirSync(ctx.backupDir, { recursive: true });
  const dest = path.join(ctx.backupDir, `board-${Date.now()}.json`);
  fs.copyFileSync(ctx.file, dest);
  setWritable(dest, true);
  const files = fs.readdirSync(ctx.backupDir).filter((f) => f.startsWith('board-')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - M.backups))) fs.unlinkSync(path.join(ctx.backupDir, f));
}

// The board as compact JSON without its top-level updatedAt, so tx() can tell a real change from none
// and persist() can reuse the same string instead of serialising the board again.
const boardBody = (board) => boardParts(board).body;
// The same JSON, byte for byte, built one top-level key and one ticket at a time, so tx() also learns which
// tickets and keys a write changed (syncOf) for the same cost.
function boardParts(board) {
  const keys = new Map();
  const items = new Map();
  const out = [];
  for (const k of Object.keys(board)) {
    if (k === 'updatedAt') continue;
    const v = board[k];
    let s;
    if (k === 'items' && isObj(v)) {
      const xs = [];
      for (const id of Object.keys(v)) {
        const j = JSON.stringify(v[id]);
        if (j === undefined) continue;
        items.set(id, j);
        xs.push(`${JSON.stringify(id)}:${j}`);
      }
      s = `{${xs.join(',')}}`;
    } else s = JSON.stringify(v);
    if (s === undefined) continue;
    keys.set(k, s);
    out.push(`${JSON.stringify(k)}:${s}`);
  }
  return { body: `{${out.join(',')}}`, keys, items };
}

// What a write changed, for the board page to patch instead of downloading the whole board (INT-218):
// { from: hash before, items: [changed or removed ids], columns: { id: itemIds } for reordered columns } (the page
// gets items as { id: ticket }, see withSync).
// Anything else (a column's name or flags, the schema, templates, directives, focus, master, requests, digest)
// or a write touching more than SYNC_MAX tickets gives { from, full: true }: the page fetches the whole board.
const SYNC_MAX = 50;
const SYNC_KEYS = new Set(['items', 'columns', 'nextNumber']);
function syncOf(from, b, a, board) {
  const full = { from, full: true };
  for (const [k, s] of a.keys) if (b.keys.get(k) !== s && !SYNC_KEYS.has(k)) return full;
  for (const k of b.keys.keys()) if (!a.keys.has(k)) return full;
  const items = [];
  for (const [id, s] of a.items) if (b.items.get(id) !== s) items.push(id);
  for (const id of b.items.keys()) if (!a.items.has(id)) items.push(id);
  if (items.length > SYNC_MAX) return full;
  const sync = { from, items };
  if (b.keys.get('columns') !== a.keys.get('columns')) {
    const was = JSON.parse(b.keys.get('columns') || '[]');
    if (!Array.isArray(was) || was.length !== board.columns.length) return full;
    const columns = {};
    for (const [i, c] of board.columns.entries()) {
      const w = was[i];
      if (w?.id !== c.id || JSON.stringify({ ...w, itemIds: undefined }) !== JSON.stringify({ ...c, itemIds: undefined })) return full;
      if (JSON.stringify(w.itemIds) !== JSON.stringify(c.itemIds)) columns[c.id] = [...c.itemIds];
    }
    sync.columns = columns;
  }
  if (b.keys.get('nextNumber') !== a.keys.get('nextNumber')) sync.nextNumber = board.nextNumber;
  return sync;
}

// Compact JSON on disk: a big board is serialised once per write, not pretty-printed on top.
function persist(ctx, body = boardBody(ctx.board)) {
  ctx.board.updatedAt = now();
  const text = `{"updatedAt":${JSON.stringify(ctx.board.updatedAt)}${body === '{}' ? '' : `,${body.slice(1, -1)}`}}`;
  maybeBackup(ctx);
  writeFileAtomic(ctx.file, text);
  ctx.hash = sha256(text);
  writeHash(ctx);
}

function persistArchive(ctx) { writeFileAtomic(ctx.archiveFile, JSON.stringify(ctx.archive)); }

// Someone edited board.json by hand: adopt it, re-hash, tell everyone.
function watchBoard(ctx) {
  fs.watchFile(ctx.file, { interval: 1000 }, () => {
    let text;
    try { text = fs.readFileSync(ctx.file, 'utf8'); } catch { return; }
    const h = sha256(text);
    if (h === ctx.hash) return;
    try { ctx.board = normalizeBoard(JSON.parse(text)); } catch { console.warn(`[${ctx.id}] board.json edited externally but is not valid JSON — ignored`); return; }
    ctx.hash = h;
    writeHash(ctx);
    emit({ board: ctx.id, type: 'board.external-edit', actor: { kind: 'system', name: 'filesystem' } });
  });
}

function loadBoard(id) {
  const p = boardPaths(id);
  const text = fs.readFileSync(p.file, 'utf8');
  const ctx = { id, ...p, board: normalizeBoard(JSON.parse(text)), archive: readJson(p.archiveFile, { items: {} }), hash: sha256(text), lastBackup: 0 };
  if (M.sandbox && M.boardName && id === (M.defaultBoard || 'main')) ctx.board.name = M.boardName;
  boards.set(id, ctx);
  writeHash(ctx);
  watchBoard(ctx);
  return ctx;
}

function addColumn(board, c) {
  if (!c || !String(c.name || '').trim()) fail(400, 'Column "name" is required');
  const base = slug(c.id || c.name);
  let id = base;
  for (let n = 2; board.columns.some((x) => x.id === id); n++) id = `${base}-${n}`;
  const col = {
    id,
    name: str(c.name, 60).trim(),
    color: str(c.color || '#8b8fa3', 32),
    icon: str(c.icon || '', 32),
    flags: pickFlags(c.flags),
    itemIds: [],
  };
  board.columns.splice(resolveIndex(board.columns.map((x) => x.id), c.position), 0, col);
  return col;
}

function createBoard(d, actor) {
  const id = slug(d.id || d.name || '');
  if (!d.name && !d.id) fail(400, 'Board "name" is required');
  const tpl = TEMPLATES[d.template || 'default'];
  if (!tpl) fail(400, `Unknown template "${d.template}". Use: ${Object.keys(TEMPLATES).join(', ')} (see GET /api/templates)`);
  if (boards.has(id)) fail(409, `Board "${id}" already exists`);
  const p = boardPaths(id);
  fs.mkdirSync(p.attachDir, { recursive: true });
  const t = now();
  const board = {
    id,
    name: str(d.name || id, 80),
    idPrefix: str(d.idPrefix || id.replace(/-/g, '').slice(0, 4), 8).toUpperCase(),
    nextNumber: 1,
    createdAt: t,
    updatedAt: t,
    directives: str(d.directives ?? tpl.directives ?? '', 50_000),
    schema: { builtins: normBuiltins(d.schema?.builtins ?? tpl.schema?.builtins), fields: [] },
    digest: [],
    requests: [],
    focusBoards: [],
    activeFocus: null,
    coordinator: d.coordinator || null,
    columns: [],
    items: {},
  };
  for (const f of arr(d.schema?.fields ?? tpl.schema?.fields)) {
    const def = normField(f);
    if (board.schema.fields.some((x) => x.key === def.key)) fail(400, `Duplicate field "${def.key}"`);
    board.schema.fields.push(def);
  }
  board.ticketTemplates = arr(d.ticketTemplates ?? tpl.ticketTemplates).map((t) => normTicketTemplate(t));
  const cols = Array.isArray(d.columns) ? d.columns : tpl.columns;
  for (const c of cols) addColumn(board, c);
  const ctx = { id, ...p, board, archive: { items: {} }, hash: '', lastBackup: 0 };
  boards.set(id, ctx);
  persist(ctx);
  persistArchive(ctx);
  watchBoard(ctx);
  emit({ board: id, type: 'board.created', actor, name: board.name });
  return ctx;
}

/* ───────────────────────── transactions ───────────────────────── */

// Every mutation runs inside tx(): it either fully applies (saved + hashed + events emitted) or fully rolls back.
// The board is serialised twice per write (snapshot, then compare-and-save). The archive only grows, so only
// transactions that say they touch it ({ archive: true }) snapshot and save it.
function tx(ctx, fn, { archive = false } = {}) {
  const parts = boardParts(ctx.board);
  const before = parts.body;
  const updatedAt = ctx.board.updatedAt;
  const beforeArchive = archive ? JSON.stringify(ctx.archive) : null;
  const events = [];
  const outer = ctx.afterCommit;
  const hooks = ctx.afterCommit = [];
  let result;
  try {
    result = fn(events);
  } catch (e) {
    ctx.board = JSON.parse(before);
    ctx.board.updatedAt = updatedAt;
    if (archive) ctx.archive = JSON.parse(beforeArchive);
    throw e;
  } finally { ctx.afterCommit = outer; }
  const afterParts = boardParts(ctx.board);
  const after = afterParts.body;
  const from = ctx.hash;
  if (after !== before) persist(ctx, after);
  const archived = archive && JSON.stringify(ctx.archive) !== beforeArchive;
  if (archived) persistArchive(ctx);
  // The first event of a write tells the board page what it changed; the others carry the same hash, so the
  // page skips them.
  const sync = after !== before && events[0]?.board === ctx.id ? (archived ? { from, full: true } : syncOf(from, parts, afterParts, ctx.board)) : null;
  events.forEach((e, i) => emit(e, i === 0 ? sync : null));
  for (const h of hooks) h();
  return result;
}
// Work that must wait until the transaction it was asked for in is saved (and never happen if it rolls back),
// e.g. landing an approval's commits.
const afterCommit = (ctx, fn) => (ctx.afterCommit ? ctx.afterCommit.push(fn) : fn());

/* ───────────────────────── items ───────────────────────── */

function findColumn(board, ref) {
  if (ref == null || ref === '') fail(400, 'Column reference required');
  const r = String(ref);
  const col = board.columns.find((c) => c.id === r)
    || board.columns.find((c) => c.name.toLowerCase() === r.toLowerCase())
    || board.columns.find((c) => c.id === slug(r));
  if (!col) fail(404, `Column "${r}" not found. Columns: ${board.columns.map((c) => `${c.name} (${c.id})`).join(', ')}`);
  return col;
}

function getItem(ctx, id) {
  const key = String(id).toUpperCase();
  const item = ctx.board.items[id] || ctx.board.items[key];
  if (item) return item;
  if (ctx.archive.items[id] || ctx.archive.items[key]) fail(410, `${key} is archived. Restore it with POST /api/boards/${ctx.id}/archive/${key}/restore`);
  fail(404, `Item "${id}" not found on board "${ctx.id}"`);
}

const activeLease = (item) => (item.lease && Date.parse(item.lease.expiresAt) > Date.now() ? item.lease : null);

function snapshot(ctx, item) {
  const col = ctx.board.columns.find((c) => c.id === item.columnId);
  return {
    id: item.id, title: item.title, type: item.type, priority: item.priority,
    columnId: item.columnId, column: col ? col.name : null, parent: item.parent,
    claimant: activeLease(item)?.claimant || null, needsHuman: !!item.needsHuman, assignee: item.assignee || null,
  };
}

// Who this event is "addressed to": leaseholder, past leaseholders, whoever asked for help, agent author,
// assignee, thread participants, @mentions — minus the actor.
function recipientsFor(item, actor, extra = []) {
  const s = new Set(extra);
  const l = activeLease(item);
  if (l) s.add(l.claimant);
  if (item.needsHuman) s.add(item.needsHuman.raisedBy);
  if (item.author?.kind === 'agent') s.add(item.author.name);
  if (item.assignee) s.add(item.assignee);
  for (const w of item.workedBy || []) s.add(w); // released after review, still owns the follow-up
  for (const c of item.comments || []) if (c.author?.name) s.add(c.author.name); // thread participants
  s.delete(actor.name);
  return [...s];
}

// Housekeeping events never wake anyone (a status line from one agent must not wake the others).
const QUIET_TYPES = new Set(['lease.status', 'lease.renewed', 'item.reordered', 'reaction.added', 'reaction.removed']);
// @names in markdown that count as mentions: not inside `code`, ``` blocks or > quotes (so talking
// *about* an agent doesn't wake it).
const plainText = (md) => String(md || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
function mentionsIn(text) {
  return [...new Set([...plainText(text).matchAll(/(?:^|[\s(])@([\w.-]+)/g)].map((m) => m[1].replace(/[.-]+$/, '')))];
}
// Who an "explain" comment is for: its @mentions, else the agent it replies to, else whoever asked for the
// review, else whoever worked the ticket last, else the assignee. The event and …/work both use this.
function explainTargets(item, c) {
  const mentions = mentionsIn(c.body);
  if (mentions.length) return mentions;
  const target = (c.replyTo && item.comments.find((x) => x.id === c.replyTo)?.author) || null;
  const who = target?.kind === 'agent' ? target.name : item.questions?.find((q) => q.kind === 'review')?.raisedBy || item.workedBy?.at(-1) || item.assignee;
  return who ? [who] : [];
}

function itemEvent(ctx, type, item, actor, extra = {}) {
  const { mentions = [], ...rest } = extra;
  if (QUIET_TYPES.has(type)) {
    return { board: ctx.id, type, actor, itemId: item.id, columnId: item.columnId, item: snapshot(ctx, item), recipients: [], ...rest };
  }
  // An approval is news, not a task: the requester stays in recipients (inbox, …/work) but isn't woken for it.
  const approval = type === 'review.approved' || (type === 'attention.resolved' && rest.verdict === 'approve');
  const addressed = approval ? [] : [...new Set(mentions.filter((n) => n && n !== actor.name))];
  return {
    board: ctx.id, type, actor, itemId: item.id, columnId: item.columnId,
    // The master-lease holder works every ticket without leasing it, so it hears about all of them.
    item: snapshot(ctx, item), recipients: recipientsFor(item, actor, [...mentions, activeMaster(ctx)?.holder].filter((n) => n && n !== actor.name)),
    // addressed ⊆ recipients: the people this event is *for* (a mention, an assignment, a handover, an answer,
    // a verdict). Standing agents wake on these; the rest of the recipients just hear about it.
    ...(addressed.length ? { addressed } : {}),
    ...(mentions.length ? { mentions } : {}), ...rest,
  };
}

const permsFor = (name) => {
  const base = M.permissions[name] || M.permissions['*'] || null;
  const lim = standing?.limitsOf?.(name);
  if (!lim) return base;
  const low = (xs) => xs.map((x) => String(x).toLowerCase());
  const columns = base?.columns && lim.columns ? base.columns.filter((c) => low(lim.columns).includes(String(c).toLowerCase())) : (lim.columns || base?.columns || null);
  return { ...(base || {}), ...(columns ? { columns } : {}), readOnly: !!(base?.readOnly || lim.readOnly) };
};

/* Grants: powers that are human-only by default, delegated by the human to named agents. They live only in
   the human's files — agents.json ("grants") or the manifest's permissions — never in the API, and are
   re-read on every call, so removing one takes effect at once.
     "grants": ["review.decide", { "power": "column.gate", "where": { "column": ["Done"], "fields.risk": "low" } }]
   review.decide  approve / request changes on reviews     column.gate  move into / out of human-only columns
   agents.control pause / resume / run other standing agents
   An agent never uses a grant on its own work: a ticket it worked on, or a review it requested.
   The powers are listed in the permission library (lib/permissions.js) beside the tool permissions. */
const { POWERS, createLibrary: createPermLibrary } = require('./lib/permissions');
// Standing agents the human lets land approved work (work.land): a landing that fails goes to them, not the human.
const landers = () => { try { return standing.list().agents.filter((a) => a.enabled && grantsOf(a.name).some((g) => g.power === 'work.land')).map((a) => a.name); } catch { return []; } };
function grantsOf(name) {
  const raw = [...arr(standing?.grantsOf?.(name)), ...arr(M.permissions[name]?.grants)];
  return raw.map((g) => {
    if (typeof g === 'string') return { power: g };
    if (!isObj(g)) return null;
    const power = String(g.power || '');
    if (g.where == null) return { power };
    // A scope that can't be read as { key: value(s) } can't be trusted to narrow the power, so the grant is
    // dropped — no power beats every power (agents.json is hand-written: "fields.risk=low" is an easy slip).
    const ok = isObj(g.where) && Object.keys(g.where).length && Object.values(g.where).every((v) => [].concat(v).some((x) => String(x ?? '').trim()));
    if (ok) return { power, where: g.where };
    const key = `${name}:${power}:${JSON.stringify(g.where)}`;
    if (!badGrantsWarned.has(key)) { badGrantsWarned.add(key); console.warn(`agents.json: ${name}'s ${power} grant is ignored — its "where" must be an object like { "fields.risk": "low" }`); }
    return null;
  }).filter((g) => g && POWERS[g.power]);
}
const badGrantsWarned = new Set();
// Does a grant's scope cover this ticket? where: { column: name|id|[…], "<dotted path>": value|[values] }
// The commits a ticket would land (its author's, not yet on main), as one string: a verdict records it, so a
// later commit makes the verdict stale. Empty when the board has no worktrees or the ticket no commits.
// Routes that record or check a verdict look the commits up async first (withCommits), so git never runs inside
// their transaction; anywhere else (…/work for a reviewers.<name> grant, INT-212) still looks them up here.
const knownCommits = new Map(); // "<board>:<id>" → the commits string, for the request that looked it up
const commitsAuthor = (item) => (item.questions || []).find((q) => q.kind === 'review')?.raisedBy || item.review?.requestedBy || item.workedBy?.at(-1);
function ticketCommits(item, ctx = null) {
  if (ctx && knownCommits.has(`${ctx.id}:${item.id}`)) return knownCommits.get(`${ctx.id}:${item.id}`);
  const author = commitsAuthor(item);
  if (!author || !worktrees || !agentBranch(author)) return '';
  try { return worktrees.commitsFor(author, item.id).map((c) => c.sha).join(','); } catch { return ''; }
}
async function withCommits(ctx, id, fn) {
  const item = getItem(ctx, id);
  const author = commitsAuthor(item);
  const key = `${ctx.id}:${item.id}`;
  const commits = !author || !worktrees || !agentBranch(author) ? '' : (await worktrees.commitsForAsync(author, item.id).catch(() => [])).map((c) => c.sha).join(',');
  knownCommits.set(key, commits);
  try { return await fn(); } finally { if (knownCommits.get(key) === commits) knownCommits.delete(key); }
}
// A reviewer's verdict can stand in for the human only when the board checked who gave it (the reviewer has
// a token here) and nothing was committed on the ticket since.
const verdictStands = (item, r, ctx = null) => !!r.verified && (r.commits ?? '') === ticketCommits(item, ctx);
function inScope(ctx, item, where) {
  if (!where || !item) return true;
  return Object.entries(where).every(([k, want]) => {
    const wants = [].concat(want).map((v) => String(v).toLowerCase());
    if (k === 'column') {
      const col = ctx.board.columns.find((c) => c.id === item.columnId);
      return wants.includes(item.columnId.toLowerCase()) || wants.includes(String(col?.name).toLowerCase());
    }
    // reviewers.<name>: that reviewer's current verdict (ok | concerns). It counts only while it stands: given
    // with the reviewer's own token, and about the commits the ticket has now. No verdict matches nothing.
    const rv = /^reviewers\.([\w.-]+)$/.exec(k);
    if (rv) {
      const r = (item.reviewers || []).find((x) => x.name.toLowerCase() === rv[1].toLowerCase());
      return !!r?.verdict && verdictStands(item, r, ctx) && wants.includes(String(r.verdict).toLowerCase());
    }
    const have = [].concat(getPath(item, k) ?? []).map((v) => String(v).toLowerCase());
    return have.some((v) => wants.includes(v));
  });
}
const ownWork = (item, name) => !!item && ((item.workedBy || []).includes(name) || (item.questions || []).some((q) => q.kind === 'review' && q.raisedBy === name)
  || item.review?.requestedBy === name);
// The grant an agent would use for this action, or a fail() saying why not. Humans never need one.
// The human's one switch for approvals made on their behalf. Off suspends every grant that approves or moves
// work past a human gate (review.decide, column.gate) on this board until they switch it back on; landing work
// that was already approved goes on. The manifest's approvalsOff says where a board starts.
const APPROVAL_POWERS = new Set(['review.decide', 'column.gate']);
const approvalsOff = (ctx) => !!(ctx?.board?.approvalsOff ?? M.approvalsOff);
function grantFor(ctx, actor, power, item, what) {
  if (actor.kind === 'user') return null;
  const mine = grantsOf(actor.name).filter((g) => g.power === power);
  if (!mine.length) fail(403, `Only the human can ${what}`, { code: 'HUMAN_ONLY', hint: `The human can delegate this by adding "grants": ["${power}"] to your entry in agents.json` });
  if (APPROVAL_POWERS.has(power) && approvalsOff(ctx)) fail(403, 'Approvals for the human are switched off on this board', { code: 'APPROVALS_OFF', hint: 'Leave it for the human: they switch approvals back on from the Agents page' });
  if (power === 'review.decide' && item && !inActiveFocus(ctx, item)) fail(409, `${item.id} is outside the focus board "${activeFocus(ctx).name}": approvals wait until the human retires it`, { code: 'OUT_OF_FOCUS', hint: 'Leave it; work on the focus board tickets (your …/work lists them)' });
  if (item && ownWork(item, actor.name)) fail(403, `${actor.name} worked on ${item.id} or asked for its review — an agent never approves its own work`, { code: 'OWN_WORK', hint: 'Leave it for the human or another agent' });
  const g = mine.find((x) => inScope(ctx, item, x.where));
  if (!g) fail(403, `${item?.id || 'This'} is outside your ${power} grant (${JSON.stringify(mine.map((x) => x.where || 'any'))})`, { code: 'OUT_OF_SCOPE', hint: 'Leave it for the human' });
  return g;
}

// How the board is governed (gates, coordinator, rules, column order) is the human's: an agent may not
// loosen the rules it is held to.
function humanConfig(actor, what) {
  if (actor.kind !== 'user') fail(403, `Only the human can ${what}`, { code: 'HUMAN_ONLY', hint: 'Ask the human on a card (POST …/items/<id>/attention) to change it' });
}

// Per-agent column limits from the manifest (humans are never limited).
function checkColumnPerm(ctx, actor, colIds) {
  if (actor.kind !== 'agent') return;
  const p = permsFor(actor.name);
  if (!p?.columns) return;
  const allowed = arr(p.columns).map((x) => String(x).toLowerCase());
  for (const id of colIds) {
    const col = ctx.board.columns.find((c) => c.id === id);
    if (!allowed.includes(id) && !allowed.includes(col?.name.toLowerCase())) {
      fail(403, `${actor.name} may only change items in: ${arr(p.columns).join(', ')}`);
    }
  }
}

// Master lease: one agent holds the whole board (no per-ticket leases needed). Other agents become
// read-only except for comments, questions and the digest; humans are never blocked.
const activeMaster = (ctx) => {
  const m = ctx.board.master;
  return m && (!m.expiresAt || Date.parse(m.expiresAt) > Date.now()) ? m : null;
};
function guardBoard(ctx, actor) {
  const m = activeMaster(ctx);
  if (m && actor.kind === 'agent' && m.holder !== actor.name) {
    fail(423, `Board "${ctx.id}" is held by ${m.holder} (master lease). You can still comment, ask the human, or post to the digest.`, { code: 'BOARD_HELD', hint: 'Comment, ask (POST …/attention) or wait for master.released', master: m });
  }
}

function claimMaster(ctx, d, actor) {
  return tx(ctx, (events) => {
    const cur = activeMaster(ctx);
    if (cur && cur.holder !== actor.name && !(d.force && actor.kind === 'user')) fail(409, `Board is already held by ${cur.holder}`, { master: cur });
    const others = Object.values(ctx.board.items).map((it) => activeLease(it)).filter((l) => l && l.claimant !== actor.name);
    if (others.length && !(d.force && actor.kind === 'user')) {
      fail(409, `Other leases are active (${[...new Set(others.map((l) => l.claimant))].join(', ')}). Wait for them to be released.`, { code: 'LEASES_ACTIVE', hint: 'They must finish (POST …/finish) or a human can force it', leases: others });
    }
    const minutes = Number(d.minutes) > 0 ? clamp(Number(d.minutes), 1, 60 * 24 * 30) : null;
    const renew = !!cur && cur.holder === actor.name;
    ctx.board.master = {
      holder: actor.name, kind: actor.kind,
      since: renew ? cur.since : now(),
      expiresAt: minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null,
      ...(d.status ? { status: str(d.status, 140), statusAt: now() } : renew && cur.status ? { status: cur.status, statusAt: cur.statusAt } : {}),
    };
    if (cur && !renew) events.push({ board: ctx.id, type: 'master.revoked', actor, holder: cur.holder, recipients: [cur.holder] });
    events.push({ board: ctx.id, type: renew ? 'master.renewed' : 'master.claimed', actor, holder: actor.name, expiresAt: ctx.board.master.expiresAt });
    return ctx.board.master;
  });
}

function releaseMaster(ctx, actor) {
  return tx(ctx, (events) => {
    const cur = ctx.board.master;
    if (!cur) return null;
    if (actor.kind === 'agent' && cur.holder !== actor.name) fail(403, `Only ${cur.holder} (or a human) can release the board`);
    ctx.board.master = null;
    events.push({ board: ctx.id, type: cur.holder === actor.name ? 'master.released' : 'master.revoked', actor, holder: cur.holder, recipients: [cur.holder].filter((n) => n !== actor.name) });
    return null;
  });
}

function guardWrite(ctx, item, actor) {
  guardBoard(ctx, actor);
  checkColumnPerm(ctx, actor, [item.columnId]);
  const l = activeLease(item);
  if (l && actor.kind === 'agent' && l.claimant !== actor.name) {
    fail(423, `${item.id} is leased by ${l.claimant} until ${l.expiresAt}`, { code: 'LEASED', hint: 'Pick another ticket, comment on this one, or wait for lease.released', lease: l });
  }
}

function checkWip(col) {
  if (col.flags.wipLimit > 0 && col.itemIds.length >= col.flags.wipLimit) fail(409, `"${col.name}" is at its WIP limit (${col.flags.wipLimit})`, { code: 'WIP_LIMIT', hint: `Finish something in "${col.name}" first` });
}

function resolveIndex(list, pos) {
  if (pos == null || pos === '' || pos === 'bottom' || pos === 'end') return list.length;
  if (pos === 'top' || pos === 'start') return 0;
  if (isObj(pos)) {
    const ref = pos.before ?? pos.after;
    const i = list.indexOf(ref);
    if (i >= 0) return pos.before != null ? i : i + 1;
    return list.length;
  }
  const n = Number(pos);
  if (!Number.isFinite(n)) fail(400, `Invalid position "${pos}". Use a number, "top", "bottom", or beforeId/afterId`);
  return clamp(Math.trunc(n), 0, list.length);
}

const doneColumnId = (ctx) => ctx.board.columns[ctx.board.columns.length - 1]?.id;
const openBlockersOf = (ctx, item) => (item.blockedBy || []).filter((id) => ctx.board.items[id] && ctx.board.items[id].columnId !== doneColumnId(ctx));

// When a blocker lands in the done column (or is archived), tell whoever waits on the items it blocked.
function emitUnblocked(ctx, resolvedId, actor, events) {
  for (const it of Object.values(ctx.board.items)) {
    if (it.id === resolvedId || !it.blockedBy?.includes(resolvedId) || openBlockersOf(ctx, it).length) continue;
    events.push(itemEvent(ctx, 'item.unblocked', it, actor, { resolvedBy: resolvedId, mentions: [asleep(ctx, it) ? null : it.assignee, activeLease(it)?.claimant].filter(Boolean) }));
  }
}

const positionOf = (d) => (d.beforeId ? { before: String(d.beforeId).toUpperCase() } : d.afterId ? { after: String(d.afterId).toUpperCase() } : d.position);

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain', md: 'text/markdown', json: 'application/json',
  csv: 'text/csv', zip: 'application/zip', mp4: 'video/mp4', webm: 'video/webm',
};
const MAX_ATTACHMENT = 15 * 1024 * 1024;

// A file the board reads from disk for someone (attachment or avatar by path). Tokens (local.json) and the
// board's own data are never read, for anyone; agents read only from the project, their worktrees and the
// OS temp folder. Agents elsewhere send dataBase64.
function readablePath(actor, raw) {
  const given = path.resolve(String(raw));
  if (!fs.existsSync(given)) fail(400, `File not found: ${given} (use an absolute path)`);
  const real = fs.realpathSync.native(given); // through symlinks and junctions
  const norm = (p) => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const inside = (dir) => { try { dir = fs.realpathSync.native(dir); } catch { /* not there: compare as is */ } const rel = path.relative(norm(dir), norm(real)); return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel)); };
  const hint = 'Attach a file from the project, your worktree or the temp folder, or send its contents as dataBase64';
  if (path.basename(norm(real)) === 'local.json' || inside(DATA)) fail(403, 'The board never reads its own tokens or data as an attachment', { code: 'FORBIDDEN', hint });
  if (actor.kind !== 'user' && ![PROJECT_ROOT, path.join(path.dirname(MANIFEST_PATH), 'worktrees'), os.tmpdir()].some(inside)) {
    fail(403, `${real} is outside the folders agents may attach from`, { code: 'FORBIDDEN', hint });
  }
  return real;
}

function saveAttachment(ctx, item, a, actor) {
  if (!isObj(a)) fail(400, 'Attachment must be an object');
  if (a.url && !a.dataBase64 && !a.data && !a.path) {
    return { id: rid('a'), kind: 'link', name: str(a.name || a.url, 120), url: str(a.url, 2000), addedAt: now(), author: actor };
  }
  let buf;
  let name = a.name;
  if (a.dataBase64 || a.data) buf = Buffer.from(String(a.dataBase64 || a.data).replace(/^data:[^,]*,/, ''), 'base64');
  else if (a.path) {
    const p = readablePath(actor, a.path);
    buf = fs.readFileSync(p);
    name = name || path.basename(p);
  } else fail(400, 'Attachment needs one of: dataBase64, path, url');
  if (buf.length > MAX_ATTACHMENT) fail(413, 'Attachment exceeds 15 MB');
  const safe = String(name || 'file').replace(/[^\w.-]+/g, '_').slice(-80);
  const file = `${item.id}-${crypto.randomBytes(3).toString('hex')}-${safe}`;
  fs.mkdirSync(ctx.attachDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.attachDir, file), buf);
  const ext = path.extname(safe).slice(1).toLowerCase();
  return {
    id: rid('a'), kind: 'file', name: safe, mime: a.mime || MIME[ext] || 'application/octet-stream',
    size: buf.length, url: `/files/${ctx.id}/${encodeURIComponent(file)}`, addedAt: now(), author: actor,
  };
}

function parseNeedsHuman(v, actor) {
  if (!v) return null;
  const reason = typeof v === 'string' ? v : v.reason;
  const kind = isObj(v) && v.kind === 'review' ? 'review' : 'question';
  const form = isObj(v) && kind === 'question' ? normForm(v.form) : null;
  return { id: rid('q'), reason: str(reason || 'Needs input', 2000), raisedBy: actor.name, raisedAt: now(), kind, ...(form ? { form } : {}) };
}

/* Forms on questions (INT-88): the agent names the fields and the board draws the controls, so nothing an
   agent writes runs on the human's screen. A question without a form works as before. */
const FORM_TYPES = ['text', 'longtext', 'choice', 'multi', 'yesno', 'number', 'date', 'note'];
const FORM_HINT = 'form is a list of { key, label, type: text|longtext|choice|multi|yesno|number|date, options? (choice, multi), required?, default?, help?, min?, max? (number) }, mixed with { type: "note", markdown }';
const formFail = (msg) => fail(400, `form: ${msg}`, { code: 'BAD_REQUEST', hint: FORM_HINT });
function normForm(form) {
  if (form == null) return null;
  if (!Array.isArray(form) || !form.length) formFail('must be a non-empty list of fields');
  if (form.length > 40) formFail('at most 40 entries');
  const keys = new Set();
  const out = form.map((f, i) => {
    if (!isObj(f)) formFail(`entry ${i + 1} must be an object`);
    const type = f.type ?? 'text';
    if (!FORM_TYPES.includes(type)) formFail(`entry ${i + 1}: unknown type "${type}" (allowed: ${FORM_TYPES.join(', ')})`);
    if (type === 'note') {
      const markdown = String(f.markdown ?? f.text ?? '').trim() || formFail(`entry ${i + 1}: a note needs "markdown"`);
      return { type, markdown: str(markdown, 4000) };
    }
    const key = String(f.key ?? '');
    if (!/^[A-Za-z][\w-]{0,39}$/.test(key)) formFail(`entry ${i + 1}: "key" must start with a letter, then letters, digits, _ or - (40 at most)`);
    if (keys.has(key)) formFail(`duplicate key "${key}"`);
    keys.add(key);
    const field = { key, type, label: str(String(f.label ?? key), 200) };
    if (f.help) field.help = str(String(f.help), 500);
    if (f.required) field.required = true;
    if (type === 'choice' || type === 'multi') {
      const opts = Array.isArray(f.options) ? f.options : [];
      if (!opts.length || opts.length > 30) formFail(`"${key}": ${type} needs 1–30 "options"`);
      field.options = opts.map((o) => {
        const value = String((isObj(o) ? o.value : o) ?? '').slice(0, 200) || formFail(`"${key}": every option needs a value`);
        return { value, label: str(String((isObj(o) && o.label) || value), 200) };
      });
      if (new Set(field.options.map((o) => o.value)).size !== field.options.length) formFail(`"${key}": options repeat a value`);
    }
    if (type === 'number') for (const k of ['min', 'max']) if (f[k] != null) field[k] = Number.isFinite(+f[k]) ? +f[k] : formFail(`"${key}": "${k}" must be a number`);
    if (f.default != null) field.default = formValue(field, f.default, (m) => formFail(`"${key}": default ${m}`));
    return field;
  });
  if (!keys.size) formFail('needs at least one field to answer (notes alone ask nothing)');
  return out;
}

// One answer, checked against its field. `bad` throws.
function formValue(f, v, bad) {
  const say = { text: 'must be text', boolean: 'must be true or false', number: 'must be a number', date: 'must be a date, YYYY-MM-DD', type: 'has no answer type' };
  return checkValue(f, v, true, (problem, d) => bad(
    problem === 'range' ? `must be between ${f.min ?? '−∞'} and ${f.max ?? '∞'}`
      : problem === 'option' ? `must be one of: ${d.join(', ')}`
        : problem === 'list' ? `must be a list from: ${d.join(', ')}` : say[problem]));
}

// The human's answers to a form: every key known, required ones present; unanswered optional ones are null.
function formAnswers(form, answers) {
  const fields = form.filter((f) => f.type !== 'note');
  const bad = (m) => fail(400, `answers: ${m}`, { code: 'BAD_REQUEST', hint: `answers is { key: value } for this form: ${fields.map((f) => `${f.key} (${f.type}${f.required ? ', required' : ''})`).join(', ')}` });
  if (!isObj(answers)) bad('must be an object of { key: value }');
  for (const k of Object.keys(answers)) if (!fields.some((f) => f.key === k)) bad(`unknown field "${k}"`);
  const out = {};
  for (const f of fields) {
    const v = answers[f.key];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) { if (f.required) bad(`"${f.label}" is required`); out[f.key] = null; continue; }
    out[f.key] = formValue(f, v, (m) => bad(`"${f.label}" ${m}`));
  }
  return out;
}

// The answers as a comment anyone can read on the card.
function formSummary(form, values) {
  const show = (f, v) => v == null ? '—' : f.type === 'yesno' ? (v ? 'Yes' : 'No')
    : f.options ? [].concat(v).map((x) => f.options.find((o) => o.value === x)?.label ?? x).join(', ') : String(v);
  return form.filter((f) => f.type !== 'note').map((f) => `**${f.label}:** ${show(f, values[f.key])}`).join('\n');
}

// A ticket can carry several open questions. `needsHuman` mirrors the oldest one so older clients,
// filters and the UI's "needs you" flag keep working.
function syncNeeds(item) { item.questions ||= item.needsHuman ? [{ id: rid('q'), ...item.needsHuman }] : []; item.needsHuman = item.questions[0] || null; }

// Open a question (an identical open one from the same asker is reused). Returns it.
function openQuestion(ctx, item, q, actor, events) {
  syncNeeds(item);
  const same = item.questions.find((x) => x.raisedBy === q.raisedBy && x.reason === q.reason && x.kind === q.kind
    && JSON.stringify(x.form || null) === JSON.stringify(q.form || null));
  if (same) return same;
  item.questions.push(q);
  syncNeeds(item);
  events.push(itemEvent(ctx, 'attention.raised', item, actor, { questionId: q.id, reason: q.reason, kind: q.kind, open: item.questions.length }));
  return q;
}

// Close questions (all, or those matching `pick`), each with its own event; the reply is posted once.
function closeQuestions(ctx, item, actor, events, { pick = () => true, reply = null, extra = {} } = {}) {
  syncNeeds(item);
  const closing = item.questions.filter(pick);
  if (!closing.length) return [];
  item.questions = item.questions.filter((q) => !closing.includes(q));
  syncNeeds(item);
  for (const q of closing) {
    closeWait(item, q, actor, { ...(extra.form ? { form: extra.form } : {}), ...(extra.withdrawn ? { withdrawn: true } : {}) });
    events.push(itemEvent(ctx, 'attention.resolved', item, actor, { questionId: q.id, raisedBy: q.raisedBy, reason: q.reason, kind: q.kind, reply, open: item.questions.length, mentions: [q.raisedBy], ...extra }));
  }
  return closing;
}

// Review column: one flagged `review`, else the column just before the first human-only gate.
function reviewColumn(ctx) {
  const cols = ctx.board.columns;
  const flagged = cols.find((c) => c.flags.review);
  if (flagged) return flagged;
  const gate = cols.findIndex((c) => c.flags.humanOnlyIn);
  return gate > 0 ? cols[gate - 1] : null;
}

const REVIEW_PARTS = [['changed', 'What changed'], ['why', 'Why'], ['verify', 'How to verify'], ['evidence', 'Evidence'], ['risks', 'Risks and open questions']];

/* Agent reviewers (INT-64): specialists the receptionist (or the human) asks to look at a ticket in review.
   They comment — ✅ looks good, or ⚠ concerns with the author @mentioned — and the card shows their ticks.
   They never decide the review: the human still approves into Done. */
const isReviewer = (name) => { try { return !!standing?.get(name).reviewer; } catch { return false; } };
// every agent marked as a reviewer, paused ones too (the receptionist can resume them)
const reviewerPool = () => { try { return (standing?.list().agents || []).filter((a) => a.reviewer); } catch { return []; } };
const authorsOf = (item) => new Set([item.review?.requestedBy, ...(item.questions || []).filter((q) => q.kind === 'review').map((q) => q.raisedBy), ...(item.workedBy || []), item.assignee].filter(Boolean));
const mayAssignReviewers = (ctx, actor) => actor.kind === 'user' || isCoordinator(ctx, actor.name);
function addReviewer(ctx, id, d, actor) {
  if (!mayAssignReviewers(ctx, actor)) fail(403, 'Only the human or the receptionist assigns reviewers', { code: 'HUMAN_ONLY' });
  const who = str(d.name || d.reviewer || '', 64).trim();
  if (!who) fail(400, '"name" is required');
  if (!isReviewer(who)) fail(400, `${who} is not a reviewer — switch on "Can review" in its Speciality (or "reviewer": true in agents.json)`, { code: 'NOT_REVIEWER', hint: `Reviewers: ${reviewerPool().map((a) => a.name).join(', ') || 'none yet'}` });
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    if (authorsOf(item).has(who)) fail(403, `${who} worked on ${item.id} — a reviewer must be someone else`, { code: 'OWN_WORK' });
    item.reviewers ||= [];
    if (item.reviewers.some((r) => r.name === who)) return item;
    item.reviewers.push({ name: who, by: actor.name, at: now(), verdict: null });
    item.version++;
    item.updatedAt = now();
    events.push(itemEvent(ctx, 'review.reviewer_assigned', item, actor, { reviewer: who, mentions: [who] }));
    return item;
  });
}
function removeReviewer(ctx, id, name, actor) {
  if (!mayAssignReviewers(ctx, actor)) fail(403, 'Only the human or the receptionist removes reviewers', { code: 'HUMAN_ONLY' });
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    const before = (item.reviewers || []).length;
    item.reviewers = (item.reviewers || []).filter((r) => r.name !== name);
    if (item.reviewers.length === before) return item;
    item.version++;
    item.updatedAt = now();
    events.push(itemEvent(ctx, 'review.reviewer_removed', item, actor, { reviewer: name }));
    return item;
  });
}
function reviewerVerdict(ctx, id, name, d, actor) {
  if (actor.name !== name) fail(403, 'Only that reviewer gives its verdict', { code: 'FORBIDDEN' });
  const verdict = ['ok', 'approve', 'good'].includes(d.verdict) ? 'ok' : d.verdict === 'concerns' ? 'concerns' : fail(400, '"verdict" must be "ok" or "concerns"');
  const comment = str(d.comment || '', 20_000).trim();
  if (verdict === 'concerns' && !comment) fail(400, 'Say what concerns you in "comment"');
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    const r = (item.reviewers || []).find((x) => x.name === name);
    if (!r) fail(404, `${name} is not a reviewer on ${item.id}`);
    if (authorsOf(item).has(name)) fail(403, `${name} has worked on ${item.id} since being asked to review it — a reviewer never judges its own work`, { code: 'OWN_WORK', hint: 'Leave the verdict to another reviewer or the human' });
    const author = (item.questions || []).find((q) => q.kind === 'review')?.raisedBy || item.review?.requestedBy || item.workedBy?.at(-1) || null;
    const ask = verdict === 'concerns' && author && !comment.includes(`@${author}`) ? `\n\n@${author} please take a look.` : '';
    const body = `${verdict === 'ok' ? '✅ **Looks good**' : '⚠ **Concerns**'} — review by ${name}${comment ? `\n\n${comment}` : ''}${ask}`;
    const c = { id: rid('c'), author: actor, body, createdAt: now() };
    item.comments.push(c);
    // verified: the board checked the reviewer's token (a name with a token must send it); commits: what was
    // reviewed, so a later commit makes the verdict stale for anyone relying on it.
    Object.assign(r, { verdict, at: c.createdAt, commentId: c.id, verified: !!M.auth.agentTokens?.[name], commits: ticketCommits(item, ctx) });
    item.version++;
    item.updatedAt = c.createdAt;
    events.push(itemEvent(ctx, 'comment.added', item, actor, { comment: { id: c.id, body: trimChange(body) }, mentions: mentionsIn(body) }));
    events.push(itemEvent(ctx, 'review.reviewed', item, actor, { reviewer: name, verdict }));
    return item;
  });
}

// commits: the ticket's commits on the agent's branch, looked up by the caller before the transaction (git
// never runs inside one).
function requestReview(ctx, id, d, actor, commits = null) {
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    if (item.columnId === doneColumnId(ctx)) fail(409, `${item.id} is already done (approved) — it can't go back to review`, { code: 'ALREADY_DONE', hint: 'If something is left to do, file a new ticket or comment on this one' });
    const col = d.column ? findColumn(ctx.board, d.column) : reviewColumn(ctx);
    if (!col) fail(400, 'No review column. Flag one with { "flags": { "review": true } } or pass "column".');
    guardWrite(ctx, item, actor);
    if (item.columnId !== col.id) moveInto(ctx, item, col.id, 'top', actor, events);
    // A review explains itself in four parts (what changed / why / how to verify / risks); a plain
    // summary still works. The parts become one readable comment and travel with the review question.
    const part = (k) => str(d[k] || '', 8000).trim();
    const notes = Object.fromEntries(REVIEW_PARTS.map(([k]) => [k, part(k)]).filter(([, v]) => v));
    let summary = str(d.summary || '', 20_000).trim();
    if (Object.keys(notes).length) {
      summary = [summary, ...REVIEW_PARTS.filter(([k]) => notes[k]).map(([k, label]) => `**${label}**\n${notes[k]}`)].filter(Boolean).join('\n\n');
    }
    const wt = actor.kind === 'agent' && worktrees ? agentBranch(actor.name) : null;
    let landing = 0; // commits approval will land on main: the review card and Approve's label read it
    if (wt) {
      commits ||= []; // the route looked them up before the transaction
      landing = commits.length;
      summary = [summary, commits.length
        ? `**Commits** on \`${wt.branch}\` (they land on approval)\n${commits.map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.subject}`).join('\n')}`
        : `⚠ No commits mentioning ${item.id} on \`${wt.branch}\` — approving lands nothing.`].filter(Boolean).join('\n\n');
    }
    const cid = summary ? rid('c') : null;
    if (summary) item.comments.push({ id: cid, author: actor, body: summary, createdAt: now(), ...(Object.keys(notes).length ? { review: notes } : {}) });
    const lease = item.lease;
    if (lease && lease.claimant === actor.name) item.lease = null;
    syncNeeds(item);
    // Asked again before a decision (INT-172): the earlier, undecided request's comment is marked as
    // replaced, and the thread folds it to one line. Decided reviews closed their question, so never fold.
    const prev = item.questions.find((q) => q.kind === 'review');
    if (prev && cid && prev.raisedBy === actor.name) {
      const old = prev.commentId ? item.comments.find((c) => c.id === prev.commentId)
        : item.comments.findLast((c) => c.review && c.id !== cid && c.author?.name === actor.name && c.createdAt <= prev.raisedAt);
      if (old) old.replacedBy = cid;
    }
    item.questions = item.questions.filter((q) => q.kind !== 'review');
    // The review card shows this text: keep the summary's whole first paragraph, not a clipped line.
    const rq = parseNeedsHuman({ reason: str(d.reason || notes.changed?.split(/\n\s*\n/)[0] || (summary ? summary.split(/\n\s*\n/)[0] : 'Ready for review'), 2000), kind: 'review' }, actor);
    if (Object.keys(notes).length) rq.notes = notes;
    else if (summary) rq.notes = { changed: summary };
    if (landing) rq.landing = landing;
    if (cid) rq.commentId = cid;
    item.version++;
    item.updatedAt = now();
    if (lease && !item.lease) events.push(itemEvent(ctx, 'lease.released', item, actor, { claimant: lease.claimant, reason: 'review requested' }));
    events.push(itemEvent(ctx, 'review.requested', item, actor, { summary: trimChange(summary) || null, reason: rq.reason }));
    openQuestion(ctx, item, rq, actor, events);
    // asked again (e.g. after changes): every assigned reviewer looks again
    for (const r of item.reviewers || []) {
      if (!r.verdict) continue;
      r.verdict = null;
      events.push(itemEvent(ctx, 'review.reviewer_assigned', item, actor, { reviewer: r.name, again: true, mentions: [r.name] }));
    }
    return item;
  });
}

function createItem(ctx, d, actor) {
  return tx(ctx, (events) => {
    const b = ctx.board;
    const template = d.template ? ticketTemplate(ctx, d.template).key : null;
    d = withTemplate(ctx, d);
    const ref = d.columnId ?? d.column;
    const col = ref != null ? findColumn(b, ref) : b.columns.find((c) => c.flags.allowCreate);
    if (!col) fail(400, 'No column on this board allows item creation');
    if (actor.kind !== 'user' && col.flags.humanOnlyIn) fail(403, `Only a human can add items to "${col.name}"`);
    const beds = b.columns.filter((c) => c.flags.sleeping);
    if (actor.kind === 'agent' && beds.length && !col.flags.sleeping && !isCoordinator(ctx, actor.name)) {
      fail(403, `New tickets from agents go to ${beds.map((c) => c.name).join(' or ')}, where they wait; the coordinator decides where they go from there`, { code: 'SLEEPING', hint: `Create it with "column": "${beds[0].name}"` });
    }
    checkColumnPerm(ctx, actor, [col.id]);
    if (!col.flags.allowCreate) fail(403, `Column "${col.name}" does not allow item creation. Allowed: ${b.columns.filter((c) => c.flags.allowCreate).map((c) => c.name).join(', ') || '(none)'}`);
    checkWip(col);
    if (!String(d.title || '').trim()) fail(400, '"title" is required');
    // Created on a focus board: made on this board and added to that focus board.
    const focus = d.focus ? getFocus(ctx, d.focus) : null;
    if (focus) guardFocus(ctx, actor, {});
    const id = `${b.idPrefix}-${b.nextNumber++}`;
    const t = now();
    const item = {
      id,
      title: str(d.title, 200).trim(),
      description: str(d.description, 100_000),
      type: oneOf(d.type, TYPES, 'task'),
      priority: oneOf(d.priority, PRIORITIES, 'Medium'),
      parent: d.parent ? str(d.parent, 60).trim() : null,
      columnId: col.id,
      enteredColumnAt: t,
      author: actor,
      createdAt: t,
      updatedAt: t,
      version: 1,
      lease: null,
      assignee: d.assignee ? str(d.assignee, 64).trim() : null,
      needsHuman: null,
      questions: [],
      blockedBy: arr(d.blockedBy).map((x) => String(x).toUpperCase()).filter((x) => b.items[x] || ctx.archive.items[x]),
      properties: isObj(d.properties) ? d.properties : {},
      fields: {},
      cover: 'auto',
      attachments: [],
      comments: [],
      flow: [{ col: col.id, at: t }],
      ...(template ? { template } : {}),
      // Disposable: may be permanently deleted. Chosen at creation, never changed.
      ...(d.test === true ? { test: true } : {}),
    };
    applyFields(ctx, item, d.fields, actor, null, true);
    // "Let the agent write it": the coordinator rewrites the ticket from these notes, except the values the
    // human set on purpose (explicit). The notes are kept so the rewrite can quote them.
    if (d.agentWrite) {
      const writer = requestTarget(ctx, d.writer);
      if (!writer) fail(400, 'No agent to write this ticket: set a coordinator (Agents page) or pass "writer".', { code: 'NO_AGENT' });
      item.agentDraft = {
        writer, by: actor.name, at: t,
        explicit: [...new Set(arr(d.explicit).map((k) => String(k)).filter((k) => /^[\w.-]{1,80}$/.test(k)))].slice(0, 60),
        original: { title: item.title, description: item.description },
      };
    }
    b.items[id] = item;
    col.itemIds.splice(resolveIndex(col.itemIds, positionOf(d)), 0, id);
    for (const a of arr(d.attachments)) item.attachments.push(saveAttachment(ctx, item, a, actor));
    events.push(itemEvent(ctx, 'item.created', item, actor, item.agentDraft ? { mentions: [item.agentDraft.writer], draft: true } : {}));
    if (focus) events.push(focusEvent(ctx, 'focus.updated', focus, actor, { added: addToFocus(ctx, focus, [id]), removed: [], changes: {} }));
    if (item.assignee) events.push(itemEvent(ctx, 'item.assigned', item, actor, { assignee: item.assignee, from: null, mentions: asleep(ctx, item) ? [] : [item.assignee] }));
    const q0 = parseNeedsHuman(d.needsHuman, actor);
    if (q0) openQuestion(ctx, item, q0, actor, events);
    return item;
  });
}

function moveInto(ctx, item, colRef, position, actor, events, { gateBy = null } = {}) {
  const b = ctx.board;
  const from = findColumn(b, item.columnId);
  const to = colRef != null && colRef !== '' ? findColumn(b, colRef) : from;
  const cross = from.id !== to.id;
  let gated = false;
  if (cross) {
    if (!from.flags.allowMoveOut) fail(403, `Items cannot leave "${from.name}"`);
    if (!to.flags.allowMoveIn) fail(403, `"${to.name}" does not accept moved items`);
    // Waking a ticket is the human's call, or the coordinator's for a ticket an agent filed.
    if (from.flags.sleeping && !to.flags.sleeping && actor.kind === 'agent' && !(isCoordinator(ctx, actor.name) && item.author?.kind === 'agent')) {
      fail(403, `${item.id} is asleep in "${from.name}": only the human${item.author?.kind === 'agent' ? ' or the coordinator' : ''} moves it on`, { code: 'SLEEPING', hint: 'Ask on the card' });
    }
    // Human-only gates: an agent passes only with a column.gate grant (a delegated review carries its own).
    const leavingDone = from.id === doneColumnId(ctx);
    gated = actor.kind !== 'user' && !!(to.flags.humanOnlyIn || from.flags.humanOnlyOut || leavingDone);
    if (gated && !gateBy) {
      if (!grantsOf(actor.name).some((g) => g.power === 'column.gate')) {
        if (to.flags.humanOnlyIn) fail(403, `Only a human can move items into "${to.name}". Move it to the column before and ask for review.`, { code: 'HUMAN_ONLY', hint: 'POST …/items/<id>/review { summary }' });
        fail(403, `Only a human can move items out of "${from.name}"`, { code: 'HUMAN_ONLY' });
      }
      if (to.flags.humanOnlyIn && (item.questions || []).some((q) => q.kind === 'review')) fail(409, `${item.id} has an open review — decide it instead of moving it`, { code: 'REVIEW_OPEN', hint: `POST /api/boards/${ctx.id}/items/${item.id}/review/decision { "verdict": "approve" | "changes", "comment": "…" } (needs the review.decide grant)` });
      if (to.flags.humanOnlyIn && reviewWithdrawnUndecided(item)) fail(409, `${item.id}'s review was withdrawn and never decided — it doesn't go through the gate on an agent's move`, { code: 'REVIEW_OPEN', hint: 'Request review again, or leave it for the human' });
      gateBy = grantFor(ctx, actor, 'column.gate', item, `move items ${to.flags.humanOnlyIn ? `into "${to.name}"` : `out of "${from.name}"`}`);
    }
    checkColumnPerm(ctx, actor, [to.id]);
    checkWip(to);
    // A human moving a ticket with an open review into an approval gate (e.g. Done) approves it.
    // Other open questions stay; moving backwards implies nothing (changes need feedback text).
    if (actor.kind === 'user' && to.flags.humanOnlyIn && (item.questions || []).some((q) => q.kind === 'review')) {
      recordVerdict(ctx, item, actor, events, 'approve', `Approved ✓ (moved to ${to.name})`);
    }
  }
  const oldIdx = from.itemIds.indexOf(item.id);
  from.itemIds.splice(oldIdx, 1);
  const idx = resolveIndex(to.itemIds, position);
  to.itemIds.splice(idx, 0, item.id);
  if (cross) {
    enterColumn(item, to.id);
    // Out of a sleeping column (into Ready): the ticket is awake now, so its assignee is called to it.
    const woken = from.flags.sleeping && !to.flags.sleeping && item.assignee && item.assignee !== actor.name ? [item.assignee] : [];
    events.push(itemEvent(ctx, 'item.moved', item, actor, { fromColumnId: from.id, columnId: to.id, position: idx, ...(woken.length ? { mentions: woken } : {}), ...(gated ? { delegated: { power: gateBy.power, onBehalfOf: 'human' } } : {}) }));
    if (to.flags.releaseLeaseOnEnter && item.lease) {
      const c = item.lease.claimant;
      item.lease = null;
      events.push(itemEvent(ctx, 'lease.released', item, actor, { claimant: c, reason: `entered ${to.name}`, mentions: [c] }));
    }
    if (to.id === doneColumnId(ctx)) emitUnblocked(ctx, item.id, actor, events);
    return true;
  }
  if (idx !== oldIdx) { events.push(itemEvent(ctx, 'item.reordered', item, actor, { from: oldIdx, position: idx })); return true; }
  return false;
}

const PATCHABLE = ['title', 'description', 'type', 'priority', 'parent', 'blockedBy', 'needsHuman', 'properties', 'replaceProperties', 'fields', 'cover', 'assignee', 'agentDraft',
  'columnId', 'column', 'position', 'beforeId', 'afterId', 'version'];

function trimChange(v) { return typeof v === 'string' && v.length > 400 ? `${v.slice(0, 400)}…` : v; }

function applyPatch(ctx, item, p, actor, events) {
  if ('test' in p) fail(400, `"test" is set when a ticket is created and can't change afterwards (${item.id} is ${item.test ? '' : 'not '}a test ticket)`, { code: 'IMMUTABLE', hint: item.test ? 'Delete it when done: DELETE …/items/<ID>' : 'Create a new ticket with "test": true, or archive this one' });
  const unknown = Object.keys(p).filter((k) => !PATCHABLE.includes(k));
  if (unknown.length) fail(400, `Unknown field(s): ${unknown.join(', ')}. Patchable: ${PATCHABLE.join(', ')}. Put custom data in "properties". Leases use /lease, comments use /comments.`, { code: 'UNKNOWN_FIELD' });
  guardWrite(ctx, item, actor);
  if (actor.kind === 'user') {
    const bi = ctx.board.schema.builtins;
    for (const k of ['type', 'priority', 'parent', 'description', 'blockedBy', 'properties', 'cover', 'assignee']) {
      if (k in p && bi[k].ui !== 'edit') fail(403, `"${bi[k].label}" is read-only in the UI`);
    }
  }
  // While an agent is writing the ticket, the values the human set stay theirs.
  if (item.agentDraft && actor.kind === 'agent') {
    const touched = [
      ...['title', 'description', 'type', 'priority', 'parent', 'blockedBy', 'assignee', 'cover'].filter((k) => k in p),
      ...Object.keys(isObj(p.fields) ? p.fields : {}).map((k) => `fields.${k}`),
      ...Object.keys(isObj(p.properties) ? p.properties : {}).map((k) => `properties.${k}`),
    ];
    const locked = touched.filter((k) => item.agentDraft.explicit.includes(k));
    if (locked.length) fail(409, `${item.id}: the human set ${locked.join(', ')} on purpose — leave ${locked.length > 1 ? 'them' : 'it'} as is`, { code: 'EXPLICIT', hint: `Rewrite only what isn't explicit: ${item.agentDraft.explicit.join(', ') || '(nothing is)'} stays. Re-send without those keys.` });
  }
  if ('agentDraft' in p && p.agentDraft !== null) fail(400, '"agentDraft" can only be cleared (null) — create the ticket with "agentWrite": true to start one');
  if (p.version != null && Number(p.version) !== item.version) fail(409, `Version conflict: ${item.id} is at version ${item.version}. Re-read and retry.`, { code: 'VERSION_CONFLICT', hint: 'GET the item, re-apply your change, retry with its version', item });

  const b = ctx.board;
  const changes = {};
  const set = (k, v) => {
    if (JSON.stringify(item[k]) === JSON.stringify(v)) return;
    changes[k] = { from: trimChange(item[k]), to: trimChange(v) };
    item[k] = v;
  };
  if ('title' in p) { if (!String(p.title || '').trim()) fail(400, '"title" cannot be empty'); set('title', str(p.title, 200).trim()); }
  if ('description' in p) set('description', str(p.description, 100_000));
  if ('type' in p) set('type', oneOf(p.type, TYPES));
  if ('priority' in p) set('priority', oneOf(p.priority, PRIORITIES));
  if ('parent' in p) set('parent', p.parent ? str(p.parent, 60).trim() : null);
  if ('blockedBy' in p) set('blockedBy', arr(p.blockedBy).map((x) => String(x).toUpperCase()).filter((x) => x !== item.id && (b.items[x] || ctx.archive.items[x])));
  if ('needsHuman' in p) {
    const prev = item.needsHuman;
    const next = parseNeedsHuman(p.needsHuman, actor);
    const before = item.questions.length;
    if (next) openQuestion(ctx, item, next, actor, events);
    else {
      // The same rule as DELETE …/attention (INT-90, INT-120): an agent only closes what it may withdraw,
      // and what it closes counts as withdrawn, so a review it cleared can't be carried through a gate.
      syncNeeds(item);
      for (const q of item.questions) mayWithdraw(ctx, actor, q.raisedBy, `${q.kind === 'review' ? 'The review' : 'Question'} ${q.id} on ${item.id}`);
      closeQuestions(ctx, item, actor, events, { extra: actor.kind === 'user' ? {} : { withdrawn: true } });
    }
    if (item.questions.length !== before) changes.needsHuman = { from: prev?.reason ?? null, to: item.needsHuman?.reason ?? null };
  }
  if ('properties' in p) {
    if (p.properties !== null && !isObj(p.properties)) fail(400, '"properties" must be an object');
    const next = p.replaceProperties === true ? {} : { ...item.properties };
    for (const [k, v] of Object.entries(p.properties || {})) { if (v === null) delete next[k]; else next[k] = v; }
    for (const k of new Set([...Object.keys(item.properties), ...Object.keys(next)])) {
      if (JSON.stringify(item.properties[k]) !== JSON.stringify(next[k])) changes[`properties.${k}`] = { from: item.properties[k] ?? null, to: next[k] ?? null };
    }
    item.properties = next;
  }
  if ('fields' in p) applyFields(ctx, item, p.fields, actor, changes);
  if ('assignee' in p) {
    const prev = item.assignee || null;
    const next = p.assignee ? str(p.assignee, 64).trim() : null;
    if (prev !== next) {
      set('assignee', next);
      // In a sleeping column an assignment is a note of who will take it, not a call to start.
      events.push(itemEvent(ctx, 'item.assigned', item, actor, { assignee: next, from: prev, mentions: asleep(ctx, item) ? [] : [next, prev].filter(Boolean) }));
    }
  }
  if ('cover' in p) {
    const v = p.cover ?? 'none';
    if (v !== 'auto' && v !== 'none' && !item.attachments.some((a) => a.id === v && /^image\//.test(a.mime || ''))) {
      fail(400, '"cover" must be "auto", "none", or the id of an image attachment on this item');
    }
    set('cover', v);
  }
  if (item.agentDraft) {
    // a human edit while the agent is writing makes those values explicit too
    if (actor.kind === 'user') item.agentDraft.explicit = [...new Set([...item.agentDraft.explicit, ...Object.keys(changes).filter((k) => k !== 'needsHuman')])];
    if ('agentDraft' in p) { changes.agentDraft = { from: 'drafting', to: null }; delete item.agentDraft; }
  }
  const moveEvents = [];
  const moving = p.columnId != null || p.column != null || p.position != null || p.beforeId || p.afterId;
  const moved = moving && moveInto(ctx, item, p.columnId ?? p.column, positionOf(p), actor, moveEvents);
  if (!Object.keys(changes).length && !moved) return false;
  item.version++;
  item.updatedAt = now();
  if (Object.keys(changes).length) events.unshift(itemEvent(ctx, 'item.updated', item, actor, { changes }));
  events.push(...moveEvents);
  return true;
}

function updateItem(ctx, id, p, actor) {
  return tx(ctx, (events) => { const item = getItem(ctx, id); applyPatch(ctx, item, p, actor, events); return item; });
}

// A body that is only a file path (C:/x/c.md, /tmp/c.md, ./c.md, @c.md): someone meant the file's text. The board
// never reads files named in a comment, so the path is what got saved; say so in the reply (not stored).
const PATH_ONLY = /^@?(?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/]|~[\\/])[^\s"'<>|*?]*\.[A-Za-z0-9]{1,8}$/;
function pathOnlyWarning(text) {
  const t = String(text || '').trim();
  if (!PATH_ONLY.test(t)) return null;
  return `The whole text you sent is a file path (${t.slice(0, 120)}). The board does not read files named in a comment, so the path itself was saved. To send the file's text, post again with body=@${t.replace(/^@/, '')} through the CLI (intellagent api … body=@path), or attach the file with "attachments".`;
}

function addComment(ctx, id, d, actor) {
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    const atts = arr(d.attachments).map((a) => saveAttachment(ctx, item, a, actor));
    if (!String(d.body || '').trim() && !atts.length) fail(400, '"body" or "attachments" is required');
    // intent "explain": a reply-only question — the agent answers on the card and changes nothing else.
    // Without an @mention it goes to whoever worked the ticket last.
    const intent = d.intent === 'explain' ? 'explain' : null;
    const c = { id: rid('c'), author: actor, body: str(d.body, 20_000), createdAt: now(), ...(atts.length ? { attachments: atts } : {}), ...(intent ? { intent } : {}), ...(d.replyTo ? { replyTo: str(d.replyTo, 40) } : {}) };
    item.comments.push(c);
    item.version++;
    item.updatedAt = c.createdAt;
    const mentions = intent ? explainTargets(item, c) : mentionsIn(c.body);
    events.push(itemEvent(ctx, 'comment.added', item, actor, { comment: { id: c.id, body: trimChange(c.body), attachments: atts.length, ...(intent ? { intent } : {}) }, mentions, ...(intent ? { intent } : {}) }));
    // An agent that names another agent without @ has alerted nobody: say so in the reply (not stored), so it
    // can comment again with the @mention if it meant to.
    const bare = actor.kind === 'agent' ? bareAgentNames(c.body, mentions, actor.name) : [];
    const warnings = [
      ...(bare.length ? [`You named ${bare.join(', ')} without @, so ${bare.length > 1 ? 'they were' : 'it was'} not alerted. If ${bare.length > 1 ? 'they' : 'it'} should act or read this now, comment again with ${bare.map((n) => `@${n}`).join(' ')}.`] : []),
      ...[pathOnlyWarning(c.body)].filter(Boolean),
    ];
    return warnings.length ? { ...c, warning: warnings.join(' ') } : c;
  });
}

// Standing agents named in a comment without @ (outside code and quotes), other than the author.
function bareAgentNames(text, mentions, self) {
  let names = [];
  try { names = standing?.list().agents.map((a) => a.name) || []; } catch { /* no agents */ }
  const plain = plainText(text);
  const at = new Set(mentions.map((m) => m.toLowerCase()));
  return names.filter((n) => n.toLowerCase() !== String(self).toLowerCase() && !at.has(n.toLowerCase())
    && new RegExp(`(^|[^@\\w.-])${n.replace(/[.-]/g, '\\$&')}(?![\\w-])`, 'i').test(plain));
}

function claimLease(ctx, id, d, actor) {
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    checkColumnPerm(ctx, actor, [item.columnId]);
    // Only the human may lease a ticket in someone else's name: a lease makes its holder an author of the ticket
    // (workedBy: refused as its reviewer, OWN_WORK on grants) and wakes them. An agent leases as itself.
    if (d.claimant && actor.kind !== 'user' && d.claimant !== actor.name) {
      fail(403, `${actor.name} can't take a lease in ${d.claimant}'s name`, { code: 'FORBIDDEN', hint: `Leave out "claimant" to lease it yourself; to pass a lease you hold: POST …/items/${item.id}/lease/handover { "to": "${str(d.claimant, 64)}" }` });
    }
    const claimant = str(d.claimant || actor.name, 64);
    const minutes = clamp(Number(d.minutes) || M.lease.defaultMinutes, 1, M.lease.maxMinutes);
    const cur = activeLease(item);
    if (cur && cur.claimant !== claimant && !(d.force && actor.kind === 'user')) {
      fail(409, `${item.id} is already leased by ${cur.claimant} until ${cur.expiresAt}`, { code: 'LEASED', hint: 'Pick another ticket (GET …/work)', lease: cur });
    }
    const renew = makeLease(item, claimant, minutes, d.status, cur);
    item.version++;
    if (cur && !renew) events.push(itemEvent(ctx, 'lease.revoked', item, actor, { claimant: cur.claimant, mentions: [cur.claimant] }));
    events.push(itemEvent(ctx, renew ? 'lease.renewed' : 'lease.claimed', item, actor, { claimant, expiresAt: item.lease.expiresAt, mentions: [claimant] }));
    return item;
  });
}

// Live "what I'm doing right now" line; deliberately does not bump item.version.
function setStatus(ctx, id, d, actor) {
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    const l = activeLease(item);
    if (!l) fail(409, `Claim a lease on ${item.id} before posting a status`);
    if (actor.kind === 'agent' && l.claimant !== actor.name) fail(403, `Only ${l.claimant} can set the status of ${item.id}`);
    const status = str(d.status, 140).trim();
    if (status === (l.status || '')) return item;
    if (status) { l.status = status; l.statusAt = now(); } else { delete l.status; delete l.statusAt; }
    events.push(itemEvent(ctx, 'lease.status', item, actor, { claimant: l.claimant, status: status || null }));
    return item;
  });
}

function releaseLease(ctx, id, actor) {
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    const cur = item.lease;
    if (!cur) return item;
    if (actor.kind === 'agent' && cur.claimant !== actor.name) fail(403, `Only ${cur.claimant} (or a human) can release this lease`);
    item.lease = null;
    item.version++;
    events.push(itemEvent(ctx, cur.claimant === actor.name ? 'lease.released' : 'lease.revoked', item, actor, { claimant: cur.claimant, mentions: [cur.claimant] }));
    return item;
  });
}

// Answer one question ({ questionId }) or, without one, every open question on the ticket.
function resolveAttention(ctx, id, d, actor) {
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    syncNeeds(item);
    if (!item.questions.length) return item;
    let qid = d.questionId || d.question;
    if (qid && !item.questions.some((q) => q.id === qid)) fail(404, `No open question "${qid}" on ${item.id}`, { code: 'NOT_FOUND', questions: item.questions.map((q) => q.id) });
    // Answers to a form belong to one question: the one named, or the only one open.
    let form = null;
    if (d.answers != null) {
      if (!qid && item.questions.length === 1) qid = item.questions[0].id;
      const q = item.questions.find((x) => x.id === qid);
      if (!q) fail(400, `${item.id} has ${item.questions.length} open questions: say which one the answers are for`, { code: 'BAD_REQUEST', hint: 'Send "questionId" with "answers"', questions: item.questions.map((x) => x.id) });
      if (!q.form) fail(400, `Question ${q.id} has no form to answer`, { code: 'BAD_REQUEST', hint: 'Answer it with "reply" instead' });
      form = formAnswers(q.form, d.answers);
    }
    // The human answers anything; an agent only closes what it may withdraw (else it could close another's review).
    for (const q of item.questions.filter((x) => !qid || x.id === qid)) mayWithdraw(ctx, actor, q.raisedBy, `${q.kind === 'review' ? 'the review' : 'question'} ${q.id} on ${item.id}`);
    let reply = null;
    const text = String(d.reply || '').trim() ? str(d.reply, 20_000) : '';
    if (text || form) {
      const q = qid ? item.questions.find((x) => x.id === qid) : null;
      const body = form ? [formSummary(q.form, form), text].filter(Boolean).join('\n\n') : text;
      reply = { id: rid('c'), author: actor, body, createdAt: now(), ...(q ? { answers: q.id } : {}), ...(form ? { form } : {}) };
      item.comments.push(reply);
    }
    // An agent closing a question (its own, or the coordinator tidying up) withdraws it rather than answers it.
    const withdrawn = actor.kind !== 'user' ? { withdrawn: true } : {};
    closeQuestions(ctx, item, actor, events, { pick: (q) => !qid || q.id === qid, reply: reply?.body ?? null, extra: { ...(form ? { form } : {}), ...withdrawn } });
    item.version++;
    item.updatedAt = now();
    return item;
  });
}

/* Withdrawing (INT-90): the agent that raised a question, a review request or a request takes it back once
   the ask is met or no longer relevant; the coordinator may clean up after others, and the human closes
   anything. A withdrawal moves nothing: whoever leases the ticket (or the coordinator) decides that. */
function mayWithdraw(ctx, actor, raisedBy, what) {
  if (actor.kind === 'user' || actor.name === raisedBy || isCoordinator(ctx, actor.name)) return;
  fail(403, `${what} was raised by ${raisedBy || 'someone else'}: only they, the coordinator or the human can close it`, { code: 'FORBIDDEN', hint: `Ask ${raisedBy || 'them'} on the card (@mention), or leave it for the human` });
}
const withdrawReason = (d) => str(d.reason || '', 2000).trim() || fail(400, 'Say why in "reason" (the ask was met, or is no longer relevant)', { code: 'BAD_REQUEST' });

function withdrawQuestion(ctx, id, qid, d, actor) {
  const reason = withdrawReason(d);
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    syncNeeds(item);
    const q = item.questions.find((x) => x.id === qid);
    if (!q) fail(404, `No open question "${qid}" on ${item.id}`, { code: 'NOT_FOUND', hint: 'GET the ticket: its open ones are under "questions"', questions: item.questions.map((x) => x.id) });
    const what = q.kind === 'review' ? 'review request' : 'question';
    mayWithdraw(ctx, actor, q.raisedBy, `The ${what} ${q.id} on ${item.id}`);
    const by = actor.name === q.raisedBy ? '' : ` (raised by ${q.raisedBy})`;
    item.comments.push({ id: rid('c'), author: actor, body: `↩ Withdrew the ${what}${by}: ${reason}`, createdAt: now(), withdrew: q.id });
    closeQuestions(ctx, item, actor, events, { pick: (x) => x === q, reply: reason, extra: { withdrawn: true } });
    item.version++;
    item.updatedAt = now();
    return item;
  });
}

function withdrawRequest(ctx, id, d, actor) {
  const reason = withdrawReason(d);
  return tx(ctx, (events) => {
    const req = getRequest(ctx, id);
    if (req.status !== 'open') fail(409, `Request ${req.id} is already ${req.withdrawn ? 'withdrawn' : 'done'}`, { code: 'CONFLICT', hint: 'Nothing to withdraw' });
    mayWithdraw(ctx, actor, req.by?.name, `Request ${req.id}`);
    // status stays open|done for older readers; `withdrawn` says how it ended
    req.status = 'done';
    req.withdrawn = { by: actor.name, reason, at: now() };
    req.updatedAt = now();
    // Nobody is woken: there is nothing left to do, and the request is gone from its agent's …/work.
    events.push({ board: ctx.id, type: 'request.withdrawn', actor, request: { id: req.id, body: trimChange(req.body), to: req.to, by: req.by?.name, status: req.status }, reason, recipients: [] });
    return req;
  });
}

// An agent (other than the human) mustn't carry a ticket through a gate while its last review was withdrawn
// and never decided: withdrawing would otherwise be a way around "decide it instead of moving it".
function reviewWithdrawnUndecided(item) {
  const w = (item.waits || []).filter((x) => x.kind === 'review').at(-1);
  return !!w?.withdrawn && !(item.review?.at && item.review.at >= w.resolvedAt);
}

/* reactions: emoji on a card or a comment. They never wake anyone and are allowed even while others
   hold the ticket or the board — they're acknowledgements, not work. */
const EMOJI_NAMES = {
  eyes: '👀', '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', tada: '🎉', heart: '❤️', rocket: '🚀', thinking: '🤔',
  check: '✅', white_check_mark: '✅', smile: '😄', laugh: '😄', fire: '🔥', warning: '⚠️', pray: '🙏', bulb: '💡', hourglass: '⏳', clap: '👏', ok: '👌',
};
function normEmoji(v) {
  const raw = String(v ?? '').trim();
  const e = EMOJI_NAMES[raw.toLowerCase().replace(/^:|:$/g, '')] || raw;
  if (!e || e.length > 16 || !/\p{Extended_Pictographic}/u.test(e)) fail(400, `"emoji" must be an emoji or one of: ${Object.keys(EMOJI_NAMES).join(', ')}`, { code: 'BAD_EMOJI' });
  return e;
}
// add: true adds, false removes, 'toggle' flips. Returns the target's reactions.
function react(ctx, id, d, actor, add = true) {
  return tx(ctx, (events) => {
    // d.note: a line the chip's hover shows next to the name (e.g. when a queued ⏳ will run)
    const item = getItem(ctx, id);
    const emoji = normEmoji(d.emoji);
    const comment = d.commentId ? item.comments.find((c) => c.id === d.commentId) : null;
    if (d.commentId && !comment) fail(404, `No comment "${d.commentId}" on ${item.id}`);
    const target = comment || item;
    const reactions = (target.reactions ||= {});
    const who = reactions[emoji] || [];
    const has = who.includes(actor.name);
    const on = add === 'toggle' ? !has : add;
    const key = `${emoji}|${actor.name}`;
    if (on && has && d.note && target.reactionNotes?.[key] !== String(d.note).slice(0, 200)) {
      // same reaction, new note (a queued ⏳ whose agent was paused or resumed)
      (target.reactionNotes ||= {})[key] = String(d.note).slice(0, 200);
      events.push(itemEvent(ctx, 'reaction.added', item, actor, { emoji, ...(comment ? { commentId: comment.id } : {}), note: target.reactionNotes[key] }));
      return reactions;
    }
    if (on === has) return reactions;
    reactions[emoji] = on ? [...who, actor.name] : who.filter((n) => n !== actor.name);
    if (!reactions[emoji].length) delete reactions[emoji];
    const notes = (target.reactionNotes ||= {});
    if (on && d.note) notes[key] = String(d.note).slice(0, 200); else delete notes[key];
    if (!Object.keys(notes).length) delete target.reactionNotes;
    events.push(itemEvent(ctx, on ? 'reaction.added' : 'reaction.removed', item, actor, { emoji, ...(comment ? { commentId: comment.id } : {}) }));
    return reactions;
  });
}

/* Lease requests: an agent that needs a ticket someone else holds asks for it; the holder hands the
   lease over in one step or declines with a reason. Requests are allowed even while the board is held. */
function requestLease(ctx, id, d, actor) {
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    const l = activeLease(item);
    if (!l) fail(409, `${item.id} isn't leased — just start it`, { code: 'NOT_LEASED', hint: `POST …/items/${item.id}/start` });
    if (l.claimant === actor.name) fail(409, 'You already hold it');
    item.leaseRequests = (item.leaseRequests || []).filter((x) => x.by !== actor.name);
    const req = { by: actor.name, reason: str(d.reason || '', 1000), at: now() };
    item.leaseRequests.push(req);
    events.push(itemEvent(ctx, 'lease.requested', item, actor, { claimant: l.claimant, reason: req.reason || null, mentions: [l.claimant] }));
    return { requested: item.id, holder: l.claimant };
  });
}
function handOverLease(ctx, id, d, actor) {
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    const l = activeLease(item);
    if (!l) fail(409, `${item.id} isn't leased`, { code: 'NOT_LEASED' });
    if (actor.kind === 'agent' && l.claimant !== actor.name) fail(403, `Only ${l.claimant} (or a human) can hand it over`, { code: 'FORBIDDEN' });
    const to = str(d.to || item.leaseRequests?.[0]?.by || '', 64).trim();
    if (!to) fail(400, '"to" is required (no pending request)');
    makeLease(item, to, l.minutes || M.lease.defaultMinutes, d.status || null, null);
    item.leaseRequests = (item.leaseRequests || []).filter((x) => x.by !== to);
    item.version++;
    events.push(itemEvent(ctx, 'lease.handed', item, actor, { from: l.claimant, claimant: to, note: str(d.note || '', 1000) || null, mentions: [to] }));
    return itemView(ctx, item);
  });
}
function declineLease(ctx, id, d, actor) {
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    const l = activeLease(item);
    if (actor.kind === 'agent' && l && l.claimant !== actor.name) fail(403, `Only ${l.claimant} (or a human) can decline`, { code: 'FORBIDDEN' });
    const who = str(d.to || item.leaseRequests?.[0]?.by || '', 64);
    const before = (item.leaseRequests || []).length;
    item.leaseRequests = (item.leaseRequests || []).filter((x) => x.by !== who);
    if (before === item.leaseRequests.length) fail(404, `No lease request from "${who}"`);
    events.push(itemEvent(ctx, 'lease.declined', item, actor, { requester: who, reason: str(d.reason || '', 1000) || null, mentions: [who] }));
    return { declined: who };
  });
}

// Asking never needs a lease: anyone working near a ticket may ask about it. Questions stack up;
// each gets an id and is answered on its own.
function askHuman(ctx, id, reason, actor, form = null) {
  let q;
  const item = tx(ctx, (events) => {
    const it = getItem(ctx, id);
    q = openQuestion(ctx, it, parseNeedsHuman({ reason: reason || 'Needs input', form }, actor), actor, events);
    it.version++;
    it.updatedAt = now();
    return it;
  });
  return { item, questionId: q.id };
}

/* ───── structured agent flows: pickup/working columns, transitions, start, decide, finish, work ───── */

// Where agents pick up work and where work happens. Flags win; names are the fallback.
function pickupColumns(ctx) {
  const cols = ctx.board.columns;
  const flagged = cols.filter((c) => c.flags.pickup);
  if (flagged.length) return flagged;
  const named = cols.filter((c) => /^(ready|to ?do|todo|next|up next|selected)$/i.test(c.name));
  return named.length ? named : cols.slice(0, 1);
}
function workingColumn(ctx) {
  const cols = ctx.board.columns;
  return cols.find((c) => c.flags.working) || cols.find((c) => /progress|doing|investigating|mitigating|working|active/i.test(c.name))
    || cols[cols.indexOf(pickupColumns(ctx).at(-1)) + 1] || null;
}

// Why `actor` cannot move `item` into `to` (null = allowed). Mirrors moveInto without changing anything.
function moveBlocker(ctx, item, to, actor) {
  const from = ctx.board.columns.find((c) => c.id === item.columnId);
  if (!from || from.id === to.id) return null;
  if (!from.flags.allowMoveOut) return { code: 'LOCKED_COLUMN', reason: `Items cannot leave "${from.name}"` };
  if (!to.flags.allowMoveIn) return { code: 'LOCKED_COLUMN', reason: `"${to.name}" does not accept moved items` };
  if (actor.kind !== 'user' && to.flags.humanOnlyIn) return { code: 'HUMAN_ONLY', reason: `Only a human can move items into "${to.name}"`, hint: 'Request review instead' };
  if (actor.kind !== 'user' && from.flags.humanOnlyOut) return { code: 'HUMAN_ONLY', reason: `Only a human can move items out of "${from.name}"` };
  if (to.flags.wipLimit > 0 && to.itemIds.length >= to.flags.wipLimit) return { code: 'WIP_LIMIT', reason: `"${to.name}" is at its WIP limit (${to.flags.wipLimit})` };
  const perms = actor.kind === 'agent' ? permsFor(actor.name) : null;
  if (perms?.readOnly) return { code: 'FORBIDDEN', reason: 'You are read-only on this board' };
  if (perms?.columns && !perms.columns.some((c) => [to.id, to.name.toLowerCase()].includes(String(c).toLowerCase()))) return { code: 'FORBIDDEN', reason: `You may not change items in "${to.name}"` };
  return null;
}

function transitions(ctx, item, actor) {
  const l = activeLease(item);
  const m = activeMaster(ctx);
  const locked = actor.kind === 'agent' && ((l && l.claimant !== actor.name) || (m && m.holder !== actor.name));
  return {
    id: item.id, column: ctx.board.columns.find((c) => c.id === item.columnId)?.name,
    ...(locked ? { lockedBy: l && l.claimant !== actor.name ? l.claimant : m.holder } : {}),
    moves: ctx.board.columns.filter((c) => c.id !== item.columnId).map((c) => {
      const why = locked ? { code: 'LEASED', reason: `Held by ${l && l.claimant !== actor.name ? l.claimant : m.holder}` } : moveBlocker(ctx, item, c, actor);
      return { column: c.name, id: c.id, allowed: !why, ...(why || {}) };
    }),
    review: reviewColumn(ctx)?.name || null,
  };
}

// Who last worked a ticket: the five most recent, each once.
function addWorker(item, name) {
  if (!(item.workedBy || []).includes(name)) item.workedBy = [...(item.workedBy || []), name].slice(-5);
}

function makeLease(item, claimant, minutes, status, cur) {
  const renew = !!cur && cur.claimant === claimant;
  addWorker(item, claimant);
  item.lease = {
    claimant,
    leasedAt: renew ? cur.leasedAt : now(),
    expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    minutes,
    renewals: renew ? (cur.renewals || 0) + 1 : 0,
    ...(renew && cur.status ? { status: cur.status, statusAt: cur.statusAt } : {}),
    ...(status ? { status: str(status, 140), statusAt: now() } : {}),
  };
  return renew;
}

// Start (or resume) work in one step: checks, lease, move to the working column, status, assignee.
// Either everything happens or nothing does.
function startWork(ctx, id, d, actor) {
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    guardBoard(ctx, actor);
    checkColumnPerm(ctx, actor, [item.columnId]);
    if (actor.kind === 'agent' && asleep(ctx, item)) {
      fail(409, `${item.id} is in ${findColumnById(ctx.board, item.columnId).name}, which is asleep: it starts once it is moved to ${pickupColumns(ctx)[0]?.name || 'the pickup column'}`, { code: 'SLEEPING', hint: 'Pick another ticket (GET …/work), or ask on the card' });
    }
    const cur = activeLease(item);
    if (cur && cur.claimant !== actor.name) fail(423, `${item.id} is leased by ${cur.claimant} until ${cur.expiresAt}`, { code: 'LEASED', hint: 'Pick another ticket (GET …/work)', lease: cur });
    // While a focus board is active, agents start only its tickets — unless the human asked for this one
    // directly (an @mention or a request), which the agent says with "outsideFocus": true.
    if (actor.kind === 'agent' && !inActiveFocus(ctx, item) && d.outsideFocus !== true) {
      fail(409, `${item.id} is not on the focus board "${activeFocus(ctx).name}", which the agents work on now`, { code: 'OUT_OF_FOCUS', hint: 'Start a ticket from GET …/work instead. If the human asked you for this one directly (an @mention or a request), pass "outsideFocus": true' });
    }
    const open = openBlockersOf(ctx, item);
    if (open.length && !d.force) fail(409, `${item.id} is blocked by ${open.join(', ')}`, { code: 'BLOCKED', hint: 'Work on a blocker first, or pass "force": true', blockedBy: open });
    const cols = ctx.board.columns;
    const work = workingColumn(ctx);
    const target = d.column ? findColumn(ctx.board, d.column)
      : work && cols.indexOf(work) > cols.findIndex((c) => c.id === item.columnId) ? work
        : item.review?.verdict === 'changes' && work ? work : null;
    let moved = null;
    if (target && target.id !== item.columnId) { moveInto(ctx, item, target.id, 'top', actor, events); moved = target.name; }
    const master = activeMaster(ctx);
    const holdsBoard = master && master.holder === actor.name;
    if (!holdsBoard) {
      const minutes = clamp(Number(d.minutes) || M.lease.defaultMinutes, 1, M.lease.maxMinutes);
      const renew = makeLease(item, actor.name, minutes, d.status, cur);
      events.push(itemEvent(ctx, renew ? 'lease.renewed' : 'lease.claimed', item, actor, { claimant: actor.name, expiresAt: item.lease.expiresAt, via: 'start' }));
    } else addWorker(item, actor.name);
    if (!item.assignee && actor.kind === 'agent') {
      item.assignee = actor.name;
      events.push(itemEvent(ctx, 'item.assigned', item, actor, { assignee: actor.name, from: null }));
    }
    item.version++;
    item.updatedAt = now();
    const lastWait = (item.waits || []).filter((w) => w.raisedBy === actor.name).at(-1);
    return {
      item: itemView(ctx, item), movedTo: moved, lease: item.lease, holdsBoard: !!holdsBoard,
      ...(item.review?.verdict === 'changes' ? { feedback: item.review.comment || null } : {}),
      ...(lastWait ? { lastAnswer: replyAfter(item, lastWait) } : {}),
      next: `Work, then POST /api/boards/${ctx.id}/items/${item.id}/review { "summary": "what changed and how to verify" }. Renew with POST …/lease if it takes longer than ${item.lease?.minutes || 'the lease'} minutes.`,
    };
  });
}

// The human's reply to a closed question: the first comment they wrote after it was asked.
function replyAfter(item, w) {
  const c = (w.id && item.comments.find((x) => x.answers === w.id || (w.withdrawn && x.withdrew === w.id))) || (item.comments || []).find((x) => x.author?.kind === 'user' && x.createdAt >= w.raisedAt);
  return c ? c.body : null;
}

// Human verdict on a review, in one step. approve: through the gate; changes: back to the working column.
function decideReview(ctx, id, d, actor) {
  if (actor.kind !== 'user') grantsOf(actor.name).some((g) => g.power === 'review.decide') || fail(403, 'Only the human decides reviews', { code: 'HUMAN_ONLY', hint: 'The human can delegate this with "grants": ["review.decide"] in agents.json' });
  const verdict = d.verdict === 'approve' || d.verdict === 'approved' ? 'approve' : d.verdict === 'changes' ? 'changes' : fail(400, '"verdict" must be "approve" or "changes"');
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    const grant = grantFor(ctx, actor, 'review.decide', item, 'decide reviews');
    // A delegated approval never overrules a reviewer: with any concerns open, only the human approves.
    const worried = (item.reviewers || []).filter((r) => r.verdict === 'concerns').map((r) => r.name);
    const evidence = String((item.questions || []).find((x) => x.kind === 'review')?.notes?.evidence || '').trim();
    if (grant && verdict === 'approve' && !evidence) fail(409, `${item.id}'s review has no evidence: only the human approves without it`, { code: 'NO_EVIDENCE', hint: 'Ask the author for evidence (screenshots, outputs, what to look at in the Preview) and to request review again' });
    if (grant && verdict === 'approve' && worried.length) fail(409, `${item.id} has concerns from ${worried.join(', ')}: only the human approves over a reviewer's concerns`, { code: 'CONCERNS_OPEN', hint: 'Leave it for the human, or @mention the author to address the concerns' });
    const comment = str(d.comment || '', 20_000).trim();
    if (verdict === 'changes' && !comment) fail(400, 'Say what needs to change in "comment"');
    // Where it goes: approve → through the next gate; changes → back to the working column.
    const cols = ctx.board.columns;
    const idx = cols.findIndex((c) => c.id === item.columnId);
    const target = d.column ? findColumn(ctx.board, d.column)
      : verdict === 'approve' ? (cols.slice(idx + 1).find((c) => c.flags.humanOnlyIn) || cols[idx + 1])
        : (workingColumn(ctx) && cols.indexOf(workingColumn(ctx)) < idx ? workingColumn(ctx) : cols[idx - 1]);
    recordVerdict(ctx, item, actor, events, verdict, comment, grant);
    // a delegated verdict carries its move through the gate with it
    if (target && target.id !== item.columnId) moveInto(ctx, item, target.id, 'top', actor, events, grant ? { gateBy: grant } : {});
    item.version++;
    item.updatedAt = now();
    return item;
  });
}

// One place that records a review verdict: the human's comment, the review question closed, item.review
// set, and review.approved / review.changes_requested sent to whoever asked and worked on it.
// Used by the review decision and by a human moving a reviewed ticket into an approval gate.
function recordVerdict(ctx, item, actor, events, verdict, comment = '', grant = null) {
  syncNeeds(item);
  const prev = item.questions.find((q) => q.kind === 'review') || null;
  const requestedBy = prev?.raisedBy || item.workedBy?.at(-1) || null;
  const said = comment || 'Approved ✓';
  const body = grant ? `${said}\n\n_Decided on the human's behalf (\`${grant.power}\` grant)._` : said;
  if (comment || verdict === 'approve') item.comments.push({ id: rid('c'), author: actor, body, createdAt: now() });
  closeQuestions(ctx, item, actor, events, { pick: (q) => q.kind === 'review', reply: body, extra: { verdict } });
  const delegated = grant ? { power: grant.power, onBehalfOf: 'human' } : null;
  item.review = { verdict, comment: comment || null, by: actor.name, at: now(), requestedBy, ...(delegated ? { delegated } : {}) };
  const who = [requestedBy, ...(item.workedBy || [])].filter(Boolean);
  events.push(itemEvent(ctx, verdict === 'approve' ? 'review.approved' : 'review.changes_requested', item, actor, { verdict, feedback: comment || null, mentions: who, ...(delegated ? { delegated } : {}) }));
  if (verdict === 'approve' && requestedBy && worktrees && agentBranch(requestedBy)) afterCommit(ctx, () => startLanding(ctx, item.id, requestedBy, actor));
}

// Put a ticket's commits from the agent's worktree branch on main, then say on the card what happened. Git runs
// outside any transaction and never blocks the board; the outcome is recorded in a transaction of its own.
// Routes that approve await landingOf() before they answer, so their reply still comes after the landing.
const landings = new Map(); // "<board>:<id>" → promise of the landing's result
function startLanding(ctx, id, agent, actor) {
  const key = `${ctx.id}:${id}`;
  const p = worktrees.land(agent, id)
    .catch((e) => ({ landed: [], reason: e.message, command: `intellagent merge ${id}` }))
    .then((r) => {
      try {
        tx(ctx, (events) => {
          const item = ctx.board.items[id];
          if (!item) return; // archived meanwhile: git is the record
          recordLanding(ctx, item, agent, actor, events, r);
          item.version++;
          item.updatedAt = now();
        });
      } catch (e) { console.error(`[${ctx.id}] recording the landing of ${id}: ${e.message}`); }
      return r;
    })
    .finally(() => { if (landings.get(key) === p) landings.delete(key); });
  landings.set(key, p);
  return p;
}
const landingOf = (ctx, id) => landings.get(`${ctx.id}:${String(id).toUpperCase()}`) || Promise.resolve(null);

function recordLanding(ctx, item, agent, actor, events, r) {
  // A failed landing with commits waiting goes to the agents allowed to land (work.land), not the human.
  const waiting = !r.landed.length && !!r.commits?.length;
  const lands = waiting ? landers().filter((n) => n !== actor.name) : [];
  const body = r.landed.length
    ? `⤵ Landed on ${r.branch || 'main'}: ${r.landed.map((x) => `\`${x}\``).join(', ')} from \`agent/${agent}\`${r.via === 'merge' ? ` by merge commit \`${r.merge}\` (a cherry-pick conflicted; the merge keeps the branch's own conflict resolution)` : ''}.`
    : `⚠ Not landed: ${r.reason}.${waiting ? (lands.length ? ` ${lands.map((n) => `@${n}`).join(' ')} will land it.` : ` When that's sorted${r.hint ? ` (${r.hint})` : ''}, run \`${r.command}\`.`) : ''}`;
  item.comments.push({ id: rid('c'), author: SYSTEM, body, createdAt: now() });
  item.landing = r.landed.length ? { state: 'landed', commits: r.landed, from: agent, at: now() }
    : waiting ? { state: 'failed', reason: r.reason, from: agent, at: now() } : { state: 'nothing', reason: r.reason, at: now() };
  events.push(itemEvent(ctx, r.landed.length ? 'item.landed' : 'item.land_failed', item, actor, { agent, landed: r.landed, ...(r.via ? { via: r.via } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(r.code ? { code: r.code } : {}), mentions: [agent, ...lands] }));
  return r;
}

// A landing someone finished by hand (a cherry-pick with a resolved conflict has other ids) still reads
// "failed" and keeps producing land actions. Mark it landed, by hand, with the commits found on main.
function markLandedByHand(ctx, id, shas, actor) {
  return tx(ctx, (events) => {
    const item = ctx.board.items[id];
    if (!item || item.landing?.state === 'landed') return null;
    item.landing = { state: 'landed', commits: shas, from: item.landing?.from || null, by: 'hand', at: now() };
    item.comments.push({ id: rid('c'), author: SYSTEM, body: `⤵ Landed by hand on main: ${shas.map((x) => `\`${x}\``).join(', ')}.`, createdAt: now() });
    item.version++;
    item.updatedAt = now();
    events.push(itemEvent(ctx, 'item.landed', item, actor, { agent: item.landing.from, landed: shas, via: 'hand' }));
    return item.landing;
  });
}
// Every sweep: an approved ticket whose landing failed, but whose id main mentions after the approval, was landed by hand.
async function reconcileLandings() {
  if (!worktrees) return;
  for (const ctx of boards.values()) {
    for (const item of Object.values(ctx.board.items)) {
      if (item.landing?.state !== 'failed' || item.review?.verdict !== 'approve') continue;
      try {
        const shas = await worktrees.mentionedOnMain(item.id, item.review.at);
        if (shas.length) markLandedByHand(ctx, item.id, shas, SYSTEM);
      } catch (e) { console.warn(`landing check for ${item.id}: ${e.message}`); }
    }
  }
}

// End of a session: release every lease (and the board hold) you have, optionally posting the digest.
function finishSession(ctx, d, actor) {
  return tx(ctx, (events) => {
    const released = [];
    for (const item of Object.values(ctx.board.items)) {
      const l = activeLease(item);
      if (!l || l.claimant !== actor.name) continue;
      item.lease = null;
      item.version++;
      released.push(item.id);
      events.push(itemEvent(ctx, 'lease.released', item, actor, { claimant: actor.name, reason: 'session finished' }));
    }
    const m = activeMaster(ctx);
    const board = !!m && m.holder === actor.name;
    if (board) { ctx.board.master = null; events.push({ board: ctx.id, type: 'master.released', actor, holder: actor.name }); }
    let digest = null;
    if (String(d.summary || '').trim()) {
      digest = { id: rid('d'), date: new Date().toLocaleDateString('en-CA'), ts: now(), author: actor, summary: str(d.summary, 20_000), items: arr(d.items).map((x) => String(x).toUpperCase()).slice(0, 50) };
      ctx.board.digest.push(digest);
      if (ctx.board.digest.length > 500) ctx.board.digest.splice(0, ctx.board.digest.length - 500);
      events.push({ board: ctx.id, type: 'digest.added', actor, entry: { id: digest.id, summary: trimChange(digest.summary) } });
    }
    return { released, releasedBoard: board, digest: digest ? digest.id : null };
  });
}

/* requests: free-form asks from the human to an agent ("let's create some tickets for X"), not tied
   to a ticket. They go to a chosen agent, else the board's coordinator, else the project's default agent. */
// Files sent with a request or a reply (pasted screenshots…): stored like ticket attachments. Events carry
// each file's local path too, so a woken agent can open it with its file tools.
function requestFiles(ctx, req, list, actor) {
  if (list == null) return [];
  if (!Array.isArray(list)) fail(400, '"attachments" must be an array');
  if (list.length > 10) fail(400, 'At most 10 attachments per message');
  return list.map((a) => saveAttachment(ctx, req, a, actor));
}
const filesForEvent = (ctx, atts) => (atts || []).map((a) => ({
  name: a.name, mime: a.mime, url: a.url,
  ...(a.kind === 'file' ? { path: path.join(ctx.attachDir, decodeURIComponent(a.url.split('/').pop())) } : {}),
}));

function requestTarget(ctx, to) {
  return (to && str(to, 64).trim()) || ctx.board.coordinator || M.defaultAgent || null;
}
// The conversation so far between the human and this agent (earlier requests and their replies), oldest
// first, so a follow-up question reaches the agent with its context. Bounded: the last 10 messages of the
// last week, each trimmed.
function conversation(ctx, req) {
  const since = Date.now() - 7 * 86_400_000;
  const msgs = [];
  for (const q of ctx.board.requests || []) {
    if (q.id === req.id || q.to !== req.to || Date.parse(q.at) < since) continue;
    msgs.push({ from: q.by?.name || '?', at: q.at, body: q.body, request: q.id });
    for (const r of q.replies || []) msgs.push({ from: r.author?.name || '?', at: r.at, body: r.body, request: q.id });
  }
  return msgs.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-10)
    .map((m) => ({ ...m, body: m.body.length > 500 ? `${m.body.slice(0, 500)}…` : m.body }));
}

function createRequest(ctx, d, actor) {
  const body = str(d.body || '', 20_000).trim();
  if (!body && !d.attachments?.length) fail(400, '"body" is required');
  const to = requestTarget(ctx, d.to);
  if (!to) fail(400, 'No agent to send this to: pass "to", or set a coordinator (PATCH /api/boards/<board> { "coordinator": "name" }).', { code: 'NO_AGENT' });
  return tx(ctx, (events) => {
    const req = { id: rid('r'), body, to, by: actor, at: now(), status: 'open', replies: [] };
    const atts = requestFiles(ctx, req, d.attachments, actor);
    if (atts.length) req.attachments = atts;
    (ctx.board.requests ||= []).push(req);
    if (ctx.board.requests.length > 300) ctx.board.requests.splice(0, ctx.board.requests.length - 300);
    const history = conversation(ctx, req);
    events.push({ board: ctx.id, type: 'request.created', actor, request: { id: req.id, body: trimChange(body), to, ...(atts.length ? { attachments: filesForEvent(ctx, atts) } : {}), ...(history.length ? { history } : {}) }, recipients: [to].filter((n) => n !== actor.name), addressed: [to].filter((n) => n !== actor.name) });
    return req;
  });
}
function getRequest(ctx, id) {
  const req = (ctx.board.requests || []).find((x) => x.id === id);
  if (!req) fail(404, `No request "${id}"`);
  return req;
}
function replyRequest(ctx, id, d, actor) {
  return tx(ctx, (events) => {
    const req = getRequest(ctx, id);
    const body = str(d.body || '', 20_000).trim();
    const atts = requestFiles(ctx, req, d.attachments, actor);
    if (!body && !atts.length && d.done == null) fail(400, '"body" or "done" is required');
    if (body || atts.length) req.replies.push({ id: rid('c'), author: actor, body, at: now(), ...(atts.length ? { attachments: atts } : {}) });
    if (d.done === true) req.status = 'done';
    if (d.done === false) req.status = 'open';
    req.updatedAt = now();
    const to = actor.name === req.to ? [] : [req.to];
    // Both ends of a conversation are waiting on the other: the agent asked hears a follow-up ("done with the
    // lease"), and an agent that asked another (a builder asking the Guard for a lease) hears the answer.
    const asker = req.by?.kind === 'agent' && req.by.name !== actor.name ? [req.by.name] : [];
    events.push({ board: ctx.id, type: req.status === 'done' && d.done ? 'request.done' : 'request.replied', actor, request: { id: req.id, body: trimChange(req.body), to: req.to, by: req.by?.name, status: req.status }, ...(body ? { reply: trimChange(body) } : {}), ...(atts.length ? { attachments: filesForEvent(ctx, atts) } : {}), recipients: [...new Set([...to, ...asker])], ...(to.length || asker.length ? { addressed: [...new Set([...to, ...asker])] } : {}) });
    return req;
  });
}

const PRIO_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };

// "What needs me now?" — everything an (ephemeral) agent needs to decide its next step, in one call.
// What an agent with review.decide still needs before it may approve this review for the human: [] when
// nothing (it may decide), a list of what to chase otherwise, or null when the only gap is a reviewer still
// within its time (nothing to chase yet).
// Each gap is { key, text }: the key names only the kind and who (stable across sweeps, so the same gap wakes
// the agent once); the text may carry details that change, like how long a verdict has been waited for.
function delegationGaps(ctx, it, q, grants) {
  const gaps = [];
  const gap = (key, text) => gaps.push({ key, text });
  let early = false;
  if (!String(q.notes?.evidence || '').trim()) gap('evidence', `evidence from ${q.raisedBy} (the review has none: screenshots, outputs, what to look at in the Preview)`);
  const worried = (it.reviewers || []).filter((r) => r.verdict === 'concerns').map((r) => r.name);
  if (worried.length) gap(`concerns:${worried.join(',')}`, `${worried.join(', ')}'s concerns resolved (the author fixes them and asks for review again)`);
  if (!grants.some((g) => inScope(ctx, it, g.where))) {
    // Several grants can each name a reviewer (reviewers.nebula, reviewers.drax): any one of them passing is
    // enough. Only reviewers who could review this ticket count (never one of its authors).
    const authors = authorsOf(it);
    const who = [...new Set(grants.flatMap((g) => Object.keys(g.where || {}).map((k) => /^reviewers\.([\w.-]+)$/.exec(k)?.[1]).filter(Boolean)))].filter((n) => !authors.has(n));
    const rs = who.map((n) => (it.reviewers || []).find((x) => x.name.toLowerCase() === n.toLowerCase())).filter(Boolean);
    const waiting = rs.filter((r) => !r.verdict);
    const oks = rs.filter((r) => r.verdict === 'ok');
    if (grants.every((g) => !Object.keys(g.where || {}).some((k) => k.startsWith('reviewers.')))) {
      for (const g of grants.slice(0, 1)) for (const [k, want] of Object.entries(g.where || {})) if (!inScope(ctx, it, { [k]: want })) gap(`scope:${k}`, `${k} to be ${[].concat(want).join(' or ')}`);
    } else if (!who.length) gap('reviewer:none', 'a reviewer your grant trusts, but every one of them worked on this ticket');
    else if (oks.some((r) => !r.verified)) gap(`unverified:${oks.map((r) => r.name).join(',')}`, `${oks.map((r) => r.name).join(' or ')}'s ok can't stand in for the human: this board doesn't check that reviewer's token (the human turns on agent tokens)`);
    else if (oks.length) gap(`stale:${oks.map((r) => r.name).join(',')}`, `a fresh verdict from ${oks.map((r) => r.name).join(' or ')}: there are commits on the ticket since the ok`);
    else if (!rs.length) gap(`assign:${who.join(',')}`, `${who.join(' or ')} assigned as reviewer`);
    else if (waiting.some((r) => Date.now() - Date.parse(r.at || 0) < 30 * 60_000)) early = true;
    else if (waiting.length) gap(`verdict:${waiting.map((r) => r.name).join(',')}`, `${waiting.map((r) => r.name).join(' or ')}'s verdict (asked ${Math.round((Date.now() - Math.min(...waiting.map((r) => Date.parse(r.at)))) / 60_000)} min ago)`);
    else gap(`ok:${who.join(',')}`, `an ok from ${who.join(' or ')} (verdicts so far: ${rs.map((r) => `${r.name} ${r.verdict}`).join(', ')})`);
  }
  return !gaps.length && early ? null : gaps;
}

// What still reaches an agent outside the active focus board (see workFor).
const FOCUS_THROUGH = new Set(['explain', 'write', 'renew', 'continue', 'land', 'answer_lease_request']);
function workFor(ctx, name) {
  const b = ctx.board;
  const items = b.columns.flatMap((c) => c.itemIds.map((id) => b.items[id]).filter(Boolean));
  const done = doneColumnId(ctx);
  const colName = (it) => b.columns.find((c) => c.id === it.columnId)?.name;
  const brief = (it, extra = {}) => { const focus = focusNames(ctx, it.id); return { id: it.id, title: it.title, column: colName(it), priority: it.priority, type: it.type, ...(focus.length ? { focus } : {}), ...extra }; };
  const focus = activeFocus(ctx);
  const lastMine = (it) => Math.max(0, ...(it.comments || []).filter((c) => c.author?.name === name).map((c) => Date.parse(c.createdAt)),
    it.lease?.claimant === name ? Date.parse(it.lease.leasedAt) : 0);
  const master = activeMaster(ctx);
  const leases = [];
  const answered = [];
  const feedback = [];
  const waiting = [];
  const assigned = [];
  for (const it of items) {
    const l = activeLease(it);
    if (l?.claimant === name) leases.push(brief(it, { expiresAt: l.expiresAt, minutesLeft: Math.max(0, Math.round((Date.parse(l.expiresAt) - Date.now()) / 60000)), status: l.status || null }));
    const mine = (it.questions || []).filter((q) => q.raisedBy === name);
    for (const q of mine) waiting.push(brief(it, { questionId: q.id, question: q.reason, kind: q.kind, since: q.raisedAt }));
    if (mine.length) continue;
    const w = (it.waits || []).filter((x) => x.raisedBy === name && x.kind !== 'review').at(-1);
    // your own withdrawal is no answer; someone else's (the coordinator's) is, with its reason
    if (w && !(w.withdrawn && w.by === name) && Date.parse(w.resolvedAt) > lastMine(it) && it.columnId !== done) answered.push(brief(it, { questionId: w.id, question: w.reason || null, answer: replyAfter(it, w), ...(w.form ? { form: w.form } : {}), answeredBy: w.by, ...(w.withdrawn ? { withdrawn: true } : {}) }));
    const rv = it.review;
    if (rv?.verdict === 'changes' && (rv.requestedBy === name || it.workedBy?.includes(name)) && Date.parse(rv.at) > lastMine(it)) feedback.push(brief(it, { feedback: rv.comment, by: rv.by }));
    if (it.assignee === name && it.columnId !== done && !asleep(ctx, it) && !(l && l.claimant !== name) && !leases.some((x) => x.id === it.id)) assigned.push(brief(it));
  }
  const requests = (b.requests || []).filter((q) => q.status === 'open' && q.to === name).map((q) => ({ requestId: q.id, request: q.body, from: q.by?.name, at: q.at, replies: q.replies.length }));
  // "Explain" questions addressed to me that I haven't answered since they were asked.
  const explain = [];
  for (const it of items) {
    const asks = (it.comments || []).filter((c) => c.intent === 'explain');
    for (const c of asks) {
      const addressed = explainTargets(it, c).includes(name);
      const answered = (it.comments || []).some((x) => x.author?.name === name && x.createdAt > c.createdAt);
      if (addressed && !answered) explain.push(brief(it, { question: c.body, commentId: c.id }));
    }
  }
  const pick = new Set(pickupColumns(ctx).map((c) => c.id));
  const ready = items.filter((it) => pick.has(it.columnId) && inActiveFocus(ctx, it) && !activeLease(it) && !it.needsHuman && (!it.assignee || it.assignee === name) && !openBlockersOf(ctx, it).length)
    .sort((a, c) => PRIO_RANK[a.priority] - PRIO_RANK[c.priority]).slice(0, 5).map((it) => brief(it));
  const call = (id, what) => `POST /api/boards/${ctx.id}/items/${id}/${what}`;
  const next = [];
  const seen = new Set();
  // One suggestion per ticket (renewing is separate: it is just housekeeping).
  // While a focus board is active, work outside it waits: only a direct ask from the human (explain, a ticket to
  // write), the lease housekeeping on what you already hold, and landing approved work get through.
  const held = [];
  const add = (action, it, why, how) => {
    const k = action === 'renew' ? `renew:${it.id}` : it.id;
    if (seen.has(k)) return;
    if (focus && !FOCUS_THROUGH.has(action) && !focus.itemIds.includes(it.id)) { if (!held.includes(it.id)) held.push(it.id); return; }
    seen.add(k); next.push({ action, id: it.id, title: it.title, why, call: how });
  };
  for (const q of requests) next.push({ action: 'handle_request', requestId: q.requestId, why: `Request from ${q.from}: ${String(q.request).slice(0, 160)}`, call: `POST /api/boards/${ctx.id}/requests/${q.requestId}/reply { "body": "what you did", "done": true }` });
  for (const it of items) {
    const l = activeLease(it);
    if (l?.claimant !== name) continue;
    for (const q of it.leaseRequests || []) next.push({ action: 'answer_lease_request', id: it.id, title: it.title, why: `${q.by} asks for it${q.reason ? `: ${q.reason}` : ''}`, call: `POST /api/boards/${ctx.id}/items/${it.id}/lease/handover { "to": "${q.by}" } — or …/lease/decline { "to": "${q.by}", "reason": "…" }` });
  }
  for (const it of items) {
    const dr = it.agentDraft;
    if (dr?.writer !== name) continue;
    add('write', brief(it), `Write this ticket from ${dr.by}'s notes${dr.explicit.length ? ` — keep what they set: ${dr.explicit.join(', ')}` : ''}. Quote their original title/description in a comment, then clear the marker`,
      `PATCH /api/boards/${ctx.id}/items/${it.id} { "title": "…", "description": "…", …, "agentDraft": null }`);
  }
  for (const x of explain) add('explain', x, `Asked to explain (reply on the card only — change nothing): ${String(x.question).slice(0, 140)}`, `POST /api/boards/${ctx.id}/items/${x.id}/comments { "body": "…" }`);
  for (const x of leases.filter((l) => l.minutesLeft <= M.lease.warningMinutes)) add('renew', x, `Your lease ends in ${x.minutesLeft} min`, `${call(x.id, 'lease')} { "minutes": 30 }`);
  for (const x of feedback) add('address_feedback', x, `Review sent back: ${String(x.feedback || '').slice(0, 120)}`, call(x.id, 'start'));
  for (const x of answered) add('resume', x, `Your question was answered: ${String(x.answer || '').slice(0, 120)}`, call(x.id, 'start'));
  for (const x of leases) add('continue', x, x.status ? `You were: ${x.status}` : 'You hold this lease', `${call(x.id, 'review')} { "summary": "…" } when done`);
  for (const it of items.filter((x) => x.columnId !== done && (x.reviewers || []).some((r) => r.name === name && !r.verdict))) {
    add('review_ticket', brief(it), 'You are a reviewer: read its commits (listed in the review comment; git show <sha>) against your concerns, then give a verdict — ok, or concerns with what should change',
      `POST /api/boards/${ctx.id}/items/${it.id}/reviewers/${name}/verdict { "verdict": "ok" | "concerns", "comment": "…" }`);
  }
  for (const x of assigned) add('start', x, 'Assigned to you', call(x.id, 'start'));
  // A router (the coordinator) assigns Ready work; it never picks it up itself.
  const router = isCoordinator(ctx, name);
  if (!router && (!next.length || next.every((n) => n.action === 'renew'))) for (const x of ready.slice(0, 3)) add('start', x, `Ready to pick up (${x.priority})`, call(x.id, 'start'));
  // A router assigns reviewers to tickets waiting in review, when a reviewer other than the author exists.
  if (router) {
    const pool = reviewerPool();
    for (const it of items) {
      if (!(it.questions || []).some((q) => q.kind === 'review') || (it.reviewers || []).length || it.test) continue;
      const mine = authorsOf(it);
      const cand = pool.filter((a) => !mine.has(a.name));
      if (!cand.length) continue;
      add('assign_reviewer', brief(it), `In review with no reviewer — pick one whose areas or concerns fit: ${cand.map((a) => `${a.name}${a.areas?.length ? ` (owns ${a.areas.slice(0, 3).join(', ')})` : ''}`).join('; ')}. Or leave it if none fits`,
        `POST /api/boards/${ctx.id}/items/${it.id}/reviewers { "name": "…" }`);
    }
  }
  // An agent the human delegated reviews to (review.decide) hears about each ticket waiting for a decision:
  // "decide" when everything its grant needs is in, "chase" naming exactly what is missing, so it pushes the
  // others for it. What they can't provide stays with the human.
  const decideGrants = grantsOf(name).filter((g) => g.power === 'review.decide');
  if (decideGrants.length && !approvalsOff(ctx)) {
    for (const it of items) {
      const q = (it.questions || []).find((x) => x.kind === 'review');
      if (!q || it.test || ownWork(it, name)) continue;
      const gaps = delegationGaps(ctx, it, q, decideGrants);
      if (gaps === null) continue; // nothing to chase yet (a reviewer is still within its time)
      if (!gaps.length) add('decide', brief(it), 'Everything is in for you to approve it for the human: your grant covers it, the evidence is there and no reviewer has concerns. Approve with a one-line why, or leave it for the human if anything looks off',
        `POST /api/boards/${ctx.id}/items/${it.id}/review/decision { "verdict": "approve", "comment": "…" }`);
      else add('chase', brief(it), `To approve this for the human you still need: ${gaps.map((g) => g.text).join('; ')}. @mention whoever owes it and say what you need; if they can't provide it, leave the ticket for the human`,
        `POST /api/boards/${ctx.id}/items/${it.id}/comments { "body": "@… …" }`);
      // the wake tag: what kind of gap, and whose — never the wording (which carries changing minutes)
      const last = next.at(-1);
      if (last?.id === it.id && (last.action === 'decide' || last.action === 'chase')) last.tag = last.action === 'decide' ? 'decide' : gaps.map((g) => g.key).join('|');
    }
  }
  // An agent allowed to land (work.land) hears about every approved ticket whose landing failed.
  if (grantsOf(name).some((g) => g.power === 'work.land')) {
    for (const it of items) {
      if (it.landing?.state !== 'failed' || it.review?.verdict !== 'approve') continue;
      const from = it.landing.from;
      add('land', brief(it), `Approved, but landing failed: ${it.landing.reason}. In your worktree, catch up with main, cherry-pick ${from}'s commits for ${it.id} (git log main..agent/${from} --grep ${it.id}), resolve any conflicts keeping both sides' intent, run the tests, then land from your branch`,
        `POST /api/boards/${ctx.id}/items/${it.id}/land { "agent": "${name}" }`);
      const last = next.at(-1);
      if (last?.id === it.id && last.action === 'land') last.tag = it.landing.at;
    }
  }
  // A supervising agent hears about other agents' stalled tickets.
  const supervise = stalledFor(ctx, name, standing?.superviseOf?.(name) || 0).map((x) => brief(x.it, { assignee: x.who, agentStatus: x.status, idleMinutes: x.idleMin, lastActivity: new Date(x.lastMs).toISOString() }));
  for (const x of supervise) {
    const off = x.agentStatus === 'paused' || x.agentStatus === 'failed';
    add('supervise', x, off ? `Assigned to ${x.assignee}, which is ${x.agentStatus} — resume it` : `Assigned to ${x.assignee}, untouched for ${x.idleMinutes} min — nudge it`,
      off ? `POST /api/agents/${x.assignee}/resume` : `POST /api/agents/${x.assignee}/run { "note": "…" } — or comment @${x.assignee} on the card`);
  }
  // A receptionist triages open unassigned tickets: everywhere with pickup "all", in the pickup columns
  // (Ready) with pickup "ready".
  const pk = standing?.pickupOf?.(name);
  const pickCols = new Set(pickupColumns(ctx).map((c) => c.id));
  const triage = pk && (router || pk === 'all') ? untriaged(ctx).filter((it) => pk === 'all' || pickCols.has(it.columnId)).map((it) => brief(it)) : [];
  for (const x of triage) add('triage', x, `Unassigned in ${x.column}: assign it, ask on the card, or leave it`, `PATCH /api/boards/${ctx.id}/items/${x.id} { "assignee": "…" }`);
  const blockedByMaster = master && master.holder !== name;
  return {
    agent: name, board: ctx.id,
    ...(master ? { master: { holder: master.holder, you: master.holder === name, status: master.status || null } } : {}),
    ...(blockedByMaster ? { note: `${master.holder} holds the whole board — you can read, comment and ask, but not change tickets.` } : {}),
    next: blockedByMaster ? [] : next,
    ...(focus ? { focus: { id: focus.id, name: focus.name, items: [...focus.itemIds], note: `The human is focused on "${focus.name}" (${focus.itemIds.length} tickets): start and review only those. Work elsewhere waits until the focus board is retired${held.length ? ` (held back: ${held.join(', ')})` : ''}; an @mention, a request or an explain from the human still gets an answer (to start a ticket the human asked you for directly, pass "outsideFocus": true to …/start).` } } : {}),
    requests, explain, leases, feedback, answered, waitingOnHuman: waiting, assigned, ready, ...(triage.length ? { triage } : {}), ...(supervise.length ? { supervise } : {}),
  };
}

// Tickets another standing agent was given but is not working on, for a supervising agent (the receptionist).
// Stalled: the assignee is paused or failed, or nobody holds the ticket, the assignee is neither running nor
// queued and nothing has happened on it for `minutes`. Never: Done, test tickets, tickets waiting on the human.
// After two receptionist comments in a row with no answer it stops proposing the ticket (no nagging loop).
// Queued, not stalled (INT-211), unless the assignee is paused or failed: the assignee is busy (holds a lease
// anywhere, or its last run ended within `minutes`); the ticket has an open blocker; or the assignee's own last
// word on it names an open ticket that hasn't changed column since ("after INT-11"). The assignee's own
// comment otherwise counts as activity for four times as long.
function stalledFor(ctx, name, minutes) {
  if (!standing || !minutes) return [];
  const b = ctx.board;
  const done = doneColumnId(ctx);
  const out = [];
  const busy = new Map();
  const isBusy = (who, a) => {
    if (!busy.has(who)) {
      const leased = [...boards.values()].some((c) => Object.values(c.board.items).some((x) => activeLease(x)?.claimant === who));
      busy.set(who, leased || Date.now() - Date.parse(a.lastRun?.endedAt || 0) < minutes * 60_000);
    }
    return busy.get(who);
  };
  // the ticket the assignee said this one waits on: open, and still in the column it was in when they said so
  const waitsOn = (it, c) => (c.body.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) || []).some((id) => {
    const x = id !== it.id && b.items[id];
    return x && x.columnId !== done && Date.parse(x.enteredColumnAt || 0) <= Date.parse(c.createdAt);
  });
  for (const it of b.columns.filter((c) => c.id !== done).flatMap((c) => c.itemIds.map((id) => b.items[id]).filter(Boolean))) {
    const who = it.assignee;
    if (!who || who === name || asleep(ctx, it) || it.test || (it.questions || []).length || activeLease(it)) continue;
    let a;
    try { a = standing.get(who); } catch { continue; } // only standing agents can be woken
    if (standing.isRunning(who)) continue;
    const off = a.status === 'paused' || a.status === 'failed';
    if (!off && (a.queued || ['queued', 'waiting', 'throttled', 'retrying'].includes(a.status))) continue;
    const cs = it.comments || [];
    if (cs.length >= 2 && cs.slice(-2).every((c) => c.author?.name === name)) continue;
    const own = cs.findLast((c) => c.author?.name === who);
    if (!off && (isBusy(who, a) || openBlockersOf(ctx, it).length || (own && waitsOn(it, own)))) continue;
    const lastMs = Math.max(Date.parse(it.updatedAt || 0), Date.parse(it.enteredColumnAt || 0), ...cs.map((c) => Date.parse(c.createdAt)));
    const idleMin = Math.round((Date.now() - lastMs) / 60_000);
    if (!off && Date.now() - lastMs < minutes * 60_000) continue;
    if (!off && own && Date.now() - Date.parse(own.createdAt) < 4 * minutes * 60_000) continue;
    out.push({ it, who, status: a.status, idleMin, lastMs });
  }
  return out;
}

// Work already sitting on the boards for a standing agent, so an idle agent wakes without being poked.
// Each entry has a stable key: the dispatcher wakes the agent once per key, and again only after the key
// has left the list and come back (reassigned, answered anew…), so leaving something alone never loops.
// pickup: false | 'ready' (also unassigned tickets in the pickup columns) | 'all' (every open unassigned
// ticket — the receptionist's view of the board).
// Open tickets nobody owns: unassigned, not leased, not waiting on the human, not in the final column.
function untriaged(ctx) {
  const b = ctx.board;
  const done = doneColumnId(ctx);
  return b.columns.filter((c) => c.id !== done).flatMap((c) => c.itemIds.map((id) => b.items[id]).filter(Boolean))
    .filter((it) => !it.test && !it.assignee && !activeLease(it) && !(it.questions || []).length);
}

function pendingWork(name, pickup = false) {
  const out = [];
  for (const ctx of boards.values()) {
    const b = ctx.board;
    const w = workFor(ctx, name);
    const waitingOnHuman = (it) => (it.questions || []).length > 0;
    // A builder's queue (assigned, not started) is offered only while it holds no lease, and again each time it
    // finishes a ticket (its newest review request is in the key): one finished means it is free for the next.
    // A queue it looked at and left alone stays quiet until then, so it never loops.
    const busy = w.leases.length > 0;
    const freedAt = Math.max(0, ...Object.values(b.items).flatMap((it) => [
      ...(it.questions || []).filter((q) => q.kind === 'review' && q.raisedBy === name).map((q) => Date.parse(q.raisedAt) || 0),
      it.review?.requestedBy === name ? Date.parse(it.review.at) || 0 : 0,
    ]));
    for (const n of w.next) {
      if (n.action === 'renew' || n.action === 'continue' || n.action === 'triage') continue; // housekeeping, mid-run, or pickup's job
      const it = n.id && b.items[n.id];
      if (it && n.action === 'start' && (busy || it.assignee !== name || waitingOnHuman(it))) continue; // "ready" suggestions are pickup's job
      const tag = n.action === 'start' ? freedAt.toString(36)
        : n.action === 'supervise' ? w.supervise?.find((x) => x.id === n.id)?.lastActivity
        : n.action === 'resume' ? w.answered.find((x) => x.id === n.id)?.questionId
        : n.action === 'address_feedback' ? it?.review?.at
          : n.action === 'explain' ? w.explain.find((x) => x.id === n.id)?.commentId
            : n.action === 'decide' || n.action === 'chase' || n.action === 'land' ? crypto.createHash('sha1').update(String(n.tag || n.action)).digest('hex').slice(0, 10) : '';
      out.push({ key: `${ctx.id}:${n.action}:${n.requestId || n.id}${tag ? `:${tag}` : ''}`, board: ctx.id, action: n.action, id: n.id || null, requestId: n.requestId || null, title: n.title || null, why: n.why });
    }
    if (!pickup) continue;
    const router = isCoordinator(ctx, name);
    const cols = new Set((pickup === 'all' ? b.columns : pickupColumns(ctx)).map((c) => c.id));
    for (const it of untriaged(ctx)) {
      if (!cols.has(it.columnId) || !inActiveFocus(ctx, it)) continue;
      out.push({ key: `${ctx.id}:triage:${it.id}`, board: ctx.id, action: pickup === 'all' || router ? 'triage' : 'pickup', id: it.id, title: it.title,
        why: pickup === 'all' || router ? `Unassigned in ${b.columns.find((c) => c.id === it.columnId)?.name}: triage it — assign, ask, or leave it` : `Ready and unassigned (${it.priority})` });
    }
  }
  return out;
}

// Tickets a builder could start now, for the idle-board alarm: in a pickup column, not held, not blocked, not
// waiting on the human, and on the active focus board if there is one.
function waitingWork() {
  const out = [];
  for (const ctx of boards.values()) {
    const cols = new Set(pickupColumns(ctx).map((c) => c.id));
    for (const c of ctx.board.columns.filter((x) => cols.has(x.id))) {
      for (const it of c.itemIds.map((id) => ctx.board.items[id]).filter(Boolean)) {
        if (it.test || activeLease(it) || (it.questions || []).length || openBlockersOf(ctx, it).length || !inActiveFocus(ctx, it)) continue;
        out.push({ board: ctx.id, id: it.id, title: it.title, assignee: it.assignee || null });
      }
    }
  }
  return out;
}

// The brief's Project line. A sandbox's projectRoot is the checkout whose code it runs, not where its work
// happens: name the sandbox's own folder as the project and the code it runs apart.
function briefProjectLine() {
  const slash = (p) => p.replace(/\\/g, '/');
  if (M.sandbox) return `Project (the folder this board was set up in): \`${slash(path.dirname(MANIFEST_PATH))}\`  ·  a sandbox: it runs the code of \`${slash(PROJECT_ROOT)}\`, which is not the project`;
  return `Project (the code these tickets are about): \`${slash(PROJECT_ROOT)}\`${M.projectRoot ? ' — outside the board\'s folder: work there' : ''}`;
}

// One page an agent reads first: who it is, what to do next, how this board works, and the exact calls.
// via: cli (intellagent api …) | mcp (tool names) | http (raw requests).
function briefing(ctx, name, base, via = 'cli') {
  const b = ctx.board;
  const w = workFor(ctx, name);
  const P = `/api/boards/${ctx.id}`;
  const cli = (m, path, args = '') => `intellagent api ${m} ${path}${args ? ` ${args}` : ''}`;
  const call = {
    work: { cli: cli('GET', `${P}/work`), mcp: 'get_my_work', http: `GET ${P}/work` },
    create: { cli: cli('POST', `${P}/items`, `title="…" template=${b.ticketTemplates[0]?.key || 'bug'} priority=High`), mcp: 'create_item { title, template?, … }', http: `POST ${P}/items { title, template?, column?, type?, priority?, parent?, fields? }` },
    start: { cli: cli('POST', `${P}/items/<ID>/start`, 'status="what you are doing"'), mcp: 'start_work { id, status }', http: `POST ${P}/items/<ID>/start { status }` },
    status: { cli: cli('PUT', `${P}/items/<ID>/status`, 'status="running tests"'), mcp: 'set_status { id, status }', http: `PUT ${P}/items/<ID>/status { status }` },
    comment: { cli: cli('POST', `${P}/items/<ID>/comments`, 'body="…"'), mcp: 'add_comment { id, body }', http: `POST ${P}/items/<ID>/comments { body }` },
    ask: { cli: cli('POST', `${P}/items/<ID>/attention`, 'reason="your question"'), mcp: 'ask_human { id, reason, form? }', http: `POST ${P}/items/<ID>/attention { reason, form? }` },
    review: { cli: cli('POST', `${P}/items/<ID>/review`, 'changed="…" why="…" verify="…" evidence="…" risks="…"'), mcp: 'request_review { id, changed, why, verify, evidence, risks }', http: `POST ${P}/items/<ID>/review { changed, why, verify, evidence, risks }` },
    moves: { cli: cli('GET', `${P}/items/<ID>/transitions`), mcp: 'get_transitions { id }', http: `GET ${P}/items/<ID>/transitions` },
    finish: { cli: cli('POST', `${P}/finish`, 'summary="what you did today"'), mcp: 'finish_session { summary }', http: `POST ${P}/finish { summary }` },
  };
  const c = (k) => `\`${call[k][via] || call[k].cli}\``;
  const flagsOf = (col) => {
    const f = col.flags;
    const pick = pickupColumns(ctx).includes(col);
    return [
      pick ? 'pick up work here' : '', workingColumn(ctx) === col ? 'work in progress (start moves tickets here)' : '',
      reviewColumn(ctx) === col ? 'review (request review moves tickets here)' : '',
      f.sleeping ? 'asleep: tickets wait here, assigned or not, until the human (or, for tickets agents filed, the coordinator) moves them on; agents file new tickets here and cannot start them here' : '', f.allowCreate ? 'new tickets OK' : '', f.humanOnlyIn ? 'only the human moves tickets in' : '', f.humanOnlyOut ? 'only the human moves tickets out' : '',
      f.wipLimit ? `max ${f.wipLimit}` : '',
    ].filter(Boolean).join(' · ');
  };
  const rules = projectRules();
  const me = profiles[name] || {};
  const intro = me.role ? [] : [
    '## First: introduce yourself',
    'You have no role on this board yet. Before any other work, ask the human these questions (one message, all at once):',
    `1. **Name** — what should I be called? (leave blank and I'll pick a friendly one${name && !/^(claude|claude-code|mcp-agent|cli-agent|agent)$/.test(name) ? `; I'm currently "${name}"` : ''})`,
    '2. **Role** — coordinator, builder, reviewer, researcher, writer, or something else?',
    '3. **Alignment** — how should I behave? (e.g. careful and thorough, fast and pragmatic, terse, explain everything, ask before big changes)',
    '4. **Anything to avoid or focus on?**',
    `Then save the answers: MCP \`introduce_yourself { name?, role, alignment, description }\`, or \`intellagent api PATCH /api/profiles/me role="…" alignment="…" description="…"\` (pick a colour and a glyph too). A blank name: \`GET /api/names/suggest\`.`,
    '',
  ];
  const lines = [
    `# You are "${name}" on the ${b.name} board`,
    `${base}  ·  board id \`${ctx.id}\`  ·  tickets ${b.idPrefix}-1, ${b.idPrefix}-2…  ·  identify every call as "${name}"${b.coordinator === name ? '  ·  you are this board\'s coordinator: requests come to you' : ''}`,
    ...(me.role ? [`Role: **${me.role}**${me.alignment ? ` · alignment: ${me.alignment}` : ''}`] : []),
    briefProjectLine(),
    '',
    ...intro,
    '## What to do next',
    ...(w.note ? [`> ${w.note}`] : []),
    ...(w.focus ? [`> 🎯 **Focus board "${w.focus.name}" is active.** ${w.focus.note} Its tickets: ${w.focus.items.join(', ') || '(none yet)'}.`, ''] : []),
    ...(w.next.length
      ? w.next.map((n, i) => n.requestId ? `${i + 1}. **handle request ${n.requestId}** — ${n.why}` : `${i + 1}. **${n.action.replace(/_/g, ' ')} ${n.id}** "${n.title}" — ${n.why}`)
      : ['Nothing is waiting for you. Ask the human what to work on, or create tickets for work you were given.']),
    ...(w.waitingOnHuman.length ? ['', `Waiting on the human (don't redo these): ${w.waitingOnHuman.map((x) => `${x.id} "${x.question}"`).join('; ')}`] : []),
    ...(() => {
      let sp = '';
      try { sp = standing?.specialityOf(name) || ''; } catch { /* not a standing agent */ }
      return sp ? ['', sp] : [];
    })(),
    ...(() => {
      // The receptionist routes work: show it the team with role, model tier and what each does.
      const team = isCoordinator(ctx, name) && standing ? standing.list().agents.filter((a) => a.name !== name) : [];
      if (!team.length) return [];
      return ['', '## Agents you can route to (set "assignee")',
        ...team.map((a) => `- **${a.name}**${a.role ? ` · ${a.role}` : ''}${a.model ? ` · ${a.model}${a.tier ? ` (${a.tier})` : ''}` : ''}${a.enabled ? '' : ' · paused'}${a.description ? ` — ${a.description}` : ''}${a.areas?.length ? `\n  owns: ${a.areas.map((x) => `\`${x}\``).join(', ')}` : ''}${a.concerns?.length ? `\n  watches for: ${a.concerns.join('; ')}` : ''}`),
        'Route by tier when agents have models: **junior** (haiku) gets small, well-specified tickets; **mid** (sonnet) normal features and bugs; **senior** (opus) risky or cross-cutting work and anything with risk: high. Match the code first: give a ticket to the agent whose areas cover the files it touches (and whose concerns fit it); then the role (a designer gets design work); then the tier.'];
    })(),
    ...(() => {
      const g = grantsOf(name);
      if (!g.length) return [];
      const how = {
        'review.decide': `decide: ${cli('POST', `${P}/items/<ID>/review/decision`, 'verdict=approve comment="why"')} (or verdict=changes with what to change)`,
        'column.gate': 'move tickets through human-only columns with a normal move (tickets with an open review: decide the review instead)',
        'work.land': `${cli('POST', `${P}/items/<ID>/land`, 'agent=<yourself>')} — only approved work (NOT_APPROVED otherwise); resolve conflicts on your own branch first (cherry-pick the author's commits, keep both sides, run the tests), then land with agent=<yourself>; push main afterwards only if your agents.json allows it`,
        'agents.control': `${cli('POST', '/api/agents/<name>/pause')} · …/resume · …/run`,
        'agents.manage': `${cli('PATCH', '/api/agents/<name>', 'label="…" model=haiku alignment="…"')} — models: ${MANAGER_MODELS.join(', ')}; perms and permissions can only narrow; never your own record`,
      };
      return ['', '## Powers the human delegated to you',
        ...g.map((x) => `- **${x.power}** — ${POWERS[x.power]}${x.where ? ` (only where ${JSON.stringify(x.where)})` : ''}: ${how[x.power]}`),
        'Your verdicts and moves are final and recorded as made on the human\'s behalf; the human can still override them. Never use a power on your own work (a ticket you worked on or asked to have reviewed) — the board refuses it. Explain each decision in its comment.',
        ...(approvalsOff(ctx) && g.some((x) => APPROVAL_POWERS.has(x.power)) ? ['**Approvals are switched off on this board right now:** the human paused them, so review.decide and column.gate are suspended (403 APPROVALS_OFF). Leave reviews for the human until they switch approvals back on.'] : [])];
    })(),
    '',
    '## Columns (left to right)',
    ...b.columns.map((col) => `- **${col.name}** (${col.itemIds.length})${flagsOf(col) ? ` — ${flagsOf(col)}` : ''}`),
    ...(b.ticketTemplates.length ? ['', '## Ticket templates (prefer these when creating; a new board starts with some: edit them or add more with POST …/ticket-templates)', ...b.ticketTemplates.map((t) => `- \`${t.key}\` ${t.label}${t.help ? ` — ${t.help}` : ''}${t.type ? ` (${t.type}${t.priority ? `, ${t.priority}` : ''})` : ''}`)] : []),
    ...(b.schema.fields.length ? ['', '## Ticket fields (set with fields.<key>=…)', ...b.schema.fields.map((f) => `- \`${f.key}\` ${f.type}${f.options?.length ? `: ${f.options.map((o) => o.value).join(' | ')}` : ''}${f.ui === 'read' ? ' (only agents set it)' : ''}${f.help ? ` — ${f.help}` : ''}`)] : []),
    '',
    '## Board rules',
    b.directives?.trim() || '(none yet)',
    ...(rules.length ? ['', `Project conventions are in ${rules.map((x) => `\`${x.file}\``).join(', ')} — follow them; the board rules only cover how to use the board.`] : []),
    '',
    '## Alerting other agents',
    '- To get another agent to act or read something now (a handoff, a question, a review finding, "your turn"), **@mention it**: `@rocket, this one is yours`. Most agents wake only when they are addressed, so a bare name ("Rocket, take this") wakes nobody. Assigning a ticket (assignee) also wakes its new owner.',
    '- An @mention inside `code` or a `>` quote does not count, so quoting someone never wakes them. Use @ only when they need to act; to talk *about* an agent, write its name plainly.',
    '',
    '## The calls you need',
    `- Your work, any time: ${c('work')}`,
    `- Create a ticket: ${c('create')}`,
    `- Start or resume a ticket (claims it, moves it to ${workingColumn(ctx)?.name || 'the working column'}, assigns you): ${c('start')}`,
    `- Say what you're doing (shows live on the card): ${c('status')}`,
    `- Comment: ${c('comment')}   ·   Ask the human (they answer on the card): ${c('ask')}`,
    `- Finished? Request review — what changed, why (incl. alternatives you rejected), how to verify, **evidence**, risks/open questions: ${c('review')}`,
    `- **Evidence is required:** the human approves only what they can see working. Give screenshots (attach them to the ticket and name them in evidence), the command you ran and its output, test results${previewable() ? ", and what to look at in the Preview — the review card's Preview button runs your branch on a copy of the board, so commit everything the ticket needs before you ask" : ''}. A review without evidence comes back with a warning.`,
    `- React to a comment or card (never wakes anyone): \`intellagent api POST ${P}/items/<ID>/reactions emoji=+1 commentId=<id>\` — 👀 is added for you on comments you were woken for.`,
    `- Requests (free-form asks like "create tickets for X") arrive as \`handle_request\` in your work: do them, then reply — \`intellagent api POST ${P}/requests/<id>/reply body="what you did, with ticket ids" done=true\`.`,
    `- Need a ticket someone else holds? Ask: \`intellagent api POST ${P}/items/<ID>/lease/request reason="why"\` — the holder hands it over or declines. If someone asks you, answer it (it's in your work).`,
    '- Asked to *explain* (a comment marked explain, or an "explain" item in your work): answer in a comment and change nothing else — not the code, the ticket, its column or the review.',
    `- Where can this ticket go?: ${c('moves')}`,
    `- Focus boards (the human's short list for today; while one is active you work only on its tickets): \`intellagent help focus\` · \`intellagent api GET ${P}/focus\``,
    `- End of session (releases everything, posts the digest): ${c('finish')}`,
    '',
    'Errors return `{ error, code, hint }` — branch on `code` (LEASED, BOARD_HELD, BLOCKED, WIP_LIMIT, HUMAN_ONLY, VERSION_CONFLICT…) and follow `hint`.',
    `Only the human moves tickets into ${b.columns.filter((x) => x.flags.humanOnlyIn).map((x) => x.name).join(', ') || 'gated columns'}. Never edit files under .intellagent/data.`,
    `Full guide: ${base}/api/docs`,
  ];
  return lines.join('\n');
}

/* ───── metrics: flow (column entries) and waits (closed questions) over a window ───── */

const median = (xs) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const HOUR = 3600_000;

function metrics(ctx, days) {
  const b = ctx.board;
  const nowMs = Date.now();
  const from = nowMs - days * 86_400_000;
  const prevFrom = from - days * 86_400_000;
  const cols = b.columns;
  const done = doneColumnId(ctx);
  const work = workingColumn(ctx);
  const all = [...Object.values(b.items), ...Object.values(ctx.archive.items)].filter((it) => !it.test);
  const t = (x) => Date.parse(x);

  // Throughput + cycle time: tickets that reached the last column in the window.
  // Cycle time runs from first entering the working column (or creation, if it never did) to done.
  const finishedIn = (lo, hi) => all.map((it) => {
    const end = (it.flow || []).filter((f) => f.col === done && t(f.at) >= lo && t(f.at) < hi).at(-1);
    if (!end) return null;
    const start = (it.flow || []).find((f) => work && f.col === work.id) || { at: it.createdAt };
    return { it, ms: Math.max(0, t(end.at) - t(start.at)), at: t(end.at) };
  }).filter(Boolean);
  const finished = finishedIn(from, nowMs + 1);
  const before = finishedIn(prevFrom, from);
  const perDay = Array.from({ length: days }, (_, i) => finished.filter((f) => f.at >= from + i * 86_400_000 && f.at < from + (i + 1) * 86_400_000).length);

  // Time spent per column: stays that ended inside the window, plus what is sitting there now.
  const stays = Object.fromEntries(cols.map((c) => [c.id, []]));
  for (const it of all) {
    const fl = it.flow || [];
    for (let i = 0; i < fl.length - 1; i++) {
      const end = t(fl[i + 1].at);
      if (end >= from && stays[fl[i].col]) stays[fl[i].col].push(end - t(fl[i].at));
    }
  }
  const columns = cols.map((c) => {
    const real = c.itemIds.filter((id) => b.items[id] && !b.items[id].test);
    const ages = real.map((id) => nowMs - t(b.items[id].enteredColumnAt || nowMs));
    return { id: c.id, name: c.name, color: c.color, count: real.length, medianStayHours: stays[c.id].length ? median(stays[c.id]) / HOUR : null, oldestHours: ages.length ? Math.max(...ages) / HOUR : null };
  });
  const middle = columns.slice(1, -1).filter((c) => c.medianStayHours != null);
  const slowest = middle.sort((x, y) => y.medianStayHours - x.medianStayHours)[0] || null;

  // Waiting on the human: open questions now, and how fast they were answered in the window.
  const open = Object.values(b.items).filter((it) => !it.test).flatMap((it) => (it.questions || []).map((q) => ({ id: it.id, kind: q.kind, ms: nowMs - t(q.raisedAt) })));
  const answered = all.flatMap((it) => (it.waits || []).filter((w) => t(w.resolvedAt) >= from).map((w) => ({ kind: w.kind, ms: t(w.resolvedAt) - t(w.raisedAt) })));
  const byAgent = {};
  for (const f of finished) for (const n of new Set(f.it.workedBy || [])) byAgent[n] = (byAgent[n] || 0) + 1;

  return {
    days, from: new Date(from).toISOString(),
    done: finished.length, donePrev: before.length, perDay,
    cycleHours: { median: finished.length ? median(finished.map((f) => f.ms)) / HOUR : null, prev: before.length ? median(before.map((f) => f.ms)) / HOUR : null },
    waiting: { open: open.length, reviews: open.filter((q) => q.kind === 'review').length, oldestHours: open.length ? Math.max(...open.map((q) => q.ms)) / HOUR : null, oldestId: open.sort((x, y) => y.ms - x.ms)[0]?.id || null },
    answerHours: { median: answered.length ? median(answered.map((a) => a.ms)) / HOUR : null, count: answered.length },
    columns, slowest: slowest ? { name: slowest.name, medianStayHours: slowest.medianStayHours } : null,
    byAgent,
    delegated: (() => {
      const evs = recent.filter((e) => e.board === ctx.id && e.delegated && t(e.ts) >= from);
      const by = {};
      for (const e of evs) { const n = e.actor?.name || '?'; by[n] ||= { reviews: 0, moves: 0 }; by[n][e.type.startsWith('review.') ? 'reviews' : 'moves']++; }
      return { reviews: evs.filter((e) => e.type.startsWith('review.')).length, moves: evs.filter((e) => e.type === 'item.moved').length, byAgent: by };
    })(),
  };
}

function archiveItems(ctx, ids, actor, reason = null) {
  return tx(ctx, (events) => {
    const done = [];
    for (const raw of arr(ids)) {
      const id = String(raw).toUpperCase();
      const item = ctx.board.items[id];
      if (!item) { if (ctx.archive.items[id]) continue; fail(404, `Item "${id}" not found`); }
      guardWrite(ctx, item, actor);
      const col = ctx.board.columns.find((c) => c.id === item.columnId);
      if (col) col.itemIds = col.itemIds.filter((x) => x !== id);
      delete ctx.board.items[id];
      const rec = { ...item, lease: null, archivedAt: now(), archivedBy: actor, archivedFrom: item.columnId, archiveReason: reason };
      ctx.archive.items[id] = rec;
      dropFromFocus(ctx, id, true);
      events.push(itemEvent(ctx, 'item.archived', rec, actor, { reason }));
      emitUnblocked(ctx, id, actor, events);
      done.push(id);
    }
    return done;
  }, { archive: true });
}

// Test tickets are the one exception to "never deleted": anyone may remove them for good (leases still apply).
function deleteItems(ctx, ids, actor) {
  return tx(ctx, (events) => {
    const gone = [];
    for (const raw of arr(ids)) {
      const id = String(raw).toUpperCase();
      const live = ctx.board.items[id];
      const item = live || ctx.archive.items[id];
      if (!item) fail(404, `Item "${id}" not found`);
      if (!item.test) fail(403, `${id} is not a test ticket — tickets are never deleted, only archived`, { code: 'NOT_TEST', hint: `POST /api/boards/${ctx.id}/items/${id}/archive` });
      if (live) {
        guardWrite(ctx, live, actor);
        const col = ctx.board.columns.find((c) => c.id === live.columnId);
        if (col) col.itemIds = col.itemIds.filter((x) => x !== id);
        delete ctx.board.items[id];
        dropFromFocus(ctx, id, false);
      } else delete ctx.archive.items[id];
      for (const a of [...(item.attachments || []), ...(item.comments || []).flatMap((c) => c.attachments || [])]) {
        if (a.kind !== 'file') continue;
        try { fs.rmSync(path.join(ctx.attachDir, decodeURIComponent(a.url.split('/').pop())), { force: true }); } catch { /* already gone */ }
      }
      // no dangling links: other tickets stop waiting on it
      for (const other of [...Object.values(ctx.board.items), ...Object.values(ctx.archive.items)]) {
        if (!(other.blockedBy || []).includes(id)) continue;
        other.blockedBy = other.blockedBy.filter((x) => x !== id);
        other.version++;
      }
      events.push({ board: ctx.id, type: 'item.deleted', actor, itemId: id, item: { id, title: item.title }, recipients: [] });
      if (live) emitUnblocked(ctx, id, actor, events);
      gone.push(id);
    }
    return gone;
  }, { archive: true });
}

function restoreItem(ctx, id, d, actor) {
  return tx(ctx, (events) => {
    const key = String(id).toUpperCase();
    const rec = ctx.archive.items[key];
    if (!rec) fail(404, `"${key}" is not in the archive`);
    const b = ctx.board;
    const col = d.columnId || d.column ? findColumn(b, d.columnId ?? d.column) : b.columns.find((c) => c.id === rec.archivedFrom) || b.columns[0];
    if (!col) fail(400, 'Board has no columns');
    const { archivedAt, archivedBy, archivedFrom, archiveReason, ...item } = rec;
    enterColumn(item, col.id);
    item.version++;
    item.updatedAt = now();
    b.items[key] = item;
    col.itemIds.unshift(key);
    delete ctx.archive.items[key];
    events.push(itemEvent(ctx, 'item.restored', item, actor, { archivedAt }));
    return item;
  }, { archive: true });
}

/* ───── focus boards: a saved view over the board (a list of its ticket ids), never a copy ─────
   The human picks a handful of tickets to work on today. Every change on a focus board is a change to the
   real ticket, because there is only one. One board is "active" — the full board, or one focus board — and
   while a focus board is active the agents take up only its tickets: a direct ask from the human (an
   @mention, a request, an explain) still gets through, and landing approved work goes on. Retiring a focus
   board removes the view and nothing else. */
const activeFocus = (ctx) => ctx.board.focusBoards.find((f) => f.id === ctx.board.activeFocus) || null;
// Whether agents may take this ticket up of their own accord: always, unless another focus board is active.
const inActiveFocus = (ctx, it) => { const f = activeFocus(ctx); return !f || f.itemIds.includes(it.id); };
const focusNames = (ctx, id) => ctx.board.focusBoards.filter((f) => f.itemIds.includes(id)).map((f) => f.name);
function getFocus(ctx, id) {
  const f = ctx.board.focusBoards.find((x) => x.id === String(id));
  if (!f) fail(404, `Focus board "${id}" not found. Focus boards: ${ctx.board.focusBoards.map((x) => `${x.name} (${x.id})`).join(', ') || '(none)'}`);
  return f;
}
function focusView(ctx, f) {
  const { startCols, ...rest } = f;
  return { ...rest, active: ctx.board.activeFocus === f.id, count: f.itemIds.length };
}
const focusEvent = (ctx, type, f, actor, extra = {}) => ({ board: ctx.id, type, actor, focus: { id: f.id, name: f.name, count: f.itemIds.length }, recipients: [], ...extra });
// Tickets to add: live ones on this board, each once; the column it stood in is kept for the retire summary.
function addToFocus(ctx, f, ids) {
  const added = [];
  for (const raw of arr(ids)) {
    const it = getItem(ctx, raw);
    if (f.itemIds.includes(it.id)) continue;
    f.itemIds.push(it.id);
    f.startCols[it.id] = it.columnId;
    added.push(it.id);
  }
  return added;
}
// Who may change a focus board: the human; the coordinator may only add tickets to one (on the human's ask).
function guardFocus(ctx, actor, d) {
  if (actor.kind === 'user') return;
  const touchesMore = d.name !== undefined || d.remove !== undefined || d.itemIds !== undefined;
  if (!isCoordinator(ctx, actor.name) || touchesMore) humanConfig(actor, isCoordinator(ctx, actor.name) ? 'rename a focus board or take tickets out of it' : 'change focus boards');
}

function createFocus(ctx, d, actor) {
  humanConfig(actor, 'create a focus board');
  const name = str(d.name, 80).trim();
  if (!name) fail(400, '"name" is required', { code: 'BAD_REQUEST', hint: 'POST …/focus { "name": "Bonus exclusions, 16 Oct", "itemIds": ["INT-12"] }' });
  return tx(ctx, (events) => {
    const f = { id: rid('fb'), name, itemIds: [], startCols: {}, archived: [], createdAt: now(), createdBy: actor };
    addToFocus(ctx, f, d.itemIds);
    ctx.board.focusBoards.push(f);
    events.push(focusEvent(ctx, 'focus.created', f, actor, { itemIds: [...f.itemIds] }));
    if (d.activate !== false) setActiveFocus(ctx, f, actor, events);
    return f;
  });
}

function updateFocus(ctx, id, d, actor) {
  guardFocus(ctx, actor, d);
  return tx(ctx, (events) => {
    const f = getFocus(ctx, id);
    const changes = {};
    if (d.name !== undefined) {
      const name = str(d.name, 80).trim();
      if (!name) fail(400, '"name" cannot be empty');
      if (name !== f.name) { changes.name = { from: f.name, to: name }; f.name = name; }
    }
    const added = addToFocus(ctx, f, d.add);
    const removed = arr(d.remove).map((x) => String(x).toUpperCase()).filter((x) => f.itemIds.includes(x));
    f.itemIds = f.itemIds.filter((x) => !removed.includes(x));
    for (const x of removed) delete f.startCols[x];
    if (added.length || removed.length || Object.keys(changes).length) events.push(focusEvent(ctx, 'focus.updated', f, actor, { added, removed, changes }));
    return f;
  });
}

// Make a focus board the active one (or null: the full board). Work the agents hold outside it goes back to
// the pickup column with a note (assignee kept): they finish nothing outside the focus, and start nothing either.
function setActiveFocus(ctx, f, actor, events) {
  const was = activeFocus(ctx);
  if ((was?.id || null) === (f?.id || null)) return;
  ctx.board.activeFocus = f ? f.id : null;
  const parked = [];
  if (f) {
    const work = workingColumn(ctx);
    const ready = pickupColumns(ctx)[0];
    for (const item of Object.values(ctx.board.items)) {
      const l = activeLease(item);
      if (!l || !isAgentName(l.claimant) || f.itemIds.includes(item.id)) continue;
      if (work && item.columnId === work.id) {
        backToReady(ctx, item, actor, events, { agent: l.claimant, reason: 'focus', body: `🎯 ${actor.name} is focusing the agents on "${f.name}". @${l.claimant}, this ticket waits in ${ready?.name || 'the pickup column'} (still yours) until the focus board is retired.` });
      } else {
        item.lease = null;
        item.version++;
        events.push(itemEvent(ctx, 'lease.revoked', item, actor, { claimant: l.claimant, reason: 'focus', mentions: [l.claimant] }));
      }
      parked.push(item.id);
    }
  }
  let agents = [];
  try { agents = standing.list().agents.map((a) => a.name); } catch { /* no standing agents */ }
  // Every agent hears it (inbox and …/work) but none is woken just for it: their work already says what to do.
  events.push({ board: ctx.id, type: 'focus.activated', actor, focus: f ? { id: f.id, name: f.name, count: f.itemIds.length } : null, from: was ? { id: was.id, name: was.name } : null, parked, recipients: agents });
}

function activateFocus(ctx, id, actor) {
  humanConfig(actor, 'choose the active board');
  return tx(ctx, (events) => { setActiveFocus(ctx, id ? getFocus(ctx, id) : null, actor, events); return activeFocus(ctx); });
}

// Retire: the view goes, every ticket stays where it is. The summary says what moved while it was open.
function retireFocus(ctx, id, actor) {
  humanConfig(actor, 'retire a focus board');
  return tx(ctx, (events) => {
    const f = getFocus(ctx, id);
    const colName = (cid) => ctx.board.columns.find((c) => c.id === cid)?.name || cid;
    const moved = f.itemIds.map((x) => ctx.board.items[x]).filter((it) => it && f.startCols[it.id] && f.startCols[it.id] !== it.columnId)
      .map((it) => ({ id: it.id, title: it.title, from: colName(f.startCols[it.id]), to: colName(it.columnId) }));
    const wasActive = ctx.board.activeFocus === f.id;
    if (wasActive) setActiveFocus(ctx, null, actor, events);
    ctx.board.focusBoards = ctx.board.focusBoards.filter((x) => x !== f);
    const summary = { id: f.id, name: f.name, createdAt: f.createdAt, tickets: f.itemIds.length, moved, archived: f.archived, wasActive };
    events.push(focusEvent(ctx, 'focus.retired', f, actor, { summary }));
    return summary;
  });
}

// A ticket that leaves the board (archived, deleted) leaves every focus board with it.
function dropFromFocus(ctx, id, archived) {
  for (const f of ctx.board.focusBoards) {
    if (!f.itemIds.includes(id)) continue;
    f.itemIds = f.itemIds.filter((x) => x !== id);
    delete f.startCols[id];
    if (archived) f.archived.push(id);
  }
}

// id → ids of the board's tickets it blocks, in board order. Built once by callers that view many tickets, so
// they don't scan the whole board again for every one of them.
function blocksIndex(ctx) {
  const idx = new Map();
  for (const x of Object.values(ctx.board.items)) {
    for (const b of new Set(x.blockedBy || [])) (idx.get(b) || idx.set(b, []).get(b)).push(x.id);
  }
  return idx;
}

function itemView(ctx, item, archived = false, blocksOf = null) {
  const col = ctx.board.columns.find((c) => c.id === (archived ? item.archivedFrom : item.columnId));
  const blocks = blocksOf ? [...(blocksOf.get(item.id) || [])] : Object.values(ctx.board.items).filter((x) => x.blockedBy?.includes(item.id)).map((x) => x.id);
  const focus = archived ? [] : focusNames(ctx, item.id);
  return { ...item, board: ctx.id, column: col?.name ?? null, lease: activeLease(item), blocks, archived, ...(focus.length ? { focus } : {}) };
}

function boardView(ctx) {
  return {
    hash: ctx.hash, seq, serverTime: now(),
    app: { name: app.name, version: VERSION, build: BUILD },
    archivedCount: Object.keys(ctx.archive.items).length,
    board: ctx.board,
  };
}

function boardSummary(ctx) {
  const b = ctx.board;
  return {
    board: { id: b.id, name: b.name, hash: ctx.hash, idPrefix: b.idPrefix },
    hasDirectives: !!b.directives.trim(),
    projectRules: projectRules().map((r) => r.file),
    master: activeMaster(ctx),
    columns: b.columns.map((c) => ({
      id: c.id, name: c.name, flags: c.flags, count: c.itemIds.length,
      items: c.itemIds.map((id) => {
        const it = b.items[id];
        return {
          id, title: it.title, type: it.type, priority: it.priority, parent: it.parent,
          claimant: activeLease(it)?.claimant ?? null, needsHuman: it.needsHuman?.reason ?? null,
          blockedBy: it.blockedBy.length ? it.blockedBy : undefined, version: it.version,
          fields: Object.keys(it.fields || {}).length ? it.fields : undefined,
        };
      }),
    })),
  };
}

/* ───────────────────────── search ───────────────────────── */

const getPath = (obj, p) => String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function looseEq(v, x) {
  if (Array.isArray(v)) return v.some((y) => looseEq(y, x));
  if (typeof v === 'string' && typeof x === 'string') return v.toLowerCase() === x.toLowerCase();
  if (v == null || x == null) return v == x; // eslint-disable-line eqeqeq
  return v === x || String(v) === String(x);
}

function cmp(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

function testCond(v, cond) {
  if (!isObj(cond)) return looseEq(v, cond);
  return Object.entries(cond).every(([op, x]) => {
    switch (op) {
      case 'eq': return looseEq(v, x);
      case 'ne': return !looseEq(v, x);
      case 'in': return arr(x).some((y) => looseEq(v, y));
      case 'nin': return !arr(x).some((y) => looseEq(v, y));
      case 'contains': return Array.isArray(v) ? v.some((y) => looseEq(y, x)) : String(v ?? '').toLowerCase().includes(String(x).toLowerCase());
      case 'gt': return v != null && cmp(v, x) > 0;
      case 'gte': return v != null && cmp(v, x) >= 0;
      case 'lt': return v != null && cmp(v, x) < 0;
      case 'lte': return v != null && cmp(v, x) <= 0;
      case 'exists': return (v !== undefined && v !== null) === (x === true || x === 'true');
      case 'regex': try { return new RegExp(x, 'i').test(String(v ?? '')); } catch { return fail(400, `Invalid regex "${x}"`); }
      default: return fail(400, `Unknown operator "${op}". Use: eq ne in nin contains gt gte lt lte exists regex`);
    }
  });
}

const SUMMARY_FIELDS = ['board', 'id', 'title', 'type', 'priority', 'column', 'columnId', 'parent', 'claimant', 'needsHuman', 'fields', 'properties', 'updatedAt', 'version', 'archived'];

function search(d) {
  const ctxs = d.board ? [getCtx(d.board)] : [...boards.values()];
  const where = isObj(d.where) ? d.where : {};
  const terms = String(d.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const ctx of ctxs) {
    const pools = [ctx.board.columns.flatMap((c) => c.itemIds.map((id) => [ctx.board.items[id], false]))];
    if (d.includeArchived === true || d.includeArchived === 'true') pools.push(Object.values(ctx.archive.items).map((x) => [x, true]));
    const blocksOf = blocksIndex(ctx);
    for (const [item, archived] of pools.flat()) {
      const v = {
        ...itemView(ctx, item, archived, blocksOf),
        claimant: activeLease(item)?.claimant ?? null,
        authorName: item.author?.name, authorKind: item.author?.kind,
      };
      if (terms.length) {
        const hay = [v.id, v.title, v.description, v.parent, JSON.stringify(v.properties), ...v.comments.map((c) => c.body)].join(' ').toLowerCase();
        if (!terms.every((t) => hay.includes(t))) continue;
      }
      if (!Object.entries(where).every(([k, cond]) => testCond(getPath(v, k), cond))) continue;
      out.push(v);
    }
  }
  if (d.sort) {
    const dir = d.order === 'desc' ? -1 : 1;
    const key = d.sort === 'priority' ? (x) => PRIORITIES.indexOf(x.priority) : (x) => getPath(x, d.sort);
    out.sort((a, b) => dir * cmp(key(a), key(b)));
  }
  const limit = clamp(Number(d.limit) || 50, 1, 500);
  const fields = d.full === true || d.full === 'true' ? null : arr(d.fields).length ? arr(d.fields) : SUMMARY_FIELDS;
  const items = out.slice(0, limit).map((v) => (fields ? Object.fromEntries(fields.map((f) => [f, getPath(v, f)])) : v));
  return { total: out.length, count: items.length, items };
}

// GET /api/search shorthand: ?type=spike&prop.risk=high&prop.score=gte:3&claimant=exists:true
const SHORTHAND = { type: 'type', priority: 'priority', column: 'column', claimant: 'claimant', parent: 'parent', author: 'authorName', needsHuman: 'needsHuman', blockedBy: 'blockedBy' };
function searchFromQuery(q) {
  const where = q.where ? JSON.parse(q.where) : {};
  for (const [k, raw] of Object.entries(q)) {
    const field = SHORTHAND[k] || (k.startsWith('prop.') ? `properties.${k.slice(5)}` : k.startsWith('f.') ? `fields.${k.slice(2)}` : k.startsWith('w.') ? k.slice(2) : null);
    if (!field) continue;
    const m = /^(eq|ne|gt|gte|lt|lte|contains|exists|regex|in|nin):(.*)$/s.exec(raw);
    where[field] = m ? { [m[1]]: m[1] === 'in' || m[1] === 'nin' ? m[2].split('|') : m[2] } : raw;
  }
  return { ...q, where };
}

/* ───────────────────────── events ───────────────────────── */

const EVENTS_FILE = path.join(DATA, 'events.jsonl');
const RECENT_MAX = 5000;
const recent = [];
let seq = 0;

(function loadEvents() {
  if (!fs.existsSync(EVENTS_FILE)) return;
  const size = fs.statSync(EVENTS_FILE).size;
  if (size > 20 * 1024 * 1024) {
    // Keep numbering going: every agent's saved cursor refers to it.
    const fd = fs.openSync(EVENTS_FILE, 'r');
    const buf = Buffer.alloc(Math.min(size, 256 * 1024));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    for (const l of buf.toString('utf8').split('\n').reverse()) { try { seq = JSON.parse(l).seq; break; } catch { /* partial line */ } }
    fs.renameSync(EVENTS_FILE, path.join(DATA, `events-${Date.now()}.jsonl`));
    return;
  }
  const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean).slice(-RECENT_MAX);
  for (const l of lines) { try { recent.push(JSON.parse(l)); } catch { /* skip torn line */ } }
  seq = recent.length ? recent[recent.length - 1].seq : 0;
}());

function parseFilter(src = {}) {
  const list = (v) => (v == null || v === '' ? undefined : arr(v));
  const f = {
    board: src.board || undefined,
    types: list(src.types ?? src.type),
    itemId: src.itemId ? String(src.itemId).toUpperCase() : undefined,
    columnId: src.columnId || src.column || undefined,
    claimant: src.claimant || undefined,
    for: src.for || undefined,
    addressed: src.addressed || undefined,
    itemType: src.itemType || undefined,
    parent: src.parent || undefined,
    fields: list(src.fields ?? src.field),
    actorKind: src.actorKind || undefined,
    excludeActor: src.excludeActor || undefined,
    assignee: src.assignee || undefined,
    actor: src.actor || undefined,
    run: src.run || undefined,
  };
  if (f.columnId && f.board && boards.has(f.board)) {
    const r = String(f.columnId).toLowerCase();
    const col = boards.get(f.board).board.columns.find((c) => c.id === r || c.name.toLowerCase() === r);
    if (col) f.columnId = col.id;
  }
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
}

/*
 * Decide whether an event should be delivered to a subscriber.
 *
 * event  — { seq, ts, board, type, actor:{kind,name}, itemId?, columnId?, fromColumnId?,
 *            changes?: { 'priority': {from,to}, 'properties.risk': {from,to}, ... },
 *            item?: { id, title, type, priority, columnId, column, parent, claimant, needsHuman },
 *            claimant?, recipients?: string[], mentions?: string[] }
 * filter — output of parseFilter(); every key is optional:
 *            { board, types[], itemId, columnId, claimant, for, itemType, parent, fields[], actorKind, excludeActor }
 *
 * An empty filter {} must match everything (the UI's live stream relies on this).
 */
function matchesFilter(event, filter) {
  const same = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();
  const typeHit = (t) => t === '*' || t === event.type || (t.endsWith('*') && event.type.startsWith(t.slice(0, -1)));
  if (filter.board && event.board !== filter.board) return false;
  if (filter.types && !filter.types.some(typeHit)) return false;
  if (filter.itemId && event.itemId !== filter.itemId) return false;
  // destination column, by id or (case-insensitive) name
  if (filter.columnId && !same(event.columnId, filter.columnId) && !same(event.item?.column, filter.columnId)) return false;
  // lease events carry the claimant directly; item events carry the current leaseholder in the snapshot
  if (filter.claimant && !same(event.claimant, filter.claimant) && !same(event.item?.claimant, filter.claimant)) return false;
  if (filter.for && !(event.recipients || []).some((r) => same(r, filter.for))) return false;
  if (filter.addressed && !(event.addressed || []).some((r) => same(r, filter.addressed))) return false;
  if (filter.itemType && !same(event.item?.type, filter.itemType)) return false;
  if (filter.parent && !same(event.item?.parent, filter.parent)) return false;
  // "properties" matches any properties.* change; "properties.risk" matches exactly
  if (filter.fields) {
    const changed = Object.keys(event.changes || {});
    if (!filter.fields.some((f) => changed.some((c) => c === f || c.startsWith(`${f}.`)))) return false;
  }
  if (filter.assignee && !same(event.item?.assignee, filter.assignee) && !same(event.assignee, filter.assignee)) return false;
  if (filter.actor && !same(event.actor?.name, filter.actor)) return false;
  if (filter.actorKind && event.actor?.kind !== filter.actorKind) return false;
  if (filter.run && event.actor?.run !== filter.run) return false;
  if (filter.excludeActor && same(event.actor?.name, filter.excludeActor)) return false;
  return true;
}

const sseClients = new Set();
let standing = null; // standing agents (lib/agents.js), started at boot
let worktrees = null; // per-agent git worktrees (lib/worktrees.js)
// The agent's worktree branch, when it has one (standing agents that edit files).
const agentBranch = (name) => { try { return (name && standing?.get(name).worktree) || null; } catch { return null; } };
const waiters = new Set();

// sync (from tx()) goes to the board page's live stream only: never into the log or an agent's events.
function emit(ev, sync = null) {
  const e = { seq: ++seq, ts: now(), ...ev };
  if (e.board && boards.has(e.board)) e.hash = boards.get(e.board).hash;
  fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(e)}\n`);
  recent.push(e);
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
  let forUi = null;
  for (const c of sseClients) {
    if (!matchesFilter(e, c.filter)) continue;
    sseSend(c.res, c.ui && sync ? (forUi ||= withSync(e, sync)) : e);
  }
  for (const w of [...waiters]) if (matchesFilter(e, w.filter)) w.check();
  standing?.onEvent(e);
  return e;
}

function sseSend(res, e) { res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`); }
// The board page's copy of a write's first event, with the changed tickets as they are now: exactly the write's
// result, since tx() emits right after saving (null = the ticket left the board). An event replayed later has
// no sync, so the page fetches the board instead.
function withSync(e, sync) {
  if (sync.full) return { ...e, sync };
  const items = boards.get(e.board)?.board.items || {};
  return { ...e, sync: { ...sync, items: Object.fromEntries(sync.items.map((id) => [id, items[id] ?? null])) } };
}

// A cursor from before a data reset can be ahead of the log; treat it as "now" instead of waiting forever.
const clampSince = (n) => (Number.isFinite(n) && n <= seq ? n : seq);
function longPoll(res, { filter, since, timeout, limit = 100, agent, onDeliver, tail = false }) {
  since = clampSince(since);
  const collect = () => {
    const hits = recent.filter((e) => e.seq > since && matchesFilter(e, filter));
    return tail ? hits.slice(-limit) : hits.slice(0, limit);
  };
  const send = (events) => {
    const cursor = events.length ? events[events.length - 1].seq : seq;
    onDeliver?.(cursor);
    reply(res, 200, { events, cursor, truncated: recent.length > 0 && since < recent[0].seq - 1 });
  };
  const first = collect();
  if (first.length || timeout <= 0) { send(first); return HANDLED; }
  const w = { filter, agent };
  const cleanup = () => {
    clearTimeout(timer);
    waiters.delete(w);
    if (agent) presenceDelta(agent, 'waiting', -1);
  };
  w.check = () => { const evs = collect(); if (evs.length) { cleanup(); send(evs); } };
  const timer = setTimeout(() => { cleanup(); send([]); }, timeout * 1000);
  res.on('close', () => { if (waiters.has(w)) cleanup(); });
  waiters.add(w);
  if (agent) presenceDelta(agent, 'waiting', +1);
  return HANDLED;
}

function openStream(req, res, filter, agent, ui = false) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  const lastId = Number(req.headers['last-event-id']) || 0;
  if (lastId) for (const e of recent) if (e.seq > lastId && matchesFilter(e, filter)) sseSend(res, e);
  res.write(`data: ${JSON.stringify({ type: 'hello', seq, app: app.name, version: VERSION, build: BUILD })}\n\n`);
  const c = { res, filter, agent, ui };
  sseClients.add(c);
  if (agent) presenceDelta(agent, 'sse', +1);
  req.on('close', () => { sseClients.delete(c); if (agent) presenceDelta(agent, 'sse', -1); });
  return HANDLED;
}

setInterval(() => { for (const c of sseClients) c.res.write(': ping\n\n'); }, 20_000).unref();

/* ───────────────────────── subscriptions ───────────────────────── */

const SUBS_FILE = path.join(DATA, 'subscriptions.json');
const subs = readJson(SUBS_FILE, {});
const saveSubs = () => writeFileAtomic(SUBS_FILE, JSON.stringify(subs, null, 2));

/* ───────────────────────── profiles (agent/user colour, glyph, image) ───────────────────────── */

const PROFILES_FILE = path.join(DATA, 'profiles.json');
const AVATAR_DIR = path.join(DATA, 'avatars');
const profiles = readJson(PROFILES_FILE, {});
const saveProfiles = () => writeFileAtomic(PROFILES_FILE, JSON.stringify(profiles, null, 2));
const COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|hsl|oklch|oklab)a?\([\d\s.,%/+-]+\))$/i;

function updateProfile(name, d, actor) {
  if (!name || name === 'anonymous') fail(400, 'Identify yourself with X-Agent (or X-User) first');
  const prev = profiles[name] || {};
  const next = { ...prev };
  if ('color' in d) {
    if (d.color == null || d.color === '') delete next.color;
    else if (!COLOR_RE.test(String(d.color).trim())) fail(400, '"color" must be a CSS colour like #8b7bff, rgb(…), hsl(…) or oklch(…)');
    else next.color = String(d.color).trim();
  }
  if ('glyph' in d) {
    const g = [...String(d.glyph ?? '').trim()].slice(0, 2).join('');
    if (g) next.glyph = g; else delete next.glyph;
  }
  if ('label' in d) { if (d.label) next.label = str(d.label, 40); else delete next.label; }
  if ('description' in d) { if (d.description) next.description = str(d.description, 4000); else delete next.description; }
  // What the agent is for and how it should behave — set when it introduces itself.
  if ('role' in d) { if (d.role) next.role = str(d.role, 40); else delete next.role; }
  if ('alignment' in d) { if (d.alignment) next.alignment = str(d.alignment, 400); else delete next.alignment; }
  if ('image' in d || 'imageBase64' in d || 'imagePath' in d) {
    if (!d.image && !d.imageBase64 && !d.imagePath) delete next.image;
    else if (d.image && /^https?:\/\//i.test(d.image)) next.image = str(d.image, 2000);
    else {
      let buf;
      let ext = 'png';
      if (d.imageBase64) {
        const m = /^data:image\/(\w+)/.exec(d.imageBase64);
        if (m) ext = m[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
        buf = Buffer.from(String(d.imageBase64).replace(/^data:[^,]*,/, ''), 'base64');
      } else {
        const fp = readablePath(actor, d.imagePath);
        buf = fs.readFileSync(fp);
        ext = path.extname(fp).slice(1).toLowerCase() || 'png';
      }
      if (!['png', 'jpg', 'gif', 'webp', 'svg'].includes(ext)) fail(400, 'Avatar must be png, jpg, gif, webp or svg');
      if (buf.length > 2 * 1024 * 1024) fail(413, 'Avatar exceeds 2 MB');
      fs.mkdirSync(AVATAR_DIR, { recursive: true });
      const file = `${slug(name)}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(AVATAR_DIR, file), buf);
      next.image = `/avatars/${file}`;
    }
  }
  next.kind = actor.kind === 'user' ? 'user' : 'agent';
  next.updatedAt = now();
  profiles[name] = next;
  saveProfiles();
  emit({ type: 'profile.updated', actor, name, profile: next });
  return { name, ...next };
}

/* ───────────────────────── presence ───────────────────────── */

const PRESENCE_FILE = path.join(DATA, 'presence.json');
const presence = new Map(Object.entries(readJson(PRESENCE_FILE, { agents: {} }).agents || {}));
for (const p of presence.values()) { p.sse = 0; p.waiting = 0; }

const isOnline = (p) => p.sse > 0 || p.waiting > 0 || Date.now() - Date.parse(p.lastSeen || 0) < M.presenceTimeoutSeconds * 1000;
let lastOnline = null;
let presenceTimer = null;

function savePresenceSoon() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    writeFileAtomic(PRESENCE_FILE, JSON.stringify({ updatedAt: now(), agents: Object.fromEntries(presence) }, null, 2));
  }, 1500);
}

function checkPresence() {
  const online = [...presence.values()].filter(isOnline).map((p) => p.name).sort().join(',');
  if (online !== lastOnline) {
    const first = lastOnline === null;
    lastOnline = online;
    if (!first) emit({ type: 'presence.changed', actor: SYSTEM, online: online ? online.split(',') : [] });
  }
  savePresenceSoon();
}

function touch(name, action) {
  if (!name || name === 'anonymous') return;
  let p = presence.get(name);
  if (!p) { p = { name, firstSeen: now(), sse: 0, waiting: 0 }; presence.set(name, p); }
  p.lastSeen = now();
  if (action) p.lastAction = action;
  checkPresence();
}

/* Leaseless status lines: what an agent's run is doing when it holds no ticket (triage, reviewing, answering a
   request). Kept in memory only (a run's line means nothing after a restart) and only ever the caller's own.
   agent.activity has no recipients and standing agents ignore agent.* events, so a line wakes nobody;
   events are throttled to one per ACTIVITY_GAP_MS per agent, the newest line sent when the gap ends. */
const activity = new Map(); // name → { line, items, at, sentAt, timer }
const ACTIVITY_GAP_MS = 2000;
function sendActivity(name) {
  const a = activity.get(name);
  if (!a) return;
  clearTimeout(a.timer);
  a.timer = null;
  a.sentAt = Date.now();
  emit({ type: 'agent.activity', actor: { kind: 'agent', name }, agent: name, line: a.line, items: a.items, recipients: [] });
  if (!a.line) activity.delete(name);
}
function setActivity(actor, d) {
  if (actor.kind !== 'agent') fail(403, 'Status lines are for agent runs; people show what they do on the tickets themselves', { code: 'FORBIDDEN' });
  const line = str(d.status ?? d.line ?? '', 200).trim();
  const items = [...new Set([].concat(d.items || []).map((x) => String(x).trim().toUpperCase()).filter((x) => /^[\w-]{1,40}$/.test(x)))].slice(0, 10);
  const prev = activity.get(actor.name);
  if (!line && !prev) return { agent: actor.name, line: null };
  const a = prev || { sentAt: 0, timer: null };
  Object.assign(a, { line: line || null, items: line ? items : [], at: now() });
  activity.set(actor.name, a);
  const wait = a.sentAt + ACTIVITY_GAP_MS - Date.now();
  if (wait <= 0) sendActivity(actor.name);
  else if (!a.timer) { a.timer = setTimeout(() => sendActivity(actor.name), wait); a.timer.unref?.(); }
  return { agent: actor.name, line: a.line, items: a.items };
}
// The newest of an agent's own line and the lease status of a ticket it holds, since its run started.
function activityOf(name, since) {
  const own = activity.get(name);
  let best = own?.line && own.at >= since ? { line: own.line, at: own.at } : null;
  const items = own?.line && own.at >= since ? [...own.items] : [];
  for (const ctx of boards.values()) {
    for (const it of Object.values(ctx.board.items)) {
      const l = activeLease(it);
      if (l?.claimant !== name) continue;
      items.push(it.id);
      const at = l.statusAt || l.leasedAt;
      if (l.status && at >= since && (!best || at > best.at)) best = { line: l.status, at };
    }
  }
  return { line: best?.line || null, items };
}

function presenceDelta(name, key, d) {
  touch(name);
  const p = presence.get(name);
  if (p) p[key] = Math.max(0, (p[key] || 0) + d);
  checkPresence();
}

function presenceView() {
  const leases = {};
  for (const ctx of boards.values()) {
    for (const it of Object.values(ctx.board.items)) {
      const l = activeLease(it);
      if (l) (leases[l.claimant] ||= []).push({ board: ctx.id, id: it.id, title: it.title, expiresAt: l.expiresAt });
    }
  }
  const names = new Set([...presence.keys(), ...Object.keys(leases)]);
  return [...names].map((name) => {
    const p = presence.get(name) || { name, sse: 0, waiting: 0 };
    return {
      name, profile: profiles[name] || null, online: !!p.lastSeen && isOnline(p), firstSeen: p.firstSeen ?? null, lastSeen: p.lastSeen ?? null, lastAction: p.lastAction ?? null,
      connections: { stream: p.sse || 0, waiting: p.waiting || 0 },
      subscriptions: Object.values(subs).filter((s) => s.agent === name).map((s) => ({ id: s.id, label: s.label, filter: s.filter })),
      leases: leases[name] || [],
    };
  }).sort((a, b) => Number(b.online) - Number(a.online) || String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

/* ───────────────────────── sweeper: leases, auto-archive, presence ───────────────────────── */

const warned = new Set();

setInterval(() => { reconcileLandings().catch((e) => console.warn(`landing sweep: ${e.message}`)); }, Math.max(1, Number(M.staleSweepSeconds) || 300) * 1000).unref();
setInterval(() => { try { sweepStale(); } catch (e) { console.warn(`stale sweep: ${e.message}`); } }, Math.max(1, Number(M.staleSweepSeconds) || 300) * 1000).unref();
setInterval(() => {
  for (const ctx of boards.values()) {
    const ms = ctx.board.master;
    // An open-ended master lease ends when its holder has gone quiet (crashed, PC restarted) —
    // unless it is a standing agent that is just between runs.
    const idleMin = M.masterIdleMinutes ?? 120;
    const seen = ms && Date.parse(presence.get(ms.holder)?.lastSeen || ms.since || ms.claimedAt || 0);
    const idle = ms && ms.kind === 'agent' && !ms.expiresAt && idleMin && Date.now() - seen > idleMin * 60_000 && !standing?.isRunning(ms.holder);
    if ((ms?.expiresAt && Date.parse(ms.expiresAt) <= Date.now()) || idle) {
      tx(ctx, (events) => { ctx.board.master = null; events.push({ board: ctx.id, type: 'master.expired', actor: SYSTEM, holder: ms.holder, recipients: [ms.holder], ...(idle ? { reason: `idle for ${idleMin} minutes` } : {}) }); });
    }
    const expired = [];
    for (const item of Object.values(ctx.board.items)) {
      if (!item.lease) continue;
      const left = Date.parse(item.lease.expiresAt) - Date.now();
      if (left <= 0) { expired.push(item.id); continue; }
      const key = `${ctx.id}:${item.id}@${item.lease.expiresAt}`;
      if (left <= M.lease.warningMinutes * 60_000 && !warned.has(key)) {
        warned.add(key);
        const c = item.lease.claimant;
        emit(itemEvent(ctx, 'lease.warning', item, SYSTEM, { claimant: c, expiresAt: item.lease.expiresAt, minutesLeft: Math.ceil(left / 60_000), mentions: [c] }));
      }
    }
    if (expired.length) {
      tx(ctx, (events) => {
        for (const id of expired) {
          const item = ctx.board.items[id];
          if (!item?.lease) continue;
          const c = item.lease.claimant;
          item.lease = null;
          item.version++;
          events.push(itemEvent(ctx, 'lease.expired', item, SYSTEM, { claimant: c, mentions: [c] }));
        }
      });
    }
    const stale = [];
    for (const col of ctx.board.columns) {
      const days = col.flags.autoArchiveAfterDays;
      if (!days) continue;
      for (const id of col.itemIds) {
        const it = ctx.board.items[id];
        if (Date.now() - Date.parse(it.enteredColumnAt || it.updatedAt) > days * 86_400_000 && !activeLease(it)) stale.push(id);
      }
    }
    if (stale.length) archiveItems(ctx, stale, SYSTEM, 'auto-archive');
  }
  checkPresence();
}, 5000).unref();

/* ───────────────────────── schema (for agents) ───────────────────────── */

const SCHEMA = {
  board: {
    id: 'string (slug)', name: 'string', idPrefix: 'string, e.g. "INT" → items are INT-1, INT-2…', nextNumber: 'integer',
    directives: 'markdown — standing rules from the human. Read before working.',
    columns: 'Column[] (ordered)', items: 'Record<itemId, Item>', createdAt: 'ISO date', updatedAt: 'ISO date',
  },
  column: {
    id: 'string (slug)', name: 'string', color: 'css color', icon: 'string', itemIds: 'string[] — display order',
    flags: {
      allowCreate: 'boolean — new items may be created here (UI and API)',
      allowMoveIn: 'boolean — items may be moved into this column',
      allowMoveOut: 'boolean — items may leave this column',
      wipLimit: 'integer, 0 = unlimited — hard cap on items',
      releaseLeaseOnEnter: 'boolean — entering this column clears the lease',
      autoArchiveAfterDays: 'number, 0 = off',
      humanOnlyIn: 'boolean — only humans may move/create items here (approval gate)',
      humanOnlyOut: 'boolean — only humans may move items out',
      review: 'boolean — target of POST /items/:id/review (default: the column before the first human-only gate)',
      '*': 'any other key is stored verbatim (custom flags)',
    },
  },
  item: {
    id: 'string, e.g. INT-12 (read-only)', title: 'string ≤200', description: 'markdown ≤100k',
    type: TYPES, priority: `${PRIORITIES.join(' | ')} (default Medium)`, parent: 'string|null — groups related items',
    columnId: 'string', author: '{ kind: "user"|"agent"|"system", name } (read-only)',
    lease: '{ claimant, leasedAt, expiresAt, minutes, renewals, status?, statusAt? } | null — managed via /lease and /status',
    assignee: 'string|null — who should pick this up next (handoff); they receive its events',
    needsHuman: '{ id, reason, raisedBy, raisedAt, kind: question|review } | null — the oldest open question (set it to ask; null closes all: the human any, an agent only what it may withdraw, as withdrawn)',
    questions: '[{ id, reason, raisedBy, raisedAt, kind, notes?, form?, landing?, commentId? }] — every open question; notes = a review\'s changed/why/verify/evidence/risks, form = the fields to fill, landing = how many commits approval will land (reviews), commentId = the comment that carries it; the answers come back on the reply comment (answers = the question id, form = { key: value }) and in the attention.resolved event; answer one with DELETE …/attention { questionId, reply }',
    blockedBy: 'itemId[]', blocks: 'itemId[] (computed)', properties: 'object — free-form property bag (undeclared data)',
    fields: 'object — values for the board custom fields declared in GET /api/boards/:board/schema; validated by type',
    cover: '"auto" (first image) | "none" | attachment id — the image shown on the card',
    attachments: '{ id, kind: "file"|"link", name, mime, size, url, addedAt, author }[]',
    comments: '{ id, author, body (markdown), createdAt, attachments?, answers? (the question id it answers), form? ({ key: value } answers), review? (the four-part review it carries), reactions? }[]', version: 'integer — bumps on every change; send it back for safe writes',
    createdAt: 'ISO', updatedAt: 'ISO', enteredColumnAt: 'ISO', template: 'ticket template key it was created from',
    flow: '[{ col, at }] — when it entered each column', waits: '[{ raisedBy, raisedAt, resolvedAt, by }] — closed needs-you requests',
  },
  event: {
    seq: 'integer cursor', ts: 'ISO', board: 'string', hash: 'board hash after the change',
    type: ['item.created', 'item.updated', 'item.moved', 'item.reordered', 'item.archived', 'item.restored', 'comment.added',
      'item.assigned', 'item.unblocked', 'lease.claimed', 'lease.renewed', 'lease.released', 'lease.revoked', 'lease.warning', 'lease.expired', 'lease.status',
      'attention.raised', 'attention.resolved', 'review.requested', 'review.approved', 'review.changes_requested', 'reaction.added', 'reaction.removed', 'request.created', 'request.replied', 'request.done', 'lease.requested', 'lease.handed', 'lease.declined', 'digest.added', 'schema.updated', 'templates.updated', 'column.created', 'column.updated', 'column.deleted',
      'board.created', 'board.updated', 'board.external-edit', 'app.renamed', 'presence.changed', 'profile.updated',
      'master.claimed', 'master.renewed', 'master.released', 'master.revoked', 'master.expired', 'master.status',
      'agent.status', 'agent.run.started', 'agent.run.finished', 'agent.failed', 'agent.activity', 'agent.managed', 'agent.poke', 'agents.changed', 'agents.stopped', 'permissions.changed',
      'item.deleted', 'item.landed', 'item.land_failed', 'request.withdrawn', 'review.reviewed', 'review.reviewer_assigned', 'review.reviewer_removed', 'work.pending',
      'focus.created', 'focus.updated', 'focus.activated', 'focus.retired'],
    actor: '{ kind, name }', itemId: 'string?', columnId: 'string? (destination for moves)', fromColumnId: 'string?',
    changes: '{ [field | "properties.<key>"]: { from, to } }?', item: 'snapshot { id,title,type,priority,columnId,column,parent,claimant,needsHuman }?',
    recipients: 'string[] — agents/users this event concerns (leaseholder and past leaseholders, asker, agent author, assignee, commenters, master-lease holder, @mentions)',
  },
  eventFilter: {
    board: 'board id', types: 'comma list; prefix wildcard allowed e.g. "lease.*"', itemId: 'INT-12', column: 'column id or name (destination)',
    claimant: 'current leaseholder of the item', for: 'name in recipients — "my inbox"', itemType: TYPES, parent: 'parent tag',
    assignee: 'current assignee of the item',
    actor: 'name of whoever caused the event',
    fields: 'comma list of changed fields, e.g. "priority,properties.risk" ("properties" = any property)', actorKind: 'user|agent|system', excludeActor: 'name — skip your own events',
  },
  boardSchema: {
    builtins: Object.fromEntries(Object.entries(BUILTINS).map(([k, v]) => [k, `{ ui: ${UI_MODES.join('|')} (default ${v.ui}), stub: boolean, label }`])),
    fields: '{ key, label, type, options?, ui, stub, icon?, help?, required?, default?, min?, max? }[]',
    fieldTypes: FIELD_TYPES,
    uiModes: 'edit = humans can change it; read = humans see it but only the API can change it; hidden = API only',
    stubSlots: 'none | top (badge beside the id) | meta (chip in the card footer)',
  },
  searchOperators: ['eq', 'ne', 'in', 'nin', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists', 'regex'],
  searchVirtualFields: ['column', 'claimant', 'authorName', 'authorKind', 'archived', 'blocks'],
};

/* ───────────────────────── HTTP plumbing ───────────────────────── */

// Replies of GZIP_MIN characters or more go out gzipped to clients that accept it. zlib runs off the main
// thread, so a big board doesn't stall other requests, but it does make that reply slower: a 20 MB board
// shrinks to 5 MB and takes ~180 ms longer. Over a network that pays; over loopback bytes cost nothing.
// Manifest "compress": "remote" (default: not for clients on this PC) | "always" | "never".
const GZIP_MIN = 16 * 1024;
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
function wantsGzip(req) {
  const mode = M.compress || 'remote';
  if (mode === 'never' || !req || !/\bgzip\b/i.test(req.headers['accept-encoding'] || '')) return false;
  return mode === 'always' || !LOOPBACK.test(req.socket?.remoteAddress || '');
}
function reply(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  const text = isText ? body : JSON.stringify(body);
  const head = {
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Intellagent-Version': `${VERSION}+${BUILD}`,
    ...headers,
  };
  if (text.length < GZIP_MIN || !wantsGzip(res.req)) {
    res.writeHead(status, head);
    res.end(text);
    return;
  }
  zlib.gzip(text, { level: 1 }, (err, buf) => {
    if (res.headersSent || res.destroyed) return;
    if (err) { res.writeHead(status, head); res.end(text); return; }
    res.writeHead(status, { ...head, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) { reject(new HttpError(413, 'Body too large (25 MB max)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      // Bodies should be UTF-8, but Windows shells often send the legacy code page (an em dash
      // arrives as byte 0x97): decode those as Windows-1252 instead of storing replacement characters.
      const buf = Buffer.concat(chunks);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1252').decode(buf); }
      text = text.trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new HttpError(400, 'Body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

// Tokens come in headers only: a token in the URL ends up in logs and browser history.
function tokenOf(req) {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '');
  return req.headers['x-intellagent-token'] || null;
}

// The UI's EventSource can't send headers, so the signed-in UI trades its token for a stream ticket
// (POST /api/stream-ticket) and opens /api/stream?ui=1&ticket=… with it. A ticket opens one stream, once,
// within a minute; seen in a log afterwards it is worth nothing. Kept in memory: a restart just means
// the UI asks for a new one when it reconnects.
const STREAM_TICKET_MS = 60_000;
const streamTickets = new Map(); // ticket → expiresAt
function issueStreamTicket() {
  const t = Date.now();
  for (const [k, exp] of streamTickets) if (exp <= t) streamTickets.delete(k);
  if (streamTickets.size >= 1000) fail(429, 'Too many unused stream tickets', { code: 'TOO_LARGE', hint: 'Open the stream with the ticket you already have, or wait a minute' });
  const ticket = crypto.randomBytes(18).toString('base64url');
  streamTickets.set(ticket, t + STREAM_TICKET_MS);
  return { ticket, expiresInSeconds: STREAM_TICKET_MS / 1000 };
}
function useStreamTicket(ticket) {
  const exp = typeof ticket === 'string' && streamTickets.get(ticket);
  if (!exp) return false;
  streamTickets.delete(ticket);
  return exp > Date.now();
}
const tokenEq = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Agent tokens in local.json (git-ignored), read fresh; and issue one for a standing agent on a board that
// requires them, so agents the human adds keep working.
function readLocalAgentTokens() {
  try { return readLocal(LOCAL_PATH).agentTokens || {}; } catch { return {}; }
}
function issueAgentToken(name) {
  if (!M.auth.requireAgentTokens || !name || M.auth.agentTokens?.[name] || readLocalAgentTokens()[name]) return;
  // never write over a local.json that can't be read: it may hold the user token
  let local;
  try { local = readLocal(LOCAL_PATH); } catch (e) { console.error(`No token issued for ${name}: ${e.message}`); return; }
  local.agentTokens = { ...(local.agentTokens || {}), [name]: crypto.randomBytes(18).toString('base64url') };
  fs.writeFileSync(LOCAL_PATH, `${JSON.stringify(local, null, 2)}\n`);
  M.auth.agentTokens = { ...(M.auth.agentTokens || {}), [name]: local.agentTokens[name] };
}

// Optional auth from the manifest. Off by default; docs and app name stay public so agents can discover it.
function checkAuth(req, q, actor, pathname) {
  // the route index, docs and app name stay public so agents can discover the board (and ask for a token)
  if (!pathname.startsWith('/api') || pathname === '/api' || pathname === '/api/docs' || pathname === '/api/app') return;
  // the UI's live stream: a valid ticket stands in for the human's token, on this one request
  if (q.ticket !== undefined && req.method === 'GET' && pathname === '/api/stream') {
    if (useStreamTicket(q.ticket)) return;
    fail(401, 'This stream ticket is used, expired or unknown', { auth: 'user', code: 'UNAUTHORIZED', hint: 'Get a new one with POST /api/stream-ticket (it opens one stream, once, within a minute)' });
  }
  const A = M.auth;
  const tok = tokenOf(req);
  if (actor.kind === 'user') {
    if (A.userToken && !tokenEq(tok, A.userToken)) fail(401, 'This board needs the user token', { auth: 'user', code: 'UNAUTHORIZED', hint: 'Sign in with the link from intellagent open' });
    return;
  }
  const need = A.agentTokens?.[actor.name];
  const tokenHint = `Send the token the human issued with: intellagent token --agent ${actor.name} (the CLI and MCP tools send it by themselves; elsewhere set INTELLAGENT_TOKEN)`;
  if (need) { if (!tokenEq(tok, need)) fail(401, `Agent "${actor.name}" must send its token (Authorization: Bearer …)`, { auth: 'agent', code: 'UNAUTHORIZED', hint: tokenHint }); return; }
  if (A.requireAgentTokens) {
    // a token issued since the board started (intellagent token --agent) counts without a restart
    const fresh = readLocalAgentTokens()[actor.name];
    if (fresh) { A.agentTokens = { ...(A.agentTokens || {}), [actor.name]: fresh }; if (tokenEq(tok, fresh)) return; fail(401, `Agent "${actor.name}" must send its token (Authorization: Bearer …)`, { auth: 'agent', code: 'UNAUTHORIZED', hint: tokenHint }); }
    fail(401, `Agent "${actor.name}" has no token on this board`, { auth: 'agent', code: 'UNAUTHORIZED', hint: `The human issues one: intellagent token --agent ${actor.name} (the CLI and MCP tools then send it by themselves)` });
  }
  const p = permsFor(actor.name);
  if (p?.readOnly && req.method !== 'GET' && /^\/api\/boards\//.test(pathname) && !/\/(comments|attention)$/.test(pathname)) {
    fail(403, `${actor.name} is read-only (it may still comment and ask for help)`);
  }
}

function actorOf(req, q) {
  const agent = req.headers['x-agent'] || q.agent;
  // X-Intellagent-Run: which run of a (standing) agent made this call. Events carry it, so a retry can
  // see what the failed attempt already did (GET /api/events?run=<id>).
  const run = req.headers['x-intellagent-run'];
  if (agent) return { kind: 'agent', name: str(agent, 64), ...(run ? { run: str(run, 40) } : {}) };
  const user = req.headers['x-user'];
  if (user) return { kind: 'user', name: str(user, 64) };
  return { kind: 'agent', name: 'anonymous' };
}

const routes = [];
function route(method, pattern, desc, handler) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}/?$`);
  routes.push({ method, pattern, desc, re, keys, handler });
}

function serveFile(res, file, type) {
  if (!fs.existsSync(file)) fail(404, 'Not found');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
  return HANDLED;
}

/* ───────────────────────── routes ───────────────────────── */

route('GET', '/api', 'This index', () => ({
  app: appInfo(), docs: '/api/docs', schema: '/api/schema',
  endpoints: routes.filter((r) => r.desc && r.pattern.startsWith('/api')).map((r) => `${r.method.padEnd(6)} ${r.pattern} — ${r.desc}`),
}));

route('GET', '/api/docs', 'Agent guide (markdown). Start here.', ({ req, res }) => {
  const base = `http://${req.headers.host}`;
  const text = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8').replaceAll('{{BASE}}', base).replaceAll('{{APP}}', app.name);
  reply(res, 200, text, { 'Content-Type': 'text/markdown; charset=utf-8' });
  return HANDLED;
});

route('GET', '/api/schema', 'Data model, event types, filter keys, search operators', () => SCHEMA);

route('GET', '/api/app', 'App name, version, build', () => appInfo());
route('PATCH', '/api/app', 'Rename the app (white label): { name }', ({ body, actor }) => {
  if (!String(body.name || '').trim()) fail(400, '"name" is required');
  const from = app.name;
  app.name = str(body.name, 60).trim();
  saveApp();
  emit({ type: 'app.renamed', actor, from, to: app.name });
  return appInfo();
});

route('GET', '/api/boards', 'List boards', () => [...boards.values()].map((ctx) => ({
  id: ctx.id, name: ctx.board.name, idPrefix: ctx.board.idPrefix, hash: ctx.hash, updatedAt: ctx.board.updatedAt,
  columns: ctx.board.columns.length, items: Object.keys(ctx.board.items).length,
  needsHuman: Object.values(ctx.board.items).filter((i) => i.needsHuman).length,
  archived: Object.keys(ctx.archive.items).length,
})));

route('GET', '/api/templates', 'Board templates: columns, ticket fields and standing rules', () => Object.entries(TEMPLATES).map(([key, t]) => ({
  key, label: t.label, description: t.description, columns: t.columns.map((c) => ({ name: c.name, flags: c.flags || {} })),
  fields: (t.schema?.fields || []).map((f) => ({ key: f.key, type: f.type })), directives: t.directives || '',
})));
route('POST', '/api/boards', 'Create a board: { name, id?, idPrefix?, template?: (see GET /api/templates), columns?, schema?, directives? }',
  ({ body, actor }) => created(boardView(createBoard(body, actor))));

route('GET', '/api/boards/:board', 'Full board JSON + hash', ({ p }) => boardView(getCtx(p.board)));

route('PATCH', '/api/boards/:board', 'Update board: { name?, idPrefix?, directives?, coordinator? (default agent for requests) } — directives and coordinator are human only', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  tx(ctx, (events) => {
    const changes = {};
    if ('directives' in body && str(body.directives, 50_000) !== ctx.board.directives) humanConfig(actor, 'change the board rules');
    if ('coordinator' in body) {
      const v = body.coordinator ? str(body.coordinator, 64).trim() : null;
      if (v !== ctx.board.coordinator) humanConfig(actor, 'choose the coordinator');
      if (v !== ctx.board.coordinator) { changes.coordinator = { from: ctx.board.coordinator, to: v }; ctx.board.coordinator = v; }
    }
    for (const k of ['name', 'idPrefix', 'directives']) {
      if (!(k in body)) continue;
      const v = k === 'idPrefix' ? str(body[k], 8).toUpperCase() : str(body[k], k === 'directives' ? 50_000 : 80);
      if (v !== ctx.board[k]) { changes[k] = { from: trimChange(ctx.board[k]), to: trimChange(v) }; ctx.board[k] = v; }
    }
    if (Object.keys(changes).length) events.push({ board: ctx.id, type: 'board.updated', actor, changes });
  });
  return boardView(ctx);
});

route('GET', '/api/boards/:board/hash', 'Current board hash (cheap change check)', ({ p }) => {
  const ctx = getCtx(p.board);
  return { hash: ctx.hash, seq, updatedAt: ctx.board.updatedAt };
});

route('GET', '/api/boards/:board/summary', 'Compact board overview — cheapest way to orient', ({ p }) => boardSummary(getCtx(p.board)));

// The project's own convention files (e.g. CLAUDE.md) are served read-only next to the board rules,
// so rules live in one place: the repo for conventions, the board for workflow.
// Where the code is. By default the folder that holds .intellagent/ (or the manifest); "projectRoot" in the
// manifest points elsewhere, for a board kept outside the project (absolute, or relative to the manifest).
const PROJECT_ROOT = M.projectRoot
  ? path.resolve(path.dirname(MANIFEST_PATH), String(M.projectRoot))
  : path.basename(path.dirname(MANIFEST_PATH)) === '.intellagent' ? path.dirname(path.dirname(MANIFEST_PATH)) : path.dirname(MANIFEST_PATH);
if (M.projectRoot && !fs.existsSync(PROJECT_ROOT)) console.warn(`projectRoot ${PROJECT_ROOT} does not exist: agents will have no code to work on`);
function projectRules() {
  return arr(M.projectRules ?? ['CLAUDE.md']).map((f) => {
    const fp = path.resolve(PROJECT_ROOT, String(f));
    if (!fp.startsWith(PROJECT_ROOT) || !fs.existsSync(fp)) return null;
    return { file: path.relative(PROJECT_ROOT, fp).replace(/\\/g, '/'), content: str(fs.readFileSync(fp, 'utf8'), 50_000) };
  }).filter(Boolean);
}

route('GET', '/api/boards/:board/directives', 'Standing rules: board workflow rules (editable) + the project\'s own convention files (read-only)', ({ p }) => {
  const ctx = getCtx(p.board);
  return { directives: ctx.board.directives, projectRules: projectRules(), updatedAt: ctx.board.updatedAt };
});

route('GET', '/api/boards/:board/master', 'Who holds the whole board (master lease), if anyone', ({ p }) => activeMaster(getCtx(p.board)));
route('POST', '/api/boards/:board/master', 'Hold the whole board as the only agent: { minutes? (omit = until released), status? }. Fails while other agents hold ticket leases.', ({ p, body, actor }) =>
  claimMaster(getCtx(p.board), body, actor));
route('PUT', '/api/boards/:board/master/status', 'Live status while holding the board: { status }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return tx(ctx, (events) => {
    const m = activeMaster(ctx);
    if (!m) fail(409, 'Nobody holds the board');
    if (m.holder !== actor.name) fail(403, `Only ${m.holder} can set the board status`);
    const st = str(body.status, 140).trim();
    if (st) { m.status = st; m.statusAt = now(); } else { delete m.status; delete m.statusAt; }
    events.push({ board: ctx.id, type: 'master.status', actor, holder: m.holder, status: st || null });
    return m;
  });
});
route('DELETE', '/api/boards/:board/master', 'Release the board (e.g. before spawning helper agents that use ticket leases)', ({ p, actor }) => releaseMaster(getCtx(p.board), actor));
// Who approves for the human on this board, and when — and the human's switch for all of it.
function approvalsView(ctx) {
  const off = approvalsOff(ctx);
  let agents = [];
  try { agents = standing.list().agents; } catch { /* no standing agents */ }
  // Everyone grantsOf can find: standing agents and names with grants in the manifest (e.g. a session with a
  // token), so the list answers "who can approve for me" without leaving anyone out.
  const standingNames = new Set(agents.map((a) => a.name));
  const manifestOnly = Object.keys(M.permissions || {}).filter((n) => n !== '*' && !standingNames.has(n)).map((name) => ({ name, standing: false }));
  const approvers = [...agents.map((a) => ({ name: a.name, standing: true, enabled: a.enabled, status: a.status })), ...manifestOnly]
    .map((a) => ({ ...a, grants: grantsOf(a.name).filter((g) => APPROVAL_POWERS.has(g.power)) })).filter((a) => a.grants.length);
  return { on: !off, approvers };
}
route('GET', '/api/boards/:board/approvals', 'Who approves for the human on this board, and when (their review.decide / column.gate grants); on: false while the human has approvals switched off', ({ p }) => approvalsView(getCtx(p.board)));
route('PUT', '/api/boards/:board/approvals', 'Human only: switch approvals for the human on or off { on }. Off suspends every review.decide and column.gate grant on this board until switched back on', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  humanConfig(actor, 'switch approvals on or off');
  if (typeof body.on !== 'boolean') fail(400, '"on" must be true or false', { code: 'BAD_REQUEST', hint: 'PUT …/approvals { "on": true } switches approvals on; { "on": false } switches them off' });
  const on = body.on;
  tx(ctx, (events) => {
    if (approvalsOff(ctx) === !on) return; // already so (also when it comes from the manifest): nothing to say
    ctx.board.approvalsOff = !on;
    events.push({ board: ctx.id, type: 'board.updated', actor, changes: { approvals: { from: on ? 'off' : 'on', to: on ? 'on' : 'off' } } });
  });
  return approvalsView(ctx);
});
route('GET', '/api/boards/:board/focus', 'Focus boards: saved views over this board (a handful of its tickets), and which board is active — the agents work only on the active one', ({ p }) => {
  const ctx = getCtx(p.board);
  return { active: ctx.board.activeFocus, focusBoards: ctx.board.focusBoards.map((f) => focusView(ctx, f)) };
});
route('POST', '/api/boards/:board/focus', 'Human: make a focus board { name, itemIds: [], activate? (default true: the agents switch to it) }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return created(focusView(ctx, createFocus(ctx, body, actor)));
});
route('PUT', '/api/boards/:board/focus/active', 'Human: choose the board the agents work on { id } (a focus board) or { id: null } (the full board). Agent work outside a focus board goes back to the pickup column', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  if (!('id' in body)) fail(400, '"id" is required (null for the full board)', { code: 'BAD_REQUEST', hint: 'PUT …/focus/active { "id": "fb_…" } or { "id": null }' });
  activateFocus(ctx, body.id, actor);
  return { active: ctx.board.activeFocus };
});
route('GET', '/api/boards/:board/focus/:id', 'One focus board with its tickets (one-line each)', ({ p }) => {
  const ctx = getCtx(p.board);
  const f = getFocus(ctx, p.id);
  return { ...focusView(ctx, f), items: f.itemIds.map((id) => snapshot(ctx, ctx.board.items[id])) };
});
route('PATCH', '/api/boards/:board/focus/:id', 'Change a focus board { name?, add?: [ids], remove?: [ids] } — the human; the coordinator may only add', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return focusView(ctx, updateFocus(ctx, p.id, body, actor));
});
route('DELETE', '/api/boards/:board/focus/:id', 'Human: retire a focus board — the view goes, no ticket moves. Returns what moved while it was open', ({ p, actor }) => retireFocus(getCtx(p.board), p.id, actor));
route('PUT', '/api/boards/:board/directives', 'Replace standing rules: { directives } (human only)', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  tx(ctx, (events) => {
    const v = str(body.directives ?? body.markdown, 50_000);
    if (v === ctx.board.directives) return;
    humanConfig(actor, 'change the board rules');
    events.push({ board: ctx.id, type: 'board.updated', actor, changes: { directives: { from: trimChange(ctx.board.directives), to: trimChange(v) } } });
    ctx.board.directives = v;
  });
  return { directives: ctx.board.directives };
});

const schemaView = (ctx) => ({ ...ctx.board.schema, fieldTypes: FIELD_TYPES, uiModes: UI_MODES, stubSlots: STUB_SLOTS });
function schemaTx(ctx, actor, fn) {
  return tx(ctx, (events) => {
    const before = JSON.stringify(ctx.board.schema);
    fn();
    if (JSON.stringify(ctx.board.schema) !== before) events.push({ board: ctx.id, type: 'schema.updated', actor, schema: ctx.board.schema });
    return schemaView(ctx);
  });
}

route('GET', '/api/boards/:board/schema', 'Ticket schema: built-in field config + declared custom fields', ({ p }) => schemaView(getCtx(p.board)));
route('PUT', '/api/boards/:board/schema', 'Set schema: { builtins?: { type: { ui, stub, label }, ... }, fields?: FieldDef[] (replaces all) }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return schemaTx(ctx, actor, () => {
    if ('builtins' in body) {
      const next = normBuiltins({ ...ctx.board.schema.builtins, ...body.builtins });
      if (JSON.stringify(next) !== JSON.stringify(ctx.board.schema.builtins)) humanConfig(actor, 'change the built-in fields (who may edit what)');
      ctx.board.schema.builtins = next;
    }
    if ('fields' in body) {
      const defs = arr(body.fields).map((f) => normField(f));
      const keys = defs.map((f) => f.key);
      if (new Set(keys).size !== keys.length) fail(400, 'Duplicate field keys');
      ctx.board.schema.fields = defs;
    }
  });
});
route('GET', '/api/boards/:board/ticket-templates', 'Ticket templates: presets for new tickets (create with { "template": "<key>" })', ({ p }) => getCtx(p.board).board.ticketTemplates);
function templatesTx(ctx, actor, fn) {
  return tx(ctx, (events) => {
    const out = fn(ctx.board.ticketTemplates);
    events.push({ board: ctx.id, type: 'templates.updated', actor, templates: ctx.board.ticketTemplates.map((t) => t.key) });
    return out;
  });
}
route('POST', '/api/boards/:board/ticket-templates', 'Add a ticket template: { label, key?, icon?, help?, type?, priority?, parent?, column?, title?, description?, fields?, properties?, position? }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return created(templatesTx(ctx, actor, (list) => {
    const t = normTicketTemplate(body);
    if (list.some((x) => x.key === t.key)) fail(409, `Template "${t.key}" already exists — PATCH it instead`);
    if (t.column) findColumn(ctx.board, t.column);
    list.splice(resolveIndex(list.map((x) => x.key), body.position), 0, t);
    return t;
  }));
});
route('PATCH', '/api/boards/:board/ticket-templates/:key', 'Change a ticket template (merged; fields/properties replace)', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return templatesTx(ctx, actor, (list) => {
    const i = list.indexOf(ticketTemplate(ctx, p.key));
    const t = normTicketTemplate({ ...body, key: list[i].key }, list[i]);
    if (t.column) findColumn(ctx.board, t.column);
    list[i] = t;
    if (body.position != null) { list.splice(i, 1); list.splice(resolveIndex(list.map((x) => x.key), body.position), 0, t); }
    return t;
  });
});
route('DELETE', '/api/boards/:board/ticket-templates/:key', 'Remove a ticket template (tickets made from it are unchanged)', ({ p, actor }) => {
  const ctx = getCtx(p.board);
  return templatesTx(ctx, actor, (list) => { const t = ticketTemplate(ctx, p.key); list.splice(list.indexOf(t), 1); return { deleted: t.key }; });
});

// Field writes answer with just the field (add ?full=true for the whole schema).
const fieldReply = (ctx, key, q) => (q.full === 'true' ? schemaView(ctx) : { field: ctx.board.schema.fields.find((f) => f.key === key) || null });
route('POST', '/api/boards/:board/schema/fields', 'Declare a field: { key, label, type, options?, ui?, stub?, icon?, help?, required?, default?, min?, max?, position? }', ({ p, q, body, actor }) => {
  const ctx = getCtx(p.board);
  let key;
  schemaTx(ctx, actor, () => {
    const def = normField(body);
    key = def.key;
    if (ctx.board.schema.fields.some((f) => f.key === def.key)) fail(409, `Field "${def.key}" already exists — PATCH it instead`);
    ctx.board.schema.fields.splice(resolveIndex(ctx.board.schema.fields.map((f) => f.key), body.position), 0, def);
  });
  return created(fieldReply(ctx, key, q));
});
route('PATCH', '/api/boards/:board/schema/fields/:key', 'Change a field definition (merged)', ({ p, q, body, actor }) => {
  const ctx = getCtx(p.board);
  schemaTx(ctx, actor, () => {
    const list = ctx.board.schema.fields;
    const i = list.findIndex((f) => f.key === p.key);
    if (i < 0) fail(404, `Field "${p.key}" not declared`);
    list[i] = normField(body, list[i]);
    if ('position' in body) { const [f] = list.splice(i, 1); list.splice(resolveIndex(list.map((x) => x.key), body.position), 0, f); }
  });
  return fieldReply(ctx, p.key, q);
});
route('DELETE', '/api/boards/:board/schema/fields/:key', 'Remove a field definition (stored values are kept)', ({ p, actor }) => {
  const ctx = getCtx(p.board);
  schemaTx(ctx, actor, () => {
    const n = ctx.board.schema.fields.length;
    ctx.board.schema.fields = ctx.board.schema.fields.filter((f) => f.key !== p.key);
    if (ctx.board.schema.fields.length === n) fail(404, `Field "${p.key}" not declared`);
  });
  return { deleted: p.key };
});

route('GET', '/api/boards/:board/columns', 'List columns with flags', ({ p }) => getCtx(p.board).board.columns);

route('POST', '/api/boards/:board/columns', 'Create column: { name, color?, icon?, position?, flags? } (human only)', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  humanConfig(actor, 'add columns (a column changes where the gates sit)');
  return created(tx(ctx, (events) => {
    const col = addColumn(ctx.board, body);
    events.push({ board: ctx.id, type: 'column.created', actor, columnId: col.id, column: { id: col.id, name: col.name, flags: col.flags } });
    return col;
  }));
});

route('PATCH', '/api/boards/:board/columns/:column', 'Update column: { name?, color?, icon?, position?, flags? (merged) } — position and known flags are human only', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return tx(ctx, (events) => {
    const col = findColumn(ctx.board, decodeURIComponent(p.column));
    const before = JSON.stringify({ ...col, itemIds: undefined });
    if ('flags' in body) {
      const next = pickFlags(body.flags, col.flags);
      // every known flag, plus pickup and working, which steer where agents pick up work and get woken
      const gated = [...Object.keys(DEFAULT_FLAGS), 'pickup', 'working'].filter((k) => JSON.stringify(next[k]) !== JSON.stringify(col.flags[k]));
      if (gated.length) humanConfig(actor, `change ${gated.join(', ')} on "${col.name}" (name, colour, icon and other custom flags are open)`);
    }
    if ('position' in body) humanConfig(actor, 'reorder columns (the order decides where the gates sit)');
    if ('name' in body) { if (!String(body.name).trim()) fail(400, 'name cannot be empty'); col.name = str(body.name, 60).trim(); }
    if ('color' in body) col.color = str(body.color, 32);
    if ('icon' in body) col.icon = str(body.icon, 32);
    if ('flags' in body) col.flags = pickFlags(body.flags, col.flags);
    if ('position' in body) {
      const cols = ctx.board.columns;
      cols.splice(cols.indexOf(col), 1);
      cols.splice(resolveIndex(cols.map((c) => c.id), body.position), 0, col);
    }
    if (JSON.stringify({ ...col, itemIds: undefined }) !== before || 'position' in body) {
      events.push({ board: ctx.id, type: 'column.updated', actor, columnId: col.id, column: { id: col.id, name: col.name, flags: col.flags } });
    }
    return col;
  });
});

route('DELETE', '/api/boards/:board/columns/:column', 'Delete an EMPTY column (human only)', ({ p, actor }) => {
  const ctx = getCtx(p.board);
  humanConfig(actor, 'delete columns');
  return tx(ctx, (events) => {
    const col = findColumn(ctx.board, decodeURIComponent(p.column));
    if (col.itemIds.length) fail(409, `"${col.name}" still has ${col.itemIds.length} item(s). Move or archive them first.`);
    ctx.board.columns = ctx.board.columns.filter((c) => c !== col);
    events.push({ board: ctx.id, type: 'column.deleted', actor, columnId: col.id });
    return { deleted: col.id };
  });
});

route('GET', '/api/boards/:board/columns/:column/items', 'All items in a column, in order (?full=true for everything)', ({ p, q }) => {
  const ctx = getCtx(p.board);
  const col = findColumn(ctx.board, decodeURIComponent(p.column));
  const blocksOf = blocksIndex(ctx);
  const items = col.itemIds.map((id) => itemView(ctx, ctx.board.items[id], false, blocksOf));
  return {
    column: { id: col.id, name: col.name, flags: col.flags },
    items: q.full === 'true' ? items : items.map((v) => Object.fromEntries(SUMMARY_FIELDS.map((f) => [f, f === 'claimant' ? v.lease?.claimant ?? null : v[f]]))),
  };
});

route('POST', '/api/boards/:board/items', 'Create item: { title, template?, description?, column?, type?, priority?, parent?, fields?, properties?, blockedBy?, needsHuman?, attachments?, position? }',
  ({ p, body, actor }) => {
    const ctx = getCtx(p.board);
    return created(itemView(ctx, createItem(ctx, body, actor)));
  });

route('POST', '/api/boards/:board/items/bulk', 'Patch many items: { ids: [], patch: {...} } → per-item results', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  const out = arr(body.ids).map((id) => {
    try { return { id, ok: true, item: updateItem(ctx, id, body.patch || {}, actor) }; }
    catch (e) { return { id, ok: false, status: e.status || 500, error: e.message }; }
  });
  return Promise.all(out.map(async (x) => (x.ok ? { ...x, item: await afterLanding(ctx, x.item) } : x)));
});

route('GET', '/api/boards/:board/items/:id', 'Full item (also finds archived items)', ({ p }) => {
  const ctx = getCtx(p.board);
  const key = p.id.toUpperCase();
  if (ctx.board.items[key]) return itemView(ctx, ctx.board.items[key]);
  if (ctx.archive.items[key]) return itemView(ctx, ctx.archive.items[key], true);
  return fail(404, `Item "${p.id}" not found`);
});

route('PATCH', '/api/boards/:board/items/:id', 'Change any field incl. column/position. properties merge (null deletes). Send version for safe writes.',
  ({ p, body, actor }) => { const ctx = getCtx(p.board); return afterLanding(ctx, updateItem(ctx, p.id, body, actor)); });

route('POST', '/api/boards/:board/items/:id/move', 'Move/reorder: { column?, position? | beforeId? | afterId? }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  const { column, columnId, position, beforeId, afterId, version } = body;
  return afterLanding(ctx, updateItem(ctx, p.id, { column: column ?? columnId, position, beforeId, afterId, version }, actor));
});

route('GET', '/api/boards/:board/items/:id/history', 'Recent events for this item', ({ p }) => {
  const key = p.id.toUpperCase();
  return recent.filter((e) => e.board === p.board && e.itemId === key).slice(-200);
});

route('POST', '/api/boards/:board/items/:id/comments', 'Add comment: { body } (markdown, @mentions notify); the reply has a "warning" when an agent was named without @ or the whole body is a file path (the board does not read it)', ({ p, body, actor }) =>
  created(addComment(getCtx(p.board), p.id, body, actor)));

route('POST', '/api/boards/:board/items/:id/attachments', 'Attach: { name?, mime?, dataBase64 | path (absolute) | url }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  if (actor.kind === 'user' && ctx.board.schema.builtins.attachments.ui !== 'edit') fail(403, 'Files are read-only in the UI');
  return created(tx(ctx, (events) => {
    const item = getItem(ctx, p.id);
    const att = saveAttachment(ctx, item, body, actor);
    item.attachments.push(att);
    item.version++;
    item.updatedAt = now();
    events.push(itemEvent(ctx, 'item.updated', item, actor, { changes: { attachments: { from: null, to: att.name } } }));
    return att;
  }));
});

route('DELETE', '/api/boards/:board/items/:id/attachments/:att', 'Detach (file is kept on disk)', ({ p, actor }) => {
  const ctx = getCtx(p.board);
  return tx(ctx, (events) => {
    const item = getItem(ctx, p.id);
    const att = item.attachments.find((a) => a.id === p.att);
    if (!att) fail(404, 'Attachment not found');
    if (actor.kind === 'user' && ctx.board.schema.builtins.attachments.ui !== 'edit') fail(403, 'Files are read-only in the UI');
    item.attachments = item.attachments.filter((a) => a !== att);
    if (item.cover === att.id) item.cover = 'auto';
    item.version++;
    events.push(itemEvent(ctx, 'item.updated', item, actor, { changes: { attachments: { from: att.name, to: null } } }));
    return itemView(ctx, item);
  });
});

route('POST', '/api/boards/:board/items/:id/lease', 'Claim or renew a lease: { minutes?, claimant? }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return itemView(ctx, claimLease(ctx, p.id, body, actor));
});
route('PUT', '/api/boards/:board/items/:id/status', 'Live status line while you hold the lease: { status } ("" clears)', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return itemView(ctx, setStatus(ctx, p.id, body, actor));
});
route('DELETE', '/api/boards/:board/items/:id/lease', 'Release a lease', ({ p, actor }) => {
  const ctx = getCtx(p.board);
  return itemView(ctx, releaseLease(ctx, p.id, actor));
});

route('POST', '/api/boards/:board/items/:id/review', 'Request review in one call: moves to the review column, comments your summary, releases your lease, raises needs-you. { summary?, reason?, column? } → the item, plus "warnings" if the work skipped the board', async ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  const before = getItem(ctx, p.id);
  // git first, outside the transaction (it never blocks the board); the ticket is read again inside it
  const [warnings, commits] = await Promise.all([
    workWarnings(ctx, before),
    actor.kind === 'agent' && worktrees && agentBranch(actor.name) ? worktrees.commitsForAsync(actor.name, before.id).catch(() => []) : null,
  ]);
  if (actor.kind === 'agent' && !String(body.evidence || '').trim()) warnings.push(`No evidence: the human approves what they can see working. Add "evidence" — screenshots (attach them to the ticket and name them), the command you ran and its output, the test results — and for anything visible, what to look at in the Preview (${previewable() ? "the review card's Preview button runs your branch" : 'a link to where it runs'}). Request review again with evidence.`);
  const item = itemView(ctx, requestReview(ctx, p.id, body, actor, commits));
  return warnings.length ? { ...item, warnings } : item;
});

// Signs that a ticket's work happened off the board: barely any time in the working column, or commits
// that mention it from before it was started. Told to the agent at review time so In Progress (and the
// cycle-time metric) mean something.
// Preview: the human sees a ticket's work running before approving it. On a board whose code is Intellagent
// itself, the board starts a sandbox board ("preview") from the author's worktree with a fresh snapshot of
// the tickets, and hands back its sign-in link (the sandbox's own token, never the human's).
route('POST', '/api/boards/:board/items/:id/preview', "Human: run this ticket's work on a temporary board (the author's branch, a copy of the tickets) and get its link → { url, from, author }", async ({ p, actor }) => {
  if (actor.kind !== 'user') fail(403, 'Only the human opens previews', { code: 'HUMAN_ONLY', hint: 'Agents run their own: intellagent sandbox <you> --from <author> --seed snapshot' });
  if (!previewable()) fail(400, "This board's code isn't Intellagent, so it can't run as a preview", { code: 'NO_PREVIEW', hint: 'Ask the agent for screenshots or a link in its evidence' });
  const ctx = getCtx(p.board);
  const item = getItem(ctx, p.id);
  const author = item.questions?.find((q) => q.kind === 'review')?.raisedBy || item.workedBy?.at(-1) || null;
  const from = author && worktrees && agentBranch(author) && fs.existsSync(path.join(worktrees.where(author).path, 'server.js')) ? author : 'main';
  const r = await require('./lib/sandbox').start(MANIFEST_PATH, 'preview', { from, seed: 'snapshot', fresh: true });
  return { url: r.signIn, from, author, port: r.port };
});

// git without blocking the board: resolves to its output, or null (not a repo, git missing, too slow).
const gitOut = (args, timeout) => new Promise((resolve) => {
  require('child_process').execFile('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (e, out) => resolve(e ? null : out));
});

async function workWarnings(ctx, item) {
  const out = [];
  const work = workingColumn(ctx);
  const entered = work && (item.flow || []).filter((x) => x.col === work.id).at(-1);
  if (!entered) return out;
  const startedMs = Date.parse(entered.at);
  const secs = Math.round((Date.now() - startedMs) / 1000);
  if (secs < 60) out.push(`${item.id} spent ${secs}s in ${work.name}. Start tickets (POST …/start) before you work on them, so the board shows real work.`);
  const log = await gitOut(['log', '--all', `--grep=${item.id}([^0-9]|$)`, '-E', '--format=%ct %h'], 3000);
  const early = (log || '').split('\n').filter(Boolean).map((l) => l.split(' ')).filter(([t]) => Number(t) * 1000 < startedMs - 5000).map(([, h]) => h);
  if (early.length) out.push(`Commit${early.length > 1 ? 's' : ''} ${early.join(', ')} mention ${item.id} but came before it was started.`);
  return out;
}

route('GET', '/api/boards/:board/digest', 'Daily digest: end-of-session summaries, newest first. ?days=7', ({ p, q }) => {
  const ctx = getCtx(p.board);
  const days = clamp(Number(q.days) || 7, 1, 90);
  const since = new Date(Date.now() - days * 86_400_000).toLocaleDateString('en-CA');
  const byDay = {};
  for (const e of ctx.board.digest) if (e.date >= since) (byDay[e.date] ||= []).push(e);
  return Object.entries(byDay).sort(([a], [b]) => b.localeCompare(a)).map(([date, entries]) => ({ date, entries: entries.sort((a, b) => b.ts.localeCompare(a.ts)) }));
});
route('POST', '/api/boards/:board/digest', 'Append to today\'s digest: { summary (markdown), items?: [ids] }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  if (!String(body.summary || '').trim()) fail(400, '"summary" is required');
  return created(tx(ctx, (events) => {
    const t = now();
    const entry = { id: rid('d'), date: new Date().toLocaleDateString('en-CA'), ts: t, author: actor, summary: str(body.summary, 20_000), items: arr(body.items).map((x) => String(x).toUpperCase()).filter((id) => !(ctx.board.items[id] || ctx.archive.items[id])?.test).slice(0, 50) };
    ctx.board.digest.push(entry);
    if (ctx.board.digest.length > 500) ctx.board.digest.splice(0, ctx.board.digest.length - 500);
    events.push({ board: ctx.id, type: 'digest.added', actor, entry: { id: entry.id, summary: trimChange(entry.summary) } });
    return entry;
  }));
});

route('GET', '/api/boards/:board/brief', 'Start here (agents): who you are, what to do next, how this board works, the exact calls. ?via=cli|mcp|http &format=json', ({ req, p, q, actor }) => {
  const ctx = getCtx(p.board);
  const text = briefing(ctx, q.agent || actor.name, `http://${req.headers.host}`, ['cli', 'mcp', 'http'].includes(q.via) ? q.via : 'cli');
  return q.format === 'json' ? { brief: text, work: workFor(ctx, q.agent || actor.name) } : text;
});
route('GET', '/api/boards/:board/metrics', 'Flow metrics over ?days=7|30: done, cycle time, time per column, waiting on the human, answer time', ({ p, q }) =>
  metrics(getCtx(p.board), clamp(Number(q.days) || 7, 1, 90)));
route('GET', '/api/boards/:board/requests', 'Requests from the human to agents: ?status=open|done&to=<agent>', ({ p, q }) =>
  (getCtx(p.board).board.requests || []).filter((x) => (!q.status || x.status === q.status) && (!q.to || x.to === q.to)).slice().reverse());
route('POST', '/api/boards/:board/requests', 'Ask an agent something not tied to a ticket: { body, to? } (to defaults to the board coordinator)', ({ p, body, actor }) =>
  created(createRequest(getCtx(p.board), body, actor)));
route('POST', '/api/boards/:board/requests/:id/reply', 'Reply to a request: { body?, done? } — agents: say what you did and pass "done": true', ({ p, body, actor }) =>
  replyRequest(getCtx(p.board), p.id, body, actor));
route('POST', '/api/boards/:board/requests/:id/withdraw', 'Take back a request you sent, once it is met or no longer relevant: { reason } — the sender, the coordinator or the human', ({ p, body, actor }) =>
  withdrawRequest(getCtx(p.board), p.id, body, actor));
route('POST', '/api/boards/:board/items/:id/questions/:qid/withdraw', 'Take back your open question or review request on a ticket: { reason } — whoever raised it, the coordinator or the human. Moves nothing.', ({ p, body, actor }) =>
  itemView(getCtx(p.board), withdrawQuestion(getCtx(p.board), p.id, p.qid, body, actor)));
route('GET', '/api/boards/:board/work', 'What needs you now (agent): next actions, your leases, answered questions, review feedback, assigned and ready tickets. ?agent= to look at another agent', ({ p, q, actor }) =>
  workFor(getCtx(p.board), q.agent || actor.name));
route('GET', '/api/boards/:board/items/:id/transitions', 'Where you can move this ticket, and why not elsewhere', ({ p, actor }) => {
  const ctx = getCtx(p.board);
  return transitions(ctx, getItem(ctx, p.id), actor);
});
route('POST', '/api/boards/:board/items/:id/start', 'Start or resume work in one step: lease + move to the working column + status + assign. { status?, minutes?, column?, force? }', ({ p, body, actor }) =>
  startWork(getCtx(p.board), p.id, body, actor));
route('POST', '/api/boards/:board/items/:id/land', 'Human, or an agent with work.land: put this approved ticket\'s commits from a worktree branch on main (when landing was blocked) { agent? } — agent: whose branch (a lander passes its own after resolving conflicts there)', async ({ p, body, actor }) => {
  if (!worktrees) fail(400, 'No worktrees on this board');
  const ctx = getCtx(p.board);
  const item = getItem(ctx, p.id);
  // An agent may land only work that was approved: landing never decides anything, the approval did.
  if (actor.kind !== 'user') {
    grantFor(ctx, actor, 'work.land', null, 'land work on main');
    if (item.review?.verdict !== 'approve') fail(409, `${item.id} isn't approved: only approved work lands`, { code: 'NOT_APPROVED', hint: 'Landing follows an approval; leave it until the human (or a delegated reviewer) approves it' });
  }
  // { landed: [shas] }: it was landed by hand. The shas must be on main (none: main is searched for the ticket id).
  if (Array.isArray(body.landed)) {
    if (item.review?.verdict !== 'approve') fail(409, `${item.id} isn't approved: only approved work lands`, { code: 'NOT_APPROVED', hint: 'Landing follows an approval' });
    // Only a landing the board saw fail can be marked: otherwise any sha would hide work that never landed.
    if (item.landing?.state !== 'failed') fail(409, `${item.id}'s landing isn't marked failed (it is ${item.landing?.state || 'not tried'})`, { code: 'CONFLICT', hint: 'Only a failed landing is marked landed by hand; use the land route without "landed" otherwise' });
    const shas = body.landed.length ? await worktrees.onMain(body.landed) : await worktrees.mentionedOnMain(item.id, item.review.at);
    if (!shas.length) fail(400, `No such commits on ${worktrees.mainBranch()}`, { code: 'BAD_REQUEST', hint: 'Pass the shas as they are on main' });
    await landingOf(ctx, item.id);
    return { item: item.id, landed: shas, via: 'hand', landing: markLandedByHand(ctx, item.id, shas, actor) || ctx.board.items[item.id].landing };
  }
  const agent = body.agent || item.review?.requestedBy || item.workedBy?.at(-1);
  if (!agent || !agentBranch(agent)) fail(400, `No agent worktree for ${item.id}; pass "agent"`);
  await landingOf(ctx, item.id); // one already under way (the approval's) goes first
  const r = await startLanding(ctx, item.id, agent, actor);
  return { item: item.id, agent, ...r };
});
// A change that may approve a ticket (a decision, or the human moving it into an approval gate) answers once
// its landing is done, so the reply and the card show the outcome, as before landing went async.
const afterLanding = async (ctx, item) => { await landingOf(ctx, item.id); return itemView(ctx, ctx.board.items[item.id] || item); };
route('POST', '/api/boards/:board/items/:id/review/decision', 'Human: decide a review { verdict: "approve"|"changes", comment?, column? }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return withCommits(ctx, p.id, () => afterLanding(ctx, decideReview(ctx, p.id, body, actor)));
});
route('POST', '/api/boards/:board/finish', 'End your session: release all your leases (and the board hold), optionally post the digest { summary?, items? }', ({ p, body, actor }) =>
  finishSession(getCtx(p.board), body, actor));

route('POST', '/api/boards/:board/items/:id/reviewers', 'Assign a reviewer (the human or the receptionist): { name } — an agent marked as a reviewer, never the ticket\'s author; it is woken to comment', ({ p, body, actor }) =>
  itemView(getCtx(p.board), addReviewer(getCtx(p.board), p.id, body, actor)));
route('DELETE', '/api/boards/:board/items/:id/reviewers/:name', 'Remove a reviewer (the human or the receptionist)', ({ p, actor }) =>
  itemView(getCtx(p.board), removeReviewer(getCtx(p.board), p.id, p.name, actor)));
route('POST', '/api/boards/:board/items/:id/reviewers/:name/verdict', 'A reviewer\'s verdict: { verdict: "ok" | "concerns", comment } — posts it on the card (concerns @mention the author; a comment that is only a file path comes back with a "warning"); the human still approves', ({ p, body, actor }) =>
  withCommits(getCtx(p.board), p.id, () => {
    const view = itemView(getCtx(p.board), reviewerVerdict(getCtx(p.board), p.id, p.name, body, actor));
    const warning = pathOnlyWarning(body.comment);
    return warning ? { ...view, warning } : view;
  }));
route('POST', '/api/boards/:board/items/:id/reactions', 'React with an emoji: { emoji ("👀" or "eyes", "+1", "tada"…), commentId? (else the card), toggle? }', ({ p, body, actor }) =>
  ({ reactions: react(getCtx(p.board), p.id, body, actor, body.toggle ? 'toggle' : true) }));
route('DELETE', '/api/boards/:board/items/:id/reactions', 'Remove your reaction: { emoji, commentId? }', ({ p, body, q, actor }) =>
  ({ reactions: react(getCtx(p.board), p.id, { ...q, ...body }, actor, false) }));

route('POST', '/api/boards/:board/items/:id/lease/request', 'Ask the holder for a ticket\'s lease: { reason }', ({ p, body, actor }) => requestLease(getCtx(p.board), p.id, body, actor));
route('POST', '/api/boards/:board/items/:id/lease/handover', 'Holder (or human): hand the lease to { to? (default: first requester), note?, status? }', ({ p, body, actor }) => handOverLease(getCtx(p.board), p.id, body, actor));
route('POST', '/api/boards/:board/items/:id/lease/decline', 'Holder (or human): decline a lease request { to? (default: first requester), reason }', ({ p, body, actor }) => declineLease(getCtx(p.board), p.id, body, actor));

route('POST', '/api/boards/:board/items/:id/attention', 'Ask the human: { reason, form? } — form: [{ key, label, type: text|longtext|choice|multi|yesno|number|date, options?, required?, default?, help? } | { type: "note", markdown }]; allowed even while others hold leases', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  const { item, questionId } = askHuman(ctx, p.id, body.reason, actor, body.form ?? null);
  return { ...itemView(ctx, item), questionId };
});
route('DELETE', '/api/boards/:board/items/:id/attention', 'Answer: { reply?, questionId?, answers? } — one question, or all open ones without questionId (reply becomes a comment); answers: { key: value } for a question with a form', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return itemView(ctx, resolveAttention(ctx, p.id, body, actor));
});

route('DELETE', '/api/boards/:board/items/:id', 'Permanently delete a TEST ticket (created with "test": true); any other ticket → 403 NOT_TEST, archive it instead', ({ p, actor }) => ({ deleted: deleteItems(getCtx(p.board), [p.id], actor) }));
route('DELETE', '/api/boards/:board/test-items', 'Human: permanently delete every test ticket on the board (archived ones too)', ({ p, actor }) => {
  if (actor.kind !== 'user') fail(403, 'Only a human can delete all test tickets at once — delete them one by one', { code: 'HUMAN_ONLY' });
  const ctx = getCtx(p.board);
  const ids = [...Object.values(ctx.board.items), ...Object.values(ctx.archive.items)].filter((it) => it.test).map((it) => it.id);
  return { deleted: ids.length ? deleteItems(ctx, ids, actor) : [] };
});
route('POST', '/api/boards/:board/items/:id/archive', 'Archive one item (never deleted)', ({ p, body, actor }) => ({ archived: archiveItems(getCtx(p.board), [p.id], actor, body.reason || null) }));
route('POST', '/api/boards/:board/archive', 'Archive many: { ids: [], reason? }', ({ p, body, actor }) => ({ archived: archiveItems(getCtx(p.board), body.ids, actor, body.reason || null) }));
route('GET', '/api/boards/:board/archive', 'Archived items (newest first)', ({ p }) => {
  const ctx = getCtx(p.board);
  return Object.values(ctx.archive.items).sort((a, b) => b.archivedAt.localeCompare(a.archivedAt))
    .map((x) => ({ id: x.id, title: x.title, type: x.type, priority: x.priority, parent: x.parent, archivedAt: x.archivedAt, archivedBy: x.archivedBy, archivedFrom: x.archivedFrom, reason: x.archiveReason }));
});
route('POST', '/api/boards/:board/archive/:id/restore', 'Restore from archive: { column? }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return itemView(ctx, restoreItem(ctx, p.id, body, actor));
});

route('GET', '/api/search', 'Search: ?board&q&type&priority&column&claimant&parent&author&prop.<key>=[op:]value&includeArchived&sort&order&limit&full', ({ q }) => search(searchFromQuery(q)));
route('POST', '/api/search', 'Search: { board?, q?, where: { "properties.risk": "high", "priority": { "in": ["High","Critical"] } }, includeArchived?, sort?, order?, limit?, fields?, full? }', ({ body }) => search(body));

route('GET', '/api/events', 'Events since a cursor: ?since=<seq>&<filter>&tail=true (newest N instead of oldest N)', ({ res, q }) =>
  longPoll(res, { filter: parseFilter(q), since: Number(q.since) || 0, timeout: 0, limit: clamp(Number(q.limit) || 100, 1, 1000), tail: q.tail === 'true' }));

route('GET', '/api/events/wait', 'Long-poll: blocks until a matching event or timeout. ?since=<seq>&timeout=25&<filter>', ({ res, q, actor }) =>
  longPoll(res, {
    filter: parseFilter(q), since: q.since != null ? Number(q.since) : seq, timeout: clamp(Number(q.timeout) || 25, 1, 120),
    limit: clamp(Number(q.limit) || 100, 1, 1000), agent: actor.kind === 'agent' ? actor.name : null,
  }));

route('GET', '/api/stream', 'Server-Sent Events stream: ?<filter>&agent=<name>', ({ req, res, q, actor }) =>
  openStream(req, res, parseFilter(q), q.ui || q.ticket ? null : actor.kind === 'agent' ? actor.name : null, !!(q.ui || q.ticket)));
route('POST', '/api/stream-ticket', 'The UI: trade the human token for a one-use ticket to open /api/stream?ui=1&ticket=… (human only)', ({ actor }) => {
  if (actor.kind !== 'user') fail(403, 'Stream tickets are for the board UI', { code: 'HUMAN_ONLY', hint: 'Agents open /api/stream with their token in the Authorization header' });
  return issueStreamTicket();
});

route('GET', '/api/subscriptions', 'List subscriptions: ?agent=', ({ q }) => Object.values(subs).filter((s) => !q.agent || s.agent === q.agent));
route('POST', '/api/subscriptions', 'Create a durable subscription with a server-side cursor: { label?, filter: {...}, since? }', ({ body, actor }) => {
  const s = { id: rid('sub'), agent: actor.name, label: str(body.label || '', 80), filter: parseFilter(body.filter || {}), cursor: body.since != null ? Number(body.since) : seq, createdAt: now() };
  subs[s.id] = s;
  saveSubs();
  touch(actor.name, 'subscribe');
  return created(s);
});
// Removing a subscription or moving its cursor is for whoever made it, or the human: anyone else could make
// its owner silently skip events. Reading it with ?peek=true moves nothing, so that stays open.
const ownSub = (s, actor) => {
  if (actor.kind !== 'user' && String(s.agent).toLowerCase() !== String(actor.name).toLowerCase()) {
    fail(403, `Subscription ${s.id} belongs to ${s.agent}`, { code: 'FORBIDDEN', hint: 'Make your own with POST /api/subscriptions, or read this one with ?peek=true' });
  }
};
route('DELETE', '/api/subscriptions/:id', 'Remove a subscription (its owner or the human)', ({ p, actor }) => {
  if (!subs[p.id]) fail(404, 'Subscription not found');
  ownSub(subs[p.id], actor);
  delete subs[p.id];
  saveSubs();
  return { deleted: p.id };
});
route('POST', '/api/subscriptions/:id/ack', 'Advance the cursor after handling events read with ?peek=true: { cursor } (at-least-once delivery; its owner or the human)', ({ p, body, actor }) => {
  const sub = subs[p.id];
  if (!sub) fail(404, `No subscription "${p.id}"`);
  ownSub(sub, actor);
  const c = Number(body.cursor);
  if (!Number.isFinite(c)) fail(400, '"cursor" is required');
  sub.cursor = Math.max(sub.cursor, Math.min(c, seq));
  sub.lastDelivery = now();
  saveSubs();
  return { id: sub.id, cursor: sub.cursor };
});
route('GET', '/api/subscriptions/:id/next', 'Long-poll the subscription; advances its cursor (its owner or the human; anyone may ?peek=true). ?timeout=25&limit=50&peek=true', ({ res, p, q, actor }) => {
  const s = subs[p.id];
  if (!s) fail(404, 'Subscription not found');
  if (q.peek !== 'true') ownSub(s, actor);
  return longPoll(res, {
    filter: s.filter, since: s.cursor, timeout: clamp(Number(q.timeout) || 25, 0, 120), limit: clamp(Number(q.limit) || 50, 1, 500), agent: s.agent,
    onDeliver: q.peek === 'true' ? null : (cursor) => { s.cursor = cursor; s.lastDelivery = now(); saveSubs(); },
  });
});

// Which agents would receive events about each item, judged by the item-scoped keys of their live and durable filters.
const SCOPE_KEYS = ['itemId', 'columnId', 'claimant', 'for', 'assignee', 'parent', 'itemType'];
function listenersFor(ctx) {
  const sources = [
    ...[...sseClients].filter((c) => c.agent).map((c) => [c.agent, c.filter]),
    ...[...waiters].filter((w) => w.agent).map((w) => [w.agent, w.filter]),
    ...Object.values(subs).map((x) => [x.agent, x.filter]),
  ].filter(([, f]) => SCOPE_KEYS.some((k) => f[k]) && (!f.board || f.board === ctx.id));
  const out = {};
  for (const item of Object.values(ctx.board.items)) {
    const ev = { board: ctx.id, type: 'item.updated', itemId: item.id, columnId: item.columnId, item: snapshot(ctx, item), recipients: recipientsFor(item, SYSTEM) };
    const names = new Set();
    for (const [agent, f] of sources) {
      const { types, fields, excludeActor, actorKind, actor, ...scoped } = f;
      if (matchesFilter(ev, scoped)) names.add(agent);
    }
    if (names.size) out[item.id] = [...names];
  }
  return out;
}
route('GET', '/api/boards/:board/listeners', 'Agents listening to each item: { itemId: [agent names] }', ({ p }) => listenersFor(getCtx(p.board)));

/* standing agents: defined in agents.json next to the manifest; the API only observes and steers them */
// Is this name an agent (not a person)? People have kind "user" profiles.
const isAgentName = (n) => !!n && profiles[n]?.kind !== 'user';
// Send a ticket an agent was working on back to the pickup column, keeping its assignee, with a comment.
function backToReady(ctx, item, actor, events, note) {
  const ready = pickupColumns(ctx)[0];
  const l = item.lease;
  if (l) { item.lease = null; events.push(itemEvent(ctx, 'lease.revoked', item, actor, { claimant: l.claimant, reason: note.reason, mentions: [l.claimant] })); }
  item.comments.push({ id: rid('c'), author: actor, body: note.body, createdAt: now() });
  events.push(itemEvent(ctx, 'comment.added', item, actor, { comment: { id: item.comments.at(-1).id, body: trimChange(note.body) }, mentions: [note.agent].filter(Boolean) }));
  // a full Ready (WIP limit) must not undo the stop: the ticket then just stays where it is, released
  if (ready && ready.id !== item.columnId) { try { moveInto(ctx, item, ready.id, 'top', actor, events); } catch { /* stays put */ } }
  item.version++;
  item.updatedAt = now();
}

// Stop every agent: kill runs, pause standing agents, release agent leases and the master lease, and send
// the tickets they were working on back to Ready (assignee kept) with a comment saying what happened.
function stopAllAgents(actor) {
  const agents = standing ? standing.stopAll() : { paused: [], stopped: [] };
  const moved = [];
  const released = [];
  for (const ctx of boards.values()) {
    const work = workingColumn(ctx);
    tx(ctx, (events) => {
      const m = activeMaster(ctx);
      const masterAgent = m && isAgentName(m.holder) ? m.holder : null;
      if (masterAgent) { ctx.board.master = null; events.push({ board: ctx.id, type: 'master.revoked', actor, holder: masterAgent, recipients: [masterAgent] }); }
      for (const item of Object.values(ctx.board.items)) {
        const l = activeLease(item);
        const who = l && isAgentName(l.claimant) ? l.claimant : (!l && masterAgent && item.assignee === masterAgent ? masterAgent : null);
        if (!who) continue;
        const inWork = work && item.columnId === work.id;
        if (inWork) {
          backToReady(ctx, item, actor, events, { agent: who, reason: 'stopped', body: `⏹ Stopped by ${actor.name}: ${who} was halted mid-work. Check for half-finished changes before restarting.` });
          moved.push(`${ctx.id}/${item.id}`);
        } else if (l) {
          item.lease = null;
          item.version++;
          events.push(itemEvent(ctx, 'lease.revoked', item, actor, { claimant: l.claimant, reason: 'stopped', mentions: [l.claimant] }));
        }
        if (l) released.push(`${ctx.id}/${item.id}`);
      }
      events.push({ board: ctx.id, type: 'agents.stopped', actor, agents: agents.paused, stopped: agents.stopped, recipients: [] });
    });
  }
  return { ...agents, released, moved };
}

// Tickets an agent left in the working column with no sign of life go back to Ready.
function sweepStale() {
  const mins = Number(M.staleWorkMinutes) || 0;
  if (!mins) return;
  for (const ctx of boards.values()) {
    const work = workingColumn(ctx);
    if (!work) continue;
    const m = activeMaster(ctx);
    const stale = Object.values(ctx.board.items).filter((it) => {
      if (it.columnId !== work.id || activeLease(it) || it.test) return false;
      if ((it.questions || []).length) return false; // waiting on the human (a question or a review): not stale
      if (it.assignee && !isAgentName(it.assignee)) return false; // a person's own work is theirs to manage
      if (m && it.assignee === m.holder) return false; // the master holder works without leases
      if (it.assignee && standing?.isRunning(it.assignee)) return false;
      const last = Math.max(Date.parse(it.updatedAt || 0), Date.parse(it.enteredColumnAt || 0), ...(it.comments || []).map((c) => Date.parse(c.createdAt)));
      return Date.now() - last > mins * 60_000;
    });
    if (!stale.length) continue;
    try {
      tx(ctx, (events) => {
        for (const it of stale) backToReady(ctx, it, SYSTEM, events, { agent: it.assignee, reason: 'stale', body: `⏸ Back to ${pickupColumns(ctx)[0]?.name || 'the pickup column'}: no activity for ${mins} min in ${work.name} and nobody holds it.${it.assignee ? ` @${it.assignee} — start it again when you pick it up.` : ''}` });
      });
    } catch { /* e.g. Ready at its WIP limit: try again next sweep */ }
  }
}

const humanOnly = (actor) => { if (actor.kind !== 'user') fail(403, 'Only the human can control standing agents', { code: 'HUMAN_ONLY' }); };
// pause / resume / run: the human, or an agent granted agents.control — never on itself
const controls = (actor, target) => {
  if (actor.kind === 'user') return;
  if (!grantsOf(actor.name).some((g) => g.power === 'agents.control')) humanOnly(actor);
  if (String(target).toLowerCase() === actor.name.toLowerCase()) fail(403, 'An agent cannot pause, resume or run itself', { code: 'OWN_WORK' });
};
route('GET', '/api/agents', 'Standing agents (from agents.json): status, queue, last run, now (what a live run is doing), history (last 10 runs). ?recent=N adds the N newest runs across all agents', ({ q }) => standing.list({ recent: Math.min(50, Math.max(0, Number(q.recent) || 0)) }));
route('GET', '/api/agents/roles', 'Roles and permissions available for standing agents', () => {
  const { ROLES } = require('./lib/agents');
  return { roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, { label: v.label, icon: v.icon, description: v.description, perms: v.perms, listen: v.listen }])), perms: permLibrary().labels() };
});
/* The permission library (INT-228): every permission an agent can hold — built-in tools, board powers and
   the human's own (command, tool, folders, bundle, verbal), stored in agents.json under "perms". Everyone
   reads it; only the human changes it, and only its custom entries. */
const permLibrary = () => standing?.permissionLibrary?.() || createPermLibrary();
const permBody = (body) => Object.fromEntries(['kind', 'name', 'description', 'brief', 'commands', 'command', 'tools', 'tool', 'folders', 'includes', 'needs'].filter((k) => k in (body || {})).map((k) => [k, body[k]]));
function permChanged(actor, key, before, after) {
  emit({ type: 'permissions.changed', actor, key, before: before ?? null, after: after ?? null });
}
route('GET', '/api/permissions', 'The permission library: every permission an agent can hold (built-in tools, board powers, and the human\'s custom ones: command, tool, folders, bundle, verbal). Verbal ones carry enforced: false and a warning', () => {
  const lib = permLibrary();
  return { permissions: lib.list(), kinds: ['builtin', 'power', ...require('./lib/permissions').KINDS], errors: lib.errors, file: standing?.file ? path.basename(standing.file) : null };
});
route('POST', '/api/permissions', 'Human: add a custom permission { key, kind: command|tool|folders|bundle|verbal, name, description?, brief?, commands?|tools?|folders?|includes?, needs? } — stored in agents.json', ({ body, actor }) => {
  if (actor.kind !== 'user') fail(403, 'Only the human can change the permission library', { code: 'HUMAN_ONLY', hint: 'Ask on a card' });
  if (!standing) fail(404, 'No standing agents on this board');
  if (permLibrary().get(String(body.key || ''))) fail(409, `"${body.key}" already exists`, { code: 'CONFLICT', hint: `Change it with PATCH /api/permissions/${body.key}` });
  const r = standing.definePerm(body.key, permBody(body));
  permChanged(actor, r.permission.key, null, r.permission);
  return created(r.permission);
});
route('PATCH', '/api/permissions/:key', 'Human: change a custom permission (merged; null removes a key). Built-ins can\'t change', ({ p, body, actor }) => {
  if (actor.kind !== 'user') fail(403, 'Only the human can change the permission library', { code: 'HUMAN_ONLY', hint: 'Ask on a card' });
  if (!standing) fail(404, 'No standing agents on this board');
  const r = standing.definePerm(p.key, permBody(body), { merge: true });
  permChanged(actor, p.key, r.before, r.permission);
  return r.permission;
});
route('DELETE', '/api/permissions/:key', 'Human: remove a custom permission no agent or other permission uses (409 CONFLICT names them)', ({ p, actor }) => {
  if (actor.kind !== 'user') fail(403, 'Only the human can change the permission library', { code: 'HUMAN_ONLY', hint: 'Ask on a card' });
  if (!standing) fail(404, 'No standing agents on this board');
  const r = standing.removePerm(p.key);
  permChanged(actor, p.key, r.before, null);
  return { removed: r.removed };
});
// Grants as the UI sends them: [{ power, where? }]; where is { key: value | [values] } (strings only).
function cleanGrants(list) {
  if (list == null) return null;
  if (!Array.isArray(list)) fail(400, '"grants" must be a list');
  return list.map((g) => {
    const power = typeof g === 'string' ? g : g?.power;
    if (!POWERS[power]) fail(400, `Unknown power "${power}". Powers: ${Object.keys(POWERS).join(', ')}`);
    // A scope narrows a power, so a malformed one is refused, never dropped: dropping it would turn "only
    // where risk is low" into "everywhere".
    if (typeof g === 'string' || g?.where == null) return power;
    if (!isObj(g.where)) fail(400, `The scope ("where") of ${power} must be an object like { "fields.risk": "low" }`, { code: 'BAD_REQUEST' });
    const where = {};
    for (const [k, v] of Object.entries(g.where)) {
      if (!/^[\w.-]{1,80}$/.test(k)) fail(400, `Scope key "${k}" of ${power} is not a field path`, { code: 'BAD_REQUEST', hint: 'Use column, or a dotted path such as fields.risk or properties.area' });
      const vs = (Array.isArray(v) ? v : [v]).map((x) => str(x, 200).trim()).filter(Boolean);
      if (!vs.length) fail(400, `Scope key "${k}" of ${power} has no value`, { code: 'BAD_REQUEST', hint: 'Give a value or a list of values, or leave the key out' });
      where[k] = Array.isArray(v) ? vs : vs[0];
    }
    if (!Object.keys(where).length) fail(400, `The scope of ${power} is empty`, { code: 'BAD_REQUEST', hint: 'Leave "where" out to grant it everywhere, on purpose' });
    return { power, where };
  });
}
// Board access the UI sets: { columns?: [names], readOnly? } (stored as "limits")
function cleanLimits(v) {
  if (v == null) return null;
  if (!isObj(v)) fail(400, '"limits" must be an object');
  const out = {};
  if (Array.isArray(v.columns) && v.columns.length) out.columns = v.columns.map((x) => str(x, 80));
  if (v.readOnly) out.readOnly = true;
  return out;
}
route('POST', '/api/agents', 'Human: add or update a standing agent { name, role?, perms?, model?, description?, listen?, throttleMinutes?, maxRunsPerHour?, keepAlive?, limits?: { columns?, readOnly? }, grants?, coordinator? } — permissions from the fixed list, never a command. grants need a board with a user token (the signed-in human)', ({ body, actor, q }) => {
  humanOnly(actor);
  // Grants bypass the human's own approval, so only a request that proves it is the human may set them:
  // the board must have a user token (checked by authenticate for every X-User request).
  if (body.grants !== undefined && !M.auth.userToken) fail(403, 'Grants can be set from the browser only on a board with a sign-in token — run "intellagent token", restart the board and sign in with "intellagent open"; or edit agents.json', { code: 'NO_TOKEN' });
  if (body.limits !== undefined) body.limits = cleanLimits(body.limits);
  if (body.grants !== undefined) body.grants = cleanGrants(body.grants);
  const a = standing.define(body.name, body, { kind: actor.kind, name: actor.name });
  issueAgentToken(a.name);
  if (body.coordinator) {
    const ctx = getCtx(q.board || M.defaultBoard);
    tx(ctx, (events) => { ctx.board.coordinator = a.name; events.push({ board: ctx.id, type: 'board.updated', actor, changes: { coordinator: { to: a.name } } }); });
  }
  return created(a);
});
route('DELETE', '/api/agents/:name', 'Human: remove a standing agent', ({ p, actor }) => { humanOnly(actor); return standing.remove(p.name); });
route('GET', '/api/agents/:name', 'One standing agent', ({ p }) => standing.get(p.name));
route('GET', '/api/agents/:name/log', 'Output of the latest run (tail): ?bytes=20000', ({ p, q }) => {
  const a = standing.get(p.name);
  const f = a.lastRun?.log;
  if (!f || !fs.existsSync(f)) return { log: '' };
  const size = fs.statSync(f).size;
  const n = clamp(Number(q.bytes) || 20000, 1000, 500_000);
  const fd = fs.openSync(f, 'r');
  const buf = Buffer.alloc(Math.min(n, size));
  fs.readSync(fd, buf, 0, buf.length, size - buf.length);
  fs.closeSync(fd);
  return { file: f, truncated: size > n, log: buf.toString('utf8') };
});
/* Agent manager (INT-55): an agent with the agents.manage grant (or the human) edits another standing
   agent. What it may change is a fixed list; the run command, grants, enabled, env and cwd stay with the
   human's file. Models come from an allowlist, and tool perms and board permissions only ever narrow. */
const MANAGER_MODELS = Array.isArray(M.managerModels) && M.managerModels.length ? M.managerModels.map(String) : ['haiku', 'sonnet', 'opus'];
const MANAGE_KEYS = ['label', 'glyph', 'color', 'alignment', 'description', 'role', 'model', 'perms', 'permissions', 'areas', 'concerns', 'context', 'reviewer'];
// a list of short strings (areas: paths or globs; concerns: phrases)
const strList = (v, what) => {
  if (v == null) return null;
  const xs = [].concat(v).map((x) => String(x).trim()).filter(Boolean);
  if (xs.length > 40) fail(400, `At most 40 ${what}`);
  return [...new Set(xs.map((x) => x.slice(0, 200)))];
};
function manageAgent(target, d, actor) {
  if (!standing) fail(404, 'No standing agents on this board');
  const a = standing.get(target); // 404 if unknown
  const name = a.name;
  const keys = Object.keys(d || {});
  const bad = keys.filter((k) => !MANAGE_KEYS.includes(k));
  if (bad.length) fail(403, `${bad.join(', ')} can't be changed through the API — the human edits agents.json for that`, { code: 'NOT_DELEGABLE', hint: `Changeable: ${MANAGE_KEYS.join(', ')}` });
  const agent = actor.kind !== 'user';
  if (agent) {
    const mine = grantsOf(actor.name).filter((g) => g.power === 'agents.manage');
    if (!mine.length) fail(403, 'Only the human can change other agents', { code: 'HUMAN_ONLY', hint: 'The human can delegate this with "grants": ["agents.manage"] in agents.json' });
    if (name.toLowerCase() === actor.name.toLowerCase()) fail(403, 'An agent manager never edits its own record', { code: 'OWN_WORK', hint: 'Ask the human' });
    if (!mine.some((g) => !g.where?.agents || [].concat(g.where.agents).map((x) => String(x).toLowerCase()).includes(name.toLowerCase()))) {
      fail(403, `${name} is outside your agents.manage grant`, { code: 'OUT_OF_SCOPE', hint: 'Leave it for the human' });
    }
  }
  const cfg = {};
  if ('role' in d) {
    if (d.role != null && !require('./lib/agents').ROLES[d.role]) fail(400, `Unknown role "${d.role}". Roles: ${Object.keys(require('./lib/agents').ROLES).join(', ')}`);
    if (agent && (d.role === 'coordinator' || a.role === 'coordinator') && d.role !== a.role) {
      fail(403, 'The coordinator role is the human\'s to give or take', { code: 'HUMAN_ONLY', hint: 'Ask the human on a card' });
    }
    cfg.role = d.role || null;
  }
  if ('description' in d) cfg.description = d.description ? str(d.description, 2000) : null;
  if ('model' in d) {
    const m = d.model == null || d.model === '' ? null : String(d.model);
    if (m && !/^[\w.:-]{1,64}$/.test(m)) fail(400, 'Model: a plain name like haiku, sonnet or opus');
    if (agent && m && !MANAGER_MODELS.includes(m)) fail(400, `An agent manager may only pick ${MANAGER_MODELS.join(', ')}`, { code: 'MODEL_NOT_ALLOWED' });
    if (agent && !m) fail(400, 'Pick a model from the allowlist; clearing it is up to the human', { code: 'MODEL_NOT_ALLOWED' });
    cfg.model = m;
  }
  if ('perms' in d) {
    // null: back to the role's tools (or the default run when it has no role)
    const next = d.perms == null ? null : [...new Set([].concat(d.perms).map(String))];
    const { ROLES } = require('./lib/agents');
    const lib = permLibrary();
    const unknown = (next || []).filter((k) => !lib.holdable(k));
    if (unknown.length) fail(400, `Unknown permission(s): ${unknown.join(', ')}${unknown.some(lib.isPower) ? ' (powers are grants, which only the human sets)' : ''}`);
    const now = a.perms || [];
    const tools = next || ROLES[('role' in cfg ? cfg.role : a.role) || '']?.perms || null;
    // compared after bundles and needs are expanded: a bundle of what it has could still bring something new
    const have = lib.resolve(now).keys;
    if (agent && (tools ? lib.resolve(tools).keys.some((k) => !have.includes(k)) : a.perms != null)) fail(403, `Tool permissions can only narrow: ${name} has ${now.join(', ') || 'none'}`, { code: 'WIDEN' });
    cfg.perms = next;
  } else if (agent && 'role' in cfg && a.permsFrom !== 'own') {
    // its tools come from its role, so a new role is a new set of tools: it may only narrow them
    const tools = require('./lib/agents').ROLES[cfg.role || '']?.perms || null;
    const now = a.perms || [];
    const have = permLibrary().resolve(now).keys;
    if (tools ? tools.some((k) => !have.includes(k)) : a.perms != null) {
      fail(403, `Tool permissions can only narrow: ${name} has ${now.join(', ') || 'none'}, and that role brings ${(tools || []).join(', ') || 'the default run'}`, { code: 'WIDEN', hint: 'Send "perms" with the role to pin its tools to what it has now, or leave it to the human' });
    }
  }
  if ('permissions' in d) {
    const p = d.permissions || {};
    const cur = permsFor(name) || {};
    const lim = { ...(a.limits || {}) };
    if ('columns' in p) {
      const cols = p.columns == null ? null : [].concat(p.columns).map(String);
      if (agent) {
        const low = (xs) => xs.map((x) => x.toLowerCase());
        if (!cols) fail(403, 'Removing a column limit widens access — that is up to the human', { code: 'WIDEN' });
        if (cur.columns && cols.some((c) => !low(cur.columns).includes(c.toLowerCase()))) fail(403, `Board permissions can only narrow: ${name} may change ${cur.columns.join(', ')}`, { code: 'WIDEN' });
        const own = permsFor(actor.name)?.columns;
        if (own && cols.some((c) => !low(own).includes(c.toLowerCase()))) fail(403, `Beyond your own scope (${own.join(', ')})`, { code: 'WIDEN' });
      }
      if (cols) lim.columns = cols; else delete lim.columns;
    }
    if ('readOnly' in p) {
      if (agent && !p.readOnly && cur.readOnly) fail(403, `${name} is read-only; only the human can lift that`, { code: 'WIDEN' });
      if (p.readOnly) lim.readOnly = true; else delete lim.readOnly;
    }
    cfg.limits = Object.keys(lim).length ? lim : null;
  }
  if ('areas' in d) cfg.areas = strList(d.areas, 'areas');
  if ('concerns' in d) cfg.concerns = strList(d.concerns, 'concerns');
  if ('reviewer' in d) cfg.reviewer = d.reviewer ? true : null;
  const by = { kind: actor.kind, name: actor.name };
  const res = Object.keys(cfg).length ? standing.manage(name, cfg, by) : { changes: {} };
  if ('context' in d) {
    const text = d.context == null ? '' : str(d.context, 20_000);
    const before = standing.setContext(name, text);
    const short = (t) => (t ? `${t.trim().split('\n')[0].slice(0, 80)}… (${t.length} chars)` : null);
    if (before !== text) res.changes.context = { from: short(before), to: short(text) };
  }
  // display: label, glyph, colour and personality live on the profile
  const prof = Object.fromEntries(['label', 'glyph', 'color', 'alignment'].filter((k) => k in d).map((k) => [k, d[k]]));
  if ('description' in d) prof.description = d.description;
  if (Object.keys(prof).length) {
    const before = { ...(profiles[name] || {}) };
    updateProfile(name, prof, actor);
    for (const k of Object.keys(prof)) {
      const to = profiles[name]?.[k] ?? null;
      if (JSON.stringify(before[k] ?? null) !== JSON.stringify(to) && !(k === 'description' && res.changes.description)) res.changes[`profile.${k}`] = { from: before[k] ?? null, to };
    }
  }
  if (!Object.keys(res.changes).length) return { agent: standing.get(name), changes: {} };
  emit({ type: 'agent.managed', actor, agent: name, changes: res.changes, ...(agent ? { delegated: { power: 'agents.manage', onBehalfOf: 'human' } } : {}), recipients: [name].filter((n) => n !== actor.name) });
  // delegated changes leave a trail in the digest too
  if (agent && boards.has(M.defaultBoard)) {
    const ctx = boards.get(M.defaultBoard);
    const lines = Object.entries(res.changes).map(([k, v]) => `${k}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`).join('; ');
    tx(ctx, (events) => {
      const entry = { id: rid('d'), date: new Date().toLocaleDateString('en-CA'), ts: now(), author: actor, summary: `Changed **${name}** (agents.manage, on the human's behalf): ${lines}`, items: [] };
      ctx.board.digest.push(entry);
      events.push({ board: ctx.id, type: 'digest.added', actor, entry: { id: entry.id, summary: trimChange(entry.summary) } });
    });
  }
  return { agent: standing.get(name), changes: res.changes };
}
// Project files and folders matching ?q= (git-tracked), for picking an agent's areas.
let fileCache = { at: 0, list: [] };
route('GET', '/api/files', 'Project files and folders matching ?q= (git-tracked; up to 40) — for agent areas', async ({ q }) => {
  if (Date.now() - fileCache.at > 30_000) {
    const files = ((await gitOut(['ls-files'], 5000)) || '').split('\n').filter(Boolean); // empty: not a repo
    const dirs = new Set();
    for (const x of files) { const parts = x.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`); }
    fileCache = { at: Date.now(), list: [...dirs, ...files].sort() };
  }
  const needle = String(q.q || '').toLowerCase();
  const hits = fileCache.list.filter((x) => x.toLowerCase().includes(needle));
  // shortest first: folders and near matches before deep files
  return hits.sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 40);
});
route('GET', '/api/agents/:name/context', "An agent's context page (markdown) and where it lives", ({ p }) => {
  const a = standing.get(p.name);
  return { agent: a.name, file: a.contextFile, text: standing.contextOf(a.name) };
});
route('PATCH', '/api/agents/:name', 'Change a standing agent: { label?, glyph?, color?, alignment?, description?, role?, model?, perms?, permissions?: { columns?, readOnly? } } — the human, or an agent with the agents.manage grant (models from the allowlist, perms/permissions only narrow, never itself)', ({ p, body, actor }) => manageAgent(p.name, body, actor));
route('POST', '/api/agents/stop-all', 'Human (or the agents.control grant): stop every agent now — kill runs, pause standing agents, release agent leases and the master lease, send their In Progress tickets back to Ready with a comment', ({ actor }) => {
  if (actor.kind !== 'user' && !grantsOf(actor.name).some((g) => g.power === 'agents.control')) humanOnly(actor);
  return stopAllAgents(actor);
});
route('POST', '/api/agents/resume-all', 'Human (or the agents.control grant): resume every standing agent', ({ actor }) => {
  if (actor.kind !== 'user' && !grantsOf(actor.name).some((g) => g.power === 'agents.control')) humanOnly(actor);
  return standing ? standing.resumeAll() : { resumed: [] };
});
route('POST', '/api/agents/:name/pause', 'Human: pause (current run finishes; events keep queueing)', ({ p, actor }) => { controls(actor, p.name); return standing.pause(p.name); });
route('POST', '/api/agents/:name/resume', 'Human: resume a paused or failed agent', ({ p, actor }) => { controls(actor, p.name); return standing.unpause(p.name); });
route('POST', '/api/agents/:name/run', 'Human: start a run now: { note? }', ({ p, body, actor }) => { controls(actor, p.name); return standing.runNow(p.name, body.note, actor); });

route('GET', '/api/presence', 'Agents seen by this instance, online state, leases, subscriptions', () => presenceView());
// Forget an offline agent: it leaves the agents list (its profile stays, and it reappears if it calls again).
route('DELETE', '/api/presence/:name', 'Human: forget an offline agent (not standing agents, not while it holds leases)', ({ p, actor }) => {
  if (actor.kind !== 'user') fail(403, 'Only the human can forget agents', { code: 'HUMAN_ONLY' });
  const name = p.name;
  const v = presenceView().find((x) => x.name === name);
  if (!v) fail(404, `No agent "${name}" in the list`);
  if (standing?.list().agents.some((a) => a.name === name)) fail(409, `${name} is a standing agent — remove it with: intellagent agents remove ${name}`, { code: 'STANDING_AGENT' });
  if (v.online) fail(409, `${name} is online right now`, { code: 'ONLINE' });
  if (v.leases.length) fail(409, `${name} still holds ${v.leases.map((l) => l.id).join(', ')} — revoke those leases first`, { code: 'HOLDS_LEASES' });
  presence.delete(name);
  savePresenceSoon();
  emit({ type: 'presence.changed', actor, forgot: name, online: [...presence.values()].filter(isOnline).map((x) => x.name) });
  return { forgot: name };
});
// The tool permissions a standing agent holds, bundles and needs expanded; null for anyone else.
function heldPerms(name) {
  let a;
  try { a = standing?.get(name); } catch { return null; }
  return a?.perms ? permLibrary().resolve(a.perms).keys : null;
}
// May this caller run another agent's code (intellagent sandbox exec, INT-258)? The human, a standing agent
// holding run-authors-code, or an agent outside agents.json whose name a token proves: on a board without
// agent tokens, any run could call itself that.
function mayRunAuthorsCode(actor, perms) {
  if (actor.kind === 'user') return { ok: true };
  if (perms) return perms.includes('run-authors-code') ? { ok: true } : { ok: false, why: 'You don\'t hold "Run an author\'s code" (run-authors-code)', hint: 'Ask the human on the card; the Reviewer role holds it by default' };
  if (M.auth.requireAgentTokens || M.auth.agentTokens?.[actor.name]) return { ok: true };
  return { ok: false, why: 'This board doesn\'t check agent names, so it can\'t tell who you are', hint: 'The human defines you in agents.json with run-authors-code, or turns on agent tokens' };
}
route('GET', '/api/permissions/me', 'What you are allowed to do (from the manifest)', ({ actor }) => {
  const perms = actor.kind === 'agent' ? heldPerms(actor.name) : null;
  const run = mayRunAuthorsCode(actor, perms);
  return {
  name: actor.name, kind: actor.kind, permissions: actor.kind === 'agent' ? permsFor(actor.name) : null,
  perms, runAuthorsCode: run.ok, ...(run.ok ? {} : { runAuthorsCodeWhy: run.why, runAuthorsCodeHint: run.hint }),
  grants: actor.kind === 'agent' ? grantsOf(actor.name).map((g) => ({ ...g, means: POWERS[g.power] })) : null,
  tokenRequired: actor.kind === 'user' ? !!M.auth.userToken : !!M.auth.agentTokens?.[actor.name] || !!M.auth.requireAgentTokens,
  boardHasUserToken: !!M.auth.userToken,
  };
});
route('GET', '/api/profiles', 'Display profiles (colour, glyph, image) for agents and users', () => profiles);
route('GET', '/api/profiles/me', 'Your display profile', ({ actor }) => ({ name: actor.name, ...(profiles[actor.name] || {}) }));
route('PUT', '/api/profiles/me/status', 'Agents: a live status line while you hold no lease (triage, reviewing, answering a request): { status ("" clears), items? }. Emits agent.activity, which wakes nobody; cleared when your run ends',
  ({ body, actor }) => setActivity(actor, body));
// A friendly generated name for agents that don't want to pick one ("leave blank").
const NAME_ADJ = ['brisk', 'cosmic', 'dapper', 'fuzzy', 'gentle', 'jolly', 'lucky', 'mellow', 'nimble', 'plucky', 'quirky', 'sunny', 'tidy', 'witty', 'zesty', 'breezy', 'cheeky', 'daring', 'humble', 'snappy'];
const NAME_NOUN = ['otter', 'heron', 'badger', 'lemur', 'puffin', 'gecko', 'walrus', 'panda', 'falcon', 'quokka', 'narwhal', 'koala', 'marmot', 'pangolin', 'axolotl', 'capybara', 'wombat', 'ibis', 'tapir', 'yak'];
function sillyName() {
  const taken = new Set([...presence.keys(), ...Object.keys(profiles)]);
  for (let i = 0; i < 50; i++) {
    const n = `${NAME_ADJ[crypto.randomInt(NAME_ADJ.length)]}-${NAME_NOUN[crypto.randomInt(NAME_NOUN.length)]}`;
    if (!taken.has(n)) return n;
  }
  return `agent-${crypto.randomBytes(2).toString('hex')}`;
}
route('GET', '/api/names/suggest', 'A free, friendly agent name (e.g. "plucky-otter")', () => ({ name: sillyName() }));

route('PATCH', '/api/profiles/me', 'Set your profile: { color?, glyph? (1–2 chars/emoji), label?, description? (markdown: what you were designed to do), role?, alignment? (how you behave), image? (https URL) | imageBase64 | imagePath } — null clears',
  ({ body, actor }) => updateProfile(actor.name, body, actor));

route('GET', '/avatars/:file', null, ({ res, p }) => {
  const name = path.basename(decodeURIComponent(p.file));
  const ext = path.extname(name).slice(1).toLowerCase();
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('Cache-Control', 'max-age=31536000, immutable');
  return serveFile(res, path.join(AVATAR_DIR, name), MIME[ext] || 'application/octet-stream');
});

route('GET', '/files/:board/:file', null, ({ res, p }) => {
  const ctx = getCtx(p.board);
  const name = path.basename(decodeURIComponent(p.file));
  const ext = path.extname(name).slice(1).toLowerCase();
  res.setHeader('Content-Security-Policy', 'sandbox');
  return serveFile(res, path.join(ctx.attachDir, name), MIME[ext] || 'application/octet-stream');
});

const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.css': 'app.css', '/app.js': 'app.js', '/favicon.svg': 'favicon.svg' };
const STATIC_TYPES = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml' };
// index.html gets cache-busting stamps (file mtimes) so edited assets are never served stale.
const stamp = (f) => Math.round(fs.statSync(path.join(PUBLIC, f)).mtimeMs).toString(36);
for (const [urlPath, file] of Object.entries(STATIC)) {
  route('GET', urlPath, null, ({ res }) => {
    if (file !== 'index.html') return serveFile(res, path.join(PUBLIC, file), STATIC_TYPES[file.split('.').pop()]);
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8')
      .replace('/app.css"', `/app.css?v=${stamp('app.css')}"`)
      .replace('/app.js"', `/app.js?v=${stamp('app.js')}"`)
      .replace('<head>', `<head>\n<meta name="intellagent-build" content="${VERSION}+${BUILD}">`);
    reply(res, 200, html, { 'Content-Type': STATIC_TYPES.html });
    return HANDLED;
  });
}

/* ───────────────────────── server ───────────────────────── */

/* Idempotency-Key: a retried write (same caller, same key) gets the first reply back instead of acting
   twice. Kept 24h, persisted so it survives restarts. */
const IDEM_FILE = path.join(DATA, 'idempotency.json');
const IDEM_TTL = 24 * 3600_000;
const idem = new Map(Object.entries(readJson(IDEM_FILE, {})).filter(([, v]) => Date.now() - v.at < IDEM_TTL));
let idemTimer = null;
function rememberIdem(key, status, body) {
  idem.set(key, { status, body, at: Date.now() });
  if (idem.size > 3000) idem.delete(idem.keys().next().value);
  clearTimeout(idemTimer);
  idemTimer = setTimeout(() => { try { fs.writeFileSync(IDEM_FILE, JSON.stringify(Object.fromEntries(idem))); } catch { /* best effort */ } }, 500);
}

// The Host names this board answers to (DNS rebinding: lib/local-only.js). "allowedHosts" in the manifest adds
// names for a proxy or tunnel in front of it.
const HOSTS = allowedHosts(M.port, { host: M.host, extra: M.allowedHosts || [] });

const server = http.createServer(async (req, res) => {
  try {
    const badHost = hostProblem(req, HOSTS, `http://127.0.0.1:${M.port}`);
    if (badHost) fail(badHost.status, badHost.error, { code: badHost.code, hint: `${badHost.hint}, or add the name to "allowedHosts" in ${MANIFEST_PATH}` });
    const u = new URL(req.url, 'http://localhost');
    // Block other web pages from driving the API through the browser (CSRF); agents and curl send no Origin.
    // A browser's writes must also say they are JSON: the UI always does, and a cross-site form cannot.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) fail(403, 'Cross-origin requests are not allowed');
    const notJson = origin && jsonProblem(req);
    if (notJson) fail(notJson.status, notJson.error, { code: notJson.code, hint: notJson.hint });
    let m = null;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const hit = r.re.exec(u.pathname);
      if (hit) { m = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(hit[i + 1])])) }; break; }
    }
    if (!m) fail(404, `No route for ${req.method} ${u.pathname}`, { code: 'NOT_FOUND', hint: 'Routes: GET /api. From the CLI, call operations by name instead: intellagent help <word> (e.g. intellagent help search), then intellagent do <operation> key=value' });
    const q = Object.fromEntries(u.searchParams);
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
    const actor = actorOf(req, q);
    checkAuth(req, q, actor, u.pathname);
    const bm = /^\/api\/boards\/([^/]+)(?:\/(.*))?$/.exec(u.pathname);
    const gctx = bm && (boards.get(bm[1]) || boards.get(slug(decodeURIComponent(bm[1]))));
    if (req.method !== 'GET' && gctx && !/(^|\/)(comments|attention|digest|master|finish|reactions|requests|request|decline)(\/|$)/.test(bm[2] || '')) {
      guardBoard(gctx, actor);
    }
    if (actor.kind === 'agent' && u.pathname.startsWith('/api')) touch(actor.name, `${req.method} ${u.pathname}`);
    const ik = req.method !== 'GET' && req.headers['idempotency-key'] ? `${actor.kind}:${actor.name}:${req.method}:${u.pathname}:${str(req.headers['idempotency-key'], 200)}` : null;
    if (ik && idem.has(ik) && Date.now() - idem.get(ik).at < IDEM_TTL) {
      const hit = idem.get(ik);
      reply(res, hit.status, hit.body, { 'Idempotent-Replayed': 'true' });
      return;
    }
    const out = await m.r.handler({ req, res, p: m.params, q, body, actor });
    if (out === HANDLED || res.headersSent) return;
    const [st, payload] = out instanceof Reply ? [out.status, out.body] : [200, out ?? {}];
    if (ik) rememberIdem(ik, st, payload);
    reply(res, st, payload);
  } catch (e) {
    if (res.headersSent) { res.end(); return; }
    const status = e.status || 500;
    if (status === 500) console.error(e);
    reply(res, status, { error: e.message, code: e.code || (status === 500 ? 'INTERNAL' : 'ERROR'), status, ...(e.extra || {}) });
  }
});

/* ───────────────────────── boot ───────────────────────── */

function seed() {
  if (M.seed === 'empty') {
    createBoard({ id: M.defaultBoard, name: M.boardName || 'Main', idPrefix: M.idPrefix || 'INT', template: M.template || 'default' }, SYSTEM);
    return;
  }
  const ctx = createBoard({
    id: M.defaultBoard, name: M.boardName || 'Main', idPrefix: M.idPrefix || 'INT',
    directives: '- Keep changes small and reviewable\n- Raise **needs you** before changing public APIs\n- Comment when you pick something up',
    schema: { fields: [
      { key: 'estimate', label: 'Estimate', type: 'number', icon: 'clock', stub: 'meta', min: 0, help: 'Hours' },
      { key: 'risk', label: 'Risk', type: 'enum', stub: 'top', options: [{ value: 'low', color: '#4cc38a' }, { value: 'medium', color: '#f2a541' }, { value: 'high', color: '#ff5d73' }] },
      { key: 'pr', label: 'Pull request', type: 'url', icon: 'link' },
      { key: 'reviewed', label: 'Reviewed', type: 'boolean', icon: 'check', stub: 'meta', ui: 'read' },
    ] },
  }, SYSTEM);
  const agent = { kind: 'agent', name: 'claude-builder' };
  const user = { kind: 'user', name: 'You' };
  const a = createItem(ctx, { title: 'Wire up the auth flow', type: 'task', priority: 'High', parent: 'auth', column: 'Ready',
    description: '## Goal\nLogin → session → refresh.\n\n- [x] Login form\n- [ ] Session cookie\n- [ ] Refresh endpoint' }, agent);
  createItem(ctx, { title: 'Token refresh race on tab wake', type: 'issue', priority: 'Critical', parent: 'auth', column: 'Ready',
    description: 'Two tabs refresh simultaneously and one gets `401`.', needsHuman: 'Should refresh tokens rotate on every use, or only on expiry?' }, agent);
  createItem(ctx, { title: 'SQLite vs flat JSON for drafts', type: 'spike', parent: 'storage',
    properties: { timebox: '2h' }, fields: { risk: 'low', estimate: 2 }, description: 'Compare write amplification and crash safety.' }, agent);
  createItem(ctx, { title: 'Onboarding notes for new agents', type: 'task', priority: 'Low' }, user);
  updateItem(ctx, a.id, { column: 'In Progress' }, agent);
  claimLease(ctx, a.id, { minutes: 45, status: 'Writing the session cookie middleware' }, agent);
}

for (const d of fs.readdirSync(BOARDS_DIR)) {
  if (!fs.existsSync(path.join(BOARDS_DIR, d, 'board.json'))) continue;
  try { loadBoard(d); } catch (e) { console.warn(`Skipping board "${d}": ${e.message}`); }
}
if (!boards.size) seed();
checkPresence();
// A sandbox has no worktrees: its projectRoot is a real checkout, and landing there would put commits on
// main that James never approved on the real board (INT-80).
if (!M.sandbox) worktrees = require('./lib/worktrees').createWorktrees({
  root: PROJECT_ROOT,
  mainBranch: typeof M.mainBranch === 'string' && /^[\w./-]{1,100}$/.test(M.mainBranch) && !M.mainBranch.startsWith('-') ? M.mainBranch : null,
  // .intellagent/worktrees in a project; .worktrees beside a manifest at the repo root (git-ignored either way)
  dir: path.basename(path.dirname(MANIFEST_PATH)) === '.intellagent' || M.projectRoot ? path.join(path.dirname(MANIFEST_PATH), 'worktrees') : path.join(PROJECT_ROOT, '.worktrees'),
});
standing = require('./lib/agents').createAgents({
  worktrees,
  file: path.join(path.dirname(MANIFEST_PATH), M.agentsFile || 'agents.json'),
  stateFile: path.join(DATA, 'agents.state.json'),
  logDir: path.join(DATA, 'agent-runs'),
  cwd: PROJECT_ROOT,
  protect: [LOCAL_PATH], // beside the manifest, which agents.json may not be
  noRuns: !!M.sandbox,
  env: { INTELLAGENT_MANIFEST: MANIFEST_PATH, INTELLAGENT_URL: `http://${M.host === '0.0.0.0' ? '127.0.0.1' : M.host}:${M.port}` },
  emit, matchesFilter, parseFilter, recent: () => recent, seq: () => seq,
  pending: (name, def) => pendingWork(name, def.pickup === true ? 'ready' : def.pickup || false),
  waiting: () => waitingWork(),
  lastSeen: (name) => presence.get(name)?.lastSeen || null, // a running agent's last call to the board (stalled runs)
  activityOf,
  // a run's leaseless status line ends with it
  onRunOver: (name) => { const a = activity.get(name); if (a?.line) { a.line = null; a.items = []; sendActivity(name); } },
  // A run starting means the agent has the comments in front of it: mark them seen with 👀.
  onRunStart: (name, events) => {
    for (const e of events) {
      if (e.type !== 'comment.added' || !e.comment?.id || !boards.has(e.board)) continue;
      const ctx = boards.get(e.board);
      const me = { kind: 'agent', name };
      try { react(ctx, e.itemId, { emoji: '⏳', commentId: e.comment.id }, me, false); } catch { /* comment gone */ }
      try { react(ctx, e.itemId, { emoji: '👀', commentId: e.comment.id }, me); } catch { /* comment gone */ }
    }
  },
  // A comment for an agent that can't run yet (settling, throttled or busy): ⏳ now, 👀 when its run starts.
  // Later the note follows the agent (paused, failed, back again: when.refresh, only where a ⏳ still shows),
  // and when.gone takes the ⏳ off (the agent was removed, or the queue cap dropped the event).
  onQueued: (name, events, when) => {
    const note = when.gone ? null
      : when.paused ? 'queued — its agent is paused; runs once it is resumed'
        : when.failed ? 'queued — its agent failed; runs once the human resumes it'
          : when.busy ? 'queued — runs after its current run'
            : `queued — runs about ${new Date(when.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const me = { kind: 'agent', name };
    for (const e of events) {
      if (e.type !== 'comment.added' || !e.comment?.id || !boards.has(e.board)) continue;
      const ctx = boards.get(e.board);
      try {
        if (when.refresh && !ctx.board.items[e.itemId]?.comments?.find((c) => c.id === e.comment.id)?.reactions?.['⏳']?.includes(name)) continue;
        react(ctx, e.itemId, { emoji: '⏳', commentId: e.comment.id, note }, me, !when.gone);
      } catch { /* comment gone */ }
    }
  },
  onAgentsChanged: (names) => { for (const n of names) issueAgentToken(n); },
  // the run's own token (INTELLAGENT_TOKEN), read fresh so a rotated one reaches the next run; never the user token
  tokenOf: (name) => readLocalAgentTokens()[name] || M.auth.agentTokens?.[name] || null,
  onRunEnd: (name) => {
    for (const ctx of boards.values()) {
      if (Object.values(ctx.board.items).some((it) => activeLease(it)?.claimant === name)) finishSession(ctx, {}, { kind: 'agent', name });
    }
  },
});

try { for (const a of standing.list().agents) issueAgentToken(a.name); } catch (e) { console.warn(`agent tokens: ${e.message}`); }

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${M.port} is in use. Set "port" in ${MANIFEST_PATH} or INTELLAGENT_PORT.`);
  else console.error(e);
  process.exit(1);
});

server.listen(M.port, M.host, () => {
  const base = `http://${M.host}:${M.port}`;
  console.log(`\n  ${app.name}  v${VERSION} (${BUILD})`);
  console.log(`  board   ${base}`);
  console.log(`  agents  ${base}/api/docs`);
  console.log(`  data    ${DATA}\n`);
  try { fs.writeFileSync(path.join(DATA, 'server.pid'), String(process.pid)); } catch { /* read-only data dir */ }
});

const shutdown = () => {
  try { fs.rmSync(path.join(DATA, 'server.pid')); } catch { /* gone */ }
  standing?.stop();
  writeFileAtomic(PRESENCE_FILE, JSON.stringify({ updatedAt: now(), agents: Object.fromEntries(presence) }, null, 2));
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
