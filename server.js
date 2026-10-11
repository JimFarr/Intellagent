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

const VERSION = '1.0.0';
const BUILD = '2026.10.11-1';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

/* ───────────────────────── manifest ───────────────────────── */

const MANIFEST_PATH = path.resolve(process.env.INTELLAGENT_MANIFEST || path.join(ROOT, 'intellagent.manifest.json'));
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
};

function loadManifest() {
  let m = {};
  if (fs.existsSync(MANIFEST_PATH)) m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  else fs.writeFileSync(MANIFEST_PATH, JSON.stringify(MANIFEST_DEFAULTS, null, 2));
  const merged = {
    ...MANIFEST_DEFAULTS, ...m,
    lease: { ...MANIFEST_DEFAULTS.lease, ...(m.lease || {}) },
    auth: { ...MANIFEST_DEFAULTS.auth, ...(m.auth || {}) },
    permissions: m.permissions || {},
  };
  if (process.env.INTELLAGENT_PORT) merged.port = Number(process.env.INTELLAGENT_PORT);
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

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
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
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
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
};
const TEMPLATES = {
  default: [
    { name: 'Backlog', icon: 'inbox', color: '#8b8fa3', flags: { allowCreate: true } },
    { name: 'Ready', icon: 'target', color: '#5aa9e6', flags: { allowCreate: true } },
    { name: 'In Progress', icon: 'play', color: '#f2a541' },
    { name: 'Review', icon: 'eye', color: '#b07cf2', flags: { review: true } },
    { name: 'Done', icon: 'check', color: '#4cc38a', flags: { releaseLeaseOnEnter: true, humanOnlyIn: true } },
  ],
  simple: [
    { name: 'To Do', icon: 'inbox', color: '#5aa9e6', flags: { allowCreate: true } },
    { name: 'Doing', icon: 'play', color: '#f2a541' },
    { name: 'Done', icon: 'check', color: '#4cc38a', flags: { releaseLeaseOnEnter: true } },
  ],
  empty: [],
};

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

function coerceField(def, v) {
  if (v === null || v === undefined || v === '') return null;
  const bad = (want) => fail(400, `Field "${def.key}" expects ${want}, got ${JSON.stringify(v)}`);
  switch (def.type) {
    case 'text': case 'user':
      return typeof v === 'string' || typeof v === 'number' ? str(v, def.type === 'user' ? 64 : 2000) : bad('a string');
    case 'markdown':
      return typeof v === 'string' ? str(v, 100_000) : bad('a markdown string');
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) bad('a number');
      if (def.min != null && n < def.min) fail(400, `Field "${def.key}" must be >= ${def.min}`);
      if (def.max != null && n > def.max) fail(400, `Field "${def.key}" must be <= ${def.max}`);
      return n;
    }
    case 'boolean':
      if (v === true || v === 'true') return true;
      if (v === false || v === 'false') return false;
      return bad('true or false');
    case 'enum': {
      const o = def.options.find((x) => x.value.toLowerCase() === String(v).toLowerCase());
      if (!o) fail(400, `Field "${def.key}" expects one of: ${def.options.map((x) => x.value).join(', ')}`);
      return o.value;
    }
    case 'tags': {
      let list = arr(v).map((x) => str(x, 60).trim()).filter(Boolean);
      if (def.options?.length) {
        list = list.map((t) => {
          const o = def.options.find((x) => x.value.toLowerCase() === t.toLowerCase());
          if (!o) fail(400, `Field "${def.key}" tags must be from: ${def.options.map((x) => x.value).join(', ')}`);
          return o.value;
        });
      }
      return list.length ? [...new Set(list)] : null;
    }
    case 'date':
      return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v.slice(0, 40) : bad('an ISO date like 2026-10-12');
    case 'url':
      return typeof v === 'string' && /^https?:\/\//i.test(v) ? str(v, 2000) : bad('an http(s) URL');
    default:
      return bad('a known type');
  }
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
const saveApp = () => writeFileAtomic(APP_FILE, JSON.stringify(app, null, 2));
if (!fs.existsSync(APP_FILE)) saveApp();

