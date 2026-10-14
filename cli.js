#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/*
 * Tiny API client so agents don't fight shell quoting.
 *   intellagent api GET  /api/boards/main/summary
 *   intellagent api POST /api/boards/main/items title="Fix login" priority=High fields.risk=low
 *   intellagent api POST /api/boards/main/items '{"title":"Hello"}'
 *   echo {"body":"hi"} | intellagent api POST /api/boards/main/items/INT-1/comments -
 *   intellagent api PATCH /api/boards/main/items/INT-1 @patch.json
 * key=value: dotted keys nest (fields.risk=low); values are parsed as JSON when possible
 * (3, true, null, ["a","b"]) and kept as text otherwise. --compact prints one-line JSON.
 * Output: the reply as JSON on stdout; on an error also "error <status> <CODE>: <message> — hint: …" on
 * stderr and exit 1 (2: can't reach the board or bad input, 3: no board found). Never prompts.
 * Env: INTELLAGENT_AGENT (your name). The board is found from the nearest .intellagent/ folder,
 * or set INTELLAGENT_URL explicitly.
 */
'use strict';
const fs = require('fs');
const { fromPairs, send, report } = require('./lib/request');

const argv = process.argv.slice(2);
const compact = argv.includes('--compact');
const [method = 'GET', rawPath = '/api', ...args] = argv.filter((x) => x !== '--compact' && x !== '--json');
// Git Bash (MSYS) rewrites "/api/x" into "C:/Program Files/Git/api/x" — undo that, and allow "api/x" without a slash.
const path = `/${rawPath.replace(/^[A-Za-z]:[\\/].*?(?=[\\/](api|files)\b)/, '').replace(/\\/g, '/').replace(/^\/+/, '')}`;

function readBody() {
  if (!args.length) return undefined;
  const [first] = args;
  if (args.length === 1 && first === '-') return fs.readFileSync(0, 'utf8');
  if (args.length === 1 && first.startsWith('@')) return fs.readFileSync(first.slice(1), 'utf8');
  if (args.length === 1 && /^\s*[[{]/.test(first)) return first;
  return fromPairs(args);
}

(async () => {
  const r = await send(method, path, readBody());
  process.exitCode = report(r, { compact });
})().catch((e) => { console.error(e.message); process.exit(e.exit || 2); });
