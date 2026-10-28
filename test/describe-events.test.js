'use strict';
// The activity lists say "for you" on every change an agent made with a delegated power, board admin included, and
// name a deleted column: a delegated rules or column change must not read like an ordinary edit.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// The event-to-words function is an ES module of the browser app (public/js/events.js); the page passes in nameOf and RUN_LABEL.
const { describe: describeEvent } = require('../public/js/events.js');
const words = (ev, html = false) => describeEvent(ev, html, (n) => n, {});

const delegated = { power: 'admin.rules', onBehalfOf: 'human' };

describe('activity words', () => {
  it('in HTML, names an agent chose (property keys, emoji) are text, never markup', () => {
    const changed = words({ type: 'item.updated', item: { id: 'INT-1' }, changes: { 'properties.<img src=x onerror=alert(1)>': {} } }, true);
    assert.ok(!changed.includes('<img'), changed);
    assert.match(changed, /&lt;img/);
    assert.ok(!words({ type: 'reaction.added', item: { id: 'INT-1' }, emoji: '<b>x</b>' }, true).includes('<b>x'));
    assert.ok(!words({ type: 'agent.managed', agent: 'a', changes: { '<i>': {} } }, true).includes('<i>'));
  });
  it('evaluates describe()', () => {
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

  it('a deleted column reads by its name when the event carries one', () => {
    assert.equal(words({ type: 'column.deleted', actor: { name: 'james' }, columnId: 'qa-2', column: { id: 'qa-2', name: 'QA' } }), 'james deleted column QA');
  });
});
