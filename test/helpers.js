// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Starts a real server on a throwaway data folder and talks to it over HTTP, the way agents and the UI do.
// Tests only depend on the public API, so they keep passing while the code behind it is reorganised.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// opts: { manifest, agents (agents.json content), dir (reuse a stopped server's folder, e.g. to simulate a reboot) }
// The environment for a child process, without the caller's own board identity: run inside an agent's
// session, INTELLAGENT_AGENT, its token and its run would otherwise leak into the servers and CLIs under test.
const cleanEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('INTELLAGENT_'))), ...extra });

// A port the OS has just handed out: it never gives the same one to two callers while both are alive,
// which a random number in a range cannot promise (the suite starts dozens of servers in parallel).
function freePort() {
  return new Promise((resolve, reject) => {
    const s = require('net').createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// The port is free when asked for but the server binds it a moment later: on the rare clash
// (EADDRINUSE in the log) start again on a new one. Any other failure keeps its log.
async function startServer(opts = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await startOnce(opts); } catch (e) {
      if (attempt >= 3 || !/EADDRINUSE/.test(e.message)) throw e;
    }
  }
}

async function startOnce({ manifest = {}, agents, dir } = {}) {
  dir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'ia-test-'));
  const port = await freePort();
  const mp = path.join(dir, 'intellagent.manifest.json');
  fs.writeFileSync(mp, JSON.stringify({ port, dataDir: './data', seed: 'empty', template: 'default', idPrefix: 'T', ...manifest }));
  if (agents) fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents, null, 2));
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: cleanEnv({ INTELLAGENT_MANIFEST: mp, INTELLAGENT_PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api`)).ok) break; } catch { /* not up yet */ }
    if (i > 100 || proc.exitCode != null) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  // as: { agent: 'name' } | { user: 'name' }
  async function api(method, p, body, as = { agent: 'tester' }) {
    const headers = { 'content-type': 'application/json' };
    if (as.agent) headers['x-agent'] = as.agent;
    if (as.user) { headers['x-user'] = as.user; headers.origin = base; }
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
  }
  // Like api() but throws unless 2xx — keeps the happy-path steps short.
  async function ok(method, p, body, as) {
    const r = await api(method, p, body, as);
    if (r.status >= 300) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  // keep: leave the folder so a new server can start on it. hard: kill without a clean shutdown (power cut).
  async function stop({ keep = false, hard = false } = {}) {
    proc.kill(hard ? 'SIGKILL' : 'SIGTERM');
    await new Promise((r) => (proc.exitCode != null ? r() : proc.on('exit', r)));
    if (keep) return;
    // data files are read-only by design; make them writable so the temp folder can go
    const unlock = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) unlock(p); else fs.chmodSync(p, 0o666); } };
    try { unlock(dir); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  return { base, api, ok, stop, dir, log: () => log };
}

// Polls fn until it returns something truthy.
async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const USER = { user: 'James' };
module.exports = { cleanEnv, startServer, freePort, until, USER };
