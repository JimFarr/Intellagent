// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// A board change an agent makes on the human's behalf (an admin.* grant) is kept in that agent's history with the
// setting before and after, and the human can put it back (INT-353).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, USER } = require('./helpers');

const B = '/api/boards/main';

describe('delegated admin changes in the agent history (INT-353)', () => {
  let s;
  before(async () => {
    s = await startServer({ agents: { agents: {
      ann: { enabled: false, grants: ['admin'] },
      bob: { enabled: false },
    } } });
  });
  after(() => s.stop());
  const history = async (name) => (await s.api('GET', `/api/agents/${name}`, undefined, USER)).body.changes || [];
  const last = async (name) => (await history(name)).at(-1);

  it('a delegated change keeps its before and after on the agent, with the board and power', async () => {
    const was = (await s.api('GET', `${B}/directives`, undefined, USER)).body.directives;
    const r = await s.api('PUT', `${B}/directives`, { directives: 'Be kind.' }, { agent: 'ann' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = await last('ann');
    assert.equal(c.by.name, 'ann');
    assert.deepEqual(c.admin, { board: 'main', power: 'admin.rules', text: 'Changed the board rules' });
    assert.deepEqual(c.changes.directives, { from: was, to: 'Be kind.' });
  });

  it('the human\'s own change and a change that changes nothing leave no entry', async () => {
    await s.api('PUT', `${B}/rebalance`, { on: false }, { agent: 'ann' });
    const n = (await history('ann')).length;
    await s.api('PUT', `${B}/directives`, { directives: 'By the human.' }, USER);
    await s.api('PUT', `${B}/rebalance`, { on: false }, { agent: 'ann' }); // already off: nothing changes
    assert.equal((await history('ann')).length, n);
  });

  it('revert puts the setting back, emits its own event and cannot be done twice', async () => {
    await s.api('PUT', `${B}/directives`, { directives: 'Before.' }, USER);
    await s.api('PUT', `${B}/directives`, { directives: 'After.' }, { agent: 'ann' });
    const c = await last('ann');
    const r = await s.api('POST', `/api/agents/ann/changes/${c.id}/revert`, {}, USER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reverted, true);
    assert.equal((await s.api('GET', `${B}/directives`, undefined, USER)).body.directives, 'Before.');
    const ev = await s.api('GET', '/api/events?types=admin.reverted&tail=true', undefined, USER);
    assert.equal(ev.body.events.at(-1).change, c.id);
    assert.ok((await last('ann')).reverted, 'the entry says it was reverted');
    const again = await s.api('POST', `/api/agents/ann/changes/${c.id}/revert`, {}, USER);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'CONFLICT');
  });

  it('a stale revert is refused with 409 CONFLICT and a hint, and changes nothing', async () => {
    await s.api('PUT', `${B}/directives`, { directives: 'First.' }, { agent: 'ann' });
    const c = await last('ann');
    await s.api('PUT', `${B}/directives`, { directives: 'Then the human.' }, USER);
    const r = await s.api('POST', `/api/agents/ann/changes/${c.id}/revert`, {}, USER);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'CONFLICT');
    assert.ok(r.body.hint);
    assert.equal((await s.api('GET', `${B}/directives`, undefined, USER)).body.directives, 'Then the human.');
    assert.ok(!(await last('ann')).reverted);
  });

  it('column changes revert as a whole, and a column that tickets moved into stays', async () => {
    const before = (await s.api('GET', `${B}/columns`, undefined, USER)).body.map((x) => x.name);
    await s.api('POST', `${B}/columns`, { name: 'QA', position: 1 }, { agent: 'ann' });
    const c = await last('ann');
    assert.equal(c.admin.power, 'admin.columns');
    // a ticket in the new column blocks the revert
    const t = await s.api('POST', `${B}/items`, { title: 'in qa', column: 'Backlog' }, USER);
    assert.equal(t.status, 201, JSON.stringify(t.body));
    assert.equal((await s.api('POST', `${B}/items/${t.body.id}/move`, { column: 'QA' }, USER)).status, 200);
    const blocked = await s.api('POST', `/api/agents/ann/changes/${c.id}/revert`, {}, USER);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'CONFLICT');
    assert.ok((await s.api('GET', `${B}/columns`, undefined, USER)).body.some((x) => x.name === 'QA'), 'rolled back');
    await s.api('POST', `${B}/items/${t.body.id}/move`, { column: 'Backlog' }, USER);
    // moving a ticket changes no column, so the stale check passes now
    const ok = await s.api('POST', `/api/agents/ann/changes/${c.id}/revert`, {}, USER);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual((await s.api('GET', `${B}/columns`, undefined, USER)).body.map((x) => x.name), before);
  });

  it('only the human reverts; an agent manager\'s change and an unknown id are told apart', async () => {
    await s.api('PUT', `${B}/directives`, { directives: 'Mine.' }, { agent: 'ann' });
    const c = await last('ann');
    const asAgent = await s.api('POST', `/api/agents/ann/changes/${c.id}/revert`, {}, { agent: 'ann' });
    assert.equal(asAgent.status, 403);
    assert.equal(asAgent.body.code, 'HUMAN_ONLY');
    const none = await s.api('POST', '/api/agents/ann/changes/chg_nope/revert', {}, USER);
    assert.equal(none.status, 404);
    await s.api('PATCH', '/api/agents/bob', { description: 'builds' }, USER);
    const m = await last('bob');
    const notAdmin = await s.api('POST', `/api/agents/bob/changes/${m.id}/revert`, {}, USER);
    assert.equal(notAdmin.status, 400);
    assert.equal(notAdmin.body.code, 'BAD_REQUEST');
  });
});
