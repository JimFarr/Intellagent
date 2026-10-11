#!/usr/bin/env node
/*
 * Tiny API client so agents don't fight shell quoting.
 *   node cli.js GET  /api/boards/main/summary
 *   node cli.js POST /api/boards/main/items '{"title":"Hello"}'
 *   echo {"body":"hi"} | node cli.js POST /api/boards/main/items/INT-1/comments -
 *   node cli.js PATCH /api/boards/main/items/INT-1 @patch.json
 * Env: INTELLAGENT_URL (default http://127.0.0.1:7420), INTELLAGENT_AGENT (your name)
 */
'use strict';
const fs = require('fs');
const { baseUrl, tokenFor } = require('./lib/locate');

const [method = 'GET', rawPath = '/api', arg] = process.argv.slice(2);
// Git Bash (MSYS) rewrites "/api/x" into "C:/Program Files/Git/api/x" — undo that, and allow "api/x" without a slash.
const path = `/${rawPath.replace(/^[A-Za-z]:[\\/].*?(?=[\\/](api|files)\b)/, '').replace(/\\/g, '/').replace(/^\/+/, '')}`;
const base = baseUrl();
const agent = process.env.INTELLAGENT_AGENT || 'cli-agent';
const token = tokenFor(agent);

function readBody() {
  if (arg === undefined) return undefined;
  if (arg === '-') return fs.readFileSync(0, 'utf8');
  if (arg.startsWith('@')) return fs.readFileSync(arg.slice(1), 'utf8');
  return arg;
}

(async () => {
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
})().catch((e) => { console.error(`Cannot reach ${base}: ${e.message}`); process.exit(2); });
