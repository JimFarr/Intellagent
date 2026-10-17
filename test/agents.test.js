// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Standing agents: the board starts runs for agents defined in agents.json.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { startServer, until, USER } = require('./helpers');

const FAKE = path.join(__dirname, 'fake-agent.js');
const run = (...args) => `node "${FAKE}" ${args.join(' ')}`;
const B = '/api/boards/main';
const fast = { settleSeconds: 0.2, retrySeconds: 0.2, throttleMinutes: 0 };

const comments = async (s, id) => (await s.ok('GET', `${B}/items/${id}`)).comments.map((c) => `${c.author.name}: ${c.body}`);
const agentState = (s, name) => s.ok('GET', `/api/agents/${name}`);

describe('standing agents', () => {
  let s;
  before(async () => {
    s = await startServer({
      agents: {
        defaults: fast,
        agents: {
          bot: { run: run('ok') },
          flaky: { run: run('fail'), maxFailures: 2 },
          slowpoke: { run: run('slow', 800) },
          budget: { run: run('ok'), maxRunsPerHour: 1 },
          coord: { run: run('ok'), listen: 'human', enabled: false },
          calm: { run: run('ok'), throttleMinutes: 0.04 }, // 2.4 s window
          doomed: { run: run('slow', 800) }, // removed by a test
          sleepy: { run: run('slow', 2500), stallMinutes: 0.01 }, // stalled after 0.6 s without a board call
        },
      },
    });
  });
  after(async () => { await s.stop(); });

  it('lists agents from agents.json', async () => {
    const { agents } = await s.ok('GET', '/api/agents');
    assert.deepEqual(agents.map((a) => a.name), ['bot', 'flaky', 'slowpoke', 'budget', 'coord', 'calm', 'doomed', 'sleepy']);
    assert.equal(agents.find((a) => a.name === 'coord').status, 'paused');
  });

  it('wakes an agent when its inbox gets an event', async () => {
    const it = await s.ok('POST', `${B}/items`, { title: 'wake test', column: 'Backlog' }, USER);
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@bot please look' }, USER);
    await until(async () => (await comments(s, it.id)).some((c) => c.startsWith('bot: handled')), 8000, 'bot reply');
    await until(async () => (await agentState(s, 'bot')).status === 'idle', 4000, 'bot idle');
    assert.equal((await agentState(s, 'bot')).lastRun.code, 0);
    const asked = (await s.ok('GET', `${B}/items/${it.id}`)).comments.find((c) => c.body === '@bot please look');
    assert.deepEqual(asked.reactions, { '👀': ['bot'] }, 'the comment it was woken for is marked seen');
  });

  it('marks a comment ⏳ while it waits for a busy agent and swaps it for 👀 when its run starts', async () => {
    const it = await s.ok('POST', `${B}/items`, { title: 'queued marker', column: 'Backlog' }, USER);
    const find = async (text) => (await s.ok('GET', `${B}/items/${it.id}`)).comments.find((c) => c.body === text);
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@slowpoke first' }, USER);
    await until(async () => (await agentState(s, 'slowpoke')).status === 'running', 4000, 'slowpoke running');
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@slowpoke second' }, USER);
    const waiting = await until(async () => { const c = await find('@slowpoke second'); return c?.reactions?.['⏳'] ? c : null; }, 4000, 'hourglass');
    assert.deepEqual(waiting.reactions, { '⏳': ['slowpoke'] });
    assert.match(waiting.reactionNotes['⏳|slowpoke'], /after its current run/);
    await until(async () => (await find('@slowpoke second'))?.reactions?.['👀'], 8000, 'seen');
    const seen = await find('@slowpoke second');
    assert.deepEqual(seen.reactions, { '👀': ['slowpoke'] }, '⏳ is gone once the run starts');
    assert.equal(seen.reactionNotes, undefined);
    await until(async () => (await agentState(s, 'slowpoke')).status === 'idle', 6000, 'slowpoke idle'); // leave it quiet for the next test
  });

  it('a queued ⏳ says so when its agent is paused, promises again on resume, and comes off when the agent is removed', async () => {
    const it = await s.ok('POST', `${B}/items`, { title: 'queued marker, paused', column: 'Backlog' }, USER);
    const find = async (text) => (await s.ok('GET', `${B}/items/${it.id}`)).comments.find((c) => c.body === text);
    const note = async (text, who) => (await find(text))?.reactionNotes?.[`⏳|${who}`] || '';
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@slowpoke one' }, USER);
    await until(async () => (await agentState(s, 'slowpoke')).status === 'running', 4000, 'slowpoke running');
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@slowpoke two' }, USER);
    await until(async () => /after its current run/.test(await note('@slowpoke two', 'slowpoke')), 4000, 'hourglass');
    await s.ok('POST', '/api/agents/slowpoke/pause', {}, USER);
    await until(async () => /paused/.test(await note('@slowpoke two', 'slowpoke')), 4000, 'paused note');
    await until(async () => !(await agentState(s, 'slowpoke')).runningSince, 6000, 'current run over');
    assert.match(await note('@slowpoke two', 'slowpoke'), /paused/, 'the end of the run does not bring the old promise back');
    await s.ok('POST', '/api/agents/slowpoke/resume', {}, USER);
    await until(async () => (await find('@slowpoke two'))?.reactions?.['👀'], 8000, 'seen after resume');
    assert.deepEqual((await find('@slowpoke two')).reactions, { '👀': ['slowpoke'] });
    await until(async () => (await agentState(s, 'slowpoke')).status === 'idle', 6000, 'slowpoke idle');

    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@doomed one' }, USER);
    await until(async () => (await agentState(s, 'doomed')).status === 'running', 4000, 'doomed running');
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@doomed two' }, USER);
    await until(async () => (await find('@doomed two'))?.reactions?.['⏳'], 4000, 'hourglass');
    await s.ok('DELETE', '/api/agents/doomed', undefined, USER);
    await until(async () => !(await find('@doomed two'))?.reactions?.['⏳'], 4000, 'hourglass taken back');
    assert.equal((await find('@doomed two')).reactionNotes, undefined);
  });

  it('a running agent shows its last activity, and is stalled after stallMinutes without any; the run keeps what it was woken for', async () => {
    const it = await s.ok('POST', `${B}/items`, { title: 'stall test', column: 'Backlog' }, USER);
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@sleepy wake up' }, USER);
    const live = await until(async () => { const a = await agentState(s, 'sleepy'); return a.status === 'running' ? a : null; }, 4000, 'sleepy running');
    assert.ok(live.lastActivityAt >= live.runningSince, 'activity is at least the run start');
    const stuck = await until(async () => { const a = await agentState(s, 'sleepy'); return a.stalled ? a : null; }, 2400, 'stalled');
    assert.equal(stuck.status, 'running');
    await s.ok('GET', `${B}/work`, undefined, { agent: 'sleepy' }); // a call to the board is a sign of life
    assert.equal((await agentState(s, 'sleepy')).stalled, false);
    const done = await until(async () => { const a = await agentState(s, 'sleepy'); return a.status === 'idle' ? a : null; }, 6000, 'sleepy idle');
    assert.deepEqual([done.lastActivityAt, done.stalled], [null, false]);
    assert.deepEqual(done.lastRun.about.comments, [it.id], 'the UI can tell where a run that ended was expected to answer');
    assert.ok(done.lastRun.endedAt);
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@slowpoke still there?' }, USER);
    const slow = await until(async () => { const a = await agentState(s, 'slowpoke'); return a.status === 'running' ? a : null; }, 4000, 'slowpoke running');
    assert.equal(slow.stalled, false, 'the default stall window is minutes, not a second');
    await until(async () => (await agentState(s, 'slowpoke')).status === 'idle', 6000, 'slowpoke idle');
  });

  it('retries a failing agent, then flags it and waits for the human', async () => {
    const it = await s.ok('POST', `${B}/items`, { title: 'flaky test', column: 'Backlog' }, USER);
    const { seq } = await s.ok('GET', '/api/app');
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@flaky go' }, USER);
    await until(async () => (await agentState(s, 'flaky')).status === 'failed', 8000, 'flaky failed');
    const evs = (await s.ok('GET', `/api/events?since=${seq}&types=agent.run.started,agent.failed`)).events.filter((e) => e.agent === 'flaky');
    assert.deepEqual(evs.map((e) => e.type), ['agent.run.started', 'agent.run.started', 'agent.failed']);
    assert.equal((await agentState(s, 'flaky')).queued, 1, 'the event is kept for the next attempt');
    // INT-346: the card can say why from the first failure; it is the log's telling line, not its last
    assert.equal((await agentState(s, 'flaky')).lastRun.error, 'Invalid MCP configuration: MCP config file not found: x/.mcp.json');

    assert.equal((await s.api('POST', '/api/agents/flaky/resume', {})).status, 403, 'agents cannot resume agents');
    const r = await s.ok('POST', '/api/agents/flaky/resume', {}, USER);
    assert.equal(r.failures, 0);
  });

  it('runs one at a time; events arriving meanwhile go in the next run', async () => {
    const it = await s.ok('POST', `${B}/items`, { title: 'slow test', column: 'Backlog' }, USER);
    const { seq } = await s.ok('GET', '/api/app');
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@slowpoke one' }, USER);
    await until(async () => (await agentState(s, 'slowpoke')).status === 'running', 4000, 'running');
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@slowpoke two' }, USER);
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@slowpoke three' }, USER);
    await until(async () => (await comments(s, it.id)).filter((c) => c.startsWith('slowpoke:')).length === 2, 8000, 'two runs');
    await until(async () => (await agentState(s, 'slowpoke')).status === 'idle', 4000, 'idle');
    const evs = (await s.ok('GET', `/api/events?since=${seq}&types=agent.run.*`)).events.filter((e) => e.agent === 'slowpoke');
    assert.deepEqual(evs.map((e) => e.type), ['agent.run.started', 'agent.run.finished', 'agent.run.started', 'agent.run.finished'], 'never overlapping');
    assert.ok((await comments(s, it.id)).includes('slowpoke: handled 2 event(s)'), 'second run got both queued events');
  });

  it('throttles at maxRunsPerHour', async () => {
    const it = await s.ok('POST', `${B}/items`, { title: 'budget test', column: 'Backlog' }, USER);
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@budget one' }, USER);
    await until(async () => (await comments(s, it.id)).some((c) => c.startsWith('budget:')), 8000, 'first run');
    await until(async () => (await agentState(s, 'budget')).status === 'idle', 4000, 'idle');
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@budget two' }, USER);
    await until(async () => (await agentState(s, 'budget')).status === 'throttled', 4000, 'throttled');
  });

  it('throttles to one run per window: a burst after a run lands in a single later run', async () => {
    const it = await s.ok('POST', `${B}/items`, { title: 'calm test', column: 'Backlog' }, USER);
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@calm first' }, USER);
    await until(async () => (await comments(s, it.id)).some((c) => c.startsWith('calm:')), 8000, 'first run (no wait)');
    await until(async () => (await agentState(s, 'calm')).status === 'idle', 4000, 'idle');
    for (const n of ['two', 'three', 'four']) await s.ok('POST', `${B}/items/${it.id}/comments`, { body: `@calm ${n}` }, USER);
    await until(async () => (await agentState(s, 'calm')).status === 'waiting', 3000, 'waiting out the window');
    await until(async () => (await comments(s, it.id)).filter((c) => c.startsWith('calm:')).length === 2, 8000, 'one batched run');
    assert.ok((await comments(s, it.id)).includes('calm: handled 3 event(s)'));
  });

  it('roles: defined through the API from a role and permissions, never a raw command', async () => {
    const roles = await s.ok('GET', '/api/agents/roles');
    assert.ok(roles.roles.builder && roles.perms.test);
    assert.equal((await s.api('POST', '/api/agents', { name: 'bob', role: 'builder' })).status, 403, 'human only');
    assert.equal((await s.api('POST', '/api/agents', { name: 'bob', role: 'wizard' }, USER)).status, 400);
    assert.equal((await s.api('POST', '/api/agents', { name: 'bob', perms: ['rm -rf'] }, USER)).status, 400);
    const a = await s.ok('POST', '/api/agents', { name: 'bob', role: 'builder', perms: ['edit', 'test'], run: 'evil --command' }, USER);
    assert.match(a.run, /^claude -p .*--allowedTools .*"Bash\(npm test:\*\)"/);
    assert.ok(!a.run.includes('evil'), 'a run command from the API is ignored');
    assert.equal(a.role, 'builder');
    // the Edit form posts the same shape again: role, perms, wake-ups and throttle change in place
    const e = await s.ok('POST', '/api/agents', { name: 'bob', role: 'reviewer', perms: ['read'], listen: 'inbox', throttleMinutes: 7, model: 'opus', description: 'looks at diffs' }, USER);
    assert.deepEqual([e.role, e.perms, e.listen, e.throttleMinutes, e.model, e.description], ['reviewer', ['read'], 'inbox', 7, 'opus', 'looks at diffs']);
    assert.equal((await s.ok('POST', '/api/agents', { name: 'bob', throttleMinutes: null }, USER)).listen, 'inbox', 'fields not sent are kept');
    await s.ok('POST', '/api/agents', { name: 'lead', role: 'coordinator', coordinator: true }, USER);
    assert.equal((await s.ok('GET', B)).board.coordinator, 'lead');
    await s.ok('DELETE', '/api/agents/bob', undefined, USER);
    await s.ok('DELETE', '/api/agents/lead', undefined, USER);
    assert.ok(!(await s.ok('GET', '/api/agents')).agents.some((x) => x.name === 'bob'));
  });

  it('paused agents queue events; resuming runs them', async () => {
    assert.equal((await agentState(s, 'coord')).status, 'paused');
    await s.ok('POST', `${B}/items`, { title: 'for the coordinator', column: 'Backlog' }, USER);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok((await agentState(s, 'coord')).queued >= 1);
  });
});

describe('standing agents wake only when addressed', () => {
  it('a thread participant is not woken by later comments; a mention (outside code) is', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: { quiet: { run: run('ok') } } } });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'addressed only', column: 'Backlog' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@quiet first' }, USER);
      await until(async () => (await comments(s, it.id)).some((c) => c.startsWith('quiet:')), 8000, 'first run');
      await until(async () => (await agentState(s, 'quiet')).status === 'idle', 4000, 'idle');
      const runs = (await agentState(s, 'quiet')).runsLastHour;
      // quiet is now a thread participant: plain comments and code-span mentions must not wake it
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: 'just chatting here' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: 'talking about `@quiet` in code' }, USER);
      await new Promise((res) => setTimeout(res, 900));
      assert.equal((await agentState(s, 'quiet')).runsLastHour, runs, 'no new run');
      assert.equal((await agentState(s, 'quiet')).queued, 0);
      await s.ok('PATCH', `${B}/items/${it.id}`, { assignee: 'quiet' }, USER);
      await until(async () => (await agentState(s, 'quiet')).runsLastHour > runs, 8000, 'assignment wakes it');
    } finally { await s.stop(); }
  });
});

describe('coordinator role', () => {
  it('wakes on tickets the human creates, without being assigned', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: { triager: { role: 'coordinator', run: run('ok') } } } });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'unassigned new ticket', column: 'Backlog' }, USER);
      await until(async () => (await comments(s, it.id)).some((c) => c.startsWith('triager:')), 8000, 'coordinator triage run');
      const brief = (await s.ok('GET', '/api/agents/triager')).listen;
      assert.deepEqual(brief, ['addressed', 'new-tickets']);
      // a ticket the human already assigned to someone else needs no triage: no wake
      await until(async () => (await agentState(s, 'triager')).status === 'idle', 6000, 'triager idle');
      const runs = (await agentState(s, 'triager')).runsLastHour;
      const given = await s.ok('POST', `${B}/items`, { title: 'already assigned', column: 'Backlog', assignee: 'someone' }, USER);
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal((await agentState(s, 'triager')).runsLastHour, runs, 'no run for a pre-assigned ticket');
      assert.deepEqual((await comments(s, given.id)).filter((c) => c.startsWith('triager:')), []);
    } finally { await s.stop(); }
  });
});

describe('standing agents retry safely', () => {
  it('a retry is told what the failed attempt did, and repeated writes are not duplicated', async () => {
    const marker = path.join(require('os').tmpdir(), `ia-flaky-${Date.now()}`);
    const s = await startServer({ agents: { defaults: fast, agents: { flaky2: { run: run('flaky-once', `"${marker}"`) } } } });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'retry test', column: 'Backlog' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@flaky2 go' }, USER);
      await until(async () => (await comments(s, it.id)).some((c) => c.startsWith('flaky2: retry saw')), 10000, 'retry');
      const mine = (await comments(s, it.id)).filter((c) => c.startsWith('flaky2:'));
      assert.deepEqual(mine, ['flaky2: picked this up', 'flaky2: retry saw earlier work: true']);
    } finally {
      await s.stop();
      require('fs').rmSync(marker, { force: true });
    }
  });
});

