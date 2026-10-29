'use strict';
// The browser plugin (INT-494): one headless Chrome per agent, on a port of its own, which the agent's browser tool
// attaches to (Playwright MCP --cdp-endpoint). No dependencies: the DevTools HTTP endpoints over node's fetch.
// Runs under the board's plugin sandbox: reads its folder, writes data/, may start programs (needs.childProcess).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DATA = path.join(__dirname, 'data');
const STATE = path.join(DATA, 'browsers.json'); // { name: { port, pid } }: what a plugin process that was killed left running
const PORTS = [9400, 9499]; // one per agent, kept in the state so it stays the same
const DEFAULT_IDLE_MIN = 15;
const CHROME = {
  win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
}[process.platform] || 'google-chrome';

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const log = (...a) => process.stderr.write(`${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const live = new Map(); // name → { proc, port, url, width, height, theme, seen, changedAt }
let connection = {};

function readState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
function writeState(s) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }
// a name as a folder name: an agent's name is already safe; a person's or a rule's may not be
const slot = (by) => `${by.kind === 'agent' ? '' : `${by.kind}-`}${String(by.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 60)}`;

async function version(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function pages(port) {
  try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json()).filter((p) => p.type === 'page'); } catch { return null; }
}
function portFor(name) {
  const s = readState();
  if (s[name]?.port) return s[name].port;
  const taken = new Set(Object.values(s).map((x) => x.port));
  for (let p = PORTS[0]; p <= PORTS[1]; p++) if (!taken.has(p)) { s[name] = { port: p }; writeState(s); return p; }
  throw new Error(`Every browser port (${PORTS[0]}–${PORTS[1]}) is taken`);
}

function launch(name, port, { url, width, height, theme }) {
  const profile = path.join(DATA, 'profiles', name);
  fs.rmSync(profile, { recursive: true, force: true }); // a fresh profile each start: nothing carried over
  fs.mkdirSync(profile, { recursive: true });
  const args = ['--headless=new', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', `--window-size=${width},${height}`,
    // prefers-color-scheme for every page: 0 dark, 1 light
    `--blink-settings=preferredColorScheme=${theme === 'dark' ? 0 : 1}`, url];
  const exe = connection.chrome || CHROME;
  // shortcut: a .js "Chrome" runs with node, so the tests can stand one in; a real Chrome is never a .js
  const proc = exe.endsWith('.js') ? spawn(process.execPath, [exe, ...args], { stdio: 'ignore', windowsHide: true }) : spawn(exe, args, { stdio: 'ignore', windowsHide: true });
  return proc;
}

async function start(by, inputs) {
  const u = new URL(inputs.url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('The address must be http or https');
  const want = { url: u.href, width: inputs.width || 1280, height: inputs.height || 800, theme: inputs.theme || 'light' };
  const name = slot(by);
  const b = live.get(name);
  // the same size and theme: open the address in a new tab of the browser it already has
  if (b && b.width === want.width && b.height === want.height && b.theme === want.theme && (await version(b.port))) {
    await fetch(`http://127.0.0.1:${b.port}/json/new?${want.url}`, { method: 'PUT' });
    b.changedAt = Date.now();
    return answer(b, true);
  }
  if (b) await stop(by);
  const port = portFor(name);
  if (await version(port)) throw new Error(`Port ${port} is taken by another program: stop it, or the human frees that port`);
  const proc = launch(name, port, want);
  const nb = { proc, port, ...want, seen: '', changedAt: Date.now() };
  live.set(name, nb);
  const failed = new Promise((res) => { proc.once('error', (e) => res(e.message)); proc.once('exit', (c) => res(`Chrome exited (${c}) before it was ready`)); });
  proc.once('exit', () => { if (live.get(name) === nb) { live.delete(name); forget(name); } });
  let ready = false;
  for (let i = 0; i < 75 && !ready; i++) {
    const why = await Promise.race([failed, sleep(200).then(() => null)]);
    if (why) { live.delete(name); throw new Error(`${why}${connection.chrome ? '' : ` (looked for ${CHROME}; set Chrome in the connection)`}`); }
    ready = !!(await version(port));
  }
  if (!ready) { proc.kill(); throw new Error('Chrome did not open its DevTools port in 15 s'); }
  const s = readState();
  s[name] = { port, pid: proc.pid };
  writeState(s);
  return answer(nb, false);
}
const answer = (b, reused) => ({
  message: `${reused ? 'Your browser opened' : 'Your browser is up at'} ${b.url} (${b.width}×${b.height}, ${b.theme}). Attach with --cdp-endpoint http://127.0.0.1:${b.port}`,
  devtools: `http://127.0.0.1:${b.port}`, port: b.port, url: b.url, width: b.width, height: b.height, theme: b.theme, reused,
  idleMinutes: idleMinutes(), attach: `--cdp-endpoint http://127.0.0.1:${b.port}`,
});
function forget(name) { const s = readState(); if (s[name]) { delete s[name].pid; writeState(s); } }

