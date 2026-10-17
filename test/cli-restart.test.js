'use strict';
// intellagent restart: the human's, stops whichever board runs this project, starts it detached and prints its address (INT-299).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { startServer, cleanEnv } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const GUARD = { INTELLAGENT_RUN_GUARD_BIN: path.join(os.tmpdir(), 'ia-test-guard-bin') };
function cli(args, { cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'intellagent.js'), ...args], { cwd, env: cleanEnv(env), encoding: 'utf8', input: '', timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('intellagent restart', () => {
  it('is refused for an agent, and the board keeps running', async () => {
    const s = await startServer();
    try {
      const r = cli(['restart'], { cwd: s.dir, env: { INTELLAGENT_AGENT: 'ada' } });
      assert.equal(r.code, 1);
      assert.match(r.err, /error 403 HUMAN_ONLY: intellagent restart is the human's/);
      assert.equal((await s.api('GET', '/api/app')).status, 200, 'still up');
    } finally { await s.stop(); }
  });

  it('stops the running board, starts it detached and prints the address; a second restart gives a new process', async () => {
    const s = await startServer();
    const pidFile = path.join(s.dir, 'data', 'server.pid');
    const before = Number(fs.readFileSync(pidFile, 'utf8'));
    let after = null;
    try {
      const r = cli(['restart'], { cwd: s.dir, env: GUARD });
      assert.equal(r.code, 0, r.err);
      const m = r.out.match(/^Running at (http:\/\/127\.0\.0\.1:\d+)/m);
      assert.ok(m, r.out);
      assert.equal(m[1], s.base, 'the same address');
      assert.equal((await fetch(`${s.base}/api/app`)).ok, true, 'answers once the command returns');
      after = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.notEqual(after, before, 'a new server process');
      assert.throws(() => process.kill(before, 0), /ESRCH/, 'the old one is gone');
    } finally {
      if (after) cli(['stop'], { cwd: s.dir, env: GUARD });
      // the test's own server was stopped by restart, so s.stop() would wait for an exit that already came: clean up here
      const unlock = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) unlock(p); else fs.chmodSync(p, 0o666); } };
      try { unlock(s.dir); fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});

describe('intellagent init in a folder that already has a board (INT-325)', () => {
  it('names the board there, says it was left alone and what to do next; the exit code stays 0', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-init-'));
    const env = { INTELLAGENT_AGENT: 'ada' };
    try {
      const first = cli(['init', dir, '--name', 'Docs Site', '--prefix', 'DOC', '--template', 'simple'], { cwd: dir, env });
      assert.equal(first.code, 0, first.err);
      const manifest = path.join(dir, '.intellagent', 'intellagent.manifest.json');
      const before = fs.readFileSync(manifest, 'utf8');
      const again = cli(['init', dir, '--name', 'Other', '--prefix', 'OTH'], { cwd: dir, env });
      assert.equal(again.code, 0);
      assert.match(again.out, /Already initialised: /);
      assert.match(again.out, /That board is "Docs Site" \(prefix DOC, port \d+\)\. init leaves it alone/);
      assert.match(again.out, /another folder/);
      assert.match(again.out, /intellagent status/);
      assert.equal(fs.readFileSync(manifest, 'utf8'), before, 'the manifest is untouched');
    } finally {
      // init makes the board's data read-only: unlock it before removing the folder
      const unlock = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) unlock(p); else fs.chmodSync(p, 0o666); } };
      try { unlock(dir); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});
