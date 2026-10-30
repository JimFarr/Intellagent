'use strict';
// Integration plugins (INT-462). A plugin is a folder .intellagent/plugins/<name>/ with a plugin.json and its code.
// Nothing in it runs until the human enables it: enabling pins a hash of the whole folder (but its data/), and a
// folder that no longer matches stops until enabled again. An enabled plugin runs in its own node process under
// the permission model: it reads only its own folder, writes only its data/, starts no programs or workers unless
// plugin.json asks and the human enabled it so, and gets no environment beyond ENV_ALWAYS: no INTELLAGENT_*, no
// token, no board URL. It talks to the board only over stdio, one JSON object per line:
//   board → plugin  { id, type: "test" | "run" | "webhook", connection, … }
//   plugin → board  { id, ok: true, result } | { id, ok: false, error }   the reply to a call
//                   { type: "event", event, data }                        an event it declared
// Its connection (secrets included) comes with each call, never through env or a file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { childEnv } = require('./agents/runner');
const { writeAtomic } = require('./jsonfile');

const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const ID_RE = /^[A-Za-z][\w-]{0,39}$/;
const TYPES = ['text', 'markdown', 'number', 'boolean', 'enum', 'tags', 'date', 'url'];
const TOP_KEYS = ['name', 'label', 'version', 'description', 'icon', 'entry', 'connection', 'hosts', 'actions', 'events', 'webhook', 'needs'];
const MAX_BYTES = 15 * 1024 * 1024; // a plugin folder or zip, unpacked
const MAX_FILES = 2000;
const MAX_LINE = 1024 * 1024; // one message on the channel
const CALL_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_SEC = 300;
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_LIMIT = 5;
const BACKOFF_MAX_MS = 5 * 60_000;
const EVENTS_PER_MIN = 60;
const RUNS_KEEP = 500; // finished runs kept; open ones always are
const REPLY_WAIT_MS = 15_000; // how long a run request waits for the outcome before answering "running"
const OPEN = new Set(['waiting', 'running']);
const SYSTEM = { kind: 'system', name: 'plugins' };

