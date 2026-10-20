'use strict';
// Sandbox boards: a throwaway Intellagent board per agent, for trying changes to Intellagent itself (or
// reproducing what the human saw) without touching the real board.
//
//   <board folder>/sandboxes/<agent>/      the sandbox's own manifest, local.json and data (git-ignored)
//   <board folder>/sandboxes/ports.json    each agent keeps its port (7431, 7432, …) across restarts
//
// A sandbox runs the server from any checkout — main, or an agent's worktree — so an agent can see its own
// branch running. It is safe by construction: `sandbox: true` in its manifest stops standing agents from
// ever running there, it has no agents.json, its user token is its own (never the human's), and the
// environment of the agent that started it (INTELLAGENT_*) is not passed on.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { readManifest, projectOf } = require('./locate');
const jsonfile = require('./jsonfile');

// Real sandboxes count up from 7431. The test suite sets INTELLAGENT_SANDBOX_FIRST_PORT to a range of its
// own, so a test board can never take the port of a live sandbox that is mid-restart.
const FIRST_PORT = Number(process.env.INTELLAGENT_SANDBOX_FIRST_PORT) || 7431;
const RESERVED = new Set([7499]); // the machine's lease program
const NAME_RE = /^(?!\.{1,2}$)[\w.-]{1,64}$/; // "." and ".." would be the sandboxes folder or the board itself
const SEEDS = ['board', 'demo', 'empty', 'snapshot'];

const rootOf = (mp) => path.join(path.dirname(mp), 'sandboxes');
const dirOf = (mp, name) => path.join(rootOf(mp), name);
const readJson = jsonfile.readOr;
const writeJson = (f, v) => fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);

const { portFree, alive: appOf } = require('./cliutil');
const alive = async (url) => Boolean(await appOf(url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The folder holding .worktrees for this board — the same rule the server uses.
function worktreesDir(mp, m = readManifest(mp)) {
  return path.basename(path.dirname(mp)) === '.intellagent' || m?.projectRoot ? path.join(path.dirname(mp), 'worktrees') : path.join(projectOf(mp, m), '.worktrees');
}

// Which code the sandbox runs: "main" (the board's own checkout, or the installed Intellagent when the
// project is something else), an agent's worktree by name, or a folder.
function sourceFor(mp, from = 'main', installed = path.join(__dirname, '..')) {
  const m = readManifest(mp);
  const has = (d) => fs.existsSync(path.join(d, 'server.js'));
  let dir;
  if (from === 'main') dir = has(projectOf(mp, m)) ? projectOf(mp, m) : installed;
  else if (NAME_RE.test(from) && fs.existsSync(path.join(worktreesDir(mp, m), from))) dir = path.join(worktreesDir(mp, m), from);
  else dir = path.resolve(String(from));
  if (!has(dir)) throw new Error(`No Intellagent server in ${dir} (looked for server.js). --from takes main, an agent's name (its worktree) or a folder.`);
  return dir;
}

// Each agent keeps one port; a new one gets the first free port from 7431 that no other sandbox has.
// When the range is full, the port of the sandbox that has been stopped the longest (it stopped itself when idle,
// or was stopped, over a minute ago, and says so in data/stopped.json) goes back to the pool: its data stays, and
// it gets a new port when started again. One per start, and never a sandbox that is starting or has no record.
async function portFor(mp, name) {
  const file = path.join(rootOf(mp), 'ports.json');
  const ports = readJson(file, {});
  if (ports[name]) return ports[name];
  const pick = async () => {
    const taken = new Set(Object.values(ports));
    for (let p = FIRST_PORT; p < FIRST_PORT + 200; p++) {
      if (!taken.has(p) && !RESERVED.has(p) && await portFree(p)) return p;
    }
    return null;
  };
  let p = await pick();
  if (!p) {
    let oldest = null;
    for (const [n, port] of Object.entries(ports)) {
      const at = Date.parse(readJson(path.join(dirOf(mp, n), 'data', 'stopped.json'), {}).at);
      if (!at || Date.now() - at < 60_000 || (oldest && at >= oldest.at)) continue;
      if (!(await alive(`http://127.0.0.1:${port}`))) oldest = { n, at };
    }
    if (oldest) { delete ports[oldest.n]; p = await pick(); }
  }
  if (!p) throw new Error(`No free port for a sandbox: ${Object.keys(ports).length} sandboxes are running in ${FIRST_PORT}-${FIRST_PORT + 199}. Stop the ones you do not use: intellagent sandbox stop NAME | --all`);
  ports[name] = p;
  writeJson(file, ports);
  return p;
}

const pidOf = (dir) => Number(readJson(path.join(dir, 'data', 'server.pid'), 0)) || null;
const kill = (pid) => require('./kill').killTree(pid);

// Copy the real board's tickets (not its events, backups, agent runs or secrets), and make the copies
// writable: the real board keeps its files read-only.
function copySnapshot(mp, data) {
  const m = readManifest(mp);
  const real = path.resolve(path.dirname(mp), m?.dataDir || './data');
  fs.mkdirSync(data, { recursive: true });
  for (const f of ['app.json', 'profiles.json']) if (fs.existsSync(path.join(real, f))) fs.copyFileSync(path.join(real, f), path.join(data, f));
  if (fs.existsSync(path.join(real, 'boards'))) {
    fs.cpSync(path.join(real, 'boards'), path.join(data, 'boards'), { recursive: true, filter: (src) => path.basename(src) !== 'backups' });
  }
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else fs.chmodSync(p, 0o644); } };
  walk(data);
}

