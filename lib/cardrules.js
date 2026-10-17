'use strict';
// Card rules: a human names a condition over a ticket and the look it earns. The condition is the board's
// filter language: terms separated by spaces, all of which must hold.
//
//   path               the value is set and not false or 0           review.allOk
//   !path              the opposite                                  !review.concerns
//   path:value         equals (case-insensitive; a|b = either)       fields.risk:low   reviewers.nebula:ok
//   path>=n  >  <=  <  =    compares numbers                         review.oks>=2
//   @name              assigned to or leased by name                 @drax
//   is:rule:<name>     another rule matches (no cycles)             is:rule:full-approval   is:rule:"full approval"
//                      (a name is found with spaces, dashes and underscores alike)
//   a or b             either side holds (and binds tighter)        @drax or fields.risk:high review.allOk
//   ( … )              a group, one level deep                      review.allOk (@drax or @nebula)
//
// A path is a dotted path into the ticket as search sees it, plus the review facts (review.oks, review.pending,
// review.concerns, review.allOk, review.evidence), reviewers.<name> (that reviewer's verdict while it stands) and
// columnDays (whole days in the column it is in now).

const TONES = ['ok', 'accent', 'warn', 'danger'];
const LOOK_KEYS = ['outline', 'badge', 'tint', 'ribbon', 'mark'];
const SHAPES = ['square', 'circle', 'triangle', 'diamond', 'bar', 'star'];
const MAX_RULES = 30;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// The three type rules boards were once seeded with (INT-290). Kept only so a board that still holds them,
// unchanged, can have them removed.
const TYPE_RULES = [
  { name: 'type task', condition: 'type:task', look: { mark: { shape: 'square', colour: '#6aa8ff' } }, enabled: true },
  { name: 'type issue', condition: 'type:issue', look: { mark: { shape: 'triangle', colour: '#ff6b8b' } }, enabled: true },
  { name: 'type spike', condition: 'type:spike', look: { mark: { shape: 'diamond', colour: '#ffc857' } }, enabled: true },
];

class RuleError extends Error {
  constructor(message, hint) { super(message); this.hint = hint; }
}

const getPath = (obj, p) => String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

const TERM = /^(!?)([\w.@-]+?)(>=|<=|>|<|=|:)(.*)$/;
const PATH = /^[A-Za-z_][\w.-]*$/;

// One term: "review.oks>=2" -> { kind: 'path', not, path, op, value }; "@drax" -> { kind: 'who' }; is:rule:name -> { kind: 'rule' }.
function parseTerm(raw) {
  if (raw.startsWith('@')) {
    if (!/^@[\w.-]+$/.test(raw)) throw new RuleError(`"${raw}" is not a name`, 'Use @ and a name, e.g. @drax');
    return { kind: 'who', value: raw.slice(1) };
  }
  if (/^is:/i.test(raw)) {
    const m = /^is:rule:(?:"([\w .-]+)"|([\w.-]+))$/i.exec(raw);
    if (!m) throw new RuleError(`"${raw}" is not something I know`, 'The only is: term here is is:rule:<name>, another card rule; a name with a space goes in quotes, is:rule:"full approval", or with a dash, is:rule:full-approval');
    return { kind: 'rule', value: m[1] ?? m[2] };
  }
  const t = TERM.exec(raw);
  if (!t) {
    const bare = /^(!?)([A-Za-z_][\w.-]*)$/.exec(raw);
    if (!bare) throw new RuleError(`"${raw}" does not parse`, 'A term is a path (review.allOk), path:value (fields.risk:low), a comparison (review.oks>=2) or @name');
    return { kind: 'path', not: !!bare[1], path: bare[2], op: 'set' };
  }
  const [, not, path, op, value] = t;
  if (!PATH.test(path)) throw new RuleError(`"${path}" is not a path`, 'Paths look like review.oks, fields.risk or reviewers.nebula');
  if (op !== ':' && (value === '' || !Number.isFinite(Number(value)))) throw new RuleError(`"${raw}" compares with "${value}", which is not a number`, 'Use a number after >, >=, <, <= and =');
  if (op === ':' && value === '') throw new RuleError(`"${raw}" has no value after the colon`, 'Write path:value, e.g. fields.risk:low');
  return { kind: 'path', not: !!not, path, op, value };
}

