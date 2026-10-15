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

// mainBranch: the branch work lands on (the manifest's mainBranch); found from the repository when not given.
function createWorktrees({ root, dir, mainBranch: configured = null }) {
  const isRepo = () => tryGit(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  const hasBranch = (b) => tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]) != null;
  const checkedOut = () => tryGit(root, ['symbolic-ref', '--short', 'HEAD']);
  // Resolved once, never from what the main checkout has open: a feature branch the human switched to
  // must not become where approved work lands, or what every agent's worktree is reset to.
  let resolved = null;
  function mainBranch() {
    if (resolved) return resolved;
    const remote = tryGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.replace(/^origin\//, '');
    const found = configured || [remote, 'main', 'master'].find((b) => b && hasBranch(b)) || checkedOut();
    if (found) resolved = found;
    return found || 'main';
  }
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
      note = `Your branch ${branch} no longer merges cleanly with ${main}. Before new work: run \`git merge ${main}\` in your worktree, resolve the conflicts (keep both sides' intent), run the tests, commit the merge, and say on the card what you resolved. \`git merge --abort\` backs out if you need to.`;
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

  // Put the ticket's commits on main (in the main checkout). Only into a clean checkout that has main open;
  // a conflict is undone. Returns { landed: [short shas], branch, reason?, code?, hint?, command }.
  function land(name, id) {
    const command = `intellagent merge ${id}`;
    if (!isRepo()) return { landed: [], reason: 'not a git repository', command };
    const main = mainBranch();
    const commits = commitsFor(name, id);
    if (!commits.length) return { landed: [], branch: main, reason: `no commits mentioning ${id} on ${where(name).branch}`, command };
    if (git(root, ['status', '--porcelain', '--untracked-files=no'])) return { landed: [], branch: main, reason: 'the main checkout has uncommitted changes', command, commits };
    const open = checkedOut();
    if (open !== main) {
      return { landed: [], branch: main, code: 'NOT_ON_MAIN', reason: `the main checkout has ${open ? `\`${open}\`` : 'a detached HEAD'} open, not \`${main}\``, hint: `git switch ${main} in the main checkout`, command, commits };
    }
    const landed = [];
    for (const c of commits) {
      let failed = null;
      try { git(root, [...NO_HOOKS, 'cherry-pick', '-x', c.sha]); } catch (e) { failed = e; }
      if (failed) {
        tryGit(root, ['cherry-pick', '--abort']);
        if (landed.length) tryGit(root, ['reset', '--hard', `HEAD~${landed.length}`]); // all or nothing
        const why = failed.code === 'ETIMEDOUT' || failed.signal ? `git took too long cherry-picking ${c.sha.slice(0, 7)}` : `${c.sha.slice(0, 7)} doesn't apply cleanly to ${main}`;
        return { landed: [], branch: main, reason: why, command, commits };
      }
      landed.push(c.sha.slice(0, 7));
    }
    return { landed, branch: main, command, commits };
  }

  return { ensure, commitsFor, land, where, isRepo, mainBranch };
}

module.exports = { createWorktrees };
