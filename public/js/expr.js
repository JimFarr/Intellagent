/* The rule expression language (INT-479): `C.text.contains("?") && T.priority in ["High", "Critical"]`.
   Pure and standalone, so the page (suggestions as you type) and the server (judging a rule) share one module.
   Nothing is ever run as code: a tokenizer, a parser that also checks types, and an evaluator over the tree.

   A schema describes what a rule may name:
     { vars: { T: <descriptor>, C: <descriptor> } }
   A descriptor is { kind, hint?, ... } with kind one of
     text number bool any person
     choice  (text with options: ["High", ...])
     list    (of: <descriptor>)
     object  (fields: { name: <descriptor> }, or open: true for any key)
   The data a rule is judged over is { T: {...}, C: {...} }; a name that has no data is null. */

const CMP = ['==', '!=', '<=', '>=', '<', '>'];
const OPS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '(', ')', '[', ']', ',', '.'];
const ANY = { kind: 'any' };
const BOOL = { kind: 'bool' };
const NUM = { kind: 'number' };
const TEXT = { kind: 'text' };
const TEXTISH = ['text', 'choice', 'person'];

const TEXT_METHODS = {
  contains: { args: 1, hint: 'the text has this in it' },
  startsWith: { args: 1, hint: 'the text begins with this' },
  endsWith: { args: 1, hint: 'the text ends with this' },
  matches: { args: 1, hint: 'the text fits this pattern, e.g. matches("^fix")' },
  isEmpty: { args: 0, hint: 'there is no text' },
};
const LIST_METHODS = {
  contains: { args: 1, hint: 'the list has this item' },
  isEmpty: { args: 0, hint: 'the list has nothing in it' },
};
const OP_HINTS = {
  '==': 'is', '!=': 'is not', '<': 'is less than', '<=': 'is at most', '>': 'is more than', '>=': 'is at least',
  in: 'is one of a list: in ["a", "b"]', '&&': 'and', '||': 'or',
};

export class ExprError extends Error {
  constructor(message, pos, end, didYouMean) {
    super(didYouMean ? `${message} — did you mean "${didYouMean}"?` : message);
    Object.assign(this, { pos, end, didYouMean: didYouMean || null });
  }
}
const fail = (m, pos, end, dym) => { throw new ExprError(m, pos, end ?? pos + 1, dym); };

// Edit distance, for "did you mean".
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}
export function nearest(word, choices) {
  const w = String(word).toLowerCase();
  let best = null, bestD = Math.max(2, Math.floor(w.length / 3)) + 1;
  for (const c of choices) {
    const l = String(c).toLowerCase();
    const d = l.startsWith(w) && w ? 0 : distance(w, l);
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}

/* ── tokenizer ─────────────────────────────────────────────────────────────────────────────────────────────── */
// Lenient (for suggestions) keeps an unfinished text as an open token and skips what it can't read.
export function tokenize(src, lenient = false) {
  const out = [];
  const sticky = (re, i) => { re.lastIndex = i; return re.exec(src); };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    let m;
    if ((m = sticky(/\d+(?:\.\d+)?/y, i))) { out.push({ t: 'num', v: Number(m[0]), pos: i, end: i + m[0].length }); i += m[0].length; continue; }
    if ((m = sticky(/[A-Za-z_$][\w$]*/y, i))) { out.push({ t: 'id', v: m[0], pos: i, end: i + m[0].length }); i += m[0].length; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, v = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { j++; v += { n: '\n', t: '\t' }[src[j]] ?? src[j]; } else v += src[j];
        j++;
      }
      if (j >= src.length) {
        if (!lenient) fail('this text has no closing quote', i, src.length);
        out.push({ t: 'str', v, pos: i, end: src.length, open: true }); break;
      }
      out.push({ t: 'str', v, pos: i, end: j + 1 }); i = j + 1; continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) { out.push({ t: 'op', v: op, pos: i, end: i + op.length }); i += op.length; continue; }
    if (c === '=' || c === '&' || c === '|') {
      if (!lenient) fail(`"${c}" on its own is not an operator`, i, i + 1, { '=': '==', '&': '&&', '|': '||' }[c]);
      out.push({ t: 'op', v: c, pos: i, end: i + 1 }); i++; continue;
    }
    if (!lenient) fail(`unexpected "${c}"`, i, i + 1);
    i++;
  }
  return out;
}

