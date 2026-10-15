'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Stopping a board must stop everything it started: its agent runs, their shells and browsers. On Windows,
// killing a process leaves its children running — an orphaned agent run then keeps working beside the copy
// the next board starts, so the same agent writes in one worktree twice. There the whole tree goes at once.
const { spawnSync } = require('child_process');

function killTree(pid) {
  if (!pid) return false;
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    return r.status === 0;
  }
  try { process.kill(pid); return true; } catch { return false; }
}

module.exports = { killTree };
