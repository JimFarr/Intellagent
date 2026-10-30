// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* The Rules page (the Rules section): the human's rules ("if <something happens> and <the ticket holds>, then
   <do this>") and what they did. Everything goes through /api/boards/<board>/rules (lib/rules.js on the server).
   The trigger is the If's first line; the conditions after it are the card-rules condition language, which the
   builder writes from dropdowns (field · operator · value, joined by AND or OR, one level of groups) and reads
   back. A condition the builder can't show as rows stays as text. */
import { $, $$, esc, el, icon } from './util.js';
import { compile, suggest, tokenize } from './expr.js';
import * as X from './exprrows.js';

const ROLE = { coordinator: 'the coordinator', assignee: 'the assignee', last_worker: 'whoever worked it last' };
const ACTION_ICON = { look: 'card', wake: 'bot', ask_human: 'ask', move: 'move', assign: 'user', release_lease: 'lock', archive: 'archive', comment: 'msg', set_field: 'braces', set_property: 'braces', extract: 'sparkle', land: 'checks', merge: 'send', style: 'palette', unstyle: 'x' };
// what every text and value may say: shown as each one's placeholder hint
const PLACEHOLDERS = '{id} {title} {field.key} {property.name} {pr.url} {pr.title} {comment.text} {comment.author} {comment.url}';
let uid = 0;
// The page's views, each its own entry in the section's side picker (app.js PAGES.rules)
// a duration is stored as minutes and shown in the largest unit that divides it
const UNITS = { minutes: 1, hours: 60, days: 1440 };
const bigUnit = (m) => (m % 1440 === 0 ? 'days' : m % 60 === 0 ? 'hours' : 'minutes');
export const RULE_VIEWS ={ mine: ['rulesDrawer', 'Rules', 'zap'], log: ['rulesLogDrawer', 'What they did', 'activity'] };

/* ─── conditions: what each field can be asked, and how a row becomes a term of the condition language ─── */
// kind → its operators: [key, label]. "one of" takes several values; "set" / "empty" take none.
const OPS = {
  choice: [['is', 'is'], ['not', 'is not'], ['oneof', 'is one of'], ['noneof', 'is none of'], ['set', 'is set'], ['empty', 'is empty']],
  person: [['is', 'is'], ['not', 'is not'], ['set', 'is someone'], ['empty', 'is nobody']],
  text: [['is', 'is'], ['not', 'is not'], ['set', 'is set'], ['empty', 'is empty']],
  number: [['>=', 'is at least'], ['<=', 'is at most'], ['=', 'is exactly'], ['>', 'is more than'], ['<', 'is less than']],
  flag: [['yes', 'is true'], ['no', 'is false']],
  who: [['is', 'is']],
  look: [['is', 'matches']],
  raw: [['raw', '']],
};
function condFields(board, people, looks) {
  const cols = board.columns.map((c) => ({ v: c.id, l: c.name }));
  const custom = (board.schema?.fields || []).map((f) => ({
    k: `fields.${f.key}`, label: f.label || f.key, group: 'Ticket fields',
    kind: f.type === 'number' ? 'number' : f.type === 'boolean' ? 'flag' : (f.options || []).length ? 'choice' : f.type === 'user' ? 'person' : 'text',
    options: (f.options || []).map((o) => { const v = typeof o === 'string' ? o : o.value; return { v, l: v }; }),
  }));
  const opts = (xs) => xs.map((v) => ({ v, l: v }));
  return [
    { k: 'columnId', label: 'Column', group: 'Ticket', kind: 'choice', options: cols },
    { k: 'priority', label: 'Priority', group: 'Ticket', kind: 'choice', options: opts(['Low', 'Medium', 'High', 'Critical']) },
    { k: 'type', label: 'Type', group: 'Ticket', kind: 'choice', options: opts(['task', 'issue', 'spike']) },
    { k: 'columnDays', label: 'Days in its column', group: 'Ticket', kind: 'number' },
    { k: 'blockedBy', label: 'Waiting on another ticket', group: 'Ticket', kind: 'flag' },
    { k: 'parent', label: 'Parent', group: 'Ticket', kind: 'text' },
    { k: 'assignee', label: 'Assignee', group: 'People', kind: 'person', options: people },
    { k: 'claimant', label: 'Held (leased) by', group: 'People', kind: 'person', options: people },
    { k: 'authorName', label: 'Created by', group: 'People', kind: 'person', options: people },
    { k: 'authorKind', label: 'Created by a', group: 'People', kind: 'choice', options: [{ v: 'user', l: 'person' }, { v: 'agent', l: 'agent' }] },
    { k: '@', label: 'Assigned to or held by', group: 'People', kind: 'who', options: people },
    { k: 'review.verdict', label: 'Review decision', group: 'Review', kind: 'choice', options: [{ v: 'approve', l: 'approved' }, { v: 'changes', l: 'sent back' }] },
    { k: 'review.allOk', label: 'Every reviewer said ok', group: 'Review', kind: 'flag' },
    { k: 'review.oks', label: 'Reviewers who said ok', group: 'Review', kind: 'number' },
    { k: 'review.concerns', label: 'A reviewer has concerns', group: 'Review', kind: 'flag' },
    { k: 'review.evidence', label: 'Review has evidence', group: 'Review', kind: 'flag' },
    ...custom,
    ...(looks.length ? [{ k: 'is:rule', label: 'Card look', group: 'Other', kind: 'look', options: opts(looks) }] : []),
    { k: 'raw', label: 'Written as text…', group: 'Other', kind: 'raw' },
  ];
}
const PHRASE = {
  claimant: { empty: 'nobody holds it', set: 'someone holds it', is: 'held by', not: 'not held by' },
  assignee: { empty: 'unassigned', set: 'assigned', is: 'assigned to', not: 'not assigned to' },
  authorName: { is: 'created by', not: 'not created by' },
  '@': { is: 'assigned to or held by' },
};
const isMulti = (op) => op === 'oneof' || op === 'noneof';
const noValue = (op) => op === 'set' || op === 'empty' || op === 'yes' || op === 'no';
// one row → its term, or null while it isn't finished
function rowTerm(r, fields) {
  const f = fields.find((x) => x.k === r.k);
  if (!f) return null;
  const vals = [].concat(r.value ?? []).map((v) => String(v).trim()).filter(Boolean);
  const plain = (v) => /^[^\s()]+$/.test(v);
  if (f.kind === 'raw') return vals[0] && plain(vals[0]) && !/^or$/i.test(vals[0]) ? vals[0] : null;
  if (f.kind === 'who') return vals[0] && /^[\w.-]+$/.test(vals[0]) ? `@${vals[0]}` : null;
  if (f.kind === 'look') return vals[0] ? (/\s/.test(vals[0]) ? `is:rule:"${vals[0]}"` : `is:rule:${vals[0]}`) : null;
  if (r.op === 'yes' || r.op === 'set') return f.k;
  if (r.op === 'no' || r.op === 'empty') return `!${f.k}`;
  if (!vals.length || !vals.every(plain)) return null;
  if (f.kind === 'number') return Number.isFinite(Number(vals[0])) ? `${f.k}${r.op}${vals[0]}` : null;
  const many = isMulti(r.op) ? vals : vals.slice(0, 1);
  return `${r.op === 'not' || r.op === 'noneof' ? '!' : ''}${f.k}:${many.join('|')}`;
}
// one term → a row (anything the builder doesn't know stays as a text row)
function termRow(t, fields) {
  if (/^@[\w.-]+$/.test(t)) return { k: '@', op: 'is', value: t.slice(1) };
  const look = /^is:rule:(?:"([^"]+)"|(\S+))$/i.exec(t);
  if (look && fields.some((f) => f.k === 'is:rule')) return { k: 'is:rule', op: 'is', value: look[1] ?? look[2] };
  const m = /^(!)?([A-Za-z_][\w.-]*)(:|>=|<=|>|<|=)?([^\s]*)$/.exec(t);
  const f = m && fields.find((x) => x.k === m[2]);
  const raw = { k: 'raw', op: 'raw', value: t };
  if (!f || f.kind === 'raw') return raw;
  if (!m[3]) return { k: f.k, op: f.kind === 'flag' ? (m[1] ? 'no' : 'yes') : (m[1] ? 'empty' : 'set') };
  if (f.kind === 'number') return !m[1] && m[3] !== ':' ? { k: f.k, op: m[3], value: m[4] } : raw;
  if (m[3] !== ':' || f.kind === 'flag') return raw;
  const vals = m[4].split('|');
  if (vals.length > 1) return { k: f.k, op: m[1] ? 'noneof' : 'oneof', value: vals };
  return { k: f.k, op: m[1] ? 'not' : 'is', value: f.kind === 'choice' ? [vals[0]] : vals[0] };
}
// "a (b or c)" → { mode: 'all', items: [row, { group, mode: 'any', rows }] }; null when the builder can't hold it
function parseCond(text, fields) {
  const src = String(text || '').trim();
  if (!src) return { mode: 'all', items: [] };
  const tokens = src.match(/\(|\)|is:rule:"[^"]*"|[^\s()]+/gi) || [];
  let at = 0;
  const level = (depth) => {
    const alts = [[]];
    for (;;) {
      const tok = tokens[at++];
      if (tok === undefined || tok === ')') { if ((tok === ')') !== (depth > 0)) throw new Error('unbalanced'); return alts; }
      if (/^or$/i.test(tok)) alts.push([]);
      else if (tok === '(') { if (depth) throw new Error('nested'); alts[alts.length - 1].push({ alts: level(1) }); }
      else alts[alts.length - 1].push(tok);
    }
  };
  try {
    const alts = level(0);
    if (alts.some((a) => !a.length)) return null;
    const rows = (ts) => ts.map((t) => termRow(t, fields));
    if (alts.length === 1) {
      const items = [];
      for (const it of alts[0]) {
        if (typeof it === 'string') { items.push(termRow(it, fields)); continue; }
        const g = it.alts;
        if (g.some((a) => !a.length || a.some((x) => typeof x !== 'string'))) return null;
        if (g.length === 1) items.push(...rows(g[0]));
        else if (g.every((a) => a.length === 1)) items.push({ group: true, mode: 'any', rows: rows(g.map((a) => a[0])) });
        else return null;
      }
      return { mode: 'all', items };
    }
    if (alts.some((a) => a.some((x) => typeof x !== 'string'))) return null;
    return { mode: 'any', items: alts.map((a) => (a.length === 1 ? termRow(a[0], fields) : { group: true, mode: 'all', rows: rows(a) })) };
  } catch { return null; }
}
// the tree back to condition text, or null while a row is unfinished. "and" binds tighter than "or", so a group
// of ands inside an "or" needs no brackets, and a group of ors inside an "and" takes one pair.
function condText(c, fields) {
  const term = (r) => rowTerm(r, fields);
  const part = (it) => {
    if (!it.group) return term(it);
    const ts = it.rows.map(term);
    if (!ts.length || ts.some((t) => !t)) return null;
    if (it.mode === c.mode || ts.length === 1) return ts.join(c.mode === 'any' ? ' or ' : ' ');
    return c.mode === 'all' ? `(${ts.join(' or ')})` : ts.join(' ');
  };
  const parts = c.items.map(part);
  return parts.some((p) => !p) ? null : parts.join(c.mode === 'any' ? ' or ' : ' ');
}

