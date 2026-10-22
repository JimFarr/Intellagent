'use strict';
// intellagent restart: the human's, stops whichever board runs this project, starts it detached and prints its address (INT-299).
const { describe, it, after } = require('node:test');
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

describe('a board on code from an agent worktree (INT-405)', () => {
  const { foreignCode } = require('../lib/locate');
  it('is foreign only when the code is a linked worktree that is not the board\'s own project', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-foreign-'));
    try {
      const wt = path.join(dir, 'Intellagent', '.worktrees', 'warlock');
      const main = path.join(dir, 'Intellagent');
      const lenza = path.join(dir, 'Lenza', '.intellagent', 'intellagent.manifest.json');
      fs.mkdirSync(wt, { recursive: true });
      fs.mkdirSync(path.join(main, '.git'));
      fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../../.git/worktrees/warlock\n');
      fs.mkdirSync(path.dirname(lenza), { recursive: true });
      fs.writeFileSync(lenza, '{}');
      assert.equal(foreignCode(wt, lenza), true, 'another project\'s board on a worktree');
      assert.equal(foreignCode(main, lenza), false, 'the main checkout is an installation');
      const sbx = path.join(dir, 'sbx.json');
      fs.writeFileSync(sbx, JSON.stringify({ sandbox: true, projectRoot: wt.toUpperCase() }));
      assert.equal(foreignCode(wt, sbx), false, 'a sandbox --from that worktree');
      assert.equal(foreignCode(path.join(dir, 'nowhere'), lenza), false, 'no .git at all (an npm install)');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  // only where this suite itself runs from a worktree (every agent's run): a live board outside the temp folder
  const live = fs.mkdtempSync(path.join(ROOT, '.ia-int405-'));
  const mp = path.join(live, 'intellagent.manifest.json');
  fs.writeFileSync(mp, JSON.stringify({ port: 1, dataDir: './data' }));
  after(() => fs.rmSync(live, { recursive: true, force: true }));
  it('start, start --background and restart refuse it before touching the board', { skip: !foreignCode(ROOT, mp) && 'the suite runs from the main checkout' }, () => {
    for (const args of [['start'], ['start', '--background'], ['restart']]) {
      const r = cli(args, { cwd: live, env: GUARD });
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.out}`);
      assert.match(r.err, /error 403 FORBIDDEN: .* is an agent's worktree, and .* is a live board — hint: .*intellagent sandbox/);
      assert.ok(!fs.existsSync(path.join(live, 'data')), 'nothing written');
    }
  });
});

describe('intellagent init in a folder that already has a board (INT-325)', () => {
  it('names the board there, says it was left alone and what to do next; the exit code stays 0', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-init-'));
    const env = { INTELLAGENT_AGENT: 'ada' };
    try {
      // --no-start: without it init starts a real board, detached, that nothing stops (INT-374)
      const quiet = ['--no-start', '--no-open', '--no-mcp', '--no-claude'];
      const first = cli(['init', dir, '--name', 'Docs Site', '--prefix', 'DOC', '--template', 'simple', ...quiet], { cwd: dir, env });
      assert.equal(first.code, 0, first.err);
      const manifest = path.join(dir, '.intellagent', 'intellagent.manifest.json');
      const before = fs.readFileSync(manifest, 'utf8');
      const port = JSON.parse(before).port;
      assert.equal(await fetch(`http://127.0.0.1:${port}/api/app`).then(() => true, () => false), false, 'init left no board running on its port');
      assert.ok(!fs.existsSync(path.join(dir, '.intellagent', 'data', 'server.pid')), 'and no server.pid');
      const again = cli(['init', dir, '--name', 'Other', '--prefix', 'OTH', ...quiet], { cwd: dir, env });
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
