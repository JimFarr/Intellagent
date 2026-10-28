// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Rules: the human's "when <something happens>, if <the ticket holds>, then <do this>", the board's built-in rules
// in the same words, the preview, the log, and the guards (no chains, gates still apply, a runaway is held back).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, until, USER } = require('./helpers');
const RULES = require('../lib/rules');

const COLS = [{ id: 'ready', name: 'Ready' }, { id: 'in-progress', name: 'In Progress' }, { id: 'done', name: 'Done' }];

describe('rules: the vocabulary (lib/rules.js)', () => {
  it('fills {id} and {title} with the title as written, $ patterns and all', () => {
    const { fill } = require('../lib/rules');
    assert.equal(fill('Escalated: {title} ({id})', { id: 'INT-7', title: "Price shows $& not $'" }), "Escalated: Price shows $& not $' (INT-7)");
  });
  it('cleans a rule, keeping a column by its id, and refuses what does not fit with a hint', () => {
    const r = RULES.cleanRule({ name: 'x', when: { on: 'entered', column: 'in progress' }, then: [{ do: 'comment', text: 'hi {id}' }] }, COLS, { id: 'r1', nowIso: '2026-10-27T00:00:00Z' });
    assert.equal(r.when.column, 'in-progress');
    assert.equal(r.enabled, true);
    for (const [bad, msg] of [
      [{ name: 'x', when: { on: 'nope' }, then: [{ do: 'archive' }] }, /not a trigger/],
      [{ name: 'x', when: { on: 'entered', column: 'Nowhere' }, then: [{ do: 'archive' }] }, /needs a column/],
      [{ name: 'x', when: { on: 'idle', minutes: 1 }, then: [{ do: 'archive' }] }, /at least 5/],
      [{ name: 'x', when: { on: 'created' }, if: 'review.oks>=x', then: [{ do: 'archive' }] }, /doesn't parse/],
      [{ name: 'x', when: { on: 'created' }, then: [] }, /at least one action/],
      [{ name: 'x', when: { on: 'every', minutes: 30 }, then: [{ do: 'archive' }] }, /"if" says which/],
    ]) assert.throws(() => RULES.cleanRule(bad, COLS, { id: 'r', nowIso: '2026-10-27T00:00:00Z' }), (e) => e instanceof RULES.RuleError && msg.test(e.message) && !!e.hint);
  });
  it('time rules fire once per stretch: the key changes only when the stretch does', () => {
    const rule = { when: { on: 'idle', minutes: 60 } };
    const t0 = Date.parse('2026-10-27T10:00:00Z');
    assert.equal(RULES.timeDue(rule, {}, { nowMs: t0 + 59 * 60_000, lastActivityMs: t0 }), null);
    const k = RULES.timeDue(rule, {}, { nowMs: t0 + 61 * 60_000, lastActivityMs: t0 });
    assert.ok(k);
    assert.equal(RULES.timeDue(rule, {}, { nowMs: t0 + 300 * 60_000, lastActivityMs: t0 }), k, 'still the same stretch');
    const inCol = { when: { on: 'in_column', column: 'ready', minutes: 30 } };
    assert.equal(RULES.timeDue(inCol, { columnId: 'done', enteredColumnAt: '2026-10-27T09:00:00Z' }, { nowMs: t0 }), null, 'only in its column');
    assert.ok(RULES.timeDue(inCol, { columnId: 'ready', enteredColumnAt: '2026-10-27T09:00:00Z' }, { nowMs: t0 }));
  });
  it('a rule that fires too often is held back', () => {
    const r = { when: { on: 'created' } };
    const t = Date.now();
    for (let i = 0; i < RULES.MAX_PER_HOUR; i++) RULES.noteFired(r, t);
    assert.equal(RULES.throttled(r, t), true);
    assert.equal(RULES.throttled(r, t + 3_600_001), false);
  });
});

describe('rules on a board', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s?.stop());
  const logFor = (rule) => s.ok('GET', `/api/boards/main/rules/log?rule=${rule}`, undefined, USER);
  const newItem = (d = {}) => s.ok('POST', '/api/boards/main/items', { title: 'A ticket', column: 'Ready', ...d }, USER);

  it("the board's own behaviours are ordinary stored rules, seeded with the values it runs with (INT-472)", async () => {
    const v = await s.ok('GET', '/api/boards/main/rules', undefined, USER);
    const own = Object.fromEntries(v.rules.filter((r) => r.id.startsWith('board-')).map((r) => [r.id, r]));
    for (const id of ['board-land', 'board-idle-check', 'board-ask-escalation', 'board-stuck-watch', 'board-rebalance']) {
      assert.ok(own[id], id);
      assert.ok(!own[id].native, `${id} is an ordinary rule`);
    }
    assert.ok(!own['board-idle-alarm'], 'an alarm the board never set follows agents.json, with no rule');
    assert.deepEqual(own['board-idle-check'].when, { on: 'idle', minutes: 60 });
    assert.match(own['board-idle-check'].text, /^If a ticket idles for 1 h → wake coordinator/);
    assert.ok(!v.vocabulary.times.board_idle.nativeOnly, 'no word is reserved any more');
    assert.ok(v.vocabulary.events.entered.column);
  });

  it("the board's rules drive its behaviours: edited, switched off, copied or deleted like any rule (INT-472)", async () => {
    const get = async (id) => (await s.ok('GET', '/api/boards/main/rules', undefined, USER)).rules.find((r) => r.id === id);
    const ic = await get('board-idle-check');
    const body = { name: ic.name, enabled: ic.enabled, when: ic.when, then: ic.then };
    assert.deepEqual((await s.ok('PUT', '/api/boards/main/rules/board-idle-check', { ...body, when: { on: 'idle', minutes: 90 } }, USER)).when, { on: 'idle', minutes: 90 });
    assert.equal((await get('board-idle-check')).when.minutes, 90);
    await s.ok('PUT', '/api/boards/main/rules/board-idle-check', { ...body, enabled: false }, USER);
    assert.equal((await get('board-idle-check')).enabled, false, 'switched off, still listed');
    // reshaped, it stays the same rule (same id) and is no longer the idle check
    const mine = await s.ok('PUT', '/api/boards/main/rules/board-idle-check', { ...body, enabled: true, if: 'priority:High' }, USER);
    assert.equal(mine.id, 'board-idle-check');
    assert.equal(mine.if, 'priority:High');
    // an engine's words work only in its rule's shape, with a hint naming the rule
    const bad = await s.api('POST', '/api/boards/main/rules', { name: 'x', when: { on: 'board_idle', minutes: 30 }, then: [{ do: 'comment', text: 'idle' }] }, USER);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'BAD_REQUEST');
    assert.match(bad.body.hint, /Idle-board alarm/);
    const keep = await s.api('PUT', '/api/boards/main/rules/board-stuck-watch', { name: 'Stuck watch', when: { on: 'idle', minutes: 60 }, then: [{ do: 'unstick' }] }, USER);
    assert.equal(keep.status, 400, 'unstick only works as the stuck watch has it');
    // the idle alarm, in its shape, is anyone's rule now; its agents must be standing ones
    const alarm = await s.api('POST', '/api/boards/main/rules', { name: 'Alarm', when: { on: 'board_idle', minutes: 30 }, then: [{ do: 'wake', agent: 'nobody' }] }, USER);
    assert.equal(alarm.status, 400);
    assert.match(alarm.body.error, /standing agents/);
    // deleted, the behaviour is off; the old setting route writes the rule back
    assert.ok((await s.ok('DELETE', '/api/boards/main/rules/board-rebalance', undefined, USER)).deleted);
    assert.equal((await s.ok('GET', '/api/boards/main/rebalance', undefined, USER)).on, false);
    await s.ok('PUT', '/api/boards/main/rebalance', { on: true }, USER);
    assert.equal((await get('board-rebalance')).enabled, true, 'PUT …/rebalance made the rule again');
    await s.ok('PUT', '/api/boards/main/idle-alarm', { on: false, minutes: 25 }, USER);
    const ia = await get('board-idle-alarm');
    assert.deepEqual([ia.enabled, ia.when], [false, { on: 'board_idle', minutes: 25 }], 'PUT …/idle-alarm writes its rule');
    await s.ok('PUT', '/api/boards/main/rules/board-idle-check', { ...body, enabled: true, when: { on: 'idle', minutes: 60 } }, USER);
  });

  it('an existing board moves its behaviour settings into rules once, keeping what was off (INT-472)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-seed-'));
    const t = await startServer({ dir });
    const file = path.join(dir, 'data', 'boards', 'main', 'board.json');
    await t.stop({ keep: true });
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    b.behaviours = { landOnApprove: false, idleCheck: { on: true, minutes: 45 }, stuckWatch: false };
    b.idleAlarm = { on: true, minutes: 30, wake: [], note: '' };
    b.rebalance = { on: false, maxMoves: 3 };
    b.automations = { rules: [], log: [] };
    fs.chmodSync(file, 0o666);
    fs.writeFileSync(file, JSON.stringify(b));
    const u = await startServer({ dir });
    try {
      const rules = Object.fromEntries((await u.ok('GET', '/api/boards/main/rules', undefined, USER)).rules.map((r) => [r.id, r]));
      assert.equal(rules['board-land'].enabled, false);
      assert.deepEqual([rules['board-idle-check'].enabled, rules['board-idle-check'].when.minutes], [true, 45]);
      assert.equal(rules['board-stuck-watch'].enabled, false);
      assert.equal(rules['board-ask-escalation'].enabled, true, 'not set: the default, on');
      assert.deepEqual([rules['board-idle-alarm'].enabled, rules['board-idle-alarm'].then[0].do], [true, 'ask_human']);
      assert.equal(rules['board-rebalance'].enabled, false);
      assert.equal((await u.ok('GET', '/api/boards/main/rebalance', undefined, USER)).maxMoves, 3, 'its numbers stay settings');
      await u.ok('POST', '/api/boards/main/items', { title: 'saves the board', column: 'Ready' }, USER);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.ok(!saved.behaviours && !saved.idleAlarm, 'the old settings are gone once saved');
    } finally { await u.stop(); }
  });

  it('only the human makes rules; a bad one comes back 400 with a hint', async () => {
    const rule = { name: 'x', when: { on: 'created' }, then: [{ do: 'comment', text: 'hi' }] };
    assert.equal((await s.api('POST', '/api/boards/main/rules', rule)).status, 403);
    const bad = await s.api('POST', '/api/boards/main/rules', { ...rule, when: { on: 'entered', column: 'Nowhere' } }, USER);
    assert.equal(bad.status, 400);
    assert.ok(bad.body.hint);
  });

  it('an event rule acts on the tickets its "if" picks, logs it, and shows on the ticket', async () => {
    const r = await s.ok('POST', '/api/boards/main/rules', { name: 'Flag urgent work', when: { on: 'entered', column: 'In Progress' }, if: 'priority:Critical', then: [{ do: 'comment', text: '{id} is urgent' }, { do: 'set_field', key: 'nope', value: 1 }] }, USER);
    assert.match(r.text, /If a ticket enters In Progress and priority:Critical → comment on it/);
    const hot = await newItem({ priority: 'Critical' });
    const cool = await newItem({ priority: 'Low' });
    await s.ok('POST', `/api/boards/main/items/${hot.id}/move`, { column: 'In Progress' }, USER);
    await s.ok('POST', `/api/boards/main/items/${cool.id}/move`, { column: 'In Progress' }, USER);
    const log = await until(async () => { const l = await logFor(r.id); return l.length && l; }, 5000, 'the rule to fire');
    assert.equal(log.length, 1, 'not for the ticket its "if" leaves out');
    assert.equal(log[0].item, hot.id);
    assert.deepEqual(log[0].results.map((x) => x.ok), [true, false], 'each action says how it went');
    assert.match(log[0].results[1].error, /nope/i);
    const item = await s.ok('GET', `/api/boards/main/items/${hot.id}`, undefined, USER);
    const c = item.comments.at(-1);
    assert.equal(c.body, `${hot.id} is urgent`);
    assert.equal(c.author.rule.name, 'Flag urgent work');
    const hist = await s.ok('GET', `/api/boards/main/items/${hot.id}/history`, undefined, USER);
    const ran = hist.find((e) => e.type === 'rule.ran');
    assert.ok(ran, 'on the ticket history');
    assert.deepEqual(ran.did.map((d) => [d.text, d.ok]), [['comment on it', true], ['set nope to 1', false]], 'saying what each action did');
    assert.match(ran.did[1].error, /nope/i);
    await s.ok('DELETE', `/api/boards/main/rules/${r.id}`, undefined, USER);
  });

  it("a rule's own changes set no rule off (no chains), and gates still apply to it", async () => {
    const a = await s.ok('POST', '/api/boards/main/rules', { name: 'Bounce back', when: { on: 'entered', column: 'Review' }, then: [{ do: 'move', column: 'In Progress' }] }, USER);
    const b = await s.ok('POST', '/api/boards/main/rules', { name: 'Bounce forward', when: { on: 'entered', column: 'In Progress' }, then: [{ do: 'move', column: 'Review' }] }, USER);
    const t = await newItem();
    await s.ok('PUT', `/api/boards/main/rules/${b.id}`, { ...b, enabled: false }, USER); // so the human's own move below doesn't set it off
    await s.ok('POST', `/api/boards/main/items/${t.id}/move`, { column: 'Review' }, USER);
    await until(async () => (await logFor(a.id)).length, 5000, 'bounce back');
    await s.ok('PUT', `/api/boards/main/rules/${b.id}`, { ...b, enabled: true }, USER);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await logFor(b.id)).length, 0, "the first rule's move set nothing off");
    assert.equal((await s.ok('GET', `/api/boards/main/items/${t.id}`, undefined, USER)).columnId, 'in-progress');
    for (const r of [a, b]) await s.ok('DELETE', `/api/boards/main/rules/${r.id}`, undefined, USER);

    const g = await s.ok('POST', '/api/boards/main/rules', { name: 'Straight to Done', when: { on: 'created' }, then: [{ do: 'move', column: 'Done' }] }, USER);
    await newItem();
    const [l] = await until(async () => { const x = await logFor(g.id); return x.length && x; }, 5000, 'the gate to refuse');
    assert.equal(l.results[0].ok, false);
    assert.match(l.results[0].error, /Only a human/);
    await s.ok('DELETE', `/api/boards/main/rules/${g.id}`, undefined, USER);
  });

  it('a card look is a rule: if a ticket fits, its card looks so; the card rules are its copy, both ways', async () => {
    const t = await newItem({ priority: 'Critical', title: 'Hot' });
    const r = await s.ok('POST', '/api/boards/main/rules', { name: 'hot', when: { on: 'fits' }, if: 'priority:Critical', then: [{ do: 'look', look: { outline: 'danger', badge: { text: 'hot' } } }] }, USER);
    assert.match(r.text, /^If a ticket fits and priority:Critical → its card shows a danger outline, the badge "hot"/);
    const cr = await s.ok('GET', '/api/boards/main/card-rules', undefined, USER);
    assert.deepEqual(cr.rules.map((x) => x.name), ['hot']);
    const looks = await s.ok('GET', '/api/boards/main/card-rules/matches', undefined, USER);
    assert.equal(looks[t.id].outline, 'danger');
    assert.ok((await s.ok('GET', `/api/search?board=main&filter=${encodeURIComponent('is:rule:hot')}`, undefined, USER)).items.some((x) => x.id === t.id), 'is:rule: finds it');
    for (const bad of [
      { name: 'x', when: { on: 'fits' }, then: [{ do: 'look', look: { outline: 'ok' } }] }, // no conditions
      { name: 'x', when: { on: 'created' }, then: [{ do: 'look', look: { outline: 'ok' } }] }, // a look on an event
      { name: 'x', when: { on: 'fits' }, if: 'type:issue', then: [{ do: 'comment', text: 'no' }] }, // fits with another action
    ]) assert.equal((await s.api('POST', '/api/boards/main/rules', bad, USER)).status, 400, JSON.stringify(bad));
    assert.equal((await s.api('POST', '/api/boards/main/rules', { name: 'HOT', when: { on: 'fits' }, if: 'type:issue', then: [{ do: 'look', look: { tint: 'ok' } }] }, USER)).status, 409, 'look names are unique');
    // PUT …/card-rules still works, and edits the rules
    await s.ok('PUT', '/api/boards/main/card-rules', { rules: [{ name: 'hot', condition: 'priority:High', look: { outline: 'warn' } }] }, USER);
    const again = (await s.ok('GET', '/api/boards/main/rules', undefined, USER)).rules.find((x) => x.when.on === 'fits');
    assert.equal(again.id, r.id, 'the same rule, kept by name');
    assert.equal(again.if, 'priority:High');
    await s.ok('DELETE', `/api/boards/main/rules/${r.id}`, undefined, USER);
    assert.deepEqual((await s.ok('GET', '/api/boards/main/card-rules', undefined, USER)).rules, []);
  });

  it('preview: which tickets a rule would act on now, before it is saved', async () => {
    const t = await newItem({ priority: 'High', title: 'Preview me' });
    const p = await s.ok('POST', '/api/boards/main/rules/preview', { rule: { name: 'p', when: { on: 'created' }, if: 'priority:High', then: [{ do: 'archive' }] } }, USER);
    assert.equal(p.mode, 'match');
    assert.ok(p.items.some((x) => x.id === t.id));
    const due = await s.ok('POST', '/api/boards/main/rules/preview', { rule: { name: 'p', when: { on: 'in_column', column: 'Ready', minutes: 60 }, then: [{ do: 'archive' }] } }, USER);
    assert.equal(due.mode, 'due');
    assert.ok(!due.items.some((x) => x.id === t.id), 'a ticket that just arrived is not due yet');
    assert.equal((await s.api('POST', '/api/boards/main/rules/preview', { rule: { name: 'p', when: { on: 'created' }, if: '(((', then: [{ do: 'archive' }] } }, USER)).status, 400);
  });

  it('wake names the agent it wakes, and says so when there is nobody to wake', async () => {
    const r = await s.ok('POST', '/api/boards/main/rules', { name: 'Tell the coordinator', when: { on: 'commented' }, then: [{ do: 'wake', agent: 'coordinator', note: 'look at {id}' }, { do: 'wake', agent: 'drax' }] }, USER);
    const t = await newItem();
    await s.ok('POST', `/api/boards/main/items/${t.id}/comments`, { body: 'hello' }, USER);
    const [l] = await until(async () => { const x = await logFor(r.id); return x.length && x; }, 5000, 'the wake');
    assert.equal(l.results[0].ok, false);
    assert.match(l.results[0].error, /no coordinator/);
    assert.equal(l.results[1].woke, 'drax');
    const ev = await s.ok('GET', '/api/events?since=0&types=rule.fired&limit=50', undefined, USER);
    const fired = ev.events.find((e) => e.itemId === t.id);
    assert.deepEqual(fired.addressed, ['drax']);
    await s.ok('DELETE', `/api/boards/main/rules/${r.id}`, undefined, USER);
  });
});
