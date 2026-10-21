/* The card markdown renderer. It reads `location` to tell the board's own images from other hosts'. */
import { esc } from './util.js';

const safeUrl = (u) => /^(https?:|\/|#|mailto:|blob:)/i.test(u) || /^data:image\//i.test(u);
// Images load by themselves only from the board (its /files, avatars) or inline data: one on another host
// would tell that host when the signed-in human reads the card. Those become a link to click instead.
const ownImage = (u) => {
  if (/^(blob:|data:image\/)/i.test(u)) return true;
  try { return new URL(u.replace(/&amp;/g, '&'), location.href).origin === location.origin; } catch { return false; }
};
const emphasis = (s) => s
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
  .replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>')
  .replace(/~~(.+?)~~/g, '<del>$1</del>');
function inline(s) {
  // \u0001 and \u0002 mark placeholders below; typed ones would pull in the wrong code span or tag
  s = s.replace(/[\u0001\u0002]/g, '');
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0001${codes.push(c) - 1}\u0001`);
  // finished tags wait behind \u0002n\u0002 so the ref and mention passes never see a URL or alt text; link text
  // gets emphasis only, so a ticket id in it never becomes a link inside the link
  const tags = [];
  const keep = (html) => `\u0002${tags.push(html) - 1}\u0002`;
  s = emphasis(esc(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => (!safeUrl(u) ? a
      : ownImage(u) ? keep(`<img alt="${a}" src="${u}" loading="lazy">`)
      : keep(`<a class="ext-img" href="${u}" target="_blank" rel="noopener noreferrer" title="Image from another site: opens in a new tab">${a || 'Image'} ↗</a>`)))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => (safeUrl(u) ? keep(`<a href="${u}" target="_blank" rel="noopener">${emphasis(t)}</a>`) : t))
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => `${pre}${keep(`<a href="${u}" target="_blank" rel="noopener">${u}</a>`)}`))
    .replace(/(^|[^\w/-])([A-Z][A-Z0-9]{1,7}-\d+)\b/g, '$1<a class="ref" data-ref="$2">$2</a>')
    .replace(/(^|\s)@([\w.-]+)/g, '$1<span class="mention">@$2</span>');
  s = s.replace(/\u0002(\d+)\u0002/g, (_, n) => tags[n]);
  return s.replace(/\u0001(\d+)\u0001/g, (_, n) => `<code>${esc(codes[n])}</code>`);
}
export function md(src, { tasks = false } = {}) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let out = '';
  const para = [];
  const flush = () => { if (para.length) { out += `<p>${para.map(inline).join('<br>')}</p>`; para.length = 0; } };
  const LIST = /^\s*([-*+]|\d+[.)])\s+/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = /^\s*(```|~~~)/.exec(line))) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(m[1])) buf.push(lines[i++]);
      i++;
      out += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flush(); out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; i++;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush(); out += '<hr>'; i++;
    } else if (/^\s*>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out += `<blockquote>${md(buf.join('\n'))}</blockquote>`;
    } else if (LIST.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      let html = '';
      while (i < lines.length && LIST.test(lines[i])) {
        const nested = /^\s*/.exec(lines[i])[0].length >= 2 ? ' nested' : '';
        const raw = lines[i].replace(LIST, '');
        const task = /^\[( |x|X)\](?:\s+(.*))?$/.exec(raw);
        html += task && !(task[2] || '').trim()
          ? `<li class="task empty${nested}" title="Empty checklist item"><span class="ck-ph" aria-hidden="true"></span></li>`
          : task
          ? `<li class="task${nested}"><input type="checkbox" class="ck" data-line="${i}"${task[1] !== ' ' ? ' checked' : ''}${tasks ? '' : ' disabled'}><span>${inline(task[2])}</span></li>`
          : `<li class="${nested.trim()}">${inline(raw)}</li>`;
        i++;
      }
      out += ordered ? `<ol>${html}</ol>` : `<ul>${html}</ul>`;
    } else if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line);
      i += 2;
      let body = '';
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { body += `<tr>${row(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`; i++; }
      out += `<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
    } else if (!line.trim()) {
      flush(); i++;
    } else { para.push(line); i++; }
  }
  flush();
  return out;
}
