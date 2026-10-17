'use strict';
/* Automatic rebalancing (INT-234): which queued tickets should change hands, and why. A pure function of the
   board's state: no clock, no I/O, no writes, so every rail is a plain unit test. The board applies the moves
   (assignee, a comment, lastMovedAt) and decides when to ask (an agent added, removed, away for long, a sweep).

   It can't loop: nothing it writes feeds back into it except lastMovedAt, and that only ever blocks a move.
   It can't ping-pong: a move must leave the source at least as long as the target, and a ticket moves at most
   once per onceEveryMinutes. It wakes little: each move is one assignment (it wakes the new owner), capped per
   call. */

const DEFAULTS = { minGap: 3, minWaitMinutes: 60, maxMoves: 3, onceEveryMinutes: 24 * 60 };

const slash = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
// Paths a ticket names in its text: anything with a slash or a file extension (lib/agents/, server.js, `public/app.js`)
const pathsIn = (text) => [...new Set((String(text || '').match(/[\w.@-]+(?:\/[\w.@-]*)+|[\w-]+\.(?:js|ts|json|css|md|html|cs|mjs|cjs)\b/g) || []).map(slash))];
const under = (p, area) => { const a = slash(area); return p === a.replace(/\/$/, '') || p.startsWith(a.endsWith('/') ? a : `${a}/`); };
const hits = (paths, areas) => paths.filter((p) => (areas || []).some((a) => under(p, a))).length;

// Why a ticket stays where it is, or null when it may move. assignedByHuman counts as a pin: a deliberate choice.
function staysBecause(t, now, s) {
  if (!t.inPickup) return 'not in a pickup column';
  if (t.held) return 'held';
  if (t.started) return 'already worked on';
  if (t.waitingOnHuman) return 'waiting on the human';
  if (t.blocked) return 'blocked';
  if (t.pinned) return 'pinned';
  if (t.assignedByHuman) return 'assigned by the human';
  if (t.lastMovedAt != null && now - t.lastMovedAt < s.onceEveryMinutes * 60_000) return 'moved recently';
  return null;
}

/**
 * agents:  [{ name, state: 'active' | 'away' | 'removed' | 'off', awayAs?, edits, role, tier, areas, columns? }]
 *          away = paused or failed on its own for long; removed = no longer in agents.json; off = neither;
 *          columns = the column ids it may work in (null: any)
 * tickets: [{ id, assignee, column, inPickup, held, started, waitingOnHuman, blocked, pinned, assignedByHuman,
 *             queuedAt, lastMovedAt (ms), text, area: [], risk }]
 * → [{ id, from, to, why }], at most settings.maxMoves (a removed agent's tickets are never capped)
 */
function plan({ agents = [], tickets = [], now, settings = {} }) {
  const s = { ...DEFAULTS, ...settings };
  const targets = agents.filter((a) => a.state === 'active' && a.edits);
  if (!targets.length) return [];
  // queue length: every unstarted ticket in a pickup column, movable or not, so a pinned backlog still counts
  const queue = new Map(agents.map((a) => [a.name, 0]));
  for (const t of tickets) if (t.inPickup && !t.started && queue.has(t.assignee)) queue.set(t.assignee, queue.get(t.assignee) + 1);
  const oldest = new Map();
  for (const t of tickets) if (t.inPickup && !t.started && t.queuedAt != null) oldest.set(t.assignee, Math.min(oldest.get(t.assignee) ?? Infinity, t.queuedAt));

  const moves = [];
  const moved = new Set();
  const paths = new Map(tickets.map((t) => [t.id, pathsIn(t.text)]));
  // best target for a ticket: owns its files, then the right role, then the right tier, then the shortest queue
  const rank = (t, a) => [
    hits(paths.get(t.id), a.areas),
    ([].concat(t.area || []).includes('design') ? a.role === 'designer' : a.role !== 'designer') ? 1 : 0,
    t.risk === 'high' ? (a.tier === 'senior' ? 1 : 0) : 0,
    -queue.get(a.name),
  ];
  const better = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

  // a removed agent's tickets first (all of them, at once), then an away agent's, then the longest queues
  const order = { removed: 0, away: 1, active: 2 };
  // an agent that is off (disabled, paused or failed but not yet away for long) neither gives nor takes
  const sources = agents.filter((a) => a.state in order && queue.get(a.name)).sort((a, b) => order[a.state] - order[b.state] || queue.get(b.name) - queue.get(a.name) || a.name.localeCompare(b.name));
  for (const src of sources) {
    const mine = tickets.filter((t) => t.assignee === src.name).sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0) || String(a.id).localeCompare(String(b.id)));
    for (const t of mine) {
      if (src.state !== 'removed' && moves.length >= s.maxMoves) return moves;
      if (moved.has(t.id)) continue;
      // a removed agent can't keep anything: even a pin or a recent move gives way (the pin named an agent that is gone)
      if (src.state === 'removed' ? !t.inPickup || t.held || t.started : staysBecause(t, now, s)) continue;
      let best = null;
      for (const a of targets) {
        if (a.name === src.name) continue;
        // the manifest's permissions.<name>.columns: never propose a move the board would throw away
        if (a.columns && !a.columns.includes(t.column)) continue;
        if (src.state === 'active') {
          const gap = queue.get(src.name) - queue.get(a.name);
          // hysteresis: a real imbalance, a queue that has waited, and a move that can't be undone by the next one
          if (gap < s.minGap || gap < 2 || now - (oldest.get(src.name) ?? now) < s.minWaitMinutes * 60_000) continue;
          // never take work from the agent that owns its files to one that doesn't
          if (hits(paths.get(t.id), a.areas) < hits(paths.get(t.id), src.areas)) continue;
        }
        if (!best || better(rank(t, a), rank(t, best))) best = a;
      }
      if (!best) continue;
      const owns = hits(paths.get(t.id), best.areas);
      const why = src.state === 'removed' ? `${src.name} was removed`
        : src.state === 'away' ? `${src.name} has been ${src.awayAs || 'away'} for long`
          : `${src.name} had ${queue.get(src.name)} queued, ${best.name} ${queue.get(best.name)}`;
      moves.push({ id: t.id, from: src.name, to: best.name, why: `${why}${owns ? `; ${best.name} owns its files` : ''}` });
      moved.add(t.id);
      queue.set(src.name, queue.get(src.name) - 1);
      queue.set(best.name, queue.get(best.name) + 1);
    }
  }
  return moves;
}

module.exports = { plan, DEFAULTS, pathsIn, staysBecause };
