'use strict';
// Finds the nearest Intellagent manifest by walking up from a folder (like git finds .git),
// and derives the board URL and agent token from it.
const fs = require('fs');
const path = require('path');
const jsonfile = require('./jsonfile');

const CANDIDATES = [path.join('.intellagent', 'intellagent.manifest.json'), 'intellagent.manifest.json'];

function findManifest(start = process.cwd(), { env = true } = {}) {
  if (env && process.env.INTELLAGENT_MANIFEST) return path.resolve(process.env.INTELLAGENT_MANIFEST);
  let dir = path.resolve(start);
  for (;;) {
    for (const c of CANDIDATES) {
      const p = path.join(dir, c);
      if (fs.existsSync(p)) return p;
    }
    // a project linked to a board kept elsewhere (intellagent link <board>)
    const link = path.join(dir, '.intellagent', 'link.json');
    if (fs.existsSync(link)) {
      try { const m = jsonfile.read(link).manifest; if (m && fs.existsSync(m)) return m; } catch { /* broken link */ }
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function readManifest(p = findManifest()) {
  if (!p) return null;
  try { return { path: p, ...jsonfile.read(p) }; } catch { return null; }
}

// No manifest here (or above) and no explicit INTELLAGENT_URL → no board. Never guess a port: guessing
// once made an agent in one project talk to another project's board.
function baseUrl(m = readManifest()) {
  if (process.env.INTELLAGENT_URL) return process.env.INTELLAGENT_URL;
  if (!m) return null;
  const host = !m.host || m.host === '0.0.0.0' ? '127.0.0.1' : m.host;
  return `http://${host}:${m.port || 7420}`;
}

// local.json beside the manifest (git-ignored): machine-local secrets — the human's userToken and agentTokens.
// {} when there is none. A file that exists but does not parse throws: an unreadable token file must never
// count as "no token" (the board would let anyone act as the human) or be written over (the token is lost).
// A leading BOM is fine (Windows PowerShell 5 and older Notepad save UTF-8 with one).
function readLocal(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  let v;
  try { v = jsonfile.parse(text); } catch (e) { throw new Error(`${file} is not valid JSON (${e.message}). Fix or delete it; it holds the board's tokens.`); }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${file} must hold a JSON object. Fix or delete it; it holds the board's tokens.`);
  return v;
}
// The one writer of local.json, for the CLI and the board alike: read what is on disk now, let `change`
// edit it, write it back through a temp file. Reading and writing happen in one synchronous step, so a key
// the other writer added a moment ago is kept. A file that cannot be read throws and is never written over.
function updateLocal(file, change) {
  const local = readLocal(file);
  change(local);
  jsonfile.writeAtomic(file, local, { mode: 0o600 });
  return local;
}
const localFile = (mp) => path.join(path.dirname(mp), 'local.json');

function localSecrets(mp = findManifest()) {
  if (!mp) return {};
  try { return readLocal(localFile(mp)); } catch { return {}; }
}

// Env wins; then this agent's token in local.json (intellagent token --agent <name>), then the manifest.
function tokenFor(agent, m = readManifest()) {
  return process.env.INTELLAGENT_TOKEN || localSecrets().agentTokens?.[agent] || m?.auth?.agentTokens?.[agent] || null;
}

// The agent name to use when none is given: INTELLAGENT_AGENT wins, then the manifest's defaultAgent
// (written by `intellagent init`), so every tool in a project speaks as the same agent.
function defaultAgent(m = readManifest()) {
  return process.env.INTELLAGENT_AGENT || m?.defaultAgent || null;
}

// The human's token: .intellagent/local.json (git-ignored), else the manifest's auth.userToken.
function userToken(mp = findManifest()) {
  if (!mp) return null;
  const t = localSecrets(mp).userToken;
  if (t) return t;
  return readManifest(mp)?.auth?.userToken || null;
}

// Where a board's code is: projectRoot from the manifest, else the folder holding .intellagent/ (or the manifest).
function projectOf(mp, m = readManifest(mp)) {
  if (m?.projectRoot) return path.resolve(path.dirname(mp), String(m.projectRoot));
  return path.basename(path.dirname(mp)) === '.intellagent' ? path.dirname(path.dirname(mp)) : path.dirname(mp);
}

// The Intellagent code in `root` is an agent's worktree (a linked git worktree has a .git file, not a folder) and
// not the board's own project: unreviewed code serving someone's board (INT-405). A sandbox --from <author> names
// that worktree as its projectRoot, so it is not foreign.
function foreignCode(root, mp, m = readManifest(mp)) {
  try { if (!fs.statSync(path.join(root, '.git')).isFile()) return false; } catch { return false; }
  return path.resolve(projectOf(mp, m)).toLowerCase() !== path.resolve(root).toLowerCase();
}

const NO_BOARD = `No Intellagent board for ${process.cwd()}: no .intellagent/ folder here or in any parent. Run "intellagent init" here, or set INTELLAGENT_URL to use a board elsewhere.`;

// Inside a standing-agent run: which run and event batch this call belongs to. A keep-alive session lives
// across runs, so the board rewrites INTELLAGENT_RUN_FILE before each turn; one-shot runs use the env.
function runContext(env = process.env) {
  if (env.INTELLAGENT_RUN_FILE) {
    try { const r = jsonfile.read(env.INTELLAGENT_RUN_FILE); return { run: r.run || null, batch: r.batch || null, events: r.events || null }; } catch { /* between turns */ }
  }
  return { run: env.INTELLAGENT_RUN || null, batch: env.INTELLAGENT_BATCH || null, events: env.INTELLAGENT_EVENTS || null };
}

module.exports = { projectOf, foreignCode, localSecrets, readLocal, updateLocal, runContext, findManifest, readManifest, baseUrl, tokenFor, defaultAgent, userToken, NO_BOARD };
