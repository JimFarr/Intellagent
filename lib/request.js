'use strict';
/* One way for the CLI to call the board (intellagent api, intellagent do): identity, token, run tagging and
   retry-safe Idempotency-Keys, and output an agent can rely on:
     stdout  the reply as JSON (pretty), or text when the reply isn't JSON
     stderr  on an error, one line: "error <status> <CODE>: <message> — hint: <hint>"
     exit    0 ok · 1 the API said no (4xx/5xx) · 2 the board can't be reached / bad input · 3 no board found */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { baseUrl, tokenFor, defaultAgent, runContext, findManifest, readManifest, projectOf, NO_BOARD } = require('./locate');

const FILE_MAX = 2 * 1024 * 1024;

// key=@path: the text of that file. The rules are the board's for attachments by path: from the project, its
// worktrees and the OS temp folder only, and never local.json or the board's data. Every call made here is an
// agent's, so there is no wider rule for the human.
function fileValue(file) {
  const fail = (status, code, msg, hint) => Object.assign(new Error(`error ${status} ${code}: ${msg} — hint: ${hint}`), { exit: 2 });
  const given = path.resolve(file);
  if (!fs.existsSync(given)) throw fail(400, 'BAD_REQUEST', `no file at ${given}`, 'give the absolute path of a file that exists; for a literal @ at the start of the text, write key=@@text');
  if (!fs.statSync(given).isFile()) throw fail(400, 'BAD_REQUEST', `${given} is not a file`, 'give the path of a file');
  const real = fs.realpathSync.native(given); // through symlinks and junctions
  const norm = (p) => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const inside = (dir) => { try { dir = fs.realpathSync.native(dir); } catch { /* not there: compare as is */ } const rel = path.relative(norm(dir), norm(real)); return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel)); };
  // the folders come from the board found where the agent runs, never from --manifest / INTELLAGENT_MANIFEST:
  // an agent can make a board of its own whose "project" is the whole disk
  const mp = findManifest(process.cwd(), { env: false });
  const m = mp ? readManifest(mp) : null;
  const hint = 'put the text in a file in the project, your worktree or the temp folder, or pass it inline as key=text';
  const dataOf = (p) => path.resolve(path.dirname(p), readManifest(p)?.dataDir || './data');
  const boards = [mp, process.env.INTELLAGENT_MANIFEST && path.resolve(process.env.INTELLAGENT_MANIFEST)].filter(Boolean);
  if (path.basename(norm(real)) === 'local.json' || boards.some((p) => inside(dataOf(p)))) {
    throw fail(403, 'FORBIDDEN', 'the CLI does not read the board\'s tokens or data into a request', hint);
  }
  const roots = mp ? [projectOf(mp, m), path.join(path.dirname(mp), 'worktrees'), os.tmpdir()] : [process.cwd(), os.tmpdir()];
  if (!roots.some(inside)) throw fail(403, 'FORBIDDEN', `${real} is outside the folders an agent may read from`, hint);
  if (fs.statSync(real).size > FILE_MAX) throw fail(413, 'TOO_LARGE', `${real} is over ${FILE_MAX / 1024 / 1024} MB`, 'send a shorter text, or attach the file with "attachments"');
  return fs.readFileSync(real, 'utf8');
}

// A value that starts with @ is a file when it is meant as one: a single word that names a file that exists, or that
// has a path separator (so a missing file is an error, not a silent literal). "@rocket take this" and a bare
// "@rocket" stay what they always were, text.
function atValue(v) {
  const ref = v.slice(1);
  if (!ref) return v;
  let isFile = false;
  try { isFile = fs.statSync(path.resolve(ref)).isFile(); } catch { /* not there */ }
  if (isFile) return fileValue(ref);
  return /\s/.test(ref) || !/[\\/]/.test(ref) ? v : fileValue(ref);
}

// key=value pairs → object. Dotted keys nest (fields.risk=low); values parse as JSON when they can
// (3, true, null, ["a","b"], {"a":1}) and stay text otherwise. key=@path takes the value from a file (kept as
// text, not parsed); key=@@text is the text "@text".
function fromPairs(pairs) {
  const out = {};
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i < 1) throw Object.assign(new Error(`Expected key=value, got "${pair}"`), { usage: true });
    const keys = pair.slice(0, i).split('.');
    let v = pair.slice(i + 1);
    if (v.startsWith('@@')) v = v.slice(1);
    else if (v.startsWith('@')) v = atValue(v);
    else try { v = JSON.parse(v); } catch { /* plain text */ }
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

module.exports = { fromPairs, fileValue, send, headersFor, report, agentName };
