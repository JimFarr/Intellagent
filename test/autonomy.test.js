'use strict';
// Autonomy (INT-393): a ticket's journey from pickup to Done, and every human intervention along the way.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { stepJourney, columnsOf, levelOf } = require('../lib/alerts/autonomy');

const board = { columns: ['backlog', 'ready', 'in-progress', 'review', 'done'].map((id) => ({ id, flags: { working: id === 'in-progress' } })) };
const cols = columnsOf(board);
const human = { kind: 'user', name: 'James' };
const agent = (name) => ({ kind: 'agent', name });
let t = 0;
const ev = (type, actor, more = {}) => ({ type, actor, itemId: 'T-1', ts: new Date(Date.parse('2026-10-19T09:00:00Z') + (t++) * 60_000).toISOString(), ...more });
const move = (from, to, actor = agent('groot')) => ev('item.moved', actor, { fromColumnId: from, columnId: to });
// replay changes (each a list of events) and return the journey
const replay = (changes) => changes.reduce((j, batch) => stepJourney(j, batch, cols), undefined);

describe('a ticket\'s journey', () => {
  it('begins at pickup: nothing before the working column counts', () => {
    const j = replay([[ev('comment.added', human)], [move('backlog', 'ready', human)], [move('ready', 'in-progress')]]);
    assert.ok(j.pickedUpAt);
    assert.deepEqual(j.touches, {}, 'the human\'s comment and move were before pickup');
  });

  it('autonomous: picked up, reviewed and approved by agents (a delegated decision), no human', () => {
    const j = replay([
      [move('ready', 'in-progress')], [move('in-progress', 'review')],
      [ev('review.reviewed', agent('nebula'))],
      [ev('attention.resolved', agent('stakar'), { kind: 'review', verdict: 'approve' }), ev('review.approved', agent('stakar')), move('review', 'done', agent('stakar'))],
    ]);
    assert.equal(j.level, 'autonomous');
    assert.ok(j.doneAt);
    assert.deepEqual([j.moves, j.back], [2, 0]);
  });

  it('approved: the only human touch is the approval, counted once however many events say it', () => {
    const j = replay([
      [move('ready', 'in-progress')], [move('in-progress', 'review')],
      [ev('attention.resolved', human, { kind: 'review', verdict: 'approve' }), ev('review.approved', human), move('review', 'done', human)],
    ]);
    assert.equal(j.level, 'approved');
    assert.deepEqual(j.touches, { decision: 1 });
  });

  it('a human dragging it into Done is the approval too', () => {
    const j = replay([[move('ready', 'in-progress')], [move('in-progress', 'done', human)]]);
    assert.deepEqual(j.touches, { decision: 1 });
    assert.equal(j.level, 'approved');
  });

  it('helped: an answer, a comment or a review sent back during the work; a send-back is rework, not a manual move', () => {
    const j = replay([
      [move('ready', 'in-progress')],
      [ev('attention.raised', agent('groot'))], [ev('attention.resolved', human, { kind: 'question' })],
      [move('in-progress', 'review')],
      [ev('attention.resolved', human, { kind: 'review', verdict: 'changes' }), ev('review.changes_requested', human), move('review', 'in-progress', human)],
      [ev('comment.added', human)],
      [move('in-progress', 'review')],
      [ev('review.approved', human), move('review', 'done', human)],
    ]);
    assert.equal(j.level, 'helped');
    assert.deepEqual(j.touches, { answer: 1, changes: 1, comment: 1, decision: 1 }, 'no "move": the send-back moved it as part of the decision');
    assert.deepEqual([j.moves, j.back], [4, 1]);
  });

  it('a human moving it by hand, assigning or editing during the work is help', () => {
    const j = replay([[move('ready', 'in-progress')], [ev('item.assigned', human)], [ev('item.updated', human)], [move('in-progress', 'review', human)], [move('review', 'done', human)]]);
    assert.deepEqual(j.touches, { assign: 1, edit: 1, move: 1, decision: 1 });
  });

  it('nothing after Done counts, and a reopened ticket picked up again starts a new journey', () => {
    let j = replay([[move('ready', 'in-progress')], [move('in-progress', 'done', human)]]);
    j = stepJourney(j, [ev('comment.added', human)], cols);
    assert.deepEqual(j.touches, { decision: 1 }, 'a comment on a done ticket is not an intervention');
    j = stepJourney(j, [move('done', 'ready', human)], cols);
    assert.equal(j, null, 'reopened into Ready: no journey until it is picked up again');
    j = stepJourney(j, [move('ready', 'in-progress')], cols);
    assert.deepEqual([j.doneAt, j.touches], [undefined, {}]);
  });

  it('levels', () => {
    assert.equal(levelOf({}), 'autonomous');
    assert.equal(levelOf({ decision: 1 }), 'approved');
    assert.equal(levelOf({ decision: 1, comment: 2 }), 'helped');
  });
});
