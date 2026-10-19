'use strict';
// Each agent's pending work (lib/alerts/work.js, INT-382), driven by a hand-built world: plain boards, a fixed
// clock and a stub team. No server, no processes.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createRecipients } = require('../lib/alerts/recipients');
const { createOks } = require('../lib/alerts/oks');
const { createWork } = require('../lib/alerts/work');

const NOW = Date.parse('2026-10-19T12:00:00Z');
const iso = (ms) => new Date(NOW + ms).toISOString();
const MIN = 60_000;

// A board with Backlog (sleeping), Ready (pickup), In Progress, Review and Done; items placed by columnId.
function makeBoard(items = [], extra = {}) {
  const columns = ['backlog', 'ready', 'in-progress', 'review', 'done'].map((id) => ({
    id, name: { backlog: 'Backlog', ready: 'Ready', 'in-progress': 'In Progress', review: 'Review', done: 'Done' }[id],
    flags: { sleeping: id === 'backlog', pickup: id === 'ready' }, itemIds: [],
  }));
  const board = { columns, items: {}, requests: [], focusBoards: [], activeFocus: null, master: null, ...extra };
  for (const it of items) {
    const full = { title: it.id, priority: 'Medium', type: 'task', comments: [], questions: [], workedBy: [], updatedAt: iso(-60 * MIN), enteredColumnAt: iso(-60 * MIN), ...it };
    board.items[full.id] = full;
    columns.find((c) => c.id === full.columnId).itemIds.push(full.id);
  }
  return { id: 'main', board };
}
// team: { name: { role?, grants?, pickup?, supervise?, helper?, status?, running?, reviewer? } }
function makeWorld(ctx, team = {}) {
  const recipients = createRecipients({ now: () => NOW, isRunning: (n) => !!team[n]?.running });
  const oks = createOks({ verdictStands: (item, r) => !!r.verified, now: () => NOW });
  return createWork({
    now: () => NOW, boards: () => [ctx], leaseWarningMinutes: () => 5, recipients, oks,
    agents: {
      get: (n) => { if (!team[n]) throw new Error('not standing'); return { status: team[n].status || 'idle', queued: 0, lastRun: team[n].lastRun || null }; },
      isRunning: (n) => !!team[n]?.running, superviseOf: (n) => (team[n]?.supervise ? 30 : 0), pickupOf: (n) => team[n]?.pickup || false,
      grantsOf: (n) => (team[n]?.grants || []).map((power) => ({ power })), isHelper: (n) => !!team[n]?.helper,
      reviewerPool: () => Object.entries(team).filter(([, a]) => a.reviewer).map(([name]) => ({ name, areas: [] })),
    },
    isCoordinator: (c, n) => team[n]?.role === 'coordinator', approvalsOff: () => false, commitsPending: () => false,
  });
}
const actions = (w) => w.next.map((n) => `${n.action}:${n.id || n.requestId}`);

