'use strict';
// The scheduler on its own, with a fake clock (node:test's mock timers) and a runner that only records
// what it was asked to start: settle delay, throttle, the hourly cap and the retry back-off, with no server
// and no process.
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createScheduler } = require('../lib/agents/scheduler');

const MIN = 60_000;
const T0 = Date.parse('2026-01-01T12:00:00Z');
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// One agent, "bot", with one event queued. What the runner is asked to start ends up in `started`.
function rig({ def = {}, state = {}, save = () => {} } = {}) {
  const started = [];
  const emitted = [];
  const agents = { bot: { status: 'idle', cursor: 0, queue: [{ seq: 1, type: 'comment.added' }], inflight: null, runs: [], failures: 0, lastRun: null, ...state } };
  const core = {
    deps: { emit: (e) => emitted.push(e), seq: () => 1, recent: () => [] },
    state: { agents },
    save: () => save(agents),
    st: (name) => agents[name],
    requeueInflight() {},
    defs: { bot: { name: 'bot', enabled: true, settleSeconds: 3, throttleMinutes: 3, maxRunsPerHour: 20, ...def } },
    running: new Map(), sessions: new Map(), timers: new Map(), procs: new Map(), held: new Map(),
    config: { wakes: () => true, need: (n) => n },
    runner: {
      lingering: () => 0,
      endSession() {},
      start(name, d, s) { started.push(Date.now()); s.runs.push(new Date().toISOString()); s.queue.splice(0); },
    },
    view: (name) => ({ name }),
  };
  const scheduler = createScheduler(core);
  core.scheduler = scheduler;
  return { scheduler, core, agents, started, emitted };
}

