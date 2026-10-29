'use strict';
// INT-448: commits that touch the board's own files are flagged on the review, and only the human approves them.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startServer, USER } = require('./helpers');

describe('a review whose commits change the board\'s own files (INT-448)', () => {
  it('shows a warning naming them, and a delegated approval is refused with BOARD_FILES', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-bf-'));
    const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\n.worktrees/\nintellagent.manifest.json\nagents.json\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    const s = await startServer({ dir, agents: { agents: {
      gamora: { role: 'coordinator', enabled: false, grants: [{ power: 'review.decide' }] },
      dev: { enabled: false, worktree: true },
    } } });
    const wt = path.join(dir, '.worktrees', 'dev');
    const review = async (title, file) => {
      const it = await s.ok('POST', '/api/boards/main/items', { title, column: 'Ready' }, USER);
      await s.ok('POST', `/api/boards/main/items/${it.id}/start`, {}, { agent: 'dev' });
      fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
      fs.writeFileSync(path.join(wt, file), 'x\n');
      git(wt, 'add', '-f', '.');
      git(wt, 'commit', '-q', '-m', `work (${it.id})`);
      await s.ok('POST', `/api/boards/main/items/${it.id}/review`, { changed: 'c', why: 'w', verify: 'v', evidence: 'e' }, { agent: 'dev' });
      return s.ok('GET', `/api/boards/main/items/${it.id}`);
    };
    const decide = (id) => s.api('POST', `/api/boards/main/items/${id}/review/decision`, { verdict: 'approve', comment: 'ok' }, { agent: 'gamora' });
    try {
      git(dir, 'worktree', 'add', '-q', wt, '-b', 'agent/dev', 'main');
      const bad = await review('touches the board', 'agent-context/dev.md');
      assert.match(bad.comments.at(-1).body, /⚠ These commits change the board's own files: `agent-context\/dev\.md`/);
      const refused = await decide(bad.id);
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, 'BOARD_FILES', JSON.stringify(refused.body));
      // the human still can
      assert.ok((await s.api('POST', `/api/boards/main/items/${bad.id}/review/decision`, { verdict: 'approve', comment: 'ok' }, USER)).body);
      const fine = await review('ordinary', 'lib/x.txt');
      assert.doesNotMatch(fine.comments.at(-1).body, /board's own files/);
      // refused for another reason (no reviewer) is fine here: what matters is that it isn't BOARD_FILES
      assert.notEqual((await decide(fine.id)).body.code, 'BOARD_FILES');
      // a commit made after the review request is read at approval time, and the name is matched in any case
      fs.mkdirSync(path.join(wt, 'Agent-Context'), { recursive: true });
      fs.writeFileSync(path.join(wt, 'Agent-Context', 'late.md'), 'x\n');
      git(wt, 'add', '-f', '.');
      git(wt, 'commit', '-q', '-m', `late (${fine.id})`);
      const late = await decide(fine.id);
      assert.equal(late.body.code, 'BOARD_FILES', JSON.stringify(late.body));
      assert.deepEqual(late.body.files.map((f) => f.toLowerCase()), ['agent-context/late.md']); // a case-insensitive disk may keep the older spelling
    } finally { await s.stop(); }
  });

  // INT-478: the same ticket moved into Done by an agent holding column.gate, with no review to decide
  it('an agent\'s column.gate move into an approval gate is refused with BOARD_FILES too', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-bf-'));
    const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\n.worktrees/\nintellagent.manifest.json\nagents.json\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    const s = await startServer({ dir, agents: { agents: {
      gamora: { role: 'coordinator', enabled: false, grants: ['column.gate'] },
      dev: { enabled: false, worktree: true },
    } } });
    const wt = path.join(dir, '.worktrees', 'dev');
    const worked = async (title, file) => {
      const it = await s.ok('POST', '/api/boards/main/items', { title, column: 'Ready' }, USER);
      await s.ok('POST', `/api/boards/main/items/${it.id}/start`, {}, { agent: 'dev' });
      fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
      fs.writeFileSync(path.join(wt, file), 'x\n');
      git(wt, 'add', '-f', '.');
      git(wt, 'commit', '-q', '-m', `work (${it.id})`);
      await s.ok('DELETE', `/api/boards/main/items/${it.id}/lease`, undefined, { agent: 'dev' });
      return it;
    };
    const move = (id) => s.api('POST', `/api/boards/main/items/${id}/move`, { column: 'Done', confirm: true }, { agent: 'gamora' });
    try {
      git(dir, 'worktree', 'add', '-q', wt, '-b', 'agent/dev', 'main');
      const bad = await worked('touches the board', 'agent-context/dev.md');
      const refused = await move(bad.id);
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, 'BOARD_FILES', JSON.stringify(refused.body));
      assert.deepEqual(refused.body.files, ['agent-context/dev.md']);
      // the same through a bulk move and a PATCH
      assert.equal((await s.api('POST', '/api/boards/main/items/bulk', { ids: [bad.id], patch: { column: 'Done', confirm: true } }, { agent: 'gamora' })).body[0].code, 'BOARD_FILES');
      assert.equal((await s.api('PATCH', `/api/boards/main/items/${bad.id}`, { column: 'Done', confirm: true }, { agent: 'gamora' })).body.code, 'BOARD_FILES');
      assert.notEqual((await s.ok('GET', `/api/boards/main/items/${bad.id}`)).column, 'Done');
      // an ordinary ticket goes through
      const fine = await worked('ordinary', 'lib/x.txt');
      const moved = await move(fine.id);
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      // the human moves the flagged one
      assert.equal((await s.api('POST', `/api/boards/main/items/${bad.id}/move`, { column: 'Done', confirm: true }, USER)).status, 200);
    } finally { await s.stop(); }
  });
});
