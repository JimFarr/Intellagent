'use strict';
// Ticket triggers (INT-435): conditions on a card that wake an agent when they hold, buffered per agent. The rules
// (lib/alerts/triggers.js) and the sweep and routes on a real board.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/alerts/triggers');
const STUCK = require('../lib/alerts/stuck');
const { startServer, USER } = require('./helpers');

const NOW = Date.parse('2026-10-23T12:00:00Z');
const MIN = 60_000;
const B = '/api/boards/main';
const bad = (m) => { throw new Error(m); };
const trig = (when, over = {}) => ({ id: 'tr1', when: T.parseWhen(when, bad), priority: 'batch', at: new Date(NOW - 120 * MIN).toISOString(), active: true, ...over });

describe('trigger rules', () => {
  it('parses each condition and refuses the rest', () => {
    assert.deepEqual(T.parseWhen({ machine: 'exclusive' }, bad), { kind: 'machine', busyBelow: 15 });
    assert.deepEqual(T.parseWhen({ idle: '1h' }, bad), { kind: 'idle', ms: 60 * MIN });
    assert.deepEqual(T.parseWhen({ every: '15m' }, bad), { kind: 'every', ms: 15 * MIN });
    assert.throws(() => T.parseWhen({ every: '30s' }, bad), /at least a minute/);
    assert.throws(() => T.parseWhen({ every: '15m', idle: '1h' }, bad), /exactly one/);
    assert.throws(() => T.parseWhen({ sometime: 'soon' }, bad), /unknown condition/);
  });
  it('machine fires on the edge only, and never without a reading', () => {
    const t = trig({ machine: 'exclusive' });
    const step = (machineFree) => { const r = T.evaluate(t, { nowMs: NOW, lastActivityMs: NOW, machineFree }); Object.assign(t, r.set); return r.fire; };
    assert.deepEqual([step(null), step(false), step(true), step(true), step(false), step(true)], [false, false, true, false, false, true]);
  });
  it('idle fires once quiet that long, then again every interval while nothing moves', () => {
    const t = trig({ idle: '60m' });
    const at = (nowMs, lastActivityMs) => T.evaluate(t, { nowMs, lastActivityMs, machineFree: null }).fire;
    assert.equal(at(NOW, NOW - 59 * MIN), false);
    assert.equal(at(NOW, NOW - 61 * MIN), true);
    t.firedAt = new Date(NOW).toISOString();
    assert.equal(at(NOW + 30 * MIN, NOW - 61 * MIN), false, 'not again within the interval');
    assert.equal(at(NOW + 61 * MIN, NOW - 61 * MIN), true, 'still quiet an interval later: again');
  });
  it('batches per agent: "now" sends the agent\'s list at once, "batch" waits for its oldest to age', () => {
    let q = [];
    q = T.enqueue(q, { wake: null, itemId: 'A', triggerId: 'a', priority: 'batch', firedAt: new Date(NOW).toISOString() });
    q = T.enqueue(q, { wake: null, itemId: 'A', triggerId: 'a', priority: 'batch', firedAt: new Date(NOW).toISOString() });
    assert.equal(q.length, 1, 'the same trigger queued twice is one entry');
    assert.deepEqual(Object.keys(T.due(q, NOW + 5 * MIN, 15 * MIN).send), []);
    assert.deepEqual(T.due(q, NOW + 16 * MIN, 15 * MIN).send.null.map((e) => e.itemId), ['A']);
    q = T.enqueue(q, { wake: null, itemId: 'B', triggerId: 'b', priority: 'now', firedAt: new Date(NOW).toISOString() });
    const r = T.due(q, NOW + MIN, 15 * MIN);
    assert.deepEqual([r.send.null.map((e) => e.itemId), r.keep], [['A', 'B'], []], 'a "now" takes the waiting ones with it');
  });
  it('the stuck watch steps aside for a card waiting on a trigger, not for the default idle check', () => {
    const it0 = { id: 'T-1', journey: { pickedUpAt: new Date(NOW - 300 * MIN).toISOString(), lastProgressAt: new Date(NOW - 90 * MIN).toISOString() }, comments: [], questions: [], asks: [] };
    const who = { owners: [], running: () => false, status: () => 'idle', sleeping: () => false };
    const idle = T.idleDefault({ id: 'd', minutes: 60, nowIso: 'x' });
    assert.deepEqual(STUCK.assess({ ...it0, triggers: [idle] }, NOW, who), { reason: 'no_owner' });
    assert.deepEqual(STUCK.assess({ ...it0, triggers: [idle, trig({ machine: 'exclusive' })] }, NOW, who), { reason: 'waiting_on_trigger' });
    assert.equal(STUCK.forCoordinator({ since: new Date(NOW - 999 * MIN).toISOString(), reason: 'waiting_on_trigger' }, NOW), false);
  });
});