describe('scheduler (fake clock)', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 }));
  afterEach(() => mock.timers.reset());

  it('a quiet agent runs once the settle delay has passed, and not before', () => {
    const { scheduler, started } = rig();
    scheduler.enqueue('bot', [{ seq: 2, type: 'comment.added' }]);
    mock.timers.tick(2900);
    assert.equal(started.length, 0);
    mock.timers.tick(200);
    assert.equal(started.length, 1);
  });

  it('events queued twice with the same seq and type are one event', () => {
    const { scheduler, agents } = rig({ state: { queue: [] } });
    scheduler.enqueue('bot', [{ seq: 5, type: 'comment.added' }]);
    scheduler.enqueue('bot', [{ seq: 5, type: 'comment.added' }, { seq: 5, type: 'item.moved' }]);
    assert.deepEqual(agents.bot.queue.map((e) => `${e.seq}:${e.type}`), ['5:comment.added', '5:item.moved']);
    assert.equal(agents.bot.cursor, 5);
  });

  it('throttle: an agent woken one minute ago waits out the rest of its three, then runs', () => {
    const { scheduler, agents, started } = rig({ state: { runs: [ago(1 * MIN)] } });
    scheduler.dispatch('bot');
    assert.equal(started.length, 0);
    assert.equal(agents.bot.status, 'waiting');
    assert.equal(Date.parse(agents.bot.resumesAt) - Date.now(), 2 * MIN + 250);
    mock.timers.tick(2 * MIN);
    assert.equal(started.length, 0, 'not before the window ends');
    mock.timers.tick(300);
    assert.equal(started.length, 1);
  });

  it('throttleMinutes 0 turns the throttle off', () => {
    const { scheduler, started } = rig({ def: { throttleMinutes: 0 }, state: { runs: [ago(1000)] } });
    scheduler.dispatch('bot');
    assert.equal(started.length, 1);
  });

  it('a retry after a failure ignores the throttle (it follows its own back-off)', () => {
    const { scheduler, started } = rig({ state: { runs: [ago(1000)], failures: 1 } });
    scheduler.dispatch('bot');
    assert.equal(started.length, 1);
  });

  it('maxRunsPerHour: the agent is throttled until its oldest run in the hour is an hour old', () => {
    const { scheduler, agents, started } = rig({ def: { throttleMinutes: 0, maxRunsPerHour: 2 }, state: { runs: [ago(30 * MIN), ago(10 * MIN)] } });
    scheduler.dispatch('bot');
    assert.equal(started.length, 0);
    assert.equal(agents.bot.status, 'throttled');
    assert.equal(Date.parse(agents.bot.resumesAt) - Date.now(), 30 * MIN + 1000);
    mock.timers.tick(30 * MIN);
    assert.equal(started.length, 0);
    mock.timers.tick(2000);
    assert.equal(started.length, 1);
  });

  it('runs older than an hour do not count towards maxRunsPerHour', () => {
    const { scheduler, agents, started } = rig({ def: { throttleMinutes: 0, maxRunsPerHour: 2 }, state: { runs: [ago(90 * MIN), ago(70 * MIN), ago(10 * MIN)] } });
    scheduler.dispatch('bot');
    assert.equal(started.length, 1);
    assert.equal(agents.bot.runs.length, 2, 'the two old ones were dropped, the new one added');
  });

  it('maxRunsPerHour null means no limit', () => {
    const { scheduler, started } = rig({ def: { throttleMinutes: 0, maxRunsPerHour: null }, state: { runs: Array.from({ length: 50 }, () => ago(MIN)) } });
    scheduler.dispatch('bot');
    assert.equal(started.length, 1);
  });

  it('whenRuns says when queued events will run: the settle delay, pushed out by the throttle', () => {
    const quiet = rig();
    assert.equal(Date.parse(quiet.scheduler.whenRuns('bot').at) - Date.now(), 3000);
    const busy = rig({ state: { runs: [ago(1 * MIN)] } });
    assert.equal(Date.parse(busy.scheduler.whenRuns('bot').at) - Date.now(), 2 * MIN);
  });

  it('whenRuns promises nothing for an agent that is paused, failed or disabled, and says busy during a run', () => {
    assert.equal(rig({ state: { paused: true } }).scheduler.whenRuns('bot'), null);
    assert.equal(rig({ state: { status: 'failed' } }).scheduler.whenRuns('bot'), null);
    assert.equal(rig({ def: { enabled: false } }).scheduler.whenRuns('bot'), null);
    const r = rig();
    r.core.running.set('bot', {});
    assert.deepEqual(r.scheduler.whenRuns('bot'), { busy: true });
  });

  it('a paused agent is not started, and says so', () => {
    const { scheduler, agents, started } = rig({ state: { paused: true } });
    scheduler.dispatch('bot');
    assert.equal(started.length, 0);
    assert.equal(agents.bot.status, 'paused');
  });

  it('a failed agent waits for the human: dispatch starts nothing', () => {
    const { scheduler, started } = rig({ state: { status: 'failed' } });
    scheduler.dispatch('bot');
    assert.equal(started.length, 0);
  });

  it('a process still lingering from the last run holds the next one back a second at a time', () => {
    const { scheduler, core, started } = rig();
    let lingering = 1;
    core.runner.lingering = () => lingering;
    scheduler.dispatch('bot');
    mock.timers.tick(1000);
    assert.equal(started.length, 0);
    lingering = 0;
    mock.timers.tick(1000);
    assert.equal(started.length, 1);
  });

  it('checkPending queues one work.pending event, and the same work never wakes the agent twice', () => {
    const { scheduler, core, agents } = rig({ state: { queue: [] } });
    core.deps.pending = () => [{ key: 'start:INT-1', action: 'start', id: 'INT-1', why: 'assigned' }];
    scheduler.checkPending('bot');
    assert.equal(agents.bot.queue.length, 1);
    assert.equal(agents.bot.queue[0].type, 'work.pending');
    agents.bot.queue.length = 0;
    scheduler.checkPending('bot');
    assert.equal(agents.bot.queue.length, 0, 'seen once, left alone');
  });

  // INT-213: the state file is written once per event, however many agents it wakes.
  function crowd(n, wakes = () => true) {
    const saves = [];
    // the save spy records how long each agent's queue was at the moment of the write
    const r = rig({ state: { queue: [] }, save: (agents) => saves.push(Object.fromEntries(Object.entries(agents).map(([k, s]) => [k, s.queue.length]))) });
    r.saves = saves;
    for (let i = 2; i <= n; i++) {
      r.agents[`bot${i}`] = { status: 'idle', cursor: 0, queue: [], inflight: null, runs: [], failures: 0, lastRun: null };
      r.core.defs[`bot${i}`] = { ...r.core.defs.bot, name: `bot${i}` };
    }
    r.core.config.wakes = wakes;
    r.core.deps.onQueued = (name) => r.saves.push(`queued:${name}`);
    return r;
  }

  it('an event that wakes seven agents saves the state once, with every queue in it, before anything is scheduled', () => {
    const { scheduler, saves, started } = crowd(7);
    scheduler.onEvent({ seq: 2, type: 'comment.added' });
    const writes = saves.filter((x) => typeof x === 'object');
    assert.equal(writes.length, 1);
    assert.deepEqual(Object.values(writes[0]), [1, 1, 1, 1, 1, 1, 1], 'all seven queues are in the one write');
    assert.equal(typeof saves[0], 'object', 'saved before any ⏳ is promised');
    mock.timers.tick(3100);
    assert.equal(started.length, 7, 'and every one of them still runs: nobody starves');
  });

  it('an event that wakes nobody writes nothing, and an agent event never queues', () => {
    const { scheduler, saves, agents } = crowd(3, (def) => def.name === 'nobody');
    scheduler.onEvent({ seq: 2, type: 'comment.added' });
    assert.equal(saves.length, 0);
    const all = crowd(3);
    all.scheduler.onEvent({ seq: 3, type: 'agent.run.finished' });
    assert.equal(all.saves.length, 0, "an agent's own run events never wake it (no loop)");
    assert.equal(agents.bot.queue.length, 0);
  });

  it('recover catches up every agent with one write', () => {
    const { scheduler, core, saves } = crowd(4);
    core.deps.recent = () => [{ seq: 5, type: 'comment.added' }];
    core.deps.seq = () => 5;
    scheduler.recover();
    const writes = saves.filter((x) => typeof x === 'object');
    assert.equal(writes.length, 1);
    assert.deepEqual(Object.values(writes[0]), [1, 1, 1, 1]);
  });
});

