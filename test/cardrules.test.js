// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Card rules (INT-263): the condition language, the review facts that only count verdicts that stand,
// the human-only routes, and the look a ticket earns (first outline wins, badges stack).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, USER } = require('./helpers');
const { parseCondition, holds, reviewFacts, cleanRules, lookFor, RuleError, TYPE_RULES } = require('../lib/cardrules');

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
      const seeded = (await s.ok('GET', '/api/boards/main/card-rules')).rules;
      assert.deepEqual(seeded, [], 'a board starts with no card rules');

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
      assert.deepEqual((await s.ok('GET', '/api/boards/main/card-rules')).rules, seeded, 'a refused PUT changes nothing');

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

  it('the review facts join the decision record in search instead of replacing it', async () => {
    const s = await startServer({});
    try {
      const it = await s.ok('POST', '/api/boards/main/items', { title: 'decided', column: 'Ready' }, USER);
      await s.ok('POST', `/api/boards/main/items/${it.id}/start`, {}, { agent: 'dev' });
      await s.ok('POST', `/api/boards/main/items/${it.id}/review`, { changed: 'c', why: 'w', verify: 'v', evidence: 'shots' }, { agent: 'dev' });
      await s.ok('POST', `/api/boards/main/items/${it.id}/review/decision`, { verdict: 'approve', comment: 'fine' }, USER);
      const full = (await s.ok('POST', '/api/search', { board: 'main', where: { id: it.id }, full: true }, USER)).items[0];
      assert.equal(full.review.verdict, 'approve', 'the decision is still there');
      assert.equal(full.review.oks, 0, 'and so are the facts');
      const byVerdict = await s.ok('POST', '/api/search', { board: 'main', where: { 'review.verdict': 'approve' } }, USER);
      assert.ok(byVerdict.items.some((x) => x.id === it.id), 'review.verdict still works in where');
    } finally { await s.stop(); }
  });
});

