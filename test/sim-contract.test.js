'use strict';
// The simulator's contract with the board (INT-384): one script, run through lib/sim and through a real board,
// must give the same events, addressed to the same agents and heard by the same ones. Who is woken by an event is
// the board's own code in both (lib/alerts, the agent config, the scheduler); what the simulator writes itself is
// its board actions, and this holds them to the board's routes.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, USER } = require('./helpers');
const { createSim } = require('../lib/sim');

const B = '/api/boards/main';
const TEAM = {
  gamora: { role: 'coordinator', enabled: false },
  groot: { role: 'builder', enabled: false },
  nebula: { role: 'reviewer', enabled: false },
};
// [who ('human' or an agent), action, ...args]; ticket ids are T-1, T-2… in creation order on both
const SCRIPT = [
  ['human', 'create', { title: 'first', column: 'Ready', assignee: 'groot' }],
  ['human', 'comment', 'T-1', '@groot please look, and `@nebula` is only quoted'],
  ['groot', 'start', 'T-1'],
  ['groot', 'comment', 'T-1', 'On it. @gamora fyi'],
  ['groot', 'ask', 'T-1', 'Which endpoint?'],
  ['groot', 'ask', 'T-1', 'Which endpoint?'], // the same question again is reused, raising nothing (INT-420)
  ['human', 'answer', 'T-1', 'The v2 one'],
  ['groot', 'review', 'T-1', { summary: 'done', evidence: 'tests pass' }],
  ['human', 'addReviewer', 'T-1', 'nebula'],
  ['nebula', 'verdict', 'T-1', 'concerns', 'No test for the error path.'],
  ['groot', 'start', 'T-1'],
  ['groot', 'review', 'T-1', { summary: 'added the test', evidence: 'tests pass' }],
  ['nebula', 'verdict', 'T-1', 'ok', 'Good now.'],
  ['human', 'create', { title: 'second', column: 'Backlog', blockedBy: ['T-1'], assignee: 'groot' }],
  ['human', 'decide', 'T-1', 'approve', 'Thanks'],
  ['human', 'assign', 'T-2', 'nebula'],
  ['human', 'move', 'T-2', 'Ready'],
  ['human', 'request', 'Plan the next sprint', 'gamora'],
];

function onSim() {
  // a test board is no git checkout: approving finds nothing to land, and says so
  const sim = createSim({ team: TEAM, sweeps: false, landing: 'nothing' });
  try {
    for (const [who, op, ...args] of SCRIPT) {
      const by = who === 'human' ? sim.human : sim.as(who);
      if (op === 'review') by.review(args[0], args[1]);
      else by[op](...args);
    }
    return sim.events;
  } finally { sim.close(); }
}

async function onBoard() {
  const s = await startServer({ agents: { agents: TEAM } });
  try {
    const as = (who) => (who === 'human' ? USER : { agent: who });
    const steps = {
      create: (d) => s.ok('POST', `${B}/items`, d, USER),
      comment: (id, body, who) => s.ok('POST', `${B}/items/${id}/comments`, { body }, as(who)),
      start: (id, who) => s.ok('POST', `${B}/items/${id}/start`, {}, as(who)),
      ask: (id, reason, who) => s.ok('POST', `${B}/items/${id}/attention`, { reason }, as(who)),
      answer: (id, reply) => s.ok('DELETE', `${B}/items/${id}/attention`, { reply }, USER),
      review: (id, d, who) => s.ok('POST', `${B}/items/${id}/review`, d, as(who)),
      addReviewer: (id, name) => s.ok('POST', `${B}/items/${id}/reviewers`, { name }, USER),
      verdict: (id, verdict, comment, who) => s.ok('POST', `${B}/items/${id}/reviewers/${who}/verdict`, { verdict, comment }, as(who)),
      decide: (id, verdict, comment) => s.ok('POST', `${B}/items/${id}/review/decision`, { verdict, comment }, USER),
      assign: (id, assignee) => s.ok('PATCH', `${B}/items/${id}`, { assignee }, USER),
      move: (id, column) => s.ok('POST', `${B}/items/${id}/move`, { column }, USER),
      request: (body, to) => s.ok('POST', `${B}/requests`, { body, to }, USER),
    };
    for (const [who, op, ...args] of SCRIPT) await steps[op](...args, who);
    return (await s.ok('GET', '/api/events?limit=1000')).events;
  } finally { await s.stop(); }
}

// What matters for alerting: the event, its ticket, whom it is for and who hears it. The board's other events
// (presence, agents' own, the digest, housekeeping that reaches nobody) are not the simulator's to make.
const OTHER = /^(presence|agent|agents|board|digest|subscription|memory|app)\./;
const line = (e) => `${e.type} ${e.itemId || e.request?.to || ''} addressed=[${[...(e.addressed || [])].sort()}] heard=[${[...(e.recipients || [])].sort()}]`;
const shape = (events) => events.filter((e) => !OTHER.test(e.type) && (e.recipients || []).length).map(line);

describe('the simulator keeps to the board (contract)', () => {
  it('one script, the same events for the same people, in the same order', async () => {
    const real = shape(await onBoard());
    const simulated = shape(onSim());
    assert.deepEqual(simulated, real);
  });
});
