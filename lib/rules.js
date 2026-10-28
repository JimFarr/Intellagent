'use strict';
/* Rules (the Rules section): the human's own "when <something happens>, if <the ticket holds>, then <do this>".
   Pure: the vocabulary, cleaning a rule from the API, matching an event or the clock, and the board's built-in rules
   written in the same words. server.js carries the actions out. The "if" is the card-rules condition language. */
const cardrules = require('./cardrules');

class RuleError extends Error {
  constructor(message, hint) { super(message); this.hint = hint; }
}
const MAX_RULES = 50;
const MAX_ACTIONS = 6;
const LOG_KEEP = 200;
// A rule that fires more than this in an hour is held back (and the log says so): a rule that loops, or matches
// far more than meant, never floods the board
const MAX_PER_HOUR = 30;

// when.on → the event that sets it off, and what the ticket must be for it. Time kinds have no event: the sweep
// checks them.
const EVENTS = {
  created: { type: 'item.created', label: 'a ticket is created' },
  entered: { type: 'item.moved', label: 'a ticket enters a column', column: true, test: (e, c) => e.columnId === c && e.fromColumnId !== c },
  left: { type: 'item.moved', label: 'a ticket leaves a column', column: true, test: (e, c) => e.fromColumnId === c && e.columnId !== c },
  assigned: { type: 'item.assigned', label: 'a ticket is assigned', test: (e, _c, w) => !w.to || String(e.assignee || '').toLowerCase() === w.to.toLowerCase() },
  review_requested: { type: 'review.requested', label: 'a review is requested' },
  approved: { type: 'review.approved', label: 'a review is approved' },
  changes_requested: { type: 'review.changes_requested', label: 'a review is sent back' },
  commented: { type: 'comment.added', label: 'a comment is added' },
  mentioned: { type: 'comment.added', label: 'someone is @mentioned', test: (e, _c, w) => (e.mentions || []).some((m) => !w.to || m.toLowerCase() === w.to.toLowerCase()) },
  unblocked: { type: 'item.unblocked', label: "a ticket's last blocker is finished" },
  lease_expired: { type: 'lease.expired', label: 'a lease expires' },
  ask_overdue: { type: 'ask.overdue', label: 'an ask is overdue' },
  // the board's own (its rules on the Rules page): they run in the board's engine, never in a rule of yours
  // a state, not an event: while a ticket fits the conditions (a card look; the board draws it, nothing fires)
  fits: { type: null, label: 'a ticket fits the conditions', state: true },
  assignee_away: { type: null, label: "a waiting ticket's assignee has been away an hour", nativeOnly: true },
};
const TIMES = {
  idle: { label: 'a ticket idles for', minutes: 5 },
  in_column: { label: 'a ticket has been in a column for', minutes: 5, column: true },
  every: { label: 'every', minutes: 15 },
  board_idle: { label: 'the board goes idle for', minutes: 5, nativeOnly: true },
  stuck: { label: 'a ticket is stuck (quiet) for', minutes: 5, nativeOnly: true },
};
const ACTIONS = {
  wake: { label: 'wake an agent', ticket: false },
  ask_human: { label: 'ask the human', ticket: true },
  move: { label: 'move the ticket', ticket: true },
  assign: { label: 'assign the ticket', ticket: true },
  release_lease: { label: "release the ticket's lease", ticket: true },
  archive: { label: 'archive the ticket', ticket: true },
  comment: { label: 'comment on the ticket', ticket: true },
  set_field: { label: 'set a field', ticket: true },
  set_property: { label: 'set a property', ticket: true },
  extract: { label: 'extract from the ticket', ticket: true },
  land: { label: 'merge its commits into main (cherry-pick, or a merge commit)', ticket: true },
  merge: { label: 'merge into a branch', ticket: true },
  style: { label: 'style its card', ticket: true },
  unstyle: { label: "clear its card's style", ticket: true },
  look: { label: 'change how its card looks', ticket: true },
  escalate: { label: 'ask the coordinator to unblock it', ticket: true, nativeOnly: true },
  unstick: { label: 'ask the coordinator to unstick it, then you if it stays stuck', ticket: true, nativeOnly: true },
  reassign: { label: 'hand it to an agent with room', ticket: true, nativeOnly: true },
};
// who a wake or an assign names besides an agent: resolved per ticket when the rule fires
const ROLES = ['coordinator', 'assignee', 'last_worker'];

