'use strict';
/* Rules (the Rules section): the human's own "when <something happens>, if <the ticket holds>, then <do this>".
   Pure: the vocabulary, cleaning a rule from the API, matching an event or the clock, and the board's built-in rules
   written in the same words. server.js carries the actions out. The "if" is the card-rules condition language. */
const cardrules = require('./cardrules');
const { WHYS: STALL_WHYS } = require('./alerts/stalls');

class RuleError extends Error {
  // at / end: where in the "if" it went wrong (an expression that doesn't read)
  constructor(message, hint, where) { super(message); this.hint = hint; if (where) Object.assign(this, where); }
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
  // a comment's own subject (INT-480): the rule fires once for each new comment, with the comment as C and its ticket as T
  commented: { type: 'comment.added', label: 'a comment is added', subject: 'comment' },
  // older: read as a comment rule with C.mentions.contains(…) (upgrade, below); still matched while a rule says it
  mentioned: { type: 'comment.added', label: 'someone is @mentioned', subject: 'comment', legacy: true, test: (e, _c, w) => (e.mentions || []).some((m) => !w.to || m.toLowerCase() === w.to.toLowerCase()) },
  unblocked: { type: 'item.unblocked', label: "a ticket's last blocker is finished" },
  lease_expired: { type: 'lease.expired', label: 'a lease expires' },
  ask_overdue: { type: 'ask.overdue', label: 'an ask is overdue' },
  // no ticket: the agent, why (lib/alerts/stalls.js WHYS) and the evidence are on the event (INT-483)
  agent_stalled: { type: 'agent.stalled', label: 'an agent stalls', agentOnly: true,
    test: (e, _c, w) => (!w.why || e.why === w.why) && (!w.agent || String(e.agent || '').toLowerCase() === w.agent.toLowerCase()) },
  // a state, not an event: while a ticket fits the conditions (a card look; the board draws it, nothing fires)
  fits: { type: null, label: 'a ticket fits the conditions', state: true },
  // assignee_away, board_idle, stuck, escalate, unstick and reassign are carried out by the board's engines, so the
  // board takes them only in the shapes of its own rules (server.js ENGINES, INT-472)
  assignee_away: { type: null, label: "a waiting ticket's assignee has been away an hour" },
};
const TIMES = {
  idle: { label: 'a ticket idles for', minutes: 5 },
  in_column: { label: 'a ticket has been in a column for', minutes: 5, column: true },
  every: { label: 'every', minutes: 15 },
  board_idle: { label: 'the board goes idle for', minutes: 5 },
  stuck: { label: 'a ticket is stuck (quiet) for', minutes: 5 },
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
  escalate: { label: 'ask the coordinator to unblock it', ticket: true },
  unstick: { label: 'ask the coordinator to unstick it, then you if it stays stuck', ticket: true },
  reassign: { label: 'hand it to an agent with room', ticket: true },
};
// who a wake or an assign names besides an agent: resolved per ticket when the rule fires
const ROLES = ['coordinator', 'assignee', 'last_worker'];

/* FOR / IF / THEN (INT-480). A rule is for a subject, whose parts have names the human may change (T, C), and its
   "if" is written in the expression language (public/js/expr.js), marked lang: "expr". Rules from before said their
   subject with the trigger and wrote "if" in the filter language; upgrade() rewrites them. Card looks and the board's
   engine rules keep the filter language: the board draws and recognises those by it.
   A new subject (a plugin's events or runs, INT-473/474) is one more row here, with its descriptor below. */
const SUBJECTS = {
  ticket: { label: 'a ticket', roles: ['ticket'] },
  comment: { label: 'a comment on a ticket', roles: ['comment', 'ticket'], event: 'commented' },
};
const ROLE_WORDS = { ticket: 'the ticket', comment: 'the comment' };
const DEFAULT_NAMES = { ticket: 'T', comment: 'C' };
const VAR = /^[A-Za-z][A-Za-z0-9_]{0,19}$/;
const RESERVED = ['in', 'true', 'false', 'null'];
const subjectOf = (on) => EVENTS[on]?.subject || 'ticket';
const namesFor = (subject, given) => Object.fromEntries(SUBJECTS[subject].roles.map((r) => [r, given?.[r] || DEFAULT_NAMES[r]]));

