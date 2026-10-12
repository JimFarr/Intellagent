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

// Env wins; otherwise a token configured for this agent in the local manifest (the file is already trusted locally).
function tokenFor(agent, m = readManifest()) {
  return process.env.INTELLAGENT_TOKEN || m?.auth?.agentTokens?.[agent] || null;
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

const NO_BOARD = `No Intellagent board for ${process.cwd()}: no .intellagent/ folder here or in any parent. Run "intellagent init" here, or set INTELLAGENT_URL to use a board elsewhere.`;

module.exports = { findManifest, readManifest, baseUrl, tokenFor, defaultAgent, userToken, NO_BOARD };
