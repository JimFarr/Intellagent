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
