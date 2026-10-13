'use strict';
// Each file-editing standing agent works in its own git worktree, on branch agent/<name>, so agents never
// commit or overwrite each other's half-finished work in the shared checkout. Their commits reach the main
// branch when the human approves the ticket's review ("landing": a cherry-pick of the ticket's commits).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// windowsHide: the board runs in the background, and git's console flashing up looked like something broke.
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, windowsHide: true }).trim();
const tryGit = (cwd, args) => { try { return git(cwd, args); } catch { return null; } };
const safe = (name) => String(name).replace(/[^\w.-]+/g, '_');
// a ticket id in a commit message, not followed by another digit (INT-3 must not match INT-31)
const idPattern = (id) => `${id}([^0-9]|$)`;
// Landing runs with the repository's hooks off. The board waits on git while it lands, and a post-commit hook
// that calls the board (intellagent hook post-commit) then waits on the board: neither moved until git's
// timeout, and the half-done cherry-pick was reported as one that did not apply. The board knows which
// ticket it is landing, so it needs no hook to tell it.
const NO_HOOKS = ['-c', `core.hooksPath=${path.join(os.tmpdir(), 'intellagent-no-hooks')}`];

function createWorktrees({ root, dir }) {
  const isRepo = () => tryGit(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  const mainBranch = () => tryGit(root, ['symbolic-ref', '--short', 'HEAD']) || 'main';
  const where = (name) => ({ path: path.join(dir, safe(name)), branch: `agent/${safe(name)}` });

  // Commits on the agent's branch that main doesn't have yet (by content, so landed cherry-picks don't count).
  function unmerged(name) {
    const { branch } = where(name);
    const out = tryGit(root, ['cherry', mainBranch(), branch]);
    return out ? out.split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.slice(2)) : [];
  }

  // The agent's worktree, created on first use and brought up to date with main. Returns { path, branch,
  // main, note } — note says what the agent should know (a conflict, leftovers), or null when not a git repo.
  function ensure(name) {
    if (!isRepo()) return null;
    const main = mainBranch();
    const { path: wt, branch } = where(name);
    if (!fs.existsSync(path.join(wt, '.git'))) {
      fs.mkdirSync(dir, { recursive: true });
      tryGit(root, ['worktree', 'prune']);
      const exists = tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) != null;
      git(root, ['worktree', 'add', wt, ...(exists ? [branch] : ['-b', branch, main])]);
    }
    let note = null;
    const dirty = git(wt, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty) {
      note = `Your worktree has uncommitted changes from an earlier run: check them (git status) and commit or discard them before new work.`;
    } else if (!unmerged(name).length) {
      // everything it made has landed (or it made nothing): start again from the tip of main
      git(wt, ['reset', '--hard', main]);
    } else if (tryGit(wt, ['merge', '--no-edit', main]) == null) {
      tryGit(wt, ['merge', '--abort']);
      note = `Your branch ${branch} no longer merges cleanly with ${main}. Run \`git merge ${main}\` in your worktree and resolve the conflicts before new work.`;
    }
    return { path: wt, branch, main, note };
  }

  // This ticket's commits on the agent's branch that main doesn't have, oldest first: [{ sha, subject }].
  function commitsFor(name, id) {
    if (!isRepo()) return [];
    const want = new Set(unmerged(name));
    const log = tryGit(root, ['log', '--reverse', '-E', `--grep=${idPattern(id)}`, '--format=%H %s', `${mainBranch()}..${where(name).branch}`]);
    return (log ? log.split('\n') : []).map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) })).filter((c) => want.has(c.sha));
  }

  // Put the ticket's commits on main (in the main checkout). Only into a clean checkout; a conflict is
  // undone. Returns { landed: [short shas], reason?, command }.
  function land(name, id) {
    const command = `intellagent merge ${id}`;
    if (!isRepo()) return { landed: [], reason: 'not a git repository', command };
    const commits = commitsFor(name, id);
    if (!commits.length) return { landed: [], reason: `no commits mentioning ${id} on ${where(name).branch}`, command };
    if (git(root, ['status', '--porcelain', '--untracked-files=no'])) return { landed: [], reason: 'the main checkout has uncommitted changes', command, commits };
    const landed = [];
    for (const c of commits) {
      let failed = null;
      try { git(root, [...NO_HOOKS, 'cherry-pick', '-x', c.sha]); } catch (e) { failed = e; }
      if (failed) {
        tryGit(root, ['cherry-pick', '--abort']);
        if (landed.length) tryGit(root, ['reset', '--hard', `HEAD~${landed.length}`]); // all or nothing
        const why = failed.code === 'ETIMEDOUT' || failed.signal ? `git took too long cherry-picking ${c.sha.slice(0, 7)}` : `${c.sha.slice(0, 7)} doesn't apply cleanly to ${mainBranch()}`;
        return { landed: [], reason: why, command, commits };
      }
      landed.push(c.sha.slice(0, 7));
    }
    return { landed, command, commits };
  }

  return { ensure, commitsFor, land, where, isRepo };
}

module.exports = { createWorktrees };