// The idle-board alarm (INT-265): a builder ("worker", it edits files) and the agent the alarm wakes ("watch").
function alarmRig() {
  const agents = {};
  const st = (name) => (agents[name] ||= { status: 'idle', cursor: 0, queue: [], inflight: null, runs: [], failures: 0, lastRun: null });
  const board = { waiting: [{ board: 'main', id: 'T-1', title: 'one', assignee: 'worker' }] };
  const alarms = [];
  const core = {
    deps: { emit() {}, seq: () => 1, recent: () => [], waiting: () => board.waiting },
    state: { agents }, save() {}, st, requeueInflight() {},
    defs: {
      worker: { name: 'worker', enabled: true, worktree: true, settleSeconds: 3, throttleMinutes: 0 },
      watch: { name: 'watch', enabled: true, idleAlarm: true, idleAlarmMinutes: 20, settleSeconds: 3, throttleMinutes: 0 },
    },
    running: new Map(), sessions: new Map(), timers: new Map(), procs: new Map(), held: new Map(),
    config: { wakes: () => true, need: (n) => n },
    runner: {
      lingering: () => 0,
      endSession() {},
      start(name, d, s) {
        for (const e of s.queue) if (e.type === 'board.idle') alarms.push({ agent: name, at: Date.now() - T0, waiting: e.waiting.map((w) => w.id), note: e.note, board: e.board });
        s.runs.push(new Date().toISOString()); s.queue.splice(0);
      },
    },
    view: (name) => ({ name }),
  };
  const scheduler = createScheduler(core);
  core.scheduler = scheduler;
  // the builder runs (and starts nothing): what the alarm's own nudge causes
  const builderRuns = () => { st('worker').runs.push(new Date().toISOString()); scheduler.checkIdle(); };
  return { scheduler, core, agents, board, alarms, builderRuns, st };
}

// Advance the fake clock in 1 s steps, so timers set while it runs (the settle delay after an alarm) fire too
const advance = (ms) => { for (let left = ms; left > 0; left -= 1000) mock.timers.tick(Math.min(1000, left)); };

