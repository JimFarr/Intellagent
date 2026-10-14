'use strict';
// What agents carry and call: the MCP tool profiles (size budget, every tool reachable), the CLI an agent
// uses beyond the MCP core (do/help, JSON out, errors with code + hint and exit codes, identity), and
// agent tokens on new boards.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { startServer, until, USER } = require('./helpers');
const { measure } = require('../scripts/measure-mcp');
const { makeTools } = require('../lib/tools');

const ROOT = path.join(__dirname, '..');
const CORE_BUDGET = 5000; // chars of tools/list JSON for the core profile
const CORE = ['get_briefing', 'get_my_work', 'get_item', 'start_work', 'set_status', 'add_comment', 'ask_human', 'request_review', 'wait_for_events', 'finish_session'];

// One MCP session: send requests, collect replies by id.
function mcp(env) {
  const p = spawn(process.execPath, [path.join(ROOT, 'mcp.js')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch { /* not ours */ }
    }
  });
  let n = 0;
  const call = (method, params) => new Promise((resolve) => { const id = ++n; waiting.set(id, resolve); p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  return { call, close: () => p.kill() };
}

// The CLI as an agent runs it: no TTY, no stdin, JSON out.
function cli(args, { cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'intellagent.js'), ...args], { cwd, env: { ...process.env, INTELLAGENT_URL: '', ...env }, encoding: 'utf8', input: '', timeout: 20000 });
  return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
}

describe('MCP tool profiles', () => {
  it('core is the default, lists exactly the core tools, and stays under its budget', async () => {
    const m = await measure('core');
    assert.deepEqual([...m.names].sort(), [...CORE].sort());
    assert.ok(m.chars <= CORE_BUDGET, `core tools/list is ${m.chars} chars; budget ${CORE_BUDGET}. Trim descriptions or move a tool out of core.`);
  });
  it('full lists every tool; an allow-list lists only the named ones', async () => {
    const full = await measure('full');
    assert.deepEqual(full.names, makeTools().map((t) => t[0]));
    assert.ok(full.chars < 24001, `full got bigger than before the trim: ${full.chars}`);
    assert.deepEqual((await measure('tools=search,get_item,no_such_tool')).names, ['get_item', 'search']);
  });

  describe('against a board', () => {
    let s;
    before(async () => { s = await startServer({ agents: { agents: {} } }); });
    after(async () => { await s.stop(); });

    it('every tool is reachable by name, also those core does not list', async () => {
      const c = mcp({ INTELLAGENT_URL: s.base, INTELLAGENT_AGENT: 'ada', INTELLAGENT_MCP_PROFILE: 'core' });
      try {
        await c.call('initialize', { clientInfo: { name: 'test' } });
        const dummy = { id: 'T-999', ids: ['T-999'], status: 'x', reason: 'x', changed: 'x', why: 'x', verify: 'x', column: 'Backlog', title: 'x', label: 'x', key: 'k', type: 'text', builtins: {}, name: 'x', requestId: 'r_x', subscription: 'sub_x', emoji: 'eyes', summary: 'x', role: 'builder', timeout: 1 };
        for (const [name, , , required] of makeTools()) {
          if (name === 'rename_app' || name === 'create_board' || name === 'introduce_yourself') continue; // would change this test board's identity
          const args = Object.fromEntries(required.map((k) => [k, dummy[k] ?? 'x']));
          const r = await c.call('tools/call', { name, arguments: args });
          const text = r.result?.content?.[0]?.text || r.error?.message || '';
          assert.doesNotMatch(text, /Unknown tool/, `${name} is not reachable`);
        }
      } finally { c.close(); }
    });
    it('a new agent also gets introduce_yourself until it has a role', async () => {
      const c = mcp({ INTELLAGENT_URL: s.base, INTELLAGENT_AGENT: 'newbie' });
      try {
        await c.call('initialize', { clientInfo: { name: 'test' } });
        const names = (await c.call('tools/list', {})).result.tools.map((t) => t.name);
        assert.ok(names.includes('introduce_yourself'));
        assert.equal(names.length, CORE.length + 1);
      } finally { c.close(); }
    });
  });
});

