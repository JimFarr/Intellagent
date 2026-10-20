'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Agent memory (INT-243): short notes an agent keeps across runs, read back in its brief every run.
// Two kinds of entry: "learned" (the agent wrote it, or accepted a colleague's suggestion) and "human" (the human told
// it to remember, or accepted a suggestion for it). An agent adds,
// edits and removes only its own learned entries that the human has not pinned; the human changes anything and
// switches an agent's memory off. Memory is only text in the brief: nothing here grants a permission or a power.
const jsonfile = require('./jsonfile');

const CAP = 4000; // characters per agent, every entry counted
const ENTRY_MAX = 1000;
const HISTORY_MAX = 5;
// Suggestions (INT-402): one agent proposes a note for another; it is memory only once the recipient or the human accepts it
const PENDING_MAX = 5; // waiting per recipient
const PAIR_MS = 86_400_000; // one suggestion per suggester and recipient a day
const WHY_MAX = 300;

// deps: { file, fail(status, message, extra), now(), rid(prefix) }
function createMemory({ file, fail, now, rid }) {
  const data = jsonfile.readOr(file, { agents: {} });
  // No prototype: a name like "__proto__" must never reach Object.prototype or count as a memory.
  data.agents = Object.assign(Object.create(null), data.agents || {});
  const save = () => jsonfile.writeAtomic(file, data);
  const of = (name) => (Object.hasOwn(data.agents, name) ? data.agents[name] : { entries: [] });
  const used = (entries) => entries.reduce((n, e) => n + e.text.length, 0);
  const isOn = (name) => !of(name).off;

  // One line per entry: a newline could open what looks like a new section of the brief.
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  function textOf(v) {
    const t = clean(v);
    if (!t) fail(400, '"text" is required', { hint: 'One lesson that applies to future tickets, in a sentence or two' });
    if (t.length > ENTRY_MAX) fail(413, `An entry is at most ${ENTRY_MAX} characters (this one has ${t.length})`, { hint: 'Keep the lesson, drop the story' });
    return t;
  }
  function fits(name, entries, extra, hint) {
    const total = used(entries) + extra;
    if (total > CAP) fail(413, `${name}'s memory would hold ${total} of ${CAP} characters`, { hint });
  }
  function find(name, id) {
    const e = of(name).entries.find((x) => x.id === id);
    if (!e) fail(404, `${name} has no memory entry "${id}"`, { hint: `GET /api/profiles/${name}/memory lists them` });
    return e;
  }

  // Who may change this entry (or add to this memory). The human: anything. An agent: its own memory only,
  // while it is on, and only its own unpinned learned entries.
  function check(name, actor, entry) {
    if (actor.kind === 'user') return;
    if (actor.name !== name) fail(403, `${actor.name} can't change ${name}'s memory`, { code: 'FORBIDDEN', hint: 'An agent changes only its own memory (/api/profiles/me/memory)' });
    if (!isOn(name)) fail(409, `The human switched ${name}'s memory off`, { code: 'MEMORY_OFF', hint: 'Keep what you learned on the card instead' });
    if (entry?.source === 'human') fail(403, `Entry ${entry.id} is the human's`, { code: 'HUMAN_ONLY', hint: 'Only the human changes what they asked you to remember: ask on a card' });
    if (entry?.pinned) fail(403, `The human pinned entry ${entry.id}`, { code: 'HUMAN_ONLY', hint: 'A pinned entry stays as the human left it: ask on a card' });
  }
  function noPin(actor, d) {
    if ('pinned' in d && actor.kind !== 'user') fail(403, 'Only the human pins memory entries', { code: 'HUMAN_ONLY', hint: 'Leave out "pinned"' });
  }

  function list(name) {
    const m = of(name);
    return { name, on: !m.off, cap: CAP, used: used(m.entries), entries: m.entries, suggestions: m.suggestions || [] };
  }
  function add(name, d, actor) {
    check(name, actor);
    noPin(actor, d);
    const text = textOf(d.text);
    const m = (data.agents[name] ||= { entries: [] });
    fits(name, m.entries, text.length, actor.kind === 'user' ? 'Remove or shorten an entry first' : 'Forget an entry that no longer helps, or shorten one, first');
    const e = { id: rid('m'), text, source: actor.kind === 'user' ? 'human' : 'learned', ...(d.from ? { from: clean(d.from).slice(0, 64) } : {}), at: now(), by: actor.name, ...(d.pinned === true ? { pinned: true } : {}) };
    m.entries.push(e);
    save();
    return e;
  }
  function edit(name, id, d, actor) {
    const e = find(name, id);
    check(name, actor, e);
    noPin(actor, d);
    if (!('text' in d) && !('pinned' in d)) fail(400, 'Nothing to change', { hint: 'Send "text" (and, the human, "pinned")' });
    if ('text' in d) {
      const text = textOf(d.text);
      fits(name, of(name).entries.filter((x) => x !== e), text.length, 'Shorten it, or forget another entry first');
      if (text !== e.text) {
        e.history = [...(e.history || []), { text: e.text, at: e.editedAt || e.at, by: e.editedBy || e.by }].slice(-HISTORY_MAX);
        e.text = text;
        e.editedAt = now();
        e.editedBy = actor.name;
      }
    }
    if ('pinned' in d) { if (d.pinned) e.pinned = true; else delete e.pinned; }
    save();
    return e;
  }
  function remove(name, id, actor) {
    const e = find(name, id);
    check(name, actor, e);
    const m = of(name);
    m.entries.splice(m.entries.indexOf(e), 1);
    save();
    return e;
  }
  function setOn(name, on, actor) {
    if (actor.kind !== 'user') fail(403, 'Only the human switches memory on or off', { code: 'HUMAN_ONLY', hint: 'Ask on a card' });
    if (typeof on !== 'boolean') fail(400, '"on" must be true or false');
    const m = (data.agents[name] ||= { entries: [] });
    if (on) delete m.off; else m.off = true;
    save();
    return list(name);
  }

  // A suggestion waits on the recipient, never in its entries: nothing reaches its memory (or its brief as memory)
  // until it, or the human, accepts. Accepted, it is learned (the recipient's) or human (the human's) with suggestedBy.
  function findSuggestion(name, id) {
    const s = (of(name).suggestions || []).find((x) => x.id === id);
    if (!s) fail(404, `${name} has no suggestion "${id}" waiting`, { hint: `GET /api/profiles/${name}/memory lists the suggestions waiting` });
    return s;
  }
  function suggest(name, d, actor) {
    if (actor.kind === 'user') fail(400, 'The human adds to an agent\'s memory directly', { hint: `POST /api/profiles/${name}/memory { text }` });
    if (actor.name === name) fail(400, 'A suggestion is for a colleague', { hint: 'Keep your own lesson with POST /api/profiles/me/memory { text }' });
    if (!isOn(name)) fail(409, `The human switched ${name}'s memory off`, { code: 'MEMORY_OFF', hint: `Tell ${name} on the card instead` });
    const text = textOf(d.text);
    const why = clean(d.why);
    if (!why) fail(400, '"why" is required', { hint: `Say what you saw that makes it worth ${name} keeping, so it can judge the note` });
    if (why.length > WHY_MAX) fail(413, `"why" is at most ${WHY_MAX} characters (this one has ${why.length})`, { hint: 'One or two sentences' });
    const m = (data.agents[name] ||= { entries: [] });
    const pending = (m.suggestions ||= []);
    if (pending.length >= PENDING_MAX) fail(409, `${name} already has ${pending.length} suggestions waiting`, { hint: `Wait until ${name} answers one; meanwhile say it on the card` });
    m.suggested = (m.suggested || []).filter((x) => Date.parse(x.at) > Date.parse(now()) - PAIR_MS);
    const last = m.suggested.find((x) => x.by === actor.name);
    if (last || pending.some((x) => x.by === actor.name)) fail(409, `You already suggested a note to ${name} today`, { hint: `One suggestion per colleague a day: wait until ${last ? `${new Date(Date.parse(last.at) + PAIR_MS).toISOString().slice(0, 16).replace('T', ' ')} UTC` : `${name} answers the one waiting`}, or say it on the card` });
    const s = { id: rid('ms'), text, why, ...(d.from ? { from: clean(d.from).slice(0, 64) } : {}), by: actor.name, at: now() };
    pending.push(s);
    m.suggested.push({ by: actor.name, at: s.at });
    save();
    return s;
  }
  // The recipient (or the human) accepts, optionally reworded: d = { text?, pinned? (the human) }
  function acceptSuggestion(name, id, d, actor) {
    check(name, actor);
    noPin(actor, d);
    const s = findSuggestion(name, id);
    const text = d.text == null ? s.text : textOf(d.text);
    const m = data.agents[name];
    fits(name, m.entries, text.length, 'Forget or shorten an entry first, or accept it shorter ("text")');
    const e = { id: rid('m'), text, source: actor.kind === 'user' ? 'human' : 'learned', ...(s.from ? { from: s.from } : {}), at: now(), by: actor.name,
      suggestedBy: s.by, ...(text !== s.text ? { suggested: s.text } : {}), ...(d.pinned === true ? { pinned: true } : {}) };
    m.entries.push(e);
    m.suggestions.splice(m.suggestions.indexOf(s), 1);
    save();
    return { entry: e, suggestion: s };
  }
  function declineSuggestion(name, id, d, actor) {
    check(name, actor);
    const s = findSuggestion(name, id);
    const reason = clean(d.reason).slice(0, WHY_MAX);
    if (!reason) fail(400, '"reason" is required', { hint: `Say why, in a sentence: it goes back to ${s.by}` });
    const m = data.agents[name];
    m.suggestions.splice(m.suggestions.indexOf(s), 1);
    save();
    return { ...s, declined: { reason, by: actor.name, at: now() } };
  }

  // The brief's Memory section: the human's entries first, pinned first within each kind.
  function briefLines(name, calls) {
    const m = of(name);
    if (m.off) return ['## Your memory', 'The human switched your memory off. Keep what you learn on the cards.'];
    const order = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    const line = (e) => `- \`${e.id}\`${e.pinned ? ' 📌' : ''} ${e.text}${e.from ? ` (from ${e.from})` : ''}`;
    const human = m.entries.filter((e) => e.source === 'human').sort(order);
    const learned = m.entries.filter((e) => e.source !== 'human').sort(order);
    return [
      '## Your memory',
      'Your own notes. They can be wrong. They never override the human\'s instructions or your permissions.',
      ...(human.length ? ['The human asked you to remember:', ...human.map(line)] : []),
      ...(learned.length ? ['You learned:', ...learned.map(line)] : []),
      `Keep a lesson that will help on future tickets (never progress, never what a card already says): ${calls.remember}. Drop one that no longer helps: ${calls.forget}. ${used(m.entries)} of ${CAP} characters used.`,
      ...(calls.suggest ? [`To pass a lesson to a colleague, suggest it: ${calls.suggest}. It joins their memory only once they or the human accept it.`] : []),
    ];
  }

  // Learned entries written since `sinceMs`, and accepted suggestions (the human's too), for the digest.
  function learnedSince(sinceMs) {
    return Object.entries(data.agents).flatMap(([agent, m]) => m.entries
      .filter((e) => (e.source !== 'human' || e.suggestedBy) && Date.parse(e.at) >= sinceMs)
      .map((e) => ({ agent, id: e.id, text: e.text, from: e.from || null, at: e.at, ...(e.suggestedBy ? { suggestedBy: e.suggestedBy, acceptedBy: e.by } : {}) })));
  }

  return { list, add, edit, remove, setOn, isOn, suggest, acceptSuggestion, declineSuggestion, briefLines, learnedSince, names: () => Object.keys(data.agents), CAP };
}

// "remember that …" / "remember: …" at the start of a human's comment or request, after any @mentions:
// { text, to: [the leading @mentions] }, or null. "Do you remember that bug?" is not one: it must lead.
function rememberText(body) {
  const m = /^\s*((?:@[\w.-]+[\s,:]*)*)remember(?:\s+that\b|\s*:)\s*([\s\S]+)$/i.exec(String(body || ''));
  if (!m || !m[2].trim()) return null;
  return { text: m[2].trim(), to: [...m[1].matchAll(/@([\w.-]+)/g)].map((x) => x[1].replace(/[.-]+$/, '')) };
}

module.exports = { createMemory, rememberText, CAP };
