#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/*
 * intellagent — global command.
 *   intellagent init [dir] [--template software] [--name "My App"] [--prefix APP] [--port 7421] [--agent claude] [--no-mcp] [--no-claude] [--no-start]
 *   intellagent brief [--agent name]    everything an agent needs to start working
 *   intellagent templates               list board templates
 *   intellagent preset list|add|diff|update   packages of board: init --preset, add one to a board, take updates piece by piece
 *   intellagent skill install [--project] install the intellagent skills for Claude Code
 *   intellagent start [--open]          run the board for the nearest .intellagent/ folder
 *   intellagent open | status | docs
 *   intellagent api <METHOD> <path> [json | @file | -]
 *   intellagent mcp                     MCP server over stdio
 *   intellagent hook install | post-commit | sync-ci
 *   intellagent agents [add|remove|pause|resume|run|log] standing agents the board wakes up itself
 *   intellagent autostart on|off|status  start this board when you log in
 *   intellagent leases status|machine|ask|renew|done|ceiling|start|stop   the machine's leases for heavy work
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const { findManifest, readManifest, baseUrl, defaultAgent, userToken, projectOf, readLocal, NO_BOARD } = require('../lib/locate');
const crypto = require('crypto');
const TEMPLATES = require('../lib/templates');
const presets = require('../lib/presets');
const jsonfile = require('../lib/jsonfile');

const ROOT = path.join(__dirname, '..');
// --url <address> and --as <name> anywhere on the line: the board to talk to and who you are, like
// INTELLAGENT_URL and INTELLAGENT_AGENT, for a shell that may only run commands starting with "intellagent"
// (a standing agent reaching its sandbox).
for (const [flag, env] of [['--url', 'INTELLAGENT_URL'], ['--as', 'INTELLAGENT_AGENT']]) {
  const a = process.argv;
  const i = a.findIndex((x, n) => n > 1 && (x === flag || x.startsWith(`${flag}=`)));
  if (i < 0) continue;
  const inline = a[i].startsWith(`${flag}=`);
  const v = inline ? a[i].slice(flag.length + 1) : a[i + 1];
  a.splice(i, inline ? 1 : 2);
  if (v) process.env[env] = v;
}
const [cmd = 'help', ...rest] = process.argv.slice(2);

const { flags, portFree, alive } = require('../lib/cliutil');

async function freePort(from = 7420) {
  for (let p = from; p < from + 200; p++) if (await portFree(p)) return p;
  throw new Error('No free port found');
}

const prefixFrom = (name) => {
  const words = name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const p = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] || 'INT').slice(0, 3);
  return p.toUpperCase().slice(0, 5) || 'INT';
};

// What goes into CLAUDE.md: short, and it points at `intellagent brief`, which carries everything else
// (so the instructions never go stale when the board changes).
function agentPrompt(url, agent, board = 'main') {
  return `Work in this project is tracked on an Intellagent board (${url}, board "${board}"). The board is how the human steers you: tickets, answers and reviews arrive there.

- **Before starting work, and whenever asked to check the board, run \`intellagent brief\`** (MCP: \`get_briefing\`). It says who you are, what to do next, how the board works and the exact commands.
- You are **${agent}** by default (set INTELLAGENT_AGENT to use another name; keep it stable).
- Work a ticket with \`start\` → \`status\` → \`review\`; ask the human on the card when unsure; \`finish\` at the end of a session. Never edit files in .intellagent/data.
- If the board isn't running: \`intellagent start\` in the background.`;
}

