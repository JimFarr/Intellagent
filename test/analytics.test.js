// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// GET /api/analytics (INT-311): derived from agent.status events and agent-stats.jsonl, live and rolled files.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { startServer } = require('./helpers');
const { createAnalytics, logFiles } = require('../lib/analytics');

const H = 3_600_000;
const NOW = Date.parse('2026-10-10T00:00:00Z');
const FROM = NOW - 24 * H; // days: 1
const iso = (ms) => new Date(ms).toISOString();
const status = (agent, s, at, extra = {}) => ({ seq: 1, ts: iso(at), type: 'agent.status', agent, status: s, ...extra });
const record = (agent, end, more = {}) => ({
  agent, model: 'opus', provider: 'anthropic', startedAt: iso(end - 600_000), endedAt: iso(end), why: 'work.pending',
  items: [], code: 0, result: 'ok', tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, cost: null,
  tools: null, commands: null, ...more,
});
const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

// A data folder with an events log and a stats log, each rolled once inside the window and once or twice before it.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-analytics-'));
  const w = (f, rows) => fs.writeFileSync(path.join(dir, f), jsonl(rows));
  w(`events-${FROM - 72 * H}.jsonl`, [status('old', 'running', FROM - 80 * H)]); // too old: never read
  w(`events-${FROM - 2 * H}.jsonl`, [status('a', 'running', FROM - 6 * H), status('a', 'idle', FROM - 5 * H)]);
  w(`events-${FROM + 6 * H}.jsonl`, [
    status('a', 'running', FROM + 2 * H, { lastRun: { events: 3 } }),
    { seq: 2, ts: iso(FROM + 2.5 * H), type: 'comment.added', body: 'mentions "agent.status" in text' },
    status('a', 'idle', FROM + 3 * H),
  ]);
  w('events.jsonl', [
    status('a', 'paused', FROM + 20 * H),
    '{"seq":9,"ts":"2026-10-09T21:00:00Z","type":"agent.status","agent":"a","sta', // torn line
    status('b', 'running', FROM + 23 * H, { lastRun: { events: 1 } }),
    status('a', 'idle', NOW + H), // after `now`: ignored
  ]);
  w(`agent-stats-${FROM - H}.jsonl`, [record('a', FROM - 2 * H, { cost: 9 })]); // ended before the window
  w('agent-stats.jsonl', [
    record('a', FROM + 3 * H, { items: ['INT-1', 'INT-2'], cost: 0.4, tools: { Bash: 2, Edit: 1 }, commands: ['git', 'npm', 'git'] }),
    record('a', FROM + 4 * H, { items: ['INT-1'], result: 'failed', code: 1, tokens: null }),
    record('b', FROM + 23.5 * H, { items: ['INT-2'], model: 'haiku', cost: 0.1, tools: { Read: 4 } }),
  ]);
  return dir;
}

