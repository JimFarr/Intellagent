'use strict';
// The stuck watch (INT-394): unfinished tickets followed over time; the coordinator woken once the board is sure,
// once per round; the human asked after that.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const STUCK = require('../lib/alerts/stuck');
const { createSim } = require('../lib/sim');
const { agentLike } = require('../lib/sim/behaviours');

const NOW = Date.parse('2026-10-19T18:00:00Z');
const MIN = 60_000;
const ago = (ms) => new Date(NOW - ms).toISOString();
const who = (over = {}) => ({ owners: [], running: () => false, status: () => 'idle', sleeping: () => false, ...over });
const ticket = (over = {}) => ({ id: 'T-1', journey: { pickedUpAt: ago(300 * MIN), lastProgressAt: ago(90 * MIN), touches: {}, moves: 1, back: 0 }, comments: [], questions: [], asks: [], ...over });

describe('stuck rules', () => {
  it('quiet for an hour, picked up and not done: stuck, with why', () => {
    assert.deepEqual(STUCK.assess(ticket(), NOW, who()), { reason: 'no_owner' });
    assert.deepEqual(STUCK.assess(ticket(), NOW, who({ owners: ['groot'] })), { reason: 'owner_quiet', owner: 'groot' });
    assert.deepEqual(STUCK.assess(ticket(), NOW, who({ owners: ['groot'], status: () => 'paused' })), { reason: 'owner_down', owner: 'groot' });
    assert.deepEqual(STUCK.assess(ticket(), NOW, who({ owners: ['groot'], status: () => 'disabled' })), { reason: 'owner_down', owner: 'groot' }, 'switched off is down too');
    assert.deepEqual(STUCK.assess(ticket({ lease: { claimant: 'groot', expiresAt: ago(-30 * MIN), leasedAt: ago(100 * MIN) } }), NOW, who()), { reason: 'held_quiet', owner: 'groot' });
    assert.deepEqual(STUCK.assess(ticket({ questions: [{ kind: 'question' }] }), NOW, who()), { reason: 'waiting_on_human' });
  });

  it('not stuck: recent progress, an owner running right now, not picked up, done, asleep or a test ticket', () => {
    assert.equal(STUCK.assess(ticket({ journey: { pickedUpAt: ago(300 * MIN), lastProgressAt: ago(10 * MIN), touches: {} } }), NOW, who()), null);
    assert.deepEqual(STUCK.assess(ticket({ lease: { claimant: 'groot', leasedAt: ago(1 * MIN), expiresAt: ago(-29 * MIN) } }), NOW, who()), { reason: 'held_quiet', owner: 'groot' }, 're-claiming it is not progress');
    assert.equal(STUCK.assess(ticket(), NOW, who({ owners: ['groot'], running: () => true })), null);
    assert.equal(STUCK.assess(ticket({ journey: null }), NOW, who()), null);
    assert.equal(STUCK.assess(ticket({ journey: { pickedUpAt: ago(9e6), doneAt: ago(6e6), touches: {} } }), NOW, who()), null);
    assert.equal(STUCK.assess(ticket(), NOW, who({ sleeping: () => true })), null);
    assert.equal(STUCK.assess(ticket({ test: true }), NOW, who()), null);
  });

  it('a journey from before progress was kept falls back to the ticket\'s activity, so an upgrade finds nothing stuck that is moving', () => {
    const legacy = ticket({ journey: { pickedUpAt: ago(3000 * MIN), touches: {} }, updatedAt: ago(10 * MIN) });
    assert.equal(STUCK.assess(legacy, NOW, who()), null);
    assert.deepEqual(STUCK.assess({ ...legacy, updatedAt: ago(90 * MIN) }, NOW, who()), { reason: 'no_owner' });
  });

  it('an ask in its time keeps it stuck but handled; making the ask is not activity', () => {
    const asked = ticket({ asks: [{ state: 'open', at: ago(5 * MIN), dueAt: ago(-55 * MIN) }] });
    assert.deepEqual(STUCK.assess(asked, NOW, who({ owners: ['groot'] })), { reason: 'owner_quiet', owner: 'groot', asked: true });
    const e = { since: ago(60 * MIN), reason: 'owner_quiet', asked: true };
    assert.equal(STUCK.forCoordinator(e, NOW), false, 'the ask is on it: nobody is woken');
  });

  it('the ledger keeps when a ticket was first seen stuck, drops what moved on, and sure means 30 minutes on', () => {
    let ledger = STUCK.sweep({}, { 'T-1': { reason: 'no_owner' } }, ago(40 * MIN));
    ledger = STUCK.sweep(ledger, { 'T-1': { reason: 'owner_quiet', owner: 'groot' }, 'T-2': { reason: 'no_owner' } }, ago(0));
    assert.equal(ledger['T-1'].since, ago(40 * MIN), 'stuck all along, whatever the reason now');
    assert.equal(STUCK.confirmed(ledger['T-1'], NOW), true);
    assert.equal(STUCK.confirmed(ledger['T-2'], NOW), false, 'just seen: only suspected');
    assert.deepEqual(Object.keys(STUCK.sweep(ledger, { 'T-2': { reason: 'no_owner' } }, ago(0))), ['T-2'], 'T-1 moved on');
  });

  it('rounds: the coordinator twice, an hour apart, then the human once', () => {
    const at = (m) => NOW + m * MIN;
    const e = { since: new Date(NOW).toISOString(), reason: 'owner_quiet', owner: 'groot' };
    assert.equal(STUCK.forCoordinator(e, at(29)), false);
    assert.deepEqual([STUCK.forCoordinator(e, at(30)), STUCK.roundOf(e, at(30))], [true, 0]);
    assert.deepEqual([STUCK.forCoordinator(e, at(95)), STUCK.roundOf(e, at(95))], [true, 1]);
    assert.deepEqual([STUCK.forCoordinator(e, at(150)), STUCK.forHuman(e, at(150))], [false, true]);
    assert.equal(STUCK.forHuman({ ...e, escalated: 'yes' }, at(150)), false, 'asked once');
    assert.equal(STUCK.forHuman({ ...e, reason: 'waiting_on_human' }, at(500)), false, 'already the human\'s');
  });

  it('the manifest tunes the timings; anything missing or nonsense keeps the default', () => {
    const t = STUCK.timingsOf({ quietMinutes: 20, rounds: 1, roundMinutes: 'soon', sureAfterMinutes: -5 });
    assert.deepEqual(t, { quietMs: 20 * MIN, confirmMs: STUCK.TIMINGS.confirmMs, roundMs: STUCK.TIMINGS.roundMs, rounds: 1 });
    assert.deepEqual(STUCK.timingsOf(undefined), STUCK.TIMINGS);
    assert.equal(STUCK.assess(ticket({ journey: { pickedUpAt: ago(300 * MIN), lastProgressAt: ago(30 * MIN), touches: {} } }), NOW, who(), t)?.reason, 'no_owner', 'quiet after 20 minutes');
    const e = { since: new Date(NOW).toISOString(), reason: 'no_owner' };
    assert.equal(STUCK.forHuman(e, NOW + 95 * MIN, t), true, 'one round, then the human');
  });

  it('one sweep of a board: the ledger, the owners, and what is due for the human', () => {
    const board = { columns: [{ id: 'doing', flags: {} }, { id: 'later', flags: { sleeping: true } }], stuck: { 'T-1': { since: ago(200 * MIN), reason: 'no_owner' } }, items: {
      'T-1': ticket({ id: 'T-1', columnId: 'doing' }), 'T-2': ticket({ id: 'T-2', columnId: 'doing' }), 'T-3': ticket({ id: 'T-3', columnId: 'later' }) } };
    const works = { groot: { next: [{ action: 'start', id: 'T-2' }, { action: 'reply', id: 'T-1' }] } };
    const { next, due, owners } = STUCK.sweepBoard(board, NOW, { works, running: () => false, status: () => 'idle' });
    assert.deepEqual(Object.keys(next), ['T-1', 'T-2'], 'asleep is not stuck');
    assert.deepEqual([next['T-1'].reason, next['T-2'].reason, next['T-2'].owner], ['no_owner', 'owner_quiet', 'groot'], 'a reply owed doesn\'t make an owner');
    assert.deepEqual(due, ['T-1']);
    assert.deepEqual([...owners.get('T-2')], ['groot']);
    assert.match(STUCK.humanQuestion(next['T-1'], NOW, undefined, board.items['T-1']), /^Quiet for 1\.5 h \(no owner\), and the coordinator could not move it on in 2 rounds/);
  });
});

