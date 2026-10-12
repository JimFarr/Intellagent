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
 *   intellagent agents [add|remove|pause|resume|run|log] standing agents the board wakes up itself
 *   intellagent autostart on|off|status  start this board when you log in
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
      const eq = a.indexOf('=');
      const [k, v] = eq < 0 ? [a.slice(2)] : [a.slice(2, eq), a.slice(eq + 1)]; // values may contain '=' (--filter)
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
const cursorPath = (mp, agent, scope) => path.join(path.dirname(mp), 'cursors', `${agent.replace(/[^\w.-]+/g, '_')}${scope ? `.${scope}` : ''}.json`);

// What to listen to: the agent's inbox (default), every human action (--human, for a coordinator),
// or any /api/events filter (--filter "types=item.created&column=Ready"). Each scope keeps its own cursor.
function listenScope(f) {
  if (f.filter) return { scope: 'filter-' + String(f.filter).replace(/[^\w]+/g, '_').slice(0, 40), query: Object.fromEntries(new URLSearchParams(String(f.filter))) };
  if (f.human) return { scope: 'human', query: { actorKind: 'user' } };
  return { scope: '', query: null };
}

// Long-polls the agent's inbox from its saved cursor; resolves with the events (or [] on timeout).
async function nextEvents({ agent, types, timeoutSec, quiet, listen = { scope: '', query: null } }) {
  const mp = findManifest();
  const url = baseUrl(readManifest(mp));
  if (!url) { console.error(NO_BOARD); process.exit(3); }
  const file = cursorPath(mp, agent, listen.scope);
  let since = null;
  try { since = JSON.parse(fs.readFileSync(file, 'utf8')).cursor; } catch { /* first run */ }
  const headers = { 'X-Agent': agent };
  if (since == null) since = (await (await fetch(`${url}/api/app`, { headers })).json()).seq; // start from now
  const deadline = timeoutSec ? Date.now() + timeoutSec * 1000 : Infinity;
  for (;;) {
    const left = Math.max(1, Math.min(50, Math.ceil((deadline - Date.now()) / 1000)));
    const q = new URLSearchParams({ ...(listen.query || { for: agent }), excludeActor: agent, since: String(since), timeout: String(left), ...(types ? { types } : {}) });
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

const { eventLine } = require('../lib/agents');

async function waitCmd() {
  const f = flags(rest);
  const agent = agentName(f);
  const events = await nextEvents({ agent, types: f.types, timeoutSec: Number(f.timeout) || 0, listen: listenScope(f) });
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
  const listen = listenScope(f);
  const what = f.filter ? `events matching ${f.filter}` : f.human ? 'everything the human does' : `inbox of "${agent}"`;
  console.log(`watching ${what} as "${agent}" — runs: ${cmd.join(' ')}`);
  for (;;) {
    let events = await nextEvents({ agent, types: f.types, timeoutSec: 0, quiet: true, listen });
    await new Promise((res) => setTimeout(res, 3000)); // let a burst of edits settle into one run
    events = events.concat(await nextEvents({ agent, types: f.types, timeoutSec: 1, quiet: true, listen }));
    const mp = findManifest();
    const evFile = path.join(path.dirname(mp), 'cursors', `${agent.replace(/[^\w.-]+/g, '_')}-events.json`);
    fs.writeFileSync(evFile, JSON.stringify(events, null, 2));
    const prompt = [
      listen.query
        ? `You are "${agent}", coordinating this project's Intellagent board. New activity (${what}):`
        : `You are "${agent}", working on this project's Intellagent board. These events are addressed to you:`,
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

/* ── standing agents: .intellagent/agents.json, run by the board server ── */

const agentsFile = (mp) => path.join(path.dirname(mp), readManifest(mp)?.agentsFile || 'agents.json');
function readAgents(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return { defaults: {}, agents: {} }; }
}

// The CLI acts as the human here (it runs on the human's machine, with the local manifest).
async function asHuman(method, p, body) {
  const mp = requireManifest();
  const m = readManifest(mp);
  const url = baseUrl(m);
  const headers = { 'content-type': 'application/json', 'x-user': os.userInfo().username, ...(m.auth?.userToken ? { authorization: `Bearer ${m.auth.userToken}` } : {}) };
  let r;
  try { r = await fetch(url + p, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
  catch { console.error(`The board isn't running (${url}). Start it with: intellagent start`); process.exit(1); }
  const j = await r.json();
  if (!r.ok) { console.error(j.error || r.status); process.exit(1); }
  return j;
}

const ago = (t) => { if (!t) return '—'; const m = Math.round((Date.now() - Date.parse(t)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

async function agentsCmd() {
  const [sub, name] = rest;
  const f = flags(rest.slice(sub === 'add' ? 2 : 0));
  const mp = requireManifest();
  const file = agentsFile(mp);
  if (!sub || sub === 'list') {
    const { agents, error } = await asHuman('GET', '/api/agents');
    if (error) console.log(`⚠ ${error}`);
    if (!agents.length) { console.log(`No standing agents. Add one:  intellagent agents add builder\n(definitions live in ${file})`); return; }
    for (const a of agents) {
      const last = a.lastRun ? `last run ${ago(a.lastRun.endedAt || a.lastRun.startedAt)} (${a.lastRun.code ?? 'running'})` : 'never run';
      console.log(`${a.name.padEnd(14)} ${a.status.padEnd(10)} ${String(a.queued).padStart(3)} queued  ${a.runsLastHour}/${a.maxRunsPerHour ?? '∞'} runs/h  ${last}   listens: ${typeof a.listen === 'string' ? a.listen : JSON.stringify(a.listen)}`);
    }
    return;
  }
  if (sub === 'add') {
    if (!name) { console.error('Usage: intellagent agents add <name> [--listen inbox|human|"types=…&column=…"] [--run "<command>"] [--max-runs 20] [--description "…"]'); process.exit(1); }
    const doc = readAgents(file);
    doc.agents ||= {};
    const listen = !f.listen || f.listen === 'inbox' || f.listen === 'human' ? (f.listen || 'inbox') : Object.fromEntries(new URLSearchParams(String(f.listen)));
    doc.agents[name] = {
      ...(doc.agents[name] || {}),
      listen,
      ...(f.run ? { run: String(f.run) } : {}),
      ...(f['max-runs'] != null ? { maxRunsPerHour: f['max-runs'] === 'none' ? null : Number(f['max-runs']) } : {}),
      ...(f.description ? { description: String(f.description) } : {}),
    };
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`Saved "${name}" to ${file}. The running board picks it up within a few seconds.`);
    if (!f.run && !doc.defaults?.run) console.log('It runs the default: claude -p (headless). Give it permissions it needs with --run "claude -p --permission-mode acceptEdits …" if required.');
    return;
  }
  if (sub === 'remove') {
    const doc = readAgents(file);
    if (!doc.agents?.[name]) { console.error(`No agent "${name}" in ${file}`); process.exit(1); }
    delete doc.agents[name];
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`Removed "${name}".`);
    return;
  }
  if (['pause', 'resume', 'run'].includes(sub)) {
    const a = await asHuman('POST', `/api/agents/${encodeURIComponent(name)}/${sub}`, sub === 'run' && f.note ? { note: String(f.note) } : {});
    console.log(`${a.name}: ${a.status}`);
    return;
  }
  if (sub === 'log') {
    const { log, file: lf } = await asHuman('GET', `/api/agents/${encodeURIComponent(name)}/log`);
    if (lf) console.log(`── ${lf}`);
    process.stdout.write(log || '(no runs yet)\n');
    return;
  }
  console.error(`Unknown: agents ${sub}`); process.exit(1);
}

/* ── autostart: bring the board (and its standing agents) back after a reboot ── */

function autostart() {
  const [sub = 'status'] = rest;
  const mp = requireManifest();
  const dir = path.basename(path.dirname(mp)) === '.intellagent' ? path.dirname(path.dirname(mp)) : path.dirname(mp);
  const project = path.basename(dir) || 'board';
  const id = `intellagent-${project.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  if (process.platform !== 'win32') {
    const line = `@reboot cd "${dir}" && "${process.execPath}" "${__filename}" start`;
    console.log(sub === 'on' ? `Add this line with \`crontab -e\` (or a launchd/systemd unit):\n\n  ${line}\n` : 'Autostart is managed by your crontab/launchd/systemd on this OS.');
    return;
  }
  const startup = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const file = path.join(startup, `${id}.vbs`);
  if (sub === 'on') {
    const q = (x) => `""${x}""`; // VBScript: a quote inside a string is doubled
    const vbs = [
      `' Starts the Intellagent board for ${dir} at login (hidden). Remove with: intellagent autostart off`,
      'Set sh = CreateObject("WScript.Shell")',
      `sh.CurrentDirectory = "${dir}"`,
      `sh.Run "${q(process.execPath)} ${q(__filename)} start", 0, False`,
    ].join('\r\n');
    fs.writeFileSync(file, vbs);
    console.log(`On: the board starts hidden when you log in.\n  ${file}`);
  } else if (sub === 'off') {
    if (fs.existsSync(file)) fs.rmSync(file);
    console.log('Off.');
  } else console.log(fs.existsSync(file) ? `On  (${file})` : 'Off  — turn on with: intellagent autostart on');
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
                   both also take --human (everything the human does: for a coordinator)
                   or --filter "types=item.created&column=Ready" (any /api/events filter)
  mcp              MCP server over stdio
  hook ...         git: install | post-commit | sync-ci

  agents           standing agents the board wakes up itself (defined in .intellagent/agents.json)
    add NAME       --listen inbox|human|"types=…&column=…"  --run "<command>"  --max-runs N|none
    pause | resume | run | log | remove NAME
  autostart on|off start this board (and its agents) when you log in
`;

const commands = {
  init, start, status, docs, templates, skill,
  open: () => { const u = baseUrl(); if (!u) { console.error(NO_BOARD); process.exit(3); } openUrl(u); },
  wait: waitCmd,
  agents: agentsCmd,
  autostart,
  watch: watchCmd,
  api: () => forward('cli.js', rest),
  mcp: () => forward('mcp.js', rest),
  hook: () => forward('git-hook.js', rest),
  help: () => process.stdout.write(HELP),
};
const run = commands[cmd] || commands.help;
Promise.resolve(run()).catch((e) => { console.error(e.message); process.exit(1); });
