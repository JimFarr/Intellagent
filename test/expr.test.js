// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// The rule expression language (INT-479): parse, evaluate, errors with positions, suggestions, slow patterns.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let X;
before(async () => { X = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'expr.js')).href); });

const schema = {
  vars: {
    T: { kind: 'object', hint: 'the ticket', fields: {
      title: { kind: 'text', hint: 'the title' },
      priority: { kind: 'choice', options: ['Low', 'Medium', 'High', 'Critical'], hint: 'how urgent' },
      column: { kind: 'choice', options: ['Ready', 'In Progress', 'Review'] },
      assignee: { kind: 'person' },
      labels: { kind: 'list', of: { kind: 'choice', options: ['ui', 'server'] } },
      estimate: { kind: 'number' },
      fields: { kind: 'object', fields: { risk: { kind: 'choice', options: ['low', 'high'] } } },
      properties: { kind: 'object', open: true },
      review: { kind: 'object', fields: { allOk: { kind: 'bool' } } },
    } },
    C: { kind: 'object', hint: 'the comment', fields: { text: { kind: 'text' }, author: { kind: 'person' } } },
  },
};
const T = { title: 'Fix login', priority: 'High', column: 'Review', assignee: { name: 'Drax' }, labels: ['ui'], estimate: 3, fields: { risk: 'low' }, properties: { pr: 'x' }, review: { allOk: true } };
const data = { T, C: { text: 'Is this done?', author: { name: 'James' } } };
const run = (s, d = data) => X.test(s, schema, d);
const val = (s, d) => { const r = run(s, d); assert.equal(r.ok, true, s + ' ' + JSON.stringify(r.error)); return r.value; };
const err = (s) => { const r = run(s); assert.equal(r.ok, false, s); return r.error; };

describe('expression language: evaluate', () => {
  it('the example from the ticket', () => {
    assert.equal(val('C.text.contains("?") && T.priority in ["High", "Critical"]'), true);
    assert.equal(val('C.text.contains("?") && T.priority in ["Low"]'), false);
  });
  it('compares', () => {
    assert.equal(val('T.estimate >= 3 && T.estimate < 4'), true);
    assert.equal(val('T.estimate != 3'), false);
    assert.equal(val('T.priority == "high"'), true, 'text ignores case');
    assert.equal(val('T.assignee == "drax"'), true, 'a person compares by name');
    assert.equal(val('C.author != T.assignee'), true);
    assert.equal(val('T.fields.risk == "low"'), true);
    assert.equal(val('T.properties.pr == "x"'), true);
    assert.equal(val('T.properties.nothing == 1'), false);
  });
  it('logic, not and brackets to any depth', () => {
    assert.equal(val('!(T.estimate > 5 || (T.priority == "Low" && ((T.title.isEmpty()))))'), true);
    assert.equal(val('T.review.allOk'), true, 'a yes/no alone holds');
    assert.equal(val('!T.review.allOk'), false);
    assert.equal(val('true && !false'), true);
    assert.equal(val('C'), true, 'a name alone holds when there is one');
    assert.equal(val('C', { T }), false);
    assert.equal(val('C.text.contains("x")', { T }), false, 'missing data is not an error');
  });
  it('text and list methods', () => {
    assert.equal(val('T.title.startsWith("fix") && T.title.endsWith("LOGIN") && T.title.contains("x l")'), true);
    assert.equal(val('T.title.matches("^fix\\\\s+log")'), true);
    assert.equal(val('T.title.isEmpty()'), false);
    assert.equal(val('T.labels.contains("UI") && !T.labels.isEmpty() && T.labels.count == 1'), true);
    assert.equal(val('"ui" in T.labels'), true);
    assert.equal(val('T.labels.isEmpty()', { T: { labels: null } }), true);
  });
  it('never reaches inherited members', () => {
    assert.equal(val('T.properties.constructor == "x" || T.properties.__proto__ == "x"'), false);
  });
});

