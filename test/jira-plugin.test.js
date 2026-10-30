// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// The Jira example plugin (INT-464): it installs through the host against the fake Jira, and its actions work.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startServer, USER } = require('./helpers');
const { fakeJira } = require('./fake-jira');

const FOLDER = path.join(__dirname, '..', 'examples', 'plugins', 'jira');

async function withJira(fn) {
  const j = fakeJira();
  await new Promise((r) => j.server.listen(0, '127.0.0.1', r));
  try { await fn(j, `http://127.0.0.1:${j.server.address().port}`); } finally { j.server.close(); }
}

test('jira example: installs from a folder, connects to the fake Jira and tests the connection', async () => {
  await withJira(async (j, url) => {
    const s = await startServer();
    try {
      const added = await s.ok('POST', '/api/plugins', { path: FOLDER }, USER);
      assert.strictEqual(added.state, 'off');
      assert.deepStrictEqual(added.actions.map((a) => a.id), ['move', 'comment', 'assign', 'create']);
      assert.deepStrictEqual(added.asks.secrets, ['password']);
      await s.ok('POST', '/api/plugins/jira/enable', { hash: added.hash }, USER);
      await s.ok('PUT', '/api/plugins/jira/connection', { values: { url, username: j.USER, password: 'wrong' } }, USER);
      assert.strictEqual((await s.ok('POST', '/api/plugins/jira/connection/test', {}, USER)).ok, false);
      await s.ok('PUT', '/api/plugins/jira/connection', { values: { password: j.PASSWORD } }, USER);
      assert.deepStrictEqual(await s.ok('POST', '/api/plugins/jira/connection/test', {}, USER), { ok: true, message: 'Signed in as Intellagent service' });
    } finally { await s.stop(); }
  });
});

test('jira example: move, comment, assign and create', async () => {
  await withJira(async (j, url) => {
    const proc = spawn(process.execPath, [path.join(FOLDER, 'index.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
    const waiting = new Map();
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)(m); }
    });
    let n = 0;
    const run = (action, inputs, ticket) => new Promise((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      proc.stdin.write(`${JSON.stringify({ id, type: 'run', action, inputs, ticket, connection: { url, username: j.USER, password: j.PASSWORD } })}\n`);
    });
    try {
      // the issue is the ticket's jira field, else a key in its title that is not the board's own id
      const byField = { id: 'INT-5', title: 'Fix login', fields: { jira: 'bet-1' } };
      const byTitle = { id: 'INT-6', title: 'INT-6 follows up BET-2', fields: {} };
      assert.strictEqual((await run('move', { status: 'In Progress' }, byField)).ok, true);
      assert.strictEqual(j.issues.get('BET-1').status, 'In Progress');
      assert.strictEqual((await run('move', { status: 'In QA' }, byTitle)).ok, true);
      const done = await run('move', { status: 'Done' }, byTitle);
      assert.strictEqual(done.ok, true, JSON.stringify(done));
      assert.strictEqual(j.issues.get('BET-2').status, 'Done');
      const stuck = await run('move', { status: 'In QA' }, byTitle); // Done only goes back to To Do
      assert.strictEqual(stuck.ok, false);
      assert.match(stuck.error, /can't go to/);
      assert.match((await run('comment', { text: 'x' }, { id: 'INT-7', title: 'no key', fields: {} })).error, /No Jira issue/);

      await run('comment', { text: '{id}: {title}' }, byField);
      assert.deepStrictEqual(j.issues.get('BET-1').comments, ['INT-5: Fix login']);
      await run('assign', { assignee: 'svc' }, byField);
      assert.strictEqual(j.issues.get('BET-1').assignee, 'svc');
      const made = await run('create', { project: 'bet', text: 'from {id}' }, byField);
      assert.strictEqual(made.result.issue, 'BET-3');
      assert.strictEqual(j.issues.get('BET-3').summary, 'Fix login');
      assert.strictEqual(j.issues.get('BET-3').type, 'Task');
    } finally { proc.kill(); }
  });
});