const appInfo = () => ({
  name: app.name, version: VERSION, build: BUILD, defaultBoard: M.defaultBoard,
  lease: M.lease, serverTime: now(), seq,
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
  b.schema = { builtins: normBuiltins(b.schema?.builtins, true), fields: Array.isArray(b.schema?.fields) ? b.schema.fields : [] };
  for (const it of Object.values(b.items)) { it.fields = isObj(it.fields) ? it.fields : {}; it.cover = it.cover || 'auto'; it.assignee = it.assignee || null; }
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
  return b;
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

function persist(ctx) {
  ctx.board.updatedAt = now();
  const text = JSON.stringify(ctx.board, null, 2);
  maybeBackup(ctx);
  writeFileAtomic(ctx.file, text);
  ctx.hash = sha256(text);
  writeHash(ctx);
}

function persistArchive(ctx) { writeFileAtomic(ctx.archiveFile, JSON.stringify(ctx.archive, null, 2)); }

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
    directives: str(d.directives || '', 50_000),
    schema: { builtins: normBuiltins(d.schema?.builtins), fields: [] },
    digest: [],
    columns: [],
    items: {},
  };
  for (const f of arr(d.schema?.fields)) {
    const def = normField(f);
    if (board.schema.fields.some((x) => x.key === def.key)) fail(400, `Duplicate field "${def.key}"`);
    board.schema.fields.push(def);
  }
  const cols = Array.isArray(d.columns) ? d.columns : TEMPLATES[d.template || 'default'];
  if (!cols) fail(400, `Unknown template "${d.template}". Use: ${Object.keys(TEMPLATES).join(', ')}`);
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
function tx(ctx, fn) {
  const before = JSON.stringify(ctx.board);
  const beforeArchive = JSON.stringify(ctx.archive);
  const events = [];
  let result;
  try {
    result = fn(events);
  } catch (e) {
    ctx.board = JSON.parse(before);
    ctx.archive = JSON.parse(beforeArchive);
    throw e;
  }
  if (JSON.stringify(ctx.board) !== before) persist(ctx);
  if (JSON.stringify(ctx.archive) !== beforeArchive) persistArchive(ctx);
  events.forEach(emit);
  return result;
}

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

// Who this event is "addressed to": leaseholder, whoever asked for help, agent author, @mentions — minus the actor.
function recipientsFor(item, actor, extra = []) {
  const s = new Set(extra);
  const l = activeLease(item);
  if (l) s.add(l.claimant);
  if (item.needsHuman) s.add(item.needsHuman.raisedBy);
  if (item.author?.kind === 'agent') s.add(item.author.name);
  if (item.assignee) s.add(item.assignee);
  for (const c of item.comments || []) if (c.author?.name) s.add(c.author.name); // thread participants
  s.delete(actor.name);
  return [...s];
}

function itemEvent(ctx, type, item, actor, extra = {}) {
  const { mentions = [], ...rest } = extra;
  return {
    board: ctx.id, type, actor, itemId: item.id, columnId: item.columnId,
    item: snapshot(ctx, item), recipients: recipientsFor(item, actor, mentions),
    ...(mentions.length ? { mentions } : {}), ...rest,
  };
}

const permsFor = (name) => M.permissions[name] || M.permissions['*'] || null;

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

function guardWrite(ctx, item, actor) {
  checkColumnPerm(ctx, actor, [item.columnId]);
  const l = activeLease(item);
  if (l && actor.kind === 'agent' && l.claimant !== actor.name) {
    fail(423, `${item.id} is leased by ${l.claimant} until ${l.expiresAt}`, { lease: l });
  }
}

function checkWip(col) {
  if (col.flags.wipLimit > 0 && col.itemIds.length >= col.flags.wipLimit) fail(409, `"${col.name}" is at its WIP limit (${col.flags.wipLimit})`);
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
    events.push(itemEvent(ctx, 'item.unblocked', it, actor, { resolvedBy: resolvedId, mentions: [it.assignee, activeLease(it)?.claimant].filter(Boolean) }));
  }
}

const positionOf = (d) => (d.beforeId ? { before: String(d.beforeId).toUpperCase() } : d.afterId ? { after: String(d.afterId).toUpperCase() } : d.position);

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain', md: 'text/markdown', json: 'application/json',
  csv: 'text/csv', zip: 'application/zip', mp4: 'video/mp4', webm: 'video/webm',
};
const MAX_ATTACHMENT = 15 * 1024 * 1024;

