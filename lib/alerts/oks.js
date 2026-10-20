'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Grant scopes and the reviewer-ok rules a delegated approval needs (INT-382). Pure over a ticket, except whether
// a verdict still stands (it compares the commits the ticket has now, a git lookup): that is injected, with the clock.
const { authorsOf } = require('./board');
const { getPath } = require('../search');

/**
 * deps: { verdictStands(item, reviewer, ctx) → bool, now: () => ms }
 */
function createOks({ verdictStands, now = () => Date.now() }) {
  function inScope(ctx, item, where) {
    if (!where || !item) return true;
    return Object.entries(where).every(([k, want]) => {
      const wants = [].concat(want).map((v) => String(v).toLowerCase());
      // by id, or the name the id was made from (server.js slug), never the name now: agents may rename columns (INT-418)
      if (k === 'column') return wants.some((w) => w.trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) === item.columnId);
      // reviewers.<name>: that reviewer's current verdict (ok | concerns). It counts only while it stands: given
      // with the reviewer's own token, and about the commits the ticket has now. No verdict matches nothing.
      const rv = /^reviewers\.([\w.-]+)$/.exec(k);
      if (rv) {
        const r = (item.reviewers || []).find((x) => x.name.toLowerCase() === rv[1].toLowerCase());
        return !!r?.verdict && verdictStands(item, r, ctx) && wants.includes(String(r.verdict).toLowerCase());
      }
      const have = [].concat(getPath(item, k) ?? []).map((v) => String(v).toLowerCase());
      return have.some((v) => wants.includes(v));
    });
  }
  // Where a grant's required-reviewers rule stands on this ticket. An ok counts while it stands (verdictStands:
  // given with the reviewer's own token, about the commits the ticket has now) and comes from someone who could
  // review it (never an author). A rule is a condition on the ticket as it is, not a token an ok is spent on, so
  // one ok can satisfy any number of rules, as GitHub's required reviewers do.
  // → { met, need, have, short: [{ name, state }], key, text, early } — state: unassigned | waiting | concerns |
  // unverified | stale; early: every shortfall is a verdict asked for less than 30 min ago (nothing to chase yet).
  function okStatus(ctx, item, g) {
    if (!g.minOks) return { met: true };
    if (!item) return { met: false, need: 1, have: 0, short: [], key: 'oks:no-ticket', text: 'a ticket with reviewers (this rule only applies to one)', early: false };
    const authors = authorsOf(item);
    const rs = item.reviewers || [];
    const find = (n) => rs.find((r) => r.name.toLowerCase() === n);
    const from = g.from ? g.from.map((n) => String(n).toLowerCase()) : null; // names compared without regard to capitals
    const pool = (from || rs.map((r) => r.name.toLowerCase())).filter((n) => ![...authors].some((a) => a.toLowerCase() === n));
    const need = g.minOks === 'all' ? Math.max(1, (from || pool).length) : g.minOks;
    const state = (n) => {
      const r = find(n);
      if (!r) return 'unassigned';
      if (!r.verdict) return 'waiting';
      if (r.verdict !== 'ok') return 'concerns';
      if (!r.verified) return 'unverified';
      return verdictStands(item, r, ctx) ? 'ok' : 'stale';
    };
    const states = pool.map((name) => ({ name, state: state(name) }));
    const have = states.filter((s) => s.state === 'ok').length;
    if (have >= need) return { met: true, need, have };
    const short = states.filter((s) => s.state !== 'ok');
    const WHY = { unassigned: 'not assigned as reviewer', waiting: 'verdict pending', concerns: 'has concerns', unverified: "ok can't count: the board doesn't check that reviewer's token", stale: 'ok is stale: commits since' };
    const missing = need - have;
    // Authors named in "from" can never count; say so, or a rule that can't be met looks like a slow reviewer.
    const lost = (from || []).filter((n) => !pool.includes(n));
    // Named reviewers are a fixed list; without "from", more reviewers can still be assigned.
    const impossible = !!g.from && pool.length < need;
    const unstaffed = !g.from && pool.length < need ? need - pool.length : 0;
    const text = impossible
      ? `${need} ok(s) from ${g.from.join(', ')}, but only ${pool.length} of them can review it${lost.length ? ` (${lost.join(', ')} worked on it)` : ''}`
      : `${missing} more ok(s)${g.from ? ` from ${g.from.join(', ')}` : ' from the assigned reviewers'}${short.length ? `: ${short.map((s) => `${s.name} ${WHY[s.state]}`).join('; ')}` : ''}${unstaffed ? `${short.length ? '; ' : ': '}${unstaffed} more reviewer(s) to assign` : ''}`;
    const early = !impossible && !unstaffed && short.length > 0 && short.every((s) => s.state === 'waiting' && now() - Date.parse(find(s.name).at || 0) < 30 * 60_000);
    return { met: false, need, have, short, key: `oks:${impossible ? 'impossible' : [...short.map((s) => `${s.name}=${s.state}`), ...(unstaffed ? [`assign=${unstaffed}`] : [])].join(',')}`, text, early };
  }
  // A grant that says whose oks it needs (minOks, or where: reviewers.<name>) is the human's own rule, and it
  // already wants at least one ok that stands. A grant without one gets the floor below.
  const reviewerRule = (g) => !!g?.minOks || Object.keys(g?.where || {}).some((k) => k.startsWith('reviewers.'));
  // The floor under a delegated approval whose grant has no reviewer rule: each reviewer assigned to the ticket (an
  // author never counts) has an ok that stands, and there is at least one. No verdict yet is not "no concerns".
  // → okStatus's answer, plus none: true when nobody who could review it is assigned.
  function assignedOks(ctx, item) {
    const st = okStatus(ctx, item, { minOks: 'all' });
    if (st.met) return st;
    const authors = [...authorsOf(item)].map((a) => a.toLowerCase());
    const none = !(item.reviewers || []).some((r) => !authors.includes(r.name.toLowerCase()));
    return none ? { ...st, none, key: 'reviewer:unassigned', text: 'a reviewer (no reviewer yet: the coordinator assigns one)' } : st;
  }

  return { inScope, okStatus, reviewerRule, assignedOks };
}

module.exports = { createOks };
