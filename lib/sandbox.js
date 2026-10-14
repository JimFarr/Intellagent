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
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { readManifest, projectOf } = require('./locate');

const FIRST_PORT = 7431;
const RESERVED = new Set([7499]); // the machine's lease program
const NAME_RE = /^[\w.-]{1,64}$/;
const SEEDS = ['demo', 'empty', 'snapshot'];

const rootOf = (mp) => path.join(path.dirname(mp), 'sandboxes');
const dirOf = (mp, name) => path.join(rootOf(mp), name);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return d; } };
const writeJson = (f, v) => fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
  s.listen(port, '127.0.0.1');
});
async function alive(url) {
  try { const r = await fetch(`${url}/api/app`); return r.ok; } catch { return false; }
}
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
async function portFor(mp, name) {
  const file = path.join(rootOf(mp), 'ports.json');
  const ports = readJson(file, {});
  if (ports[name]) return ports[name];
  const taken = new Set(Object.values(ports));
  for (let p = FIRST_PORT; p < FIRST_PORT + 200; p++) {
    if (taken.has(p) || RESERVED.has(p) || !(await portFree(p))) continue;
    ports[name] = p;
    writeJson(file, ports);
    return p;
  }
  throw new Error('No free port for a sandbox');
}

const pidOf = (dir) => Number(readJson(path.join(dir, 'data', 'server.pid'), 0)) || null;
function kill(pid) { try { process.kill(pid); return true; } catch { return false; } }

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

async function stop(mp, name) {
  const dir = dirOf(mp, name);
  const pid = pidOf(dir);
  if (!pid || !kill(pid)) return false;
  const port = readJson(path.join(rootOf(mp), 'ports.json'), {})[name];
  for (let i = 0; i < 40 && port && !(await portFree(port)); i++) await sleep(100);
  try { fs.rmSync(path.join(dir, 'data', 'server.pid')); } catch { /* gone */ }
  return true;
}

// Start (or restart, to pick up new code) the sandbox for <name>. Data is kept between restarts unless
// fresh is set or a seed is asked for.
async function start(mp, name, { from = 'main', seed = null, fresh = false } = {}) {
  if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a valid agent name`);
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
  const kind = seed || readJson(path.join(dir, 'intellagent.manifest.json'), {}).sandboxSeed || 'demo';
  const port = await portFor(mp, name);
  if (!(await portFree(port))) throw new Error(`Port ${port} (${name}'s sandbox) is in use by something else`);
  const real = readManifest(mp) || {};
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'intellagent.manifest.json'), {
    appName: 'Intellagent',
    boardName: `${name}'s sandbox`,
    sandbox: true, // standing agents never run here
    sandboxSeed: kind,
    idPrefix: kind === 'snapshot' ? real.idPrefix || 'INT' : 'SBX',
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
  });
  const local = readJson(path.join(dir, 'local.json'), {});
  if (!local.userToken) writeJson(path.join(dir, 'local.json'), { userToken: crypto.randomBytes(18).toString('base64url') });
  if (firstRun && kind === 'snapshot') copySnapshot(mp, data);
  fs.mkdirSync(data, { recursive: true });
  const log = fs.openSync(path.join(data, 'server.log'), 'a');
  // Nothing of the starting agent's board identity leaks in: the sandbox is its own board. (NODE_TEST_CONTEXT:
  // started from node --test, the server would otherwise run as a test-runner child.)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('INTELLAGENT_') && k !== 'NODE_TEST_CONTEXT'));
  spawn(process.execPath, [path.join(source, 'server.js')], {
    cwd: dir, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    env: { ...env, INTELLAGENT_MANIFEST: path.join(dir, 'intellagent.manifest.json') },
  }).unref();
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { if (await alive(url)) break; await sleep(125); }
  if (!(await alive(url))) {
    const tail = fs.readFileSync(path.join(data, 'server.log'), 'utf8').split('\n').slice(-15).join('\n');
    throw new Error(`The sandbox did not start. Its log (${path.join(data, 'server.log')}):\n${tail}`);
  }
  const token = readJson(path.join(dir, 'local.json'), {}).userToken;
  return { name, url, signIn: `${url}/#token=${token}`, port, source, seed: firstRun ? kind : 'kept', dir };
}

async function list(mp) {
  const ports = readJson(path.join(rootOf(mp), 'ports.json'), {});
  const out = [];
  for (const [name, port] of Object.entries(ports)) {
    const dir = dirOf(mp, name);
    const m = readJson(path.join(dir, 'intellagent.manifest.json'), {});
    out.push({ name, port, url: `http://127.0.0.1:${port}`, running: await alive(`http://127.0.0.1:${port}`), source: m.projectRoot || null });
  }
  return out;
}

module.exports = { start, stop, list, sourceFor, rootOf, SEEDS };