function saveAttachment(ctx, item, a, actor) {
  if (!isObj(a)) fail(400, 'Attachment must be an object');
  if (a.url && !a.dataBase64 && !a.data && !a.path) {
    return { id: rid('a'), kind: 'link', name: str(a.name || a.url, 120), url: str(a.url, 2000), addedAt: now(), author: actor };
  }
  let buf;
  let name = a.name;
  if (a.dataBase64 || a.data) buf = Buffer.from(String(a.dataBase64 || a.data).replace(/^data:[^,]*,/, ''), 'base64');
  else if (a.path) {
    const p = path.resolve(String(a.path));
    if (!fs.existsSync(p)) fail(400, `File not found: ${p} (use an absolute path)`);
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
  return { reason: str(reason || 'Needs input', 2000), raisedBy: actor.name, raisedAt: now(), kind };
}

// Review column: one flagged `review`, else the column just before the first human-only gate.
function reviewColumn(ctx) {
  const cols = ctx.board.columns;
  const flagged = cols.find((c) => c.flags.review);
  if (flagged) return flagged;
  const gate = cols.findIndex((c) => c.flags.humanOnlyIn);
  return gate > 0 ? cols[gate - 1] : null;
}

function requestReview(ctx, id, d, actor) {
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    const col = d.column ? findColumn(ctx.board, d.column) : reviewColumn(ctx);
    if (!col) fail(400, 'No review column. Flag one with { "flags": { "review": true } } or pass "column".');
    guardWrite(ctx, item, actor);
    if (item.columnId !== col.id) moveInto(ctx, item, col.id, 'top', actor, events);
    const summary = str(d.summary || '', 20_000).trim();
    if (summary) item.comments.push({ id: rid('c'), author: actor, body: summary, createdAt: now() });
    const lease = item.lease;
    if (lease && lease.claimant === actor.name) item.lease = null;
    item.needsHuman = { reason: str(d.reason || (summary ? summary.split('\n')[0].slice(0, 200) : 'Ready for review'), 2000), raisedBy: actor.name, raisedAt: now(), kind: 'review' };
    item.version++;
    item.updatedAt = now();
    if (lease && !item.lease) events.push(itemEvent(ctx, 'lease.released', item, actor, { claimant: lease.claimant, reason: 'review requested' }));
    events.push(itemEvent(ctx, 'review.requested', item, actor, { summary: trimChange(summary) || null, reason: item.needsHuman.reason }));
    events.push(itemEvent(ctx, 'attention.raised', item, actor, { reason: item.needsHuman.reason, kind: 'review' }));
    return item;
  });
}

function createItem(ctx, d, actor) {
  return tx(ctx, (events) => {
    const b = ctx.board;
    const ref = d.columnId ?? d.column;
    const col = ref != null ? findColumn(b, ref) : b.columns.find((c) => c.flags.allowCreate);
    if (!col) fail(400, 'No column on this board allows item creation');
    if (actor.kind !== 'user' && col.flags.humanOnlyIn) fail(403, `Only a human can add items to "${col.name}"`);
    checkColumnPerm(ctx, actor, [col.id]);
    if (!col.flags.allowCreate) fail(403, `Column "${col.name}" does not allow item creation. Allowed: ${b.columns.filter((c) => c.flags.allowCreate).map((c) => c.name).join(', ') || '(none)'}`);
    checkWip(col);
    if (!String(d.title || '').trim()) fail(400, '"title" is required');
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
      needsHuman: parseNeedsHuman(d.needsHuman, actor),
      blockedBy: arr(d.blockedBy).map((x) => String(x).toUpperCase()).filter((x) => b.items[x] || ctx.archive.items[x]),
      properties: isObj(d.properties) ? d.properties : {},
      fields: {},
      cover: 'auto',
      attachments: [],
      comments: [],
    };
    applyFields(ctx, item, d.fields, actor, null, true);
    b.items[id] = item;
    col.itemIds.splice(resolveIndex(col.itemIds, positionOf(d)), 0, id);
    for (const a of arr(d.attachments)) item.attachments.push(saveAttachment(ctx, item, a, actor));
    events.push(itemEvent(ctx, 'item.created', item, actor));
    if (item.needsHuman) events.push(itemEvent(ctx, 'attention.raised', item, actor, { reason: item.needsHuman.reason }));
    return item;
  });
}

