'use strict';
// Asks (INT-391): what one agent needs from another, as data instead of an @mention. The rules (lib/alerts/asks.js),
// the work they make (lib/alerts/work.js) and the routes on a real board.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const ASKS = require('../lib/alerts/asks');
const { startServer, USER } = require('./helpers');

const NOW = Date.parse('2026-10-19T12:00:00Z');
const B = '/api/boards/main';

describe('ask rules', () => {
  it('an ask has an owner, a kind, a due time (default an hour, at most a week) and starts open', () => {
    const a = ASKS.newAsk({ id: 'ask_1', by: 'stakar', to: 'gamora', kind: 'assign_reviewer', what: 'INT-9 needs a reviewer', now: NOW });
    assert.equal(a.state, 'open');
    assert.equal(Date.parse(a.dueAt) - NOW, 60 * 60_000);
    assert.equal(Date.parse(ASKS.newAsk({ id: 'x', by: 'a', to: 'b', what: 'w', dueMinutes: 1e9, now: NOW }).dueAt) - NOW, 7 * 24 * 60 * 60_000);
  });
  it('closes itself when the thing is done: a verdict, a new review request, a reviewer assigned', () => {
    const item = { asks: [
      ASKS.newAsk({ id: 'r', by: 'stakar', to: 'nebula', kind: 'review', what: 'verdict please', now: NOW }),
      ASKS.newAsk({ id: 'f', by: 'nebula', to: 'groot', kind: 'fix', what: 'add the test', now: NOW }),
      ASKS.newAsk({ id: 'a', by: 'stakar', to: 'gamora', kind: 'assign_reviewer', what: 'a reviewer', now: NOW }),
      ASKS.newAsk({ id: 'q', by: 'groot', to: 'stakar', kind: 'decide', what: 'v1 or v2?', now: NOW }),
    ] };
    assert.deepEqual(ASKS.closeBy(item, { kind: 'verdict', who: 'drax' }, 'now').map((x) => x.ask.id), [], 'another reviewer\'s verdict does not answer it');
    assert.deepEqual(ASKS.closeBy(item, { kind: 'verdict', who: 'nebula' }, 'now').map((x) => x.ask.id), ['r']);
    assert.deepEqual(ASKS.closeBy(item, { kind: 'review_requested', who: 'groot' }, 'now').map((x) => x.ask.id), ['f']);
    assert.deepEqual(ASKS.closeBy(item, { kind: 'reviewer_assigned' }, 'now').map((x) => x.ask.id), ['a']);
    assert.deepEqual(ASKS.openAsks(item).map((a) => a.id), ['q'], 'a decision is answered, never closed by itself');
  });
  it('is overdue once past its due time, and only until it has been escalated', () => {
    const a = ASKS.newAsk({ id: 'q', by: 'groot', to: 'stakar', what: 'v1 or v2?', dueMinutes: 30, now: NOW });
    const item = { asks: [a] };
    assert.deepEqual(ASKS.overdueAsks(item, NOW + 29 * 60_000), []);
    assert.deepEqual(ASKS.overdueAsks(item, NOW + 31 * 60_000).map((x) => x.id), ['q']);
    a.escalated = 'then';
    assert.deepEqual(ASKS.overdueAsks(item, NOW + 31 * 60_000), []);
    const up = ASKS.escalationOf(ASKS.newAsk({ id: 'q2', by: 'groot', to: 'stakar', what: 'x', now: NOW }), 'gamora', { id: 'up', now: NOW }).ask;
    assert.deepEqual(ASKS.overdueAsks({ asks: [up] }, NOW + 999 * 60_000), [], 'an escalation never escalates again');
  });
  it('escalates to the coordinator; when that is the asker or the owner it makes nothing (the human is never asked)', () => {
    const a = ASKS.newAsk({ id: 'q', by: 'groot', to: 'stakar', what: 'v1 or v2?', now: NOW });
    const up = ASKS.escalationOf(a, 'gamora', { id: 'up', now: NOW });
    assert.deepEqual([up.ask.to, up.ask.kind, up.ask.escalates, up.ask.by], ['gamora', 'unblock', 'q', 'intellagent']);
    assert.deepEqual(ASKS.escalationOf(a, 'stakar', { id: 'up', now: NOW }), {}, 'the coordinator is the owner');
    assert.deepEqual(ASKS.escalationOf(a, 'groot', { id: 'up', now: NOW }), {}, 'the coordinator is the asker: ask.overdue wakes it');
    assert.deepEqual(ASKS.escalationOf(a, null, { id: 'up', now: NOW }), {});
  });
  it('finishing one end of an escalation finishes the other, with the human\'s questions it had opened', () => {
    const fresh = () => {
      const a = { ...ASKS.newAsk({ id: 'q', by: 'groot', to: 'stakar', what: 'v1 or v2?', now: NOW }), escalated: 'then', questionId: 'hq' };
      const up = ASKS.escalationOf(a, 'gamora', { id: 'up', now: NOW }).ask;
      return { asks: [a, up] };
    };
    let item = fresh();
    let r = ASKS.finish(item, item.asks[0], { state: 'done', answer: 'v2', doneBy: 'stakar' }, 'now');
    assert.deepEqual([r.closed.map((a) => a.id), r.questionIds], [['up'], ['hq']], 'the owner answered: the coordinator\'s escalation closes');
    assert.equal(item.asks[1].auto, true);
    item = fresh();
    r = ASKS.finish(item, item.asks[1], { state: 'withdrawn', answer: 'moot', doneBy: 'gamora' }, 'now');
    assert.deepEqual([r.closed.map((a) => a.id), item.asks[0].state, r.questionIds], [['q'], 'withdrawn', ['hq']], 'the coordinator withdrew it: the original goes too');
  });
  it('keeps at most `keep` asks: the oldest closed ones go, an open one never', () => {
    const item = { asks: [] };
    const rules = { ...ASKS.RULES, keep: 3 };
    for (let i = 0; i < 5; i++) ASKS.addAsk(item, { ...ASKS.newAsk({ id: `a${i}`, by: 'x', to: 'y', what: 'w', now: NOW + i }), ...(i < 3 ? { state: 'done' } : {}) }, rules);
    assert.deepEqual(item.asks.map((a) => a.id), ['a2', 'a3', 'a4']);
    for (let i = 5; i < 8; i++) ASKS.addAsk(item, ASKS.newAsk({ id: `a${i}`, by: 'x', to: 'y', what: 'w', now: NOW + i }), rules);
    assert.deepEqual(item.asks.map((a) => a.id), ['a3', 'a4', 'a5', 'a6', 'a7'], 'every open ask stays, past the cap');
  });
});

