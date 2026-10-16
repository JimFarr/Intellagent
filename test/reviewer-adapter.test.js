'use strict';
// bin/reviewer-adapter.js: a reviewer that is not Claude. The model is a script behind a fake OpenAI-compatible
// endpoint, the board is a real one, the code under review is a small git repository.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { startServer, cleanEnv, USER } = require('./helpers');

const ADAPTER = path.join(__dirname, '..', 'bin', 'reviewer-adapter.js');
const call = (name, args, id = `call_${Math.random().toString(36).slice(2, 8)}`) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const tools = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls });
const say = (content) => ({ role: 'assistant', content });

// A model API that answers from a script, one entry per request, and remembers what it was asked.
async function fakeModel(script, { status = 200 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
      if (status !== 200) { res.writeHead(status, { 'content-type': 'application/json' }); return res.end('{"error":"nope"}'); }
      const message = script[Math.min(requests.length - 1, script.length - 1)];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) };
}

// the code under review: two commits
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-rev-'));
  const git = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  fs.writeFileSync(path.join(dir, 'local.json'), '{"userToken":"SECRET-IN-LOCAL"}');
  git('add', '.'); git('commit', '-q', '-m', 'first commit');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\nsecond line\n');
  git('commit', '-qam', 'second commit (T-1)');
  return dir;
}

function runAdapter(env, input = 'Review T-1 and give a verdict.') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ADAPTER], { env: cleanEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err, result: (() => { try { return JSON.parse(out.trim().split('\n').pop()); } catch { return null; } })() }));
    child.stdin.end(input);
  });
}

async function setup(script, opts) {
  const model = await fakeModel(script, opts);
  const s = await startServer({ agents: { agents: { rev: { role: 'reviewer', reviewer: true, enabled: false } } } }).catch(async (e) => { await model.close(); throw e; });
  let it1;
  try {
    it1 = await s.ok('POST', '/api/boards/main/items', { title: 'Thing to review', description: '**Done when**\n- [ ] CHECKLIST-ITEM-ONE', column: 'Backlog' }, USER);
    await s.ok('POST', `/api/boards/main/items/${it1.id}/reviewers`, { name: 'rev' }, USER);
  } catch (e) { await model.close(); await s.stop(); throw e; }
  const root = repo();
  const env = (extra = {}) => ({
    INTELLAGENT_ADAPTER_URL: model.url, INTELLAGENT_ADAPTER_KEY: 'sk-the-api-key', INTELLAGENT_ADAPTER_MODEL: 'fake-1',
    INTELLAGENT_ADAPTER_ROOT: root, INTELLAGENT_ADAPTER_TEST: 'node -e "console.log(\'tests ok\')"',
    INTELLAGENT_URL: s.base, INTELLAGENT_AGENT: 'rev', ...extra,
  });
  return { model, s, it1, root, env, done: async () => { await model.close(); await s.stop(); } };
}
const toolMessages = (model, request) => model.requests[request].body.messages.filter((m) => m.role === 'tool').map((m) => m.content);