async function init() {
  const f = flags(rest);
  if (asAgent() && !f['no-open']) { f['no-open'] = true; console.log(`(Running as ${asAgent()}: the board won't be opened signed in — the human opens it with: intellagent open)`); }
  const dir = path.resolve(f._[0] || '.');
  const folder = path.join(dir, '.intellagent');
  const manifestPath = path.join(folder, 'intellagent.manifest.json');
  if (fs.existsSync(manifestPath)) { console.log(`Already initialised: ${manifestPath}`); return; }
  const name = String(f.name || path.basename(dir));
  // --preset <name|folder> sets the board up from a preset; --template is the older name for a built-in one
  let preset = null;
  if (f.preset) {
    if (f.template) { console.error('error 400 BAD_REQUEST: --preset and --template both choose the board — hint: use only --preset'); process.exit(1); }
    preset = loadPreset(String(f.preset), folder);
    printPowers(preset);
    if (!await confirm(`Set up this board from ${preset.name}@${preset.version}?`, f)) { console.log('Nothing written.'); return; }
  }
  const template = preset ? preset.name : String(f.template || 'default');
  if (!preset && !TEMPLATES[template]) { console.error(`Unknown template "${template}". Available: ${Object.keys(TEMPLATES).join(', ')} (presets: intellagent preset list)`); process.exit(1); }
  const port = Number(f.port) || await freePort(7420);
  const agent = String(f.agent || 'claude');
  const userToken = f['no-token'] ? null : crypto.randomBytes(18).toString('base64url');
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
    // Your token lives in local.json (not committed): only requests that carry it act as you.
    // agents must send a token (local.json holds them; the CLI and MCP send them by themselves); --open-agents turns it off
    auth: { userToken: null, agentTokens: {}, requireAgentTokens: !f['open-agents'] },
    defaultAgent: agent,
    permissions: {},
    // the code lives somewhere else (a board kept outside the project)
    ...(f.project ? { projectRoot: path.resolve(String(f.project)) } : {}),
  };
  fs.mkdirSync(folder, { recursive: true });
  if (preset) {
    if (preset.dir) presets.addFolder(preset, folder);
    presets.record(folder, preset, Object.keys(presets.parts(preset)));
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const agentTokens = f['open-agents'] ? undefined : { [agent]: crypto.randomBytes(18).toString('base64url') };
  if (userToken || agentTokens) fs.writeFileSync(path.join(folder, 'local.json'), `${JSON.stringify({ ...(userToken ? { userToken } : {}), ...(agentTokens ? { agentTokens } : {}) }, null, 2)}\n`);
  const url =`http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(folder, 'README.md'), `# ${name} · Intellagent board\n\n- \`intellagent start\` runs it (from anywhere in this project); \`intellagent open\` opens it signed in; \`intellagent stop\` stops it.\n- \`intellagent brief\` shows an agent everything it needs.\n- \`local.json\` holds your user token (git-ignored). Only requests with it act as you; \`intellagent open\` signs the browser in.\n\n## Agent instructions\n\n${agentPrompt(url, agent)}\n`);
  fs.writeFileSync(path.join(folder, '.gitignore'), 'data/\ncursors/\nlocal.json\nworktrees/\n');
  console.log(`\n  ✓ ${path.relative(process.cwd(), manifestPath) || manifestPath}`);
  console.log(`    board "${name}" · ${preset ? `${preset.label || preset.name} preset` : `${TEMPLATES[template].label} template`} · tickets ${manifest.idPrefix}-1, ${manifest.idPrefix}-2… · port ${port}`);

  if (!f['no-mcp']) {
    const mcpPath = path.join(dir, '.mcp.json');
    let mcp = {};
    try { mcp = jsonfile.read(mcpPath); } catch { /* new file */ }
    mcp.mcpServers = mcp.mcpServers || {};
    mcp.mcpServers.intellagent = { command: 'node', args: [path.join(ROOT, 'mcp.js').replace(/\\/g, '/')] };
    fs.writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
    console.log('  ✓ .mcp.json  (intellagent MCP tools)');
  }
  if (!f['no-claude']) {
    const md = path.join(dir, 'CLAUDE.md');
    const block = `\n## Intellagent board\n\n${agentPrompt(url, agent)}\n`;
    const cur = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
    if (!cur.includes('## Intellagent board')) { fs.writeFileSync(md, cur + block); console.log('  ✓ CLAUDE.md  (agent instructions appended)'); }
  }
  if (f['no-start']) { console.log(`\n  Next:  intellagent start --open   (port ${port}${f.port ? '' : ', the first free one from 7420'})\n`); return; }
  await startBackground(manifestPath, url);
  console.log(`\n  ✓ running at ${url}${f['no-open'] ? '' : ' — opening it signed in'}`);
  if (!f['no-open']) openBoard(manifestPath);
  console.log(`\n  Tell your agent: "check the board" — it runs \`intellagent brief\` and takes it from there.`);
  console.log('  Back after a reboot: intellagent autostart on\n');
}

// Starts the server detached (logs to .intellagent/data/server.log) and waits until it answers.
async function startBackground(mp, url) {
  if (await alive(url)) return;
  const data = path.join(path.dirname(mp), 'data');
  fs.mkdirSync(data, { recursive: true });
  const log = fs.openSync(path.join(data, 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: path.dirname(mp), detached: true, windowsHide: true, stdio: ['ignore', log, log],
    env: { ...process.env, INTELLAGENT_MANIFEST: mp },
  });
  child.unref();
  for (let i = 0; i < 50; i++) { if (await alive(url)) return; await new Promise((res) => setTimeout(res, 100)); }
  console.error(`The board did not start; see ${path.join(data, 'server.log')}`);
  process.exit(1);
}

// Opens the board; the user token rides in the URL fragment (never sent to the server or logged).
function openBoard(mp = requireManifest()) {
  // here, not on the commands: open, start --open and init all come through this (it carries the user token)
  humanOnly('opening the board signed in');
  const u = baseUrl(readManifest(mp));
  const t = userToken(mp);
  openUrl(t ? `${u}/#token=${t}` : u);
}

// Give an existing board (made before tokens, or with --no-token) the human's sign-in token, so only
// requests that carry it can act as the human. --rotate replaces an existing one.
function tokenCmd() {
  humanOnly('intellagent token');
  const mp = requireManifest();
  const dir = path.dirname(mp);
  const file = path.join(dir, 'local.json');
  let local;
  try { local = readLocal(file); } catch (e) { console.error(e.message); process.exit(1); } // never write over it
  const f = flags(rest);
  // --agent <name>: that agent's token (boards with requireAgentTokens refuse agents without one)
  if (f.agent) {
    const name = String(f.agent);
    if (local.agentTokens?.[name] && !f.rotate) { console.log(`${name} already has a token in ${file}. --rotate replaces it.`); return; }
    local.agentTokens = { ...(local.agentTokens || {}), [name]: crypto.randomBytes(18).toString('base64url') };
    fs.writeFileSync(file, `${JSON.stringify(local, null, 2)}\n`);
    console.log(`Token for "${name}" saved in ${file} (git-ignored). The board accepts it at once.`);
    console.log(`In this project the CLI and MCP tools send it by themselves when they act as ${name}. Elsewhere, give the agent INTELLAGENT_TOKEN=<the token>.`);
    return;
  }
  if (local.userToken && !f.rotate) {
    console.log(`This board already has a user token (${path.relative(process.cwd(), file) || file}).\n  intellagent open           signs the browser in\n  intellagent token --rotate replaces it (signs every browser out)`);
    return;
  }
  local.userToken = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(file, `${JSON.stringify(local, null, 2)}\n`);
  // keep it out of git, wherever the manifest lives
  const gi = path.join(dir, '.gitignore');
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!/^\/?local\.json\s*$/m.test(cur)) fs.writeFileSync(gi, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}local.json\n`);
  console.log(`${f.rotate ? 'New' : 'Created a'} user token in ${file} (git-ignored).`);
  console.log('From now on only requests carrying it act as you: the CLI uses it automatically, agents never get it.');
  console.log('The board reads it when it starts:  intellagent stop  then  intellagent start  — then  intellagent open  to sign in.');
}

// intellagent project [path]: show, or set, the folder with the code this board's agents work on
function projectCmd() {
  if (rest[0]) humanOnly('intellagent project <path>');
  const mp = requireManifest();
  const target = rest[0];
  if (!target) { console.log(projectOf(mp)); return; }
  const abs = path.resolve(String(target));
  if (!fs.existsSync(abs)) { console.error(`No such folder: ${abs}`); process.exit(2); }
  const raw = jsonfile.read(mp);
  raw.projectRoot = abs;
  fs.writeFileSync(mp, `${JSON.stringify(raw, null, 2)}\n`);
  console.log(`This board's agents now work on ${abs}.`);
  console.log('Restart the board to apply it: intellagent stop, then intellagent start --background.');
  console.log(`Agents you run yourself in that folder find the board after: cd "${abs}" && intellagent link "${path.dirname(mp)}"`);
}

