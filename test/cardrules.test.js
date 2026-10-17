// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Card rules (INT-263): the condition language, the review facts that only count verdicts that stand,
// the human-only routes, and the look a ticket earns (first outline wins, badges stack).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, USER } = require('./helpers');
const { parseCondition, holds, reviewFacts, cleanRules, lookFor, RuleError } = require('../lib/cardrules');

describe('the condition language', () => {
  const view = { assignee: 'drax', claimant: null, priority: 'High', fields: { risk: 'low', area: ['cli', 'ui'] }, review: { oks: 2, pending: 0, concerns: 0, allOk: true, evidence: true }, reviewers: { nebula: 'ok' } };
  const ok = (text, rules) => holds(parseCondition(text), view, rules);
  it('holds terms, comparisons, negation, names and other rules', () => {
    assert.ok(ok('review.allOk review.oks>=2 review.evidence'));
    assert.ok(!ok('review.oks>2'));
    assert.ok(ok('review.oks=2 review.pending<1'));
    assert.ok(ok('!review.concerns'));
    assert.ok(!ok('review.concerns'));
    assert.ok(ok('fields.risk:low priority:high|critical fields.area:ui'), 'case-insensitive, either of a|b, any of a list');
    assert.ok(ok('reviewers.nebula:ok'));
    assert.ok(!ok('reviewers.kraglin:ok'), 'no verdict that stands matches nothing');
    assert.ok(ok('@drax'));
    assert.ok(!ok('@groot'));
    const rules = [{ name: 'low', condition: 'fields.risk:low' }, { name: 'loop', condition: 'is:rule:loop' }];
    assert.ok(ok('is:rule:low', rules));
    assert.ok(!ok('is:rule:loop', rules), 'a rule that names itself never matches, and never hangs');
    assert.ok(!ok('is:rule:missing', rules));
  });
  it('refuses what does not parse, saying which term and what to write', () => {
    for (const bad of ['', '   ', 'review.oks>=two', 'fields.risk:', 'is:open', '@', 'a b>=', '9lives:x']) {
      assert.throws(() => parseCondition(bad), (e) => e instanceof RuleError && !!e.message && !!e.hint, `"${bad}"`);
    }
  });
  it('counts only verdicts that still stand, and calls it allOk only when every assigned reviewer is in', () => {
    const item = { reviewers: [{ name: 'Nebula', verdict: 'ok' }, { name: 'rocket', verdict: 'ok' }, { name: 'groot', verdict: 'concerns' }, { name: 'mantis', verdict: null }], questions: [{ kind: 'review', notes: { evidence: 'shots' } }] };
    const f = reviewFacts(item, (r) => r.name !== 'rocket'); // rocket's ok is stale
    assert.deepEqual(f.review, { oks: 1, pending: 2, concerns: 1, allOk: false, evidence: true });
    assert.deepEqual(f.reviewers, { nebula: 'ok', groot: 'concerns' });
    assert.equal(reviewFacts({ reviewers: [{ name: 'a', verdict: 'ok' }] }, () => true).review.allOk, true);
    assert.equal(reviewFacts({}, () => true).review.allOk, false, 'nobody assigned is not approval');
    assert.equal(reviewFacts({ questions: [{ kind: 'review', notes: { evidence: '  ' } }] }, () => true).review.evidence, false);
  });
  it('cleans rules, and the first outline wins while badges stack up to two', () => {
    assert.throws(() => cleanRules([{ name: 'a', condition: 'x:1', look: { outline: 'purple' } }]), /outline must be one of/);
    assert.throws(() => cleanRules([{ name: 'a', condition: 'x:1', look: {} }]), /no look/);
    assert.throws(() => cleanRules([{ name: 'a', condition: 'x:1', look: { tint: 'ok' } }, { name: 'A', condition: 'x:1', look: { tint: 'ok' } }]), /Two rules/);
    assert.throws(() => cleanRules([{ name: 'a', condition: 'x:1', look: { tint: 'ok' }, order: 1 }]), /unknown keys: order/);
    const rules = cleanRules([
      { name: 'one', condition: 'fields.risk:low', look: { outline: 'ok', badge: 'safe' } },
      { name: 'two', condition: 'review.allOk', look: { outline: 'warn', badge: { text: 'approved', icon: 'check' }, ribbon: 'approved' } },
      { name: 'three', condition: 'priority:high', look: { badge: 'high' } },
      { name: 'off', condition: 'priority:high', look: { tint: 'danger' }, enabled: false },
    ]);
    const look = lookFor(view, rules);
    assert.deepEqual(look.rules, ['one', 'two', 'three']);
    assert.equal(look.outline, 'ok', 'the first rule\'s outline wins');
    assert.equal(look.ribbon, 'approved');
    assert.deepEqual(look.badges, [{ text: 'safe' }, { text: 'approved', icon: 'check' }], 'two badges, no more');
    assert.equal(look.tint, undefined, 'a disabled rule does nothing');
    assert.equal(lookFor({ ...view, fields: { risk: 'high' }, review: { allOk: false }, priority: 'Low' }, rules), null);
  });
});

