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
    assert.deepEqual(ASKS.closeBy(item, { kind: 'verdict', who: 'drax' }, 'now').map((a) => a.id), [], 'another reviewer\'s verdict does not answer it');
    assert.deepEqual(ASKS.closeBy(item, { kind: 'verdict', who: 'nebula' }, 'now').map((a) => a.id), ['r']);
    assert.deepEqual(ASKS.closeBy(item, { kind: 'review_requested', who: 'groot' }, 'now').map((a) => a.id), ['f']);
    assert.deepEqual(ASKS.closeBy(item, { kind: 'reviewer_assigned' }, 'now').map((a) => a.id), ['a']);
    assert.deepEqual(ASKS.openAsks(item).map((a) => a.id), ['q'], 'a decision is answered, never closed by itself');
  });
  it('is overdue once past its due time, and only until it has been escalated', () => {
    const a = ASKS.newAsk({ id: 'q', by: 'groot', to: 'stakar', what: 'v1 or v2?', dueMinutes: 30, now: NOW });
    const item = { asks: [a] };
    assert.deepEqual(ASKS.overdueAsks(item, NOW + 29 * 60_000), []);
    assert.deepEqual(ASKS.overdueAsks(item, NOW + 31 * 60_000).map((x) => x.id), ['q']);
    a.escalated = 'then';
    assert.deepEqual(ASKS.overdueAsks(item, NOW + 31 * 60_000), []);
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
});
