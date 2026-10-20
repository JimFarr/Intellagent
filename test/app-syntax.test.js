'use strict';
// The browser app must parse: one duplicate top-level const or let stops the whole file from loading, and no other test
// runs it. vm.Script compiles the source without running it, so nothing in the page executes here.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

describe('browser app', () => {
  it('public/app.js parses as a script (a duplicate top-level const fails here, by name)', () => {
    const file = path.join(__dirname, '..', 'public', 'app.js');
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(() => new vm.Script(src, { filename: file }), 'public/app.js must parse');
  });
});

// The writing pip's agent half (INT-286) lives in the page, so run the real thinkers() and writersOf() source here
// against a stand-in state: a running agent woken by a comment on the ticket is a writer until its reply lands or its run ends.
describe('writing pip: agents', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const cut = (from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a); assert.ok(a > 0 && b > a, `${from} not found`); return src.slice(a, b); };
  const make = (standing) => {
    const w = vm.runInNewContext(
      `${cut('const thinkers =', 'const dotsHTML')}\nconst typingNow = new Map();\n${cut('const writersOf =', 'const pipHTML')}\n({ writersOf: (it) => JSON.stringify(writersOf(it)) })`,
      { state: { standing } });
    return { writersOf: (it) => JSON.parse(w.writersOf(it)) }; // out of the vm's realm, so deepEqual compares plain arrays
  };
  const run = (status, about = { comments: ['T-1'] }) => ({ drax: { name: 'drax', status, lastRun: { startedAt: '2026-01-01T10:00:00Z', about } } });
  const item = (comments = []) => ({ id: 'T-1', comments });

  it('a running agent woken by a comment on the ticket is writing', () => {
    assert.deepEqual(make(run('running')).writersOf(item()), ['drax']);
  });
  it('it stops when its reply posts', () => {
    const reply = [{ author: { name: 'drax' }, createdAt: '2026-01-01T10:01:00Z' }];
    assert.deepEqual(make(run('running')).writersOf(item(reply)), []);
  });
  it('it stops when the run ends, and never shows for another ticket or a queued run', () => {
    assert.deepEqual(make(run('idle')).writersOf(item()), []);
    assert.deepEqual(make(run('queued')).writersOf(item()), []);
    assert.deepEqual(make(run('running', { comments: ['T-2'] })).writersOf(item()), []);
  });
});

// The no-reply pip (INT-333): the rule is the whole feature, so run the real quietOf() source.
describe('no-reply pip', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const a = src.indexOf('const answeredByReaction'), b = src.indexOf('const clock =');
  assert.ok(a > 0 && b > a);
  const quiet = (agent, comments = []) => JSON.parse(vm.runInNewContext(
    `${src.slice(a, b)}\nJSON.stringify(quietOf({ id: 'T-1', comments }))`,
    { state: { standing: { drax: { name: 'drax', status: 'idle', ...agent } } }, comments }));
  const ended = (about = { comments: ['T-1'] }) => ({ lastRun: { startedAt: '2026-01-01T10:00:00Z', endedAt: '2026-01-01T10:05:00Z', about } });

  it('an ended run that was woken here and said nothing leaves a trace with its end time', () => {
    assert.deepEqual(quiet(ended()), [{ name: 'drax', at: '2026-01-01T10:05:00Z' }]);
  });
  it('nothing for another ticket, a running agent, or a run that never ended', () => {
    assert.deepEqual(quiet(ended({ comments: ['T-2'] })), []);
    assert.deepEqual(quiet({ ...ended(), status: 'running' }), []);
    assert.deepEqual(quiet({ lastRun: { startedAt: '2026-01-01T10:00:00Z', about: { comments: ['T-1'] } } }), []);
  });
  it('it clears when the agent comments after the run began, but not for an older comment or someone else', () => {
    assert.deepEqual(quiet(ended(), [{ author: { name: 'drax' }, createdAt: '2026-01-01T10:03:00Z' }]), []);
    assert.equal(quiet(ended(), [{ author: { name: 'drax' }, createdAt: '2026-01-01T09:00:00Z' }]).length, 1);
    assert.equal(quiet(ended(), [{ author: { name: 'nebula' }, createdAt: '2026-01-01T10:03:00Z' }]).length, 1);
  });
  it('a reaction by the agent answers, except seen and queued', () => {
    assert.deepEqual(quiet(ended(), [{ author: { name: 'james' }, createdAt: '2026-01-01T09:59:00Z', reactions: { '✅': ['drax'] } }]), []);
    assert.equal(quiet(ended(), [{ author: { name: 'james' }, createdAt: '2026-01-01T09:59:00Z', reactions: { '👀': ['drax'], '⏳': ['drax'] } }]).length, 1);
  });
});

// The rule builder (INT-306) lives in the page too: run its real ruleTree and treeText source against a stand-in field list,
// and check that condition text -> rows -> text gives the same text, and that a text row cannot change how rows group.
describe('rule builder: round trip', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const a = src.indexOf('const RULE_TESTS ='), b = src.indexOf('const needsNoSpace');
  assert.ok(a > 0 && b > a, 'rule builder source not found');
  const fields = [
    { path: 'type', kind: 'choice', options: [] }, { path: 'priority', kind: 'choice', options: [] },
    { path: 'review.oks', kind: 'number' }, { path: 'review.allOk', kind: 'flag' }, { path: 'columnDays', kind: 'number' },
    { path: 'fields.risk', kind: 'choice', options: [] }, { path: '', kind: 'raw' },
  ];
  const lib = vm.runInNewContext(
    `${src.slice(a, b)}\n({ back: (t) => treeText(ruleTree(t, F)), tree: (t) => JSON.stringify(ruleTree(t, F)), text: (tr) => treeText(tr) })`,
    { F: fields });
  const same = ['review.allOk (@drax or @nebula) columnDays>=3', 'review.allOk or (@drax or @nebula) or columnDays>=3',
    'fields.risk:high or priority:Critical or is:rule:"two words"', 'type:issue review.oks>=2'];
  for (const t of same) it(`"${t}" comes back as written`, () => assert.equal(lib.back(t), t));
  it('a condition with no switch (a b or c) stays one text row, saved as written', () => {
    const t = 'type:issue priority:High or @drax';
    assert.equal(lib.back(t), t);
    assert.equal(JSON.parse(lib.tree(t)).items.length, 1);
  });
  it('beside other rows a text row must be one term', () => {
    const rows = (v) => ({ mode: 'all', items: [{ path: 'type', test: 'is', value: 'issue' }, { path: '', test: 'raw', value: v }] });
    assert.equal(lib.text(rows('a or b')), null);
    assert.equal(lib.text(rows('a b')), null);
    assert.equal(lib.text(rows('(a)')), null);
    assert.equal(lib.text(rows('or')), null);
    assert.equal(lib.text(rows('is:rule:"two words"')), 'type:issue is:rule:"two words"');
    assert.equal(lib.text(rows('@drax')), 'type:issue @drax');
  });
});