function moveInto(ctx, item, colRef, position, actor, events) {
  const b = ctx.board;
  const from = findColumn(b, item.columnId);
  const to = colRef != null && colRef !== '' ? findColumn(b, colRef) : from;
  const cross = from.id !== to.id;
  if (cross) {
    if (!from.flags.allowMoveOut) fail(403, `Items cannot leave "${from.name}"`);
    if (!to.flags.allowMoveIn) fail(403, `"${to.name}" does not accept moved items`);
    if (actor.kind !== 'user' && to.flags.humanOnlyIn) fail(403, `Only a human can move items into "${to.name}". Move it to the column before and ask for review.`);
    if (actor.kind !== 'user' && from.flags.humanOnlyOut) fail(403, `Only a human can move items out of "${from.name}"`);
    checkColumnPerm(ctx, actor, [to.id]);
    checkWip(to);
  }
  const oldIdx = from.itemIds.indexOf(item.id);
  from.itemIds.splice(oldIdx, 1);
  const idx = resolveIndex(to.itemIds, position);
  to.itemIds.splice(idx, 0, item.id);
  if (cross) {
    item.columnId = to.id;
    item.enteredColumnAt = now();
    events.push(itemEvent(ctx, 'item.moved', item, actor, { fromColumnId: from.id, columnId: to.id, position: idx }));
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

const PATCHABLE = ['title', 'description', 'type', 'priority', 'parent', 'blockedBy', 'needsHuman', 'properties', 'replaceProperties', 'fields', 'cover', 'assignee',
  'columnId', 'column', 'position', 'beforeId', 'afterId', 'version'];

function trimChange(v) { return typeof v === 'string' && v.length > 400 ? `${v.slice(0, 400)}…` : v; }

function applyPatch(ctx, item, p, actor, events) {
  const unknown = Object.keys(p).filter((k) => !PATCHABLE.includes(k));
  if (unknown.length) fail(400, `Unknown field(s): ${unknown.join(', ')}. Patchable: ${PATCHABLE.join(', ')}. Put custom data in "properties". Leases use /lease, comments use /comments.`);
  guardWrite(ctx, item, actor);
  if (actor.kind === 'user') {
    const bi = ctx.board.schema.builtins;
    for (const k of ['type', 'priority', 'parent', 'description', 'blockedBy', 'properties', 'cover', 'assignee']) {
      if (k in p && bi[k].ui !== 'edit') fail(403, `"${bi[k].label}" is read-only in the UI`);
    }
  }
  if (p.version != null && Number(p.version) !== item.version) fail(409, `Version conflict: ${item.id} is at version ${item.version}. Re-read and retry.`, { item });

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
    if (!!prev !== !!next || (prev && next && prev.reason !== next.reason)) {
      item.needsHuman = next;
      changes.needsHuman = { from: prev?.reason ?? null, to: next?.reason ?? null };
      events.push(next
        ? itemEvent(ctx, 'attention.raised', item, actor, { reason: next.reason })
        : itemEvent(ctx, 'attention.resolved', item, actor, { raisedBy: prev.raisedBy, mentions: [prev.raisedBy] }));
    }
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
      events.push(itemEvent(ctx, 'item.assigned', item, actor, { assignee: next, from: prev, mentions: [next, prev].filter(Boolean) }));
    }
  }
  if ('cover' in p) {
    const v = p.cover ?? 'none';
    if (v !== 'auto' && v !== 'none' && !item.attachments.some((a) => a.id === v && /^image\//.test(a.mime || ''))) {
      fail(400, '"cover" must be "auto", "none", or the id of an image attachment on this item');
    }
    set('cover', v);
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

function addComment(ctx, id, d, actor) {
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    const atts = arr(d.attachments).map((a) => saveAttachment(ctx, item, a, actor));
    if (!String(d.body || '').trim() && !atts.length) fail(400, '"body" or "attachments" is required');
    const c = { id: rid('c'), author: actor, body: str(d.body, 20_000), createdAt: now(), ...(atts.length ? { attachments: atts } : {}) };
    item.comments.push(c);
    item.version++;
    item.updatedAt = c.createdAt;
    const mentions = [...c.body.matchAll(/(?:^|\s)@([\w.-]+)/g)].map((m) => m[1]);
    events.push(itemEvent(ctx, 'comment.added', item, actor, { comment: { id: c.id, body: trimChange(c.body), attachments: atts.length }, mentions }));
    return c;
  });
}

function claimLease(ctx, id, d, actor) {
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    checkColumnPerm(ctx, actor, [item.columnId]);
    const claimant = str(d.claimant || actor.name, 64);
    const minutes = clamp(Number(d.minutes) || M.lease.defaultMinutes, 1, M.lease.maxMinutes);
    const cur = activeLease(item);
    if (cur && cur.claimant !== claimant && !(d.force && actor.kind === 'user')) {
      fail(409, `${item.id} is already leased by ${cur.claimant} until ${cur.expiresAt}`, { lease: cur });
    }
    const renew = !!cur && cur.claimant === claimant;
    const t = Date.now();
    item.lease = {
      claimant,
      leasedAt: renew ? cur.leasedAt : new Date(t).toISOString(),
      expiresAt: new Date(t + minutes * 60_000).toISOString(),
      minutes,
      renewals: renew ? (cur.renewals || 0) + 1 : 0,
      ...(renew && cur.status ? { status: cur.status, statusAt: cur.statusAt } : {}),
      ...(d.status ? { status: str(d.status, 140), statusAt: now() } : {}),
    };
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

function resolveAttention(ctx, id, d, actor) {
  return tx(ctx, (events) => {
    const item = getItem(ctx, id);
    const prev = item.needsHuman;
    if (!prev) return item;
    let reply = null;
    if (String(d.reply || '').trim()) {
      reply = { id: rid('c'), author: actor, body: str(d.reply, 20_000), createdAt: now() };
      item.comments.push(reply);
    }
    item.needsHuman = null;
    item.version++;
    item.updatedAt = now();
    events.push(itemEvent(ctx, 'attention.resolved', item, actor, { raisedBy: prev.raisedBy, reason: prev.reason, reply: reply?.body ?? null, mentions: [prev.raisedBy] }));
    return item;
  });
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
      events.push(itemEvent(ctx, 'item.archived', rec, actor, { reason }));
      emitUnblocked(ctx, id, actor, events);
      done.push(id);
    }
    return done;
  });
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
    item.columnId = col.id;
    item.enteredColumnAt = now();
    item.version++;
    item.updatedAt = now();
    b.items[key] = item;
    col.itemIds.unshift(key);
    delete ctx.archive.items[key];
    events.push(itemEvent(ctx, 'item.restored', item, actor, { archivedAt }));
    return item;
  });
}