// intellagent link <board folder or manifest>: from a project, use a board that lives elsewhere
function linkCmd() {
  const target = rest[0];
  if (!target) { console.error('Usage: intellagent link <board folder | manifest path>   (run it in the project)'); process.exit(2); }
  let mp = path.resolve(String(target));
  if (fs.existsSync(mp) && fs.statSync(mp).isDirectory()) mp = [path.join(mp, '.intellagent', 'intellagent.manifest.json'), path.join(mp, 'intellagent.manifest.json')].find((p) => fs.existsSync(p)) || '';
  if (!mp || !fs.existsSync(mp)) { console.error(`No Intellagent board at ${target} (looked for intellagent.manifest.json)`); process.exit(2); }
  const dir = path.join(process.cwd(), '.intellagent');
  if (fs.existsSync(path.join(dir, 'intellagent.manifest.json'))) { console.error('This folder already has its own board (.intellagent/intellagent.manifest.json).'); process.exit(2); }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'link.json'), `${JSON.stringify({ manifest: mp }, null, 2)}\n`);
  // the link is this machine's path: keep it out of git
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi) || !/^link\.json$/m.test(fs.readFileSync(gi, 'utf8'))) fs.appendFileSync(gi, 'link.json\n');
  console.log(`Linked ${process.cwd()} to the board at ${mp}.`);
  console.log('intellagent, its MCP tools and agents started here now use that board.');
  const pr = projectOf(mp);
  if (path.resolve(pr) !== path.resolve(process.cwd())) console.log(`Note: that board's agents work on ${pr}. To point them here: intellagent project "${process.cwd()}" (in the board's folder), then restart it.`);
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

async function start() {
  const f = flags(rest);
  if (f.open) humanOnly('intellagent start --open (opening the board signed in)'); // before anything boots
  const mp = requireManifest();
  const url = baseUrl(readManifest(mp));
  if (await alive(url)) { console.log(`Already running at ${url}`); if (f.open) openBoard(mp); return; }
  if (f.background) { await startBackground(mp, url); console.log(`Running at ${url} (logs: .intellagent/data/server.log)`); if (f.open) openBoard(mp); return; }
  process.env.INTELLAGENT_MANIFEST = mp;
  if (f.open) setTimeout(() => openBoard(mp), 700);
  require(path.join(ROOT, 'server.js'));
}

async function stop() {
  humanOnly('intellagent stop'); // stopping the board stops every standing agent with it
  const mp = requireManifest();
  const pidFile = path.join(path.dirname(mp), 'data', 'server.pid');
  let pid = null;
  try { pid = Number(fs.readFileSync(pidFile, 'utf8')); } catch { /* not started by us */ }
  if (!pid) { console.log('Not running (no server.pid).'); return; }
  // the whole tree: the board and the agent runs it started (else they live on as orphans beside the next board's)
  console.log(require('../lib/kill').killTree(pid) ? 'Stopped.' : 'Not running.');
  try { fs.rmSync(pidFile); } catch { /* gone */ }
}

// Everything an agent needs to start, from the board itself (so it is never stale).
async function brief() {
  const f = flags(rest);
  const m = readManifest(findManifest());
  const url = baseUrl(m); // INTELLAGENT_URL, or the nearest board folder
  if (!url) { console.error(NO_BOARD); process.exit(3); }
  const agent = String(f.agent || defaultAgent(m) || 'agent');
  const board = String(f.board || process.env.INTELLAGENT_BOARD || m?.defaultBoard || 'main');
  let r;
  try { r = await require('../lib/request').send('GET', `/api/boards/${board}/brief?via=${f.via || 'cli'}`, undefined, { agent, base: url }); }
  catch { console.error(`The board isn't running (${url}). Start it in the background: intellagent start --background`); process.exit(1); }
  process.stdout.write(`${r.raw}\n`);
  if (!r.ok) process.exit(1);
}

async function status() {
  const mp = findManifest();
  const url = baseUrl(readManifest(mp));
  if (!url) { console.log(NO_BOARD); return; }
  const app = await alive(url);
  console.log(`manifest  ${mp || '(none — using defaults)'}`);
  if (mp) { const pr = projectOf(mp); console.log(`project   ${pr}${fs.existsSync(pr) ? '' : '  ⚠ missing'}`); }
  console.log(`url       ${url}  ${app ? '● running' : '○ not running'}`);
  if (!app) return;
  // As the human: a board that requires tokens answers an anonymous caller with an error, not its boards.
  const t = mp && userToken(mp);
  const r = await fetch(`${url}/api/boards`, { headers: { 'x-user': os.userInfo().username, ...(t ? { authorization: `Bearer ${t}` } : {}) } });
  const boards = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(boards)) { console.log(`boards    (not readable: ${boards?.error || r.status})`); return; }
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

/* ── presets: packages of board (and later permissions and roles) ── */