describe('rule marks (INT-290)', () => {
  it('a mark has a shape and a tone or a colour; anything else is a 400 with a hint; lookFor keeps every matching mark in rule order', () => {
    const ok = cleanRules([{ name: 'a', condition: 'priority:High', look: { mark: { shape: 'star', colour: '#AABBCC' } } }, { name: 'b', condition: 'priority:High', look: { mark: { shape: 'bar', tone: 'warn' } } }]);
    assert.deepEqual(ok[0].look.mark, { shape: 'star', colour: '#aabbcc' });
    for (const mark of [{ shape: 'hexagon', tone: 'ok' }, { shape: 'star' }, { shape: 'star', tone: 'ok', colour: '#fff' }, { shape: 'star', tone: 'pink' }, { shape: 'star', colour: 'red' }, { shape: 'star', tone: 'ok', size: 3 }, 'star']) {
      assert.throws(() => cleanRules([{ name: 'x', condition: 'priority:High', look: { mark } }]), (e) => e instanceof RuleError && !!e.hint, JSON.stringify(mark));
    }
    // no limit: seven matching rules, seven marks, in the order of the rules
    const many = cleanRules(Array.from({ length: 7 }, (_, i) => ({ name: `m${i}`, condition: 'priority:High', look: { mark: { shape: 'circle', tone: 'ok' } } })));
    const look = lookFor({ priority: 'High' }, many);
    assert.deepEqual(look.marks.map((m) => m.rule), many.map((r) => r.name));
    assert.deepEqual(look.marks[0], { shape: 'circle', tone: 'ok', rule: 'm0' });
  });

  it('a board starts with no rules; a stored mark comes back; a bad one is refused; matches lists every mark; an old board loses the seeded type rules, unchanged ones only', async () => {
    const s = await startServer({ agents: { agents: {} } });
    try {
      const task = await s.ok('POST', '/api/boards/main/items', { title: 'a task', column: 'Ready', type: 'task' }, USER);
      const spike = await s.ok('POST', '/api/boards/main/items', { title: 'a spike', column: 'Ready', type: 'spike' }, USER);
      const got = await s.ok('GET', '/api/boards/main/card-rules');
      assert.deepEqual(got.rules, []);
      assert.ok(got.shapes.includes('star'));
      let m = await s.ok('GET', '/api/boards/main/card-rules/matches');
      assert.deepEqual(m, {}, 'no rules, no marks');

      // a bad shape or colour: 400, a hint, nothing changed
      const bad = await s.api('PUT', '/api/boards/main/card-rules', { rules: [{ name: 'x', condition: 'type:task', look: { mark: { shape: 'blob', tone: 'ok' } } }] }, USER);
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'BAD_REQUEST');
      assert.match(bad.body.hint, /square\|circle/);
      assert.deepEqual((await s.ok('GET', '/api/boards/main/card-rules')).rules, got.rules);

      // the human adds marks of their own; every matching mark is listed, in rule order; a rule can be switched off
      const mine = { name: 'big', condition: 'type:task', look: { mark: { shape: 'star', tone: 'danger' } } };
      const also = { name: 'also', condition: 'type:task', look: { mark: { shape: 'circle', colour: '#6aa8ff' } } };
      const spikes = { name: 'spikes', condition: 'type:spike', look: { mark: { shape: 'diamond', tone: 'warn' } }, enabled: false };
      await s.ok('PUT', '/api/boards/main/card-rules', { rules: [mine, also, spikes] }, USER);
      m = await s.ok('GET', '/api/boards/main/card-rules/matches');
      assert.deepEqual(m[task.id].marks.map((x) => [x.rule, x.shape]), [['big', 'star'], ['also', 'circle']]);
      assert.equal(m[spike.id], undefined, 'a rule switched off gives no mark');

      // a board seeded earlier with the three type rules loses them once, but keeps one the human changed
      const seeded = TYPE_RULES.map((r) => structuredClone(r));
      seeded[1].look.mark.colour = '#000000';
      await s.ok('PUT', '/api/boards/main/card-rules', { rules: [mine, ...seeded] }, USER);
      await s.stop({ keep: true });
      const file = path.join(s.dir, 'data', 'boards', 'main', 'board.json');
      fs.chmodSync(file, 0o666);
      const b = JSON.parse(fs.readFileSync(file, 'utf8'));
      b.cardRulesSeeded = true;
      fs.writeFileSync(file, JSON.stringify(b));
      const old = await startServer({ dir: s.dir });
      try {
        assert.deepEqual((await old.ok('GET', '/api/boards/main/card-rules')).rules.map((r) => r.name), ['big', 'type issue']);
      } finally { await old.stop(); }
    } catch (e) { await s.stop().catch(() => {}); throw e; }
  });
});

