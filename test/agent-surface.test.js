// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
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
const { startServer, freePort, until, USER, cleanEnv } = require('./helpers');
const { measure } = require('../scripts/measure-mcp');
const { makeTools } = require('../lib/tools');

const ROOT = path.join(__dirname, '..');
const CORE_BUDGET = 5000; // chars of tools/list JSON for the core profile
const CORE = ['get_briefing', 'get_my_work', 'get_item', 'start_work', 'set_status', 'add_comment', 'ask_human', 'request_review', 'wait_for_events', 'finish_session'];

// One MCP session: send requests, collect replies by id.
function mcp(env) {
  const p = spawn(process.execPath, [path.join(ROOT, 'mcp.js')], { env: cleanEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
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
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'intellagent.js'), ...args], { cwd, env: cleanEnv(env), encoding: 'utf8', input: '', timeout: 60000 });
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
  it('help <command> prints that command\'s usage; an unknown word lists commands and operations', () => {
    const h = cli(['help', 'init']);
    assert.equal(h.code, 0);
    assert.match(h.out, /--template --name --prefix --port/);
    assert.match(h.out, /--open-agents/);
    assert.doesNotMatch(h.out, /templates {8}list board templates/, 'only init\'s own lines');
    assert.match(cli(['help', 'agents']).out, /add NAME .*--role/);
    const bad = cli(['help', 'make_coffee']);
    assert.match(bad.err, /No command or operation matches "make_coffee"\. Commands: .*init.*Operations: get_briefing/);
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
  it('commands that act as the human refuse to run as an agent', () => {
    for (const [args, env] of [[['merge', 'T-1'], { INTELLAGENT_AGENT: 'sneaky' }], [['agents', 'pause', 'x'], { INTELLAGENT_RUN: 'run_1' }],
      [['agents', 'add', 'evil', '--role', 'builder'], { INTELLAGENT_AGENT: 'sneaky' }], [['token', '--rotate'], { INTELLAGENT_AGENT: 'sneaky' }],
      [['merge', 'T-1', '--as', 'sneaky'], {}], [['stop'], { INTELLAGENT_AGENT: 'sneaky' }], [['open'], { INTELLAGENT_AGENT: 'sneaky' }],
      [['start', '--open'], { INTELLAGENT_AGENT: 'sneaky' }]]) {
      const r = cli(args, { cwd: s.dir, env });
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err, /HUMAN_ONLY/, args.join(' '));
    }
    assert.ok(!fs.readFileSync(path.join(s.dir, 'agents.json'), 'utf8').includes('evil'), 'nothing written');
  });
  it('start --open as an agent refuses before anything boots', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-stopped-'));
    const port = await freePort();
    fs.writeFileSync(path.join(dir, 'intellagent.manifest.json'), JSON.stringify({ port, dataDir: './data', seed: 'empty' }));
    for (const args of [['start', '--open'], ['start', '--background', '--open']]) {
      const r = cli(args, { cwd: dir, env: { INTELLAGENT_AGENT: 'sneaky' } });
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err, /HUMAN_ONLY/);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'data')), 'no board was started: no data folder');
    assert.equal(await fetch(`http://127.0.0.1:${port}/api/app`).then(() => 'up', () => 'down'), 'down');
  });
  it('--url and --as reach a board from anywhere, for shells that may only run "intellagent …"', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-nowhere-'));
    const r = cli(['do', 'create_item', 'title=by flag', 'column=Backlog', '--url', s.base, '--as', 'flagged'], { cwd: elsewhere });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.author.name, 'flagged');
    assert.equal(cli(['api', 'GET', '/api/profiles/me', `--url=${s.base}`, '--as=flagged'], { cwd: elsewhere }).json.name, 'flagged');
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
  it('init --no-start names the port in its Next line, and says when it is the default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-init-'));
    const a = cli(['init', '--name', 'Port A', '--no-start', '--no-open', '--no-mcp', '--no-claude'], { cwd: dir });
    assert.match(a.out, /Next: {2}intellagent start --open {3}\(port \d+, the first free one from 7420\)/);
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-init-'));
    const b = cli(['init', '--name', 'Port B', '--port', '7437', '--no-start', '--no-open', '--no-mcp', '--no-claude'], { cwd: dir2 });
    assert.match(b.out, /\(port 7437\)/);
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
  it('intellagent status lists the boards of a board that requires tokens', async () => {
    const s = await startServer({ manifest: { auth: { requireAgentTokens: true } }, agents: { agents: {} } });
    try {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'intellagent.js'), 'status'], { cwd: s.dir, env: { ...process.env, INTELLAGENT_URL: '' }, encoding: 'utf8', input: '', timeout: 60000 });
      assert.match(r.stdout, /board\s+main · \d+ items/);
      assert.doesNotMatch(r.stdout + r.stderr, /not iterable/);
    } finally { await s.stop(); }
  });
  it('an agent with a role and a token is not asked to introduce itself over MCP; a wrong token gets a code and a hint', async () => {
    const s = await startServer({ manifest: { auth: { requireAgentTokens: true } }, agents: { agents: {} } });
    const env = { INTELLAGENT_MANIFEST: path.join(s.dir, 'intellagent.manifest.json'), INTELLAGENT_URL: s.base, INTELLAGENT_AGENT: 'vera' };
    try {
      assert.equal(cli(['token', '--agent', 'vera'], { cwd: s.dir }).code, 0);
      const set = cli(['api', 'PATCH', '/api/profiles/me', 'role=builder'], { cwd: s.dir, env: { INTELLAGENT_AGENT: 'vera' } });
      assert.equal(set.code, 0, set.err);
      const c = mcp(env);
      try {
        const init = await c.call('initialize', { clientInfo: { name: 'test' } });
        assert.doesNotMatch(init.result.instructions, /not introduced yourself/);
        const names = (await c.call('tools/list', {})).result.tools.map((t) => t.name);
        assert.equal(names.length, CORE.length, 'ten tools, no introduce_yourself');
      } finally { c.close(); }
      const wrong = await fetch(`${s.base}/api/profiles/me`, { headers: { 'X-Agent': 'vera', Authorization: 'Bearer nope' } });
      const body = await wrong.json();
      assert.equal(wrong.status, 401);
      assert.equal(body.code, 'UNAUTHORIZED');
      assert.ok(body.hint, 'a wrong token comes with a hint');
    } finally { await s.stop(); }
  });
  it('an empty INTELLAGENT_TOKEN (a standing run with no token) is no token: the CLI and MCP fall back to local.json', async () => {
    const s = await startServer({ manifest: { auth: { requireAgentTokens: true } }, agents: { agents: {} } });
    const empty = { INTELLAGENT_TOKEN: '' };
    try {
      assert.equal(cli(['token', '--agent', 'vera'], { cwd: s.dir }).code, 0);
      const ok = cli(['api', 'GET', '/api/profiles/me'], { cwd: s.dir, env: { ...empty, INTELLAGENT_AGENT: 'vera' } });
      assert.equal(ok.code, 0, `CLI: ${ok.err}`);
      const c = mcp({ ...empty, INTELLAGENT_MANIFEST: path.join(s.dir, 'intellagent.manifest.json'), INTELLAGENT_URL: s.base, INTELLAGENT_AGENT: 'vera' });
      try {
        const r = await c.call('tools/call', { name: 'get_my_work', arguments: {} });
        assert.ok(!r.result?.isError, `MCP: ${r.result?.content?.[0]?.text || r.error?.message}`);
      } finally { c.close(); }
      // with nothing to fall back to, nothing is sent: "has no token", not a wrong (empty) one
      const none = cli(['api', 'GET', '/api/profiles/me'], { cwd: s.dir, env: { ...empty, INTELLAGENT_AGENT: 'nobody' } });
      assert.equal(none.code, 1);
      assert.match(none.err, /error 401 UNAUTHORIZED: Agent "nobody" has no token on this board/);
    } finally { await s.stop(); }
  });
  it('intellagent help focus explains focus boards and the calls an agent may make, and the brief points at it', async () => {
    const s = await startServer({ agents: { agents: {} } });
    try {
      const h = cli(['help', 'focus'], { cwd: s.dir });
      assert.equal(h.code, 0, h.err);
      assert.match(h.out, /focus boards/i);
      assert.match(h.out, /api GET \/api\/boards\/main\/focus\b/, 'list');
      assert.match(h.out, /api GET \/api\/boards\/main\/focus\/<id>/, 'read');
      assert.match(h.out, /OUT_OF_FOCUS/);
      assert.match(h.out, /HUMAN_ONLY/, 'creating one is the human\'s');
      assert.doesNotMatch(h.out + h.err, /No command or operation matches/);
      const brief = cli(['brief', '--agent', 'ada'], { cwd: s.dir, env: { INTELLAGENT_AGENT: 'ada' } });
      assert.match(brief.out, /intellagent help focus/);
      // what the help promises is what the board does: an agent cannot make one
      const made = cli(['api', 'POST', '/api/boards/main/focus', 'name=x'], { cwd: s.dir, env: { INTELLAGENT_AGENT: 'ada' } });
      assert.equal(made.code, 1);
      assert.match(made.err, /HUMAN_ONLY/);
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
  it('a local.json saved with a BOM still guards the human, and issuing agent tokens keeps the user token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-bom-'));
    const local = path.join(dir, 'local.json');
    fs.writeFileSync(local, `﻿${JSON.stringify({ userToken: 'bom-secret' })}`); // as PowerShell 5 Set-Content -Encoding UTF8 writes it
    const s = await startServer({ dir, manifest: { auth: { requireAgentTokens: true } }, agents: { agents: {} } });
    try {
      const anon = await fetch(`${s.base}/api/boards/main/work`, { headers: { 'X-User': 'James' } });
      assert.equal(anon.status, 401, 'X-User without the token is refused');
      const signed = await fetch(`${s.base}/api/boards/main/work`, { headers: { 'X-User': 'James', Authorization: 'Bearer bom-secret' } });
      assert.equal(signed.status, 200);
      // the board issues one for a new standing agent; the CLI issues one by hand
      fs.writeFileSync(path.join(s.dir, 'agents.json'), JSON.stringify({ agents: { late: { enabled: false, perms: ['read'] } } }));
      await until(() => JSON.parse(fs.readFileSync(local, 'utf8').replace(/^﻿/, '')).agentTokens?.late, 10000, 'late gets a token');
      assert.equal(cli(['token', '--agent', 'pat'], { cwd: s.dir }).code, 0);
      const after = JSON.parse(fs.readFileSync(local, 'utf8'));
      assert.equal(after.userToken, 'bom-secret', 'the user token survives');
      assert.ok(after.agentTokens.late && after.agentTokens.pat);
    } finally { await s.stop(); }
  });
  it('a local.json that does not parse stops the board, naming the file, and the CLI will not write over it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-badlocal-'));
    const local = path.join(dir, 'local.json');
    fs.writeFileSync(local, '{ "userToken": "half');
    await assert.rejects(startServer({ dir }), (e) => /will not start: .*local\.json is not valid JSON/.test(e.message));
    const r = cli(['token', '--agent', 'pat'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.err, /local\.json is not valid JSON/);
    assert.equal(fs.readFileSync(local, 'utf8'), '{ "userToken": "half', 'left as it was');
  });
});

