'use strict';
// Who an event is for (lib/alerts/recipients.js, INT-381): the rules on plain objects, with a fixed clock.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createRecipients, mentionsIn, plainText, QUIET_TYPES } = require('../lib/alerts/recipients');

const NOW = Date.parse('2026-10-19T12:00:00Z');
const iso = (ms) => new Date(NOW + ms).toISOString();
const HOUR = 3600_000;
const human = { kind: 'user', name: 'James' };
const agent = (name) => ({ kind: 'agent', name });
const ctx = (board = {}) => ({ id: 'main', board: { columns: [{ id: 'ready', name: 'Ready' }, { id: 'review', name: 'Review' }], master: null, ...board } });
const ticket = (over = {}) => ({ id: 'INT-1', title: 't', columnId: 'ready', comments: [], workedBy: [], ...over });

describe('mentions', () => {
  it('finds @names in plain text, once each, without trailing punctuation', () => {
    assert.deepEqual(mentionsIn('@rocket take this, @groot. And @rocket again'), ['rocket', 'groot']);
    assert.deepEqual(mentionsIn('(@nebula) and email@example.com'), ['nebula'], 'an @ inside a word is not a mention');
  });
  it('ignores code spans, fenced blocks and > quotes: talking about an agent does not wake it', () => {
    assert.deepEqual(mentionsIn('`@rocket` and\n```\n@groot\n```\n> @drax said\n@mantis'), ['mantis']);
    assert.equal(plainText('> quoted\nplain'), 'plain');
  });
  it('a name without @ is not a mention', () => assert.deepEqual(mentionsIn('Rocket, take this'), []));
});

describe('recipients', () => {
  const { recipientsFor } = createRecipients({ now: () => NOW });
  it('collects leaseholder, asker, agent author, assignee, past workers and thread participants, minus the actor', () => {
    const item = ticket({
      lease: { claimant: 'groot', expiresAt: iso(HOUR) }, needsHuman: { raisedBy: 'drax' }, author: agent('gamora'),
      assignee: 'rocket', workedBy: ['nebula'], comments: [{ author: agent('mantis') }, { author: { kind: 'system', name: 'intellagent' } }, { author: human }],
    });
    assert.deepEqual(recipientsFor(item, agent('rocket')).sort(), ['James', 'drax', 'gamora', 'groot', 'mantis', 'nebula']);
  });
  it('an expired lease no longer counts', () => {
    assert.deepEqual(recipientsFor(ticket({ lease: { claimant: 'groot', expiresAt: iso(-1) } }), human), []);
  });
  it('a human author is not a recipient; the board\'s own notes add nobody', () => {
    assert.deepEqual(recipientsFor(ticket({ author: human, comments: [{ author: { kind: 'system', name: 'intellagent' } }] }), agent('x')), []);
  });
});

describe('itemEvent: who hears and who is woken', () => {
  const { itemEvent } = createRecipients({ now: () => NOW });
  it('addressed is the mentions minus the actor, and a subset of recipients', () => {
    const e = itemEvent(ctx(), 'comment.added', ticket({ assignee: 'rocket' }), agent('groot'), { mentions: ['drax', 'groot'] });
    assert.deepEqual(e.addressed, ['drax']);
    assert.ok(e.addressed.every((n) => e.recipients.includes(n)));
    assert.ok(e.recipients.includes('rocket') && !e.recipients.includes('groot'));
  });
  it('no mentions: heard by the recipients, woken nobody (no addressed key)', () => {
    const e = itemEvent(ctx(), 'item.moved', ticket({ assignee: 'rocket' }), human);
    assert.deepEqual(e.recipients, ['rocket']);
    assert.equal(e.addressed, undefined);
  });
  it('an approval is news, not a task: nobody is addressed', () => {
    assert.equal(itemEvent(ctx(), 'review.approved', ticket(), human, { mentions: ['rocket'] }).addressed, undefined);
    assert.equal(itemEvent(ctx(), 'attention.resolved', ticket(), human, { mentions: ['rocket'], verdict: 'approve' }).addressed, undefined);
    assert.deepEqual(itemEvent(ctx(), 'attention.resolved', ticket(), human, { mentions: ['rocket'], verdict: 'changes' }).addressed, ['rocket']);
  });
  it('housekeeping events reach nobody', () => {
    for (const type of QUIET_TYPES) {
      const e = itemEvent(ctx(), type, ticket({ assignee: 'rocket' }), human, { mentions: ['rocket'] });
      assert.deepEqual(e.recipients, [], type);
      assert.equal(e.addressed, undefined, type);
    }
  });
  it('the master-lease holder hears about every ticket while the lease stands, and not after', () => {
    const held = ctx({ master: { holder: 'stakar', expiresAt: iso(HOUR) } });
    assert.ok(itemEvent(held, 'item.moved', ticket(), human).recipients.includes('stakar'));
    assert.ok(!itemEvent(ctx({ master: { holder: 'stakar', expiresAt: iso(-1) } }), 'item.moved', ticket(), human).recipients.includes('stakar'));
    assert.ok(itemEvent(ctx({ master: { holder: 'stakar' } }), 'item.moved', ticket(), human).recipients.includes('stakar'), 'open-ended');
  });
  it('the snapshot names the column and the live claimant', () => {
    const e = itemEvent(ctx(), 'item.moved', ticket({ lease: { claimant: 'groot', expiresAt: iso(HOUR) } }), human);
    assert.equal(e.item.column, 'Ready');
    assert.equal(e.item.claimant, 'groot');
  });
});