function itemView(ctx, item, archived = false) {
  const col = ctx.board.columns.find((c) => c.id === (archived ? item.archivedFrom : item.columnId));
  const blocks = Object.values(ctx.board.items).filter((x) => x.blockedBy?.includes(item.id)).map((x) => x.id);
  return { ...item, board: ctx.id, column: col?.name ?? null, lease: activeLease(item), blocks, archived };
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
    for (const [item, archived] of pools.flat()) {
      const v = {
        ...itemView(ctx, item, archived),
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
  if (fs.statSync(EVENTS_FILE).size > 20 * 1024 * 1024) {
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
    itemType: src.itemType || undefined,
    parent: src.parent || undefined,
    fields: list(src.fields ?? src.field),
    actorKind: src.actorKind || undefined,
    excludeActor: src.excludeActor || undefined,
    assignee: src.assignee || undefined,
    actor: src.actor || undefined,
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
  if (filter.excludeActor && same(event.actor?.name, filter.excludeActor)) return false;
  return true;
}

const sseClients = new Set();
const waiters = new Set();

function emit(ev) {
  const e = { seq: ++seq, ts: now(), ...ev };
  if (e.board && boards.has(e.board)) e.hash = boards.get(e.board).hash;
  fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(e)}\n`);
  recent.push(e);
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
  for (const c of sseClients) if (matchesFilter(e, c.filter)) sseSend(c.res, e);
  for (const w of [...waiters]) if (matchesFilter(e, w.filter)) w.check();
  return e;
}

function sseSend(res, e) { res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`); }

function longPoll(res, { filter, since, timeout, limit = 100, agent, onDeliver, tail = false }) {
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

function openStream(req, res, filter, agent) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  const lastId = Number(req.headers['last-event-id']) || 0;
  if (lastId) for (const e of recent) if (e.seq > lastId && matchesFilter(e, filter)) sseSend(res, e);
  res.write(`data: ${JSON.stringify({ type: 'hello', seq, app: app.name, version: VERSION, build: BUILD })}\n\n`);
  const c = { res, filter, agent };
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
        const fp = path.resolve(String(d.imagePath));
        if (!fs.existsSync(fp)) fail(400, `File not found: ${fp}`);
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

setInterval(() => {
  for (const ctx of boards.values()) {
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
    needsHuman: '{ reason, raisedBy, raisedAt, kind: question|review } | null — set to ask the human for input',
    blockedBy: 'itemId[]', blocks: 'itemId[] (computed)', properties: 'object — free-form property bag (undeclared data)',
    fields: 'object — values for the board custom fields declared in GET /api/boards/:board/schema; validated by type',
    cover: '"auto" (first image) | "none" | attachment id — the image shown on the card',
    attachments: '{ id, kind: "file"|"link", name, mime, size, url, addedAt, author }[]',
    comments: '{ id, author, body (markdown), createdAt, attachments? }[]', version: 'integer — bumps on every change; send it back for safe writes',
    createdAt: 'ISO', updatedAt: 'ISO', enteredColumnAt: 'ISO',
  },
  event: {
    seq: 'integer cursor', ts: 'ISO', board: 'string', hash: 'board hash after the change',
    type: ['item.created', 'item.updated', 'item.moved', 'item.reordered', 'item.archived', 'item.restored', 'comment.added',
      'item.assigned', 'item.unblocked', 'lease.claimed', 'lease.renewed', 'lease.released', 'lease.revoked', 'lease.warning', 'lease.expired', 'lease.status',
      'attention.raised', 'attention.resolved', 'review.requested', 'digest.added', 'schema.updated', 'column.created', 'column.updated', 'column.deleted',
      'board.created', 'board.updated', 'board.external-edit', 'app.renamed', 'presence.changed', 'profile.updated'],
    actor: '{ kind, name }', itemId: 'string?', columnId: 'string? (destination for moves)', fromColumnId: 'string?',
    changes: '{ [field | "properties.<key>"]: { from, to } }?', item: 'snapshot { id,title,type,priority,columnId,column,parent,claimant,needsHuman }?',
    recipients: 'string[] — agents/users this event concerns (leaseholder, asker, agent author, @mentions)',
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

function reply(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Intellagent-Version': `${VERSION}+${BUILD}`,
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
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
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new HttpError(400, 'Body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

function tokenOf(req, q) {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '');
  return req.headers['x-intellagent-token'] || q.token || null;
}
const tokenEq = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Optional auth from the manifest. Off by default; docs and app name stay public so agents can discover it.
function checkAuth(req, q, actor, pathname) {
  if (!pathname.startsWith('/api') || pathname === '/api/docs' || pathname === '/api/app') return;
  const A = M.auth;
  const tok = tokenOf(req, q);
  if (actor.kind === 'user') {
    if (A.userToken && !tokenEq(tok, A.userToken)) fail(401, 'This board needs the user token', { auth: 'user' });
    return;
  }
  const need = A.agentTokens?.[actor.name];
  if (need) { if (!tokenEq(tok, need)) fail(401, `Agent "${actor.name}" must send its token (Authorization: Bearer …)`, { auth: 'agent' }); return; }
  if (A.requireAgentTokens) fail(401, `Agent "${actor.name}" has no token configured in the manifest`, { auth: 'agent' });
  const p = permsFor(actor.name);
  if (p?.readOnly && req.method !== 'GET' && /^\/api\/boards\//.test(pathname) && !/\/(comments|attention)$/.test(pathname)) {
    fail(403, `${actor.name} is read-only (it may still comment and ask for help)`);
  }
}

function actorOf(req, q) {
  const agent = req.headers['x-agent'] || q.agent;
  if (agent) return { kind: 'agent', name: str(agent, 64) };
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

route('POST', '/api/boards', 'Create a board: { name, id?, idPrefix?, template?: default|simple|empty, columns?: Column[], directives? }',
  ({ body, actor }) => created(boardView(createBoard(body, actor))));

route('GET', '/api/boards/:board', 'Full board JSON + hash', ({ p }) => boardView(getCtx(p.board)));

route('PATCH', '/api/boards/:board', 'Update board: { name?, idPrefix?, directives? }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  tx(ctx, (events) => {
    const changes = {};
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

route('GET', '/api/boards/:board/directives', 'Standing rules from the human (markdown)', ({ p }) => {
  const ctx = getCtx(p.board);
  return { directives: ctx.board.directives, updatedAt: ctx.board.updatedAt };
});
route('PUT', '/api/boards/:board/directives', 'Replace standing rules: { directives }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  tx(ctx, (events) => {
    const v = str(body.directives ?? body.markdown, 50_000);
    if (v === ctx.board.directives) return;
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
    if ('builtins' in body) ctx.board.schema.builtins = normBuiltins({ ...ctx.board.schema.builtins, ...body.builtins });
    if ('fields' in body) {
      const defs = arr(body.fields).map((f) => normField(f));
      const keys = defs.map((f) => f.key);
      if (new Set(keys).size !== keys.length) fail(400, 'Duplicate field keys');
      ctx.board.schema.fields = defs;
    }
  });
});
route('POST', '/api/boards/:board/schema/fields', 'Declare a field: { key, label, type, options?, ui?, stub?, icon?, help?, required?, default?, min?, max?, position? }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return created(schemaTx(ctx, actor, () => {
    const def = normField(body);
    if (ctx.board.schema.fields.some((f) => f.key === def.key)) fail(409, `Field "${def.key}" already exists — PATCH it instead`);
    ctx.board.schema.fields.splice(resolveIndex(ctx.board.schema.fields.map((f) => f.key), body.position), 0, def);
  }));
});
route('PATCH', '/api/boards/:board/schema/fields/:key', 'Change a field definition (merged)', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return schemaTx(ctx, actor, () => {
    const list = ctx.board.schema.fields;
    const i = list.findIndex((f) => f.key === p.key);
    if (i < 0) fail(404, `Field "${p.key}" not declared`);
    list[i] = normField(body, list[i]);
    if ('position' in body) { const [f] = list.splice(i, 1); list.splice(resolveIndex(list.map((x) => x.key), body.position), 0, f); }
  });
});
route('DELETE', '/api/boards/:board/schema/fields/:key', 'Remove a field definition (stored values are kept)', ({ p, actor }) => {
  const ctx = getCtx(p.board);
  return schemaTx(ctx, actor, () => {
    const n = ctx.board.schema.fields.length;
    ctx.board.schema.fields = ctx.board.schema.fields.filter((f) => f.key !== p.key);
    if (ctx.board.schema.fields.length === n) fail(404, `Field "${p.key}" not declared`);
  });
});