describe('a failed agent gets one more try (INT-295)', () => {
  it('after the cool-off its probe run succeeds, and it is back to normal with nothing from the human', async () => {
    const marker = path.join(os.tmpdir(), `ia-probe-${Date.now()}`);
    // failedRetryMinutes 0.05: the probe is due ~3 s after it failed, time enough to "fix the cause" first. The rules are in scheduler.test.js.
    const s = await startServer({ agents: { defaults: { ...fast, maxFailures: 1 }, agents: { mender: { run: run('fail-until', `"${marker}"`), failedRetryMinutes: 0.05 } } } });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'probe test', column: 'Backlog' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@mender go' }, USER);
      const failed = await until(async () => { const a = await agentState(s, 'mender'); return a.status === 'failed' ? a : null; }, 6000, 'failed');
      assert.ok(Date.parse(failed.probeAt) > Date.now() - 1000, 'it says when it tries again');
      const ev = (await s.ok('GET', '/api/events?types=agent.failed')).events;
      assert.equal(ev.at(-1).probeAt, failed.probeAt, 'agent.failed carries probeAt');
      fs.writeFileSync(marker, 'the cause passed');
      await until(async () => (await comments(s, it.id)).some((c) => c.startsWith('mender: handled')), 8000, 'the probe ran and handled the event');
      const after = await until(async () => { const a = await agentState(s, 'mender'); return a.status === 'idle' ? a : null; }, 4000, 'idle');
      assert.deepEqual([after.failures, after.probeAt, after.probing], [0, undefined, undefined]);
    } finally {
      await s.stop();
      fs.rmSync(marker, { force: true });
    }
  });
});

describe('the usage limit', () => {
  it('a run refused for the usage limit is no failure: the agent and its account mates wait for the reset, then run (INT-293)', async () => {
    const marker = path.join(os.tmpdir(), `ia-limited-${Date.now()}`);
    const s = await startServer({ agents: { defaults: { ...fast, maxFailures: 1 }, agents: {
      lim: { run: run('limited', `"${marker}"`, 3), provider: 'acme' },
      mate: { run: run('ok'), provider: 'acme' }, // same account: waits too, without a run of its own
      other: { run: run('ok'), provider: 'elsewhere' }, // another account: unaffected
    } } });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'limit test', column: 'Backlog' }, USER);
      const seq = (await s.ok('GET', '/api/events?tail=true')).cursor;
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@lim go' }, USER);
      const lim = await until(async () => { const a = await agentState(s, 'lim'); return a.status === 'waiting' && a.waitingFor === 'usage limit' ? a : null; }, 6000, 'lim waits for the limit');
      assert.equal(lim.failures, 0, 'a refused run is not a failure');
      assert.equal(lim.queued, 1, 'its events wait for the reset');
      assert.ok(Date.parse(lim.resumesAt) > Date.now(), 'it says when it runs again');
      assert.ok((await agentState(s, 'mate')).limitedUntil, 'the account mate is held too');
      assert.equal((await agentState(s, 'other')).limitedUntil, null, 'another account is not');
      const ev = (await s.ok('GET', `/api/events?since=${seq}&types=agent.usage_limited`)).events;
      assert.deepEqual(ev.map((e) => [e.agent, e.provider, e.agents]), [['lim', 'acme', ['lim', 'mate']]]);
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@mate and @other too' }, USER);
      await until(async () => (await comments(s, it.id)).some((c) => c.startsWith('other: handled')), 6000, 'other runs at once');
      assert.equal((await agentState(s, 'mate')).status, 'waiting', 'mate waits for the reset instead of spending a run');
      assert.ok(!(await comments(s, it.id)).some((c) => c.startsWith('lim:') || c.startsWith('mate:')));
      // after the reset both run by themselves, with nothing from the human
      await until(async () => { const c = await comments(s, it.id); return c.some((x) => x.startsWith('lim: handled')) && c.some((x) => x.startsWith('mate: handled')); }, 12000, 'both run after the reset');
      const after = await agentState(s, 'lim');
      assert.equal(after.failures, 0);
      assert.equal(after.limitedUntil, null);
    } finally {
      await s.stop();
      fs.rmSync(marker, { force: true });
    }
  });
});

describe('standing agents survive a reboot', () => {
  it('retries the run that was cut off, telling the agent it was interrupted', async () => {
    let s = await startServer({ agents: { defaults: fast, agents: { worker: { run: run('slow', 1500) } } } });
    const it = await s.ok('POST', `${B}/items`, { title: 'reboot test', column: 'Backlog' }, USER);
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@worker start' }, USER);
    await until(async () => (await agentState(s, 'worker')).status === 'running', 4000, 'running');
    const dir = s.dir;
    await s.stop({ keep: true }); // the run dies with it (or posts to a dead port)
    await new Promise((r) => setTimeout(r, 1800));

    s = await startServer({ dir, agents: { defaults: { ...fast }, agents: { worker: { run: run('ok') } } } });
    try {
      await until(async () => (await comments(s, it.id)).some((c) => c === 'worker: handled 1 event(s) (resumed after interruption)'), 8000, 'resumed run');
    } finally { await s.stop(); }
  });
});

describe('standing agents pick up work already on the board', () => {
  it('on board start: assigned work wakes its agent, the receptionist sees unassigned tickets, and nothing loops', async () => {
    let s = await startServer({ agents: { agents: {} } });
    const loose = await s.ok('POST', `${B}/items`, { title: 'nobody owns this', column: 'Backlog' }, USER);
    const owned = await s.ok('POST', `${B}/items`, { title: 'for the builder', column: 'Backlog', assignee: 'maker' }, USER);
    const dir = s.dir;
    await s.stop({ keep: true });

    s = await startServer({ dir, agents: { defaults: fast, agents: {
      desk: { role: 'coordinator', run: run('ok') }, maker: { run: run('ok') }, idle: { run: run('ok') },
    } } });
    try {
      const started = async (name) => (await s.ok('GET', '/api/events?types=agent.run.started')).events.filter((e) => e.agent === name);
      await until(async () => (await started('maker')).length && (await started('desk')).length, 8000, 'pending wakes');
      assert.deepEqual((await started('maker'))[0].items, [owned.id], 'assigned work wakes its agent');
      const deskItems = (await started('desk'))[0].items;
      assert.ok(deskItems.includes(loose.id) && !deskItems.includes(owned.id), 'the receptionist sees unassigned tickets only');
      const deskWork = await s.ok('GET', `${B}/work?agent=desk`);
      assert.deepEqual(deskWork.triage.map((x) => x.id), [loose.id], 'its brief lists the same tickets');
      assert.equal((await s.ok('GET', `${B}/work?agent=idle`)).triage, undefined, 'other agents have no triage list');
      await until(async () => (await agentState(s, 'maker')).status === 'idle' && (await agentState(s, 'desk')).status === 'idle', 4000, 'idle');
      assert.equal((await agentState(s, 'maker')).lastRun.why, 'work.pending');
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal((await started('maker')).length, 1, 'untouched work does not wake it again');
      assert.equal((await started('desk')).length, 1);
      assert.equal((await started('idle')).length, 0, 'agents with nothing waiting stay asleep');
    } finally { await s.stop(); }
  });

  it('a builder\'s queue is offered after a run that started nothing, never loops, and comes back once it finishes a ticket', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: { maker: { run: run('ok') } } } });
    const MAKER = { agent: 'maker' };
    try {
      const runs = async () => (await s.ok('GET', '/api/events?types=agent.run.started')).events.filter((e) => e.agent === 'maker');
      const settled = async (n, label) => {
        await until(async () => (await runs()).length === n && (await agentState(s, 'maker')).status === 'idle', 8000, label);
        await new Promise((r) => setTimeout(r, 1200));
        assert.equal((await runs()).length, n, `${label}: nothing more wakes it`);
      };
      // The assignment wakes it; that run (a script, like one answering a comment) starts nothing. Before, its
      // brief counted the queue as seen, and the ticket waited for good.
      const queued = await s.ok('POST', `${B}/items`, { title: 'in the queue', column: 'Backlog', assignee: 'maker' }, USER);
      await settled(2, 'queue offered after the assignment run');
      const [, offer] = await runs();
      assert.equal(offer.why, 'work.pending');
      assert.deepEqual(offer.items, [queued.id]);
      // A comment wakes it again; the queue it already saw and left alone stays quiet
      await s.ok('POST', `${B}/items/${queued.id}/comments`, { body: '@maker a note' }, USER);
      await settled(3, 'a comment run');
      // It finishes another ticket: free again, so the queue is offered again, once
      const other = await s.ok('POST', `${B}/items`, { title: 'its current work', column: 'Backlog' }, USER);
      await s.ok('POST', `${B}/items/${other.id}/lease`, { minutes: 10 }, MAKER);
      await s.ok('POST', `${B}/items/${other.id}/review`, { summary: 'done', evidence: 'tests pass' }, MAKER);
      await s.ok('POST', `${B}/items/${other.id}/comments`, { body: '@maker thanks' }, USER);
      await settled(5, 'queue offered again after a finished ticket');
      const last = (await runs()).at(-1);
      assert.equal(last.why, 'work.pending');
      assert.deepEqual(last.items, [queued.id]);
    } finally { await s.stop(); }
  });

  it('a blocked ticket in a builder\'s queue wakes nobody until its blocker is done, and stays listed as blocked (INT-273)', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: { maker: { run: run('ok') } } } });
    try {
      const runs = async () => (await s.ok('GET', '/api/events?types=agent.run.started')).events.filter((e) => e.agent === 'maker');
      const settled = async (n, label) => {
        await until(async () => (await runs()).length === n && (await agentState(s, 'maker')).status === 'idle', 8000, label);
        await new Promise((r) => setTimeout(r, 1200));
        assert.equal((await runs()).length, n, `${label}: nothing more wakes it`);
      };
      const blocker = await s.ok('POST', `${B}/items`, { title: 'the blocker', column: 'Backlog' }, USER);
      const waits = await s.ok('POST', `${B}/items`, { title: 'waits on it', column: 'Backlog', assignee: 'maker', blockedBy: [blocker.id] }, USER);
      // The assignment wakes it once; the queue is not offered on top, since it can't start a blocked ticket
      await settled(1, 'the assignment only');
      const next = (await s.ok('GET', `${B}/work?agent=maker`)).next.find((n) => n.id === waits.id);
      assert.equal(next?.action, 'start');
      assert.match(next.why, new RegExp(`blocked by ${blocker.id}`), 'the brief still lists it, marked as blocked');
      // The blocker is done: item.unblocked wakes the assignee, and the queue is offered once, as after an assignment
      await s.ok('POST', `${B}/items/${blocker.id}/move`, { column: 'Done' }, USER);
      await settled(3, 'unblocked');
      const [, woke, offer] = await runs();
      assert.deepEqual(woke.items, [waits.id], 'item.unblocked wakes the assignee');
      assert.equal(offer.why, 'work.pending');
      assert.deepEqual(offer.items, [waits.id]);
      assert.equal((await s.ok('GET', `${B}/work?agent=maker`)).next.find((n) => n.id === waits.id)?.why, 'Assigned to you');
    } finally { await s.stop(); }
  });

  it('the idle-board alarm reaches its agent through a real board: what waits, from the pickup columns, and how the builders stand', async () => {
    // idleAlarmMinutes 0.03: due ~1.8 s after the board starts. The timing rules are in scheduler.test.js.
    const s = await startServer({ agents: { defaults: fast, agents: {
      worker: { run: run('ok'), worktree: true },
      watch: { run: run('ok'), idleAlarm: true, idleAlarmMinutes: 0.03 },
    } } });
    try {
      const alarms = async () => (await s.ok('GET', '/api/events?types=agent.run.started')).events.filter((e) => e.agent === 'watch' && e.why === 'board.idle');
      const waiting = await s.ok('POST', `${B}/items`, { title: 'nobody started this', column: 'Ready' }, USER);
      await s.ok('POST', `${B}/items`, { title: 'parked', column: 'Backlog' }, USER);
      await until(async () => (await alarms()).length === 1, 8000, 'alarm');
      const log = (await s.ok('GET', '/api/agents/watch/log', undefined, USER)).log;
      assert.match(log, /board\.idle — no builder has run for \d+ min, yet 1 ticket\(s\) wait/, 'Backlog is not waiting work');
      assert.match(log, new RegExp(`${waiting.id} "nobody started this" — unassigned`));
      assert.match(log, /builders: worker idle/);
      // kept on the board: the Agents page lists it, the metrics count it
      await until(async () => (await s.ok('GET', `${B}/idle-alarm`)).recent.length === 1, 4000, 'recorded');
      const rec = (await s.ok('GET', `${B}/idle-alarm`)).recent[0];
      assert.deepEqual([rec.woke, rec.waiting, rec.repeat], [['watch'], [waiting.id], 1]);
      const m = await s.ok('GET', `${B}/metrics?days=7`);
      assert.equal(m.idle.alarms, 1);
      assert.equal(m.idle.prev, 0);
      assert.ok(m.idle.longestMinutes >= 0);
    } finally { await s.stop(); }
  });

  it('the idle-board alarm is a board setting: the human picks who it wakes and a note for them; agents.json flags are the fallback', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: {
      worker: { run: run('ok'), worktree: true, enabled: false },
      lander: { run: run('ok'), idleAlarm: true, idleAlarmMinutes: 30, enabled: false },
      lead: { run: run('ok'), enabled: false },
    } } });
    try {
      const before = await s.ok('GET', `${B}/idle-alarm`);
      assert.deepEqual([before.on, before.minutes, before.wake, before.from], [true, 30, ['lander'], 'agents.json'], 'until the human sets it, agents.json decides');
      assert.deepEqual(before.agents.sort(), ['lander', 'lead', 'worker']);
      assert.equal((await s.api('PUT', `${B}/idle-alarm`, { on: false }, { agent: 'lead' })).status, 403, 'human only');
      for (const bad of [{ minutes: 2 }, { minutes: 20.5 }, { wake: ['nobody'] }, { on: true, wake: [] }, { note: 'x'.repeat(1001) }, { on: 'yes' }]) {
        assert.ok([400].includes((await s.api('PUT', `${B}/idle-alarm`, bad, USER)).status), JSON.stringify(bad).slice(0, 40));
      }
      const set = await s.ok('PUT', `${B}/idle-alarm`, { wake: ['lead'], minutes: 45, note: 'Nudge the assignees first; ask Gamora for anything unassigned.' }, USER);
      assert.deepEqual([set.on, set.minutes, set.wake, set.from], [true, 45, ['lead'], 'settings']);
      assert.equal(set.note, 'Nudge the assignees first; ask Gamora for anything unassigned.');
      const off = await s.ok('PUT', `${B}/idle-alarm`, { on: false }, USER);
      assert.deepEqual([off.on, off.wake], [false, ['lead']], 'switching off keeps who it wakes');
    } finally { await s.stop(); }
  });

  // The planner's rails are unit tests below and the scheduler's timing in scheduler.test.js; these go through a board.
  const LEAD = { agent: 'lead' };
  const queued = async (s, title, to, by = LEAD) => {
    const t = await s.ok('POST', `${B}/items`, { title, column: 'Ready' }, USER);
    await s.ok('PATCH', `${B}/items/${t.id}`, { assignee: to }, by);
    return t.id;
  };
  const item = (s, id) => s.ok('GET', `${B}/items/${id}`);

  // removalGraceMinutes: 0, so the pass made at the removal moves the queue (the ten minutes' grace is in scheduler.test.js)
  it('rebalancing (INT-234): a removed agent\'s queue moves after the grace, as the system, waking only each new owner; a pin goes with it; work it started stays', async () => {
    const s = await startServer({ manifest: { removalGraceMinutes: 0 }, agents: { defaults: fast, agents: {
      rocket: { run: run('ok'), worktree: true }, drax: { run: run('ok'), worktree: true }, leaving: { run: run('ok'), worktree: true },
    } } });
    try {
      const a = await queued(s, 'first in its queue', 'leaving');
      const b = await queued(s, 'second', 'leaving');
      const byHand = await queued(s, 'the human gave it this', 'leaving', USER);
      await s.ok('POST', `${B}/items/${byHand}/pin`, undefined, USER);
      const begun = await queued(s, 'it started this one', 'leaving');
      await s.ok('POST', `${B}/items/${begun}/lease`, { minutes: 5 }, { agent: 'leaving' });
      await s.ok('DELETE', `${B}/items/${begun}/lease`, undefined, { agent: 'leaving' });
      assert.deepEqual((await s.ok('GET', `${B}/rebalance`)).recent, [], 'nothing moves while the team is unchanged');

      await s.ok('DELETE', '/api/agents/leaving', undefined, USER);
      await until(async () => (await s.ok('GET', `${B}/rebalance`)).recent.length === 1, 8000, 'a pass after the removal');
      const pass = (await s.ok('GET', `${B}/rebalance`)).recent[0];
      assert.equal(pass.reason, 'agents.changed');
      assert.deepEqual(pass.moves.map((m) => m.id).sort(), [a, b, byHand].sort(), 'all its unstarted tickets, even the human\'s: that agent is gone');
      assert.equal((await item(s, begun)).assignee, 'leaving', 'started work is never moved');
      for (const id of [a, b, byHand]) {
        const t = await item(s, id);
        assert.ok(['rocket', 'drax'].includes(t.assignee));
        assert.deepEqual([t.assignedBy.kind, t.rebalanced.from, t.rebalanced.why], ['system', 'leaving', 'leaving was removed']);
        const c = t.comments.at(-1);
        const note = id === byHand ? ' (was pinned to leaving; not pinned now)' : '';
        assert.deepEqual([c.author.kind, c.body], ['system', `↔ Moved from leaving to ${t.assignee}: leaving was removed${note}.`]);
        assert.equal(t.pinned, undefined, 'never pinned to an owner the board picked');
      }
      assert.equal((await item(s, byHand)).rebalanced.unpinned, true);
      // the board's own notes make nobody a thread participant
      const later = await s.ok('POST', `${B}/items/${a}/comments`, { body: 'a later word' }, USER);
      const ev = (await s.ok('GET', `/api/events?itemId=${a}&types=comment.added`)).events.find((e) => e.comment?.id === later.id);
      assert.ok(!ev.recipients.includes('rebalance'), JSON.stringify(ev.recipients));
      const evs = (await s.ok('GET', `/api/events?itemId=${a}`)).events;
      const moved = evs.find((e) => e.type === 'item.assigned' && e.actor.kind === 'system');
      assert.deepEqual(moved.addressed, [(await item(s, a)).assignee], 'the assignment wakes the new owner and nobody else');
      assert.equal(evs.find((e) => e.type === 'comment.added' && e.actor.kind === 'system').addressed, undefined, 'the ↔ comment wakes nobody');
      const digest = (await s.ok('GET', `${B}/digest?days=1`))[0].entries.find((e) => e.author.name === 'rebalance');
      assert.match(digest.summary, /^↔ Rebalanced 3 tickets: /);
    } finally { await s.stop(); }
  });

  it('rebalancing (INT-234): a real imbalance moves work; undo puts it back and pins it; the switch, pins and undo are the human\'s', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: {
      rocket: { run: run('ok'), worktree: true }, drax: { run: run('ok'), worktree: true },
      spare: { run: run('ok'), enabled: false }, other: { run: run('ok'), enabled: false },
    } } });
    try {
      const fresh = await s.ok('GET', `${B}/rebalance`);
      assert.deepEqual([fresh.on, fresh.minGap, fresh.minWaitMinutes, fresh.maxMoves, fresh.onceEveryMinutes], [true, 3, 60, 3, 1440], 'a board without the setting: on, with the defaults');
      assert.equal((await s.api('PUT', `${B}/rebalance`, { on: false }, LEAD)).status, 403, 'human only');
      for (const bad of [{ on: 'no' }, { minGap: 1 }, { maxMoves: 2.5 }, { onceEveryMinutes: 10 }]) assert.equal((await s.api('PUT', `${B}/rebalance`, bad, USER)).status, 400, JSON.stringify(bad));
      await s.ok('PUT', `${B}/rebalance`, { minWaitMinutes: 0, minGap: 2 }, USER);
      const ids = [];
      for (const n of [1, 2, 3, 4]) ids.push(await queued(s, `rocket's ${n}`, 'rocket'));
      const pinned = await queued(s, 'pinned', 'rocket');
      assert.equal((await s.api('POST', `${B}/items/${pinned}/pin`, undefined, LEAD)).status, 403, 'an agent cannot pin');
      assert.equal((await s.api('PATCH', `${B}/items/${pinned}`, { pinned: { by: 'lead' } }, LEAD)).status, 400, 'nor through PATCH');
      await s.ok('POST', `${B}/items/${pinned}/pin`, undefined, USER);
      // Stop all and resume ask for nothing
      await s.ok('POST', '/api/agents/stop-all', {}, USER);
      await s.ok('POST', '/api/agents/resume-all', {}, USER);

      await s.ok('DELETE', '/api/agents/spare', undefined, USER); // a change to the team: a pass now
      await until(async () => (await s.ok('GET', `${B}/rebalance`)).recent.length === 1, 8000, 'a pass');
      const { moves } = (await s.ok('GET', `${B}/rebalance`)).recent[0];
      // 5 vs 0: the gap closes to 3 vs 2, and never so far that the next pass would move one back
      assert.equal(moves.length, 2);
      assert.ok(moves.every((m) => m.from === 'rocket' && m.to === 'drax' && ids.includes(m.id)), 'the pinned one stays');
      assert.match(moves[0].why, /^rocket had 5 queued, drax 0$/);

      const back = moves[0].id;
      assert.equal((await s.api('POST', `${B}/items/${back}/rebalance/undo`, undefined, LEAD)).status, 403, 'an agent cannot undo');
      const undone = await s.ok('POST', `${B}/items/${back}/rebalance/undo`, undefined, USER);
      assert.deepEqual([undone.assignee, undone.pinned.by, undone.assignedBy.kind], ['rocket', 'James', 'user']);
      assert.equal((await s.api('POST', `${B}/items/${back}/rebalance/undo`, undefined, USER)).status, 409, 'nothing left to undo');
      // the new owner started the other one: undo would leave two owners
      const kept = moves[1].id;
      await s.ok('POST', `${B}/items/${kept}/lease`, { minutes: 5 }, { agent: 'drax' });
      const held = await s.api('POST', `${B}/items/${kept}/rebalance/undo`, undefined, USER);
      assert.deepEqual([held.status, held.body.code], [409, 'CONFLICT']);
      assert.match(held.body.error, /drax holds it/);
      assert.match(held.body.hint, /Reassign it by hand/);
      await s.ok('DELETE', `${B}/items/${kept}/lease`, undefined, { agent: 'drax' });
      const worked = await s.api('POST', `${B}/items/${kept}/rebalance/undo`, undefined, USER);
      assert.equal(worked.status, 409, 'released, but drax has worked it');
      assert.match(worked.body.error, /drax has started it/);
      assert.equal((await item(s, kept)).assignee, 'drax');
      // PUT stores only what was sent: the keys never set keep following the defaults
      const stored = () => JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'boards', 'main', 'board.json'), 'utf8')).rebalance;
      assert.deepEqual(stored(), { minWaitMinutes: 0, minGap: 2 });

      // switched off: a change to the team moves nothing
      await s.ok('PUT', `${B}/rebalance`, { on: false }, USER);
      assert.deepEqual(stored(), { minWaitMinutes: 0, minGap: 2, on: false });
      await s.ok('DELETE', '/api/agents/other', undefined, USER);
      await new Promise((r) => setTimeout(r, 3500));
      assert.equal((await s.ok('GET', `${B}/rebalance`)).recent.length, 1);
    } finally { await s.stop(); }
  });
});

