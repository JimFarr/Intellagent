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

function baseUrl(m = readManifest()) {
  if (process.env.INTELLAGENT_URL) return process.env.INTELLAGENT_URL;
  if (!m) return 'http://127.0.0.1:7420';
  const host = !m.host || m.host === '0.0.0.0' ? '127.0.0.1' : m.host;
  return `http://${host}:${m.port || 7420}`;
}

// Env wins; otherwise a token configured for this agent in the local manifest (the file is already trusted locally).
function tokenFor(agent, m = readManifest()) {
  return process.env.INTELLAGENT_TOKEN || m?.auth?.agentTokens?.[agent] || null;
}

module.exports = { findManifest, readManifest, baseUrl, tokenFor };
