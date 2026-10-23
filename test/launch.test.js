'use strict';
// lib/launch.js: a long-lived program started outside whoever started it, with their environment and a log.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('../lib/launch');

it('starts the program with the caller\'s environment plus env, output in the log, and writes no file holding them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-launch-'));
  const log = path.join(dir, 'out.log');
  process.env.IA_LAUNCH_TEST_INHERITED = 'inherited';
  // a token-like value with characters a command line or JSON could mangle
  const secret = 'tok "q" & %PATH% é=1';
  const written = [];
  const real = fs.writeFileSync;
  fs.writeFileSync = (...a) => { written.push(a[0]); return real(...a); };
  try {
    launch({ command: process.execPath, args: ['-e', 'console.log(JSON.stringify([process.env.IA_LAUNCH_TEST_INHERITED, process.env.IA_SECRET, process.pid])); setTimeout(() => {}, 60000)'], cwd: os.tmpdir(), env: { IA_SECRET: secret }, log });
  } finally { fs.writeFileSync = real; }
  assert.deepEqual(written, [], 'the environment (tokens) never goes through a file');
  let out = '';
  for (const end = Date.now() + 20_000; Date.now() < end && !out.trim(); await new Promise((r) => setTimeout(r, 200))) out = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const [inherited, got, pid] = JSON.parse(out.trim());
  try {
    assert.deepEqual([inherited, got], ['inherited', secret]);
    assert.doesNotThrow(() => process.kill(pid, 0), 'still running after the go-between exited');
  } finally {
    try { process.kill(pid); } catch { /* gone */ }
    // it holds the log open until it has exited
    for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { break; } }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
