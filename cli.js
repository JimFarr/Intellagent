#!/usr/bin/env node
/*
 * Tiny API client so agents don't fight shell quoting.
 *   intellagent api GET  /api/boards/main/summary
 *   intellagent api POST /api/boards/main/items title="Fix login" priority=High fields.risk=low
 *   intellagent api POST /api/boards/main/items '{"title":"Hello"}'
 *   echo {"body":"hi"} | intellagent api POST /api/boards/main/items/INT-1/comments -
 *   intellagent api PATCH /api/boards/main/items/INT-1 @patch.json
 * key=value: dotted keys nest (fields.risk=low); values are parsed as JSON when possible
 * (3, true, null, ["a","b"]) and kept as text otherwise.
 * Env: INTELLAGENT_AGENT (your name). The board is found from the nearest .intellagent/ folder,
 * or set INTELLAGENT_URL explicitly.
 */
'use strict';
const fs = require('fs');
const { baseUrl, tokenFor, defaultAgent, NO_BOARD } = require('./lib/locate');

const [method = 'GET', rawPath = '/api', ...args] = process.argv.slice(2);
// Git Bash (MSYS) rewrites "/api/x" into "C:/Program Files/Git/api/x" — undo that, and allow "api/x" without a slash.
const path = `/${rawPath.replace(/^[A-Za-z]:[\\/].*?(?=[\\/](api|files)\b)/, '').replace(/\\/g, '/').replace(/^\/+/, '')}`;
const base = baseUrl();
const agent = defaultAgent() || 'cli-agent';
const token = tokenFor(agent);

function fromPairs(pairs) {
  const out = {};
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i < 1) throw new Error(`Expected key=value, got "${pair}"`);
    const keys = pair.slice(0, i).split('.');
    let v = pair.slice(i + 1);
    try { v = JSON.parse(v); } catch { /* plain text */ }
    let t = out;
    for (const k of keys.slice(0, -1)) t = (t[k] ||= {});
    t[keys[keys.length - 1]] = v;
  }
  return JSON.stringify(out);
}

function readBody() {
  if (!args.length) return undefined;
  const [first] = args;
  if (args.length === 1 && first === '-') return fs.readFileSync(0, 'utf8');
  if (args.length === 1 && first.startsWith('@')) return fs.readFileSync(first.slice(1), 'utf8');
  if (args.length === 1 && /^\s*[[{]/.test(first)) return first;
  return fromPairs(args);
}

(async () => {
  if (!base) { console.error(NO_BOARD); process.exit(3); }
  const body = readBody();
  const res = await fetch(base + path, {
    method: method.toUpperCase(),
    headers: { 'Content-Type': 'application/json', 'X-Agent': agent, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body,
  });
  const text = await res.text();
  let out = text;
  try { out = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON (e.g. docs) */ }
  process.stdout.write(`${out}\n`);
  if (!res.ok) process.exit(1);
})().catch((e) => { console.error(e.message.startsWith('Expected') ? e.message : `Cannot reach ${base}: ${e.message}`); process.exit(2); });
