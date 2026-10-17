// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// INT-308: the model follows the run. The classifier is a plain function over a table; the rest goes through a
// real board with a fake agent that reports the model it was given.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, until, USER } = require('./helpers');
const { classify, modelFor } = require('../lib/agents/triage');
const { escalates } = require('../lib/agents/stats');

const FAKE = path.join(__dirname, 'fake-agent.js');
const run = (...args) => `node "${FAKE}" ${args.join(' ')}`;
const B = '/api/boards/main';
const fast = { settleSeconds: 0.2, retrySeconds: 0.2, throttleMinutes: 0 };
const pending = (...actions) => ({ type: 'work.pending', work: actions.map((action) => ({ action, id: 'INT-1', key: action })) });
const bodies = async (s, id) => (await s.ok('GET', `${B}/items/${id}`)).comments.map((c) => c.body);

describe('classify (INT-308)', () => {
  it('housekeeping is triage; anything that can need building is build; unknown is build', () => {
    assert.equal(classify([pending('renew', 'answer_lease_request')]), 'triage');
    assert.equal(classify([{ type: 'lease.request' }, { type: 'focus.activated' }, { type: 'board.idle' }]), 'triage');
    assert.equal(classify([{ type: 'comment.added' }]), 'triage', 'a comment that asks for nothing');
    assert.equal(classify([{ type: 'comment.added', intent: 'explain' }]), 'build');
    assert.equal(classify([{ type: 'request.created' }]), 'build');
    assert.equal(classify([{ type: 'item.assigned' }]), 'build');
    assert.equal(classify([pending('start')]), 'build');
    assert.equal(classify([pending('renew'), pending('address_feedback')]), 'build', 'one build event makes the batch build');
    assert.equal(classify([{ type: 'something.new' }]), 'build');
    assert.equal(classify([]), 'build');
  });
  it('modelFor falls back to the agent model; the marker must be a line of its own', () => {
    assert.equal(modelFor({ model: 'opus', runModels: { triage: 'haiku' } }, 'triage'), 'haiku');
    assert.equal(modelFor({ model: 'opus', runModels: { triage: 'haiku' } }, 'build'), 'opus');
    assert.equal(modelFor({ model: 'opus' }, 'triage'), 'opus');
    assert.equal(escalates({ result: 'text\n [[needs-build]] \n' }), true);
    assert.equal(escalates({ result: 'I will not write [[needs-build]] here' }), false);
    assert.equal(escalates(null), false);
  });
});

describe('the model follows the run (INT-308)', () => {
  it('a comment runs on the triage model and says so; no runModels = the agent model; bad names are refused', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: {
      cheap: { run: run('model'), model: 'opus', runModels: { triage: 'haiku' }, listen: 'inbox' },
      plain: { run: run('model'), model: 'opus', listen: 'inbox' },
      bad: { run: run('model'), model: 'opus', runModels: { triage: 'haiku; rm -rf /', build: 'sonnet', other: 'x' }, enabled: false },
    } } });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'model test', column: 'Backlog' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@cheap @plain have a look' }, USER);
      const got = await until(async () => { const c = await bodies(s, it.id); return c.filter((b) => b.startsWith('ran on')).length >= 2 ? c : null; }, 8000, 'both comments');
      assert.ok(got.includes('ran on haiku (triage prompt)'), got.join(' | '));
      assert.ok(got.includes('ran on opus'), 'without runModels every run uses the agent model');
      const a = await s.ok('GET', '/api/agents/cheap');
      assert.deepEqual([a.lastRun.kind, a.lastRun.model, a.history.at(-1).kind, a.history.at(-1).model], ['triage', 'haiku', 'triage', 'haiku']);
      const bad = await s.ok('GET', '/api/agents/bad');
      assert.deepEqual(bad.runModels, { build: 'sonnet' }, 'only plain model names under triage/build');
    } finally { await s.stop(); }
  });

  it('a triage run that asks for building is run again once on the build model, and never loops', async () => {
    const s = await startServer({ agents: { defaults: { ...fast, throttleMinutes: 30 }, agents: {
      esc: { run: run('model', 'escalate'), model: 'opus', runModels: { triage: 'haiku' }, listen: 'inbox' },
    } } });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'escalate test', column: 'Backlog' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@esc please look' }, USER);
      const got = await until(async () => { const c = await bodies(s, it.id); return c.some((b) => b === 'ran on opus') ? c : null; }, 8000, 'the build run, despite the 30 minute throttle');
      assert.deepEqual(got.filter((b) => b.startsWith('ran on')), ['ran on haiku (triage prompt)', 'ran on opus']);
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal((await bodies(s, it.id)).filter((b) => b.startsWith('ran on')).length, 2, 'no third run');
      const a = await s.ok('GET', '/api/agents/esc');
      assert.deepEqual(a.history.map((h) => [h.kind, h.model]), [['triage', 'haiku'], ['build', 'opus']]);
    } finally { await s.stop(); }
  });
});