describe('any-of, groups, the age fact and rule names with spaces (INT-292)', () => {
  const view = { assignee: 'drax', claimant: null, priority: 'High', columnDays: 5, fields: { risk: 'low' }, review: { oks: 2, allOk: true, concerns: 0 }, reviewers: {} };
  const ok = (text, rules) => holds(parseCondition(text), view, rules);
  it('or: either side; and binds tighter; a group is one unit; old conditions answer the same', () => {
    assert.ok(ok('@groot or @drax'));
    assert.ok(!ok('@groot or @nebula'));
    assert.ok(ok('@groot review.allOk or @drax'), 'and binds tighter: (@groot and allOk) or @drax');
    assert.ok(!ok('@groot or @nebula review.allOk'));
    assert.ok(ok('review.allOk (@groot or @drax)'));
    assert.ok(!ok('!review.allOk (@groot or @drax)'));
    assert.ok(ok('(@groot or @nebula) or fields.risk:low'));
    assert.ok(ok('fields.risk:low|high review.oks>=2'), 'a|b inside one term still works');
    assert.ok(ok('@drax OR @groot'), 'or in any case');
  });
  it('a group inside a group, an unclosed or stray bracket and a dangling or are 400s with a hint', () => {
    for (const bad of ['(@a or (@b @c))', '(@a or @b', '@a or @b)', 'or @a', '@a or', '()', '(@a or)', '@a or or @b']) {
      assert.throws(() => parseCondition(bad), (e) => e instanceof RuleError && !!e.message && !!e.hint, bad);
    }
    assert.match(assertThrowsHint('(@a or (@b))'), /one level/i);
    assert.match(assertThrowsHint('!(@a or @b)'), /! on the terms inside/);
  });
  it('a bracket pair inside a value stays in its term, as it did before groups', () => {
    const t = parseCondition('fields.note:foo(bar) or (fields.note:a(b)c @drax)');
    assert.equal(t.any[0][0].value, 'foo(bar)');
    assert.equal(t.any[1][0].any[0][0].value, 'a(b)c');
    assert.equal(t.any[1][0].any[0][1].value, 'drax');
    assert.ok(holds(parseCondition('fields.note:foo(bar)'), { fields: { note: 'foo(bar)' } }));
  });
  it('columnDays compares like review.oks', () => {
    assert.ok(ok('columnDays>=3'));
    assert.ok(ok('columnDays>4 columnDays<6'));
    assert.ok(!ok('columnDays>5'));
    assert.ok(ok('columnDays=5'));
    assert.ok(ok('columnDays>=9 or columnDays<=5'));
  });
  it('is:rule: finds a rule named with a space, by quotes or by a dash, in any case', () => {
    const rules = [{ name: 'full approval', condition: 'review.allOk review.oks>=2' }, { name: 'cold', condition: 'columnDays>=9' }];
    assert.ok(ok('is:rule:"full approval"', rules));
    assert.ok(ok('is:rule:full-approval', rules));
    assert.ok(ok('is:rule:Full-Approval', rules));
    assert.ok(!ok('is:rule:cold', rules));
    assert.ok(ok('is:rule:cold or is:rule:"full approval"', rules));
    assert.throws(() => parseCondition('is:rule:"full approval'), (e) => e instanceof RuleError && !!e.hint, 'an open quote');
  });
  it('on a board: columnDays is a search fact and filter term, and the check route takes the new syntax', async () => {
    const s = await startServer({ agents: { agents: {} } });
    try {
      const it1 = await s.ok('POST', '/api/boards/main/items', { title: 'fresh', column: 'Ready', type: 'task' }, USER);
      const q = (c) => s.ok('GET', `/api/boards/main/card-rules/check?condition=${encodeURIComponent(c)}`);
      assert.equal((await q('columnDays<1')).count, 1);
      assert.equal((await q('columnDays>=1')).count, 0);
      assert.deepEqual((await q('columnDays>=1 or (type:task columnDays=0)')).ids, [it1.id]);
      const found = await s.ok('POST', '/api/search', { board: 'main', where: { columnDays: { lt: 1 } }, fields: ['id', 'columnDays'] });
      assert.deepEqual(found.items.map((x) => [x.id, x.columnDays]), [[it1.id, 0]]);
      assert.equal((await s.api('GET', `/api/boards/main/card-rules/check?condition=${encodeURIComponent('(a or (b))')}`)).status, 400);
      // a rule with the new syntax is stored and earns its look
      await s.ok('PUT', '/api/boards/main/card-rules', { rules: [{ name: 'fresh work', condition: 'columnDays<1 (type:task or type:spike)', look: { badge: 'new' } }, { name: 'also', condition: 'is:rule:"fresh work"', look: { ribbon: 'fresh' } }] }, USER);
      const m = await s.ok('GET', '/api/boards/main/card-rules/matches');
      assert.deepEqual(m[it1.id].rules, ['fresh work', 'also']);
    } finally { await s.stop(); }
  });
});

function assertThrowsHint(text) {
  try { parseCondition(text); } catch (e) { return `${e.message} ${e.hint}`; }
  return '';
}