describe('triggers on a real board', () => {
  const TEAM = { agents: { gamora: { role: 'coordinator', enabled: false }, groot: { role: 'builder', enabled: false }, nebula: { role: 'reviewer', enabled: false } } };
  const as = (agent) => ({ agent });
  const waitFor = async (fn, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) { const v = await fn(); if (v) return v; } return null; };

  it('anyone sets one; when it holds, the agent it names (default the coordinator) gets one trigger.fired list', async () => {
    const s = await startServer({ agents: TEAM, manifest: { triggers: { sweepSeconds: 1, batchMinutes: 0.02 } } });
    try {
      await s.ok('PATCH', B, { coordinator: 'gamora' }, USER); // switched off in TEAM, so named on the board
      const a = await s.ok('POST', `${B}/items`, { title: 'timing run', column: 'Ready' }, USER);
      const b = await s.ok('POST', `${B}/items`, { title: 'the export', column: 'Ready' }, USER);
      assert.equal((await s.api('POST', `${B}/items/${a.id}/triggers`, { when: { every: '10s' } }, as('groot'))).status, 400);
      assert.equal((await s.api('POST', `${B}/items/${a.id}/triggers`, { when: { every: '1h' }, wake: 'nobody' }, as('groot'))).status, 400);
      const { seq } = await s.ok('GET', '/api/app');
      const past = new Date(Date.now() - MIN).toISOString();
      const t1 = await s.ok('POST', `${B}/items/${a.id}/triggers`, { when: { until: past }, priority: 'now', wake: 'nebula', note: 'run the timing suite' }, as('groot'));
      await s.ok('POST', `${B}/items/${b.id}/triggers`, { when: { until: past } }, as('nebula'));
      const toNebula = await waitFor(async () => (await s.ok('GET', `/api/events?since=${seq}&types=trigger.fired`)).events.find((e) => e.wake === 'nebula'));
      assert.deepEqual([toNebula.addressed, toNebula.cards.map((c) => [c.id, c.note, c.priority])], [['nebula'], [[a.id, 'run the timing suite', 'now']]]);
      const toCoord = await waitFor(async () => (await s.ok('GET', `/api/events?since=${seq}&types=trigger.fired`)).events.find((e) => e.wake === 'gamora'));
      assert.deepEqual(toCoord.cards.map((c) => c.id), [b.id], 'no agent named: the coordinator, after the batch window');
      assert.equal((await s.ok('GET', `${B}/items/${a.id}`)).triggers.find((x) => x.id === t1.id).active, false, 'until fires once, then switches off');
    } finally { await s.stop(); }
  });

  it('a picked-up card gets the idle check; removed, it stays removed', async () => {
    const s = await startServer({ agents: TEAM, manifest: { triggers: { sweepSeconds: 1 } } });
    try {
      const t = await s.ok('POST', `${B}/items`, { title: 'the export', column: 'Ready' }, USER);
      await s.ok('POST', `${B}/items/${t.id}/start`, { status: 'reading' }, as('groot'));
      const idle = await waitFor(async () => (await s.ok('GET', `${B}/items/${t.id}`)).triggers?.find((x) => x.default));
      assert.deepEqual([idle.when.kind, idle.priority, idle.active], ['idle', 'batch', true]);
      await s.ok('DELETE', `${B}/items/${t.id}/triggers/${idle.id}`, null, as('groot'));
      await new Promise((r) => setTimeout(r, 2500));
      const it = await s.ok('GET', `${B}/items/${t.id}`);
      assert.deepEqual([it.idleCheck, (it.triggers || []).length], [false, 0]);
    } finally { await s.stop(); }
  });
});
