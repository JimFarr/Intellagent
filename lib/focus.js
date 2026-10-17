'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Focus boards: a saved view over the board (a list of its ticket ids), never a copy. The human picks a handful
// of tickets to work on today. Every change on a focus board is a change to the real ticket, because there is
// only one. One board is "active" — the full board, or one focus board — and while a focus board is active the
// agents take up only its tickets: a direct ask from the human (an @mention, a request, an explain) still gets
// through, and landing approved work goes on. Retiring a focus board removes the view and nothing else.

// deps: { fail, arr, str, rid, now, tx, getItem, itemEvent, activeLease, isCoordinator, humanConfig,
//   workingColumn, pickupColumns, backToReady, isAgentName, listStanding(): the standing agents' list() }
function createFocusBoards({ fail, arr, str, rid, now, tx, getItem, itemEvent, activeLease, isCoordinator, humanConfig,
  workingColumn, pickupColumns, backToReady, isAgentName, listStanding }) {
  const activeFocus = (ctx) => ctx.board.focusBoards.find((f) => f.id === ctx.board.activeFocus) || null;
  // Whether agents may take this ticket up of their own accord: always, unless another focus board is active.
  const inActiveFocus = (ctx, it) => { const f = activeFocus(ctx); return !f || f.itemIds.includes(it.id); };
  const focusNames = (ctx, id) => ctx.board.focusBoards.filter((f) => f.itemIds.includes(id)).map((f) => f.name);
  function getFocus(ctx, id) {
    const f = ctx.board.focusBoards.find((x) => x.id === String(id));
    if (!f) fail(404, `Focus board "${id}" not found. Focus boards: ${ctx.board.focusBoards.map((x) => `${x.name} (${x.id})`).join(', ') || '(none)'}`);
    return f;
  }
  function focusView(ctx, f) {
    const { startCols, ...rest } = f;
    return { ...rest, active: ctx.board.activeFocus === f.id, count: f.itemIds.length };
  }
  const focusEvent = (ctx, type, f, actor, extra = {}) => ({ board: ctx.id, type, actor, focus: { id: f.id, name: f.name, count: f.itemIds.length }, recipients: [], ...extra });
  // Tickets to add: live ones on this board, each once; the column it stood in is kept for the retire summary.
  function addToFocus(ctx, f, ids) {
    const added = [];
    for (const raw of arr(ids)) {
      const it = getItem(ctx, raw);
      if (f.itemIds.includes(it.id)) continue;
      f.itemIds.push(it.id);
      f.startCols[it.id] = it.columnId;
      added.push(it.id);
    }
    return added;
  }
  // Who may change a focus board: the human; the coordinator may only add tickets to one (on the human's ask).
  function guardFocus(ctx, actor, d) {
    if (actor.kind === 'user') return;
    const touchesMore = d.name !== undefined || d.remove !== undefined || d.itemIds !== undefined;
    if (!isCoordinator(ctx, actor.name) || touchesMore) humanConfig(actor, isCoordinator(ctx, actor.name) ? 'rename a focus board or take tickets out of it' : 'change focus boards');
  }

  function createFocus(ctx, d, actor) {
    humanConfig(actor, 'create a focus board');
    const name = str(d.name, 80).trim();
    if (!name) fail(400, '"name" is required', { code: 'BAD_REQUEST', hint: 'POST …/focus { "name": "Bonus exclusions, 16 Oct", "itemIds": ["INT-12"] }' });
    return tx(ctx, (events) => {
      const f = { id: rid('fb'), name, itemIds: [], startCols: {}, archived: [], createdAt: now(), createdBy: actor };
      addToFocus(ctx, f, d.itemIds);
      ctx.board.focusBoards.push(f);
      events.push(focusEvent(ctx, 'focus.created', f, actor, { itemIds: [...f.itemIds] }));
      if (d.activate !== false) setActiveFocus(ctx, f, actor, events);
      return f;
    });
  }

  function updateFocus(ctx, id, d, actor) {
    guardFocus(ctx, actor, d);
    return tx(ctx, (events) => {
      const f = getFocus(ctx, id);
      const changes = {};
      if (d.name !== undefined) {
        const name = str(d.name, 80).trim();
        if (!name) fail(400, '"name" cannot be empty');
        if (name !== f.name) { changes.name = { from: f.name, to: name }; f.name = name; }
      }
      const added = addToFocus(ctx, f, d.add);
      const removed = arr(d.remove).map((x) => String(x).toUpperCase()).filter((x) => f.itemIds.includes(x));
      f.itemIds = f.itemIds.filter((x) => !removed.includes(x));
      for (const x of removed) delete f.startCols[x];
      if (added.length || removed.length || Object.keys(changes).length) events.push(focusEvent(ctx, 'focus.updated', f, actor, { added, removed, changes }));
      return f;
    });
  }

  // Make a focus board the active one (or null: the full board). Work the agents hold outside it goes back to
  // the pickup column with a note (assignee kept): they finish nothing outside the focus, and start nothing either.
  function setActiveFocus(ctx, f, actor, events) {
    const was = activeFocus(ctx);
    if ((was?.id || null) === (f?.id || null)) return;
    ctx.board.activeFocus = f ? f.id : null;
    const parked = [];
    if (f) {
      const work = workingColumn(ctx);
      const ready = pickupColumns(ctx)[0];
      for (const item of Object.values(ctx.board.items)) {
        const l = activeLease(item);
        if (!l || !isAgentName(l.claimant) || f.itemIds.includes(item.id)) continue;
        if (work && item.columnId === work.id) {
          backToReady(ctx, item, actor, events, { agent: l.claimant, reason: 'focus', body: `🎯 ${actor.name} is focusing the agents on "${f.name}". @${l.claimant}, this ticket waits in ${ready?.name || 'the pickup column'} (still yours) until the focus board is retired.` });
        } else {
          item.lease = null;
          item.version++;
          events.push(itemEvent(ctx, 'lease.revoked', item, actor, { claimant: l.claimant, reason: 'focus', mentions: [l.claimant] }));
        }
        parked.push(item.id);
      }
    }
    let agents = [];
    try { agents = listStanding().agents.map((a) => a.name); } catch { /* no standing agents */ }
    // Every agent hears it (inbox and …/work) but none is woken just for it: their work already says what to do.
    events.push({ board: ctx.id, type: 'focus.activated', actor, focus: f ? { id: f.id, name: f.name, count: f.itemIds.length } : null, from: was ? { id: was.id, name: was.name } : null, parked, recipients: agents });
  }

  function activateFocus(ctx, id, actor) {
    humanConfig(actor, 'choose the active board');
    return tx(ctx, (events) => { setActiveFocus(ctx, id ? getFocus(ctx, id) : null, actor, events); return activeFocus(ctx); });
  }

  // Retire: the view goes, every ticket stays where it is. The summary says what moved while it was open.
  function retireFocus(ctx, id, actor) {
    humanConfig(actor, 'retire a focus board');
    return tx(ctx, (events) => {
      const f = getFocus(ctx, id);
      const colName = (cid) => ctx.board.columns.find((c) => c.id === cid)?.name || cid;
      const moved = f.itemIds.map((x) => ctx.board.items[x]).filter((it) => it && f.startCols[it.id] && f.startCols[it.id] !== it.columnId)
        .map((it) => ({ id: it.id, title: it.title, from: colName(f.startCols[it.id]), to: colName(it.columnId) }));
      const wasActive = ctx.board.activeFocus === f.id;
      if (wasActive) setActiveFocus(ctx, null, actor, events);
      ctx.board.focusBoards = ctx.board.focusBoards.filter((x) => x !== f);
      const summary = { id: f.id, name: f.name, createdAt: f.createdAt, tickets: f.itemIds.length, moved, archived: f.archived, wasActive };
      events.push(focusEvent(ctx, 'focus.retired', f, actor, { summary }));
      return summary;
    });
  }

  // A ticket that leaves the board (archived, deleted) leaves every focus board with it.
  function dropFromFocus(ctx, id, archived) {
    for (const f of ctx.board.focusBoards) {
      if (!f.itemIds.includes(id)) continue;
      f.itemIds = f.itemIds.filter((x) => x !== id);
      delete f.startCols[id];
      if (archived) f.archived.push(id);
    }
  }
  return { activeFocus, inActiveFocus, focusNames, getFocus, focusView, focusEvent, addToFocus, guardFocus,
    createFocus, updateFocus, activateFocus, retireFocus, dropFromFocus };
}

module.exports = { createFocusBoards };
