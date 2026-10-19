'use strict';
// Warm sessions by need (INT-404): a keep-alive session stays only while it pays.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { warmDecision, typicalGap } = require('../lib/agents/warm');
const { DEFAULTS } = require('../lib/agents/config');
const { startServer, USER } = require('./helpers');

const NOW = Date.parse('2026-10-20T09:00:00Z');
const MIN = 60_000;
const starts = (...minsAgo) => minsAgo.map((m) => new Date(NOW - m * MIN).toISOString());
const auto = { enabled: true, keepAlive: 'auto' };
const decide = (def, s, o = {}) => warmDecision(def, DEFAULTS, { turns: 1, context: 30_000, floor: 30_000, runs: [], ...s }, { ok: true, paused: false, nowMs: NOW, ...o });

describe('warm rules', () => {
  it('the typical gap is the median of the last few, so one long pause does not decide it', () => {
    assert.equal(typicalGap(starts(10, 8, 6, 4, 2)), 2 * MIN);
    assert.equal(typicalGap(starts(300, 8, 6, 4, 2)), 2 * MIN);
    assert.equal(typicalGap(starts(2)), null);
  });
  it('auto keeps a frequent waker warm until the cache would lapse', () => {
    const d = decide(auto, { runs: starts(8, 6, 4, 2, 0) });
    assert.equal(d.keep, true);
    assert.equal(Date.parse(d.until) - NOW, DEFAULTS.cacheTtlMinutes * MIN);
    assert.match(d.why, /every 2 min/);
  });
  it('auto lets a rare waker start fresh: its cache would be gone anyway', () => {
    const d = decide(auto, { runs: starts(90, 60, 30, 0) });
    assert.equal(d.keep, false);
    assert.match(d.why, /every 30 min and the cache lasts 5/);
  });
  it('auto ends a session whose context grew past warmFactor × a fresh start', () => {
    assert.equal(decide(auto, { runs: starts(4, 2, 0), context: 80_000 }).keep, true);
    const d = decide(auto, { runs: starts(4, 2, 0), context: 100_000 });
    assert.equal(d.keep, false);
    assert.match(d.why, /3\.3× a fresh start/);
    assert.equal(decide({ ...auto, warmFactor: 4 }, { runs: starts(4, 2, 0), context: 100_000 }).keep, true);
  });
  it('a new agent is kept warm until it has a pattern (the idle timer still ends it)', () => {
    assert.equal(decide(auto, { runs: starts(0) }).keep, true);
  });
  it('every mode: a failed turn, a paused agent, too many turns or too big a context end it; plain keep-alive ignores the gaps', () => {
    const keep = { enabled: true, keepAlive: true };
    assert.equal(decide(keep, { runs: starts(90, 60, 30, 0) }).keep, true, 'keepAlive: true keeps it, as before');
    assert.equal(decide(keep, {}, { ok: false }).keep, false);
    assert.equal(decide(keep, {}, { paused: true }).keep, false);
    assert.equal(decide(keep, { turns: DEFAULTS.recycleAfterRuns }).keep, false);
    assert.equal(decide(keep, { context: DEFAULTS.recycleAboveTokens + 1 }).keep, false);
    assert.equal(decide({ ...keep, warm: 'auto' }, { runs: starts(90, 60, 30, 0) }).keep, false, '"warm": "auto" on a stream run');
  });
});

describe('warm sessions on a real board', () => {
  const FAKE = path.join(__dirname, 'fake-agent.js');
  const run = (...args) => `node "${FAKE}" ${args.join(' ')}`;
  const B = '/api/boards/main';
  const until = async (f, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`timed out: ${what}`); };
  it('auto: quick wakes share a session; idle past the cache it ends, and the next wake starts fresh', async () => {
    const fast = { settleSeconds: 0.2, retrySeconds: 0.2, throttleMinutes: 0 };
    // a cache of 15 seconds, so the idle end comes within the test
    const s = await startServer({ agents: { defaults: fast, agents: { keeper: { role: 'builder', run: run('stream'), keepAlive: 'stream-json', warm: 'auto', cacheTtlMinutes: 0.25, throttleMinutes: 0 } } } });
    const state = () => s.ok('GET', '/api/agents/keeper', undefined, USER);
    const turns = async (id) => (await s.ok('GET', `${B}/items/${id}`, undefined, USER)).comments.filter((c) => c.author.name === 'keeper' && c.body.startsWith('turn')).map((c) => c.body);
    try {
      const t = await s.ok('POST', `${B}/items`, { title: 'warm', column: 'Backlog' }, USER);
      for (let n = 1; n <= 2; n++) {
        await s.ok('POST', `${B}/items/${t.id}/comments`, { body: `@keeper wake ${n}` }, USER);
        await until(async () => (await turns(t.id)).length === n, 30000, `turn ${n}`);
        await until(async () => (await state()).status === 'idle', 30000, 'idle');
      }
      const [a, b] = await turns(t.id);
      assert.match(a, /turn 1 in/);
      assert.match(b, /turn 2 in/, 'a quick second wake is a warm turn');
      const warm = (await state()).session;
      assert.equal(warm.warm.keep, true);
      await until(async () => (await state()).session === null, 45000, 'the idle session ends once the cache would have lapsed');
      assert.match((await state()).lastWarm.why, /^idle for the cache's/);
      await s.ok('POST', `${B}/items/${t.id}/comments`, { body: '@keeper wake 3' }, USER);
      await until(async () => (await turns(t.id)).length === 3, 30000, 'turn 3');
      assert.match((await turns(t.id))[2], /turn 1 in/, 'and the next wake starts fresh');
    } finally { await s.stop(); }
  });
});
