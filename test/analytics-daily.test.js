'use strict';
// The daily cost series in GET /api/analytics (INT-362): per agent and for the total, one entry per UTC day of the window.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAnalytics } = require('../lib/analytics');

const H = 3_600_000;
const NOW = Date.parse('2026-10-10T12:00:00Z');
const run = (agent, endedAt, cost) => JSON.stringify({
  agent, model: 'opus', startedAt: new Date(Date.parse(endedAt) - 600_000).toISOString(), endedAt, why: 'work.pending',
  items: [], code: 0, result: 'ok', tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost, tools: null, commands: null,
});
function dataDir(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-daily-'));
  fs.writeFileSync(path.join(dir, 'agent-stats.jsonl'), `${rows.join('\n')}\n`);
  return dir;
}

describe('analytics: cost per agent per day (INT-362)', () => {
  const rows = [
    run('a', '2026-10-08T10:00:00Z', 0.5),
    run('a', '2026-10-08T11:00:00Z', 0.25),
    run('a', '2026-10-08T12:00:00Z', null), // no result: unpriced, never 0
    run('a', '2026-10-10T09:00:00Z', 1),
    run('b', '2026-10-09T23:59:00Z', null),
    run('b', '2026-10-10T01:00:00Z', 2),
  ];
  const r = createAnalytics({ dataDir: dataDir(rows) })({ days: 3, now: NOW });
  const a = r.agents.find((x) => x.agent === 'a');
  const b = r.agents.find((x) => x.agent === 'b');
  const brief = (d) => d.map((x) => [x.day, x.runs, x.cost, x.unpriced]);

  it('has one entry per UTC day of the window, oldest first, empty days included', () => {
    assert.deepEqual(a.daily.map((d) => d.day), ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']);
  });

  it('adds the priced runs of a day, counts the unpriced ones, and leaves a day with no cost null, never 0', () => {
    assert.deepEqual(brief(a.daily), [['2026-10-07', 0, null, 0], ['2026-10-08', 3, 0.75, 1], ['2026-10-09', 0, null, 0], ['2026-10-10', 1, 1, 0]]);
    assert.deepEqual(brief(b.daily), [['2026-10-07', 0, null, 0], ['2026-10-08', 0, null, 0], ['2026-10-09', 1, null, 1], ['2026-10-10', 1, 2, 0]]);
  });

  it('the total series adds the agents day by day, and agrees with the window total', () => {
    assert.deepEqual(brief(r.totals.daily), [['2026-10-07', 0, null, 0], ['2026-10-08', 3, 0.75, 1], ['2026-10-09', 1, null, 1], ['2026-10-10', 2, 3, 0]]);
    assert.equal(r.totals.cost, 3.75);
    assert.equal(r.totals.daily.reduce((n, d) => n + (d.cost || 0), 0), r.totals.cost);
  });

  it('?agent= narrows the series to that agent, and an empty folder gives an empty list, not an error', () => {
    const only = createAnalytics({ dataDir: dataDir(rows) })({ days: 3, now: NOW, agent: 'b' });
    assert.deepEqual(only.agents.map((x) => x.agent), ['b']);
    assert.equal(only.totals.cost, 2);
    const none = createAnalytics({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ia-daily-')) })({ days: 1, now: NOW });
    assert.deepEqual(none.agents, []);
    assert.equal(none.totals.daily.every((d) => d.runs === 0 && d.cost === null), true);
  });
});
