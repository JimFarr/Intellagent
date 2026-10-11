#!/usr/bin/env node
/*
 * intellagent — global command.
 *   intellagent init [dir] [--name "My App"] [--prefix APP] [--port 7421] [--mcp] [--claude] [--demo]
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
const { findManifest, readManifest, baseUrl } = require('../lib/locate');

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
  const port = Number(f.port) || await freePort(7420);
  const manifest = {
    appName: 'Intellagent',
    boardName: name,
    idPrefix: String(f.prefix || prefixFrom(name)).toUpperCase(),
    seed: f.demo ? 'demo' : 'empty',
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
  fs.writeFileSync(path.join(folder, '.gitignore'), 'data/\n');
  const url = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(folder, 'README.md'), `# ${name} · Intellagent board\n\nStart it with \`intellagent start\` (from anywhere inside this project), then open ${url}.\n\n## Prompt for agents\n\n\`\`\`\n${agentPrompt(url)}\n\`\`\`\n`);
  console.log(`\n  ✓ ${path.relative(process.cwd(), manifestPath) || manifestPath}`);
  console.log(`    board "${name}" · tickets ${manifest.idPrefix}-1, ${manifest.idPrefix}-2… · port ${port}`);

  if (f.mcp) {
    const mcpPath = path.join(dir, '.mcp.json');
    let mcp = {};
    try { mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8')); } catch { /* new file */ }
    mcp.mcpServers = mcp.mcpServers || {};
    mcp.mcpServers.intellagent = { command: 'node', args: [path.join(ROOT, 'mcp.js').replace(/\\/g, '/')] };
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
  const app = await alive(url);
  console.log(`manifest  ${mp || '(none — using defaults)'}`);
  console.log(`url       ${url}  ${app ? '● running' : '○ not running'}`);
  if (!app) return;
  const boards = await (await fetch(`${url}/api/boards`)).json();
  for (const b of boards) console.log(`board     ${b.id} · ${b.items} items · ${b.needsHuman} need you · ${b.archived} archived`);
}

async function docs() {
  const url = baseUrl();
  try { process.stdout.write(await (await fetch(`${url}/api/docs`)).text()); }
  catch { process.stdout.write(fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8')); }
}

function forward(script, args) {
  process.argv = [process.argv[0], path.join(ROOT, script), ...args];
  require(path.join(ROOT, script));
}

const HELP = `intellagent — a kanban for you and your agents

  init [dir]       scaffold .intellagent/ here   --name --prefix --port --mcp --claude --demo
  start            run this project's board      --open
  open             open the board in a browser
  status           where it is and whether it's running
  docs             print the agent guide
  api M PATH [b]   call the API as an agent      (INTELLAGENT_AGENT=name)
  mcp              MCP server over stdio
  hook ...         git: install | post-commit | sync-ci
`;

const commands = {
  init, start, status, docs,
  open: () => openUrl(baseUrl()),
  api: () => forward('cli.js', rest),
  mcp: () => forward('mcp.js', rest),
  hook: () => forward('git-hook.js', rest),
  help: () => process.stdout.write(HELP),
};
const run = commands[cmd] || commands.help;
Promise.resolve(run()).catch((e) => { console.error(e.message); process.exit(1); });