describe('the CLI for agents', () => {
  let s;
  before(async () => { s = await startServer({ agents: { agents: {} } }); });
  after(async () => { await s.stop(); });

  it('help <operation> prints the exact request; unknown operations exit 2', () => {
    const h = cli(['help', 'hand_over_lease']);
    assert.equal(h.code, 0);
    assert.match(h.out, /POST \/api\/boards\/<board>\/items\/<ID>\/lease\/handover/);
    assert.match(h.out, /intellagent do hand_over_lease id=INT-12/);
    assert.equal(cli(['help', 'make_coffee']).code, 2);
  });
  it('do <operation> runs it as INTELLAGENT_AGENT and prints JSON', async () => {
    const it = cli(['do', 'create_item', 'title=from the CLI', 'column=Backlog', 'priority=High'], { cwd: s.dir, env: { INTELLAGENT_AGENT: 'cli-tester' } });
    assert.equal(it.code, 0, it.err);
    assert.equal(it.json.author.name, 'cli-tester', 'identity from INTELLAGENT_AGENT');
    const moved = cli(['do', 'move_item', `id=${it.json.id}`, 'column=Ready'], { cwd: s.dir, env: { INTELLAGENT_AGENT: 'cli-tester' } });
    assert.equal(moved.code, 0, moved.err);
    assert.equal((await s.ok('GET', `/api/boards/main/items/${it.json.id}`)).column, 'Ready');
  });
  it('errors carry the code and hint on stderr with exit 1; bad input exits 2; nothing prompts', async () => {
    const it = await s.ok('POST', '/api/boards/main/items', { title: 'held', column: 'Ready' }, USER);
    await s.ok('POST', `/api/boards/main/items/${it.id}/start`, {}, { agent: 'holder' });
    const r = cli(['do', 'start_work', `id=${it.id}`], { cwd: s.dir, env: { INTELLAGENT_AGENT: 'other' } });
    assert.equal(r.code, 1);
    assert.match(r.err, /^error 423 LEASED: .* — hint: /m);
    assert.equal(r.json.code, 'LEASED', 'the reply is still JSON on stdout');
    const api = cli(['api', 'GET', '/api/boards/main/items/NOPE-1'], { cwd: s.dir, env: { INTELLAGENT_AGENT: 'other' } });
    assert.equal(api.code, 1);
    assert.match(api.err, /^error 404/m);
    const missing = cli(['do', 'request_review', `id=${it.id}`], { cwd: s.dir });
    assert.equal(missing.code, 2);
    assert.match(missing.err, /needs: changed, why, verify/);
  });
});

describe('agent tokens on new boards', () => {
  it('init turns on agent tokens for a new board and gives the default agent one; existing boards are left alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-init-'));
    const r = cli(['init', '--name', 'Token Test', '--no-start', '--no-open', '--no-mcp', '--no-claude'], { cwd: dir });
    assert.equal(r.code, 0, r.err || r.out);
    const m = JSON.parse(fs.readFileSync(path.join(dir, '.intellagent', 'intellagent.manifest.json'), 'utf8'));
    assert.equal(m.auth.requireAgentTokens, true);
    assert.equal(m.host, '127.0.0.1');
    const local = JSON.parse(fs.readFileSync(path.join(dir, '.intellagent', 'local.json'), 'utf8'));
    assert.ok(local.agentTokens[m.defaultAgent], 'the default agent has a token');
    assert.ok(fs.readFileSync(path.join(dir, '.intellagent', '.gitignore'), 'utf8').includes('local.json'));
  });
  it('an agent without a token is refused with a hint; intellagent token --agent fixes it without a restart', async () => {
    const s = await startServer({ manifest: { auth: { requireAgentTokens: true } }, agents: { agents: {} } });
    try {
      const no = cli(['do', 'get_my_work'], { cwd: s.dir, env: { INTELLAGENT_AGENT: 'pat' } });
      assert.equal(no.code, 1);
      assert.match(no.err, /error 401.*hint: The human issues one: intellagent token --agent pat/);
      assert.equal(cli(['token', '--agent', 'pat'], { cwd: s.dir }).code, 0);
      const yes = cli(['do', 'get_my_work'], { cwd: s.dir, env: { INTELLAGENT_AGENT: 'pat' } });
      assert.equal(yes.code, 0, yes.err);
      assert.equal(yes.json.agent, 'pat');
    } finally { await s.stop(); }
  });
  it('a standing agent added to agents.json while the board runs gets its token without a restart', async () => {
    const s = await startServer({ manifest: { auth: { requireAgentTokens: true } }, agents: { agents: {} } });
    try {
      // as `intellagent agents add late` does: the file is edited, and the running board notices
      fs.writeFileSync(path.join(s.dir, 'agents.json'), JSON.stringify({ agents: { late: { enabled: false, perms: ['read'] } } }));
      await until(async () => cli(['do', 'get_my_work'], { cwd: s.dir, env: { INTELLAGENT_AGENT: 'late' } }).code === 0, 10000, 'late can call the board');
    } finally { await s.stop(); }
  });
});