class PluginError extends Error {
  constructor(status, message, code, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);

// A typed field (a connection field or an action input), in the board's field types.
function cleanField(f, where, problems) {
  if (!isObj(f)) { problems.push(`${where}: must be an object`); return null; }
  if (!ID_RE.test(f.key || '')) problems.push(`${where}.key: letters, digits, _ or -, starting with a letter`);
  const type = f.type ?? 'text';
  if (!TYPES.includes(type)) problems.push(`${where}.type: "${type}" is not a field type (${TYPES.join(', ')})`);
  const d = { key: f.key, label: text(f.label, 60) || f.key, type };
  if (f.help) d.help = text(f.help, 300);
  if (f.required === true) d.required = true;
  if (f.secret === true) d.secret = true;
  if (type === 'enum' || type === 'tags') {
    d.options = (Array.isArray(f.options) ? f.options : []).map((o) => (isObj(o) ? { value: String(o.value ?? ''), ...(o.label ? { label: text(o.label, 60) } : {}) } : { value: String(o) })).filter((o) => o.value);
    if (type === 'enum' && !d.options.length) problems.push(`${where}.options: an enum needs options`);
  }
  if (type === 'number') for (const k of ['min', 'max']) if (f[k] != null) d[k] = Number(f[k]);
  return d;
}
function cleanFields(list, where, problems) {
  if (list == null) return [];
  if (!Array.isArray(list)) { problems.push(`${where}: must be a list`); return []; }
  const out = list.map((f, i) => cleanField(f, `${where}[${i}]`, problems)).filter(Boolean);
  const keys = out.map((f) => f.key);
  for (const k of new Set(keys.filter((k, i) => keys.indexOf(k) !== i))) problems.push(`${where}: "${k}" appears twice`);
  return out;
}

// --permission (no longer experimental) is Node 23.5's: on an older node a plugin would never start, so it can't be enabled
const [MAJOR, MINOR] = process.versions.node.split('.').map(Number);
const PERMISSION_OK = MAJOR > 23 || (MAJOR === 23 && MINOR >= 5);
const fold = process.platform === 'win32' ? (p) => path.resolve(p).toLowerCase() : (p) => path.resolve(p);
const within = (inner, outer) => { const r = path.relative(fold(outer), fold(inner)); return !r || (!r.startsWith('..') && !path.isAbsolute(r)); };

// plugin.json → { def, problems }. Strict at the top level, so a misspelt key is an error, not silently ignored.
// protect: folders a plugin may never be given (the board's own: its local.json, its data).
function validate(json, folder, dir, protect = []) {
  const problems = [];
  if (!isObj(json)) return { def: null, problems: ['plugin.json must hold a JSON object'] };
  for (const k of Object.keys(json)) if (!TOP_KEYS.includes(k)) problems.push(`${k}: unknown key (plugin.json takes ${TOP_KEYS.join(', ')})`);
  if (!NAME_RE.test(json.name || '')) problems.push('name: lower-case letters, digits and -, starting with a letter (max 40)');
  else if (json.name === 'runs') problems.push('name: "runs" is taken (/api/plugins/runs lists the runs)');
  else if (folder && json.name !== folder) problems.push(`name: "${json.name}" must match its folder "${folder}"`);
  const entry = json.entry ?? 'index.js';
  const entryPath = typeof entry === 'string' ? path.resolve(dir || '.', entry) : null;
  if (!entryPath || path.isAbsolute(entry) || !entryPath.startsWith(path.resolve(dir || '.') + path.sep)) problems.push('entry: a file inside the plugin folder');
  else if (dir && !fs.existsSync(entryPath)) problems.push(`entry: ${entry} is not in the folder`);
  const def = {
    name: json.name, label: text(json.label, 60) || json.name, version: text(json.version, 40) || null,
    description: text(json.description, 4000) || '', icon: text(json.icon, 32) || null, entry,
    connection: cleanFields(json.connection, 'connection', problems),
    hosts: Array.isArray(json.hosts) ? json.hosts.map((h) => String(h).slice(0, 200)) : [],
    actions: [], events: [], webhook: json.webhook === true,
    needs: { childProcess: json.needs?.childProcess === true, read: [] },
  };
  if (json.hosts != null && !Array.isArray(json.hosts)) problems.push('hosts: must be a list of host names');
  if (json.needs != null && !isObj(json.needs)) problems.push('needs: must be { childProcess?, read? }');
  for (const r of Array.isArray(json.needs?.read) ? json.needs.read : []) {
    if (typeof r !== 'string' || !path.isAbsolute(r)) problems.push(`needs.read: "${r}" must be an absolute path`);
    else if (path.parse(path.resolve(r)).root === path.resolve(r)) problems.push(`needs.read: "${r}" is a whole drive`);
    else if (protect.some((p) => within(r, p) || within(p, r))) problems.push(`needs.read: "${r}" would open the board's own files`);
    else def.needs.read.push(r);
  }
  (Array.isArray(json.actions) ? json.actions : json.actions == null ? [] : (problems.push('actions: must be a list'), [])).forEach((a, i) => {
    const w = `actions[${i}]`;
    if (!isObj(a) || !ID_RE.test(a.id || '')) { problems.push(`${w}.id: letters, digits, _ or -, starting with a letter`); return; }
    const t = a.timeoutSec == null ? CALL_TIMEOUT_MS / 1000 : Number(a.timeoutSec);
    if (!(t >= 1 && t <= MAX_TIMEOUT_SEC)) problems.push(`${w}.timeoutSec: 1 to ${MAX_TIMEOUT_SEC}`);
    def.actions.push({ id: a.id, label: text(a.label, 60) || a.id, help: text(a.help, 300) || '', timeoutSec: t, inputs: cleanFields(a.inputs, `${w}.inputs`, problems) });
  });
  (Array.isArray(json.events) ? json.events : json.events == null ? [] : (problems.push('events: must be a list'), [])).forEach((e, i) => {
    if (!isObj(e) || !ID_RE.test(e.id || '')) { problems.push(`events[${i}].id: letters, digits, _ or -, starting with a letter`); return; }
    const w = `events[${i}]`;
    // fields are typed like an action's inputs; a bare name is a text field (INT-474)
    const fields = cleanFields(Array.isArray(e.fields) ? e.fields.map((f) => (typeof f === 'string' ? { key: f } : f)) : e.fields, `${w}.fields`, problems);
    const ev = { id: e.id, label: text(e.label, 60) || e.id, fields };
    // the event's ticket, found by one of its fields: { field: "key", matches: "fields.jira" | "properties.<name>" }
    if (e.ticket != null) {
      if (!isObj(e.ticket) || !fields.some((f) => f.key === e.ticket.field)) problems.push(`${w}.ticket.field: one of the event's fields`);
      else if (!/^(fields|properties)\.[A-Za-z_][\w.-]{0,59}$/.test(e.ticket.matches || '')) problems.push(`${w}.ticket.matches: fields.<key> or properties.<name> of a ticket`);
      else ev.ticket = { field: e.ticket.field, matches: e.ticket.matches };
    }
    def.events.push(ev);
  });
  for (const [list, what] of [[def.actions, 'actions'], [def.events, 'events']]) {
    const ids = list.map((x) => x.id);
    for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) problems.push(`${what}: "${id}" appears twice`);
  }
  return { def, problems };
}

// Every file of the folder but data/, as [{ rel, abs }] sorted by path. A link is refused: it could point the hash
// at one file while the code reads another.
function filesOf(dir) {
  const out = [];
  let bytes = 0;
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && e.name === 'data') continue;
      const abs = path.join(d, e.name);
      if (e.isSymbolicLink()) throw new PluginError(400, `${r} is a link: a plugin holds only plain files and folders`, 'BAD_REQUEST');
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        bytes += fs.statSync(abs).size;
        out.push({ rel: r, abs });
        if (out.length > MAX_FILES || bytes > MAX_BYTES) throw new PluginError(413, `A plugin is at most ${MAX_FILES} files and ${MAX_BYTES / 1048576} MB`, 'TOO_LARGE');
      }
    }
  };
  walk(dir, '');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
// shortcut: hashes the whole folder on every read; cache by mtimes if plugin folders grow large.
function hashDir(dir) {
  const h = crypto.createHash('sha256');
  for (const f of filesOf(dir)) { h.update(`${f.rel}\0`); h.update(fs.readFileSync(f.abs)); h.update('\0'); }
  return `sha256:${h.digest('hex')}`;
}