async function stop(by) {
  const name = slot(by);
  const b = live.get(name);
  if (!b) return { message: 'You have no browser running', stopped: false };
  live.delete(name);
  const gone = new Promise((r) => { b.proc.once('exit', r); setTimeout(r, 5000).unref(); });
  b.proc.kill();
  await gone;
  forget(name);
  return { message: 'Your browser is closed', stopped: true };
}

// A browser whose pages (their addresses and titles) haven't changed for the idle time closes itself
const idleMinutes = () => Number(connection.idleMinutes) || DEFAULT_IDLE_MIN;
async function sweep() {
  for (const [name, b] of live) {
    const list = await pages(b.port);
    const seen = JSON.stringify((list || []).map((p) => [p.url, p.title]));
    if (seen !== b.seen) { b.seen = seen; b.changedAt = Date.now(); continue; }
    if (Date.now() - b.changedAt >= idleMinutes() * 60_000) { log(`closing ${name}'s browser: idle ${idleMinutes()} min`); await stop({ kind: 'agent', name }); }
  }
}
setInterval(() => { sweep().catch((e) => log('sweep:', e.message)); }, 30_000).unref();

// A plugin process the board killed can't close its browsers: the next one does, before anything else
async function reap() {
  const s = readState();
  for (const [name, b] of Object.entries(s)) {
    if (!b.pid) continue;
    if (await version(b.port)) { try { process.kill(b.pid); log(`closed ${name}'s browser left from before (pid ${b.pid})`); } catch { /* already gone */ } }
    delete b.pid;
  }
  writeState(s);
}
const reaped = reap().catch((e) => log('reap:', e.message));

async function test() {
  // a throwaway browser on the last port: proves Chrome launches from here and opens DevTools
  const t = await start({ kind: 'system', name: 'connection-test' }, { url: 'http://127.0.0.1:1/' }).catch((e) => ({ error: e.message }));
  if (t.error) throw new Error(t.error);
  const v = await version(t.port);
  await stop({ kind: 'system', name: 'connection-test' });
  return { message: `Chrome launches: ${v?.Browser || 'unknown version'}` };
}

async function handle(m) {
  await reaped;
  connection = m.connection || {};
  try {
    let result;
    if (m.type === 'test') result = await test();
    else if (m.type === 'run' && m.action === 'start') result = await start(m.by || { kind: 'user', name: 'human' }, m.inputs || {});
    else if (m.type === 'run' && m.action === 'stop') result = await stop(m.by || { kind: 'user', name: 'human' });
    else throw new Error(`No ${m.type} ${m.action || ''} here`);
    send({ id: m.id, ok: true, result });
  } catch (e) { send({ id: m.id, ok: false, error: e.message }); }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(JSON.parse(line)); }
});
// the board closed the channel (disabled, removed, stopping): take every browser down with us
process.stdin.on('end', async () => { for (const name of [...live.keys()]) await stop({ kind: 'agent', name }).catch(() => {}); process.exit(0); });
