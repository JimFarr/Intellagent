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
// `git patch-id --stable` over the patches in `patch`: Map of patch id -> commit sha (the first one seen).
const patchIds = (cwd, patch) => new Promise((resolve) => {
  const p = execFile('git', ['patch-id', '--stable'], { ...GIT_OPTS, cwd }, (e, out) => {
    const ids = new Map();
    if (!e) for (const l of String(out).split('\n')) { const [id, sha] = l.split(' '); if (id && sha && !ids.has(id)) ids.set(id, sha); }
    resolve(ids);
  });
  p.stdin.on('error', () => {});
  p.stdin.end(patch);
});
const safe = (name) => String(name).replace(/[^\w.-]+/g, '_').replace(/^\.{1,2}$/, '_');
// a ticket id in a commit message, not followed by another digit (INT-3 must not match INT-31)
const idPattern = (id) => `${id}([^0-9]|$)`;
// Landing runs with the repository's hooks off. The board waits on git while it lands, and a post-commit hook
// that calls the board (intellagent hook post-commit) then waits on the board: neither moved until git's
// timeout, and the half-done cherry-pick was reported as one that did not apply. The board knows which
// ticket it is landing, so it needs no hook to tell it.
const NO_HOOKS = ['-c', `core.hooksPath=${path.join(os.tmpdir(), 'intellagent-no-hooks')}`];

