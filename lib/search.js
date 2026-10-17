'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Search (GET/POST /api/search): tickets as search sees them, with the review facts, filtered by text, a where
// object (testCond's operators) and a card-rules condition. Reads the board only; it never changes anything.

const cardrules = require('./cardrules');

const getPath = (obj, p) => String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function looseEq(v, x) {
  if (Array.isArray(v)) return v.some((y) => looseEq(y, x));
  if (typeof v === 'string' && typeof x === 'string') return v.toLowerCase() === x.toLowerCase();
  if (v == null || x == null) return v == x; // eslint-disable-line eqeqeq
  return v === x || String(v) === String(x);
}

function cmp(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

const SUMMARY_FIELDS = ['board', 'id', 'title', 'type', 'priority', 'column', 'columnId', 'parent', 'claimant', 'needsHuman', 'fields', 'properties', 'updatedAt', 'version', 'archived', 'review', 'look'];

// GET /api/search shorthand: ?type=spike&prop.risk=high&prop.score=gte:3&claimant=exists:true
const SHORTHAND = { type: 'type', priority: 'priority', column: 'column', claimant: 'claimant', parent: 'parent', author: 'authorName', needsHuman: 'needsHuman', blockedBy: 'blockedBy' };
function searchFromQuery(q) {
  const where = q.where ? JSON.parse(q.where) : {};
  for (const [k, raw] of Object.entries(q)) {
    const field = SHORTHAND[k] || (k.startsWith('prop.') ? `properties.${k.slice(5)}` : k.startsWith('f.') ? `fields.${k.slice(2)}` : k.startsWith('w.') ? k.slice(2) : null);
    if (!field) continue;
    const m = /^(eq|ne|gt|gte|lt|lte|contains|exists|regex|in|nin):(.*)$/s.exec(raw);
    where[field] = m ? { [m[1]]: m[1] === 'in' || m[1] === 'nin' ? m[2].split('|') : m[2] } : raw;
  }
  return { ...q, where };
}

// deps: { fail, isObj, arr, clamp, PRIORITIES, boards (the server's Map of board contexts), getCtx, blocksIndex,
//   itemView, activeLease, verdictStands, ruleErrors, cardRulesOf (shared with the card-rules routes) }
function createSearch({ fail, isObj, arr, clamp, PRIORITIES, boards, getCtx, blocksIndex, itemView, activeLease, verdictStands, ruleErrors, cardRulesOf }) {
  function testCond(v, cond) {
    if (!isObj(cond)) return looseEq(v, cond);
    return Object.entries(cond).every(([op, x]) => {
      switch (op) {
        case 'eq': return looseEq(v, x);
        case 'ne': return !looseEq(v, x);
        case 'in': return arr(x).some((y) => looseEq(v, y));
        case 'nin': return !arr(x).some((y) => looseEq(v, y));
        case 'contains': return Array.isArray(v) ? v.some((y) => looseEq(y, x)) : String(v ?? '').toLowerCase().includes(String(x).toLowerCase());
        case 'gt': return v != null && cmp(v, x) > 0;
        case 'gte': return v != null && cmp(v, x) >= 0;
        case 'lt': return v != null && cmp(v, x) < 0;
        case 'lte': return v != null && cmp(v, x) <= 0;
        case 'exists': return (v !== undefined && v !== null) === (x === true || x === 'true');
        case 'regex': try { return new RegExp(x, 'i').test(String(v ?? '')); } catch { return fail(400, `Invalid regex "${x}"`); }
        default: return fail(400, `Unknown operator "${op}". Use: eq ne in nin contains gt gte lt lte exists regex`);
      }
    });
  }

  // A ticket as search sees it, with the review facts (only verdicts that still stand) and reviewers.<name>.
  function searchView(ctx, item, archived, blocksOf) {
    // Landing cherry-picks the commits, so the list of unlanded commits a verdict recorded is empty afterwards:
    // once a ticket has landed its verified verdicts still stand (nothing more can be committed on it).
    const landed = item.landing?.state === 'landed';
    const facts = cardrules.reviewFacts(item, (r) => (landed ? !!r.verified : verdictStands(item, r, ctx)));
    const v = {
      ...itemView(ctx, item, archived, blocksOf),
      claimant: activeLease(item)?.claimant ?? null,
      authorName: item.author?.name, authorKind: item.author?.kind,
      reviewers: facts.reviewers,
      columnDays: Math.max(0, Math.floor((Date.now() - Date.parse(item.enteredColumnAt || item.updatedAt || item.createdAt)) / 86_400_000)),
    };
    // item.review is the decision record (verdict, by, at…): the facts join it, they do not replace it
    v.review = { ...item.review, ...facts.review };
    if (!archived && cardRulesOf(ctx).length) { const look = cardrules.lookFor(v, cardRulesOf(ctx)); if (look) v.look = look; }
    return v;
  }

  function search(d) {
    const ctxs = d.board ? [getCtx(d.board)] : [...boards.values()];
    const where = isObj(d.where) ? d.where : {};
    const terms = String(d.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const filter = d.filter ? ruleErrors(() => cardrules.parseCondition(d.filter)) : null;
    const out = [];
    for (const ctx of ctxs) {
      const pools = [ctx.board.columns.flatMap((c) => c.itemIds.map((id) => [ctx.board.items[id], false]))];
      if (d.includeArchived === true || d.includeArchived === 'true') pools.push(Object.values(ctx.archive.items).map((x) => [x, true]));
      const blocksOf = blocksIndex(ctx);
      for (const [item, archived] of pools.flat()) {
        const v = searchView(ctx, item, archived, blocksOf);
        if (filter && !cardrules.holds(filter, v, cardRulesOf(ctx).filter((r) => r.enabled !== false))) continue;
        if (terms.length) {
          const hay = [v.id, v.title, v.description, v.parent, JSON.stringify(v.properties), ...v.comments.map((c) => c.body)].join(' ').toLowerCase();
          if (!terms.every((t) => hay.includes(t))) continue;
        }
        if (!Object.entries(where).every(([k, cond]) => testCond(getPath(v, k), cond))) continue;
        out.push(v);
      }
    }
    if (d.sort) {
      const dir = d.order === 'desc' ? -1 : 1;
      const key = d.sort === 'priority' ? (x) => PRIORITIES.indexOf(x.priority) : (x) => getPath(x, d.sort);
      out.sort((a, b) => dir * cmp(key(a), key(b)));
    }
    const limit = clamp(Number(d.limit) || 50, 1, 500);
    const fields = d.full === true || d.full === 'true' ? null : arr(d.fields).length ? arr(d.fields) : SUMMARY_FIELDS;
    const items = out.slice(0, limit).map((v) => (fields ? Object.fromEntries(fields.map((f) => [f, getPath(v, f)])) : v));
    return { total: out.length, count: items.length, items };
  }

  return { search, searchView, testCond };
}

module.exports = { createSearch, searchFromQuery, getPath, SUMMARY_FIELDS };