// Copy the real board's shape (columns and their flags, fields, ticket templates, rules, id prefix) but none
// of its tickets, archive, requests or digest: what `intellagent init` set up, without the work.
// Returns the names of the boards copied (none when the real board has no data yet).
function copyBoardShape(mp, data) {
  const m = readManifest(mp);
  const src = path.join(path.resolve(path.dirname(mp), m?.dataDir || './data'), 'boards');
  const copied = [];
  if (!fs.existsSync(src)) return copied;
  for (const id of fs.readdirSync(src)) {
    const real = readJson(path.join(src, id, 'board.json'), null);
    if (!real) continue;
    const dir = path.join(data, 'boards', id);
    fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
    const board = { ...real, nextNumber: 1, items: {}, digest: [], requests: [], columns: (real.columns || []).map((c) => ({ ...c, itemIds: [] })) };
    fs.writeFileSync(path.join(dir, 'board.json'), `${JSON.stringify(board, null, 2)}\n`);
    copied.push(real.name || id);
  }
  return copied;
}

// Stops the sandbox <name> and says what happened: { name, port, stopped, code, reason }. When it did not
// stop, code says why: NO_SANDBOX (no such name), NOT_RUNNING (nothing answers on its port), NOT_A_SANDBOX
// (the board there says it is not one: left alone), NO_PID (no process holds the port and server.pid is
// missing), KILL_FAILED, STILL_RUNNING (told to stop, but the port is still taken).
async function stop(mp, name) {
  const dir = dirOf(mp, name);
  const port = readJson(path.join(rootOf(mp), 'ports.json'), {})[name] || null;
  const out = (stopped, code, reason) => ({ name, port, stopped, code, reason });
  const forget = () => { try { fs.rmSync(path.join(dir, 'data', 'server.pid')); } catch { /* none */ } };
  if (!port) return out(false, 'NO_SANDBOX', `no sandbox named ${name} (intellagent sandbox list)`);
  const app = await appOf(`http://127.0.0.1:${port}`);
  // Nothing answers: whatever server.pid names (a reboot leaves a stale one) is not this sandbox.
  if (!app) { forget(); return out(false, 'NOT_RUNNING', `nothing answers on port ${port}`); }
  // The process that holds the port is the one to stop. server.pid can be missing, or name another process
  // (a restart that lost it, a reboot), and then `list` sees the board while a stop by pid would find nothing.
  // Only when the board on the port says it is a sandbox: never kill a real board or whatever else holds the port.
  if (!app.sandbox) return out(false, 'NOT_A_SANDBOX', `the board on port ${port} is not a sandbox, so it is left alone`);
  const pid = require('./kill').pidOnPort(port) || pidOf(dir);
  if (!pid) return out(false, 'NO_PID', `no process is found holding port ${port}, and ${name} has no server.pid`);
  if (!kill(pid)) return out(false, 'KILL_FAILED', `process ${pid} on port ${port} could not be stopped`);
  for (let i = 0; i < 40 && !(await portFree(port)); i++) await sleep(100);
  if (!(await portFree(port))) return out(false, 'STILL_RUNNING', `process ${pid} was told to stop, but port ${port} is still taken`);
  forget();
  try { writeJson(path.join(dir, 'data', 'stopped.json'), { at: new Date().toISOString(), reason: 'stopped with sandbox stop' }); } catch { /* no data folder */ }
  return out(true, 'STOPPED', `stopped (port ${port})`);
}