// "review.oks>=2 (@drax or fields.risk:high)" -> { any: [[term | group, …], …] }: alternatives split by `or`, each a
// list of which all must hold; a group is ( … ) with the same shape. And binds tighter than or. One level of groups:
// a group cannot hold another. Throws RuleError saying which term is wrong.
function parseCondition(text) {
  const src = String(text ?? '').trim();
  if (!src) throw new RuleError('The condition is empty', 'Write at least one term, e.g. review.allOk review.oks>=2');
  if (src.length > 500) throw new RuleError('The condition is longer than 500 characters', 'Split it into two rules');
  const tokens = src.match(/\(|\)|is:rule:"[^"]*"|[^\s()]+/gi);
  let at = 0;
  const alt = (depth) => {
    const any = [[]];
    for (;;) {
      const tok = tokens[at++];
      if (tok === undefined) { if (depth) throw new RuleError('A ( is never closed', 'Close the group with )'); break; }
      if (tok === ')') {
        if (!depth) throw new RuleError('A ) closes nothing', 'Open the group first: (a or b)');
        break;
      }
      if (/^or$/i.test(tok)) {
        if (!any[any.length - 1].length) throw new RuleError('"or" needs a term before it', 'Write a term, then or, then another: review.allOk or @drax');
        any.push([]);
      } else if (tok === '(') {
        if (depth) throw new RuleError('A group cannot hold another group', 'Only one level of groups: flatten it, or make the inner one a rule of its own and use is:rule:<name>');
        any[any.length - 1].push(alt(depth + 1));
      } else any[any.length - 1].push(parseTerm(tok));
    }
    if (any.some((c) => !c.length)) throw new RuleError(depth ? 'A group is empty or ends with "or"' : 'The condition ends with "or" or has an empty group', 'Write a term on both sides of every or, and inside every ( )');
    return { any };
  };
  return alt(0);
}

const same = (v, x) => {
  if (Array.isArray(v)) return v.some((y) => same(y, x));
  return v != null && String(v).toLowerCase() === String(x).toLowerCase();
};

// view: a ticket as search sees it (with .review and .reviewers). rules: the board's rules, for is:rule: terms.
// A rule is found by its name with spaces, dashes and underscores alike, as the Filter box does: full-approval finds "full approval".
const ruleKey = (name) => String(name).toLowerCase().trim().replace(/[\s_-]+/g, '-');
function holds(node, view, rules = [], seen = new Set()) {
  return node.any.some((all) => all.every((t) => {
    if (t.any) return holds(t, view, rules, seen);
    if (t.kind === 'who') return [view.assignee, view.claimant].some((n) => n && String(n).toLowerCase() === t.value.toLowerCase());
    if (t.kind === 'rule') {
      const key = ruleKey(t.value);
      const other = rules.find((r) => ruleKey(r.name) === key);
      if (!other || seen.has(key)) return false;
      return holds(other.terms || parseCondition(other.condition), view, rules, new Set([...seen, key]));
    }
    const v = getPath(view, t.path);
    let ok;
    if (t.op === 'set') ok = Array.isArray(v) ? v.length > 0 : !!v;
    else if (t.op === ':') ok = t.value.split('|').some((x) => same(v, x));
    else {
      const n = Number(v);
      const x = Number(t.value);
      ok = v != null && v !== '' && Number.isFinite(n) && (t.op === '>=' ? n >= x : t.op === '<=' ? n <= x : t.op === '>' ? n > x : t.op === '<' ? n < x : n === x);
    }
    return t.not ? !ok : ok;
  }));
}

// The review facts of one ticket. stands(reviewer) says whether that reviewer's verdict still counts: given
// with their own token and about the commits the ticket has now. Only such verdicts are counted, so a stale ok
// never shows as approval.
function reviewFacts(item, stands) {
  const assigned = item.reviewers || [];
  const verdicts = {};
  let oks = 0;
  let concerns = 0;
  for (const r of assigned) {
    const v = r.verdict && stands(r) ? String(r.verdict).toLowerCase() : null;
    if (v) verdicts[r.name.toLowerCase()] = v;
    if (v === 'ok') oks++;
    if (v === 'concerns') concerns++;
  }
  const pending = assigned.length - oks - concerns;
  const evidence = !!(item.questions || []).find((q) => q.kind === 'review' && String(q.notes?.evidence || '').trim());
  return { review: { oks, pending, concerns, allOk: assigned.length > 0 && pending === 0 && concerns === 0, evidence }, reviewers: verdicts };
}

// The rules a human sends, checked and cleaned: [{ name, condition, look, enabled }] in the order given.
function cleanRules(input) {
  if (!Array.isArray(input)) throw new RuleError('"rules" must be a list', 'PUT …/card-rules { "rules": [{ "name": "full approval", "condition": "review.allOk review.oks>=2", "look": { "outline": "ok" } }] }');
  if (input.length > MAX_RULES) throw new RuleError(`At most ${MAX_RULES} rules`, 'Merge or drop some');
  const names = new Set();
  return input.map((r, i) => {
    const at = `Rule ${i + 1}`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new RuleError(`${at} must be an object`, 'A rule is { name, condition, look, enabled? }');
    const unknown = Object.keys(r).filter((k) => !['name', 'condition', 'look', 'enabled'].includes(k));
    if (unknown.length) throw new RuleError(`${at} has unknown keys: ${unknown.join(', ')}`, 'A rule is { name, condition, look, enabled? }; its place in the list is its order');
    const name = String(r.name ?? '').trim();
    if (!/^[\w][\w .-]{0,39}$/.test(name)) throw new RuleError(`${at} needs a name of 1 to 40 letters, digits, spaces, dots, dashes or underscores`, 'The name is what is:rule:<name> looks for');
    if (names.has(name.toLowerCase())) throw new RuleError(`Two rules are called "${name}"`, 'Names are unique, ignoring case');
    names.add(name.toLowerCase());
    try { parseCondition(r.condition); } catch (e) { if (e instanceof RuleError) throw new RuleError(`${at} ("${name}"): ${e.message}`, e.hint); throw e; }
    const look = cleanLook(r.look, `${at} ("${name}")`);
    if (!Object.keys(look).length) throw new RuleError(`${at} ("${name}") has no look`, 'Give it at least one of outline, badge, tint, ribbon, mark');
    return { name, condition: String(r.condition).trim().replace(/\s+/g, ' '), look, enabled: r.enabled !== false };
  });
}

