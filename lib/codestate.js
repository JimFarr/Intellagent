'use strict';
// Which code the board is running, and how far main has moved on since it started (INT-319).
// The commit is read once at start; main is re-read on refresh() (the sweep), so a landing is never "live" silently.
// Not a git checkout (an npm install), or git missing: every field is null and the board says nothing.
const { execFile, execFileSync } = require('child_process');

const TICKET = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;
const MAX_COMMITS = 30;

function git(dir, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: dir, windowsHide: true, timeout: 10_000 }, (err, out) => resolve(err ? null : String(out).trim()));
  });
}

// dir: the folder the board's own code lives in. mainBranch(): the branch work lands on (may be null).
function createCodeState({ dir, mainBranch = () => null }) {
  let running = null;
  try { running = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null; } catch { /* not a checkout */ }
  const startedAt = new Date().toISOString();
  let state = { runningCommit: running, runningSince: running ? startedAt : null, mainCommit: null, behind: running ? 0 : null, behindCommits: [], behindTickets: [], checkedAt: null };
  let busy = null;

  async function refresh() {
    if (!running) return state;
    if (busy) return busy;
    busy = (async () => {
      const branch = mainBranch() || (await git(dir, ['rev-parse', '--verify', '-q', 'main']) ? 'main' : (await git(dir, ['rev-parse', '--verify', '-q', 'master']) ? 'master' : null));
      const main = branch && await git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
      if (!main) return state;
      // Commits on main the running code does not have. If the running commit is no longer an ancestor (main was
      // rewritten), the range is still the honest answer to "what is not live".
      const log = await git(dir, ['log', '--format=%h %s', `${running}..${main}`]);
      const lines = log ? log.split('\n').filter(Boolean) : [];
      const tickets = [];
      for (const l of lines) for (const id of l.match(TICKET) || []) if (!tickets.includes(id)) tickets.push(id);
      state = {
        ...state, mainCommit: main, behind: lines.length,
        behindCommits: lines.slice(0, MAX_COMMITS).map((l) => ({ sha: l.slice(0, l.indexOf(' ')), subject: l.slice(l.indexOf(' ') + 1) })),
        behindTickets: tickets, checkedAt: new Date().toISOString(),
      };
      return state;
    })().finally(() => { busy = null; });
    return busy;
  }

  // One line for a brief or a header; '' when nothing landed since start (or when this is not a checkout).
  function line() {
    if (!state.behind) return '';
    const named = state.behindTickets.length ? ` (${state.behindTickets.slice(0, 8).join(', ')}${state.behindTickets.length > 8 ? ', …' : ''})` : '';
    return `The board is running code from ${state.runningSince.slice(11, 16)} UTC, ${state.behind} commit${state.behind === 1 ? '' : 's'} behind main${named}. Anything that landed since is not enforced until the human restarts the board.`;
  }

  return { refresh, snapshot: () => ({ ...state }), line };
}

module.exports = { createCodeState };
