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

  it('a leftover process that never reports its exit holds the next run a minute at most, then is stopped (INT-379)', () => {
    const { scheduler, core, agents, started } = rig({ def: { throttleMinutes: 0 } });
    let left = 1;
    let stopped = 0;
    core.runner.lingering = () => left;
    core.runner.endLingering = () => { stopped++; left = 0; return 1; };
    scheduler.dispatch('bot');
    assert.equal(started.length, 0);
    assert.equal(agents.bot.status, 'waiting', 'it says it is waiting, not the status it had before');
    assert.equal(agents.bot.waitingFor, 'its last run to end');
    mock.timers.tick(30_000);
    assert.equal(started.length, 0, 'still within the minute');
    mock.timers.tick(31_000);
    assert.equal(stopped, 1, 'the leftover is stopped');
    assert.equal(started.length, 1, 'and the run starts');
  });

  it('a newer work summary keeps the work of one not yet read, and drops what has left the list (INT-378)', () => {
    const { scheduler, core, agents } = rig({ state: { queue: [] } });
    const w = (id) => ({ key: `decide:${id}`, action: 'decide', id, why: 'ready' });
    core.deps.pending = () => [w('LNZ-2')];
    scheduler.checkPending('bot');
    // before the agent runs, the list changes: LNZ-5 and LNZ-6 join, LNZ-2 is still there
    core.deps.pending = () => [w('LNZ-2'), w('LNZ-5'), w('LNZ-6')];
    scheduler.checkPending('bot');
    const summaries = agents.bot.queue.filter((e) => e.type === 'work.pending');
    assert.equal(summaries.length, 1, 'still one summary');
    assert.deepEqual(summaries[0].work.map((x) => x.id).sort(), ['LNZ-2', 'LNZ-5', 'LNZ-6']);
    // and LNZ-5 leaves before a third sweep that finds LNZ-7
    core.deps.pending = () => [w('LNZ-2'), w('LNZ-6'), w('LNZ-7')];
    scheduler.checkPending('bot');
    assert.deepEqual(agents.bot.queue.filter((e) => e.type === 'work.pending')[0].work.map((x) => x.id).sort(), ['LNZ-2', 'LNZ-6', 'LNZ-7']);
  });

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

  it('a resume whose timer was lost is found by the sweep once it is half a minute late, and only then (INT-379)', () => {
    const { scheduler, agents, started } = rig({ def: { throttleMinutes: 0, maxRunsPerHour: 2 }, state: { status: 'throttled', resumesAt: ago(-10 * MIN), runs: [ago(50 * MIN), ago(40 * MIN)] } });
    assert.deepEqual(scheduler.checkMissedResumes(), [], 'not due yet');
    mock.timers.tick(10 * MIN + 20_000);
    assert.deepEqual(scheduler.checkMissedResumes(), [], 'due, but within the grace of the timer itself');
    mock.timers.tick(20_000);
    assert.deepEqual(scheduler.checkMissedResumes(), ['bot']);
    mock.timers.tick(5000);
    assert.equal(started.length, 1, 'it runs its queued events');
    assert.deepEqual(scheduler.checkMissedResumes(), [], 'and is not woken again: nothing queued');
    assert.equal(agents.bot.queue.length, 0);
  });

  it('cap of 2: the third event waits for the hour, then runs (INT-379)', () => {
    const { scheduler, agents, started } = rig({ def: { throttleMinutes: 0, maxRunsPerHour: 2 } });
    scheduler.dispatch('bot'); mock.timers.tick(5 * MIN);
    agents.bot.queue.push({ seq: 2, type: 'comment.added' }); scheduler.dispatch('bot'); mock.timers.tick(5 * MIN);
    agents.bot.queue.push({ seq: 3, type: 'comment.added' }); scheduler.dispatch('bot');
    assert.equal(started.length, 2);
    assert.equal(agents.bot.status, 'throttled');
    mock.timers.tick(50 * MIN + 2000);
    assert.equal(started.length, 3, 'the third runs once the first is an hour old');
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

  it('an agent held for the usage limit waits for the reset, says why, then runs by itself (INT-293)', () => {
    const { scheduler, agents, started } = rig({ def: { throttleMinutes: 0 } });
    scheduler.holdForLimit('bot', Date.now() + 30 * MIN);
    assert.equal(agents.bot.status, 'waiting');
    assert.equal(agents.bot.waitingFor, 'usage limit');
    assert.equal(agents.bot.resumesAt, new Date(T0 + 30 * MIN).toISOString());
    scheduler.dispatch('bot');
    mock.timers.tick(29 * MIN);
    assert.equal(started.length, 0, 'not before the reset');
    assert.ok(Date.parse(scheduler.whenRuns('bot').at) >= T0 + 30 * MIN, 'whenRuns promises the reset, not the settle delay');
    mock.timers.tick(MIN + 2000);
    assert.equal(started.length, 1, 'runs once the limit resets');
    assert.equal(agents.bot.waitingFor, undefined);
    assert.equal(agents.bot.limitedUntil, undefined);
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

  it('work an agent left alone is offered once more after reofferMinutes, then stays quiet (INT-397)', () => {
    const { scheduler, core, agents } = rig({ state: { queue: [] } });
    core.deps.pending = () => [{ key: 'start:INT-1', action: 'start', id: 'INT-1', rev: 3 }];
    const queued = () => agents.bot.queue.filter((e) => e.type === 'work.pending').length;
    scheduler.checkPending('bot');
    assert.equal(queued(), 1);
    agents.bot.queue.length = 0;
    mock.timers.tick(119 * MIN);
    scheduler.checkPending('bot');
    assert.equal(queued(), 0, 'not yet two hours');
    mock.timers.tick(2 * MIN);
    scheduler.checkPending('bot');
    assert.equal(queued(), 1, 'offered again once');
    agents.bot.queue.length = 0;
    mock.timers.tick(600 * MIN);
    scheduler.checkPending('bot');
    assert.equal(queued(), 0, 'left alone again: no third wake');
  });

  it('work whose ticket changed since it was offered is offered once more, and a busy ticket cannot loop it (INT-397)', () => {
    let rev = 3;
    const { scheduler, core, agents } = rig({ def: { reofferMinutes: 0 }, state: { queue: [] } });
    core.deps.pending = () => [{ key: 'start:INT-1', action: 'start', id: 'INT-1', rev }];
    const queued = () => agents.bot.queue.filter((e) => e.type === 'work.pending').length;
    scheduler.checkPending('bot');
    agents.bot.queue.length = 0;
    scheduler.checkPending('bot');
    assert.equal(queued(), 0, 'unchanged: quiet');
    rev = 4;
    scheduler.checkPending('bot');
    assert.equal(queued(), 1, 'a blocker done, a comment: offered again');
    agents.bot.queue.length = 0;
    rev = 5;
    scheduler.checkPending('bot');
    rev = 6;
    scheduler.checkPending('bot');
    assert.equal(queued(), 0, 'one change-wake per piece of work, however often the ticket moves');
  });

  it('work that left the list and returns starts over (INT-397)', () => {
    let on = true;
    const { scheduler, core, agents } = rig({ state: { queue: [] } });
    core.deps.pending = () => (on ? [{ key: 'start:INT-1', action: 'start', id: 'INT-1', rev: 1 }] : []);
    scheduler.checkPending('bot');
    on = false;
    scheduler.checkPending('bot');
    agents.bot.queue.length = 0;
    on = true;
    scheduler.checkPending('bot');
    assert.equal(agents.bot.queue.length, 1);
    assert.deepEqual(Object.keys(agents.bot.seenMeta), ['start:INT-1']);
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

  it('stays quiet while the builders wait for the usage limit, and counts the quiet stretch from the reset (INT-293)', () => {
    const { scheduler, alarms, st } = alarmRig();
    scheduler.holdForLimit('worker', Date.now() + 60 * MIN);
    advance(60 * MIN);
    assert.equal(st('watch').queue.length + alarms.length, 0, 'nobody could run: no alarm');
    advance(19 * MIN);
    assert.equal(alarms.length, 0, 'the builders get their usual quiet stretch after the reset');
    advance(2 * MIN + 5000);
    assert.equal(alarms.length, 1, 'and then it alarms as usual');
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

// INT-296: above 85% of the five-hour window, pickup and supervise nudges wait for the reset
describe("the account's usage holds back optional work (fake clock)", () => {
  const { parseRate } = require('../lib/agents/usage');
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 }));
  afterEach(() => mock.timers.reset());
  const RESET = T0 + 60 * MIN;
  function usageRig(work) {
    const r = rig({ def: { run: 'claude -p "x"' }, state: { queue: [] } });
    r.core.deps.pending = () => work;
    r.offered = () => { const e = r.agents.bot.queue.find((x) => x.type === 'work.pending'); r.agents.bot.queue.length = 0; return e ? e.work.map((w) => w.id) : []; };
    return r;
  }
  const W = (action, id) => ({ key: `main:${action}:${id}`, action, id });

  it('parseRate reads every window from the newest rate_limit_event, and nothing from the prompt', () => {
    const ev = (u) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: u, resetsAt: 1800000000 }, seven_day: { utilization: 0.6, resetsAt: 1800500000 } } } });
    const log = `prompt mentions ${ev(0.99)}\n--- output ---\n${ev(0.4)}\n{"type":"assistant"}\n${ev(0.42)}\n`;
    assert.deepEqual(parseRate(log), { five_hour: { utilization: 0.42, resetsAt: 1800000000000 }, seven_day: { utilization: 0.6, resetsAt: 1800500000000 } });
    const older = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.7, resetsAt: 1800000000 } });
    assert.deepEqual(parseRate(`--- output ---\n${older}`), { five_hour: { utilization: 0.7, resetsAt: 1800000000000 } });
    assert.equal(parseRate('--- output ---\n{"type":"result"}'), null);
  });

  it('held: only the work that is not optional is offered; after the reset the held work wakes it once', () => {
    const { scheduler, core, offered } = usageRig([W('pickup', 'T-1'), W('supervise', 'T-2'), W('start', 'T-3')]);
    scheduler.noteRate('bot', { five_hour: { utilization: 0.9, resetsAt: RESET } });
    scheduler.checkPending('bot');
    assert.deepEqual(offered(), ['T-3'], 'its own started-work queue still wakes it');
    scheduler.checkPending('bot');
    assert.deepEqual(offered(), [], 'and nothing again while held: no loop');
    assert.equal(scheduler.usageView().anthropic.heldBack, true);
    mock.timers.tick(61 * MIN);
    scheduler.checkPending('bot');
    assert.deepEqual(offered(), ['T-1', 'T-2'], 'after the reset the optional work is fresh');
    scheduler.checkPending('bot');
    assert.deepEqual(offered(), [], 'once');
    assert.equal(scheduler.usageView().anthropic.heldBack, false);
    assert.equal(scheduler.heldMinutes(T0 - MIN), 60, 'held from the report to the reset');
    assert.equal(core.state.usageHolds.length, 1);
  });

  it('minutes held stop at the reset though nobody looked since, and overlapping accounts count once', () => {
    const { scheduler, core } = usageRig([]);
    scheduler.noteRate('bot', { five_hour: { utilization: 0.9, resetsAt: RESET } });
    mock.timers.tick(3 * 60 * MIN); // well past the reset; nothing called holding() meanwhile
    assert.equal(scheduler.heldMinutes(T0 - MIN), 60, 'the open stretch ends at its reset, not at now');
    const from = new Date(T0).toISOString();
    core.state.usageHolds.push({ provider: 'other', from, until: new Date(RESET).toISOString(), to: new Date(RESET).toISOString() });
    assert.equal(scheduler.heldMinutes(T0 - MIN), 60, 'a second account held over the same hour is still one hour');
  });

  it('work it already saw before the hold does not wake it again at the reset', () => {
    const { scheduler, offered } = usageRig([W('pickup', 'T-4')]);
    scheduler.checkPending('bot');
    assert.deepEqual(offered(), ['T-4'], 'seen while there was room');
    scheduler.noteRate('bot', { five_hour: { utilization: 0.95, resetsAt: RESET } });
    scheduler.checkPending('bot');
    mock.timers.tick(61 * MIN);
    scheduler.checkPending('bot');
    assert.deepEqual(offered(), [], 'left alone before: still left alone');
  });

  it('below the threshold nothing is held, and a custom run with no provider has no account to hold', () => {
    const r = usageRig([W('pickup', 'T-5')]);
    r.scheduler.noteRate('bot', { five_hour: { utilization: 0.84, resetsAt: RESET } });
    r.scheduler.checkPending('bot');
    assert.deepEqual(r.offered(), ['T-5']);
    const c = usageRig([W('pickup', 'T-6')]);
    c.core.defs.bot.run = 'node adapter.js';
    c.scheduler.noteRate('bot', { five_hour: { utilization: 0.99, resetsAt: RESET } });
    c.scheduler.checkPending('bot');
    assert.deepEqual(c.offered(), ['T-6']);
    assert.deepEqual(c.scheduler.usageView(), {});
  });
});