describe('model tiers', () => {
  it('model reaches a claude run as --model; an explicit --model or a non-claude run is left alone; the receptionist sees the team', async () => {
    const s = await startServer({ agents: { defaults: { ...fast, model: 'sonnet' }, agents: {
      desk: { role: 'coordinator', enabled: false, run: run('ok') },
      junior: { role: 'builder', model: 'haiku', enabled: false, description: 'small tickets' },
      mid: { role: 'builder', enabled: false },
      pinned: { run: 'claude -p "x" --model opus', model: 'haiku', enabled: false },
      scripted: { run: run('ok'), model: 'haiku', enabled: false },
      seeker: { role: 'reviewer', model: 'deepseek-chat', provider: 'deepseek', enabled: false, run: run('ok') },
    } } });
    try {
      const a = async (n) => s.ok('GET', `/api/agents/${n}`);
      const j = await a('junior');
      assert.match(j.run, / --model haiku$/);
      assert.equal(j.tier, 'junior');
      assert.match((await a('mid')).run, / --model sonnet$/, 'defaults.model applies');
      assert.equal((await a('pinned')).run, 'claude -p "x" --model opus', 'an explicit --model wins');
      assert.doesNotMatch((await a('scripted')).run, /--model/, 'non-claude runs are left alone');
      assert.equal((await s.api('POST', '/api/agents', { name: 'evil', role: 'builder', model: 'haiku; rm -rf /' }, USER)).status, 400);
      await s.ok('POST', '/api/agents', { name: 'senior', role: 'builder', model: 'opus' }, USER);
      assert.match((await a('senior')).run, / --model opus$/);
      const brief = (await s.api('GET', '/api/boards/main/brief', undefined, { agent: 'desk' })).body;
      const text = typeof brief === 'string' ? brief : brief.markdown;
      assert.match(text, /Agents you can route to/);
      assert.match(text, /\*\*junior\*\* · builder · haiku \(junior\)/);
      assert.match(text, /\*\*seeker\*\* · reviewer · deepseek-chat · deepseek/, 'the team line shows the provider beside the model (INT-255)');
    } finally { await s.stop(); }
  });
});

describe('what agents are doing', () => {
  it('now: since, why, items and the newest status line; a leaseless line of your own that wakes nobody and ends with the run', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: { sleepy2: { run: run('slow', 2500) }, watcher: { run: run('ok'), listen: { types: 'agent.activity' } } } } });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'now test', column: 'Backlog' }, USER);
      const { seq } = await s.ok('GET', '/api/app');
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@sleepy2 have a look' }, USER);
      const a = await until(async () => { const x = await agentState(s, 'sleepy2'); return x.now ? x : null; }, 4000, 'running');
      assert.deepEqual([a.now.since, a.now.why, a.now.items, a.now.line], [a.runningSince, 'comment.added', [it.id], null]);
      const started = (await s.ok('GET', `/api/events?since=${seq}&types=agent.run.started`)).events.find((e) => e.agent === 'sleepy2');
      assert.equal(started.why, 'comment.added', 'the live event says why');

      assert.equal((await s.api('PUT', '/api/profiles/me/status', { status: 'x' }, USER)).status, 403, 'people have no run line');
      await s.ok('PUT', '/api/profiles/me/status', { status: 'triaging', items: ['int-99'] }, { agent: 'sleepy2' });
      await s.ok('PUT', '/api/profiles/me/status', { status: 'triaging 2/4' }, { agent: 'sleepy2' });
      let now = (await agentState(s, 'sleepy2')).now;
      assert.deepEqual([now.line, now.items], ['triaging 2/4', [it.id]], 'the newest line; items from the newest call');
      const lines = await until(async () => {
        const evs = (await s.ok('GET', `/api/events?since=${seq}&types=agent.activity`)).events;
        return evs.length >= 2 ? evs : null;
      }, 4000, 'throttled line arrives');
      assert.deepEqual(lines.map((e) => e.line), ['triaging', 'triaging 2/4'], 'two quick lines: the first now, the newest after the gap');
      assert.ok(lines.every((e) => !e.recipients.length && !e.addressed), 'agent.activity is for nobody');

      // a ticket it holds: its lease status counts too, the newest one wins
      await s.ok('POST', `${B}/items/${it.id}/lease`, { status: 'reading the diff' }, { agent: 'sleepy2' });
      now = (await agentState(s, 'sleepy2')).now;
      assert.equal(now.line, 'reading the diff');

      const done = await until(async () => { const x = await agentState(s, 'sleepy2'); return x.status === 'idle' ? x : null; }, 8000, 'run over');
      assert.equal(done.now, null);
      assert.deepEqual(done.history.map((h) => [h.code, h.why, h.items]), [[0, 'comment.added', [it.id]]]);
      const cleared = await until(async () => (await s.ok('GET', `/api/events?since=${seq}&types=agent.activity`)).events.find((e) => e.line === null), 3000, 'line cleared');
      assert.equal(cleared.agent, 'sleepy2');
      const w = await agentState(s, 'watcher');
      assert.deepEqual([w.history.length, w.queued], [0, 0], 'even an agent listening for agent.activity is never woken by it');

      const { recent } = await s.ok('GET', '/api/agents?recent=10');
      assert.deepEqual(recent[0].agent, 'sleepy2', 'newest run first, across agents');
      assert.equal((await s.ok('GET', '/api/agents')).recent, undefined, 'only when asked');
    } finally { await s.stop(); }
  });

  it('keeps the last 10 runs per agent', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: { busybee: { run: run('ok') } } } });
    try {
      const starts = [];
      for (let i = 0; i < 11; i++) {
        const before = (await agentState(s, 'busybee')).lastRun?.startedAt;
        await s.ok('POST', '/api/agents/busybee/run', {}, USER);
        const a = await until(async () => { const x = await agentState(s, 'busybee'); return x.lastRun?.endedAt && x.lastRun.startedAt !== before ? x : null; }, 6000, `run ${i + 1}`);
        starts.push(a.lastRun.startedAt);
      }
      const h = (await agentState(s, 'busybee')).history;
      assert.deepEqual(h.map((x) => x.startedAt), starts.slice(1), 'the 10 newest, the first run dropped');
      assert.ok(h.every((x, i) => !i || x.startedAt >= h[i - 1].startedAt), 'oldest first');
    } finally { await s.stop(); }
  });

  it('a run started by an agent with agents.control names that agent, not the human (INT-126)', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: { boss: { enabled: false, grants: ['agents.control'] }, poked: { run: run('ok') } } } });
    try {
      const pokes = async () => {
        const dir = path.join(s.dir, 'data', 'agent-runs', 'poked');
        await until(async () => (await agentState(s, 'poked')).lastRun?.endedAt, 6000, 'run over');
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.events.json')).sort();
        return JSON.parse(fs.readFileSync(path.join(dir, files.at(-1)), 'utf8')).filter((e) => e.type === 'agent.poke');
      };
      await s.ok('POST', '/api/agents/poked/run', { note: 'from boss' }, { agent: 'boss' });
      assert.deepEqual((await pokes()).map((e) => e.actor), [{ kind: 'agent', name: 'boss' }]);
      const before = (await agentState(s, 'poked')).lastRun.startedAt;
      await s.ok('POST', '/api/agents/poked/run', {}, USER);
      await until(async () => (await agentState(s, 'poked')).lastRun?.startedAt !== before, 6000, 'second run');
      assert.deepEqual((await pokes()).map((e) => e.actor), [{ kind: 'user', name: 'James' }]);
    } finally { await s.stop(); }
  });
});

describe('keep-alive standing agents', () => {
  it('one process serves several wakes as turns, is recycled after recycleAfterRuns, restarts after a crash and stops on pause', async () => {
    const marker = path.join(require('os').tmpdir(), `ia-crash-${Date.now()}`);
    const s = await startServer({ agents: { defaults: fast, agents: {
      keeper: { role: 'builder', run: run('stream'), keepAlive: 'stream-json', recycleAfterRuns: 2, throttleMinutes: 0 },
      crashy: { run: run('stream', `"${marker}"`), keepAlive: 'stream-json' },
    } } });
    const pidOf = (c) => Number(/pid (\d+)/.exec(c)?.[1]);
    const mine = async (id, who) => (await comments(s, id)).filter((c) => c.startsWith(`${who}: turn`));
    const idle = (who) => until(async () => (await agentState(s, who)).status === 'idle', 30000, `${who} idle`);
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'keep-alive', column: 'Backlog' }, USER);
      for (let n = 1; n <= 3; n++) {
        await s.ok('POST', `${B}/items/${it.id}/comments`, { body: `@keeper wake ${n}` }, USER);
        await until(async () => (await mine(it.id, 'keeper')).length === n, 30000, `turn ${n}`);
        await idle('keeper');
      }
      const [t1, t2, t3] = await mine(it.id, 'keeper');
      assert.match(t1, /turn 1 in/);
      assert.match(t2, /turn 2 in/);
      assert.equal(pidOf(t1), pidOf(t2), 'the second wake is a turn in the same process');
      assert.match(t3, /turn 1 in/, 'recycled after 2 turns: a fresh process');
      // only the first turn of a session carries the role brief and the rules; later turns get the short prompt
      assert.ok(t1.endsWith('(full+role)'), t1);
      assert.ok(t2.endsWith('(short)'), `turn 2 gets the short prompt, without the role brief: ${t2}`);
      assert.ok(t3.endsWith('(full+role)'), `a recycled session starts with the full prompt again: ${t3}`);
      assert.notEqual(pidOf(t3), pidOf(t1));
      assert.equal((await agentState(s, 'keeper')).session.turns, 1);
      await s.ok('POST', '/api/agents/keeper/pause', {}, USER);
      assert.equal((await agentState(s, 'keeper')).session, null, 'pausing stops the session');

      const c = await s.ok('POST', `${B}/items`, { title: 'crash', column: 'Backlog' }, USER);
      await s.ok('POST', `${B}/items/${c.id}/comments`, { body: '@crashy go' }, USER);
      await until(async () => (await mine(c.id, 'crashy')).length === 1, 30000, 'retried in a new process');
      assert.equal((await agentState(s, 'crashy')).failures, 0);
    } finally {
      await s.stop();
      require('fs').rmSync(marker, { force: true });
    }
  });
});

