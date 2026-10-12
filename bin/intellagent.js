#!/usr/bin/env node
/*
 * intellagent — global command.
 *   intellagent init [dir] [--template software] [--name "My App"] [--prefix APP] [--port 7421] [--mcp] [--agent name] [--claude] [--demo]
 *   intellagent templates               list board templates
 *   intellagent skill install [--project] install the /intellagent-setup skill for Claude Code
 *   intellagent start [--open]          run the board for the nearest .intellagent/ folder
 *   intellagent open | status | docs
 *   intellagent api <METHOD> <path> [json | @file | -]
 *   intellagent mcp                     MCP server over stdio
 *   intellagent hook install | post-commit | sync-ci
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const os = require('os');
const { findManifest, readManifest, baseUrl, NO_BOARD } = require('../lib/locate');
const TEMPLATES = require('../lib/templates');

const ROOT = path.join(__dirname, '..');
const [cmd = 'help', ...rest] = process.argv.slice(2);

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v ?? (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
    } else out._.push(a);
  }
  return out;
}

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
  s.listen(port, '127.0.0.1');
});
async function freePort(from = 7420) {
  for (let p = from; p < from + 200; p++) if (await portFree(p)) return p;
  throw new Error('No free port found');
}

const prefixFrom = (name) => {
  const words = name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const p = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] || 'INT').slice(0, 3);
  return p.toUpperCase().slice(0, 5) || 'INT';
};

function agentPrompt(url, board = 'main') {
  return `This project has an Intellagent kanban at ${url} (board "${board}") that I use to coordinate work with you.
Before working, read ${url}/api/docs and follow it. Identify yourself with the header "X-Agent: <your-name>".
From a shell you can use: intellagent api GET /api/boards/${board}/summary`;
}

async function init() {
  const f = flags(rest);
  const dir = path.resolve(f._[0] || '.');
  const folder = path.join(dir, '.intellagent');
  const manifestPath = path.join(folder, 'intellagent.manifest.json');
  if (fs.existsSync(manifestPath)) { console.log(`Already initialised: ${manifestPath}`); return; }
  const name = String(f.name || path.basename(dir));
  const template = String(f.template || 'default');
  if (!TEMPLATES[template]) { console.error(`Unknown template "${template}". Available: ${Object.keys(TEMPLATES).join(', ')}`); process.exit(1); }
  const port = Number(f.port) || await freePort(7420);
  const manifest = {
    appName: 'Intellagent',
    boardName: name,
    idPrefix: String(f.prefix || prefixFrom(name)).toUpperCase(),
    seed: f.demo ? 'demo' : 'empty',
    template,
    host: '127.0.0.1',
    port,
    dataDir: './data',
    defaultBoard: 'main',
    lease: { defaultMinutes: 30, maxMinutes: 1440, warningMinutes: 5 },
    presenceTimeoutSeconds: 90,
    readonlyData: true,
    backups: 10,
    auth: { userToken: null, agentTokens: {}, requireAgentTokens: false },
    permissions: {},
  };
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(folder, '.gitignore'), 'data/\ncursors/\n');
  const url = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(folder, 'README.md'), `# ${name} · Intellagent board\n\nStart it with \`intellagent start\` (from anywhere inside this project), then open ${url}.\n\n## Prompt for agents\n\n\`\`\`\n${agentPrompt(url)}\n\`\`\`\n`);
  console.log(`\n  ✓ ${path.relative(process.cwd(), manifestPath) || manifestPath}`);
  console.log(`    board "${name}" · ${TEMPLATES[template].label} template · tickets ${manifest.idPrefix}-1, ${manifest.idPrefix}-2… · port ${port}`);

  if (f.mcp) {
    const mcpPath = path.join(dir, '.mcp.json');
    let mcp = {};
    try { mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8')); } catch { /* new file */ }
    mcp.mcpServers = mcp.mcpServers || {};
    mcp.mcpServers.intellagent = {
      command: 'node', args: [path.join(ROOT, 'mcp.js').replace(/\\/g, '/')],
      ...(f.agent ? { env: { INTELLAGENT_AGENT: String(f.agent) } } : {}),
    };
    fs.writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
    console.log('  ✓ .mcp.json  (intellagent MCP tools)');
  }
  if (f.claude) {
    const md = path.join(dir, 'CLAUDE.md');
    const block = `\n## Intellagent board\n\n${agentPrompt(url)}\n`;
    const cur = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
    if (!cur.includes('## Intellagent board')) { fs.writeFileSync(md, cur + block); console.log('  ✓ CLAUDE.md  (agent instructions appended)'); }
  }
  console.log(`\n  Next:  intellagent start --open\n`);
}

