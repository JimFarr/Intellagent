'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* events: the event log (events.jsonl, rotated while the board runs), the filter every reader uses, emit, the live
   stream, long-polls and the subscriptions store. The routes stay in server.js. seq is read through currentSeq(). */

// deps: { fs, path, DATA, M (the manifest: eventsMaxMB, eventsKeep), now, arr, boards, reply, HANDLED, presenceDelta,
//   app, VERSION, BUILD, readJson, writeFileAtomic, onEvent (the standing agents', set at boot, so read when called) }
const { parseFilter: parseFilterWith, matchesFilter } = require('./alerts/filters');

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

  // The seq of a log's last whole line, read from its end only
  function lastSeq(file) {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(size, 256 * 1024));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    for (const l of buf.toString('utf8').split('\n').reverse()) { try { return JSON.parse(l).seq; } catch { /* partial line */ } }
    return 0;
  }

  (function loadEvents() {
    // Keep numbering going: every agent's saved cursor, the scheduler's duplicate check and the runs'
    // Idempotency-Keys refer to it. Rotated and restarted before the next event: carry on from the set-aside log.
    if (!fs.existsSync(EVENTS_FILE)) {
      const newest = fs.readdirSync(DATA).filter((f) => /^events-\d+\.jsonl$/.test(f)).sort((a, b) => Number(b.slice(7, -6)) - Number(a.slice(7, -6)))[0];
      if (newest) seq = lastSeq(path.join(DATA, newest));
      return;
    }
    const size = fs.statSync(EVENTS_FILE).size;
    if (size > EVENTS_MAX) {
      seq = lastSeq(EVENTS_FILE);
      rotateEvents();
      return;
    }
    eventsBytes = size;
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean).slice(-RECENT_MAX);
    for (const l of lines) { try { recent.push(JSON.parse(l)); } catch { /* skip torn line */ } }
    seq = recent.length ? recent[recent.length - 1].seq : 0;
  }());

  // which events a subscriber receives: lib/alerts/filters.js, shared with the alerting simulator (INT-383)
  const parseFilter = (src = {}) => parseFilterWith(src, (board, ref) => {
    const r = String(ref).toLowerCase();
    return boards.has(board) ? boards.get(board).board.columns.find((c) => c.id === r || c.name.toLowerCase() === r)?.id : undefined;
  });

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