/* ── patterns ──────────────────────────────────────────────────────────────────────────────────────────────── */
// Why a pattern is refused, or null. A group that repeats something repeating (a+)+ or an alternation (a|a)*
// can take forever on a long text, and so can a backreference: none of them is allowed. Patterns are short.
export function unsafePattern(src) {
  if (src.length > 120) return 'the pattern is longer than 120 characters';
  if (/\\[1-9k]/.test(src)) return 'a pattern may not refer back to a group (\\1)';
  const stack = [];
  let inClass = false, open = 0;
  const quant = (s, i) => s[i] === '*' || s[i] === '+' || (s[i] === '{' && /^\{\d*,\d*\}|^\{\d{2,}\}|^\{[2-9]\}/.test(s.slice(i)));
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if ((c === '*' || c === '+' || (c === '{' && /^\{\d*,(?:\d{2,})?\}/.test(src.slice(i)))) && ++open > 2) return 'more than two wide repeats (* + {n,} or {n,10} and up) can be slow on a long text (like .*.*.*x)';
    if (c === '[') inClass = true;
    else if (c === '(') stack.push({ q: false, alt: false });
    else if (c === '|' && stack.length) stack[stack.length - 1].alt = true;
    else if (c === ')') {
      const g = stack.pop();
      if (g && quant(src, i + 1) && (g.q || g.alt)) return 'a group that repeats something already repeating can be very slow (like (a+)+)';
      if (g?.q && stack.length) stack[stack.length - 1].q = true;
    } else if (quant(src, i) && stack.length) stack[stack.length - 1].q = true;
  }
  return null;
}

/* ── parser (with types) ───────────────────────────────────────────────────────────────────────────────────── */
const kindName = (t) => ({ text: 'text', number: 'a number', bool: 'true/false', choice: 'a choice', person: 'a person', list: 'a list', object: 'a record', any: 'any value' }[t.kind]);
const textish = (t) => TEXTISH.includes(t.kind);
// Two kinds can be compared when either is unknown or both are alike (text, choices and people all compare as text).
const alike = (a, b) => a.kind === 'any' || b.kind === 'any' || (textish(a) && textish(b)) || (a.kind === b.kind && (a.kind === 'number' || a.kind === 'bool'));