describe('expression language: errors', () => {
  it('say where and what was meant', () => {
    let e = err('T.priorty == "High"');
    assert.deepEqual([e.pos, e.end, e.didYouMean], [2, 9, 'priority']);
    e = err('X.a == 1');
    assert.equal(e.pos, 0); assert.match(e.message, /unknown name "X"/);
    e = err('T.priority == "Hgh"');
    assert.equal(e.didYouMean, 'High'); assert.equal(e.pos, 14);
    e = err('T.priority in ["High", "Crtical"]');
    assert.equal(e.didYouMean, 'Critical');
    e = err('T.title.contain("x")');
    assert.equal(e.didYouMean, 'contains');
    e = err('T.labels.contains("db")');
    assert.match(e.message, /not one of: ui, server/);
    e = err('T.fields.risk == "medium"');
    assert.match(e.message, /low, high/);
  });
  it('syntax', () => {
    assert.match(err('T.title = "x"').message, /==/);
    assert.equal(err('T.title = "x"').didYouMean, '==');
    assert.match(err('C.text.contains("x"').message, /ends too soon/);
    assert.match(err('T.title == "x').message, /closing quote/);
    assert.match(err('T.title == "x" T.title == "y"').message, /&& or \|\|/);
    assert.match(err('').message, /empty/);
    assert.match(err('T.estimate >').message, /ends too soon/);
    assert.match(err('T.title.contains()').message, /one argument/);
  });
  it('types', () => {
    assert.match(err('T.title').message, /yes\/no/);
    assert.match(err('T.estimate == "x"').message, /cannot compare/);
    assert.match(err('T.review.allOk > 1').message, /true\/false|cannot compare/);
    assert.match(err('T.labels == 1').message, /cannot be compared/);
    assert.match(err('T.title.count').message, /no field "count"/);
    assert.match(err('T.title.contains').message, /method/);
    assert.match(err('T.priority in "High"').message, /list/);
  });
});

describe('expression language: slow patterns are refused', () => {
  for (const bad of ['(a+)+$', '(a|a)*b', '(.*)*', '(\\\\w+\\\\s?)*', '(a)\\\\1', 'a'.repeat(130)]) {
    it(bad.slice(0, 20), () => assert.match(err(`T.title.matches("${bad}")`).message, /refused/));
  }
  it('plain patterns pass; the pattern must be written out', () => {
    assert.equal(val('T.title.matches("^(fix|add) [a-z]+$")'), true);
    assert.match(err('T.title.matches(C.text)').message, /in quotes/);
    assert.match(err('T.title.matches("(")').message, /not a valid pattern/);
  });
  it('a hand-made tree with a slow pattern is false, not slow', () => {
    const tree = { k: 'call', name: 'matches', obj: { k: 'lit', v: 'aaaaaaaaaaaaaaaaaaaaaaaa!', type: { kind: 'text' } }, args: [{ k: 'lit', v: '(a+)+$' }], type: { kind: 'bool' } };
    assert.equal(X.evaluate(tree, {}), false);
  });
});