describe('analytics: the pieces', () => {
  it('reads the rolled files in the window, the newest one before it, and the live one; skips older ones', () => {
    const dir = fixture();
    assert.deepEqual(logFiles(dir, 'events', FROM).map((f) => path.basename(f)),
      [`events-${FROM - 2 * H}.jsonl`, `events-${FROM + 6 * H}.jsonl`, 'events.jsonl']);
    assert.deepEqual(logFiles(dir, 'agent-stats', FROM).map((f) => path.basename(f)),
      [`agent-stats-${FROM - H}.jsonl`, 'agent-stats.jsonl']);
    assert.deepEqual(logFiles(path.join(dir, 'missing'), 'events', FROM), [], 'no folder: nothing');
  });

  it('time in each state, queue depth, runs, tokens, cost by model, tools and commands per agent', () => {
    const r = createAnalytics({ dataDir: fixture() })({ days: 1, now: NOW });
    assert.equal(r.from, iso(FROM));
    assert.deepEqual(r.agents.map((a) => a.agent), ['a', 'b'], '"old" is in a file that rolled before the window');
    const [a, b] = r.agents;
    // a was idle when the window opened (known from the file that rolled before it)
    assert.deepEqual(a.states, { idle: 19 * H, running: H, paused: 4 * H });
    assert.equal(a.unknownMs, 0);
    assert.deepEqual(b.states, { running: H });
    assert.equal(b.unknownMs, 23 * H, 'before its first state in the window, b is unknown');
    assert.deepEqual(a.queue, [{ at: iso(FROM + 2 * H), status: 'running', depth: 3 }]);
    assert.deepEqual(a.runs, { count: 2, ok: 1, failed: 1, timeout: 0, stopped: 0, limited: 0, ms: 1_200_000 });
    assert.equal(a.cost, 0.4);
    assert.equal(a.unpriced, 1, 'the failed run has no cost: counted, never taken as 0');
    assert.deepEqual(a.tokens, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
    assert.equal(a.models.opus.runs, 2);
    assert.deepEqual(a.tools, [{ name: 'Bash', count: 2 }, { name: 'Edit', count: 1 }]);
    assert.equal(a.toolsUnknown, 1);
    assert.deepEqual(a.commands, [{ name: 'git', count: 2 }, { name: 'npm', count: 1 }]);
    assert.equal(b.models.haiku.cost, 0.1);
    assert.deepEqual(r.totals, { runs: 3, tokens: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 }, cost: 0.5, unpriced: 1 });
  });

  it('per ticket: a run woken for two tickets shares its cost between them, so tickets add up to the total', () => {
    const r = createAnalytics({ dataDir: fixture() })({ days: 1, now: NOW });
    const t = Object.fromEntries(r.tickets.map((x) => [x.id, x]));
    assert.deepEqual(r.tickets.map((x) => x.id), ['INT-2', 'INT-1'], 'most expensive first');
    assert.equal(t['INT-1'].runs, 2);
    assert.equal(t['INT-1'].cost, 0.2);
    assert.equal(t['INT-1'].unpriced, 1);
    assert.equal(t['INT-1'].shared, 1);
    assert.equal(t['INT-2'].cost, 0.3);
    assert.deepEqual(t['INT-2'].agents, ['a', 'b']);
    assert.equal(t['INT-1'].tokens.input, 50, 'half of the shared run; the failed one reported none');
  });

  it('?agent= narrows agents and tickets to that agent', () => {
    const r = createAnalytics({ dataDir: fixture() })({ days: 1, now: NOW, agent: 'b' });
    assert.deepEqual(r.agents.map((a) => a.agent), ['b']);
    assert.deepEqual(r.tickets.map((x) => [x.id, x.cost]), [['INT-2', 0.1]]);
    assert.equal(r.totals.cost, 0.1);
  });
});

describe('analytics: segments and suggestions (INT-336)', () => {
  it('segments follow the states, clipped to the window, with the board\'s note; their time adds up to states', () => {
    const [a, b] = createAnalytics({ dataDir: fixture() })({ days: 1, now: NOW }).agents;
    assert.deepEqual(a.segments.map((s) => [s.from, s.to, s.status]), [
      [iso(FROM), iso(FROM + 2 * H), 'idle'], [iso(FROM + 2 * H), iso(FROM + 3 * H), 'running'],
      [iso(FROM + 3 * H), iso(FROM + 20 * H), 'idle'], [iso(FROM + 20 * H), iso(NOW), 'paused'],
    ]);
    assert.deepEqual(b.segments, [{ from: iso(FROM + 23 * H), to: iso(NOW), status: 'running' }]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-analytics-seg-'));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl([status('a', 'waiting', FROM + H, { waitingFor: 'usage limit', resumesAt: iso(FROM + 2 * H) }), status('a', 'idle', FROM + 2 * H)]));
    const w = createAnalytics({ dataDir: dir })({ days: 1, now: NOW }).agents[0];
    assert.equal(w.segments[0].note, 'usage limit');
    assert.equal(w.segments[1].note, undefined);
  });

  it('keeps only the newest 500 segments per agent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-analytics-cap-'));
    const rows = [];
    for (let i = 0; i < 700; i++) rows.push(status('a', i % 2 ? 'idle' : 'running', FROM + i * 60_000));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl(rows));
    const a = createAnalytics({ dataDir: dir })({ days: 1, now: NOW }).agents[0];
    assert.equal(a.segments.length, 500);
    assert.equal(a.segments.at(-1).to, iso(NOW));
  });

  it('suggests a rebalance when one agent is backed up while another is idle, and tickets waiting on the human', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-analytics-sug-'));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl([
      status('busy', 'queued', FROM + H), status('free', 'idle', FROM + H),
    ]));
    const waiting = [{ id: 'INT-9', since: iso(NOW - 3 * 24 * H) }, { id: 'INT-8', since: iso(NOW - 2 * H) }];
    const r = createAnalytics({ dataDir: dir })({ days: 1, now: NOW, waiting });
    assert.deepEqual(r.suggestions.map((s) => s.kind), ['rebalance', 'waiting-on-human']);
    assert.deepEqual(r.suggestions[0].agents, ['busy', 'free']);
    assert.match(r.suggestions[0].text, /busy spent 96% of the window queued.*free sat idle 96%/);
    assert.deepEqual(r.suggestions[1].items, ['INT-9'], 'only what has waited over a day');
    assert.deepEqual(createAnalytics({ dataDir: fixture() })({ days: 1, now: NOW }).suggestions, [], 'nothing to say: no suggestion');
  });
});