export function compile(text, schema) {
  try {
    const vars = schema?.vars || {};
    const toks = tokenize(text);
    toks.push({ t: 'end', pos: text.length, end: text.length });
    let p = 0;
    const peek = () => toks[p];
    const isOp = (v) => peek().t === 'op' && peek().v === v;
    const isWord = (v) => peek().t === 'id' && peek().v === v;
    const expect = (v) => {
      if (!isOp(v)) fail(peek().t === 'end' ? `the expression ends too soon: expected "${v}"` : `expected "${v}" here`, peek().pos, peek().end);
      return toks[p++];
    };
    const yesNo = (n, what) => {
      if (n.type.kind !== 'bool' && n.type.kind !== 'object' && n.type.kind !== 'any') fail(`${what} needs a yes/no, but this is ${kindName(n.type)}`, n.pos, n.end);
      return n;
    };
    // a text written where a choice goes must be one of its options
    const choiceOk = (desc, n) => {
      if (desc?.kind !== 'choice' || !desc.options || n.k !== 'lit' || typeof n.v !== 'string') return;
      if (!desc.options.some((o) => String(o).toLowerCase() === n.v.toLowerCase())) {
        fail(`"${n.v}" is not one of: ${desc.options.join(', ')}`, n.pos, n.end, nearest(n.v, desc.options));
      }
    };

    const parseOr = () => {
      let l = parseAnd();
      while (isOp('||')) { yesNo(l, 'the left of ||'); next(); const r = yesNo(parseAnd(), 'the right of ||'); l = { k: 'or', l, r, pos: l.pos, end: r.end, type: BOOL }; }
      return l;
    };
    const next = () => toks[p++];
    const parseAnd = () => {
      let l = parseNot();
      while (isOp('&&')) { yesNo(l, 'the left of &&'); next(); const r = yesNo(parseNot(), 'the right of &&'); l = { k: 'and', l, r, pos: l.pos, end: r.end, type: BOOL }; }
      return l;
    };
    const parseNot = () => {
      if (!isOp('!')) return parseCmp();
      const t = next(); const e = yesNo(parseNot(), '!');
      return { k: 'not', e, pos: t.pos, end: e.end, type: BOOL };
    };
    const parseCmp = () => {
      const l = parsePostfix();
      if (peek().t === 'op' && CMP.includes(peek().v)) {
        const op = next().v; const r = parsePostfix();
        for (const n of [l, r]) if (n.type.kind === 'list' || n.type.kind === 'object') fail(`${kindName(n.type)} cannot be compared with ${op}`, n.pos, n.end);
        if (!alike(l.type, r.type)) fail(`cannot compare ${kindName(l.type)} with ${kindName(r.type)}`, l.pos, r.end);
        if (op !== '==' && op !== '!=' && (l.type.kind === 'bool' || r.type.kind === 'bool')) fail(`${op} needs numbers or text, not true/false`, l.pos, r.end);
        choiceOk(l.type, r); choiceOk(r.type, l);
        return { k: 'cmp', op, l, r, pos: l.pos, end: r.end, type: BOOL };
      }
      if (isWord('in')) {
        next(); const r = parsePostfix();
        if (r.type.kind !== 'list' && r.type.kind !== 'any') fail('"in" needs a list: ["a", "b"] or a list field', r.pos, r.end);
        if (l.type.kind === 'list' || l.type.kind === 'object') fail(`${kindName(l.type)} cannot be looked up with "in"`, l.pos, l.end);
        if (r.k === 'list') for (const it of r.items) { if (!alike(l.type, it.type)) fail(`cannot compare ${kindName(l.type)} with ${kindName(it.type)}`, it.pos, it.end); choiceOk(l.type, it); }
        else if (r.type.of) { if (!alike(l.type, r.type.of)) fail(`the list holds ${kindName(r.type.of)}, not ${kindName(l.type)}`, l.pos, r.end); choiceOk(r.type.of, l); }
        return { k: 'in', l, r, pos: l.pos, end: r.end, type: BOOL };
      }
      return l;
    };
    const parsePostfix = () => {
      let n = parsePrimary();
      while (isOp('.')) {
        const dot = next(); const name = peek();
        if (name.t !== 'id') fail('expected a name after "."', dot.pos, dot.end);
        next(); n = member(n, name);
      }
      return n;
    };
    const member = (obj, name) => {
      const t = obj.type, tbl = t.kind === 'list' ? LIST_METHODS : textish(t) ? TEXT_METHODS : t.kind === 'any' ? { ...TEXT_METHODS, ...LIST_METHODS } : null;
      if (isOp('(')) {
        const m = tbl?.[name.v];
        if (!m) fail(`${kindName(t)} has no method "${name.v}"`, name.pos, name.end, tbl ? nearest(name.v, Object.keys(tbl)) : null);
        next(); const args = [];
        while (!isOp(')')) {
          if (args.length) expect(',');
          args.push(parseOr());
        }
        const close = expect(')');
        if (args.length !== m.args) fail(`${name.v} takes ${m.args === 0 ? 'no arguments' : 'one argument'}, not ${args.length}`, name.pos, close.end);
        const [a] = args;
        if (a && t.kind === 'list') { if (t.of && !alike(t.of, a.type)) fail(`the list holds ${kindName(t.of)}, not ${kindName(a.type)}`, a.pos, a.end); choiceOk(t.of, a); }
        else if (a && !textish(a.type) && a.type.kind !== 'any') fail(`${name.v} needs text, not ${kindName(a.type)}`, a.pos, a.end);
        if (name.v === 'matches' && t.kind !== 'list') {
          if (a.k !== 'lit' || typeof a.v !== 'string') fail('matches needs the pattern written in quotes: matches("^fix")', a.pos, a.end);
          const bad = unsafePattern(a.v);
          if (bad) fail(`pattern refused: ${bad}`, a.pos, a.end);
          try { new RegExp(a.v, 'i'); } catch { fail('this is not a valid pattern', a.pos, a.end); }
        }
        return { k: 'call', obj, name: name.v, args, pos: obj.pos, end: close.end, type: BOOL };
      }
      if (t.kind === 'list' && name.v === 'count') return { k: 'count', obj, pos: obj.pos, end: name.end, type: NUM };
      if (t.kind === 'any') return { k: 'field', obj, name: name.v, pos: obj.pos, end: name.end, type: ANY };
      if (t.kind === 'object') {
        const own = t.fields && Object.hasOwn(t.fields, name.v) ? t.fields[name.v] : t.open ? ANY : null;
        if (!own) fail(`no field "${name.v}" on ${text.slice(obj.pos, obj.end)}`, name.pos, name.end, nearest(name.v, Object.keys(t.fields || {})));
        return { k: 'field', obj, name: name.v, pos: obj.pos, end: name.end, type: own };
      }
      const known = tbl && (Object.keys(tbl).includes(name.v) ? ` — "${name.v}" is a method: write ${name.v}(…)` : '');
      fail(`${kindName(t)} has no field "${name.v}"${known || ''}`, name.pos, name.end, t.kind === 'list' ? nearest(name.v, ['count']) : null);
    };
    const parsePrimary = () => {
      const t = peek();
      if (t.t === 'num') { next(); return { k: 'lit', v: t.v, pos: t.pos, end: t.end, type: NUM }; }
      if (t.t === 'str') { next(); return { k: 'lit', v: t.v, pos: t.pos, end: t.end, type: TEXT }; }
      if (t.t === 'id') {
        if (t.v === 'true' || t.v === 'false') { next(); return { k: 'lit', v: t.v === 'true', pos: t.pos, end: t.end, type: BOOL }; }
        if (Object.hasOwn(vars, t.v)) { next(); return { k: 'var', name: t.v, pos: t.pos, end: t.end, type: vars[t.v] }; }
        fail(`unknown name "${t.v}"`, t.pos, t.end, nearest(t.v, [...Object.keys(vars), 'true', 'false']));
      }
      if (isOp('(')) { next(); const e = parseOr(); expect(')'); return e; }
      if (isOp('[')) {
        const open = next(); const items = [];
        while (!isOp(']')) { if (items.length) expect(','); items.push(parsePostfix()); }
        const close = expect(']');
        return { k: 'list', items, pos: open.pos, end: close.end, type: { kind: 'list', of: items[0]?.type } };
      }
      if (t.t === 'end') fail('the expression ends too soon: expected a value', t.pos, t.end);
      fail(`expected a value, found "${text.slice(t.pos, t.end)}"`, t.pos, t.end);
    };

    if (!toks.length || toks[0].t === 'end') fail('the expression is empty', 0, 0);
    const tree = parseOr();
    if (peek().t !== 'end') fail(`unexpected "${text.slice(peek().pos, peek().end)}" — join conditions with && or ||`, peek().pos, peek().end);
    yesNo(tree, 'a rule');
    return { ok: true, tree };
  } catch (e) {
    if (!(e instanceof ExprError)) throw e;
    return { ok: false, error: { message: e.message, pos: e.pos, end: e.end, didYouMean: e.didYouMean } };
  }
}

