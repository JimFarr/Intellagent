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
    // import lines are only legal in a module; the rest of the file is checked as a script
    const src = fs.readFileSync(file, 'utf8').replace(/^import .*$/gm, '');
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
      `${cut('const thinkers =', 'const replyWords')}\nconst typingNow = new Map();\n${cut('const writersOf =', 'const pipHTML')}\n({ writersOf: (it) => JSON.stringify(writersOf(it)) })`,
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

// Stop all agents (INT-340): run the real armStopAll() source against a stand-in document that records its listeners.
// The second click is the page's own handler (it calls stop._disarm, then posts stop-all), so it is not run here.
describe('stop all agents: the armed confirm', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const a = src.indexOf('function armStopAll('), b = src.indexOf('function fillAgents(');
  assert.ok(a > 0 && b > a, 'armStopAll source not found');
  const make = () => {
    const listeners = { click: [], keydown: [] };
    const doc = {
      addEventListener: (type, fn) => listeners[type].push(fn),
      removeEventListener: (type, fn) => { listeners[type] = listeners[type].filter((f) => f !== fn); },
    };
    const armStopAll = vm.runInNewContext(`${src.slice(a, b)}\narmStopAll`, { document: doc });
    const inside = { nodeName: 'SPAN' };
    const classes = new Set();
    const stop = {
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      lastChild: { textContent: 'Stop all agents' },
      contains: (node) => node === inside,
    };
    const body = {};
    const fire = (type, ev) => [...listeners[type]].forEach((fn) => fn(ev));
    const count = () => listeners.click.length + listeners.keydown.length;
    return { armStopAll, stop, body, inside, classes, fire, count };
  };

  it('the first click arms it: armed look, the second-click label, and the flag the redraw reads', () => {
    const t = make();
    t.armStopAll(t.stop, t.body);
    assert.ok(t.classes.has('armed'));
    assert.equal(t.stop.lastChild.textContent, 'Click again to stop everything');
    assert.equal(t.body._stopArmed, true);
  });
  it('Escape disarms it, and takes its listeners away', () => {
    const t = make();
    t.armStopAll(t.stop, t.body);
    t.fire('keydown', { type: 'keydown', key: 'a' });
    assert.ok(t.classes.has('armed'), 'other keys leave it armed');
    t.fire('keydown', { type: 'keydown', key: 'Escape' });
    assert.ok(!t.classes.has('armed'));
    assert.equal(t.stop.lastChild.textContent, 'Stop all agents');
    assert.equal(t.body._stopArmed, false);
    assert.equal(t.count(), 0, 'no listener left behind');
  });
  it('a click elsewhere disarms it; a click on the button itself does not', () => {
    const t = make();
    t.armStopAll(t.stop, t.body);
    t.fire('click', { type: 'click', target: t.inside });
    assert.ok(t.classes.has('armed'), 'the second click reaches the page handler, not the disarm');
    t.fire('click', { type: 'click', target: { nodeName: 'BODY' } });
    assert.ok(!t.classes.has('armed'));
    assert.equal(t.count(), 0);
  });
  it('a click while armed: the page calls stop._disarm once, which leaves no listener to fire again', () => {
    const t = make();
    t.armStopAll(t.stop, t.body);
    t.stop._disarm();
    assert.ok(!t.classes.has('armed'));
    assert.equal(t.count(), 0);
    t.fire('keydown', { type: 'keydown', key: 'Escape' }); // nothing left to run
    assert.equal(t.stop.lastChild.textContent, 'Stop all agents');
  });
});
