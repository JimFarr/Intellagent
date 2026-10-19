// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Roles as data (INT-229): the built-ins ship in lib/agents/roles.json, the human adds their own in agents.json.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, USER } = require('./helpers');
const { createRoles, BUILTIN } = require('../lib/agents/roles');
const { runFor } = require('../lib/agents');

describe('roles as data: the library', () => {
  it('has the six built-ins, and a prototype key is never a role', () => {
    const r = createRoles();
    assert.deepEqual(r.keys(), ['coordinator', 'builder', 'reviewer', 'researcher', 'designer', 'writer']);
    for (const k of ['constructor', 'toString', '__proto__']) assert.equal(r.has(k), false, k);
    assert.deepEqual(r.errors, []);
  });

  it('a built-in role gives an agent exactly the defaults it gave before', () => {
    const r = createRoles();
    assert.deepEqual(r.defaultsOf(r.get('coordinator')), { listen: ['addressed', 'new-tickets'], throttleMinutes: 3, description: BUILTIN.coordinator.description, pickup: 'all', supervise: true });
    assert.deepEqual(r.defaultsOf(r.get('reviewer')), { listen: 'addressed', throttleMinutes: 5, description: BUILTIN.reviewer.description, reviewer: true });
    assert.deepEqual(r.defaultsOf(r.get('builder')), { listen: 'addressed', throttleMinutes: 3, description: BUILTIN.builder.description });
    assert.deepEqual(r.defaultsOf(null), {});
  });

  it('refuses a custom role that does not check out, naming the role and the key', () => {
    const r = createRoles({
      builder: { label: 'Mine' },
      'bad name': {},
      sometimes: { pickup: 'sometimes' },
      deaf: { listen: 'never' },
      loose: { perms: 'edit' },
      slow: { throttleMinutes: -1 },
      fancy: { model: 'opus; rm -rf /' },
      fine: { label: 'Fine', perms: ['read'] },
    });
    assert.deepEqual(r.keys().filter((k) => !BUILTIN[k]), ['fine']);
    for (const k of ['builder', 'bad name', 'sometimes', 'deaf', 'loose', 'slow', 'fancy']) assert.ok(r.errors.some((m) => m.startsWith(`Role "${k}"`)), k);
    assert.equal(r.get('builder').label, 'Builder', 'a built-in is never replaced');
  });

  it('lists what an agent sets itself that its role sets differently', () => {
    const r = createRoles();
    assert.equal(r.differences({ description: 'x' }), null, 'no role, nothing to differ from');
    assert.deepEqual(r.differences({ role: 'builder', run: 'x', areas: ['a'] }), {}, 'keys a role does not set are not differences');
    assert.deepEqual(r.differences({ role: 'builder', listen: 'addressed', throttleMinutes: 3 }), {}, 'the same value is not a difference');
    assert.deepEqual(r.differences({ role: 'builder', perms: ['read'], model: 'opus' }), {
      perms: { role: ['edit', 'test', 'build', 'git', 'call-helpers'], agent: ['read'] },
      model: { role: null, agent: 'opus' },
    });
  });
});

