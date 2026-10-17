'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* events: the event log (events.jsonl, rotated while the board runs), the filter every reader uses, emit, the live
   stream, long-polls and the subscriptions store. The routes stay in server.js. seq is read through currentSeq(). */

// deps: { fs, path, DATA, M (the manifest: eventsMaxMB, eventsKeep), now, arr, boards, reply, HANDLED, presenceDelta,
//   app, VERSION, BUILD, readJson, writeFileAtomic, onEvent (the standing agents', set at boot, so read when called) }
function createEvents({ fs, path, DATA, M, now, arr, boards, reply, HANDLED, presenceDelta, app, VERSION, BUILD, readJson, writeFileAtomic, onEvent }) {
  const EVENTS_FILE = path.join(DATA, 'events.jsonl');
  const RECENT_MAX = 5000;
  const recent = [];
  let seq = 0;

  // events.jsonl is set aside as events-<ms>.jsonl once it passes eventsMaxMB (manifest, default 20), while the
  // board runs and at boot; only the newest eventsKeep (default 5) of those are kept.
  const EVENTS_MAX = Math.max(0.001, Number(M.eventsMaxMB) || 20) * 1024 * 1024;
  const EVENTS_KEEP = M.eventsKeep == null ? 5 : Math.max(0, Number(M.eventsKeep) || 0);
  let eventsBytes = 0;
  function rotateEvents() {
    try { fs.renameSync(EVENTS_FILE, path.join(DATA, `events-${Date.now()}.jsonl`)); } catch (e) { console.warn(`event log not rotated: ${e.message}`); return; }
    eventsBytes = 0;
    const old = fs.readdirSync(DATA).filter((f) => /^events-\d+\.jsonl$/.test(f)).sort((a, b) => Number(a.slice(7, -6)) - Number(b.slice(7, -6)));
    for (const f of old.slice(0, Math.max(0, old.length - EVENTS_KEEP))) {
      try { fs.unlinkSync(path.join(DATA, f)); } catch (e) { console.warn(`old event log ${f} not removed: ${e.message}`); }
    }
  }

  (function loadEvents() {
    if (!fs.existsSync(EVENTS_FILE)) return;
    const size = fs.statSync(EVENTS_FILE).size;
    if (size > EVENTS_MAX) {
      // Keep numbering going: every agent's saved cursor refers to it.
      const fd = fs.openSync(EVENTS_FILE, 'r');
      const buf = Buffer.alloc(Math.min(size, 256 * 1024));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      fs.closeSync(fd);
      for (const l of buf.toString('utf8').split('\n').reverse()) { try { seq = JSON.parse(l).seq; break; } catch { /* partial line */ } }
      rotateEvents();
      return;
    }
    eventsBytes = size;
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean).slice(-RECENT_MAX);
    for (const l of lines) { try { recent.push(JSON.parse(l)); } catch { /* skip torn line */ } }
    seq = recent.length ? recent[recent.length - 1].seq : 0;
  }());

  function parseFilter(src = {}) {
    const list = (v) => (v == null || v === '' ? undefined : arr(v));
    const f = {
      board: src.board || undefined,
      types: list(src.types ?? src.type),
      itemId: src.itemId ? String(src.itemId).toUpperCase() : undefined,
      columnId: src.columnId || src.column || undefined,
      claimant: src.claimant || undefined,
      for: src.for || undefined,
      addressed: src.addressed || undefined,
      itemType: src.itemType || undefined,
      parent: src.parent || undefined,
      fields: list(src.fields ?? src.field),
      actorKind: src.actorKind || undefined,
      excludeActor: src.excludeActor || undefined,
      assignee: src.assignee || undefined,
      actor: src.actor || undefined,
      run: src.run || undefined,
    };
    if (f.columnId && f.board && boards.has(f.board)) {
      const r = String(f.columnId).toLowerCase();
      const col = boards.get(f.board).board.columns.find((c) => c.id === r || c.name.toLowerCase() === r);
      if (col) f.columnId = col.id;
    }
    return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
  }

  /*
   * Decide whether an event should be delivered to a subscriber.
   *
   * event  — { seq, ts, board, type, actor:{kind,name}, itemId?, columnId?, fromColumnId?,
   *            changes?: { 'priority': {from,to}, 'properties.risk': {from,to}, ... },
   *            item?: { id, title, type, priority, columnId, column, parent, claimant, needsHuman },
   *            claimant?, recipients?: string[], mentions?: string[] }
   * filter — output of parseFilter(); every key is optional:
   *            { board, types[], itemId, columnId, claimant, for, itemType, parent, fields[], actorKind, excludeActor }
   *
   * An empty filter {} must match everything (the UI's live stream relies on this).
   */
  function matchesFilter(event, filter) {
    const same = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();
    const typeHit = (t) => t === '*' || t === event.type || (t.endsWith('*') && event.type.startsWith(t.slice(0, -1)));
    if (filter.board && event.board !== filter.board) return false;
    if (filter.types && !filter.types.some(typeHit)) return false;
    if (filter.itemId && event.itemId !== filter.itemId) return false;
    // destination column, by id or (case-insensitive) name
    if (filter.columnId && !same(event.columnId, filter.columnId) && !same(event.item?.column, filter.columnId)) return false;
    // lease events carry the claimant directly; item events carry the current leaseholder in the snapshot
    if (filter.claimant && !same(event.claimant, filter.claimant) && !same(event.item?.claimant, filter.claimant)) return false;
    if (filter.for && !(event.recipients || []).some((r) => same(r, filter.for))) return false;
    if (filter.addressed && !(event.addressed || []).some((r) => same(r, filter.addressed))) return false;
    if (filter.itemType && !same(event.item?.type, filter.itemType)) return false;
    if (filter.parent && !same(event.item?.parent, filter.parent)) return false;
    // "properties" matches any properties.* change; "properties.risk" matches exactly
    if (filter.fields) {
      const changed = Object.keys(event.changes || {});
      if (!filter.fields.some((f) => changed.some((c) => c === f || c.startsWith(`${f}.`)))) return false;
    }
    if (filter.assignee && !same(event.item?.assignee, filter.assignee) && !same(event.assignee, filter.assignee)) return false;
    if (filter.actor && !same(event.actor?.name, filter.actor)) return false;
    if (filter.actorKind && event.actor?.kind !== filter.actorKind) return false;
    if (filter.run && event.actor?.run !== filter.run) return false;
    if (filter.excludeActor && same(event.actor?.name, filter.excludeActor)) return false;
    return true;
  }

  const sseClients = new Set();
  const waiters = new Set();

  // sync (from tx()) goes to the board page's live stream only: never into the log or an agent's events.
  function emit(ev, sync = null) {
    const e = { seq: ++seq, ts: now(), ...ev };
    if (e.board && boards.has(e.board)) e.hash = boards.get(e.board).hash;
    const line = `${JSON.stringify(e)}\n`;
    fs.appendFileSync(EVENTS_FILE, line);
    eventsBytes += Buffer.byteLength(line);
    if (eventsBytes > EVENTS_MAX) rotateEvents();
    recent.push(e);
    if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
    let forUi = null;
    for (const c of sseClients) {
      if (!matchesFilter(e, c.filter)) continue;
      sseSend(c.res, c.ui && sync ? (forUi ||= withSync(e, sync)) : e);
    }
    for (const w of [...waiters]) if (matchesFilter(e, w.filter)) w.check();
    onEvent(e);
    return e;
  }

  function sseSend(res, e) { res.write(`${e.seq != null ? `id: ${e.seq}\n` : ''}data: ${JSON.stringify(e)}\n\n`); }
  // The board page's copy of a write's first event, with the changed tickets as they are now: exactly the write's
  // result, since tx() emits right after saving (null = the ticket left the board). An event replayed later has
  // no sync, so the page fetches the board instead.
  function withSync(e, sync) {
    if (sync.full) return { ...e, sync };
    const items = boards.get(e.board)?.board.items || {};
    return { ...e, sync: { ...sync, items: Object.fromEntries(sync.items.map((id) => [id, items[id] ?? null])) } };
  }

  // A cursor from before a data reset can be ahead of the log; treat it as "now" instead of waiting forever.
  const clampSince = (n) => (Number.isFinite(n) && n <= seq ? n : seq);
  function longPoll(res, { filter, since, timeout, limit = 100, agent, onDeliver, tail = false }) {
    since = clampSince(since);
    const collect = () => {
      const hits = recent.filter((e) => e.seq > since && matchesFilter(e, filter));
      return tail ? hits.slice(-limit) : hits.slice(0, limit);
    };
    const send = (events) => {
      const cursor = events.length ? events[events.length - 1].seq : seq;
      onDeliver?.(cursor);
      reply(res, 200, { events, cursor, truncated: recent.length > 0 && since < recent[0].seq - 1 });
    };
    const first = collect();
    if (first.length || timeout <= 0) { send(first); return HANDLED; }
    const w = { filter, agent };
    const cleanup = () => {
      clearTimeout(timer);
      waiters.delete(w);
      if (agent) presenceDelta(agent, 'waiting', -1);
    };
    w.check = () => { const evs = collect(); if (evs.length) { cleanup(); send(evs); } };
    const timer = setTimeout(() => { cleanup(); send([]); }, timeout * 1000);
    res.on('close', () => { if (waiters.has(w)) cleanup(); });
    waiters.add(w);
    if (agent) presenceDelta(agent, 'waiting', +1);
    return HANDLED;
  }

  function openStream(req, res, filter, agent, ui = false) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const lastId = Number(req.headers['last-event-id']) || 0;
    if (lastId) for (const e of recent) if (e.seq > lastId && matchesFilter(e, filter)) sseSend(res, e);
    res.write(`data: ${JSON.stringify({ type: 'hello', seq, app: app.name, version: VERSION, build: BUILD })}\n\n`);
    const c = { res, filter, agent, ui };
    sseClients.add(c);
    if (agent) presenceDelta(agent, 'sse', +1);
    req.on('close', () => { sseClients.delete(c); if (agent) presenceDelta(agent, 'sse', -1); });
    return HANDLED;
  }

  setInterval(() => { for (const c of sseClients) c.res.write(': ping\n\n'); }, 20_000).unref();

  const SUBS_FILE = path.join(DATA, 'subscriptions.json');
  const subs = readJson(SUBS_FILE, {});
  const saveSubs = () => writeFileAtomic(SUBS_FILE, JSON.stringify(subs, null, 2));

  return {
    recent, currentSeq: () => seq, parseFilter, matchesFilter, sseClients, waiters, emit, sseSend,
    longPoll, openStream, subs, saveSubs,
  };
}

module.exports = { createEvents };
