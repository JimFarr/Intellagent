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
    assert.throws(() => T.parseWhen({ every: '30s' }, bad), /at least 5 minutes/);
    assert.throws(() => T.parseWhen({ idle: '4m' }, bad), /at least 5 minutes/);
    assert.deepEqual(T.parseWhen({ every: '5m' }, bad), { kind: 'every', ms: 5 * MIN });
    assert.deepEqual(T.parseWhen({ quietFor: '1m' }, bad), { kind: 'quietFor', ms: MIN });
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
    let q = [{ wake: null, itemId: 'A', ruleId: 'a', priority: 'batch', firedAt: new Date(NOW).toISOString() }];
    assert.deepEqual(Object.keys(T.due(q, NOW + 5 * MIN, 15 * MIN).send), []);
    assert.deepEqual(T.due(q, NOW + 16 * MIN, 15 * MIN).send.null.map((e) => e.itemId), ['A']);
    q = [...q, { wake: null, itemId: 'B', ruleId: 'b', priority: 'now', firedAt: new Date(NOW).toISOString() }];
    const r = T.due(q, NOW + MIN, 15 * MIN);
    assert.deepEqual([r.send.null.map((e) => e.itemId), r.keep], [['A', 'B'], []], 'a "now" takes the waiting ones with it');
  });
  it('a trigger is a rule on its ticket, and reads back as the trigger it was set as (INT-475)', () => {
    for (const [when, on] of [[{ machine: 'exclusive', busyBelow: 20 }, { on: 'machine_free', busyBelow: 20 }], [{ quietFor: '30m' }, { on: 'quiet_for', minutes: 30 }],
      [{ idle: '1h' }, { on: 'idle', minutes: 60 }], [{ every: '15m' }, { on: 'every', minutes: 15 }], [{ until: '2026-10-24T09:00:00Z' }, { on: 'at', at: '2026-10-24T09:00:00.000Z' }]]) {
      const parsed = T.parseWhen(when, bad);
      const r = T.toRule({ id: 'tr1', itemId: 'T-1', when: parsed, priority: 'now', wake: 'nebula', note: 'go', by: 'groot', nowIso: 'x' });
      assert.deepEqual([r.item, r.when, r.then], ['T-1', on, [{ do: 'wake', agent: 'nebula', batch: false, note: 'go' }]]);
      assert.deepEqual(T.fromRule(r), { id: 'tr1', when: parsed, priority: 'now', wake: 'nebula', note: 'go', by: 'groot', at: 'x', active: true });
    }
    const old = { ...trig({ quietFor: '30m' }), by: 'groot', quietFrom: 'q', firedAt: 'f' };
    const m = T.migrate(old, 'T-1');
    assert.deepEqual([m.id, m.enabled, m.state, m.then[0].agent, m.then[0].batch], ['tr1', true, { firedAt: 'f', quietFrom: 'q' }, 'coordinator', true]);
  });
  it('the idle check holds while the card waits on the human, not on the board\'s own question', () => {
    assert.equal(T.holds({ questions: [{ kind: 'review', raisedBy: 'groot' }] }), true);
    assert.equal(T.holds({ questions: [{ raisedBy: 'intellagent' }] }), false, 'the board\'s own question is not the human\'s wait');
    assert.equal(T.holds({ questions: [] }), false);
  });
  it('the stuck watch steps aside for a card waiting on a trigger, not for the board\'s idle check', () => {
    const it0 = { id: 'T-1', columnId: 'c', journey: { pickedUpAt: new Date(NOW - 300 * MIN).toISOString(), lastProgressAt: new Date(NOW - 90 * MIN).toISOString() }, comments: [], questions: [], asks: [] };
    const board = (rules) => ({ columns: [], items: { 'T-1': it0 }, automations: { rules } });
    const who = { works: {}, running: () => false, status: () => 'idle' };
    const idleCheck = { id: 'board-idle-check', engine: 'idleCheck', enabled: true, when: { on: 'idle', minutes: 60 }, then: [{ do: 'wake', agent: 'coordinator' }] };
    assert.equal(STUCK.sweepBoard(board([idleCheck]), NOW, who).next['T-1'].reason, 'no_owner');
    const mine = T.toRule({ id: 'tr1', itemId: 'T-1', when: T.parseWhen({ machine: 'exclusive' }, bad), priority: 'now', by: 'groot', nowIso: 'x' });
    assert.equal(STUCK.sweepBoard(board([idleCheck, mine]), NOW, who).next['T-1'].reason, 'waiting_on_trigger');
    assert.equal(STUCK.sweepBoard(board([idleCheck, { ...mine, enabled: false }]), NOW, who).next['T-1'].reason, 'no_owner', 'one that fired and switched off waits on nothing');
    assert.equal(STUCK.forCoordinator({ since: new Date(NOW - 999 * MIN).toISOString(), reason: 'waiting_on_trigger' }, NOW), false);
  });
});