describe('the git hook', () => {
  it('links a commit to its ticket on a board that requires agent tokens, posting as the default agent', async () => {
    const { execFileSync } = require('child_process');
    const s = await startServer({ manifest: { idPrefix: 'HK', defaultAgent: 'vera', auth: { requireAgentTokens: true } }, agents: { agents: {} } });
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-hook-'));
    const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    try {
      assert.equal(cli(['token', '--agent', 'vera'], { cwd: s.dir }).code, 0);
      const it = await s.ok('POST', '/api/boards/main/items', { title: 'linked', column: 'Ready' }, USER);
      git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@e.com'); git('config', 'user.name', 'T');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
      git('add', '.'); git('commit', '-q', '-m', `Fix the thing (${it.id})`);
      const r = spawnSync(process.execPath, [path.join(ROOT, 'git-hook.js'), 'post-commit'], {
        cwd: repo, encoding: 'utf8', timeout: 20000,
        env: cleanEnv({ INTELLAGENT_MANIFEST: path.join(s.dir, 'intellagent.manifest.json'), INTELLAGENT_URL: s.base }),
      });
      assert.match(r.stdout, new RegExp(`linked [0-9a-f]{7} → ${it.id}`), r.stdout + r.stderr);
      const item = await s.ok('GET', `/api/boards/main/items/${it.id}`, undefined, USER);
      assert.ok(item.comments.some((c) => /\*\*Commit\*\*/.test(c.body)), 'the commit is a comment on the ticket');
    } finally { await s.stop(); }
  });
});

