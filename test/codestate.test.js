// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// The code the board runs, and how far main has moved on since it started (INT-319).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startServer, USER } = require('./helpers');
const { createCodeState } = require('../lib/codestate');

const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const commit = (dir, msg) => { fs.writeFileSync(path.join(dir, 'f.txt'), `${Math.random()}`); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); };

describe('code state (INT-319)', () => {
  it('is quiet when nothing landed since start, then counts the commits on main and names their tickets', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codestate-'));
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'first (INT-1)');
    const cs = createCodeState({ dir, mainBranch: () => 'main' });
    const head = git(dir, 'rev-parse', 'HEAD');
    await cs.refresh();
    let s = cs.snapshot();
    assert.equal(s.runningCommit, head);
    assert.equal(s.mainCommit, head);
    assert.equal(s.behind, 0);
    assert.equal(cs.line(), '', 'quiet');

    commit(dir, 'Fix the stack badge (INT-297)');
    commit(dir, 'Another one (INT-315) and INT-297 again');
    commit(dir, 'No ticket in this one');
    await cs.refresh();
    s = cs.snapshot();
    assert.equal(s.runningCommit, head, 'the running commit does not move');
    assert.equal(s.behind, 3);
    assert.deepEqual(s.behindTickets, ['INT-315', 'INT-297'], 'ids from the subjects, once each, newest first');
    assert.equal(s.behindCommits.length, 3);
    assert.match(cs.line(), /3 commits behind main \(INT-315, INT-297\)/);
    assert.match(cs.line(), /restarts the board/);
  });

  it('says nothing when the code is not a git checkout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-'));
    const cs = createCodeState({ dir, mainBranch: () => 'main' });
    await cs.refresh();
    const s = cs.snapshot();
    assert.equal(s.runningCommit, null);
    assert.equal(s.behind, null);
    assert.equal(cs.line(), '');
  });
});

describe('GET /api/app and the restart (INT-319)', () => {
  it('GET /api/app carries the commit the board runs; only the human restarts it', async () => {
    const s = await startServer();
    try {
      const app = await s.ok('GET', '/api/app', undefined, USER);
      assert.match(app.runningCommit, /^[0-9a-f]{40}$/);
      assert.ok(Number.isInteger(app.behind) && app.behind >= 0);
      assert.ok(Array.isArray(app.behindTickets));
      const r = await s.api('POST', '/api/app/restart', {}, { agent: 'tester' });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'HUMAN_ONLY');
      assert.ok(r.body.hint);
    } finally { await s.stop(); }
  });
  it('the human\'s restart brings the board back: the restart is not in the tree that stop kills', async () => {
    const s = await startServer();
    const { pidOnPort, killTree } = require('../lib/kill');
    const port = new URL(s.base).port;
    try {
      const before = pidOnPort(port);
      assert.deepEqual(await s.ok('POST', '/api/app/restart', {}, USER), { restarting: true });
      let after = null;
      for (const end = Date.now() + 30_000; Date.now() < end && !after; await new Promise((r) => setTimeout(r, 500))) {
        const pid = pidOnPort(port);
        if (pid && pid !== before && (await s.api('GET', '/api/app').catch(() => ({}))).status === 200) after = pid;
      }
      assert.ok(after, `a new board answers on ${port}`);
    } finally { killTree(pidOnPort(port)); await s.stop(); }
  });
});

describe('the brief says when the board is behind main (INT-319)', () => {
  it('a review.decide or work.land holder is told after a commit lands past the start commit; a plain builder is not', async () => {
    const code = fs.mkdtempSync(path.join(os.tmpdir(), 'codebrief-'));
    git(code, 'init', '-q', '-b', 'main');
    commit(code, 'first (INT-1)');
    const idle = 'node -e 0';
    const s = await startServer({
      env: { INTELLAGENT_CODE_DIR: code },
      agents: { agents: {
        approver: { run: idle, grants: ['review.decide'] },
        lander: { run: idle, grants: ['work.land'] },
        plain: { run: idle },
        chief: { run: idle, role: 'coordinator' },
      } },
    });
    try {
      const brief = async (a) => (await s.api('GET', '/api/boards/main/brief', undefined, { agent: a })).body;
      const app0 = await s.ok('GET', '/api/app', undefined, USER);
      assert.equal(app0.behind, 0);
      assert.doesNotMatch(await brief('approver'), /commits? behind main/, 'quiet while nothing landed');

      commit(code, 'Landed rule (INT-297)');
      const app1 = await s.ok('GET', '/api/app', undefined, USER); // re-reads main
      assert.equal(app1.behind, 1);
      assert.deepEqual(app1.behindTickets, ['INT-297']);
      assert.match(await brief('approver'), /1 commit behind main \(INT-297\)/);
      assert.match(await brief('lander'), /1 commit behind main \(INT-297\)/);
      assert.doesNotMatch(await brief('plain'), /commits? behind main/, 'only holders of the two powers are told');
      assert.match(await brief('chief'), /1 commit behind main \(INT-297\)/, 'the coordinator is told too (INT-419)');
      const days = await s.ok('GET', '/api/boards/main/digest?days=1', undefined, USER);
      assert.match(days[0].behind, /1 commit behind main \(INT-297\)/, 'the digest says it on today');
    } finally { await s.stop(); }
  });
});
