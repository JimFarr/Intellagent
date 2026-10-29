// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Agent stalls (INT-483): the pure check over agent views, with a clock passed in.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { check, whyOf, timingsOf, TIMINGS } = require('../lib/alerts/stalls');
const { startServer, until, USER } = require('./helpers');
const RULES = require('../lib/rules');

const MIN = 60_000;
const T0 = Date.parse('2026-10-29T12:00:00Z');
const agent = (x) => ({ name: 'drax', status: 'idle', queued: 0, failures: 0, lastRun: null, runningSince: null, limitedUntil: null, ...x });
const none = () => [];
const work = [{ board: 'main', action: 'start', id: 'INT-1', title: 'One' }];

describe('agent stalls (INT-483)', () => {
  it('says why for each kind, and nothing for an agent at work or with nothing to do', () => {
    assert.equal(whyOf(agent({ status: 'failed' }), none), 'failed');
    assert.equal(whyOf(agent({ status: 'retrying', failures: 1, queued: 1 }), none), 'failed', 'a failed run being retried');
    assert.equal(whyOf(agent({ status: 'waiting', waitingFor: 'usage limit', queued: 2 }), none), 'limited');
    assert.equal(whyOf(agent({ status: 'throttled', queued: 1 }), none), 'limited');
    assert.equal(whyOf(agent({ status: 'paused', queued: 1 }), none), 'paused');
    assert.equal(whyOf(agent({ status: 'paused' }), () => work), 'paused', 'paused with work on the board, nothing queued');
    assert.equal(whyOf(agent({ status: 'paused' }), none), null, 'paused with nothing waiting is no stall');
    assert.equal(whyOf(agent({ status: 'queued', queued: 3 }), none), 'waiting');
    assert.equal(whyOf(agent({ status: 'idle' }), () => work), null, 'work it was offered and left is its own choice, not a stall');
    assert.equal(whyOf(agent({ status: 'running', queued: 3, runningSince: new Date(T0).toISOString() }), none), null);
  });

  it('a stall is raised once, with its evidence, and again only after the agent is out of it', () => {
    const failed = agent({ status: 'failed', failures: 3, lastRun: { startedAt: 'a', endedAt: 'b', code: 1, error: 'boom', log: 'x.log' } });
    let r = check([failed], () => work, {}, T0);
    assert.equal(r.stalls.length, 1);
    assert.deepEqual(r.stalls[0], { agent: 'drax', why: 'failed', since: new Date(T0).toISOString(), minutes: 0,
      evidence: { status: 'failed', queued: 0, failures: 3, lastRun: { startedAt: 'a', endedAt: 'b', code: 1, error: 'boom' }, waiting: [{ board: 'main', action: 'start', id: 'INT-1', title: 'One' }] } });
    r = check([failed], none, r.ledger, T0 + 30 * MIN);
    assert.equal(r.stalls.length, 0, 'still failed: not raised again');
    r = check([agent({ status: 'idle' })], none, r.ledger, T0 + 31 * MIN);
    assert.deepEqual([r.stalls.length, r.ledger], [0, {}], 'resumed and fine: the stall is over');
    r = check([failed], none, r.ledger, T0 + 32 * MIN);
    assert.equal(r.stalls.length, 1, 'a new stall is raised');
  });

  it('waiting and limited count only after their minutes; paused and failed at once', () => {
    const queued = agent({ status: 'queued', queued: 2 });
    let r = check([queued], none, {}, T0);
    assert.equal(r.stalls.length, 0, 'just queued');
    r = check([queued], none, r.ledger, T0 + TIMINGS.waitMs - 1);
    assert.equal(r.stalls.length, 0);
    r = check([queued], none, r.ledger, T0 + TIMINGS.waitMs);
    assert.deepEqual([r.stalls.length, r.stalls[0].why, r.stalls[0].minutes], [1, 'waiting', 15]);
    // a run started in between: the wait starts over
    r = check([agent({ status: 'running', queued: 2, runningSince: 'x' })], none, r.ledger, T0 + 16 * MIN);
    r = check([queued], none, r.ledger, T0 + 17 * MIN);
    assert.equal(r.stalls.length, 0);
    const limited = agent({ status: 'waiting', waitingFor: 'usage limit', queued: 1, limitedUntil: '2026-10-29T15:00:00Z' });
    r = check([limited], none, {}, T0);
    r = check([limited], none, r.ledger, T0 + 15 * MIN);
    assert.deepEqual([r.stalls[0].why, r.stalls[0].evidence.limitedUntil], ['limited', '2026-10-29T15:00:00Z']);
    assert.equal(check([agent({ status: 'paused', queued: 1 })], none, {}, T0).stalls[0].why, 'paused');
  });

  it('a different reason is a new stall', () => {
    let r = check([agent({ status: 'paused', queued: 1 })], none, {}, T0);
    r = check([agent({ status: 'failed' })], none, r.ledger, T0 + MIN);
    assert.deepEqual(r.stalls.map((s) => s.why), ['failed']);
  });

  it('the manifest tunes the minutes; anything else keeps the default', () => {
    assert.deepEqual(timingsOf({ waitMinutes: 5, limitedMinutes: 'x' }), { waitMs: 5 * MIN, limitedMs: TIMINGS.limitedMs });
    assert.deepEqual(timingsOf(null), TIMINGS);
  });
});