describe('roles as data: on the board', () => {
  let s;
  before(async () => {
    s = await startServer({
      agents: {
        roles: {
          triager: { label: 'Triager', description: 'Sorts new tickets', brief: 'Your role: triager.', perms: ['read'], model: 'haiku', commands: ['npm run lint'], throttleMinutes: 2 },
          builder: { label: 'Not the builder' },
          boosted: { label: 'Boosted', perms: ['read'], grants: ['review.decide'] },
        },
        agents: {
          plain: { role: 'builder', enabled: false },
          sorter: { role: 'triager', enabled: false },
          mine: { role: 'builder', perms: ['read'], description: 'my own words', enabled: false },
          ghost: { role: 'nope', enabled: false },
          boss: { enabled: false, grants: ['agents.manage'] },
        },
      },
    });
  });
  after(async () => { await s.stop(); });

  const agent = (name) => s.ok('GET', `/api/agents/${name}`);

  it('an agent with a built-in role is built as before', async () => {
    const a = await agent('plain');
    assert.deepEqual([a.listen, a.throttleMinutes, a.perms, a.permsFrom, a.pickup, a.reviewer], ['addressed', 3, BUILTIN.builder.perms, 'role', false, false]);
    assert.equal(a.description, BUILTIN.builder.description);
    assert.ok(a.run.startsWith(runFor(BUILTIN.builder.perms).split(' --strict-mcp-config')[0]), 'the same tools as before');
    assert.deepEqual(a.differsFromRole, {});
  });

  it('a custom role brings its permissions, model, commands and wake-up settings', async () => {
    const a = await agent('sorter');
    assert.deepEqual([a.role, a.perms, a.permsFrom, a.model, a.tier, a.throttleMinutes, a.listen], ['triager', ['read'], 'role', 'haiku', 'junior', 2, 'addressed']);
    assert.match(a.run, /"Bash\(npm run lint\)"/);
    assert.match(a.run, / --model haiku$/);
    assert.deepEqual(a.differsFromRole, {});
  });

  it('differsFromRole names what the agent sets itself', async () => {
    const a = await agent('mine');
    assert.deepEqual(a.differsFromRole, {
      perms: { role: BUILTIN.builder.perms, agent: ['read'] },
      description: { role: BUILTIN.builder.description, agent: 'my own words' },
    });
  });

  it('GET /api/roles lists built-ins and custom roles with the agents using each, and the errors', async () => {
    const r = await s.ok('GET', '/api/roles');
    const by = Object.fromEntries(r.roles.map((x) => [x.key, x]));
    assert.deepEqual(Object.keys(by), ['coordinator', 'builder', 'reviewer', 'researcher', 'designer', 'writer', 'triager']);
    assert.deepEqual([by.builder.builtin, by.builder.label, by.builder.agents], [true, 'Builder', ['plain', 'mine']]);
    assert.deepEqual([by.triager.builtin, by.triager.model, by.triager.commands, by.triager.agents], [false, 'haiku', ['npm run lint'], ['sorter']]);
    assert.equal(by.reviewer.reviewer, true);
    assert.ok(r.errors.some((m) => m.includes('"builder" is built in')));
    assert.ok(!by.boosted, 'a role that carries grants is refused');
    assert.ok(r.errors.some((m) => m.includes('Role "boosted": a role never carries grants')));
    // the short form the Agents page reads keeps its shape and gains the custom role
    const short = await s.ok('GET', '/api/agents/roles');
    assert.deepEqual(Object.keys(short.roles.triager), ['label', 'icon', 'description', 'perms', 'listen']);
  });

  it('GET /api/roles/:key gives one role with how each agent differs; an unknown one is 404 with the list', async () => {
    const r = await s.ok('GET', '/api/roles/builder');
    assert.deepEqual(r.agents.map((a) => a.name), ['plain', 'mine']);
    assert.deepEqual(Object.keys(r.agents.find((a) => a.name === 'mine').differs).sort(), ['description', 'perms']);
    const miss = await s.api('GET', '/api/roles/nope');
    assert.equal(miss.status, 404);
    assert.equal(miss.body.code, 'NOT_FOUND');
    assert.match(miss.body.hint, /triager/);
  });

  it('an unknown role is reported, and the agent still loads without one', async () => {
    const list = await s.ok('GET', '/api/agents');
    assert.match(list.error, /agent "ghost": unknown role "nope"/);
    assert.equal((await agent('ghost')).differsFromRole, null);
  });

  it('agents can be defined and managed with a custom role; an unknown one is a 400 with the list', async () => {
    const a = await s.ok('POST', '/api/agents', { name: 'sorter2', role: 'triager', enabled: false }, USER);
    assert.deepEqual([a.role, a.perms, a.model], ['triager', ['read'], 'haiku']);
    assert.equal((await s.api('POST', '/api/agents', { name: 'x', role: 'nope' }, USER)).status, 400);
    const bad = await s.api('PATCH', '/api/agents/sorter2', { role: 'nope' }, USER);
    assert.equal(bad.status, 400);
    assert.match(bad.body.hint, /triager/);
    await s.ok('PATCH', '/api/agents/sorter2', { role: 'builder' }, USER);
    assert.equal((await agent('sorter2')).role, 'builder');
    await s.ok('DELETE', '/api/agents/sorter2', undefined, USER);
  });

  it("an agent manager gives only built-in roles: the human's own can bring commands and a model it could not", async () => {
    const boss = { agent: 'boss' };
    const r = await s.api('PATCH', '/api/agents/mine', { role: 'triager', perms: ['read'] }, boss);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'HUMAN_ONLY');
    assert.match(r.body.hint, /builder/);
    const a = await agent('mine');
    assert.deepEqual([a.role, a.model, a.commands ?? null], ['builder', null, null], 'nothing changed: no npm run lint, no haiku');
    // a built-in role still works within the narrowing rules, as before
    await s.ok('PATCH', '/api/agents/mine', { role: 'researcher', perms: ['read'] }, boss);
    assert.equal((await agent('mine')).role, 'researcher');
    // and the human may give any role
    await s.ok('PATCH', '/api/agents/mine', { role: 'triager' }, USER);
    assert.equal((await agent('mine')).role, 'triager');
  });

  it('PUT /api/roles/:key: the human adds and replaces their own roles; commands written by hand are kept (INT-370)', async () => {
    const made = await s.ok('PUT', '/api/roles/scout', { label: 'Scout', brief: 'Your role: scout.', perms: ['read'], supervise: true, throttleMinutes: 4 }, USER);
    assert.equal(made.created, true);
    assert.deepEqual([made.role.label, made.role.perms, made.role.supervise, made.role.throttleMinutes, made.role.builtin], ['Scout', ['read'], true, 4, false]);
    assert.equal((await s.ok('GET', '/api/roles/scout')).brief, 'Your role: scout.');
    // an agent given the new role is built from it, once accepted (probation runs it with read and no wakes)
    await s.ok('POST', '/api/agents', { name: 'scout1', role: 'scout', enabled: false }, USER);
    assert.equal((await agent('scout1')).supervise, false, 'on probation: no supervision');
    await s.ok('POST', '/api/agents/scout1/accept', {}, USER);
    assert.deepEqual([(await agent('scout1')).perms, (await agent('scout1')).supervise], [['read'], true]);
    // replacing triager keeps its hand-written commands: the API never sets them, so it never drops them
    const again = await s.ok('PUT', '/api/roles/triager', { label: 'Triager 2', perms: ['read'] }, USER);
    assert.deepEqual([again.created, again.role.label, again.role.commands], [false, 'Triager 2', ['npm run lint']]);
    // recorded, and an agent.* event, so it wakes nobody
    const ev = (await s.ok('GET', '/api/events?types=agent.role_changed&limit=10')).events;
    assert.deepEqual(ev.map((e) => [e.key, e.before ? 'changed' : 'added', e.recipients.length]), [['scout', 'added', 0], ['triager', 'changed', 0]]);
    await s.ok('DELETE', '/api/agents/scout1', undefined, USER);
  });

  it('PUT /api/roles/:key is the human\'s, never takes commands, run, env or grants, and holds no power (INT-370)', async () => {
    for (const who of [{ agent: 'boss' }, { agent: 'plain' }]) {
      const r = await s.api('PUT', '/api/roles/sneaky', { label: 'x', perms: ['read'] }, who);
      assert.deepEqual([r.status, r.body.code], [403, 'HUMAN_ONLY'], `${who.agent}: even agents.manage`);
    }
    assert.equal((await s.api('GET', '/api/roles/sneaky')).status, 404, 'nothing written');
    const put = (key, body) => s.api('PUT', `/api/roles/${key}`, body, USER);
    assert.deepEqual([(await put('builder', { label: 'x' })).status, (await put('builder', { label: 'x' })).body.code], [409, 'CONFLICT'], 'a built-in never changes');
    for (const k of ['commands', 'run', 'env', 'inheritEnv', 'grants']) {
      const r = await put('loaded', { label: 'x', [k]: k === 'env' ? { A: '1' } : ['npm run x'] });
      assert.deepEqual([r.status, r.body.code], [403, 'NOT_DELEGABLE'], k);
    }
    const power = await put('loaded', { perms: ['read', 'review.decide'] });
    assert.equal(power.status, 400);
    assert.match(power.body.error, /powers are grants/);
    assert.equal((await put('loaded', { label: 'x', speed: 9 })).body.code, 'UNKNOWN_FIELD');
    // cleanRole's own checks, as load makes them
    const deaf = await put('loaded', { listen: 'never' });
    assert.equal(deaf.status, 400);
    assert.match(deaf.body.error, /Role "loaded": "listen"/);
    assert.equal((await s.api('GET', '/api/roles/loaded')).status, 404, 'nothing written');
  });

  it('supervise and idleAlarm: the human sets them on POST and PATCH /api/agents, an agent manager never (INT-370)', async () => {
    const a = await s.ok('POST', '/api/agents', { name: 'watcher', role: 'builder', enabled: false, supervise: true, idleAlarm: { minutes: 15 } }, USER);
    // stored, but probation holds them off until the human accepts the agent
    assert.deepEqual([a.supervise, a.idleAlarm], [false, null]);
    await s.ok('POST', '/api/agents/watcher/accept', {}, USER);
    assert.deepEqual([(await agent('watcher')).supervise, (await agent('watcher')).idleAlarm], [true, { minutes: 15 }]);
    // PATCH: false overrides the role, null goes back to it; plain true leaves no minutes behind
    let r = await s.ok('PATCH', '/api/agents/watcher', { supervise: false, idleAlarm: true }, USER);
    assert.deepEqual(r.changes.supervise, { from: true, to: false });
    assert.deepEqual(r.changes.idleAlarmMinutes, { from: 15, to: null });
    assert.deepEqual([(await agent('watcher')).supervise, (await agent('watcher')).idleAlarm], [false, { minutes: 20 }]);
    r = await s.ok('PATCH', '/api/agents/watcher', { idleAlarm: null }, USER);
    assert.equal((await agent('watcher')).idleAlarm, null);
    // kept in the agent's history, like every other edit
    const hist = (await agent('watcher')).changes || [];
    assert.ok(hist.some((c) => c.changes.supervise), 'the change is recorded with before and after');
    // an agent manager over it, and the agent itself: refused, nothing changes
    for (const [who, body] of [['boss', { supervise: true }], ['boss', { idleAlarm: true, description: 'and this' }], ['watcher', { idleAlarm: true }]]) {
      const no = await s.api('PATCH', '/api/agents/watcher', body, { agent: who });
      assert.equal(no.status, 403, `${who} ${JSON.stringify(body)}`);
    }
    assert.equal((await s.api('PATCH', '/api/agents/watcher', { supervise: true }, { agent: 'boss' })).body.code, 'HUMAN_ONLY');
    assert.deepEqual([(await agent('watcher')).supervise, (await agent('watcher')).idleAlarm, (await agent('watcher')).description], [false, null, BUILTIN.builder.description]);
    // POST is the human's already; bad values are a 400 for the human too
    assert.equal((await s.api('POST', '/api/agents', { name: 'w2', supervise: true }, { agent: 'boss' })).body.code, 'HUMAN_ONLY');
    for (const v of ['yes', { minutes: 2 }, { minutes: 15, extra: 1 }, [true]]) {
      assert.equal((await s.api('PATCH', '/api/agents/watcher', { idleAlarm: v }, USER)).status, 400, JSON.stringify(v));
    }
    assert.equal((await s.api('POST', '/api/agents', { name: 'w3', supervise: 'on' }, USER)).status, 400);
    await s.ok('DELETE', '/api/agents/watcher', undefined, USER);
  });

  it('listen, pickup and throttleMinutes: the human sets them on PATCH, kept with before and after; an agent manager never (INT-401)', async () => {
    await s.ok('POST', '/api/agents', { name: 'waker', role: 'builder', enabled: false }, USER);
    await s.ok('POST', '/api/agents/waker/accept', {}, USER);
    const r = await s.ok('PATCH', '/api/agents/waker', { listen: ['addressed', 'new-tickets'], pickup: true, throttleMinutes: 7 }, USER);
    assert.deepEqual(r.changes.listen.to, ['addressed', 'new-tickets']);
    assert.deepEqual(r.changes.pickup.to, 'ready', 'true is stored as "ready"');
    assert.deepEqual(r.changes.throttleMinutes, { from: null, to: 7 });
    const now = await agent('waker');
    assert.deepEqual([now.listen, now.pickup, now.throttleMinutes], [['addressed', 'new-tickets'], 'ready', 7]);
    assert.ok(((await agent('waker')).changes || []).some((c) => c.changes.throttleMinutes), 'recorded with before and after');
    // a filter object is a listen source too; null goes back to the role's
    await s.ok('PATCH', '/api/agents/waker', { listen: { types: 'item.created', column: 'Ready' }, pickup: null, throttleMinutes: 0 }, USER);
    assert.equal((await agent('waker')).throttleMinutes, 0);
    // bad shapes: 400 and nothing changes
    for (const body of [{ listen: 'everything' }, { listen: [] }, { listen: [['a']] }, { pickup: 'sometimes' }, { throttleMinutes: -1 }, { throttleMinutes: 2.5 }, { throttleMinutes: '3' }]) {
      assert.equal((await s.api('PATCH', '/api/agents/waker', body, USER)).status, 400, JSON.stringify(body));
    }
    assert.equal((await agent('waker')).throttleMinutes, 0);
    // an agent manager over it, and the agent itself, are refused
    for (const [who, body] of [['boss', { listen: 'human' }], ['boss', { pickup: 'all' }], ['boss', { throttleMinutes: 1, description: 'and this' }], ['waker', { throttleMinutes: 0 }]]) {
      const no = await s.api('PATCH', '/api/agents/waker', body, { agent: who });
      assert.equal(no.status, 403, `${who} ${JSON.stringify(body)}`);
    }
    assert.equal((await s.api('PATCH', '/api/agents/waker', { pickup: 'all' }, { agent: 'boss' })).body.code, 'HUMAN_ONLY');
    assert.equal((await agent('waker')).throttleMinutes, 0);
    await s.ok('DELETE', '/api/agents/waker', undefined, USER);
  });
});