describe('one agent, one process', () => {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const pids = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);

  it('keep-alive: a retry after a failed turn waits for the ended session to exit (INT-199)', async () => {
    const f = path.join(os.tmpdir(), `ia-linger-${Date.now()}`);
    const s = await startServer({ agents: { defaults: fast, agents: { twice: { run: run('stream-linger', `"${f}"`, 2000), keepAlive: 'stream-json' } } } });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'linger', column: 'Backlog' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@twice go' }, USER);
      await until(async () => (await comments(s, it.id)).some((c) => c.startsWith('twice: lingered')), 15000, 'retried turn');
      const lines = pids(f);
      assert.equal(lines.length, 2, `one session per attempt: ${lines}`);
      assert.ok(!lines.some((l) => l.startsWith('overlap')), `the retry started while the failed session still ran: ${lines}`);
    } finally {
      await s.stop();
      for (const x of [f, `${f}.err`]) fs.rmSync(x, { force: true });
    }
  });

  it('a board restart stops the run that outlived it before starting the retry (INT-196)', async () => {
    const f = path.join(os.tmpdir(), `ia-restart-${Date.now()}`);
    const agents = { defaults: fast, agents: { survivor: { run: run('linger', `"${f}"`, 8000) } } };
    // the backstop for a run the guard missed (INT-262): without the guard, a run outlives a board that dies
    const env = { INTELLAGENT_RUN_GUARD: 'off' };
    let s = await startServer({ agents, env });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'restart', column: 'Backlog' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@survivor go' }, USER);
      await until(() => fs.existsSync(f), 8000, 'first run started');
      const first = Number(pids(f)[0]);
      const dir = s.dir;
      await s.stop({ keep: true, hard: true }); // a crash: no clean stop, so nothing kills the run
      assert.ok(alive(first), 'the run outlived its board');
      s = await startServer({ dir, agents, env });
      await until(() => pids(f).length >= 2, 15000, 'retried run');
      const lines = pids(f);
      assert.ok(!lines.some((l) => l.startsWith('overlap')), `two runs at once: ${lines}\n${s.log()}`);
      assert.ok(!alive(first), 'the run from before the restart was stopped');
      assert.match(s.log(), /still alive .*stopping it/);
    } finally {
      await s.stop();
      fs.rmSync(f, { force: true });
    }
  });

  it('a board that dies takes its runs and their children with it, keep-alive sessions too, and the helper is built once (INT-262)', async () => {
    const one = path.join(os.tmpdir(), `ia-family-${Date.now()}`);
    const live = `${one}-live`;
    const agents = { defaults: fast, agents: {
      orphan: { run: run('family', `"${one}"`, 60000) },
      lifer: { run: run('family', `"${live}"`, 60000), keepAlive: 'stream-json' },
    } };
    // this board builds its own helper, in its data folder
    const env = { INTELLAGENT_RUN_GUARD_BIN: '' };
    let s = await startServer({ agents, env });
    const all = [];
    try {
      await until(() => /run guard: on/.test(s.log()), 120000, `guard up:\n${s.log()}`); // the first build may take a while
      if (process.platform === 'win32') assert.match(s.log(), /run guard: built/);
      const it = await s.ok('POST', `${B}/items`, { title: 'family', column: 'Backlog' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@orphan @lifer go' }, USER);
      for (const f of [one, live]) await until(() => fs.existsSync(f) && pids(f).length === 2, 15000, `run and child started (${f})`);
      all.push(...pids(one).map(Number), ...pids(live).map(Number));
      assert.ok(all.every(alive), 'all four are running');
      const dir = s.dir;
      await s.stop({ keep: true, hard: true }); // TerminateProcess on Windows: no clean stop, no new board
      await until(() => !all.some(alive), 10000, `the runs and their children ended with the board: ${all.filter(alive)}`);
      // the same board started again reuses the helper it built
      s = await startServer({ dir, agents: { defaults: fast, agents: {} }, env });
      await until(() => /run guard: on/.test(s.log()), 30000, `guard up again:\n${s.log()}`);
      assert.doesNotMatch(s.log(), /run guard: built/);
    } finally {
      await s.stop().catch(() => {});
      for (const p of all) try { process.kill(p); } catch { /* gone */ }
      for (const f of [one, live]) fs.rmSync(f, { force: true });
    }
  });
});

describe('the run guard falls back (INT-262)', () => {
  const { createGuard } = require('../lib/agents/guard');
  const win = process.platform === 'win32';

  it('without csc.exe, or when the build fails, runs start unchanged and the log says why once', { skip: !win && 'the helper is built on Windows only' }, async () => {
    for (const [csc, why] of [[path.join(os.tmpdir(), 'no-such', 'csc.exe'), /no csc\.exe/], [process.execPath, /building the helper .* failed/]]) {
      const lines = [];
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-guard-'));
      const g = createGuard({ log: (l) => lines.push(l), binDir, csc });
      try {
        g.start();
        await until(() => lines.length > 0, 60000, 'a log line');
        assert.equal(lines.length, 1, lines.join('\n'));
        assert.match(lines[0], why);
        assert.match(lines[0], /Runs start as before/);
        assert.equal(g.wrap('claude -p go'), 'claude -p go', 'the command is untouched');
        g.add({ pid: process.pid }); // no helper: a no-op, never a throw
        assert.equal(g.status().on, false);
        assert.match(g.status().why, why);
      } finally { g.stop(); fs.rmSync(binDir, { recursive: true, force: true }); }
    }
  });

  it('off (a sandbox, or INTELLAGENT_RUN_GUARD=off) starts nothing and leaves commands alone', () => {
    const lines = [];
    const g = createGuard({ log: (l) => lines.push(l), off: true });
    g.start();
    assert.equal(g.wrap('claude -p go'), 'claude -p go');
    assert.deepEqual(lines, []);
    assert.deepEqual(g.status(), { on: false, why: null });
  });
});

describe('keep-alive recycling by context size', () => {
  it('replaces a session once its context per call passes recycleAboveTokens, and reports the size', async () => {
    // the fake agent's context grows 50k per turn: 50k, 100k, 150k
    const s = await startServer({ agents: { defaults: fast, agents: {
      fat: { role: 'builder', run: run('stream'), keepAlive: 'stream-json', recycleAboveTokens: 120000, throttleMinutes: 0 },
    } } });
    const mine = async (id) => (await comments(s, id)).filter((c) => c.startsWith('fat: turn'));
    const idle = () => until(async () => (await agentState(s, 'fat')).status === 'idle', 6000, 'fat idle');
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'context', column: 'Backlog' }, USER);
      for (let n = 1; n <= 3; n++) {
        await s.ok('POST', `${B}/items/${it.id}/comments`, { body: `@fat wake ${n}` }, USER);
        await until(async () => (await mine(it.id)).length === n, 30000, `turn ${n}`);
        await idle();
        if (n === 1) assert.equal((await agentState(s, 'fat')).session.context, 50010);
      }
      const [t1, t2, t3] = await mine(it.id);
      assert.match(t2, /turn 2 in/, 'still under the limit: same session');
      assert.match(t3, /turn 3 in/, 'turn 3 ran in the same session');
      assert.equal((await agentState(s, 'fat')).session, null, 'turn 3 read 150k per call: the session was ended');
      assert.ok(t1 && t2 && t3);
    } finally { await s.stop(); }
  });
});

describe('what a run inherits (INT-246)', () => {
  const { childEnv } = require('../lib/agents/runner');

  it('null in env removes a variable, inheritEnv keeps only what it lists, and the run\'s own variables always win', () => {
    process.env.IA_T_SECRET = 's';
    process.env.IA_T_KEEP = 'k';
    try {
      const all = childEnv({ run: 'claude -p go', env: { IA_T_SECRET: null, IA_T_ADD: 1 } }, { INTELLAGENT_URL: 'u' }, { INTELLAGENT_AGENT: 'me' });
      assert.equal(all.IA_T_SECRET, undefined, 'dropped');
      assert.equal(all.IA_T_KEEP, 'k', 'everything else is still inherited');
      assert.equal(all.IA_T_ADD, '1');
      const only = childEnv({ inheritEnv: ['IA_T_KEEP'], env: { INTELLAGENT_AGENT: 'spoof' } }, { INTELLAGENT_URL: 'u' }, { INTELLAGENT_AGENT: 'me' });
      assert.deepEqual(Object.keys(only).filter((k) => k.startsWith('IA_T_')), ['IA_T_KEEP']);
      assert.ok(Object.keys(only).some((k) => k.toUpperCase() === 'PATH'), 'a shell can still start');
      assert.equal(only.INTELLAGENT_URL, 'u', 'the board\'s own variables are not inherited, so inheritEnv never drops them');
      assert.equal(only.INTELLAGENT_AGENT, 'me', 'an agent cannot pose as another');
      if (process.platform === 'win32') assert.equal(childEnv({ run: 'claude -p go', env: { ia_t_secret: null } }, {}, {}).IA_T_SECRET, undefined, 'Windows names ignore case');
    } finally { delete process.env.IA_T_SECRET; delete process.env.IA_T_KEEP; }
  });

  it('a custom run inherits only what a shell needs unless inheritEnv adds names; a claude run still inherits everything (INT-260)', () => {
    const token = process.env.INTELLAGENT_TOKEN; // set when the suite itself runs inside an agent
    process.env.IA_T_API_KEY = 'secret';
    process.env.INTELLAGENT_TOKEN = 'the-boards-own';
    try {
      const shell = ['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].map((k) => k.toUpperCase());
      const fromBoard = (env) => Object.keys(env).filter((k) => k !== 'INTELLAGENT_URL' && k !== 'INTELLAGENT_AGENT');
      for (const run of ['node adapter.js', ['node', 'adapter.js'], 'C:/tools/claude.exe -p go', undefined]) {
        const env = childEnv({ run }, { INTELLAGENT_URL: 'u' }, { INTELLAGENT_AGENT: 'me' });
        const stray = fromBoard(env).filter((k) => !shell.includes(k.toUpperCase()));
        assert.deepEqual(stray, [], `${JSON.stringify(run)} inherits nothing beyond the shell's names`);
        assert.equal(env.INTELLAGENT_URL, 'u');
        assert.equal(env.INTELLAGENT_AGENT, 'me');
      }
      const widened = childEnv({ run: 'node adapter.js', inheritEnv: ['ia_t_api_key'] }, {}, {});
      assert.equal(process.platform === 'win32' ? widened.IA_T_API_KEY : widened.ia_t_api_key, process.platform === 'win32' ? 'secret' : undefined,
        'inheritEnv adds a name (case-insensitively on Windows only)');
      assert.equal(childEnv({ run: 'node adapter.js', inheritEnv: ['IA_T_API_KEY'] }, {}, {}).IA_T_API_KEY, 'secret');
      assert.equal(childEnv({ run: 'node adapter.js', env: { IA_T_API_KEY: 'given' } }, {}, {}).IA_T_API_KEY, 'given', 'env still gives a value outright');
      const claude = childEnv({ run: 'claude -p go' }, {}, {});
      assert.equal(claude.IA_T_API_KEY, 'secret', 'claude runs keep today\'s default');
      assert.equal(claude.INTELLAGENT_TOKEN, 'the-boards-own');
      assert.equal(childEnv({ run: 'claude -p go', inheritEnv: [] }, {}, {}).IA_T_API_KEY, undefined, 'inheritEnv still narrows a claude run');
    } finally {
      delete process.env.IA_T_API_KEY;
      if (token == null) delete process.env.INTELLAGENT_TOKEN; else process.env.INTELLAGENT_TOKEN = token;
    }
  });

  it('a run gets the env the agent asked for; keepAlive with a non-claude run runs one-shot; a bad env leaves the agent off', async () => {
    process.env.IA_T_BOARD_SECRET = 'leak';
    let s;
    try {
      s = await startServer({ agents: { defaults: fast, agents: {
        narrow: { run: run('env', 'IA_T_BOARD_SECRET,IA_T_MINE'), env: { IA_T_BOARD_SECRET: null, IA_T_MINE: 'x' } },
        plain: { run: run('env', 'IA_T_BOARD_SECRET,IA_T_MINE'), keepAlive: true },
        wide: { run: run('env', 'IA_T_BOARD_SECRET'), inheritEnv: ['IA_T_BOARD_SECRET'] },
        broken: { run: run('ok'), inheritEnv: 'PATH' },
      } } });
    } finally { delete process.env.IA_T_BOARD_SECRET; }
    try {
      const { error, agents } = await s.ok('GET', '/api/agents');
      assert.match(error, /"plain": keepAlive needs a claude run/);
      assert.match(error, /"broken": "inheritEnv" must be a list/, 'every problem is reported, not just the last');
      assert.equal(agents.find((a) => a.name === 'plain').keepAlive, false);
      assert.equal(agents.find((a) => a.name === 'broken').status, 'paused');
      const it = await s.ok('POST', `${B}/items`, { title: 'env', column: 'Backlog' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@narrow @plain @wide @broken go' }, USER);
      await until(async () => (await comments(s, it.id)).filter((c) => / env /.test(c)).length === 3, 15000, 'all three replied');
      const said = await comments(s, it.id);
      assert.ok(said.includes('narrow: handled 1 event(s) env IA_T_BOARD_SECRET=- IA_T_MINE=x'), said.join('\n'));
      assert.ok(said.includes('plain: handled 1 event(s) env IA_T_BOARD_SECRET=- IA_T_MINE=-'),
        'plain ran one-shot instead of hanging on a turn, and a custom run never sees a board variable it was not given (INT-260)');
      assert.ok(said.includes('wide: handled 1 event(s) env IA_T_BOARD_SECRET=leak'), 'inheritEnv lets that one name through');
      assert.equal((await agentState(s, 'plain')).session, null);
      assert.ok(!said.some((c) => c.startsWith('broken:')), 'broken never ran');
    } finally { await s.stop(); }
  });
});

describe('stop all agents', () => {
  it('kills runs without counting a failure, pauses everyone, frees leases, sends their In Progress tickets to Ready; resume-all restarts', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: { busy: { run: run('slow', 4000) }, calm2: { run: run('ok') } } } });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'half done', column: 'Ready' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/start`, { status: 'editing' }, { agent: 'busy' });
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@busy keep going' }, USER);
      await until(async () => (await agentState(s, 'busy')).status === 'running', 6000, 'busy running');
      assert.equal((await s.api('POST', '/api/agents/stop-all', {}, { agent: 'busy' })).status, 403, 'agents need the grant');
      const r = await s.ok('POST', '/api/agents/stop-all', {}, USER);
      assert.deepEqual(r.stopped, ['busy']);
      assert.ok(r.moved.some((x) => x.endsWith(it.id)));
      await until(async () => (await agentState(s, 'busy')).status === 'paused', 6000, 'busy paused');
      const a = await agentState(s, 'busy');
      assert.equal(a.failures, 0, 'a stopped run is not a failure');
      assert.ok(a.queued >= 1, 'its events wait for the resume');
      assert.equal((await agentState(s, 'calm2')).status, 'paused');
      const after = await s.ok('GET', `${B}/items/${it.id}`);
      assert.equal(after.column, 'Ready');
      assert.equal(after.lease, null);
      assert.equal(after.assignee, 'busy', 'kept, so it is easy to resume');
      assert.match(after.comments.at(-1).body, /Stopped by .*busy was halted mid-work/);
      await s.ok('POST', '/api/agents/resume-all', {}, USER);
      await until(async () => ['running', 'queued', 'idle'].includes((await agentState(s, 'busy')).status), 6000, 'busy resumed');
    } finally { await s.stop(); }
  });

  it('the stale sweep sends an agent ticket left in In Progress, with no lease and no activity, back to Ready', async () => {
    const s = await startServer({ manifest: { staleWorkMinutes: 0.01, staleSweepSeconds: 0.4 }, agents: { agents: {} } });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'abandoned', column: 'Ready' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/start`, {}, { agent: 'ghost' });
      await s.ok('DELETE', `${B}/items/${it.id}/lease`, undefined, { agent: 'ghost' });
      await until(async () => (await s.ok('GET', `${B}/items/${it.id}`)).column === 'Ready', 6000, 'swept to Ready');
      assert.match((await s.ok('GET', `${B}/items/${it.id}`)).comments.at(-1).body, /Back to Ready: no activity/);
    } finally { await s.stop(); }
  });

  it('the stale sweep leaves a ticket that waits on the human (open question or review) where it is, and wakes nobody (INT-192)', async () => {
    const s = await startServer({ manifest: { staleWorkMinutes: 0.01, staleSweepSeconds: 0.4 }, agents: { agents: {} } });
    try {
      const park = async (title) => {
        const it = await s.ok('POST', `${B}/items`, { title, column: 'Ready' }, USER);
        await s.ok('POST', `${B}/items/${it.id}/start`, {}, { agent: 'ghost' });
        return it;
      };
      const asked = await park('asked James');
      await s.ok('POST', `${B}/items/${asked.id}/attention`, { reason: 'which way?' }, { agent: 'ghost' });
      await s.ok('DELETE', `${B}/items/${asked.id}/lease`, undefined, { agent: 'ghost' });
      const plain = await park('abandoned');
      await s.ok('DELETE', `${B}/items/${plain.id}/lease`, undefined, { agent: 'ghost' });
      const { cursor } = await s.ok('GET', '/api/events?tail=true');
      // the plain one is swept: by then the asked one has been idle as long
      await until(async () => (await s.ok('GET', `${B}/items/${plain.id}`)).column === 'Ready', 6000, 'plain ticket swept');
      await new Promise((r) => setTimeout(r, 1000)); // two more sweeps
      const after = await s.ok('GET', `${B}/items/${asked.id}`);
      assert.equal(after.column, 'In Progress', 'a ticket with an open question stays');
      assert.ok(!after.comments.some((c) => /Back to/.test(c.body)));
      const { events } = await s.ok('GET', `/api/events?since=${cursor}&itemId=${asked.id}`);
      assert.deepEqual(events, [], 'nothing happened to it, so nobody was woken');
    } finally { await s.stop(); }
  });
});

