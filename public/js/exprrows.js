// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* The rule builder's rows for the expression language (INT-496): field · operator · value, joined by AND or OR with
   one level of groups, written as the same text the If box holds and read back from it. Pure, so the page and its
   test share it. A rule's schema is expr.js's: { vars: { T: <descriptor>, C: <descriptor> } }. */
import { compile, tokenize } from './expr.js';

// kind → its operators: [key, label]
export const OPS = {
  choice: [['is', 'is'], ['not', 'is not'], ['oneof', 'is one of'], ['noneof', 'is none of'], ['set', 'is set'], ['empty', 'is empty']],
  person: [['is', 'is'], ['not', 'is not'], ['set', 'is someone'], ['empty', 'is nobody']],
  text: [['is', 'is'], ['not', 'is not'], ['has', 'contains'], ['set', 'is set'], ['empty', 'is empty']],
  number: [['>=', 'is at least'], ['<=', 'is at most'], ['=', 'is exactly'], ['>', 'is more than'], ['<', 'is less than']],
  bool: [['yes', 'is true'], ['no', 'is false']],
  list: [['has', 'has'], ['lacks', 'does not have'], ['set', 'is not empty'], ['empty', 'is empty']],
};
export const isMulti = (op) => op === 'oneof' || op === 'noneof';
export const noValue = (op) => ['set', 'empty', 'yes', 'no'].includes(op);

// Every path a rule may ask about, as rows: [{ k: 'T.fields.risk', label, group, kind, options }]. Open records have no
// known keys, so a rule writes those in the text.
export function fieldsOf(schema) {
  const out = [];
  const walk = (d, path, group, depth) => {
    if (d.kind === 'object') { if (depth < 3) for (const [k, f] of Object.entries(d.fields || {})) walk(f, `${path}.${k}`, group, depth + 1); return; }
    if (!OPS[d.kind]) return;
    const options = d.kind === 'choice' ? d.options : d.kind === 'list' && d.of?.kind === 'choice' ? d.of.options : null;
    out.push({ k: path, label: path.split('.').slice(1).join(' › '), hint: d.hint, group, kind: d.kind, options: options?.map(String) });
  };
  for (const [name, d] of Object.entries(schema?.vars || {})) walk(d, name, d.hint || name, 0);
  return out;
}

const lit = (v) => (typeof v === 'number' ? String(v) : JSON.stringify(String(v)));
const vals = (r) => [].concat(r.value ?? []).map((v) => String(v).trim()).filter(Boolean);
const NUM = { '>=': '>=', '<=': '<=', '>': '>', '<': '<', '=': '==' };
// one row → its text, or null while it isn't finished
export function rowText(r, fields) {
  const f = fields.find((x) => x.k === r.k);
  if (!f) return null;
  const v = vals(r).flatMap((s) => (isMulti(r.op) ? s.split('|').map((t) => t.trim()).filter(Boolean) : [s])), x = r.k;
  switch (r.op) {
    case 'yes': return x;
    case 'no': return `!${x}`;
    case 'set': return f.kind === 'bool' ? x : `!${x}.isEmpty()`;
    case 'empty': return `${x}.isEmpty()`;
    case 'is': return v.length ? `${x} == ${lit(v[0])}` : null;
    case 'not': return v.length ? `${x} != ${lit(v[0])}` : null;
    case 'has': return v.length ? `${x}.contains(${lit(v[0])})` : null;
    case 'lacks': return v.length ? `!${x}.contains(${lit(v[0])})` : null;
    case 'oneof': return v.length ? `${x} in [${v.map(lit).join(', ')}]` : null;
    case 'noneof': return v.length ? `!(${x} in [${v.map(lit).join(', ')}])` : null;
    default: return NUM[r.op] && v.length && Number.isFinite(Number(v[0])) ? `${x} ${NUM[r.op]} ${Number(v[0])}` : null;
  }
}
// the tree of rows back to text, or null while a row is unfinished. && binds tighter than ||, so a group of ands inside
// an or needs no brackets and a group of ors inside an and takes one pair.
export function treeText(c, fields) {
  const part = (it) => {
    if (!it.group) return rowText(it, fields);
    const ts = it.rows.map((r) => rowText(r, fields));
    if (!ts.length || ts.some((t) => !t)) return null;
    if (it.mode === c.mode || ts.length === 1) return ts.join(c.mode === 'any' ? ' || ' : ' && ');
    return c.mode === 'all' ? `(${ts.join(' || ')})` : ts.join(' && ');
  };
  const parts = c.items.map(part);
  return parts.some((p) => !p) ? null : parts.join(c.mode === 'any' ? ' || ' : ' && ');
}

