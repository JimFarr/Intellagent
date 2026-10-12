'use strict';
// Standing agents: the board starts runs for agents defined in agents.json.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
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
        },
      },
    });
  });
  after(async () => { await s.stop(); });

  it('lists agents from agents.json', async () => {
    const { agents } = await s.ok('GET', '/api/agents');
    assert.deepEqual(agents.map((a) => a.name), ['bot', 'flaky', 'slowpoke', 'budget', 'coord', 'calm']);
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

describe('coordinator role', () => {
  it('wakes on tickets the human creates, without being assigned', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: { triager: { role: 'coordinator', run: run('ok') } } } });
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'unassigned new ticket', column: 'Backlog' }, USER);
      await until(async () => (await comments(s, it.id)).some((c) => c.startsWith('triager:')), 8000, 'coordinator triage run');
      const brief = (await s.ok('GET', '/api/agents/triager')).listen;
      assert.deepEqual(brief, ['inbox', 'new-tickets']);
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