// The names a rule gives its subject's parts: each a word, none twice
function cleanNames(given, subject) {
  const out = namesFor(subject, null);
  for (const [role, v] of Object.entries(given && typeof given === 'object' ? given : {})) {
    if (!out[role]) throw new RuleError(`${SUBJECTS[subject].label} has no "${role}" to name`, `It names: ${Object.keys(out).join(', ')}`);
    const s = str(v, 40);
    if (!VAR.test(s) || RESERVED.includes(s)) throw new RuleError(`"${s}" can't name ${ROLE_WORDS[role]}`, 'A letter or a short word: letters, digits and _, starting with a letter (T, ticket, t2)');
    out[role] = s;
  }
  const taken = Object.values(out);
  if (new Set(taken).size !== taken.length) throw new RuleError('Two parts of the For have the same name', `Give each its own: ${Object.entries(out).map(([r, n]) => `${ROLE_WORDS[r]} ${n}`).join(', ')}`);
  return out;
}

/* What an "if" may name, as expr.js descriptors: the ticket (with the board's columns and declared fields) and the
   comment. The data a rule is judged over has the same shape (server.js ruleData). */
const d = (kind, hint, extra) => ({ kind, hint, ...extra });
const optionValues = (f) => (f.options || []).map((o) => (o && typeof o === 'object' ? o.value : o)).filter((v) => v != null).map(String);
function fieldDesc(f) {
  const hint = f.label || f.key;
  const opts = optionValues(f);
  if (f.type === 'enum') return d('choice', hint, { options: opts });
  if (f.type === 'tags') return d('list', hint, { of: opts.length ? d('choice', hint, { options: opts }) : d('text', hint) });
  return d({ number: 'number', boolean: 'bool', user: 'person' }[f.type] || 'text', hint);
}
function ticketDesc(columns = [], fields = []) {
  return d('object', 'the ticket', { fields: {
    id: d('text', 'its id, e.g. INT-12'), title: d('text', 'its title'), description: d('text', 'its description'),
    type: d('choice', 'task, issue or spike', { options: ['task', 'issue', 'spike'] }),
    priority: d('choice', 'how urgent', { options: ['Low', 'Medium', 'High', 'Critical'] }),
    column: d('choice', 'the column it is in', { options: columns.map((c) => c.name) }),
    assignee: d('person', 'who it is assigned to'), claimant: d('person', 'who holds its lease'),
    authorName: d('text', 'who filed it'), authorKind: d('text', 'agent or user: what filed it'),
    parent: d('text', 'its parent'), blockedBy: d('list', 'the tickets it waits on', { of: d('text', 'a ticket id') }),
    blocks: d('list', 'the tickets waiting on it', { of: d('text', 'a ticket id') }),
    columnDays: d('number', 'days in its column'), archived: d('bool', 'it is archived'),
    fields: d('object', "the board's fields", { fields: Object.fromEntries(fields.map((f) => [f.key, fieldDesc(f)])) }),
    properties: d('object', 'its properties', { open: true }),
    review: d('object', 'its review', { open: true, fields: {
      allOk: d('bool', 'every named reviewer said ok'), oks: d('number', 'ok verdicts that stand'), pending: d('number', 'reviewers yet to answer'),
      concerns: d('number', 'concerns that stand'), evidence: d('bool', 'the open review has evidence'), verdict: d('text', 'the decision'), by: d('text', 'who decided') } }),
    reviewers: d('object', 'reviewers by name', { open: true }),
  } });
}
const COMMENT_DESC = d('object', 'the comment', { fields: {
  id: d('text', 'its id'), author: d('person', 'who wrote it'), authorKind: d('text', 'agent or user'), text: d('text', 'what it says'),
  mentions: d('list', 'who it @mentions', { of: d('person', 'a name') }), intent: d('text', 'explain, for an Ask why'),
} });
// The expr.js schema for a rule: { vars: { T: …, C: … } } under its names
function schemaFor(subject, names, columns, fields) {
  const n = namesFor(subject, names);
  const desc = { ticket: ticketDesc(columns, fields), comment: COMMENT_DESC };
  return { vars: Object.fromEntries(Object.entries(n).map(([role, name]) => [name, desc[role]])) };
}

