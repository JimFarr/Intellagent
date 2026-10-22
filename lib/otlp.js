'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// OTLP export (INT-432): the metric families GET /metrics renders (lib/prometheus.js), and one span per agent run
// from the run records (agent-stats.jsonl), pushed as OTLP/HTTP JSON to any collector. Off unless the manifest has
// metrics.otlp. Labels are the Prometheus ones, so no ticket text is sent; a span carries ticket ids, never titles.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const nanos = (ms) => String(BigInt(Math.round(ms)) * 1000000n);
const value = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: String(v) });
const attrs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([key, v]) => ({ key, value: value(v) }));

// families: [{ name, type: gauge | counter | histogram, help, samples: [[suffix, labels, value]] }]
function metricsBody(families, { now, start, resource }) {
  const time = nanos(now);
  const from = nanos(start);
  const metrics = families.map(({ name, type, help, samples }) => {
    if (type === 'histogram') {
      // the samples are Prometheus' flat rows: cumulative _bucket rows (le), _sum and _count per label set
      const points = new Map();
      for (const [suffix, l, v] of samples) {
        const { le, ...rest } = l;
        const key = JSON.stringify(rest);
        if (!points.has(key)) points.set(key, { attributes: attrs(rest), bounds: [], cum: [], sum: 0, count: 0 });
        const p = points.get(key);
        if (suffix === '_bucket') { if (le !== '+Inf') p.bounds.push(Number(le)); p.cum.push(v); } else if (suffix === '_sum') p.sum = v; else p.count = v;
      }
      const dataPoints = [...points.values()].map((p) => ({
        attributes: p.attributes, startTimeUnixNano: from, timeUnixNano: time, count: String(p.count), sum: p.sum,
        explicitBounds: p.bounds, bucketCounts: p.cum.map((c, i) => String(c - (i ? p.cum[i - 1] : 0))),
      }));
      return { name, description: help, histogram: { aggregationTemporality: 2, dataPoints } };
    }
    const dataPoints = samples.filter(([, , v]) => Number.isFinite(v)).map(([, l, v]) => ({
      attributes: attrs(Object.fromEntries(Object.entries(l).map(([k, x]) => [k, String(x)]))), timeUnixNano: time, asDouble: v,
      ...(type === 'counter' ? { startTimeUnixNano: from } : {}),
    }));
    // counters are cumulative totals from board state (they survive a restart): CUMULATIVE (2), monotonic
    return type === 'counter'
      ? { name, description: help, sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints } }
      : { name, description: help, gauge: { dataPoints } };
  });
  return { resourceMetrics: [{ resource, scopeMetrics: [{ scope: { name: 'intellagent' }, metrics }] }] };
}

// One run record (lib/agents/stats.js) as a span, or null when it has no times.
function spanOf(r) {
  const start = Date.parse(r?.startedAt);
  const end = Date.parse(r?.endedAt);
  if (typeof r?.agent !== 'string' || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const t = r.tokens || {};
  return {
    traceId: crypto.randomBytes(16).toString('hex'), spanId: crypto.randomBytes(8).toString('hex'),
    name: 'agent.run', kind: 1, startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(Math.max(start, end)),
    attributes: attrs({
      'intellagent.agent': r.agent, 'intellagent.result': r.result, 'intellagent.kind': r.kind,
      'intellagent.items': Array.isArray(r.items) ? r.items.join(',') : null,
      'intellagent.reasons': Array.isArray(r.reasons) ? r.reasons.join(',') : r.why, 'intellagent.writes': r.writes,
      'intellagent.cost_usd': r.cost, 'gen_ai.system': r.provider, 'gen_ai.request.model': r.model,
      'gen_ai.usage.input_tokens': t.input, 'gen_ai.usage.output_tokens': t.output,
      'gen_ai.usage.cache_read_input_tokens': t.cacheRead, 'gen_ai.usage.cache_creation_input_tokens': t.cacheWrite,
    }),
    status: r.result === 'ok' ? { code: 1 } : { code: 2, message: String(r.result || 'failed') },
  };
}

// The run records appended since the last export. The first look skips what is already there: only runs that end
// from now on are sent, so a restart never sends old runs again.
function createRunTail(file) {
  let offset = null;
  return {
    read() {
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* no runs yet */ }
      if (offset === null) offset = size;
      // shortcut: a roll of the live file (every ~17k runs) loses the runs written since the last export; read the rolled file's tail if that matters
      if (size < offset) offset = 0;
      if (size === offset) return { records: [], to: offset };
      const buf = Buffer.alloc(size - offset);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
      const end = buf.lastIndexOf(10) + 1; // a line still being written goes next time
      const records = [];
      for (const l of buf.subarray(0, end).toString('utf8').split('\n')) { if (l) try { records.push(JSON.parse(l)); } catch { /* torn line */ } }
      return { records, to: offset + end };
    },
    commit(to) { offset = to; },
  };
}

// OTEL_EXPORTER_OTLP_HEADERS: "key=value,key2=value2" (values URL-encoded), the standard place for a collector's token
function parseHeaders(s) {
  const out = {};
  for (const pair of String(s || '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

// config: true | { endpoint?, intervalSeconds? }. families(): what GET /metrics would render now.
function createOtlpExport({ config, dataDir, families, version, env = process.env, log = console.warn }) {
  const c = config && typeof config === 'object' ? config : {};
  const endpoint = String(c.endpoint || env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318').replace(/\/+$/, '');
  const intervalMs = Math.max(1, Number(c.intervalSeconds) || 60) * 1000;
  const headers = { ...parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS), 'content-type': 'application/json' };
  const resource = { attributes: attrs({ 'service.name': 'intellagent', 'service.version': version }) };
  const start = Date.now();
  const tail = createRunTail(path.join(dataDir, 'agent-stats.jsonl'));
  tail.read(); // mark where the runs stand now

  async function post(kind, body) {
    const r = await fetch(`${endpoint}/v1/${kind}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`the collector answered ${r.status} to /v1/${kind}`);
  }
  // Spans are marked sent only once the collector took them, so a collector that is down gets them later.
  async function once(now = Date.now()) {
    await post('metrics', metricsBody(families(), { now, start, resource }));
    const { records, to } = tail.read();
    const spans = records.map(spanOf).filter(Boolean);
    if (spans.length) await post('traces', { resourceSpans: [{ resource, scopeSpans: [{ scope: { name: 'intellagent' }, spans }] }] });
    tail.commit(to);
  }
  // for setInterval: never throws (a throw in a timer ends the board), and says so once when it fails and once when it is back
  // One export at a time: two in flight would read the same runs before either marks them sent.
  let failing = false;
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      await once();
      if (failing) log(`OTLP export to ${endpoint} works again`);
      failing = false;
    } catch (e) {
      if (!failing) log(`OTLP export to ${endpoint} failed: ${e.message} (retried every ${intervalMs / 1000} s)`);
      failing = true;
    } finally { busy = false; }
  }
  return { once, tick, endpoint, intervalMs };
}

module.exports = { createOtlpExport, metricsBody, spanOf, createRunTail, parseHeaders };