describe('the idle-board alarm (fake clock)', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 }));
  afterEach(() => mock.timers.reset());

  it('is due idleAlarmMinutes after the board starts, and not before', () => {
    const { scheduler, agents, alarms } = alarmRig();
    scheduler.checkIdle();
    advance(20 * MIN - 1000);
    assert.equal(agents.watch.queue.length, 0, 'not before the limit');
    advance(1100);
    assert.deepEqual(agents.watch.queue.map((e) => e.type), ['board.idle']);
    advance(3000);
    assert.equal(alarms.length, 1);
    assert.deepEqual(alarms[0].waiting, ['T-1']);
  });

  it('the same waiting tickets alarm again only after twice the wait each time, however often its nudge wakes a builder', () => {
    const { scheduler, alarms, builderRuns } = alarmRig();
    scheduler.checkIdle();
    advance(20 * MIN + 5000); // first alarm at 20 min
    assert.equal(alarms.length, 1);
    // the nudge wakes the builder, which says "waiting on X" and starts nothing, every 20 minutes for an hour
    for (let i = 0; i < 3; i++) { builderRuns(); advance(20 * MIN + 100); }
    assert.equal(alarms.length, 2, 'one repeat in the hour, not three');
    assert.ok(alarms[1].at >= 60 * MIN, `the repeat waits 40 min after the first (at ${alarms[1].at / MIN} min)`);
    // the second came at ~60 min, so the third is due 80 min after it, at ~140 min (we are at ~80)
    advance(59 * MIN);
    assert.equal(alarms.length, 2, 'the next repeat waits 80 min');
    advance(2 * MIN);
    assert.equal(alarms.length, 3);
  });

  it('a different set of waiting tickets alarms once the builders have been quiet long enough', () => {
    const { scheduler, alarms, board, builderRuns } = alarmRig();
    scheduler.checkIdle();
    advance(20 * MIN + 5000);
    assert.equal(alarms.length, 1);
    board.waiting = [...board.waiting, { board: 'main', id: 'T-2', title: 'two', assignee: null }];
    builderRuns();
    advance(19 * MIN);
    assert.equal(alarms.length, 1, 'still within the quiet limit');
    advance(MIN + 5000);
    assert.equal(alarms.length, 2);
    assert.deepEqual(alarms[1].waiting, ['T-1', 'T-2']);
  });

  it('stays quiet while the builders are paused, have events queued, or nothing waits', () => {
    const { scheduler, agents, board, st } = alarmRig();
    st('worker').paused = true;
    scheduler.checkIdle();
    advance(30 * MIN);
    scheduler.checkIdle();
    assert.equal(agents.watch.queue.length, 0, 'paused');
    st('worker').paused = false;
    st('worker').queue.push({ seq: 9, type: 'comment.added' });
    scheduler.checkIdle();
    assert.equal(agents.watch.queue.length, 0, 'queued');
    st('worker').queue.length = 0;
    board.waiting = [];
    scheduler.checkIdle();
    assert.equal(agents.watch.queue.length, 0, 'nothing waits');
  });

  it('the board\'s setting decides: who it wakes, after how long, with the human\'s note; off means quiet', () => {
    const { scheduler, core, agents, alarms } = alarmRig();
    const recorded = [];
    core.defs.lead = { name: 'lead', enabled: true, settleSeconds: 3, throttleMinutes: 0 };
    let setting = { board: 'main', on: true, minutes: 30, wake: ['lead'], note: 'Ask Gamora first.' };
    core.deps.idleAlarms = () => [setting];
    core.deps.onIdleAlarm = (board, rec) => recorded.push({ board, ...rec });
    scheduler.checkIdle();
    advance(20 * MIN + 5000);
    assert.equal(alarms.length, 0, 'not at 20 min: the setting says 30, and the agents.json flag is only the fallback');
    advance(10 * MIN);
    assert.deepEqual(alarms.map((a) => [a.agent, a.note, a.board]), [['lead', 'Ask Gamora first.', 'main']], 'lead is woken at 30 min, with the note');
    assert.deepEqual(recorded.map((r) => [r.board, r.woke, r.repeat]), [['main', ['lead'], 1]]);
    // switched off: quiet, whatever waits
    setting = { ...setting, on: false };
    advance(300 * MIN);
    scheduler.checkIdle();
    assert.equal(alarms.length, 1);
  });
});