function requireManifest() {
  const m = findManifest();
  if (!m) { console.error('No .intellagent/ found here or in any parent folder. Run: intellagent init'); process.exit(1); }
  return m;
}

function openUrl(url) {
  const [bin, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
}

async function alive(url) {
  try { const r = await fetch(`${url}/api/app`); return r.ok ? r.json() : null; } catch { return null; }
}

async function start() {
  const f = flags(rest);
  const mp = requireManifest();
  const url = baseUrl(readManifest(mp));
  if (await alive(url)) { console.log(`Already running at ${url}`); if (f.open) openUrl(url); return; }
  process.env.INTELLAGENT_MANIFEST = mp;
  if (f.open) setTimeout(() => openUrl(url), 700);
  require(path.join(ROOT, 'server.js'));
}

async function status() {
  const mp = findManifest();
  const url = baseUrl(readManifest(mp));
  if (!url) { console.log(NO_BOARD); return; }
  const app = await alive(url);
  console.log(`manifest  ${mp || '(none — using defaults)'}`);
  console.log(`url       ${url}  ${app ? '● running' : '○ not running'}`);
  if (!app) return;
  const boards = await (await fetch(`${url}/api/boards`)).json();
  for (const b of boards) console.log(`board     ${b.id} · ${b.items} items · ${b.needsHuman} need you · ${b.archived} archived`);
}

async function docs() {
  const url = baseUrl();
  try {
    if (!url) throw new Error('no board'); process.stdout.write(await (await fetch(`${url}/api/docs`)).text()); }
  catch { process.stdout.write(fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8')); }
}

function forward(script, args) {
  process.argv = [process.argv[0], path.join(ROOT, script), ...args];
  require(path.join(ROOT, script));
}

function templates() {
  for (const [k, t] of Object.entries(TEMPLATES)) {
    console.log(`  ${k.padEnd(9)} ${t.label}`);
    console.log(`  ${''.padEnd(9)} ${t.description}`);
    const fields = (t.schema?.fields || []).map((x) => x.key);
    if (fields.length) console.log(`  ${''.padEnd(9)} fields: ${fields.join(', ')}`);
  }
}

// Copies the bundled Claude Code skill to ~/.claude/skills (or ./.claude/skills with --project).
function skill() {
  const f = flags(rest);
  if (f._[0] !== 'install') { console.log('Usage: intellagent skill install [--project]'); return; }
  const src = path.join(ROOT, 'skills', 'intellagent-setup', 'SKILL.md');
  const base = f.project ? path.join(process.cwd(), '.claude', 'skills') : path.join(os.homedir(), '.claude', 'skills');
  const dest = path.join(base, 'intellagent-setup', 'SKILL.md');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`Installed ${dest}`);
  console.log('In Claude Code: /intellagent-setup, or just ask it to set up Intellagent.');
}

/* ── wait / watch: make the board able to wake an agent ── */

function agentName(f) {
  const a = f.agent || process.env.INTELLAGENT_AGENT;
  if (!a) { console.error('Pass --agent <name> or set INTELLAGENT_AGENT.'); process.exit(1); }
  return String(a);
}
const cursorPath = (mp, agent) => path.join(path.dirname(mp), 'cursors', `${agent.replace(/[^\w.-]+/g, '_')}.json`);

// Long-polls the agent's inbox from its saved cursor; resolves with the events (or [] on timeout).
async function nextEvents({ agent, types, timeoutSec, quiet }) {
  const mp = findManifest();
  const url = baseUrl(readManifest(mp));
  if (!url) { console.error(NO_BOARD); process.exit(3); }
  const file = cursorPath(mp, agent);
  let since = null;
  try { since = JSON.parse(fs.readFileSync(file, 'utf8')).cursor; } catch { /* first run */ }
  const headers = { 'X-Agent': agent };
  if (since == null) since = (await (await fetch(`${url}/api/app`, { headers })).json()).seq; // start from now
  const deadline = timeoutSec ? Date.now() + timeoutSec * 1000 : Infinity;
  for (;;) {
    const left = Math.max(1, Math.min(50, Math.ceil((deadline - Date.now()) / 1000)));
    const q = new URLSearchParams({ for: agent, excludeActor: agent, since: String(since), timeout: String(left), ...(types ? { types } : {}) });
    let r;
    try { r = await (await fetch(`${url}/api/events/wait?${q}`, { headers })).json(); }
    catch (e) { if (!quiet) console.error(`board unreachable (${e.message}); retrying…`); await new Promise((res) => setTimeout(res, 5000)); continue; }
    since = r.cursor;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ cursor: since, at: new Date().toISOString() }));
    if (r.events?.length) return r.events;
    if (Date.now() >= deadline) return [];
  }
}