/* ── evaluator ─────────────────────────────────────────────────────────────────────────────────────────────── */
// Text compares without regard to case, a person by name, nothing as empty text.
const norm = (v) => (v == null ? '' : typeof v === 'string' ? v.toLowerCase() : typeof v === 'object' && !Array.isArray(v) && 'name' in v ? String(v.name).toLowerCase() : v);
const same = (a, b) => norm(a) === norm(b);
const truthy = (v) => v != null && v !== false;
const patterns = new Map();
const MAX_TEXT = 5000;

export function evaluate(tree, data) {
  const ev = (n) => {
    switch (n.k) {
      case 'lit': return n.v;
      case 'list': return n.items.map(ev);
      case 'var': return data && Object.hasOwn(data, n.name) ? data[n.name] ?? null : null;
      case 'field': { const o = ev(n.obj); return o && typeof o === 'object' && Object.hasOwn(o, n.name) ? o[n.name] ?? null : null; }
      case 'count': { const o = ev(n.obj); return Array.isArray(o) ? o.length : 0; }
      case 'not': return !truthy(ev(n.e));
      case 'and': return truthy(ev(n.l)) && truthy(ev(n.r));
      case 'or': return truthy(ev(n.l)) || truthy(ev(n.r));
      case 'in': { const r = ev(n.r), l = ev(n.l); return Array.isArray(r) && r.some((x) => same(l, x)); }
      case 'cmp': {
        const a = norm(ev(n.l)), b = norm(ev(n.r));
        if (n.op === '==') return a === b;
        if (n.op === '!=') return a !== b;
        if (typeof a !== typeof b || a === '' || b === '') return false;
        return { '<': a < b, '<=': a <= b, '>': a > b, '>=': a >= b }[n.op];
      }
      case 'call': {
        const o = ev(n.obj), a = n.args.length ? ev(n.args[0]) : null;
        if (Array.isArray(o) || (o == null && n.obj.type.kind === 'list')) {
          const list = o || [];
          return n.name === 'isEmpty' ? list.length === 0 : list.some((x) => same(x, a));
        }
        const s = String(norm(o)).slice(0, MAX_TEXT), q = String(norm(a));
        switch (n.name) {
          case 'isEmpty': return s === '';
          case 'contains': return s.includes(q);
          case 'startsWith': return s.startsWith(q);
          case 'endsWith': return s.endsWith(q);
          case 'matches': {
            const src = String(a);
            if (unsafePattern(src)) return false;
            if (!patterns.has(src)) patterns.set(src, new RegExp(src, 'i'));
            return patterns.get(src).test(s);
          }
        }
        return false;
      }
    }
    return null;
  };
  return truthy(ev(tree));
}

