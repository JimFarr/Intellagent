// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// FOR / IF / THEN (INT-480): a rule is for a subject (a ticket T, or a comment C on a ticket T), with names the human
// may change, and its "if" in the expression language. Older rules are rewritten once, only where the words say the same.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { startServer, until, USER } = require('./helpers');
const RULES = require('../lib/rules');

const COLS = [{ id: 'ready', name: 'Ready' }, { id: 'in-progress', name: 'In Progress' }, { id: 'done', name: 'Done' }];
const FIELDS = [{ key: 'risk', type: 'enum', options: [{ value: 'low' }, 'high'] }, { key: 'area', type: 'tags', options: ['ui', 'server'] }, { key: 'estimate', type: 'number' }, { key: 'note', type: 'text' }];
const T = RULES.ticketDesc(COLS, FIELDS);
let X;
before(async () => { X = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'expr.js')).href); });

describe('rules: filter conditions as expressions (lib/rules.js toExpr)', () => {
  it('says each kind of term the same way, or not at all', () => {
    for (const [filter, expr] of [
      ['priority:High', 'T.priority == "High"'],
      ['priority:High|Critical', 'T.priority in ["High", "Critical"]'],
      ['fields.area:ui', 'T.fields.area.contains("ui")'],
      ['fields.area:ui|server', '(T.fields.area.contains("ui") || T.fields.area.contains("server"))'],
      ['@drax', '(T.assignee == "drax" || T.claimant == "drax")'],
      ['!claimant', '!(!T.claimant.isEmpty())'],
      ['review.oks>=2 review.allOk', 'T.review.oks >= 2 && T.review.allOk'],
      ['fields.estimate=3', 'T.fields.estimate == 3'],
      ['type:issue or (priority:Critical @drax)', 'T.type == "issue" || (T.priority == "Critical" && (T.assignee == "drax" || T.claimant == "drax"))'],
      ['column:"In Progress"', null], // the filter reads the quotes as part of the value: not one of the columns
      ['is:rule:urgent', null], // another card look: not in the expression language
      ['properties.pr:x', null], // an open bag: a list or a text, the filter matched either
      ['fields.risk:medium', null], // not one of the options: the filter matched nothing, the expression would not read
      ['nope:1', null],
    ]) assert.equal(RULES.toExpr(filter, 'T', T), expr, filter);
  });
  it('every translation reads in the language, and picks the same tickets as the filter did', () => {
    const cardrules = require('../lib/cardrules');
    const schema = RULES.schemaFor('ticket', null, COLS, FIELDS);
    const tickets = [
      { priority: 'High', type: 'task', assignee: 'drax', claimant: null, fields: { area: ['ui'], estimate: 3 }, review: { oks: 2, allOk: true } },
      { priority: 'critical', type: 'issue', assignee: null, claimant: 'DRAX', fields: { area: [] }, review: { oks: 1, allOk: false } },
      { priority: 'Low', type: 'spike', assignee: 'nebula', claimant: 'nebula', fields: {}, review: {} },
    ];
    for (const filter of ['priority:High', 'priority:High|Critical', 'fields.area:ui', '@drax', '!claimant', 'claimant', 'review.oks>=2 review.allOk', 'fields.estimate=3', 'type:issue or (priority:Critical @drax)', '!priority:Low fields.area:ui|server']) {
      const text = RULES.toExpr(filter, 'T', T);
      const c = X.compile(text, schema);
      assert.ok(c.ok, `${filter} → ${text}: ${c.error?.message}`);
      for (const t of tickets) assert.equal(X.evaluate(c.tree, { T: t }), cardrules.holds(cardrules.parseCondition(filter), t), `${filter} on ${JSON.stringify(t)}`);
    }
  });
});

