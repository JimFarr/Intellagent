/* Shared by every area of the client: ids, colours, time, avatars and names. Pure over state, settings and util: nothing here draws a card or opens a window. */
import { esc, hashStr, hue, initials } from './util.js';
import { state, settings, BASE_THEME } from './state.js';
import { THEMES, themeGroups } from './themes.js';

// Parent tags take a slot, and each theme paints its slots from its own palette (--tag-0…7, themeGroups): as
// many slots as the theme has distinct group colours, up to eight. Slots are dealt out board-wide: each name
// starts at its hashed slot and moves along only when an earlier name took it, so as many parents as there are
// colours never share one, and a name keeps its colour on chips, groups and menus alike.
let tagSlots = new Map(), tagSlotsFor, tagSlotsOf;
const tagCount = () => themeGroups(THEMES[settings.theme] || THEMES[BASE_THEME]).count;
const tagHome = (p) => hashStr(String(p)) % tagCount();
function tagSlot(p) {
  const board = state.board, slots = tagCount();
  // Rebuild when the board is replaced, the theme has a different number of colours, or an in-place edit
  // brought in a name we haven't dealt yet.
  if (tagSlotsFor !== board || tagSlotsOf !== slots || (!tagSlots.has(p) && Object.values(board?.items || {}).some((it) => it.parent === p))) {
    tagSlotsFor = board;
    tagSlotsOf = slots;
    tagSlots = new Map();
    const names = [...new Set(Object.values(board?.items || {}).map((it) => it.parent).filter(Boolean))];
    names.sort((a, b) => tagHome(a) - tagHome(b) || (a < b ? -1 : 1));
    let used = new Set();
    for (const n of names) {
      if (used.size === slots) used = new Set();
      let s = tagHome(n);
      while (used.has(s)) s = (s + 1) % slots;
      used.add(s);
      tagSlots.set(n, s);
    }
  }
  return tagSlots.get(p) ?? tagHome(p);
}
const tagColor = (p) => `var(--tag-${tagSlot(p)}, var(--accent))`;
const tilt = (id) => (((hashStr(id) % 1000) / 1000) - 0.5) * 2.6;
// Each card gets its own decoration placement, stable per ticket: a slot (0–3), a spot along the top
// edge (18–82%) and a small extra angle, so tape, pins and clips don't line up like stamps.
const decoVars = (id) => {
  const h = hashStr(`${id}~deco`);
  return `--deco-slot:${h % 4};--deco-x:${18 + ((h >>> 3) % 65)}%;--deco-r:${((h >>> 9) % 15) - 7}deg`;
};
const decoSlot = (id) => hashStr(`${id}~deco`) % 4;
const nowMs = () => Date.now() + state.offset;
const reduced = () => settings.motion === 'reduced';
const autosize = (ta) => { if (!ta) return; ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
const isImage = (a) => a?.kind !== 'link' && /^image\//.test(a?.mime || '');

function rel(ts) {
  if (!ts) return '';
  const s = (nowMs() - Date.parse(ts)) / 1000;
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 604800) return `${Math.round(s / 86400)}d`;
  return new Date(ts).toLocaleDateString();
}
const fmtLeft = (ms) => (ms <= 0 ? '0:00' : ms >= 3600000 ? `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m` : `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`);

const TYPES = ['issue', 'task', 'spike'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const PRIO_VAR = { Low: 'var(--muted)', Medium: 'var(--task)', High: 'var(--warn)', Critical: 'var(--danger)' };
const TYPE_VAR = { issue: 'var(--issue)', task: 'var(--task)', spike: 'var(--spike)' };
const FIELD_ICON = { text: 'text', markdown: 'text', number: 'num', boolean: 'toggle', enum: 'list', tags: 'tag', date: 'cal', url: 'link', user: 'user' };
const LOGO = '<svg viewBox="0 0 32 32"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent-2)"/></linearGradient></defs><rect x="2" y="2" width="28" height="28" rx="9" fill="url(#lg)"/><path d="M9.5 11h11M9.5 16h7M9.5 21h4" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><path d="M23 17.5l1.1 2.4 2.4 1.1-2.4 1.1-1.1 2.4-1.1-2.4-2.4-1.1 2.4-1.1z" fill="#fff"/></svg>';

// Agents (and you) can set colour / glyph / image via PATCH /api/profiles/me; otherwise colour comes from the name.
function avatar(actor, cls = '') {
  const name = actor?.name || '?';
  const p = state.profiles[name];
  const kind = (p?.kind || actor?.kind) === 'user' ? 'user' : 'agent';
  const color = p?.color || `hsl(${hue(name)} 62% 56%)`;
  const style = `--av:${esc(color)}${p?.image ? `;background-image:url(&quot;${esc(p.image)}&quot;)` : ''}`;
  const run = state.standing[name]?.status;
  return `<span class="avatar ${kind} ${p?.image ? 'img' : ''} ${p?.glyph ? 'glyph' : ''} ${cls}" data-name="${esc(name)}"${run && run !== 'idle' ? ` data-run="${run}"` : ''} style="${style}" title="${esc(p?.label || name)}|${kind === 'agent' ? 'Agent' : 'Person'}${p?.label ? ` · ${esc(name)}` : ''} — click for profile">${p?.image ? '' : p?.glyph ? `<i class="gl">${esc(emojiGlyph(p.glyph))}</i>` : esc(initials(name))}</span>`;
}
// A glyph like 🗡 or ⚔ draws as a flat text symbol unless U+FE0F follows it; add it so it shows as the emoji.
const emojiGlyph = (g) => (/^\p{Extended_Pictographic}$/u.test(g) && !/\p{Emoji_Presentation}/u.test(g) ? `${g}️` : g);

// How an agent or person is called on screen: the profile's label when it has one ("Receptionist"),
// else the id. The id is what routes (@mentions, assignee), so it stays in tooltips and muted suffixes.
const nameOf = (n) => state.profiles[n]?.label || n || '';
const nameHTML = (n) => {
  const l = state.profiles[n]?.label;
  return l && l !== n ? `<span class="dn" title="@${esc(n)}">${esc(l)}</span>` : esc(n || '');
};
const dotsHTML = '<i class="ai-dots"><b></b><b></b><b></b></i>';
// The bubble's age (INT-191): how long the run has gone, or that it has gone quiet (stalled: no board call and no output)
const minsSince = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
const standingOf = (n) => Object.values(state.standing || {}).find((a) => a.name === n) || {};
const runAgo = (n) => {
  const a = standingOf(n);
  return a.stalled ? `hasn't touched the board for ${minsSince(a.lastActivityAt)} min` : `${minsSince(a.runningSince)} min`;
};
const thinkAge = (n) => {
  const stalled = standingOf(n).stalled;
  return `${stalled ? '' : dotsHTML}<span class="think-age${stalled ? ' stalled' : ''}" data-run="${esc(n)}">${runAgo(n)}</span>`;
};

export {
  tagColor, tilt, decoVars, decoSlot, nowMs, reduced, autosize, isImage, rel, fmtLeft,
  TYPES, PRIORITIES, PRIO_VAR, TYPE_VAR, FIELD_ICON, LOGO,
  avatar, emojiGlyph, nameOf, nameHTML, dotsHTML, minsSince, standingOf, runAgo, thinkAge,
};
