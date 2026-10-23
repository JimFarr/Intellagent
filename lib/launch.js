'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Starts a long-lived program (the board, the lease program) that must outlive whoever started it. On Windows a
// detached child still belongs to its starter's job object (libuv never asks to break away), so a board started
// from an agent's or an app's session died with that session. There WMI starts this file as a go-between, a
// process no caller owns, in no caller's job; it starts the program and exits. The caller's environment (tokens
// too) goes to it in WMI's own startup block, never through a file; its command line carries only paths.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

function start({ command, args, cwd, log }, env) {
  const fd = fs.openSync(log, 'a');
  spawn(command, args, { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] }).unref();
}

const PS = '$e = [string[]](ConvertFrom-Json $env:IA_LAUNCH_ENV); '
  + '$s = New-CimInstance -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = $e } -ClientOnly; '
  + '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:IA_LAUNCH_CMD; CurrentDirectory = $env:IA_LAUNCH_CWD; ProcessStartupInformation = $s }; '
  + 'if ($r.ReturnValue -ne 0) { [Console]::Error.WriteLine("Win32_Process.Create returned " + $r.ReturnValue); exit 1 }';

// Starts command with args in cwd, output appended to log, environment: this process's plus env.
function launch({ command, args = [], cwd, env = {}, log }) {
  const all = { ...process.env, ...env };
  if (process.platform !== 'win32') return start({ command, args, cwd, log }, all);
  const job = Buffer.from(JSON.stringify({ command, args, cwd, log })).toString('base64');
  const line = [process.execPath, __filename, job].map((a) => `"${a}"`).join(' ');
  const block = JSON.stringify(Object.entries(all).filter(([k]) => k && !k.startsWith('=')).map(([k, v]) => `${k}=${v}`));
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { windowsHide: true, encoding: 'utf8', env: { ...process.env, IA_LAUNCH_CMD: line, IA_LAUNCH_CWD: cwd, IA_LAUNCH_ENV: block } });
  if (r.status !== 0) throw new Error(`could not start ${command}: ${(r.stderr || r.error?.message || '').trim()}`);
}

// the go-between: node launch.js <job, base64 JSON>; its environment is the caller's, from WMI
if (require.main === module) start(JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8')), process.env);

module.exports = { launch };
