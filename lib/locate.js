'use strict';
// Finds the nearest Intellagent manifest by walking up from a folder (like git finds .git),
// and derives the board URL and agent token from it.
const fs = require('fs');
const path = require('path');

const CANDIDATES = [path.join('.intellagent', 'intellagent.manifest.json'), 'intellagent.manifest.json'];

function findManifest(start = process.cwd()) {
  if (process.env.INTELLAGENT_MANIFEST) return path.resolve(process.env.INTELLAGENT_MANIFEST);
  let dir = path.resolve(start);
  for (;;) {
    for (const c of CANDIDATES) {
      const p = path.join(dir, c);
      if (fs.existsSync(p)) return p;
    }
    // a project linked to a board kept elsewhere (intellagent link <board>)
    const link = path.join(dir, '.intellagent', 'link.json');
    if (fs.existsSync(link)) {
      try { const m = JSON.parse(fs.readFileSync(link, 'utf8')).manifest; if (m && fs.existsSync(m)) return m; } catch { /* broken link */ }
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function readManifest(p = findManifest()) {
  if (!p) return null;
  try { return { path: p, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch { return null; }
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
function localSecrets(mp = findManifest()) {
  if (!mp) return {};
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(mp), 'local.json'), 'utf8').replace(/^\uFEFF/, '')) || {}; } catch { return {}; }
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
  try { const t = JSON.parse(fs.readFileSync(path.join(path.dirname(mp), 'local.json'), 'utf8')).userToken; if (t) return t; } catch { /* none */ }
  return readManifest(mp)?.auth?.userToken || null;
}

// Where a board's code is: projectRoot from the manifest, else the folder holding .intellagent/ (or the manifest).
function projectOf(mp, m = readManifest(mp)) {
  if (m?.projectRoot) return path.resolve(path.dirname(mp), String(m.projectRoot));
  return path.basename(path.dirname(mp)) === '.intellagent' ? path.dirname(path.dirname(mp)) : path.dirname(mp);
}

const NO_BOARD = `No Intellagent board for ${process.cwd()}: no .intellagent/ folder here or in any parent. Run "intellagent init" here, or set INTELLAGENT_URL to use a board elsewhere.`;

// Inside a standing-agent run: which run and event batch this call belongs to. A keep-alive session lives
// across runs, so the board rewrites INTELLAGENT_RUN_FILE before each turn; one-shot runs use the env.
function runContext(env = process.env) {
  if (env.INTELLAGENT_RUN_FILE) {
    try { const r = JSON.parse(fs.readFileSync(env.INTELLAGENT_RUN_FILE, 'utf8')); return { run: r.run || null, batch: r.batch || null, events: r.events || null }; } catch { /* between turns */ }
  }
  return { run: env.INTELLAGENT_RUN || null, batch: env.INTELLAGENT_BATCH || null, events: env.INTELLAGENT_EVENTS || null };
}

module.exports = { projectOf, localSecrets, runContext, findManifest, readManifest, baseUrl, tokenFor, defaultAgent, userToken, NO_BOARD };
