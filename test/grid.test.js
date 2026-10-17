// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// The permissions grid (INT-239): who holds what, and setting one cell. Only the signed-in human writes it.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { startServer, USER } = require('./helpers');

const TOKEN = 'secret-token';

describe('permissions grid (INT-239)', () => {
  let s;
  const agentsFile = () => JSON.parse(fs.readFileSync(path.join(s.dir, 'agents.json'), 'utf8'));
  const human = (method, p, body) => fetch(`${s.base}${p}`, { method, headers: { 'content-type': 'application/json', 'x-user': 'James', origin: s.base, authorization: `Bearer ${TOKEN}` }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const cell = async (agent, key) => (await s.ok('GET', '/api/agents/grid')).agents.find((a) => a.name === agent).cells[key];
  before(async () => {
    s = await startServer({
      manifest: { auth: { userToken: TOKEN, requireAgentTokens: false } },
      agents: { agents: { w: { enabled: false, role: 'builder' }, mgr: { enabled: false, grants: ['agents.manage'] }, solo: { enabled: false, perms: ['read'] } } },
    });
    const mk = await human('POST', '/api/permissions', { key: 'email', kind: 'verbal', name: 'Email the client', brief: 'You may email the client about delays.' });
    assert.equal(mk.status, 201, JSON.stringify(mk.body));
  });
  after(() => s.stop());

  it('lists every agent against every permission, with the lines the agent will read', async () => {
    const g = await s.ok('GET', '/api/agents/grid');
    assert.ok(g.permissions.some((p) => p.key === 'edit') && g.permissions.some((p) => p.key === 'review.decide'));
    const w = g.agents.find((a) => a.name === 'w');
    assert.equal(w.role, 'builder');
    assert.equal(w.cells.edit.mode, 'on', 'from its role');
    assert.equal(w.cells['review.decide'].mode, 'off');
    assert.deepEqual(w.cells['review.decide'].brief, [], 'off: nothing in the brief');
    const mgr = g.agents.find((a) => a.name === 'mgr');
    assert.equal(mgr.cells['agents.manage'].mode, 'on');
    assert.match(mgr.cells['agents.manage'].brief[0], /^- \*\*agents\.manage\*\* — .*: intellagent api PATCH \/api\/agents\/<name>/);
  });

  it('refuses agents (HUMAN_ONLY), a board with no sign-in token (NO_TOKEN) and unknown things', async () => {
    const r = await s.api('PUT', '/api/agents/w/permissions/read', { mode: 'off' }, { agent: 'mgr' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'HUMAN_ONLY');
    assert.ok(r.body.hint);
    assert.equal((await s.api('PUT', '/api/agents/w/permissions/read', { mode: 'off' }, { agent: 'w' })).body.code, 'HUMAN_ONLY', 'not even on itself');
    assert.equal((await s.api('PUT', '/api/agents/w/permissions/read', { mode: 'off' }, USER)).status, 401, 'an X-User without the token is no human');
    const t = await startServer({ agents: { agents: { w: { enabled: false, role: 'builder' } } } });
    try {
      const n = await t.api('PUT', '/api/agents/w/permissions/read', { mode: 'off' }, USER);
      assert.deepEqual([n.status, n.body.code], [403, 'NO_TOKEN']);
      assert.ok(n.body.hint);
    } finally { await t.stop(); }
    assert.equal((await human('PUT', '/api/agents/nobody/permissions/read', { mode: 'on' })).body.code, 'NOT_FOUND');
    assert.equal((await human('PUT', '/api/agents/w/permissions/make.coffee', { mode: 'on' })).body.code, 'NOT_FOUND');
    assert.equal((await human('PUT', '/api/agents/w/permissions/read', {})).body.code, 'BAD_REQUEST');
    assert.equal((await human('PUT', '/api/agents/w/permissions/read', { mode: 'maybe' })).body.code, 'BAD_REQUEST');
    assert.equal((await human('PUT', '/api/agents/w/permissions/read', { guidance: 7 })).body.code, 'BAD_REQUEST');
    assert.ok(!('guidance' in agentsFile().agents.w), 'a refused save writes nothing');
  });

  it('off and on for a tool: the agent leaves its role\'s list for its own, and the reply says so', async () => {
    const off = await human('PUT', '/api/agents/w/permissions/git', { mode: 'off' });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.cell.mode, 'off');
    assert.match(off.body.notes.join(' '), /its own list/);
    assert.ok(Array.isArray(agentsFile().agents.w.perms) && !agentsFile().agents.w.perms.includes('git'), 'written to agents.json');
    const on = await human('PUT', '/api/agents/w/permissions/git', { mode: 'on' });
    assert.equal(on.body.cell.mode, 'on');
    assert.equal(on.body.changed, true);
    const again = await human('PUT', '/api/agents/w/permissions/git', { mode: 'on' });
    assert.equal(again.body.changed, false, 'already on: nothing written');
  });

  it('turning on switches on what it needs, and turning off says when something else keeps it on', async () => {
    const on = await human('PUT', '/api/agents/solo/permissions/run-authors-code', { mode: 'on' });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepEqual(on.body.also.map((x) => x.key).sort(), ['test'], 'read was already on; test comes with it');
    assert.match(on.body.also[0].why, /needs it/);
    assert.ok(agentsFile().agents.solo.perms.includes('test'));
    const off = await human('PUT', '/api/agents/solo/permissions/test', { mode: 'off' });
    assert.equal(off.body.cell.mode, 'on', 'run-authors-code still needs it');
    assert.equal(off.body.cell.implied, true);
    assert.deepEqual(off.body.cell.by, ['run-authors-code']);
    assert.match(off.body.notes.join(' '), /stays on/);
    assert.equal((await human('PUT', '/api/agents/solo/permissions/run-authors-code', { mode: 'off' })).body.cell.mode, 'off');
    assert.equal((await human('PUT', '/api/agents/solo/permissions/test', { mode: 'off' })).body.cell.mode, 'off', 'free to go once nothing needs it');
  });

  it('a verbal permission is on in the brief and adds no tool', async () => {
    const before = (await s.ok('GET', '/api/agents/w')).run;
    const r = await human('PUT', '/api/agents/w/permissions/email', { mode: 'on' });
    assert.equal(r.body.cell.enforced, false);
    assert.match(r.body.notes.join(' '), /verbal/);
    assert.equal((await s.ok('GET', '/api/agents/w')).run, before, 'its run is exactly what it was');
    assert.match(r.body.cell.brief[0], /Email the client.*You may email the client/);
  });

  it('rules: a power takes minOks/from and a scope, a tool permission takes none', async () => {
    const on = await human('PUT', '/api/agents/w/permissions/review.decide', { mode: 'on' });
    assert.deepEqual([on.body.cell.mode, on.body.cell.rules], ['on', null]);
    assert.deepEqual(agentsFile().agents.w.grants, ['review.decide']);
    assert.match(on.body.cell.brief[0], /^- \*\*review\.decide\*\*/);
    const rules = await human('PUT', '/api/agents/w/permissions/review.decide', { mode: 'rules', rules: { minOks: 2, from: ['nebula', 'kraglin'], where: { 'fields.risk': 'low' } } });
    assert.equal(rules.status, 200, JSON.stringify(rules.body));
    assert.equal(rules.body.cell.mode, 'rules');
    assert.deepEqual(rules.body.cell.rules, { minOks: 2, from: ['nebula', 'kraglin'], where: { 'fields.risk': 'low' } });
    assert.match(rules.body.cell.brief[0], /only with 2 of nebula, kraglin|only with .*nebula/i);
    assert.deepEqual(agentsFile().agents.w.grants, [{ power: 'review.decide', minOks: 2, from: ['nebula', 'kraglin'], where: { 'fields.risk': 'low' } }]);
    for (const bad of [{ mode: 'rules' }, { mode: 'rules', rules: {} }, { mode: 'rules', rules: { minOks: 3, from: ['nebula', 'kraglin'] } }, { mode: 'rules', rules: { oops: 1 } }, { mode: 'on', rules: { minOks: 1 } }]) {
      const r = await human('PUT', '/api/agents/w/permissions/review.decide', bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.body.code, 'BAD_REQUEST');
      assert.ok(r.body.hint);
    }
    assert.equal((await human('PUT', '/api/agents/w/permissions/work.land', { mode: 'rules', rules: { minOks: 1 } })).status, 400, 'minOks only fits the powers that act on a reviewed ticket');
    const tool = await human('PUT', '/api/agents/w/permissions/edit', { mode: 'rules', rules: { minOks: 1 } });
    assert.equal(tool.body.code, 'BAD_REQUEST');
    assert.match(tool.body.hint, /board powers/);
    assert.equal((await cell('w', 'review.decide')).mode, 'rules', 'the refusals changed nothing');
    const off = await human('PUT', '/api/agents/w/permissions/review.decide', { mode: 'off' });
    assert.equal(off.body.cell.mode, 'off');
    assert.ok(!('grants' in agentsFile().agents.w), 'no grants left: the key goes');
  });

  it('guidance: set beside a permission, read in the brief, removed with an empty text', async () => {
    await human('PUT', '/api/agents/mgr/permissions/agents.manage', { guidance: 'Models only, never roles.\nAsk first.' });
    assert.equal(agentsFile().agents.mgr.guidance['agents.manage'], 'Models only, never roles.\nAsk first.');
    const c = await cell('mgr', 'agents.manage');
    assert.equal(c.mode, 'on', 'guidance alone leaves the mode');
    assert.equal(c.guidance, 'Models only, never roles.\nAsk first.');
    assert.match(c.brief[1], /^  Guidance from the human \(not enforced\): Models only, never roles\. Ask first\.$/);
    const brief = await (await fetch(`${s.base}/api/boards/main/brief`, { headers: { 'x-agent': 'mgr' } })).text();
    assert.ok(brief.includes(c.brief[0]) && brief.includes(c.brief[1]), 'the grid shows exactly what the brief says');
    const gone = await human('PUT', '/api/agents/mgr/permissions/agents.manage', { guidance: '' });
    assert.equal(gone.body.cell.guidance, null);
    assert.ok(!('guidance' in agentsFile().agents.mgr));
    assert.equal(agentsFile().agents.mgr.grants[0], 'agents.manage', 'the grant was never touched');
  });

  it('differs from the role, and the change is kept in the agent\'s history', async () => {
    const w = (await s.ok('GET', '/api/agents/grid')).agents.find((a) => a.name === 'w');
    assert.equal(w.cells.git.differsFromRole, false, 'git was switched off and on again');
    assert.equal(w.cells.email.differsFromRole, true, 'the role does not hold it');
    assert.equal(w.cells.git.differsFromRole, false);
    const hist = (await s.ok('GET', '/api/agents/w')).changes;
    assert.ok(hist.length >= 2 && hist.every((c) => c.by.name === 'James'), JSON.stringify(hist.map((c) => c.by)));
  });
});