describe('waiting from the CLI', () => {
  it('wait marks a comment seen (👀) on a board that requires agent tokens', async () => {
    const s = await startServer({ manifest: { auth: { requireAgentTokens: true } }, agents: { agents: {} } });
    try {
      assert.equal(cli(['token', '--agent', 'pat'], { cwd: s.dir }).code, 0);
      const env = { INTELLAGENT_AGENT: 'pat' };
      const it = await s.ok('POST', '/api/boards/main/items', { title: 'look', column: 'Ready' }, USER);
      // pat acts first, so wait starts from there; then the human @mentions pat
      assert.equal(cli(['do', 'add_comment', `id=${it.id}`, 'body=on it'], { cwd: s.dir, env }).code, 0);
      const c = await s.ok('POST', `/api/boards/main/items/${it.id}/comments`, { body: '@pat what is the plan?' }, USER);
      const w = cli(['wait', '--timeout', '30'], { cwd: s.dir, env });
      assert.equal(w.code, 0, w.err || w.out);
      const item = await s.ok('GET', `/api/boards/main/items/${it.id}`, undefined, USER);
      const mine = item.comments.find((x) => x.id === (c.comment?.id || c.id));
      assert.ok(mine?.reactions?.['👀']?.includes('pat'), 'pat marked the comment seen');
    } finally { await s.stop(); }
  });
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
      const w = cli(['wait', '--timeout', '30'], { cwd: away, env });
      assert.equal(w.code, 0, w.err || w.out);
      assert.match(w.out, /attention\.resolved.*Okta/);
    } finally { await s.stop(); }
  });
});

