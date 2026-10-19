'use strict';
// Alerting scenarios (INT-385): how waking should work, as simulator tests on the board's own rules. Each states the
// behaviour we want. A new one the board doesn't meet yet may be marked todo with its ticket until the fix lands;
// none is now.
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

describe('a comment never hides work', () => {
  it('an agent that saw a mention on its assigned ticket without answering still gets the ticket to start (INT-392)', () => {
    // groot is busy on another ticket when the human asks about T-2 on the card; his run for the mention only reads it
    const seen = new Set();
    sim = createSim({ columns: SLEEPING, team: { groot: { role: 'builder', throttleMinutes: 0, behave: (run, act) => {
      if (run.why.includes('comment.added')) return; // read, no answer
      for (const n of run.brief.next) if (n.action === 'start' && !seen.has(n.id)) { seen.add(n.id); act.start(n.id); act.review(n.id, { summary: 'done', evidence: 'tests pass' }); }
    } } } });
    const t = sim.human.create({ title: 'assigned', column: 'Ready', assignee: 'groot' });
    sim.human.comment(t, '@groot is the export header in scope?');
    sim.tick('2h');
    assert.equal(sim.item(t).columnId, 'review', sim.wakes('groot').join(' | '));
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

  it('a decider is not woken to chase a reviewer the coordinator is about to assign (INT-387)', () => {
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

describe('wake from work (INT-390): a wake always carries work; news alone is context', () => {
  const WORK = { wakeFrom: 'work' };

  it('liveness holds: a day of work reaches Done with every agent waking from its work', () => {
    sim = createSim({ columns: SLEEPING, defaults: WORK, team: TEAM() });
    for (let i = 0; i < 12; i++) { sim.human.create({ title: `job ${i + 1}`, column: 'Ready' }); sim.tick('15m'); }
    sim.tick('8h');
    assert.deepEqual(stuck(sim), []);
    assert.equal(sim.metrics().idleRuns, 0);
  });

  it('news with nothing to do wakes nobody: the lease released when the human moves an agent’s ticket to Done', () => {
    for (const [mode, wakes] of [['events', 1], ['work', 0]]) {
      const s = createSim({ defaults: { wakeFrom: mode }, team: { groot: { role: 'builder' } } });
      try {
        const t = s.human.create({ title: 'x', column: 'Ready' });
        s.as('groot').start(t);
        s.tick('10m');
        const before = s.runs.length;
        s.human.move(t, 'Done'); // lease.released, addressed to groot
        s.tick('10m');
        assert.equal(s.runs.length - before, wakes, `${mode}: ${s.wakes().slice(before).join(' | ')}`);
      } finally { s.close(); }
    }
  });

  it('a reassignment wakes the new assignee, not the one it was taken from', () => {
    sim = createSim({ defaults: WORK, team: { groot: { role: 'builder' }, rocket: { role: 'builder' } } });
    const t = sim.human.create({ title: 'x', column: 'Ready', assignee: 'groot' });
    sim.tick('10m');
    const before = sim.runs.length;
    sim.human.assign(t, 'rocket');
    sim.tick('10m');
    assert.deepEqual(sim.wakes().slice(before).map((w) => w.split(' ')[0]), ['rocket']);
  });

  it('a mention is work: it wakes the agent once, with the comment as context, and not again once seen', () => {
    sim = createSim({ defaults: WORK, team: { groot: { role: 'builder' } } });
    const t = sim.human.create({ title: 'x', column: 'Ready' });
    sim.tick('10m');
    sim.human.comment(t, '@groot is the header in scope?');
    sim.tick('10m');
    const runs = sim.runs.filter((r) => r.agent === 'groot');
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].work, [`mention:${t}`]);
    assert.ok(runs[0].events.some((e) => e.type === 'comment.added'), 'the comment comes along as context');
    sim.tick('1h');
    assert.equal(sim.runs.filter((r) => r.agent === 'groot').length, 1, 'seen (👀) and left: a reply owed, which never wakes');
  });
});

describe('asks (INT-391): obligations between agents as data', () => {
  const WORK = { wakeFrom: 'work' };

  it('an ask wakes its owner once; the answer wakes the asker once; nobody else is told', () => {
    sim = createSim({ defaults: WORK, team: { groot: { role: 'builder' }, stakar: { role: 'builder', behave: agentLike({ does: ['ask'] }) }, rocket: { role: 'builder' } } });
    const t = sim.human.create({ title: 'x', column: 'Ready' });
    sim.tick('10m');
    sim.as('groot').askAgent(t, { to: 'stakar', kind: 'decide', what: 'CSV or JSON?' });
    sim.tick('30m');
    assert.deepEqual(sim.wakes().map((w) => w.split(' ')[0]), ['stakar', 'groot']);
    assert.equal(sim.item(t).asks[0].state, 'done');
    assert.deepEqual(sim.runs.at(-1).work, [`ask_answered:${t}`]);
  });

  it('an ask nobody answers escalates once to the coordinator, and closes with the original when it is answered', () => {
    sim = createSim({ defaults: WORK, team: { gamora: { role: 'coordinator' }, groot: { role: 'builder' }, stakar: { role: 'builder' } } });
    const t = sim.human.create({ title: 'x', column: 'Ready', assignee: 'groot' });
    const askId = sim.as('groot').askAgent(t, { to: 'stakar', kind: 'decide', what: 'CSV or JSON?', dueMinutes: 30 });
    sim.tick('3h');
    const asks = sim.item(t).asks;
    assert.equal(asks.length, 2, 'one escalation, not one per sweep');
    assert.equal(asks[1].to, 'gamora');
    assert.equal(asks[1].escalates, askId);
    assert.ok(sim.runs.some((r) => r.agent === 'gamora' && r.work.includes(`ask:${t}`)), 'the coordinator is woken for it');
    sim.as('stakar').answerAsk(t, askId, 'CSV');
    assert.deepEqual(sim.item(t).asks.map((a) => a.state), ['done', 'done'], 'the escalation closes with it');
  });

  it('an ask for a reviewer closes itself when the coordinator assigns one, with no answer to write', () => {
    sim = createSim({ defaults: WORK, team: { gamora: { role: 'coordinator', behave: agentLike({ reviewers: ['nebula'] }) }, groot: { role: 'builder' }, nebula: { role: 'reviewer' }, stakar: { role: 'builder' } } });
    const t = sim.human.create({ title: 'x', column: 'Ready', assignee: 'groot' });
    sim.as('groot').start(t);
    sim.as('groot').review(t);
    sim.as('stakar').askAgent(t, { to: 'gamora', kind: 'assign_reviewer', what: 'needs a reviewer' });
    sim.tick('30m');
    assert.equal(sim.item(t).asks[0].state, 'done');
    assert.deepEqual(sim.item(t).reviewers.map((r) => r.name), ['nebula']);
  });
});

