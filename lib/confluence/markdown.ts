'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* Markdown and Confluence's storage format (XHTML with ac: macros), both ways, and replacing one section of a page.
   toStorage: what an agent or a rule writes, as a page body: headings, paragraphs, lists (nested by indent), code
   fences (the code macro), quotes, rules, tables, **bold**, *italic*, `code`, ~~struck~~ and [links](url).
   toMarkdown: a page for an agent to read. Best-effort: a macro other than code reads as [macro: name], so writing a
   whole page back would lose it; section replace touches only the part under one heading. */

type Node = { tag?: string; attrs?: Record<string, string>; kids?: Node[]; text?: string };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m));

// **bold**, *italic*, `code`, ~~struck~~, [text](url); code spans first, so nothing inside them is read as markup
function inline(s: string): string {
  const codes: string[] = [];
  let out = s.replace(/`([^`]+)`/g, (_m, c) => `\u0000${codes.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
  out = esc(out)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => (/^(https?:|mailto:|\/)/i.test(decode(u)) ? `<a href="${u}">${t}</a>` : t))
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)|(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, (_m, p1, a, p2, b) => `${p1 ?? p2}<em>${a ?? b}</em>`)
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)]);
}
const codeMacro = (lang: string, body: string) => `<ac:structured-macro ac:name="code">${lang ? `<ac:parameter ac:name="language">${esc(lang)}</ac:parameter>` : ''}<ac:plain-text-body><![CDATA[${body.replace(/]]>/g, ']]]]><![CDATA[>')}]]></ac:plain-text-body></ac:structured-macro>`;
const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function toStorage(md: string): string {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      out.push(codeMacro(fence[1], body.join('\n')));
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr />'); continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const q: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      out.push(`<blockquote>${toStorage(q.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      out.push(`<table><tbody><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      // a list, nested by indent: each item is [indent, ordered, text]
      const items: [number, boolean, string][] = [];
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i++) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]) as RegExpExecArray;
        items.push([m[1].replace(/\t/g, '  ').length, /\d/.test(m[2]), m[3]]);
      }
      i--;
      let html = '';
      const stack: [number, boolean][] = [];
      for (const [ind, ord, text] of items) {
        if (!stack.length || ind > stack[stack.length - 1][0]) { html += ord ? '<ol>' : '<ul>'; stack.push([ind, ord]); }
        else {
          while (stack.length > 1 && ind < stack[stack.length - 1][0]) { html += `</li>${stack.pop()![1] ? '</ol>' : '</ul>'}`; }
          // a numbered list straight after a bulleted one (or the reverse) at the same depth is a list of its own
          if (stack[stack.length - 1][1] !== ord) { html += `</li>${stack.pop()![1] ? '</ol>' : '</ul>'}${ord ? '<ol>' : '<ul>'}`; stack.push([ind, ord]); }
          else html += '</li>';
        }
        html += `<li>${inline(text)}`;
      }
      while (stack.length) html += `</li>${stack.pop()![1] ? '</ol>' : '</ul>'}`;
      out.push(html);
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out.join('');
}

// A small reader for the storage format: tags, text, CDATA and comments, into a tree (the format is well-formed XHTML)
function parse(xml: string): Node[] {
  const root: Node = { tag: '#root', kids: [] };
  const stack: Node[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\/([\w:-]+)\s*>|<([\w:-]+)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) top.kids!.push({ text: m[1] });
    else if (m[2]) { const i = stack.map((n) => n.tag).lastIndexOf(m[2]); if (i > 0) stack.length = i; }
    else if (m[3]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] || '').matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const n: Node = { tag: m[3], attrs, kids: [] };
      top.kids!.push(n);
      if (!m[5] && !/^(br|hr|img|col)$/i.test(m[3])) stack.push(n);
    } else if (m[6]) top.kids!.push({ text: decode(m[6]) });
  }
  return root.kids!;
}
const textOf = (n: Node): string => (n.text ?? (n.kids || []).map(textOf).join(''));

