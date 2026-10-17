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
