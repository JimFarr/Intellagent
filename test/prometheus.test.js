// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// GET /metrics (INT-309): Prometheus text format, off until the manifest switches it on, a read-only token,
// counters that survive a restart, and no ticket text in any label.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { startServer, USER, cleanEnv } = require('./helpers');
const { createRunTotals } = require('../lib/prometheus');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'metrics-secret-token';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// The text format, strictly enough to catch a malformed line: HELP and TYPE before a family's samples, every sample
// `name{label="v",…} number`, histogram buckets cumulative. Returns the samples.
function parse(text) {
  assert.ok(text.endsWith('\n'), 'ends with a newline');
  const types = {};
  const samples = [];
  for (const line of text.split('\n').filter(Boolean)) {
    let m;
    if ((m = /^# HELP (\w+) .+$/.exec(line))) continue;
    if ((m = /^# TYPE (\w+) (counter|gauge|histogram)$/.exec(line))) { types[m[1]] = m[2]; continue; }
    m = /^(\w+?)(_bucket|_sum|_count)?(\{((?:\w+="(?:[^"\\]|\\.)*",?)*)\})? (-?\d+(?:\.\d+)?|NaN)$/.exec(line);
    assert.ok(m, `a sample line: ${line}`);
    const family = types[m[1] + (m[2] || '')] ? m[1] + (m[2] || '') : m[1];
    assert.ok(types[family] || types[m[1]], `${line} comes after its TYPE`);
    const labels = Object.fromEntries([...(m[4] || '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((x) => [x[1], x[2]]));
    samples.push({ name: m[1] + (m[2] || ''), labels, value: Number(m[5]), type: types[m[1]] || types[family] });
  }
  return samples;
}
const get = (samples, name, labels = {}) => samples.find((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))?.value;

async function scrape(s, token = TOKEN) {
  const r = await fetch(`${s.base}/metrics`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
}

// A board with metrics on and a metrics token (and a user token, to prove the metrics token opens nothing else).
async function board({ user = false, agents } = {}) {
  const dir = tmp('ia-prom-');
  fs.writeFileSync(path.join(dir, 'local.json'), JSON.stringify({ ...(user ? { userToken: 'user-secret' } : {}), metricsToken: TOKEN }));
  return startServer({ dir, agents, manifest: { metrics: { prometheus: true } } });
}

describe('GET /metrics: switch and token', () => {
  it('is off unless the manifest says metrics.prometheus, and says how to switch it on', async () => {
    const s = await startServer();
    try {
      const r = await s.api('GET', '/metrics');
      assert.equal(r.status, 404);
      assert.equal(r.body.code, 'NOT_FOUND');
      assert.match(r.body.hint, /"prometheus": true[\s\S]*intellagent token --metrics/);
    } finally { await s.stop(); }
  });

  it('needs the metrics token as a bearer: none, a wrong one and the user token are refused, with a hint', async () => {
    const s = await board({ user: true });
    try {
      for (const t of [null, 'wrong', 'user-secret']) {
        const r = await fetch(`${s.base}/metrics`, { headers: t ? { authorization: `Bearer ${t}` } : {} });
        assert.equal(r.status, 401, String(t));
        const b = await r.json();
        assert.equal(b.code, 'UNAUTHORIZED');
        assert.match(b.hint, /bearer|authorization|metrics/i);
      }
      const ok = await scrape(s);
      assert.equal(ok.status, 200);
      assert.equal(ok.type, 'text/plain; version=0.0.4; charset=utf-8');
    } finally { await s.stop(); }
  });

  it('with metrics on but no token issued, says to issue one', async () => {
    const s = await startServer({ manifest: { metrics: { prometheus: true } } });
    try {
      const r = await s.api('GET', '/metrics');
      assert.equal(r.status, 401);
      assert.match(r.body.hint, /intellagent token --metrics/);
    } finally { await s.stop(); }
  });

  it('the metrics token opens nothing else, and is never in the output', async () => {
    const s = await board({ user: true });
    try {
      const h = { authorization: `Bearer ${TOKEN}` };
      assert.equal((await fetch(`${s.base}/api/boards/main/items`, { method: 'POST', headers: { ...h, 'x-user': 'James', origin: s.base, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'nope' }) })).status, 401);
      const { text } = await scrape(s);
      assert.ok(!text.includes(TOKEN) && !text.includes('user-secret'), 'no token in the output');
    } finally { await s.stop(); }
  });

  it('intellagent token --metrics issues it (human only), keeps it on a second call, and --rotate replaces it', () => {
    const dir = tmp('ia-prom-cli-');
    const mp = path.join(dir, 'intellagent.manifest.json');
    fs.writeFileSync(mp, JSON.stringify({ port: 7999, dataDir: './data' }));
    const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'intellagent.js'), ...args], { cwd: dir, env: cleanEnv({ INTELLAGENT_MANIFEST: mp, ...env }), encoding: 'utf8' });
    const a = run(['token', '--metrics']);
    assert.equal(a.status, 0, a.stderr);
    const first = JSON.parse(fs.readFileSync(path.join(dir, 'local.json'), 'utf8')).metricsToken;
    assert.ok(first && a.stdout.includes(first), 'saved, and shown once for the scrape config');
    assert.match(run(['token', '--metrics']).stdout, /already has a metrics token/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'local.json'), 'utf8')).metricsToken, first);
    run(['token', '--metrics', '--rotate']);
    assert.notEqual(JSON.parse(fs.readFileSync(path.join(dir, 'local.json'), 'utf8')).metricsToken, first);
    assert.notEqual(run(['token', '--metrics'], { INTELLAGENT_AGENT: 'drax' }).status, 0, 'an agent cannot issue it');
  });
});

describe('GET /metrics: the numbers', () => {
  it('parses as the exposition format; counters only go up, and survive a restart; no ticket text in a label', async () => {
    let s = await board();
    const dir = s.dir;
    try {
      const before = parse((await scrape(s)).text);
      assert.equal(get(before, 'intellagent_up'), 1);
      assert.equal(get(before, 'intellagent_tickets_done_total', { board: 'main' }), 0);
      const a = await s.ok('POST', '/api/boards/main/items', { title: 'SECRET-TITLE-xyz needs "quotes"', column: 'Ready' }, USER);
      await s.ok('POST', `/api/boards/main/items/${a.id}/attention`, { reason: 'SECRET-QUESTION-abc' }, { agent: 'drax' });
      const mid = (await scrape(s)).text;
      assert.ok(!/SECRET/.test(mid), 'titles and question text never reach the output');
      const m = parse(mid);
      assert.equal(get(m, 'intellagent_tickets', { board: 'main', column: 'Ready' }), 1);
      assert.equal(get(m, 'intellagent_questions_open', { board: 'main', kind: 'question' }), 1);
      assert.ok(get(m, 'intellagent_question_oldest_seconds', { board: 'main' }) >= 0);
      assert.ok(get(m, 'intellagent_events_total') > get(before, 'intellagent_events_total'), 'events_total goes up');
      // reach the last column
      await s.ok('POST', `/api/boards/main/items/${a.id}/move`, { column: 'Done' }, USER);
      const after = parse((await scrape(s)).text);
      for (const x of after.filter((x) => x.type === 'counter')) {
        const prev = before.find((y) => y.name === x.name && JSON.stringify(y.labels) === JSON.stringify(x.labels));
        if (prev) assert.ok(x.value >= prev.value, `${x.name} only goes up`);
      }
      // worked out from the tickets as they stand, so they can step down: gauges, not counters
      for (const n of ['intellagent_reviews_decided', 'intellagent_landings', 'intellagent_idle_alarms']) {
        assert.ok(after.some((x) => x.name === n && x.type === 'gauge'), `${n} is a gauge`);
      }
      const done = get(after, 'intellagent_tickets_done_total', { board: 'main' });
      assert.equal(done, 1, 'a ticket in the last column counts as done');
      assert.equal(get(after, 'intellagent_cycle_seconds_count', { board: 'main' }), 1);
      assert.equal(get(after, 'intellagent_cycle_seconds_bucket', { board: 'main', le: '+Inf' }), 1);
      // a restart keeps them: they come from the board, not from memory
      await s.stop({ keep: true });
      s = await startServer({ dir, manifest: { metrics: { prometheus: true } } });
      const again = parse((await scrape(s)).text);
      assert.equal(get(again, 'intellagent_tickets_done_total', { board: 'main' }), 1, 'done survives a restart');
    } finally { await s.stop(); }
  });

  it('a scrape is cheap: the median of 20 on a board of 150 tickets (reported; bounded loosely so a busy machine does not fail it)', async (t) => {
    const s = await board();
    try {
      await Promise.all(Array.from({ length: 150 }, (_, i) => s.ok('POST', '/api/boards/main/items', { title: `ticket ${i}`, column: 'Ready' }, USER)));
      const ms = [];
      for (let i = 0; i < 20; i++) { const t0 = process.hrtime.bigint(); const r = await scrape(s); ms.push(Number(process.hrtime.bigint() - t0) / 1e6); assert.equal(r.status, 200); }
      ms.sort((a, b) => a - b);
      t.diagnostic(`scrape on 150 tickets: median ${ms[10].toFixed(2)} ms, slowest ${ms[19].toFixed(2)} ms (including the HTTP round trip)`);
      assert.ok(ms[10] < 50, `median ${ms[10]} ms`);
    } finally { await s.stop(); }
  });

  it('labels are bounded: only fixed words, board ids, column names, agent and model names', async () => {
    const s = await board();
    try {
      const m = parse((await scrape(s)).text);
      const keys = new Set(m.flatMap((x) => Object.keys(x.labels)));
      const allowed = new Set(['agent', 'board', 'build', 'column', 'delegated', 'kind', 'le', 'model', 'direction', 'level', 'provider', 'reason', 'result', 'state', 'status', 'verdict', 'version']);
      assert.deepEqual([...keys].filter((k) => !allowed.has(k)), [], 'no label outside the fixed set');
      assert.ok(m.length < 400, `a bounded number of series on an empty board (${m.length})`);
    } finally { await s.stop(); }
  });
});

describe('the Grafana dashboard (docs/grafana)', () => {
  it('is importable JSON whose queries use only metrics the board exposes, and covers flow, agents and the human', async () => {
    const dash = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'grafana', 'intellagent.json'), 'utf8'));
    const panels = dash.panels.filter((p) => p.type !== 'row');
    assert.equal(new Set(dash.panels.map((p) => p.id)).size, dash.panels.length, 'panel ids are unique');
    assert.deepEqual(dash.__inputs.map((i) => i.name), ['DS_PROMETHEUS']);
    const s = await board();
    try {
      const declared = new Set((await scrape(s)).text.split('\n').map((l) => /^# TYPE (\w+) /.exec(l)?.[1]).filter(Boolean));
      const used = new Set(panels.flatMap((p) => p.targets.flatMap((t) => [...t.expr.matchAll(/\bintellagent_\w+/g)].map((m) => m[0].replace(/_(bucket|sum|count)$/, '')))));
      for (const name of used) assert.ok(declared.has(name), `${name} is exposed`);
      for (const p of panels) for (const t of p.targets) assert.ok(t.expr.includes('intellagent_'), `${p.title} queries the board`);
    } finally { await s.stop(); }
    const titles = panels.map((p) => p.title).join('|');
    for (const want of ['Tickets per column', 'Done per day', 'Cycle time', 'Agent status', 'Runs by result', 'Queue per agent', 'Tokens per model', 'Estimated cost', 'Estimated cost per model', 'Usage-limit', 'Open questions', 'Oldest wait']) assert.ok(titles.includes(want), want);
  });
});

describe('run records, read incrementally', () => {
  const rec = (agent, result = 'ok', more = {}) => JSON.stringify({ agent, model: 'opus', result, startedAt: '2026-10-10T00:00:00Z', endedAt: '2026-10-10T00:02:00Z', tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2 }, ...more }) + '\n';

  it('counts runs, run time and tokens, reads only what was appended, and does not count a roll twice', () => {
    const dir = tmp('ia-prom-runs-');
    const live = path.join(dir, 'agent-stats.jsonl');
    const totals = createRunTotals(dir);
    assert.equal(totals().runs.size, 0, 'no file yet');
    fs.writeFileSync(live, rec('a') + rec('a', 'failed') + '{"agent":"a","torn');
    let t = totals();
    assert.deepEqual(t.runs.get('a'), { ok: 1, failed: 1 }, 'a torn line is left for later');
    assert.equal(t.dur.get('a').count, 2);
    assert.equal(t.dur.get('a').sum, 240);
    assert.deepEqual([...t.tokens.values()].map((x) => [x.agent, x.model, x.input, x.output, x.cacheRead, x.cacheWrite]), [['a', 'opus', 20, 10, 2, 4]]);
    fs.writeFileSync(live, rec('a') + rec('a', 'failed') + rec('b', 'limited'));
    t = totals();
    assert.deepEqual(t.runs.get('a'), { ok: 1, failed: 1 }, 'the first two were not read again');
    assert.deepEqual(t.runs.get('b'), { limited: 1 });
    // the live file rolls: its content moves to a rolled name and a new live file starts
    fs.renameSync(live, path.join(dir, 'agent-stats-1790000000000.jsonl'));
    fs.writeFileSync(live, rec('a'));
    t = totals();
    assert.deepEqual(t.runs.get('a'), { ok: 2, failed: 1 }, 'the roll is not counted twice');
    assert.deepEqual(t.runs.get('b'), { limited: 1 });
  });

  it('counts wakes by reason and runs that changed nothing; older records without them count as neither (INT-389)', () => {
    const dir = tmp('ia-prom-wakes-');
    fs.writeFileSync(path.join(dir, 'agent-stats.jsonl'),
      rec('a', 'ok', { reasons: ['decide'], writes: 3 }) + rec('a', 'ok', { reasons: ['comment.added'], writes: 0 })
      + rec('a', 'failed', { reasons: ['start'], writes: 0 }) + rec('a', 'ok', { why: 'item.assigned, comment.added' }));
    const t = createRunTotals(dir)();
    assert.deepEqual(t.wakes.get('a'), { decide: 1, 'comment.added': 2, start: 1, 'item.assigned': 1 }, 'an old record falls back to its event types');
    assert.equal(t.measured.get('a'), 2, 'finished runs with a write count');
    assert.equal(t.idle.get('a'), 1, 'one finished run changed nothing; a failed run is not idle');
  });

  it('shows in /metrics: wakes by reason, idle runs, and the open tickets nobody will touch (INT-389)', async () => {
    const dir = tmp('ia-prom-alerts-');
    fs.writeFileSync(path.join(dir, 'local.json'), JSON.stringify({ metricsToken: TOKEN }));
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'agent-stats.jsonl'), rec('drax', 'ok', { reasons: ['decide'], writes: 2 }) + rec('drax', 'ok', { reasons: ['comment.added'], writes: 0 }));
    const s = await startServer({ dir, manifest: { metrics: { prometheus: true } }, agents: { agents: { drax: { role: 'builder', enabled: false } } } });
    try {
      const orphan = await s.ok('POST', '/api/boards/main/items', { title: 'nobody owns this', column: 'Backlog' }, USER);
      await s.ok('POST', `/api/boards/main/items/${orphan.id}/move`, { column: 'Review' }, USER);
      await s.ok('POST', '/api/boards/main/items', { title: 'assigned to drax, who is off', column: 'Ready', assignee: 'drax' }, USER);
      const m = parse((await scrape(s)).text);
      assert.equal(get(m, 'intellagent_agent_wakes_total', { agent: 'drax', reason: 'decide' }), 1);
      assert.equal(get(m, 'intellagent_agent_wakes_total', { agent: 'drax', reason: 'comment.added' }), 1);
      assert.equal(get(m, 'intellagent_agent_measured_runs_total', { agent: 'drax' }), 2);
      assert.equal(get(m, 'intellagent_agent_idle_runs_total', { agent: 'drax' }), 1);
      // the Review ticket (unassigned, no question), and drax's: drax is switched off, so nobody will touch it either
      assert.equal(get(m, 'intellagent_tickets_unowned', { board: 'main' }), 2);
    } finally { await s.stop(); }
  });

  it('shows autonomy: finished tickets by how much a human stepped in, the interventions, churn, in flight and stuck (INT-393)', async () => {
    const dir = tmp('ia-prom-autonomy-');
    fs.writeFileSync(path.join(dir, 'local.json'), JSON.stringify({ metricsToken: TOKEN }));
    const s = await startServer({ dir, manifest: { metrics: { prometheus: true } }, agents: { agents: { groot: { role: 'builder', enabled: false } } } });
    const G = { agent: 'groot' };
    try {
      const flow = async (title, help) => {
        const it = await s.ok('POST', '/api/boards/main/items', { title, column: 'Ready' }, USER);
        await s.ok('POST', `/api/boards/main/items/${it.id}/start`, {}, G);
        if (help) await s.ok('POST', `/api/boards/main/items/${it.id}/comments`, { body: 'use the v2 endpoint' }, USER);
        await s.ok('POST', `/api/boards/main/items/${it.id}/review`, { summary: 'done', evidence: 'tests pass' }, G);
        await s.ok('POST', `/api/boards/main/items/${it.id}/review/decision`, { verdict: 'approve' }, USER);
        return it.id;
      };
      await flow('only approved', false);
      await flow('helped along', true);
      const wip = await s.ok('POST', '/api/boards/main/items', { title: 'in flight', column: 'Ready' }, USER);
      await s.ok('POST', `/api/boards/main/items/${wip.id}/start`, {}, G);
      const m = parse((await scrape(s)).text);
      const v = (name, labels) => get(m, name, { board: 'main', ...labels });
      assert.equal(v('intellagent_tickets_finished_by_autonomy', { level: 'approved' }), 1);
      assert.equal(v('intellagent_tickets_finished_by_autonomy', { level: 'helped' }), 1);
      assert.equal(v('intellagent_tickets_finished_by_autonomy', { level: 'autonomous' }), 0);
      assert.equal(v('intellagent_human_interventions', { kind: 'decision' }), 2, 'one per approval, however many events it made');
      assert.equal(v('intellagent_human_interventions', { kind: 'comment' }), 1);
      assert.equal(v('intellagent_human_interventions', { kind: 'move' }), 0, 'the approval moved it to Done: not a manual move');
      assert.equal(v('intellagent_ticket_moves', { direction: 'back' }), 0);
      assert.equal(v('intellagent_tickets_in_flight', {}), 1);
      assert.equal(v('intellagent_tickets_stuck', { reason: 'owner_quiet', state: 'sure' }), 0, 'just started: not stuck');
      assert.equal(v('intellagent_stuck_oldest_seconds', {}), 0);
    } finally { await s.stop(); }
  });

  it('shows in /metrics: runs by result, usage-limited runs, tokens by model', async () => {
    const dir = tmp('ia-prom-stats-');
    fs.writeFileSync(path.join(dir, 'local.json'), JSON.stringify({ metricsToken: TOKEN }));
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'agent-stats.jsonl'), rec('drax') + rec('drax', 'limited'));
    const s = await startServer({ dir, manifest: { metrics: { prometheus: true } } });
    try {
      const m = parse((await scrape(s)).text);
      assert.equal(get(m, 'intellagent_agent_runs_total', { agent: 'drax', result: 'ok' }), 1);
      assert.equal(get(m, 'intellagent_agent_runs_total', { agent: 'drax', result: 'limited' }), 1);
      assert.equal(get(m, 'intellagent_agent_usage_limited_total', { agent: 'drax' }), 1);
      assert.equal(get(m, 'intellagent_agent_tokens_total', { agent: 'drax', model: 'opus', kind: 'input' }), 20);
      assert.equal(get(m, 'intellagent_agent_run_seconds_count', { agent: 'drax' }), 2);
    } finally { await s.stop(); }
  });
});

describe('agent status (INT-426)', () => {
  it('every agent has a series for each of the eight statuses the Grafana panel maps, exactly one of them 1', async () => {
    const s = await board({ agents: { agents: { groot: { role: 'builder', enabled: false } } } });
    try {
      const rows = parse((await scrape(s)).text).filter((x) => x.name === 'intellagent_agent_status' && x.labels.agent === 'groot');
      const panel = ['idle', 'running', 'waiting', 'throttled', 'failed', 'paused', 'queued', 'retrying'];
      assert.deepEqual(panel.filter((st) => !rows.some((r) => r.labels.status === st)), [], 'a status the panel maps is never exported');
      assert.equal(rows.filter((r) => r.value === 1).length, 1);
    } finally { await s.stop(); }
  });
});