describe('analytics: cost per call', () => {
  // The worst a call reads: events.jsonl rolls only at start once past 20 MB, so the live file can be bigger; the
  // stats file rolls at 5 MB (about 17k runs). Most event lines are not agent.status and are skipped unparsed.
  it('a 25 MB events log and a full 5 MB stats file answer in well under a second', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-analytics-big-'));
    const agents = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const ev = [];
    let size = 0;
    for (let i = 0; size < 25e6; i++) {
      const at = FROM - 24 * H + i * 1000;
      const l = JSON.stringify(i % 50 ? { seq: i, ts: iso(at), type: 'comment.added', itemId: `INT-${i % 400}`, body: 'x'.repeat(300) }
        : status(agents[i % 8], ['running', 'idle', 'queued'][i % 3], at, { lastRun: { events: 2 } }));
      ev.push(l);
      size += l.length + 1;
    }
    fs.writeFileSync(path.join(dir, 'events.jsonl'), ev.join('\n') + '\n');
    const st = [];
    size = 0;
    for (let i = 0; size < 5e6; i++) {
      const l = JSON.stringify(record(agents[i % 8], FROM + (i % 86_400) * 1000, { items: [`INT-${i % 400}`], cost: 0.01, tools: { Bash: 3, Edit: 1 }, commands: ['git', 'npm'] }));
      st.push(l);
      size += l.length + 1;
    }
    fs.writeFileSync(path.join(dir, 'agent-stats.jsonl'), st.join('\n') + '\n');
    const analytics = createAnalytics({ dataDir: dir });
    const times = [];
    let r;
    for (let i = 0; i < 5; i++) { const s = process.hrtime.bigint(); r = analytics({ days: 30, now: NOW }); times.push(Number(process.hrtime.bigint() - s) / 1e6); }
    times.sort((x, y) => x - y);
    t.diagnostic(`analytics on ${ev.length} events and ${st.length} runs: median ${times[2].toFixed(0)} ms, max ${times[4].toFixed(0)} ms, reply ${(JSON.stringify(r).length / 1024).toFixed(0)} KB`);
    assert.equal(r.agents.length, 8);
    assert.equal(r.totals.runs, st.length);
    assert.ok(times[2] < 3000, `median ${times[2]} ms`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('GET /api/analytics', () => {
  it('anyone who can read the board reads it; a bad agent name is 400 with a hint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-test-'));
    fs.mkdirSync(path.join(dir, 'data'));
    const end = Date.now() - H;
    fs.writeFileSync(path.join(dir, 'data', 'agent-stats.jsonl'), jsonl([record('rocket', end, { items: ['T-1'], cost: 0.25 })]));
    const s = await startServer({ dir });
    try {
      const r = await s.ok('GET', '/api/analytics?days=7', undefined, { agent: 'someone' });
      assert.equal(r.days, 7);
      assert.equal(r.totals.cost, 0.25);
      assert.deepEqual(r.tickets.map((t) => t.id), ['T-1']);
      assert.equal((await s.ok('GET', '/api/analytics?days=500', undefined, { user: 'James' })).days, 90, 'capped at 90 days');
      assert.deepEqual((await s.ok('GET', '/api/analytics?agent=nobody')).agents, []);
      const bad = await s.api('GET', '/api/analytics?agent=a%20b');
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'BAD_REQUEST');
      assert.ok(bad.body.hint);
    } finally { await s.stop(); }
  });
});