route('GET', '/api/boards/:board/columns', 'List columns with flags', ({ p }) => getCtx(p.board).board.columns);

route('POST', '/api/boards/:board/columns', 'Create column: { name, color?, icon?, position?, flags? } (API only)', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return created(tx(ctx, (events) => {
    const col = addColumn(ctx.board, body);
    events.push({ board: ctx.id, type: 'column.created', actor, columnId: col.id, column: { id: col.id, name: col.name, flags: col.flags } });
    return col;
  }));
});

route('PATCH', '/api/boards/:board/columns/:column', 'Update column: { name?, color?, icon?, position?, flags? (merged) }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return tx(ctx, (events) => {
    const col = findColumn(ctx.board, decodeURIComponent(p.column));
    const before = JSON.stringify({ ...col, itemIds: undefined });
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

route('DELETE', '/api/boards/:board/columns/:column', 'Delete an EMPTY column', ({ p, actor }) => {
  const ctx = getCtx(p.board);
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
  const items = col.itemIds.map((id) => itemView(ctx, ctx.board.items[id]));
  return {
    column: { id: col.id, name: col.name, flags: col.flags },
    items: q.full === 'true' ? items : items.map((v) => Object.fromEntries(SUMMARY_FIELDS.map((f) => [f, f === 'claimant' ? v.lease?.claimant ?? null : v[f]]))),
  };
});

route('POST', '/api/boards/:board/items', 'Create item: { title, description?, column?, type?, priority?, parent?, properties?, blockedBy?, needsHuman?, attachments?, position? }',
  ({ p, body, actor }) => {
    const ctx = getCtx(p.board);
    return created(itemView(ctx, createItem(ctx, body, actor)));
  });

route('POST', '/api/boards/:board/items/bulk', 'Patch many items: { ids: [], patch: {...} } → per-item results', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return arr(body.ids).map((id) => {
    try { return { id, ok: true, item: itemView(ctx, updateItem(ctx, id, body.patch || {}, actor)) }; }
    catch (e) { return { id, ok: false, status: e.status || 500, error: e.message }; }
  });
});

