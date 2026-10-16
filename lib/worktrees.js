'use strict';
// Each file-editing standing agent works in its own git worktree, on branch agent/<name>, so agents never
// commit or overwrite each other's half-finished work in the shared checkout. Their commits reach the main
// branch when the human approves the ticket's review ("landing": a cherry-pick of the ticket's commits).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execFile } = require('child_process');

// windowsHide: the board runs in the background, and git's console flashing up looked like something broke.
const GIT_OPTS = { encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 };
const git = (cwd, args) => execFileSync('git', args, { ...GIT_OPTS, cwd, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, args) => { try { return git(cwd, args); } catch { return null; } };
// The same, without blocking the board: requests keep being served while git works. The error carries
// code/signal like execFileSync's (ETIMEDOUT is reported as a kill signal).
const gitA = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', args, { ...GIT_OPTS, cwd }, (e, out) => (e ? reject(e) : resolve(String(out).trim())));
});
const tryGitA = (cwd, args) => gitA(cwd, args).catch(() => null);
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
  const toCommits = (log, unmergedOut) => {
    const want = new Set(unmergedOut ? unmergedOut.split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.slice(2)) : []);
    return (log ? log.split('\n') : []).map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) })).filter((c) => want.has(c.sha));
  };
  const logArgs = (name, id) => ['log', '--reverse', '-E', `--grep=${idPattern(id)}`, '--format=%H %s', `${mainBranch()}..${where(name).branch}`];
  function commitsFor(name, id) {
    if (!isRepo()) return [];
    return toCommits(tryGit(root, logArgs(name, id)), tryGit(root, ['cherry', mainBranch(), where(name).branch]));
  }
  // The same without blocking the board (request paths use this one).
  async function commitsForAsync(name, id) {
    if (await tryGitA(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return [];
    const [log, cherry] = await Promise.all([tryGitA(root, logArgs(name, id)), tryGitA(root, ['cherry', mainBranch(), where(name).branch])]);
    return toCommits(log, cherry);
  }

  // One landing at a time on the main checkout: two at once would cherry-pick into each other's half-done state.
  let queue = Promise.resolve();
  const land = (name, id) => {
    const run = queue.then(() => landNow(name, id));
    queue = run.catch(() => {});
    return run;
  };

  // Put the ticket's commits on main (in the main checkout). Only into a clean checkout that has main open;
  // a conflict is undone. Cherry-picks first; when that conflicts and every unmerged commit on the branch is
  // this ticket's, merges the branch instead, which carries a conflict the agent already resolved when it
  // merged main in (INT-145). Async: git never blocks the board. Resolves to
  // { landed: [short shas], branch, via?, merge?, reason?, code?, hint?, command }.
  async function landNow(name, id) {
    const command = `intellagent merge ${id}`;
    if (await tryGitA(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return { landed: [], reason: 'not a git repository', command };
    const main = mainBranch();
    const commits = await commitsForAsync(name, id);
    if (!commits.length) return { landed: [], branch: main, reason: `no commits mentioning ${id} on ${where(name).branch}`, command };
    if (await gitA(root, ['status', '--porcelain', '--untracked-files=no'])) return { landed: [], branch: main, reason: 'the main checkout has uncommitted changes', command, commits };
    const open = await tryGitA(root, ['symbolic-ref', '--short', 'HEAD']);
    if (open !== main) {
      return { landed: [], branch: main, code: 'NOT_ON_MAIN', reason: `the main checkout has ${open ? `\`${open}\`` : 'a detached HEAD'} open, not \`${main}\``, hint: `git switch ${main} in the main checkout`, command, commits };
    }
    const start = await gitA(root, ['rev-parse', 'HEAD']);
    const undo = () => tryGitA(root, ['reset', '--hard', start]); // all or nothing
    const tooLong = (e) => e.code === 'ETIMEDOUT' || !!e.signal || !!e.killed;
    const short = commits.map((c) => c.sha.slice(0, 7));
    for (const c of commits) {
      let failed = null;
      try { await gitA(root, [...NO_HOOKS, 'cherry-pick', '-x', c.sha]); } catch (e) { failed = e; }
      if (!failed) continue;
      await tryGitA(root, ['cherry-pick', '--abort']);
      await undo();
      if (tooLong(failed)) return { landed: [], branch: main, reason: `git took too long cherry-picking ${c.sha.slice(0, 7)}`, command, commits };
      const why = `${c.sha.slice(0, 7)} doesn't apply cleanly to ${main}`;
      // A merge brings every commit on the branch, so only when nothing on it belongs to another ticket.
      const mine = new Set(commits.map((x) => x.sha));
      const cherry = await tryGitA(root, ['cherry', main, where(name).branch]);
      const others = (cherry ? cherry.split('\n') : []).filter((l) => l.startsWith('+ ')).map((l) => l.slice(2)).filter((sha) => !mine.has(sha));
      if (others.length) return { landed: [], branch: main, reason: `${why}, and ${where(name).branch} has ${others.length} commit(s) for other tickets, so it can't be merged instead`, command, commits };
      let merged = null;
      try { await gitA(root, [...NO_HOOKS, 'merge', '--no-ff', '-m', `Land ${id} from ${where(name).branch}`, where(name).branch]); } catch (e) { merged = e; }
      if (merged) {
        await tryGitA(root, ['merge', '--abort']);
        await undo();
        return { landed: [], branch: main, reason: tooLong(merged) ? `${why}, and git took too long merging ${where(name).branch}` : `${why}, nor does merging ${where(name).branch}`, command, commits };
      }
      return { landed: short, branch: main, via: 'merge', merge: await gitA(root, ['rev-parse', '--short=7', 'HEAD']), command, commits };
    }
    return { landed: short, branch: main, via: 'cherry-pick', command, commits };
  }

  return { ensure, commitsFor, commitsForAsync, land, where, isRepo, mainBranch };
}

module.exports = { createWorktrees };