function inlineMd(nodes: Node[]): string {
  return nodes.map((n) => {
    if (n.text != null) return n.text.replace(/\s+/g, ' ');
    const k = inlineMd(n.kids || []);
    switch (n.tag) {
      case 'strong': case 'b': return k.trim() ? `**${k}**` : k;
      case 'em': case 'i': return k.trim() ? `*${k}*` : k;
      case 'code': return `\`${textOf(n)}\``;
      case 'del': case 's': return `~~${k}~~`;
      case 'a': return n.attrs?.href ? `[${k || n.attrs.href}](${n.attrs.href})` : k;
      case 'br': return '\n';
      case 'ac:link': return k || '[link]';
      case 'ri:page': return n.attrs?.['ri:content-title'] || '';
      case 'ri:user': return '@user';
      case 'ac:link-body': case 'ac:plain-text-link-body': return textOf(n);
      case 'ac:structured-macro': return `[macro: ${n.attrs?.['ac:name'] || '?'}]`;
      case 'ac:emoticon': return '';
      default: return k;
    }
  }).join('');
}
function blocksMd(nodes: Node[], depth = 0): string {
  const out: string[] = [];
  let run: Node[] = [];
  const flushInline = () => { const t = inlineMd(run).trim(); if (t) out.push(t); run = []; };
  for (const n of nodes) {
    const t = n.tag || '';
    if (/^h[1-6]$/.test(t)) { flushInline(); out.push(`${'#'.repeat(Number(t[1]))} ${inlineMd(n.kids || []).trim()}`); }
    else if (t === 'p') { flushInline(); const x = inlineMd(n.kids || []).trim(); if (x) out.push(x); }
    else if (t === 'hr') { flushInline(); out.push('---'); }
    else if (t === 'blockquote') { flushInline(); out.push(blocksMd(n.kids || [], depth).split('\n').map((l) => `> ${l}`).join('\n')); }
    else if (t === 'ul' || t === 'ol') { flushInline(); out.push(listMd(n, depth)); }
    else if (t === 'table') { flushInline(); out.push(tableMd(n)); }
    else if (t === 'ac:structured-macro' && n.attrs?.['ac:name'] === 'code') {
      flushInline();
      const lang = (n.kids || []).find((k) => k.tag === 'ac:parameter' && k.attrs?.['ac:name'] === 'language');
      const body = (n.kids || []).find((k) => k.tag === 'ac:plain-text-body');
      out.push(`\`\`\`${lang ? textOf(lang) : ''}\n${body ? textOf(body) : ''}\n\`\`\``);
    } else if (/^(ac:layout|ac:layout-section|ac:layout-cell|div|section|tbody|ac:rich-text-body)$/.test(t)) { flushInline(); const x = blocksMd(n.kids || [], depth); if (x) out.push(x); }
    else if (t === 'ac:structured-macro') {
      flushInline();
      const rich = (n.kids || []).find((k) => k.tag === 'ac:rich-text-body');
      out.push(`[macro: ${n.attrs?.['ac:name'] || '?'}]${rich ? `\n${blocksMd(rich.kids || [], depth)}` : ''}`);
    } else run.push(n);
  }
  flushInline();
  return out.join('\n\n');
}
function listMd(list: Node, depth: number): string {
  let i = 0;
  return (list.kids || []).filter((k) => k.tag === 'li').map((li) => {
    const inner = (li.kids || []).filter((k) => k.tag !== 'ul' && k.tag !== 'ol');
    const sub = (li.kids || []).filter((k) => k.tag === 'ul' || k.tag === 'ol').map((s) => `\n${listMd(s, depth + 1)}`).join('');
    const p = inner.length === 1 && inner[0].tag === 'p' ? inner[0].kids || [] : inner;
    return `${'  '.repeat(depth)}${list.tag === 'ol' ? `${++i}.` : '-'} ${inlineMd(p).trim()}${sub}`;
  }).join('\n');
}
function tableMd(table: Node): string {
  const rows: Node[] = [];
  const walk = (n: Node) => { for (const k of n.kids || []) { if (k.tag === 'tr') rows.push(k); else if (k.tag) walk(k); } };
  walk(table);
  const grid = rows.map((r) => (r.kids || []).filter((c) => c.tag === 'th' || c.tag === 'td').map((c) => inlineMd(c.kids || []).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()));
  if (!grid.length) return '';
  const w = Math.max(...grid.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: w }, (_, i) => r[i] || '').join(' | ')} |`;
  return [line(grid[0]), `|${' --- |'.repeat(w)}`, ...grid.slice(1).map(line)].join('\n');
}
const toMarkdown = (storage: string) => blocksMd(parse(String(storage || ''))).replace(/\n{3,}/g, '\n\n').trim();

/* The page with the content under one heading replaced (up to the next heading of the same level or higher). The
   heading is matched by its text, ignoring case and spacing. Not there: the heading and content are added at the end
   (as an h2, or the level given as "## Title"). → { storage, found } */
function replaceSection(storage: string, heading: string, md: string) {
  const want = String(heading).replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const level = /^(#{1,6})\s/.exec(String(heading))?.[1].length || 2;
  const hs = [...String(storage).matchAll(/<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi)].map((m) => ({ level: Number(m[1]), start: m.index!, end: m.index! + m[0].length, text: decode(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim().toLowerCase() }));
  const at = hs.findIndex((h) => h.text === want);
  const body = toStorage(md);
  if (at < 0) return { storage: `${storage}<h${level}>${esc(String(heading).replace(/^#+\s*/, '').trim())}</h${level}>${body}`, found: false };
  const h = hs[at];
  const next = hs.slice(at + 1).find((x) => x.level <= h.level);
  return { storage: storage.slice(0, h.end) + body + storage.slice(next ? next.start : storage.length), found: true };
}

module.exports = { toStorage, toMarkdown, replaceSection };
