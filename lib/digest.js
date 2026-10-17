'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// The daily digest (GET/POST …/digest, and the summary finish posts): end-of-session summaries per day, kept
// to the newest 500 on the board, with what each agent learned that day beside them.

const MAX = 500;

// deps: { rid, now, trimChange, learnedSince(ms): memory entries learned since then }
function createDigest({ rid, now, trimChange, learnedSince }) {
  // Append one entry inside a tx: the caller has already trimmed the summary and picked the items.
  function add(ctx, events, actor, summary, items) {
    const entry = { id: rid('d'), date: new Date().toLocaleDateString('en-CA'), ts: now(), author: actor, summary, items };
    ctx.board.digest.push(entry);
    if (ctx.board.digest.length > MAX) ctx.board.digest.splice(0, ctx.board.digest.length - MAX);
    events.push({ board: ctx.id, type: 'digest.added', actor, entry: { id: entry.id, summary: trimChange(entry.summary) } });
    return entry;
  }
  // The last `days` days, newest first: { date, entries, learned? }
  function read(ctx, days) {
    const sinceMs = Date.now() - days * 86_400_000;
    const since = new Date(sinceMs).toLocaleDateString('en-CA');
    const byDay = {};
    for (const e of ctx.board.digest) if (e.date >= since) (byDay[e.date] ||= { entries: [] }).entries.push(e);
    for (const l of learnedSince(sinceMs)) {
      const date = new Date(l.at).toLocaleDateString('en-CA');
      if (date >= since) ((byDay[date] ||= { entries: [] }).learned ||= []).push(l);
    }
    return Object.entries(byDay).sort(([a], [b]) => b.localeCompare(a)).map(([date, d]) => ({ date, entries: d.entries.sort((a, b) => b.ts.localeCompare(a.ts)), ...(d.learned ? { learned: d.learned } : {}) }));
  }
  return { add, read };
}

module.exports = { createDigest };
