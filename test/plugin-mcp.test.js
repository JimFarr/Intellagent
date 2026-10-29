'use strict';
// The plugin authoring MCP (INT-485): make a plugin, check it, try it as the board runs it, over MCP and directly.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { TOOLS } = require('../plugin-mcp');

const tool = (n) => TOOLS.find((t) => t[0] === n)[4];
const sandboxed = (() => { const [a, b] = process.versions.node.split('.').map(Number); return a > 23 || (a === 23 && b >= 5); })();

describe('plugin authoring tools', () => {
  it('a new plugin checks clean and answers a test and a run, sandboxed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmcp-'));
    assert.match(tool('plugin_new')({ dir, name: 'demo', connection: [{ key: 'token', label: 'Token', secret: true }] }), /Made .*demo/);
    const p = path.join(dir, 'demo');
    assert.equal(JSON.parse(tool('plugin_check')({ path: p })).ok, true);
    const t = JSON.parse(await tool('plugin_try')({ path: p, type: 'test', connection: { token: 'x' } }));
    assert.deepEqual([t.ok, t.result.message], [true, 'Connected']);
    const r = JSON.parse(await tool('plugin_try')({ path: p, type: 'run', action: 'hello', inputs: { who: 'Ann' } }));
    assert.deepEqual([r.ok, r.result.who], [true, 'Ann']);
    assert.equal(r.sandboxed, sandboxed || r.sandboxed);
    assert.throws(() => tool('plugin_new')({ dir, name: 'demo' }), /already exists/, 'never overwrites');
    assert.throws(() => tool('plugin_new')({ dir, name: 'Bad Name' }), /name:/);
  });

  it('check reports a broken entry; try reports an error reply, an unknown action and a plugin that never answers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmcp-'));
    tool('plugin_new')({ dir, name: 'oops' });
    const p = path.join(dir, 'oops');
    const index = path.join(p, 'index.js');
    fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace("return { message: 'Connected' };", "throw new Error('the token was refused');"));
    const t = JSON.parse(await tool('plugin_try')({ path: p, type: 'test' }));
    assert.deepEqual([t.ok, t.error], [false, 'the token was refused']);
    await assert.rejects(tool('plugin_try')({ path: p, type: 'run', action: 'nope' }), /no action "nope"/);
    fs.writeFileSync(index, 'process.stdin.resume(); // reads, never answers\n');
    const h = JSON.parse(await tool('plugin_try')({ path: p, type: 'test', timeoutSec: 1 }));
    assert.match(h.error, /no answer in 1 s/);
    fs.writeFileSync(index, 'this is not javascript (');
    const c = JSON.parse(tool('plugin_check')({ path: p }));
    assert.equal(c.ok, false);
    assert.match(c.problems.join(' '), /index\.js/);
  });

  it('the sandbox is the board\'s: a plugin can\'t read outside its folder', { skip: !sandboxed && 'needs Node 23.5+' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmcp-'));
    tool('plugin_new')({ dir, name: 'nosy' });
    const p = path.join(dir, 'nosy');
    const outside = path.join(dir, 'secret.txt');
    fs.writeFileSync(outside, 'board token');
    const index = path.join(p, 'index.js');
    fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace("return { message: 'Connected' };", `return { message: require('fs').readFileSync(${JSON.stringify(outside)}, 'utf8') };`));
    const t = JSON.parse(await tool('plugin_try')({ path: p, type: 'test' }));
    assert.equal(t.ok, false);
    assert.match(t.error, /ERR_ACCESS_DENIED|permission|access/i);
  });

  it('speaks MCP: initialize, tools/list, tools/call', async () => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'plugin-mcp.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
    const replies = [];
    let buf = '';
    proc.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    const msgs = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'plugin_guide', arguments: {} } }];
    proc.stdin.end(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
    await new Promise((r) => proc.on('exit', r));
    const byId = Object.fromEntries(replies.map((r) => [r.id, r.result]));
    assert.equal(byId[1].serverInfo.name, 'intellagent-plugins');
    assert.deepEqual(byId[2].tools.map((t) => t.name), ['plugin_guide', 'plugin_new', 'plugin_check', 'plugin_try']);
    assert.match(byId[3].content[0].text, /^# Writing an Intellagent plugin/);
  });
});