function cleanLook(look, at) {
  if (!look || typeof look !== 'object' || Array.isArray(look)) throw new RuleError(`${at} needs a look`, 'look is { outline?, badge?, tint?, ribbon?, mark?: { shape, tone | colour } }');
  const unknown = Object.keys(look).filter((k) => !LOOK_KEYS.includes(k));
  if (unknown.length) throw new RuleError(`${at}: unknown look keys ${unknown.join(', ')}`, `A look is built from ${LOOK_KEYS.join(', ')}`);
  const out = {};
  for (const k of ['outline', 'tint']) {
    if (look[k] == null) continue;
    if (!TONES.includes(look[k])) throw new RuleError(`${at}: ${k} must be one of ${TONES.join(', ')}`, 'Tones come from the theme, so they work in light and dark');
    out[k] = look[k];
  }
  if (look.badge != null) {
    const b = typeof look.badge === 'string' ? { text: look.badge } : look.badge;
    const text = String(b?.text ?? '').trim();
    if (!text || text.length > 24) throw new RuleError(`${at}: a badge needs short text (1 to 24 characters)`, 'badge: { "text": "approved", "icon": "check" }');
    out.badge = { text, ...(b.icon ? { icon: String(b.icon).slice(0, 40) } : {}) };
  }
  if (look.ribbon != null) {
    const text = String(look.ribbon).trim();
    if (!text || text.length > 16) throw new RuleError(`${at}: a ribbon needs short text (1 to 16 characters)`, 'ribbon: "approved"');
    out.ribbon = text;
  }
  if (look.mark != null) {
    const m = look.mark;
    const hint = `mark: { "shape": "${SHAPES.join('|')}", "tone": "${TONES.join('|')}" } or "colour": "#rrggbb" instead of a tone`;
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new RuleError(`${at}: a mark is { shape, tone or colour }`, hint);
    const unknownMark = Object.keys(m).filter((k) => !['shape', 'tone', 'colour'].includes(k));
    if (unknownMark.length) throw new RuleError(`${at}: unknown mark keys ${unknownMark.join(', ')}`, hint);
    if (!SHAPES.includes(m.shape)) throw new RuleError(`${at}: a mark's shape must be one of ${SHAPES.join(', ')}`, hint);
    if ((m.tone == null) === (m.colour == null)) throw new RuleError(`${at}: a mark needs exactly one of tone or colour`, hint);
    if (m.tone != null && !TONES.includes(m.tone)) throw new RuleError(`${at}: a mark's tone must be one of ${TONES.join(', ')}`, 'Tones come from the theme, so they work in light and dark; use colour for a fixed one');
    if (m.colour != null && !HEX.test(String(m.colour))) throw new RuleError(`${at}: a mark's colour must be a hex colour like #6aa8ff`, hint);
    out.mark = { shape: m.shape, ...(m.tone != null ? { tone: m.tone } : { colour: String(m.colour).toLowerCase() }) };
  }
  return out;
}

// What a ticket earns from the enabled rules, in order: the first outline, tint and ribbon win; badges stack, up to 2;
// every matching mark is kept, in rule order, with the rule it came from (the card decides how many to show).
function lookFor(view, rules) {
  const on = rules.filter((r) => r.enabled !== false);
  const hit = on.filter((r) => holds(parseCondition(r.condition), view, on));
  if (!hit.length) return null;
  const first = (k) => hit.find((r) => r.look[k] != null)?.look[k];
  const badges = hit.filter((r) => r.look.badge).map((r) => r.look.badge).slice(0, 2);
  const marks = hit.filter((r) => r.look.mark).map((r) => ({ ...r.look.mark, rule: r.name }));
  return {
    rules: hit.map((r) => r.name),
    ...(marks.length ? { marks } : {}),
    ...(first('outline') ? { outline: first('outline') } : {}),
    ...(first('tint') ? { tint: first('tint') } : {}),
    ...(first('ribbon') ? { ribbon: first('ribbon') } : {}),
    ...(badges.length ? { badges } : {}),
  };
}

module.exports = { RuleError, parseCondition, holds, reviewFacts, cleanRules, lookFor, TONES, SHAPES, TYPE_RULES, MAX_RULES };
