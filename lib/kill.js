'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Stopping a board must stop everything it started: its agent runs, their shells and browsers. On Windows,
// killing a process leaves its children running — an orphaned agent run then keeps working beside the copy
// the next board starts, so the same agent writes in one worktree twice. There the whole tree goes at once.
const { spawnSync } = require('child_process');

// EPERM: the process exists but is not ours to signal, so it is alive
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function killTree(pid) {
  if (!pid) return false;
  if (process.platform === 'win32') {
    const was = alive(pid);
    // taskkill /T exits non-zero when any process in the tree had already ended, even though the rest went:
    // judge by whether the process is gone, not by its exit code.
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    return was && !alive(pid);
  }
  try { process.kill(pid); return true; } catch { return false; }
}

// The process listening on a local TCP port, or null (nothing listens, or the tool to ask is missing).
function pidOnPort(port) {
  port = Number(port);
  if (!port) return null;
  if (process.platform === 'win32') {
    const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, encoding: 'utf8' });
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const c = line.trim().split(/\s+/); // Proto  Local  Foreign  State  PID
      if (c[3] === 'LISTENING' && /^(127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]):(\d+)$/.test(c[1]) && Number(c[1].split(':').pop()) === port) return Number(c[4]) || null;
    }
    return null;
  }
  const r = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return Number(String(r.stdout || '').split('\n')[0]) || null;
}

module.exports = { killTree, pidOnPort, alive };
