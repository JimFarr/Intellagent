// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// A sandbox name is a folder name: "." and ".." would point at the board itself (INT-412).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sandbox = require('../lib/sandbox');

test('sandbox names . and .. are refused before anything on disk changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbname-'));
  try {
    const mp = path.join(dir, 'intellagent.manifest.json');
    fs.writeFileSync(mp, '{"name":"real"}\n');
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data', 'board.json'), '{}');
    for (const name of ['..', '.']) {
      await assert.rejects(sandbox.start(mp, name, { fresh: true }), (e) => e.code === 'BAD_REQUEST' && Boolean(e.hint));
    }
    assert.equal(fs.readFileSync(mp, 'utf8'), '{"name":"real"}\n');
    assert.ok(fs.existsSync(path.join(dir, 'data', 'board.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'sandboxes')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI prints the code and hint for sandbox .. and exits 1', () => {
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbname-cli-'));
  try {
    const mp = path.join(dir, 'intellagent.manifest.json');
    fs.writeFileSync(mp, '{"name":"real"}\n');
    const env = { ...process.env, INTELLAGENT_URL: '', INTELLAGENT_AGENT: '' };
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'intellagent.js'), 'sandbox', '..', '--fresh', '--manifest', mp], { cwd: dir, env, encoding: 'utf8', input: '', timeout: 60000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /error 400 BAD_REQUEST: .* — hint: /);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