describe('card rules on a board', () => {
  it('only the human sets them; a bad condition is a 400 with a hint; search, check and matches use them', async () => {
    const s = await startServer({ agents: { agents: {} } });
    try {
      await s.ok('POST', '/api/boards/main/schema/fields', { key: 'risk', type: 'enum', options: ['low', 'high'] }, USER);
      const mk = (title, risk) => s.ok('POST', '/api/boards/main/items', { title, column: 'Ready', fields: { risk } }, USER);
      const low = await mk('low one', 'low');
      const high = await mk('high one', 'high');
      assert.deepEqual((await s.ok('GET', '/api/boards/main/card-rules')).rules, []);

      const rules = [
        { name: 'safe', condition: 'fields.risk:low', look: { outline: 'ok', badge: 'safe' } },
        { name: 'unreviewed', condition: 'review.pending=0 !review.allOk', look: { tint: 'accent' } },
      ];
      const agent = await s.api('PUT', '/api/boards/main/card-rules', { rules }, { agent: 'dev' });
      assert.equal(agent.status, 403);
      assert.equal(agent.body.code, 'HUMAN_ONLY');
      const bad = await s.api('PUT', '/api/boards/main/card-rules', { rules: [{ name: 'x', condition: 'review.oks>=two', look: { tint: 'ok' } }] }, USER);
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'BAD_REQUEST');
      assert.match(bad.body.error, /not a number/);
      assert.ok(bad.body.hint);
      assert.deepEqual((await s.ok('GET', '/api/boards/main/card-rules')).rules, [], 'a refused PUT changes nothing');

      const put = await s.ok('PUT', '/api/boards/main/card-rules', { rules }, USER);
      assert.deepEqual(put.rules.map((r) => r.name), ['safe', 'unreviewed']);
      assert.deepEqual((await s.ok('GET', '/api/boards/main/card-rules')).rules, put.rules, 'kept, in order');

      // review facts and the filter in search
      const hit = await s.ok('POST', '/api/search', { board: 'main', filter: 'fields.risk:low !review.allOk' }, USER);
      assert.deepEqual(hit.items.map((i) => i.id), [low.id]);
      assert.deepEqual(hit.items[0].review, { oks: 0, pending: 0, concerns: 0, allOk: false, evidence: false });
      const viaWhere = await s.ok('POST', '/api/search', { board: 'main', where: { 'review.oks': { gte: 1 } } }, USER);
      assert.equal(viaWhere.total, 0);
      const viaGet = await s.ok('GET', '/api/search?board=main&filter=fields.risk:high');
      assert.deepEqual(viaGet.items.map((i) => i.id), [high.id]);
      const badFilter = await s.api('POST', '/api/search', { board: 'main', filter: 'is:nothing' }, USER);
      assert.equal(badFilter.status, 400);
      assert.ok(badFilter.body.hint);

      // the live count before saving, and the looks
      const check = await s.ok('GET', '/api/boards/main/card-rules/check?condition=fields.risk:low');
      assert.deepEqual(check, { count: 1, ids: [low.id] });
      assert.equal((await s.api('GET', '/api/boards/main/card-rules/check?condition=oops>')).status, 400);
      const matches = await s.ok('GET', '/api/boards/main/card-rules/matches');
      assert.deepEqual(matches[low.id], { rules: ['safe', 'unreviewed'], outline: 'ok', tint: 'accent', badges: [{ text: 'safe' }] });
      assert.deepEqual(matches[high.id], { rules: ['unreviewed'], tint: 'accent' });
      const withLook = await s.ok('POST', '/api/search', { board: 'main', where: { id: low.id } }, USER);
      assert.equal(withLook.items[0].look.outline, 'ok');

      // switch one off: it no longer matches
      await s.ok('PUT', '/api/boards/main/card-rules', { rules: [{ ...rules[0], enabled: false }, rules[1]] }, USER);
      assert.deepEqual((await s.ok('GET', '/api/boards/main/card-rules/matches'))[low.id], { rules: ['unreviewed'], tint: 'accent' });
    } finally { await s.stop(); }
  });

  it('a reviewer\'s ok counts only with their own token, and review.allOk follows it', async () => {
    const s = await startServer({ agents: { agents: { nebula: { role: 'reviewer', enabled: false }, rocket: { role: 'builder', enabled: false, reviewer: true }, groot: { role: 'builder', enabled: false, reviewer: true } } },
      manifest: { auth: { agentTokens: { nebula: 't-nebula', rocket: 't-rocket' } } } }); // groot has no token here
    try {
      const it = await s.ok('POST', '/api/boards/main/items', { title: 'to review', column: 'Ready' }, USER);
      await s.ok('POST', `/api/boards/main/items/${it.id}/start`, {}, { agent: 'dev' });
      await s.ok('POST', `/api/boards/main/items/${it.id}/review`, { changed: 'c', why: 'w', verify: 'v', evidence: 'shots' }, { agent: 'dev' });
      for (const name of ['nebula', 'groot']) await s.ok('POST', `/api/boards/main/items/${it.id}/reviewers`, { name }, USER);
      const facts = async () => (await s.ok('POST', '/api/search', { board: 'main', where: { id: it.id } }, USER)).items[0].review;
      assert.deepEqual(await facts(), { oks: 0, pending: 2, concerns: 0, allOk: false, evidence: true });
      const verdict = (who, v, token) => fetch(`${s.base}/api/boards/main/items/${it.id}/reviewers/${who}/verdict`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent': who, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ verdict: v, comment: 'looked' }) });
      assert.ok((await verdict('nebula', 'ok', 't-nebula')).ok);
      assert.deepEqual(await facts(), { oks: 1, pending: 1, concerns: 0, allOk: false, evidence: true });
      assert.ok((await verdict('groot', 'ok', null)).ok, 'given by an agent with no token: recorded, but the board cannot vouch for it');
      assert.deepEqual(await facts(), { oks: 1, pending: 1, concerns: 0, allOk: false, evidence: true }, 'an unverified ok is not counted');
      await s.ok('POST', `/api/boards/main/items/${it.id}/reviewers`, { name: 'rocket' }, USER);
      assert.ok((await verdict('rocket', 'ok', 't-rocket')).ok);
      assert.deepEqual(await facts(), { oks: 2, pending: 1, concerns: 0, allOk: false, evidence: true }, 'groot is still pending, so not allOk');
      const check = (c) => s.ok('GET', `/api/boards/main/card-rules/check?condition=${encodeURIComponent(c)}`);
      assert.equal((await check('review.oks>=2 review.pending=1 review.evidence reviewers.nebula:ok')).count, 1);
      assert.equal((await check('review.allOk')).count, 0);
    } finally { await s.stop(); }
  });
});
