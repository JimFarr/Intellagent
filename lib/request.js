'use strict';
/* One way for the CLI to call the board (intellagent api, intellagent do): identity, token, run tagging and
   retry-safe Idempotency-Keys, and output an agent can rely on:
     stdout  the reply as JSON (pretty), or text when the reply isn't JSON
     stderr  on an error, one line: "error <status> <CODE>: <message> — hint: <hint>"
     exit    0 ok · 1 the API said no (4xx/5xx) · 2 the board can't be reached / bad input · 3 no board found */
const crypto = require('crypto');
const { baseUrl, tokenFor, defaultAgent, runContext, NO_BOARD } = require('./locate');

// key=value pairs → object. Dotted keys nest (fields.risk=low); values parse as JSON when they can
// (3, true, null, ["a","b"], {"a":1}) and stay text otherwise.
function fromPairs(pairs) {
  const out = {};
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i < 1) throw Object.assign(new Error(`Expected key=value, got "${pair}"`), { usage: true });
    const keys = pair.slice(0, i).split('.');
    let v = pair.slice(i + 1);
    try { v = JSON.parse(v); } catch { /* plain text */ }
    let t = out;
    for (const k of keys.slice(0, -1)) t = (t[k] ||= {});
    t[keys[keys.length - 1]] = v;
  }
  return out;
}

const agentName = () => defaultAgent() || 'cli-agent';

// The headers of every call an agent makes: who it is, its token, the run it belongs to.
function headersFor(agent, extra = {}) {
  const token = tokenFor(agent);
  const { run } = runContext();
  return {
    'Content-Type': 'application/json', 'X-Agent': agent,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(run ? { 'X-Intellagent-Run': run } : {}),
    ...extra,
  };
}

// Inside a standing-agent run: an Idempotency-Key derived from the batch, so a retry that repeats an
// identical write gets the first reply instead of doing it twice.
function idempotencyKey(method, path, text) {
  const { batch } = runContext();
  return batch && method !== 'GET' ? crypto.createHash('sha1').update(`${batch}|${method}|${path}|${text || ''}`).digest('hex') : null;
}

// options: agent (default: this process's agent), base (default: the nearest board), timeoutMs, headers.
async function send(method, path, body, { agent = agentName(), base = baseUrl(), timeoutMs, headers } = {}) {
  if (!base) { const e = new Error(NO_BOARD); e.exit = 3; throw e; }
  const M = method.toUpperCase();
  const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const idem = idempotencyKey(M, path, text);
  let res;
  try {
    res = await fetch(base + path, {
      method: M,
      headers: headersFor(agent, { ...(idem ? { 'Idempotency-Key': idem } : {}), ...headers }),
      body: text,
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (e) { const err = new Error(`Cannot reach ${base}: ${e.message} — is the board running? (intellagent start)`); err.exit = 2; throw err; }
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not JSON, e.g. docs */ }
  return { status: res.status, ok: res.ok, raw, json };
}

// Print a reply the agent-friendly way, and set the exit code.
function report(r, { compact = false } = {}) {
  const out = r.json != null ? JSON.stringify(r.json, null, compact ? 0 : 2) : r.raw;
  process.stdout.write(`${out}\n`);
  if (r.ok) return 0;
  const j = r.json || {};
  process.stderr.write(`error ${r.status}${j.code ? ` ${j.code}` : ''}: ${j.error || r.raw.slice(0, 200)}${j.hint ? ` — hint: ${j.hint}` : ''}\n`);
  return 1;
}

module.exports = { fromPairs, send, headersFor, report, agentName };