// INT-294: the alarm's only target is down, so it tells the human instead of going silent
describe('the idle-board alarm falls back to the human (fake clock)', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 }));
  afterEach(() => mock.timers.reset());
  const humanRig = () => {
    const r = alarmRig();
    r.recorded = [];
    r.core.deps.onIdleAlarm = (board, rec) => r.recorded.push({ board, ...rec, at: Date.now() - T0 });
    return r;
  };

  it('a failed target: the human is told what waits and who is down, with the same backoff, and nobody is woken', () => {
    const { scheduler, agents, alarms, recorded, st, builderRuns } = humanRig();
    Object.assign(st('watch'), { status: 'failed', failures: 3, lastRun: { code: 1 } });
    scheduler.checkIdle();
    advance(20 * MIN + 5000);
    assert.equal(recorded.length, 1, 'told the human at 20 min');
    const [rec] = recorded;
    assert.deepEqual(rec.woke, ['human']);
    assert.equal(rec.human, true);
    assert.deepEqual(rec.waiting, ['T-1']);
    assert.deepEqual(rec.down, [{ name: 'watch', status: 'failed', code: 1, failures: 3 }]);
    assert.deepEqual(rec.builders.map((b) => b.name), ['worker']);
    assert.equal(agents.watch.queue.length + alarms.length, 0, 'the failed agent is not woken');
    // the builder runs and starts nothing, again and again: the human hears at 20, 60, 140 min, never every pass
    for (let i = 0; i < 5; i++) { builderRuns(); advance(20 * MIN + 100); } // to ~120 min
    assert.equal(recorded.length, 2, 'one repeat in the next 100 minutes, not five');
    assert.ok(recorded[1].at >= 60 * MIN);
    assert.equal(recorded[1].repeat, 2);
    advance(25 * MIN);
    assert.equal(recorded.length, 3, 'the third 80 min after the second');
    assert.ok(recorded[2].at >= 140 * MIN);
  });

  it('once the target is back, the alarm wakes it again instead of the human', () => {
    const { scheduler, alarms, recorded, st, board } = humanRig();
    st('watch').paused = true;
    scheduler.checkIdle();
    advance(20 * MIN + 5000);
    assert.deepEqual(recorded.map((r) => r.down.map((d) => d.status)), [['paused']]);
    st('watch').paused = false;
    board.waiting = [...board.waiting, { board: 'main', id: 'T-2', title: 'two', assignee: null }];
    scheduler.checkIdle();
    advance(5000);
    assert.deepEqual(alarms.map((a) => a.agent), ['watch'], 'watch is woken for the new set');
    assert.deepEqual(recorded.map((r) => r.woke), [['human'], ['watch']]);
  });

  it('none named still reaches the human; the switch off keeps it quiet', () => {
    const { scheduler, core, recorded } = humanRig();
    let setting = { board: 'main', on: true, minutes: 20, wake: [], note: '' };
    core.deps.idleAlarms = () => [setting];
    scheduler.checkIdle();
    advance(20 * MIN + 5000);
    assert.deepEqual(recorded.map((r) => [r.board, r.woke, r.down]), [['main', ['human'], []]]);
    setting = { ...setting, human: false, wake: ['watch'] };
    core.defs.watch.enabled = false;
    advance(300 * MIN);
    scheduler.checkIdle();
    assert.equal(recorded.length, 1, 'human: false and nobody to wake: quiet');
  });

  it('quiet during Stop all and while the builders wait for the usage limit: both end by themselves or by the human', () => {
    const { scheduler, recorded, st } = humanRig();
    st('watch').status = 'failed';
    st('worker').paused = true; // Stop all pauses every agent, builders too
    scheduler.checkIdle();
    advance(60 * MIN);
    scheduler.checkIdle();
    assert.equal(recorded.length, 0, 'Stop all: the human did it, nothing to tell');
    st('worker').paused = false;
    scheduler.holdForLimit('worker', Date.now() + 60 * MIN);
    advance(60 * MIN + 19 * MIN);
    assert.equal(recorded.length, 0, 'the usage limit recovers by itself; then the usual quiet stretch');
    advance(2 * MIN + 5000);
    assert.deepEqual(recorded.map((r) => r.woke), [['human']]);
  });
});