describe('watching from the CLI', () => {
  it('watch --once runs with only INTELLAGENT_URL and names the event\'s board in its prompt', async () => {
    const s = await startServer({ agents: { agents: {} } });
    const away = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-away-')); // no board folder here
    try {
      const env = { INTELLAGENT_URL: s.base, INTELLAGENT_AGENT: 'watcher' };
      const it = await s.ok('POST', '/api/boards/main/items', { title: 'watched', column: 'Ready' }, USER);
      assert.equal(cli(['do', 'add_comment', `id=${it.id}`, 'body=on it'], { cwd: away, env }).code, 0);
      await s.ok('POST', `/api/boards/main/items/${it.id}/comments`, { body: '@watcher please look' }, USER);
      const w = cli(['watch', '--once', '--', 'node', '-e', 'process.stdin.pipe(process.stdout)'], { cwd: away, env });
      assert.equal(w.code, 0, w.err || w.out);
      assert.match(w.out, /the board is main/);
      assert.match(w.out, /intellagent api GET \/api\/boards\/<board>\/items\/<ID>/);
      assert.ok(!/path\" argument/.test(w.err), w.err);
    } finally { await s.stop(); }
  });
});

describe('the brief of a sandbox board', () => {
  it('names the folder the board was set up in as the project, and the code it runs apart', async () => {
    const code = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-code-'));
    const s = await startServer({ manifest: { sandbox: true, projectRoot: code } });
    try {
      const slash = (p) => p.split(path.sep).join('/');
      const projectLine = async () => {
        const brief = (await s.api('GET', '/api/boards/main/brief', undefined, { agent: 'dev' })).body;
        const text = typeof brief === 'string' ? brief : brief.markdown;
        return text.split('\n').find((l) => l.startsWith('Project'));
      };
      let line = await projectLine();
      assert.ok(line.includes(`\`${slash(s.dir)}\``), line);
      assert.ok(line.includes(slash(code)), 'the code it runs is named too');
      assert.match(line, /sandbox: it runs the code of/);
      // a folder that happens to be called "project" is not guessed at
      fs.mkdirSync(path.join(s.dir, 'project'));
      line = await projectLine();
      assert.ok(!line.includes(`${slash(s.dir)}/project`), line);
    } finally { await s.stop(); }
  });
});

describe('the brief of an empty-seeded board', () => {
  it('lists the starter ticket templates and says they can be edited', async () => {
    const s = await startServer();
    try {
      const brief = (await s.api('GET', '/api/boards/main/brief', undefined, { agent: 'dev' })).body;
      const text = typeof brief === 'string' ? brief : brief.markdown;
      assert.match(text, /## Ticket templates \(prefer these when creating; a new board starts with some: edit them or add more/);
      for (const key of ['bug', 'feature', 'question']) assert.match(text, new RegExp(`- \`${key}\``));
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
      // named for whoever runs it, even though its board was copied from the real one
      assert.equal((await get(`${r.json.url}/api/boards/main`)).board.name, "Tester's Board");
      assert.equal((await get(`${r.json.url}/api/app`)).name, "Tester's Board");
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

  it('a sandbox starts from the board init set up: its fields, rules and columns, no tickets, and says which board', async () => {
    const s = await startServer({ agents: { agents: {} } });
    try {
      await s.ok('POST', '/api/boards/main/schema/fields', { key: 'area', label: 'Area', type: 'text' }, USER);
      await s.ok('PUT', '/api/boards/main/directives', { directives: 'Always say hello.' }, USER);
      await s.ok('POST', '/api/boards/main/items', { title: 'real work', column: 'Ready' }, USER);
      const r = cli(['sandbox', 'shape', '--json'], { cwd: s.dir });
      assert.equal(r.code, 0, r.err);
      assert.equal(r.json.seed, 'board');
      assert.ok(r.json.from, 'names the board it started from');
      const schema = await get(`${r.json.url}/api/boards/main/schema`);
      assert.ok(JSON.stringify(schema).includes('"area"'));
      assert.match(JSON.stringify(await get(`${r.json.url}/api/boards/main/directives`)), /Always say hello/);
      const sum = JSON.stringify(await get(`${r.json.url}/api/boards/main/summary`));
      assert.ok(!sum.includes('real work'));
      assert.match(cli(['sandbox', 'shape', '--fresh'], { cwd: s.dir }).out, /from the board/);
    } finally { cli(['sandbox', 'stop', '--all'], { cwd: s.dir }); await s.stop(); }
  });

  describe('sandbox exec', () => {
    // async, so a stub board in this process can answer while the CLI runs
    const cliAsync = (args, { cwd, env = {} } = {}) => new Promise((resolve) => {
      const p = require('child_process').spawn(process.execPath, [path.join(ROOT, 'bin', 'intellagent.js'), ...args], { cwd, env: cleanEnv(env) });
      let out = ''; let err = '';
      p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
      p.stdin.end();
      p.on('close', (code) => resolve({ code, out, err }));
    });
    const stubBoard = (me) => new Promise((resolve) => {
      const srv = require('http').createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url === '/api/permissions/me' ? me : {})); });
      srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
    });

    it('runs the sandbox code on the sandbox board only, refuses what could leave it, and passes the exit code on', async () => {
      const s = await startServer({ agents: { agents: {} } });
      try {
        const r = cli(['sandbox', 'tester', '--seed', 'empty', '--from', ROOT, '--json'], { cwd: s.dir });
        assert.equal(r.code, 0, r.err);
        // the caller's own board and token are in its environment; exec must not pass them on
        const real = { INTELLAGENT_URL: s.base, INTELLAGENT_TOKEN: 'real-board-token' };
        const app = cli(['sandbox', 'exec', 'tester', '--', 'api', 'GET', '/api/app'], { cwd: s.dir, env: real });
        assert.equal(app.code, 0, app.err);
        assert.equal(app.json.name, "Tester's Board");
        // an item written through exec lands in the sandbox, not on the real board
        const made = cli(['sandbox', 'exec', 'tester', '--', 'api', 'POST', '/api/boards/main/items', 'title=via exec', 'column=Backlog'], { cwd: s.dir, env: real });
        assert.equal(made.code, 0, made.err);
        assert.ok(!JSON.stringify(await s.ok('GET', '/api/boards/main/summary')).includes('via exec'));
        assert.ok(JSON.stringify(await get(`${r.json.url}/api/boards/main/summary`)).includes('via exec'));
        // its own commands run, as the sandbox's human
        assert.equal(cli(['sandbox', 'exec', 'tester', '--', 'status'], { cwd: s.dir, env: { INTELLAGENT_AGENT: '' } }).code, 0);
        // another board, or something outside the sandbox: refused with a code and a hint
        for (const bad of [['brief', '--url', s.base], ['brief', `--url=${s.base}`], ['brief', '--as', 'claude'], ['start'], ['stop'], ['merge', 'INT-1'], ['token'], ['sandbox', 'stop', 'tester'], ['leases', 'ceiling', '--cpu', '1'], ['init', path.join(ROOT, 'not-in-the-temp-folder')]]) {
          const x = cli(['sandbox', 'exec', 'tester', '--', ...bad], { cwd: s.dir, env: real });
          assert.equal(x.code, 1, bad.join(' '));
          assert.match(x.err, /error 403 FORBIDDEN: .* — hint: /, bad.join(' '));
        }
        // the exit code of the command comes back unchanged
        const nope = cli(['sandbox', 'exec', 'tester', '--', 'api', 'GET', '/api/nothing-here'], { cwd: s.dir });
        assert.notEqual(nope.code, 0);
        // no command, no sandbox, a sandbox that is not running
        assert.match(cli(['sandbox', 'exec', 'tester'], { cwd: s.dir }).err, /error 400 BAD_REQUEST: .*after --.* — hint: /);
        assert.match(cli(['sandbox', 'exec', 'ghost', '--', 'brief'], { cwd: s.dir }).err, /error 404 NOT_FOUND: There is no sandbox called ghost — hint: /);
        cli(['sandbox', 'stop', 'tester'], { cwd: s.dir });
        assert.match(cli(['sandbox', 'exec', 'tester', '--', 'brief'], { cwd: s.dir }).err, /error 404 NOT_FOUND: tester's sandbox is not running — hint: intellagent sandbox tester/);
      } finally { cli(['sandbox', 'stop', '--all'], { cwd: s.dir }); await s.stop(); }
    });

    it('an agent needs "run an author\'s code": the board says no, or does not say, and exec is refused with the board\'s own reason', async () => {
      const s = await startServer({ agents: { agents: {} } });
      const no = await stubBoard({ runAuthorsCode: false, runAuthorsCodeWhy: 'builder does not hold "Run an author\'s code"', runAuthorsCodeHint: 'ask James on the card' });
      const yes = await stubBoard({ runAuthorsCode: true });
      try {
        assert.equal(cli(['sandbox', 'tester', '--seed', 'empty', '--from', ROOT, '--json'], { cwd: s.dir }).code, 0);
        const run = (url) => cliAsync(['sandbox', 'exec', 'tester', '--', 'api', 'GET', '/api/app'], { cwd: s.dir, env: { INTELLAGENT_AGENT: 'builder', INTELLAGENT_URL: url } });
        const denied = await run(no.url);
        assert.equal(denied.code, 1);
        assert.match(denied.err, /error 403 NO_PERMISSION: builder does not hold "Run an author's code" — hint: ask James on the card/);
        assert.ok(!denied.out.includes("Tester's Board"), 'nothing ran');
        // a board that does not report the field (older code) counts as no
        const silent = await stubBoard({});
        const unknown = await run(silent.url);
        silent.srv.close();
        assert.equal(unknown.code, 1);
        assert.match(unknown.err, /error 403 NO_PERMISSION: .* — hint: /);
        const allowed = await run(yes.url);
        assert.equal(allowed.code, 0, allowed.err);
        assert.match(allowed.out, /Tester's Board/);
      } finally { no.srv.close(); yes.srv.close(); cli(['sandbox', 'stop', '--all'], { cwd: s.dir }); await s.stop(); }
    });

    it('end to end: the real board decides from the agent\'s role, a reviewer runs the command and a builder is refused', async () => {
      const s = await startServer({ manifest: { auth: { requireAgentTokens: false } }, agents: { agents: { rv: { enabled: false, role: 'reviewer' }, bd: { enabled: false, role: 'builder' } } } });
      try {
        assert.equal(cli(['sandbox', 'tester', '--seed', 'empty', '--from', ROOT, '--json'], { cwd: s.dir }).code, 0);
        const as = (agent) => cliAsync(['sandbox', 'exec', 'tester', '--', 'api', 'GET', '/api/app'], { cwd: s.dir, env: { INTELLAGENT_AGENT: agent } });
        const rv = await as('rv');
        assert.equal(rv.code, 0, rv.err);
        assert.equal(JSON.parse(rv.out).name, "Tester's Board");
        const bd = await as('bd');
        assert.equal(bd.code, 1);
        assert.match(bd.err, /error 403 NO_PERMISSION: .*run-authors-code.* — hint: /);
        assert.equal(bd.out, '', 'nothing ran');
      } finally { cli(['sandbox', 'stop', '--all'], { cwd: s.dir }); await s.stop(); }
    });
  });
});

describe('agents alert each other with @mentions', () => {
  it('the brief says so, and naming an agent without @ comes back with a warning', async () => {
    const s = await startServer({ agents: { agents: { rocket: { role: 'builder', enabled: false }, 'star-lord': { role: 'builder', enabled: false } } } });
    try {
      const brief = (await s.api('GET', '/api/boards/main/brief', undefined, { agent: 'gamora' })).body;
      assert.match(typeof brief === 'string' ? brief : brief.markdown, /## Alerting other agents[\s\S]*@mention/);
      const it = await s.ok('POST', '/api/boards/main/items', { title: 'route me', column: 'Ready' }, USER);
      const say = (body) => s.ok('POST', `/api/boards/main/items/${it.id}/comments`, { body }, { agent: 'gamora' });
      const bare = await say('Rocket. It touches the wake loop, so star-lord can wait.');
      assert.match(bare.warning, /rocket, star-lord without @/);
      assert.equal((await say('@rocket, it is yours.')).warning, undefined, 'an @mention alerts');
      assert.equal((await say('`rocket` is in the code; > nothing\n> Rocket said so')).warning, undefined, 'code and quotes do not count');
      assert.equal((await s.ok('POST', `/api/boards/main/items/${it.id}/comments`, { body: 'Rocket, look' }, USER)).warning, undefined, 'only agents are warned');
      assert.equal((await s.ok('POST', `/api/boards/main/items/${it.id}/comments`, { body: 'rocket here, done' }, { agent: 'rocket' })).warning, undefined, 'not about yourself');
      const saved = (await s.ok('GET', `/api/boards/main/items/${it.id}`)).comments;
      assert.ok(saved.every((c) => !('warning' in c)), 'the warning is never stored');
    } finally { await s.stop(); }
  });
});

describe('reviews carry evidence, and the human can preview the work', () => {
  it('a review without evidence warns; evidence shows on the review', async () => {
    const s = await startServer({ agents: { agents: {} } });
    try {
      const mk = async () => { const it = await s.ok('POST', '/api/boards/main/items', { title: 'x', column: 'Ready' }, USER); await s.ok('POST', `/api/boards/main/items/${it.id}/start`, {}, { agent: 'dev' }); return it; };
      const a = await mk();
      const bare = await s.ok('POST', `/api/boards/main/items/${a.id}/review`, { changed: 'c', why: 'w', verify: 'v' }, { agent: 'dev' });
      assert.ok(bare.warnings?.some((w) => /^No evidence/.test(w)));
      const b = await mk();
      const ok = await s.ok('POST', `/api/boards/main/items/${b.id}/review`, { changed: 'c', why: 'w', verify: 'v', evidence: 'npm test: 12 pass; shot.png attached' }, { agent: 'dev' });
      assert.ok(!(ok.warnings || []).some((w) => /evidence/i.test(w)));
      const got = await s.ok('GET', `/api/boards/main/items/${b.id}`);
      assert.equal(got.questions.find((q) => q.kind === 'review').notes.evidence, 'npm test: 12 pass; shot.png attached');
      // not an Intellagent checkout: no preview, and only the human may ask
      assert.equal((await s.ok('GET', '/api/app')).preview, false);
      assert.equal((await s.api('POST', `/api/boards/main/items/${b.id}/preview`, {}, { agent: 'dev' })).status, 403);
      assert.equal((await s.api('POST', `/api/boards/main/items/${b.id}/preview`, {}, USER)).body.code, 'NO_PREVIEW');
    } finally { await s.stop(); }
  });

  it('on a board whose code is Intellagent, Preview runs the work on a temporary board with the tickets', async () => {
    const s = await startServer({ manifest: { projectRoot: ROOT }, agents: { agents: {} } });
    try {
      assert.equal((await s.ok('GET', '/api/app')).preview, true);
      const it = await s.ok('POST', '/api/boards/main/items', { title: 'see me in the preview', column: 'Ready' }, USER);
      const r = await s.ok('POST', `/api/boards/main/items/${it.id}/preview`, {}, USER);
      assert.equal(r.from, 'main', 'no author worktree: main');
      assert.match(r.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=/);
      const base = r.url.split('/#')[0];
      assert.notEqual(base, s.base);
      const copy = await fetch(`${base}/api/boards/main/items/${it.id}`, { headers: { 'x-agent': 'look' } }).then((x) => x.json());
      assert.equal(copy.title, 'see me in the preview');
    } finally { await require('../lib/sandbox').stop(path.join(s.dir, 'intellagent.manifest.json'), 'preview'); await s.stop(); }
  });
});

describe('delegated approval on a reviewer\'s ok', () => {
  it('Gamora approves only where Nebula said ok, and never over anyone\'s concerns', async () => {
    const s = await startServer({ agents: { agents: {
      gamora: { role: 'coordinator', enabled: false, grants: [{ power: 'review.decide', where: { 'reviewers.nebula': 'ok' } }, { power: 'review.decide', where: { 'reviewers.drax': 'ok' } }] },
      drax: { role: 'builder', enabled: false, reviewer: true },
      nebula: { role: 'reviewer', enabled: false },
      rocket: { role: 'builder', enabled: false, reviewer: true },
    } }, manifest: { auth: { agentTokens: { nebula: 't-nebula', drax: 't-drax', rocket: 't-rocket' } } } });
    try {
      const inReview = async (title) => {
        const it = await s.ok('POST', '/api/boards/main/items', { title, column: 'Ready' }, USER);
        await s.ok('POST', `/api/boards/main/items/${it.id}/start`, {}, { agent: 'dev' });
        await s.ok('POST', `/api/boards/main/items/${it.id}/review`, { changed: 'c', why: 'w', verify: 'v', evidence: 'e' }, { agent: 'dev' });
        await s.ok('POST', `/api/boards/main/items/${it.id}/reviewers`, { name: 'nebula' }, USER);
        return it;
      };
      const decide = (id) => s.api('POST', `/api/boards/main/items/${id}/review/decision`, { verdict: 'approve', comment: 'on Nebula\'s QA' }, { agent: 'gamora' });
      // reviewers with a token here: the board checks who gave the verdict, so it may stand in for the human
      const verdict = async (id, who, v) => {
        const r = await fetch(`${s.base}/api/boards/main/items/${id}/reviewers/${who}/verdict`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent': who, authorization: `Bearer t-${who}` }, body: JSON.stringify({ verdict: v, comment: v === 'ok' ? 'Checked. It holds. @gamora' : 'not yet' }) });
        assert.ok(r.ok, `${who}'s verdict: ${r.status}`);
      };

      const work = async () => (await s.ok('GET', '/api/boards/main/work', undefined, { agent: 'gamora' })).next.filter((n) => n.action === 'decide' || n.action === 'chase');
      const a = await inReview('waiting on QA');
      assert.equal((await decide(a.id)).status, 403, 'no verdict from Nebula yet: out of scope');
      assert.deepEqual((await work()).filter((n) => n.id === a.id), [], 'Nebula was only just asked: nothing to chase yet');
      await verdict(a.id, 'nebula', 'ok');
      assert.equal((await work()).find((n) => n.id === a.id)?.action, 'decide', 'everything is in: decide');
      const ok = await decide(a.id);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal((await s.ok('GET', `/api/boards/main/items/${a.id}`)).column, 'Done', 'approved through the gate');

      const b = await inReview('one reviewer worried');
      await s.ok('POST', `/api/boards/main/items/${b.id}/reviewers`, { name: 'rocket' }, USER);
      await verdict(b.id, 'nebula', 'ok');
      await verdict(b.id, 'rocket', 'concerns');
      const no = await decide(b.id);
      assert.equal(no.status, 409);
      assert.equal(no.body.code, 'CONCERNS_OPEN');
      const ch = (await work()).find((n) => n.id === b.id);
      assert.equal(ch?.action, 'chase');
      assert.match(ch.why, /rocket's concerns resolved/);

      // no evidence in the review: never approved on the human's behalf
      const e = await s.ok('POST', '/api/boards/main/items', { title: 'no evidence', column: 'Ready' }, USER);
      await s.ok('POST', `/api/boards/main/items/${e.id}/start`, {}, { agent: 'dev' });
      await s.ok('POST', `/api/boards/main/items/${e.id}/review`, { changed: 'c', why: 'w', verify: 'v' }, { agent: 'dev' });
      await s.ok('POST', `/api/boards/main/items/${e.id}/reviewers`, { name: 'nebula' }, USER);
      await verdict(e.id, 'nebula', 'ok');
      assert.equal((await decide(e.id)).body.code, 'NO_EVIDENCE');
      assert.match((await work()).find((n) => n.id === e.id)?.why || '', /evidence from dev/);

      const c = await inReview('QA has concerns');
      await verdict(c.id, 'nebula', 'concerns');
      assert.equal((await decide(c.id)).status, 403, "Nebula's concerns are out of scope");

      // Drax's ok is enough on its own (a code-only review), and the chase names either reviewer
      const d1 = await s.ok('POST', '/api/boards/main/items', { title: 'code only', column: 'Ready' }, USER);
      await s.ok('POST', `/api/boards/main/items/${d1.id}/start`, {}, { agent: 'dev' });
      await s.ok('POST', `/api/boards/main/items/${d1.id}/review`, { changed: 'c', why: 'w', verify: 'v', evidence: 'e' }, { agent: 'dev' });
      // no reviewer yet: the coordinator's assign_reviewer comes first (one action per ticket)
      assert.equal((await s.ok('GET', '/api/boards/main/work', undefined, { agent: 'gamora' })).next.find((n) => n.id === d1.id)?.action, 'assign_reviewer');
      await s.ok('POST', `/api/boards/main/items/${d1.id}/reviewers`, { name: 'drax' }, USER);
      await verdict(d1.id, 'drax', 'ok');
      assert.equal((await decide(d1.id)).status, 200, "Drax's ok is in scope");
    } finally { await s.stop(); }
  });
});

describe('a verdict the board could not check never stands in for the human', () => {
  it("without the reviewer's token, Nebula's ok is not enough, and the chase says why with a stable wake tag", async () => {
    const s = await startServer({ agents: { agents: {
      gamora: { role: 'coordinator', enabled: false, grants: [{ power: 'review.decide', where: { 'reviewers.nebula': 'ok' } }] },
      nebula: { role: 'reviewer', enabled: false },
    } } });
    try {
      const it = await s.ok('POST', '/api/boards/main/items', { title: 'anyone could be nebula here', column: 'Ready' }, USER);
      await s.ok('POST', `/api/boards/main/items/${it.id}/start`, {}, { agent: 'dev' });
      await s.ok('POST', `/api/boards/main/items/${it.id}/review`, { changed: 'c', why: 'w', verify: 'v', evidence: 'e' }, { agent: 'dev' });
      await s.ok('POST', `/api/boards/main/items/${it.id}/reviewers`, { name: 'nebula' }, USER);
      await s.ok('POST', `/api/boards/main/items/${it.id}/reviewers/nebula/verdict`, { verdict: 'ok', comment: 'fine' }, { agent: 'nebula' });
      const d = await s.api('POST', `/api/boards/main/items/${it.id}/review/decision`, { verdict: 'approve', comment: 'x' }, { agent: 'gamora' });
      assert.equal(d.status, 403, 'an unverified ok is out of scope');
      const ch = (await s.ok('GET', '/api/boards/main/work', undefined, { agent: 'gamora' })).next.find((n) => n.id === it.id);
      assert.equal(ch?.action, 'chase');
      assert.match(ch.why, /doesn't check that reviewer's token/);
      assert.equal(ch.tag, 'unverified:nebula', 'the wake tag names the gap, not its wording');
    } finally { await s.stop(); }
  });
});

describe('a verdict records the commits it saw, looked up without blocking the board (INT-137)', () => {
  it('a later commit makes the verdict stale; the verdict and decision routes never call the sync git lookup', async () => {
    const { execFileSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-wt-'));
    const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\n.worktrees/\nintellagent.manifest.json\nagents.json\nstub.js\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    // Preloaded into the server: the sync lookup says so in the log and fails, so a route that still used it
    // would record no commits (and never match), and the log would show it
    const stub = path.join(dir, 'stub.js');
    fs.writeFileSync(stub, `const wt = require(${JSON.stringify(path.join(ROOT, 'lib', 'worktrees.js'))});
const real = wt.createWorktrees;
wt.createWorktrees = (o) => { const w = real(o); w.commitsFor = (name, id) => { console.error('SYNC commitsFor ' + name + ' ' + id); throw new Error('sync git'); }; return w; };
console.error('commitsFor stub loaded');
`);
    const s = await startServer({ dir, env: { NODE_OPTIONS: `--require "${stub.replace(/\\/g, '/')}"` }, agents: { agents: {
      gamora: { role: 'coordinator', enabled: false, grants: [{ power: 'review.decide', where: { 'reviewers.nebula': 'ok' } }] },
      nebula: { role: 'reviewer', enabled: false },
      dev: { enabled: false, worktree: true },
    } }, manifest: { auth: { agentTokens: { nebula: 't-nebula' } } } });
    const wtDev = path.join(dir, '.worktrees', 'dev');
    const commit = (n) => { fs.writeFileSync(path.join(wtDev, `f${n}.txt`), `${n}\n`); git(wtDev, 'add', '.'); git(wtDev, 'commit', '-q', '-m', `dev work ${n} (T-1)`); return git(wtDev, 'rev-parse', 'HEAD'); };
    const verdict = () => fetch(`${s.base}/api/boards/main/items/T-1/reviewers/nebula/verdict`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent': 'nebula', authorization: 'Bearer t-nebula' }, body: JSON.stringify({ verdict: 'ok', comment: 'fine' }) });
    const decide = () => s.api('POST', '/api/boards/main/items/T-1/review/decision', { verdict: 'approve', comment: 'x' }, { agent: 'gamora' });
    try {
      assert.match(s.log(), /commitsFor stub loaded/, 'the stub is in place');
      git(dir, 'worktree', 'add', '-q', wtDev, '-b', 'agent/dev', 'main');
      const it = await s.ok('POST', '/api/boards/main/items', { title: 'dev commits', column: 'Ready' }, USER);
      assert.equal(it.id, 'T-1');
      await s.ok('POST', `/api/boards/main/items/${it.id}/start`, {}, { agent: 'dev' });
      const first = commit(1);
      await s.ok('POST', `/api/boards/main/items/${it.id}/review`, { changed: 'c', why: 'w', verify: 'v', evidence: 'e' }, { agent: 'dev' });
      await s.ok('POST', `/api/boards/main/items/${it.id}/reviewers`, { name: 'nebula' }, USER);
      assert.ok((await verdict()).ok);
      const rv = () => s.ok('GET', `/api/boards/main/items/${it.id}`).then((x) => x.reviewers.find((r) => r.name === 'nebula'));
      assert.equal((await rv()).commits, first, 'the verdict records the commits it saw');
      // dev commits again: Nebula's ok no longer covers what would land
      const second = commit(2);
      const stale = await decide();
      assert.equal(stale.status, 403, `a stale ok is out of scope: ${JSON.stringify(stale.body)}`);
      // a fresh ok covers both, and the decision goes through
      assert.ok((await verdict()).ok);
      assert.equal((await rv()).commits, `${first},${second}`);
      assert.equal((await decide()).status, 200);
      assert.doesNotMatch(s.log(), /SYNC commitsFor/, 'no route above ran git synchronously');
    } finally {
      await s.stop();
      try { execFileSync('git', ['worktree', 'prune'], { cwd: dir }); } catch { /* ignore */ }
    }
  });
});

describe("the human's switch for approvals", () => {
  it('lists who approves and when; off suspends every approval grant until the human switches it back on', async () => {
    const s = await startServer({ agents: { agents: {
      gamora: { role: 'coordinator', enabled: false, grants: [{ power: 'review.decide', where: { 'reviewers.nebula': 'ok' } }] },
      nebula: { role: 'reviewer', enabled: false },
    } }, manifest: { auth: { agentTokens: { nebula: 't-nebula' } } } });
    try {
      const v = await s.ok('GET', '/api/boards/main/approvals');
      assert.equal(v.on, true);
      assert.deepEqual(v.approvers.map((a) => a.name), ['gamora']);
      assert.equal((await s.api('PUT', '/api/boards/main/approvals', { on: false }, { agent: 'gamora' })).body.code, 'HUMAN_ONLY', 'agents never flip it');
      // a ticket fully in Gamora's scope
      const it = await s.ok('POST', '/api/boards/main/items', { title: 'in scope', column: 'Ready' }, USER);
      await s.ok('POST', `/api/boards/main/items/${it.id}/start`, {}, { agent: 'dev' });
      await s.ok('POST', `/api/boards/main/items/${it.id}/review`, { changed: 'c', why: 'w', verify: 'v', evidence: 'e' }, { agent: 'dev' });
      await s.ok('POST', `/api/boards/main/items/${it.id}/reviewers`, { name: 'nebula' }, USER);
      const r = await fetch(`${s.base}/api/boards/main/items/${it.id}/reviewers/nebula/verdict`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent': 'nebula', authorization: 'Bearer t-nebula' }, body: JSON.stringify({ verdict: 'ok', comment: 'fine' }) });
      assert.ok(r.ok);
      const actions = async () => (await s.ok('GET', '/api/boards/main/work', undefined, { agent: 'gamora' })).next.filter((n) => n.id === it.id).map((n) => n.action);
      assert.deepEqual(await actions(), ['decide']);
      // the human switches approvals off
      assert.equal((await s.ok('PUT', '/api/boards/main/approvals', { on: false }, USER)).on, false);
      const d = await s.api('POST', `/api/boards/main/items/${it.id}/review/decision`, { verdict: 'approve', comment: 'x' }, { agent: 'gamora' });
      assert.equal(d.status, 403);
      assert.equal(d.body.code, 'APPROVALS_OFF');
      assert.deepEqual(await actions(), [], 'nothing wakes the approver while it is off');
      const brief = (await s.api('GET', '/api/boards/main/brief', undefined, { agent: 'gamora' })).body;
      assert.match(typeof brief === 'string' ? brief : brief.markdown, /Approvals are switched off/);
      // and back on
      await s.ok('PUT', '/api/boards/main/approvals', { on: true }, USER);
      assert.equal((await s.api('POST', `/api/boards/main/items/${it.id}/review/decision`, { verdict: 'approve', comment: 'on again' }, { agent: 'gamora' })).status, 200);
    } finally { await s.stop(); }
  });
  it('a board can start with approvals off (manifest approvalsOff)', async () => {
    const s = await startServer({ agents: { agents: { gamora: { enabled: false, grants: ['review.decide'] } } }, manifest: { approvalsOff: true, permissions: { session: { grants: ['column.gate'] } } } });
    try {
      const v = await s.ok('GET', '/api/boards/main/approvals');
      assert.equal(v.on, false);
      // everyone who can approve is listed, also a name granted only in the manifest
      assert.deepEqual(v.approvers.map((a) => [a.name, a.standing]), [['gamora', true], ['session', false]]);
      // a malformed switch is refused, never read as off
      assert.equal((await s.api('PUT', '/api/boards/main/approvals', { on: 1 }, USER)).body.code, 'BAD_REQUEST');
      assert.equal((await s.api('PUT', '/api/boards/main/approvals', {}, USER)).body.code, 'BAD_REQUEST');
      // switching off a board that already starts off says nothing
      const { seq } = await s.ok('GET', '/api/app');
      await s.ok('PUT', '/api/boards/main/approvals', { on: false }, USER);
      assert.deepEqual((await s.ok('GET', `/api/events?since=${seq}&types=board.updated`)).events, []);
    } finally { await s.stop(); }
  });
});
