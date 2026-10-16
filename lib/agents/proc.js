'use strict';
// Processes a standing agent's runs started: stopping a tree, and finding the ones a board that died left behind.
const { execFile, execFileSync } = require('child_process');

function killTree(child) {
  if (process.platform === 'win32') execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => {});
  else try { process.kill(-child.pid, 'SIGTERM'); } catch { try { (child.kill ? child.kill('SIGTERM') : process.kill(child.pid, 'SIGTERM')); } catch { /* gone */ } }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Which of the processes recorded before a restart ({ pid, at }: the shell a run was spawned in, and when) are
// still running, as pids to stop. Only what is provably ours: pids get reused, and the wrong one could be the
// human's. Windows: the shell may be gone while its child (claude) runs on, orphaned but still naming it as
// parent, so its children count too if they started with it; one process query covers every agent.
function leftovers(recorded) {
  const found = new Map(); // recorded entry → pids
  if (!recorded.length) return found;
  try {
    if (process.platform === 'win32') {
      const ids = [...new Set(recorded.map((p) => Number(p.pid)))];
      const filter = ids.map((id) => `ProcessId=${id} OR ParentProcessId=${id}`).join(' OR ');
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [string]$_.ProcessId + ' ' + $_.ParentProcessId + ' ' + ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }`],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      const rows = out.split(/\r?\n/).map((l) => l.trim().split(' ').map(Number)).filter((r) => r.length === 3 && r.every(Number.isFinite));
      for (const p of recorded) {
        const self = rows.find(([id]) => id === p.pid);
        if (self && Math.abs(self[2] - p.at) < 5000) { found.set(p, [p.pid]); continue; } // taskkill /T takes its children
        // the shell is gone (or its pid now belongs to someone else, started later): children it started itself
        const kids = rows.filter(([id, parent, t]) => parent === p.pid && id !== p.pid && t >= p.at - 1000 && t - p.at < 30_000 && (!self || t < self[2]));
        if (kids.length) found.set(p, kids.map(([id]) => id));
      }
      return found;
    }
    // elsewhere a run leads its own process group (detached), and a pid is never reused while its group lives
    for (const p of recorded) {
      if (!alive(-p.pid)) continue;
      if (alive(p.pid)) {
        const secs = Number(execFileSync('ps', ['-o', 'etimes=', '-p', String(Number(p.pid))], { encoding: 'utf8', timeout: 5000 }).trim());
        if (!Number.isFinite(secs) || Math.abs(Date.now() - secs * 1000 - p.at) > 5000) continue;
      }
      found.set(p, [p.pid]);
    }
  } catch { /* the OS won't say: leave them */ }
  return found;
}
// a process stopped after a restart is gone once neither it nor (elsewhere) its process group is left
const lives = (pid) => alive(pid) || (process.platform !== 'win32' && alive(-pid));

module.exports = { killTree, leftovers, lives };
