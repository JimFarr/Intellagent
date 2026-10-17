// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// One record per run in agent-stats.jsonl (INT-310).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { startServer, until, USER } = require('./helpers');
const { createStats, costOf, turnCost, commandName, addTools, newTools, resultOf, lastResult } = require('../lib/agents/stats');

const FAKE = path.join(__dirname, 'fake-agent.js');
const run = (...args) => `node "${FAKE}" ${args.join(' ')}`;
const B = '/api/boards/main';
const fast = { settleSeconds: 0.2, retrySeconds: 0.2, throttleMinutes: 0 };

describe('run statistics: the pieces', () => {
  it('a keep-alive turn costs the difference from the running total; no result means null, never 0', () => {
    assert.equal(turnCost(null, 0.25), 0.25, 'the first turn is the whole total');
    assert.equal(turnCost(0.25, 0.5), 0.25, 'the second is the difference');
    assert.equal(turnCost(0.5, 0.75), 0.25);
    assert.equal(turnCost(0.5, 0.1), 0.1, 'a counter that restarted: the new total is the turn');
    assert.equal(turnCost(0.5, null), null, 'no total: unknown, not free');
    assert.equal(costOf({ type: 'result' }), null);
    assert.equal(costOf({ total_cost_usd: 0 }), 0, 'a real zero stays zero');
    assert.equal(costOf({ total_cost_usd: 'x' }), null);
    assert.equal(costOf(null), null);
  });

  it('keeps command names, never command lines', () => {
    assert.equal(commandName('FOO=1 git push https://u:secret@h/x'), 'git');
    assert.equal(commandName('C:\\tools\\node.exe --test'), 'node');
    assert.equal(commandName('"/usr/bin/npm" test'), 'npm');
    assert.equal(commandName('  '), null);
    assert.equal(commandName('$(curl evil)'), null);
    assert.equal(commandName('API_KEY="hunter2 xyz" node x'), null, 'a quoted value may hold a space: no part of it is a name');
    assert.equal(commandName('API_KEY=a\\ b node x'), null, 'an escaped space may hide part of a secret too: no name');
    assert.equal(commandName("TOKEN='a b' git push"), null);
    assert.equal(commandName('A=1 B=2 git push'), 'git', 'plain assignments are skipped');
    const acc = newTools();
    addTools(acc, { type: 'assistant', message: { content: [
      { type: 'text', text: 'hi' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test --token=abc' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm run lint' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'x' } },
    ] } });
    addTools(acc, { type: 'user' });
    addTools(acc, null);
    assert.deepEqual(acc, { tools: { Bash: 2, Edit: 1 }, commands: ['npm'] });
    assert.ok(!JSON.stringify(acc).includes('abc'));
  });

  it('results: ok, failed, timeout, stopped, limited', () => {
    assert.equal(resultOf(0), 'ok');
    assert.equal(resultOf(1), 'failed');
    assert.equal(resultOf(-1), 'failed');
    assert.equal(resultOf('timeout'), 'timeout');
    assert.equal(resultOf('stopped'), 'stopped');
    assert.equal(resultOf(1, true), 'limited');
  });

  it('reads the last result object after the prompt', () => {
    const log = '$ x\n--- prompt ---\n{"type":"result","total_cost_usd":9}\n--- output ---\n{"type":"assistant"}\n{"type":"result","total_cost_usd":0.5}\n';
    assert.equal(costOf(lastResult(log)), 0.5);
    assert.equal(lastResult('--- output ---\nnothing'), null);
  });

  it('rolls the file over like events.jsonl, and the reader returns rolled files first, then the live one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-stats-'));
    try {
      const st = createStats(dir, { maxBytes: 100 });
      for (let n = 1; n <= 6; n++) st.append({ n, pad: 'x'.repeat(40) });
      const files = fs.readdirSync(dir);
      assert.ok(files.some((f) => /^agent-stats-\d+\.jsonl$/.test(f)), `rolled: ${files}`);
      assert.ok(files.includes('agent-stats.jsonl'));
      fs.appendFileSync(path.join(dir, 'agent-stats.jsonl'), '{"torn\n');
      assert.deepEqual(st.read().map((r) => r.n), [1, 2, 3, 4, 5, 6], 'every record, in order; a torn line is skipped');
      assert.deepEqual(createStats(path.join(dir, 'nowhere')).read(), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('run statistics: a real board', () => {
  it('writes a line per run and per keep-alive turn; cost per turn, null without a result, no secrets (INT-310)', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: {
      keeper: { role: 'builder', run: run('stream'), keepAlive: 'stream-json', recycleAfterRuns: 5, throttleMinutes: 0, model: 'sonnet' },
      counter: { run: run('usage') },
      broken: { run: run('fail'), maxFailures: 5 },
    } } });
    const file = path.join(s.dir, 'data', 'agent-stats.jsonl');
    const lines = (who) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((r) => r.agent === who);
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'stats', column: 'Backlog' }, USER);
      for (let n = 1; n <= 2; n++) {
        await s.ok('POST', `${B}/items/${it.id}/comments`, { body: `@keeper wake ${n}` }, USER);
        await until(async () => lines('keeper').length === n, 30000, `keeper turn ${n}`);
        await until(async () => (await s.ok('GET', '/api/agents/keeper')).status === 'idle', 30000, 'keeper idle');
      }
      const [t1, t2] = lines('keeper');
      assert.equal(t1.cost, 0.25);
      assert.equal(t2.cost, 0.25, 'the second turn costs the difference, not the running total 0.5');
      assert.equal(t1.result, 'ok');
      assert.equal(t1.model, 'sonnet');
      assert.deepEqual(t1.tools, { Bash: 1 });
      assert.deepEqual(t1.commands, ['git']);
      assert.deepEqual(t1.items, [it.id]);
      assert.equal(t1.tokens.input, 10);
      assert.ok(!fs.readFileSync(file, 'utf8').includes('s3cret'), 'no command line in the file');

      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@counter go' }, USER);
      await until(async () => lines('counter').length === 1, 30000, 'one-shot line');
      const [c] = lines('counter');
      assert.equal(c.cost, 0.5);
      assert.equal(c.tools, null, 'a one-shot json run lists no tool calls');
      assert.deepEqual(c.tokens, { input: 120, output: 30, cacheRead: 500, cacheWrite: 40 });

      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@broken go' }, USER);
      await until(async () => lines('broken').length >= 1, 30000, 'failed line');
      const [b] = lines('broken');
      assert.equal(b.result, 'failed');
      assert.equal(b.cost, null, 'a run with no result line has an unknown cost, not 0');
    } finally { await s.stop(); }
  });
});