// Asks before writing; --yes agrees up front. With no terminal and no --yes it refuses, so a script never hangs.
async function confirm(question, f) {
  if (f.yes) return true;
  if (!process.stdin.isTTY) { console.error('error 400 BAD_REQUEST: this asks before it writes, and there is no terminal — hint: add --yes to agree'); process.exit(1); }
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(`${question} [y/N] `, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function loadPreset(spec, boardDir) {
  try { return presets.load(spec, boardDir); } catch (e) { console.error(`error ${e.code === 'NOT_FOUND' ? 404 : 400} ${e.code || 'BAD_REQUEST'}: ${e.message} — hint: intellagent preset list`); process.exit(1); }
}

function printPowers(p) {
  const powers = presets.powers(p);
  console.log(`\n  ${p.name}@${p.version} brings:`);
  console.log(`    ${Object.keys(presets.parts(p)).length} pieces of board: ${Object.keys(presets.parts(p)).join(', ')}`);
  console.log(powers.length ? `  and gives it these powers:\n${powers.map((x) => `    - ${x}`).join('\n')}` : '  and gives it no powers beyond a plain board.');
  console.log('  It brings no commands or tools yet (permissions and roles are not part of a preset).\n');
}

const WORD = { new: 'add', same: 'already there', update: 'update', edited: 'yours, kept', dropped: 'you removed it, kept off', gone: 'no longer in the preset, kept' };
function printPlan(steps) {
  for (const s of steps) console.log(`    ${s.state.padEnd(8)} ${s.id}  (${WORD[s.state]})`);
}

// Add or update one piece of the board through the API, as the human.
async function applyStep(board, s) {
  const b = `/api/boards/${board}`;
  const [kind, key] = s.id.includes(':') ? [s.id.slice(0, s.id.indexOf(':')), s.id.slice(s.id.indexOf(':') + 1)] : [s.id, ''];
  const fresh = s.state === 'new';
  if (kind === 'column') return fresh ? asHuman('POST', `${b}/columns`, s.value) : asHuman('PATCH', `${b}/columns/${encodeURIComponent(key)}`, s.value);
  if (kind === 'field') return fresh ? asHuman('POST', `${b}/schema/fields`, s.value) : asHuman('PATCH', `${b}/schema/fields/${encodeURIComponent(key)}`, s.value);
  if (kind === 'ticket-template') return fresh ? asHuman('POST', `${b}/ticket-templates`, s.value) : asHuman('PATCH', `${b}/ticket-templates/${encodeURIComponent(key)}`, s.value);
  if (kind === 'directives') return asHuman('PUT', `${b}/directives`, { directives: s.value });
}

async function presetCmd() {
  const [sub = 'list', spec] = rest;
  const f = flags(rest.slice(1));
  if (sub === 'list') {
    const mp = findManifest();
    const dir = mp ? path.dirname(mp) : null;
    const lock = dir ? presets.readLock(dir).presets : {};
    for (const [n, p] of Object.entries(presets.all(dir))) {
      const on = lock[n] ? `  installed ${lock[n].version}${lock[n].version !== p.version ? ` (available ${p.version})` : ''}` : '';
      console.log(`  ${n.padEnd(10)} ${p.broken ? `NOT USABLE: ${p.broken}` : `${p.version.padEnd(5)} ${p.label || ''}`}  [${p.source}]${on}`);
    }
    return;
  }
  if (!['add', 'diff', 'update'].includes(sub)) { console.error('Usage: intellagent preset list | add <name|folder> [--yes] | diff <name> | update <name|folder> [--accept all|id,id]'); process.exit(1); }
  if (!spec) { console.error(`Usage: intellagent preset ${sub} <name${sub === 'diff' ? '' : '|folder'}>`); process.exit(1); }
  humanOnly(`intellagent preset ${sub}`);
  const mp = requireManifest();
  const dir = path.dirname(mp);
  const board = String(f.board || readManifest(mp)?.defaultBoard || 'main');
  const p = loadPreset(spec, dir);
  const lock = presets.readLock(dir).presets[p.name];
  const live = (await asHuman('GET', `/api/boards/${board}`)).board;
  const steps = presets.plan(p, lock?.parts, live);
  if (sub === 'add') {
    if (lock) { console.error(`error 409 CONFLICT: ${p.name}@${lock.version} is already on this board — hint: intellagent preset diff ${p.name}, then preset update ${p.name} --accept all`); process.exit(1); }
    printPowers(p);
    printPlan(steps);
    const todo = steps.filter((s) => s.state === 'new');
    if (!await confirm(`Add ${todo.length} piece${todo.length === 1 ? '' : 's'} to board "${board}"?`, f)) { console.log('Nothing written.'); return; }
    if (p.dir) presets.addFolder(p, dir);
    for (const s of todo) await applyStep(board, s);
    presets.record(dir, p, steps.filter((s) => s.state === 'new' || s.state === 'same').map((s) => s.id));
    console.log(`  ✓ ${p.name}@${p.version}: ${todo.length} added, ${steps.length - todo.length} left as they were.`);
    return;
  }
  if (!lock) { console.error(`error 404 NOT_FOUND: ${p.name} is not installed on this board — hint: intellagent preset add ${p.name}`); process.exit(1); }
  console.log(`\n  ${p.name}: installed ${lock.version}, available ${p.version}`);
  printPlan(steps.filter((s) => s.state !== 'same'));
  if (sub === 'diff') return;
  const can = steps.filter((s) => s.state === 'new' || s.state === 'update');
  if (!f.accept) { console.log(can.length ? `\n  Accept them with: intellagent preset update ${p.name} --accept all   (or --accept id,id)` : '\n  Nothing to update.'); return; }
  const want = f.accept === true || f.accept === 'all' ? can.map((s) => s.id) : String(f.accept).split(',').map((x) => x.trim());
  const bad = want.filter((id) => !can.some((s) => s.id === id));
  if (bad.length) { console.error(`error 400 BAD_REQUEST: cannot take ${bad.join(', ')}: not a new or updatable piece — hint: intellagent preset diff ${p.name}; edited pieces are yours and are never overwritten`); process.exit(1); }
  for (const s of can.filter((x) => want.includes(x.id))) await applyStep(board, s);
  if (p.dir) presets.addFolder(p, dir); // updating from a newer folder: the board keeps this copy
  presets.record(dir, p, [...steps.filter((s) => s.state === 'same').map((s) => s.id), ...want]);
  console.log(`  ✓ ${p.name}@${p.version}: ${want.length} piece${want.length === 1 ? '' : 's'} updated.`);
}

// Copies the bundled Claude Code skill to ~/.claude/skills (or ./.claude/skills with --project).
function skill() {
  const f = flags(rest);
  if (f._[0] !== 'install') { console.log('Usage: intellagent skill install [--project]'); return; }
  const base = f.project ? path.join(process.cwd(), '.claude', 'skills') : path.join(os.homedir(), '.claude', 'skills');
  // intellagent: how an agent works a ticket (loads when it does); intellagent-setup: setting up a board
  for (const name of ['intellagent', 'intellagent-setup']) {
    const dest = path.join(base, name, 'SKILL.md');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), dest);
    console.log(`Installed ${dest}`);
  }
  console.log('In Claude Code: agents pick up the intellagent skill when they work a ticket; /intellagent-setup sets up a board.');
}

