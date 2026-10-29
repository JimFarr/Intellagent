'use strict';
// One record per run (INT-310): agent-stats.jsonl in the board's data folder, about 300 bytes a run. It is the
// raw material for the analytics page; nothing here wakes or changes an agent.
const fs = require('fs');
const path = require('path');

const FILE = 'agent-stats.jsonl';
const MAX_BYTES = 5 * 1024 * 1024; // like events.jsonl, the live file rolls over once it passes this

// total_cost_usd of a "result" object, or null when it gives none (null, never 0: no result line means unknown)
function costOf(m) {
  const c = m && typeof m === 'object' ? m.total_cost_usd : null;
  return Number.isFinite(c) && c >= 0 ? c : null;
}
// A keep-alive session reports its RUNNING total on every result, so one turn's cost is the difference from the
// turn before. A total below the previous one means the counter restarted: the new total is the turn's own cost.
function turnCost(prevTotal, total) {
  if (total == null) return null;
  if (prevTotal == null || total < prevTotal) return round(total);
  return round(total - prevTotal);
}
const round = (n) => Math.round(n * 1e6) / 1e6;

// The command's own name, never its line (a line can hold a secret): "FOO=1 node --test x" -> "node",
// "C:/tools/git.exe status" -> "git", "cd x && npm test" -> "cd".
function commandName(line) {
  for (const w of String(line || '').trim().split(/\s+/)) {
    // leading NAME=value. One that holds a quote may hold a space too (API_KEY="a b"), so the rest of the line could
    // be part of a secret: give no name at all rather than risk it
    // (a backslash can escape a space too, API_KEY=a\ b, so it counts like a quote)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { if (/["'`\\]/.test(w)) return null; continue; }
    if (!w) continue;
    const base = w.replace(/^["']+|["']+$/g, '').split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '');
    return /^[\w.+-]+$/.test(base) ? base : null;
  }
  return null;
}

// What a stream-json line says about tools: a tool_use block per call. { tools: { Bash: 2 }, commands: ['git'] }
function addTools(acc, m) {
  if (!m || m.type !== 'assistant' || !Array.isArray(m.message?.content)) return;
  for (const b of m.message.content) {
    if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
    acc.tools[b.name] = (acc.tools[b.name] || 0) + 1;
    if (b.name === 'Bash') { const c = commandName(b.input?.command); if (c && !acc.commands.includes(c)) acc.commands.push(c); }
  }
}
const newTools = () => ({ tools: {}, commands: [] });

// Run result: ok | failed | timeout | stopped | limited
function resultOf(code, limited) {
  if (limited) return 'limited';
  if (code === 'stopped') return 'stopped';
  if (code === 'timeout') return 'timeout';
  return code === 0 ? 'ok' : 'failed';
}

// The last "result" object in a one-shot run's log (everything after the prompt), or null.
function lastResult(text) {
  const out = String(text || '');
  const lines = out.slice(Math.max(0, out.lastIndexOf('--- output ---'))).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try { const m = JSON.parse(line); if (m.type === 'result') return m; } catch { /* not a result line */ }
  }
  return null;
}

// What a run's tool permissions refused (INT-487): the result line's permission_denials, as names only (a Bash
// denial by its command name, never its line or arguments), deduped, at most 5.
function denialsOf(m) {
  const out = new Set();
  for (const d of Array.isArray(m?.permission_denials) ? m.permission_denials : []) {
    const tool = String(d?.tool_name || '').replace(/[^\w.:-]/g, '').slice(0, 40);
    if (!tool) continue;
    const cmd = tool === 'Bash' ? commandName(d.tool_input?.command) : null;
    out.add(cmd ? `Bash:${cmd}` : tool);
  }
  return [...out].slice(0, 5);
}

// A triage run (INT-308) that finds it must build ends its answer with this marker on a line of its own.
const ESCALATE = '[[needs-build]]';
const escalates = (m) => typeof m?.result === 'string' && m.result.split('\n').some((l) => l.trim() === ESCALATE);

function createStats(dir, { maxBytes = MAX_BYTES } = {}) {
  const live = path.join(dir, FILE);
  function append(rec) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // rolled files are kept on purpose (unlike events.jsonl): about 17k runs a file, and analytics wants the history
      try { if (fs.statSync(live).size > maxBytes) fs.renameSync(live, path.join(dir, `agent-stats-${Date.now()}.jsonl`)); } catch { /* none yet */ }
      fs.appendFileSync(live, `${JSON.stringify(rec)}\n`);
    } catch { /* statistics never break a run */ }
  }
  // every record, oldest first: the rolled files (by their timestamp) and then the live one. A torn line is skipped.
  function read() {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /^agent-stats-\d+\.jsonl$/.test(f)).sort((a, b) => parseInt(a.slice(12), 10) - parseInt(b.slice(12), 10)); } catch { return []; }
    files.push(FILE);
    const out = [];
    for (const f of files) {
      let text;
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      for (const l of text.split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* torn line */ } }
    }
    return out;
  }
  return { append, read, file: live };
}

module.exports = { createStats, lastResult, denialsOf, escalates, ESCALATE, costOf, turnCost, commandName, addTools, newTools, resultOf, FILE };