describe('the receptionist supervises other agents', () => {
  it("is told about another agent's stalled ticket, and stops after two unanswered nudges", async () => {
    const s = await startServer({ agents: { defaults: fast, agents: {
      desk: { role: 'coordinator', run: run('ok') },
      sleeper: { role: 'builder', enabled: false }, // never runs: its tickets stall
    } } });
    try {
      const sup = async () => (await s.ok('GET', `${B}/work?agent=desk`)).supervise || [];
      const it = await s.ok('POST', `${B}/items`, { title: 'given to a paused agent', column: 'Ready', assignee: 'sleeper' }, USER);
      const t = await s.ok('POST', `${B}/items`, { title: 'throwaway', column: 'Ready', assignee: 'sleeper', test: true }, USER);
      const q = await s.ok('POST', `${B}/items`, { title: 'waiting on you', column: 'Ready', assignee: 'sleeper', needsHuman: 'which way?' }, USER);
      const ids = (await sup()).map((x) => x.id);
      assert.ok(ids.includes(it.id), 'a ticket held up by a paused agent is reported');
      assert.ok(!ids.includes(t.id) && !ids.includes(q.id), 'test tickets and tickets waiting on the human are not');
      const w = await s.ok('GET', `${B}/work?agent=desk`);
      assert.match(w.next.find((n) => n.id === it.id)?.call || '', /\/api\/agents\/sleeper\/resume/);
      for (const body of ['@sleeper please pick this up', '@sleeper reminder']) await s.ok('POST', `${B}/items/${it.id}/comments`, { body }, { agent: 'desk' });
      assert.ok(!(await sup()).some((x) => x.id === it.id), 'two unanswered nudges: left for the human');
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: 'still needed' }, USER);
      assert.ok((await sup()).some((x) => x.id === it.id), 'someone else acting makes it eligible again');
      assert.equal((await s.ok('GET', `${B}/work?agent=sleeper`)).supervise, undefined, 'only supervisors get the list');
    } finally { await s.stop(); }
  });

  it("reads a busy agent's other tickets as queued, not stalled, and still catches one that is idle (INT-211)", async () => {
    // superviseMinutes 0.02: a ticket counts as untouched after ~1.2 s; 'usage' runs end without a word on the card
    const s = await startServer({ agents: { defaults: fast, agents: {
      desk: { role: 'coordinator', run: run('usage'), superviseMinutes: 0.02 },
      worker: { role: 'builder', run: run('usage'), throttleMinutes: 0 },
    } } });
    try {
      const sup = async () => ((await s.ok('GET', `${B}/work?agent=desk`)).supervise || []).map((x) => x.id);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const a = await s.ok('POST', `${B}/items`, { title: 'working on this', column: 'Ready', assignee: 'worker' }, USER);
      const b = await s.ok('POST', `${B}/items`, { title: 'next in its queue', column: 'Ready', assignee: 'worker' }, USER);
      const c = await s.ok('POST', `${B}/items`, { title: 'blocked by a', column: 'Ready', assignee: 'worker', blockedBy: [a.id] }, USER);
      // the assignments wake it, then its queue is offered once; a run that ends releases what it holds, so lease only once both have run
      await until(async () => { const w = await agentState(s, 'worker'); return w.lastRun?.why === 'work.pending' && w.status === 'idle' && !w.queued; }, 8000, 'worker settled');
      await sleep(500);
      // busy: it holds a lease on a, so b waits its turn however long it sits
      await s.ok('POST', `${B}/items/${a.id}/lease`, { minutes: 10 }, { agent: 'worker' });
      await sleep(1600);
      assert.ok((await s.ok('GET', `${B}/items/${a.id}`)).lease, 'still held');
      assert.deepEqual(await sup(), [], 'a busy agent has nothing stalled');
      // idle, nothing held: b is stalled; c has an open blocker, so it is not
      await s.ok('DELETE', `${B}/items/${a.id}/lease`, undefined, { agent: 'worker' });
      const ids = await until(async () => { const x = await sup(); return x.includes(b.id) && x; }, 8000, 'b reported once the worker is idle');
      assert.ok(!ids.includes(c.id), 'a ticket with an open blocker is waiting, not stalled');
      // the assignee says b waits on a: quiet past its own-comment window (4 × 1.2 s), until a moves
      await s.ok('POST', `${B}/items/${b.id}/comments`, { body: `Queued behind ${a.id}.` }, { agent: 'worker' });
      await sleep(5500);
      assert.ok(!(await sup()).includes(b.id), 'waits on a, which has not moved');
      await s.ok('POST', `${B}/items/${a.id}/move`, { column: 'In Progress' }, USER);
      await until(async () => (await sup()).includes(b.id), 8000, 'b reported again once a moved');
    } finally { await s.stop(); }
  });
});

describe('lean runs', () => {
  const { runFor, boardMcpConfig, keepAliveCmd } = require('../lib/agents');

  it('loads only the built-in tools the perms use, and no MCP servers but the board\'s', () => {
    const reader = runFor(['read']);
    assert.match(reader, / --tools "Bash,Read,Grep,Glob" --strict-mcp-config --allowedTools /);
    assert.doesNotMatch(reader, /--mcp-config|acceptEdits/);
    assert.match(runFor(['edit', 'test', 'git']), / --permission-mode acceptEdits --tools "Bash,Read,Grep,Glob,Edit,Write" /);
    assert.match(runFor(['read', 'web']), / --tools "Bash,Read,Grep,Glob,WebSearch,WebFetch" /);
    const b = runFor(['test'], { mcpConfig: '.mcp.json' });
    assert.match(b, / --strict-mcp-config --mcp-config "\.mcp\.json" --allowedTools "Bash\(intellagent:\*\)" "mcp__intellagent" "Bash\(npm test\)"/);
    assert.match(keepAliveCmd(b), /--allowedTools .* --input-format stream-json/, 'keep-alive flags still follow the variadic lists');
  });

  it('denies Claude\'s file tools on the board\'s own files, and no Bash rule lets node --test take flags (INT-195)', async () => {
    const { PERMS } = require('../lib/agents');
    const r = runFor(['edit', 'test'], { protect: ['C:\\board\\local.json'], protectWrites: ['C:\\board\\data\\**'] });
    const deny = /--disallowedTools (.*)$/.exec(r)[1];
    for (const t of ['Read', 'Edit', 'Write']) {
      for (const p of ['**/.intellagent/local.json', '**/agents.json', '**/agent-context/**', '**/.git/hooks/**']) assert.ok(deny.includes(`"${t}(${p})"`), `${t}(${p})`);
    }
    if (process.platform === 'win32') {
      assert.ok(deny.includes('"Read(//c/board/local.json)"'), 'absolute paths in the POSIX form Claude Code matches');
      assert.ok(deny.includes('"Edit(//c/board/data/**)"') && deny.includes('"Write(//c/board/data/**)"'));
      assert.ok(!deny.includes('Read(//c/board/data'), 'a run still reads its own events file in data/');
    }
    // Claude Code's Bash rules: "Bash(x)" is exactly x, "Bash(x:*)" is x followed by anything
    const fits = (rule, cmd) => { const m = /^Bash\((.*)\)$/.exec(rule); if (!m) return false; return m[1].endsWith(':*') ? cmd.startsWith(m[1].slice(0, -2)) : cmd === m[1]; };
    const rules = [...Object.values(PERMS).flatMap((p) => p.tools), 'Bash(intellagent:*)'];
    for (const cmd of ['node --test --import x', 'node --test --import=data:text/javascript,x', 'node --test x.js']) {
      assert.deepEqual(rules.filter((t) => fits(t, cmd)), [], cmd);
    }
    assert.ok(rules.some((t) => fits(t, 'node --test')) && rules.some((t) => fits(t, 'npm test')), 'plain test runs still fit');

    // on a board: runs built from a role carry the rules with the board's real paths; a custom run is left alone
    const s = await startServer({ agents: { agents: { b: { role: 'builder', enabled: false }, c: { run: 'claude -p "mine"', enabled: false } } } });
    try {
      const { agents } = await s.ok('GET', '/api/agents');
      const b = agents.find((a) => a.name === 'b').run;
      assert.match(b, /--disallowedTools .*"Read\(\/\/.*agents\.json\)"/);
      assert.match(b, /"Edit\(\/\/.*\/data\/\*\*\)"/);
      assert.equal(agents.find((a) => a.name === 'c').run, 'claude -p "mine"', "the human's own run wins");
    } finally { await s.stop(); }
  });

  it('finds the board\'s MCP server only when the project registered it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-mcp-'));
    try {
      assert.equal(boardMcpConfig(dir), null, 'no .mcp.json');
      fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
      assert.equal(boardMcpConfig(dir), null, 'no intellagent server');
      fs.writeFileSync(path.join(dir, '.mcp.json'), `﻿${JSON.stringify({ mcpServers: { intellagent: { command: 'node', args: ['mcp.js'] } } })}`);
      assert.equal(boardMcpConfig(dir), path.join(dir, '.mcp.json'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('points an untracked .mcp.json at the project, so a worktree agent still finds it (INT-345)', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-mcp-proj-'));
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-mcp-wt-'));
    try {
      fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { intellagent: { command: 'node', args: ['mcp.js'] } } }));
      // the worktree is a checkout without the untracked file, so a relative path would not resolve there
      assert.equal(fs.existsSync(path.join(worktree, '.mcp.json')), false);
      const abs = boardMcpConfig(project);
      assert.ok(path.isAbsolute(abs), 'absolute path');
      assert.ok(fs.existsSync(abs), 'it names the project\'s file');
      assert.match(runFor(['test'], { mcpConfig: abs }), new RegExp(`--mcp-config "${abs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });
});

describe('token usage', () => {
  const { parseUsage, usageOf, withJsonOutput } = require('../lib/agents');

  it('parses usage from a claude result and says nothing when there is none', () => {
    const log = '$ claude -p x\n--- prompt ---\n{"type":"user"} not output\n--- output ---\nnoise\n'
      + `${JSON.stringify({ type: 'result', usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 100 } })}\n`;
    assert.deepEqual(parseUsage(log), { input: 7, output: 3, cacheRead: 100, cacheCreated: 0 });
    assert.equal(parseUsage('--- output ---\njust text, no json\n'), null, 'n/a, not zero');
    assert.equal(parseUsage('--- output ---\n{"type":"result","result":"ok"}\n'), null);
    assert.equal(usageOf({ usage: {} }), null);
    assert.deepEqual(usageOf({ usage: { input_tokens: 0, output_tokens: 0 } }), { input: 0, output: 0, cacheRead: 0, cacheCreated: 0 }, 'a reported zero stays zero');
  });

  it('reads the OpenAI-compatible usage other providers print, with cached tokens taken out of input (INT-247)', () => {
    const openai = { type: 'result', usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 800 } }, num_turns: 2 };
    assert.deepEqual(usageOf(openai), { input: 200, output: 50, cacheRead: 800, cacheCreated: 0, context: 500 });
    const deepseek = { type: 'result', usage: { prompt_tokens: 300, completion_tokens: 20, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 200 } };
    assert.deepEqual(parseUsage(`--- output ---\n${JSON.stringify(deepseek)}\n`), { input: 200, output: 20, cacheRead: 100, cacheCreated: 0 });
    assert.deepEqual(usageOf({ usage: { prompt_tokens: 10, completion_tokens: 0 } }), { input: 10, output: 0, cacheRead: 0, cacheCreated: 0 });
  });

  it('an agent has a provider: anthropic for a claude run, its own otherwise; only Anthropic models get a tier; a run is told its model (INT-247)', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: {
      senior: { role: 'builder', model: 'opus', enabled: false },
      seeker: { run: run('env', 'INTELLAGENT_PROVIDER,INTELLAGENT_MODEL'), provider: 'DeepSeek', model: 'deepseek-chat' },
      odd: { run: run('ok'), provider: 'bad name!' },
    } } });
    try {
      const { agents, error } = await s.ok('GET', '/api/agents');
      const a = (n) => agents.find((x) => x.name === n);
      assert.deepEqual([a('senior').provider, a('senior').tier], ['anthropic', 'senior']);
      assert.deepEqual([a('seeker').provider, a('seeker').model, a('seeker').tier], ['deepseek', 'deepseek-chat', null]);
      assert.equal(a('odd').provider, null);
      assert.match(error, /"odd": provider must be a plain name/);
      const it = await s.ok('POST', `${B}/items`, { title: 'provider', column: 'Backlog' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@seeker go' }, USER);
      await until(async () => (await comments(s, it.id)).some((c) => c.startsWith('seeker: handled')), 8000, 'seeker reply');
      assert.ok((await comments(s, it.id)).includes('seeker: handled 1 event(s) env INTELLAGENT_PROVIDER=deepseek INTELLAGENT_MODEL=deepseek-chat'));
      const set = await s.ok('POST', '/api/agents', { name: 'senior', provider: 'Anthropic' }, USER);
      assert.equal(set.provider, 'anthropic');
      assert.equal((await s.api('POST', '/api/agents', { name: 'senior', provider: 'no spaces' }, USER)).status, 400);
    } finally { await s.stop(); }
  });

  it('asks one-shot claude runs for JSON output and leaves everything else alone', () => {
    assert.equal(withJsonOutput('claude -p "x"'), 'claude -p "x" --output-format json');
    assert.equal(withJsonOutput('claude -p "x" --output-format stream-json'), 'claude -p "x" --output-format stream-json');
    assert.equal(withJsonOutput('node fake.js ok'), 'node fake.js ok');
  });

  it('records usage per run and per day, keeps it over a restart, and has none for runs that report none', async () => {
    const agents = { defaults: fast, agents: { metered: { run: run('usage') }, quiet: { run: run('ok') } } };
    let s = await startServer({ agents });
    const it = await s.ok('POST', `${B}/items`, { title: 'usage test', column: 'Backlog' }, USER);
    const poke = async (who, round) => {
      const before = (await agentState(s, who)).lastRun?.startedAt;
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: `@${who} round ${round}` }, USER);
      await until(async () => { const a = await agentState(s, who); return a.status === 'idle' && a.lastRun?.endedAt && a.lastRun.startedAt !== before; }, 8000, `${who} run ${round}`);
    };
    await poke('metered', 1);
    let m = await agentState(s, 'metered');
    assert.deepEqual(m.lastRun.usage, { input: 120, output: 30, cacheRead: 500, cacheCreated: 40 });
    assert.equal(m.usageToday.runs, 1);
    await poke('metered', 2);
    m = await agentState(s, 'metered');
    assert.deepEqual([m.usageToday.runs, m.usageToday.input, m.usageToday.output], [2, 240, 60]);

    await poke('quiet', 1);
    const q = await agentState(s, 'quiet');
    assert.equal(q.lastRun.usage, null, 'no usage reported → null, shown as n/a');
    assert.equal(q.usageToday, null);

    const dir = s.dir;
    await s.stop({ keep: true });
    s = await startServer({ dir, agents });
    try {
      m = await agentState(s, 'metered');
      assert.equal(m.usageToday.input, 240, 'survives a board restart');
      assert.equal(m.lastRun.usage.output, 30);
      assert.equal(m.history.length, 2, 'run history survives a board restart');
    } finally { await s.stop(); }
  });
});

describe('receptionist with pickup "ready"', () => {
  it('a ticket moved into Ready wakes it to triage (not to start it itself)', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: { desk: { role: 'coordinator', pickup: 'ready', run: run('ok') } } } });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'parked idea', column: 'Backlog' }, { agent: 'someone' });
      const w0 = await s.ok('GET', `${B}/work?agent=desk`);
      assert.ok(!(w0.triage || []).some((x) => x.id === it.id), 'Backlog is not its job with pickup "ready"');
      await s.ok('POST', `${B}/items/${it.id}/move`, { column: 'Ready' }, USER);
      await until(async () => (await s.ok('GET', '/api/events?types=agent.run.started')).events.some((e) => e.agent === 'desk' && e.items.includes(it.id)), 8000, 'woken for the moved ticket');
      const w = await s.ok('GET', `${B}/work?agent=desk`);
      assert.ok(w.next.some((n) => n.id === it.id && n.action === 'triage'), 'told to triage it');
      assert.ok(!w.next.some((n) => n.id === it.id && n.action === 'start'), 'never told to start it');
    } finally { await s.stop(); }
  });
});

describe('per-agent git worktrees', () => {
  it('each agent commits on its own branch in its own worktree; approval lands the ticket on main', async () => {
    const fs = require('fs');
    const os = require('os');
    const { execFileSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-wt-'));
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\n.worktrees/\nintellagent.manifest.json\nagents.json\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    // A post-commit hook, as `intellagent hook install` writes one: landing must not run it (it would call the
    // board while the board waits on git). It counts its runs in a file git does not track.
    const hookRuns = path.join(dir, 'hook-runs.txt');
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'post-commit'), `#!/bin/sh\necho ran >> "${hookRuns.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    const runs = () => (fs.existsSync(hookRuns) ? fs.readFileSync(hookRuns, 'utf8').split('\n').filter(Boolean).length : 0);
    const s = await startServer({ dir, agents: { defaults: fast, agents: { ann: { run: run('commit'), worktree: true }, bob: { run: run('commit'), worktree: true } } } });
    try {
      const a = await s.ok('POST', `${B}/items`, { title: 'for ann', column: 'Ready', assignee: 'ann' }, USER);
      const b = await s.ok('POST', `${B}/items`, { title: 'for bob', column: 'Ready', assignee: 'bob' }, USER);
      await until(async () => (await comments(s, a.id)).some((c) => c.startsWith('ann: committed')) && (await comments(s, b.id)).some((c) => c.startsWith('bob: committed')), 10000, 'both committed');
      const where = (await comments(s, a.id)).find((c) => c.startsWith('ann: committed'));
      assert.ok(where.replace(/\\/g, '/').endsWith('.worktrees/ann'), `ann works in its own worktree: ${where}`);
      assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'the main checkout is untouched');
      assert.ok(!fs.existsSync(path.join(dir, `work-${a.id}.txt`)), 'nothing on main before approval');
      assert.ok(git('log', '--format=%s', 'agent/ann').includes(`(${a.id})`));
      assert.ok(!git('log', '--format=%s', 'agent/ann').includes(`(${b.id})`), "bob's work is not on ann's branch");
      // review lists the commits; approval lands them
      await until(async () => (await agentState(s, 'ann')).status === 'idle', 6000, 'ann idle');
      const r = await s.ok('POST', `${B}/items/${a.id}/review`, { summary: 'done' }, { agent: 'ann' });
      assert.match(r.comments.at(-1).body, /Commits\*\* on `agent\/ann`/);
      const before = runs();
      assert.ok(before > 0, 'the hook does run on ordinary commits: the agents\' own');
      await s.ok('POST', `${B}/items/${a.id}/review/decision`, { verdict: 'approve' }, USER);
      assert.ok(fs.existsSync(path.join(dir, `work-${a.id}.txt`)), 'landed on main');
      assert.equal(runs(), before, 'landing ran no hook');
      assert.ok(git('log', '-1', '--format=%s').includes(`(${a.id})`));
      assert.match((await comments(s, a.id)).at(-1), /Landed on main/);
      assert.ok(!fs.existsSync(path.join(dir, `work-${b.id}.txt`)), "bob's unapproved work stays off main");
      // an uncommitted change the ticket's commits don't touch no longer blocks landing, and survives it
      fs.writeFileSync(path.join(dir, 'README.md'), 'edited by the human\n');
      await s.ok('POST', `${B}/items/${b.id}/review`, { summary: 'done' }, { agent: 'bob' });
      await s.ok('POST', `${B}/items/${b.id}/review/decision`, { verdict: 'approve' }, USER);
      assert.match((await comments(s, b.id)).at(-1), /Landed on main/);
      assert.ok(fs.existsSync(path.join(dir, `work-${b.id}.txt`)));
      assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'edited by the human\n', "the human's uncommitted edit is kept");
      git('checkout', 'README.md');
    } finally {
      await s.stop();
      try { execFileSync('git', ['worktree', 'prune'], { cwd: dir }); } catch { /* ignore */ }
    }
  });
  it('a conflict the agent resolved by merging main lands by merge; never with another ticket\'s commits', async () => {
    const fs = require('fs');
    const os = require('os');
    const { execFileSync } = require('child_process');
    const { createWorktrees } = require('../lib/worktrees');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-wt-'));
    const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const write = (cwd, file, text) => fs.writeFileSync(path.join(cwd, file), text);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'core.autocrlf', 'false');
    write(dir, '.gitignore', '.worktrees/\n');
    write(dir, 'f.txt', 'start\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    const wt = createWorktrees({ root: dir, dir: path.join(dir, '.worktrees') });
    // ann changes f.txt, main changes the same line, ann merges main and resolves the conflict
    const setup = async (name, id) => {
      const { path: p } = await wt.ensure(name);
      write(p, 'f.txt', `${name}\n`);
      git(p, 'commit', '-q', '-am', `${name} edits f (${id})`);
      return p;
    };
    try {
      const ann = await setup('ann', 'T-1');
      write(dir, 'f.txt', 'main\n');
      git(dir, 'commit', '-q', '-am', 'main edits f');
      assert.throws(() => git(ann, 'merge', 'main'));
      write(ann, 'f.txt', 'ann+main\n');
      git(ann, 'commit', '-q', '-am', 'merge main, keep both');
      // a second ticket's commit on the same branch: merging would drag it onto main, so nothing lands
      write(ann, 'g.txt', 'other\n');
      git(ann, 'add', 'g.txt');
      git(ann, 'commit', '-q', '-m', 'other work (T-2)');
      const head = git(dir, 'rev-parse', 'HEAD');
      const refused = await wt.land('ann', 'T-1');
      assert.equal(refused.landed.length, 0);
      assert.match(refused.reason, /doesn't apply cleanly to main, and agent\/ann has 1 commit\(s\) for other tickets/);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'main is where it was');
      assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=no'), '', 'and clean');
      // without the other ticket's commit, the merge lands with ann's resolution
      git(ann, 'reset', '-q', '--hard', 'HEAD~1');
      const r = await wt.land('ann', 'T-1');
      assert.equal(r.via, 'merge');
      assert.equal(r.landed.length, 1);
      assert.equal(git(dir, 'show', 'main:f.txt'), 'ann+main', 'the resolution is on main');
      assert.match(git(dir, 'log', '-1', '--format=%s'), /^Land T-1 from agent\/ann$/);
      assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=no'), '');
      assert.equal(wt.commitsFor('ann', 'T-1').length, 0, 'nothing left to land');
      // a plain ticket still lands by cherry-pick
      const bob = (await wt.ensure('bob')).path;
      write(bob, 'h.txt', 'bob\n');
      git(bob, 'add', 'h.txt');
      git(bob, 'commit', '-q', '-m', 'bob adds h (T-3)');
      assert.equal((await wt.land('bob', 'T-3')).via, 'cherry-pick');
      // INT-301: a change that is already on main under another sha counts as landed, found by patch id
      const eve = (await wt.ensure('eve')).path;
      write(eve, 'e.txt', 'eve\n');
      git(eve, 'add', 'e.txt');
      git(eve, 'commit', '-q', '-m', 'eve adds e (T-6)');
      write(dir, 'e.txt', 'eve\n');
      git(dir, 'add', 'e.txt');
      git(dir, 'commit', '-q', '-m', 'the same change by hand');
      const byHand = git(dir, 'rev-parse', '--short=7', 'HEAD');
      const eq = await wt.land('eve', 'T-6');
      assert.equal(eq.via, 'equivalent', JSON.stringify(eq));
      assert.deepEqual(eq.landed, [byHand]);
      assert.equal(eq.equivalent[0].main, byHand);
      assert.equal(git(dir, 'rev-parse', '--short=7', 'HEAD'), byHand, 'no new commit on main');
      // the twin older than the window searched: still landed, flagged unmatched (the sha is only main's tip)
      const far = createWorktrees({ root: dir, dir: path.join(dir, '.worktrees'), twinWindow: 1 });
      const fay = (await far.ensure('fay')).path;
      write(fay, 'f.txt', 'fay\n');
      git(fay, 'add', 'f.txt');
      git(fay, 'commit', '-q', '-m', 'fay adds f (T-7)');
      write(dir, 'f.txt', 'fay\n');
      git(dir, 'add', 'f.txt');
      git(dir, 'commit', '-q', '-m', 'the same change by hand again');
      write(dir, 'g.txt', 'later\n');
      git(dir, 'add', 'g.txt');
      git(dir, 'commit', '-q', '-m', 'something later');
      const lost = await far.land('fay', 'T-7');
      assert.equal(lost.via, 'equivalent', JSON.stringify(lost));
      assert.equal(lost.equivalent[0].unmatched, true);
      assert.equal(lost.landed[0], git(dir, 'rev-parse', '--short=7', 'HEAD'), 'main\'s tip, the only sha known');
      // INT-137: git never blocks the board (the event loop turns while it lands), and two landings asked for
      // at once go one after the other, so neither cherry-picks into the other's half-done state
      for (const [name, id] of [['cy', 'T-4'], ['di', 'T-5']]) {
        const p = (await wt.ensure(name)).path;
        write(p, `${name}.txt`, `${name}\n`);
        git(p, 'add', `${name}.txt`);
        git(p, 'commit', '-q', '-m', `${name} adds a file (${id})`);
      }
      let turned = false;
      setImmediate(() => { turned = true; });
      const both = await Promise.all([wt.land('cy', 'T-4'), wt.land('di', 'T-5')]);
      assert.ok(turned, 'the event loop ran while git worked');
      assert.deepEqual(both.map((x) => [x.via, x.landed.length]), [['cherry-pick', 1], ['cherry-pick', 1]]);
      assert.equal(git(dir, 'show', 'main:cy.txt'), 'cy');
      assert.equal(git(dir, 'show', 'main:di.txt'), 'di');
      assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=no'), '');
    } finally {
      try { execFileSync('git', ['worktree', 'prune'], { cwd: dir }); } catch { /* ignore */ }
    }
  });
  it('a side branch open in the main checkout is neither where work lands nor what agents catch up with', async () => {
    const fs = require('fs');
    const os = require('os');
    const { execFileSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-wt-'));
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\n.worktrees/\nintellagent.manifest.json\nagents.json\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    // the human is on a feature branch with a commit main doesn't have
    git('switch', '-q', '-c', 'side');
    fs.writeFileSync(path.join(dir, 'side.txt'), 'wip\n');
    git('add', 'side.txt');
    git('commit', '-q', '-m', 'side work');
    const s = await startServer({ dir, agents: { defaults: fast, agents: { ann: { run: run('commit'), worktree: true } } } });
    try {
      const a = await s.ok('POST', `${B}/items`, { title: 'for ann', column: 'Ready', assignee: 'ann' }, USER);
      await until(async () => (await comments(s, a.id)).some((c) => c.startsWith('ann: committed')), 10000, 'ann committed');
      assert.ok(!git('log', '--format=%s', 'agent/ann').includes('side work'), "ann's branch starts from main, not the open side branch");
      await until(async () => (await agentState(s, 'ann')).status === 'idle', 6000, 'ann idle');
      await s.ok('POST', `${B}/items/${a.id}/review`, { summary: 'done' }, { agent: 'ann' });
      await s.ok('POST', `${B}/items/${a.id}/review/decision`, { verdict: 'approve' }, USER);
      assert.match((await comments(s, a.id)).at(-1), /Not landed: the main checkout has `side` open, not `main`.*git switch main.*intellagent merge/);
      const failed = (await s.ok('GET', `/api/events?types=item.land_failed&itemId=${a.id}`)).events.at(-1);
      assert.equal(failed.code, 'NOT_ON_MAIN');
      assert.ok(!git('log', '--format=%s', 'side').includes(`(${a.id})`), 'nothing landed on side');
      git('switch', '-q', 'main');
      const land = await s.ok('POST', `${B}/items/${a.id}/land`, {}, USER);
      assert.equal(land.landed.length, 1);
      assert.equal(land.branch, 'main');
      assert.ok(git('log', '-1', '--format=%s', 'main').includes(`(${a.id})`));
      assert.match((await comments(s, a.id)).at(-1), /Landed on main/);
    } finally {
      await s.stop();
      try { execFileSync('git', ['worktree', 'prune'], { cwd: dir }); } catch { /* ignore */ }
    }
  });
});