const str = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));
const NAME = /^[a-z0-9][a-z0-9_.-]{0,39}$/i;
const PROP = /^[A-Za-z_][\w.-]{0,59}$/;
// a git branch the board may create and push: no leading dash, no spaces or ref syntax
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,99}$/;
// what an extract reads
const FROM = ['title', 'description', 'comments', 'all'];

// columns: [{ id, name }] of the board, so a rule names a column that is there (by id or name; kept as the id)
function cleanWhen(w, columns, native = false) {
  if (!w || typeof w !== 'object') throw new RuleError('"when" is required', `when.on is one of: ${[...Object.keys(EVENTS), ...Object.keys(TIMES)].join(', ')}`);
  const on = String(w.on || '');
  const def = EVENTS[on] || TIMES[on];
  if (!def || (def.nativeOnly && !native)) throw new RuleError(`"${on}" is not a trigger`, `when.on is one of: ${[...Object.keys(EVENTS), ...Object.keys(TIMES)].filter((k) => !(EVENTS[k] || TIMES[k]).nativeOnly).join(', ')}`);
  const out = { on };
  if (def.column) {
    const ref = str(w.column, 80).toLowerCase();
    const col = columns.find((c) => c.id === ref || c.name.toLowerCase() === ref);
    if (!col) throw new RuleError(`"${on}" needs a column${ref ? `, and there is no "${w.column}"` : ''}`, `Columns: ${columns.map((c) => c.name).join(', ')}`);
    out.column = col.id;
  }
  if (TIMES[on]) {
    const m = Number(w.minutes);
    if (!Number.isFinite(m) || m < def.minutes || m > 60 * 24 * 90) throw new RuleError(`"${on}" needs minutes, at least ${def.minutes}`, 'Each firing can cost an agent a run, so time rules wait at least a few minutes');
    out.minutes = Math.round(m);
  }
  if ((on === 'assigned' || on === 'mentioned') && w.to) {
    if (!NAME.test(String(w.to))) throw new RuleError(`"${w.to}" is not a name`, 'An agent or person, e.g. drax');
    out.to = String(w.to);
  }
  return out;
}