/* A filter-language condition (priority:High|Critical @drax) as an expression on the ticket named t
   (T.priority in ["High", "Critical"] && (T.assignee == "drax" || T.claimant == "drax")), or null when it can't be said
   the same way: an is:rule: term, a path the ticket has no type for, a value that isn't one of a choice's options.
   Only a translation that means exactly what the filter meant is made, so a rule never changes what it picks. */
const IDENT = /^[A-Za-z_$][\w$]*$/;
const q = (s) => JSON.stringify(String(s));
const TEXTISH = ['text', 'choice', 'person'];
function descAt(desc, path) {
  let cur = desc;
  for (const k of path) {
    if (!IDENT.test(k) || cur?.kind !== 'object') return null;
    cur = cur.fields && Object.hasOwn(cur.fields, k) ? cur.fields[k] : cur.open ? { kind: 'any' } : null;
  }
  return cur;
}
function termExpr(t, tname, tdesc) {
  if (t.kind === 'who') return `(${tname}.assignee == ${q(t.value)} || ${tname}.claimant == ${q(t.value)})`;
  if (t.kind !== 'path') return null;
  const desc = descAt(tdesc, t.path.split('.'));
  if (!desc || desc.kind === 'any' || desc.kind === 'object') return null;
  const x = `${tname}.${t.path}`;
  let e = null;
  if (t.op === 'set') e = desc.kind === 'bool' ? x : desc.kind === 'list' || TEXTISH.includes(desc.kind) ? `!${x}.isEmpty()` : null;
  else if (t.op === ':') {
    const vals = t.value.split('|');
    const choice = desc.kind === 'list' ? desc.of : desc;
    if (choice?.kind === 'choice' && !vals.every((v) => choice.options.some((o) => o.toLowerCase() === v.toLowerCase()))) return null;
    if (desc.kind === 'list') e = vals.map((v) => `${x}.contains(${q(v)})`).join(' || ');
    else if (TEXTISH.includes(desc.kind)) e = vals.length > 1 ? `${x} in [${vals.map(q).join(', ')}]` : `${x} == ${q(vals[0])}`;
    else if (desc.kind === 'number' && vals.every((v) => v !== '' && Number.isFinite(Number(v)))) e = vals.map((v) => `${x} == ${Number(v)}`).join(' || ');
    else if (desc.kind === 'bool' && vals.length === 1 && ['true', 'false'].includes(vals[0].toLowerCase())) e = `${x} == ${vals[0].toLowerCase()}`;
    if (e && vals.length > 1 && !e.includes(' in [')) e = `(${e})`;
  } else if (desc.kind === 'number' && t.op !== '~') e = `${x} ${t.op === '=' ? '==' : t.op} ${Number(t.value)}`;
  if (!e) return null;
  return t.not ? `!(${e})` : e;
}
function toExpr(cond, tname, tdesc) {
  let tree;
  try { tree = cardrules.parseCondition(cond); } catch { return null; }
  // every term with an || in it comes back in brackets, and so does a group (as the human wrote it), so && can join them as they are
  const alt = (node, nested) => {
    const ors = [];
    for (const all of node.any) {
      const ands = [];
      for (const t of all) {
        const e = t.any ? alt(t, true) : termExpr(t, tname, tdesc);
        if (e == null) return null;
        ands.push(e);
      }
      ors.push(ands.join(' && '));
    }
    const s = ors.join(' || ');
    return nested ? `(${s})` : s;
  };
  return alt(tree, false);
}

/* An older rule in today's words: its subject from its trigger, its "if" as an expression, "mentioned" as a comment
   rule that asks C.mentions. A rule that already speaks the language, a card look, an engine's rule or a ticket's own
   trigger is returned as it is; so is one whose "if" can't be said the same way (it keeps working in the filter
   language). tdesc: ticketDesc of the board. */