describe('waiting from the CLI', () => {
  it('brief and wait work with only INTELLAGENT_URL, and wait catches an answer that came before it was called', async () => {
    const s = await startServer({ agents: { agents: {} } });
    const away = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-away-')); // no board folder here
    try {
      const env = { INTELLAGENT_URL: s.base, INTELLAGENT_AGENT: 'asker' };
      const b = cli(['brief'], { cwd: away, env });
      assert.equal(b.code, 0, b.err);
      const it = await s.ok('POST', '/api/boards/main/items', { title: 'sso?', column: 'Ready' }, USER);
      const ask = cli(['do', 'ask_human', `id=${it.id}`, 'reason=Which provider?'], { cwd: away, env });
      assert.equal(ask.code, 0, ask.err);
      // the human answers before the agent gets round to waiting
      await s.ok('DELETE', `/api/boards/main/items/${it.id}/attention`, { reply: 'Okta' }, USER);
      const w = cli(['wait', '--timeout', '5'], { cwd: away, env });
      assert.equal(w.code, 0, w.err || w.out);
      assert.match(w.out, /attention\.resolved.*Okta/);
    } finally { await s.stop(); }
  });
});

describe('a board kept outside the project', () => {
  it('projectRoot sends agents, conventions and the brief to the project; link lets the project find the board', async () => {
    const { execFileSync } = require('child_process');
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-project-'));
    const git = (...a) => execFileSync('git', a, { cwd: project, encoding: 'utf8' });
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@e.com'); git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Conventions\nTabs, never spaces.\n');
    git('add', '.'); git('commit', '-q', '-m', 'init');
    const fake = path.join(__dirname, 'fake-agent.js');
    const s = await startServer({ manifest: { projectRoot: project }, agents: { agents: { dev: { run: `node "${fake}" commit`, worktree: false } } } });
    try {
      // conventions and the brief come from the project
      assert.match(JSON.stringify((await s.ok('GET', '/api/boards/main/directives')).projectRules), /Tabs, never spaces/);
      const brief = (await s.api('GET', '/api/boards/main/brief', undefined, { agent: 'dev' })).body;
      assert.ok((typeof brief === 'string' ? brief : brief.markdown).includes(project.split(path.sep).join('/')), 'the brief names the project folder');
      // a standing agent works in the project, not in the board's folder
      const it = await s.ok('POST', '/api/boards/main/items', { title: 'work', column: 'Ready', assignee: 'dev' }, USER);
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(path.join(project, `work-${it.id}.txt`)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      assert.ok(fs.existsSync(path.join(project, `work-${it.id}.txt`)), 'the agent ran in the project');
      assert.ok(!fs.existsSync(path.join(s.dir, `work-${it.id}.txt`)));
      // from the project, the CLI finds the board through a link
      assert.equal(cli(['do', 'get_my_work'], { cwd: project, env: { INTELLAGENT_AGENT: 'dev' } }).code, 3, 'not found before linking');
      assert.equal(cli(['link', s.dir], { cwd: project }).code, 0);
      const w = cli(['do', 'get_my_work'], { cwd: project, env: { INTELLAGENT_AGENT: 'dev' } });
      assert.equal(w.code, 0, w.err);
      assert.ok(fs.readFileSync(path.join(project, '.intellagent', '.gitignore'), 'utf8').includes('link.json'));
    } finally { await s.stop(); }
  });
});