route('GET', '/api/boards/:board/items/:id', 'Full item (also finds archived items)', ({ p }) => {
  const ctx = getCtx(p.board);
  const key = p.id.toUpperCase();
  if (ctx.board.items[key]) return itemView(ctx, ctx.board.items[key]);
  if (ctx.archive.items[key]) return itemView(ctx, ctx.archive.items[key], true);
  return fail(404, `Item "${p.id}" not found`);
});

route('PATCH', '/api/boards/:board/items/:id', 'Change any field incl. column/position. properties merge (null deletes). Send version for safe writes.',
  ({ p, body, actor }) => { const ctx = getCtx(p.board); return itemView(ctx, updateItem(ctx, p.id, body, actor)); });

route('POST', '/api/boards/:board/items/:id/move', 'Move/reorder: { column?, position? | beforeId? | afterId? }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  const { column, columnId, position, beforeId, afterId, version } = body;
  return itemView(ctx, updateItem(ctx, p.id, { column: column ?? columnId, position, beforeId, afterId, version }, actor));
});

route('GET', '/api/boards/:board/items/:id/history', 'Recent events for this item', ({ p }) => {
  const key = p.id.toUpperCase();
  return recent.filter((e) => e.board === p.board && e.itemId === key).slice(-200);
});

route('POST', '/api/boards/:board/items/:id/comments', 'Add comment: { body } (markdown, @mentions notify)', ({ p, body, actor }) =>
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

route('POST', '/api/boards/:board/items/:id/review', 'Request review in one call: moves to the review column, comments your summary, releases your lease, raises needs-you. { summary?, reason?, column? }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return itemView(ctx, requestReview(ctx, p.id, body, actor));
});

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
    const entry = { id: rid('d'), date: new Date().toLocaleDateString('en-CA'), ts: t, author: actor, summary: str(body.summary, 20_000), items: arr(body.items).map((x) => String(x).toUpperCase()).slice(0, 50) };
    ctx.board.digest.push(entry);
    if (ctx.board.digest.length > 500) ctx.board.digest.splice(0, ctx.board.digest.length - 500);
    events.push({ board: ctx.id, type: 'digest.added', actor, entry: { id: entry.id, summary: trimChange(entry.summary) } });
    return entry;
  }));
});