// Compile and judge in one go: { ok: true, value } or { ok: false, error }.
export function test(text, schema, data) {
  const c = compile(text, schema);
  return c.ok ? { ok: true, value: evaluate(c.tree, data) } : c;
}

/* ── suggestions ───────────────────────────────────────────────────────────────────────────────────────────── */
function resolve(schema, names) {
  let d = schema?.vars?.[names[0]];
  for (const n of names.slice(1)) {
    if (d?.kind !== 'object') return null;
    d = d.fields && Object.hasOwn(d.fields, n) ? d.fields[n] : d.open ? ANY : null;
  }
  return d || null;
}
// The names of the dotted path that ends at token i (T . fields . risk), or null.
function chainEndingAt(toks, i) {
  if (toks[i]?.t !== 'id') return null;
  const names = [toks[i].v];
  while (toks[i - 1]?.v === '.' && toks[i - 2]?.t === 'id') { names.unshift(toks[i - 2].v); i -= 2; }
  return names;
}
const isOperand = (t) => t && (t.t === 'num' || t.t === 'str' || (t.t === 'id' && t.v !== 'in') || (t.t === 'op' && (t.v === ')' || t.v === ']')));
// The innermost bracket still open at the end of the tokens: { i, v }, or null.
function openBracket(toks) {
  let depth = 0;
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    if (t.t !== 'op') continue;
    if (t.v === ')' || t.v === ']') depth++;
    else if ((t.v === '(' || t.v === '[') && depth-- === 0) return { i, v: t.v };
  }
  return null;
}
// Where the clause being written starts: after the last &&, || , comma or open bracket at this depth.
function clauseStart(toks) {
  let depth = 0;
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    if (t.t !== 'op') continue;
    if (t.v === ')' || t.v === ']') depth++;
    else if (t.v === '(' || t.v === '[') { if (depth-- === 0) return i + 1; }
    else if (depth === 0 && (t.v === '&&' || t.v === '||' || t.v === ',')) return i + 1;
  }
  return 0;
}

