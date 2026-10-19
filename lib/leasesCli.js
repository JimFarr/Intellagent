'use strict';
// `intellagent leases …` — the machine's lease program (leases-server.js) from the command line.
// Prints JSON on stdout, like `intellagent api`. Starts the program in the background when it is not running.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { readManifest } = require('./locate');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.INTELLAGENT_LEASES_PORT) || 7499;
const URL_ = `http://127.0.0.1:${PORT}`;
const LOG = path.join(os.homedir(), '.intellagent', 'leases.log');

const USAGE = `intellagent leases — the machine's leases for heavy work (one program per PC, every board shares it)

  status                      capacity, ceiling, what is in use (the floor), live and recent leases
  machine                     what the processor and the graphics card are doing now
  ask --holder NAME [--board NAME] [--cpu THREADS] [--gpu MB] [--minutes N] [--exclusive] [--ticket ID] [--purpose "…"]
                              yes with a lease, or no with why and when room frees (holder defaults to INTELLAGENT_AGENT,
                              board to this board's name)
  renew ID [--minutes N]      keep a lease (it ends by itself when its time is up)
  done ID                     end a lease
  ceiling [--cpu THREADS] [--gpu MB]   the most that may be leased at once
  reap PID                    stop a process an agent left running ("machine" marks them agent: true); nothing else
  start | stop | serve        run it in the background, stop it, or run it here
`;

const { flags } = require('./cliutil');

async function alive() {
  try { return (await fetch(`${URL_}/status`)).ok; } catch { return false; }
}

async function start() {
  if (await alive()) return false;
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const log = fs.openSync(LOG, 'a');
  spawn(process.execPath, [path.join(ROOT, 'leases-server.js')], { detached: true, windowsHide: true, stdio: ['ignore', log, log] }).unref();
  for (let i = 0; i < 80; i++) { if (await alive()) return true; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`The lease program did not start; see ${LOG}`);
}

async function call(method, p, body) {
  await start();
  const r = await fetch(URL_ + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`error ${r.status}${out.code ? ` ${out.code}` : ''}: ${out.error || r.statusText}${out.hint ? ` — hint: ${out.hint}` : ''}`), { exit: 1 });
  return out;
}

const num = (v) => (v === undefined || v === true ? undefined : Number(v));
// --exclusive, --exclusive=true → true; --exclusive=false|no|0 → false (a bare string would be truthy)
const yes = (v) => v === true || /^(true|yes|1)$/i.test(String(v ?? ''));

async function leases(args) {
  const [sub = 'help', ...rest] = args;
  const f = flags(rest);
  const print = (o) => console.log(JSON.stringify(o, null, 2));
  switch (sub) {
    case 'serve': return require('../leases-server.js');
    case 'start': return console.log((await start()) ? `started on ${URL_}` : `already running on ${URL_}`);
    case 'stop': {
      if (!(await alive())) return console.log('not running');
      await fetch(`${URL_}/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json' } });
      return console.log('stopped');
    }
    case 'status': return print(await call('GET', '/status'));
    case 'machine': return print(await call('GET', '/machine'));
    case 'ask': return print(await call('POST', '/ask', {
      holder: f.holder || process.env.INTELLAGENT_AGENT,
      board: (typeof f.board === 'string' && f.board) || boardName(),
      cpu: num(f.cpu) ?? 0, gpuMB: num(f.gpu) ?? 0, minutes: num(f.minutes) ?? 15,
      exclusive: yes(f.exclusive), ticket: f.ticket || null, purpose: f.purpose || '',
    }));
    case 'renew': return print(await call('POST', `/leases/${need(f._[0])}/renew`, { minutes: num(f.minutes) ?? 15 }));
    case 'done': return print(await call('POST', `/leases/${need(f._[0])}/done`, {}));
    case 'reap': return print(await call('POST', '/reap', { pid: Number(need(f._[0])) }));
    case 'ceiling': return print(await call('PUT', '/ceiling', { cpu: num(f.cpu), gpuMB: num(f.gpu) }));
    default: return process.stdout.write(USAGE);
  }
}

// The board this CLI belongs to (the nearest manifest's app name), so the program can tell two boards'
// natashas apart. None outside a board: the lease is then recorded under the bare holder name.
function boardName() {
  const m = readManifest();
  return m ? m.appName || path.basename(path.dirname(m.path)) : null;
}

function need(id) {
  if (!id) throw Object.assign(new Error('Which lease? Give its id, e.g. L12'), { exit: 2 });
  return id;
}

module.exports = { leases, USAGE };