route('POST', '/api/boards/:board/items/:id/attention', 'Ask the human: { reason }', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return itemView(ctx, updateItem(ctx, p.id, { needsHuman: { reason: body.reason || 'Needs input' } }, { ...actor, kind: actor.kind === 'agent' ? 'agent' : actor.kind }));
});
route('DELETE', '/api/boards/:board/items/:id/attention', 'Resolve: { reply? } (reply becomes a comment)', ({ p, body, actor }) => {
  const ctx = getCtx(p.board);
  return itemView(ctx, resolveAttention(ctx, p.id, body, actor));
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
  openStream(req, res, parseFilter(q), q.ui ? null : actor.kind === 'agent' ? actor.name : null));

route('GET', '/api/subscriptions', 'List subscriptions: ?agent=', ({ q }) => Object.values(subs).filter((s) => !q.agent || s.agent === q.agent));
route('POST', '/api/subscriptions', 'Create a durable subscription with a server-side cursor: { label?, filter: {...}, since? }', ({ body, actor }) => {
  const s = { id: rid('sub'), agent: actor.name, label: str(body.label || '', 80), filter: parseFilter(body.filter || {}), cursor: body.since != null ? Number(body.since) : seq, createdAt: now() };
  subs[s.id] = s;
  saveSubs();
  touch(actor.name, 'subscribe');
  return created(s);
});
route('DELETE', '/api/subscriptions/:id', 'Remove a subscription', ({ p }) => {
  if (!subs[p.id]) fail(404, 'Subscription not found');
  delete subs[p.id];
  saveSubs();
  return { deleted: p.id };
});
route('GET', '/api/subscriptions/:id/next', 'Long-poll the subscription; advances its cursor. ?timeout=25&limit=50&peek=true', ({ res, p, q }) => {
  const s = subs[p.id];
  if (!s) fail(404, 'Subscription not found');
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

route('GET', '/api/presence', 'Agents seen by this instance, online state, leases, subscriptions', () => presenceView());
route('GET', '/api/permissions/me', 'What you are allowed to do (from the manifest)', ({ actor }) => ({
  name: actor.name, kind: actor.kind, permissions: actor.kind === 'agent' ? permsFor(actor.name) : null,
  tokenRequired: actor.kind === 'user' ? !!M.auth.userToken : !!M.auth.agentTokens?.[actor.name] || !!M.auth.requireAgentTokens,
}));
route('GET', '/api/profiles', 'Display profiles (colour, glyph, image) for agents and users', () => profiles);
route('GET', '/api/profiles/me', 'Your display profile', ({ actor }) => ({ name: actor.name, ...(profiles[actor.name] || {}) }));
route('PATCH', '/api/profiles/me', 'Set your profile: { color?, glyph? (1–2 chars/emoji), label?, description? (markdown: what you were designed to do), image? (https URL) | imageBase64 | imagePath } — null clears',
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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    // Block other web pages from driving the API through the browser (CSRF); agents and curl send no Origin.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) fail(403, 'Cross-origin requests are not allowed');
    let m = null;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const hit = r.re.exec(u.pathname);
      if (hit) { m = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(hit[i + 1])])) }; break; }
    }
    if (!m) fail(404, `No route for ${req.method} ${u.pathname}. See GET /api`);
    const q = Object.fromEntries(u.searchParams);
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
    const actor = actorOf(req, q);
    checkAuth(req, q, actor, u.pathname);
    if (actor.kind === 'agent' && u.pathname.startsWith('/api')) touch(actor.name, `${req.method} ${u.pathname}`);
    const out = await m.r.handler({ req, res, p: m.params, q, body, actor });
    if (out === HANDLED || res.headersSent) return;
    if (out instanceof Reply) reply(res, out.status, out.body);
    else reply(res, 200, out ?? {});
  } catch (e) {
    if (res.headersSent) { res.end(); return; }
    const status = e.status || 500;
    if (status === 500) console.error(e);
    reply(res, status, { error: e.message, status, ...(e.extra || {}) });
  }
});

/* ───────────────────────── boot ───────────────────────── */

function seed() {
  if (M.seed === 'empty') {
    createBoard({ id: M.defaultBoard, name: M.boardName || 'Main', idPrefix: M.idPrefix || 'INT' }, SYSTEM);
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
});

const shutdown = () => {
  writeFileAtomic(PRESENCE_FILE, JSON.stringify({ updatedAt: now(), agents: Object.fromEntries(presence) }, null, 2));
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
