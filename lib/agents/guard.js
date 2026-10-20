'use strict';
// Runs end when the board dies (INT-262). A clean stop kills every run itself; this covers a board that dies
// (crash, killed from Task Manager, out of memory), whose runs would otherwise work on with nobody watching
// until the next start finds them through the pid list (proc.js leftovers, which stays as the backstop).
//   Windows   jobguard.cs, built once with the .NET Framework's csc.exe, holds a kill-on-close job for as long
//             as the board lives. Each run's command starts with the helper's "join", which puts the run's
//             cmd.exe in the job before cmd starts the run, so everything the run starts is born inside it.
//   elsewhere reaper.js, detached, is told each run's process group and ends them when the board's pipe closes.
// Nothing here ever blocks a run: if the helper can't be built or started, or dies, runs start as before and
// the board log says why, once.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const SRC = path.join(__dirname, 'jobguard.cs');

function findCsc() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const p = path.join(root, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// The helper for this source, built once into the board's data folder (which agents may not write to) and reused
// while its bytes still match the hash recorded when it was built; a changed source (the name carries its hash) or
// a changed exe builds a new one. cb(err, exe, built)
function buildHelper({ binDir, csc }, cb) {
  let exe, mark;
  try {
    exe = path.join(binDir, `jobguard-${sha(SRC).slice(0, 12)}.exe`);
    mark = `${exe}.sha256`;
    if (fs.existsSync(exe)) {
      if (fs.existsSync(mark) && fs.readFileSync(mark, 'utf8').trim() === sha(exe)) return cb(null, exe, false);
      fs.rmSync(exe, { force: true }); // not the exe this board built: build it again
    }
    fs.mkdirSync(binDir, { recursive: true });
  } catch (e) { return cb(e); }
  if (!csc || !fs.existsSync(csc)) return cb(new Error(`no csc.exe (looked for ${csc || 'the .NET Framework 4 compiler'})`));
  // two boards may build at once: each builds its own file, and the first rename wins
  const tmp = `${exe.slice(0, -4)}-${process.pid}-${Date.now()}.tmp.exe`;
  execFile(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${tmp}`, SRC], { windowsHide: true, timeout: 120_000 }, (err, stdout, stderr) => {
    if (err) {
      fs.rmSync(tmp, { force: true });
      const why = `${stdout || ''}${stderr || ''}`.trim().split(/\r?\n/).find(Boolean) || err.message;
      return cb(new Error(`building the helper with ${csc} failed: ${why}`));
    }
    try {
      const hash = sha(tmp);
      fs.renameSync(tmp, exe);
      fs.writeFileSync(mark, hash);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      if (!fs.existsSync(exe)) return cb(e);
    }
    cb(null, exe, true);
  });
}

/**
 * opts: { log, off (never start: a sandbox, or INTELLAGENT_RUN_GUARD=off), binDir (where the helper is built), csc (Windows) }
 */
function createGuard({ log = console.log, off = false, binDir = path.join(os.tmpdir(), 'intellagent-guard'), csc = findCsc() } = {}) {
  const win = process.platform === 'win32';
  let helper = null; // the helper process while it lives
  let exe = null;
  let job = null;
  let ready = false;
  let stopping = false;
  let failed = null;
  const say = (m) => log(`agents: run guard: ${m}`);
  const fallback = (why) => {
    ready = false;
    helper = null;
    if (failed || stopping) return;
    failed = why;
    say(`${why}. Runs start as before; if the board dies, the next start stops what it left behind`);
  };

  // A helper that ends or fails takes the guard down with it; its runs then die with it (Windows: the job closed).
  function watch(child, onReady) {
    helper = child;
    let err = '';
    child.on('error', (e) => fallback(`the helper did not start (${e.message})`));
    child.on('exit', (code) => fallback(`the helper exited (code ${code})${err.trim() ? `: ${err.trim().split(/\r?\n/)[0]}` : ''}`));
    child.stdin.on('error', () => {});
    child.stderr?.on('data', (d) => { err += d; });
    let out = '';
    child.stdout?.on('data', (d) => {
      out += d;
      if (!ready && /^ready\r?$/m.test(out)) { ready = true; onReady(); }
    });
    // the helper must never keep the board's process alive
    child.unref();
    for (const s of [child.stdin, child.stdout, child.stderr]) s?.unref?.();
  }

  function start() {
    if (off || helper || stopping) return;
    if (!win) {
      let child;
      try {
        child = spawn(process.execPath, [path.join(__dirname, 'reaper.js')], { detached: true, stdio: ['pipe', 'ignore', 'pipe'] });
      } catch (e) { return fallback(`the reaper did not start (${e.message})`); }
      watch(child, () => {});
      child.on('spawn', () => { ready = true; say('on (runs end with the board)'); });
      return;
    }
    buildHelper({ binDir, csc }, (err, built, fresh) => {
      if (err) return fallback(err.message);
      if (stopping) return;
      if (fresh) say(`built ${built}`);
      exe = built;
      job = `Local\\intellagent-runs-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      let child;
      try { child = spawn(exe, ['hold', String(process.pid), job], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return fallback(`the helper did not start (${e.message})`); }
      watch(child, () => say('on (runs end with the board)'));
    });
  }

  return {
    start,
    // Windows: the command a run's shell executes, with the helper's join first. "&" binds loosest in cmd, so
    // the run's own && and || stay together; the shell's exit code is the run's.
    wrap: (cmd) => (win && ready ? `"${exe}" join ${job} & ${cmd}` : cmd),
    // A run's process: Windows adds it to the job again (a run started before the guard was up, or whose join
    // failed); elsewhere the reaper learns its process group.
    add(child) {
      if (!helper || !child.pid) return;
      try { helper.stdin.write(win ? `${child.pid}\n` : `+${child.pid}\n`); } catch { /* the exit handler reports it */ }
    },
    remove(child) {
      if (win || !helper || !child.pid) return;
      try { helper.stdin.write(`-${child.pid}\n`); } catch { /* gone */ }
    },
    // A clean stop: the board has stopped its runs itself, so letting the helper go ends nothing new.
    stop() {
      stopping = true;
      ready = false;
      try { helper?.stdin.end(); } catch { /* gone */ }
    },
    status: () => ({ on: ready, why: failed }),
  };
}

module.exports = { createGuard };
