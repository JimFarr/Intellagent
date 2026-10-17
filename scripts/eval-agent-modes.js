#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
/*
 * Do agents do as well with less? Runs realistic board tasks with a real model in three modes and checks
 * the board afterwards:
 *   full   all 52 MCP tools, no skill
 *   core   the core MCP profile + the intellagent skill + the CLI (Bash(intellagent *))
 *   cli    the skill + the CLI only, no MCP
 * Every run gets a fresh throwaway board (seeded through the API), the outcome is verified through the API,
 * and the run's own stream says how many tool calls and errors it took and what it cost in tokens.
 *
 *   node scripts/eval-agent-modes.js [--model haiku] [--modes full,core,cli] [--tasks claim,review] [--repeat 1] [--out results.json]
 * Needs: the `claude` CLI, signed in. Costs real tokens (haiku: ~2–6 cents a run).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : acc), []));
const MODEL = args.model || 'haiku';
const MODES = String(args.modes || 'full,core,cli').split(',');
const REPEAT = Number(args.repeat) || 1;
const AGENT = 'evalbot';
const SKILL = fs.readFileSync(path.join(ROOT, 'skills', 'intellagent', 'SKILL.md'), 'utf8');
const CORE = ['get_briefing', 'get_my_work', 'get_item', 'start_work', 'set_status', 'add_comment', 'ask_human', 'request_review', 'wait_for_events', 'finish_session'];

/* ── a throwaway board ── */
async function board() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-eval-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const mp = path.join(dir, 'intellagent.manifest.json');
  fs.writeFileSync(mp, JSON.stringify({ port, dataDir: './data', seed: 'empty', template: 'default', idPrefix: 'T', defaultAgent: AGENT }));
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, INTELLAGENT_MANIFEST: mp, INTELLAGENT_PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api`)).ok) break; } catch { /* starting */ }
    if (i > 100) throw new Error('board did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  const call = async (method, p, body, as = { user: 'James' }) => {
    const headers = { 'content-type': 'application/json', ...(as.user ? { 'x-user': as.user, origin: base } : { 'x-agent': as.agent }) };
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return t; }
  };
  return { dir, base, call, stop: () => { proc.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* busy */ } } };
}
const B = '/api/boards/main';
const bot = { agent: AGENT };

/* ── the tasks: setup (board state), prompt, check (expected API effects) ── */
const TASKS = [
  {
    key: 'claim', title: 'Claim a ready ticket and post a status',
    setup: async (c) => { await c('POST', `${B}/items`, { title: 'Fix the login typo', column: 'Ready' }); },
    prompt: 'On the Intellagent board, pick up the ready ticket T-1 ("Fix the login typo") and start working on it, with a status line saying what you are doing first. Do not do the work itself; just claim it properly.',
    check: async (c) => { const it = await c('GET', `${B}/items/T-1`); return it.column === 'In Progress' && it.lease?.claimant === AGENT && !!it.lease?.status; },
  },
  {
    key: 'status', title: 'Post a live status on a ticket you hold',
    setup: async (c) => { await c('POST', `${B}/items`, { title: 'Parser rewrite', column: 'Ready' }); await c('POST', `${B}/items/T-1/start`, {}, bot); },
    prompt: 'You are working on Intellagent ticket T-1. Post the live status "running tests 3/10" on it.',
    check: async (c) => (await c('GET', `${B}/items/T-1`)).lease?.status === 'running tests 3/10',
  },
  {
    key: 'ask', title: 'Ask the human a question and wait for the answer',
    setup: async (c) => { await c('POST', `${B}/items`, { title: 'Single sign-on', column: 'Ready' }); await c('POST', `${B}/items/T-1/start`, {}, bot); },
    // a scripted human answers as soon as the question appears
    human: async (c) => {
      for (let i = 0; i < 300; i++) {
        const it = await c('GET', `${B}/items/T-1`);
        const q = (it.questions || []).find((x) => x.raisedBy === AGENT);
        if (q) { await new Promise((r) => setTimeout(r, 3000)); await c('DELETE', `${B}/items/T-1/attention`, { questionId: q.id, reply: 'Yes — SSO through Okta only.' }); return; }
        await new Promise((r) => setTimeout(r, 1000));
      }
    },
    prompt: 'You are working on Intellagent ticket T-1. Ask the human on the card whether SSO should be supported and through which provider. Then wait for the answer, and post a comment on T-1 that starts with "Answer:" and repeats it.',
    check: async (c) => (await c('GET', `${B}/items/T-1`)).comments.some((x) => x.author?.name === AGENT && /^Answer:/i.test(x.body) && /okta/i.test(x.body)),
  },
  {
    key: 'review', title: 'Request review with a five-part explanation',
    setup: async (c) => { await c('POST', `${B}/items`, { title: 'Fix the login typo', column: 'Ready' }); await c('POST', `${B}/items/T-1/start`, {}, bot); },
    prompt: 'You finished Intellagent ticket T-1 in an earlier session: you fixed the typo "Pasword" → "Password" in login.html, committed it, and the tests pass (the code is not in this folder — no need to look for it). Now request the human\'s review with the board\'s five-part explanation.',
    check: async (c) => { const it = await c('GET', `${B}/items/T-1`); const n = it.comments.find((x) => x.review)?.review || {}; return it.column === 'Review' && !!(n.changed && n.why && n.verify); },
  },
  {
    key: 'search', title: 'Search for a ticket and move it',
    setup: async (c) => {
      for (const [title, priority] of [['Tidy the footer', 'Low'], ['Payment timeout on checkout', 'Critical'], ['Payment page copy', 'Low'], ['Login rate limit', 'High']]) await c('POST', `${B}/items`, { title, priority, column: 'Backlog' });
    },
    prompt: 'On the Intellagent board, find the Critical-priority ticket about payments and move it to the Ready column. Leave everything else as it is.',
    check: async (c) => { const all = await Promise.all([1, 2, 3, 4].map((n) => c('GET', `${B}/items/T-${n}`))); return all[1].column === 'Ready' && [0, 2, 3].every((i) => all[i].column === 'Backlog'); },
  },
  {
    key: 'attach', title: 'Attach a file to a ticket',
    setup: async (c, b) => {
      await c('POST', `${B}/items`, { title: 'Broken header on mobile', column: 'Ready' });
      fs.writeFileSync(path.join(b.dir, 'screenshot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    },
    prompt: (b) => `Attach the screenshot at ${path.join(b.dir, 'screenshot.png').replace(/\\/g, '/')} to Intellagent ticket T-1.`,
    check: async (c) => (await c('GET', `${B}/items/T-1`)).attachments.some((a) => a.name === 'screenshot.png'),
  },
  {
    key: 'handover', title: 'Hand over a lease that another agent asked for',
    setup: async (c) => {
      await c('POST', `${B}/items`, { title: 'CSV parser', column: 'Ready' });
      await c('POST', `${B}/items/T-1/start`, {}, bot);
      await c('POST', `${B}/items/T-1/lease/request`, { reason: 'I own the import pipeline' }, { agent: 'mid' });
    },
    prompt: 'The agent "mid" has asked for Intellagent ticket T-1, which you hold. Hand it over to mid with a note saying you finished the parser and the tests still need updating.',
    check: async (c) => (await c('GET', `${B}/items/T-1`)).lease?.claimant === 'mid',
  },
  {
    key: 'digest', title: 'Read the digest',
    setup: async (c) => { await c('POST', `${B}/digest`, { summary: 'Shipped the CSV export; next: the PDF report.' }, { agent: 'mid' }); },
    prompt: 'According to the Intellagent board\'s digest, what did the agent "mid" ship? Reply with just the feature name.',
    check: async (c, out) => /csv export/i.test(out),
  },
];

// The claude executable, spawned without a shell (a shell splits arguments with spaces). On Windows npm installs
// a .cmd shim; use the program it points at.
function claudeCommand() {
  if (process.platform !== 'win32') return ['claude'];
  for (const dir of String(process.env.PATH).split(path.delimiter)) {
    const shim = path.join(dir, 'claude.cmd');
    if (!fs.existsSync(shim)) continue;
    const m = /"%dp0%\\([^"]+)"/.exec(fs.readFileSync(shim, 'utf8'));
    if (!m) continue;
    const target = path.join(dir, m[1]);
    return target.endsWith('.js') ? [process.execPath, target] : [target];
  }
  return ['claude.exe'];
}
const CLAUDE = claudeCommand();

/* ── one run ── */
async function run(mode, task) {
  const b = await board();
  const c = b.call;
  await c('PATCH', '/api/profiles/me', { role: 'builder', description: 'Evaluation agent' }, bot); // already introduced
  await task.setup(c, b);
  // the agent's project folder: the skill (core, cli) and a PATH shim so `intellagent` is this branch's CLI
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-eval-work-'));
  const bin = path.join(work, '.bin');
  fs.mkdirSync(bin);
  const cliPath = path.join(ROOT, 'bin', 'intellagent.js').replace(/\\/g, '/');
  fs.writeFileSync(path.join(bin, 'intellagent'), `#!/bin/sh\nexec node "${cliPath}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'intellagent.cmd'), `@node "${cliPath}" %*\r\n`);
  if (mode !== 'full') {
    fs.mkdirSync(path.join(work, '.claude', 'skills', 'intellagent'), { recursive: true });
    fs.writeFileSync(path.join(work, '.claude', 'skills', 'intellagent', 'SKILL.md'), SKILL);
  }
  const env = { ...process.env, INTELLAGENT_URL: b.base, INTELLAGENT_AGENT: AGENT, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  delete env.INTELLAGENT_MANIFEST;
  const mcpConfig = path.join(work, 'mcp.json');
  const toolsAllowed = [];
  if (mode !== 'cli') {
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { intellagent: { command: process.execPath, args: [path.join(ROOT, 'mcp.js')], env: { INTELLAGENT_URL: b.base, INTELLAGENT_AGENT: AGENT, INTELLAGENT_MCP_PROFILE: mode === 'full' ? 'full' : 'core' } } } }));
    toolsAllowed.push('mcp__intellagent');
  }
  if (mode !== 'full') toolsAllowed.push('Bash(intellagent *)', 'Skill');
  const prompt = typeof task.prompt === 'function' ? task.prompt(b) : task.prompt;
  const argv = ['-p', prompt, '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--max-turns', '20', '--strict-mcp-config',
    ...(mode !== 'cli' ? ['--mcp-config', mcpConfig] : []), '--allowedTools', ...toolsAllowed];
  const humanDone = task.human ? task.human(c) : null;
  const t0 = Date.now();
  const lines = await new Promise((resolve) => {
    const p = spawn(CLAUDE[0], [...CLAUDE.slice(1), ...argv], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    const kill = setTimeout(() => p.kill(), 240_000);
    p.on('close', () => { clearTimeout(kill); resolve(out.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)); });
  });
  if (humanDone) await Promise.race([humanDone, new Promise((r) => setTimeout(r, 1000))]);
  // what the stream says: tool calls, errors, the final answer, usage
  const uses = lines.filter((m) => m.type === 'assistant').flatMap((m) => (m.message?.content || []).filter((x) => x.type === 'tool_use'));
  const results = lines.filter((m) => m.type === 'user').flatMap((m) => (Array.isArray(m.message?.content) ? m.message.content : []).filter((x) => x.type === 'tool_result'));
  const errors = results.filter((r) => r.is_error || /^error \d{3}|Exit code [1-9]|is not reachable|Unknown tool/m.test(typeof r.content === 'string' ? r.content : JSON.stringify(r.content || ''))).length;
  const result = lines.find((m) => m.type === 'result') || {};
  const init = lines.find((m) => m.type === 'system' && m.subtype === 'init') || {};
  const skillUsed = uses.some((u) => u.name === 'Skill') || uses.some((u) => u.name === 'Read' && /intellagent[\\/]SKILL\.md/.test(JSON.stringify(u.input)));
  let ok = false;
  try { ok = await task.check(c, String(result.result || '')); } catch { ok = false; }
  b.stop();
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* busy */ }
  const u = result.usage || {};
  return {
    mode, task: task.key, ok, toolCalls: uses.length, errors, turns: result.num_turns ?? null, seconds: Math.round((Date.now() - t0) / 1000),
    costUsd: result.total_cost_usd ?? null, inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outputTokens: u.output_tokens || 0,
    mcpTools: (init.tools || []).filter((t) => t.startsWith('mcp__')).length, skillUsed,
    calls: uses.map((x) => (x.name === 'Bash' ? `Bash: ${String(x.input?.command || '').slice(0, 80)}` : x.name.replace('mcp__intellagent__', 'mcp:'))),
  };
}