function cleanAction(a, columns, native = false) {
  if (!a || typeof a !== 'object' || !ACTIONS[a.do] || (ACTIONS[a.do].nativeOnly && !native)) throw new RuleError(`"${a?.do}" is not an action`, `"do" is one of: ${Object.keys(ACTIONS).join(', ')}`);
  const out = { do: a.do };
  const who = (v, what) => {
    const s = str(v, 40);
    if (!s || !(ROLES.includes(s) || NAME.test(s))) throw new RuleError(`${what} needs an agent`, `An agent's name, or ${ROLES.join(', ')}`);
    return s;
  };
  if (a.do === 'wake') { out.agent = who(a.agent, 'wake'); if (a.note) out.note = str(a.note, 500); }
  if (a.do === 'assign') out.to = a.to == null || a.to === '' ? null : who(a.to, 'assign');
  if (a.do === 'move') {
    const ref = str(a.column, 80).toLowerCase();
    const col = columns.find((c) => c.id === ref || c.name.toLowerCase() === ref);
    if (!col) throw new RuleError('move needs a column', `Columns: ${columns.map((c) => c.name).join(', ')}`);
    out.column = col.id;
  }
  if (a.do === 'comment' || a.do === 'ask_human') {
    out.text = str(a.text, 4000);
    if (!out.text) throw new RuleError(`${a.do === 'comment' ? 'comment' : 'ask_human'} needs text`, '{id} and {title} stand for the ticket');
  }
  if (a.do === 'set_field') {
    out.key = str(a.key, 60);
    if (!/^[a-z][a-zA-Z0-9_]*$/.test(out.key)) throw new RuleError('set_field needs a field key', 'A field declared on the board, e.g. risk');
    out.value = a.value === undefined ? null : a.value;
  }
  if (a.do === 'set_property') {
    out.key = str(a.key, 60);
    if (!PROP.test(out.key)) throw new RuleError('set_property needs a property name', 'Letters, digits, dots, dashes or underscores, e.g. pr');
    out.value = a.value === undefined ? null : a.value;
  }
  if (a.do === 'extract') {
    out.from = FROM.includes(a.from) ? a.from : 'all';
    if (!['pattern', 'ai'].includes(a.how)) throw new RuleError('extract needs how: pattern or ai', 'A pattern (a regular expression; its first group, or the whole match) or a question for the AI');
    out.how = a.how;
    if (a.how === 'pattern') {
      out.pattern = str(a.pattern, 300);
      try { if (!out.pattern) throw new Error('empty'); new RegExp(out.pattern, 'i'); } catch { throw new RuleError('extract needs a pattern that is a regular expression', 'e.g. https://dev\\.azure\\.com/\\S+ or Services?: (.+)'); }
    } else {
      out.ask = str(a.ask, 500);
      if (!out.ask) throw new RuleError('extract needs a question for the AI', 'e.g. "Which services does it touch?" The answer is written as it comes');
    }
    if (!['field', 'property', 'comment'].includes(a.into)) throw new RuleError('extract needs into: field, property or comment', 'Where the answer goes');
    out.into = a.into;
    if (a.into !== 'comment') {
      out.key = str(a.key, 60);
      if (!(a.into === 'field' ? /^[a-z][a-zA-Z0-9_]*$/ : PROP).test(out.key)) throw new RuleError(`extract into a ${a.into} needs its key`, a.into === 'field' ? 'A field declared on the board' : 'A property name, e.g. services');
    }
  }
  if (a.do === 'merge') {
    out.branch = str(a.branch, 100);
    if (!BRANCH.test(out.branch) || /\.\.|\/\/|\.lock$|\/$|@\{/.test(out.branch)) throw new RuleError('merge needs a branch name', 'e.g. integration/next: made from main if it is not there yet');
    out.push = a.push !== false;
  }
  if (a.do === 'style') {
    try { out.look = cardrules.cleanLook(a.look, 'The style'); } catch (e) { throw new RuleError(e.message, e.hint); }
    if (!Object.keys(out.look).length) throw new RuleError('The style is empty', 'Give it at least one of outline, tint, badge, ribbon, mark');
  }
  if (a.do === 'look') {
    try { out.look = cardrules.cleanLook(a.look, 'The look'); } catch (e) { throw new RuleError(e.message, e.hint); }
    if (!Object.keys(out.look).length) throw new RuleError('The look is empty', 'Give it at least one of outline, tint, badge, ribbon, mark');
  }
  return out;
}

// One rule from the API. Keeps the board's own fields (id, created, fired) from `prev` when it is an edit.
function cleanRule(r, columns, { id, prev, nowIso, native = false }) {
  if (!r || typeof r !== 'object') throw new RuleError('A rule is { name, when, if?, then }', 'See GET /api/boards/<board>/rules');
  const name = str(r.name, 80);
  if (!name) throw new RuleError('A rule needs a name', 'Say what it does, e.g. "Wake the coordinator on idle tickets"');
  const when = cleanWhen(r.when, columns, native);
  const cond = str(r.if, 500);
  if (cond) {
    try { cardrules.parseCondition(cond); } catch (e) { throw new RuleError(`The "if" doesn't parse: ${e.message}`, e.hint); }
  }
  const then = Array.isArray(r.then) ? r.then : [];
  if (!then.length) throw new RuleError('A rule needs at least one action in "then"', `Actions: ${Object.keys(ACTIONS).join(', ')}`);
  if (then.length > MAX_ACTIONS) throw new RuleError(`At most ${MAX_ACTIONS} actions in a rule`, 'Split it into two rules');
  const actions = then.map((a) => cleanAction(a, columns, native));
  // a board-level rule (every) has no ticket for a ticket action unless "if" picks them
  // a card look: a ticket that fits takes the look, for as long as it fits; one look, and the conditions that pick
  // the tickets. Its name is what is:rule:<name> looks for, so it follows the card-rule name rules.
  const looks = actions.filter((a) => a.do === 'look').length;
  if (when.on === 'fits' || looks) {
    if (when.on !== 'fits' || looks !== 1 || actions.length !== 1) throw new RuleError('A card look is "if a ticket fits" with one action: change how its card looks', 'Set the trigger to "a ticket fits the conditions" and the action to "change how its card looks", or pick another action');
    if (!cond) throw new RuleError('A card look needs conditions: which tickets take it', 'Add a condition, e.g. priority is Critical');
    if (!/^[\w][\w .-]{0,39}$/.test(name)) throw new RuleError('A card look needs a name of 1 to 40 letters, digits, spaces, dots, dashes or underscores', 'Its name is what is:rule:<name> finds');
  }
  if (when.on === 'every' && !cond && actions.some((a) => ACTIONS[a.do].ticket)) {
    throw new RuleError('An "every" rule acts on tickets only when "if" says which', 'Add an "if" (e.g. column:review), or use only wake');
  }
  return {
    id: prev?.id || id, name, enabled: r.enabled !== false, when, ...(cond ? { if: cond } : {}), then: actions,
    createdAt: prev?.createdAt || nowIso, updatedAt: nowIso, ...(prev?.state ? { state: prev.state } : {}),
  };
}

// Does this event set the rule off? The ticket's own condition is checked by the caller (it needs the ticket's view).
function eventMatches(rule, e) {
  const def = EVENTS[rule.when.on];
  if (!def || e.type !== def.type) return false;
  return !def.test || def.test(e, rule.when.column, rule.when);
}

// A time rule against one ticket, edge-triggered: it fires once per stretch, keyed by what started the stretch
// (the ticket's last activity, or when it entered the column). Returns the key to remember when it fires.
function timeDue(rule, item, { nowMs, lastActivityMs }) {
  const ms = rule.when.minutes * 60_000;
  if (rule.when.on === 'idle') {
    if (!lastActivityMs || nowMs - lastActivityMs < ms) return null;
    return `idle@${lastActivityMs}`;
  }
  if (rule.when.on === 'in_column') {
    const since = Date.parse(item.enteredColumnAt || item.createdAt);
    if (item.columnId !== rule.when.column || !since || nowMs - since < ms) return null;
    return `col@${since}`;
  }
  return null;
}
// An "every" rule: due once each period, from the last time it fired (or when it was made)
const everyDue = (rule, nowMs) => nowMs - Date.parse(rule.state?.lastEvery || rule.createdAt) >= rule.when.minutes * 60_000;

// Held back when it fired too often in the last hour
const throttled = (rule, nowMs) => (rule.state?.recent || []).filter((t) => nowMs - t < 3_600_000).length >= MAX_PER_HOUR;
const noteFired = (rule, nowMs) => {
  rule.state ||= {};
  rule.state.recent = [...(rule.state.recent || []).filter((t) => nowMs - t < 3_600_000), nowMs];
};

// Placeholders in an action's text or value: {id} {title} {assignee} {priority}, {field.<key>}, {property.<name>},
// and from what set the rule off, {comment.text|author|url|threadId}. An unknown
// one stays as written, so a typo shows. (A replacer function: a title's "$&" or "$'" is text, not a pattern.)
const TICKET_KEYS = ['id', 'title', 'assignee', 'priority'];
function fill(text, item, ev = null) {
  return String(text).replace(/\{([a-z]+)(?:\.([\w.-]+))?\}/gi, (m, head, rest) => {
    let v;
    if (!rest) { if (!TICKET_KEYS.includes(head)) return m; v = item?.[head]; }
    else if (head === 'field') v = item?.fields?.[rest];
    else if (head === 'property' || head === 'prop') v = item?.properties?.[rest];
    else if (head === 'comment') v = rest.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ev?.[head]);
    else return m;
    return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}
// A value to store: text with placeholders is filled; anything else is kept as it is
const fillValue = (v, item, ev) => (typeof v === 'string' && v.includes('{') ? fill(v, item, ev) : v);

// A rule in words, for the list and the log: "If a ticket enters Done → merge its commits into main"
function describe(rule, columns) {
  const col = (id) => columns.find((c) => c.id === id)?.name || id;
  const w = rule.when;
  const def = EVENTS[w.on] || TIMES[w.on];
  let when = def ? def.label : w.on;
  if (w.on === 'entered') when = `a ticket enters ${col(w.column)}`;
  if (w.on === 'left') when = `a ticket leaves ${col(w.column)}`;
  if (w.on === 'assigned' && w.to) when = `a ticket is assigned to ${w.to}`;
  if (w.on === 'mentioned' && w.to) when = `${w.to} is @mentioned`;
  if (w.on === 'idle') when = `a ticket idles for ${mins(w.minutes)}`;
  if (w.on === 'in_column') when = `a ticket has been in ${col(w.column)} for ${mins(w.minutes)}`;
  if (w.on === 'every') when = `every ${mins(w.minutes)}`;
  if (w.on === 'fits') when = 'a ticket fits';
  if (w.on === 'board_idle') when = `the board goes idle for ${mins(w.minutes)}`;
  if (w.on === 'stuck') when = `a ticket is stuck (quiet) for ${mins(w.minutes)}`;
  return `If ${when}${rule.if ? ` and ${rule.if}` : ''} → ${rule.then.map((a) => describeAction(a, columns)).join(', ')}`;
}
// One action in words: "move it to Done"
function describeAction(a, columns) {
  const col = (id) => columns.find((c) => c.id === id)?.name || id;
  if (a.do === 'wake') return `wake ${a.agent.replace('_', ' ')}`;
  if (a.do === 'move') return `move it to ${col(a.column)}`;
  if (a.do === 'assign') return a.to ? `assign it to ${a.to.replace('_', ' ')}` : 'unassign it';
  if (a.do === 'set_field') return `set ${a.key} to ${JSON.stringify(a.value)}`;
  if (a.do === 'set_property') return `set the property ${a.key} to ${JSON.stringify(a.value)}`;
  if (a.do === 'extract') return `${a.how === 'ai' ? `ask AI "${a.ask}"` : `find /${a.pattern}/`} in its ${a.from === 'all' ? 'text' : a.from} and put it in ${a.into === 'comment' ? 'a comment' : `${a.into === 'field' ? '' : 'the property '}${a.key}`}`;
  if (a.do === 'merge') return `merge its commits into ${a.branch}${a.push ? ' and push it' : ''}`;
  if (a.do === 'style') return `style its card: ${lookWords(a.look)}`;
  if (a.do === 'comment') return 'comment on it';
  if (a.do === 'look') return `its card shows ${lookWords(a.look)}`;
  return ACTIONS[a.do]?.label || a.do;
}
const an = (w) => `${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}`;
const lookWords = (l) => [l.outline && `${an(l.outline)} outline`, l.tint && `${an(l.tint)} tint`, l.badge?.text && `the badge "${l.badge.text}"`, l.ribbon && `the ribbon "${l.ribbon}"`, l.mark && `a ${l.mark.shape} mark`].filter(Boolean).join(', ') || 'no look';
const mins = (m) => (m % 1440 === 0 ? `${m / 1440} d` : m % 60 === 0 ? `${m / 60} h` : `${m} min`);

module.exports = { RuleError, EVENTS, TIMES, ACTIONS, ROLES, MAX_RULES, LOG_KEEP, MAX_PER_HOUR, FROM, cleanRule, eventMatches, timeDue, everyDue, throttled, noteFired, fill, fillValue, describe, describeAction };
