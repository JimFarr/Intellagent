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
});

describe('model tiers', () => {
  it('model reaches a claude run as --model; an explicit --model or a non-claude run is left alone; the receptionist sees the team', async () => {
    const s = await startServer({ agents: { defaults: { ...fast, model: 'sonnet' }, agents: {
      desk: { role: 'coordinator', enabled: false, run: run('ok') },
      junior: { role: 'builder', model: 'haiku', enabled: false, description: 'small tickets' },
      mid: { role: 'builder', enabled: false },
      pinned: { run: 'claude -p "x" --model opus', model: 'haiku', enabled: false },
      scripted: { run: run('ok'), model: 'haiku', enabled: false },
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
});

describe('keep-alive standing agents', () => {
  it('one process serves several wakes as turns, is recycled after recycleAfterRuns, restarts after a crash and stops on pause', async () => {
    const marker = path.join(require('os').tmpdir(), `ia-crash-${Date.now()}`);
    const s = await startServer({ agents: { defaults: fast, agents: {
      keeper: { role: 'builder', run: run('stream'), keepAlive: true, recycleAfterRuns: 2, throttleMinutes: 0 },
      crashy: { run: run('stream', `"${marker}"`), keepAlive: true },
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
    const s = await startServer({ agents: { defaults: fast, agents: { twice: { run: run('stream-linger', `"${f}"`, 2000), keepAlive: true } } } });
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
    let s = await startServer({ agents });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'restart', column: 'Backlog' }, USER);
      await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@survivor go' }, USER);
      await until(() => fs.existsSync(f), 8000, 'first run started');
      const first = Number(pids(f)[0]);
      const dir = s.dir;
      await s.stop({ keep: true, hard: true }); // a crash: no clean stop, so nothing kills the run
      assert.ok(alive(first), 'the run outlived its board');      s = await startServer({ dir, agents });
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
});

describe('keep-alive recycling by context size', () => {
  it('replaces a session once its context per call passes recycleAboveTokens, and reports the size', async () => {
    // the fake agent's context grows 50k per turn: 50k, 100k, 150k
    const s = await startServer({ agents: { defaults: fast, agents: {
      fat: { role: 'builder', run: run('stream'), keepAlive: true, recycleAboveTokens: 120000, throttleMinutes: 0 },
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
      assert.equal(boardMcpConfig(dir), '.mcp.json');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
      // a dirty main checkout blocks landing, and the card says how to finish
      fs.writeFileSync(path.join(dir, 'README.md'), 'edited by the human\n');
      await s.ok('POST', `${B}/items/${b.id}/review`, { summary: 'done' }, { agent: 'bob' });
      await s.ok('POST', `${B}/items/${b.id}/review/decision`, { verdict: 'approve' }, USER);
      assert.match((await comments(s, b.id)).at(-1), /Not landed: the main checkout has uncommitted changes.*intellagent merge/);
      git('checkout', 'README.md');
      const land = await s.ok('POST', `${B}/items/${b.id}/land`, {}, USER);
      assert.equal(land.landed.length, 1);
      assert.ok(fs.existsSync(path.join(dir, `work-${b.id}.txt`)));
    } finally {
      await s.stop();
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
    const s = await startServer({ dir, agents: { defaults: fast, agents: {
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
      // approval with a dirty main checkout: the landing fails and goes to the lander
      fs.writeFileSync(path.join(dir, 'README.md'), 'edited by the human\n');
      await s.ok('POST', `${B}/items/${b.id}/review/decision`, { verdict: 'approve' }, USER);
      const note = (await comments(s, b.id)).at(-1);
      assert.match(note, /Not landed: the main checkout has uncommitted changes/);
      assert.match(note, /@yondu will land it/);
      assert.doesNotMatch(note, /intellagent merge/, 'the human is not asked to run it');
      assert.equal((await s.ok('GET', `${B}/items/${b.id}`)).landing.state, 'failed');
      const work = (await s.ok('GET', `${B}/work`, undefined, { agent: 'yondu' })).next;
      assert.equal(work.find((n) => n.id === b.id)?.action, 'land');
      // an agent without work.land may not land
      assert.equal((await s.api('POST', `${B}/items/${b.id}/land`, { agent: 'bob' }, { agent: 'eve' })).body.code, 'HUMAN_ONLY');
      // the lander lands it once main is clean
      git('checkout', 'README.md');
      const landed = await s.ok('POST', `${B}/items/${b.id}/land`, { agent: 'bob' }, { agent: 'yondu' });
      assert.equal(landed.landed.length, 1);
      assert.ok(fs.existsSync(path.join(dir, `work-${b.id}.txt`)), 'on main');
      assert.equal((await s.ok('GET', `${B}/items/${b.id}`)).landing.state, 'landed');
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
      assert.match(log, /## Your speciality[\s\S]*Pixel/);
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