describe('the reviewer adapter', () => {
  it('reads the code, runs the tests and posts a verdict, with the five tools and no others; ends with a result line', async () => {
    const x = await setup([
      tools(call('read_file', { path: 'a.txt' }), call('git_log', {}), call('git_diff', { from: 'HEAD~1', to: 'HEAD' }), call('run_tests', {})),
      tools(call('board_call', { action: 'verdict', ticket: 'T-1', verdict: 'concerns', comment: 'the second line has no test' })),
      say('Verdict posted.'),
    ]);
    try {
      const r = await runAdapter(x.env());
      assert.equal(r.code, 0, r.err);
      const first = x.model.requests[0];
      assert.equal(first.url, '/chat/completions');
      assert.equal(first.auth, 'Bearer sk-the-api-key');
      assert.deepEqual(first.body.tools.map((t) => t.function.name), ['read_file', 'git_log', 'git_diff', 'run_tests', 'board_call'], 'the tool list is the permission surface: exactly these five');
      const prompt = first.body.messages[1].content;
      assert.match(prompt, /Review T-1/);
      assert.match(prompt, /CHECKLIST-ITEM-ONE/, 'the adapter fetched the ticket the prompt names');
      const [file, log, diff, tests] = toolMessages(x.model, 1);
      assert.equal(file, 'hello\nsecond line\n');
      assert.match(log, /second commit \(T-1\)/);
      assert.match(diff, /\+second line/);
      assert.match(tests, /exit code 0[\s\S]*tests ok/);
      const item = await x.s.ok('GET', `/api/boards/main/items/${x.it1.id}`, undefined, USER);
      const v = item.reviewers.find((y) => y.name === 'rev');
      assert.equal(v.verdict, 'concerns');
      assert.ok(item.comments.some((c) => c.body.includes('the second line has no test')));
      assert.equal(r.result.type, 'result');
      assert.equal(r.result.is_error, false);
      assert.equal(r.result.num_turns, 3);
      assert.deepEqual(r.result.usage, { input_tokens: 300, output_tokens: 30 });
      assert.deepEqual(r.result.verdicts, [{ ticket: 'T-1', verdict: 'concerns' }]);
    } finally { await x.done(); }
  });

  it('refuses in words, and runs nothing, for a path outside the folder, secrets, option-looking refs, other board calls and unknown tools', async () => {
    const x = await setup([
      tools(
        call('read_file', { path: '../outside.txt' }),
        call('read_file', { path: 'local.json' }),
        call('read_file', { path: '.git/config' }),
        call('read_file', { path: path.join(os.tmpdir(), 'anything.txt') }),
        call('git_diff', { to: '--output=pwned.txt' }),
        call('git_log', { ref: '-n5' }),
        call('board_call', { action: 'delete', ticket: 'T-1' }),
        call('board_call', { action: 'comment', ticket: '../../x', body: 'hi' }),
        call('board_call', { action: 'verdict', ticket: 'T-1', verdict: 'approve', comment: 'x' }),
        call('shell', { cmd: 'rm -rf /' }),
      ),
      say('done'),
    ]);
    try {
      fs.writeFileSync(path.join(path.dirname(x.root), 'outside.txt'), 'outside');
      const r = await runAdapter(x.env());
      assert.equal(r.code, 0, r.err);
      const results = toolMessages(x.model, 1);
      assert.equal(results.length, 10);
      results.forEach((m, i) => assert.match(m, /^REFUSED: /, `call ${i} was refused: ${m.slice(0, 80)}`));
      assert.ok(results.every((m) => !m.includes('SECRET-IN-LOCAL') && !m.includes('outside') || m.startsWith('REFUSED')), 'no secret came back');
      assert.equal(fs.existsSync(path.join(x.root, 'pwned.txt')), false, 'git ran with no option the model chose');
      const item = await x.s.ok('GET', `/api/boards/main/items/${x.it1.id}`, undefined, USER);
      assert.equal(item.comments.length, 0, 'nothing was posted to the board');
      assert.equal(item.reviewers.find((y) => y.name === 'rev').verdict, null);
      assert.equal(r.result.is_error, false);
    } finally { await x.done(); }
  });

  it('the tests and git run without the API key, the board token or any INTELLAGENT_ variable', async () => {
    const x = await setup([tools(call('run_tests', {})), say('done')]);
    try {
      const test = 'node -e "console.log(\'LEAK[\' + Object.keys(process.env).filter(k => /KEY|TOKEN|SECRET|^INTELLAGENT_/i.test(k)).join() + \']\')"';
      const r = await runAdapter(x.env({ INTELLAGENT_ADAPTER_TEST: test, INTELLAGENT_TOKEN: 'agent-token', MY_SECRET: 's' }));
      assert.equal(r.code, 0, r.err);
      assert.match(toolMessages(x.model, 1)[0], /LEAK\[\]/);
    } finally { await x.done(); }
  });

  it('what goes wrong has a code and a hint: no configuration, a failing model API, a model that never finishes', async () => {
    const none = await runAdapter({ INTELLAGENT_AGENT: 'rev' });
    assert.equal(none.code, 2);
    assert.match(none.err, /error 400 BAD_REQUEST: INTELLAGENT_ADAPTER_URL, INTELLAGENT_ADAPTER_KEY, INTELLAGENT_ADAPTER_MODEL not set — hint: .*never in agents\.json/);

    const bad = await setup([say('x')], { status: 500 });
    try {
      const r = await runAdapter(bad.env());
      assert.equal(r.code, 1);
      assert.match(r.err, /error 502 BAD_GATEWAY: the model API answered 500.* — hint: check/);
    } finally { await bad.done(); }

    const loop = await setup([tools(call('run_tests', {}))]);
    try {
      const r = await runAdapter(loop.env({ INTELLAGENT_ADAPTER_TURNS: '2' }));
      assert.equal(r.code, 1, 'a reviewer that never answers fails the run, so the board retries it');
      assert.equal(r.result.subtype, 'error_max_turns');
      assert.equal(r.result.is_error, true);
      assert.equal(loop.model.requests.length, 2);
    } finally { await loop.done(); }
  });
});
