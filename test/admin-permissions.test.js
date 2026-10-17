// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Can edit permissions (INT-349): an agent with admin.permissions changes the grid and the library through the
// escalation rules: only other agents, only what it holds itself, never a board power, never a permission it
// holds; command, tool and folders permissions only narrow. Admin off suspends it; it needs its own token.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./helpers');

const B = '/api/boards/main';

describe('Can edit permissions (admin.permissions, INT-349)', () => {
  let s;
  const as = {
    human: { 'x-user': 'James', authorization: 'Bearer user-secret' },
    boss: { 'x-agent': 'boss', authorization: 'Bearer boss-secret' },
    plain: { 'x-agent': 'plain', authorization: 'Bearer plain-secret' },
    notok: { 'x-agent': 'notok' },
  };
  const call = async (who, method, p, body) => {
    const r = await fetch(s.base + p, { method, headers: { 'content-type': 'application/json', origin: s.base, ...as[who] }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const cell = (who, agent, key, body) => call(who, 'PUT', `/api/agents/${agent}/permissions/${key}`, body);
  const agentsFile = () => JSON.parse(fs.readFileSync(path.join(s.dir, 'agents.json'), 'utf8'));
  const refused = (r, codes) => {
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'NO_ESCALATION');
    assert.deepEqual(r.body.reasons, codes);
    assert.ok(r.body.hint);
  };

  before(async () => {
    s = await startServer({
      manifest: { auth: { userToken: 'user-secret', agentTokens: { boss: 'boss-secret', plain: 'plain-secret' } } },
      agents: {
        perms: {
          deploy: { kind: 'command', name: 'Deploy', commands: ['npm run deploy', 'npm run deploy:prod'] },
          'docs-only': { kind: 'verbal', name: 'Docs only', brief: 'Only touch docs' },
          tone: { kind: 'verbal', name: 'Tone', brief: 'Be brief' },
          pack: { kind: 'bundle', name: 'Pack', includes: ['read'] },
        },
        agents: {
          boss: { enabled: false, perms: ['read', 'test', 'docs-only'], grants: ['admin.permissions'] },
          notok: { enabled: false, perms: ['read'], grants: ['admin.permissions'] },
          plain: { enabled: false, perms: ['read', 'test'] },
          w: { enabled: false, perms: ['read', 'web'] },
        },
      },
    });
  });
  after(() => s.stop());

  it('grants what it holds to another agent, tagged as delegated, in the digest and the history', async () => {
    const r = await cell('boss', 'w', 'test', { mode: 'on' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(agentsFile().agents.w.perms.includes('test'));
    const ev = (await s.ok('GET', '/api/events?types=agent.managed&tail=true')).events.at(-1);
    assert.equal(ev.agent, 'w');
    assert.deepEqual(ev.delegated, { power: 'admin.permissions', onBehalfOf: 'human' });
    const dg = await s.ok('GET', `${B}/digest?days=1`);
    assert.match(JSON.stringify(dg), /Changed \*\*w\*\*'s Run tests permission.*admin\.permissions, on the human's behalf/);
    // kept on the agent with before/after, as agents.manage changes are (the Agents page reverts from it)
    const last = (await s.ok('GET', '/api/agents/w')).changes.at(-1);
    assert.deepEqual(last.by, { kind: 'agent', name: 'boss' });
    assert.deepEqual(last.changes.perms, { from: ['read', 'web'], to: ['read', 'web', 'test'] });
    // guidance on a permission it holds counts as a change to that cell, and is allowed
    assert.equal((await cell('boss', 'w', 'test', { guidance: 'Unit tests only' })).status, 200);
  });

  it('never beyond what it holds: on, off and guidance alike', async () => {
    refused(await cell('boss', 'w', 'edit', { mode: 'on' }), ['BEYOND_HELD']);
    assert.deepEqual((await cell('boss', 'w', 'edit', { mode: 'on' })).body.missing, ['edit']);
    // w holds web, boss doesn't: it takes away only what it could grant
    refused(await cell('boss', 'w', 'web', { mode: 'off' }), ['BEYOND_HELD']);
    refused(await cell('boss', 'w', 'web', { guidance: 'Docs sites only' }), ['BEYOND_HELD']);
    assert.ok(agentsFile().agents.w.perms.includes('web'), 'nothing changed');
    // a bundle brings its parts: boss holds read, so pack is within it... but not pack itself
    refused(await cell('boss', 'w', 'pack', { mode: 'on' }), ['BEYOND_HELD']);
  });

  it('never its own row', async () => {
    refused(await cell('boss', 'boss', 'test', { mode: 'off' }), ['OWN_ROW']);
    refused(await cell('boss', 'BOSS', 'read', { guidance: 'x' }), ['OWN_ROW']);
  });

  it('never a board power, admin.permissions included, and no rules or guidance on one either', async () => {
    for (const key of ['review.decide', 'admin.permissions', 'admin', 'agents.manage']) {
      const r = await cell('boss', 'w', key, { mode: 'on' });
      refused(r, ['BOARD_POWER']);
      assert.deepEqual(r.body.powers, [key]);
    }
    refused(await cell('boss', 'w', 'review.decide', { mode: 'rules', rules: { where: { 'fields.risk': 'low' } } }), ['BOARD_POWER']);
    refused(await cell('boss', 'w', 'review.decide', { guidance: 'Docs tickets only' }), ['BOARD_POWER']);
    assert.equal(agentsFile().agents.w.grants, undefined);
  });

  it('the library: bundles and verbal ones of what it holds; command, tool and folders permissions only narrow', async () => {
    const lib = (who, method, key, body) => call(who, method, key ? `/api/permissions/${key}` : '/api/permissions', body);
    // creating a permission that allows tools is the human's
    refused(await lib('boss', 'POST', null, { key: 'push', kind: 'command', commands: ['git push'] }), ['HUMAN_KIND']);
    refused(await lib('boss', 'POST', null, { key: 'net', kind: 'tool', tools: ['WebFetch'] }), ['HUMAN_KIND']);
    // a bundle of what it holds is fine; of what it doesn't hold is not
    assert.equal((await lib('boss', 'POST', null, { key: 'qa', kind: 'bundle', includes: ['read', 'test'] })).status, 201);
    refused(await lib('boss', 'POST', null, { key: 'big', kind: 'bundle', includes: ['edit'] }), ['BEYOND_HELD']);
    assert.equal((await lib('boss', 'POST', null, { key: 'careful', kind: 'verbal', brief: 'Ask first', needs: ['read'] })).status, 201);
    // narrowing the human's command permission is fine; adding to it is not, nor turning it into another kind's tools
    assert.equal((await lib('boss', 'PATCH', 'deploy', { commands: ['npm run deploy'] })).status, 200);
    const wider = await lib('boss', 'PATCH', 'deploy', { commands: ['npm run deploy', 'git push'] });
    refused(wider, ['NARROW_ONLY']);
    assert.deepEqual(agentsFile().perms.deploy.commands, ['npm run deploy']);
    refused(await lib('boss', 'PATCH', 'tone', { kind: 'tool', tools: ['WebFetch'] }), ['HUMAN_KIND']);
    // new includes and needs must be its own; old ones may stay
    refused(await lib('boss', 'PATCH', 'pack', { includes: ['read', 'edit'] }), ['BEYOND_HELD']);
    assert.equal((await lib('boss', 'PATCH', 'pack', { includes: ['read', 'test'] })).status, 200);
    // never one it holds: that would widen its own row through a side door
    refused(await lib('boss', 'PATCH', 'docs-only', { brief: 'Touch anything' }), ['HELD_ITSELF']);
    // removing: bundles and verbal ones only, and the board still refuses one in use
    assert.equal((await lib('boss', 'DELETE', 'careful')).status, 200);
    refused(await lib('boss', 'DELETE', 'deploy'), ['HUMAN_KIND']);
    assert.equal((await lib('boss', 'DELETE', 'nope')).status, 404, 'an unknown key is still a 404');
    const ev = (await s.ok('GET', '/api/events?types=permissions.changed&tail=true')).events.at(-1);
    assert.deepEqual(ev.delegated, { power: 'admin.permissions', onBehalfOf: 'human' });
    assert.equal(ev.after, null);
  });

  it('a singular "command" can\'t slip a wider command past the narrowing check', async () => {
    const raw = agentsFile();
    raw.perms.single = { kind: 'command', name: 'Single', command: 'npm run lint' };
    fs.writeFileSync(path.join(s.dir, 'agents.json'), JSON.stringify(raw, null, 2));
    await new Promise((r) => setTimeout(r, 600)); // the board re-reads agents.json on change
    const r = await call('boss', 'PATCH', '/api/permissions/single', { command: 'git push' });
    assert.notEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(!JSON.stringify(agentsFile().perms.single).includes('git push'));
  });

  it('needs the grant, its own token, and admin on; the human is never held to the rules', async () => {
    const plain = await cell('plain', 'w', 'test', { mode: 'off' });
    assert.equal(plain.status, 403);
    assert.equal(plain.body.code, 'HUMAN_ONLY');
    assert.equal((await call('plain', 'POST', '/api/permissions', { key: 'v', kind: 'verbal', brief: 'b' })).body.code, 'HUMAN_ONLY');
    const notok = await cell('notok', 'w', 'read', { guidance: 'x' });
    assert.equal(notok.status, 403);
    assert.equal(notok.body.code, 'NO_TOKEN');
    assert.equal((await call('human', 'PUT', `${B}/admin`, { on: false })).status, 200);
    try {
      assert.equal((await cell('boss', 'w', 'test', { mode: 'off' })).body.code, 'ADMIN_OFF');
      assert.equal((await call('boss', 'POST', '/api/permissions', { key: 'v2', kind: 'verbal', brief: 'b' })).body.code, 'ADMIN_OFF');
    } finally {
      assert.equal((await call('human', 'PUT', `${B}/admin`, { on: true })).status, 200);
    }
    // the human grants anything, a board power included
    assert.equal((await cell('human', 'w', 'edit', { mode: 'on' })).status, 200);
    assert.equal((await cell('human', 'w', 'review.decide', { mode: 'on' })).status, 200);
    assert.equal((await call('human', 'POST', '/api/permissions', { key: 'push', kind: 'command', commands: ['git push'] })).status, 201);
  });

  it('the brief and permissions/me name the power and what it does', async () => {
    const me = await call('boss', 'GET', '/api/permissions/me');
    assert.ok(me.body.grants.some((g) => g.power === 'admin.permissions'));
    const brief = await call('boss', 'GET', `${B}/brief?format=json`);
    assert.match(JSON.stringify(brief.body), /admin\.permissions.*NO_ESCALATION/);
  });
});