describe('the stuck watch on the simulator', () => {
  let sim = null;
  afterEach(() => { sim?.close(); sim = null; });

  it('a builder that goes silent mid-ticket: the coordinator is woken once and asks it; unanswered, the human is asked once; then nothing loops', () => {
    sim = createSim({
      defaults: { wakeFrom: 'work' },
      team: {
        gamora: { role: 'coordinator', behave: agentLike() },
        // starts what it is given, then goes silent: never finishes, never answers (its lease lapses and it re-claims it)
        groot: { role: 'builder', behave: (run, act) => { for (const n of run.brief.next) if (n.action === 'start') act.start(n.id); } },
      },
    });
    const t = sim.human.create({ title: 'goes quiet', column: 'Ready', assignee: 'groot' });
    sim.tick('12h');
    const unstick = sim.runs.filter((r) => r.agent === 'gamora' && r.work.some((w) => w.startsWith('unstick:')));
    assert.equal(unstick.length, 1, `the coordinator is woken once: ${sim.wakes('gamora').join(' | ')}`);
    const asks = sim.item(t).asks.filter((a) => a.by === 'gamora');
    assert.deepEqual(asks.map((a) => [a.to, a.kind]), [['groot', 'answer']], 'it asks the silent owner');
    const human = sim.item(t).questions;
    assert.equal(human.length, 1, 'unanswered, the human is asked once');
    assert.equal(sim.board.stuck[t].reason, 'waiting_on_human', 'and it is the human\'s now');
    const asked = Date.parse(human[0].raisedAt);
    // The owner's unanswered ask is offered to it once more after reofferMinutes (INT-397); then nothing wakes anyone
    const after = () => sim.runs.filter((r) => Date.parse(r.at) > asked);
    assert.ok(after().every((r) => r.agent === 'groot' && r.work.every((w) => w.startsWith('ask:'))), 'only that one re-offer');
    const once = after().length;
    assert.ok(once <= 1, 'at most once');
    sim.tick('24h');
    assert.equal(after().length, once, 'after that nothing wakes anyone for it: no loop');
  });

  it('a ticket whose owner is paused is owner_down, not no_owner', () => {
    sim = createSim({ team: { groot: { role: 'builder', behave: (run, act) => { for (const n of run.brief.next) if (n.action === 'start') act.start(n.id); } } } });
    const t = sim.human.create({ title: 'x', column: 'Ready', assignee: 'groot' });
    sim.tick('10m');
    sim.agent('groot'); // started
    sim.pause('groot');
    sim.tick('2h');
    assert.equal(sim.board.stuck[t]?.reason, 'owner_down');
    assert.equal(sim.board.stuck[t]?.owner, 'groot');
  });

  it('a ticket moving along normally never enters the ledger', () => {
    sim = createSim({ defaults: { wakeFrom: 'work' }, team: {
      gamora: { role: 'coordinator', behave: agentLike({ builders: ['groot'], reviewers: ['nebula'] }) },
      groot: { role: 'builder', behave: agentLike() }, nebula: { role: 'reviewer', behave: agentLike() },
      stakar: { role: 'builder', grants: ['review.decide'], behave: agentLike({ does: ['decide'] }) },
    } });
    for (let i = 0; i < 4; i++) sim.human.create({ title: `job ${i}`, column: 'Ready' });
    sim.tick('6h');
    assert.deepEqual(sim.board.stuck, {});
    assert.ok(!sim.runs.some((r) => r.work.some((w) => w.startsWith('unstick:'))));
  });
});