describe('a lander (work.land) gets approved work onto main', () => {
  it('a failed landing goes to the lander, not the human; the lander lands only approved work', async () => {
    const fs = require('fs');
    const os = require('os');
    const { execFileSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-land-'));
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\n.worktrees/\nintellagent.manifest.json\nagents.json\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const s = await startServer({ dir, manifest: { staleSweepSeconds: 0.4 }, agents: { defaults: fast, agents: {
      bob: { run: run('commit'), worktree: true },
      yondu: { run: run('ok'), worktree: true, grants: ['work.land'] },
      eve: { run: run('ok'), worktree: true },
    } } });
    try {
      const b = await s.ok('POST', `${B}/items`, { title: 'for bob', column: 'Ready', assignee: 'bob' }, USER);
      await until(async () => (await comments(s, b.id)).some((c) => c.startsWith('bob: committed')), 10000, 'bob committed');
      await until(async () => (await agentState(s, 'bob')).status === 'idle', 6000, 'bob idle');
      await s.ok('POST', `${B}/items/${b.id}/review`, { summary: 'done', evidence: 'e' }, { agent: 'bob' });
      // nobody may land before approval
      assert.equal((await s.api('POST', `${B}/items/${b.id}/land`, { agent: 'bob' }, { agent: 'yondu' })).body.code, 'NOT_APPROVED');
      // the lander's brief says how to land
      const brief = (await s.api('GET', `${B}/brief`, undefined, { agent: 'yondu' })).body;
      assert.match(brief, /work\.land\*\* — .*\/items\/<ID>\/land.*NOT_APPROVED/);
      assert.doesNotMatch(brief, /work\.land\*\* — undefined/);
      // approval while the main checkout has uncommitted changes to a file the ticket changes: the landing
      // fails, names the file and goes to the lander
      fs.writeFileSync(path.join(dir, `work-${b.id}.txt`), "the human's own version\n");
      git('add', `work-${b.id}.txt`);
      await s.ok('POST', `${B}/items/${b.id}/review/decision`, { verdict: 'approve' }, USER);
      const note = (await comments(s, b.id)).at(-1);
      assert.ok(note.includes(`Not landed: the main checkout has uncommitted changes to \`work-${b.id}.txt\``), note);
      assert.equal((await s.ok('GET', `${B}/items/${b.id}`)).landing.code, 'DIRTY');
      assert.match(note, /@yondu will land it/);
      assert.doesNotMatch(note, /intellagent merge/, 'the human is not asked to run it');
      assert.equal((await s.ok('GET', `${B}/items/${b.id}`)).landing.state, 'failed');
      const work = (await s.ok('GET', `${B}/work`, undefined, { agent: 'yondu' })).next;
      assert.equal(work.find((n) => n.id === b.id)?.action, 'land');
      // an agent without work.land may not land
      assert.equal((await s.api('POST', `${B}/items/${b.id}/land`, { agent: 'bob' }, { agent: 'eve' })).body.code, 'HUMAN_ONLY');
      // still dirty: the sweep leaves it alone
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal((await s.ok('GET', `${B}/items/${b.id}`)).landing.state, 'failed', 'no retry while the overlap is there');
      // once main is clean the board's sweep lands it by itself; no lander run needed
      git('rm', '-q', '--cached', `work-${b.id}.txt`);
      fs.rmSync(path.join(dir, `work-${b.id}.txt`));
      await until(async () => (await s.ok('GET', `${B}/items/${b.id}`)).landing.state === 'landed', 6000, 'landed by the sweep');
      assert.ok(fs.existsSync(path.join(dir, `work-${b.id}.txt`)), 'on main');
    } finally {
      await s.stop();
      try { execFileSync('git', ['worktree', 'prune'], { cwd: dir }); } catch { /* ignore */ }
    }
  });

  it('a verified ok still counts after the ticket has landed: review facts keep oks and allOk (INT-263)', async () => {
    const fs = require('fs');
    const os = require('os');
    const { execFileSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-facts-'));
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\n.worktrees/\nintellagent.manifest.json\nagents.json\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const s = await startServer({ dir, manifest: { auth: { agentTokens: { nebula: 't-nebula' } } }, agents: { defaults: fast, agents: {
      bob: { run: run('commit'), worktree: true },
      nebula: { role: 'reviewer', enabled: false },
    } } });
    try {
      const b = await s.ok('POST', `${B}/items`, { title: 'for bob', column: 'Ready', assignee: 'bob' }, USER);
      await until(async () => (await comments(s, b.id)).some((c) => c.startsWith('bob: committed')), 10000, 'bob committed');
      await until(async () => (await agentState(s, 'bob')).status === 'idle', 6000, 'bob idle');
      await s.ok('POST', `${B}/items/${b.id}/review`, { summary: 'done', evidence: 'e' }, { agent: 'bob' });
      await s.ok('POST', `${B}/items/${b.id}/reviewers`, { name: 'nebula' }, USER);
      const verdict = await fetch(`${s.base}${B}/items/${b.id}/reviewers/nebula/verdict`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent': 'nebula', authorization: 'Bearer t-nebula' }, body: JSON.stringify({ verdict: 'ok', comment: 'fine' }) });
      assert.ok(verdict.ok);
      const facts = async () => (await s.ok('POST', '/api/search', { board: 'main', where: { id: b.id } }, USER)).items[0].review;
      assert.equal((await facts()).allOk, true, 'before landing');
      await s.ok('POST', `${B}/items/${b.id}/review/decision`, { verdict: 'approve' }, USER);
      assert.equal((await s.ok('GET', `${B}/items/${b.id}`)).landing.state, 'landed');
      const after = await facts();
      assert.equal(after.oks, 1, 'after landing');
      assert.equal(after.allOk, true);
      assert.equal(after.pending, 0);
    } finally {
      await s.stop();
      try { execFileSync('git', ['worktree', 'prune'], { cwd: dir }); } catch { /* ignore */ }
    }
  });

  it('a landing finished by hand stops being work: the sweep and the land route mark it landed, by hand (INT-261)', async () => {
    const fs = require('fs');
    const os = require('os');
    const { execFileSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-hand-'));
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\n.worktrees/\nintellagent.manifest.json\nagents.json\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const s = await startServer({ dir, manifest: { staleSweepSeconds: 0.4 }, agents: { defaults: fast, agents: {
      bob: { run: run('commit'), worktree: true },
      cy: { run: run('commit'), worktree: true },
      dee: { run: run('commit'), worktree: true },
      eli: { run: run('commit'), worktree: true },
      yondu: { run: run('ok'), worktree: true, grants: ['work.land'] },
    } } });
    const failedTicket = async (title, who) => {
      const t = await s.ok('POST', `${B}/items`, { title, column: 'Ready', assignee: who }, USER);
      await until(async () => (await comments(s, t.id)).some((c) => c.startsWith(`${who}: committed`)), 10000, `${who} committed`);
      await until(async () => (await agentState(s, who)).status === 'idle', 6000, `${who} idle`);
      await s.ok('POST', `${B}/items/${t.id}/review`, { summary: 'done', evidence: 'e' }, { agent: who });
      // main has its own version of the ticket's file, so the landing conflicts and fails for good (an uncommitted
      // change would only hold it until main is clean: the sweep lands those again)
      fs.writeFileSync(path.join(dir, `work-${t.id}.txt`), "main's own\n");
      git('add', '.');
      git('commit', '-q', '-m', 'A file in the way');
      await s.ok('POST', `${B}/items/${t.id}/review/decision`, { verdict: 'approve' }, USER);
      assert.equal((await s.ok('GET', `${B}/items/${t.id}`)).landing.state, 'failed');
      return t;
    };
    try {
      // someone lands it by hand: a commit on main that names the ticket, with an id of its own
      const a = await failedTicket('by hand, found by the sweep', 'bob');
      // a commit whose body only names the ticket (to say it was left out) is not its landing
      fs.writeFileSync(path.join(dir, 'other.txt'), 'other\n');
      git('add', '.');
      git('commit', '-q', '-m', 'Restore the stylesheet', '-m', `It had brought in rules from tickets that haven't landed (${a.id}).`);
      await new Promise((r) => setTimeout(r, 1500)); // a few sweeps
      assert.equal((await s.ok('GET', `${B}/items/${a.id}`)).landing.state, 'failed', 'a mention in a commit body is not a landing');
      fs.writeFileSync(path.join(dir, 'by-hand-a.txt'), 'resolved\n');
      git('add', '.');
      git('commit', '-q', '-m', `Land it myself (${a.id})`);
      await until(async () => (await s.ok('GET', `${B}/items/${a.id}`)).landing.state === 'landed', 8000, 'the sweep noticed');
      const card = await s.ok('GET', `${B}/items/${a.id}`);
      assert.equal(card.landing.by, 'hand');
      assert.equal(card.landing.commits.length, 1);
      assert.ok((await comments(s, a.id)).some((c) => /Landed by hand on main/.test(c)));
      const work = (await s.ok('GET', `${B}/work`, undefined, { agent: 'yondu' })).next;
      assert.equal(work.find((n) => n.id === a.id), undefined, 'no land action any more');

      // main has nothing for the next one yet: the lander can mark it with the shas, which must be on main
      const b = await failedTicket('by hand, marked on the route', 'cy');
      assert.equal((await s.api('POST', `${B}/items/${b.id}/land`, { landed: ['deadbeef'] }, USER)).status, 400, 'a sha not on main is refused');
      // an approved ticket whose landing never failed can't be marked landed with some sha
      const u = await s.ok('POST', `${B}/items`, { title: 'never tried', column: 'Ready' }, USER);
      assert.equal((await s.api('POST', `${B}/items/${u.id}/land`, { landed: [git('rev-parse', 'HEAD')] }, { agent: 'yondu' })).status, 409, 'an unapproved ticket is refused');
      assert.equal((await s.api('POST', `${B}/items/${a.id}/land`, { landed: [git('rev-parse', 'HEAD')] }, { agent: 'yondu' })).status, 409, 'a landing that is not failed is refused');
      fs.writeFileSync(path.join(dir, 'by-hand-b.txt'), 'resolved\n');
      git('add', '.');
      git('commit', '-q', '-m', 'no ticket id here');
      const sha = git('rev-parse', 'HEAD');
      const r = await s.ok('POST', `${B}/items/${b.id}/land`, { landed: [sha] }, { agent: 'yondu' });
      assert.equal(r.via, 'hand');
      assert.equal((await s.ok('GET', `${B}/items/${b.id}`)).landing.by, 'hand');

      // intellagent merge <ID> --mark-landed, as the human: with a sha, with none, on an unapproved ticket
      const { spawnSync } = require('child_process');
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('INTELLAGENT_')));
      const merge = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'intellagent.js'), 'merge', ...args], { cwd: dir, env, encoding: 'utf8', input: '', timeout: 60000 });
      const c = await failedTicket('marked by the CLI with a sha', 'dee');
      fs.writeFileSync(path.join(dir, 'by-hand-c.txt'), 'resolved\n');
      git('add', '.');
      git('commit', '-q', '-m', 'no ticket id here either');
      const withSha = merge(c.id, '--mark-landed', git('rev-parse', 'HEAD'));
      assert.equal(withSha.status, 0, withSha.stderr);
      assert.match(withSha.stdout, /Marked landed by hand: [0-9a-f]{7}/);
      assert.equal((await s.ok('GET', `${B}/items/${c.id}`)).landing.by, 'hand');
      const d = await failedTicket('marked by the CLI with none', 'eli');
      fs.writeFileSync(path.join(dir, 'by-hand-d.txt'), 'resolved\n');
      git('add', '.');
      git('commit', '-q', '-m', `Landed by hand (${d.id})`);
      const none = merge(d.id, '--mark-landed');
      // The commit names the ticket, so the sweep (every 0.4 s here) may mark it first. Under a loaded full run
      // it often does: then the CLI is told it's already landed. Either order ends landed by hand.
      if (none.status === 0) assert.match(none.stdout, /Marked landed by hand/);
      else assert.match(none.stderr, new RegExp(`${d.id}'s landing isn't marked failed \\(it is landed\\)`), none.stderr);
      assert.equal((await s.ok('GET', `${B}/items/${d.id}`)).landing.by, 'hand');
      const refused = merge(u.id, '--mark-landed');
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /isn't approved.*hint: Landing follows an approval/, 'the error carries its hint');
      assert.equal(merge(c.id, '--mark-landed', 'a', 'b').status, 1, 'a second sha without a comma is refused, not dropped');
    } finally {
      await s.stop();
      try { execFileSync('git', ['worktree', 'prune'], { cwd: dir }); } catch { /* ignore */ }
    }
  });
});

