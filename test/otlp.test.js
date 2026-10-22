// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// OTLP export (INT-432): off unless the manifest has metrics.otlp; then the /metrics families and one span per run
// are pushed to a collector as OTLP/HTTP JSON.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startServer, USER } = require('./helpers');
const { metricsBody, spanOf } = require('../lib/otlp');

// A stand-in collector: keeps every body it is sent, by path, with its headers.
async function collector() {
  const got = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => { got.push({ path: req.url, headers: req.headers, body: JSON.parse(body) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { got, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
const rec = (agent, more = {}) => JSON.stringify({ agent, model: 'opus', provider: 'anthropic', result: 'ok', startedAt: '2026-10-22T00:00:00Z', endedAt: '2026-10-22T00:02:00Z', items: ['T-1'], tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2 }, cost: 0.5, ...more }) + '\n';
const metric = (body, name) => body.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.name === name);
const attr = (p) => Object.fromEntries(p.attributes.map((a) => [a.key, Object.values(a.value)[0]]));

describe('OTLP export: the conversion', () => {
  it('maps gauges, counters (cumulative, monotonic) and histograms (per-bucket counts) from the /metrics families', () => {
    const body = metricsBody([
      { name: 'g', type: 'gauge', help: 'a gauge', samples: [['', { board: 'main' }, 3]] },
      { name: 'c_total', type: 'counter', help: 'a counter', samples: [['', {}, 7]] },
      { name: 'h', type: 'histogram', help: 'a histogram', samples: [
        ['_bucket', { agent: 'a', le: '10' }, 1], ['_bucket', { agent: 'a', le: '60' }, 3], ['_bucket', { agent: 'a', le: '+Inf' }, 4],
        ['_sum', { agent: 'a' }, 200], ['_count', { agent: 'a' }, 4]] },
    ], { now: 2000, start: 1000, resource: { attributes: [] } });
    const g = metric(body, 'g');
    assert.deepEqual(attr(g.gauge.dataPoints[0]), { board: 'main' });
    assert.equal(g.gauge.dataPoints[0].asDouble, 3);
    assert.equal(g.gauge.dataPoints[0].timeUnixNano, '2000000000');
    const c = metric(body, 'c_total').sum;
    assert.equal(c.aggregationTemporality, 2);
    assert.equal(c.isMonotonic, true);
    assert.equal(c.dataPoints[0].startTimeUnixNano, '1000000000');
    const h = metric(body, 'h').histogram.dataPoints;
    assert.equal(h.length, 1, 'one point per label set, le dropped');
    assert.deepEqual(attr(h[0]), { agent: 'a' });
    assert.deepEqual(h[0].explicitBounds, [10, 60]);
    assert.deepEqual(h[0].bucketCounts, ['1', '2', '1'], 'cumulative buckets become per-bucket counts');
    assert.equal(h[0].count, '4');
    assert.equal(h[0].sum, 200);
  });

  it('a run record becomes an agent.run span with its times, result, tickets and tokens; one with no times is skipped', () => {
    const s = spanOf(JSON.parse(rec('drax', { result: 'timeout' })));
    assert.equal(s.name, 'agent.run');
    assert.match(s.traceId, /^[0-9a-f]{32}$/);
    assert.match(s.spanId, /^[0-9a-f]{16}$/);
    assert.equal(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano), 120000000000n);
    const a = attr(s);
    assert.equal(a['intellagent.agent'], 'drax');
    assert.equal(a['intellagent.items'], 'T-1');
    assert.equal(a['gen_ai.request.model'], 'opus');
    assert.equal(a['gen_ai.usage.input_tokens'], '10');
    assert.deepEqual(s.status, { code: 2, message: 'timeout' });
    assert.equal(spanOf({ agent: 'drax' }), null);
  });
});

describe('OTLP export: on and off', () => {
  it('on: pushes the /metrics families and the runs that end after start to the collector, with the OTEL headers', async () => {
    const col = await collector();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-otlp-'));
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'agent-stats.jsonl'), rec('old'));
    const s = await startServer({ dir, manifest: { metrics: { otlp: { endpoint: `${col.url}/`, intervalSeconds: 1 } } }, env: { OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20otlp-secret' } });
    try {
      await s.ok('POST', '/api/boards/main/items', { title: 'SECRET-TITLE-otlp', column: 'Ready' }, USER);
      fs.appendFileSync(path.join(dir, 'data', 'agent-stats.jsonl'), rec('drax'));
      const m = await until(() => col.got.find((g) => g.path === '/v1/metrics' && metric(g.body, 'intellagent_tickets')?.gauge.dataPoints.some((p) => attr(p).column === 'Ready' && p.asDouble === 1)));
      assert.ok(m, 'metrics reached the collector');
      assert.equal(m.headers.authorization, 'Bearer otlp-secret');
      assert.equal(m.headers['content-type'], 'application/json');
      assert.ok(metric(m.body, 'intellagent_tickets_done_total').sum.isMonotonic);
      assert.ok(metric(m.body, 'intellagent_cycle_seconds').histogram);
      const res = attr(m.body.resourceMetrics[0].resource);
      assert.equal(res['service.name'], 'intellagent');
      const t = await until(() => col.got.find((g) => g.path === '/v1/traces'));
      assert.ok(t, 'a trace reached the collector');
      const spans = t.body.resourceSpans[0].scopeSpans[0].spans;
      assert.deepEqual(spans.map((x) => attr(x)['intellagent.agent']), ['drax'], 'only the run that ended after start');
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(col.got.filter((g) => g.path === '/v1/traces').length, 1, 'a run is sent once');
      assert.ok(!JSON.stringify(col.got).includes('SECRET'), 'no ticket text leaves the board');
    } finally { await s.stop(); await col.close(); }
  });

  it('off: with no metrics.otlp nothing is sent, even with OTEL_EXPORTER_OTLP_ENDPOINT set', async () => {
    const col = await collector();
    const s = await startServer({ manifest: { metrics: { prometheus: true } }, env: { OTEL_EXPORTER_OTLP_ENDPOINT: col.url } });
    try {
      await s.ok('POST', '/api/boards/main/items', { title: 'quiet', column: 'Ready' }, USER);
      await new Promise((r) => setTimeout(r, 2500)); // past the first export a board with OTLP on makes after 1 s
      assert.equal(col.got.length, 0);
    } finally { await s.stop(); await col.close(); }
  });
});