/* ── wait / watch: make the board able to wake an agent ── */

function agentName(f) {
  const a = f.agent || defaultAgent();
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
  // the cursor lives in the board folder; with only INTELLAGENT_URL, in a temp file per board and agent
  const file = mp ? cursorPath(mp, agent, listen.scope)
    : path.join(os.tmpdir(), 'intellagent-cursors', `${crypto.createHash('sha1').update(url).digest('hex').slice(0, 10)}-${String(agent).replace(/[^\w.-]+/g, '_')}${listen.scope ? `-${listen.scope}` : ''}.json`);
  let since = null;
  try { since = jsonfile.read(file).cursor; } catch { /* first run */ }
  const get = async (p) => (await require('../lib/request').send('GET', p, undefined, { agent, base: url })).json;
  if (since == null) {
    // First wait: start right after this agent's own last action, so an answer that arrived between
    // "ask" and "wait" is not missed; an agent that has done nothing yet starts from now.
    try {
      const mine = (await get(`/api/events?actor=${encodeURIComponent(agent)}&tail=true&limit=1`)).events || [];
      since = mine.length ? mine[mine.length - 1].seq : null;
    } catch { /* fall back to now */ }
    if (since == null) since = (await get('/api/app')).seq;
  }
  const deadline = timeoutSec ? Date.now() + timeoutSec * 1000 : Infinity;
  for (;;) {
    const left = Math.max(1, Math.min(50, Math.ceil((deadline - Date.now()) / 1000)));
    const q = new URLSearchParams({ ...(listen.query || { for: agent }), excludeActor: agent, since: String(since), timeout: String(left), ...(types ? { types } : {}) });
    let r;
    try { r = await get(`/api/events/wait?${q}`); }
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
  let events = await nextEvents({ agent, types: f.types, timeoutSec: Number(f.timeout) || 0, listen: listenScope(f) });
  // One human action is often several events (approve = resolved + moved + approved): wait a moment
  // so the whole burst comes back together instead of waking the agent once per event.
  if (events.length) {
    await new Promise((res) => setTimeout(res, 2000));
    events = events.concat(await nextEvents({ agent, types: f.types, timeoutSec: 1, quiet: true, listen: listenScope(f) }));
  }
  if (!events.length) { console.log('(no events before timeout)'); process.exit(2); }
  // The agent is about to read these: mark comments as seen (👀) so the human knows.
  const url = baseUrl(readManifest(findManifest()));
  await Promise.all(events.filter((e) => e.type === 'comment.added' && e.comment?.id).map((e) => require('../lib/request').send('POST', `/api/boards/${e.board}/items/${e.itemId}/reactions`, { emoji: '👀', commentId: e.comment.id }, { agent, base: url }).catch(() => {})));
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
    // Beside the cursors; a board reached by --url or INTELLAGENT_URL has no manifest, so a temp folder.
    const mp = findManifest();
    const evDir = mp ? path.join(path.dirname(mp), 'cursors') : path.join(os.tmpdir(), 'intellagent-cursors');
    const evFile = path.join(evDir, `${agent.replace(/[^\w.-]+/g, '_')}-events.json`);
    fs.mkdirSync(evDir, { recursive: true });
    fs.writeFileSync(evFile, JSON.stringify(events, null, 2));
    const prompt = [
      listen.query
        ? `You are "${agent}", coordinating this project's Intellagent board. New activity (${what}):`
        : `You are "${agent}", working on this project's Intellagent board. These events are addressed to you:`,
      ...events.map((e) => `- ${e.board && e.board !== 'main' ? `[board ${e.board}] ` : ''}${eventLine(e)}`),
      '',
      `Read each ticket for context (intellagent api GET /api/boards/<board>/items/<ID>; the board is ${[...new Set(events.map((e) => e.board).filter(Boolean))].join(', ') || 'main'}), act on it following the board's standing rules and the project's CLAUDE.md, and reply on the card.`,
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
  return jsonfile.readOr(file, { defaults: {}, agents: {} });
}

// Who is running this, if it is an agent ('' for the human). The board sets INTELLAGENT_AGENT (and the run) for
// every standing-agent run.
function asAgent() {
  return process.env.INTELLAGENT_AGENT || (process.env.INTELLAGENT_RUN || process.env.INTELLAGENT_RUN_FILE ? 'a standing agent' : '');
}
// Commands that act as the human (with the user token from local.json) or write the human's files refuse to
// run as an agent: a standing agent's shell may run "intellagent …", and it must not merge, steer other agents
// or change grants that way.
function humanOnly(what) {
  const agent = asAgent();
  if (!agent) return;
  console.error(`error 403 HUMAN_ONLY: ${what} is the human's — refused for ${agent} — hint: ask the human on the card (intellagent do ask_human id=<ID> reason="…")`);
  process.exit(1);
}

async function asHuman(method, p, body) {
  humanOnly(`intellagent ${cmd}`);
  const mp = requireManifest();
  const m = readManifest(mp);
  const url = baseUrl(m);
  const t = userToken(mp);
  const headers = { 'content-type': 'application/json', 'x-user': os.userInfo().username, ...(t ? { authorization: `Bearer ${t}` } : {}) };
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
  if (sub === 'add' || sub === 'remove') humanOnly(`intellagent agents ${sub}`);
  const f = flags(rest.slice(sub === 'add' ? 2 : 0));
  const mp = requireManifest();
  const file = agentsFile(mp);
  if (!sub || sub === 'list') {
    const { agents, error } = await asHuman('GET', '/api/agents');
    if (error) console.log(`⚠ ${error}`);
    if (!agents.length) { console.log(`No standing agents. Add one:  intellagent agents add builder\n(definitions live in ${file})`); return; }
    for (const a of agents) {
      const last = a.lastRun ? `last run ${ago(a.lastRun.endedAt || a.lastRun.startedAt)} (${a.lastRun.code ?? 'running'})${a.lastRun.why ? ` for ${a.lastRun.why}` : ''}` : 'never run';
      console.log(`${a.name.padEnd(14)} ${a.status.padEnd(10)} ${String(a.queued).padStart(3)} queued  ${a.runsLastHour}/${a.maxRunsPerHour ?? '∞'} runs/h  ${last}   ${a.keepAlive ? (a.session ? `alive ${a.session.turns}/${a.session.recycleAfter} turns  ` : 'keep-alive  ') : ''}${a.model ? `model: ${a.model}${a.tier ? ` (${a.tier})` : ''}  ` : ''}listens: ${typeof a.listen === 'string' ? a.listen : JSON.stringify(a.listen)}${a.pickup ? `  pickup: ${a.pickup}` : ''}`);
    }
    return;
  }
  if (sub === 'add') {
    if (!name) { console.error('Usage: intellagent agents add <name> [--listen addressed|inbox|human|new-tickets|"types=…"] [--run "<command>"] [--max-runs 20] [--model haiku|sonnet|opus] [--description "…"]'); process.exit(1); }
    const doc = readAgents(file);
    doc.agents ||= {};
    const listen = !f.listen || ['addressed', 'inbox', 'human', 'new-tickets'].includes(f.listen) ? (f.listen || 'addressed') : Object.fromEntries(new URLSearchParams(String(f.listen)));
    const { ROLES } = require('../lib/agents');
    const lib = require('../lib/permissions').createLibrary(doc.perms); // built-ins plus this file's own
    if (f.model && !/^[\w.:-]{1,64}$/.test(String(f.model))) { console.error('--model: a plain name like haiku, sonnet or opus'); process.exit(1); }
    if (f.role && !ROLES[f.role]) { console.error(`Unknown role "${f.role}". Roles: ${Object.keys(ROLES).join(', ')}`); process.exit(1); }
    const perms = f.allow ? String(f.allow).split(',').map((x) => x.trim()).filter(Boolean) : null;
    const badPerms = (perms || []).filter((k) => !lib.holdable(k));
    if (badPerms.length) { console.error(`Unknown permission(s): ${badPerms.join(', ')}. Use: ${Object.keys(lib.labels()).join(', ')}`); process.exit(1); }
    doc.agents[name] = {
      ...(doc.agents[name] || {}),
      ...(f.role ? { role: String(f.role) } : {}),
      ...(perms ? { perms } : {}),
      ...(f.listen || !f.role ? { listen } : {}),
      ...(f.run ? { run: String(f.run) } : {}),
      ...(f['max-runs'] != null ? { maxRunsPerHour: f['max-runs'] === 'none' ? null : Number(f['max-runs']) } : {}),
      ...(f.throttle != null ? { throttleMinutes: Number(f.throttle) } : {}),
      ...(f.model ? { model: String(f.model) } : {}),
      ...(f.areas ? { areas: String(f.areas).split(',').map((x) => x.trim()).filter(Boolean) } : {}),
      ...(f.concerns ? { concerns: String(f.concerns).split(',').map((x) => x.trim()).filter(Boolean) } : {}),
      ...(f.description ? { description: String(f.description) } : {}),
    };
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`Saved "${name}" to ${file}. The running board picks it up within a few seconds.`);
    // A missing command would only show up as failed runs: check it now.
    const exe = String(doc.agents[name].run || doc.defaults?.run || 'claude').trim().match(/^"([^"]+)"|^(\S+)/).slice(1).find(Boolean);
    const found = require('child_process').spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], { stdio: 'ignore' }).status === 0;
    if (!found) console.log(`⚠ "${exe}" is not on PATH, so runs will fail. ${exe === 'claude' ? 'Install Claude Code (https://claude.com/claude-code) and sign in once by running `claude`.' : 'Install it or use a full path in --run.'}`);
    if (!f.run && !f.role && !perms && !doc.defaults?.run) console.log('Tip: give it a role (--role coordinator|builder|reviewer|researcher|writer) or permissions (--allow edit,test,build,git,web,read) so its runs can do their job.');
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
  if (sub !== 'status') humanOnly(`intellagent autostart ${sub}`);
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

