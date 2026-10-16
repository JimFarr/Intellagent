// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// The permission library (INT-228): built-ins from code, the human's own in agents.json, agents read only.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { startServer, USER } = require('./helpers');
const { createLibrary, PERMS, POWERS } = require('../lib/permissions');
const { runFor, ROLES } = require('../lib/agents');

const B = '/api/boards/main';

describe('permission library', () => {
  it('seeds the built-ins from PERMS and POWERS', () => {
    const lib = createLibrary();
    const keys = lib.list().map((p) => p.key);
    assert.deepEqual(keys, [...Object.keys(PERMS), ...Object.keys(POWERS)]);
    assert.equal(lib.get('review.decide').heldBy, 'grants');
    assert.equal(lib.get('edit').heldBy, 'perms');
    assert.ok(lib.list().every((p) => p.builtin && p.enforced));
  });

  it('builds the same run for every role as before', () => {
    // the run string is what reaches claude: built-ins resolve to exactly their old tools
    for (const r of Object.values(ROLES)) {
      const expected = [...new Set(r.perms.flatMap((k) => PERMS[k].tools))];
      const run = runFor(r.perms);
      for (const t of expected) assert.ok(run.includes(`"${t}"`), `${t} in ${run}`);
      assert.equal(run.includes('--permission-mode acceptEdits'), r.perms.includes('edit'));
    }
  });

  it('turns each kind into tool rules; verbal adds none', () => {
    const lib = createLibrary({
      deploy: { kind: 'command', name: 'Deploy', commands: ['npm run deploy:staging', 'npm run deploy:check:*'], needs: ['test'] },
      gh: { kind: 'tool', name: 'GitHub', tools: ['mcp__github', 'WebFetch'] },
      docs: { kind: 'folders', name: 'Docs only', folders: ['docs/**', 'README.md'] },
      ship: { kind: 'bundle', name: 'Ship', includes: ['deploy', 'git'] },
      email: { kind: 'verbal', name: 'Email the client', brief: 'You may email the client about delays.' },
    });
    assert.deepEqual(lib.errors, []);
    const r = lib.resolve(['ship', 'email']);
    assert.deepEqual(r.keys.sort(), ['deploy', 'email', 'git', 'ship', 'test'], 'bundles and needs expand');
    assert.ok(r.tools.includes('Bash(npm run deploy:staging)') && r.tools.includes('Bash(npm test)'));
    assert.ok(!r.tools.some((t) => /email/i.test(t)), 'a verbal permission grants no tool');
    const run = runFor(['docs', 'gh', 'email'], { library: lib });
    assert.ok(run.includes('"Edit(docs/**)"') && run.includes('"Write(README.md)"'));
    assert.ok(!run.includes('acceptEdits'), 'folders allow edits by rule, not by mode');
    assert.ok(run.includes('"mcp__github"') && !/--tools "[^"]*mcp__/.test(run), 'MCP tools are allowed, not listed as built-in tools');
    assert.equal(lib.get('email').enforced, false);
    assert.match(lib.get('email').warning, /not enforced/);
    assert.match(lib.briefText(['email']), /Verbal permissions \(not enforced.*\n- \*\*Email the client\*\* — You may email the client about delays\./);
    assert.equal(lib.briefText(['edit', 'test']), '', 'built-ins add nothing to the brief');
  });

  it('refuses what could widen or mislead, and keeps the rest', () => {
    const lib = createLibrary({
      sneaky: { kind: 'bundle', name: 'x', includes: ['review.decide'] },
      shell: { kind: 'tool', name: 'x', tools: ['Bash'] },
      quote: { kind: 'command', name: 'x', commands: ['rm -rf "/"'] },
      up: { kind: 'folders', name: 'x', folders: ['../secrets/**'] },
      abs: { kind: 'folders', name: 'x', folders: ['C:/Windows/**'] },
      edit: { kind: 'verbal', name: 'shadow', brief: 'x' },
      mute: { kind: 'verbal', name: 'x' },
      loop: { kind: 'bundle', name: 'x', includes: ['loop2'] },
      loop2: { kind: 'bundle', name: 'x', includes: ['loop'] },
      leans: { kind: 'bundle', name: 'x', includes: ['sneaky'] },
      fine: { kind: 'command', name: 'Fine', commands: ['npm run fine'] },
    });
    for (const k of ['sneaky', 'shell', 'quote', 'up', 'abs', 'mute', 'leans']) assert.ok(!lib.has(k), `${k} is dropped`);
    assert.equal(lib.get('edit').builtin, true, 'a custom entry never shadows a built-in');
    assert.ok(lib.errors.some((e) => /loop/.test(e)), 'a cycle is reported');
    assert.ok(lib.has('fine'));
    assert.ok(!lib.holdable('review.decide'), 'powers are held through grants only');
  });

  it('treats inherited names (constructor, toString) as unknown, never as a permission', () => {
    const lib = createLibrary({
      viaInclude: { kind: 'bundle', name: 'x', includes: ['constructor'] },
      viaNeed: { kind: 'verbal', name: 'x', brief: 'x', needs: ['toString'] },
      fine: { kind: 'command', name: 'Fine', commands: ['npm run fine'] },
    });
    assert.ok(!lib.has('viaInclude') && !lib.has('viaNeed'), 'reported and skipped');
    assert.ok(lib.errors.some((e) => /constructor/.test(e)) && lib.errors.some((e) => /toString/.test(e)));
    for (const k of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      assert.ok(!lib.has(k) && !lib.holdable(k) && !lib.isPower(k), k);
      assert.equal(lib.get(k), null, k);
    }
    assert.deepEqual(lib.resolve(['constructor', 'fine']).unknown, ['constructor']);
    assert.doesNotThrow(() => runFor(['edit', 'constructor'], { library: lib }), 'the run is still built');
  });
});