it('the woken agent\'s prompt lists each card: why, the note, its assignee', () => {
  const { eventLine } = require('../lib/agents/prompt');
  const line = eventLine({ type: 'trigger.fired', wake: 'gamora', cards: [
    { id: 'LNZ-72', title: 'Timing run', why: 'the machine is free', note: 'run the quiet benchmark', priority: 'now', owner: 'natasha' },
    { id: 'LNZ-35', title: 'Heat solver', why: 'idle for 61 min', note: null, priority: 'batch', owner: null }] });
  assert.match(line, /^trigger\.fired — /);
  assert.match(line, /· LNZ-72 "Timing run" — the machine is free \(note: run the quiet benchmark\) \[assigned to natasha\] \[now\]/);
  assert.match(line, /· LNZ-35 "Heat solver" — idle for 61 min$/m);
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
      assert.deepEqual([idle.id, idle.when.kind, idle.priority, idle.active], ['board-idle-check', 'idle', 'batch', true], 'the board\'s Idle check rule, covering the card');
      assert.ok((await s.ok('GET', B)).board.items[t.id].triggers.some((x) => x.default), 'the board view carries it, for the card\'s bell');
      await s.ok('DELETE', `${B}/items/${t.id}/triggers/${idle.id}`, null, as('groot'));
      await new Promise((r) => setTimeout(r, 2500));
      const it = await s.ok('GET', `${B}/items/${t.id}`);
      assert.deepEqual((it.triggers || []).length, 0);
      const rule = (await s.ok('GET', `${B}/rules`, undefined, USER)).rules.find((r) => r.id === 'board-idle-check');
      assert.deepEqual([rule.enabled, rule.skip], [true, [t.id]], 'the Idle check rule skips the card; it stays on for the rest');
    } finally { await s.stop(); }
  });

  it('a ticket keeps at most 5, outside the board\'s rules, and they go when it is done (INT-475)', async () => {
    const s = await startServer({ agents: TEAM, manifest: { triggers: { sweepSeconds: 1 } } });
    try {
      const t = await s.ok('POST', `${B}/items`, { title: 'the export', column: 'Ready' }, USER);
      const set = [];
      for (let i = 0; i < 5; i++) set.push(await s.ok('POST', `${B}/items/${t.id}/triggers`, { when: { every: `${10 + i}m` } }, as('groot')));
      assert.deepEqual([set[0].rule.item, set[0].rule.when, set[0].text], [t.id, { on: 'every', minutes: 10 }, 'If every 10 min → wake coordinator'], 'the reply names the rule it wrote');
      const sixth = await s.api('POST', `${B}/items/${t.id}/triggers`, { when: { every: '1h' } }, as('groot'));
      assert.deepEqual([sixth.status, sixth.body.code], [409, 'CONFLICT']);
      const rules = (await s.ok('GET', `${B}/rules`, undefined, USER)).rules;
      assert.ok(!rules.some((r) => r.item), 'not on the Rules page: they are the ticket\'s');
      assert.equal((await s.api('PUT', `${B}/rules/${set[0].id}`, { name: 'x', when: { on: 'every', minutes: 15 }, then: [{ do: 'wake', agent: 'gamora' }] }, USER)).status, 404, 'nor changed through it');
      await s.ok('DELETE', `${B}/items/${t.id}/triggers/${set[0].id}`, null, as('groot'));
      assert.equal((await s.ok('GET', `${B}/items/${t.id}`)).triggers.length, 4);
      await s.ok('POST', `${B}/items/${t.id}/move`, { column: 'Done' }, USER);
      assert.ok(await waitFor(async () => (await s.ok('GET', `${B}/items/${t.id}`)).triggers.length === 0), 'done: its triggers went with it');
    } finally { await s.stop(); }
  });

  it('a board with triggers on its tickets loads with the same triggers, as rules (INT-475)', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-trig-'));
    const s = await startServer({ dir, agents: TEAM });
    const a = await s.ok('POST', `${B}/items`, { title: 'timing run', column: 'Ready' }, USER);
    const b = await s.ok('POST', `${B}/items`, { title: 'the export', column: 'Ready' }, USER);
    await s.ok('POST', `${B}/items/${b.id}/start`, { status: 'reading' }, as('groot'));
    await s.stop({ keep: true });
    const file = path.join(dir, 'data', 'boards', 'main', 'board.json');
    const board = JSON.parse(fs.readFileSync(file, 'utf8'));
    const at = '2026-10-20T10:00:00.000Z';
    board.items[a.id].triggers = [
      { id: 'tr_m', when: { kind: 'machine', busyBelow: 15 }, priority: 'now', wake: 'nebula', note: 'run it', by: 'groot', at, active: true, wasTrue: false },
      { id: 'tr_u', when: { kind: 'until', at }, priority: 'batch', by: 'groot', at, active: false, firedAt: at },
      { id: 'tr_d', when: { kind: 'idle', ms: 3_600_000 }, priority: 'batch', by: 'intellagent', at, active: true, default: true, firedAt: at }];
    board.items[b.id].idleCheck = false;
    board.triggerQueue = [{ wake: 'nebula', itemId: a.id, triggerId: 'tr_m', priority: 'now', why: 'the machine is free for a timing run', note: 'run it', firedAt: at },
      { wake: null, itemId: a.id, triggerId: 'tr_d', priority: 'batch', why: 'idle for 61 min', note: null, firedAt: at }];
    fs.chmodSync(file, 0o666);
    fs.writeFileSync(file, JSON.stringify(board));
    const u = await startServer({ dir, agents: TEAM });
    try {
      const ts = (await u.ok('GET', `${B}/items/${a.id}`)).triggers;
      const by = Object.fromEntries(ts.map((t) => [t.id, t]));
      assert.deepEqual(Object.keys(by).sort(), ['tr_m', 'tr_u'], 'its own two, same ids; the default idle check is the board\'s rule now');
      assert.deepEqual([by.tr_m.when, by.tr_m.priority, by.tr_m.wake, by.tr_m.note, by.tr_m.active, by.tr_m.wasTrue], [{ kind: 'machine', busyBelow: 15 }, 'now', 'nebula', 'run it', true, false]);
      assert.deepEqual([by.tr_u.active, by.tr_u.firedAt], [false, at]);
      await u.ok('POST', `${B}/items`, { title: 'saves the board', column: 'Ready' }, USER);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.ok(!saved.triggerQueue && !saved.items[a.id].triggers && !('idleCheck' in saved.items[b.id]), 'the old fields are gone once saved');
      const rules = Object.fromEntries(saved.automations.rules.map((r) => [r.id, r]));
      assert.deepEqual(rules.tr_m.state.pending, { [a.id]: { why: 'the machine is free for a timing run', firedAt: at } }, 'what waited to be sent waits on its rule');
      assert.deepEqual([rules['board-idle-check'].skip, rules['board-idle-check'].state.pending[a.id].why, rules['board-idle-check'].state.fired[a.id]], [[b.id], 'idle for 61 min', at]);
      await u.stop({ keep: true });
    } catch (e) { await u.stop(); throw e; }
    // and the sweep sends them: the trigger's to the agent it names, the idle check's to the coordinator
    const w = await startServer({ dir, agents: TEAM, manifest: { triggers: { sweepSeconds: 1, batchMinutes: 0.02 } } });
    try {
      await w.ok('PATCH', B, { coordinator: 'gamora' }, USER);
      const got = await waitFor(async () => {
        const evs = (await w.ok('GET', '/api/events?types=trigger.fired')).events;
        return evs.some((e) => e.wake === 'gamora') && evs.some((e) => e.wake === 'nebula') && evs;
      });
      assert.ok(got, 'both sent');
      assert.deepEqual(got.filter((e) => e.wake === 'gamora').flatMap((e) => e.cards.map((c) => [c.id, c.why])), [[a.id, 'idle for 61 min']]);
      assert.deepEqual(got.filter((e) => e.wake === 'nebula').flatMap((e) => e.cards.map((c) => [c.id, c.note, c.priority])), [[a.id, 'run it', 'now']]);
    } finally { await w.stop(); }
  });
});
