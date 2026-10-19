'use strict';
// The alerting simulator (lib/sim, INT-383): whole flows on a simulated board, with the board's own rules and the
// real scheduler, in milliseconds. Each test reads: given this team and board, when this happens, these agents
// wake, in this order, with this work.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createSim } = require('../lib/sim');
const { agentLike } = require('../lib/sim/behaviours');

// The columns of this project's board: Backlog sleeps (agents file there; nothing starts there)
const SLEEPING = [
  { name: 'Backlog', flags: { allowCreate: true, sleeping: true } },
  { name: 'Ready', flags: { pickup: true, allowCreate: true } },
  { name: 'In Progress', flags: { working: true } },
  { name: 'Review', flags: { review: true } },
  { name: 'Done', flags: { releaseLeaseOnEnter: true, humanOnlyIn: true } },
];

let sim = null;
afterEach(() => { sim?.close(); sim = null; });

describe('alerting simulator', () => {
  it('a ticket goes from the human to Done with nobody poked by hand: triage, build, review, decision', () => {
    sim = createSim({ columns: SLEEPING, team: {
      gamora: { role: 'coordinator', behave: agentLike({ builders: ['groot'], reviewers: ['nebula'] }) },
      groot: { role: 'builder', behave: agentLike() },
      nebula: { role: 'reviewer', behave: agentLike() },
      stakar: { role: 'builder', grants: ['review.decide'], behave: agentLike() },
    } });
    const t = sim.human.create({ title: 'Fix the login', column: 'Ready' });
    sim.tick('1h');
    assert.equal(sim.item(t).columnId, 'done', `it got done: ${sim.wakes().join(' | ')}`);
    assert.deepEqual(sim.wakes().map((w) => w.split(' ')[0]), ['gamora', 'groot', 'gamora', 'nebula', 'stakar'], 'triage, build, assign a reviewer, review, decide: nobody woken twice');
  });

  it('a name without @, or an @ inside code or a quote, wakes nobody', () => {
    sim = createSim({ team: { rocket: { role: 'builder' } } });
    const t = sim.human.create({ title: 'x', column: 'Ready' });
    sim.human.comment(t, 'Rocket, take this');
    sim.human.comment(t, 'see `@rocket` and\n> @rocket said');
    sim.tick('10m');
    assert.deepEqual(sim.wakes('rocket'), []);
    sim.human.comment(t, '@rocket take this');
    sim.tick('1m');
    assert.deepEqual(sim.wakes('rocket'), ['rocket comment.added T-1']);
  });

  it('an assignment in a sleeping column wakes nobody; moving it to Ready wakes the assignee', () => {
    sim = createSim({ columns: SLEEPING, team: { groot: { role: 'builder' } } });
    const t = sim.human.create({ title: 'later', column: 'Backlog', assignee: 'groot' });
    sim.tick('30m');
    assert.deepEqual(sim.wakes('groot'), [], 'asleep: no wake, and no pending work offered');
    sim.human.move(t, 'Ready');
    sim.tick('1m');
    assert.deepEqual(sim.wakes('groot'), ['groot item.moved T-1']);
  });

  it('an approval is news, not a task: the author is not woken for it', () => {
    sim = createSim({ team: { groot: { role: 'builder' } } });
    const t = sim.human.create({ title: 'x', column: 'Ready' });
    sim.as('groot').start(t);
    sim.as('groot').review(t);
    sim.tick('10m');
    const before = sim.runs.length;
    sim.human.decide(t, 'approve');
    sim.tick('10m');
    assert.equal(sim.runs.length, before, sim.wakes().join(' | '));
    assert.equal(sim.item(t).columnId, 'done');
  });

  it('the throttle batches a burst: ten comments in a minute wake a builder twice, with all ten delivered', () => {
    sim = createSim({ team: { groot: { role: 'builder' } } });
    const t = sim.human.create({ title: 'x', column: 'Ready' });
    for (let i = 0; i < 10; i++) { sim.human.comment(t, `@groot note ${i}`); sim.tick('6s'); }
    sim.tick('10m');
    const runs = sim.runs.filter((r) => r.agent === 'groot');
    assert.equal(runs.length, 2);
    assert.equal(runs.flatMap((r) => r.events).filter((e) => e.type === 'comment.added').length, 10);
  });

  it('reports the alerting metrics of the board: wakes by reason, runs that changed nothing, tickets nobody will touch (INT-389)', () => {
    sim = createSim({ team: { groot: { role: 'builder', behave: agentLike() } } });
    const t = sim.human.create({ title: 'x', column: 'Ready', assignee: 'groot' });
    sim.human.create({ title: 'orphan', column: 'Review' });
    sim.tick('10m');
    sim.human.comment(t, '@groot thanks!'); // nothing to do: a run that changes nothing
    sim.tick('10m');
    const m = sim.metrics();
    assert.deepEqual(m.wakes, { 'item.assigned': 1, 'comment.added': 1 });
    assert.equal(m.idleRuns, 1);
    assert.deepEqual(m.unowned, ['T-2']);
  });

  it('work that appears while an agent waits out its hourly cap is offered once it can run (INT-378)', () => {
    // Lenza, 2026-10-19: the supervisor read only his events; a ticket became decidable while he waited, and the
    // run that followed (for other events) must not count it as seen.
    sim = createSim({ team: {
      stakar: { role: 'builder', grants: ['review.decide'], maxRunsPerHour: 2, throttleMinutes: 0, behave: agentLike({ reads: 'events' }) },
      groot: { role: 'builder' }, nebula: { role: 'reviewer' },
    } });
    const other = sim.human.create({ title: 'something else', column: 'Ready' });
    sim.human.comment(other, '@stakar one');
    sim.tick('2m');
    sim.human.comment(other, '@stakar two');
    sim.tick('2m');
    sim.human.comment(other, '@stakar three'); // capped: waits for the hour
    sim.tick('5m');
    assert.equal(sim.agent('stakar').status, 'throttled');
    const t = sim.human.create({ title: 'to decide', column: 'Ready' });
    sim.as('groot').start(t);
    sim.as('groot').review(t);
    sim.human.addReviewer(t, 'nebula');
    sim.as('nebula').verdict(t, 'ok'); // decidable now, while stakar waits
    sim.tick('2h');
    assert.equal(sim.item(t).columnId, 'done', sim.wakes('stakar').join(' | '));
  });
});