// Two builders and a reviewer; deps.rebalance records each call, the way the board's planner would be asked.
function rebalanceRig({ loadError = null } = {}) {
  const calls = [];
  const started = [];
  const agents = {};
  const st = (n) => (agents[n] ||= { status: 'idle', cursor: 0, queue: [], inflight: null, runs: [], failures: 0, lastRun: null });
  const defs = {
    rocket: { name: 'rocket', enabled: true, worktree: true, role: 'builder', model: 'opus', areas: ['server.js'], settleSeconds: 3, throttleMinutes: 0 },
    drax: { name: 'drax', enabled: true, worktree: true, role: 'builder', model: 'sonnet', settleSeconds: 3, throttleMinutes: 0 },
    kraglin: { name: 'kraglin', enabled: true, role: 'reviewer', settleSeconds: 3, throttleMinutes: 0 },
  };
  const state = { agents };
  const core = {
    deps: { emit() {}, seq: () => 1, recent: () => [], rebalance: (x) => calls.push({ at: Date.now() - T0, ...x }) },
    state, save() {}, st, requeueInflight() {}, defs,
    running: new Map(), sessions: new Map(), timers: new Map(), procs: new Map(), held: new Map(),
    config: { wakes: () => true, need: (n) => n, loadError: () => loadError },
    runner: { lingering: () => 0, endSession() {}, start(name, d, s) { started.push(name); s.runs.push(new Date().toISOString()); s.queue.splice(0); } },
    view: (name) => ({ name }),
  };
  for (const n of Object.keys(defs)) st(n);
  const scheduler = createScheduler(core);
  core.scheduler = scheduler;
  const stateOf = (n) => scheduler.rebalanceAgents().find((a) => a.name === n);
  return { scheduler, core, defs, state, calls, started, stateOf };
}

