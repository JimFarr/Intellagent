// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Probation (INT-233): a new agent may only introduce itself until the human accepts it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { startServer, until, USER } = require('./helpers');

const FAKE = path.join(__dirname, 'fake-agent.js');
const run = (...args) => `node "${FAKE}" ${args.join(' ')}`;
const B = '/api/boards/main';
const fast = { settleSeconds: 0.2, retrySeconds: 0.2, throttleMinutes: 0 };
const agentState = (s, name) => s.ok('GET', `/api/agents/${name}`);
const as = (name) => ({ agent: name });
const agentsFile = (s) => JSON.parse(fs.readFileSync(path.join(s.dir, 'agents.json'), 'utf8')).agents;

describe('probation: a new agent may only introduce itself (INT-233)', () => {
  it('starts on probation in agents.json, runs read-only, and is asked once to introduce itself', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: { vet: { run: run('ok') } } } });
    try {
      const a = await s.ok('POST', '/api/agents', { name: 'newbie', role: 'builder', perms: ['edit', 'git'], listen: 'inbox' }, USER);
      assert.ok(a.probation.since);
      assert.deepEqual([a.perms, a.worktree, a.pickup], [['read'], null, false], 'its run reads and nothing more');
      const file = agentsFile(s);
      assert.ok(file.newbie.probation, "the human's file holds it: losing state never lifts it");
      assert.deepEqual(file.newbie.perms, ['edit', 'git'], 'what it will have is kept for when it is accepted');
      assert.equal((await agentState(s, 'vet')).probation, null, 'agents already in the file get none');
      const reqs = await s.ok('GET', `${B}/requests?to=newbie`);
      assert.equal(reqs.length, 1);
      assert.match(reqs[0].body, /^\[introduction\]/);
      // its one run answers that request and stops: nothing else wakes it
      await until(async () => (await agentState(s, 'newbie')).lastRun?.endedAt, 8000, 'the introduction run');
      await until(async () => (await agentState(s, 'newbie')).status === 'idle', 4000, 'idle');
      const runs = (await agentState(s, 'newbie')).runsLastHour;
      const it1 = await s.ok('POST', `${B}/items`, { title: 'for the newcomer', column: 'Backlog' }, USER);
      await s.ok('POST', `${B}/items/${it1.id}/comments`, { body: '@newbie please look' }, USER);
      await s.ok('PATCH', `${B}/items/${it1.id}`, { assignee: 'newbie' }, USER);
      await new Promise((r) => setTimeout(r, 1000));
      const after = await agentState(s, 'newbie');
      assert.deepEqual([after.runsLastHour, after.queued], [runs, 0], 'a mention or an assignment starts no run on probation');
    } finally { await s.stop(); }
  });

  it('answers 409 PROBATION to every write off the allow-list, lets the allowed ones through, and survives a restart', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: { vet: { run: run('ok') } } } });
    let s2;
    try {
      await s.ok('POST', '/api/agents', { name: 'newbie', role: 'builder' }, USER);
      const t = await s.ok('POST', `${B}/items`, { title: 'closed to the newcomer', column: 'Backlog' }, USER);
      const refused = [
        ['POST', `${B}/items`, { title: 'x', column: 'Backlog' }],
        ['POST', `${B}/items/${t.id}/comments`, { body: 'hello' }],
        ['POST', `${B}/items/${t.id}/comments`, { body: 'hello', intro: true }], // no ticket was named for it
        ['POST', `${B}/items/${t.id}/start`, {}],
        ['POST', `${B}/items/${t.id}/lease`, {}],
        ['PATCH', `${B}/items/${t.id}`, { priority: 'High' }],
        ['POST', `${B}/items/${t.id}/reactions`, { emoji: '+1' }],
        ['POST', `${B}/items/${t.id}/attention`, { reason: 'may I?' }],
        ['POST', `${B}/digest`, { summary: 'hi' }],
        ['POST', `${B}/master`, {}],
        ['POST', `${B}/requests`, { body: 'hello', to: 'vet' }],
        ['POST', '/api/profiles/me/memory', { text: 'a note' }],
        ['POST', '/api/subscriptions', { filter: { for: 'newbie' } }],
        ['DELETE', `${B}/items/${t.id}/lease`, undefined],
      ];
      for (const [m, p, b] of refused) {
        const r = await s.api(m, p, b, as('newbie'));
        assert.deepEqual([r.status, r.body.code], [409, 'PROBATION'], `${m} ${p}`);
      }
      // allowed: reads, its own profile, the reply to the request that asked it
      assert.equal((await s.api('GET', `${B}/brief`, undefined, as('newbie'))).status, 200);
      assert.equal((await s.api('PATCH', '/api/profiles/me', { description: 'I review code' }, as('newbie'))).status, 200);
      const asked = (await s.ok('GET', `${B}/requests?to=newbie`))[0];
      assert.equal((await s.api('POST', `${B}/requests/${asked.id}/reply`, { body: 'I am newbie. I read; I do not edit.', done: true }, as('newbie'))).status, 200);
      // not a request addressed to it
      const other = await s.ok('POST', `${B}/requests`, { body: 'something', to: 'vet' }, USER);
      assert.equal((await s.api('POST', `${B}/requests/${other.id}/reply`, { body: 'let me answer', done: true }, as('newbie'))).body.code, 'PROBATION');
      // a restart does not lift it, and does not ask again
      await s.stop({ keep: true });
      s2 = await startServer({ dir: s.dir });
      assert.ok((await agentState(s2, 'newbie')).probation, 'still on probation after a restart');
      assert.equal((await s2.api('POST', `${B}/items`, { title: 'x', column: 'Backlog' }, as('newbie'))).body.code, 'PROBATION');
      assert.equal((await s2.ok('GET', `${B}/requests?to=newbie`)).length, 1, 'asked once, not again at every start');
    } finally { await (s2 || s).stop(); }
  });

  it('an introduction comment on the ticket the human named mentions nobody', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: { vet: { run: run('ok') } } } });
    try {
      const t = await s.ok('POST', `${B}/items`, { title: 'introductions', column: 'Backlog' }, USER);
      const other = await s.ok('POST', `${B}/items`, { title: 'not this one', column: 'Backlog' }, USER);
      await s.ok('POST', '/api/agents', { name: 'newbie', role: 'builder', introTicket: t.id }, USER);
      assert.equal((await s.api('POST', `${B}/items/${other.id}/comments`, { body: 'hi', intro: true }, as('newbie'))).body.code, 'PROBATION');
      assert.equal((await s.api('POST', `${B}/items/${t.id}/comments`, { body: 'no flag' }, as('newbie'))).body.code, 'PROBATION');
      const { seq } = await s.ok('GET', '/api/app');
      await s.ok('POST', `${B}/items/${t.id}/comments`, { body: 'Hello. @vet please take a look, I am new.', intro: true }, as('newbie'));
      const ev = (await s.ok('GET', `/api/events?since=${seq}&types=comment.added`)).events.at(-1);
      assert.ok(!(ev.recipients || []).includes('vet'), 'the mention is text: it alerts nobody');
      await new Promise((r) => setTimeout(r, 800));
      assert.equal((await agentState(s, 'vet')).queued, 0);
    } finally { await s.stop(); }
  });

  it('only the human lifts it, sending it back keeps it, and a re-added name starts again', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: { boss: { run: run('ok'), enabled: false, grants: ['agents.manage', 'agents.control'] } } } });
    try {
      await s.ok('POST', '/api/agents', { name: 'newbie', role: 'builder', perms: ['edit', 'git'] }, USER);
      // the probationer is stopped at the gate (409), the manager by the route (403): neither lifts it
      for (const [who, status, code] of [['newbie', 409, 'PROBATION'], ['boss', 403, 'HUMAN_ONLY']]) {
        const r = await s.api('POST', '/api/agents/newbie/accept', {}, as(who));
        assert.deepEqual([r.status, r.body.code], [status, code], `${who} cannot accept`);
      }
      assert.equal((await s.api('POST', '/api/agents/newbie/return', { note: 'x' }, as('boss'))).status, 403);
      const m = await s.api('PATCH', '/api/agents/newbie', { probation: null }, as('boss'));
      assert.deepEqual([m.status, m.body.code], [403, 'NOT_DELEGABLE'], 'probation is not a key a manager may change');
      await s.api('PATCH', '/api/agents/newbie', { role: 'reviewer' }, as('boss'));
      assert.ok((await agentState(s, 'newbie')).probation, "a manager's role change never clears it");
      // sent back: still on probation, asked again, with the note
      const back = await s.ok('POST', '/api/agents/newbie/return', { note: 'say what you will not do' }, USER);
      assert.ok(back.probation.returned.note);
      const reqs = await s.ok('GET', `${B}/requests?to=newbie`);
      assert.equal(reqs.length, 2);
      assert.ok(reqs.some((r) => /say what you will not do/.test(r.body)));
      // accepted: it works like any agent, with its own permissions
      const ok = await s.ok('POST', '/api/agents/newbie/accept', {}, USER);
      assert.equal(ok.probation, null);
      assert.ok(!agentsFile(s).newbie.probation);
      assert.match((await agentState(s, 'newbie')).run, /^claude -p .*acceptEdits/);
      assert.equal((await s.api('POST', `${B}/items`, { title: 'now it may', column: 'Backlog' }, as('newbie'))).status, 201);
      assert.equal((await s.api('POST', '/api/agents/newbie/accept', {}, USER)).status, 409, 'nothing left to accept');
      // removed and added again under the same name: probation again
      await s.ok('DELETE', '/api/agents/newbie', undefined, USER);
      assert.ok((await s.ok('POST', '/api/agents', { name: 'newbie', role: 'builder' }, USER)).probation);
    } finally { await s.stop(); }
  });

  it("a probationer's run has read only: no edit, test, git, commands, worktree or keep-alive, whatever the file lists", async () => {
    const s = await startServer({ agents: { defaults: { ...fast, run: null }, agents: {
      probe: { enabled: false, probation: { since: '2026-10-17T10:00:00.000Z' }, role: 'builder', perms: ['edit', 'test', 'git', 'web'], commands: ['npm run x'], keepAlive: true, pickup: 'all', worktree: true },
    } } });
    try {
      const a = await agentState(s, 'probe');
      assert.deepEqual([a.perms, a.worktree, a.keepAlive, a.pickup], [['read'], null, false, false]);
      assert.match(a.run, /--tools "Bash,Read,Grep,Glob"/);
      const allowed = a.run.replace(/--disallowedTools.*/, '');
      assert.ok(!/acceptEdits|npm run x|Edit|Write|git/.test(allowed), allowed);
    } finally { await s.stop(); }
  });

  it('a hand-written run is replaced while on probation, and comes back when it is accepted', async () => {
    const s = await startServer({ agents: { defaults: fast, agents: {
      own: { enabled: false, probation: { since: '2026-10-17T10:00:00.000Z' }, run: 'my-adapter --do-anything', role: 'builder' },
    } } });
    try {
      const a = await agentState(s, 'own');
      assert.match(a.run, /^claude -p .*--tools "Bash,Read,Grep,Glob"/);
      assert.ok(!a.run.includes('my-adapter'), 'not sandboxed on disk would mean it could do anything');
      await s.ok('POST', '/api/agents/own/accept', {}, USER);
      assert.equal((await agentState(s, 'own')).run, 'my-adapter --do-anything');
    } finally { await s.stop(); }
  });

  it('the CLI: agents add says the new agent is on probation, agents accept lifts it, and the line changes', async () => {
    const { spawnSync } = require('child_process');
    const { cleanEnv } = require('./helpers');
    const s = await startServer({ agents: { defaults: fast, agents: { vet: { run: run('ok') } } } });
    try {
      const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'intellagent.js'), ...args], {
        cwd: s.dir, env: cleanEnv({ INTELLAGENT_MANIFEST: path.join(s.dir, 'intellagent.manifest.json'), INTELLAGENT_URL: s.base }), encoding: 'utf8', input: '', timeout: 60000 });
      const add = cli('agents', 'add', 'fresh', '--role', 'reviewer');
      assert.equal(add.status, 0, add.stderr);
      assert.match(add.stdout, /"fresh" is on probation/);
      assert.match(add.stdout, /intellagent agents accept fresh/);
      assert.ok(agentsFile(s).fresh.probation, 'the file holds it');
      assert.ok(!/is on probation/.test(cli('agents', 'add', 'fresh', '--description', 'again').stdout), 'an existing name keeps its record and says nothing');
      await until(async () => (await agentState(s, 'fresh').catch(() => ({}))).probation, 8000, 'the board has read the file');
      const acc = cli('agents', 'accept', 'fresh');
      assert.equal(acc.status, 0, acc.stderr);
      assert.match(acc.stdout, /^fresh: \w+$/m, 'no "(on probation)" any more');
      assert.ok(!agentsFile(s).fresh.probation);
      const again = cli('agents', 'accept', 'fresh');
      assert.notEqual(again.status, 0, 'nothing left to accept');
      assert.match(cli('help').stdout, /accept NAME/);
    } finally { await s.stop(); }
  });
});
