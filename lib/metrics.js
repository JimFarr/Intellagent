'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Flow metrics over a window (GET …/metrics): tickets done, cycle time, time per column, waiting on the human,
// answer time, delegated decisions and idle-board alarms. Reads the board only; it never changes anything.

const median = (xs) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const HOUR = 3600_000;

// deps: { doneColumnId(ctx), workingColumn(ctx), recent: the server's in-memory event list (read live) }
// usageHeldMinutes(fromMs, toMs): minutes optional work was held back for the account's usage (INT-296)
function createMetrics({ doneColumnId, workingColumn, recent, usageHeldMinutes = null }) {
  return function metrics(ctx, days) {
    const b = ctx.board;
    const nowMs = Date.now();
    const from = nowMs - days * 86_400_000;
    const prevFrom = from - days * 86_400_000;
    const cols = b.columns;
    const done = doneColumnId(ctx);
    const work = workingColumn(ctx);
    const all = [...Object.values(b.items), ...Object.values(ctx.archive.items)].filter((it) => !it.test);
    const t = (x) => Date.parse(x);

    // Throughput + cycle time: tickets that reached the last column in the window.
    // Cycle time runs from first entering the working column (or creation, if it never did) to done.
    const finishedIn = (lo, hi) => all.map((it) => {
      const end = (it.flow || []).filter((f) => f.col === done && t(f.at) >= lo && t(f.at) < hi).at(-1);
      if (!end) return null;
      const start = (it.flow || []).find((f) => work && f.col === work.id) || { at: it.createdAt };
      return { it, ms: Math.max(0, t(end.at) - t(start.at)), at: t(end.at) };
    }).filter(Boolean);
    const finished = finishedIn(from, nowMs + 1);
    const before = finishedIn(prevFrom, from);
    const perDay = Array.from({ length: days }, (_, i) => finished.filter((f) => f.at >= from + i * 86_400_000 && f.at < from + (i + 1) * 86_400_000).length);

    // Time spent per column: stays that ended inside the window, plus what is sitting there now.
    const stays = Object.fromEntries(cols.map((c) => [c.id, []]));
    for (const it of all) {
      const fl = it.flow || [];
      for (let i = 0; i < fl.length - 1; i++) {
        const end = t(fl[i + 1].at);
        if (end >= from && stays[fl[i].col]) stays[fl[i].col].push(end - t(fl[i].at));
      }
    }
    const columns = cols.map((c) => {
      const real = c.itemIds.filter((id) => b.items[id] && !b.items[id].test);
      const ages = real.map((id) => nowMs - t(b.items[id].enteredColumnAt || nowMs));
      return { id: c.id, name: c.name, color: c.color, count: real.length, medianStayHours: stays[c.id].length ? median(stays[c.id]) / HOUR : null, oldestHours: ages.length ? Math.max(...ages) / HOUR : null };
    });
    const middle = columns.slice(1, -1).filter((c) => c.medianStayHours != null);
    const slowest = middle.sort((x, y) => y.medianStayHours - x.medianStayHours)[0] || null;

    // Waiting on the human: open questions now, and how fast they were answered in the window.
    const open = Object.values(b.items).filter((it) => !it.test).flatMap((it) => (it.questions || []).map((q) => ({ id: it.id, kind: q.kind, ms: nowMs - t(q.raisedAt) })));
    const answered = all.flatMap((it) => (it.waits || []).filter((w) => t(w.resolvedAt) >= from).map((w) => ({ kind: w.kind, ms: t(w.resolvedAt) - t(w.raisedAt) })));
    const byAgent = {};
    for (const f of finished) for (const n of new Set(f.it.workedBy || [])) byAgent[n] = (byAgent[n] || 0) + 1;

    return {
      days, from: new Date(from).toISOString(),
      done: finished.length, donePrev: before.length, perDay,
      cycleHours: { median: finished.length ? median(finished.map((f) => f.ms)) / HOUR : null, prev: before.length ? median(before.map((f) => f.ms)) / HOUR : null },
      waiting: { open: open.length, reviews: open.filter((q) => q.kind === 'review').length, oldestHours: open.length ? Math.max(...open.map((q) => q.ms)) / HOUR : null, oldestId: open.sort((x, y) => y.ms - x.ms)[0]?.id || null },
      answerHours: { median: answered.length ? median(answered.map((a) => a.ms)) / HOUR : null, count: answered.length },
      columns, slowest: slowest ? { name: slowest.name, medianStayHours: slowest.medianStayHours } : null,
      byAgent,
      delegated: (() => {
        const evs = recent.filter((e) => e.board === ctx.id && e.delegated && t(e.ts) >= from);
        // board admin (INT-256): admin.* changes to the board's settings, counted on their own
        const kind = (e) => (String(e.delegated.power || '').startsWith('admin.') ? 'admin' : e.type.startsWith('review.') ? 'reviews' : e.type === 'item.moved' ? 'moves' : null);
        const by = {};
        for (const e of evs) { const k = kind(e); if (!k) continue; const n = e.actor?.name || '?'; by[n] ||= { reviews: 0, moves: 0, admin: 0 }; by[n][k]++; }
        return { reviews: evs.filter((e) => kind(e) === 'reviews').length, moves: evs.filter((e) => kind(e) === 'moves').length, admin: evs.filter((e) => kind(e) === 'admin').length, byAgent: by };
      })(),
      // How often the board went idle with work waiting: the idle-board alarms in the window (INT-265)
      idle: (() => {
        const log = b.idleLog || [];
        const inWin = log.filter((a) => t(a.at) >= from);
        return { alarms: inWin.length, prev: log.filter((a) => t(a.at) >= prevFrom && t(a.at) < from).length,
          longestMinutes: inWin.length ? Math.max(...inWin.map((a) => a.idleMinutes || 0)) : null, lastAt: log.at(-1)?.at || null };
      })(),
      // Minutes pickup and supervise nudges waited because the account was nearly spent (INT-296)
      usageHeld: usageHeldMinutes ? { minutes: usageHeldMinutes(from, nowMs), prev: usageHeldMinutes(prevFrom, from) } : null,
    };
  };
}

module.exports = { createMetrics, median };
