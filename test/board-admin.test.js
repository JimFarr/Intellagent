// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Board admin (INT-256): the human-only board settings, each its own grantable power (admin.columns,
// admin.rules, admin.coordinator, admin.fields, admin.focus, admin.cardRules, admin.rebalancing), "admin" for
// all of them at once, the human's "admin off" switch, and the trail each delegated change leaves.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, USER } = require('./helpers');

const B = '/api/boards/main';

// Each power, and one call that needs it.
const CALLS = {
  'admin.rules': ['PUT', `${B}/directives`, { directives: 'Be kind.' }],
  'admin.coordinator': ['PATCH', B, { coordinator: 'bob' }],
  'admin.fields': ['PUT', `${B}/schema`, { builtins: { priority: { ui: 'read' } } }],
  'admin.cardRules': ['PUT', `${B}/card-rules`, { rules: [{ name: 'approved', condition: 'review.allOk', look: { outline: 'ok' } }] }],
  'admin.rebalancing': ['PUT', `${B}/rebalance`, { on: false }],
  'admin.columns': ['POST', `${B}/columns`, { name: 'QA', position: 1 }],
  'admin.focus': ['POST', `${B}/focus`, { name: 'Today', itemIds: [], activate: false }],
};

describe('board admin powers (INT-256)', () => {
  let s;
  before(async () => {
    s = await startServer({ agents: { agents: {
      ...Object.fromEntries(Object.keys(CALLS).map((p) => [p.replace('admin.', 'has-').toLowerCase(), { enabled: false, grants: [p] }])),
      bob: { enabled: false },
      ann: { enabled: false, grants: ['admin'] },
      ready: { enabled: false, grants: [{ power: 'admin.columns', where: { column: 'Ready' } }] },
      other: { enabled: false, grants: [{ power: 'admin.rules', where: { board: 'elsewhere' } }] },
    } } });
  });
  after(() => s.stop());
  const holder = (p) => ({ agent: p.replace('admin.', 'has-').toLowerCase() });

  it('each one works for the agent that holds it and is refused to one without it', async () => {
    for (const [power, [m, path, body]] of Object.entries(CALLS)) {
      const no = await s.api(m, path, body, { agent: 'bob' });
      assert.equal(no.status, 403, `${power} without the grant`);
      assert.equal(no.body.code, 'HUMAN_ONLY', power);
      assert.match(no.body.hint, new RegExp(power.replace('.', '\\.')), `${power}: the hint names the power`);
      const yes = await s.api(m, path, body, holder(power));
      assert.ok(yes.status < 300, `${power} with the grant: ${yes.status} ${JSON.stringify(yes.body)}`);
    }
  });

  it('one power never opens another', async () => {
    const r = await s.api('PUT', `${B}/directives`, { directives: 'Mine now.' }, { agent: 'has-columns' });
    assert.equal(r.body.code, 'HUMAN_ONLY');
    const c = await s.api('PATCH', `${B}/columns/Ready`, { flags: { wipLimit: 4 } }, { agent: 'has-rules' });
    assert.equal(c.body.code, 'HUMAN_ONLY');
  });

  it('the scope narrows: a column scope reaches that column only, a board scope that board only', async () => {
    assert.equal((await s.api('PATCH', `${B}/columns/Ready`, { flags: { wipLimit: 6 } }, { agent: 'ready' })).status, 200);
    assert.equal((await s.api('PATCH', `${B}/columns/Backlog`, { flags: { wipLimit: 6 } }, { agent: 'ready' })).body.code, 'OUT_OF_SCOPE');
    // adding a column names no column, so a column scope never covers it
    assert.equal((await s.api('POST', `${B}/columns`, { name: 'Elsewhere' }, { agent: 'ready' })).body.code, 'OUT_OF_SCOPE');
    assert.equal((await s.api('PUT', `${B}/directives`, { directives: 'x' }, { agent: 'other' })).body.code, 'OUT_OF_SCOPE');
  });

  it('Can edit columns adds a human-only gate but never lifts one, nor deletes a gated column', async () => {
    const lift = await s.api('PATCH', `${B}/columns/Done`, { flags: { humanOnlyIn: false } }, { agent: 'has-columns' });
    assert.equal(lift.status, 403);
    assert.equal(lift.body.code, 'HUMAN_ONLY');
    assert.equal((await s.ok('GET', `${B}/columns`)).find((c) => c.name === 'Done').flags.humanOnlyIn, true, 'the gate is still there');
    assert.equal((await s.api('PATCH', `${B}/columns/Review`, { flags: { humanOnlyOut: true } }, { agent: 'has-columns' })).status, 200);
    assert.equal((await s.api('PATCH', `${B}/columns/Review`, { flags: { humanOnlyOut: false } }, { agent: 'ann' })).body.code, 'HUMAN_ONLY', 'not even with admin');
    await s.ok('PATCH', `${B}/columns/Review`, { flags: { humanOnlyOut: false } }, USER);
    await s.ok('POST', `${B}/columns`, { name: 'Gated', flags: { humanOnlyIn: true } }, USER);
    assert.equal((await s.api('DELETE', `${B}/columns/Gated`, undefined, { agent: 'has-columns' })).body.code, 'HUMAN_ONLY');
    await s.ok('DELETE', `${B}/columns/Gated`, undefined, USER);
  });

  it('Can edit columns never changes which column is final (the done column)', async () => {
    const names = async () => (await s.ok('GET', `${B}/columns`)).map((c) => c.name);
    const was = await names();
    assert.equal(was.at(-1), 'Done');
    const refused = async (m, path, body, why) => {
      const r = await s.api(m, path, body, { agent: 'has-columns' });
      assert.equal(r.status, 403, why);
      assert.equal(r.body.code, 'HUMAN_ONLY', why);
      assert.match(r.body.hint, /final column is the done column/, why);
      assert.deepEqual(await names(), was, `${why}: nothing changed`);
    };
    await refused('POST', `${B}/columns`, { name: 'Shipped' }, 'adding at the end');
    await refused('POST', `${B}/columns`, { name: 'Shipped', position: 'bottom' }, 'adding at the bottom');
    await refused('PATCH', `${B}/columns/Done`, { position: 0 }, 'moving Done away from the end');
    await refused('PATCH', `${B}/columns/Backlog`, { position: 'bottom' }, 'moving another column after Done');
    // an ungated last column can't be deleted either: the one before it would become done
    await s.ok('PATCH', `${B}/columns/Done`, { flags: { humanOnlyIn: false } }, USER);
    await refused('DELETE', `${B}/columns/Done`, undefined, 'deleting the last column');
    await s.ok('PATCH', `${B}/columns/Done`, { flags: { humanOnlyIn: true } }, USER);
    // a move that leaves Done last is fine
    assert.equal((await s.api('PATCH', `${B}/columns/QA`, { position: 0 }, { agent: 'has-columns' })).status, 200);
    assert.equal((await names()).at(-1), 'Done');
    // the human may
    await s.ok('POST', `${B}/columns`, { name: 'Shipped' }, USER);
    const { seq } = await s.ok('GET', '/api/app');
    const { deleted } = await s.ok('DELETE', `${B}/columns/Shipped`, undefined, USER);
    const [ev] = (await s.ok('GET', `/api/events?since=${seq}&types=column.deleted`)).events;
    assert.equal(ev.columnId, deleted, 'columnId kept for older readers');
    assert.deepEqual(ev.column, { id: deleted, name: 'Shipped' }, 'the name, taken before the delete');
  });

  it('Can choose the coordinator never chooses itself', async () => {
    const r = await s.api('PATCH', B, { coordinator: 'has-coordinator' }, { agent: 'has-coordinator' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'OWN_WORK');
  });

  it('admin is every power at once, each checked on its own', async () => {
    const me = await s.ok('GET', '/api/permissions/me', undefined, { agent: 'ann' });
    const powers = me.grants.map((g) => g.power);
    for (const p of [...Object.keys(CALLS), 'review.decide', 'column.gate', 'work.land']) assert.ok(powers.includes(p), p);
    assert.ok(!powers.includes('admin.permissions'), 'admin covers a frozen list: Can edit permissions is granted by name only (INT-349)');
    assert.equal((await s.api('PUT', `${B}/directives`, { directives: 'By ann.' }, { agent: 'ann' })).status, 200);
    // and the library lists it with the Board admin group
    const lib = (await s.ok('GET', '/api/permissions')).permissions;
    assert.deepEqual(lib.filter((e) => e.group === 'Board admin').map((e) => e.key).sort(), [...Object.keys(CALLS), 'admin', 'admin.permissions'].sort());
  });

  it('every delegated change says so on its event, in the digest and in the metrics; the human\'s say nothing', async () => {
    const { seq } = await s.ok('GET', '/api/app');
    await s.ok('PUT', `${B}/directives`, { directives: 'Tagged.' }, { agent: 'has-rules' });
    await s.ok('PUT', `${B}/directives`, { directives: 'By the human.' }, USER);
    const evs = (await s.ok('GET', `/api/events?since=${seq}&types=board.updated`)).events;
    assert.equal(evs.length, 2);
    assert.deepEqual(evs[0].delegated, { power: 'admin.rules', onBehalfOf: 'human' });
    assert.equal(evs[1].delegated, undefined);
    const digest = (await s.ok('GET', `/api/events?since=${seq}&types=digest.added`)).events;
    assert.equal(digest.length, 1, 'one digest line, for the agent\'s change only');
    assert.match(digest[0].entry.summary, /board rules \(admin\.rules, on the human's behalf\)/);
    const m = await s.ok('GET', `${B}/metrics?days=7`);
    assert.ok(m.delegated.admin >= 1);
    assert.equal(m.delegated.moves, 0, 'admin changes are not counted as moves');
  });
});

describe('delegated metrics (INT-256)', () => {
  it('every delegated event counts once: reviews, moves, admin, and anything else under other', () => {
    const { createMetrics } = require('../lib/metrics');
    const ts = new Date().toISOString();
    const ev = (type, power, name) => ({ board: 'main', ts, type, actor: { kind: 'agent', name }, delegated: { power, onBehalfOf: 'human' } });
    const recent = [ev('review.approved', 'review.decide', 'a'), ev('item.moved', 'column.gate', 'a'), ev('board.updated', 'admin.rules', 'b'),
      ev('agent.paused', 'agents.control', 'b'), { board: 'main', ts, type: 'item.moved', actor: { kind: 'agent', name: 'c' } }];
    const metrics = createMetrics({ doneColumnId: () => 'done', workingColumn: () => null, recent });
    const ctx = { id: 'main', board: { columns: [{ id: 'done', name: 'Done', itemIds: [] }], items: {} }, archive: { items: {} } };
    const d = metrics(ctx, 7).delegated;
    assert.deepEqual([d.reviews, d.moves, d.admin, d.other], [1, 1, 1, 1]);
    assert.deepEqual(d.byAgent, { a: { reviews: 1, moves: 1, admin: 0, other: 0 }, b: { reviews: 0, moves: 0, admin: 1, other: 1 } });
  });
});

describe("the human's switch for board admin (INT-256)", () => {
  it('lists who holds admin powers; off suspends them all until the human switches it back on', async () => {
    const s = await startServer({ agents: { agents: { cy: { enabled: false, grants: ['admin.rules', 'review.decide'] }, dee: { enabled: false } } } });
    try {
      const v = await s.ok('GET', `${B}/admin`);
      assert.equal(v.on, true);
      assert.deepEqual(v.holders.map((h) => [h.name, h.grants.map((g) => g.power)]), [['cy', ['admin.rules']]]);
      assert.equal((await s.api('PUT', `${B}/admin`, { on: false }, { agent: 'cy' })).body.code, 'HUMAN_ONLY', 'agents never flip it');
      assert.equal((await s.api('PUT', `${B}/admin`, { on: 'no' }, USER)).body.code, 'BAD_REQUEST', 'a malformed switch is refused, never read as off');
      assert.equal((await s.ok('PUT', `${B}/admin`, { on: false }, USER)).on, false);
      const r = await s.api('PUT', `${B}/directives`, { directives: 'x' }, { agent: 'cy' });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'ADMIN_OFF');
      const brief = (await s.api('GET', `${B}/brief`, undefined, { agent: 'cy' })).body;
      assert.match(typeof brief === 'string' ? brief : brief.markdown, /Board admin is switched off/);
      // the approvals switch is separate: admin off leaves review.decide alone
      assert.equal((await s.ok('GET', `${B}/approvals`)).on, true);
      await s.ok('PUT', `${B}/admin`, { on: true }, USER);
      assert.equal((await s.api('PUT', `${B}/directives`, { directives: 'x' }, { agent: 'cy' })).status, 200);
    } finally { await s.stop(); }
  });
});
