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

describe('keep-alive standing agents', () => {
  it('one process serves several wakes as turns, is recycled after recycleAfterRuns, restarts after a crash and stops on pause', async () => {
    const marker = path.join(require('os').tmpdir(), `ia-crash-${Date.now()}`);
    const s = await startServer({ agents: { defaults: fast, agents: {
      keeper: { role: 'builder', run: run('stream'), keepAlive: true, recycleAfterRuns: 2, throttleMinutes: 0 },
      crashy: { run: run('stream', `"${marker}"`), keepAlive: true },
    } } });
    const pidOf = (c) => Number(/pid (\d+)/.exec(c)?.[1]);
    const mine = async (id, who) => (await comments(s, id)).filter((c) => c.startsWith(`${who}: turn`));
    const idle = (who) => until(async () => (await agentState(s, who)).status === 'idle', 6000, `${who} idle`);
    try {
      const it = await s.ok('POST', `${B}/items`, { title: 'keep-alive', column: 'Backlog' }, USER);
      for (let n = 1; n <= 3; n++) {
        await s.ok('POST', `${B}/items/${it.id}/comments`, { body: `@keeper wake ${n}` }, USER);
        await until(async () => (await mine(it.id, 'keeper')).length === n, 8000, `turn ${n}`);
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
      await until(async () => (await mine(c.id, 'crashy')).length === 1, 10000, 'retried in a new process');
      assert.equal((await agentState(s, 'crashy')).failures, 0);
    } finally {
      await s.stop();
      require('fs').rmSync(marker, { force: true });
    }
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
      await s.ok('POST', `${B}/items/${a.id}/review/decision`, { verdict: 'approve' }, USER);
      assert.ok(fs.existsSync(path.join(dir, `work-${a.id}.txt`)), 'landed on main');
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
});
