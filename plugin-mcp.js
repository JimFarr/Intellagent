#!/usr/bin/env node
'use strict';
/* An MCP server for writing Intellagent plugins (INT-485): make one, check it, and try it the way the board runs it,
   with no board and nothing installed. Tools: plugin_guide, plugin_new, plugin_check, plugin_try.
   Start: node plugin-mcp.js (or intellagent plugin-mcp). The guide it serves is docs/plugins.md. */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { validate, NAME_RE } = require('./lib/plugins');
const { childEnv } = require('./lib/agents/runner');
const { serve, launched } = require('./lib/mcp-serve');

const ROOT = __dirname;
const VERSION = require('./package.json').version;
const [MAJOR, MINOR] = process.versions.node.split('.').map(Number);
const SANDBOX = MAJOR > 23 || (MAJOR === 23 && MINOR >= 5); // the board runs plugins only where --permission is stable

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function load(dir) {
  const root = path.resolve(String(dir || ''));
  const file = path.join(root, 'plugin.json');
  if (!fs.existsSync(file)) throw new Error(`no plugin.json in ${root}`);
  let json;
  try { json = readJson(file); } catch (e) { throw new Error(`plugin.json is not JSON: ${e.message}`); }
  return { root, ...validate(json, path.basename(root), root) };
}