describe('Ask an agent keeps the conversation', () => {
  it('a follow-up request carries the earlier messages with that agent, oldest first', async () => {
    const s = await startServer({ agents: { agents: {} } });
    try {
      const r1 = await s.ok('POST', '/api/boards/main/requests', { body: 'What does INT-3 do?', to: 'desk' }, USER);
      await s.ok('POST', `/api/boards/main/requests/${r1.id}/reply`, { body: 'It adds search.' }, { agent: 'desk' });
      await s.ok('POST', '/api/boards/main/requests', { body: 'unrelated', to: 'someone-else' }, USER);
      const { seq } = await s.ok('GET', '/api/app');
      await s.ok('POST', '/api/boards/main/requests', { body: 'And who reviewed it?', to: 'desk' }, USER);
      const ev = (await s.ok('GET', `/api/events?since=${seq}&types=request.created`)).events.at(-1);
      assert.deepEqual(ev.request.history.map((m) => `${m.from}: ${m.body}`), ['James: What does INT-3 do?', 'desk: It adds search.']);
      const line = require('../lib/agents').eventLine(ev);
      assert.match(line, /conversation so far[\s\S]*What does INT-3 do\?[\s\S]*It adds search\.[\s\S]*And who reviewed it\?/);
    } finally { await s.stop(); }
  });
});

describe('sandbox boards', () => {
  // A restart kills the server behind fetch's pooled keep-alive connection; the first request after it can
  // hit a dead socket (one per earlier request), so retry a few times.
  const get = async (url) => { const go = () => fetch(url, { headers: { 'x-agent': 'tester' } }).then((r) => r.json()); for (let i = 0; ; i++) { try { return await go(); } catch (e) { if (i >= 3) throw e; } } };
  it('standing agents never run on a sandbox board', async () => {
    const fake = path.join(__dirname, 'fake-agent.js');
    const s = await startServer({ manifest: { sandbox: true }, agents: { agents: { dev: { run: `node "${fake}" commit`, worktree: false } } } });
    try {
      const it = await s.ok('POST', '/api/boards/main/items', { title: 'work', column: 'Ready', assignee: 'dev' }, USER);
      const agent = await until(async () => (await s.ok('GET', '/api/agents')).agents.find((a) => a.name === 'dev' && a.status === 'paused'));
      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(!fs.existsSync(path.join(s.dir, `work-${it.id}.txt`)), 'the agent did not run');
      // and nothing lands from a sandbox: it has no worktrees, so its human can't put commits on a real main
      const land = await s.api('POST', `/api/boards/main/items/${it.id}/land`, { agent: 'dev' }, USER);
      assert.equal(land.status, 400);
      assert.match(JSON.stringify(land.body), /No worktrees/);
    } finally { await s.stop(); }
  });

  it('intellagent sandbox starts a board of its own from a snapshot, keeps it across restarts, and stops it', async () => {
    const s = await startServer({ agents: { agents: {} } });
    try {
      const it = await s.ok('POST', '/api/boards/main/items', { title: 'copied over', column: 'Ready' }, USER);
      const r = cli(['sandbox', 'tester', '--seed', 'snapshot', '--json'], { cwd: s.dir });
      assert.equal(r.code, 0, r.err);
      assert.notEqual(r.json.url, s.base);
      const got = await get(`${r.json.url}/api/boards/main/items/${it.id}`);
      assert.equal(got.title, 'copied over');
      // writes land in the sandbox, never on the real board
      await fetch(`${r.json.url}/api/boards/main/items`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent': 'tester' }, body: JSON.stringify({ title: 'sandbox only', column: 'Ready' }) });
      assert.ok(!JSON.stringify(await s.ok('GET', '/api/boards/main/summary')).includes('sandbox only'));
      // a restart keeps its data and port
      const again = cli(['sandbox', 'tester', '--json'], { cwd: s.dir });
      assert.equal(again.json.port, r.json.port);
      assert.equal(again.json.seed, 'kept');
      assert.ok(JSON.stringify(await get(`${r.json.url}/api/boards/main/summary`)).includes('sandbox only'));
      assert.equal(fs.readFileSync(path.join(s.dir, 'sandboxes', '.gitignore'), 'utf8').trim(), '*');
      assert.match(cli(['sandbox', 'stop', 'tester'], { cwd: s.dir }).out, /stopped/);
    } finally { cli(['sandbox', 'stop', '--all'], { cwd: s.dir }); await s.stop(); }
  });
});