describe('expression language: suggestions', () => {
  const at = (s, caret = s.length) => X.suggest(s, caret, schema);
  const labels = (s, caret) => at(s, caret).items.map((i) => i.label);

  it('names at the start, after && and after (', () => {
    for (const s of ['', 'T.estimate > 1 && ', '!(', 'T.estimate > 1 || (']) assert.deepEqual(labels(s).slice(0, 2), ['T', 'C'], s);
    assert.equal(at('').items[0].hint, 'the ticket');
  });
  it('filters by what is typed', () => {
    assert.deepEqual(labels('C'), ['C']);
    assert.deepEqual(labels('T.pri'), ['priority']);
    assert.equal(at('T.pri').items[0].hint, 'how urgent');
    const s = at('T.pri'); assert.deepEqual([s.from, s.to], [2, 5]);
  });
  it('fields after a dot, deep and shallow', () => {
    assert.ok(labels('T.').includes('assignee') && labels('T.').includes('fields'));
    assert.deepEqual(labels('T.fields.'), ['risk']);
    assert.deepEqual(labels('T.review.'), ['allOk']);
    assert.deepEqual(labels('T.properties.'), [], 'an open record has no known keys');
  });
  it('methods after a text or list, with the call opened', () => {
    assert.deepEqual(labels('C.text.'), ['contains', 'startsWith', 'endsWith', 'matches', 'isEmpty']);
    assert.equal(at('C.text.').items.find((i) => i.label === 'contains').insert, 'contains(');
    assert.equal(at('C.text.').items.find((i) => i.label === 'isEmpty').insert, 'isEmpty()');
    assert.deepEqual(labels('T.labels.'), ['count', 'contains', 'isEmpty']);
    assert.deepEqual(labels('C.text.st'), ['startsWith']);
  });
  it('operators after a value, by its type', () => {
    assert.deepEqual(labels('T.priority '), ['==', '!=', 'in']);
    assert.ok(labels('T.estimate ').includes('>=') && labels('T.estimate ').includes('in'));
    assert.deepEqual(labels('T.review.allOk '), ['&&', '||']);
    assert.deepEqual(labels('T.priority == "High" '), ['&&', '||']);
    assert.deepEqual(labels('C.text.contains("?") '), ['&&', '||']);
    assert.deepEqual(labels('T.priority i'), ['in']);
    assert.deepEqual(labels('T.title.isEmpty() &'), ['&&']);
    assert.deepEqual(labels('T.priority !'), ['!=']);
    assert.deepEqual(labels('(T.priority == "High" '), ['&&', '||', ')']);
  });
  it("a field's choice values after a comparison, in a list and inside contains", () => {
    assert.deepEqual(labels('T.priority == '), ['Low', 'Medium', 'High', 'Critical', 'T', 'C', 'true', 'false', '!', '(']);
    assert.equal(at('T.priority == ').items[0].insert, '"Low"');
    assert.deepEqual(labels('T.priority in [').slice(0, 4), ['Low', 'Medium', 'High', 'Critical']);
    assert.deepEqual(labels('T.priority in ["Low", ').slice(0, 4), ['Low', 'Medium', 'High', 'Critical']);
    assert.deepEqual(labels('T.labels.contains(').slice(0, 2), ['ui', 'server']);
    assert.deepEqual(labels('T.review.allOk == ').slice(0, 2), ['true', 'false']);
    assert.deepEqual(labels('T.column == "In'), ['In Progress']);
    assert.deepEqual(labels('T.column != "'), ['Ready', 'In Progress', 'Review']);
  });
  it('inside a half-typed text the whole text is replaced, quotes included', () => {
    const s = at('T.priority == "Hi');
    assert.deepEqual([s.from, s.to, s.items[0].insert], [14, 17, '"High"']);
    assert.equal(at('T.priority == "Hi"', 17).to, 18, 'the closing quote that is already there is taken too');
    assert.deepEqual(labels('C.text.contains("'), [], 'free text has no suggestions');
  });
  it('after in comes a list; a list closes with , or ]', () => {
    assert.equal(labels('T.priority in ')[0], '[');
    assert.deepEqual(labels('T.priority in ["Low" '), [',', ']']);
  });
  it('the caret in the middle of the text', () => {
    assert.deepEqual(labels('T.pri == "High"', 5), ['priority']);
    assert.ok(labels('T. == 1', 2).includes('estimate'));
  });
  it('never throws on rubbish', () => {
    for (const s of ['((', ']]', '"', '&&&&', '.', 'T..', '1 2 3', 'in in in', '@#$', 'T.title.contains(((']) assert.doesNotThrow(() => at(s), s);
  });
});