function upgrade(rule, tdesc) {
  if (!rule || rule.lang === 'expr' || rule.engine || rule.item || rule.when?.on === 'fits' || !rule.when) return rule;
  const subject = rule.for && SUBJECTS[rule.for] ? rule.for : subjectOf(rule.when.on);
  const names = namesFor(subject, rule.names);
  const parts = [];
  if (rule.if) {
    const e = toExpr(rule.if, names.ticket, tdesc);
    if (e == null) return rule;
    parts.push(e);
  }
  let when = rule.when;
  if (when.on === 'mentioned') {
    parts.push(when.to ? `${names.comment}.mentions.contains(${q(when.to)})` : `!${names.comment}.mentions.isEmpty()`);
    when = { on: 'commented' };
  }
  const cond = parts.length > 1 ? parts.map((p) => `(${p})`).join(' && ') : parts.join('');
  const { if: _old, ...rest } = rule;
  return { ...rest, for: subject, names, when, lang: 'expr', ...(cond ? { if: cond } : {}) };
}

const str = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));
const NAME = /^[a-z0-9][a-z0-9_.-]{0,39}$/i;
const PROP = /^[A-Za-z_][\w.-]{0,59}$/;
// a git branch the board may create and push: no leading dash, no spaces or ref syntax
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,99}$/;
// what an extract reads
const FROM = ['title', 'description', 'comments', 'all'];

// columns: [{ id, name }] of the board, so a rule names a column that is there (by id or name; kept as the id)
function cleanWhen(w, columns) {
  if (!w || typeof w !== 'object') throw new RuleError('"when" is required', `when.on is one of: ${[...Object.keys(EVENTS), ...Object.keys(TIMES)].join(', ')}`);
  const on = String(w.on || '');
  const def = EVENTS[on] || TIMES[on];
  if (!def) throw new RuleError(`"${on}" is not a trigger`, `when.on is one of: ${[...Object.keys(EVENTS), ...Object.keys(TIMES)].join(', ')}`);
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
  if (on === 'agent_stalled') {
    if (w.why != null && w.why !== '') {
      if (!STALL_WHYS.includes(w.why)) throw new RuleError(`"${w.why}" is not a reason an agent stalls`, `why is one of: ${STALL_WHYS.join(', ')}, or left out for any`);
      out.why = w.why;
    }
    if (w.agent) {
      if (!NAME.test(String(w.agent))) throw new RuleError(`"${w.agent}" is not a name`, 'A standing agent, e.g. drax, or left out for any');
      out.agent = String(w.agent);
    }
  }
  // the idle alarm: false when it should not tell the human if nobody it names can be woken
  if (on === 'board_idle' && w.human === false) out.human = false;
  return out;
}

