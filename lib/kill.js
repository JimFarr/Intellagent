'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Stopping a board must stop everything it started: its agent runs, their shells and browsers. On Windows,
// killing a process leaves its children running — an orphaned agent run then keeps working beside the copy
// the next board starts, so the same agent writes in one worktree twice. There the whole tree goes at once.
const { spawnSync } = require('child_process');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
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

module.exports = { killTree };