describe('specialised agents', () => {
  it('areas, concerns and a context page reach the agent, its brief and the receptionist, and are editable', async () => {
    const fs = require('fs');
    const s = await startServer({ agents: { defaults: fast, agents: {
      desk: { role: 'coordinator', enabled: false },
      pixel: { run: run('ok'), areas: ['public/app.css'], concerns: ['dark/light parity'] },
    } } });
    try {
      // edit from the UI's API: add an area and write the context page
      const r = await s.ok('PATCH', '/api/agents/pixel', { areas: ['public/app.css', 'public/themes/'], concerns: ['dark/light parity', 'calm motion'], context: '# Pixel\nThemes live in STYLE tokens.' }, USER);
      assert.ok(r.changes.areas && r.changes.context, JSON.stringify(r.changes));
      const a = await s.ok('GET', '/api/agents/pixel');
      assert.deepEqual(a.areas, ['public/app.css', 'public/themes/']);
      assert.equal(a.contextFile, 'agent-context/pixel.md');
      assert.ok(fs.existsSync(path.join(s.dir, 'agent-context', 'pixel.md')), 'the context page is a file beside agents.json');
      assert.match((await s.ok('GET', '/api/agents/pixel/context')).text, /STYLE tokens/);
      // the agent's own brief, and the receptionist's routing view
      const brief = (await s.api('GET', `${B}/brief`, undefined, { agent: 'pixel' })).body;
      assert.match(typeof brief === 'string' ? brief : brief.markdown, /Your speciality[\s\S]*public\/themes\/[\s\S]*calm motion[\s\S]*STYLE tokens/);
      const desk = (await s.api('GET', `${B}/brief`, undefined, { agent: 'desk' })).body;
      assert.match(typeof desk === 'string' ? desk : desk.markdown, /\*\*pixel\*\*[\s\S]*owns: `public\/app\.css`/);
      // and the first prompt of a run
      const it = await s.ok('POST', `${B}/items`, { title: 'restyle', column: 'Backlog' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@pixel please' }, USER);
      await until(async () => (await comments(s, it.id)).some((c) => c.startsWith('pixel:')), 8000, 'pixel ran');
      const logs = fs.readdirSync(path.join(s.dir, 'data', 'agent-runs', 'pixel')).filter((x) => x.endsWith('.log'));
      const log = fs.readFileSync(path.join(s.dir, 'data', 'agent-runs', 'pixel', logs.at(-1)), 'utf8');
      assert.match(log, /## Base: how every agent works here\n\*\*The loop\.\*\*[\s\S]*## Your speciality[\s\S]*Pixel/);
      // agents without a grant can't change it; input is checked
      assert.equal((await s.api('PATCH', '/api/agents/pixel', { areas: ['x'] }, { agent: 'desk' })).status, 403);
      assert.equal((await s.api('PATCH', '/api/agents/pixel', { areas: Array.from({ length: 41 }, (_, i) => `f${i}`) }, USER)).status, 400);
    } finally { await s.stop(); }
  });
});

describe('agent reviewers', () => {
  it('the receptionist assigns a specialist reviewer (never the author), who comments a verdict; only the human approves', async () => {
    const s = await startServer({ agents: { agents: {
      desk: { role: 'coordinator', enabled: false },
      maker: { role: 'builder', enabled: false, reviewer: true },
      critic: { role: 'reviewer', enabled: false, areas: ['server.js'] },
      plain: { role: 'builder', enabled: false },
    } } });
    const ag = (agent) => ({ agent });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'feature', column: 'Ready', assignee: 'maker' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/start`, {}, ag('maker'));
      await s.ok('POST', `${B}/items/${it.id}/review`, { summary: 'done' }, ag('maker'));
      // the receptionist is told to assign one, and offered only reviewers who aren't the author
      const w = await s.ok('GET', `${B}/work?agent=desk`);
      const ask = w.next.find((n) => n.id === it.id && n.action === 'assign_reviewer');
      assert.ok(ask, 'receptionist gets assign_reviewer');
      assert.match(ask.why, /critic/);
      assert.doesNotMatch(ask.why, /maker/, 'the author is never offered');
      // never the author, never a non-reviewer, never by a builder
      assert.equal((await s.api('POST', `${B}/items/${it.id}/reviewers`, { name: 'maker' }, ag('desk'))).body.code, 'OWN_WORK');
      assert.equal((await s.api('POST', `${B}/items/${it.id}/reviewers`, { name: 'plain' }, ag('desk'))).body.code, 'NOT_REVIEWER');
      assert.equal((await s.api('POST', `${B}/items/${it.id}/reviewers`, { name: 'critic' }, ag('maker'))).body.code, 'HUMAN_ONLY');
      const { seq } = await s.ok('GET', '/api/app');
      await s.ok('POST', `${B}/items/${it.id}/reviewers`, { name: 'critic' }, ag('desk'));
      const ev = (await s.ok('GET', `/api/events?since=${seq}&types=review.reviewer_assigned`)).events.at(-1);
      assert.deepEqual(ev.addressed, ['critic'], 'the reviewer is woken');
      assert.ok((await s.ok('GET', `${B}/work?agent=critic`)).next.some((n) => n.action === 'review_ticket' && n.id === it.id));
      // only the reviewer gives its verdict; concerns @mention the author
      assert.equal((await s.api('POST', `${B}/items/${it.id}/reviewers/critic/verdict`, { verdict: 'ok' }, ag('desk'))).status, 403);
      const v = await s.ok('POST', `${B}/items/${it.id}/reviewers/critic/verdict`, { verdict: 'concerns', comment: 'No test for the error path.' }, ag('critic'));
      assert.equal(v.reviewers[0].verdict, 'concerns');
      assert.match(v.comments.at(-1).body, /⚠ \*\*Concerns\*\*[\s\S]*@maker/);
      assert.equal(v.column, 'Review', 'a reviewer never moves the ticket');
      assert.equal((await s.api('POST', `${B}/items/${it.id}/review/decision`, { verdict: 'approve' }, ag('critic'))).body.code, 'HUMAN_ONLY');
      // asking for review again resets the tick and wakes the reviewer
      await s.ok('POST', `${B}/items/${it.id}/start`, {}, ag('maker'));
      const again = await s.ok('POST', `${B}/items/${it.id}/review`, { summary: 'added the test' }, ag('maker'));
      assert.equal(again.reviewers[0].verdict, null);
      // a reviewer who starts working on the ticket can no longer judge it
      const it2 = await s.ok('POST', `${B}/items`, { title: 'second', column: 'Ready' }, USER);
      await s.ok('POST', `${B}/items/${it2.id}/reviewers`, { name: 'critic' }, USER);
      await s.ok('POST', `${B}/items/${it2.id}/lease`, {}, ag('critic'));
      assert.equal((await s.api('POST', `${B}/items/${it2.id}/reviewers/critic/verdict`, { verdict: 'ok' }, ag('critic'))).body.code, 'OWN_WORK');
    } finally { await s.stop(); }
  });
});

describe('agent permissions from the UI', () => {
  it('board access, keep-alive and runs per hour save with history; grants only from the signed-in human on a board with a token', async () => {
    // no token on this board: grants are refused even for the human
    const s1 = await startServer({ agents: { agents: { w: { role: 'builder', enabled: false } } } });
    try {
      assert.equal((await s1.api('POST', '/api/agents', { name: 'w', grants: ['review.decide'] }, USER)).body.code, 'NO_TOKEN');
      const r = await s1.ok('POST', '/api/agents', { name: 'w', keepAlive: true, maxRunsPerHour: 7, limits: { columns: ['Backlog', 'Ready'], readOnly: true } }, USER);
      assert.equal(r.keepAlive, true);
      assert.equal(r.maxRunsPerHour, 7);
      assert.deepEqual(r.limits, { columns: ['Backlog', 'Ready'], readOnly: true });
      assert.deepEqual((await s1.ok('GET', '/api/permissions/me', undefined, { agent: 'w' })).permissions, { columns: ['Backlog', 'Ready'], readOnly: true });
      assert.ok(r.changes.at(-1).changes.limits, 'the edit is in its Recent changes');
      assert.equal((await s1.ok('POST', '/api/agents', { name: 'w', maxRunsPerHour: null }, USER)).maxRunsPerHour, null, 'null stays "no limit"');
    } finally { await s1.stop(); }

    // with a token: the signed-in human may set grants; agents never
    const s2 = await startServer({ manifest: { auth: { userToken: 'secret-token' } }, agents: { agents: { w: { role: 'builder', enabled: false } } } });
    try {
      const human = (method, p, body) => fetch(`${s2.base}${p}`, { method, headers: { 'content-type': 'application/json', 'x-user': 'James', origin: s2.base, authorization: 'Bearer secret-token' }, body: body && JSON.stringify(body) }).then(async (x) => ({ status: x.status, body: await x.json() }));
      assert.equal((await s2.api('POST', '/api/agents', { name: 'w', grants: ['review.decide'] }, USER)).status, 401, 'no token, no human');
      assert.equal((await s2.api('POST', '/api/agents', { name: 'w', grants: ['review.decide'] }, { agent: 'w' })).status, 403, 'agents never');
      const g = await human('POST', '/api/agents', { name: 'w', grants: ['agents.control', { power: 'review.decide', where: { 'fields.risk': 'low' } }] });
      assert.equal(g.status, 201, JSON.stringify(g.body));
      assert.deepEqual(g.body.grants, ['agents.control', { power: 'review.decide', where: { 'fields.risk': 'low' } }]);
      const me = await fetch(`${s2.base}/api/permissions/me`, { headers: { 'x-agent': 'w' } }).then((x) => x.json());
      assert.deepEqual(me.grants.map((x) => x.power), ['agents.control', 'review.decide']);
      assert.equal((await human('POST', '/api/agents', { name: 'w', grants: ['make.coffee'] })).status, 400);
      // a scope narrows a power: a malformed one is refused, never dropped into "everywhere"
      const scoped = await human('POST', '/api/agents', { name: 'w', grants: [{ power: 'review.decide', where: { 'fields.my-risk': 'low' } }] });
      assert.deepEqual(scoped.body.grants, [{ power: 'review.decide', where: { 'fields.my-risk': 'low' } }], 'hyphenated keys are kept');
      for (const where of [{ 'fields risk': 'low' }, { 'fields.risk': '' }, { 'fields.risk': [] }, {}, 'risk=low', ['low']]) {
        const bad = await human('POST', '/api/agents', { name: 'w', grants: [{ power: 'review.decide', where }] });
        assert.equal(bad.status, 400, `refused: ${JSON.stringify(where)}`);
      }
      assert.deepEqual((await fetch(`${s2.base}/api/permissions/me`, { headers: { 'x-agent': 'w' } }).then((x) => x.json())).grants[0].where, { 'fields.my-risk': 'low' }, 'a refused save leaves the scoped grant as it was');
      assert.deepEqual((await human('POST', '/api/agents', { name: 'w', grants: [] })).body.grants, [], 'removing all grants');
    } finally { await s2.stop(); }
  });

  it('a grant in agents.json whose scope cannot be read is dropped, never widened to everywhere', async () => {
    const s2 = await startServer({ agents: { agents: {
      a: { grants: [{ power: 'review.decide', where: 'fields.risk=low' }] },
      b: { grants: [{ power: 'review.decide', where: {} }, { power: 'column.gate', where: ['Done'] }] },
      c: { grants: [{ power: 'review.decide', where: { 'fields.risk': '' } }, { power: 'agents.control', where: { column: 'Done' } }] },
    } } });
    try {
      const mine = async (n) => (await s2.ok('GET', '/api/permissions/me', undefined, { agent: n })).grants;
      assert.deepEqual(await mine('a'), []);
      assert.deepEqual(await mine('b'), []);
      assert.deepEqual((await mine('c')).map((g) => g.power), ['agents.control'], 'the well-formed grant stays');
      const it = await s2.ok('POST', '/api/boards/main/items', { title: 'x', column: 'Ready' }, { agent: 'dev' });
      await s2.ok('POST', `/api/boards/main/items/${it.id}/review`, { summary: 'done' }, { agent: 'dev' });
      const d = await s2.api('POST', `/api/boards/main/items/${it.id}/review/decision`, { verdict: 'approve' }, { agent: 'a' });
      assert.equal(d.status, 403);
      assert.equal(d.body.code, 'HUMAN_ONLY');
    } finally { await s2.stop(); }
  });
});

describe('extra commands the human allows', () => {
  it('commands in agents.json are allowed exactly as written; wildcards and shell punctuation are dropped', () => {
    const { runFor } = require('../lib/agents');
    const r = runFor(['edit', 'test'], { commands: ['npm run measure:board', 'rm -rf *', 'echo x; curl evil', 'git push'] });
    assert.ok(r.includes('"Bash(npm run measure:board)"'));
    assert.ok(r.includes('"Bash(git push)"'), "an exact command the human wrote is the human's call");
    assert.ok(!r.includes('rm -rf') && !r.includes('curl'));
    const withArgs = runFor(['edit'], { commands: ['npm run measure:board:*', 'npm *:run'] });
    assert.ok(withArgs.includes('"Bash(npm run measure:board:*)"'), 'a trailing :* allows that one command with any arguments');
    assert.ok(!withArgs.includes('npm *:run'), 'no other wildcards');
  });
});

describe('a run gets its own token (INT-248)', () => {
  it('in INTELLAGENT_TOKEN, never one inherited from the board', async () => {
    // the board itself was started with someone else's token in its environment
    const s = await startServer({ env: { INTELLAGENT_TOKEN: 'inherited-token' }, manifest: { auth: { requireAgentTokens: true } }, agents: { defaults: fast, agents: { adapter: { run: run('token') } } } });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'for the adapter', column: 'Backlog' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@adapter take a look' }, USER);
      const said = async () => (await s.ok('GET', `${B}/items/${it.id}`, undefined, USER)).comments.map((c) => `${c.author.name}: ${c.body}`);
      // the comment only lands if the token in its env is adapter's own (the board requires one)
      await until(async () => (await said()).some((c) => c.startsWith('adapter: token from env')), 8000, 'the adapter posted with its env token');
      const own = JSON.parse(fs.readFileSync(path.join(s.dir, 'local.json'), 'utf8')).agentTokens.adapter;
      assert.ok((await said()).includes(`adapter: token from env (${own.length} chars)`));
    } finally { await s.stop(); }
  });

  it('a rotated token starts a fresh keep-alive session; an unchanged one keeps it', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: { keeper: { run: run('stream'), keepAlive: 'stream-json', throttleMinutes: 0 } } } });
    const localFile = path.join(s.dir, 'local.json');
    const setToken = (t) => {
      const local = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, 'utf8')) : {};
      fs.writeFileSync(localFile, JSON.stringify({ ...local, agentTokens: { ...(local.agentTokens || {}), keeper: t } }));
    };
    const pidOf = (c) => Number(/pid (\d+)/.exec(c)?.[1]);
    const turns = async (id) => (await comments(s, id)).filter((c) => c.startsWith('keeper: turn'));
    try {
      setToken('a'.repeat(24));
      const it = await s.ok('POST', `${B}/items`, { title: 'rotate', column: 'Backlog' }, USER);
      const wake = async (n) => {
        await s.ok('POST', `${B}/items/${it.id}/comments`, { body: `@keeper wake ${n}` }, USER);
        await until(async () => (await turns(it.id)).length === n, 30000, `turn ${n}`);
        await until(async () => (await agentState(s, 'keeper')).status === 'idle', 30000, 'keeper idle');
      };
      await wake(1);
      await wake(2);
      setToken('b'.repeat(24)); // what `intellagent token --agent keeper --rotate` does to local.json
      await wake(3);
      const [t1, t2, t3] = await turns(it.id);
      assert.equal(pidOf(t1), pidOf(t2), 'same token: the second wake is a turn in the same session');
      assert.match(t3, /turn 1 in/, 'rotated: a fresh session');
      assert.notEqual(pidOf(t3), pidOf(t1));
      assert.ok(t3.endsWith('(full)'), `the fresh session gets the full prompt: ${t3}`);
    } finally { await s.stop(); }
  });
});

describe('stopping a board stops what it started', () => {
  it('killTree stops a process and the processes it started (agent runs must not outlive their board)', { skip: process.platform !== 'win32' && 'the orphan bug is Windows-only' }, async () => {
    const { spawn, execSync } = require('child_process');
    const { killTree } = require('../lib/kill');
    const p = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e3)'],{stdio:'ignore'});setInterval(()=>{},1e3)"], { stdio: 'ignore' });
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const kids = await until(() => {
      const k = execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${p.pid}').ProcessId"`, { encoding: 'utf8' }).split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number);
      return k.length ? k : null;
    }, 8000, 'the child started');
    assert.ok(killTree(p.pid));
    await until(() => !alive(p.pid) && !kids.some(alive), 5000, 'parent and child stopped');
  });
});