export function createRules({ api, toast, openDrawer, rel, nameOf, isOpen, board, people = () => [] }) {
  const S = { tab: 'mine', view: null, data: null, log: [], agents: [], plugins: [], body: null };
  const base = () => `/api/boards/${encodeURIComponent(board().id)}/rules`;
  const ago = (ts) => { const r = rel(ts); return !r ? '' : r === 'now' ? 'just now' : `${r} ago`; };
  const fail = (e) => toast(e.message + (e.data?.hint ? ` — ${e.data.hint}` : ''), { kind: 'error', wrap: true, timeout: 7000 });
  const option = (v, label, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;
  const colName = (id) => board().columns.find((c) => c.id === id)?.name || id;
  // the card looks' names, for the is:rule condition (a card look is a rule: if a ticket fits, its card looks so)
  const lookNames = () => (S.data?.rules || []).filter((r) => r.when.on === 'fits').map((r) => r.name);
  const skeleton = (n = 3) => `<div class="ent-list" aria-busy="true">${'<div class="ent sk" aria-hidden="true"><i></i><b></b><b class="s"></b></div>'.repeat(n)}</div>`;

  async function load() {
    const [data, log] = await Promise.all([api('GET', base()), api('GET', `${base()}/log?limit=100`)]);
    Object.assign(S, { data, log });
    // who a wake or an assign can name: the standing agents (a typed name still works)
    api('GET', '/api/plugins').then((r) => { S.plugins = r.plugins || []; }, () => {});
    api('GET', '/api/agents').then((a) => { S.agents = (a.agents || a || []).map((x) => x.name).filter(Boolean); }, () => {});
  }

  async function open(tab) {
    S.tab = RULE_VIEWS[tab] ? tab : 'mine';
    S.body = openDrawer(...RULE_VIEWS[S.tab]);
    S.body.innerHTML = skeleton();
    S.view = null;
    try { await load(); } catch (e) { S.body.innerHTML = `<div class="empty-note">${icon('zap')}<span>${esc(e.message)}</span></div>`; return; }
    render();
  }

  function render() {
    if (!isOpen()) return;
    S.body.innerHTML = '<div class="rl-page"></div>';
    const pane = $('.rl-page', S.body);
    if (S.view) return S.view(pane);
    ({ mine: drawMine, log: drawLog })[S.tab](pane);
  }

  // A rule's sentence with its parts picked out: If … and … then …
  function sentence(text, expr) {
    const m = /^(?:For (.*?), when|When) (.*?)(?:, and only if (.*?))?, (.*)\.$/.exec(text || '');
    if (!m) return `<span>${esc(text || '')}</span>`;
    return `${m[1] ? `<span class="rl-k">For</span> ${esc(m[1])}, ` : ''}<span class="rl-k">${m[1] ? 'when' : 'When'}</span> ${esc(m[2])}${m[3] ? `, <span class="rl-k">and only if</span> ${expr ? `<code>${esc(m[3])}</code>` : condWords(m[3])}` : ''}, ${esc(m[4])}.`;
  }
  // a condition in words, with the builder's own labels: "priority is one of High, Critical and held by is nobody"
  function condWords(text) {
    const fields = condFields(board(), [...new Set([...S.agents, ...people()])].map((n) => ({ v: n, l: nameOf(n) })), lookNames());
    const c = parseCond(text, fields);
    if (!c) return `<code>${esc(text)}</code>`;
    const row = (r) => {
      const f = fields.find((x) => x.k === r.k);
      if (!f || f.kind === 'raw') return `<code>${esc([].concat(r.value ?? []).join(''))}</code>`;
      const label = esc(f.label.toLowerCase());
      if (f.kind === 'flag') return r.op === 'yes' ? label : `not: ${label}`;
      const vals = [].concat(r.value ?? []).map((v) => esc(f.options?.find((o) => o.v === v)?.l || v));
      const said = vals.length && !noValue(r.op) ? ` <b>${vals.join(', ')}</b>` : '';
      // people read as phrases: "nobody holds it", "assigned to drax", not "held (leased) by is nobody"
      const phrase = PHRASE[f.k]?.[r.op];
      if (phrase) return `${phrase}${said}`;
      return `${label} ${esc(OPS[f.kind].find(([k]) => k === r.op)?.[1] || '')}${said}`;
    };
    const join = (mode) => (mode === 'any' ? ' <span class="rl-k">or</span> ' : ' <span class="rl-k">and</span> ');
    return c.items.map((it) => (it.group ? `(${it.rows.map(row).join(join(it.mode))})` : row(it))).join(join(c.mode));
  }

  /* ─── the rules ─── */
  function drawMine(pane) {
    const lastOf = (id) => S.log.find((l) => l.rule === id);
    const row = (r) => {
      const last = lastOf(r.id);
      const bad = last?.results?.filter((x) => !x.ok).length;
      // the when column: when it last fired, in amber or red when something needs a look
      const when = last?.held ? '<span class="warn-t">held back</span>' : bad ? `<span class="bad-t">${bad} failed</span>` : last ? esc(ago(last.at)) : r.native || r.when.on === 'fits' ? '' : 'never';
      return `<article class="ent${r.enabled ? '' : ' off'}" data-rule="${esc(r.id)}">
          <span class="ent-lead ent-tile"${r.enabled ? '' : ' data-tone="muted"'}>${icon(r.when.on === 'fits' ? 'card' : r.when.on in S.data.vocabulary.times ? 'clock' : 'zap')}</span>
          <div class="ent-body"><h3 class="ent-title"><span class="ent-name">${esc(r.name)}</span></h3><p class="rl-sentence">${sentence(r.text, r.lang === 'expr')}</p></div>
          <div class="ent-side"><span class="ent-col when" title="${last ? `Last fired ${esc(new Date(last.at).toLocaleString())}${last.item ? ` on ${esc(last.item)}` : ''}` : ''}">${when}</span>
            <div class="ent-acts"><button type="button" class="switch ${r.enabled ? 'on' : ''}" role="switch" aria-checked="${r.enabled}" aria-label="${esc(r.name)} on" data-on title="${r.enabled ? 'On|Switch it off' : 'Off|Switch it on'}"></button></div></div></article>`;
    };
    // yours first, then the ones the board came with (edited the same way); a row opens its editor
    const mine = S.data.rules.filter((r) => !r.native), built = S.data.rules.filter((r) => r.native);
    const box = (name, rows) => `<div class="ent-list one-line"><div class="ent-lh">${name} <span class="cnt">${rows.length}</span><span class="grow"></span><span class="ent-col when">Last fired</span><span style="width:38px"></span></div>${rows.map(row).join('')}</div>`;
    pane.innerHTML = `<div class="ent-bar"><button class="btn sm primary" data-new>${icon('plus', 'sm')}New rule</button></div>
      ${mine.length ? box('Your rules', mine) : `<div class="ent-empty">${icon('zap')}<h3>No rules of yours yet</h3><p>For example: <i>if a ticket idles for 2 h, wake the coordinator</i>.</p></div>`}
      ${built.length ? box('From column settings', built) : ''}`;
    pane.onclick = async (e) => {
      if (e.target.closest('[data-new]')) { S.view = (p) => editor(p, null); render(); return; }
      const card = e.target.closest('[data-rule]');
      const r = card && S.data.rules.find((x) => x.id === card.dataset.rule);
      if (!r) return;
      const sw = e.target.closest('[data-on]');
      if (sw) {
        sw.classList.toggle('on');
        try { await api('PUT', `${base()}/${encodeURIComponent(r.id)}`, { ...strip(r), enabled: !r.enabled }); await load(); render(); }
        catch (err) { sw.classList.toggle('on'); fail(err); }
        return;
      }
      // anywhere else on the card (Edit included) opens it
      if (!getSelection().toString()) { S.view = (p) => editor(p, r); render(); }
    };
  }
  const strip = (r) => ({ name: r.name, enabled: r.enabled, ...(r.for ? { for: r.for, names: r.names } : {}), ...(r.lang ? { lang: r.lang } : {}), when: r.when, ...(r.if ? { if: r.if } : {}), then: r.then });

  /* ─── the builder: If (the trigger, then conditions joined by AND / OR) → Then, with a live preview ─── */
  function editor(pane, r) {
    const v = S.data.vocabulary;
    const fields = condFields(board(), [...new Set([...S.agents, ...people()])].map((n) => ({ v: n, l: nameOf(n) })), lookNames());
    const blankRow = () => ({ k: 'priority', op: 'oneof', value: [] });
    const subjects = v.subjects || {};
    // a rule's "if" is an expression (For / If / Then) unless it is a card look, a board behaviour or an older rule in the filter language
    const st = { when: { ...(r?.when || { on: 'entered', column: board().columns[0]?.id }) }, cond: null, text: r?.if || '', asText: false, enabled: r ? r.enabled : true,
      for: r?.for && subjects[r.for] ? r.for : 'ticket', expr: !!subjects.ticket && (r ? r.lang === 'expr' : true) };
    st.names = { ...(subjects[st.for]?.names || {}), ...(r?.names || {}) };
    if (st.expr) { st.asText = true; st.cond = { mode: 'all', items: [] }; } else { st.cond = parseCond(r?.if, fields); if (!st.cond) { st.asText = true; st.cond = { mode: 'all', items: [] }; } }
    // the expression language's schema under this rule's names, and the rows it offers
    const schemaX = () => ({ vars: Object.fromEntries(Object.entries(st.names).map(([role, name]) => [name, subjects[st.for].parts[role]])) });
    let xfields = st.expr ? X.fieldsOf(schemaX()) : [];
    const FLD = () => (st.expr ? xfields : fields), OPT = () => (st.expr ? X.OPS : OPS);
    const rowDone = (row) => (st.expr ? X.rowText(row, xfields) : rowTerm(row, fields));
    const ROLE_WORD = { ticket: 'the ticket', comment: 'the comment' };
    pane.innerHTML = `<form class="rb" autocomplete="off">
      <header class="rb-top"><input class="rb-name" name="name" required maxlength="80" value="${esc(r?.name || '')}" placeholder="Name this rule" aria-label="Rule name">
        <label class="rb-on"><span>${st.enabled ? 'On' : 'Off'}</span><button type="button" class="switch ${st.enabled ? 'on' : ''}" role="switch" aria-checked="${st.enabled}" aria-label="Rule on" data-enabled></button></label></header>
      <p class="rb-sum rl-sentence" data-sum aria-live="polite"></p>
      <div class="rb-grid"><ol class="rb-flow">
        <li class="rb-step" data-for-step${st.expr ? '' : ' hidden'}><span class="rb-dot">For</span><div class="rb-card"><div class="rb-for" data-for></div></div></li>
        <li class="rb-step"><span class="rb-dot">When</span><div class="rb-card"><div data-when></div></div></li>
        <li class="rb-step" data-if-step><span class="rb-dot">If</span><div class="rb-card"><div data-if></div></div></li>
        <li class="rb-step"><span class="rb-dot">Then</span><div class="rb-card"><div class="rb-acts" data-acts></div>
          <button type="button" class="rb-add" data-add-act>${icon('plus', 'sm')}Add an action</button></div></li>
      </ol>
      <aside class="rb-preview" aria-live="polite"><div class="rb-ph">${icon('eye', 'sm')}Preview</div><div data-preview><div class="sk-lines" aria-hidden="true"><b></b><b class="s"></b></div></div></aside></div>
      <footer class="rb-foot">${r ? `<button type="button" class="btn sm ghost danger" data-del>${icon('trash', 'sm')}Delete</button>` : ''}<span class="grow"></span>
        <button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('check', 'sm')}${r ? 'Save' : 'Add rule'}</button></footer></form>`;
    alias = st.names?.ticket || 'T'; // before the action rows below are drawn
    const f = $('form', pane);
    const ifEl = $('[data-if]', f), whenEl = $('[data-when]', f), acts = $('[data-acts]', f);
    const joinSel = (mode, at) => `<select class="inp rb-join" data-join="${at}" aria-label="And or or">${option('all', 'AND', mode === 'all')}${option('any', 'OR', mode === 'any')}</select>`;

    // the trigger line: what sets the rule off, with what it needs
    function triggerHTML() {
      const d = v.events[st.when.on] || v.times[st.when.on] || {};
      // the rule's own names for its parts, so the trigger reads "T has been in Done for 2 days"
      const T = st.names?.ticket || 'T', C = st.names?.comment || 'C';
      const say = (k, label) => (k === 'commented' ? `a comment ${C} is added to ${T}` : k === 'in_column' ? `${T} has been in` : label.replace(/^a ticket\b/, T));
      const mins = Number(st.when.minutes) || 60, unit = st.unit || bigUnit(mins);
      return `<div class="rb-trigger"><select class="inp" data-w="on" aria-label="What sets it off">
          <optgroup label="Something happens">${Object.entries(v.events).filter(([k, x]) => !x.state && (!x.nativeOnly || k === st.when.on) && (!st.expr || x.subject === st.for)).map(([k, x]) => option(k, say(k, x.label), k === st.when.on)).join('')}</optgroup>
          <optgroup label="Time passes">${Object.entries(v.times).filter(([k, x]) => (!x.nativeOnly || k === st.when.on) && (!st.expr || st.for === 'ticket')).map(([k, x]) => option(k, say(k, x.label), k === st.when.on)).join('')}</optgroup>
          <optgroup label="While">${Object.entries(v.events).filter(([, x]) => x.state && (!st.expr || st.for === 'ticket')).map(([k, x]) => option(k, `${say(k, x.label)} (its card's look)`, k === st.when.on)).join('')}</optgroup></select>
        ${d.column ? `<select class="inp" data-w="column" aria-label="Column">${board().columns.map((c) => option(c.id, c.name, c.id === st.when.column)).join('')}</select>` : ''}
        ${st.when.on === 'in_column' ? '<span class="rb-word">for</span>' : ''}
        ${v.times[st.when.on] ? `<span class="rb-unit"><input class="inp" type="number" data-wn min="1" step="1" value="${mins / UNITS[unit]}" aria-label="How long"><select class="inp" data-wu aria-label="Unit">${Object.keys(UNITS).map((u) => option(u, u, u === unit)).join('')}</select></span>` : ''}
        ${st.when.on === 'plugin_event' ? pluginEventHTML() : ''}
        ${d.agent ? stallHTML(d) : ''}
        ${st.when.on === 'assigned' || st.when.on === 'mentioned' ? `<span class="rb-unit"><span>${st.when.on === 'assigned' ? 'to' : 'who'}</span><input class="inp" data-w="to" list="rl-people" placeholder="anyone" value="${esc(st.when.to || '')}" spellcheck="false"></span>` : ''}</div>`;
    }
    // an agent stalls: why (any or one) and which agent (any or a standing one); left out means any
    function stallHTML(d) {
      return `<select class="inp" data-w="why" aria-label="Why it stalls">${option('', 'for any reason', !st.when.why)}${d.whys.map((x) => option(x, x, x === st.when.why)).join('')}</select>
        <select class="inp" data-w="agent" aria-label="Which agent">${option('', 'any agent', !st.when.agent)}${S.agents.map((n) => option(n, n, n === st.when.agent)).join('')}</select>`;
    }
    // a plugin and one of the events it declares
    function pluginEventHTML() {
      const p = S.plugins.find((x) => x.name === st.when.plugin);
      return `<select class="inp" data-w="plugin" aria-label="Plugin">${option('', 'a plugin…', !p)}${S.plugins.map((x) => option(x.name, x.label || x.name, x.name === st.when.plugin)).join('')}</select>
        <select class="inp" data-w="event" aria-label="Event">${option('', 'an event…', !st.when.event)}${(p?.events || []).map((x) => option(x.id, x.label || x.id, x.id === st.when.event)).join('')}</select>`;
    }
    // one condition: field · operator · value
    function rowHTML(row, addr) {
      const fd = FLD().find((x) => x.k === row.k) || FLD()[0];
      const ops = OPT()[fd.kind];
      if (!ops.some(([k]) => k === row.op)) row.op = ops[0][0];
      const vals = [].concat(row.value ?? []);
      let val = '';
      if (fd.kind === 'raw') val = `<input class="inp mono rb-grow" data-val value="${esc(vals.join(''))}" placeholder="e.g. reviewers.nebula:ok" spellcheck="false">`;
      else if (noValue(row.op)) val = '';
      else if (fd.options?.length && isMulti(row.op)) val = `<span class="rb-chips">${fd.options.map((o) => { const ov = o.v ?? o, ol = o.l ?? o; return `<button type="button" class="toggle-chip ${vals.includes(ov) ? 'on' : ''}" data-opt="${esc(ov)}">${esc(ol)}</button>`; }).join('')}</span>`;
      else if (fd.options?.length && fd.kind !== 'person' && fd.kind !== 'who' && fd.kind !== 'list') val = `<select class="inp" data-val>${option('', 'choose…', !vals[0])}${fd.options.map((o) => option(o.v ?? o, o.l ?? o, (o.v ?? o) === vals[0])).join('')}</select>`;
      else if (fd.options?.length && fd.kind === 'list') val = `<select class="inp" data-val>${option('', 'choose…', !vals[0])}${fd.options.map((o) => option(o, o, o === vals[0])).join('')}</select>`;
      else if (fd.kind === 'number') val = `<input class="inp rb-num" type="number" min="0" data-val value="${esc(vals[0] ?? '')}" placeholder="2">`;
      else val = `<input class="inp" data-val ${fd.kind === 'person' || fd.kind === 'who' ? 'list="rl-people" placeholder="a name"' : 'placeholder="value"'} value="${esc(vals.join('|'))}" spellcheck="false">`;
      const groups = [...new Set(FLD().map((x) => x.group))];
      return `<div class="rb-row${rowDone(row) ? '' : ' todo'}" data-row="${addr}">
        <select class="inp" data-rk aria-label="Field">${groups.map((g) => `<optgroup label="${esc(g)}">${FLD().filter((x) => x.group === g).map((x) => option(x.k, x.label, x.k === fd.k)).join('')}</optgroup>`).join('')}</select>
        ${ops.length > 1 ? `<select class="inp rb-op" data-op aria-label="Operator">${ops.map(([k, l]) => option(k, l, k === row.op)).join('')}</select>` : fd.kind === 'raw' ? '' : `<span class="rb-opword">${esc(ops[0][1])}</span>`}
        ${val}<button type="button" class="icon-x" data-rdel title="Remove" aria-label="Remove this condition">${icon('x', 'sm')}</button></div>`;
    }
    // the rows as text and back: the expression language for a rule on a subject, the filter language for the rest
    const toText = () => (st.expr ? X.treeText(st.cond, xfields) : condText(st.cond, fields));
    const fromText = (t) => (st.expr ? X.parseRows(t, schemaX()) : parseCond(t, fields));
    const drawWhen = () => {
      alias = st.names?.ticket || 'T';
      $$('[data-do] option', acts).forEach((o) => { const d = v.actions[o.value]; if (d) o.textContent = actLabel(d.label); });
      stallOnly = !!v.events[st.when.on]?.agent; // it has no ticket: no If, no ticket actions
      $('[data-if-step]', f).hidden = stallOnly;
      $('[data-for-step]', f).hidden = stallOnly || !st.expr;
      whenEl.innerHTML = `${triggerHTML()}<div class="rb-hint">${stallOnly ? 'Acts on no ticket: it fires once each time an agent stalls.' : 'The rule looks at each ticket when this becomes true.'}</div>`;
    };
    const drawSummary = () => changed();
    function drawIf() {
      if (st.expr && !st.asText) st.text = toText() ?? st.text; // the builder writes the same text the box holds
      const c = st.cond;
      const items = c.items.map((it, i) => {
        const join = i === 0 ? '<span class="rb-and">AND</span>' : joinSel(c.mode, 'top');
        if (!it.group) return `<div class="rb-item">${join}${rowHTML(it, String(i))}</div>`;
        return `<div class="rb-item">${join}<div class="rb-group" data-group="${i}"><div class="rb-ghead"><span>Group</span><button type="button" class="icon-x" data-gdel title="Remove the group" aria-label="Remove the group">${icon('x', 'sm')}</button></div>
          ${it.rows.map((row, k) => `<div class="rb-item">${k === 0 ? '' : joinSel(it.mode, `g${i}`)}${rowHTML(row, `${i}.${k}`)}</div>`).join('')}
          <button type="button" class="rb-add" data-add-row="${i}">${icon('plus', 'sm')}Condition</button></div></div>`;
      }).join('');
      const open = st.ifOpen || !!st.text.trim() || c.items.length > 0;
      if (!open) {
        ifEl.innerHTML = `<div class="rb-iff"><button type="button" class="link-btn" data-if-open>${icon('plus', 'sm')}Add a condition</button><span class="rb-hint">Without one the rule acts every time the When happens.</span></div>`;
        return;
      }
      ifEl.innerHTML = `<div class="rb-iff"><b>and only if</b><span class="rb-hint">Narrows the When: both must hold.</span><button type="button" class="link-btn" data-if-clear>Remove</button></div>
        ${st.asText && st.expr ? `<div class="rb-x">
            <div class="rb-xbox"><input class="inp mono rb-xin" data-x role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="rl-sg" aria-describedby="rl-xmsg" aria-label="Only when" value="${esc(st.text)}" placeholder="${st.for === 'comment' ? esc(`${st.names.comment}.text.contains("?")`) : esc(`${st.names.ticket}.priority in ["High", "Critical"]`)}" spellcheck="false" autocapitalize="off">
              <ul class="rb-sug" id="rl-sg" role="listbox" aria-label="Suggestions" hidden></ul></div>
            <button type="button" class="rb-xmsg" id="rl-xmsg" data-xgo hidden></button>
            <div class="rb-hint">Written as an expression, e.g. <code>${esc(`${st.names.ticket}.priority == "High" && ${st.names.ticket}.assignee.isEmpty()`)}</code>. Leave it empty for every one. Ctrl+Space shows what fits here.</div></div>
          <div class="rb-adds"><button type="button" class="link-btn" data-as-rows>Use the builder</button></div>`
        : st.asText ? `<div class="rb-item"><span class="rb-and">AND</span><input class="inp mono rb-grow" data-cond-text value="${esc(st.text)}" placeholder="priority:High|Critical (@drax or @nebula)" spellcheck="false"></div>
          <div class="rb-hint">Written in the condition language. Leave it empty for every ticket.</div>
          <div class="rb-adds"><button type="button" class="link-btn" data-as-rows>Use the builder</button></div>`
        : `${items}<div class="rb-adds"><button type="button" class="rb-add" data-add-row>${icon('plus', 'sm')}Add a condition</button>
          <button type="button" class="rb-add" data-add-group>${icon('layers', 'sm')}Add a group</button><span class="grow"></span>
          <button type="button" class="link-btn" data-as-text>Write it as text</button></div>
          ${c.items.length ? '' : '<div class="rb-hint">No conditions: every one it happens to.</div>'}
          ${st.expr ? `<div class="rb-hint">Writes: <code data-xtext>${esc(st.text || 'nothing yet')}</code></div>` : ''}`}`;
      if (st.expr && st.asText) check();
    }
    /* the If box: green or red as it reads, and what fits under the caret */
    const sg = { items: [], at: 0, from: 0, to: 0 };
    const xin = () => $('[data-x]', ifEl);
    function check() {
      const i = xin(), msg = $('[data-xgo]', ifEl);
      if (!i) return true;
      const c = st.text.trim() ? compile(st.text, schemaX()) : null;
      i.classList.toggle('ok', !!c?.ok); i.classList.toggle('bad', c ? !c.ok : false); i.setAttribute('aria-invalid', c && !c.ok ? 'true' : 'false');
      msg.hidden = !c || c.ok;
      if (c && !c.ok) {
        const er = c.error;
        msg.textContent = `${er.message} (character ${er.pos + 1})`;
        Object.assign(msg.dataset, { at: er.pos, end: Math.max(er.end, er.pos + 1) });
      }
      return !c || c.ok;
    }
    function closeSug() { sg.items = []; const u = $('#rl-sg', ifEl), i = xin(); if (u) u.hidden = true; if (i) { i.setAttribute('aria-expanded', 'false'); i.removeAttribute('aria-activedescendant'); } }
    function drawSug() {
      const u = $('#rl-sg', ifEl), i = xin();
      if (!u || !i) return;
      if (!sg.items.length) return closeSug();
      u.innerHTML = sg.items.map((x, n) => `<li id="rl-sg-${n}" role="option" data-sg="${n}" aria-selected="${n === sg.at}"><b>${esc(x.label)}</b><span>${esc(x.hint || x.kind)}</span></li>`).join('');
      u.hidden = false; i.setAttribute('aria-expanded', 'true'); i.setAttribute('aria-activedescendant', `rl-sg-${sg.at}`);
      $(`#rl-sg-${sg.at}`, u)?.scrollIntoView({ block: 'nearest' });
      // under the caret: the width of the text before where the word starts
      const cs = getComputedStyle(i), ctx = document.createElement('canvas').getContext('2d');
      ctx.font = cs.font;
      const x = parseFloat(cs.paddingLeft) + ctx.measureText(i.value.slice(0, sg.from)).width - i.scrollLeft;
      u.style.left = `${Math.max(0, Math.min(x, i.offsetWidth - 220))}px`;
    }
    // an empty box offers nothing until asked (Ctrl+Space)
    function suggestNow(force) {
      const i = xin();
      if (!i) return;
      const out = suggest(i.value, i.selectionStart ?? i.value.length, schemaX());
      sg.items = force || i.value ? out.items.slice(0, 40) : [];
      Object.assign(sg, { at: 0, from: out.from, to: out.to });
      drawSug();
    }
    function take(n) {
      const i = xin(), it = sg.items[n];
      if (!i || !it) return;
      i.value = i.value.slice(0, sg.from) + it.insert + i.value.slice(sg.to);
      const caret = sg.from + it.insert.length;
      i.setSelectionRange(caret, caret); i.focus();
      st.text = i.value; check(); changed(); suggestNow();
    }
    /* the For step: what the rule is about, and what its parts are called */
    const VAR = /^[A-Za-z][A-Za-z0-9_]{0,19}$/;
    function drawFor() {
      const box = $('[data-for]', f);
      $('[data-for-step]', f).hidden = stallOnly || !st.expr;
      if (!st.expr) return;
      const roles = Object.keys(subjects[st.for].names);
      box.innerHTML = `<select class="inp" data-subject aria-label="What the rule is for">${Object.entries(subjects).map(([k, x]) => option(k, x.label, k === st.for)).join('')}</select>
        ${roles.map((role) => `<label class="rb-unit"><span>${role === st.for ? 'named' : 'its ticket, named'}</span><input class="inp rb-nm" data-nm="${role}" value="${esc(st.names[role])}" maxlength="20" spellcheck="false" autocapitalize="off" aria-label="Name for ${ROLE_WORD[role]}"></label>`).join('')}
        <span class="rb-hint" data-nmmsg role="alert" hidden></span>`;
    }
    // the filter language and the expression language each have their own If: a card look is the only new rule that needs the old one
    function setLanguage(expr) {
      Object.assign(st, { expr, text: '', asText: expr, cond: expr ? { mode: 'all', items: [] } : parseCond('', fields) });
      xfields = expr ? X.fieldsOf(schemaX()) : [];
      drawFor();
    }
    const rowAt = (n) => {
      const [i, k] = n.closest('[data-row]').dataset.row.split('.').map(Number);
      return k == null ? st.cond.items[i] : st.cond.items[i].rows[k];
    };
    ifEl.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add-row]');
      if (add) { const g = add.dataset.addRow; (g === '' ? st.cond.items : st.cond.items[Number(g)].rows).push(blankRow()); drawIf(); changed(); return; }
      if (e.target.closest('[data-add-group]')) { st.cond.items.push({ group: true, mode: st.cond.mode === 'all' ? 'any' : 'all', rows: [blankRow(), blankRow()] }); drawIf(); changed(); return; }
      const del = e.target.closest('[data-rdel]');
      if (del) {
        const [i, k] = del.closest('[data-row]').dataset.row.split('.').map(Number);
        if (k == null) st.cond.items.splice(i, 1);
        else { st.cond.items[i].rows.splice(k, 1); if (!st.cond.items[i].rows.length) st.cond.items.splice(i, 1); }
        drawIf(); changed(); return;
      }
      const gdel = e.target.closest('[data-gdel]');
      if (gdel) { st.cond.items.splice(Number(gdel.closest('[data-group]').dataset.group), 1); drawIf(); changed(); return; }
      const opt = e.target.closest('[data-opt]');
      if (opt) {
        const row = rowAt(opt); const vals = new Set([].concat(row.value || []));
        vals.has(opt.dataset.opt) ? vals.delete(opt.dataset.opt) : vals.add(opt.dataset.opt);
        row.value = [...vals]; drawIf(); changed(); return;
      }
      if (e.target.closest('[data-as-text]')) { st.text = toText() ?? st.text; st.asText = true; drawIf(); return; }
      const go = e.target.closest('[data-xgo]');
      if (go) { const i = $('[data-x]', ifEl); i.focus(); i.setSelectionRange(Number(go.dataset.at), Number(go.dataset.end)); return; }
      const pick = e.target.closest('[data-sg]');
      if (pick) { take(Number(pick.dataset.sg)); return; }
      if (e.target.closest('[data-as-rows]')) {
        const c = fromText(st.text);
        if (!c) { toast('The builder can’t show this as rows (a group in a group, or something its rows lack): keep it as text', { kind: 'error' }); return; }
        st.cond = c; st.asText = false; drawIf(); changed();
      }
    });
    whenEl.addEventListener('input', (e) => {
      if (e.target.matches('[data-wn]')) { setMinutes(); changed(); }
    });
    whenEl.addEventListener('change', (e) => {
      if (e.target.matches('[data-wu]')) { st.unit = e.target.value; setMinutes(); changed(); }
    });
    // the number and its unit, kept as minutes
    function setMinutes() {
      const n = Number($('[data-wn]', whenEl).value), u = $('[data-wu]', whenEl).value;
      st.unit = u;
      st.when.minutes = Math.max(v.times[st.when.on]?.minMinutes || 5, Math.round(n * UNITS[u]) || 0);
      drawSummary();
    }
    ifEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-if-open]')) { st.ifOpen = true; drawIf(); (xin() || $('select, input', ifEl))?.focus(); }
      if (e.target.closest('[data-if-clear]')) { Object.assign(st, { ifOpen: false, text: '', cond: { mode: 'all', items: [] } }); drawIf(); changed(); }
    });
    whenEl.addEventListener('change', whenChanged);
    function whenChanged(e) {
      const w = e.target.dataset.w;
      if (w) {
        st.when[w] = e.target.value;
        if (w === 'plugin') { st.when.event = ''; drawIf(); }
        if (w === 'on') {
          const d = v.events[st.when.on] || v.times[st.when.on];
          if (d.column && !st.when.column) st.when.column = board().columns[0]?.id;
          if (v.times[st.when.on] && !st.when.minutes) st.when.minutes = 60;
          const isLook = st.when.on === 'fits';
          // a card look keeps the filter language; every other new rule is written in the expression language
          if (!r && subjects.ticket && st.expr === isLook) setLanguage(!isLook);
          const hasLook = $$('[data-do]', acts).some((x) => x.value === 'look');
          if (isLook !== hasLook) { acts.innerHTML = ''; acts.append(el(actionRow(isLook ? { do: 'look', look: { outline: 'accent' } } : { do: 'wake', agent: 'coordinator' }))); renumber(); }
          $('[data-add-act]', f).hidden = isLook;
          st.unit = null;
          delete st.when.why; delete st.when.agent;
          const wasStall = stallOnly;
          drawWhen();
          // a rule with no ticket keeps no condition and none of the ticket actions: redraw the rows so their lists follow
          if (stallOnly) Object.assign(st, { ifOpen: false, text: '', cond: { mode: 'all', items: [] } });
          if (stallOnly !== wasStall) {
            for (const row of $$('.rb-act', acts)) {
              const act = $('[data-do]', row).value, g = (n) => $(`[name="${n}"]`, row)?.value ?? '';
              if (act === 'look') continue;
              row.replaceWith(el(actionRow(act === 'wake' ? { do: 'wake', agent: g('agent'), note: g('note') } : stallOnly && v.actions[act]?.ticket ? { do: 'wake', agent: 'coordinator' } : { do: act })));
            }
            renumber();
          }
          drawIf();
        }
        if (w === 'column') drawSummary();
        changed();
      }
    }
    ifEl.addEventListener('change', (e) => {
      const j = e.target.dataset.join;
      if (j) { if (j === 'top') st.cond.mode = e.target.value; else st.cond.items[Number(j.slice(1))].mode = e.target.value; drawIf(); changed(); return; }
      if (e.target.matches('[data-rk]')) {
        const row = rowAt(e.target); const fd = FLD().find((x) => x.k === e.target.value);
        Object.assign(row, { k: fd.k, op: OPT()[fd.kind][0][0], value: undefined });
        drawIf(); changed(); return;
      }
      if (e.target.matches('[data-op]')) {
        const row = rowAt(e.target); const was = isMulti(row.op);
        row.op = e.target.value;
        if (was !== isMulti(row.op)) row.value = [].concat(row.value ?? []).slice(0, 1);
        drawIf(); changed(); return;
      }
      if (e.target.matches('select[data-val]')) { rowAt(e.target).value = [e.target.value]; drawIf(); changed(); }
    });
    ifEl.addEventListener('keydown', (e) => {
      if (!e.target.matches('[data-x]')) return;
      const open = sg.items.length;
      if (e.key === ' ' && e.ctrlKey) { e.preventDefault(); suggestNow(true); return; }
      if (!open) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sg.at = (sg.at + (e.key === 'ArrowDown' ? 1 : -1) + open) % open; drawSug(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); take(sg.at); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSug(); }
    });
    ifEl.addEventListener('focusout', (e) => { if (e.target.matches('[data-x]')) closeSug(); });
    ifEl.addEventListener('mousedown', (e) => { if (e.target.closest('[data-sg]')) e.preventDefault(); }); // keep the caret in the box
    ifEl.addEventListener('input', (e) => {
      if (e.target.matches('input[data-val]')) {
        const row = rowAt(e.target);
        row.value = e.target.value;
        e.target.closest('[data-row]').classList.toggle('todo', !rowDone(row));
        changed();
      }
      if (e.target.matches('[data-cond-text]')) { st.text = e.target.value; changed(); }
      if (e.target.matches('[data-x]')) { st.text = e.target.value; check(); changed(); suggestNow(); }
    });

    f.addEventListener('change', (e) => {
      if (!e.target.matches('[data-subject]')) return;
      st.for = e.target.value; st.names = { ...subjects[st.for].names }; st.text = ''; st.cond = { mode: 'all', items: [] }; st.asText = true; xfields = X.fieldsOf(schemaX());
      const own = Object.keys(v.events).find((k) => v.events[k].subject === st.for && !v.events[k].state && !v.events[k].nativeOnly);
      if (v.events[st.when.on]?.subject !== st.for) st.when = { on: own, column: board().columns[0]?.id };
      drawFor(); drawWhen(); drawIf(); changed();
    });
    f.addEventListener('input', (e) => {
      const nm = e.target.closest('[data-nm]');
      if (!nm) return;
      const role = nm.dataset.nm, word = nm.value.trim(), msg = $('[data-nmmsg]', f);
      const bad = !VAR.test(word) || ['in', 'true', 'false', 'null'].includes(word) ? 'A letter or a short word: letters, digits and _, starting with a letter'
        : Object.entries(st.names).some(([k, n]) => k !== role && n === word) ? 'Two parts need different names' : '';
      nm.setAttribute('aria-invalid', bad ? 'true' : 'false'); msg.hidden = !bad; msg.textContent = bad;
      if (bad) return;
      // the If keeps meaning the same thing under the new name
      const was = st.names[role];
      st.text = X.renameIn(st.asText ? st.text : toText() ?? st.text, was, word);
      st.names[role] = word; xfields = X.fieldsOf(schemaX());
      if (!st.asText) { const c = fromText(st.text); if (c) st.cond = c; else st.asText = true; }
      drawWhen(); drawIf(); changed();
    });
    stallOnly = !!v.events[st.when.on]?.agent; // before the first action row is drawn
    for (const a of r?.then || [{ do: 'wake', agent: 'coordinator' }]) acts.append(el(actionRow(a)));
    const renumber = () => $$('.rb-act', acts).forEach((x, i) => { $('.rb-n', x).textContent = i + 1; });
    renumber();
    $('[data-add-act]', f).hidden = st.when.on === 'fits'; // a card look has its one look
    acts.addEventListener('change', (e) => {
      if (e.target.matches('[data-do]')) { e.target.closest('.rb-act').replaceWith(el(actionRow({ do: e.target.value }))); renumber(); }
      // an extract's how and into change which inputs it shows: redraw the row with what is typed so far
      if (e.target.matches('[data-redraw]')) {
        const row = e.target.closest('.rb-act');
        const g = (n) => $(`[name="${n}"]`, row)?.value ?? '';
        row.replaceWith(el(actionRow({ do: 'extract', from: g('from'), how: g('how'), into: g('into'), ask: g('ask'), pattern: g('pattern'), key: g('key') })));
        renumber();
      }
      // a run's plugin and action decide which inputs it shows
      if (e.target.matches('[data-redraw-run]')) {
        const row = e.target.closest('.rb-act');
        const g = (n) => $(`[name="${n}"]`, row)?.value ?? '';
        const pick = e.target.name === 'plugin';
        row.replaceWith(el(actionRow({ do: 'run', plugin: g('plugin'), action: pick ? '' : g('action'), inputs: pick ? {} : readInputs(row) })));
        renumber();
      }
      changed();
    });
    acts.addEventListener('input', changed);
    f.addEventListener('click', (e) => {
      if (e.target.closest('[data-add-act]')) { if ($$('.rb-act', acts).length < 6) { acts.append(el(actionRow({ do: 'comment' }))); renumber(); changed(); } }
      if (e.target.closest('[data-act-del]')) { e.target.closest('.rb-act').remove(); renumber(); changed(); }
      const en = e.target.closest('[data-enabled]');
      if (en) { st.enabled = !st.enabled; en.classList.toggle('on', st.enabled); en.setAttribute('aria-checked', st.enabled); en.previousElementSibling.textContent = st.enabled ? 'On' : 'Off'; }
    });
    f.elements.name.addEventListener('input', changed);
    $('[data-cancel]', f).onclick = () => { S.view = null; render(); };
    const del = $('[data-del]', f);
    if (del) del.onclick = async () => {
      if (!confirm(`Delete the rule "${r.name}"? What it did stays in the log.`)) return;
      try { await api('DELETE', `${base()}/${encodeURIComponent(r.id)}`); S.view = null; await load(); render(); toast('Rule deleted', { kind: 'ok', icon: 'trash' }); } catch (e) { fail(e); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = read();
      if (st.expr && st.asText && !check()) { xin().focus(); toast('The If doesn’t read yet: the red message says where', { kind: 'error' }); return; }
      if (body.if === null) { toast('Finish the conditions first (a highlighted row needs a value), or remove them', { kind: 'error' }); return; }
      const send = (b) => (r ? api('PUT', `${base()}/${encodeURIComponent(r.id)}`, b) : api('POST', base(), b));
      try {
        let sent = body;
        try { await send(sent); } catch (err) {
          if (err.data?.code !== 'CONFIRM_REQUIRED') throw err;
          // saved on, it would act on tickets at once (INT-508): say how many and ask
          const choice = await confirmAct(err.data);
          if (!choice) return;
          sent = choice === 'off' ? { ...body, enabled: false } : { ...body, confirm: err.data.count };
          await send(sent);
        }
        S.view = null; await load(); render();
        toast(sent.enabled !== body.enabled ? 'Rule saved switched off: nothing happens until you switch it on' : r ? 'Rule saved' : 'Rule added: it acts from now on', { kind: 'ok', icon: 'zap' });
      } catch (err) { fail(err); }
    };

    function read() {
      const cond = st.asText ? st.text.trim() : toText();
      const then = $$('.rb-act', acts).map((row) => {
        const g = (n) => $(`[name="${n}"]`, row)?.value.trim() ?? '';
        const a = { do: $('[data-do]', row).value };
        if (a.do === 'wake') { a.agent = g('agent') || 'coordinator'; if (g('note')) a.note = g('note'); }
        if (a.do === 'assign') a.to = g('to') || null;
        if (a.do === 'move') a.column = g('column');
        if (a.do === 'comment' || a.do === 'ask_human') a.text = g('text');
        if (a.do === 'set_field' || a.do === 'set_property') { a.key = g('key'); const raw = g('value'); a.value = raw === '' ? null : raw; if (/^(true|false|-?\d+(\.\d+)?|\[.*\])$/.test(raw)) try { a.value = JSON.parse(raw); } catch { /* text as typed */ } }
        if (a.do === 'run') Object.assign(a, { plugin: g('plugin'), action: g('action'), inputs: readInputs(row) });
        if (a.do === 'merge') { a.branch = g('branch'); a.push = !!$('[name="push"]', row)?.checked; }
        if (a.do === 'extract') {
          Object.assign(a, { from: g('from') || 'all', how: g('how') || 'pattern', into: g('into') || 'property' });
          if (a.how === 'ai') a.ask = g('ask'); else a.pattern = g('pattern');
          if (a.into !== 'comment') a.key = g('key');
        }
        if (a.do === 'look' || a.do === 'style') {
          a.look = {};
          if (g('outline')) a.look.outline = g('outline');
          if (g('tint')) a.look.tint = g('tint');
          if (g('badge')) a.look.badge = { text: g('badge') };
          if (g('ribbon')) a.look.ribbon = g('ribbon');
          if (g('shape')) a.look.mark = { shape: g('shape'), tone: g('markTone') || 'accent' };
        }
        return a;
      });
      const when = { on: st.when.on };
      const d = v.events[when.on] || v.times[when.on] || {};
      if (d.column) when.column = st.when.column;
      if (v.times[when.on]) when.minutes = Number(st.when.minutes) || 60;
      if (d.agent) Object.assign(when, st.when.why ? { why: st.when.why } : {}, st.when.agent ? { agent: st.when.agent } : {});
      if (when.on === 'plugin_event') Object.assign(when, { plugin: st.when.plugin || '', event: st.when.event || '' });
      if ((when.on === 'assigned' || when.on === 'mentioned') && st.when.to?.trim()) when.to = st.when.to.trim();
      return { name: f.elements.name.value.trim(), enabled: st.enabled, ...(st.expr ? { for: st.for, names: st.names, lang: 'expr' } : {}), when, if: cond === null ? null : cond || undefined, then };
    }

    let t = null;
    function changed() { clearTimeout(t); t = setTimeout(preview, 300); }
    async function preview() {
      const out = $('[data-preview]', f);
      if (!out) return;
      const body = read();
      if (body.if === null) { out.innerHTML = '<p class="rb-wait">Finish the highlighted conditions to see which tickets it picks.</p>'; return; }
      if (st.expr && !(st.text.trim() ? compile(st.text, schemaX()).ok : true)) { out.innerHTML = '<p class="rb-wait">Fix the If (the red message) to see which it picks.</p>'; return; }
      try {
        const p = await api('POST', `${base()}/preview`, { rule: { ...body, name: body.name || 'preview' } });
        const items = p.items.map((x) => `<li><code>${esc(x.id)}</code><span>${esc(x.title)}</span></li>`).join('');
        $('[data-sum]', f).innerHTML = sentence(p.text, st.expr);
        out.innerHTML = `<div class="rb-count"><b>${p.mode === 'board' || stallOnly ? '—' : p.count}</b><span>${p.mode === 'board' || stallOnly ? 'Acts on no ticket: it wakes once each time' : p.mode === 'due' ? `ticket${p.count === 1 ? '' : 's'} it would fire for right now` : `ticket${p.count === 1 ? '' : 's'} on the board fit the conditions now`}</span></div>
          ${items && !stallOnly ? `<ul class="rb-items">${items}</ul>` : ''}`;
        out.classList.remove('bad');
      } catch (e) { out.innerHTML = `<p>${esc(e.message)}</p>${e.data?.hint ? `<p class="rb-wait">${esc(e.data.hint)}</p>` : ''}`; out.classList.add('bad'); }
    }
    drawFor(); drawWhen(); drawIf(); changed();
    pane.append(el(`<datalist id="rl-people">${fields.find((x) => x.k === 'assignee').options.map((o) => `<option value="${esc(o.v)}">${esc(o.l)}</option>`).join('')}</datalist>`));
  }

  // a run's typed inputs as filled in; empty ones are left out (texts may hold {id}, {title} and {event.<field>})
  const readInputs = (row) => Object.fromEntries($$('[data-input]', row).map((i) => [i.dataset.input, i.type === 'checkbox' ? i.checked : i.type === 'number' ? (i.value === '' ? '' : Number(i.value)) : i.value.trim()]).filter(([, x]) => x !== '' && x !== false));

  // One action: a numbered card with what to do and the one or two things it needs
  // an action in the rule's own name for its ticket: "archive T"
  let alias = 'T';
  const actLabel = (label) => label.replace(/\bthe ticket\b/g, alias).replace(/\bit\b/g, alias);
  let stallOnly = false; // the rule being edited is about an agent, not a ticket
  function actionRow(a) {
    const v = S.data.vocabulary;
    const id = `rl${++uid}`;
    const who = (name, cur, allowNone) => `<input class="inp" name="${name}" list="rl-who-${id}" value="${esc(cur || '')}" placeholder="${allowNone ? 'nobody (unassign)' : 'coordinator'}" spellcheck="false">
      <datalist id="rl-who-${id}">${Object.keys(ROLE).map((k) => `<option value="${k}">${esc(ROLE[k])}</option>`).join('')}${S.agents.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`;
    let rest = '';
    if (a.do === 'wake') rest = `${who('agent', a.agent || 'coordinator')}<input class="inp rb-wide" name="note" maxlength="500" value="${esc(a.note || '')}" placeholder="What to do (optional; {id} {title})">`;
    if (a.do === 'assign') rest = who('to', a.to, true);
    if (a.do === 'move') rest = `<select class="inp" name="column">${board().columns.map((c) => option(c.id, c.name, c.id === a.column)).join('')}</select>`;
    if (a.do === 'comment' || a.do === 'ask_human') rest = `<input class="inp rb-wide" name="text" maxlength="4000" value="${esc(a.text || '')}" placeholder="${a.do === 'comment' ? 'Comment' : 'Question'}: ${PLACEHOLDERS}">`;
    if (a.do === 'set_field' || a.do === 'set_property') {
      const keys = a.do === 'set_field' ? board().schema?.fields?.map((x) => x.key) || [] : [];
      rest = `<input class="inp" name="key" value="${esc(a.key || '')}" placeholder="${a.do === 'set_field' ? 'field' : 'property'}" spellcheck="false"${keys.length ? ` list="rl-keys-${id}"` : ''}>${keys.length ? `<datalist id="rl-keys-${id}">${keys.map((k) => `<option value="${esc(k)}">`).join('')}</datalist>` : ''}<span class="rb-to">to</span><input class="inp rb-wide" name="value" value="${esc(a.value == null ? '' : typeof a.value === 'string' ? a.value : JSON.stringify(a.value))}" placeholder="value, e.g. {pr.url} (empty clears it)" spellcheck="false">`;
    }
    if (a.do === 'run') {
      const p = S.plugins.find((x) => x.name === a.plugin);
      const act = p?.actions?.find((x) => x.id === a.action);
      const input = (f) => {
        const cur = a.inputs?.[f.key];
        const lab = `${esc(f.label || f.key)}${f.required ? ' *' : ''}`;
        const at = `data-input="${esc(f.key)}" aria-label="${lab}" title="${esc(f.help || '')}"`;
        if (f.type === 'enum') return `<select class="inp" ${at}>${option('', `${f.label || f.key}…`, cur == null)}${(f.options || []).map((o) => option(o.value, o.label || o.value, o.value === cur)).join('')}</select>`;
        if (f.type === 'boolean') return `<label class="rb-check"><input type="checkbox" ${at}${cur ? ' checked' : ''}>${lab}</label>`;
        return `<input class="inp rb-wide" ${f.type === 'number' ? 'type="number"' : ''} ${at} value="${esc(cur ?? '')}" placeholder="${lab}${f.type === 'number' ? '' : ': {id} {title} {event.field}'}" spellcheck="false">`;
      };
      rest = `<select class="inp" name="plugin" aria-label="Plugin" data-redraw-run>${option('', 'a plugin…', !p)}${S.plugins.map((x) => option(x.name, x.label || x.name, x.name === a.plugin)).join('')}</select>
        <select class="inp" name="action" aria-label="Plugin action" data-redraw-run>${option('', 'an action…', !act)}${(p?.actions || []).map((x) => option(x.id, x.label || x.id, x.id === a.action)).join('')}</select>
        ${(act?.inputs || []).map(input).join('')}`;
    }
    if (a.do === 'merge') rest = `<input class="inp" name="branch" value="${esc(a.branch || 'integration/next')}" placeholder="branch" spellcheck="false" aria-label="Branch"><label class="rb-check"><input type="checkbox" name="push"${a.push === false ? '' : ' checked'}>push to origin</label>`;
    if (a.do === 'extract') {
      const how = a.how || 'pattern';
      const into = a.into || 'property';
      rest = `<select class="inp" name="from" aria-label="Read">${[['all', 'from the whole ticket'], ['title', 'from the title'], ['description', 'from the description'], ['comments', 'from the comments']].map(([k, l]) => option(k, l, k === (a.from || 'all'))).join('')}</select>
        <select class="inp" name="how" aria-label="How" data-redraw>${option('pattern', 'with a pattern', how === 'pattern')}${option('ai', 'by asking AI', how === 'ai')}</select>
        ${how === 'ai' ? `<input class="inp rb-wide" name="ask" maxlength="500" value="${esc(a.ask || '')}" placeholder="Question, e.g. Which services does it touch?">` : `<input class="inp rb-wide" name="pattern" maxlength="300" value="${esc(a.pattern || '')}" placeholder="Regular expression; its first group is kept, e.g. Services?: (.+)" spellcheck="false">`}
        <select class="inp" name="into" aria-label="Into" data-redraw>${[['property', 'into a property'], ['field', 'into a field'], ['comment', 'as a comment']].map(([k, l]) => option(k, l, k === into)).join('')}</select>
        ${into === 'comment' ? '' : `<input class="inp" name="key" value="${esc(a.key || '')}" placeholder="${into === 'field' ? 'field' : 'property'}" spellcheck="false">`}`;
    }
    if (a.do === 'look' || a.do === 'style') {
      const l = a.look || {};
      const tone = (name, cur, none) => `<select class="inp" name="${name}" aria-label="${name}">${option('', none, !cur)}${v.tones.map((t) => option(t, t, t === cur)).join('')}</select>`;
      rest = `${tone('outline', l.outline, 'no outline')}${tone('tint', l.tint, 'no tint')}<input class="inp" name="badge" maxlength="24" value="${esc(l.badge?.text || '')}" placeholder="badge text"><input class="inp" name="ribbon" maxlength="16" value="${esc(l.ribbon || '')}" placeholder="ribbon">
        <select class="inp" name="shape" aria-label="mark">${option('', 'no mark', !l.mark)}${v.shapes.map((x) => option(x, `${x} mark`, x === l.mark?.shape)).join('')}</select>${tone('markTone', l.mark?.tone, 'mark colour')}`;
    }
    return `<div class="rb-act"><span class="rb-n"></span><span class="rb-aic">${icon(ACTION_ICON[a.do] || 'zap', 'sm')}</span>
      <div class="rb-afields"><select class="inp" data-do aria-label="Action">${Object.entries(v.actions).filter(([k, d]) => (!d.nativeOnly || k === a.do) && !(stallOnly && d.ticket) && (k === 'look') === (a.do === 'look')).map(([k, d]) => option(k, actLabel(d.label), k === a.do)).join('')}</select>${rest}</div>
      <button type="button" class="icon-x" data-act-del title="Remove" aria-label="Remove this action">${icon('x', 'sm')}</button></div>`;
  }
  /* ─── the log ─── */
  function drawLog(pane) {
    // one row a firing: what fired and on what, what its actions did (in words), when
    const said = (x) => (!x.ok ? `${x.do.replace('_', ' ')} failed: ${x.error}` : x.woke ? `woke ${nameOf(x.woke)}` : x.column ? `moved to ${colName(x.column)}` : 'assignee' in x ? (x.assignee ? `assigned ${nameOf(x.assignee)}` : 'unassigned') : x.landing ? `merging: ${x.landing}`
      : x.branch ? `merged into ${x.branch}${x.created ? ' (new)' : ''}${x.pushed ? ', pushed' : x.pushError ? `, not pushed: ${x.pushError}` : ''}`
      : 'found' in x ? (x.found === false ? 'found nothing to extract' : `extracted "${x.found}"`) : x.do.replace('_', ' '));
    pane.innerHTML = S.log.length ? `<div class="ent-list one-line"><div class="ent-lh">What the rules did <span class="cnt">${S.log.length}</span></div>${S.log.map((l) => {
      const bad = (l.results || []).filter((x) => !x.ok).length;
      const [tone, ic] = l.held ? ['warn', 'clock'] : bad ? ['danger', 'x'] : ['ok', 'check'];
      const did = l.held ? esc(l.held) : l.note ? esc(l.note) : (l.results || []).map((x) => esc(said(x))).join(' · ');
      return `<article class="ent">
        <span class="ent-lead ent-tile" data-tone="${tone}">${icon(ic)}</span>
        <div class="ent-body"><h3 class="ent-title"><span class="ent-name">${esc(l.name)}</span>${l.item ? ` <code class="ent-code">${esc(l.item)}</code>` : ''}</h3><div class="ent-sub">${did}</div></div>
        <div class="ent-side"><span class="ent-col when" title="${esc(new Date(l.at).toLocaleString())}">${esc(ago(l.at))}</span></div></article>`;
    }).join('')}</div>`
      : `<div class="ent-empty">${icon('activity')}<h3>Nothing yet</h3><p>Each time a rule fires, it shows here with what each action did.</p></div>`;
  }

  // The board asked before saving a rule that acts on tickets now: how many, the first few, three ways out.
  // Resolves 'act', 'off' or null (Cancel, Esc). Focus starts on Cancel, as the gate confirm does.
  function confirmAct({ count, items = [] }) {
    const root = el(`<div class="scrim gate-scrim"><div class="gate-dlg" role="alertdialog" aria-modal="true" aria-labelledby="ca-t">
      <div class="gate-confirm ca"><div id="ca-t"><b>Saving this rule acts on ${count} ticket${count === 1 ? '' : 's'} now</b>
        <ul class="ca-list">${items.slice(0, 5).map((i) => `<li><code class="ent-code">${esc(i.id)}</code> ${esc(i.title)}</li>`).join('')}${count > 5 ? `<li class="muted">and ${count - 5} more: Cancel to see them all in the preview</li>` : ''}</ul>
        <div class="gc-sub">Save it switched off to start it later: it then runs under the hourly cap.</div></div>
        <div class="gc-btns"><button class="btn ghost sm" data-ca="">Cancel</button><button class="btn sm" data-ca="off">Save switched off</button><button class="btn primary sm" data-ca="act">Save and act on ${count}</button></div></div></div></div>`);
    document.body.append(root);
    return new Promise((resolve) => {
      const done = (v) => { root.remove(); resolve(v); };
      root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } }, true);
      $$('[data-ca]', root).forEach((b) => { b.onclick = () => done(b.dataset.ca || null); });
      requestAnimationFrame(() => $('[data-ca=""]', root).focus());
    });
  }

  // Live: the log grows as rules fire; editors are never redrawn under the human's hands
  let pending = null;
  function onEvent(ev) {
    if (!isOpen() || S.view || !(ev.type === 'rule.ran' || ev.type === 'rule.held' || (ev.type === 'board.updated' && ev.changes?.rules))) return;
    clearTimeout(pending);
    pending = setTimeout(() => load().then(render, () => {}), 300);
  }

  return { open, onEvent };
}
