'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Boards on one repository share its branches (agent/<name>, ticket/<name>/<ID>), so two boards with an agent of
// the same name would mix their commits (INT-453). Each board records its agent names in the repository's git
// folder, which all its worktrees share; start reads the others' entries. The file is only a hint: a missing or
// broken one means no clash is known, never a refused start.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const json = require('./jsonfile');

const registryFile = (root) => {
  try {
    const dir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.join(path.resolve(root, dir), 'intellagent-boards.json');
  } catch { return null; }
};
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Record this board's agent names; returns the other board (manifest path) that already has `name`, or null.
function claim(root, manifestPath, names, name) {
  const file = registryFile(root);
  if (!file) return null;
  const boards = json.readOr(file, {}).boards || {};
  const other = Object.keys(boards).find((m) => !same(m, manifestPath) && fs.existsSync(m) && (boards[m] || []).includes(name));
  if (other) return other;
  try {
    for (const m of Object.keys(boards)) if (same(m, manifestPath) || !fs.existsSync(m)) delete boards[m];
    boards[manifestPath] = [...new Set(names)];
    json.writeAtomic(file, { boards });
  } catch { /* a hint only */ }
  return null;
}

module.exports = { claim };
