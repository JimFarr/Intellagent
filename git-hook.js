#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/*
 * Git ↔ Intellagent.
 *   node intellagent/git-hook.js install     add a post-commit hook to the current repo
 *   node intellagent/git-hook.js post-commit attach the last commit to every ticket it mentions (e.g. "Fix INT-12")
 *   node intellagent/git-hook.js sync-ci     update each ticket's PR field with CI status (needs the GitHub CLI `gh`)
 * Env: INTELLAGENT_URL (default http://127.0.0.1:7420), INTELLAGENT_TOKEN (if the board requires one),
 *      INTELLAGENT_PR_FIELD (default "pr"), INTELLAGENT_CI_FIELD (default "ci")
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { baseUrl, tokenFor, defaultAgent } = require('./lib/locate');
const request = require('./lib/request');

const BASE = baseUrl();
// A token comes from INTELLAGENT_TOKEN only (INT-467), so with one the hook speaks as the agent it belongs to
// (a standing run's, or the project's default agent); without one it is "git", for boards that need no token.
const AGENT = tokenFor() ? (process.env.INTELLAGENT_AGENT || defaultAgent() || 'git') : 'git';
const PR_FIELD = process.env.INTELLAGENT_PR_FIELD || 'pr';
const CI_FIELD = process.env.INTELLAGENT_CI_FIELD || 'ci';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

async function api(method, p, body) {
  // Bookkeeping must never hold up a commit: a board that is busy (or waiting on this very commit) is skipped.
  const r = await request.send(method, p, body, { agent: AGENT, base: BASE, timeoutMs: 3000 });
  if (!r.ok) throw new Error(`${r.json?.error || `HTTP ${r.status}`}${r.json?.hint ? ` — ${r.json.hint}` : ''}`);
  return r.json ?? {};
}

// https://github.com/owner/repo/commit/<sha> from an origin like git@github.com:owner/repo.git
function commitUrl(sha) {
  let origin = '';
  try { origin = git('remote', 'get-url', 'origin'); } catch { return null; }
  const m = /github\.com[:/](.+?)(\.git)?$/.exec(origin);
  return m ? `https://github.com/${m[1]}/commit/${sha}` : null;
}

async function postCommit() {
  const [sha, subject, author, ...bodyLines] = git('log', '-1', '--format=%H%n%s%n%an%n%b').split('\n');
  const text = `${subject}\n${bodyLines.join('\n')}`;
  const boards = await api('GET', '/api/boards');
  const byPrefix = new Map(boards.map((b) => [b.idPrefix.toUpperCase(), b.id]));
  const ids = [...new Set([...text.matchAll(/\b([A-Z][A-Z0-9]{1,7})-(\d+)\b/g)].map((m) => `${m[1]}-${m[2]}`))];
  const url = commitUrl(sha);
  for (const id of ids) {
    const board = byPrefix.get(id.split('-')[0]);
    if (!board) continue;
    const short = sha.slice(0, 7);
    const body = `**Commit** ${url ? `[\`${short}\`](${url})` : `\`${short}\``} by ${author}\n> ${subject}`;
    try {
      await api('POST', `/api/boards/${board}/items/${id}/comments`, { body });
      if (url) await api('POST', `/api/boards/${board}/items/${id}/attachments`, { url, name: `commit ${short}` });
      console.log(`intellagent: linked ${short} → ${id}`);
    } catch (e) { console.log(`intellagent: ${id}: ${e.message}`); }
  }
}

function install() {
  const hooksDir = path.join(git('rev-parse', '--git-common-dir'), 'hooks');
  const hook = path.join(hooksDir, 'post-commit');
  // Prefer the global command; fall back to this script's absolute path.
  const line = `intellagent hook post-commit 2>/dev/null || node "${__filename.replace(/\\/g, '/')}" post-commit || true`;
  const existing = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8') : '#!/bin/sh\n';
  if (existing.includes('git-hook.js')) { console.log('Hook already installed.'); return; }
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(hook, `${existing.trimEnd()}\n${line}\n`);
  try { fs.chmodSync(hook, 0o755); } catch { /* windows */ }
  console.log(`Installed ${hook}`);
}

// For every ticket whose PR field holds a GitHub PR URL, ask `gh` for its checks and store pending/passing/failing/merged.
async function syncCi() {
  const boards = await api('GET', '/api/boards');
  for (const b of boards) {
    const schema = await api('GET', `/api/boards/${b.id}/schema`);
    if (!schema.fields.some((f) => f.key === PR_FIELD)) continue;
    if (!schema.fields.some((f) => f.key === CI_FIELD)) {
      await api('POST', `/api/boards/${b.id}/schema/fields`, {
        key: CI_FIELD, label: 'CI', type: 'enum', ui: 'read', stub: 'top', icon: 'activity',
        options: [{ value: 'pending', color: '#f2a541' }, { value: 'passing', color: '#4cc38a' }, { value: 'failing', color: '#ff5d73' }, { value: 'merged', color: '#b07cf2' }],
      });
    }
    const found = await api('POST', '/api/search', { board: b.id, where: { [`fields.${PR_FIELD}`]: { contains: '/pull/' } }, full: true, limit: 500 });
    for (const it of found.items) {
      let status;
      try {
        const info = JSON.parse(execFileSync('gh', ['pr', 'view', it.fields[PR_FIELD], '--json', 'state,statusCheckRollup'], { encoding: 'utf8' }));
        const checks = info.statusCheckRollup || [];
        const outcome = (c) => (c.conclusion || c.state || '').toUpperCase();
        if (info.state === 'MERGED') status = 'merged';
        else if (checks.some((c) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(outcome(c)))) status = 'failing';
        else if (checks.length && checks.every((c) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(outcome(c)))) status = 'passing';
        else status = 'pending';
      } catch (e) { console.log(`${it.id}: gh failed (${e.message.split('\n')[0]})`); continue; }
      if (it.fields[CI_FIELD] !== status) {
        await api('PATCH', `/api/boards/${b.id}/items/${it.id}`, { fields: { [CI_FIELD]: status } }).catch((e) => console.log(`${it.id}: ${e.message}`));
        console.log(`${it.id}: CI ${status}`);
      }
    }
  }
}

const cmd = process.argv[2];
if (!BASE && cmd !== 'install') { if (cmd === 'post-commit') process.exit(0); console.error(require('./lib/locate').NO_BOARD); process.exit(3); }
const run = { install, 'post-commit': postCommit, 'sync-ci': syncCi }[cmd];
if (!run) { console.log('Usage: node git-hook.js install | post-commit | sync-ci'); process.exit(1); }
Promise.resolve(run()).catch((e) => { console.error(`intellagent: ${e.message}`); process.exit(cmd === 'post-commit' ? 0 : 1); });