// INT-212: the runner catches the worktree up with async git. Until that is done the agent holds a starting
// slot, so nothing else starts it: no second run into the same worktree (INT-196).
describe('a run that is catching up its worktree (fake clock)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createRunner } = require('../lib/agents/runner');
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 }));
  afterEach(() => mock.timers.reset());
  const flush = () => new Promise((r) => setImmediate(r));

  // The real scheduler and runner; ensure() waits on a promise the test settles.
  function live() {
    const r = rig({ def: { worktree: true, throttleMinutes: 0, settleSeconds: 0, retrySeconds: 1, maxFailures: 3, run: 'never-spawned' } });
    const calls = [];
    let settle;
    r.core.deps = {
      ...r.core.deps,
      logDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ia-run-')), cwd: os.tmpdir(),
      worktrees: { ensure: (name) => { calls.push(name); return new Promise((res, rej) => { settle = { res, rej }; }); } },
    };
    // a failed or stopped run's events go back on the queue, as in lib/agents/state.js
    r.core.requeueInflight = (s) => { if (s.inflight) s.queue.unshift(...s.inflight); s.inflight = null; };
    r.core.runner = createRunner(r.core);
    return { ...r, calls, settle: () => settle };
  }

  it('a dispatch, a run-now or a new event while ensure() is pending starts nothing', async () => {
    const { scheduler, core, agents, calls } = live();
    scheduler.dispatch('bot');
    assert.deepEqual(calls, ['bot'], 'the run started and is catching up');
    assert.equal(core.running.get('bot')?.starting, true);
    scheduler.enqueue('bot', [{ seq: 2, type: 'comment.added' }]);
    scheduler.dispatch('bot');
    scheduler.api.runNow('bot', 'again');
    mock.timers.tick(10 * MIN);
    await flush();
    assert.deepEqual(calls, ['bot'], 'still one run');
    assert.deepEqual(agents.bot.queue.map((e) => e.seq), [2], 'the new event waits for the next run');
  });

  it('a failed catch-up clears the slot and is retried with back-off', async () => {
    const { scheduler, core, agents, calls, settle } = live();
    scheduler.dispatch('bot');
    settle().rej(new Error('merge in progress'));
    await flush();
    assert.equal(core.running.has('bot'), false, 'the slot is gone');
    assert.equal(agents.bot.failures, 1);
    assert.equal(agents.bot.status, 'retrying');
    assert.match(agents.bot.lastRun.error, /worktree: merge in progress/);
    mock.timers.tick(1000);
    assert.deepEqual(calls, ['bot', 'bot'], 'retried after the back-off');
  });

  it('pause during the catch-up: no process starts, and its events go back on the queue', async () => {
    const { scheduler, core, agents, settle } = live();
    scheduler.dispatch('bot');
    scheduler.api.pause('bot');
    settle().res({ path: os.tmpdir(), branch: 'agent/bot', main: 'main', note: null });
    await flush();
    assert.equal(core.running.has('bot'), false);
    assert.equal(core.procs.size, 0, 'no process was started');
    assert.deepEqual(agents.bot.queue.map((e) => e.seq), [1], 'the event it was woken for waits');
    assert.equal(agents.bot.failures, 0);
    assert.equal(agents.bot.status, 'paused');
  });

  it('stop all during the catch-up: no process starts, the events wait, and it is not a failure', async () => {
    const { scheduler, core, agents, settle } = live();
    scheduler.dispatch('bot');
    assert.deepEqual(scheduler.api.stopAll().stopped, ['bot']);
    settle().res({ path: os.tmpdir(), branch: 'agent/bot', main: 'main', note: null });
    await flush();
    assert.equal(core.running.has('bot'), false);
    assert.equal(core.procs.size, 0, 'no process was started');
    assert.equal(agents.bot.lastRun.code, 'stopped');
    assert.equal(agents.bot.failures, 0);
    assert.equal(agents.bot.status, 'paused');
  });
});