// mainBranch: the branch work lands on (the manifest's mainBranch); found from the repository when not given.
// twinWindow: how many of main's newest commits are searched for the twin of a commit whose patch main already has.
function createWorktrees({ root, dir, mainBranch: configured = null, twinWindow = 300 }) {
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
  // One branch per ticket (INT-321): ticket/<name>/<ID>, from main's tip. Not agent/<name>/<ID>: git cannot hold
  // the branch agent/<name> and a folder of that name at once, and agent/<name> stays for work already in flight.
  const ticketBranch = (name, id) => `ticket/${safe(name)}/${String(id).toUpperCase()}`;
  // The branch a ticket's commits are on: its own when it has one, else the agent's old branch.
  const branchFor = (name, id) => (id && hasBranch(ticketBranch(name, id)) ? ticketBranch(name, id) : where(name).branch);
  const branchForA = async (name, id) => (id && await tryGitA(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${ticketBranch(name, id)}`]) != null ? ticketBranch(name, id) : where(name).branch);

  // Commits on the agent's branch that main doesn't have yet (by content, so landed cherry-picks don't count).
  async function unmerged(name, branch = where(name).branch) {
    const out = await tryGitA(root, ['cherry', mainBranch(), branch]);
    return out ? out.split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.slice(2)) : [];
  }

  // The agent's worktree, created on first use and brought up to date with main. Resolves to { path, branch,
  // main, note } — note says what the agent should know (a conflict, leftovers), or null when not a git repo.
  // Async, so a run's catch-up never blocks the board (INT-212): the runner holds the agent as starting meanwhile.
  async function ensure(name) {
    if (await tryGitA(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
    const main = mainBranch();
    const { path: wt, branch } = where(name);
    if (!fs.existsSync(path.join(wt, '.git'))) {
      fs.mkdirSync(dir, { recursive: true });
      await tryGitA(root, ['worktree', 'prune']);
      const exists = await tryGitA(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) != null;
      await gitA(root, ['worktree', 'add', wt, ...(exists ? [branch] : ['-b', branch, main])]);
    }
    let note = null;
    let dirty = await gitA(wt, ['status', '--porcelain', '--untracked-files=no']);
    // On a ticket's own branch (INT-321): never reset it. Once everything on it has landed it is deleted and the
    // worktree goes back to the agent's branch; until then it only catches up with main.
    const open = await tryGitA(wt, ['symbolic-ref', '--short', 'HEAD']);
    if (open?.startsWith('ticket/')) {
      const made = await tryGitA(root, ['rev-list', '--count', `${main}..${open}`]);
      const waiting = ((await tryGitA(root, ['cherry', main, open])) || '').split('\n').some((l) => l.startsWith('+ '));
      if (!dirty && Number(made) > 0 && !waiting) {
        await gitA(wt, ['checkout', branch]);
        await tryGitA(root, ['branch', '-D', open]);
        dirty = '';
      } else {
        if (!dirty && await tryGitA(wt, ['merge', '--no-edit', main]) == null) {
          await tryGitA(wt, ['merge', '--abort']);
          note = `Your branch ${open} no longer merges cleanly with ${main}. Before new work: run \`git merge ${main}\` in your worktree, resolve the conflicts (keep both sides' intent), run the tests, commit the merge, and say on the card what you resolved. \`git merge --abort\` backs out if you need to.`;
        } else if (dirty) note = `Your worktree has uncommitted changes from an earlier run: check them (git status) and commit or discard them before new work.`;
        return { path: wt, branch: open, main, note };
      }
    }
    if (dirty) {
      note = `Your worktree has uncommitted changes from an earlier run: check them (git status) and commit or discard them before new work.`;
    } else if (!(await unmerged(name)).length) {
      // everything it made has landed (or it made nothing): start again from the tip of main
      await gitA(wt, ['reset', '--hard', main]);
    } else if (await tryGitA(wt, ['merge', '--no-edit', main]) == null) {
      await tryGitA(wt, ['merge', '--abort']);
      note = `Your branch ${branch} no longer merges cleanly with ${main}. Before new work: run \`git merge ${main}\` in your worktree, resolve the conflicts (keep both sides' intent), run the tests, commit the merge, and say on the card what you resolved. \`git merge --abort\` backs out if you need to.`;
    }
    return { path: wt, branch, main, note };
  }

  // Give the ticket its own branch and switch the agent's worktree to it (INT-321). It starts from main's tip,
  // or from the branch of an unlanded blocker (blockedBy: [ids]) so the work that builds on it can. A branch the
  // ticket already has is resumed, with main merged in. Uncommitted work is refused, never stashed.
  // Resolves to { ok, branch, base, resumed } or { ok: false, code, reason, hint }.
  async function startTicket(name, id, { blockedBy = [] } = {}) {
    if (await tryGitA(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return { ok: false, code: 'NOT_GIT', reason: 'not a git repository' };
    const { path: wt } = where(name);
    if (!fs.existsSync(path.join(wt, '.git'))) await ensure(name);
    const main = mainBranch();
    const branch = ticketBranch(name, id);
    if (await gitA(wt, ['status', '--porcelain', '--untracked-files=no'])) {
      return { ok: false, code: 'DIRTY', reason: `your worktree has uncommitted changes, so ${id} can't get its own branch`, hint: 'commit them (on the ticket they belong to) or discard them, then start again' };
    }
    const exists = await tryGitA(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) != null;
    if (exists) {
      await gitA(wt, ['checkout', branch]);
      if (await tryGitA(wt, ['merge', '--no-edit', main]) == null) {
        await tryGitA(wt, ['merge', '--abort']);
        return { ok: true, branch, base: null, resumed: true, note: `${branch} no longer merges cleanly with ${main}. Run \`git merge ${main}\`, resolve the conflicts (keep both sides' intent), run the tests and commit the merge.` };
      }
      return { ok: true, branch, base: null, resumed: true };
    }
    // Work begun before ticket branches: commits for this ticket on agent/<name> that main lacks keep the ticket
    // there, so a second round lands with the first (a fresh branch from main would strand round one).
    const old = where(name).branch;
    if (toCommits(await tryGitA(root, logArgs(old, id)), await tryGitA(root, ['cherry', main, old])).length) {
      await gitA(wt, ['checkout', old]);
      return { ok: true, branch: old, base: null, resumed: true, note: `${id} already has commits on ${old}, so it stays there and lands from there as before; only tickets with no commits yet get their own branch.` };
    }
    // the first blocker whose branch still holds commits main lacks is the base
    let base = main;
    for (const b of blockedBy) {
      const refs = await tryGitA(root, ['for-each-ref', '--format=%(refname:short)', `refs/heads/ticket/*/${String(b).toUpperCase()}`]);
      const theirs = refs?.split('\n').filter(Boolean)[0];
      if (theirs && ((await tryGitA(root, ['cherry', main, theirs])) || '').split('\n').some((l) => l.startsWith('+ '))) { base = theirs; break; }
    }
    await gitA(wt, ['checkout', '-b', branch, base]);
    return { ok: true, branch, base, resumed: false };
  }

  // This ticket's commits on the agent's branch that main doesn't have, oldest first: [{ sha, subject }].
  const toCommits = (log, unmergedOut) => {
    const want = new Set(unmergedOut ? unmergedOut.split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.slice(2)) : []);
    return (log ? log.split('\n') : []).map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) })).filter((c) => want.has(c.sha));
  };
  const logArgs = (branch, id) => ['log', '--reverse', '-E', `--grep=${idPattern(id)}`, '--format=%H %s', `${mainBranch()}..${branch}`];
  function commitsFor(name, id) {
    if (!isRepo()) return [];
    const branch = branchFor(name, id);
    return toCommits(tryGit(root, logArgs(branch, id)), tryGit(root, ['cherry', mainBranch(), branch]));
  }
  // The same without blocking the board (request paths use this one). strict: a git error throws instead of
  // reading as "no commits", for callers where the two must not be confused (a verdict's commits, INT-212).
  async function commitsForAsync(name, id, { strict = false } = {}) {
    if (await tryGitA(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return [];
    const run = strict ? (args) => gitA(root, args) : (args) => tryGitA(root, args);
    const branch = await branchForA(name, id);
    const [log, cherry] = await Promise.all([run(logArgs(branch, id)), run(['cherry', mainBranch(), branch])]);
    return toCommits(log, cherry);
  }

  // The tips of the agent's branch and of main, read from the ref files (no git process, so cheap enough to
  // call on every request): "<branch sha>:<main sha>", or null when either can't be read. A ticket's commits
  // depend only on these two, so they key a cache of commitsFor (INT-212).
  function commonDir() {
    const dotgit = path.join(root, '.git');
    let stat;
    try { stat = fs.statSync(dotgit); } catch { return null; }
    if (stat.isDirectory()) return dotgit;
    // root is itself a worktree: .git names its own git dir, whose commondir holds the shared refs
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'));
    if (!m) return null;
    const own = path.resolve(root, m[1].trim());
    try { return path.resolve(own, fs.readFileSync(path.join(own, 'commondir'), 'utf8').trim()); } catch { return own; }
  }
  function refSha(dir, ref) {
    try {
      const v = fs.readFileSync(path.join(dir, ref), 'utf8').trim();
      if (/^[0-9a-f]{40,64}$/.test(v)) return v;
    } catch { /* not a loose ref: look in packed-refs */ }
    try {
      const line = fs.readFileSync(path.join(dir, 'packed-refs'), 'utf8').split('\n').find((l) => l.trimEnd().endsWith(` ${ref}`) && !l.startsWith('#'));
      return line ? line.slice(0, line.indexOf(' ')) : null;
    } catch { return null; }
  }
  function tips(name, id = null) {
    const dir = commonDir();
    if (!dir) return null;
    const branch = (id && refSha(dir, `refs/heads/${ticketBranch(name, id)}`)) || refSha(dir, `refs/heads/${where(name).branch}`);
    const main = branch && refSha(dir, `refs/heads/${mainBranch()}`);
    return branch && main ? `${branch}:${main}` : null;
  }

  // Tracked files with uncommitted changes in a checkout (staged or not), as repo-relative paths.
  async function dirtyFiles(dir) {
    // plain paths, staged or not (git status's porcelain lines lose their leading space to gitA's trim)
    const out = (await tryGitA(dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', 'HEAD'])) || '';
    return out.split('\n').filter(Boolean);
  }

  // The checkout that has main open, or null: git lets one branch be open in one checkout only.
  const landDir = path.join(dir, '_land');
  async function mainHolder() {
    await tryGitA(root, ['worktree', 'prune']);
    const want = `branch refs/heads/${mainBranch()}`;
    let at = null;
    for (const l of ((await tryGitA(root, ['worktree', 'list', '--porcelain'])) || '').split('\n')) {
      if (l.startsWith('worktree ')) at = path.resolve(l.slice(9));
      else if (l === want) return at;
    }
    return null;
  }
  // Where a landing happens (INT-440): the checkout that has main open, as before, so main never moves under
  // anyone's open files; else the board's own worktree, which opens main for the landing only (own: true, the
  // caller detaches it after, so the human can still switch to main). Never update-ref: that would leave an
  // open checkout's files behind its branch, and its next commit -a would undo the landed work.
  async function landingCheckout() {
    const holder = await mainHolder();
    if (holder && holder !== path.resolve(landDir)) return { cwd: holder, own: false };
    if (!fs.existsSync(path.join(landDir, '.git'))) {
      fs.mkdirSync(dir, { recursive: true });
      await gitA(root, ['worktree', 'add', '-q', '--detach', landDir, mainBranch()]);
    }
    // a landing cut short (the board stopped half-way) leaves its state behind
    await tryGitA(landDir, ['cherry-pick', '--abort']);
    await tryGitA(landDir, ['merge', '--abort']);
    await gitA(landDir, ['checkout', '-q', '-f', mainBranch()]);
    await tryGitA(landDir, ['clean', '-fdq']);
    return { cwd: landDir, own: true };
  }

  // One landing at a time: two at once would cherry-pick into each other's half-done state.
  let queue = Promise.resolve();
  const land = (name, id) => {
    const run = queue.then(() => landNow(name, id));
    queue = run.catch(() => {});
    return run;
  };

  // Put the ticket's commits on main, in the checkout landingCheckout picks; a conflict is undone. Cherry-picks first; when that conflicts and every unmerged commit on the branch is
  // this ticket's, merges the branch instead, which carries a conflict the agent already resolved when it
  // merged main in (INT-145). Async: git never blocks the board. Resolves to
  // { landed: [short shas], branch, via?, merge?, reason?, code?, hint?, command }.
  async function landNow(name, id) {
    const command = `intellagent merge ${id}`;
    if (await tryGitA(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return { landed: [], reason: 'not a git repository', command };
    const main = mainBranch();
    // Every commit of the ticket on the branch, also those whose patch main already has (git cherry's "-").
    const branch = await branchForA(name, id);
    const ticketOwn = branch !== where(name).branch;
    const commits = toCommits(await tryGitA(root, logArgs(branch, id)), ((await tryGitA(root, ['cherry', main, branch])) || '').replace(/^- /gm, '+ '));
    if (!commits.length) return { landed: [], branch: main, reason: `no commits mentioning ${id} on ${branch}`, command };
    const place = await landingCheckout();
    try {
      return await landIn(place.cwd, { name, id, main, branch, ticketOwn, commits, command });
    } finally {
      if (place.own) await tryGitA(place.cwd, ['checkout', '-q', '--detach']);
    }
  }
  async function landIn(cwd, { id, main, branch, ticketOwn, commits, command }) {
    // Uncommitted changes in the main checkout block a landing only where they touch a file the ticket's commits
    // change: an edit to agents.json (the Agents page writes it) must not hold up every landing. The undo below
    // keeps them (reset --keep), and the merge fallback, which can't promise that, needs a clean checkout.
    const dirty = await dirtyFiles(cwd);
    if (dirty.length) {
      const touched = new Set();
      for (const c of commits) for (const f of ((await tryGitA(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', c.sha])) || '').split('\n').filter(Boolean)) touched.add(f);
      const overlap = dirty.filter((f) => touched.has(f));
      if (overlap.length) {
        const names = overlap.slice(0, 5).map((f) => `\`${f}\``).join(', ') + (overlap.length > 5 ? ` and ${overlap.length - 5} more` : '');
        return { landed: [], branch: main, code: 'DIRTY', reason: `the main checkout has uncommitted changes to ${names}, which this ticket's commits change`, hint: 'commit or discard them there; the board lands it again once the main checkout is clean', command, commits };
      }
    }
    if (ticketOwn) {
      // a ticket branch started from its blocker's holds the blocker's commits too: they land first, in blocker order
      const own = new Set(commits.map((x) => x.sha));
      const under = ((await tryGitA(root, ['cherry', main, branch])) || '').split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.slice(2)).filter((sha) => !own.has(sha));
      if (under.length) return { landed: [], branch: main, code: 'WAITS_FOR_BLOCKER', reason: `${branch} sits on ${under.length} commit(s) of another ticket that main doesn't have yet`, hint: `land the ticket it builds on first (its blockedBy), then ${id}`, command, commits };
    }
    const start = await gitA(cwd, ['rev-parse', 'HEAD']);
    const undo = () => tryGitA(cwd, ['reset', dirty.length ? '--keep' : '--hard', start]); // all or nothing; --keep spares uncommitted work
    const tooLong = (e) => e.code === 'ETIMEDOUT' || !!e.signal || !!e.killed;
    // A commit whose patch is already on main (landed by hand, or inside another ticket's commit) counts as
    // landed, found by patch id and not by message; it is not picked again, which would only conflict (INT-301).
    const equivalent = [];
    const todo = [];
    const plus = new Set(((await tryGitA(root, ['cherry', main, branch])) || '').split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.slice(2)));
    for (const c of commits) {
      let twin = null;
      if (!plus.has(c.sha)) {
        const mine = await patchIds(root, `commit ${c.sha}\n${(await tryGitA(root, ['show', '--format=', c.sha])) || ''}\n`);
        const log = await tryGitA(root, ['log', '--no-merges', '--format=commit %H', '-p', '-n', String(twinWindow), main]);
        const [id] = [...mine.keys()];
        if (id && log) twin = (await patchIds(root, log)).get(id) || null;
      }
      // No twin in the window: the patch is on main, but where is unknown; landed then names main's tip and the card says so.
      if (!plus.has(c.sha)) equivalent.push({ sha: c.sha.slice(0, 7), main: (twin || await gitA(root, ['rev-parse', main])).slice(0, 7), ...(twin ? {} : { unmatched: true }) }); else todo.push(c);
    }
    const short = [...todo.map((c) => c.sha.slice(0, 7)), ...equivalent.map((e) => e.main)];
    const eq = equivalent.length ? { equivalent } : {};
    if (!todo.length) return { landed: short, branch: main, via: 'equivalent', ...eq, command, commits };
    for (const c of todo) {
      let failed = null;
      try { await gitA(cwd, [...NO_HOOKS, 'cherry-pick', '-x', c.sha]); } catch (e) { failed = e; }
      if (!failed) continue;
      await tryGitA(cwd, ['cherry-pick', '--abort']);
      await undo();
      if (tooLong(failed)) return { landed: [], branch: main, reason: `git took too long cherry-picking ${c.sha.slice(0, 7)}`, command, commits };
      const why = `${c.sha.slice(0, 7)} doesn't apply cleanly to ${main}`;
      // A merge brings every commit on the branch, so only when nothing on it belongs to another ticket.
      const mine = new Set(commits.map((x) => x.sha));
      const cherry = await tryGitA(root, ['cherry', main, branch]);
      const others = (cherry ? cherry.split('\n') : []).filter((l) => l.startsWith('+ ')).map((l) => l.slice(2)).filter((sha) => !mine.has(sha));
      if (others.length) return { landed: [], branch: main, reason: `${why}, and ${branch} has ${others.length} commit(s) for other tickets, so it can't be merged instead`, command, commits };
      if (dirty.length) return { landed: [], branch: main, code: 'DIRTY', reason: `${why}, and merging ${branch} instead needs a clean main checkout (uncommitted: ${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? '…' : ''})`, hint: 'commit or discard them there; the board lands it again once the main checkout is clean', command, commits };
      let merged = null;
      try { await gitA(cwd, [...NO_HOOKS, 'merge', '--no-ff', '-m', `Land ${id} from ${branch}`, branch]); } catch (e) { merged = e; }
      if (merged) {
        await tryGitA(cwd, ['merge', '--abort']);
        await undo();
        return { landed: [], branch: main, reason: tooLong(merged) ? `${why}, and git took too long merging ${branch}` : `${why}, nor does merging ${branch}`, command, commits };
      }
      return { landed: short, branch: main, via: 'merge', ...eq, merge: await gitA(cwd, ['rev-parse', '--short=7', 'HEAD']), command, commits };
    }
    return { landed: short, branch: main, via: 'cherry-pick', ...eq, command, commits };
  }

  // Short shas of commits on main whose subject names the ticket, made at or after `since` (an ISO time),
  // oldest first: what someone landed by hand, with ids that differ from the author's. Async.
  // The subject only: a commit body may name a ticket to say it was left out ("brought in CSS from tickets that
  // haven't landed (INT-162…)"), and that must never count as landing it.
  async function mentionedOnMain(id, since) {
    if (await tryGitA(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return [];
    const out = await tryGitA(root, ['log', '--reverse', '-E', `--grep=${idPattern(id)}`, '--format=%h %s', ...(since ? [`--since=${since}`] : []), mainBranch()]);
    const named = new RegExp(idPattern(id), 'i');
    return out ? out.split('\n').filter(Boolean).filter((l) => named.test(l.slice(l.indexOf(' ') + 1))).map((l) => l.split(' ')[0]) : [];
  }
  // Of these shas, the short ones that really are on main (a hand-landed claim is checked, not trusted).
  async function onMain(shas) {
    const found = [];
    for (const sha of shas) {
      if (!/^[0-9a-f]{4,40}$/i.test(String(sha))) continue;
      if (await tryGitA(root, ['merge-base', '--is-ancestor', String(sha), mainBranch()]) != null) found.push(await tryGitA(root, ['rev-parse', '--short=7', String(sha)]));
    }
    return found.filter(Boolean);
  }

  return { ensure, startTicket, ticketBranch, mentionedOnMain, onMain, commitsFor, commitsForAsync, tips, land, where, isRepo, mainBranch, dirtyMain: async () => { const h = await mainHolder(); return h && h !== path.resolve(landDir) ? dirtyFiles(h) : []; } };
}

module.exports = { createWorktrees };
