// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Helper agents (INT-252): "helper": true in agents.json. The builders call on a helper with a request for a chore
// (call-helpers); nobody but the human assigns it a ticket, and on a ticket it wasn't given it never takes the
// lease, starts or requests review.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, USER } = require('./helpers');

const B = '/api/boards/main';

describe('helper agents (INT-252)', () => {
  let s;
  let ticket;
  before(async () => {
    s = await startServer({ agents: { agents: {
      cosmo: { enabled: false, role: 'builder', helper: true },
      busy: { enabled: false, role: 'builder', helper: true, maxRunsPerHour: 12 },
      bob: { enabled: false, role: 'builder' },
      rev: { enabled: false, role: 'reviewer' },
      gam: { enabled: false, role: 'coordinator' },
    } } });
    assert.equal((await s.api('PATCH', B, { coordinator: 'gam' }, USER)).status, 200);
    ticket = (await s.api('POST', `${B}/items`, { title: 'Work', column: 'Ready' }, USER)).body.id;
  });
  after(() => s.stop());

  it('an agent may not assign a helper, on a PATCH or a new ticket; the human may', async () => {
    const no = await s.api('PATCH', `${B}/items/${ticket}`, { assignee: 'cosmo' }, { agent: 'gam' });
    assert.equal(no.status, 403);
    assert.equal(no.body.code, 'NOT_ROUTABLE');
    assert.match(no.body.hint, /requests/);
    const made = await s.api('POST', `${B}/items`, { title: 'For cosmo', column: 'Backlog', assignee: 'cosmo' }, { agent: 'bob' });
    assert.equal(made.body.code, 'NOT_ROUTABLE');
    assert.equal((await s.api('PATCH', `${B}/items/${ticket}`, { assignee: 'bob' }, { agent: 'gam' })).status, 200, 'any other agent is still routable');
    const mine = (await s.api('POST', `${B}/items`, { title: 'Chore', column: 'Ready', assignee: 'cosmo' }, USER)).body;
    assert.equal(mine.assignee, 'cosmo');
  });

  it('a request to a helper needs call-helpers; the human always may, a helper never calls a helper', async () => {
    const yes = await s.api('POST', `${B}/requests`, { to: 'cosmo', body: 'run the tests' }, { agent: 'bob' });
    assert.equal(yes.status, 201, JSON.stringify(yes.body));
    for (const agent of ['rev', 'gam']) {
      const no = await s.api('POST', `${B}/requests`, { to: 'cosmo', body: 'take this' }, { agent });
      assert.equal(no.status, 403, agent);
      assert.equal(no.body.code, 'NOT_DELEGABLE', agent);
      assert.match(no.body.hint, /call-helpers/);
    }
    const loop = await s.api('POST', `${B}/requests`, { to: 'busy', body: 'you do it' }, { agent: 'cosmo' });
    assert.equal(loop.body.code, 'NOT_DELEGABLE');
    assert.equal((await s.api('POST', `${B}/requests`, { to: 'cosmo', body: 'hi' }, USER)).status, 201);
    assert.equal((await s.api('POST', `${B}/requests`, { to: 'bob', body: 'hi' }, { agent: 'rev' })).status, 201, 'other agents are unchanged');
  });

  it('on a ticket it was not given, a helper takes no lease, starts nothing and requests no review', async () => {
    assert.equal((await s.api('POST', `${B}/items/${ticket}/lease`, {}, { agent: 'cosmo' })).body.code, 'NOT_ROUTABLE');
    assert.equal((await s.api('POST', `${B}/items/${ticket}/start`, {}, { agent: 'cosmo' })).body.code, 'NOT_ROUTABLE');
    assert.equal((await s.api('POST', `${B}/items/${ticket}/review`, { summary: 'done' }, { agent: 'cosmo' })).body.code, 'NOT_ROUTABLE');
    assert.equal((await s.api('POST', `${B}/items/${ticket}/lease`, {}, { agent: 'bob' })).status, 200);
    assert.equal((await s.api('POST', `${B}/items/${ticket}/lease/request`, { reason: 'mine?' }, { agent: 'cosmo' })).body.code, 'NOT_ROUTABLE');
    assert.equal((await s.api('POST', `${B}/items/${ticket}/lease/handover`, { to: 'cosmo' }, { agent: 'bob' })).body.code, 'NOT_ROUTABLE');
    assert.equal((await s.api('POST', `${B}/items/${ticket}/comments`, { body: 'tests: 12/12' }, { agent: 'cosmo' })).status, 201, 'it still reports on the card');
    // a ticket the human gave it is its own
    const own = (await s.api('POST', `${B}/items`, { title: 'Given', column: 'Ready', assignee: 'cosmo' }, USER)).body.id;
    assert.equal((await s.api('POST', `${B}/items/${own}/start`, {}, { agent: 'cosmo' })).status, 200);
  });

  it('a helper has no pickup and a low cap unless it sets its own; the coordinator is told not to route to it', async () => {
    const list = (await s.api('GET', '/api/agents', undefined, USER)).body.agents;
    const by = Object.fromEntries(list.map((a) => [a.name, a]));
    assert.equal(by.cosmo.helper, true);
    assert.equal(by.bob.helper, false);
    assert.equal(by.cosmo.maxRunsPerHour, 6);
    assert.equal(by.busy.maxRunsPerHour, 12);
    assert.equal(by.cosmo.pickup, false);
    const brief = (await s.api('GET', `${B}/brief`, undefined, { agent: 'gam' })).body;
    const routing = brief.split('## Agents you can route to')[1].split('\n## ')[0];
    assert.match(routing, /\*\*bob\*\*/);
    assert.doesNotMatch(routing, /\*\*cosmo\*\*/);
    assert.match(routing, /Helpers, not for routing: cosmo, busy/);
  });

  it('the library lists call-helpers, and the Builder role holds it', async () => {
    const lib = (await s.api('GET', '/api/permissions', undefined, USER)).body;
    const all = JSON.stringify(lib);
    assert.match(all, /call-helpers/);
    const bob = (await s.api('GET', '/api/permissions/me', undefined, { agent: 'bob' })).body;
    assert.match(JSON.stringify(bob), /call-helpers/);
  });
});