describe('workFor: an agent\'s next actions', () => {
  it('an assigned ticket is "start", unless it sits in a sleeping column', () => {
    const ctx = makeBoard([{ id: 'A', columnId: 'ready', assignee: 'groot' }, { id: 'B', columnId: 'backlog', assignee: 'groot' }]);
    assert.deepEqual(actions(makeWorld(ctx, { groot: {} }).workFor(ctx, 'groot')), ['start:A']);
  });
  it('a blocked assigned ticket is listed after the others and says what it waits on', () => {
    const ctx = makeBoard([{ id: 'X', columnId: 'ready' }, { id: 'A', columnId: 'ready', assignee: 'groot', blockedBy: ['X'] }, { id: 'B', columnId: 'ready', assignee: 'groot' }]);
    const w = makeWorld(ctx, { groot: {} }).workFor(ctx, 'groot');
    assert.deepEqual(actions(w), ['start:B', 'start:A']);
    assert.match(w.next[1].why, /blocked by X/);
  });
  it('with nothing assigned, a builder is offered Ready work; a coordinator and a helper never are', () => {
    const ctx = makeBoard([{ id: 'A', columnId: 'ready', priority: 'Low' }, { id: 'B', columnId: 'ready', priority: 'High' }]);
    const world = makeWorld(ctx, { groot: {}, gamora: { role: 'coordinator' }, wong: { helper: true } });
    assert.deepEqual(actions(world.workFor(ctx, 'groot')), ['start:B', 'start:A'], 'by priority');
    assert.deepEqual(actions(world.workFor(ctx, 'gamora')), []);
    assert.deepEqual(actions(world.workFor(ctx, 'wong')), []);
  });
  it('a reviewer with no verdict yet gets review_ticket; with one it gets nothing', () => {
    const ctx = makeBoard([{ id: 'A', columnId: 'review', reviewers: [{ name: 'nebula', verdict: null }] }, { id: 'B', columnId: 'review', reviewers: [{ name: 'nebula', verdict: 'ok' }] }]);
    assert.deepEqual(actions(makeWorld(ctx, { nebula: { reviewer: true } }).workFor(ctx, 'nebula')), ['review_ticket:A']);
  });
  it('a decider gets chase while a reviewer is missing, decide once everything is in', () => {
    const review = { kind: 'review', raisedBy: 'groot', id: 'q1', notes: { evidence: 'tests pass' } };
    const ctx = makeBoard([
      { id: 'A', columnId: 'review', questions: [review], workedBy: ['groot'] },
      { id: 'B', columnId: 'review', questions: [review], workedBy: ['groot'], reviewers: [{ name: 'nebula', verdict: 'ok', verified: true }] },
    ]);
    const w = makeWorld(ctx, { stakar: { grants: ['review.decide'] }, nebula: { reviewer: true } }).workFor(ctx, 'stakar');
    assert.deepEqual(actions(w), ['chase:A', 'decide:B']);
    assert.match(w.next[0].why, /a reviewer \(no reviewer yet/);
  });
  it('a master lease held by someone else empties everyone else\'s next', () => {
    const ctx = makeBoard([{ id: 'A', columnId: 'ready', assignee: 'groot' }], { master: { holder: 'rocket' } });
    const world = makeWorld(ctx, { groot: {}, rocket: {} });
    assert.deepEqual(actions(world.workFor(ctx, 'groot')), []);
    assert.match(world.workFor(ctx, 'groot').note, /rocket holds the whole board/);
  });
  it('a focus board holds back work outside it, but lets an explain through', () => {
    const ctx = makeBoard([
      { id: 'A', columnId: 'ready', assignee: 'groot' }, { id: 'B', columnId: 'ready', assignee: 'groot' },
      { id: 'C', columnId: 'review', comments: [{ id: 'c1', intent: 'explain', body: '@groot why?', author: { kind: 'user', name: 'James' }, createdAt: iso(-MIN) }] },
    ], { focusBoards: [{ id: 'f1', name: 'Today', itemIds: ['A'] }], activeFocus: 'f1' });
    const w = makeWorld(ctx, { groot: {} }).workFor(ctx, 'groot');
    assert.deepEqual(actions(w), ['explain:C', 'start:A']);
    assert.match(w.focus.note, /held back: B/);
  });
});

describe('pendingWork: what wakes an agent, under which key', () => {
  it('start is offered only to a builder holding no lease; the key carries when it was last freed', () => {
    const ctx = makeBoard([{ id: 'A', columnId: 'ready', assignee: 'groot' }]);
    const world = makeWorld(ctx, { groot: {} });
    assert.deepEqual(world.pendingWork('groot').map((w) => w.key), ['main:start:A:0']);
    ctx.board.items.B = { id: 'B', columnId: 'in-progress', comments: [], questions: [], lease: { claimant: 'groot', expiresAt: iso(30 * MIN), leasedAt: iso(-MIN) } };
    ctx.board.columns[2].itemIds.push('B');
    assert.deepEqual(world.pendingWork('groot'), [], 'busy: its queue waits');
  });
  it('replies owed, renewals and leases held never wake (listed only)', () => {
    const ctx = makeBoard([{ id: 'B', columnId: 'in-progress', lease: { claimant: 'groot', expiresAt: iso(2 * MIN), leasedAt: iso(-MIN) } }]);
    assert.deepEqual(makeWorld(ctx, { groot: {} }).pendingWork('groot'), []);
  });
  it('pickup: "ready" offers unassigned Ready tickets as pickup, "all" offers every open one as triage', () => {
    const ctx = makeBoard([{ id: 'A', columnId: 'ready' }, { id: 'B', columnId: 'backlog' }]);
    const world = makeWorld(ctx, { groot: {}, gamora: { role: 'coordinator' } });
    assert.deepEqual(world.pendingWork('groot', 'ready').map((w) => `${w.action}:${w.id}`), ['pickup:A']);
    assert.deepEqual(world.pendingWork('gamora', 'all').map((w) => `${w.action}:${w.id}`).sort(), ['triage:A', 'triage:B']);
  });
  it('a chase key changes with the kind of gap, not its wording', () => {
    const review = { kind: 'review', raisedBy: 'groot', id: 'q1', notes: { evidence: 'tests pass' } };
    const ctx = makeBoard([{ id: 'A', columnId: 'review', questions: [review], workedBy: ['groot'] }]);
    const world = makeWorld(ctx, { stakar: { grants: ['review.decide'] }, nebula: { reviewer: true } });
    const before = world.pendingWork('stakar')[0].key;
    assert.equal(world.pendingWork('stakar')[0].key, before, 'stable while nothing changes');
    ctx.board.items.A.reviewers = [{ name: 'nebula', verdict: null, at: iso(-2 * 3600_000) }];
    assert.notEqual(world.pendingWork('stakar')[0].key, before, 'a reviewer assigned: a new gap, a new key');
  });
});

describe('waitingWork and stalledFor', () => {
  it('waitingWork lists startable Ready tickets: not leased, blocked or waiting on the human', () => {
    const ctx = makeBoard([
      { id: 'A', columnId: 'ready' }, { id: 'B', columnId: 'ready', blockedBy: ['A'] },
      { id: 'C', columnId: 'ready', questions: [{ kind: 'question', raisedBy: 'groot' }] }, { id: 'D', columnId: 'backlog' },
    ]);
    assert.deepEqual(makeWorld(ctx).waitingWork().map((w) => w.id), ['A']);
  });
  it('a supervisor hears of an idle agent\'s untouched ticket, and of a paused agent\'s at once', () => {
    const ctx = makeBoard([{ id: 'A', columnId: 'ready', assignee: 'groot' }, { id: 'B', columnId: 'ready', assignee: 'rocket', updatedAt: iso(-MIN), enteredColumnAt: iso(-MIN) }]);
    const world = makeWorld(ctx, { gamora: { role: 'coordinator', supervise: true }, groot: {}, rocket: { status: 'paused' } });
    assert.deepEqual(world.stalledFor(ctx, 'gamora', 30).map((x) => `${x.it.id}:${x.who}:${x.status}`), ['A:groot:idle', 'B:rocket:paused']);
  });
});