// A .zip's files as [{ name, data }]: stored or deflated, no encryption, no zip64, no links, no path that leaves
// the folder. One folder holding everything (my-plugin/…) is unwrapped.
function unzip(buf) {
  const bad = (m) => new PluginError(400, `Not a plugin zip: ${m}`, 'BAD_REQUEST');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad('no zip directory found');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > MAX_FILES) throw new PluginError(413, `A plugin is at most ${MAX_FILES} files`, 'TOO_LARGE');
  const files = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('a broken directory entry');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl).replace(/\\/g, '/');
    p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw bad(`${name} is encrypted`);
    if (csize === 0xffffffff || size === 0xffffffff) throw bad('zip64 is not supported');
    if (((attrs >>> 16) & 0o170000) === 0o120000) throw new PluginError(400, `${name} is a link: a plugin holds only plain files and folders`, 'BAD_REQUEST');
    // ':' is a drive or an NTFS alternate stream (a.js:hidden), never a plain file
    if (name.startsWith('/') || name.includes(':') || name.split('/').some((s) => s === '..' || s === '')) throw bad(`${name} is outside the plugin folder`);
    if ((total += size) > MAX_BYTES) throw new PluginError(413, `A plugin is at most ${MAX_BYTES / 1048576} MB unpacked`, 'TOO_LARGE');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad(`${name} has no file header`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) { try { data = zlib.inflateRawSync(raw, { maxOutputLength: size }); } catch { throw bad(`${name} does not unpack`); } }
    else throw bad(`${name} uses compression method ${method}`);
    if (data.length !== size) throw bad(`${name} is the wrong size`);
    files.push({ name, data });
  }
  const tops = new Set(files.map((f) => (f.name.includes('/') ? f.name.split('/')[0] : '')));
  if (tops.size === 1 && !tops.has('')) { const cut = [...tops][0].length + 1; for (const f of files) f.name = f.name.slice(cut); }
  // data/ is the plugin's own working folder, outside the pin: a package that ships one ships code nobody pinned
  const shipped = files.find((f) => f.name.split('/')[0] === 'data');
  if (shipped) throw bad(`${shipped.name}: a plugin can't ship a data/ folder (it is the plugin's own, and not pinned)`);
  return files;
}

/**
 * The plugins of one board folder.
 * deps: { dir (the plugins folder), local: { read(), update(fn) } (local.json), emit, now, coerce(def, value),
 *         protect (folders needs.read may never reach: the board's own), runsFile (where runs are kept),
 *         holders(power) → [{ name, where?, approve? }], dropGrants(name) → [agent names] (a removed plugin's grants) }
 */