describe('explain targets', () => {
  const { explainTargets } = createRecipients({ now: () => NOW });
  it('mentions first, then the agent replied to, the review asker, the last worker, the assignee', () => {
    const base = ticket({ assignee: 'zed', workedBy: ['old', 'last'], questions: [{ kind: 'review', raisedBy: 'asker' }], comments: [{ id: 'c1', author: agent('author1') }] });
    assert.deepEqual(explainTargets(base, { body: 'why? @drax' }), ['drax']);
    assert.deepEqual(explainTargets(base, { body: 'why?', replyTo: 'c1' }), ['author1']);
    assert.deepEqual(explainTargets(base, { body: 'why?' }), ['asker']);
    assert.deepEqual(explainTargets({ ...base, questions: [] }, { body: 'why?' }), ['last']);
    assert.deepEqual(explainTargets({ ...base, questions: [], workedBy: [] }, { body: 'why?' }), ['zed']);
    assert.deepEqual(explainTargets(ticket(), { body: 'why?' }), []);
  });
});

describe('seen, not answered (INT-343)', () => {
  const comment = (over = {}) => ({ id: 'c1', author: human, body: '@rocket please', createdAt: iso(-HOUR), reactions: { '👀': ['rocket'] }, ...over });
  it('a mention the agent saw (👀) and did not answer is listed', () => {
    const { unansweredIn } = createRecipients({ now: () => NOW });
    assert.deepEqual(unansweredIn(ticket({ comments: [comment()] })), [{ commentId: 'c1', agent: 'rocket', by: 'James', since: iso(-HOUR) }]);
  });
  it('clears when it comments later or reacts with anything but 👀/⏳; never while it runs, nor after 3 days', () => {
    const { unansweredIn } = createRecipients({ now: () => NOW });
    assert.deepEqual(unansweredIn(ticket({ comments: [comment(), { author: agent('rocket'), createdAt: iso(-1000) }] })), []);
    assert.deepEqual(unansweredIn(ticket({ comments: [comment({ reactions: { '👀': ['rocket'], '✅': ['rocket'] } })] })), []);
    assert.equal(unansweredIn(ticket({ comments: [comment({ reactions: { '👀': ['rocket'], '⏳': ['rocket'] } })] })).length, 1, '⏳ is not an answer');
    assert.deepEqual(createRecipients({ now: () => NOW, isRunning: () => true }).unansweredIn(ticket({ comments: [comment()] })), []);
    assert.deepEqual(unansweredIn(ticket({ comments: [comment({ createdAt: iso(-4 * 24 * HOUR) })] })), []);
  });
  it('not listed: no 👀 yet (still queued), an explain, or a 👀 from someone it did not mention', () => {
    const { unansweredIn } = createRecipients({ now: () => NOW });
    assert.deepEqual(unansweredIn(ticket({ comments: [comment({ reactions: {} })] })), []);
    assert.deepEqual(unansweredIn(ticket({ comments: [comment({ intent: 'explain' })] })), []);
    assert.deepEqual(unansweredIn(ticket({ comments: [comment({ reactions: { '👀': ['groot'] } })] })), []);
  });
});
