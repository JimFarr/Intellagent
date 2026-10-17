// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// One permission table for the routes (INT-144): every write route declares who may call it, whether a read-only
// agent may still call it, and whether it is allowed while another agent holds the board. The dispatcher reads
// the table; a route missing from it stops the board at start.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, USER } = require('./helpers');

const B = '/api/boards/main';

describe('the route policy table (INT-144)', () => {
  let s;
  let ticket;
  before(async () => {
    s = await startServer({ manifest: { permissions: { ro: { readOnly: true } } } });
    ticket = (await s.api('POST', `${B}/items`, { title: 'Work', column: 'Ready' }, USER)).body.id;
  });
  after(() => s.stop());

  it('lists a policy for every write route, and nothing else', async () => {
    const idx = (await s.api('GET', '/api?policies=true')).body;
    const writes = idx.endpoints.map((e) => e.split(' — ')[0].trim().split(/\s+/)).filter(([m]) => m !== 'GET');
    const listed = new Set(idx.policies.map((x) => `${x.method} ${x.pattern}`));
    for (const [m, p] of writes) assert.ok(listed.has(`${m} ${p}`), `${m} ${p} has no policy`);
    for (const x of idx.policies) assert.ok(x.who, `${x.method} ${x.pattern} says nobody`);
    assert.equal((await s.api('GET', '/api')).body.policies, undefined, 'only when asked');
  });

  it('a read-only agent may talk on a ticket and nothing else', async () => {
    assert.equal((await s.api('POST', `${B}/items/${ticket}/comments`, { body: 'seen' }, { agent: 'ro' })).status, 201);
    const asked = await s.api('POST', `${B}/items/${ticket}/attention`, { reason: 'which one?' }, { agent: 'ro' });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    for (const [method, path, body] of [['PATCH', `${B}/items/${ticket}`, { priority: 'High' }], ['POST', `${B}/items/${ticket}/lease`, {}], ['POST', `${B}/items/${ticket}/reactions`, { emoji: 'eyes' }]]) {
      const r = await s.api(method, path, body, { agent: 'ro' });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.match(r.body.error, /read-only/);
    }
  });

  it('while another agent holds the board, only the routes that say so go through', async () => {
    assert.equal((await s.api('POST', `${B}/master`, {}, { agent: 'holder' })).status, 200);
    try {
      assert.equal((await s.api('POST', `${B}/items/${ticket}/comments`, { body: 'hi' }, { agent: 'other' })).status, 201);
      assert.equal((await s.api('POST', `${B}/items/${ticket}/reactions`, { emoji: 'eyes' }, { agent: 'other' })).status, 200);
      assert.equal((await s.api('PATCH', `${B}/items/${ticket}`, { priority: 'Low' }, { agent: 'other' })).body.code, 'BOARD_HELD');
      // the old path regex let any URL with "finish" (or "requests", "master"…) in it through, even as a name
      assert.equal((await s.api('DELETE', `${B}/items/${ticket}/reviewers/finish`, undefined, { agent: 'other' })).body.code, 'BOARD_HELD');
    } finally {
      await s.api('DELETE', `${B}/master`, undefined, { agent: 'holder' });
    }
  });

  it('a human-only route answers from the table, with its own words', async () => {
    const r = await s.api('PUT', `${B}/approvals`, { on: false }, { agent: 'other' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'HUMAN_ONLY');
    assert.equal(r.body.error, 'Only the human can switch approvals on or off');
    assert.match(r.body.hint, /attention/);
    assert.equal((await s.api('PUT', '/api/boards/nope/approvals', { on: false }, { agent: 'other' })).status, 404, 'an unknown board is still a 404');
    assert.equal((await s.api('PUT', `${B}/approvals`, { on: true }, USER)).status, 200);
  });
});

describe('route policy gaps closed (INT-355)', () => {
  let s;
  const human = { 'content-type': 'application/json', 'x-user': 'James', origin: '', authorization: 'Bearer user-secret' };
  const call = (method, p, headers, body) => fetch(s.base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  before(async () => {
    s = await startServer({
      manifest: { auth: { userToken: 'user-secret' }, permissions: { ro: { readOnly: true } } },
      agents: { agents: { ro: { enabled: false, grants: ['agents.control', 'agents.manage'] }, mgr: { enabled: false, grants: ['agents.manage'] }, w: { enabled: false, role: 'builder' } } },
    });
    human.origin = s.base;
  });
  after(() => s.stop());

  it('renaming the app and adding a board are the human\'s', async () => {
    for (const [method, p, body] of [['PATCH', '/api/app', { name: 'Mine now' }], ['POST', '/api/boards', { name: 'Side', idPrefix: 'SD' }]]) {
      for (const agent of ['other', 'ro']) {
        const r = await s.api(method, p, body, { agent });
        assert.equal(r.status, 403, `${agent}: ${method} ${p}`);
      }
      const r = await s.api(method, p, body, { agent: 'other' });
      assert.equal(r.body.code, 'HUMAN_ONLY');
      assert.ok(r.body.hint, 'says what to do instead');
    }
    assert.equal((await call('PATCH', '/api/app', human, { name: 'Renamed' })).status, 200);
    assert.equal((await call('POST', '/api/boards', human, { name: 'Side', idPrefix: 'SD' })).ok, true);
    assert.equal((await s.ok('GET', '/api/app')).name, 'Renamed');
  });

  it('renaming the app needs the user token like every other write; reading it stays public', async () => {
    const r = await call('PATCH', '/api/app', { 'x-user': 'James', origin: s.base }, { name: 'No token' });
    assert.equal(r.status, 401);
    assert.equal((await s.ok('GET', '/api/app', undefined, { agent: 'nobody' })).name, 'Renamed');
  });

  it('read-only takes the agents.* routes from an agent holding the grants; without read-only the grant still works', async () => {
    for (const [method, p, body] of [
      ['PATCH', '/api/agents/w', { description: 'x' }], ['POST', '/api/agents/stop-all', {}], ['POST', '/api/agents/resume-all', {}],
      ['POST', '/api/agents/w/pause', {}], ['POST', '/api/agents/w/resume', {}], ['POST', '/api/agents/w/run', {}],
    ]) {
      const r = await s.api(method, p, body, { agent: 'ro' });
      assert.equal(r.status, 403, `${method} ${p}`);
      assert.match(r.body.error, /read-only/);
    }
    assert.equal((await s.api('PATCH', '/api/agents/w', { description: 'Builds things' }, { agent: 'mgr' })).status, 200);
    // checking a command changes nothing, so a read-only agent may still do it
    assert.notEqual((await s.api('POST', '/api/agents/w/commands/check', { command: 'npm run x' }, { agent: 'ro' })).status, 403);
  });
});