describe('the "an agent stalls" trigger (INT-483)', () => {
  const COLS = [{ id: 'ready', name: 'Ready' }];
  it('takes why and agent, refuses ticket actions and conditions, and says itself in words', () => {
    const r = RULES.cleanRule({ name: 'x', when: { on: 'agent_stalled', why: 'paused', agent: 'drax' }, then: [{ do: 'wake', agent: 'coordinator' }] }, COLS, { id: 'r', nowIso: 'now' });
    assert.deepEqual(r.when, { on: 'agent_stalled', why: 'paused', agent: 'drax' });
    assert.equal(RULES.describe(r, COLS), 'If drax stalls (paused) → wake coordinator');
    for (const [bad, msg] of [
      [{ when: { on: 'agent_stalled', why: 'bored' }, then: [{ do: 'wake', agent: 'coordinator' }] }, /not a reason/],
      [{ when: { on: 'agent_stalled' }, then: [{ do: 'comment', text: 'hi' }] }, /about an agent/],
      [{ when: { on: 'agent_stalled' }, if: 'priority:High', then: [{ do: 'wake', agent: 'coordinator' }] }, /about an agent/],
    ]) assert.throws(() => RULES.cleanRule({ name: 'x', ...bad }, COLS, { id: 'r', nowIso: 'now' }), msg);
  });

  const FAKE = path.join(__dirname, 'fake-agent.js');
  const run = (...a) => `node "${FAKE}" ${a.join(' ')}`;
  const B = '/api/boards/main';
  let s;
  before(async () => {
    s = await startServer({ agents: { defaults: { settleSeconds: 0.2, retrySeconds: 0.2, throttleMinutes: 0 }, agents: {
      boss: { run: run('ok') }, drax: { run: run('ok') }, flaky: { run: run('fail'), maxFailures: 1, failedRetryMinutes: 0 }, spare: { run: run('ok') },
    } } });
  });
  after(async () => { await s.stop(); });
  const events = async (type) => (await s.ok('GET', `/api/events?types=${type}`)).events;

  it('a paused agent with work waiting: raised once, and the rule wakes whom it names with the stall', async () => {
    const rule = await s.ok('POST', `${B}/rules`, { name: 'Paused agents', when: { on: 'agent_stalled', why: 'paused' }, then: [{ do: 'wake', agent: 'boss' }] }, USER);
    assert.equal(rule.text, 'If an agent stalls (paused) → wake boss');
    const vocab = (await s.ok('GET', `${B}/rules`)).vocabulary.events.agent_stalled;
    assert.deepEqual([vocab.agent, vocab.whys], [true, ['failed', 'limited', 'paused', 'waiting']]);
    await s.ok('POST', '/api/agents/drax/pause', {}, USER);
    await s.ok('POST', `${B}/items`, { title: 'for drax', column: 'Ready', assignee: 'drax' }, USER);
    // any agent's status change runs the check (as the minute's sweep does)
    await s.ok('POST', '/api/agents/spare/pause', {}, USER);
    const stall = await until(async () => (await events('agent.stalled')).find((e) => e.agent === 'drax'), 5000, 'drax stalled');
    assert.equal(stall.why, 'paused');
    assert.ok(stall.evidence.queued >= 1 || stall.evidence.waiting.length, 'the evidence says what waits');
    const woke = await until(async () => (await events('rule.fired')).find((e) => e.stall?.agent === 'drax'), 5000, 'boss woken');
    assert.deepEqual([woke.addressed, woke.stall.why, woke.why], [['boss'], 'paused', 'drax stalls (paused)']);
    // still paused: another check raises nothing more
    await s.ok('POST', '/api/agents/spare/resume', {}, USER);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await events('agent.stalled')).filter((e) => e.agent === 'drax').length, 1);
  });

  it('an agent whose runs fail is raised as failed, with its last run', async () => {
    await s.ok('POST', `${B}/items`, { title: 'for flaky', column: 'Ready', assignee: 'flaky' }, USER);
    const stall = await until(async () => (await events('agent.stalled')).find((e) => e.agent === 'flaky'), 15000, 'flaky stalled');
    assert.equal(stall.why, 'failed');
    assert.notEqual(stall.evidence.lastRun.code, 0);
  });
});