// text → { mode, items } of rows and groups, or null when the rows can't hold it (a method they lack, a group in a group…)
export function parseRows(text, schema) {
  const src = String(text || '').trim();
  if (!src) return { mode: 'all', items: [] };
  const c = compile(src, schema);
  if (!c.ok) return null;
  const fields = fieldsOf(schema);
  const path = (n) => (n.k === 'var' ? n.name : n.k === 'field' ? (path(n.obj) ? `${path(n.obj)}.${n.name}` : null) : null);
  const field = (n) => { const p = path(n); return p && fields.find((f) => f.k === p); };
  const value = (n) => (n.k === 'lit' ? n.v : undefined);
  // one comparison, call or bare yes/no → a row, or null
  const term = (n, not) => {
    if (n.k === 'not') return not ? null : term(n.e, true);
    const f = field(n);
    if (f && f.kind === 'bool') return { k: f.k, op: not ? 'no' : 'yes' };
    if (n.k === 'call') {
      const o = field(n.obj);
      if (!o) return null;
      if (n.name === 'isEmpty') return { k: o.k, op: not ? 'set' : 'empty' };
      const a = value(n.args[0]);
      if (n.name === 'contains' && a !== undefined) return { k: o.k, op: o.kind === 'list' ? (not ? 'lacks' : 'has') : not ? null : 'has', value: String(a) };
      return null;
    }
    if (n.k === 'in') {
      const o = field(n.l);
      return o && n.r.k === 'list' && n.r.items.every((i) => i.k === 'lit') ? { k: o.k, op: not ? 'noneof' : 'oneof', value: n.r.items.map((i) => String(i.v)) } : null;
    }
    if (n.k === 'cmp' && !not) {
      const o = field(n.l), v = value(n.r);
      if (!o || v === undefined) return null;
      if (o.kind === 'bool') return null;
      if (o.kind === 'number') { const op = Object.keys(NUM).find((k) => NUM[k] === n.op); return typeof v === 'number' && op ? { k: o.k, op, value: String(v) } : null; }
      return n.op === '==' || n.op === '!=' ? { k: o.k, op: n.op === '==' ? 'is' : 'not', value: String(v) } : null;
    }
    return null;
  };
  const flat = (n, k) => (n.k === k ? [...flat(n.l, k), ...flat(n.r, k)] : [n]);
  const rows = (ns) => { const r = ns.map((n) => term(n)); return r.some((x) => !x) ? null : r; };
  const top = c.tree.k === 'or' ? 'or' : 'and', inner = top === 'or' ? 'and' : 'or';
  const items = [];
  for (const n of flat(c.tree, top)) {
    const parts = flat(n, inner);
    if (parts.length === 1) { const r = rows(parts); if (!r) return null; items.push(r[0]); continue; }
    const r = rows(parts);
    if (!r) return null;
    items.push({ group: true, mode: inner === 'or' ? 'any' : 'all', rows: r });
  }
  return { mode: top === 'or' ? 'any' : 'all', items };
}

// Rename a part (T → ticket) in the text: only the names themselves, never a word after a dot or inside a quote.
export function renameIn(text, from, to) {
  let out = '', at = 0;
  const toks = tokenize(text, true);
  toks.forEach((t, i) => {
    if (t.t !== 'id' || t.v !== from || toks[i - 1]?.v === '.') return;
    out += text.slice(at, t.pos) + to; at = t.end;
  });
  return out + text.slice(at);
}