function createPlugins({ dir, local, emit, now = () => new Date().toISOString(), coerce, protect = [], runsFile = null, holders = () => [], dropGrants = () => [], ticketOf = () => null }) {
  const live = new Map(); // name → { proc, pending, crashes, crashed, timer, stopping, events, stderr }
  const folder = (name) => path.join(dir, name);
  const saved = (name) => local.read().plugins?.[name] || {};
  const save = (name, fn) => local.update((l) => { l.plugins ||= {}; l.plugins[name] ||= {}; fn(l.plugins[name]); if (!Object.keys(l.plugins[name]).length) delete l.plugins[name]; });
  const tell = (type, name, extra = {}, actor = SYSTEM) => emit({ type, actor, plugin: name, ...extra, recipients: [] });
  const notFound = (name) => new PluginError(404, `No plugin "${name}"`, 'NOT_FOUND', { hint: 'GET /api/plugins lists them' });

  function read(name) {
    if (!NAME_RE.test(name) || !fs.existsSync(path.join(folder(name), 'plugin.json'))) return null;
    let json;
    try { json = JSON.parse(fs.readFileSync(path.join(folder(name), 'plugin.json'), 'utf8')); } catch (e) { return { name, def: null, problems: [`plugin.json is not valid JSON: ${e.message}`] }; }
    const { def, problems } = validate(json, name, folder(name), protect);
    return { name, def, problems };
  }
  function stateOf(p, hash, s = saved(p.name)) {
    if (p.problems.length) return 'invalid';
    if (!s.enabled) return 'off';
    if (hash !== s.enabled.hash) return 'changed';
    return live.get(p.name)?.crashed ? 'crashed' : 'on';
  }
  function current(name) {
    const p = read(name);
    if (!p) throw notFound(name);
    let hash = null;
    try { hash = hashDir(folder(name)); } catch (e) { p.problems.push(e.message); }
    return { p, hash, state: stateOf(p, hash) };
  }

  // the last 4 only of a secret long enough that 4 characters don't give it away
  const mask = (v) => (v == null ? null : `••••${String(v).length >= 12 ? String(v).slice(-4) : ''}`);
  function view(name) {
    const { p, hash, state } = current(name);
    const s = saved(name);
    const d = p.def || {};
    const values = {};
    for (const f of d.connection || []) values[f.key] = s.connection?.[f.key] == null ? null : f.secret ? mask(s.connection[f.key]) : s.connection[f.key];
    const l = live.get(name);
    return {
      name, label: d.label || name, version: d.version || null, description: d.description || '', icon: d.icon || null,
      state, running: !!l?.proc, problems: p.problems, hash,
      enabled: s.enabled || null,
      asks: { secrets: (d.connection || []).filter((f) => f.secret).map((f) => f.key), hosts: d.hosts || [], needs: d.needs || { childProcess: false, read: [] },
        actions: (d.actions || []).map((a) => a.id), events: (d.events || []).map((e) => e.id), webhook: d.webhook ? `/hooks/${name}` : null },
      connection: { fields: d.connection || [], values, connected: (d.connection || []).every((f) => !f.required || values[f.key] != null), test: s.test || null },
      actions: (d.actions || []).map((a) => ({ ...a, power: `plugin.${name}.${a.id}`, holders: holders(`plugin.${name}.${a.id}`) })),
      events: d.events || [],
      webhook: d.webhook ? { path: `/hooks/${name}`, lastAt: l?.lastHookAt || null } : null,
      crashes: { count: l?.crashes.length || 0, lastAt: l?.lastCrashAt || null, lastError: l?.lastError || null },
      runs: { waiting: runs.filter((r) => r.plugin === name && r.status === 'waiting').length, running: runs.filter((r) => r.plugin === name && r.status === 'running').length },
    };
  }
  function list() {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort()
      .filter((n) => read(n)).map(view);
  }

  /* ── the process ── */
  function start(name) {
    const l = live.get(name) || { crashes: [], pending: new Map(), events: [] };
    live.set(name, l);
    if (l.proc) return l;
    const { p, state } = current(name);
    if (state !== 'on') return l;
    if (!PERMISSION_OK) { l.lastError = `needs Node 23.5 or later (this board runs ${process.versions.node})`; return l; } // enabled on a newer node: never start it unsandboxed
    const root = folder(name);
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    // a trailing separator, so plugins/jira never also opens plugins/jira-2
    const args = ['--permission', `--allow-fs-read=${root}${path.sep}`, `--allow-fs-write=${path.join(root, 'data')}${path.sep}`];
    if (p.def.needs.childProcess) args.push('--allow-child-process');
    for (const r of p.def.needs.read) args.push(`--allow-fs-read=${r}`);
    args.push(path.join(root, p.def.entry));
    const proc = spawn(process.execPath, args, { cwd: root, env: childEnv({ inheritEnv: [] }, null, {}), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    l.proc = proc;
    l.stopping = false;
    l.stderr = '';
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      if (buf.length > MAX_LINE && !buf.includes('\n')) { l.lastError = 'a message over 1 MB'; proc.kill(); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(name, l, p.def, line); }
    });
    proc.stderr.on('data', (d) => { l.stderr = (l.stderr + d).slice(-2000); });
    proc.stdin.on('error', () => { /* it exited; the exit handler says so */ });
    // a process that never started sends 'error' and no 'exit': end it here, or l.proc stays set and it never restarts
    proc.on('error', (e) => { l.stderr = `${l.stderr}\n${e.message}`; onExit(name, l, proc, null, 'error'); });
    proc.on('exit', (code, signal) => onExit(name, l, proc, code, signal));
    return l;
  }
  function onLine(name, l, def, line) {
    let m;
    try { m = JSON.parse(line); } catch { l.stderr = `${l.stderr}\n(not JSON) ${line.slice(0, 200)}`.slice(-2000); return; }
    if (!isObj(m)) return;
    if (m.id != null && l.pending.has(m.id)) {
      const c = l.pending.get(m.id);
      l.pending.delete(m.id);
      clearTimeout(c.timer);
      c.resolve(m);
      return;
    }
    if (m.type === 'event') raise(name, l, def, m.event, m.data, m.item);
  }
  const busy = (l) => { const t = Date.now(); l.events = l.events.filter((x) => t - x < 60_000); return l.events.length >= EVENTS_PER_MIN; };
  // An event the plugin declared → plugin.event { event, data, item?, match? }, at most EVENTS_PER_MIN a minute.
  // data keeps only the declared fields whose values fit their types. Its ticket: item (an id the plugin sent), or
  // match: { path, value } from the event's ticket link, for the board to look up. false when it is dropped.
  function raise(name, l, def, event, data, item) {
    const ev = def.events.find((e) => e.id === event);
    if (!ev) return false;
    if (!pinHolds(name)) return false; // code changed under a running plugin (a lazy require): stop it, never act on it
    if (busy(l)) return false;
    l.events.push(Date.now());
    const clean = {};
    if (isObj(data) && JSON.stringify(data).length <= 10_000) {
      for (const f of ev.fields) {
        if (data[f.key] == null) continue;
        try { const v = coerce(f, data[f.key]); if (v != null) clean[f.key] = v; } catch { /* doesn't fit its type: dropped */ }
      }
    }
    const id = typeof item === 'string' && /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}$/.test(item) ? item : null;
    const match = !id && ev.ticket && clean[ev.ticket.field] != null ? { path: ev.ticket.matches, value: String(clean[ev.ticket.field]) } : null;
    tell('plugin.event', name, { event, data: clean, ...(id ? { item: id } : {}), ...(match ? { match } : {}) });
    return true;
  }
  function onExit(name, l, proc, code, signal) {
    if (l.proc !== proc) return;
    l.proc = null;
    for (const c of l.pending.values()) { clearTimeout(c.timer); c.reject(new PluginError(502, `${name} stopped while answering`, 'PLUGIN_CRASHED')); }
    l.pending.clear();
    if (l.stopping) return;
    const t = Date.now();
    l.crashes = [...l.crashes.filter((x) => t - x < CRASH_WINDOW_MS), t];
    l.lastCrashAt = now();
    l.lastError = (l.stderr.trim().split('\n').pop() || `exit ${code ?? signal}`).slice(0, 500);
    if (l.crashes.length >= CRASH_LIMIT) {
      l.crashed = true;
      tell('plugin.crashed', name, { error: l.lastError, count: l.crashes.length });
      tell('plugin.disabled', name, { reason: 'crashed' });
      return;
    }
    const wait = Math.min(1000 * 2 ** (l.crashes.length - 1), BACKOFF_MAX_MS);
    l.timer = setTimeout(() => { l.timer = null; start(name); }, wait);
    l.timer.unref?.();
  }
  // false (and the plugin stopped) when its files no longer match the pin
  function pinHolds(name) {
    if (current(name).state !== 'changed') return true;
    stop(name);
    tell('plugin.disabled', name, { reason: 'changed' });
    return false;
  }
  // a plugin that works on its own (polls, never raises an event) is checked once a minute too
  const watch = setInterval(() => { for (const [name, l] of live) if (l.proc) { try { pinHolds(name); } catch { stop(name); } } }, 60_000);
  watch.unref?.();

  function stop(name) {
    const l = live.get(name);
    if (!l) return;
    clearTimeout(l.timer);
    l.timer = null;
    if (l.proc) { l.stopping = true; l.proc.kill(); }
  }

  // One call to a running plugin → its reply { ok, result?, error? }. The pin is checked first: changed code stops.
  async function call(name, type, payload = {}, timeoutMs = CALL_TIMEOUT_MS) {
    const { state } = current(name);
    if (!pinHolds(name)) throw changedError(name);
    if (state !== 'on') throw new PluginError(409, `${name} is ${state}`, 'PLUGIN_OFF', { hint: 'The human enables it on the Integrations page' });
    const l = start(name);
    if (!l.proc) throw new PluginError(503, `${name} is restarting`, 'PLUGIN_CRASHED', { hint: 'Try again in a few seconds' });
    const id = crypto.randomUUID();
    const connection = { ...(saved(name).connection || {}), ...(payload.connection || {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        l.pending.delete(id);
        l.lastError = `no answer to ${type} in ${timeoutMs / 1000} s`;
        l.proc?.kill(); // a hung plugin is restarted, never left holding the call
        reject(new PluginError(504, `${name} did not answer in ${timeoutMs / 1000} s`, 'TIMEOUT'));
      }, timeoutMs);
      l.pending.set(id, { resolve, reject, timer });
      l.proc.stdin.write(`${JSON.stringify({ ...payload, id, type, connection })}\n`);
    });
  }

  /* ── webhooks (INT-474) ── */
  // POST /hooks/<name>, from anyone: the plugin gets the raw request and checks it itself (a signature from a secret
  // in its connection), and answers { ok: true, result: { event, data } | null }. The board acts only on an event the
  // plugin declared, through raise(): pinned, rate-capped. Anything that isn't an enabled webhook plugin is one 404,
  // so the open route says nothing about what is installed.
  async function webhook(name, { headers, body }) {
    const p = read(name);
    const gone = new PluginError(404, 'No webhook here', 'NOT_FOUND');
    if (!p?.def?.webhook || current(name).state !== 'on') throw gone;
    const l = start(name);
    if (busy(l)) throw new PluginError(429, 'Too many events from this plugin: try again in a minute', 'RATE_LIMITED');
    let r;
    try { r = await call(name, 'webhook', { webhook: { headers, body } }); } catch (e) { throw ['PLUGIN_OFF', 'PLUGIN_CHANGED'].includes(e.code) ? gone : e; }
    l.lastHookAt = now();
    if (r.ok !== true) throw new PluginError(401, String(r.error ?? 'The plugin refused it').slice(0, 200), 'UNAUTHORIZED');
    const event = isObj(r.result) && typeof r.result.event === 'string' ? r.result.event : null;
    if (event && !p.def.events.some((e) => e.id === event)) throw new PluginError(502, `${name} answered with an event it doesn't declare: ${event.slice(0, 40)}`, 'BAD_GATEWAY');
    return { accepted: true, event: event && raise(name, l, p.def, event, r.result.data, r.result.item) ? event : null };
  }

  /* ── adding and removing ── */
  // Files (from a folder or a zip) go to a staging folder first; only a valid plugin with a free name is moved in.
  function install(files, actor) {
    fs.mkdirSync(dir, { recursive: true });
    const stage = fs.mkdtempSync(path.join(dir, '.add-'));
    try {
      for (const f of files) {
        const to = path.join(stage, ...f.name.split('/'));
        if (!to.startsWith(stage + path.sep)) throw new PluginError(400, `${f.name} is outside the plugin folder`, 'BAD_REQUEST');
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, f.data);
      }
      let json;
      try { json = JSON.parse(fs.readFileSync(path.join(stage, 'plugin.json'), 'utf8')); } catch (e) {
        throw new PluginError(400, 'The plugin has no readable plugin.json', 'PLUGIN_INVALID', { problems: [e.code === 'ENOENT' ? 'plugin.json is missing' : `plugin.json is not valid JSON: ${e.message}`] });
      }
      const { problems } = validate(json, null, stage, protect);
      if (problems.length) throw new PluginError(400, `plugin.json has ${problems.length} problem${problems.length > 1 ? 's' : ''}`, 'PLUGIN_INVALID', { problems });
      if (fs.existsSync(folder(json.name))) throw new PluginError(409, `A plugin named "${json.name}" is already here`, 'CONFLICT', { hint: `Remove it first: DELETE /api/plugins/${json.name}` });
      fs.renameSync(stage, folder(json.name));
      tell('plugin.added', json.name, {}, actor);
      return view(json.name);
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  function add(body, actor) {
    if (typeof body.zipBase64 === 'string') {
      const buf = Buffer.from(body.zipBase64, 'base64');
      if (buf.length > MAX_BYTES) throw new PluginError(413, `A plugin zip is at most ${MAX_BYTES / 1048576} MB`, 'TOO_LARGE');
      return install(unzip(buf), actor);
    }
    const src = typeof body.path === 'string' ? path.resolve(body.path) : null;
    if (!src || !path.isAbsolute(body.path) || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      throw new PluginError(400, 'Send { path } (an absolute folder) or { zipBase64, filename }', 'BAD_REQUEST');
    }
    if (src === path.resolve(dir) || src.startsWith(path.resolve(dir) + path.sep)) throw new PluginError(400, 'That folder is already in the plugins folder', 'BAD_REQUEST', { hint: 'Enable it instead' });
    return install(filesOf(src).map((f) => ({ name: f.rel, data: fs.readFileSync(f.abs) })), actor);
  }
  async function remove(name, actor) {
    if (!read(name)) throw notFound(name);
    const proc = live.get(name)?.proc;
    // Windows keeps the folder (the process's cwd) until the process has really exited
    const gone = proc && proc.exitCode === null && proc.signalCode === null ? new Promise((res) => { proc.once('close', res); setTimeout(res, 10_000).unref(); }) : null;
    stop(name);
    await gone;
    live.delete(name);
    const runsCanceled = cancelOpen(name, actor);
    fs.rmSync(folder(name), { recursive: true, force: true });
    save(name, (s) => { for (const k of Object.keys(s)) delete s[k]; });
    // the grants go too: a plugin added again under this name is new code, and earns its grants anew
    const grantsDropped = dropGrants(name, actor);
    tell('plugin.removed', name, {}, actor);
    return { removed: name, grantsDropped, runsCanceled };
  }

  /* ── on and off ── */
  function enable(name, hash, actor) {
    const c = current(name);
    if (!PERMISSION_OK) throw new PluginError(409, `Plugins need Node 23.5 or later; this board runs ${process.versions.node}`, 'PLUGIN_UNSUPPORTED', { hint: 'Update Node to 23.5 or later and restart the board: the plugin sandbox is its --permission flag' });
    if (c.p.problems.length) throw new PluginError(400, `${name} can't be enabled: plugin.json has problems`, 'PLUGIN_INVALID', { problems: c.p.problems });
    if (!hash || hash !== c.hash) throw new PluginError(409, `${name}'s files are not the ones you were shown`, 'PLUGIN_CHANGED', { hash: c.hash, hint: 'Read it again (GET /api/plugins/<name>), show what it asks for, and send that hash' });
    stop(name);
    live.delete(name);
    save(name, (s) => { s.enabled = { hash, by: actor.name, at: now() }; });
    start(name);
    tell('plugin.enabled', name, {}, actor);
    return view(name);
  }
  function disable(name, actor) {
    if (!read(name)) throw notFound(name);
    stop(name);
    live.delete(name);
    save(name, (s) => { delete s.enabled; });
    cancelOpen(name, actor);
    tell('plugin.disabled', name, { reason: 'human' }, actor);
    return view(name);
  }

  /* ── connection ── */
  function setConnection(name, values, actor) {
    const { p } = current(name);
    if (!p.def) throw new PluginError(400, `${name}'s plugin.json has problems`, 'PLUGIN_INVALID', { problems: p.problems });
    const next = { ...(saved(name).connection || {}), ...checkValues(p.def, values) };
    for (const k of Object.keys(next)) if (next[k] == null) delete next[k];
    const missing = p.def.connection.filter((f) => f.required && next[f.key] == null).map((f) => f.key);
    if (missing.length) throw new PluginError(400, `Required: ${missing.join(', ')}`, 'BAD_REQUEST');
    save(name, (s) => { s.connection = next; delete s.test; });
    tell('plugin.connection', name, { change: 'saved' }, actor);
    return view(name);
  }
  function checkValues(def, values) {
    if (!isObj(values)) throw new PluginError(400, 'Send { values: { key: value } }', 'BAD_REQUEST');
    const out = {};
    for (const [k, v] of Object.entries(values)) {
      const f = def.connection.find((x) => x.key === k);
      if (!f) throw new PluginError(400, `Unknown connection field "${k}". Fields: ${def.connection.map((x) => x.key).join(', ') || '(none)'}`, 'BAD_REQUEST');
      out[k] = v == null ? null : coerce(f, v);
    }
    return out;
  }
  function clearConnection(name, actor) {
    if (!read(name)) throw notFound(name);
    save(name, (s) => { delete s.connection; delete s.test; });
    tell('plugin.connection', name, { change: 'cleared' }, actor);
    return view(name);
  }
  async function test(name, values, actor) {
    const { p, state } = current(name);
    const connection = values == null ? {} : checkValues(p.def || { connection: [] }, values);
    // a required field not set yet: the board knows it isn't connected, without asking the plugin
    const have = { ...(saved(name).connection || {}), ...connection };
    const missing = (p.def?.connection || []).filter((f) => f.required && have[f.key] == null).map((f) => f.key);
    let r;
    if (missing.length && state === 'on') r ={ ok: false, error: `Not connected: ${missing.join(', ')} not set` };
    else try { r = await call(name, 'test', { connection }); } catch (e) {
      if (e.code !== 'PLUGIN_CRASHED') throw e;
      r = { ok: false, error: e.message };
    }
    const result = { ok: r.ok === true, message: String((r.ok ? r.result?.message : r.error) ?? (r.ok ? 'Connected' : 'Failed')).slice(0, 500) };
    if (values == null) save(name, (s) => { s.test = { ...result, at: now() }; });
    tell('plugin.connection', name, { change: 'tested', ok: result.ok }, actor);
    return result;
  }

  /* ── runs of an action (INT-473) ── */
  // The board decides who may run what (plugin.<name>.<action> grants, server.js); this keeps the runs: one per
  // request, waiting for the human's OK or running, then finished. Kept in runsFile, the newest RUNS_KEEP finished.
  let runs = [];
  try { runs = runsFile ? JSON.parse(fs.readFileSync(runsFile, 'utf8')).runs || [] : []; } catch { /* none yet */ }
  // a run the board was in the middle of when it stopped never finished: say so, never leave it "running"
  for (const r of runs) if (r.status === 'running') Object.assign(r, { status: 'failed', error: 'The board restarted while it ran', finishedAt: now() });
  const replying = new Set(); // runs whose agent is still waiting on its POST: the outcome reaches it in the reply
  function saveRuns() {
    const done = runs.filter((r) => !OPEN.has(r.status));
    if (done.length > RUNS_KEEP) { const drop = new Set(done.slice(0, done.length - RUNS_KEEP)); runs = runs.filter((r) => !drop.has(r)); }
    if (runsFile) writeAtomic(runsFile, { runs });
  }
  function setRun(r, status, actor = SYSTEM, extra = {}) {
    Object.assign(r, extra, { status });
    if (!OPEN.has(status)) r.finishedAt = now();
    saveRuns();
    const agent = r.by.kind === 'agent' ? [r.by.name] : [];
    // the agent hears every change; only an outcome it wasn't handed in its reply, nor caused itself, wakes it
    const wake = !OPEN.has(status) && !replying.has(r.id) && actor.name !== r.by.name ? agent : [];
    emit({ type: `plugin.run.${status === 'running' ? 'started' : status}`, actor, plugin: r.plugin, action: r.action, runId: r.id, status, by: r.by.name,
      ...(r.item ? { item: r.item } : {}), recipients: agent, ...(wake.length ? { addressed: wake } : {}) });
  }
  const changedError = (name) => new PluginError(409, `${name}'s files changed since it was enabled: it is stopped until the human enables it again`, 'PLUGIN_CHANGED');
  // An action of a plugin the human has enabled (its code is checked again when it runs), or null.
  function actionOf(name, id) {
    const p = read(name);
    if (!p?.def || p.problems.length || !saved(name).enabled) return null;
    return p.def.actions.find((a) => a.id === id) || null;
  }
  // A run request checked against what the plugin declares → { action, inputs } with the inputs in their types.
  function prepare(name, actionId, inputs) {
    const { p, state } = current(name);
    if (!pinHolds(name)) throw changedError(name);
    if (state !== 'on') throw new PluginError(409, `${name} is ${state}`, 'PLUGIN_OFF', { hint: 'The human enables it on the Integrations page' });
    const action = p.def.actions.find((a) => a.id === actionId);
    if (!action) throw new PluginError(404, `${name} has no action "${actionId}"`, 'NOT_FOUND', { hint: `Actions: ${p.def.actions.map((a) => a.id).join(', ') || '(none)'}` });
    if (inputs != null && !isObj(inputs)) throw new PluginError(400, 'Send { inputs: { key: value } }', 'BAD_REQUEST');
    const out = {};
    for (const [k, v] of Object.entries(inputs || {})) {
      const f = action.inputs.find((x) => x.key === k);
      if (!f) throw new PluginError(400, `Unknown input "${k}" of ${actionId}. Inputs: ${action.inputs.map((x) => x.key).join(', ') || '(none)'}`, 'BAD_REQUEST');
      const c = coerce(f, v);
      if (c != null) out[k] = c;
    }
    const missing = action.inputs.filter((f) => f.required && out[f.key] == null).map((f) => f.key);
    if (missing.length) throw new PluginError(400, `Required: ${missing.join(', ')}`, 'BAD_REQUEST');
    const conn = saved(name).connection || {};
    const unset = p.def.connection.filter((f) => f.required && conn[f.key] == null).map((f) => f.key);
    if (unset.length) throw new PluginError(409, `${name} is not connected: ${unset.join(', ')} not set`, 'NOT_CONNECTED', { hint: 'The human connects it on the Integrations page' });
    return { action, inputs: out };
  }
  async function execute(r, action) {
    setRun(r, 'running', SYSTEM, { startedAt: now() });
    let reply;
    // a plugin has no board address or token: a run for a ticket carries the ticket's own data, read as it runs
    const ticket = r.item ? ticketOf(r.board, r.item) : null;
    // by: who asked (an agent's or the human's name), so a plugin can keep something per agent (INT-494)
    try { reply = await call(r.plugin, 'run', { action: r.action, inputs: r.inputs, by: { ...r.by }, ...(ticket ? { ticket } : {}) }, action.timeoutSec * 1000); } catch (e) {
      reply = { ok: false, error: e.message, timedout: e.code === 'TIMEOUT' };
    }
    if (r.status !== 'running') return; // canceled meanwhile: what it answered is not kept
    if (reply.ok === true) setRun(r, 'succeeded', SYSTEM, { result: isObj(reply.result) && JSON.stringify(reply.result).length <= 10_000 ? reply.result : { message: 'Done (its answer was too large to keep)' } });
    else setRun(r, reply.timedout ? 'timedout' : 'failed', SYSTEM, { error: String(reply.error ?? 'Failed').slice(0, 500) });
  }
  // Runs it and answers once it finishes or after REPLY_WAIT_MS, whichever comes first. agentWaits: the agent that
  // asked is the one waiting, so an outcome inside the wait is in its reply and wakes nobody.
  async function answerSoon(r, action, agentWaits) {
    if (agentWaits) replying.add(r.id);
    const done = execute(r, action);
    let t;
    await Promise.race([done, new Promise((res) => { t = setTimeout(res, REPLY_WAIT_MS); })]);
    clearTimeout(t);
    replying.delete(r.id);
    return { ...r };
  }
  // A run of a prepared request. approve: the grant says the human OKs each run first.
  function startRun(name, { action, inputs }, { by, item = null, board = null, approve = false }) {
    const r = { id: `pr_${crypto.randomBytes(6).toString('hex')}`, plugin: name, action: action.id, status: 'waiting', inputs, by: { kind: by.kind, name: by.name },
      ...(item ? { item, ...(board ? { board } : {}) } : {}), approval: null, result: null, error: null, createdAt: now(), startedAt: null, finishedAt: null };
    runs.push(r);
    if (approve) { setRun(r, 'waiting', by); return Promise.resolve({ ...r }); }
    return answerSoon(r, action, by.kind === 'agent');
  }
  function runOf(id) {
    const r = runs.find((x) => x.id === id);
    if (!r) throw new PluginError(404, `No run "${id}"`, 'NOT_FOUND', { hint: 'GET /api/plugins/runs lists them' });
    return r;
  }
  // recheck(run, prepared): throws when the agent's grant no longer covers the run (server.js)
  function approveRun(id, actor, recheck) {
    const r = runOf(id);
    if (r.status !== 'waiting') throw new PluginError(409, `Run ${id} is ${r.status}`, 'ALREADY_DECIDED');
    const prep = prepare(r.plugin, r.action, r.inputs);
    recheck(r, prep);
    r.approval = { by: actor.name, at: now(), verdict: 'approved' };
    return answerSoon(r, prep.action, false);
  }
  function rejectRun(id, actor, note) {
    const r = runOf(id);
    if (r.status !== 'waiting') throw new PluginError(409, `Run ${id} is ${r.status}`, 'ALREADY_DECIDED');
    setRun(r, 'rejected', actor, { approval: { by: actor.name, at: now(), verdict: 'rejected', ...(note ? { note: String(note).slice(0, 500) } : {}) } });
    return { ...r };
  }
  function cancelRun(id, actor) {
    const r = runOf(id);
    if (actor.kind !== 'user' && actor.name !== r.by.name) throw new PluginError(403, `Run ${id} is ${r.by.name}'s: an agent cancels only its own`, 'FORBIDDEN');
    if (!OPEN.has(r.status)) throw new PluginError(409, `Run ${id} is already ${r.status}`, 'CONFLICT');
    setRun(r, 'canceled', actor);
    return { ...r };
  }
  // every open run of a plugin, canceled (it was turned off or removed) → how many
  const cancelOpen = (name, actor) => runs.filter((r) => r.plugin === name && OPEN.has(r.status)).map((r) => setRun(r, 'canceled', actor)).length;
  function listRuns({ plugin, status, top } = {}) {
    const n = Math.min(Math.max(Number(top) || 20, 1), 100);
    return runs.filter((r) => (!plugin || r.plugin === plugin) && (!status || r.status === status)).slice(-n).reverse().map((r) => ({ ...r }));
  }

  return {
    list, view, add, remove, enable, disable, setConnection, clearConnection, test, call, webhook,
    actionOf, prepare, startRun, approveRun, rejectRun, cancelRun, listRuns, getRun: (id) => ({ ...runOf(id) }),
    startAll() { for (const p of list()) if (p.state === 'on') start(p.name); },
    stopAll() { clearInterval(watch); for (const name of live.keys()) stop(name); },
  };
}

module.exports = { createPlugins, validate, hashDir, unzip, PluginError, NAME_RE, TYPES };