(async () => {
  const { measure } = require('./measure-mcp');
  const sizes = { full: (await measure('full')).chars, core: (await measure('core')).chars, cli: 0 };
  const tasks = args.tasks ? TASKS.filter((t) => String(args.tasks).split(',').includes(t.key)) : TASKS;
  const rows = [];
  for (const task of tasks) {
    for (const mode of MODES) {
      for (let i = 0; i < REPEAT; i++) {
        const r = await run(mode, task);
        r.toolListChars = sizes[mode];
        r.skillChars = mode === 'full' ? 0 : SKILL.length;
        rows.push(r);
        console.log(`${task.key.padEnd(9)} ${mode.padEnd(5)} ${r.ok ? 'ok  ' : 'FAIL'} calls=${r.toolCalls} errors=${r.errors} turns=${r.turns} ${r.seconds}s $${(r.costUsd ?? 0).toFixed(4)} in=${r.inputTokens}  ${r.calls.join(' | ').slice(0, 220)}`);
      }
    }
  }
  if (args.out) fs.writeFileSync(args.out, JSON.stringify({ model: MODEL, sizes, skillChars: SKILL.length, rows }, null, 2));
  // summary per mode
  console.log('\nmode   success  calls  errors  $/task   input tok/task  tool-list chars  skill chars');
  for (const mode of MODES) {
    const rs = rows.filter((r) => r.mode === mode);
    const avg = (k) => rs.reduce((s, r) => s + (r[k] || 0), 0) / rs.length;
    console.log(`${mode.padEnd(6)} ${`${rs.filter((r) => r.ok).length}/${rs.length}`.padEnd(8)} ${avg('toolCalls').toFixed(1).padStart(5)}  ${avg('errors').toFixed(1).padStart(6)}  ${avg('costUsd').toFixed(4)}  ${Math.round(avg('inputTokens')).toString().padStart(14)}  ${String(sizes[mode]).padStart(15)}  ${mode === 'full' ? 0 : SKILL.length}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
