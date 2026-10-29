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
    } finally { await s.stop(); }
  });
});
