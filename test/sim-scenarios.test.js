'use strict';
// Alerting scenarios (INT-385): how waking should work, as simulator tests on the board's own rules. Each states the
// behaviour we want. One that the board doesn't meet yet is marked todo with its ticket: it runs and reports, and
// the build stays green until the fix lands and the todo comes off.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createSim } = require('../lib/sim');
const { agentLike } = require('../lib/sim/behaviours');

const SLEEPING = [
  { name: 'Backlog', flags: { allowCreate: true, sleeping: true } },
  { name: 'Ready', flags: { pickup: true, allowCreate: true } },
  { name: 'In Progress', flags: { working: true } },
  { name: 'Review', flags: { review: true } },
  { name: 'Done', flags: { releaseLeaseOnEnter: true, humanOnlyIn: true } },
];
// The team of this project's board, in miniature. Every agent reads only what woke it (as on Lenza).
const TEAM = (over = {}) => ({
  gamora: { role: 'coordinator', behave: agentLike({ builders: ['groot', 'rocket'], reviewers: ['nebula'] }) },
  groot: { role: 'builder', behave: agentLike() },
  rocket: { role: 'builder', behave: agentLike() },
  nebula: { role: 'reviewer', behave: agentLike() },
  stakar: { role: 'builder', grants: ['review.decide'], behave: agentLike({ does: ['decide'] }) },
  ...over,
});
const stuck = (sim) => Object.values(sim.board.items).filter((it) => it.columnId !== 'done')
  .map((it) => `${it.id} in ${it.columnId}${it.assignee ? ` (${it.assignee})` : ''}${it.questions.length ? ` waiting: ${it.questions.map((q) => q.kind).join(',')}` : ''}${it.reviewers.length ? ` reviewers: ${it.reviewers.map((r) => `${r.name}=${r.verdict}`).join(',')}` : ''}`);

let sim = null;
afterEach(() => { sim?.close(); sim = null; });

describe('liveness: nothing gets stuck with nobody told', () => {
  it('a day\'s work: twelve tickets from the human over three hours all reach Done, nobody poked by hand', () => {
    sim = createSim({ columns: SLEEPING, team: TEAM() });
    for (let i = 0; i < 12; i++) { sim.human.create({ title: `job ${i + 1}`, column: 'Ready', priority: ['High', 'Medium', 'Low'][i % 3] }); sim.tick('15m'); }
    sim.tick('8h');
    assert.deepEqual(stuck(sim), []);
  });

  it('work assigned while its builder is busy, capped or throttled is still done', () => {
    sim = createSim({ columns: SLEEPING, team: TEAM({ groot: { role: 'builder', maxRunsPerHour: 3, behave: agentLike() } }) });
    for (let i = 0; i < 8; i++) sim.human.create({ title: `burst ${i + 1}`, column: 'Ready', assignee: 'groot' });
    sim.tick('6h');
    assert.deepEqual(stuck(sim), []);
  });

  it('a ticket blocked by another is started once its blocker is done', () => {
    sim = createSim({ columns: SLEEPING, team: TEAM() });
    const a = sim.human.create({ title: 'first', column: 'Ready', assignee: 'groot' });
    sim.human.create({ title: 'second', column: 'Ready', assignee: 'rocket', blockedBy: [a] });
    sim.tick('4h');
    assert.deepEqual(stuck(sim), []);
  });

  it('a reviewer with concerns reaches the author as work: it redoes the ticket and its reviewer is asked again (INT-388)', () => {
    sim = createSim({ columns: SLEEPING, team: TEAM({ nebula: { role: 'reviewer', behave: (run, act) => {
      // concerns the first time, ok after
      for (const id of run.items) { const it = sim.item(id); const r = it.reviewers.find((x) => x.name === 'nebula'); if (r && !r.verdict) act.verdict(id, it.comments.some((c) => /Concerns/.test(c.body)) ? 'ok' : 'concerns', 'needs a test'); }
    } } }) });
    sim.human.create({ title: 'reviewed twice', column: 'Ready', assignee: 'groot' });
    sim.tick('4h');
    assert.deepEqual(stuck(sim), []);
  });

  it('an answered question gets its asker back to work', () => {
    sim = createSim({ columns: SLEEPING, team: TEAM({ groot: { role: 'builder', behave: (run, act) => {
      for (const id of run.items) {
        const it = sim.item(id);
        if (it.columnId === 'ready' && !(it.waits || []).length && !it.questions.length) { act.start(id); act.ask(id, 'Which endpoint?'); continue; }
        if ((it.waits || []).length && it.columnId === 'in-progress') act.review(id, { summary: 'done', evidence: 'tests pass' });
      }
    } } }) });
    const t = sim.human.create({ title: 'needs an answer', column: 'Ready', assignee: 'groot' });
    sim.tick('30m');
    assert.equal(sim.item(t).questions.length, 1, 'it asked');
    sim.human.answer(t, 'The v2 one');
    sim.tick('3h');
    assert.deepEqual(stuck(sim), []);
  });
});

describe('quiet: nobody is woken for nothing', () => {
  it('an approval wakes nobody, its landing included (INT-386)', () => {
    sim = createSim({ team: { groot: { role: 'builder' } } });
    const t = sim.human.create({ title: 'x', column: 'Ready' });
    sim.as('groot').start(t);
    sim.as('groot').review(t);
    sim.tick('10m');
    const before = sim.runs.length;
    sim.human.decide(t, 'approve');
    sim.tick('10m');
    assert.deepEqual(sim.wakes().slice(before), []);
  });

  it('a decider is not woken to chase a reviewer the coordinator is about to assign', { todo: 'INT-387: chase "a reviewer (the coordinator assigns one)" wakes the decider at the moment the coordinator is woken to assign it' }, () => {
    // the flow that showed it: the coordinator triages, the builder builds, and the review needs a reviewer
    sim = createSim({ columns: SLEEPING, team: TEAM() });
    sim.human.create({ title: 'x', column: 'Ready' });
    sim.tick('2h');
    const chases = sim.runs.filter((r) => r.agent === 'stakar' && r.work.some((w) => w.startsWith('chase:')));
    assert.deepEqual(chases.map((r) => r.work), []);
  });

  it('a ticket the human files, already assigned, does not wake the coordinator', () => {
    sim = createSim({ columns: SLEEPING, team: TEAM() });
    sim.human.create({ title: 'x', column: 'Backlog', assignee: 'groot' });
    sim.tick('30m');
    assert.deepEqual(sim.wakes('gamora'), []);
  });

  it('housekeeping wakes nobody: a ticket moved between columns by the human, with no assignee', () => {
    // no coordinator: nobody triages the ticket to a builder meanwhile
    const { gamora, ...team } = TEAM();
    sim = createSim({ columns: SLEEPING, team });
    const t = sim.human.create({ title: 'x', column: 'Backlog' });
    sim.tick('15m');
    const before = sim.runs.length;
    sim.human.move(t, 'In Progress');
    sim.human.move(t, 'Backlog');
    sim.tick('15m');
    assert.deepEqual(sim.wakes().slice(before), []);
  });
});
