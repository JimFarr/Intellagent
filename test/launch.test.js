'use strict';
// lib/launch.js: a long-lived program started outside whoever started it, with their environment and a log.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('../lib/launch');

it('starts the program with the caller\'s environment plus env, output in the log; the job file is gone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-launch-'));
  const log = path.join(dir, 'out.log');
  process.env.IA_LAUNCH_TEST_INHERITED = 'inherited';
  launch({ command: process.execPath, args: ['-e', 'console.log(process.env.IA_LAUNCH_TEST_INHERITED, process.env.IA_EXTRA, process.pid); setTimeout(() => {}, 60000)'], cwd: os.tmpdir(), env: { IA_EXTRA: 'extra' }, log });
  let out = '';
  for (const end = Date.now() + 20_000; Date.now() < end && !out.trim(); await new Promise((r) => setTimeout(r, 200))) out = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const [inherited, extra, pid] = out.trim().split(' ');
  try {
    assert.deepEqual([inherited, extra], ['inherited', 'extra']);
    assert.doesNotThrow(() => process.kill(Number(pid), 0), 'still running after the go-between exited');
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('intellagent-launch-')), [], 'the job file (it holds the environment) is deleted');
  } finally {
    try { process.kill(Number(pid)); } catch { /* gone */ }
    // it holds the log open until it has exited
    for (let i = 0; i < 50; i++) { try { process.kill(Number(pid), 0); await new Promise((r) => setTimeout(r, 100)); } catch { break; } }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