/* Operations by name — the same definitions as the MCP tools (lib/tools.js), so an agent without the MCP
   server (or with only its core) gets the same calls with the same parameters.
     intellagent do <operation> key=value …   run it (JSON out; errors: code + hint on stderr, exit 1)
     intellagent help <operation>             its exact request shape */
function operations() {
  const { makeTools } = require('../lib/tools');
  const m = readManifest(findManifest() || '');
  return makeTools({ board: process.env.INTELLAGENT_BOARD || m?.defaultBoard || 'main', agent: () => require('../lib/request').agentName() });
}
function findOps(query) {
  const ops = operations();
  const qy = String(query || '').toLowerCase().replace(/-/g, '_');
  const exact = ops.find((t) => t[0] === qy);
  if (exact) return [exact];
  const byName = ops.filter((t) => t[0].includes(qy));
  return byName.length ? byName : ops.filter((t) => t[1].toLowerCase().includes(qy));
}
// One command's entry from HELP: its line and the indented lines under it ("init", "agents", "leases"…).
function commandHelp(name) {
  const out = [];
  for (const line of HELP.split('\n').slice(1)) {
    if (/^ {2}\S/.test(line)) {
      if (out.length) break;
      if (line.trim().split(/\s+/)[0] === name) out.push(line);
    } else if (out.length) {
      if (!line.trim()) break;
      out.push(line);
    }
  }
  return out.length ? out.join('\n') : null;
}
function opHelp(query) {
  const { requestShape } = require('../lib/tools');
  const q = String(query).toLowerCase().replace(/-/g, '_');
  if (!operations().some((t) => t[0] === q)) {
    const entry = commandHelp(String(query).toLowerCase());
    if (entry) { console.log(entry); return; }
  }
  const hits = findOps(query);
  if (!hits.length) { console.error(`No command or operation matches "${query}". Commands: ${Object.keys(commands).join(', ')}. Operations: ${operations().map((t) => t[0]).join(', ')}`); process.exit(2); }
  for (const t of hits.slice(0, 6)) {
    const [name, description, props, required] = t;
    const shape = requestShape(t);
    console.log(`${name} — ${description}`);
    if (shape) console.log(`  request  ${shape.method} ${shape.path}${shape.query.length ? ` ?${shape.query.join('&')}` : ''}`);
    for (const [k, v] of Object.entries(props)) console.log(`  ${required.includes(k) ? '*' : ' '} ${k.padEnd(16)} ${v.type}${v.description ? ` — ${v.description}` : ''}`);
    const ex = required.map((k) => `${k}=${k === 'id' ? 'INT-12' : `<${k}>`}`).join(' ');
    console.log(`  run      intellagent do ${name}${ex ? ` ${ex}` : ''}${shape ? `\n  or       intellagent api ${shape.method} ${shape.path.replace('<board>', 'main').replace('<ID>', 'INT-12')}` : ''}\n`);
  }
  if (hits.length > 6) console.log(`… and ${hits.length - 6} more: ${hits.slice(6).map((t) => t[0]).join(', ')}`);
}
async function doOp() {
  const [query, ...pairs] = rest;
  if (!query) { console.error('Usage: intellagent do <operation> key=value …   (intellagent help <operation> for its parameters)'); process.exit(2); }
  const { fromPairs, send, report } = require('../lib/request');
  const t = operations().find((x) => x[0] === String(query).toLowerCase().replace(/-/g, '_'));
  if (!t) { const near = findOps(query).map((x) => x[0]); console.error(`No operation "${query}".${near.length ? ` Did you mean: ${near.slice(0, 5).join(', ')}?` : ''}`); process.exit(2); }
  const compact = pairs.includes('--compact');
  let args;
  try { args = fromPairs(pairs.filter((x) => x !== '--compact')); } catch (e) { console.error(e.message); process.exit(2); }
  const missing = t[3].filter((k) => args[k] === undefined || args[k] === '');
  if (missing.length) { console.error(`${t[0]} needs: ${missing.join(', ')}  (intellagent help ${t[0]})`); process.exit(2); }
  const getJson = async (m, p) => (await send(m, p)).json;
  const [method, p, body] = await t[4](args, getJson);
  process.exitCode = report(await send(method, p, body), { compact });
}