describe('the stuck watch on a real board', () => {
  const { startServer, USER } = require('./helpers');
  const B = '/api/boards/main';
  it('the sweep enters a quiet ticket with why, the route says so, and past its rounds the human is asked once', async () => {
    // timings in fractions of a minute, and a sweep every second, so the whole watch runs in a few seconds
    const s = await startServer({ manifest: { stuck: { quietMinutes: 0.02, sureAfterMinutes: 0.02, roundMinutes: 0.02, rounds: 1 }, stuckSweepSeconds: 1 },
      agents: { agents: { groot: { role: 'builder', enabled: false } } } });
    try {
      const t = await s.ok('POST', `${B}/items`, { title: 'goes quiet', column: 'Ready' }, USER);
      await s.ok('POST', `${B}/items/${t.id}/start`, {}, { agent: 'groot' });
      let r;
      for (let i = 0; i < 40; i++) {
        r = await s.ok('GET', `${B}/stuck`);
        if (r.stuck.some((e) => e.id === t.id && e.escalated)) break;
        await new Promise((ok) => setTimeout(ok, 250));
      }
      assert.deepEqual(r.rules, { quietMinutes: 0.02, sureAfterMinutes: 0.02, roundMinutes: 0.02, rounds: 1 });
      const e = r.stuck.find((x) => x.id === t.id);
      assert.ok(e?.escalated, `escalated: ${JSON.stringify(r.stuck)}`);
      const qs = (await s.ok('GET', `${B}/items/${t.id}`)).questions;
      assert.equal(qs.length, 1);
      assert.match(qs[0].reason, /^Quiet for .* h \(held quiet: groot\), and the coordinator could not move it on in 1 rounds/);
      await new Promise((ok) => setTimeout(ok, 1500));
      assert.equal((await s.ok('GET', `${B}/items/${t.id}`)).questions.length, 1, 'asked once');
      assert.equal((await s.ok('GET', `${B}/stuck`)).stuck.find((x) => x.id === t.id)?.reason, 'waiting_on_human');
    } finally { await s.stop(); }
  });
});
