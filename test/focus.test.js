// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Focus boards: a saved view over a board (a handful of its tickets), never a copy. One board is active and
// the agents work only on it; retiring a focus board removes the view and moves nothing.
const { describe, it: test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, USER } = require('./helpers');

let s;
const B = '/api/boards/main';
const mk = (body = {}, as = USER) => s.ok('POST', `${B}/items`, { title: 'x', column: 'Ready', ...body }, as);
const col = async (id) => (await s.ok('GET', `${B}/items/${id}`)).column;
const work = (agent) => s.ok('GET', `${B}/work`, undefined, { agent });

describe('focus boards', () => {
  before(async () => {
    s = await startServer({ manifest: { permissions: { approver: { grants: ['review.decide'] } } } });
    await s.ok('PATCH', `/api/boards/main/columns/Ready`, { flags: { wipLimit: 0 } }, USER);
  });
  after(async () => { await s.stop(); });

  test('only the human creates, activates, renames, takes out of or retires a focus board', async () => {
    const a = await mk();
    const byAgent = await s.api('POST', `${B}/focus`, { name: 'Today', itemIds: [a.id] }, { agent: 'rocket' });
    assert.equal(byAgent.status, 403);
    assert.equal(byAgent.body.code, 'HUMAN_ONLY');
    const f = await s.ok('POST', `${B}/focus`, { name: 'Agent rules', itemIds: [a.id], activate: false }, USER);
    for (const [m, p, body] of [['PUT', `${B}/focus/active`, { id: f.id }], ['PATCH', `${B}/focus/${f.id}`, { name: 'Mine' }], ['PATCH', `${B}/focus/${f.id}`, { remove: [a.id] }], ['DELETE', `${B}/focus/${f.id}`]]) {
      const r = await s.api(m, p, body, { agent: 'rocket' });
      assert.equal(r.status, 403, `${m} ${p} ${JSON.stringify(body)}`);
    }
    const noName = await s.api('POST', `${B}/focus`, { itemIds: [a.id] }, USER);
    assert.equal(noName.status, 400);
    await s.ok('DELETE', `${B}/focus/${f.id}`, undefined, USER);
  });

  test('create from a selection: listed, active, holds exactly those tickets, and agents can read it', async () => {
    const [a, b, c] = [await mk({ title: 'A' }), await mk({ title: 'B' }), await mk({ title: 'C' })];
    const f = await s.ok('POST', `${B}/focus`, { name: 'Bonus exclusions, 16 Oct', itemIds: [a.id, b.id.toLowerCase(), a.id] }, USER);
    assert.equal(f.active, true, 'a new focus board becomes the active board');
    assert.deepEqual(f.itemIds, [a.id, b.id], 'ids are matched case-insensitively and added once');
    const list = await s.ok('GET', `${B}/focus`, undefined, { agent: 'rocket' });
    assert.equal(list.active, f.id);
    assert.ok(list.focusBoards.some((x) => x.id === f.id && x.count === 2));
    const one = await s.ok('GET', `${B}/focus/${f.id}`, undefined, { agent: 'rocket' });
    assert.deepEqual(one.items.map((x) => x.title), ['A', 'B']);
    assert.deepEqual((await s.ok('GET', `${B}/items/${a.id}`)).focus, ['Bonus exclusions, 16 Oct'], 'a ticket says which focus boards hold it');
    assert.equal((await s.ok('GET', `${B}/items/${c.id}`)).focus, undefined);
    const missing = await s.api('POST', `${B}/focus`, { name: 'Bad', itemIds: ['T-999'] }, USER);
    assert.equal(missing.status, 404, 'unknown tickets are refused, nothing is made');
    await s.ok('DELETE', `${B}/focus/${f.id}`, undefined, USER);
  });

  test('every change on a focus board is a change to the one real ticket; new tickets join the focus', async () => {
    const a = await mk({ title: 'Edit me' });
    const f = await s.ok('POST', `${B}/focus`, { name: 'Edits', itemIds: [a.id], activate: false }, USER);
    await s.ok('POST', `${B}/items/${a.id}/move`, { column: 'In Progress' }, USER);
    await s.ok('POST', `${B}/items/${a.id}/comments`, { body: 'from the focus board' }, USER);
    const real = await s.ok('GET', `${B}/items/${a.id}`);
    assert.equal(real.column, 'In Progress');
    assert.equal(real.comments.at(-1).body, 'from the focus board');
    const sum = await s.ok('GET', `${B}/summary`);
    assert.equal(sum.columns.flatMap((c) => c.items || []).filter((x) => x.id === a.id).length, 1, 'still one card on the board');

    const made = await mk({ title: 'Made on the focus board', focus: f.id });
    const after = await s.ok('GET', `${B}/focus/${f.id}`);
    assert.deepEqual(after.itemIds, [a.id, made.id], 'created on the parent board and added to the focus');
    const badFocus = await s.api('POST', `${B}/items`, { title: 'y', column: 'Ready', focus: 'fb_nope' }, USER);
    assert.equal(badFocus.status, 404);
    await s.ok('DELETE', `${B}/focus/${f.id}`, undefined, USER);
  });

  test('a ticket archived on the parent leaves the focus board', async () => {
    const [a, b] = [await mk(), await mk()];
    const f = await s.ok('POST', `${B}/focus`, { name: 'Archive', itemIds: [a.id, b.id], activate: false }, USER);
    await s.ok('POST', `${B}/items/${a.id}/archive`, {}, USER);
    assert.deepEqual((await s.ok('GET', `${B}/focus/${f.id}`)).itemIds, [b.id]);
    await s.ok('POST', `${B}/archive/${a.id}/restore`, {}, USER);
    assert.deepEqual((await s.ok('GET', `${B}/focus/${f.id}`)).itemIds, [b.id], 'restoring does not bring it back on its own');
    const r = await s.ok('DELETE', `${B}/focus/${f.id}`, undefined, USER);
    assert.deepEqual(r.archived, [a.id], 'the retire summary names what was archived meanwhile');
  });

  test('retire removes the view only: every ticket stays where it is, none lost or duplicated', async () => {
    const [a, b, c] = [await mk(), await mk(), await mk({ column: 'Backlog' })];
    const f = await s.ok('POST', `${B}/focus`, { name: 'Retire me', itemIds: [a.id, b.id] }, USER);
    await s.ok('POST', `${B}/items/${a.id}/move`, { column: 'Review' }, USER);
    const before = await s.ok('GET', `${B}/summary`);
    const r = await s.ok('DELETE', `${B}/focus/${f.id}`, undefined, USER);
    assert.equal(r.wasActive, true);
    assert.deepEqual(r.moved, [{ id: a.id, title: a.title, from: 'Ready', to: 'Review' }]);
    assert.deepEqual((await s.ok('GET', `${B}/summary`)).columns, before.columns, 'every column holds exactly what it held');
    assert.equal((await s.ok('GET', `${B}/focus`)).active, null, 'the full board is active again');
    assert.equal(await col(c.id), 'Backlog');
    assert.equal((await s.api('GET', `${B}/focus/${f.id}`)).status, 404);
  });

  test('while a focus board is active the agents work only on it; direct asks still get through', async () => {
    const inside = await mk({ title: 'Inside', assignee: 'drax' });
    const outside = await mk({ title: 'Outside', assignee: 'drax' });
    const held = await mk({ title: 'Held outside' });
    await s.ok('POST', `${B}/items/${held.id}/start`, { status: 'half way' }, { agent: 'cosmo' });
    const keep = await mk({ title: 'Held inside' });
    await s.ok('POST', `${B}/items/${keep.id}/start`, { status: 'focused' }, { agent: 'cosmo' });

    const f = await s.ok('POST', `${B}/focus`, { name: 'Only this', itemIds: [inside.id, keep.id] }, USER);
    // work cosmo held outside the focus goes back to the pickup column, still assigned; inside, it is untouched
    const h = await s.ok('GET', `${B}/items/${held.id}`);
    assert.equal(h.column, 'Ready');
    assert.equal(h.lease, null);
    assert.equal(h.assignee, 'cosmo');
    assert.match(h.comments.at(-1).body, /focusing the agents on "Only this"/);
    const k = await s.ok('GET', `${B}/items/${keep.id}`);
    assert.equal(k.column, 'In Progress');
    assert.equal(k.lease.claimant, 'cosmo');

    const w = await work('drax');
    assert.deepEqual(w.next.filter((n) => n.action === 'start').map((n) => n.id), [inside.id], 'only the focus ticket is suggested');
    assert.equal(w.focus.name, 'Only this');
    assert.match(w.focus.note, new RegExp(outside.id));
    assert.deepEqual(w.assigned.find((x) => x.id === inside.id).focus, ['Only this'], 'work items say they are in focus');
    const brief = await s.ok('GET', `${B}/brief`, undefined, { agent: 'drax' });
    assert.match(typeof brief === 'string' ? brief : brief.brief || JSON.stringify(brief), /Focus board "Only this" is active/);

    // the human asks drax to explain the outside ticket: that still reaches it
    await s.ok('POST', `${B}/items/${outside.id}/comments`, { body: '@drax why this way?', intent: 'explain' }, USER);
    assert.ok((await work('drax')).next.some((n) => n.action === 'explain' && n.id === outside.id));

    await s.ok('POST', `${B}/items/${outside.id}/comments`, { body: 'Because of the lease rules.' }, { agent: 'drax' });

    // starting outside the focus is refused, unless the agent says the human asked for it directly
    const asked = await mk({ title: 'Asked for directly' });
    const refused = await s.api('POST', `${B}/items/${asked.id}/start`, {}, { agent: 'drax' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'OUT_OF_FOCUS');
    assert.match(refused.body.hint, /outsideFocus/);
    await s.ok('POST', `${B}/items/${asked.id}/start`, { outsideFocus: true }, { agent: 'drax' });
    await s.ok('POST', `${B}/items/${inside.id}/start`, {}, { agent: 'drax' });
    await s.ok('POST', `${B}/items/${asked.id}/move`, { column: 'Ready' }, USER);
    await s.ok('POST', `${B}/items/${inside.id}/move`, { column: 'Ready' }, USER);
    // the full board again: the held work comes back
    await s.ok('PUT', `${B}/focus/active`, { id: null }, USER);
    const back = await work('drax');
    assert.equal(back.focus, undefined);
    assert.ok(back.next.some((n) => n.action === 'start' && n.id === outside.id));
    await s.ok('DELETE', `${B}/focus/${f.id}`, undefined, USER);
  });

  test('delegated approvals wait outside the focus board', async () => {
    const t = await mk({ title: 'Reviewed outside' });
    await s.ok('POST', `${B}/items/${t.id}/start`, {}, { agent: 'author' });
    await s.ok('POST', `${B}/items/${t.id}/review`, { changed: 'c', why: 'w', verify: 'v', evidence: 'npm test: 10 pass', risks: 'r' }, { agent: 'author' });
    const other = await mk();
    const f = await s.ok('POST', `${B}/focus`, { name: 'Elsewhere', itemIds: [other.id] }, USER);
    const r = await s.api('POST', `${B}/items/${t.id}/review/decision`, { verdict: 'approve', comment: 'ok' }, { agent: 'approver' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'OUT_OF_FOCUS');
    assert.equal((await work('approver')).next.some((n) => n.id === t.id), false, 'no decide or chase for it either');
    await s.ok('DELETE', `${B}/focus/${f.id}`, undefined, USER);
    await s.ok('POST', `${B}/items/${t.id}/review/decision`, { verdict: 'approve', comment: 'ok' }, { agent: 'approver' });
  });

  test('the coordinator may add tickets to a focus board, nothing more', async () => {
    await s.ok('PATCH', B, { coordinator: 'gamora' }, USER);
    const [a, b] = [await mk(), await mk()];
    const f = await s.ok('POST', `${B}/focus`, { name: 'Coord', itemIds: [a.id], activate: false }, USER);
    const added = await s.ok('PATCH', `${B}/focus/${f.id}`, { add: [b.id] }, { agent: 'gamora' });
    assert.deepEqual(added.itemIds, [a.id, b.id]);
    assert.equal((await s.api('PATCH', `${B}/focus/${f.id}`, { remove: [a.id] }, { agent: 'gamora' })).status, 403);
    assert.equal((await s.api('PATCH', `${B}/focus/${f.id}`, { add: [a.id] }, { agent: 'rocket' })).status, 403, 'other agents may not add');
    const out = await s.ok('PATCH', `${B}/focus/${f.id}`, { remove: [a.id], name: 'Renamed' }, USER);
    assert.deepEqual(out.itemIds, [b.id]);
    assert.equal(out.name, 'Renamed');
    await s.ok('DELETE', `${B}/focus/${f.id}`, undefined, USER);
  });

  test('focus boards survive a restart', async () => {
    const a = await mk();
    const f = await s.ok('POST', `${B}/focus`, { name: 'Durable', itemIds: [a.id] }, USER);
    await s.stop({ keep: true });
    s = await startServer({ dir: s.dir, manifest: { permissions: { approver: { grants: ['review.decide'] } } } });
    const list = await s.ok('GET', `${B}/focus`);
    assert.equal(list.active, f.id);
    assert.deepEqual(list.focusBoards.find((x) => x.id === f.id).itemIds, [a.id]);
  });
});