describe('base context and prompt layers (INT-251)', () => {
  const { REVIEW_PARTS, createBase, shipped } = require('../lib/agents/base');
  const { promptFor, layersFor } = require('../lib/agents/prompt');
  const ROLES = require('../lib/agents/roles.json');
  const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };

  it('the shipped base is used until the human saves their own; their copy survives, and saving the shipped text again removes it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-base-'));
    const base = createBase(dir);
    assert.deepEqual(base.read(), { text: shipped(), shipped: shipped(), edited: false });
    base.write('**Be kind.**\r\nAlways.');
    assert.deepEqual(base.read(), { text: '**Be kind.**\nAlways.', shipped: shipped(), edited: true });
    assert.ok(fs.existsSync(path.join(dir, 'base-context.md')), 'their copy is a file beside agents.json');
    assert.equal(base.write(`${shipped()}\n\n`), '**Be kind.**\nAlways.', 'returns what agents got before');
    assert.equal(fs.existsSync(path.join(dir, 'base-context.md')), false, 'the shipped text again is no copy, so updates reach them');
    base.write('mine'); base.write('   ');
    assert.equal(base.read().edited, false, 'empty resets to the shipped text');
    assert.throws(() => base.write('x'.repeat(9000)), /at most/);
    fs.writeFileSync(path.join(dir, 'base-context.md'), 'y'.repeat(9000));
    assert.match(base.read().text, /^y{8000}\n…\(base context cut at 8000 characters\)$/, 'a copy edited by hand past the cap says it was cut');
  });

  it('a first turn carries base, role and speciality in that order, each labelled; a warm turn carries none', () => {
    const layers = layersFor({ base: 'BASE', brief: 'ROLE', speciality: '## Your speciality\nSPEC' });
    assert.deepEqual(layers.map((l) => [l.layer, l.chars]), [['base', 4], ['role', 4], ['agent', 23]]);
    assert.deepEqual(layersFor({ base: 'BASE' }).map((l) => l.layer), ['base'], 'an empty layer is left out');
    const opts = { listen: 'inbox', evFile: 'e.json', base: 'BASE', brief: 'ROLE', speciality: '## Your speciality\nSPEC' };
    const cold = promptFor('pixel', [], opts);
    assert.match(cold, /^## Base: how every agent works here\nBASE\n\n## Your role\nROLE\n\n## Your speciality\nSPEC\n/);
    assert.doesNotMatch(promptFor('pixel', [], { ...opts, warm: true }), /BASE|ROLE|SPEC/);
  });

  it('every text that counts the review parts (role briefs, the base, AGENTS.md, the schema, the UI, the skills) names the ones the board asks for', () => {
    const root = path.join(__dirname, '..');
    const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
    const under = (dir, ext) => { try { return fs.readdirSync(path.join(root, dir), { recursive: true }).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f)); } catch { return []; } };
    // lib/agents.js is left out: its "four parts" are the modules createAgents wires, not a review
    const files = ['AGENTS.md', 'server.js', 'mcp.js', 'bin/intellagent.js', 'public/app.js', 'public/app.css', ...under('scripts', '.js'), ...under('skills', '.md')];
    const texts = {
      'base.md': shipped(),
      ...Object.fromEntries(files.filter((f) => fs.existsSync(path.join(root, f))).map((f) => [f, read(f)])),
      ...Object.fromEntries(Object.entries(ROLES).map(([k, r]) => [`roles.json ${k}`, r.brief])),
    };
    let named = 0;
    for (const [where, t] of Object.entries(texts)) {
      // "five parts", "five-part review", and "the other four parts" (all but changed)
      for (const m of t.matchAll(/\b(?:(other) )?(\w+)[- ]parts?\b(?:\s*\(([^)]*)\))?/gi)) {
        const n = NUMBERS[m[2].toLowerCase()];
        if (!n) continue;
        named++;
        assert.equal(n, REVIEW_PARTS.length - (m[1] ? 1 : 0), `${where}: "${m[0]}"`);
        if (m[3]) assert.deepEqual(m[3].split(/\s*[,/]\s*/).map((x) => x.trim()).sort(), [...REVIEW_PARTS].sort(), `${where}: "${m[0]}"`);
      }
    }
    assert.ok(named >= 8, `the check found the texts it is meant to cover (${named})`);
  });
});

describe('automatic rebalancing planner (INT-234)', () => {
  const { plan, pathsIn } = require('../lib/agents/rebalance');
  const NOW = Date.parse('2026-10-17T12:00:00Z');
  const H = 3600_000;
  const A = (name, extra = {}) => ({ name, state: 'active', edits: true, role: 'builder', tier: 'mid', areas: [], ...extra });
  const T = (id, assignee, extra = {}) => ({ id, assignee, inPickup: true, queuedAt: NOW - 2 * H, text: '', area: [], ...extra });
  const queueOf = (name, n, extra = {}) => Array.from({ length: n }, (_, i) => T(`${name}-${i + 1}`, name, { queuedAt: NOW - 2 * H + i, ...extra }));
  // apply moves the way the board will: new assignee, lastMovedAt now
  const apply = (tickets, moves, at = NOW) => tickets.map((t) => { const m = moves.find((x) => x.id === t.id); return m ? { ...t, assignee: m.to, lastMovedAt: at } : t; });

  it('moves nothing below the threshold or before the queue has waited, then just enough to close the gap', () => {
    const agents = [A('rocket'), A('drax')];
    assert.deepEqual(plan({ agents, tickets: [...queueOf('rocket', 4), ...queueOf('drax', 2)], now: NOW }), [], 'a gap of 2 is no imbalance');
    const fresh = [...queueOf('rocket', 5, { queuedAt: NOW - 30 * 60_000 }), ...queueOf('drax', 2)];
    assert.deepEqual(plan({ agents, tickets: fresh, now: NOW }), [], 'a queue younger than an hour waits');
    const moves = plan({ agents, tickets: [...queueOf('rocket', 5), ...queueOf('drax', 2)], now: NOW });
    assert.deepEqual(moves, [{ id: 'rocket-1', from: 'rocket', to: 'drax', why: 'rocket had 5 queued, drax 2' }], 'one move, oldest first: 4 and 3 are balanced');
  });

  it('never moves a ticket that is held, started, waiting on the human, blocked, pinned, assigned by the human, outside pickup or moved today', () => {
    const agents = [A('rocket'), A('drax')];
    const stuck = [{ held: true }, { started: true }, { waitingOnHuman: true }, { blocked: true }, { pinned: true }, { assignedByHuman: true }, { inPickup: false }, { lastMovedAt: NOW - 23 * H }]
      .map((x, i) => T(`stuck-${i}`, 'rocket', { queuedAt: NOW - 3 * H, ...x }));
    // the stuck ones still count towards rocket's queue (all but the one outside pickup and the started one)
    const moves = plan({ agents, tickets: [...stuck, T('free', 'rocket')], now: NOW });
    assert.deepEqual(moves.map((m) => m.id), ['free']);
    assert.deepEqual(plan({ agents, tickets: [...stuck, T('free', 'rocket', { lastMovedAt: NOW - 25 * H })], now: NOW }).map((m) => m.id), ['free'], 'a day later it may move again');
  });

  it('can never ping-pong: a second pass over its own result moves nothing, even once the day has passed', () => {
    const agents = [A('a'), A('b'), A('c')];
    let tickets = [...queueOf('a', 9), ...queueOf('b', 1)];
    const first = plan({ agents, tickets, now: NOW });
    assert.equal(first.length, 3, 'capped at maxMoves');
    tickets = apply(tickets, first);
    assert.deepEqual(plan({ agents, tickets, now: NOW }).filter((m) => first.some((f) => f.id === m.id)), [], 'what moved stays put today');
    // a day on, with every move forgotten, each pass only ever narrows the gap until it is under the threshold
    let t = tickets.map((x) => ({ ...x, lastMovedAt: null }));
    const seen = new Set();
    for (let pass = 0; pass < 10; pass++) {
      const m = plan({ agents, tickets: t, now: NOW + (pass + 1) * 25 * H });
      for (const x of m) { assert.ok(!seen.has(`${x.id}>${x.from}`), `${x.id} went back to ${x.from}`); seen.add(`${x.id}>${x.to}`); }
      t = apply(t, m, NOW + (pass + 1) * 25 * H);
      if (!m.length) break;
    }
    const sizes = ['a', 'b', 'c'].map((n) => t.filter((x) => x.assignee === n).length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) < 3, `balanced: ${sizes}`);
  });

  it('prefers the agent that owns the files, never takes work from its owner, and gives risk: high to a senior', () => {
    const groot = A('groot', { areas: ['lib/agents/'], tier: 'senior' });
    const rocket = A('rocket', { areas: ['server.js'] });
    const drax = A('drax');
    assert.deepEqual(pathsIn('Fix `lib/agents/runner.js` and server.js'), ['lib/agents/runner.js', 'server.js']);
    // rocket is overloaded; a ticket naming lib/agents/ goes to groot even though drax's queue is shorter
    const tickets = [T('x', 'rocket', { text: 'in lib/agents/scheduler.js', queuedAt: NOW - 3 * H }), ...queueOf('rocket', 5), ...queueOf('groot', 1), ...queueOf('drax', 0)];
    assert.equal(plan({ agents: [groot, rocket, drax], tickets, now: NOW, settings: { maxMoves: 1 } }).find((m) => m.id === 'x')?.to, 'groot');
    // groot is overloaded with its own files: they stay with it
    const own = [...queueOf('groot', 6, { text: 'lib/agents/runner.js' })];
    assert.deepEqual(plan({ agents: [groot, drax], tickets: own, now: NOW }), []);
    // a risky ticket with no owner goes to the senior
    const risky = [T('r', 'rocket', { risk: 'high' }), ...queueOf('rocket', 5)];
    assert.equal(plan({ agents: [rocket, drax, A('opus', { tier: 'senior' })], tickets: risky, now: NOW, settings: { maxMoves: 1 } })[0].to, 'opus');
  });

  it("a removed agent's unstarted tickets all move at once, pins included; an away agent's move without the threshold; only active builders take work", () => {
    const tickets = [...queueOf('gone', 5, { pinned: true }), T('gone-started', 'gone', { started: true }), T('nap-1', 'napper')];
    const agents = [A('gone', { state: 'removed' }), A('napper', { state: 'away', awayAs: 'paused' }), A('drax'), A('kraglin', { edits: false, role: 'reviewer' }), A('paused', { state: 'away' })];
    const moves = plan({ agents, tickets, now: NOW });
    assert.deepEqual(moves.filter((m) => m.from === 'gone').map((m) => m.id), ['gone-1', 'gone-2', 'gone-3', 'gone-4', 'gone-5'], 'not capped, started stays');
    assert.ok(moves.every((m) => m.to === 'drax'), 'never to a reviewer or an away agent');
    assert.match(moves.find((m) => m.from === 'gone').why, /gone was removed/);
    assert.deepEqual(plan({ agents: [A('napper', { state: 'away', awayAs: 'paused' }), A('drax')], tickets: [T('nap-1', 'napper')], now: NOW }),
      [{ id: 'nap-1', from: 'napper', to: 'drax', why: 'napper has been paused for long' }]);
    assert.deepEqual(plan({ agents: [A('gone', { state: 'removed' }), A('kraglin', { edits: false })], tickets, now: NOW }), [], 'nobody to take it: nothing moves');
  });

  it("an agent that is off neither gives nor takes; a target's allowed columns are respected", () => {
    const tickets = [...queueOf('napper', 6, { column: 'ready' }), ...queueOf('rocket', 6, { column: 'ready' })];
    assert.deepEqual(plan({ agents: [A('napper', { state: 'off' }), A('rocket', { state: 'off' }), A('drax')], tickets, now: NOW }), [], 'paused less than an hour, or stopped: its queue waits for it');
    assert.deepEqual(plan({ agents: [A('rocket'), A('drax', { columns: ['backlog'] })], tickets, now: NOW }), [], 'drax may not work in ready');
    assert.equal(plan({ agents: [A('rocket'), A('drax', { columns: ['ready'] })], tickets, now: NOW }).length, 2);
  });
});