// What plugin_new writes: a plugin.json and an index.js that already speaks the channel, so a first try succeeds.
function skeleton(name, label, actions, connection) {
  const json = {
    name, label: label || name, version: '0.1.0', description: `What ${label || name} does, in a sentence the human reads before enabling it.`,
    entry: 'index.js', hosts: [], connection: connection || [],
    actions: actions?.length ? actions : [{ id: 'hello', label: 'Say hello', help: 'Answers with a greeting: replace it with a real action', inputs: [{ key: 'who', label: 'Who', type: 'text', required: true }] }],
    events: [],
  };
  const handlers = json.actions.map((a) => `  async ${JSON.stringify(a.id)}(connection, inputs, ticket) {\n    // TODO: do the work; throw an Error with a plain message when it fails\n    return { message: \`${a.id} ran\`${a.inputs?.[0] ? `, ${a.inputs[0].key}: inputs[${JSON.stringify(a.inputs[0].key)}]` : ''} };\n  },`).join('\n');
  const index = `'use strict';
// ${label || name}: an Intellagent plugin. The board talks to it over stdin/stdout, one JSON object per line
// (docs/plugins.md). It runs sandboxed: it reads only this folder, writes only data/, and gets no environment.
//   { id, type: "test", connection }                                   -> { id, ok: true, result: { message } }
//   { id, type: "run", action, inputs, ticket?, connection }           -> { id, ok: true, result } | { id, ok: false, error }
//   it may also send { type: "event", event, data } for an event it declares in plugin.json

// Check the connection (the human's Test button): reach the service with it, and say who it signed in as.
async function test(connection) {
  return { message: 'Connected' };
}

const actions = {
${handlers}
};

const reply = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
async function handle(m) {
  try {
    if (m.type === 'test') return reply({ id: m.id, ok: true, result: await test(m.connection || {}) });
    if (m.type === 'run') {
      const act = actions[m.action];
      if (!act) throw new Error(\`no action "\${m.action}"\`);
      return reply({ id: m.id, ok: true, result: await act(m.connection || {}, m.inputs || {}, m.ticket || null) });
    }
    throw new Error(\`unknown call "\${m.type}"\`);
  } catch (e) { reply({ id: m.id, ok: false, error: String(e?.message || e).slice(0, 500) }); }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) { let m; try { m = JSON.parse(line); } catch { continue; } handle(m); }
  }
});
`;
  const readme = `# ${label || name}\n\nAn Intellagent plugin. ${json.description}\n\n- Actions: ${json.actions.map((a) => `\`${a.id}\``).join(', ')}\n- Talks to: ${json.hosts.length ? json.hosts.join(', ') : '(list the hosts in plugin.json)'}\n\nThe human adds this folder on the Integrations page, enables it, fills in the connection and grants its actions to agents. See docs/plugins.md in Intellagent.\n`;
  return { 'plugin.json': `${JSON.stringify(json, null, 2)}\n`, 'index.js': index, 'README.md': readme };
}

// Runs the plugin as the board does (lib/plugins.js start(): keep the flags in step), sends one call and collects
// what comes back until its reply, or the timeout.
function tryPlugin({ path: dir, type = 'test', action, inputs = {}, connection = {}, ticket = null, webhook = null, timeoutSec = 30 }) {
  const { root, def, problems } = load(dir);
  if (problems.length) throw new Error(`plugin.json has problems (run plugin_check):\n- ${problems.join('\n- ')}`);
  if (type === 'run' && !def.actions.some((a) => a.id === action)) throw new Error(`no action "${action}" in plugin.json (it has ${def.actions.map((a) => a.id).join(', ') || 'none'})`);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const args = SANDBOX ? ['--permission', `--allow-fs-read=${root}${path.sep}`, `--allow-fs-write=${path.join(root, 'data')}${path.sep}`] : [];
  if (SANDBOX && def.needs.childProcess) args.push('--allow-child-process');
  if (SANDBOX) for (const r of def.needs.read) args.push(`--allow-fs-read=${r}`);
  args.push(path.join(root, def.entry));
  const proc = spawn(process.execPath, args, { cwd: root, env: childEnv({ inheritEnv: [] }, null, {}), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const id = 'try-1';
  const events = [];
  let stderr = '';
  let buf = '';
  return new Promise((resolve) => {
    const finish = (out) => { clearTimeout(timer); proc.kill(); resolve({ ...out, events, stderr: stderr.trim().slice(-2000) || undefined, sandboxed: SANDBOX || `no: Node ${process.versions.node} (the board needs 23.5 or later to run plugins)` }); };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer in ${timeoutSec} s` }), Math.min(Number(timeoutSec) || 30, 300) * 1000);
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { stderr += `\n(not JSON on stdout: the board ignores it) ${line.slice(0, 200)}`; continue; }
        if (m?.type === 'event') events.push({ event: m.event, data: m.data, declared: def.events.some((e) => e.id === m.event) });
        else if (m?.id === id) finish({ ok: m.ok === true, ...(m.ok === true ? { result: m.result } : { error: m.error }) });
      }
    });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('exit', (code) => finish({ ok: false, error: `the plugin exited (code ${code}) before answering` }));
    proc.stdin.on('error', () => {});
    const extra = type === 'run' ? { action, inputs, ...(ticket ? { ticket } : {}) } : type === 'webhook' ? { webhook: { headers: webhook?.headers || {}, body: webhook?.body ?? '' } } : {};
    proc.stdin.write(`${JSON.stringify({ id, type, connection, ...extra })}\n`);
  });
}

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const TOOLS = [
  ['plugin_guide', 'START HERE: how an Intellagent plugin works (plugin.json, the stdin/stdout channel, the sandbox, secrets, what the human does).', {}, [],
    () => fs.readFileSync(path.join(ROOT, 'docs', 'plugins.md'), 'utf8')],
  ['plugin_new', 'Write a working plugin skeleton in <dir>/<name>: plugin.json, index.js (speaks the channel), README.md. Refuses to overwrite.',
    { dir: S('string', 'Folder to create the plugin in (absolute)'), name: S('string', 'Plugin name: lower-case, digits and -'), label: S('string', 'Display name'),
      actions: S('array', 'Actions: [{ id, label, help, inputs: [{ key, label, type, required }] }]', { items: {} }), connection: S('array', 'Connection fields: [{ key, label, type, secret?, required? }]', { items: {} }) },
    ['dir', 'name'], (a) => {
      if (!NAME_RE.test(a.name || '')) throw new Error('name: lower-case letters, digits and -, starting with a letter (max 40)');
      const root = path.join(path.resolve(a.dir), a.name);
      if (fs.existsSync(root)) throw new Error(`${root} already exists`);
      fs.mkdirSync(root, { recursive: true });
      for (const [f, body] of Object.entries(skeleton(a.name, a.label, a.actions, a.connection))) fs.writeFileSync(path.join(root, f), body);
      const { problems } = load(root);
      return `Made ${root}: plugin.json, index.js, README.md.${problems.length ? `\nplugin.json problems to fix:\n- ${problems.join('\n- ')}` : '\nNext: write the actions in index.js, then plugin_check and plugin_try.'}`;
    }],
  ['plugin_check', 'Check a plugin folder the way the board does when it is added: plugin.json, the entry file, and that the entry parses.',
    { path: S('string', 'The plugin folder (absolute)') }, ['path'], (a) => {
      const { root, def, problems } = load(a.path);
      const syntax = spawnSync(process.execPath, ['--check', path.join(root, def.entry)], { encoding: 'utf8' });
      if (syntax.status !== 0) problems.push(`${def.entry}: ${(syntax.stderr || '').trim().split('\n').slice(0, 4).join(' ')}`);
      return JSON.stringify({ ok: !problems.length, problems, plugin: { name: def.name, label: def.label, actions: def.actions.map((x) => ({ id: x.id, inputs: x.inputs.map((i) => i.key) })), events: def.events.map((e) => e.id), connection: def.connection.map((c) => `${c.key}${c.secret ? ' (secret)' : ''}`), hosts: def.hosts, needs: def.needs } }, null, 2);
    }],
  ['plugin_try', 'Run a plugin as the board does (sandboxed, no environment) and send it one call: "test" (the connection), "run" (an action) or "webhook" (a request to /hooks/<name>). Nothing is installed.',
    { path: S('string', 'The plugin folder (absolute)'), type: S('string', 'test | run | webhook'), webhook: S('object', 'webhook: the request, { headers: { name: value } (lower-case names), body: "the raw body as text" }'), action: S('string', 'run: the action id'), inputs: S('object', 'run: the action inputs'),
      connection: S('object', 'The connection values the human would enter'), ticket: S('object', 'run: the ticket it is for, { id, title, fields, properties }'), timeoutSec: S('number', 'Seconds to wait (default 30)') },
    ['path'], async (a) => JSON.stringify(await tryPlugin(a), null, 2)],
];

if (launched(module, __filename)) {
  serve({ name: 'intellagent-plugins', version: VERSION, tools: TOOLS,
    instructions: 'Writes and tries Intellagent plugins. Call plugin_guide first; then plugin_new, edit index.js, plugin_check, plugin_try. Nothing here touches a board: the human adds and enables the finished folder.' });
}

module.exports = { TOOLS, skeleton, tryPlugin };