// Start (or restart, to pick up new code) the sandbox for <name>. Data is kept between restarts unless
// fresh is set or a seed is asked for.
async function start(mp, name, { from = 'main', seed = null, fresh = false, keep = null, idleHours = null } = {}) {
  if (!NAME_RE.test(name)) throw refuse(`"${name}" is not a valid agent name`, 'BAD_REQUEST', 'a name is letters, digits, dot, dash or underscore (at most 64), and not . or ..');
  if (seed && !SEEDS.includes(seed)) throw new Error(`--seed takes ${SEEDS.join(', ')}`);
  const source = sourceFor(mp, from);
  const root = rootOf(mp);
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(path.join(root, '.gitignore'))) fs.writeFileSync(path.join(root, '.gitignore'), '*\n');
  const dir = dirOf(mp, name);
  const data = path.join(dir, 'data');
  await stop(mp, name);
  if ((fresh || seed) && fs.existsSync(data)) fs.rmSync(data, { recursive: true, force: true });
  const firstRun = !fs.existsSync(data);
  // a restart keeps how it was seeded
  // a new sandbox starts from the board init set up when there is one, else the demo
  const before = readJson(path.join(dir, 'intellagent.manifest.json'), {});
  const kept = before.sandboxSeed;
  const realData = path.resolve(path.dirname(mp), (readManifest(mp) || {}).dataDir || './data');
  const kind = seed || kept || (fs.existsSync(path.join(realData, 'boards')) ? 'board' : 'demo');
  const port = await portFor(mp, name);
  if (!(await portFree(port))) throw new Error(`Port ${port} (${name}'s sandbox) is in use by something else`);
  const real = readManifest(mp) || {};
  fs.mkdirSync(dir, { recursive: true });
  // "Nebula's Board": a sandbox always says whose it is, so it is never mistaken for the real board in a browser tab
  const title = `${name.charAt(0).toUpperCase()}${name.slice(1)}'s Board`;
  writeJson(path.join(dir, 'intellagent.manifest.json'), {
    appName: title,
    boardName: title,
    sandbox: true, // standing agents never run here
    sandboxSeed: kind,
    idPrefix: kind === 'snapshot' || kind === 'board' ? real.idPrefix || 'INT' : 'SBX',
    seed: kind === 'demo' ? 'demo' : 'empty',
    template: real.template || 'default',
    host: '127.0.0.1',
    port,
    dataDir: './data',
    readonlyData: false,
    auth: { requireAgentTokens: false },
    defaultAgent: name,
    projectRoot: source,
    staleWorkMinutes: 0,
    // a sandbox nobody uses stops itself after sandboxIdleHours; sandboxKeep exempts it; a restart keeps both
    sandboxKeep: keep ?? Boolean(before.sandboxKeep),
    sandboxIdleHours: idleHours ?? before.sandboxIdleHours ?? 4,
  });
  try { fs.rmSync(path.join(data, 'stopped.json')); } catch { /* none */ }
  const local = readJson(path.join(dir, 'local.json'), {});
  if (!local.userToken) writeJson(path.join(dir, 'local.json'), { userToken: crypto.randomBytes(18).toString('base64url') });
  if (firstRun && kind === 'snapshot') copySnapshot(mp, data);
  let shapeFrom = null;
  if (firstRun && kind === 'board') {
    const names = copyBoardShape(mp, data);
    if (!names.length) throw new Error('--seed board needs the real board to have data (start the board once, or use --seed demo|empty)');
    shapeFrom = names.join(', ');
  }
  fs.mkdirSync(data, { recursive: true });
  const log = fs.openSync(path.join(data, 'server.log'), 'a');
  // Nothing of the starting agent's board identity leaks in: the sandbox is its own board. (NODE_TEST_CONTEXT:
  // started from node --test, the server would otherwise run as a test-runner child.)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('INTELLAGENT_') && k !== 'NODE_TEST_CONTEXT'));
  const child = spawn(process.execPath, [path.join(source, 'server.js')], {
    cwd: dir, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    env: { ...env, INTELLAGENT_MANIFEST: path.join(dir, 'intellagent.manifest.json') },
  });
  child.unref();
  const url = `http://127.0.0.1:${port}`;
  // Ours answers only when the server on the port is the one just spawned: it writes its own pid to
  // data/server.pid once it is up, and a server that lost the port to another board has exited.
  const ours = async () => pidOf(dir) === child.pid && (await alive(url));
  for (let i = 0; i < 80; i++) { if (await ours()) break; await sleep(125); }
  if (!(await ours())) {
    const tail = fs.readFileSync(path.join(data, 'server.log'), 'utf8').split('\n').slice(-15).join('\n');
    throw new Error(`The sandbox did not start. Its log (${path.join(data, 'server.log')}):\n${tail}`);
  }
  const token = readJson(path.join(dir, 'local.json'), {}).userToken;
  return { name, url, signIn: `${url}/#token=${token}`, port, source, seed: firstRun ? kind : 'kept', from: shapeFrom, dir };
}