function cleanAction(a, columns) {
  if (!a || typeof a !== 'object' || !ACTIONS[a.do]) throw new RuleError(`"${a?.do}" is not an action`, `"do" is one of: ${Object.keys(ACTIONS).join(', ')}`);
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
// compile: expr.js compile (the server passes it in: this file stays plain CommonJS); fields: the board's declared fields.
function cleanRule(r, columns, { id, prev, nowIso, compile = null, fields = [] }) {
  if (!r || typeof r !== 'object') throw new RuleError('A rule is { name, for?, names?, when, if?, then }', 'See GET /api/boards/<board>/rules');
  const name = str(r.name, 80);
  if (!name) throw new RuleError('A rule needs a name', 'Say what it does, e.g. "Wake the coordinator on idle tickets"');
  const subject = r.for == null || r.for === '' ? subjectOf(r.when?.on) : String(r.for);
  if (!SUBJECTS[subject]) throw new RuleError(`"${r.for}" is not something a rule is for`, `for is one of: ${Object.keys(SUBJECTS).join(', ')}`);
  const when = cleanWhen(r.when || (SUBJECTS[subject].event ? { on: SUBJECTS[subject].event } : null), columns);
  if (subjectOf(when.on) !== subject) {
    const own = Object.keys({ ...EVENTS, ...TIMES }).filter((k) => subjectOf(k) === subject && !EVENTS[k]?.legacy);
    throw new RuleError(`"${(EVENTS[when.on] || TIMES[when.on]).label}" is about ${SUBJECTS[subjectOf(when.on)].label}, not ${SUBJECTS[subject].label}`, `For ${SUBJECTS[subject].label}, when.on is one of: ${own.join(', ')}`);
  }
  // an edit that leaves out names and lang (the page before INT-480's step 2, the on/off switch) keeps the rule's own
  const names = cleanNames(r.names ?? (prev?.for === subject ? prev.names : null), subject);
  if (r.lang != null && !['expr', 'filter'].includes(r.lang)) throw new RuleError(`"${r.lang}" is not a language for "if"`, 'lang is expr (T.priority == "High"), or filter for the older priority:High');
  const lang = r.lang === 'expr' || (r.lang == null && prev?.lang === 'expr') ? 'expr' : null;
  const cond = str(r.if, lang ? 1000 : 500);
  if (cond && lang) {
    if (when.on === 'fits') throw new RuleError("A card look's conditions are in the filter language", 'Write them as the Filter box does, e.g. priority:Critical, and leave lang out');
    if (compile) {
      const c = compile(cond, schemaFor(subject, names, columns, fields));
      if (!c.ok) throw new RuleError(`The "if" doesn't read: ${c.error.message}`, `At character ${c.error.pos + 1}: ${JSON.stringify(cond.slice(c.error.pos, Math.max(c.error.end, c.error.pos + 1)))}. Names here: ${Object.values(names).join(', ')}`, { at: c.error.pos, end: c.error.end });
    }
  } else if (cond) {
    try { cardrules.parseCondition(cond); } catch (e) { throw new RuleError(`The "if" doesn't parse: ${e.message}`, e.hint); }
  }
  const then = Array.isArray(r.then) ? r.then : [];
  if (!then.length) throw new RuleError('A rule needs at least one action in "then"', `Actions: ${Object.keys(ACTIONS).join(', ')}`);
  if (then.length > MAX_ACTIONS) throw new RuleError(`At most ${MAX_ACTIONS} actions in a rule`, 'Split it into two rules');
  const actions = then.map((a) => cleanAction(a, columns));
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
  if (EVENTS[when.on]?.agentOnly && (cond || actions.some((a) => ACTIONS[a.do].ticket))) {
    throw new RuleError(`"${EVENTS[when.on].label}" is about an agent, not a ticket`, 'Use wake (the coordinator, or an agent by name); pick the agent and the reason in "when"');
  }
  return {
    id: prev?.id || id, name, enabled: r.enabled !== false, for: subject, names, when, ...(lang ? { lang } : {}), ...(cond ? { if: cond } : {}), then: actions,
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
  // a ticket's own triggers (rule.item, INT-475; lib/alerts/triggers.js)
  if (w.on === 'machine_free') when = `the machine is free (processor under ${w.busyBelow}%)`;
  if (w.on === 'quiet_for') when = `a ticket is quiet for ${mins(w.minutes)}`;
  if (w.on === 'at') when = `it is ${String(w.at).slice(0, 16).replace('T', ' ')} UTC`;
  if (w.on === 'agent_stalled') when = `${w.agent || 'an agent'} stalls${w.why ? ` (${w.why})` : ''}`;
  if (rule.item) when = when.replace(/^a ticket/, rule.item);
  return `If ${when}${rule.if ? ` and ${rule.if}` : ''} → ${rule.then.map((a) => describeAction(a, columns)).join(', ')}`;
}
// One action in words: "move it to Done"
function describeAction(a, columns) {
  const col = (id) => columns.find((c) => c.id === id)?.name || id;
  if (a.do === 'wake') return `wake ${a.agent.replace('_', ' ')}${a.batch === false ? ' at once' : ''}`;
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

module.exports = { RuleError, EVENTS, TIMES, ACTIONS, ROLES, SUBJECTS, DEFAULT_NAMES, subjectOf, cleanNames, ticketDesc, COMMENT_DESC, schemaFor, toExpr, upgrade, MAX_RULES, LOG_KEEP, MAX_PER_HOUR, FROM, cleanRule, eventMatches, timeDue, everyDue, throttled, noteFired, fill, fillValue, describe, describeAction };