// intellagent sandbox [name] [--from main|<agent>|<dir>] [--seed board|demo|empty|snapshot] [--fresh] [--open] [--json]
// intellagent sandbox list | stop <name> | stop --all
async function sandboxCmd() {
  const sb = require('../lib/sandbox');
  const mp = requireManifest();
  const f = flags(rest);
  const [sub, arg] = f._;
  if (sub === 'list') {
    const all = await sb.list(mp);
    if (f.json) { console.log(JSON.stringify(all, null, 2)); return; }
    if (!all.length) { console.log('No sandboxes yet: intellagent sandbox <agent>'); return; }
    for (const s of all) console.log(`${s.running ? '●' : '○'} ${s.name.padEnd(12)} ${s.url}  ${s.source || ''}`);
    return;
  }
  if (sub === 'stop') {
    const names = f.all ? (await sb.list(mp)).map((s) => s.name) : [arg].filter(Boolean);
    if (!names.length) { console.error('Usage: intellagent sandbox stop <name> | --all'); process.exit(2); }
    for (const n of names) console.log(`${n}: ${(await sb.stop(mp, n)) ? 'stopped' : 'not running'}`);
    return;
  }
  const name = sub || defaultAgent(readManifest(mp));
  if (!name) { console.error('Usage: intellagent sandbox <agent name>   (or set INTELLAGENT_AGENT)'); process.exit(2); }
  const r = await sb.start(mp, String(name), { from: String(f.from || 'main'), seed: f.seed ? String(f.seed) : null, fresh: !!f.fresh });
  if (f.json) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`${name}'s sandbox is running at ${r.url}  (${r.seed === 'kept' ? 'data kept' : `seeded: ${r.seed}${r.from ? `, from the board "${r.from}": its columns, fields and rules, no tickets` : ''}`}; code from ${r.source})`);
  console.log(`  sign in as its human:  ${r.signIn}`);
  console.log(`  talk to it as an agent: intellagent brief --url ${r.url}   (or INTELLAGENT_URL=${r.url})`);
  console.log('  standing agents never run in a sandbox; your real board is untouched.');
  console.log(`  stop it: intellagent sandbox stop ${name}`);
  if (f.open) openUrl(r.signIn);
}