export function suggest(text, caret, schema) {
  const head = text.slice(0, caret);
  const toks = tokenize(head, true);
  let from = caret, to = caret, prefix = '', inText = false;
  const last = toks[toks.length - 1];
  if (last?.t === 'str' && last.open) {
    from = last.pos; prefix = last.v; inText = true; toks.pop();
    if (text[caret] === head[last.pos]) to = caret + 1; // the closing quote already there
  } else if (last?.end === caret && (last.t === 'id' || (last.t === 'op' && /^[=!<>&|]+$/.test(last.v) && isOperand(toks[toks.length - 2])))) {
    from = last.pos; prefix = last.v; toks.pop();
  }
  const prev = toks[toks.length - 1];
  const out = [];
  const add = (label, insert, kind, hint) => out.push({ label, insert, kind, hint: hint || '' });
  const names = () => {
    for (const [k, d] of Object.entries(schema?.vars || {})) add(k, k, 'name', d.hint);
    add('true', 'true', 'value', ''); add('false', 'false', 'value', ''); add('!', '!', 'operator', 'not');
    add('(', '(', 'operator', 'a group');
  };
  const values = (d) => {
    if (d?.kind === 'choice') for (const o of d.options || []) add(String(o), JSON.stringify(String(o)), 'value', d.hint);
    else if (d?.kind === 'bool') { add('true', 'true', 'value'); add('false', 'false', 'value'); }
  };
  const methodsOf = (d) => {
    const tbl = d.kind === 'list' ? LIST_METHODS : textish(d) ? TEXT_METHODS : null;
    if (d.kind === 'list') add('count', 'count', 'field', 'how many items');
    for (const [m, s] of Object.entries(tbl || {})) add(m, s.args ? `${m}(` : `${m}()`, 'method', s.hint);
  };
  // the type a value should have here: after a comparison, inside in [ … ], inside contains( … )
  const expected = () => {
    const ob = openBracket(toks);
    if (prev?.t === 'op' && CMP.includes(prev.v)) return resolve(schema, chainEndingAt(toks, toks.length - 2) || []);
    if (ob && (prev === toks[ob.i] || prev?.v === ',')) {
      if (ob.v === '[' && toks[ob.i - 1]?.v === 'in') return resolve(schema, chainEndingAt(toks, ob.i - 2) || []);
      if (ob.v === '(' && toks[ob.i - 1]?.t === 'id' && toks[ob.i - 2]?.v === '.') {
        const recv = resolve(schema, chainEndingAt(toks, ob.i - 3) || []);
        return recv?.kind === 'list' ? recv.of : null;
      }
    }
    return null;
  };

  if (inText) values(expected());
  else if (prev?.v === '.' && prev.t === 'op') {
    const d = resolve(schema, chainEndingAt(toks, toks.length - 2) || []);
    if (d?.kind === 'object') for (const [k, f] of Object.entries(d.fields || {})) add(k, k, 'field', f.hint);
    else if (d) methodsOf(d);
  } else if (isOperand(prev)) {
    const ob = openBracket(toks);
    if (ob?.v === '[') { add(',', ',', 'operator'); add(']', ']', 'operator', 'end of the list'); }
    else {
      const clause = toks.slice(clauseStart(toks));
      const compared = clause.some((t) => (t.t === 'op' && CMP.includes(t.v)) || (t.t === 'id' && t.v === 'in'));
      const d = prev.t === 'id' ? resolve(schema, chainEndingAt(toks, toks.length - 1) || []) : prev.t === 'num' ? NUM : prev.t === 'str' ? TEXT : BOOL;
      const kind = d?.kind;
      if (compared || kind === 'bool' || kind === 'object') { add('&&', '&&', 'operator', OP_HINTS['&&']); add('||', '||', 'operator', OP_HINTS['||']); }
      else if (kind === 'list') { /* a list is used through its methods */ }
      else {
        const ops = kind === 'number' ? CMP : kind === 'any' ? CMP : ['==', '!='];
        for (const o of ops) add(o, o, 'operator', OP_HINTS[o]);
        add('in', 'in', 'operator', OP_HINTS.in);
      }
      if (ob?.v === '(') add(')', ')', 'operator', toks[ob.i - 1]?.t === 'id' && toks[ob.i - 2]?.v === '.' ? 'end of the arguments' : 'end of the group');
      else if (kind === 'object' || kind === 'bool') { /* already added */ }
    }
  } else {
    const d = expected();
    if (d && (d.kind === 'choice' || d.kind === 'bool')) values(d);
    if (prev?.t === 'id' && prev.v === 'in') add('[', '[', 'operator', 'start a list');
    else names();
  }

  const w = prefix.toLowerCase();
  const starts = out.filter((s) => s.label.toLowerCase().startsWith(w));
  const items = starts.length || !w ? starts : out.filter((s) => s.label.toLowerCase().includes(w));
  return { from, to, items };
}
