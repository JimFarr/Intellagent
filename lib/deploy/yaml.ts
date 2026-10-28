'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* yaml: just enough YAML to read what a pipeline declares: its `parameters:`, its `resources: pipelines:` and an
   `extends: template:`. Block mappings and sequences, quoted and plain scalars, [flow, lists], | and > blocks,
   comments. Every scalar stays a string (or null for ~ / empty): we only offer names and values in pickers.
   Anything stranger (anchors, multi-line flow) reads as a string or is skipped; a pipeline we can't read
   still works, its parameters are then typed by hand. Ported from KM.Launchpad's AdoService (MIT). */

type Y = string | null | Y[] | { [k: string]: Y };
type Line = { indent: number; text: string };

function lines(src: string): Line[] {
  const out: Line[] = [];
  for (const raw of String(src).replace(/\r\n?/g, '\n').split('\n')) {
    if (/^(---|\.\.\.)\s*$/.test(raw)) { if (out.length) break; continue; } // first document only
    const text = stripComment(raw).replace(/\s+$/, '');
    if (!text.trim()) { out.push({ indent: -1, text: '' }); continue; } // kept for | blocks
    out.push({ indent: raw.length - raw.trimStart().length, text: text.trimStart() });
  }
  return out;
}
// A # starts a comment at the line start or after a space, outside quotes.
function stripComment(s: string): string {
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") { if (i === 0 || /[\s:[{,-]/.test(s[i - 1])) q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}
// "key: value" → [key, value]; the colon must end the text or be followed by a space, outside quotes and {{ }}.
function splitKey(t: string): [string, string] | null {
  let q = '', depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") { if (i === 0) q = c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ':' && depth <= 0 && (i === t.length - 1 || t[i + 1] === ' ')) return [unquote(t.slice(0, i).trim()) ?? '', t.slice(i + 1).trim()];
  }
  return null;
}
function unquote(s: string): string | null {
  if (s === '' || s === '~' || s === 'null') return null;
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) return s.slice(1, -1).replace(/\\(["\\/nt])/g, (_, c) => ({ n: '\n', t: '\t' } as Record<string, string>)[c] ?? c);
  return s;
}
function scalar(s: string): Y {
  const t = s.trim();
  if (t.startsWith('[') && t.endsWith(']')) return splitFlow(t.slice(1, -1)).map((x) => unquote(x));
  return unquote(t);
}
function splitFlow(s: string): string[] {
  const out: string[] = [];
  let q = '', depth = 0, cur = '';
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && !depth) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseYaml(src: string): Y {
  const ls = lines(src);
  let i = 0;
  const skipBlank = () => { while (i < ls.length && ls[i].indent < 0) i++; };
  // | and > blocks: the more-indented lines after the key, joined
  function blockText(parent: number, fold: boolean): string {
    const body: string[] = [];
    let ind = -1;
    while (i < ls.length && (ls[i].indent < 0 || ls[i].indent > parent)) {
      if (ls[i].indent >= 0 && ind < 0) ind = ls[i].indent;
      body.push(ls[i].indent < 0 ? '' : ' '.repeat(ls[i].indent - ind) + ls[i].text);
      i++;
    }
    while (body.length && !body[body.length - 1]) body.pop();
    return fold ? body.join(' ') : body.join('\n');
  }
  // the value after "key:" or "- ": inline, a block scalar, or a nested block indented past `parent`
  function valueAfter(rest: string, parent: number, seqOk: boolean): Y {
    if (rest === '|' || rest === '|-' || rest === '|+') return blockText(parent, false);
    if (rest === '>' || rest === '>-' || rest === '>+') return blockText(parent, true);
    if (rest !== '') return scalar(rest);
    skipBlank();
    if (i >= ls.length) return null;
    const n = ls[i];
    if (n.indent > parent || (seqOk && n.indent === parent && (n.text === '-' || n.text.startsWith('- ')))) return block(n.indent);
    return null;
  }
  function block(indent: number): Y {
    skipBlank();
    if (i >= ls.length) return null;
    const first = ls[i].text;
    if (first === '-' || first.startsWith('- ')) {
      const arr: Y[] = [];
      while (i < ls.length) {
        skipBlank();
        if (i >= ls.length || ls[i].indent !== indent || !(ls[i].text === '-' || ls[i].text.startsWith('- '))) break;
        const rest = ls[i].text === '-' ? '' : ls[i].text.slice(2).trim();
        const col = indent + 2 + (ls[i].text.slice(2).length - ls[i].text.slice(2).trimStart().length);
        i++;
        const kv = rest && !/^["'[{]/.test(rest) ? splitKey(rest) : null;
        if (kv) {
          // "- key: value" opens a mapping whose other keys sit at the column of the first
          i--;
          ls[i] = { indent: col, text: rest };
          arr.push(mapping(col));
        } else arr.push(valueAfter(rest, indent, false));
      }
      return arr;
    }
    return mapping(indent);
  }
  function mapping(indent: number): Y {
    const obj: { [k: string]: Y } = {};
    while (i < ls.length) {
      skipBlank();
      if (i >= ls.length || ls[i].indent !== indent) break;
      const kv = splitKey(ls[i].text);
      if (!kv) { i++; continue; } // not a key: something we don't read
      i++;
      obj[kv[0]] = valueAfter(kv[1], indent, true);
    }
    return obj;
  }
  skipBlank();
  return i < ls.length ? block(ls[i].indent) : null;
}

type Param = { name: string; kind: 'parameter'; type: 'string' | 'boolean' | 'number' | 'enum'; defaultValue: string | null; allowOverride: true; allowedValues: string[] | null };
type Resource = { alias: string; source: string | null; project: string | null };
const isMap = (v: Y): v is { [k: string]: Y } => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: Y | undefined): string | null => (typeof v === 'string' ? v : null);

// What a pipeline file declares: parameters (a list of { name, type, default, values }, or the old name: default
// mapping), pipeline resources, and the template it extends (to follow when it declares no parameters itself).
function pipelineDeclarations(text: string): { parameters: Param[]; resources: Resource[]; extendsTemplate: string | null } {
  let root: Y;
  try { root = parseYaml(text); } catch { root = null; }
  if (!isMap(root)) return { parameters: [], resources: [], extendsTemplate: null };
  const parameters: Param[] = [];
  const p = root.parameters;
  if (Array.isArray(p)) {
    for (const n of p) {
      if (!isMap(n) || !str(n.name)) continue;
      const values = Array.isArray(n.values) ? n.values.filter((x): x is string => typeof x === 'string') : null;
      const raw = str(n.type) || 'string';
      parameters.push({
        name: str(n.name) as string, kind: 'parameter',
        type: values?.length ? 'enum' : raw === 'boolean' ? 'boolean' : raw === 'number' ? 'number' : 'string',
        defaultValue: str(n.default), allowOverride: true, allowedValues: values?.length ? values : null,
      });
    }
  } else if (isMap(p)) {
    for (const [name, def] of Object.entries(p)) parameters.push({ name, kind: 'parameter', type: 'string', defaultValue: str(def), allowOverride: true, allowedValues: null });
  }
  const resources: Resource[] = [];
  const pl = isMap(root.resources) ? root.resources.pipelines : null;
  if (Array.isArray(pl)) for (const n of pl) if (isMap(n) && str(n.pipeline)) resources.push({ alias: str(n.pipeline) as string, source: str(n.source), project: str(n.project) });
  const ext = isMap(root.extends) ? str(root.extends.template) : null;
  return { parameters, resources, extendsTemplate: ext };
}

// A template path relative to the file that names it ("../t/deploy.yml" from "ci/app.yml" → "t/deploy.yml").
function resolveRepoPath(fromFile: string, templatePath: string): string {
  if (templatePath.startsWith('/')) return templatePath.replace(/^\/+/, '');
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const parts: string[] = [];
  for (const seg of (dir ? `${dir}/${templatePath}` : templatePath).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}

module.exports = { parseYaml, pipelineDeclarations, resolveRepoPath };