const HELP = `intellagent — a kanban for you and your agents

  init [dir]       set up a board here, start it, open it   --template --name --prefix --port --agent (default claude)
                   --port N (default: the first free port from 7420)  --prefix XX (ticket ids)  --open-agents (agents need no token)
                   also adds the MCP tools (.mcp.json) and CLAUDE.md instructions; opt out: --no-mcp --no-claude --no-start --no-token
  templates        list board templates (software, research, ops, ...)
  preset           packages of board: preset list | add NAME|FOLDER [--yes] | diff NAME | update NAME [--accept all|id,id]
                   init --preset NAME|FOLDER sets a board up from one; it lists the powers it brings and asks first (--yes agrees)
                   an update never overwrites what you edited: edited pieces are kept, the rest you accept one by one
  skill install    add the intellagent skills to Claude Code (working a ticket; setting up)   [--project]
  start            run this project's board      --open --background
  stop             stop a board started in the background
  brief            what an agent needs to start: next steps, columns, templates, rules, calls   --agent --via cli|mcp|http
  open             open the board in a browser (signed in, if the board has a user token)
  merge ID         land an approved ticket's commits from its agent's worktree branch on main
  project [PATH]   show, or set, the folder with the code (a board kept outside the project)
  link BOARD       in a project: use the board kept at BOARD (its folder or manifest)
  token --agent N  issue (or --rotate) an agent's token, for boards that require agent tokens
  token [--rotate] give this board a user token so only you can act as the human (older boards)
  status           where it is and whether it's running
  docs             print the agent guide
  api M PATH [b]   call the API as an agent      (INTELLAGENT_AGENT=name; body: key=value… | json | @file | -)
                   key=@path reads that one value from a file (a long comment: body=@C:/tmp/c.md); key=@@text sends the text "@text"
                   files only from the project, its worktrees and the temp folder; never local.json or the board's data
  do OP [k=v …]    run an operation by name (the MCP tools, all of them): intellagent do move_item id=INT-12 column=Review
  help CMD|OP      a command's usage (help init), or an operation's exact request and parameters (help lease, help search …)
                   api/do: JSON on stdout; errors: "error <status> <CODE>: … — hint: …" on stderr, exit 1 (2 unreachable/bad input, 3 no board)
  wait             block until something arrives in your inbox, print it, exit   --agent --types --timeout --json
  watch -- CMD     run CMD each time your inbox gets events (unattended agents)   --agent --claude --once
                   both also take --human (everything the human does: for a coordinator)
                   or --filter "types=item.created&column=Ready" (any /api/events filter)
  mcp              MCP server over stdio
  hook ...         git: install | post-commit | sync-ci

  agents           standing agents the board wakes up itself (defined in .intellagent/agents.json)
    add NAME       --role coordinator|builder|reviewer|researcher|writer|designer  --allow edit,test,build,git,web,read
                   --listen addressed|inbox|human|new-tickets|"types=…"  --max-runs N|none  --throttle MIN  --run "<command>" (overrides role)
                   --model haiku|sonnet|opus  (junior / mid / senior; the receptionist routes by it)
                   --areas "public/app.css,public/themes/"  --concerns "accessibility,performance"  (its speciality)
    pause | resume | run | log | remove NAME
  autostart on|off start this board (and its agents) when you log in

  sandbox [NAME]   a throwaway board of your own, running any checkout (--from main|<agent>|<dir>, --seed board|demo|empty|snapshot, --fresh); sandbox list | stop NAME|--all
  leases           the machine's leases for heavy work — browsers, solves, timings (one per PC; every board shares it)
    status | machine | ask --holder N --cpu T --gpu MB --minutes M [--exclusive] | renew ID | done ID | ceiling | start | stop
`;

const commands = {
  init, start, stop, status, docs, templates, skill, brief,
  preset: presetCmd,
  open: () => { if (!findManifest()) { console.error(NO_BOARD); process.exit(3); } openBoard(); },
  token: tokenCmd,
  project: projectCmd,
  link: linkCmd,
  sandbox: sandboxCmd,
  // land an approved ticket's commits from its agent's worktree branch on main (when approval couldn't)
  merge: () => {
    const id = rest[0];
    if (!id) { console.error('Usage: intellagent merge <TICKET-ID> [--agent name] [--board id]'); process.exit(1); }
    const f = flags(rest.slice(1));
    const board = f.board || readManifest(requireManifest())?.defaultBoard || 'main';
    return asHuman('POST', `/api/boards/${board}/items/${id}/land`, f.agent ? { agent: String(f.agent) } : {}).then((r) => console.log(r.landed?.length ? `Landed ${r.landed.join(', ')} on main.` : `Not landed: ${r.reason || r.error || JSON.stringify(r)}`));
  },
  wait: waitCmd,
  agents: agentsCmd,
  autostart,
  watch: watchCmd,
  api: () => forward('cli.js', rest),
  do: () => doOp().catch((e) => { console.error(e.message); process.exit(e.exit || 2); }),
  mcp: () => forward('mcp.js', rest),
  hook: () => forward('git-hook.js', rest),
  leases: () => require('../lib/leasesCli').leases(rest).catch((e) => { console.error(e.message); process.exit(e.exit || 1); }),
  help: () => (rest[0] ? opHelp(rest[0]) : process.stdout.write(HELP)),
};
const run = commands[cmd] || commands.help;
Promise.resolve(run()).catch((e) => { console.error(e.message); process.exit(1); });