describe('when rebalancing is asked for (INT-234, fake clock)', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 }));
  afterEach(() => mock.timers.reset());

  it('describes each agent for the planner: builders active, a reviewer takes no work, tiers from the model', () => {
    const { stateOf } = rebalanceRig();
    assert.deepEqual(stateOf('rocket'), { name: 'rocket', state: 'active', edits: true, role: 'builder', tier: 'senior', areas: ['server.js'] });
    assert.equal(stateOf('drax').tier, 'mid');
    assert.equal(stateOf('kraglin').edits, false);
  });

  it('a helper takes no rebalanced work, though it edits files (INT-252)', () => {
    const { defs, stateOf } = rebalanceRig();
    defs.drax.helper = true;
    assert.equal(stateOf('drax').edits, false);
    assert.equal(stateOf('rocket').edits, true);
  });

  it('an agent paused on its own is off for an hour, then away; resuming makes it active again', () => {
    const { scheduler, stateOf } = rebalanceRig();
    scheduler.api.pause('drax');
    assert.equal(stateOf('drax').state, 'off', 'just paused: it neither gives nor takes');
    mock.timers.tick(59 * MIN);
    assert.equal(stateOf('drax').state, 'off');
    mock.timers.tick(2 * MIN);
    assert.deepEqual([stateOf('drax').state, stateOf('drax').awayAs], ['away', 'paused']);
    scheduler.api.unpause('drax');
    assert.equal(stateOf('drax').state, 'active');
  });

  it('Stop all never counts as away, however long it lasts; resuming everyone sets off nothing', () => {
    const { scheduler, stateOf, calls } = rebalanceRig();
    scheduler.api.pause('drax'); // paused on its own before the stop: it stays away from then
    mock.timers.tick(10 * MIN);
    scheduler.api.stopAll();
    mock.timers.tick(3 * 60 * MIN);
    assert.equal(stateOf('rocket').state, 'off', 'stopped, not away');
    assert.equal(stateOf('drax').state, 'away', 'its own pause still counts');
    scheduler.api.resumeAll();
    assert.deepEqual(['rocket', 'drax'].map((n) => stateOf(n).state), ['active', 'active']);
    assert.equal(calls.length, 0, 'the human controls never ask for a rebalance themselves');
  });

  it('a failed agent is away an hour after it failed', () => {
    const { scheduler, stateOf } = rebalanceRig();
    scheduler.setStatus('rocket', 'failed', { failedAt: new Date().toISOString() });
    mock.timers.tick(30 * MIN);
    assert.equal(stateOf('rocket').state, 'off');
    mock.timers.tick(31 * MIN);
    assert.deepEqual([stateOf('rocket').state, stateOf('rocket').awayAs], ['away', 'failed']);
  });

  it('a sweep asks at most every ten minutes; a change to the team asks at once', () => {
    const { scheduler, calls } = rebalanceRig();
    scheduler.checkRebalance('sweep');
    scheduler.checkRebalance('sweep');
    mock.timers.tick(9 * MIN);
    scheduler.checkRebalance('sweep');
    assert.equal(calls.length, 1);
    mock.timers.tick(MIN);
    scheduler.checkRebalance('sweep');
    assert.equal(calls.length, 2);
    scheduler.checkRebalance('agents.changed');
    assert.deepEqual(calls.map((c) => c.reason), ['sweep', 'sweep', 'agents.changed']);
  });

  it('an agent taken out of agents.json is removed after a ten-minute grace, for a day; coming back clears it; a file with a problem removes nobody', () => {
    const { scheduler, defs, calls, stateOf } = rebalanceRig();
    const before = { rocket: 'builder', drax: 'builder', kraglin: 'reviewer' };
    delete defs.drax;
    scheduler.agentsChanged(before);
    assert.equal(calls.length, 1, 'asked at once');
    assert.equal(calls[0].agents.find((a) => a.name === 'drax'), undefined, 'inside the grace: in no list, so nothing of its moves');
    mock.timers.tick(9 * MIN);
    assert.equal(stateOf('drax'), undefined);
    mock.timers.tick(MIN);
    assert.equal(stateOf('drax').state, 'removed', 'ten minutes on, the removal counts');
    defs.drax = { name: 'drax', enabled: true, worktree: true, role: 'builder', settleSeconds: 3 };
    scheduler.agentsChanged({ rocket: 'builder', kraglin: 'reviewer' });
    assert.equal(stateOf('drax').state, 'active', 'back: not removed');
    delete defs.drax;
    scheduler.agentsChanged(before);
    mock.timers.tick(25 * 60 * MIN);
    assert.equal(stateOf('drax'), undefined, 'a day on, a removed agent is forgotten');
    // a role change is a change to the team; the same team is not
    const n = calls.length;
    scheduler.agentsChanged({ rocket: 'reviewer', kraglin: 'reviewer' });
    scheduler.agentsChanged({ rocket: 'builder', kraglin: 'reviewer' });
    assert.equal(calls.length, n + 1);

    const bad = rebalanceRig({ loadError: 'agents.json: agent "drax": unknown permission(s) x' });
    delete bad.defs.drax;
    bad.scheduler.agentsChanged(before);
    assert.equal(bad.stateOf('drax'), undefined, 'dropped by a problem in the file: never treated as removed');
  });

  it('one save mid-edit drains nothing: removed, then back inside the grace, no pass ever sees the agent as removed', () => {
    const { scheduler, defs, calls } = rebalanceRig();
    const all = { rocket: 'builder', drax: 'builder', kraglin: 'reviewer' };
    const draxDef = defs.drax;
    delete defs.drax;
    scheduler.agentsChanged(all);
    mock.timers.tick(4 * MIN);
    defs.drax = draxDef;
    scheduler.agentsChanged({ rocket: 'builder', kraglin: 'reviewer' });
    for (let i = 0; i < 6; i++) { mock.timers.tick(10 * MIN); scheduler.checkRebalance('sweep'); }
    assert.ok(calls.length >= 8, 'the passes ran');
    for (const c of calls) assert.notEqual(c.agents.find((a) => a.name === 'drax')?.state, 'removed', `pass at ${c.at / MIN} min`);
  });

  it('a pass that throws is logged, and the next sweep still asks', () => {
    const { scheduler, core } = rebalanceRig();
    const lines = [];
    core.deps.log = (l) => lines.push(l);
    let n = 0;
    core.deps.rebalance = () => { n++; throw new Error('boom'); };
    scheduler.checkRebalance('sweep');
    mock.timers.tick(10 * MIN);
    scheduler.checkRebalance('sweep');
    assert.equal(n, 2);
    assert.deepEqual(lines, ['agents: rebalancing (sweep) failed: boom', 'agents: rebalancing (sweep) failed: boom']);
  });

  it('no loop: the wake a move causes (an assignment for its new owner) never asks for another rebalance', () => {
    const { scheduler, calls, started, core } = rebalanceRig();
    // the board applies a move: drax is woken by its item.assigned, runs, and finishes
    core.deps.rebalance = (x) => { calls.push(x); scheduler.enqueue('drax', [{ seq: 50 + calls.length, type: 'item.assigned' }]); };
    scheduler.checkRebalance('sweep');
    mock.timers.tick(3100);
    assert.deepEqual(started, ['drax'], 'the move woke its new owner once');
    scheduler.checkPending('drax');
    scheduler.sweepAll();
    scheduler.checkRebalance('sweep');
    mock.timers.tick(5 * MIN);
    assert.equal(calls.length, 1, 'nothing it caused asked again');
    assert.deepEqual(started, ['drax']);
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

  // INT-295: three failed catch-ups make the agent failed; the fourth call is its one probe
  async function failTimes(r, n) {
    for (let i = 0; i < n; i++) {
      if (i) mock.timers.tick(10 * MIN); // past the back-off
      else r.scheduler.dispatch('bot');
      r.settle().rej(new Error('index.lock exists'));
      await flush();
    }
  }

  it('a failed agent gets one probe after failedRetryMinutes; a failed probe is final until the human resumes', async () => {
    const r = live();
    const { scheduler, agents, calls, emitted } = r;
    await failTimes(r, 3);
    assert.equal(agents.bot.status, 'failed');
    const failedAt = Date.now();
    assert.equal(agents.bot.probeAt, new Date(failedAt + 30 * MIN).toISOString(), 'the default cool-off is 30 minutes');
    assert.equal(emitted.filter((e) => e.type === 'agent.failed').at(-1).probeAt, agents.bot.probeAt);
    // new events during the cool-off don't start it early
    scheduler.enqueue('bot', [{ seq: 7, type: 'comment.added' }]);
    mock.timers.tick(29 * MIN);
    assert.equal(calls.length, 3, 'no run before the cool-off ends');
    mock.timers.tick(MIN + 100);
    assert.equal(calls.length, 4, 'the probe');
    assert.equal(agents.bot.probing, true);
    r.settle().rej(new Error('index.lock exists'));
    await flush();
    assert.equal(agents.bot.status, 'failed');
    assert.equal(agents.bot.probeAt, undefined, 'no second probe');
    assert.equal(emitted.filter((e) => e.type === 'agent.failed').at(-1).probeAt, null);
    for (let i = 0; i < 10; i++) { mock.timers.tick(60 * MIN); scheduler.dispatch('bot'); }
    assert.equal(calls.length, 4, 'ten hours and every dispatch later: still waiting for the human (no loop)');
    // the human resumes: a new streak, which gets its own probe
    scheduler.api.resume('bot');
    assert.equal(calls.length, 5);
    assert.equal(agents.bot.probing, undefined);
  });

  it('failedRetryMinutes: 0 turns the probe off', async () => {
    const r = live();
    r.core.defs.bot.failedRetryMinutes = 0;
    await failTimes(r, 3);
    assert.equal(r.agents.bot.status, 'failed');
    assert.equal(r.agents.bot.probeAt, undefined);
    mock.timers.tick(24 * 60 * MIN);
    assert.equal(r.calls.length, 3);
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

describe('saving through a rename (Windows)', () => {
  it('a rename that fails a few times with EPERM is tried again, not thrown', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { renameRetry } = require('../lib/jsonfile');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-rename-'));
    const tmp = path.join(dir, 'a.tmp');
    const file = path.join(dir, 'a.json');
    fs.writeFileSync(tmp, '{}');
    const real = fs.renameSync;
    let fails = 3;
    fs.renameSync = (...a) => { if (fails-- > 0) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return real(...a); };
    try { renameRetry(tmp, file); } finally { fs.renameSync = real; }
    assert.equal(fs.readFileSync(file, 'utf8'), '{}');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
