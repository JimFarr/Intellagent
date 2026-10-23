'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Starts a long-lived program (the board, the lease program) that must outlive whoever started it. On Windows a
// detached child still belongs to its starter's job object (libuv never asks to break away), so a board started
// from an agent's or an app's session died with that session. There WMI starts this file as a go-between, a
// process no caller owns, in no caller's job; it starts the program with the caller's environment and exits.
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function start({ command, args, cwd, env, log }) {
  const fd = fs.openSync(log, 'a');
  spawn(command, args, { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] }).unref();
}

const PS = '$s = New-CimInstance -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0 } -ClientOnly; '
  + '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:IA_LAUNCH_CMD; CurrentDirectory = $env:IA_LAUNCH_CWD; ProcessStartupInformation = $s }; '
  + 'if ($r.ReturnValue -ne 0) { [Console]::Error.WriteLine("Win32_Process.Create returned " + $r.ReturnValue); exit 1 }';

// Starts command with args in cwd, output appended to log, environment: this process's plus env.
function launch({ command, args = [], cwd, env = {}, log }) {
  const job = { command, args, cwd, env: { ...process.env, ...env }, log };
  if (process.platform !== 'win32') return start(job);
  // the job holds the caller's environment (tokens too): only this user may read it, and the go-between deletes it first
  const file = path.join(os.tmpdir(), `intellagent-launch-${crypto.randomBytes(8).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify(job), { mode: 0o600 });
  const line = [process.execPath, __filename, file].map((a) => `"${a}"`).join(' ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { windowsHide: true, encoding: 'utf8', env: { ...process.env, IA_LAUNCH_CMD: line, IA_LAUNCH_CWD: cwd } });
  if (r.status !== 0) { try { fs.rmSync(file); } catch { /* gone */ } throw new Error(`could not start ${command}: ${(r.stderr || r.error?.message || '').trim()}`); }
  return file; // the job file, for a test to check the go-between deleted it
}

// the go-between: node launch.js <job file>
if (require.main === module) {
  const file = process.argv[2];
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.rmSync(file);
  start(job);
}

module.exports = { launch };