describe('permission library over the API', () => {
  let s;
  const agentsFile = () => path.join(s.dir, 'agents.json');
  before(async () => {
    s = await startServer({ manifest: { auth: { requireAgentTokens: false } }, agents: { agents: { w: { enabled: false, role: 'builder' }, mgr: { enabled: false, grants: ['agents.manage'] } } } });
  });
  after(() => s.stop());

  it('lists the library for everyone; only the human changes it', async () => {
    const all = (await s.ok('GET', '/api/permissions')).permissions;
    assert.ok(all.some((p) => p.key === 'edit') && all.some((p) => p.key === 'work.land'));
    const body = { key: 'email', kind: 'verbal', name: 'Email the client', brief: 'You may email the client about delays.' };
    assert.equal((await s.api('POST', '/api/permissions', body, { agent: 'w' })).body.code, 'HUMAN_ONLY');
    assert.equal((await s.api('POST', '/api/permissions', body, { agent: 'mgr' })).body.code, 'HUMAN_ONLY', 'agents.manage does not reach the library');
    const made = await s.ok('POST', '/api/permissions', body, USER);
    assert.equal(made.enforced, false);
    assert.equal(JSON.parse(fs.readFileSync(agentsFile(), 'utf8')).perms.email.kind, 'verbal', 'stored in agents.json');
    assert.equal((await s.api('POST', '/api/permissions', body, USER)).body.code, 'CONFLICT', 'no duplicate');
    assert.equal((await s.api('PATCH', '/api/permissions/edit', { name: 'x' }, USER)).body.code, 'CONFLICT', 'built-ins never change');
    assert.equal((await s.api('POST', '/api/permissions', { key: 'b', kind: 'bundle', name: 'b', includes: ['column.gate'] }, USER)).status, 400);
    assert.equal((await s.ok('PATCH', '/api/permissions/email', { name: 'Email clients' }, USER)).name, 'Email clients');
    const roles = await s.ok('GET', '/api/agents/roles');
    assert.match(roles.perms.email, /not enforced/, 'the agent form marks it');
  });

  it('an agent holding a custom permission gets its tools and its brief lines', async () => {
    await s.ok('POST', '/api/permissions', { key: 'deploy', kind: 'command', name: 'Deploy to staging', commands: ['npm run deploy:staging'], brief: 'Deploy to staging after the tests pass.' }, USER);
    const a = await s.ok('POST', '/api/agents', { name: 'w', perms: ['edit', 'deploy', 'email'] }, USER);
    assert.ok(a.run.includes('"Bash(npm run deploy:staging)"'));
    assert.ok(!/email/i.test(a.run), 'the verbal one is in no tool rule');
    const brief = await (await fetch(`${s.base}${B}/brief`, { headers: { 'x-agent': 'w' } })).text();
    assert.match(brief, /## Permissions the human gave you\n- \*\*Deploy to staging\*\* — Deploy to staging after the tests pass\./);
    assert.match(brief, /Verbal permissions \(not enforced/);
    assert.match(brief, /\*\*Email clients\*\* — You may email the client about delays\./);
    // changing the permission changes the holder's run
    await s.ok('PATCH', '/api/permissions/deploy', { commands: ['npm run deploy:stage2'] }, USER);
    assert.ok((await s.ok('GET', '/api/agents/w')).run.includes('"Bash(npm run deploy:stage2)"'));
  });

  it('an agent manager still only narrows, bundles expanded', async () => {
    await s.ok('POST', '/api/permissions', { key: 'pack', kind: 'bundle', name: 'Pack', includes: ['edit', 'web'] }, USER);
    const r = await s.api('PATCH', '/api/agents/w', { perms: ['pack'] }, { agent: 'mgr' });
    assert.equal(r.body.code, 'WIDEN', 'a bundle that brings web is wider than edit + deploy');
    assert.equal((await s.api('PATCH', '/api/agents/w', { perms: ['edit'] }, { agent: 'mgr' })).status, 200);
    assert.equal((await s.api('PATCH', '/api/agents/w', { perms: ['edit', 'review.decide'] }, USER)).status, 400, 'powers are not perms');
  });

  it('removing one in use names who uses it', async () => {
    await s.ok('POST', '/api/agents', { name: 'w', perms: ['edit', 'deploy'] }, USER);
    await s.ok('POST', '/api/permissions', { key: 'ops', kind: 'bundle', name: 'Ops', includes: ['deploy'] }, USER);
    const r = await s.api('DELETE', '/api/permissions/deploy', undefined, USER);
    assert.equal(r.body.code, 'CONFLICT');
    assert.deepEqual([r.body.holders, r.body.usedBy], [['w'], ['ops']]);
    await s.ok('DELETE', '/api/permissions/ops', undefined, USER);
    await s.ok('POST', '/api/agents', { name: 'w', perms: ['edit'] }, USER);
    await s.ok('DELETE', '/api/permissions/deploy', undefined, USER);
    assert.ok(!(await s.ok('GET', '/api/permissions')).permissions.some((p) => p.key === 'deploy'));
    assert.equal((await s.api('DELETE', '/api/permissions/edit', undefined, USER)).body.code, 'CONFLICT');
  });

  it('inherited names are refused as perms, includes and needs', async () => {
    assert.equal((await s.api('PATCH', '/api/agents/w', { perms: ['edit', 'constructor'] }, USER)).status, 400);
    assert.equal((await s.api('POST', '/api/permissions', { key: 'b2', kind: 'bundle', name: 'b', includes: ['constructor'] }, USER)).status, 400);
    assert.equal((await s.api('POST', '/api/permissions', { key: 'n2', kind: 'verbal', name: 'n', brief: 'x', needs: ['toString'] }, USER)).status, 400);
    assert.equal((await s.api('PATCH', '/api/permissions/toString', { name: 'x' }, USER)).body.code, 'NOT_FOUND');
    assert.equal((await s.api('DELETE', '/api/permissions/constructor', undefined, USER)).body.code, 'NOT_FOUND');
    assert.ok((await s.ok('GET', '/api/agents/w')).run, 'agents still build');
  });
});