describe('rules: subjects and names (lib/rules.js)', () => {
  const clean = (r) => RULES.cleanRule(r, COLS, { id: 'r1', nowIso: '2026-10-30T00:00:00Z', compile: X.compile, fields: FIELDS });
  it('a rule is for a ticket or a comment; a comment rule needs no "when" and names its parts', () => {
    const t = clean({ name: 'x', when: { on: 'created' }, then: [{ do: 'archive' }] });
    assert.deepEqual([t.for, t.names], ['ticket', { ticket: 'T' }]);
    const c = clean({ name: 'y', for: 'comment', names: { comment: 'msg', ticket: 'card' }, lang: 'expr', if: 'msg.text.contains("?") && card.priority == "High"', then: [{ do: 'wake', agent: 'coordinator' }] });
    assert.deepEqual([c.for, c.when, c.names, c.lang], ['comment', { on: 'commented' }, { comment: 'msg', ticket: 'card' }, 'expr']);
  });
  it('refuses what does not fit, saying where', () => {
    for (const [bad, msg] of [
      [{ for: 'pr', when: { on: 'created' } }, /not something a rule is for/],
      [{ for: 'comment', when: { on: 'created' } }, /is about a ticket, not a comment/],
      [{ for: 'comment', names: { comment: 'T', ticket: 'T' } }, /same name/],
      [{ names: { ticket: 'in' }, when: { on: 'created' } }, /can't name the ticket/],
      [{ names: { comment: 'C' }, when: { on: 'created' } }, /has no "comment"/],
      [{ when: { on: 'created' }, lang: 'sql', if: 'x' }, /not a language/],
      [{ when: { on: 'fits' }, lang: 'expr', if: 'T.priority == "High"', then: [{ do: 'look', look: { tint: 'warn' } }] }, /filter language/],
    ]) assert.throws(() => clean({ name: 'x', then: [{ do: 'archive' }], ...bad }), msg, JSON.stringify(bad));
    let err;
    try { clean({ name: 'x', when: { on: 'created' }, lang: 'expr', if: 'T.priorty == "High"', then: [{ do: 'archive' }] }); } catch (e) { err = e; }
    assert.match(err.message, /no field "priorty".*did you mean "priority"/);
    assert.deepEqual([err.at, err.end], [2, 9]);
    assert.match(err.hint, /At character 3: "priorty"/);
  });
  it('upgrades an older rule: its subject, its "if", and "mentioned" as a comment rule; leaves looks, engines and what it cannot say', () => {
    const old = { id: 'a', name: 'a', enabled: true, when: { on: 'mentioned', to: 'drax' }, if: 'priority:High', then: [{ do: 'wake', agent: 'drax' }] };
    const up = RULES.upgrade(old, T);
    assert.deepEqual({ for: up.for, names: up.names, when: up.when, lang: up.lang, if: up.if }, { for: 'comment', names: { comment: 'C', ticket: 'T' }, when: { on: 'commented' }, lang: 'expr', if: '(T.priority == "High") && (C.mentions.contains("drax"))' });
    assert.equal(RULES.upgrade(up, T), up, 'once');
    for (const keep of [
      { ...old, when: { on: 'fits' } },
      { ...old, when: { on: 'in_column', column: 'in-progress', minutes: 60 }, if: '!claimant', engine: 'staleWork' },
      { ...old, if: 'is:rule:urgent' },
    ]) assert.equal(RULES.upgrade(keep, T), keep);
  });
});

describe('rules: FOR / IF / THEN on the board (INT-480)', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.stop());

  it('lists the subjects with their parts for the suggestions, and answers an "if" that does not read with where', async () => {
    const v = (await s.ok('GET', '/api/boards/main/rules', undefined, USER)).vocabulary;
    assert.deepEqual(Object.keys(v.subjects), ['ticket', 'comment']);
    assert.deepEqual(v.subjects.comment.names, { comment: 'C', ticket: 'T' });
    assert.equal(v.subjects.ticket.parts.ticket.fields.priority.kind, 'choice');
    assert.equal(v.events.commented.subject, 'comment');
    assert.equal(v.events.mentioned, undefined, 'the older word is not offered');
    const bad = await s.api('POST', '/api/boards/main/rules', { name: 'x', when: { on: 'created' }, lang: 'expr', if: 'T.title.contains("a") &&', then: [{ do: 'archive' }] }, USER);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'BAD_REQUEST');
    assert.equal(typeof bad.body.at, 'number');
    assert.ok(bad.body.hint);
  });

  it('a comment rule fires once for each comment its "if" picks, judged on the comment and its ticket', async () => {
    const r = await s.ok('POST', '/api/boards/main/rules', { name: 'Questions on urgent work', for: 'comment', lang: 'expr', if: 'C.text.contains("?") && T.priority in ["High", "Critical"]', then: [{ do: 'set_property', key: 'asked', value: 'yes' }] }, USER);
    assert.equal(r.when.on, 'commented');
    const hot = await s.ok('POST', '/api/boards/main/items', { title: 'hot', priority: 'High' }, USER);
    const cold = await s.ok('POST', '/api/boards/main/items', { title: 'cold', priority: 'Low' }, USER);
    await s.ok('POST', `/api/boards/main/items/${hot.id}/comments`, { body: 'no question here' }, { agent: 'drax' });
    await s.ok('POST', `/api/boards/main/items/${cold.id}/comments`, { body: 'why?' }, { agent: 'drax' });
    await s.ok('POST', `/api/boards/main/items/${hot.id}/comments`, { body: 'and why?' }, { agent: 'nebula' });
    await until(async () => (await s.ok('GET', `/api/boards/main/items/${hot.id}`, undefined, USER)).properties.asked === 'yes', 8000, 'the rule setting the property');
    const log = await s.ok('GET', `/api/boards/main/rules/log?rule=${r.id}`, undefined, USER);
    assert.deepEqual(log.map((l) => l.item), [hot.id], 'once: the comment without a question and the ticket that is not urgent are passed over');
    // the page's on/off switch sends name, enabled, when, if and then: the rule keeps its language and names
    const off = await s.ok('PUT', `/api/boards/main/rules/${r.id}`, { name: r.name, enabled: false, when: r.when, if: r.if, then: r.then }, USER);
    assert.deepEqual([off.enabled, off.lang, off.for, off.if], [false, 'expr', 'comment', r.if]);
  });

  it('a board that kept rules in the filter language reads them in the new words once it starts', async () => {
    const t = await startServer();
    await t.ok('POST', '/api/boards/main/rules', { name: 'Mentions', when: { on: 'mentioned', to: 'drax' }, if: 'priority:High', lang: 'filter', then: [{ do: 'wake', agent: 'drax' }] }, USER);
    await t.stop({ keep: true });
    const find = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? find(path.join(d, f.name)) : f.name === 'board.json' ? [path.join(d, f.name)] : []));
    const file = find(t.dir)[0];
    // the rule as the board kept it before INT-480: no for, no names, no lang
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rule = b.automations.rules.find((x) => x.name === 'Mentions');
    Object.assign(rule, { when: { on: 'mentioned', to: 'drax' }, if: 'priority:High' });
    for (const k of ['for', 'names', 'lang']) delete rule[k];
    fs.chmodSync(file, 0o666);
    fs.writeFileSync(file, JSON.stringify(b));
    const t2 = await startServer({ dir: t.dir });
    try {
      const up = (await t2.ok('GET', '/api/boards/main/rules', undefined, USER)).rules.find((x) => x.name === 'Mentions');
      assert.deepEqual([up.for, up.when.on, up.lang, up.if], ['comment', 'commented', 'expr', '(T.priority == "High") && (C.mentions.contains("drax"))']);
    } finally { await t2.stop(); }
  });
});
