'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Area notes (INT-403): what a run learned about a part of the code, kept by area (a file or a folder of the
// project), so whichever agent works there next reads it instead of working it out again. Agent memory is one
// agent's; a note belongs to the code. Any agent or the human adds one; another agent confirms one that helped or
// retires one that is wrong (with why); the author or the human edits it; the human removes any. Notes are only
// text an agent reads: nothing here grants anything.
//
//   note: { id, area, text, by, from?, at, confirmedBy?: [names], editedAt?, editedBy?, history? }
//   retired: the same, plus { retiredAt, retiredBy, why }, kept a while for the record
const jsonfile = require('./jsonfile');

const TEXT_MAX = 600;      // one lesson, not the story
const PER_AREA = 8;        // an area keeps its most useful notes; the least confirmed, oldest goes first
const TOTAL_MAX = 400;
const RETIRED_MAX = 200;
const HISTORY_MAX = 3;

// A repo path as notes key it: relative, forward slashes, no leading ./ or /, a folder ends with "/".
// "" is the whole project. Anything that climbs out of the project, or is absolute, is refused.
function areaOf(v) {
  let a = String(v ?? '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/{2,}/g, '/');
  if (/^([a-z]:|\/)/i.test(a) || a.split('/').includes('..')) return null;
  if (a === '.' || a === '/') a = '';
  return a;
}
// Does a note about `area` concern `path`? A folder note covers what is in it; asking about a folder also finds
// the notes on what is in it.
function covers(area, path) {
  if (area === '' || area === path) return true;
  if (area.endsWith('/') && path.startsWith(area)) return true;
  if (path.endsWith('/') && area.startsWith(path)) return true;
  return false;
}
// Repo paths named in a ticket's text: `lib/alerts/work.js`, public/app.js, docs/, server.js
const PATH_RE = /(?:^|[\s`'"(\[])((?:[\w.-]+\/)+[\w.-]*|[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|css|html|md|py|go|rs|java|cs|yml|yaml|sh))(?=$|[\s`'"),.:;\]])/g;
function pathsIn(text, max = 20) {
  const out = new Set();
  for (const m of String(text || '').matchAll(PATH_RE)) {
    const a = areaOf(m[1].replace(/[.:]+$/, ''));
    if (a && !/^https?:/.test(m[1]) && !a.includes('://')) out.add(a);
    if (out.size >= max) break;
  }
  return [...out];
}

// "area: text" lines (or a list of { area, text }), as a review's `learned` part sends them. "none" says the
// author looked and found nothing worth keeping.
function parseLearned(v) {
  if (v == null || v === '') return { notes: [], none: false };
  const list = Array.isArray(v) ? v : String(v).split(/\r?\n/).map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean);
  if (list.length === 1 && typeof list[0] === 'string' && /^(none|nothing)\.?$/i.test(list[0])) return { notes: [], none: true };
  const notes = [];
  const bad = [];
  for (const x of list) {
    if (x && typeof x === 'object') { notes.push({ area: x.area, text: x.text }); continue; }
    const m = /^`?([^`:\s][^`:]*?)`?\s*:\s+(.+)$/.exec(String(x));
    if (m && areaOf(m[1]) != null) notes.push({ area: m[1], text: m[2] }); else bad.push(String(x));
  }
  return { notes, none: false, bad };
}

// deps: { file, fail(status, message, extra), now(), rid(prefix) }
function createNotes({ file, fail, now, rid }) {
  const data = jsonfile.readOr(file, { notes: [], retired: [] });
  data.notes ||= [];
  data.retired ||= [];
  const save = () => jsonfile.writeAtomic(file, data);
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim(); // one line: a newline could fake a brief heading
  const rank = (n) => (n.confirmedBy?.length || 0) * 1e13 + Date.parse(n.editedAt || n.at); // confirmed first, then newest

  function textOf(v) {
    const t = clean(v);
    if (!t) fail(400, '"text" is required', { hint: 'What the next agent working here should know, in a sentence or two' });
    if (t.length > TEXT_MAX) fail(413, `A note is at most ${TEXT_MAX} characters (this one has ${t.length})`, { hint: 'Keep the lesson, drop the story' });
    return t;
  }
  function areaArg(v) {
    const a = areaOf(v);
    if (a == null) fail(400, `"area" must be a path inside the project, e.g. "lib/alerts/" or "server.js" (got ${JSON.stringify(v)})`);
    return a;
  }
  function find(id) {
    const n = data.notes.find((x) => x.id === id);
    if (!n) fail(404, `No area note "${id}"`, { hint: 'GET /api/notes lists them' });
    return n;
  }
  // Keep each area, and the whole set, within its cap: the least confirmed, oldest note goes (retired, not lost).
  // `keep`, the note just added, goes last: it has no confirmations yet, and dropping it would answer "added"
  // for a note that is already gone
  function trim(area, keep) {
    const drop = (n, why) => { data.notes.splice(data.notes.indexOf(n), 1); data.retired.push({ ...n, retiredAt: now(), retiredBy: 'intellagent', why }); };
    const order = (a, b) => (a === keep) - (b === keep) || rank(a) - rank(b);
    const here = data.notes.filter((n) => n.area === area).sort(order);
    while (here.length > PER_AREA) drop(here.shift(), `more than ${PER_AREA} notes on ${area || 'the project'}`);
    const all = [...data.notes].sort(order);
    while (all.length > TOTAL_MAX) drop(all.shift(), `more than ${TOTAL_MAX} notes`);
    data.retired = data.retired.slice(-RETIRED_MAX);
  }

  function add(d, actor) {
    const area = areaArg(d.area);
    const text = textOf(d.text);
    // the same lesson again: count it as confirmed instead of keeping two
    const same = data.notes.find((n) => n.area === area && n.text.toLowerCase() === text.toLowerCase());
    if (same) { if (same.by !== actor.name && !(same.confirmedBy || []).includes(actor.name)) (same.confirmedBy ||= []).push(actor.name); save(); return { note: same, duplicate: true }; }
    const n = { id: rid('n'), area, text, by: actor.name, ...(d.from ? { from: clean(d.from).slice(0, 64).toUpperCase() } : {}), at: now() };
    data.notes.push(n);
    trim(area, n);
    save();
    return { note: n };
  }
  // Several at once (a review's learned part): what was kept and what was refused, never all-or-nothing
  function addAll(list, from, actor) {
    const added = [];
    const refused = [];
    for (const x of list) {
      try { added.push(add({ ...x, from }, actor).note); } catch (e) { refused.push({ area: x.area, text: x.text, error: e.message }); }
    }
    return { added, refused };
  }
  function edit(id, d, actor) {
    const n = find(id);
    if (actor.kind !== 'user' && actor.name !== n.by) fail(403, `Note ${id} is ${n.by}'s`, { code: 'FORBIDDEN', hint: 'Confirm it, or retire it with why and add a better one' });
    if (!('text' in d) && !('area' in d)) fail(400, 'Nothing to change', { hint: 'Send "text" and/or "area"' });
    const text = 'text' in d ? textOf(d.text) : n.text;
    const area = 'area' in d ? areaArg(d.area) : n.area;
    if (text !== n.text || area !== n.area) {
      n.history = [...(n.history || []), { text: n.text, area: n.area, at: n.editedAt || n.at, by: n.editedBy || n.by }].slice(-HISTORY_MAX);
      Object.assign(n, { text, area, editedAt: now(), editedBy: actor.name });
      trim(area);
      save();
    }
    return n;
  }
  function confirm(id, actor) {
    const n = find(id);
    if (actor.name === n.by) fail(409, 'A note is confirmed by someone it helped, not by its author', { code: 'OWN_WORK' });
    if (!(n.confirmedBy || []).includes(actor.name)) { (n.confirmedBy ||= []).push(actor.name); save(); }
    return n;
  }
  // Wrong or out of date: any agent or the human takes it out of use, saying why. It is kept a while for the record.
  function retire(id, d, actor) {
    const n = find(id);
    const why = clean(d.why || d.reason).slice(0, 300);
    if (!why) fail(400, '"why" is required: what is wrong with it, so nobody adds it back', { hint: 'E.g. "work.js no longer has pendingWork; it moved to scheduler.js"' });
    data.notes.splice(data.notes.indexOf(n), 1);
    const r = { ...n, retiredAt: now(), retiredBy: actor.name, why };
    data.retired.push(r);
    data.retired = data.retired.slice(-RETIRED_MAX);
    save();
    return r;
  }
  function remove(id, actor) {
    if (actor.kind !== 'user') fail(403, 'Only the human removes a note outright', { code: 'HUMAN_ONLY', hint: 'Retire it with why: POST /api/notes/<id>/retire { "why": "…" }' });
    const n = find(id);
    data.notes.splice(data.notes.indexOf(n), 1);
    save();
    return n;
  }
  // The notes that concern any of these paths (files or folders), most useful first.
  function forPaths(paths, { limit = 12, from = null } = {}) {
    const ps = [...new Set(paths.map(areaOf).filter((p) => p != null))];
    const hit = data.notes.filter((n) => ps.some((p) => covers(n.area, p)) || (from && n.from === String(from).toUpperCase()));
    return hit.sort((a, b) => rank(b) - rank(a)).slice(0, limit);
  }
  function list({ path = null, by = null, from = null, retired = false } = {}) {
    let out = retired ? data.retired : data.notes;
    if (path != null) { const p = areaOf(path); out = p == null ? [] : out.filter((n) => covers(n.area, p)); }
    if (by) out = out.filter((n) => n.by === by);
    if (from) out = out.filter((n) => n.from === String(from).toUpperCase());
    return [...out].sort((a, b) => rank(b) - rank(a));
  }
  const addedSince = (ms) => data.notes.filter((n) => Date.parse(n.at) >= ms).map((n) => ({ id: n.id, area: n.area, text: n.text, by: n.by, from: n.from || null, at: n.at }));
  const count = () => data.notes.length;

  return { add, addAll, edit, confirm, retire, remove, forPaths, list, addedSince, count };
}

// One line per note for a brief or a reply: `id` area — text (by, from, confirmed by n)
const noteLine = (n) => `- \`${n.id}\` **${n.area || '(whole project)'}**: ${n.text} _(${n.by}${n.from ? `, ${n.from}` : ''}${n.confirmedBy?.length ? `, confirmed by ${n.confirmedBy.length}` : ''})_`;

module.exports = { createNotes, areaOf, covers, pathsIn, parseLearned, noteLine, TEXT_MAX, PER_AREA };