const eventLine = (e) => `#${e.seq} ${e.type}${e.itemId ? ` ${e.itemId}` : ''}${e.item?.title ? ` "${e.item.title}"` : ''} by ${e.actor?.name || '?'}${e.reply ? ` — reply: ${e.reply}` : e.comment?.body ? ` — ${e.comment.body}` : e.reason ? ` — ${e.reason}` : ''}`;

async function waitCmd() {
  const f = flags(rest);
  const agent = agentName(f);
  const events = await nextEvents({ agent, types: f.types, timeoutSec: Number(f.timeout) || 0 });
  if (!events.length) { console.log('(no events before timeout)'); process.exit(2); }
  console.log(f.json ? JSON.stringify(events, null, 2) : events.map(eventLine).join('\n'));
}

function quoteWin(a) { return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a; }

async function watchCmd() {
  const sep = rest.indexOf('--');
  const f = flags(sep >= 0 ? rest.slice(0, sep) : rest);
  const cmd = sep >= 0 ? rest.slice(sep + 1) : (f.claude ? ['claude', '-p', 'Handle the Intellagent events described on stdin.'] : null);
  const agent = agentName(f);
  if (!cmd?.length) { console.error('Usage: intellagent watch --agent <name> -- <command…>   (or --claude)'); process.exit(1); }
  console.log(`watching inbox of "${agent}" — runs: ${cmd.join(' ')}`);
  for (;;) {
    let events = await nextEvents({ agent, types: f.types, timeoutSec: 0, quiet: true });
    await new Promise((res) => setTimeout(res, 3000)); // let a burst of edits settle into one run
    events = events.concat(await nextEvents({ agent, types: f.types, timeoutSec: 1, quiet: true }));
    const mp = findManifest();
    const evFile = path.join(path.dirname(mp), 'cursors', `${agent.replace(/[^\w.-]+/g, '_')}-events.json`);
    fs.writeFileSync(evFile, JSON.stringify(events, null, 2));
    const prompt = [
      `You are "${agent}", working on this project's Intellagent board. These events are addressed to you:`,
      ...events.map((e) => `- ${eventLine(e)}`),
      '',
      `Read each ticket for context (intellagent api GET /api/boards/main/items/<ID>), act on it following the board's standing rules and the project's CLAUDE.md, and reply on the card.`,
      `Use INTELLAGENT_AGENT=${agent} for API calls. Full event JSON: ${evFile}`,
    ].join('\n');
    console.log(`\n▶ ${events.length} event(s): ${events.map((e) => e.itemId || e.type).join(', ')}`);
    const args = cmd.slice(1).map((a) => a.replace('{events}', evFile));
    const win = process.platform === 'win32';
    const child = spawn(win ? cmd[0] : cmd[0], win ? args.map(quoteWin) : args, {
      stdio: ['pipe', 'inherit', 'inherit'], shell: win, env: { ...process.env, INTELLAGENT_AGENT: agent, INTELLAGENT_EVENTS: evFile },
    });
    child.stdin.end(prompt);
    const code = await new Promise((res) => child.on('close', res));
    console.log(`■ finished (exit ${code})`);
    if (f.once) return;
  }
}

const HELP = `intellagent — a kanban for you and your agents

  init [dir]       scaffold .intellagent/ here   --template --name --prefix --port --mcp --agent --claude --demo
  templates        list board templates (software, research, ops, ...)
  skill install    add the /intellagent-setup skill to Claude Code   [--project]
  start            run this project's board      --open
  open             open the board in a browser
  status           where it is and whether it's running
  docs             print the agent guide
  api M PATH [b]   call the API as an agent      (INTELLAGENT_AGENT=name; body: key=value… | json | @file | -)
  wait             block until something arrives in your inbox, print it, exit   --agent --types --timeout --json
  watch -- CMD     run CMD each time your inbox gets events (unattended agents)   --agent --claude --once
  mcp              MCP server over stdio
  hook ...         git: install | post-commit | sync-ci
`;

const commands = {
  init, start, status, docs, templates, skill,
  open: () => { const u = baseUrl(); if (!u) { console.error(NO_BOARD); process.exit(3); } openUrl(u); },
  wait: waitCmd,
  watch: watchCmd,
  api: () => forward('cli.js', rest),
  mcp: () => forward('mcp.js', rest),
  hook: () => forward('git-hook.js', rest),
  help: () => process.stdout.write(HELP),
};
const run = commands[cmd] || commands.help;
Promise.resolve(run()).catch((e) => { console.error(e.message); process.exit(1); });
