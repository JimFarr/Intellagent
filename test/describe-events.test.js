'use strict';
// The activity lists say "for you" on every change an agent made with a delegated power, board admin included, and
// name a deleted column: a delegated rules or column change must not read like an ordinary edit.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The event-to-words function lives inside the browser app; evaluate just that slice of public/app.js.
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const escLine = /^ {2}const esc = .*$/m.exec(src)[0];
const from = src.indexOf('  function describe(ev, html = false) {'), to = src.indexOf('\n  }\n', from) + '\n  }\n'.length;
const { describe: words } = new Function('nameOf', `${escLine}\n${src.slice(from, to)}; return { describe };`)((n) => n);

const delegated = { power: 'admin.rules', onBehalfOf: 'human' };

describe('activity words', () => {
  it('evaluates describe()', () => {
    assert.ok(from > 0 && to > from, 'describe() in public/app.js');
    assert.equal(words({ type: 'board.updated', actor: { name: 'gamora' } }), 'gamora updated the board');
  });

  it('a delegated board, schema or column change reads "for you"', () => {
    const ev = (type, extra = {}) => ({ type, actor: { name: 'gamora' }, delegated, ...extra });
    assert.equal(words(ev('board.updated')), 'gamora updated the board for you');
    assert.equal(words(ev('schema.updated')), 'gamora changed the ticket schema for you');
    assert.equal(words(ev('column.created', { column: { name: 'QA' } })), 'gamora added column QA for you');
    assert.equal(words(ev('column.updated', { column: { name: 'QA' } })), 'gamora updated column QA for you');
  });

  it('an ordinary change of the same kind does not say "for you"', () => {
    assert.equal(words({ type: 'board.updated', actor: { name: 'james' } }), 'james updated the board');
    assert.equal(words({ type: 'column.updated', actor: { name: 'james' }, column: { name: 'QA' } }), 'james updated column QA');
  });

  it('a deleted column is named, and a delegated delete says "for you"', () => {
    assert.equal(words({ type: 'column.deleted', actor: { name: 'gamora' }, columnId: 'qa', delegated }), 'gamora deleted column qa for you');
    assert.equal(words({ type: 'column.deleted', actor: { name: 'james' }, columnId: 'qa' }), 'james deleted column qa');
  });
});
