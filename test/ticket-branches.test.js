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

  it('a ticket begun on agent/<name> stays there when started again, so both rounds land (Rocket, INT-321)', async () => {
    const { dir, wt, clean } = repo();
    try {
      const { path: p } = await wt.ensure('ann');
      write(p, 'r1.txt', 'round 1\n'); git(p, 'add', '.'); git(p, 'commit', '-q', '-m', 'round 1 (T-1)');
      write(p, 'ten.txt', 'ten\n'); git(p, 'add', '.'); git(p, 'commit', '-q', '-m', 'other work (T-10)');
      const again = await wt.startTicket('ann', 'T-1');
      assert.deepEqual([again.ok, again.branch, again.base], [true, 'agent/ann', null], JSON.stringify(again));
      assert.match(again.note, /already has commits on agent\/ann/);
      write(p, 'r2.txt', 'round 2\n'); git(p, 'add', '.'); git(p, 'commit', '-q', '-m', 'round 2 (T-1)');
      const r = await wt.land('ann', 'T-1');
      assert.equal(r.landed.length, 2, JSON.stringify(r));
      assert.ok(fs.existsSync(path.join(dir, 'r1.txt')) && fs.existsSync(path.join(dir, 'r2.txt')), 'both rounds are on main');
      assert.ok(!fs.existsSync(path.join(dir, 'ten.txt')), "T-10's commit is not T-1's");
      // a ticket with nothing unlanded on agent/ann gets its own branch from main: T-2, and T-1 now that it has
      // landed, although T-10's commit (whose id starts with T-1) is still waiting there
      for (const id of ['T-2', 'T-1']) {
        const fresh = await wt.startTicket('ann', id);
        assert.deepEqual([fresh.branch, fresh.base], [`ticket/ann/${id}`, 'main'], id);
        assert.ok(!fs.existsSync(path.join(p, 'ten.txt')), `${id} starts from main, without agent/ann's other work`);
      }
      // and T-10, begun on agent/ann, goes back there from a ticket branch
      assert.equal((await wt.startTicket('ann', 'T-10')).branch, 'agent/ann');
      assert.equal(git(p, 'branch', '--show-current'), 'agent/ann');
    } finally { clean(); }
  });
});

describe('start gives the ticket its branch (INT-321)', () => {
  it('two tickets started through the board land on their own in either order; uncommitted work refuses start and changes nothing', async () => {
    const { startServer, until, USER } = require('./helpers');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-tbs-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'core.autocrlf', 'false');
    write(dir, '.gitignore', 'data/\n.worktrees/\nintellagent.manifest.json\nagents.json\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    const s = await startServer({ dir, agents: { agents: { dev: { enabled: false, worktree: true } } } });
    const p = path.join(dir, '.worktrees', 'dev');
    const B = '/api/boards/main';
    const say = async (id) => (await s.ok('GET', `${B}/items/${id}`)).comments.map((c) => c.body).at(-1) || '';
    try {
      const brief = (await s.api('GET', `${B}/brief`, undefined, { agent: 'dev' })).body;
      assert.match(typeof brief === 'string' ? brief : brief.markdown, /## Your branches[\s\S]*ticket\/dev\/<ID>/);
      const one = await s.ok('POST', `${B}/items`, { title: 'one', column: 'Ready' }, USER);
      const two = await s.ok('POST', `${B}/items`, { title: 'two', column: 'Ready' }, USER);
      const a = await s.ok('POST', `${B}/items/${one.id}/start`, {}, { agent: 'dev' });
      assert.deepEqual([a.branch.name, a.branch.base, a.branch.resumed], [`ticket/dev/${one.id}`, 'main', false]);
      assert.equal(git(p, 'branch', '--show-current'), `ticket/dev/${one.id}`, 'the worktree is on the ticket branch');
      commit(p, 'one.txt', one.id);

      // uncommitted work: start answers 409 DIRTY with a hint, and the ticket stays where it was
      // a full working column refuses start before git: the worktree stays where it was (Kraglin, INT-321)
      await s.ok('PATCH', `${B}/columns/in-progress`, { flags: { wipLimit: 1 } }, USER);
      const full = await s.api('POST', `${B}/items/${two.id}/start`, {}, { agent: 'dev' });
      assert.deepEqual([full.status, full.body.code], [409, 'WIP_LIMIT']);
      assert.ok(full.body.hint);
      assert.equal(git(p, 'branch', '--show-current'), `ticket/dev/${one.id}`, 'the worktree was not switched');
      assert.ok(!git(dir, 'branch', '--list', `ticket/dev/${two.id}`), 'and no branch was made');
      await s.ok('PATCH', `${B}/columns/in-progress`, { flags: { wipLimit: 0 } }, USER);

      write(p, 'one.txt', 'half done\n');
      const dirty =await s.api('POST', `${B}/items/${two.id}/start`, {}, { agent: 'dev' });
      assert.equal(dirty.status, 409);
      assert.equal(dirty.body.code, 'DIRTY');
      assert.ok(dirty.body.hint);
      const still = await s.ok('GET', `${B}/items/${two.id}`);
      assert.deepEqual([still.column, still.lease, still.assignee], ['Ready', null, null], 'nothing changed on the board');
      assert.equal(git(p, 'branch', '--show-current'), `ticket/dev/${one.id}`, 'nor in the worktree');
      git(p, 'checkout', '--', 'one.txt');

      const b = await s.ok('POST', `${B}/items/${two.id}/start`, {}, { agent: 'dev' });
      assert.deepEqual([b.branch.name, b.branch.base], [`ticket/dev/${two.id}`, 'main'], 'the second ticket starts from main, not from the first');
      commit(p, 'two.txt', two.id);
      for (const it of [one, two]) await s.ok('POST', `${B}/items/${it.id}/review`, { changed: 'c', why: 'w', verify: 'v', evidence: 'e' }, { agent: 'dev' });

      // the second one lands first, alone
      await s.ok('POST', `${B}/items/${two.id}/review/decision`, { verdict: 'approve' }, USER);
      await until(async () => /Landed on main/.test(await say(two.id)), 10000, `${two.id} landed`);
      assert.ok(fs.existsSync(path.join(dir, 'two.txt')) && !fs.existsSync(path.join(dir, 'one.txt')), `only ${two.id}'s work is on main`);
      // feedback on the first: start again resumes its branch
      await s.ok('POST', `${B}/items/${one.id}/review/decision`, { verdict: 'changes', comment: 'one more thing' }, USER);
      const again = await s.ok('POST', `${B}/items/${one.id}/start`, {}, { agent: 'dev' });
      assert.deepEqual([again.branch.name, again.branch.resumed], [`ticket/dev/${one.id}`, true]);
      assert.ok(fs.existsSync(path.join(p, 'two.txt')), 'resuming merged main in');
      await s.ok('POST', `${B}/items/${one.id}/review`, { changed: 'c', why: 'w', verify: 'v', evidence: 'e' }, { agent: 'dev' });
      await s.ok('POST', `${B}/items/${one.id}/review/decision`, { verdict: 'approve' }, USER);
      await until(async () => /Landed on main/.test(await say(one.id)), 10000, `${one.id} landed`);
      assert.ok(fs.existsSync(path.join(dir, 'one.txt')));
    } finally {
      await s.stop();
      try { git(dir, 'worktree', 'prune'); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