describe('asks on a real board', () => {
  const TEAM = { agents: {
    gamora: { role: 'coordinator', enabled: false }, groot: { role: 'builder', enabled: false },
    stakar: { role: 'builder', enabled: false }, nebula: { role: 'reviewer', enabled: false },
  } };
  const as = (agent) => ({ agent });

  it('an agent asks another: a work item for the owner, the answer on the card and back to the asker, who sees it as work', async () => {
    const s = await startServer({ agents: TEAM });
    try {
      const t = await s.ok('POST', `${B}/items`, { title: 'the export', column: 'Ready' }, USER);
      // refusals first
      assert.equal((await s.api('POST', `${B}/items/${t.id}/asks`, { to: 'groot', what: 'x' }, as('groot'))).status, 400, 'not yourself');
      assert.equal((await s.api('POST', `${B}/items/${t.id}/asks`, { to: 'nobody', what: 'x' }, as('groot'))).status, 400, 'a standing agent');
      assert.match((await s.api('POST', `${B}/items/${t.id}/asks`, { to: 'human', what: 'x' }, as('groot'))).body.hint, /attention/, 'the human is asked with attention');
      assert.equal((await s.api('POST', `${B}/items/${t.id}/asks`, { to: 'stakar', kind: 'bribe', what: 'x' }, as('groot'))).status, 400, 'a known kind');
      const { seq } = await s.ok('GET', '/api/app');
      const r = await s.ok('POST', `${B}/items/${t.id}/asks`, { to: 'stakar', kind: 'decide', what: 'CSV or JSON?', options: ['CSV', 'JSON'], dueMinutes: 30 }, as('groot'));
      assert.equal(r.ask.state, 'open');
      const created = (await s.ok('GET', `/api/events?since=${seq}&types=ask.created`)).events.at(-1);
      assert.deepEqual(created.addressed, ['stakar'], 'it is addressed to its owner');
      const owner = (await s.ok('GET', `${B}/work?agent=stakar`)).next.find((n) => n.action === 'ask');
      assert.equal(owner.askId, r.ask.id);
      assert.match(owner.why, /groot asks you \(decide\): CSV or JSON\? — options: CSV \/ JSON/);
      // only the owner, the asker, the coordinator or the human answer it
      assert.equal((await s.api('POST', `${B}/items/${t.id}/asks/${r.ask.id}/done`, { answer: 'CSV' }, as('nebula'))).body.code, 'FORBIDDEN');
      const done = await s.ok('POST', `${B}/items/${t.id}/asks/${r.ask.id}/done`, { answer: 'CSV, one row per ticket' }, as('stakar'));
      assert.match(done.comments.at(-1).body, /groot's ask\*\* \(decide\): CSV or JSON\?\n\nCSV, one row per ticket/);
      const answered = (await s.ok('GET', `/api/events?since=${seq}&types=ask.done`)).events.at(-1);
      assert.deepEqual(answered.addressed, ['groot'], 'the answer goes to the asker');
      assert.ok(!(await s.ok('GET', `${B}/work?agent=stakar`)).next.some((n) => n.action === 'ask'), 'answered: gone from the owner\'s work');
      assert.equal((await s.ok('GET', `${B}/work?agent=groot`)).next.find((n) => n.action === 'ask_answered')?.askId, r.ask.id);
      assert.equal((await s.api('POST', `${B}/items/${t.id}/asks/${r.ask.id}/done`, { answer: 'again' }, as('stakar'))).body.code, 'CONFLICT');
    } finally { await s.stop(); }
  });

  it('closes itself when the thing is done: a reviewer assigned answers "assign one", a verdict answers "review it"', async () => {
    const s = await startServer({ agents: TEAM });
    try {
      const t = await s.ok('POST', `${B}/items`, { title: 'reviewed', column: 'Ready' }, USER);
      await s.ok('POST', `${B}/items/${t.id}/start`, {}, as('groot'));
      await s.ok('POST', `${B}/items/${t.id}/review`, { summary: 'done', evidence: 'tests pass' }, as('groot'));
      const assign = (await s.ok('POST', `${B}/items/${t.id}/asks`, { to: 'gamora', kind: 'assign_reviewer', what: 'needs a code reviewer' }, as('stakar'))).ask;
      const review = (await s.ok('POST', `${B}/items/${t.id}/asks`, { to: 'nebula', kind: 'review', what: 'a verdict, please' }, as('stakar'))).ask;
      await s.ok('POST', `${B}/items/${t.id}/reviewers`, { name: 'nebula' }, USER);
      let it = await s.ok('GET', `${B}/items/${t.id}`);
      assert.equal(it.asks.find((a) => a.id === assign.id).state, 'done');
      assert.equal(it.asks.find((a) => a.id === review.id).state, 'open');
      await s.ok('POST', `${B}/items/${t.id}/reviewers/nebula/verdict`, { verdict: 'ok' }, as('nebula'));
      it = await s.ok('GET', `${B}/items/${t.id}`);
      assert.equal(it.asks.find((a) => a.id === review.id).state, 'done');
      assert.equal(it.asks.find((a) => a.id === review.id).doneBy, 'nebula');
      // withdraw: only the asker (or the coordinator, or the human)
      const q = (await s.ok('POST', `${B}/items/${t.id}/asks`, { to: 'groot', what: 'anything else?' }, as('stakar'))).ask;
      assert.equal((await s.api('POST', `${B}/items/${t.id}/asks/${q.id}/withdraw`, { reason: 'x' }, as('groot'))).body.code, 'FORBIDDEN');
      await s.ok('POST', `${B}/items/${t.id}/asks/${q.id}/withdraw`, { reason: 'not needed' }, as('stakar'));
      assert.equal((await s.ok('GET', `${B}/items/${t.id}`)).asks.find((a) => a.id === q.id).state, 'withdrawn');
    } finally { await s.stop(); }
  });

  it('the owner is named as the board knows it, whatever the case it was asked with', async () => {
    const s = await startServer({ agents: TEAM });
    try {
      const t = await s.ok('POST', `${B}/items`, { title: 'cased', column: 'Ready' }, USER);
      const r = await s.ok('POST', `${B}/items/${t.id}/asks`, { to: 'Stakar', what: 'which one?' }, as('groot'));
      assert.equal(r.ask.to, 'stakar');
      assert.equal((await s.ok('GET', `${B}/work?agent=stakar`)).next.find((n) => n.action === 'ask')?.askId, r.ask.id);
      assert.equal((await s.api('POST', `${B}/items/${t.id}/asks`, { to: 'GROOT', what: 'x' }, as('groot'))).status, 400, 'still not yourself');
    } finally { await s.stop(); }
  });
});

describe('asks on the simulator', () => {
  const { createSim } = require('../lib/sim');
  it('overdue: the coordinator gets one; when the owner answers after all, the escalation closes with it', () => {
    const sim = createSim({ team: { gamora: { role: 'coordinator' }, groot: { role: 'builder' }, stakar: { role: 'builder' } } });
    try {
      const t = sim.human.create({ title: 'slow answer', column: 'Ready' });
      const id = sim.as('groot').askAgent(t, { to: 'stakar', what: 'v1 or v2?', dueMinutes: 10 });
      sim.tick('12m');
      const up = sim.item(t).asks.find((a) => a.escalates === id);
      assert.equal(up?.to, 'gamora');
      sim.as('stakar').answerAsk(t, id, 'v2');
      assert.equal(sim.item(t).asks.find((a) => a.id === up.id).state, 'done');
      const w = sim.as('groot').askAgent(t, { to: 'stakar', what: 'anything else?' });
      sim.as('groot').withdrawAsk(t, w, 'moot');
      assert.equal(sim.item(t).asks.find((a) => a.id === w).state, 'withdrawn');
      assert.ok(sim.events.some((e) => e.type === 'ask.withdrawn'));
    } finally { sim.close(); }
  });
});
