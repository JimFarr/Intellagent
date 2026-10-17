// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// INT-321: one branch per ticket, started from main, so an approved ticket lands on its own.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createWorktrees } = require('../lib/worktrees');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (cwd, file, text) => fs.writeFileSync(path.join(cwd, file), text);

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-tb-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'core.autocrlf', 'false');
  write(dir, '.gitignore', '.worktrees/\n');
  write(dir, 'base.txt', 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  const wt = createWorktrees({ root: dir, dir: path.join(dir, '.worktrees') });
  const clean = () => { fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, wt, clean };
}
const commit = (cwd, file, id) => { write(cwd, file, `${id}\n`); git(cwd, 'add', file); git(cwd, 'commit', '-q', '-m', `work on ${id}`); };

describe('a branch per ticket (INT-321)', () => {
  it('two tickets by one agent land independently, in either order', async () => {
    const { dir, wt, clean } = repo();
    try {
      const a = await wt.startTicket('ann', 'T-1');
      assert.deepEqual([a.ok, a.branch, a.base], [true, 'ticket/ann/T-1', 'main']);
      const p = wt.where('ann').path;
      commit(p, 'one.txt', 'T-1');
      const b = await wt.startTicket('ann', 'T-2');
      assert.equal(b.base, 'main', 'the second ticket starts from main, not on top of the first');
      commit(p, 'two.txt', 'T-2');
      assert.equal(wt.commitsFor('ann', 'T-1').length, 1);
      assert.equal(wt.commitsFor('ann', 'T-2').length, 1);
      assert.deepEqual(wt.commitsFor('ann', 'T-2').map((c) => c.subject), ['work on T-2']);
      // T-2 is approved first: it lands without T-1
      const second = await wt.land('ann', 'T-2');
      assert.equal(second.landed.length, 1, JSON.stringify(second));
      assert.ok(fs.existsSync(path.join(dir, 'two.txt')));
      assert.ok(!fs.existsSync(path.join(dir, 'one.txt')), 'T-1 is not dragged along');
      const first = await wt.land('ann', 'T-1');
      assert.equal(first.landed.length, 1, JSON.stringify(first));
      assert.ok(fs.existsSync(path.join(dir, 'one.txt')));
    } finally { clean(); }
  });

  it('a ticket that builds on another starts from its branch and lands after it', async () => {
    const { dir, wt, clean } = repo();
    try {
      await wt.startTicket('ann', 'T-1');
      const p = wt.where('ann').path;
      commit(p, 'one.txt', 'T-1');
      const b = await wt.startTicket('ann', 'T-3', { blockedBy: ['t-1'] });
      assert.equal(b.base, 'ticket/ann/T-1');
      commit(p, 'three.txt', 'T-3');
      assert.equal(wt.commitsFor('ann', 'T-3').length, 1, 'only its own commit is the ticket\'s');
      const early = await wt.land('ann', 'T-3');
      assert.deepEqual([early.landed, early.code], [[], 'WAITS_FOR_BLOCKER']);
      assert.ok(!fs.existsSync(path.join(dir, 'three.txt')), 'nothing landed');
      assert.equal((await wt.land('ann', 'T-1')).landed.length, 1);
      const late = await wt.land('ann', 'T-3');
      assert.equal(late.landed.length, 1, JSON.stringify(late));
      assert.ok(fs.existsSync(path.join(dir, 'three.txt')));
    } finally { clean(); }
  });

  it('uncommitted work is refused with a hint and kept; a landed ticket branch is deleted by the next ensure; an unlanded one is never reset', async () => {
    const { dir, wt, clean } = repo();
    try {
      await wt.startTicket('ann', 'T-1');
      const p = wt.where('ann').path;
      commit(p, 'one.txt', 'T-1');
      write(p, 'one.txt', 'half done\n');
      const refused = await wt.startTicket('ann', 'T-2');
      assert.deepEqual([refused.ok, refused.code], [false, 'DIRTY']);
      assert.ok(refused.hint);
      assert.equal(fs.readFileSync(path.join(p, 'one.txt'), 'utf8'), 'half done\n', 'never stashed or discarded');
      git(p, 'checkout', '--', 'one.txt');
      // main moves; an ensure on an unlanded ticket branch catches up and keeps the commit
      write(dir, 'main.txt', 'm\n'); git(dir, 'add', 'main.txt'); git(dir, 'commit', '-q', '-m', 'main moves');
      const e = await wt.ensure('ann');
      assert.equal(e.branch, 'ticket/ann/T-1');
      assert.ok(fs.existsSync(path.join(p, 'main.txt')) && fs.existsSync(path.join(p, 'one.txt')));
      // resuming (review feedback) continues the same branch
      assert.equal((await wt.startTicket('ann', 'T-1')).resumed, true);
      await wt.land('ann', 'T-1');
      const after = await wt.ensure('ann');
      assert.equal(after.branch, 'agent/ann', 'back on the agent branch once the ticket has landed');
      assert.throws(() => git(dir, 'rev-parse', '--verify', '--quiet', 'refs/heads/ticket/ann/T-1'), 'the landed ticket branch is gone');
    } finally { clean(); }
  });

  it('work already on agent/<name> still lands as before', async () => {
    const { dir, wt, clean } = repo();
    try {
      const { path: p } = await wt.ensure('ann');
      commit(p, 'old.txt', 'T-9');
      const r = await wt.land('ann', 'T-9');
      assert.equal(r.landed.length, 1, JSON.stringify(r));
      assert.ok(fs.existsSync(path.join(dir, 'old.txt')));
    } finally { clean(); }
  });
});