async function list(mp) {
  const ports = readJson(path.join(rootOf(mp), 'ports.json'), {});
  const out = [];
  for (const [name, port] of Object.entries(ports)) {
    const dir = dirOf(mp, name);
    const m = readJson(path.join(dir, 'intellagent.manifest.json'), {});
    const running = await alive(`http://127.0.0.1:${port}`);
    out.push({ name, port, url: `http://127.0.0.1:${port}`, running, source: m.projectRoot || null, keep: Boolean(m.sandboxKeep), idleHours: m.sandboxIdleHours ?? 4, stopped: running ? null : readJson(path.join(dir, 'data', 'stopped.json'), null) });
  }
  return out;
}

// `sandbox exec <name> -- <args…>`: the CLI of the code the sandbox runs (its projectRoot), pointed at the
// sandbox's own board and acting as the sandbox's human. Returns what to spawn, or throws with { code, hint }.
// Nothing of the caller's INTELLAGENT_* reaches it (no real board URL or token), it may not be told another
// board (--url, --as, --manifest), and commands that start, stop or write things outside the sandbox are refused
// (leases: the machine-wide lease program every board shares).
const EXEC_REFUSED = ['start', 'stop', 'merge', 'autostart', 'token', 'hook', 'skill', 'link', 'project', 'sandbox', 'watch', 'mcp', 'leases'];
const EXEC_REDIRECTS = ['--url', '--as', '--manifest'];
const refuse = (message, code, hint) => Object.assign(new Error(message), { code, hint });

async function execPlan(mp, name, args, { tmp = require('os').tmpdir() } = {}) {
  if (!NAME_RE.test(String(name || ''))) throw refuse('sandbox exec needs the sandbox name', 'BAD_REQUEST', 'intellagent sandbox exec <name> -- <command…>   (names: intellagent sandbox list)');
  if (!args.length) throw refuse('sandbox exec needs a command after --', 'BAD_REQUEST', `intellagent sandbox exec ${name} -- preset list`);
  const dir = dirOf(mp, name);
  const manifestFile = path.join(dir, 'intellagent.manifest.json');
  const m = readJson(manifestFile, null);
  if (!m || !m.sandbox) throw refuse(`There is no sandbox called ${name}`, 'NOT_FOUND', `intellagent sandbox ${name} --from <author>   (or intellagent sandbox list)`);
  const url = `http://127.0.0.1:${m.port}`;
  if (!(await alive(url))) throw refuse(`${name}'s sandbox is not running`, 'NOT_FOUND', `intellagent sandbox ${name} --from ${path.basename(String(m.projectRoot || 'main'))}`);
  const script = path.join(String(m.projectRoot || ''), 'bin', 'intellagent.js');
  if (!fs.existsSync(script)) throw refuse(`${name}'s sandbox runs code with no bin/intellagent.js (${m.projectRoot})`, 'NOT_FOUND', `intellagent sandbox ${name} --from <author>`);
  const bad = args.find((a) => EXEC_REDIRECTS.some((f) => a === f || a.startsWith(`${f}=`)));
  if (bad) throw refuse(`${bad} is not allowed in sandbox exec: it always talks to ${name}'s sandbox`, 'FORBIDDEN', 'drop the flag');
  const [sub] = args;
  if (EXEC_REFUSED.includes(sub)) throw refuse(`${sub} is not allowed in sandbox exec: it would start, stop or change something outside the sandbox`, 'FORBIDDEN', `run it yourself; exec is for trying what the author changed on ${name}'s board`);
  if (sub === 'init') {
    // init makes a new board in a folder: only in the temp folder, and never started or tied to this project
    const where = path.resolve(args.slice(1).find((a) => !a.startsWith('-')) || '.');
    const inTmp = !path.relative(path.resolve(tmp), where).startsWith('..') && !path.isAbsolute(path.relative(path.resolve(tmp), where));
    if (!inTmp) throw refuse(`init in sandbox exec only works in the temp folder (${tmp})`, 'FORBIDDEN', 'give init a folder under it: init <tmp>/x --preset … --yes');
    args = [...args, '--no-start', '--no-mcp', '--no-claude'];
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('INTELLAGENT_') && k !== 'NODE_TEST_CONTEXT'));
  // no INTELLAGENT_AGENT: its human-only commands run as its human, with the sandbox's own token
  return { command: process.execPath, args: [script, ...args], env: { ...env, INTELLAGENT_MANIFEST: manifestFile }, url, source: m.projectRoot };
}

module.exports = { start, stop, list, sourceFor, rootOf, execPlan, SEEDS };
