// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// INT-343: an addressed comment its agent saw but never answered stays visible, and run logs outlive a fast agent.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { startServer, USER } = require('./helpers');
const { pruneLogs } = require('../lib/agents/runner');

const B = '/api/boards/main';
const as = (agent) => ({ agent });

describe('run logs outlive a fast agent (INT-343)', () => {
  const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');
  const make = (dir, ms) => { fs.writeFileSync(path.join(dir, `${stamp(ms)}.log`), 'x'); fs.writeFileSync(path.join(dir, `${stamp(ms)}.events.json`), '[]'); };
  const names = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.log')).length;

  it('keeps every log younger than a day however many there are; drops the old ones beyond the newest 20; keeps the events file with its log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-logs-'));
    try {
      const now = Date.parse('2026-10-17T12:00:00Z');
      for (let i = 0; i < 100; i++) make(dir, now - i * 5000); // 100 runs in the last ~8 minutes
      pruneLogs(dir, now);
      assert.equal(names(dir), 100, 'a busy agent keeps its last day, not its last 20');
      for (let i = 0; i < 30; i++) make(dir, now - 2 * 86400000 - i * 5000); // 30 runs two days ago
      pruneLogs(dir, now);
      assert.equal(names(dir), 100, 'the old ones are gone: they are beyond the newest 20 and older than a day');
      assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.events.json')).length, 100, 'events files go with their logs');
      // a quiet agent: only old logs, so the newest 20 stay
      const quiet = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-logs-'));
      for (let i = 0; i < 30; i++) make(quiet, now - 5 * 86400000 - i * 60000);
      pruneLogs(quiet, now);
      assert.equal(names(quiet), 20, 'the newest 20 are always kept');
      fs.rmSync(quiet, { recursive: true, force: true });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('seen, not answered (INT-343)', () => {
  it('shows on the card and in the agent\'s work once 👀 is on an addressed comment; clears when it answers; starts no run', async () => {
    // enabled: false, so nothing runs: the test plays the agent's part over the API
    const s = await startServer({ agents: { defaults: { settleSeconds: 0.2, throttleMinutes: 0 }, agents: { bot: { run: 'node -e 0', enabled: false } } } });
    try {
      const t = await s.ok('POST', `${B}/items`, { title: 'ask', column: 'Backlog' }, USER);
      const last = async () => (await s.ok('GET', `${B}/items/${t.id}`)).comments.at(-1);
      await s.ok('POST', `${B}/items/${t.id}/comments`, { body: '@bot please look' }, USER);
      const c = await last();
      const unanswered = async () => (await s.ok('GET', `${B}/items/${t.id}`)).unanswered || [];
      const replies = async () => (await s.ok('GET', `${B}/work?agent=bot`, undefined, as('bot'))).next.filter((n) => n.action === 'reply');
      assert.deepEqual(await unanswered(), [], 'not seen yet: still queued, nothing to mark');
      await s.ok('POST', `${B}/items/${t.id}/reactions`, { emoji: 'eyes', commentId: c.id }, as('bot'));
      const u = await unanswered();
      assert.deepEqual(u.map((x) => [x.commentId, x.agent]), [[c.id, 'bot']]);
      assert.equal((await replies()).length, 1, 'its work list names it');
      const work = await s.ok('GET', `${B}/work?agent=bot`, undefined, as('bot'));
      assert.equal(work.unanswered.length, 1);
      // someone else mentioned or a self-mention is no debt of bot's
      await s.ok('POST', `${B}/items/${t.id}/comments`, { body: 'no mention here' }, USER);
      const other = await last();
      await s.ok('POST', `${B}/items/${t.id}/reactions`, { emoji: 'eyes', commentId: other.id }, as('bot'));
      assert.equal((await unanswered()).length, 1, 'only addressed comments count');
      // a reaction other than 👀 answers; so does a later comment
      await s.ok('POST', `${B}/items/${t.id}/reactions`, { emoji: '+1', commentId: c.id }, as('bot'));
      assert.deepEqual(await unanswered(), []);
      await s.ok('DELETE', `${B}/items/${t.id}/reactions`, { emoji: '+1', commentId: c.id }, as('bot'));
      assert.equal((await unanswered()).length, 1);
      await s.ok('POST', `${B}/items/${t.id}/comments`, { body: 'on it' }, as('bot'));
      assert.deepEqual(await unanswered(), [], 'clears the moment the agent answers');
      assert.deepEqual(await replies(), []);
      // no run was started by any of this
      const bot = await s.ok('GET', '/api/agents/bot');
      assert.deepEqual([bot.runningSince, bot.lastRun, bot.history.length], [null, null, 0]);
    } finally { await s.stop(); }
  });
});
