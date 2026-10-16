/* Intellagent — client. Stateless view over the board JSON served by server.js. */
'use strict';

(() => {
  /* ═════════════════════════ helpers ═════════════════════════ */

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const hue = (s) => hashStr(String(s)) % 360;
  const initials = (n) => String(n).split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
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

  const ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3M7.5 15h9"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 13v2M15 13v2"/><circle cx="12" cy="3" r="1"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    pin: '<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 14v7"/>',
    checks: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    archive: '<rect x="2" y="3" width="20" height="5" rx="1.5"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    ask: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M10 8.5a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.4M12 14h.01"/>',
    chev: '<path d="m6 9 6 6 6-6"/>',
    layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    move: '<path d="m8 3-4 4 4 4M4 7h16M16 21l4-4-4-4M20 17H4"/>',
    flag: '<path d="M4 22V4M4 4h13l-2 4 2 4H4"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    issue: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>',
    task: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    spike: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/>',
    palette: '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A5.7 5.7 0 0 0 22 9.8C22 5.5 17.5 2 12 2z"/>',
    card: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h10M7 13h6"/>',
    board: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18M15 3v18"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c1 1.3 2.2 2 3.5 2s2.5-.7 3.5-2M9 9.5h.01M15 9.5h.01"/>',
    terminal: '<path d="M4 17l6-5-6-5M12 19h8"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    sparkle: '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>',
    tag: '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    cal: '<rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    num: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    toggle: '<rect x="2" y="6" width="20" height="12" rx="6"/><circle cx="16" cy="12" r="3"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    eyeoff: '<path d="M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6M2 2l20 20"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/>',
    radio: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
    news: '<path d="M4 22h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8M15 18h-5M10 6h8v4h-8z"/>',
    wave: '<path d="M2 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0"/><path d="M2 18c2-4 4-4 6 0s4 4 6 0 4-4 6 0" opacity=".5"/>',
  };
  const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ICONS.sparkle}</svg>`;
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
    return `<span class="avatar ${kind} ${p?.image ? 'img' : ''} ${p?.glyph ? 'glyph' : ''} ${cls}" data-name="${esc(name)}"${run && run !== 'idle' ? ` data-run="${run}"` : ''} style="${style}" title="${esc(p?.label || name)}|${kind === 'agent' ? 'Agent' : 'Person'}${p?.label ? ` · ${esc(name)}` : ''} — click for profile">${p?.image ? '' : esc(p?.glyph || initials(name))}</span>`;
  }

  // How an agent or person is called on screen: the profile's label when it has one ("Receptionist"),
  // else the id. The id is what routes (@mentions, assignee), so it stays in tooltips and muted suffixes.
  const nameOf = (n) => state.profiles[n]?.label || n || '';
  const nameHTML = (n) => {
    const l = state.profiles[n]?.label;
    return l && l !== n ? `<span class="dn" title="@${esc(n)}">${esc(l)}</span>` : esc(n || '');
  };

  // Standing agents whose active run was woken for this request (kind 'requests') or by a comment on this
  // ticket (kind 'comments') and haven't answered there yet — they get a "thinking" bubble. `answered(name,
  // since)` says whether a reply from <name> landed after the run started. Only 'running' counts: queued,
  // throttled, failed and paused runs show nothing, and the bubble goes with the run.
  const thinkers = (kind, id, answered) => Object.values(state.standing || {})
    .filter((a) => a.status === 'running' && a.lastRun?.about?.[kind]?.includes(id) && !answered(a.name, a.lastRun.startedAt))
    .map((a) => a.name);
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
  // A run that ended without a reply here (INT-191): a quiet line. It goes once the agent replied during the run, or anyone posts after it ended
  const endedHere = (kind, id, posts) => Object.values(state.standing || {})
    .filter((a) => a.status !== 'running' && a.lastRun?.endedAt && a.lastRun?.about?.[kind]?.includes(id)
      && !posts.some((p) => p.at > a.lastRun.endedAt || (p.who === a.name && p.at > a.lastRun.startedAt)))
    .map((a) => `${nameOf(a.name)}'s run ended ${minsSince(a.lastRun.endedAt)} min ago without replying here`);
  // An open request its agent will not pick up soon (INT-203): what the human can do, or when it runs. Clears once the agent replies or starts
  const requestStuck = (q) => {
    if (q.status !== 'open' || (q.replies || []).some((r) => r.author?.name === q.to && r.at > q.at)) return null;
    const sa = state.standing?.[q.to];
    if (!sa) return state.presence.find((p) => p.name === q.to)?.online ? null : 'Offline: nothing is listening. Ask someone else.';
    if (sa.status === 'paused') return 'Paused: it won’t run until you resume it on the Agents page, or ask someone else.';
    if (sa.status === 'failed') return 'Failed: needs you. Resume it on the Agents page, or ask someone else.';
    if (sa.status === 'throttled' || sa.status === 'queued' || sa.status === 'waiting') {
      const when = sa.resumesAt && new Date(sa.resumesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return when ? `Runs about ${when}` : sa.status === 'throttled' ? 'Throttled: runs later' : 'Queued: runs shortly';
    }
    return null;
  };

  /* ═════════════════════════ themes + settings ═════════════════════════ */

  // A theme = palette + style spec + optional CSS. The style spec drives data-attributes on <html>
  // (CSS branches on them); `css` is injected for one-off touches that make each theme its own.
  const STYLE = {
    card: 12, col: 20, modal: 22, ctl: 10, bw: 1, colAlpha: 84, titleW: 600,
    shadow: 'soft', // soft | flat | hard | glow
    cards: 'sticky', // sticky | clean | elevated | outline | glass | index
    tape: 'tape', // tape | pin | clip | corner | none
    md: 'clean', // markdown look: clean | grid | paper | terminal
    attn: 'orbit', // needs-you styling: orbit | glow | bar | outline | ribbon
    enter: 'rise', // modal opening: rise | sheet | fade | pop | zoom
    lanes: 'glass', // columns: glass | solid | outline | lane
    typeInd: 'bar', // clean cards show type as: bar | top | tint | dot
    chips: 'pill', // pill | tag | outline
    heads: 'normal', // column titles: normal | caps
    avatar: 'mixed', // mixed (agents square, people round) | round | square
    bg: 'blobs', texture: true,
    corner: null, // px kept clear in each card's top-right (auto: 16 when the fold decoration is on)
    avatars: 'color', // color | accent | ink
    groups: 'tray', // tickets sharing a parent: tray (tinted panel) | rail (coloured rail) | rule (header + hairline) | tab (folder tab) | spine (vertical label) | foot (caption below) | cover (a summary card on top of the pile)
    avStyle: 'gem', // avatar look: gem | flat | tint | ring | pebble | stamp
    drop: 'ring', // a column a ticket is dragged over: ring | tint | lift | spotlight | dashed | pulse
    colColor: 'own', // own | accent | ink — column dots and rules
  };
  // Palette colours are #rgb or #rrggbb. WCAG relative luminance and contrast ratio, and a plain sRGB mix (p = share of y).
  const rgb = (h) => (h.length === 4 ? [...h.slice(1)].map((c) => c + c) : [h.slice(1, 3), h.slice(3, 5), h.slice(5, 7)]).map((x) => parseInt(x, 16));
  const luminance = (h) => rgb(h).map((c) => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (x, y) => { const [a, b] = [luminance(x), luminance(y)].sort((m, n) => n - m); return (a + 0.05) / (b + 0.05); };
  const oklab = (h) => {
    const [r, g, b] = rgb(h).map((c) => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const [l, m, s] = [0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b].map(Math.cbrt);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const fromOklab = ([L, a, b]) => {
    const [l, m, s] = [L + 0.3963377774 * a + 0.2158037573 * b, L - 0.1055613458 * a - 0.0638541728 * b, L - 0.0894841775 * a - 1.291485548 * b].map((c) => c ** 3);
    const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    return `#${lin.map((c) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055))).toString(16).padStart(2, '0')).join('')}`;
  };
  // color-mix(in oklab, x p, y), as CSS does it
  const mixOklab = (x, p, y) => fromOklab(oklab(x).map((c, i) => c * p + oklab(y)[i] * (1 - p)));
  const mixHex = (x, y, p) => `#${rgb(x).map((c, i) => Math.round(c + (rgb(y)[i] - c) * p).toString(16).padStart(2, '0')).join('')}`;
  const T = (label, mode, c, style = {}, css = '') => ({
    label, mode, style, css, glow: !!style.glow,
    vars: {
      bg: c[0], panel: c[1], surface: c[2], text: c[3], muted: c[4], border: c[5], accent: c[6], 'accent-2': c[7],
      issue: c[8], task: c[9], spike: c[10], ok: c[11], warn: c[12], danger: c[13], blob1: c[14], blob2: c[15], blob3: c[16],
      shadow: mode === 'dark' ? 'rgb(0 0 0 / .6)' : 'rgb(60 45 30 / .22)', 'fx-o': mode === 'dark' ? '.34' : '.5', grain: mode === 'dark' ? '.07' : '.09',
      // set on every theme, so switching away from one that changes them never leaves them behind
      'on-accent': '#fff', 'accent-fill': c[6],
    },
  });
  // The Bauhaus family shares one geometry: a card wears its type as a shape in the top-right corner (issue a
  // circle, task a square, spike a triangle) and a column a thick rule on top. `s` is the shape's size in px,
  // `rule` the rule's thickness; `extra` is the variant's own CSS (it comes last, so it wins).
  const bauhausCss = (s, rule, extra = '') => `.card { background: radial-gradient(circle at 100% 0, var(--type-c) 0 ${s}px, transparent ${s + 1}px), var(--surface); } .card[data-type="task"] { background: linear-gradient(var(--type-c), var(--type-c)) 100% 0 / ${s}px ${s}px no-repeat, var(--surface); } .card[data-type="spike"] { background: linear-gradient(225deg, var(--type-c) 50%, transparent 50%) 100% 0 / ${Math.round(s * 1.36)}px ${Math.round(s * 1.36)}px no-repeat, var(--surface); } .card::before { display: none; } .column { border-top: ${rule}px solid var(--col); } .col-name { font-weight: 900; letter-spacing: .06em; } .app-name { background: none; color: var(--text); -webkit-text-fill-color: currentColor; font-weight: 900; } ${extra}`;
  // The poster look (Bauhaus, Bauhaus Night) and the quieter studio look (thin borders, small shapes, no offset shadow).
  const BAUHAUS_POSTER = { md: 'grid', card: 0, col: 0, modal: 0, ctl: 20, bw: 2, shadow: 'hard', cards: 'clean', typeInd: 'top', tape: 'none', attn: 'ribbon', enter: 'pop', lanes: 'solid', chips: 'pill', heads: 'caps', bg: 'none', texture: true, avatar: 'round', corner: 30, titleW: 700, font: "'Archivo'", display: "'Archivo'" };
  const BAUHAUS_STUDIO = { md: 'grid', card: 2, col: 2, modal: 4, ctl: 4, bw: 1, shadow: 'flat', cards: 'clean', typeInd: 'top', tape: 'none', attn: 'bar', enter: 'fade', lanes: 'solid', chips: 'tag', heads: 'caps', bg: 'none', texture: false, avatar: 'square', corner: 20, titleW: 600, font: "'Inter'", display: "'Archivo'", colAlpha: 100 };
  const STUDIO_CSS = '.col-name { font-weight: 700; letter-spacing: .1em; font-size: 12px; } .c-title { font-size: 14px; } .app-name { font-weight: 700; letter-spacing: -.01em; }';
  const THEMES = {
    // The first look, now one theme among many: its key stays, so a saved pick still finds it.
    intellagent: T('Amethyst', 'dark', ['#0d0e1a', '#161829', '#1d2035', '#eceefe', '#8e93b8', '#2b2f4a', '#8b7bff', '#2fe0c4', '#ff6b8b', '#6aa8ff', '#ffc857', '#3ddc97', '#ffb454', '#ff5d73', '#7b5cff', '#00d4b0', '#ff5fa2']),
    daylight: T('Daylight', 'light', ['#f4f1ec', '#ebe6de', '#fffdf9', '#23212b', '#7a7585', '#ddd6cb', '#6c5cff', '#0fb59a', '#e5486b', '#3b7bea', '#e3a019', '#1f9e66', '#d9822b', '#d93c56', '#b6a8ff', '#8ff0dc', '#ffc2d9'],
      { attn: 'glow' }),
    dracula: T('Dracula', 'dark', ['#21222c', '#282a36', '#343746', '#f8f8f2', '#8b93c4', '#44475a', '#bd93f9', '#ff79c6', '#ff5555', '#8be9fd', '#f1fa8c', '#50fa7b', '#ffb86c', '#ff5555', '#bd93f9', '#ff79c6', '#8be9fd'],
      { cards: 'clean', typeInd: 'top', tape: 'none', attn: 'glow', enter: 'zoom', bg: 'stars' },
      '.c-id { color: var(--accent-2); } .col-name { color: var(--accent); }'),
    nord: T('Nord', 'dark', ['#2a303c', '#2e3440', '#3b4252', '#eceff4', '#a3adc2', '#434c5e', '#88c0d0', '#b48ead', '#bf616a', '#81a1c1', '#ebcb8b', '#a3be8c', '#d08770', '#bf616a', '#5e81ac', '#88c0d0', '#b48ead'],
      { card: 10, col: 16, modal: 18, ctl: 8, cards: 'clean', tape: 'none', typeInd: 'tint', attn: 'outline', enter: 'fade', lanes: 'solid', bg: 'none' },
      '.col-head { border-bottom: 1px solid var(--border); margin: 0 4px 10px; }'),
    mocha: T('Catppuccin Mocha', 'dark', ['#11111b', '#1e1e2e', '#313244', '#cdd6f4', '#a6adc8', '#45475a', '#cba6f7', '#94e2d5', '#f38ba8', '#89b4fa', '#f9e2af', '#a6e3a1', '#fab387', '#f38ba8', '#cba6f7', '#89b4fa', '#f5c2e7'],
      { attn: 'glow' }, '.card { --card-line: color-mix(in oklab, var(--accent) 18%, transparent); }'),
    latte: T('Catppuccin Latte', 'light', ['#dce0e8', '#e6e9ef', '#eff1f5', '#4c4f69', '#6c6f85', '#ccd0da', '#8839ef', '#179299', '#d20f39', '#1e66f5', '#df8e1d', '#40a02b', '#fe640b', '#d20f39', '#8839ef', '#04a5e5', '#ea76cb'],
      { attn: 'glow' }),
    tokyo: T('Tokyo Night', 'dark', ['#16161e', '#1a1b26', '#24283b', '#c0caf5', '#8089b3', '#2f3549', '#7aa2f7', '#bb9af7', '#f7768e', '#7dcfff', '#e0af68', '#9ece6a', '#ff9e64', '#f7768e', '#7aa2f7', '#bb9af7', '#2ac3de'],
      { cards: 'clean', tape: 'none', typeInd: 'dot', attn: 'glow', enter: 'zoom', bg: 'stars', chips: 'outline' },
      '.column { border-top: 2px solid color-mix(in oklab, var(--col) 80%, transparent); }'),
    gruvbox: T('Gruvbox', 'dark', ['#1d2021', '#282828', '#3c3836', '#ebdbb2', '#a89984', '#504945', '#fabd2f', '#8ec07c', '#fb4934', '#83a598', '#fabd2f', '#b8bb26', '#fe8019', '#fb4934', '#d79921', '#689d6a', '#cc241d'],
      { card: 6, tape: 'pin', attn: 'ribbon', enter: 'pop', bg: 'none', heads: 'caps', display: "'JetBrains Mono', monospace" },
      '.c-title { font-family: var(--mono); font-size: 13px; }'),
    rosepine: T('Rosé Pine', 'dark', ['#191724', '#1f1d2e', '#26233a', '#e0def4', '#908caa', '#393552', '#c4a7e7', '#ebbcba', '#eb6f92', '#9ccfd8', '#f6c177', '#3e8fb0', '#f6c177', '#eb6f92', '#c4a7e7', '#ebbcba', '#31748f'],
      { cards: 'clean', tape: 'none', typeInd: 'tint', attn: 'glow', enter: 'fade', bg: 'aurora' }),
    solarized: T('Solarized Light', 'light', ['#eee8d5', '#f5efdc', '#fdf6e3', '#073642', '#657b83', '#ddd6c1', '#268bd2', '#2aa198', '#dc322f', '#268bd2', '#b58900', '#859900', '#cb4b16', '#dc322f', '#268bd2', '#2aa198', '#d33682'],
      { md: 'paper', card: 6, col: 12, modal: 14, ctl: 6, cards: 'clean', tape: 'corner', shadow: 'flat', attn: 'bar', enter: 'fade', lanes: 'solid', bg: 'none' }),
    github: T('GitHub Light', 'light', ['#f6f8fa', '#eef1f4', '#ffffff', '#1f2328', '#656d76', '#d0d7de', '#0969da', '#8250df', '#cf222e', '#0969da', '#9a6700', '#1a7f37', '#bc4c00', '#cf222e', '#54aeff', '#c297ff', '#ffd8b5'],
      { card: 8, col: 12, modal: 14, ctl: 7, cards: 'clean', tape: 'none', shadow: 'flat', attn: 'outline', enter: 'sheet', lanes: 'solid', chips: 'tag', bg: 'none', texture: false, avatar: 'round', titleW: 600 },
      '.c-title { font-size: 13.5px; } .c-id { color: var(--muted); }'),
    synthwave: T("Synthwave '84", 'dark', ['#1a1025', '#241b2f', '#2a2139', '#f4eee4', '#a29bc8', '#3b2f52', '#ff7edb', '#36f9f6', '#fe4450', '#36f9f6', '#fede5d', '#72f1b8', '#f97e72', '#fe4450', '#ff7edb', '#36f9f6', '#fede5d'],
      { glow: true, shadow: 'glow', cards: 'clean', tape: 'none', typeInd: 'top', attn: 'orbit', enter: 'zoom', bg: 'mesh', heads: 'caps' },
      '.col-name { color: var(--accent); text-shadow: 0 0 8px var(--accent); }'),
    slate: T('Slate', 'light', ['#f5f7fa', '#eef1f5', '#ffffff', '#1b2430', '#64748b', '#dbe2ea', '#2563eb', '#0ea5e9', '#dc2626', '#2563eb', '#d97706', '#16a34a', '#ea580c', '#dc2626', '#93c5fd', '#a5f3fc', '#e2e8f0'],
      { card: 6, col: 10, modal: 12, ctl: 6, shadow: 'flat', tape: 'none', cards: 'clean', attn: 'bar', enter: 'sheet', lanes: 'lane', chips: 'tag', heads: 'caps', bg: 'none', texture: false, avatar: 'round', titleW: 500, font: "'IBM Plex Sans'", display: "'IBM Plex Sans'", colAlpha: 92 },
      '.topbar { background: var(--surface); border-bottom: 1px solid var(--border); margin-bottom: 10px; padding-bottom: 12px; } .app-name { background: none; color: var(--text); -webkit-text-fill-color: currentColor; }'),
    graphite: T('Graphite', 'dark', ['#0f1012', '#16171a', '#1c1d21', '#e6e7ea', '#8b8f98', '#2a2c31', '#6e9fff', '#58d0b4', '#f87171', '#6e9fff', '#fbbf24', '#4ade80', '#fb923c', '#f87171', '#3b4252', '#2a3a4a', '#3a2e3e'],
      { card: 5, col: 8, modal: 10, ctl: 6, tape: 'none', cards: 'clean', typeInd: 'dot', attn: 'outline', enter: 'sheet', lanes: 'solid', chips: 'outline', bg: 'none', texture: false, display: "'Inter'", colAlpha: 92 },
      '.column { border-color: transparent; } .card:hover { translate: 0 -1px; }'),
    midnight: T('Midnight Pro', 'dark', ['#08090c', '#101116', '#15161c', '#ededf0', '#8a8f98', '#23252d', '#5e6ad2', '#4cb782', '#eb5757', '#5e6ad2', '#f2c94c', '#4cb782', '#f2994a', '#eb5757', '#5e6ad2', '#26b5ce', '#8e4ec6'],
      { card: 8, col: 14, modal: 16, ctl: 8, tape: 'none', cards: 'clean', typeInd: 'dot', attn: 'glow', enter: 'rise', lanes: 'outline', chips: 'tag', bg: 'aurora', titleW: 500, display: "'Inter'" },
      '.col-name { font-weight: 500; font-size: 13px; color: var(--muted); } .c-title { font-size: 13.5px; }'),
    paper: T('Paper', 'light', ['#f3efe6', '#ece6d9', '#fbf8f2', '#2b2a26', '#7b756a', '#d9d1c0', '#b4532a', '#2f6f62', '#b4362a', '#2f5d8a', '#b98a1b', '#3d7a4a', '#c06a2b', '#b4362a', '#e8d9bd', '#d9e4d6', '#efd3c8'],
      { md: 'paper', card: 2, col: 4, modal: 6, ctl: 4, shadow: 'flat', tape: 'corner', cards: 'clean', typeInd: 'top', attn: 'ribbon', enter: 'fade', lanes: 'lane', chips: 'outline', heads: 'caps', bg: 'doodles', display: "'Fraunces', serif", colAlpha: 90 },
      '.c-title { font-family: var(--display); font-size: 15.5px; } .board { background-image: repeating-linear-gradient(transparent 0 27px, color-mix(in oklab, var(--accent-2) 9%, transparent) 27px 28px); background-size: auto; } .col-name { font-style: italic; }'),
    brutalist: T('Brutalist', 'light', ['#f4f1ea', '#ffffff', '#ffffff', '#111111', '#555555', '#111111', '#ff4d00', '#0047ff', '#ff2e2e', '#0047ff', '#ffcc00', '#00a651', '#ff8a00', '#ff2e2e', '#ffcc00', '#0047ff', '#ff4d00'],
      { md: 'grid', card: 0, col: 0, modal: 0, ctl: 0, bw: 2, shadow: 'hard', tape: 'none', cards: 'clean', typeInd: 'top', attn: 'outline', enter: 'pop', lanes: 'solid', chips: 'tag', heads: 'caps', bg: 'none', texture: false, avatar: 'square', titleW: 700, font: "'Space Grotesk'", display: "'Space Grotesk'", colAlpha: 100 },
      '.c-title { font-size: 15px; } .app-name { background: none; color: var(--text); -webkit-text-fill-color: currentColor; } .btn.primary { background: var(--accent-fill); border: 2px solid var(--text); box-shadow: 3px 3px 0 var(--text); } .pill-btn:hover { translate: -2px -2px; box-shadow: 3px 3px 0 var(--text); }'),
    cork: T('Corkboard', 'light', ['#c9a77c', '#b8946a', '#fff8d2', '#2b2014', '#6b5537', '#9c7a52', '#c0392b', '#2e86ab', '#ff9aa2', '#7fb7e6', '#f4d35e', '#4c9a2a', '#d9822b', '#c0392b', '#e0c39a', '#b88e5f', '#d8b38a'],
      { md: 'paper', card: 2, col: 16, modal: 18, ctl: 10, tape: 'pin', cards: 'sticky', attn: 'ribbon', bg: 'none', avatar: 'round', colAlpha: 55, grain: '.22' },
      ".c-title { font-family: 'Caveat', cursive; font-size: 20px; line-height: 1.1; font-weight: 600; }"),
    blueprint: T('Blueprint', 'dark', ['#0b2545', '#0f2f57', '#13396a', '#e8f1ff', '#8fb3e0', '#2f5d93', '#7cc4ff', '#ffd166', '#ff8fa3', '#7cc4ff', '#ffd166', '#8ef0b0', '#ffb86b', '#ff8fa3', '#1d4e89', '#2b6cb0', '#0b3d73'],
      { md: 'terminal', card: 3, col: 6, modal: 8, ctl: 4, shadow: 'flat', tape: 'clip', cards: 'clean', typeInd: 'dot', attn: 'outline', enter: 'fade', lanes: 'outline', chips: 'outline', heads: 'caps', bg: 'none', texture: false, display: "'JetBrains Mono', monospace" },
      '.board { background-image: linear-gradient(color-mix(in oklab, var(--text) 8%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in oklab, var(--text) 8%, transparent) 1px, transparent 1px); background-size: 24px 24px; } .column, .card { border-style: dashed; } .c-title { text-transform: uppercase; font-size: 12.5px; letter-spacing: .04em; }'),
    vision: T('Vision', 'light', ['#e9eef8', '#ffffff', '#ffffff', '#0f1222', '#5b6380', '#d9e0ee', '#5b5bf6', '#0ea5e9', '#f43f5e', '#3b82f6', '#f59e0b', '#10b981', '#f97316', '#ef4444', '#a78bfa', '#67e8f9', '#f9a8d4'],
      { card: 18, col: 28, modal: 30, ctl: 14, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'glow', enter: 'rise', lanes: 'glass', bg: 'mesh', texture: false, avatar: 'round', colAlpha: 45 },
      '.column { background: linear-gradient(180deg, rgb(255 255 255 / .6), rgb(255 255 255 / .28)); border: 1px solid rgb(255 255 255 / .75); box-shadow: 0 1px 0 rgb(255 255 255 / .9) inset, 0 30px 60px -30px rgb(30 40 90 / .35); } .card { background: rgb(255 255 255 / .8); border-color: rgb(255 255 255 / .95); box-shadow: 0 1px 0 #fff inset, 0 12px 30px -14px rgb(30 40 90 / .32); } .modal, .drawer, .menu { background: rgb(255 255 255 / .93); } .pill-btn, .search input { background: rgb(255 255 255 / .62); border-color: rgb(255 255 255 / .85); } .app-name { background: linear-gradient(90deg, #5b5bf6, #0ea5e9); -webkit-background-clip: text; background-clip: text; }'),
    phosphor: T('Phosphor', 'dark', ['#050805', '#081008', '#0b160b', '#b8ffb0', '#5f9a5a', '#1d3a1c', '#39ff14', '#a3ff7a', '#ff5f5f', '#39ff14', '#ffd84d', '#39ff14', '#ffb000', '#ff4040', '#0f3d0f', '#123a12', '#0a2a0a'],
      { md: 'terminal', card: 0, col: 0, modal: 0, ctl: 0, shadow: 'flat', cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'outline', enter: 'fade', lanes: 'outline', chips: 'outline', heads: 'caps', bg: 'none', texture: false, avatar: 'square', avatars: 'accent', colColor: 'accent', titleW: 400, font: "'JetBrains Mono', monospace", display: "'VT323', monospace" },
      'body::after { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 1000; background: repeating-linear-gradient(0deg, rgb(0 0 0 / .22) 0 1px, transparent 1px 3px); } .board { background-image: radial-gradient(ellipse at 50% 40%, rgb(57 255 20 / .07), transparent 70%); } .c-title, .col-name, .app-name { text-shadow: 0 0 6px color-mix(in oklab, var(--accent) 65%, transparent); } .c-title { font-family: var(--display); font-size: 20px; line-height: 1.05; letter-spacing: .02em; } .col-name { font-family: var(--display); font-size: 19px; letter-spacing: .04em; } .app-name { background: none; color: var(--accent); -webkit-text-fill-color: currentColor; font-family: var(--display); font-size: 23px; } .card:hover .c-title::after { content: "_"; animation: breathe 1s steps(1) infinite; }'),
    swiss: T('Swiss', 'light', ['#f2f2ee', '#f2f2ee', '#ffffff', '#111111', '#6b6b6b', '#111111', '#e3000f', '#e3000f', '#e3000f', '#111111', '#ffb800', '#00875a', '#ff6b00', '#e3000f', '#f2f2ee', '#f2f2ee', '#f2f2ee'],
      { md: 'grid', card: 0, col: 0, modal: 0, ctl: 0, shadow: 'flat', cards: 'clean', typeInd: 'top', tape: 'none', attn: 'bar', enter: 'fade', lanes: 'lane', chips: 'tag', bg: 'none', texture: false, avatar: 'square', avatars: 'ink', colColor: 'ink', titleW: 700, font: "'Inter'", display: "'Inter'", colAlpha: 100 },
      '.col-head { border-bottom: 3px solid var(--text) !important; align-items: flex-end; } .col-name { font-size: 30px; font-weight: 800; letter-spacing: -.045em; text-transform: lowercase; line-height: 1; } .col-count { background: none; padding: 0; font: 300 30px/1 var(--display); letter-spacing: -.04em; color: var(--accent); } .col-dot, .col-icon { display: none; } .card { background: transparent; border-width: 0 0 1px; border-color: var(--text); border-radius: 0; box-shadow: none; padding: 12px 0 11px; } .card::before { display: none; } .card:hover { background: rgb(0 0 0 / .03); } .c-title { font-size: 15.5px; letter-spacing: -.02em; } .app-name { background: none; color: var(--text); -webkit-text-fill-color: currentColor; font-weight: 800; letter-spacing: -.045em; font-size: 22px; } .logo { filter: grayscale(1) contrast(1.6); }'),
    bauhaus: T('Bauhaus', 'light', ['#f1ebdd', '#e8e0cd', '#fbf7ee', '#1a1a1a', '#6a645a', '#1a1a1a', '#d6312a', '#1f4fa3', '#d6312a', '#1f4fa3', '#f2b705', '#2e7d32', '#e8701a', '#d6312a', '#d6312a', '#1f4fa3', '#f2b705'],
      { ...BAUHAUS_POSTER }, bauhausCss(22, 10)),
    // The same poster at night: primaries on warm black, cream ink.
    'bauhaus-night': T('Bauhaus Night', 'dark', ['#14130f', '#1c1b16', '#23211b', '#f1ebdd', '#9a9384', '#d9d1bf', '#e8443a', '#3d6fd6', '#e8443a', '#3d6fd6', '#f5c518', '#43a047', '#ef8a2a', '#e8443a', '#e8443a', '#3d6fd6', '#f5c518'],
      { ...BAUHAUS_POSTER, texture: false }, bauhausCss(22, 10)),
    // Black on paper with one red: the shapes alone tell the types apart.
    'bauhaus-mono': T('Bauhaus Mono', 'light', ['#ecebe7', '#e2e1dc', '#f8f8f6', '#151515', '#6b6b6b', '#151515', '#c8281e', '#151515', '#151515', '#151515', '#151515', '#3d3d3d', '#6b6b6b', '#c8281e', '#151515', '#6b6b6b', '#b5b5b5'],
      { ...BAUHAUS_POSTER, avatars: 'ink', colColor: 'ink' }, bauhausCss(22, 10, '.btn.primary { background: var(--accent-fill); box-shadow: 3px 3px 0 var(--text); }')),
    // Mono, inverted: white geometry on black, red only for danger.
    'bauhaus-noir': T('Bauhaus Noir', 'dark', ['#0e0e0e', '#161616', '#1c1c1c', '#ededea', '#8c8c88', '#ededea', '#ededea', '#8c8c88', '#ededea', '#ededea', '#ededea', '#bdbdbd', '#a0a0a0', '#ff4a3d', '#ededea', '#8c8c88', '#4a4a4a'],
      { ...BAUHAUS_POSTER, texture: false, avatars: 'ink', colColor: 'ink' }, bauhausCss(22, 10, '.btn.primary { background: var(--text); color: var(--bg); box-shadow: none; }')),
    // For work: muted primaries, hairline borders, small shapes — still a circle, a square and a triangle.
    'bauhaus-studio': T('Bauhaus Studio', 'light', ['#f3f2ee', '#eae8e2', '#ffffff', '#1d1f24', '#6b6e76', '#d6d3cb', '#b8402f', '#24407a', '#b8402f', '#24407a', '#c9962a', '#3b7a4a', '#c9772a', '#b8402f', '#b8402f', '#24407a', '#c9962a'],
      { ...BAUHAUS_STUDIO }, bauhausCss(14, 4, STUDIO_CSS)),
    'bauhaus-studio-dark': T('Bauhaus Studio Dark', 'dark', ['#16171b', '#1d1f24', '#23262c', '#e7e6e1', '#8d9099', '#30333b', '#e0584a', '#5b84d6', '#e0584a', '#5b84d6', '#e3b341', '#4caf6e', '#e08a3a', '#e0584a', '#e0584a', '#5b84d6', '#e3b341'],
      { ...BAUHAUS_STUDIO }, bauhausCss(14, 4, STUDIO_CSS)),
    soft: T('Soft', 'light', ['#e6e9ef', '#e6e9ef', '#e6e9ef', '#2d3346', '#7b8196', '#d5d9e2', '#6c63ff', '#00b8a9', '#ef5d7a', '#5b8def', '#f0a93b', '#2bb673', '#f08c3b', '#e5484d', '#e6e9ef', '#e6e9ef', '#e6e9ef'],
      { card: 16, col: 26, modal: 28, ctl: 14, bw: 0, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'glow', enter: 'rise', lanes: 'solid', bg: 'none', texture: false, avatar: 'round', colAlpha: 100 },
      '.column { box-shadow: 10px 10px 24px #c5c9d3, -10px -10px 24px #ffffff; } .card { box-shadow: 6px 6px 14px #c8ccd6, -6px -6px 14px #ffffff; } .card:hover { box-shadow: 2px 2px 6px #c8ccd6, -2px -2px 6px #ffffff; } .card::before { display: none; } .search input, .inp, .dd, .tbox, .seg { background: var(--bg); box-shadow: inset 3px 3px 7px #c8ccd6, inset -3px -3px 7px #ffffff; border-color: transparent; } .pill-btn, .btn:not(.primary) { background: var(--bg); border-color: transparent; box-shadow: 4px 4px 10px #c8ccd6, -4px -4px 10px #ffffff; } .pill-btn:active, .btn:active { box-shadow: inset 3px 3px 7px #c8ccd6, inset -3px -3px 7px #ffffff; } .modal, .drawer { box-shadow: 20px 20px 50px #c5c9d3, -20px -20px 50px #ffffff; } .seg button.on { box-shadow: 3px 3px 6px #c8ccd6, -3px -3px 6px #ffffff; }'),
    dusk: T('Dusk', 'dark', ['#292d36', '#292d36', '#292d36', '#e4e7f0', '#8d93a7', '#343944', '#968fff', '#3fd4c2', '#ff7d95', '#6fa8ff', '#f4b860', '#46cf91', '#f39b5c', '#ff6670', '#292d36', '#292d36', '#292d36'],
      { card: 16, col: 26, modal: 28, ctl: 14, bw: 0, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'glow', enter: 'rise', lanes: 'solid', bg: 'none', texture: false, avatar: 'round', colAlpha: 100 },
      '.column { box-shadow: 10px 10px 24px #1c1f26, -8px -8px 22px #343a46; } .card { box-shadow: 6px 6px 14px #1c1f26, -5px -5px 12px #343a46; } .card:hover { box-shadow: 2px 2px 6px #1c1f26, -2px -2px 6px #343a46; } .card::before { display: none; } .search input, .inp, .dd, .tbox, .seg { background: var(--bg); box-shadow: inset 3px 3px 7px #1c1f26, inset -3px -3px 7px #343a46; border-color: transparent; } .pill-btn, .btn:not(.primary) { background: var(--bg); border-color: transparent; box-shadow: 4px 4px 10px #1c1f26, -4px -4px 10px #343a46; } .pill-btn:active, .btn:active { box-shadow: inset 3px 3px 7px #1c1f26, inset -3px -3px 7px #343a46; } .modal, .drawer { box-shadow: 20px 20px 50px #15171c, -14px -14px 40px #343a46; } .seg button.on { background: var(--bg); box-shadow: 3px 3px 6px #1c1f26, -3px -3px 6px #343a46; } .opt-grid button { background: var(--bg); border-color: transparent; box-shadow: 3px 3px 7px #1c1f26, -3px -3px 7px #343a46; } .opt-grid button.on { box-shadow: inset 3px 3px 7px #1c1f26, inset -3px -3px 7px #343a46; color: var(--accent); } .btn.primary { background: linear-gradient(145deg, #9a93ff, #7a72f0); box-shadow: 4px 4px 10px #1a1c23, -3px -3px 8px #353a47; } .col-name { color: #d9dcf0; }'),
    moss: T('Moss', 'dark', ['#121812', '#182019', '#1e281f', '#e6ecd9', '#8f9c84', '#2b382c', '#a3d16c', '#e2c36b', '#e88a6a', '#7fb6a4', '#e2c36b', '#8fcf6e', '#e0a35a', '#e86a5a', '#2f4a26', '#4a5a1f', '#1f3a33'],
      { card: 18, col: 30, modal: 30, ctl: 14, bw: 1, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'glow', enter: 'rise', lanes: 'solid', chips: 'pill', bg: 'blobs', texture: true, grain: '.11', avatar: 'round', md: 'paper', titleW: 600, display: "'Fraunces'", colAlpha: 88 },
      '.card { border-radius: 28px 14px 30px 12px / 16px 30px 14px 28px; border-color: rgb(163 209 108 / .14); background: radial-gradient(140% 120% at 0% 0%, rgb(163 209 108 / .10), transparent 55%), linear-gradient(165deg, #233024, #1a231b); box-shadow: 0 12px 26px -14px rgb(0 0 0 / .85), inset 0 1px 0 rgb(226 195 107 / .10); } .card:nth-child(3n+2) { border-radius: 14px 30px 16px 26px / 28px 14px 30px 16px; } .card:nth-child(3n) { border-radius: 30px 18px 24px 14px / 14px 26px 18px 30px; } .card:hover { box-shadow: 0 18px 36px -14px rgb(0 0 0 / .9), 0 0 0 1px rgb(163 209 108 / .35), 0 0 30px -10px rgb(163 209 108 / .35); } .column { border-radius: 46px 34px 52px 30px / 34px 52px 30px 46px; border-color: rgb(163 209 108 / .10); background: linear-gradient(180deg, rgb(32 44 30 / .88), rgb(22 30 22 / .82)); } .col-head { border-bottom: 1px dashed rgb(226 195 107 / .18); } .col-name { font-family: var(--display); font-weight: 600; letter-spacing: .01em; color: #e9e2c4; } .app-name { color: #e2c36b; } .btn.primary { background: linear-gradient(140deg, #b5dc7c, #6fae58); color: #10160f; border-radius: 22px 12px 22px 12px; }'),
    clay: T('Clay', 'light', ['#ede2d3', '#e5d6c2', '#f6eee2', '#3b2a22', '#8a7362', '#d8c4ab', '#c2603f', '#6f8f68', '#c2603f', '#5f7f9a', '#d49a3a', '#6f8f68', '#d08a3a', '#b8432e', '#e7b49a', '#c9d3b4', '#f0cf9e'],
      { card: 20, col: 32, modal: 32, ctl: 16, bw: 0, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'outline', enter: 'rise', lanes: 'solid', chips: 'pill', bg: 'blobs', texture: true, grain: '.12', avatar: 'round', md: 'paper', titleW: 600, display: "'Bricolage Grotesque'", colAlpha: 100 },
      '.column { border-radius: 120px 120px 34px 34px / 46px 46px 34px 34px; background: linear-gradient(178deg, #ecdfcd, #e1cfb8); box-shadow: inset 0 3px 0 rgb(255 255 255 / .6), inset 0 -14px 28px -18px rgb(120 70 40 / .3), 0 22px 38px -26px rgb(110 70 40 / .5); } .col-head { padding-top: 26px; justify-content: center; } .col-name { font-weight: 700; color: #6a3a26; } .card { border-radius: 26px 18px 28px 16px / 18px 28px 16px 26px; background: radial-gradient(120% 90% at 20% 0%, #fcf7ef, #f0e3d1); box-shadow: inset 0 1px 0 rgb(255 255 255 / .95), inset 0 -3px 0 rgb(194 96 63 / .10), 0 12px 20px -12px rgb(110 60 30 / .5); } .card:nth-child(2n) { border-radius: 18px 28px 16px 26px / 28px 16px 26px 18px; background: radial-gradient(120% 90% at 80% 0%, #fbf3ea, #ecdcc6); } .card:nth-child(3n) { background: radial-gradient(120% 90% at 30% 0%, #f6f4e8, #e3e2cf); } .card:hover { box-shadow: inset 0 1px 0 #fff, inset 0 -3px 0 rgb(194 96 63 / .18), 0 18px 28px -14px rgb(110 60 30 / .55); } .search input, .inp, .tbox { background: #f3e9db; box-shadow: inset 0 2px 5px rgb(120 70 40 / .16); border-color: transparent; } .btn.primary { background: linear-gradient(150deg, #d27a56, #b3532f); border-radius: 999px; box-shadow: inset 0 1px 0 rgb(255 255 255 / .3), 0 6px 14px -6px rgb(160 70 40 / .6); } .app-name { color: #b3532f; }'),
    tide: T('Tide', 'light', ['#e4eef0', '#d6e6e9', '#f4fafa', '#173b44', '#5f8088', '#c3d9dd', '#0f7a86', '#ff7f6b', '#ff7f6b', '#2f8fb8', '#e8b04a', '#2fae8f', '#f09a4a', '#e35a4f', '#a8dde0', '#ffd1c4', '#c7e7d9'],
      { card: 22, col: 28, modal: 28, ctl: 14, bw: 1, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'glow', enter: 'rise', lanes: 'glass', chips: 'pill', bg: 'mesh', texture: false, avatar: 'round', md: 'clean', titleW: 600, display: "'Outfit'", colAlpha: 62 },
      '.column { border-radius: 34px; border-color: rgb(255 255 255 / .75); box-shadow: 0 22px 44px -30px rgb(15 90 100 / .5); } .col-head { position: relative; } .col-head::after { content: ""; position: absolute; left: 14px; right: 14px; bottom: -6px; height: 9px; background: radial-gradient(circle at 8px -3px, transparent 7px, var(--col, var(--accent)) 7.5px, var(--col, var(--accent)) 9px, transparent 9.5px) 0 0 / 16px 9px repeat-x; opacity: .55; } .card { border-radius: 26px 26px 26px 6px; border-color: rgb(255 255 255 / .95); background: linear-gradient(170deg, rgb(255 255 255 / .95), rgb(232 246 246 / .88)); box-shadow: 0 10px 22px -12px rgb(15 90 100 / .45), inset 0 -2px 0 rgb(15 122 134 / .08); } .card:nth-child(2n) { border-radius: 26px 26px 6px 26px; } .card:hover { box-shadow: 0 16px 30px -12px rgb(15 90 100 / .5), 0 0 0 1px rgb(15 122 134 / .3); } .btn.primary { background: linear-gradient(135deg, #0f7a86, #2f8fb8); border-radius: 999px; } .app-name { color: #0f7a86; }'),
    bloom: T('Bloom', 'dark', ['#170f1c', '#1f1526', '#271b30', '#f3e8f4', '#a08aa8', '#3a2a44', '#e58ad6', '#f6c453', '#ff7a9a', '#9d8cff', '#f6c453', '#7fd6a0', '#f2a05c', '#ff5f7e', '#5b1e5a', '#3a1d63', '#6b4a12'],
      { card: 22, col: 32, modal: 32, ctl: 14, bw: 1, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'orbit', enter: 'zoom', lanes: 'glass', chips: 'pill', bg: 'blobs', texture: true, avatar: 'round', md: 'clean', titleW: 600, display: "'Fraunces'", colAlpha: 70 },
      '.card { border-radius: 34px 6px 34px 6px; border-color: rgb(229 138 214 / .18); background: radial-gradient(120% 100% at 100% 0%, rgb(229 138 214 / .14), transparent 60%), linear-gradient(150deg, #2e2038, #231a2b); box-shadow: 0 14px 28px -16px rgb(0 0 0 / .85); } .card:nth-child(2n) { border-radius: 6px 34px 6px 34px; background: radial-gradient(120% 100% at 0% 0%, rgb(246 196 83 / .10), transparent 60%), linear-gradient(150deg, #2e2038, #231a2b); } .card:hover { box-shadow: 0 20px 40px -16px rgb(229 138 214 / .45), 0 0 0 1px rgb(246 196 83 / .3); } .column { border-radius: 90px 90px 30px 30px / 60px 60px 30px 30px; border-color: rgb(229 138 214 / .14); background: linear-gradient(180deg, rgb(58 30 70 / .55), rgb(31 21 38 / .7)); } .col-head { padding-top: 22px; justify-content: center; } .col-name { font-family: var(--display); font-style: italic; font-weight: 600; } .app-name { background: linear-gradient(90deg, #e58ad6, #f6c453); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; } .btn.primary { background: linear-gradient(135deg, #e58ad6, #b56ae0); color: #1b0f20; border-radius: 18px 4px 18px 4px; } .group { --g-r: calc(34px + var(--gi)) calc(6px + var(--gi)); --cover-r: 34px 6px; --tab-x: 30px; } .group-cards > .card, .group-cards > .card:nth-child(2n) { border-radius: 34px 6px; }'),
    cloud: T('Cloud', 'light', ['#f1efea', '#ebe8e1', '#fbfaf7', '#2f2d35', '#8b8792', '#e3dfd7', '#8d82d6', '#e39aa6', '#e2898c', '#7fa6d6', '#dfb465', '#78b692', '#e0a36c', '#d66f6e', '#ddd7f6', '#f7d9de', '#d3ebde'],
      { card: 18, col: 26, modal: 28, ctl: 14, bw: 1, cards: 'elevated', typeInd: 'dot', tape: 'none', attn: 'glow', enter: 'rise', lanes: 'solid', chips: 'pill', bg: 'blobs', texture: false, md: 'clean', avStyle: 'tint', titleW: 600, display: "'Outfit'", colAlpha: 100 },
      '.column { background: linear-gradient(180deg, #edeae3, #e8e4dc); border-color: transparent; } .card { padding: 14px 15px 12px; } .group { --cpx: 15px; } .c-title { font-size: 14.5px; letter-spacing: -.005em; } .col-name { font-size: 15px; font-weight: 600; letter-spacing: -.01em; } .btn.primary { background: #2f2d35; color: #fbfaf7; } .app-name { color: #2f2d35; }'),
    liquid: T('Liquid', 'light', ['#dfe6f6', '#ffffff', '#ffffff', '#111733', '#5a6482', '#cdd6ec', '#3d6bff', '#ff5aa6', '#ff5d73', '#3d6bff', '#ffb020', '#22c08a', '#ff8a3d', '#ef4058', '#7aa0ff', '#ff9bd2', '#7cf0d6'],
      { card: 18, col: 28, modal: 30, ctl: 14, bw: 1, cards: 'glass', typeInd: 'dot', tape: 'none', attn: 'glow', enter: 'zoom', lanes: 'glass', chips: 'pill', bg: 'mesh', texture: false, md: 'clean', avStyle: 'gem', titleW: 600, display: "'Outfit'", colAlpha: 40 },
      '.column, .card, .modal, .drawer, .pill-btn, .search input { box-shadow: inset 0 1px 0 rgb(255 255 255 / .9), inset 0 0 0 1px rgb(255 255 255 / .35), 0 18px 40px -26px rgb(30 50 140 / .45); } .modal, .drawer { background: rgb(255 255 255 / .72); -webkit-backdrop-filter: blur(24px) saturate(1.5); backdrop-filter: blur(24px) saturate(1.5); } .pill-btn { background: rgb(255 255 255 / .55); } .btn.primary { background: linear-gradient(180deg, #5a83ff, #2f5cf5); border-radius: 999px; box-shadow: inset 0 1px 0 rgb(255 255 255 / .45), 0 8px 18px -8px rgb(47 92 245 / .6); } .app-name { background: linear-gradient(90deg, #3d6bff, #ff5aa6); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }'),
    pop: T('Pop', 'light', ['#fff5e4', '#ffffff', '#ffffff', '#141414', '#5b5550', '#141414', '#ff4f8b', '#2bb5ff', '#ff5a5a', '#4d78ff', '#ffc21f', '#19b36b', '#ff8a1f', '#ff3b3b', '#ffd6e5', '#cdeeff', '#fff0b8'],
      { card: 12, col: 18, modal: 18, ctl: 12, bw: 2, shadow: 'hard', cards: 'clean', typeInd: 'top', tape: 'none', attn: 'ribbon', enter: 'pop', lanes: 'solid', chips: 'tag', heads: 'caps', bg: 'confetti', texture: false, md: 'grid', avStyle: 'stamp', titleW: 700, font: "'Space Grotesk'", display: "'Space Grotesk'", colAlpha: 100 },
      '.column { border: 2.5px solid #141414; box-shadow: 5px 5px 0 #141414; } .column:nth-child(5n+1) { background: #ffd9e6; } .column:nth-child(5n+2) { background: #d4efff; } .column:nth-child(5n+3) { background: #fff1b8; } .column:nth-child(5n+4) { background: #dcf5e3; } .column:nth-child(5n) { background: #e9e0ff; } .card { border: 2px solid #141414; box-shadow: 3px 3px 0 #141414; transition: translate .15s, box-shadow .15s; } .card:hover { translate: -2px -2px; box-shadow: 5px 5px 0 #141414; } .pill-btn, .search input, .btn { border: 2px solid #141414; box-shadow: 2px 2px 0 #141414; } .btn.primary { background: #ff4f8b; color: #141414; } .chip { border: 1.5px solid #141414; } .app-name { color: #141414; font-weight: 800; }'),
    aqua: T('Aqua', 'light', ['#dde6ef', '#eef3f8', '#ffffff', '#1d2b3a', '#5f7286', '#b9c8d8', '#1f86ff', '#7cc63d', '#ff5266', '#1f86ff', '#ffaa1f', '#4fb83a', '#ff8a2a', '#e8394f', '#bfe2ff', '#d8f5c4', '#e8dcff'],
      { card: 12, col: 16, modal: 18, ctl: 10, bw: 1, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'outline', enter: 'pop', lanes: 'solid', chips: 'pill', bg: 'none', texture: false, md: 'clean', avStyle: 'gem', titleW: 600, display: "'Outfit'", colAlpha: 100 },
      '.bg-layer { background: repeating-linear-gradient(0deg, #e6edf4 0 2px, #f2f6fa 2px 4px); } .pill-btn, .btn { border-radius: 999px; } .column { background: linear-gradient(180deg, #f7fafd, #e9f0f7); border: 1px solid #b6c6d8; box-shadow: inset 0 1px 0 #fff, 0 10px 24px -16px rgb(40 70 110 / .5); } .col-head { margin: 6px 6px 8px; padding: 9px 12px; border-radius: 10px; background: linear-gradient(180deg, #ffffff 0%, #e4eef8 49%, #d3e2f2 50%, #e8f1fa 100%); border: 1px solid #b6c6d8; box-shadow: inset 0 1px 0 #fff; } .card { background: linear-gradient(180deg, #ffffff 0%, #fbfdff 48%, #f2f7fc 52%, #ffffff 100%); border-color: #c4d2e1; box-shadow: inset 0 1px 0 #fff, 0 4px 10px -6px rgb(40 70 110 / .45); } .btn.primary { background: linear-gradient(180deg, #b9e1ff 0%, #4aa6ff 48%, #1f86ff 52%, #7cc7ff 100%); border: 1px solid #1b63c4; color: #fff; text-shadow: 0 -1px 0 rgb(0 40 100 / .4); box-shadow: inset 0 1px 0 rgb(255 255 255 / .6), 0 3px 8px -3px rgb(20 90 200 / .6); } .pill-btn { background: linear-gradient(180deg, #ffffff, #e3ebf4); border-color: #b6c6d8; } .app-name { color: #1f86ff; text-shadow: 0 1px 0 #fff; }'),
    iridescent: T('Iridescent', 'dark', ['#07070b', '#0e0e15', '#13131c', '#f1f0ff', '#8d8ba8', '#24233a', '#c084fc', '#5eead4', '#fb7185', '#60a5fa', '#fcd34d', '#4ade80', '#fb923c', '#f43f5e', '#7c3aed', '#06b6d4', '#ec4899'],
      { card: 14, col: 20, modal: 22, ctl: 12, cards: 'clean', typeInd: 'dot', tape: 'none', attn: 'orbit', enter: 'zoom', lanes: 'outline', chips: 'outline', bg: 'aurora', texture: true },
      '.card { border: 1px solid transparent; background: linear-gradient(var(--surface), var(--surface)) padding-box, conic-gradient(from 210deg, #c084fc, #5eead4, #60a5fa, #f472b6, #fcd34d, #c084fc) border-box; } .card:hover { box-shadow: 0 18px 40px -16px rgb(192 132 252 / .5), 0 0 24px -10px rgb(94 234 212 / .5); } .column { border-color: rgb(255 255 255 / .07); background: rgb(14 14 21 / .55); } .app-name { background: linear-gradient(90deg, #c084fc, #5eead4, #f472b6); -webkit-background-clip: text; background-clip: text; } .btn.primary { background: linear-gradient(120deg, #c084fc, #60a5fa, #5eead4); }'),
    riso: T('Riso', 'light', ['#f5f0e6', '#efe8da', '#fbf8f1', '#1d2b6b', '#5c6aa3', '#1d2b6b', '#ff48b0', '#0078bf', '#ff48b0', '#0078bf', '#ffe800', '#00a95c', '#ff6c2f', '#ff48b0', '#ff48b0', '#0078bf', '#ffe800'],
      { md: 'paper', card: 4, col: 6, modal: 8, ctl: 6, bw: 2, shadow: 'hard', cards: 'clean', typeInd: 'tint', tape: 'none', attn: 'ribbon', enter: 'pop', lanes: 'outline', chips: 'tag', heads: 'caps', bg: 'halftone', texture: true, grain: '.4', titleW: 700, font: "'Bricolage Grotesque'", display: "'Bricolage Grotesque'" },
      '.card { --card-line: var(--text); box-shadow: 3px 3px 0 var(--accent); } .card:hover { box-shadow: 5px 5px 0 var(--accent), -2px -2px 0 color-mix(in oklab, var(--accent-2) 70%, transparent); } .c-title { text-shadow: 1.5px 1px 0 color-mix(in oklab, var(--accent) 50%, transparent); } .col-name { color: var(--accent-2); text-shadow: 2px 1px 0 color-mix(in oklab, var(--accent) 60%, transparent); } .column { box-shadow: 6px 6px 0 color-mix(in oklab, var(--accent-2) 28%, transparent); } .app-name { background: none; color: var(--accent-2); -webkit-text-fill-color: currentColor; text-shadow: 2px 1.5px 0 var(--accent); } .btn.primary { background: var(--accent-fill); box-shadow: 3px 3px 0 var(--accent-2); }'),
  };
  // Each theme's avatar look (kept in one table so the set reads as a whole).
  const AV_STYLE = {
    intellagent: 'gem', daylight: 'tint', dracula: 'flat', nord: 'tint', mocha: 'tint', latte: 'tint', tokyo: 'ring', gruvbox: 'flat',
    solarized: 'tint', github: 'flat', slate: 'tint', graphite: 'ring', midnight: 'ring', paper: 'ring', brutalist: 'stamp', cork: 'flat',
    blueprint: 'ring', vision: 'gem', phosphor: 'ring', swiss: 'flat', bauhaus: 'flat', soft: 'pebble', dusk: 'pebble', moss: 'pebble',
    'bauhaus-night': 'flat', 'bauhaus-mono': 'flat', 'bauhaus-noir': 'flat', 'bauhaus-studio': 'tint', 'bauhaus-studio-dark': 'tint',
    clay: 'pebble', tide: 'tint', bloom: 'gem', iridescent: 'gem', riso: 'stamp',
  };
  for (const [k, v] of Object.entries(AV_STYLE)) if (THEMES[k]) THEMES[k].style.avStyle ??= v;
  // …and what a column does when a ticket is dragged over it.
  const DROP_STYLE = {
    vision: 'tint', tide: 'tint', iridescent: 'tint', liquid: 'tint', cloud: 'tint', daylight: 'tint', latte: 'tint',
    soft: 'lift', dusk: 'lift', clay: 'lift', pop: 'lift', brutalist: 'lift', bauhaus: 'lift', riso: 'lift', aqua: 'lift',
    'bauhaus-night': 'lift', 'bauhaus-mono': 'lift', 'bauhaus-noir': 'lift', 'bauhaus-studio': 'dashed', 'bauhaus-studio-dark': 'dashed',
    blueprint: 'dashed', phosphor: 'dashed', swiss: 'dashed', paper: 'dashed', graphite: 'dashed',
    moss: 'spotlight', midnight: 'spotlight', tokyo: 'spotlight', slate: 'spotlight',
    bloom: 'pulse', dracula: 'pulse', mocha: 'pulse', cork: 'pulse',
  };
  for (const [k, v] of Object.entries(DROP_STYLE)) if (THEMES[k]) THEMES[k].style.drop ??= v;
  // …and how tickets sharing a parent are drawn (tray unless named here). Paper and soft themes file them behind a
  // cover card (an index divider) or under folder tabs,
  // grid themes set the label on a spine, crisp product themes use a ruled header, bold/neon ones a coloured rail.
  const GROUP_LOOK = {
    paper: 'cover', cork: 'cover', clay: 'cover', cloud: 'cover', riso: 'tab', solarized: 'tab',
    swiss: 'spine', bauhaus: 'spine', brutalist: 'spine',
    'bauhaus-night': 'spine', 'bauhaus-mono': 'spine', 'bauhaus-noir': 'spine', 'bauhaus-studio': 'rule', 'bauhaus-studio-dark': 'rule',
    phosphor: 'foot', blueprint: 'foot',
    github: 'rule', slate: 'rule', graphite: 'rule', midnight: 'rule', nord: 'rule',
    dracula: 'rail', tokyo: 'rail', synthwave: 'rail', gruvbox: 'rail', pop: 'rail', iridescent: 'rail',
  };
  for (const [k, v] of Object.entries(GROUP_LOOK)) if (THEMES[k]) THEMES[k].style.groups ??= v;
  // …and the kind it is listed under in Appearance (INT-222): pick a kind, then a theme. Every theme is in one.
  const THEME_KINDS = [
    ['bauhaus', 'Bauhaus', ['bauhaus-studio', 'bauhaus-studio-dark', 'bauhaus', 'bauhaus-night', 'bauhaus-mono', 'bauhaus-noir']],
    ['product', 'Product', ['intellagent', 'daylight', 'slate', 'graphite', 'midnight']],
    ['editor', 'Editor classics', ['github', 'solarized', 'latte', 'nord', 'dracula', 'mocha', 'tokyo', 'gruvbox', 'rosepine']],
    ['soft', 'Soft & organic', ['cloud', 'soft', 'clay', 'tide', 'dusk', 'moss', 'bloom']],
    ['print', 'Print & retro', ['paper', 'swiss', 'brutalist', 'riso', 'pop', 'cork', 'aqua', 'blueprint', 'phosphor']],
    ['glass', 'Glass & neon', ['vision', 'liquid', 'iridescent', 'synthwave']],
  ];
  const themeKind = (k) => THEME_KINDS.find(([, , keys]) => keys.includes(k))?.[0] || THEME_KINDS[0][0];
  // Organic themes lean on their colour fields: let the background blobs come through more.
  for (const [k, o] of [['moss', '.62'], ['clay', '.7'], ['tide', '.75'], ['bloom', '.6'], ['cloud', '.8'], ['liquid', '.95']]) if (THEMES[k]) THEMES[k].vars['fx-o'] = o;
  // Blueprint's contours are drawn in one ink, like the sheet itself (index lines in its text white, not gold).
  THEMES.blueprint.vars['topo-index'] = THEMES.blueprint.vars.text;
  // Text on accent fills reaches 4.5:1. White where it does; in a dark theme, else its background ink (a pale accent
  // reads far better with ink); else the fill (--accent-fill) is deepened toward the theme's ink until white reads.
  // --accent itself is untouched, so links, rings and tints keep the theme's colour.
  for (const t of Object.values(THEMES)) {
    const v = t.vars, ink = luminance(v.bg) < luminance(v.text) ? v.bg : v.text;
    if (contrast('#fff', v.accent) >= 4.5) continue;
    else if (t.mode === 'dark' && contrast(ink, v.accent) >= 4.5) v['on-accent'] = ink;
    else for (let i = 1; i <= 50 && contrast('#fff', v['accent-fill']) < 4.5; i++) v['accent-fill'] = mixHex(v.accent, ink, i / 50);
  }
  // Group (parent) colours, --tag-0…7, come from the theme's own palette: in this order, each that shows on the
  // card surface (moved toward the text until it reaches 3:1, as any non-text mark must) and differs clearly from
  // those already taken. A narrow palette adds deeper shades of what it has while they still differ; then repeats.
  const TAG_SRC = ['accent', 'accent-2', 'task', 'spike', 'ok', 'issue', 'warn', 'blob1', 'blob2', 'blob3', 'danger'];
  // Text tinted by a group colour (app.css): [variable, usual share of the tag in the text, share in its ground,
  // ground]. A theme whose colours can't carry the usual share at 4.5:1 gets a smaller one, never a duller colour.
  const TAG_TEXT = [['tag-cover', 42, 9, 'surface'], ['tag-tab', 40, 14, 'surface'], ['tag-chip', 55, 17, 'surface'], ['tag-head', 50, 0, 'panel']];
  const shows = (c, v) => { for (let i = 1; i <= 100 && contrast(c, v.surface) < 3; i++) c = mixHex(c, v.text, 0.02); return c; };
  const apart = (x, y) => Math.hypot(...oklab(x).map((c, i) => c - oklab(y)[i]));
  // Worked out when a theme is first shown (about 1 ms), not for every theme at load: { tags, shares }.
  const themeGroups = (t) => t.groupColours ??= (() => {
    const v = t.vars, tags = [];
    const add = (c, d) => tags.length < 8 && tags.every((x) => apart(x, c) > d) && tags.push(c);
    for (const k of TAG_SRC) if (contrast(v[k], v.surface) >= 1.6) add(shows(v[k], v), 0.1);
    if (!tags.length) tags.push(shows(v.accent, v));
    // a shade has to differ more than a hue does to be told apart at the size of a dot
    for (const p of [0.35, 0.6]) for (const c of [...tags]) add(shows(mixHex(c, v.text, p), v), 0.16);
    const count = tags.length; // slots are dealt over this many; the rest repeat so no old theme's colour lingers
    for (let i = 0; tags.length < 8; i++) tags.push(tags[i]);
    const shares = {};
    for (const [key, usual, inGround, ground] of TAG_TEXT) {
      let s = usual;
      while (s > 0 && tags.some((c) => contrast(mixOklab(c, s / 100, v.text), mixOklab(c, inGround / 100, v[ground])) < 4.5)) s -= 5;
      shares[key] = Math.max(0, s);
    }
    return { tags, count, shares };
  })();
  // Strength of each generated pattern, multiplying --fx-o. The one source: the board gets it as --fx-k (applySettings),
  // the Background tiles use it directly. `<kind>-<mode>` overrides a kind in light or dark themes.
  const FXK = { topo: 1.05, squiggles: 0.62, doodles: 0.7, confetti: 1.3, halftone: 0.7, 'halftone-light': 0.55 };
  const fxk = (kind, mode) => FXK[`${kind}-${mode}`] ?? FXK[kind] ?? 1;
  const BACKGROUNDS = [['blobs', 'Blobs'], ['aurora', 'Aurora'], ['mesh', 'Mesh'], ['stars', 'Stars'], ['topo', 'Topo'], ['halftone', 'Halftone'], ['squiggles', 'Squiggles'], ['doodles', 'Doodles'], ['confetti', 'Confetti'], ['none', 'None']];
  // The default, and the fallback for a missing or unknown theme: Bauhaus Studio, or its dark twin.
  const BASE_THEME = matchMedia('(prefers-color-scheme: light)').matches ? 'bauhaus-studio' : 'bauhaus-studio-dark';
  const themeStyle = () => ({ ...STYLE, ...(THEMES[settings.theme] || THEMES[BASE_THEME]).style });
  // A user setting of "theme" (or unset) defers to the theme's own choice.
  const pick = (k) => (settings[k] != null && settings[k] !== 'theme' ? settings[k] : themeStyle()[k]);

  // The only place that touches localStorage: a missing or unreadable value gives the fallback, and a failed write is dropped.
  // `raw` keeps a plain string (the token) as it is instead of JSON.
  const stored = (key, fallback, raw = false) => ({
    get() {
      try { return (raw ? localStorage.getItem(key) : JSON.parse(localStorage.getItem(key))) || fallback; } catch { return fallback; }
    },
    save(value) {
      try { localStorage.setItem(key, raw ? value : JSON.stringify(value)); } catch { /* private mode */ }
    },
  });

  const KEY = 'intellagent.settings.v1';
  const settingsStore = stored(KEY, {});
  const DEFAULTS = {
    theme: BASE_THEME,
    v3: true, bg: 'theme', cards: 'theme', tape: 'theme', attn: 'theme', enter: 'theme', lanes: 'theme', texture: 'theme', md: 'theme', avStyle: 'theme', drop: 'theme', groups: 'theme',
    density: 'cozy', colw: 300, ageDays: '7',
    motion: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full',
    stub: { id: true, type: true, priority: true, parent: true, author: true, lease: true, comments: true, attachments: true, blocked: true, properties: false, description: false, thumbnail: true, fields: true, assignee: true, status: true, checklist: true, listeners: true },
    grouping: 'stack', saveMode: 'accept', userName: 'You', notify: false, notifyHidden: true, sound: false, toasts: true,
    metrics: true, metricsDays: 7,
  };
  function loadSettings() {
    try {
      const s = settingsStore.get();
      if (!s.v2) { if (s.cards === 'sticky') s.cards = 'theme'; s.v2 = true; }
      if (!s.v3) { s.bg = 'theme'; s.texture = 'theme'; s.v3 = true; } // themes now pick background + texture
      return { ...DEFAULTS, ...s, stub: { ...DEFAULTS.stub, ...(s.stub || {}) } };
    } catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
  }
  let settings = loadSettings();
  let settingsVersion = 0;
  function saveSettings() {
    settingsStore.save(settings);
    settingsVersion++;
    applySettings();
    render();
  }
  function applySettings() {
    const t = THEMES[settings.theme] || THEMES[BASE_THEME];
    const st = themeStyle();
    const r = document.documentElement;
    for (const [k, v] of Object.entries(t.vars)) r.style.setProperty(`--${k}`, v);
    const groups = themeGroups(t);
    groups.tags.forEach((c, i) => r.style.setProperty(`--tag-${i}`, c));
    for (const [k, s] of Object.entries(groups.shares)) r.style.setProperty(`--${k}`, `${s}%`);
    for (const [k, v] of [['--r-card', st.card], ['--r-col', st.col], ['--r-modal', st.modal], ['--r-ctl', st.ctl], ['--bw', st.bw]]) r.style.setProperty(k, `${v}px`);
    r.style.setProperty('--col-alpha', `${st.colAlpha}%`);
    r.style.setProperty('--title-w', st.titleW);
    if (st.grain) r.style.setProperty('--grain', st.grain);
    if (st.font) r.style.setProperty('--font', `${st.font}, system-ui, -apple-system, 'Segoe UI', sans-serif`); else r.style.removeProperty('--font');
    if (st.display) r.style.setProperty('--display', `${st.display}, var(--font)`); else r.style.removeProperty('--display');
    Object.assign(r.dataset, {
      theme: settings.theme in THEMES ? settings.theme : BASE_THEME, mode: t.mode, glow: t.glow ? '1' : '',
      shadow: st.shadow, typeind: st.typeInd, chips: st.chips, heads: st.heads, avatar: st.avatar,
      tape: pick('tape'), cards: pick('cards'), attn: pick('attn'), enter: pick('enter'), lanes: pick('lanes'), bg: pick('bg'), md: pick('md'), avstyle: pick('avStyle'), drop: pick('drop'), groups: pick('groups'),
      density: settings.density,
    });
    r.style.setProperty('--fx-k', fxk(r.dataset.bg, t.mode));
    const texture = settings.texture === 'theme' || settings.texture == null ? st.texture : settings.texture === 'on' || settings.texture === true;
    r.classList.toggle('no-texture', !texture);
    r.classList.toggle('reduced', reduced());
    r.style.setProperty('--colw', `${settings.colw}px`);
    const corner = st.corner ?? (pick('tape') === 'corner' ? 16 : 0);
    r.style.setProperty('--corner', `${corner}px`);
    r.dataset.avatars = st.avatars;
    r.dataset.colcolor = st.colColor;
    let css = $('#theme-css');
    if (!css) { css = document.createElement('style'); css.id = 'theme-css'; document.head.append(css); }
    css.textContent = t.css ? `:root[data-theme="${r.dataset.theme}"] { } ${t.css.replace(/(^|\})\s*([^{}]+)\{/g, (m, b, sel) => `${b} ${sel.split(',').map((x) => `:root[data-theme="${r.dataset.theme}"] ${x.trim()}`).join(', ')} {`)}` : '';
    let meta = $('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.append(meta); }
    meta.content = t.vars.bg;
    stars.sync(); art.sync();
  }
  function switchTheme(name, x = innerWidth / 2, y = 0, after = null) {
    const apply = () => { settings.theme = name; saveSettings(); after?.(); };
    if (!document.startViewTransition || reduced()) { apply(); return; }
    // The new snapshot starts as a zero-size circle (CSS), so nothing flashes before the reveal begins.
    const root = document.documentElement;
    root.style.setProperty('--vt-x', `${x}px`);
    root.style.setProperty('--vt-y', `${y}px`);
    root.classList.add('theme-reveal');
    const vt = document.startViewTransition(apply);
    vt.finished.finally(() => root.classList.remove('theme-reveal'));
    vt.ready.then(() => {
      const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      document.documentElement.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 700, easing: 'cubic-bezier(.6,0,.2,1)', fill: 'forwards', pseudoElement: '::view-transition-new(root)' });
    }).catch(() => {});
  }

  /* ─── at rest: the board is in the background (another window has focus, or the tab is hidden) or nobody has
     touched it for a minute. Every animation that loops forever (the drifting backgrounds, pulsing dots, spinning
     rings, the starfield) stands still, so the graphics card has nothing to redraw; one-off animations (a toast, a
     card arriving) still play. The next touch, key or focus brings the movement back. ─── */
  const rest = (() => {
    const AFTER_MS = 60_000;
    const held = new Set();
    let on = false, idle = 0, again = 0, sweep = 0;
    const loops = () => document.getAnimations().filter((a) => a.effect?.getTiming?.().iterations === Infinity);
    const hold = () => { for (const a of loops()) if (a.playState === 'running') { a.pause(); held.add(a); } };
    const set = (v) => {
      if (v === on) return;
      on = v;
      document.documentElement.toggleAttribute('data-rest', on);
      // hold the loops now, and every few seconds again for any whose start event a background tab never got
      if (on) { hold(); sweep = setInterval(hold, 5000); return; }
      clearInterval(sweep);
      for (const a of held) { try { a.play(); } catch { /* gone with its element */ } }
      held.clear();
      document.dispatchEvent(new Event('intellagent:wake'));
    };
    const away = () => document.hidden || !document.hasFocus();
    const touch = () => {
      clearTimeout(idle);
      if (away()) { set(true); return; }
      set(false);
      idle = setTimeout(() => set(true), AFTER_MS);
    };
    for (const t of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'focus']) addEventListener(t, touch, { passive: true });
    addEventListener('blur', () => { clearTimeout(idle); set(true); });
    document.addEventListener('visibilitychange', touch);
    // a loop that starts while at rest (a new card that needs you, an agent starting a run, a background switched on) stands still too
    document.addEventListener('animationstart', () => { if (on) { clearTimeout(again); again = setTimeout(hold, 120); } });
    setTimeout(touch, 0);
    return {
      get on() { return on; },
      settle() { if (on) { clearTimeout(again); again = setTimeout(hold, 120); } },
    };
  })();

  /* ─── starfield (canvas) ─── */
  const stars = (() => {
    let cv = null;
    let ctx = null;
    let pts = [];
    let raf = 0;
    let cols = ['#fff', '#fff', '#fff'];
    let mx = 0;
    let my = 0;
    let last = 0;
    const seed = () => {
      const n = Math.min(280, Math.round((innerWidth * innerHeight) / 6500));
      pts = Array.from({ length: n }, () => ({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, z: Math.random() ** 1.7 * 0.9 + 0.1, t: Math.random() * 6.28, c: Math.random() < 0.2 }));
    };
    const resize = () => {
      if (!cv) return;
      const d = devicePixelRatio || 1;
      cv.width = innerWidth * d; cv.height = innerHeight * d;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      seed();
      if (!raf) frame();
    };
    // Capped at 30 fps (a slow drift loses nothing, and it halves the cost; a quarter on 120 Hz screens).
    // Steps are scaled by the time elapsed, in 60 fps units, so the speed is the same at any refresh rate.
    const frame = (now = performance.now()) => {
      raf = 0;
      if (!cv) return;
      const move = !reduced() && !document.hidden && !document.documentElement.hasAttribute('data-rest');
      if (move && last && now - last < 1000 / 30 - 2) { raf = requestAnimationFrame(frame); return; }
      const k = move && last ? Math.min(4, (now - last) / (1000 / 60)) : 0;
      last = move ? now : 0;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      const light = document.documentElement.dataset.mode === 'light';
      for (const p of pts) {
        if (move) {
          p.y -= p.z * 0.14 * k; p.x += p.z * 0.05 * k; p.t += 0.025 * p.z * k;
          if (p.y < -4) { p.y = innerHeight + 4; p.x = Math.random() * innerWidth; }
          if (p.x > innerWidth + 4) p.x = -4;
        }
        ctx.globalAlpha = (0.3 + 0.7 * (0.5 + 0.5 * Math.sin(p.t))) * p.z * (light ? 0.55 : 0.95);
        ctx.fillStyle = p.c ? (p.z > 0.55 ? cols[1] : cols[2]) : cols[0];
        ctx.beginPath();
        ctx.arc(p.x + mx * p.z * 16, p.y + my * p.z * 16, p.z * 1.7, 0, 6.283);
        ctx.fill();
      }
      if (move && document.documentElement.dataset.bg === 'stars') raf = requestAnimationFrame(frame); else last = 0;
    };
    addEventListener('resize', resize);
    addEventListener('pointermove', (e) => { mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5; });
    const wake = () => { if (!document.hidden && document.documentElement.dataset.bg === 'stars' && !raf) frame(); };
    document.addEventListener('visibilitychange', wake);
    document.addEventListener('intellagent:wake', wake);
    return {
      sync() {
        const on = document.documentElement.dataset.bg === 'stars';
        if (!cv) { cv = document.getElementById('stars'); if (!cv) return; ctx = cv.getContext('2d'); }
        if (!on) { cancelAnimationFrame(raf); raf = 0; last = 0; ctx.clearRect(0, 0, cv.width, cv.height); return; }
        const cs = getComputedStyle(document.documentElement);
        cols = [cs.getPropertyValue('--text').trim(), cs.getPropertyValue('--accent').trim(), cs.getPropertyValue('--accent-2').trim()];
        if (!pts.length) resize();
        cancelAnimationFrame(raf); raf = 0; frame();
      },
    };
  })();

  /* ─── generated art: topo · squiggles · doodles · confetti · halftone ───
     Drawn once per theme/size onto one canvas, never tiled: a seeded noise field decides where marks
     cluster and where the board gets quiet, so nothing reads as wallpaper. Motion is a slow compositor drift (CSS). */
  const art = (() => {
    const KINDS = ['topo', 'squiggles', 'doodles', 'confetti', 'halftone'];
    const M = 60; // canvas overhang each side, room for the drift
    const hash = (x, y, s) => { let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1274126177)) | 0; h = Math.imul(h ^ (h >>> 13), 1103515245); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
    const vn = (x, y, s) => {
      const xi = Math.floor(x), yi = Math.floor(y), u0 = x - xi, v0 = y - yi;
      const u = u0 * u0 * u0 * (u0 * (u0 * 6 - 15) + 10), v = v0 * v0 * v0 * (v0 * (v0 * 6 - 15) + 10);
      const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };
    const fbm = (x, y, s, o = 3) => { // octaves rotated ~37° so the lattice never shows
      let t = 0, a = 0.5, n = 0;
      for (let i = 0; i < o; i++) { t += a * vn(x, y, s + i * 31); n += a; [x, y] = [(x * 0.8 - y * 0.6) * 2.02, (x * 0.6 + y * 0.8) * 2.02]; a *= 0.5; }
      return t / n;
    };
    const rng = (s) => () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const pickW = (r, list) => { let x = r() * list.reduce((n, [, w]) => n + w, 0); for (const [v, w] of list) if ((x -= w) <= 0) return v; return list[0][0]; };

    // contour lines of a domain-warped noise field; every fifth line is an index contour
    function topo(ctx, W, H, k, c) {
      const cell = 6 * Math.max(0.6, k), nx = Math.ceil(W / cell) + 1, ny = Math.ceil(H / cell) + 1, f = new Float32Array(nx * ny), sc = 1 / (500 * k);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const x = i * cell * sc, y = j * cell * sc;
        f[j * nx + i] = fbm(x + 0.9 * fbm(x + 3.1, y + 7.7, 5, 2), y + 0.9 * fbm(x + 8.3, y + 1.9, 9, 2), 2, 4);
      }
      const step = 0.028, paths = [new Path2D(), new Path2D()];
      const E = (e, x, y, a, b, cc, d, L) => { // edge crossing point: 0 top, 1 right, 2 bottom, 3 left
        const t = (p, q) => (L - p) / (q - p);
        return e === 0 ? [x + t(a, b) * cell, y] : e === 1 ? [x + cell, y + t(b, cc) * cell] : e === 2 ? [x + t(d, cc) * cell, y + cell] : [x, y + t(a, d) * cell];
      };
      const SEG = [[], [[3, 2]], [[2, 1]], [[3, 1]], [[0, 1]], [[3, 0], [2, 1]], [[0, 2]], [[3, 0]], [[3, 0]], [[0, 2]], [[0, 1], [3, 2]], [[0, 1]], [[3, 1]], [[2, 1]], [[3, 2]], []];
      for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
        const a = f[j * nx + i], b = f[j * nx + i + 1], cc = f[(j + 1) * nx + i + 1], d = f[(j + 1) * nx + i];
        const lo = Math.ceil(Math.min(a, b, cc, d) / step), hi = Math.floor(Math.max(a, b, cc, d) / step);
        for (let l = lo; l <= hi; l++) {
          const L = l * step, idx = (a > L) << 3 | (b > L) << 2 | (cc > L) << 1 | (d > L);
          for (const [e1, e2] of SEG[idx]) {
            const p = E(e1, i * cell, j * cell, a, b, cc, d, L), q = E(e2, i * cell, j * cell, a, b, cc, d, L), P = paths[l % 5 === 0 ? 1 : 0];
            P.moveTo(p[0], p[1]); P.lineTo(q[0], q[1]);
          }
        }
      }
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = c.accent; ctx.lineWidth = Math.max(0.7, 1 * k); ctx.stroke(paths[0]);
      ctx.strokeStyle = c['topo-index'] || c['accent-2']; ctx.lineWidth = Math.max(1, 1.9 * k); ctx.stroke(paths[1]);
    }

    // two offset halftone screens (15° and 75°) whose dots swell where each colour pools
    function halftone(ctx, W, H, k, c) {
      const screen = (ang, col, cx, cy, seed) => {
        const p = 13 * Math.max(0.55, k), ca = Math.cos(ang), sa = Math.sin(ang), R = Math.hypot(W, H);
        ctx.fillStyle = col; ctx.beginPath();
        for (let v = -R; v < R; v += p) for (let u = -R; u < R; u += p) {
          const x = W / 2 + u * ca - v * sa, y = H / 2 + u * sa + v * ca;
          if (x < -p || y < -p || x > W + p || y > H + p) continue;
          const d = Math.hypot((x / W - cx) * 1.15, (y / H - cy) * 1.5);
          const t = (1 - sstep(0, 0.8, d)) * (0.5 + 0.9 * fbm(x / (260 * k), y / (260 * k), seed, 2)) - 0.06;
          const r = p * 0.5 * Math.sqrt(Math.max(0, Math.min(0.8, t)));
          if (r > 0.45) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.2832); }
        }
        ctx.fill();
      };
      screen(0.26, c.accent, 0.92, 0.02, 3);
      screen(1.31, c['accent-2'], 0.06, 1.02, 8);
    }

    // marks for the scattered kinds, drawn in a unit box around the origin
    const wave = (n, amp) => { const p = []; for (let i = 0; i <= 48; i++) { const t = i / 48; p.push([-1 + 2 * t, amp * Math.sin(t * Math.PI * 2 * n)]); } return p; };
    const coil = () => { const p = []; for (let i = 0; i <= 90; i++) { const t = i / 90; p.push([-0.95 + 1.9 * t - 0.2 * Math.sin(t * Math.PI * 9), 0.2 * Math.cos(t * Math.PI * 9)]); } return p; };
    const ring = (r, n = 40, a0 = 0, a1 = 6.2832) => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / n; return [r * Math.cos(a), r * Math.sin(a)]; });
    const line = (ctx, pts) => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); };
    // hand-drawn: jitter the points, then run a smooth curve through their midpoints
    const sketch = (ctx, pts, r, closed = false, j = 0.035) => {
      const q = pts.map(([x, y]) => [x + (r() - 0.5) * 2 * j, y + (r() - 0.5) * 2 * j]);
      if (closed) q.push(q[0], q[1]);
      ctx.beginPath(); ctx.moveTo(q[0][0], q[0][1]);
      for (let i = 1; i < q.length - 1; i++) ctx.quadraticCurveTo(q[i][0], q[i][1], (q[i][0] + q[i + 1][0]) / 2, (q[i][1] + q[i + 1][1]) / 2);
      if (!closed) ctx.lineTo(q[q.length - 1][0], q[q.length - 1][1]);
      ctx.stroke();
    };
    const dense = (pts, closed) => pts.flatMap((p, i) => { const q = pts[(i + 1) % pts.length]; return !closed && i === pts.length - 1 ? [p] : [p, [p[0] + (q[0] - p[0]) * 0.15, p[1] + (q[1] - p[1]) * 0.15], [p[0] + (q[0] - p[0]) * 0.85, p[1] + (q[1] - p[1]) * 0.85]]; }); // keeps corners from melting
    const dot = (ctx, x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill(); };
    const MEMPHIS = [
      [(x) => line(x, wave(2.5, 0.22)), 4], [(x) => line(x, coil()), 2.5], [(x) => line(x, wave(3, 0.16).map(([a, b], i) => [a, i % 8 < 4 ? b : -b]).filter((_, i) => i % 4 === 0)), 2],
      [(x) => line(x, ring(0.55, 30, Math.PI, 6.2832)), 1.4], [(x) => line(x, ring(0.32)), 1], [(x) => { dot(x, -0.42, 0.1, 0.1); dot(x, 0, -0.12, 0.1); dot(x, 0.42, 0.1, 0.1); }, 1],
      [(x) => { line(x, [[-0.3, 0], [0.3, 0]]); line(x, [[0, -0.3], [0, 0.3]]); }, 1], [(x) => { for (const o of [-0.26, 0, 0.26]) line(x, [[-0.5, o - 0.15], [0.5, o + 0.15]]); }, 1],
    ];
    const star = (n, R, r0) => Array.from({ length: n * 2 }, (_, i) => { const a = -Math.PI / 2 + i * Math.PI / n, q = i % 2 ? r0 : R; return [q * Math.cos(a), q * Math.sin(a)]; });
    const DOODLES = [
      [(x, r) => sketch(x, [[-0.5, 0.02], [-0.32, 0.2], [-0.14, 0.38], [0.2, -0.05], [0.55, -0.45]], r), 2], // check
      [(x, r) => sketch(x, dense(star(5, 0.6, 0.26), true), r, true, 0.025), 1.6],
      [(x, r) => { x.beginPath(); x.moveTo(0, -0.62); for (const [a, b, cx, cy] of [[0.55, 0, 0.08, -0.08], [0, 0.62, 0.08, 0.08], [-0.55, 0, -0.08, 0.08], [0, -0.62, -0.08, -0.08]]) x.quadraticCurveTo(cx, cy, a, b); x.stroke(); }, 2], // sparkle
      [(x, r) => sketch(x, Array.from({ length: 34 }, (_, i) => { const a = i * 0.42, q = 0.04 + i * 0.016; return [q * Math.cos(a), q * Math.sin(a)]; }), r, false, 0.015), 1.3], // spiral
      [(x, r) => { sketch(x, [[-0.6, 0.35], [-0.2, 0.42], [0.15, 0.1], [0.5, -0.3]], r); sketch(x, [[0.18, -0.32], [0.5, -0.3], [0.46, 0.02]], r, false, 0.02); }, 1.6], // arrow
      [(x, r) => sketch(x, Array.from({ length: 24 }, (_, i) => { const t = i / 24 * 6.2832; return [0.036 * 16 * Math.sin(t) ** 3, -0.036 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) - 0.05]; }), r, true, 0.02), 1.2], // heart
      [(x, r) => { sketch(x, dense([[-0.5, -0.38], [0.5, -0.38], [0.52, 0.38], [-0.5, 0.38]], true), r, true, 0.025); sketch(x, [[-0.3, -0.12], [0.28, -0.12]], r, false, 0.02); sketch(x, [[-0.3, 0.1], [0.08, 0.1]], r, false, 0.02); }, 1.4], // card
      [(x, r) => sketch(x, dense([[0.12, -0.62], [-0.3, 0.06], [0.04, 0.04], [-0.12, 0.62], [0.36, -0.12], [0.02, -0.1], [0.12, -0.62]]), r, false, 0.015), 1.2], // bolt
      [(x, r) => { sketch(x, dense([[-0.55, -0.4], [0.55, -0.42], [0.55, 0.22], [-0.05, 0.22], [-0.3, 0.48], [-0.28, 0.22], [-0.55, 0.22], [-0.55, -0.4]]), r, false, 0.02); }, 1.4], // speech bubble
      [(x, r) => { sketch(x, ring(0.5, 14), r, true, 0.03); dot(x, -0.17, -0.1, 0.06); dot(x, 0.17, -0.1, 0.06); sketch(x, ring(0.27, 8, 0.5, 2.64).map(([a, b]) => [a, b + 0.02]), r, false, 0.015); }, 1], // smile
      [(x, r) => { for (let i = 0; i < 4; i++) { const a = i * Math.PI / 4; sketch(x, [[-0.45 * Math.cos(a), -0.45 * Math.sin(a)], [0.45 * Math.cos(a), 0.45 * Math.sin(a)]], r, false, 0.02); } }, 1], // asterisk
    ];
    const CONFETTI = [
      [(x) => { x.beginPath(); x.roundRect(-0.55, -0.2, 1.1, 0.4, 0.08); x.fill(); }, 4], [(x) => dot(x, 0, 0, 0.32), 2.2],
      [(x) => { x.beginPath(); x.moveTo(0, -0.42); x.lineTo(0.4, 0.3); x.lineTo(-0.4, 0.3); x.closePath(); x.fill(); }, 1.6],
      [(x) => { x.lineWidth = 0.2; line(x, wave(1.5, 0.18).map(([a, b]) => [a * 0.6, b])); }, 1.8], [(x) => { x.fillRect(-0.28, -0.28, 0.56, 0.56); }, 1],
    ];
    const KIND = { // marks, size px, spacing ×size, stroke px, colour weights, foreshorten
      squiggles: { marks: MEMPHIS, size: [30, 50], gap: 2.6, lw: 2.2, cols: [['accent', 5], ['accent-2', 4], ['spike', 1.4]] },
      doodles: { marks: DOODLES, size: [28, 42], gap: 2.35, lw: 1.9, cols: [['accent', 5], ['accent-2', 4]] },
      confetti: { marks: CONFETTI, size: [12, 21], gap: 3, lw: 0, cols: [['accent', 4], ['accent-2', 3.6], ['spike', 2.6], ['issue', 1.6]], fore: true },
    };
    function scatter(ctx, W, H, k, c, kind) {
      const K = KIND[kind], r = rng(kind.length * 977 + 13), placed = [], cellSz = 70 * k, grid = new Map();
      const near = (x, y, rad) => {
        const gx = Math.floor(x / cellSz), gy = Math.floor(y / cellSz);
        for (let a = gx - 1; a <= gx + 1; a++) for (let b = gy - 1; b <= gy + 1; b++) for (const p of grid.get(a + ',' + b) || []) if (Math.hypot(p[0] - x, p[1] - y) < (p[2] + rad)) return true;
        return false;
      };
      const tries = Math.round((W * H) / ((k < 1 ? 120 : 900) * k * k));
      for (let n = 0; n < tries; n++) {
        const x = r() * W, y = r() * H, s = (K.size[0] + r() * (K.size[1] - K.size[0])) * k;
        // clusters and calm patches: low-frequency noise gates the density
        if (k >= 1 && r() > 0.04 + 0.96 * sstep(0.47, 0.62, fbm(x / (460 * k), y / (460 * k), kind.length, 2))) continue;
        const rad = s * K.gap * (k < 1 ? 0.36 : 0.5);
        if (near(x, y, rad)) continue;
        const key = Math.floor(x / cellSz) + ',' + Math.floor(y / cellSz);
        (grid.get(key) || grid.set(key, []).get(key)).push([x, y, rad]);
        placed.push([x, y, s]);
      }
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const [x, y, s] of placed) {
        const mark = pickW(r, K.marks), col = c[pickW(r, K.cols)];
        ctx.save(); ctx.translate(x, y); ctx.rotate((r() - 0.5) * (kind === 'doodles' ? 0.9 : 6.2832));
        if (K.fore) ctx.scale(0.35 + 0.65 * r(), 1);
        ctx.scale(s, s);
        ctx.strokeStyle = ctx.fillStyle = col; ctx.lineWidth = (K.lw * Math.max(0.75, k)) / s;
        ctx.globalAlpha = K.fore ? 0.6 + 0.4 * r() : 1;
        mark(ctx, r);
        ctx.restore();
      }
    }
    const paint = (ctx, W, H, kind, c, k) => (kind === 'topo' ? topo : kind === 'halftone' ? halftone : scatter)(ctx, W, H, k, c, kind);

    let cv = null, key = '', timer = 0;
    const tiles = new Map();
    const vars = () => (THEMES[settings.theme] || THEMES[BASE_THEME]).vars;
    function sync() {
      const kind = document.documentElement.dataset.bg;
      cv ||= document.getElementById('art');
      if (!cv) return;
      if (!KINDS.includes(kind)) { if (key) { cv.width = cv.height = 0; key = ''; } return; }
      const d = Math.min(2, devicePixelRatio || 1), W = innerWidth + 2 * M, H = innerHeight + 2 * M, k2 = [kind, settings.theme, W, H, d].join();
      if (k2 === key) return;
      key = k2;
      cv.width = Math.round(W * d); cv.height = Math.round(H * d);
      const ctx = cv.getContext('2d');
      ctx.setTransform(d, 0, 0, d, 0, 0);
      paint(ctx, W, H, kind, vars(), 1);
    }
    addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(sync, 250); });
    return {
      sync,
      // Settings tile: the same generator at a smaller scale (no calm patches), a little stronger than on the board
      tile(kind) {
        if (!KINDS.includes(kind)) return '';
        const v = vars(), id = kind + settings.theme;
        if (!tiles.has(id)) {
          const W = 200, H = 80, c = document.createElement('canvas'), o = document.createElement('canvas');
          c.width = o.width = W * 2; c.height = o.height = H * 2;
          const g = o.getContext('2d'); g.scale(2, 2); paint(g, W, H, kind, v, kind === 'topo' || kind === 'halftone' ? 0.5 : 0.6);
          const x = c.getContext('2d'); x.globalAlpha = Math.min(1, parseFloat(v['fx-o']) * fxk(kind, (THEMES[settings.theme] || THEMES[BASE_THEME]).mode) * 1.8); x.drawImage(o, 0, 0);
          tiles.set(id, c.toDataURL());
        }
        return `background: url(${tiles.get(id)}) center / cover, var(--bg)`;
      },
    };
  })();
  /* ═════════════════════════ state + api ═════════════════════════ */

  const state = {
    app: { name: 'Intellagent' }, boards: [], boardId: null, board: null, hash: null, seq: 0, offset: 0, archivedCount: 0,
    presence: [], standing: {}, profiles: {}, listeners: {}, listenersSig: '', inbox: [], bulk: false, selected: new Set(), focusId: null, query: '', expanded: new Set(), folded: new Set(),
    modal: null, live: false, refreshing: false, refreshAgain: false,
  };

  const TOKEN_KEY = 'intellagent.token';
  const tokenStore = stored(TOKEN_KEY, '', true);
  const AUTH = { token: tokenStore.get() };
  // `intellagent open` passes the user token in the fragment (#token=…): keep it, then drop it from the address bar.
  {
    const m = /^#token=([\w-]+)/.exec(location.hash);
    if (m) {
      AUTH.token = m[1];
      tokenStore.save(m[1]);
      history.replaceState(null, '', location.pathname);
    }
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-User': (settings.userName || 'You').replace(/[^\x20-\x7e]/g, '') || 'You',
        ...(AUTH.token ? { Authorization: `Bearer ${AUTH.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && data?.auth === 'user' && await promptToken()) return api(method, url, body);
    if (!res.ok) { const e = new Error(data?.error || res.statusText); e.status = res.status; e.data = data; throw e; }
    return data;
  }
  const B = (p = '') => `/api/boards/${encodeURIComponent(state.boardId)}${p}`;
  const I = (id, p = '') => B(`/items/${encodeURIComponent(id)}${p}`);
  const colById = (id) => state.board?.columns.find((c) => c.id === id);
  const activeLease = (it) => (it?.lease && Date.parse(it.lease.expiresAt) > nowMs() ? it.lease : null);
  const schema = () => state.board?.schema || { builtins: {}, fields: [] };
  const bi = (k) => schema().builtins[k] || { ui: 'edit', stub: true, label: k };
  const canEdit = (k) => bi(k).ui === 'edit';
  const shown = (k) => bi(k).ui !== 'hidden';
  const needsIds = () => (state.board ? state.board.columns.flatMap((c) => c.itemIds).filter((id) => state.board.items[id]?.needsHuman) : []);
  function openBlockers(it) {
    const last = state.board.columns[state.board.columns.length - 1]?.id;
    return (it.blockedBy || []).filter((id) => { const b = state.board.items[id]; return b && b.columnId !== last; });
  }
  function coverOf(it) {
    if (it.cover === 'none') return null;
    if (it.cover && it.cover !== 'auto') return it.attachments.find((a) => a.id === it.cover) || null;
    return it.attachments.find(isImage) || null;
  }

  async function loadBoard(id) {
    const data = await api('GET', `/api/boards/${encodeURIComponent(id)}`);
    if (state.boardId !== data.board.id) resetBoardDom();
    const boardChanged = state.boardId !== data.board.id;
    state.boardId = data.board.id;
    state.board = data.board;
    state.hash = data.hash;
    state.seq = data.seq;
    loadMetrics(boardChanged);
    state.offset = Date.parse(data.serverTime) - Date.now();
    state.archivedCount = data.archivedCount;
    Object.assign(state.app, data.app);
    if (state.focusId && !viewFocus()) { state.focusId = null; toast('That focus board was retired — showing the full board', { icon: 'target' }); }
    if (location.hash !== boardHash()) history.replaceState(null, '', boardHash());
    renderHeader();
    render();
    state.modal?.refresh();
    scheduleListeners();
    renderCatch();
    const dg = $('#digestDrawer .drawer-body');
    if (dg?._redraw && !dg.contains(document.activeElement)) dg._redraw();
    if (!catchupDone.has(state.boardId)) { catchupDone.add(state.boardId); catchUp(state.boardId); }
  }

  let refreshTimer = null;
  function scheduleRefresh(delay = 50) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (state.refreshing) { state.refreshAgain = true; return; }
      state.refreshing = true;
      try { await loadBoard(state.boardId); } catch (e) { console.warn(e); }
      state.refreshing = false;
      if (state.refreshAgain) { state.refreshAgain = false; scheduleRefresh(0); }
    }, delay);
  }

  /* ═════════════════════════ generic UI: menu / dropdown / text box ═════════════════════════ */

  function closeMenus() { $$('.menu').forEach((m) => { m._onClose?.(); m.remove(); }); }

  // A positioned popover list. Items: { label, value?, icon?, color?, avatar?, hint?, cls?, disabled?, run? } or '-'.
  function menu(anchor, items, { up = false, search = false, creatable = null, placeholder = 'Search…', onClose = null, keepOpen = false, width = null } = {}) {
    const open = $('.menu');
    if (open && open._anchor === anchor) { closeMenus(); return null; }
    closeMenus();
    const m = el(`<div class="menu" role="listbox">${search || creatable ? `<input class="inp m-search" placeholder="${esc(placeholder)}" spellcheck="false">` : ''}<div class="m-list"></div></div>`);
    m._onClose = onClose;
    m._anchor = anchor;
    const list = $('.m-list', m);
    const input = $('.m-search', m);
    let active = -1;
    const draw = () => {
      const q = (input?.value || '').trim().toLowerCase();
      list.innerHTML = '';
      const vis = items.filter((it) => it === '-' ? !q : !q || String(it.label).toLowerCase().includes(q));
      for (const it of vis) {
        if (it === '-') { list.append(el('<hr>')); continue; }
        const lead = it.avatar ? avatar(it.avatar) : it.color ? `<span class="sw" style="--c:${esc(it.color)}"></span>` : it.icon ? icon(it.icon) : '';
        const need = it.need ? `<b class="mi-need" title="Needs you|${it.need} ticket${it.need === 1 ? '' : 's'} waiting for your answer">${icon('ask', 'sm')}${it.need}</b>` : '';
        const b = el(`<button class="mi ${it.cls || ''}" ${it.disabled ? 'disabled' : ''}>${lead}<span>${esc(it.label)}</span>${need}${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</button>`);
        b.onclick = (e) => { if (!keepOpen) closeMenus(); it.run?.(e); if (keepOpen) draw(); };
        list.append(b);
      }
      if (creatable && q && !items.some((it) => it !== '-' && String(it.label).toLowerCase() === q)) {
        const raw = input.value.trim();
        const b = el(`<button class="mi create">${icon('plus')}<span>${esc(raw)}</span></button>`);
        b.onclick = () => { closeMenus(); creatable(raw); };
        list.append(b);
      }
      if (!list.children.length) list.append(el('<div class="m-empty">—</div>'));
      active = -1;
    };
    draw();
    document.body.append(m);
    if (width) m.style.width = `${width}px`;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const mr = m.getBoundingClientRect();
      const left = clamp(r.left, 8, innerWidth - mr.width - 8);
      const below = innerHeight - r.bottom - 8;
      const goUp = up || (below < mr.height && r.top > below);
      const top = goUp ? r.top - mr.height - 6 : r.bottom + 6;
      Object.assign(m.style, { left: `${left}px`, top: `${clamp(top, 8, innerHeight - mr.height - 8)}px`, transformOrigin: goUp ? 'bottom left' : 'top left' });
    };
    place();
    if (input) {
      input.oninput = () => { draw(); place(); };
      input.onkeydown = (e) => {
        const btns = $$('button.mi:not(:disabled)', list);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          active = clamp(active + (e.key === 'ArrowDown' ? 1 : -1), 0, btns.length - 1);
          btns.forEach((b, i) => b.classList.toggle('act', i === active));
          btns[active]?.scrollIntoView({ block: 'nearest' });
        }
        if (e.key === 'Enter') { e.preventDefault(); (btns[active] || btns[0])?.click(); }
        if (e.key === 'Escape') { e.stopPropagation(); closeMenus(); }
      };
      setTimeout(() => input.focus(), 10);
    }
    setTimeout(() => {
      const off = (e) => {
        if (!m.isConnected) { document.removeEventListener('pointerdown', off, true); return; }
        if (!m.contains(e.target) && !anchor.contains(e.target)) { closeMenus(); document.removeEventListener('pointerdown', off, true); }
      };
      document.addEventListener('pointerdown', off, true);
    });
    return m;
  }

  // Styled replacement for <select>: renders a trigger button and opens a searchable menu.
  function ddHTML(key, labelHTML, { placeholder = '—', disabled = false } = {}) {
    return `<button class="dd" data-dd="${esc(key)}" ${disabled ? 'disabled' : ''}><span class="v ${labelHTML ? '' : 'ph'}">${labelHTML || esc(placeholder)}</span>${icon('chev', 'sm')}</button>`;
  }
  function openDd(btn, items, opts = {}) {
    if (btn.classList.contains('open')) { closeMenus(); return; }
    btn.classList.add('open');
    menu(btn, items, { ...opts, width: Math.max(btn.offsetWidth, 200), onClose: () => btn.classList.remove('open') });
  }

  // Text area with an accept button bottom-right (and optional extra tool buttons on the left).
  function tboxHTML({ cls = '', ph = '', okIcon = 'check', okTitle = 'Save', tools = '', hint = 'Ctrl+Enter', mono = false, rows = 1 } = {}) {
    return `<div class="tbox ${cls}"><textarea rows="${rows}" class="${mono ? 'mono' : ''}" placeholder="${esc(ph)}" spellcheck="true"></textarea><div class="staged"></div>
      <div class="tbox-bar">${tools}<span class="grow"></span><span class="hint">${esc(hint)}</span><button class="tb-ok" title="${esc(okTitle)}">${icon(okIcon)}</button></div></div>`;
  }
  function wireTbox(box, onAccept, { escape = null, submitOnEnter = false } = {}) {
    const ta = $('textarea', box);
    ta.addEventListener('input', () => autosize(ta));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (submitOnEnter && !e.shiftKey))) { e.preventDefault(); onAccept(); }
      if (e.key === 'Escape' && escape) { e.preventDefault(); e.stopPropagation(); escape(); }
    });
    $('.tb-ok', box).addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus so blur-save doesn't double fire
    $('.tb-ok', box).onclick = onAccept;
    return ta;
  }

  /* ═════════════════════════ chrome / header ═════════════════════════ */

  function buildChrome() {
    $('#topbar').innerHTML = `
      <div class="brand"><span class="logo" title="Next theme|Click to cycle through themes">${LOGO}</span><span class="app-name" id="appName"></span></div>
      <button class="pill-btn board-btn" id="boardBtn"><span id="boardName"></span>${icon('chev', 'sm')}</button>
      <label class="search">${icon('search')}<input id="search" placeholder="Filter" autocomplete="off" spellcheck="false"><kbd>/</kbd></label>
      <span class="grow"></span>
      <button class="pill-btn master-btn" id="masterBtn" hidden></button>
      <button class="pill-btn needs-btn" id="needsBtn" title="Needs you|Tickets where an agent is waiting for your answer" hidden>${icon('ask')}<span id="needsCount"></span></button>
      <button class="pill-btn catch-btn" id="catchBtn" title="While you were away|Tickets agents changed since you last looked" hidden>${icon('sparkle')}<span id="catchCount"></span></button>
      <div class="awake" id="awake" role="group" aria-label="Awake agents"></div>
      <label class="search ask-field" id="askField" title="Ask an agent|Plan work, create tickets, explain a blocker — anything not tied to one ticket · A"><span class="ask-av" id="askAv"></span><input id="askIn" readonly autocomplete="off" aria-haspopup="dialog" aria-label="Ask an agent"><kbd>A</kbd><i class="ask-dot" hidden></i></label>
      <button class="pill-btn hub-btn agents-btn" id="hubBtn" data-tip="Agents & inbox|Your inbox, the digest, agents, standing rules, flow and the archive"><span class="stack-av" id="agentAvs"></span><span id="agentCount"></span><span class="awake-n" id="awakeN" hidden></span><span class="badge" hidden></span><span class="dot" hidden></span></button>
      <button class="pill-btn icon-btn" id="bulkBtn" title="Select|Pick several tickets to move, re-prioritise or archive">${icon('checks')}</button>
      <button class="pill-btn icon-btn" id="settingsBtn" title="Settings|Themes, card contents, ticket fields and alerts">${icon('sliders')}</button>`;
    $('#boardBtn').onclick = (e) => boardMenu(e.currentTarget);
    $('#search').oninput = (e) => { state.query = e.target.value; applyFilter(); };
    $('#masterBtn').onclick = (e) => masterMenu(e.currentTarget);
    $('#needsBtn').onclick = () => { const ids = needsIds(); if (ids.length) openItem(ids[0], cardEls.get(ids[0]), { rail: true }); };

    $('#catchBtn').onclick = openCatchup;
    $('#awake').onclick = (e) => { const b = e.target.closest('[data-wake]'); if (b) openAgents(b.dataset.wake); };
    // keyboard focus shows the same tooltip as hover
    $('#awake').addEventListener('focusin', (e) => { const b = e.target.closest('[data-wake]'); if (b?.matches(':focus-visible')) { hideTip(); tipFor = b; showTip(b); } });
    $('#awake').addEventListener('focusout', hideTip);
    wireAskField();
    // Opens on whatever it is signalling: unread inbox, then a new digest entry, else the agents list
    // (asking an agent has its own field right beside it).
    $('#hubBtn').onclick = () => (state.inbox.some(isUnread) ? openInbox() : !$('#hubBtn .dot').hidden ? openDigest() : openAgents());
    $('#bulkBtn').onclick = () => setBulk(!state.bulk);
    $('#settingsBtn').onclick = () => openSettings();
    $('.logo').onclick = (e) => {
      const keys = Object.keys(THEMES);
      switchTheme(keys[(keys.indexOf(settings.theme) + 1) % keys.length], e.clientX, e.clientY);
    };
    $('#board').addEventListener('scroll', updateOverflow, { passive: true });
    addEventListener('resize', updateOverflow);
  }

  /* ─── metrics strip: how work flows, and how long agents wait on you ─── */

  const dur = (h) => (h == null ? '—' : h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${Math.round(h)}h` : `${(h / 24).toFixed(h < 240 ? 1 : 0)}d`);
  let metricsAt = 0;
  let metricsTimer = null;
  // Throttled: board refreshes are frequent; metrics move slowly.
  function loadMetrics(now = false) {
    const box = $('#metrics');
    if (!settings.metrics) { box.hidden = true; return; }
    clearTimeout(metricsTimer);
    const wait = now ? 0 : Math.max(0, 15000 - (Date.now() - metricsAt));
    metricsTimer = setTimeout(async () => {
      metricsAt = Date.now();
      try { state.metrics = await api('GET', B(`/metrics?days=${settings.metricsDays}`)); } catch { return; }
      renderMetrics();
    }, wait);
  }
  function sparkline(xs) {
    const w = 56; const h = 16; const max = Math.max(1, ...xs);
    const pts = xs.map((v, i) => `${(i / Math.max(1, xs.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(' ');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}"/></svg>`;
  }
  function renderMetrics() {
    const box = $('#metrics');
    const m = state.metrics;
    if (!m || !settings.metrics) { box.hidden = true; return; }
    box.hidden = false;
    const delta = m.done - m.donePrev;
    const trend = delta ? `<span class="mt-delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '↑' : '↓'}${Math.abs(delta)}</span>` : '';
    const w = m.waiting;
    box.innerHTML = `
      <div class="seg mini mt-days">${[7, 30].map((d) => `<button class="${m.days === d ? 'on' : ''}" data-days="${d}" title="Window|Last ${d} days">${d}d</button>`).join('')}</div>
      <button class="mt" data-mt="done" title="Done|Tickets that reached ${esc(state.board.columns.at(-1)?.name || 'the last column')} in the last ${m.days} days (vs the ${m.days} before)">${icon('check', 'sm')}<b>${m.done}</b> done${trend}${sparkline(m.perDay)}</button>
      <button class="mt" data-mt="cycle" title="Cycle time|Median time from starting work to done">${icon('clock', 'sm')}<b>${dur(m.cycleHours.median)}</b> cycle</button>
      <button class="mt ${w.open ? 'attn' : ''}" data-mt="waiting" title="Waiting on you|Open questions and reviews${w.oldestId ? ` — oldest on ${esc(w.oldestId)}` : ''}">${icon('ask', 'sm')}<b>${w.open}</b> waiting on you${w.open ? ` · oldest ${dur(w.oldestHours)}` : ''}</button>
      <button class="mt" data-mt="answer" title="Your answer time|Median time from an agent asking to you answering (${m.answerHours.count} answered)">${icon('send', 'sm')}you answer in <b>${dur(m.answerHours.median)}</b></button>
      ${m.slowest ? `<button class="mt" data-mt="slow" title="Slowest step|Column where tickets wait longest (median)">${icon('layers', 'sm')}slowest: <b>${esc(m.slowest.name)}</b> ${dur(m.slowest.medianStayHours)}</button>` : ''}`;
    box.onclick = (e) => {
      const d = e.target.closest('[data-days]');
      if (d) { settings.metricsDays = Number(d.dataset.days); saveSettings(); loadMetrics(true); return; }
      const t = e.target.closest('[data-mt]');
      if (!t) return;
      if (t.dataset.mt === 'waiting' && w.oldestId) { openItem(w.oldestId, cardEls.get(w.oldestId), { rail: true }); return; }
      openMetrics();
    };
  }
  async function openMetrics() {
    // The strip normally loads these; fetch them here when it is hidden.
    if (!state.metrics) { try { state.metrics = await api('GET', B(`/metrics?days=${settings.metricsDays}`)); } catch { return; } }
    const m = state.metrics;
    const body = openDrawer('metricsDrawer', `Flow · last ${m.days} days`, 'activity');
    const maxStay = Math.max(1, ...m.columns.map((c) => c.medianStayHours || 0));
    const agents = Object.entries(m.byAgent).sort((a, b) => b[1] - a[1]);
    body.innerHTML = `<div class="section"><div class="section-head">${icon('layers', 'sm')}<span>Time in each column (median)</span><span class="rule"></span></div>
        ${m.columns.map((c) => `<div class="mbar"><span class="mb-name"><i style="background:${esc(c.color)}"></i>${esc(c.name)}</span><span class="mb-track"><b style="width:${((c.medianStayHours || 0) / maxStay) * 100}%;background:${esc(c.color)}"></b></span><span class="mb-val">${dur(c.medianStayHours)}</span><span class="mb-sub">${c.count} now${c.oldestHours != null ? ` · oldest ${dur(c.oldestHours)}` : ''}</span></div>`).join('')}</div>
      <div class="section"><div class="section-head">${icon('check', 'sm')}<span>Done per day</span><span class="rule"></span></div><div class="mdays">${m.perDay.map((v) => `<i style="height:${(v / Math.max(1, ...m.perDay)) * 100}%" title="${v}"></i>`).join('')}</div></div>
      ${agents.length ? `<div class="section"><div class="section-head">${icon('bot', 'sm')}<span>Finished, by who worked on it</span><span class="rule"></span></div>${agents.map(([n, v]) => `<div class="magent">${avatar({ kind: 'agent', name: n })}<span>${esc(n)}</span><b>${v}</b></div>`).join('')}</div>` : ''}`;
  }

  function updateOverflow() {
    const b = $('#board');
    const ov = [];
    if (b.scrollLeft > 4) ov.push('l');
    if (b.scrollLeft + b.clientWidth < b.scrollWidth - 4) ov.push('r');
    b.dataset.ov = ov.join(' ');
    // Align the header with the column group, so the logo and the last button line up with the outer columns.
    const cols = $$('.column', b);
    const r = document.documentElement.style;
    if (!cols.length || ov.length || innerWidth < 640) { r.removeProperty('--frame-l'); r.removeProperty('--frame-r'); return; }
    const first = cols[0].getBoundingClientRect();
    const last = cols[cols.length - 1].getBoundingClientRect();
    r.setProperty('--frame-l', `${Math.max(12, Math.round(first.left))}px`);
    r.setProperty('--frame-r', `${Math.max(12, Math.round(innerWidth - last.right))}px`);
  }

  function renderHeader() {
    if (!state.board) return;
    $('#appName').textContent = state.app.name;
    document.title = `${state.board.name} · ${state.app.name}`;
    $('#boardName').textContent = state.board.name;
    const needs = needsIds().length;
    $('#needsBtn').hidden = !needs;
    $('#needsCount').textContent = needs;
    const ms = activeMaster();
    const mb = $('#masterBtn');
    mb.hidden = !ms;
    if (ms) {
      mb.innerHTML = `${icon('lock', 'sm')}${avatar({ kind: ms.kind === 'user' ? 'user' : 'agent', name: ms.holder })}<span class="ms">${esc(ms.status || 'holds the board')}</span>`;
      mb.dataset.tip = `Board held by ${ms.holder}|Working alone — other agents can only comment or ask${ms.expiresAt ? ` · until ${new Date(ms.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}. Click to release.`;
    }
    const lastDigest = state.board.digest?.[state.board.digest.length - 1]?.ts || '';
    $('#hubBtn .dot').hidden = !lastDigest || lastDigest <= (digestSeen[state.boardId] || '');
    $('#bulkBtn').classList.toggle('on', state.bulk);
    $('#boardName').textContent = viewFocus() ? `${state.board.name} › ${viewFocus().name}` : state.board.name;
    document.title = `${viewFocus() ? `${viewFocus().name} · ` : ''}${state.board.name} · ${state.app.name}`;
    renderFocusBar();
    renderPresenceButton();
    renderAsk();
    $('#build').innerHTML = `<span class="live-dot ${state.live ? 'on' : ''}" title="${state.live ? 'Live' : 'Reconnecting'}"></span>
      <span title="Build|Version · build · board hash — the hash changes on every board edit">v${esc(state.app.version || '')} · ${esc(state.app.build || '')} · ${esc((state.hash || '').slice(0, 8))}</span>`;
  }

  function renderPresenceButton() {
    const online = state.presence.filter((p) => p.online);
    // Up to three faces for who's online (a bot glyph when nobody is), "+N" beyond that; the inbox count
    // and the digest dot are drawn by renderInboxBtn / renderHeader. One summary in the tooltip.
    const shown = online.length > 3 ? 2 : 3;
    $('#agentAvs').innerHTML = online.length ? online.slice(0, shown).map((p) => avatar({ kind: 'agent', name: p.name })).join('') : icon('bot');
    $('#agentCount').textContent = online.length > shown ? `+${online.length - shown}` : '';
    const btn = $('#hubBtn');
    const unread = state.inbox.filter(isUnread).length;
    const bits = [online.length ? `${online.length} online: ${online.slice(0, 4).map((p) => p.name).join(', ')}${online.length > 4 ? '…' : ''}` : 'No agents online',
      unread ? `${unread} unread in your inbox` : '', !$('.dot', btn).hidden ? 'new digest entry' : ''].filter(Boolean);
    btn.dataset.tip = `Agents & inbox|${bits.join(' · ')}`;
    btn.setAttribute('aria-label', `Agents and inbox — ${bits.join(', ')}`);
    renderAwake();
  }

  // The awake strip (INT-163): standing agents that are running, waiting to run or failed, each in a run ring.
  // Idle and paused agents are not shown, so a quiet board has an empty strip. On a phone it folds into
  // the hub button as a count whose dot shows the worst state.
  const RING = { running: 'run', queued: 'wait', throttled: 'wait', retrying: 'wait', failed: 'fail' };
  // Order in the strip: failed (needs you), then running, then waiting; past four the rest fold into +n.
  const RING_ORDER = { fail: 0, run: 1, wait: 2 };
  function renderAwake() {
    const box = $('#awake');
    if (!box) return;
    const awake = Object.values(state.standing || {}).filter((a) => RING[a.status])
      .sort((a, b) => RING_ORDER[RING[a.status]] - RING_ORDER[RING[b.status]] || a.name.localeCompare(b.name));
    const line = (a) => {
      const n = a.now;
      const bits = a.status === 'running' && n ? [n.items?.[0], n.line, rel(n.since)] : [RUN_LABEL[a.status], a.queued ? `${a.queued} waiting` : ''];
      return `${nameOf(a.name)}|${bits.filter(Boolean).join(' · ') || RUN_LABEL[a.status]}`;
    };
    const shown = awake.length > 4 ? 3 : 4;
    const sig = JSON.stringify(awake.map((a) => [a.name, a.status, a.now?.line, a.now?.items, a.now?.since, a.queued]));
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.innerHTML = awake.slice(0, shown).map((a) => `<button class="wk" data-wake="${esc(a.name)}" data-ring="${RING[a.status]}" data-tip="${esc(line(a))}" aria-label="${esc(line(a).replace('|', ': '))}">${avatar({ kind: 'agent', name: a.name })}${RING[a.status] === 'fail' ? '<i aria-hidden="true">!</i>' : ''}</button>`).join('')
        + (awake.length > shown ? `<button class="wk-more" data-wake="" data-tip="${esc(`${awake.length - shown} more awake|${awake.slice(shown).map((a) => `${a.name} · ${RUN_LABEL[a.status]}`).join(', ')}`)}">+${awake.length - shown}</button>` : '');
    } else {
      // only the minutes moved: refresh the tooltips in place
      for (const b of $$('.wk', box)) { const a = state.standing[b.dataset.wake]; if (a) b.dataset.tip = line(a); }
    }
    const n = $('#awakeN');
    n.hidden = !awake.length;
    n.textContent = awake.length || '';
    n.dataset.ring = awake.some((a) => a.status === 'failed') ? 'fail' : awake.some((a) => RING[a.status] === 'wait') ? 'wait' : 'run';
    n.setAttribute('aria-label', `${awake.length} awake`);
  }

  async function refreshPresence() {
    try {
      const [pres, st] = await Promise.all([api('GET', '/api/presence'), api('GET', '/api/agents')]);
      state.presence = pres;
      state.standing = Object.fromEntries(st.agents.map((a) => [a.name, a]));
    } catch { return; }
    // run-state dots on every avatar already on screen (cards only re-render when they change)
    for (const av of $$('.avatar[data-name]')) {
      const run = state.standing[av.dataset.name]?.status;
      if (run && run !== 'idle') av.dataset.run = run; else delete av.dataset.run;
    }
    renderPresenceButton();
    // a run starting or ending adds / removes "thinking" bubbles in the open threads
    const think = JSON.stringify(Object.values(state.standing).filter((a) => a.status === 'running').map((a) => [a.name, a.lastRun?.about, a.stalled]));
    if (think !== state.thinkSig) {
      state.thinkSig = think;
      $('#requestsDrawer .drawer-body')?._redraw?.();
      if (state.modal?.kind === 'item' && !state.modal.create) state.modal.refresh();
    }
    // the minutes on a "writing a reply" bubble count up between redraws (INT-191)
    for (const t of $$('.think-age[data-run]')) t.textContent = runAgo(t.dataset.run);
    if ($('#agentsDrawer') && !$('#agentsDrawer .add-agent')) fillAgents($('#agentsDrawer .drawer-body')); // never wipe a half-filled form
  }

  function armDelete(btn, ids, done = () => {}) {
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      toast(`Click again to delete ${ids.length > 1 ? `${ids.length} test tickets` : ids[0]} for good`, { icon: 'trash', timeout: 3000 });
      clearTimeout(btn._arm);
      btn._arm = setTimeout(() => btn.classList.remove('armed'), 3000);
      return;
    }
    btn.classList.remove('armed');
    deleteTests(ids).then(done);
  }
  async function deleteTests(ids) {
    try {
      const r = ids === 'all' ? await api('DELETE', B('/test-items')) : await api('DELETE', I(ids[0]));
      toast(r.deleted.length ? `Deleted ${r.deleted.length > 1 ? `${r.deleted.length} test tickets` : r.deleted[0]}` : 'No test tickets to delete', { icon: 'trash' });
      scheduleRefresh(0);
    } catch (e) { toast(e.message, { kind: 'error' }); }
  }

  function boardMenu(anchor) {
    const items = state.boards.map((b) => ({
      label: b.name, icon: 'board', hint: String(b.items), need: b.needsHuman || 0, cls: b.id === state.boardId && !state.focusId ? 'on' : '',
      run: () => { closeModal(true); if (b.id === state.boardId) showFocus(null); else { state.focusId = null; loadBoard(b.id); } },
    }));
    const act = activeFocusBoard();
    if (focusBoards().length) {
      items.push('-');
      for (const f of focusBoards()) items.push({ label: f.name, icon: 'target', hint: `${f.itemIds.length}${f.id === act?.id ? ' · agents here' : ''}`, cls: f.id === state.focusId ? 'on' : '', run: () => showFocus(f.id) });
    }
    items.push({ label: 'New focus board…', icon: 'plus', hint: state.selected.size ? `${state.selected.size} selected` : '', run: () => {
      if (state.selected.size) { focusMenu($('#bulkbar [data-a="focus"]') || anchor); return; }
      setBulk(true);
      toast('Select the tickets to focus on, then choose Focus in the bar below', { icon: 'target', timeout: 5000 });
    } });
    items.push('-', { label: 'Archive', icon: 'archive', hint: String(state.archivedCount), run: openArchive });
    const tests = Object.values(state.board?.items || {}).filter((it) => it.test).length;
    if (tests) items.push({ label: 'Delete test tickets', icon: 'trash', hint: String(tests), run: () => deleteTests('all') });
    menu(anchor, items);
  }

  /* ─── focus boards (INT-215): a saved view over this board — only its tickets, the same columns and rules.
     Every change on it is a change to the real ticket. One board is active: the agents work only on that one. ─── */
  const focusBoards = () => state.board?.focusBoards || [];
  const viewFocus = () => focusBoards().find((f) => f.id === state.focusId) || null;
  const activeFocusBoard = () => focusBoards().find((f) => f.id === state.board?.activeFocus) || null;
  const inView = (id) => { const f = viewFocus(); return !f || f.itemIds.includes(id); };
  const withFocus = (body) => (state.focusId ? { ...body, focus: state.focusId } : body);
  const boardHash = () => `#/${state.boardId}${state.focusId ? `/focus/${state.focusId}` : ''}`;
  function parseHash() {
    const m = /^#\/?([^/=]+)(?:\/focus\/([\w-]+))?/.exec(location.hash);
    return { board: m ? decodeURIComponent(m[1]) : '', focus: m?.[2] || null };
  }
  function showFocus(id, { push = true } = {}) {
    if ((id || null) === state.focusId) return;
    closeModal(true);
    state.focusId = id || null;
    state.selected.clear();
    if (push && location.hash !== boardHash()) history.pushState(null, '', boardHash());
    renderHeader();
    render();
  }
  async function createFocus(name, ids) {
    try {
      const f = await api('POST', B('/focus'), { name, itemIds: ids });
      setBulk(false);
      await loadBoard(state.boardId);
      showFocus(f.id);
      toast(`"${f.name}" is the active board — the agents work only on its ${f.itemIds.length} ticket${f.itemIds.length === 1 ? '' : 's'}`, { icon: 'target', kind: 'ok', timeout: 5000, wrap: true });
    } catch (e) { toast(e.message, { kind: 'error' }); }
  }
  async function patchFocus(f, body, done) {
    try { await api('PATCH', B(`/focus/${encodeURIComponent(f.id)}`), body); if (done) toast(done, { icon: 'target' }); scheduleRefresh(0); } catch (e) { toast(e.message, { kind: 'error' }); }
  }
  async function setActiveBoard(id) {
    try { await api('PUT', B('/focus/active'), { id }); scheduleRefresh(0); } catch (e) { toast(e.message, { kind: 'error' }); }
  }
  async function retireFocus(f) {
    try {
      const r = await api('DELETE', B(`/focus/${encodeURIComponent(f.id)}`));
      if (state.focusId === f.id) state.focusId = null;
      await loadBoard(state.boardId);
      if (location.hash !== boardHash()) history.pushState(null, '', boardHash());
      const moved = r.moved.length ? ` While it was open, ${r.moved.length} moved: ${r.moved.slice(0, 4).map((x) => `${x.id} ${x.from} → ${x.to}`).join(', ')}${r.moved.length > 4 ? '…' : ''}.` : ' Nothing moved while it was open.';
      toast(`Retired "${r.name}": all ${r.tickets} tickets stay where they are.${moved}${r.archived.length ? ` ${r.archived.length} archived.` : ''}`, { icon: 'target', kind: 'ok', timeout: 9000, wrap: true });
    } catch (e) { toast(e.message, { kind: 'error' }); }
  }
  // The selected tickets: a new focus board (type its name), or into / out of an existing one.
  function focusMenu(anchor) {
    const ids = [...state.selected];
    const vf = viewFocus();
    const items = focusBoards().map((f) => ({ label: `Add to ${f.name}`, icon: 'target', hint: String(f.itemIds.length), run: () => patchFocus(f, { add: ids }, `Added ${ids.length} to "${f.name}"`) }));
    if (vf) items.unshift({ label: `Take out of ${vf.name}`, icon: 'x', run: () => { patchFocus(vf, { remove: ids }, `Took ${ids.length} out of "${vf.name}" — they stay on the board`); state.selected.clear(); } });
    if (!items.length) items.push({ label: 'Name it, then press Enter', icon: 'info', disabled: true });
    menu(anchor, items, { up: true, creatable: (name) => createFocus(name, ids), placeholder: 'Name a new focus board…', width: 300 });
  }
  // The strip under the top bar: which board this is, which one the agents work on, and the way back.
  function renderFocusBar() {
    const bar = $('#focusbar');
    if (!bar || !state.board) return;
    const vf = viewFocus();
    const act = activeFocusBoard();
    bar.hidden = !vf && !act;
    bar.classList.toggle('viewing', !!vf);
    if (bar.hidden) { bar.innerHTML = ''; return; }
    const n = (f) => `${f.itemIds.length} ticket${f.itemIds.length === 1 ? '' : 's'}`;
    bar.innerHTML = vf
      ? `<span class="fb-ic">${icon('target')}</span>
        <span class="fb-text"><small>Focus board of ${esc(state.board.name)}</small><b>${esc(vf.name)}</b><span class="fb-n">${n(vf)}</span></span>
        <span class="fb-actions">${vf.id === act?.id
    ? `<span class="fb-active on" data-tip="Active board|The agents work only on these tickets. Work elsewhere waits until you retire this board or make the full board active">${icon('bot', 'sm')}Agents work here</span>`
    : `<button class="fb-active" data-fb="activate" data-tip="Make active|Point the agents at these tickets only. Work they hold elsewhere goes back to ${esc(state.board.columns.find((c) => c.flags.pickup)?.name || 'the pickup column')}">${icon('bot', 'sm')}Make active</button>`}
        <button class="btn sm" data-fb="back">${icon('board', 'sm')}Full board</button>
        <button class="btn ghost sm fb-retire" data-fb="retire" data-tip="Retire board and return to the original|Removes this view only: no ticket moves, nothing is lost${vf.id === act?.id ? '. The full board becomes active again' : ''}">${icon('x', 'sm')}<span>Retire</span></button></span>`
      : `<span class="fb-ic">${icon('target')}</span>
        <span class="fb-text"><small>The agents are focused on</small><b>${esc(act.name)}</b><span class="fb-n">${n(act)}</span></span>
        <span class="fb-actions"><button class="btn ghost sm" data-fb="open">${icon('target', 'sm')}Open it</button>
        <button class="btn ghost sm" data-fb="full" data-tip="Make the full board active|The agents go back to working on every ticket">${icon('bot', 'sm')}Make the full board active</button></span>`;
    bar.onclick = (e) => {
      const b = e.target.closest('[data-fb]');
      if (!b) return;
      const a = b.dataset.fb;
      if (a === 'back') showFocus(null);
      if (a === 'open') showFocus(act.id);
      if (a === 'activate') setActiveBoard(vf.id);
      if (a === 'full') setActiveBoard(null);
      if (a === 'retire') {
        if (!b.classList.contains('armed')) {
          b.classList.add('armed');
          b.lastChild.textContent = 'Click again to retire';
          setTimeout(() => { if (b.isConnected) { b.classList.remove('armed'); b.lastChild.textContent = 'Retire'; } }, 3500);
          return;
        }
        retireFocus(vf);
      }
    };
  }

  async function refreshProfiles() {
    try { state.profiles = await api('GET', '/api/profiles'); } catch { return; }
    settingsVersion++;
    render();
    renderPresenceButton();
    state.modal?.refresh();
  }

  const activeMaster = () => {
    const m = state.board?.master;
    return m && (!m.expiresAt || Date.parse(m.expiresAt) > nowMs()) ? m : null;
  };
  function masterMenu(anchor) {
    const ms = activeMaster();
    if (!ms) return;
    const mine = ms.holder === settings.userName;
    menu(anchor, [{ label: mine ? 'Release the board' : `Revoke ${ms.holder}'s hold`, icon: 'x', cls: mine ? '' : 'danger',
      run: async () => { try { await api('DELETE', B('/master')); scheduleRefresh(0); } catch (e) { toast(e.message, { kind: 'error' }); } } }]);
  }

  async function refreshBoards() { try { state.boards = await api('GET', '/api/boards'); } catch { /* offline */ } }

  /* ═════════════════════════ board render (keyed + FLIP) ═════════════════════════ */

  const colEls = new Map();
  const cardEls = new Map();
  const groupEls = new Map();
  let drag = null;

  function resetBoardDom() {
    $('#board').innerHTML = '';
    colEls.clear(); cardEls.clear(); groupEls.clear();
    state.selected.clear();
  }

  function snapshotRects() {
    const m = new Map();
    for (const [id, c] of cardEls) if (c.isConnected) m.set(c, { r: c.getBoundingClientRect(), col: c.closest('.column')?.dataset.id, id });
    for (const g of groupEls.values()) if (g.isConnected) m.set(g, { r: g.getBoundingClientRect() });
    return m;
  }

  function layoutColumn(col) {
    const items = state.board.items;
    const ids = col.itemIds.filter((id) => items[id] && inView(id));
    if (settings.grouping === 'off' || !shown('parent')) return ids.map((id) => ({ kind: 'card', id }));
    const byParent = new Map();
    for (const id of ids) {
      const p = items[id].parent;
      if (p) { if (!byParent.has(p)) byParent.set(p, []); byParent.get(p).push(id); }
    }
    const out = [];
    const done = new Set();
    for (const id of ids) {
      const p = items[id].parent;
      if (p && byParent.get(p).length > 1) {
        if (done.has(p)) continue;
        done.add(p);
        out.push({ kind: 'group', key: `${col.id}::${p}`, parent: p, ids: byParent.get(p) });
      } else out.push({ kind: 'card', id });
    }
    return out;
  }

  function render() {
    if (!state.board || drag) return;
    const before = snapshotRects();
    const boardEl = $('#board');
    const b = state.board;

    b.columns.forEach((col, i) => {
      let c = colEls.get(col.id);
      if (!c) { c = buildColumn(col.id); colEls.set(col.id, c); }
      updateColumn(c, col);
      if (boardEl.children[i] !== c) boardEl.insertBefore(c, boardEl.children[i] || null);
    });
    for (const [id, c] of colEls) if (!b.columns.some((x) => x.id === id)) { c.remove(); colEls.delete(id); }

    const seenCards = new Set();
    const seenGroups = new Set();
    for (const col of b.columns) {
      const list = $('.list', colEls.get(col.id));
      layoutColumn(col).forEach((n, idx) => {
        let node;
        if (n.kind === 'card') { node = ensureCard(n.id); seenCards.add(n.id); node.style.removeProperty('--si'); node.tabIndex = 0; }
        else {
          node = ensureGroup(n.key);
          seenGroups.add(n.key);
          updateGroup(node, n);
          const inner = $('.group-cards', node);
          // A closed stack is one Tab stop, its head (a button that fans it out); its cards join the order once open.
          const shut = node.classList.contains('stack') && !node.classList.contains('open');
          n.ids.forEach((id, j) => {
            const c = ensureCard(id);
            seenCards.add(id);
            c.style.setProperty('--si', j);
            c.tabIndex = shut ? -1 : 0;
            if (inner.children[j] !== c) inner.insertBefore(c, inner.children[j] || null);
          });
        }
        if (list.children[idx] !== node) list.insertBefore(node, list.children[idx] || null);
      });
    }

    for (const [id, c] of cardEls) if (!seenCards.has(id)) { animateOut(c, before.get(c)?.r); cardEls.delete(id); state.selected.delete(id); }
    for (const [k, g] of groupEls) if (!seenGroups.has(k)) { g.remove(); groupEls.delete(k); }
    for (const id of seenCards) updateCard(cardEls.get(id), b.items[id]);

    applyFilter();
    flip(before);
    renderBulkBar();
    requestAnimationFrame(updateOverflow);
    rest.settle();
  }

  const SPRING = 'cubic-bezier(.2,.9,.25,1.12)';
  // Opening/closing a stack is a deliberate gesture: calm ease-in-out, no overshoot, for the stack and its neighbours.
  const EASE_IO = 'cubic-bezier(.45,0,.2,1)';
  const MORPH_MS = 300;
  let morphNext = null;
  function flip(before, { flights = true } = {}) {
    const mo = morphNext;
    morphNext = null;
    if (reduced()) return;
    // A FLIP still in flight would skew the new measurement; the snapshot already holds where it is now.
    for (const node of before.keys()) for (const an of node.getAnimations()) if (an.id === 'flip') an.cancel();
    const own = mo && $('.group-cards', mo.g);
    // Measure everything first. A card inside a group that itself moves only animates its offset *relative to
    // the group*; animating both would carry the card twice the distance, across the headers above it.
    const delta = new Map();
    for (const [node, a] of before) {
      if (!node.isConnected) continue;
      const r = node.getBoundingClientRect();
      delta.set(node, { r, dx: a.r.left - r.left, dy: a.r.top - r.top });
    }
    for (const [node, a] of before) {
      const d = delta.get(node);
      if (!d || (own && node.parentNode === own)) continue;
      const newCol = node.closest('.column')?.dataset.id;
      if (flights && a.col && newCol && a.col !== newCol) { if (Math.abs(d.dx) >= 1 || Math.abs(d.dy) >= 1) fly(node, a.r, d.r); continue; }
      const pg = node.parentNode?.parentNode;
      const gd = pg && pg.classList?.contains('group') ? delta.get(pg) : null;
      const dx = d.dx - (gd?.dx || 0), dy = d.dy - (gd?.dy || 0);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      node.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0px 0px' }], mo ? { id: 'flip', duration: MORPH_MS, easing: EASE_IO } : { id: 'flip', duration: 520, easing: SPRING });
    }
    if (mo) morphStack(mo, before);
    for (const node of [...cardEls.values(), ...groupEls.values()]) {
      if (before.has(node) || !node.isConnected || !node.getBoundingClientRect().width) continue;
      node.animate([{ opacity: 0, scale: 0.86 }, { opacity: 1, scale: 1 }], { duration: 420, easing: SPRING });
    }
  }

  // Stack open/close. Every card travels from the box it was drawn in to its new one (position AND size, since
  // the back sheets borrow the front card's box), driven by transform only. Back cards keep their content
  // hidden while moving and reveal it once they are nearly in place; on close it goes first. The tray
  // grows/shrinks with the cards. Interrupting mid-way starts from wherever things are on screen.
  const stackFaces = (c) => [...c.children].filter((x) => x.matches('.c-body, .tape, .c-ask, .c-check'));
  const stackLook = (g) => new Map([...$('.group-cards', g).children].map((c) => [c, { o: +getComputedStyle(c).opacity, f: +getComputedStyle($('.c-body', c) || c).opacity }]));
  function morphStack({ g, opening, was }, before) {
    const cards = [...$('.group-cards', g).children];
    const faces = stackFaces;
    for (const c of cards) for (const x of [c, ...faces(c), $('.g-bg', g)]) for (const an of x.getAnimations()) if (an.id === 'morph') an.cancel();
    const ends = cards.map((c) => c.getBoundingClientRect());
    const opts = (delay = 0, extra = {}) => ({ id: 'morph', duration: MORPH_MS, delay, easing: EASE_IO, fill: 'backwards', ...extra });
    const runs = [];
    cards.forEach((c, i) => {
      const a = before.get(c)?.r;
      const r = ends[i];
      if (!a || !r.width || !r.height || !a.width) return;
      // End transform is the CSS one (stacked offset or none): a pure scale s + translateY ty about the centre.
      const m = new DOMMatrix(getComputedStyle(c).transform === 'none' ? undefined : getComputedStyle(c).transform);
      const s = m.a || 1, ty = m.f;
      const lw = r.width / s, lh = r.height / s;
      const dx = a.left + a.width / 2 - (r.left + r.width / 2), dy = a.top + a.height / 2 - (r.top + r.height / 2 - ty);
      const delay = opening ? Math.min(i, 5) * 16 : Math.min(cards.length - 1 - i, 5) * 12;
      runs.push(c.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${a.width / lw}, ${a.height / lh})` }, { transform: `translate(0px, ${ty}px) scale(${s}, ${s})` }], opts(delay)));
      const w = was?.get(c), o = +getComputedStyle(c).opacity;
      if (!w) return;
      if (Math.abs(w.o - o) > 0.01) c.animate([{ opacity: w.o }, { opacity: o }], opts(delay, { easing: opening ? 'cubic-bezier(.3,0,.2,1)' : 'cubic-bezier(.6,0,.9,.4)' }));
      const fs = faces(c);
      const fo = +getComputedStyle($('.c-body', c) || c).opacity;
      if (fs.length && Math.abs(w.f - fo) > 0.01) {
        // Reveal over the last 45% of the trip; hide over the first 30%.
        const k = opening ? [{ opacity: w.f }, { opacity: w.f, offset: 0.55, easing: 'ease-out' }, { opacity: fo }] : [{ opacity: w.f, easing: 'ease-in' }, { opacity: fo, offset: 0.3 }, { opacity: fo }];
        for (const x of fs) x.animate(k, opts(delay, { easing: 'linear' }));
      }
    });
    const ga = before.get(g)?.r;
    if (ga) {
      const dh = g.getBoundingClientRect().height - ga.height;
      const bg = $('.g-bg', g), b0 = parseFloat(getComputedStyle(bg).bottom) || 0;
      if (Math.abs(dh) > 1) bg.animate([{ bottom: `${b0 + dh}px` }, { bottom: `${b0}px` }], opts());
    }
    // Hand the cards back to CSS only once their own trip is over (a later toggle takes over the token).
    const token = (g._morph = (g._morph || 0) + 1);
    Promise.allSettled(runs.map((x) => x.finished)).then(() => { if (g._morph === token) delete g.dataset.morph; });
  }

  // Cross-column moves fly a ghost above everything so overflow clipping never hides the trip.
  function fly(node, from, to) {
    const ghost = node.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('flash', 'morph-src');
    Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    document.body.append(ghost);
    // Hide instantly: the card's CSS opacity transition would otherwise fade it out at its destination.
    node.style.transition = 'none';
    node.style.opacity = '0';
    const lift = Math.min(60, Math.abs(to.left - from.left) * 0.12);
    ghost.animate([
      { translate: '0px 0px', rotate: '0deg', scale: 1 },
      { translate: `${(to.left - from.left) / 2}px ${(to.top - from.top) / 2 - lift}px`, rotate: `${Math.sign(to.left - from.left) * 4}deg`, scale: 1.05, offset: 0.5 },
      { translate: `${to.left - from.left}px ${to.top - from.top}px`, rotate: '0deg', scale: 1 },
    ], { duration: 700, easing: 'cubic-bezier(.5,0,.25,1)' }).onfinish = () => {
      ghost.remove(); node.style.opacity = ''; void node.offsetWidth; node.style.transition = '';
      node.classList.remove('landed'); void node.offsetWidth; node.classList.add('landed');
    };
  }

  function animateOut(node, rect) {
    if (!rect || reduced() || !node.isConnected) { node.remove(); return; }
    Object.assign(node.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, margin: 0, zIndex: 50, pointerEvents: 'none' });
    document.body.append(node);
    node.animate([{ opacity: 1, scale: 1, filter: 'blur(0)' }, { opacity: 0, scale: 0.7, filter: 'blur(6px)', translate: '0 -20px' }], { duration: 380, easing: 'ease-in' }).onfinish = () => node.remove();
  }

  /* ─── columns ─── */

  function buildColumn(id) {
    const c = el(`<section class="column" data-id="${esc(id)}">
      <header class="col-head"><span class="col-dot"></span><span class="col-icon"></span><h2 class="col-name"></h2><span class="col-gate" hidden>${icon('user', 'sm')}</span><span class="col-count"></span><span class="grow"></span>
        <button class="col-add" title="New ticket|Opens a full ticket to write · Shift+click for the quick one-line box (Fix login #auth !high /issue)">${icon('plus')}</button></header>
      <div class="col-wip" hidden><i></i></div>
      <div class="composer"><div class="tpl-row"></div>${tboxHTML({ ph: 'New ticket…', okIcon: 'plus', okTitle: 'Create', hint: 'Enter', rows: 2 })}</div>
      <div class="list"></div></section>`);
    $('.col-add', c).onclick = (e) => (e.shiftKey ? openComposer(id) : openCreate(id));
    $('.col-count', c).onclick = () => {
      if (!state.bulk) return;
      const ids = colById(id)?.itemIds || [];
      const all = ids.every((x) => state.selected.has(x));
      ids.forEach((x) => (all ? state.selected.delete(x) : state.selected.add(x)));
      render();
    };
    const ta = wireTbox($('.composer .tbox', c), () => submitComposer(id), { escape: () => closeComposer(id), submitOnEnter: true });
    ta.addEventListener('blur', () => setTimeout(() => { if (!ta.value.trim() && document.activeElement !== ta) closeComposer(id); }, 120));
    return c;
  }

  function updateColumn(c, col) {
    c.style.setProperty('--col', col.color || 'var(--accent)');
    $('.col-name', c).textContent = col.name;
    $('.col-icon', c).innerHTML = ICONS[col.icon] ? icon(col.icon, 'sm') : col.icon && col.icon.length <= 2 ? esc(col.icon) : '';
    const n = col.itemIds.length;
    const seen = viewFocus() ? col.itemIds.filter(inView).length : n;
    const wip = col.flags.wipLimit;
    const cnt = $('.col-count', c);
    cnt.textContent = wip && !viewFocus() ? `${n}/${wip}` : seen;
    cnt.classList.toggle('full', !!wip && n >= wip);
    const bar = $('.col-wip', c);
    bar.hidden = !wip;
    if (wip) { bar.style.setProperty('--w', `${Math.min(100, (n / wip) * 100)}%`); bar.classList.toggle('full', n >= wip); }
    $('.col-add', c).hidden = !col.flags.allowCreate || (!!wip && n >= wip);
    if (!col.flags.allowCreate) c.classList.remove('composing');
    const gate = $('.col-gate', c);
    gate.hidden = !(col.flags.humanOnlyIn || col.flags.humanOnlyOut);
    gate.dataset.tip = `Approval gate|${[col.flags.humanOnlyIn && 'only humans move tickets in', col.flags.humanOnlyOut && 'only humans move tickets out'].filter(Boolean).join(' · ')}`;
    cnt.dataset.tip = viewFocus() ? `${seen} on this focus board|${n} in the column on the full board${wip ? ` · WIP limit ${n} of ${wip} slots used` : ''}`
      : wip ? `WIP limit|${n} of ${wip} slots used` : `${n} ticket${n === 1 ? '' : 's'}`;
  }

  // Ticket templates (per board) as one-tap chips above the composer; "/bug" in the text picks one too.
  function openComposer(colId, template = null) {
    const c = colEls.get(colId);
    c.classList.add('composing');
    const row = $('.composer .tpl-row', c);
    const tpls = state.board.ticketTemplates || [];
    row.hidden = !tpls.length;
    row.innerHTML = tpls.map((t) => `<button class="tpl-chip" data-tpl="${esc(t.key)}" title="${esc(t.label)}|${esc(t.help || 'Start from this template')}">${icon(t.icon || t.type || 'task', 'sm')}${esc(t.label)}</button>`).join('');
    row.onclick = (e) => { const b = e.target.closest('[data-tpl]'); if (b) setComposerTemplate(colId, c.dataset.tpl === b.dataset.tpl ? null : b.dataset.tpl); };
    setComposerTemplate(colId, template);
    $('.composer textarea', c).focus();
  }
  function setComposerTemplate(colId, key) {
    const c = colEls.get(colId);
    const t = (state.board.ticketTemplates || []).find((x) => x.key === key);
    if (t) c.dataset.tpl = t.key; else delete c.dataset.tpl;
    for (const b of $$('.tpl-chip', c)) b.classList.toggle('on', b.dataset.tpl === c.dataset.tpl);
    const ta = $('.composer textarea', c);
    ta.placeholder = t ? `New ${t.label.toLowerCase()}…` : 'New ticket…';
    if (t?.title && !ta.value) ta.value = t.title;
    ta.focus();
  }
  function closeComposer(colId) {
    const c = colEls.get(colId);
    if (!c) return;
    c.classList.remove('composing');
    delete c.dataset.tpl;
    $('.composer textarea', c).value = '';
  }
  // Quick syntax: "Fix login #auth !high /issue"
  // Quick syntax in a title: "Fix login #auth !high /issue /bug" → parent, priority, type, template.
  function parseQuick(raw) {
    const body = {};
    let text = String(raw || '');
    const tplKeys = new Set((state.board.ticketTemplates || []).map((t) => t.key));
    text = text.replace(/(^|\s)\/([\w-]+)\b/g, (m, s, k) => { if (!tplKeys.has(k.toLowerCase())) return m; body.template = k.toLowerCase(); return s; });
    text = text.replace(/(^|\s)#([\w./-]+)/g, (_, s, p) => { body.parent = p; return s; });
    text = text.replace(/(^|\s)!(low|med(?:ium)?|high|crit(?:ical)?)\b/gi, (_, s, p) => { body.priority = PRIORITIES.find((x) => x.toLowerCase().startsWith(p.toLowerCase().slice(0, 3))); return s; });
    text = text.replace(/(^|\s)\/(issue|task|spike)\b/gi, (_, s, t) => { body.type = t.toLowerCase(); return s; });
    body.title = text.replace(/\s+/g, ' ').trim();
    return body;
  }

  async function submitComposer(colId) {
    const c = colEls.get(colId);
    const ta = $('.composer textarea', c);
    const text = ta.value;
    const body = { column: colId, position: 'top', ...(c.dataset.tpl ? { template: c.dataset.tpl } : {}), ...parseQuick(text) };
    const box = $('.composer', c);
    if (!body.title) { box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); return; }
    ta.value = '';
    autosize(ta);
    ta.focus();
    try { await api('POST', B('/items'), withFocus(body)); scheduleRefresh(0); setComposerTemplate(colId, null); } catch (e) { toast(e.message, { kind: 'error' }); ta.value = text; }
  }

  /* ─── groups ─── */

  function ensureGroup(key) {
    let g = groupEls.get(key);
    if (g) return g;
    g = el(`<section class="group" data-key="${esc(key)}"><button class="group-head"><i class="tape"></i><span class="g-dot"></span><span class="g-name"></span><span class="g-count"></span><span class="grow"></span>${icon('chev', 'g-chev')}<span class="g-sum"></span></button><i class="g-bg"></i><div class="group-cards"></div></section>`);
    $('.group-head', g).onclick = () => toggleGroup(key);
    $('.group-cards', g).addEventListener('click', () => { if (g.classList.contains('stack') && !g.classList.contains('open')) toggleGroup(key); });
    groupEls.set(key, g);
    return g;
  }
  function updateGroup(g, n) {
    const mode = settings.grouping;
    g.className = `group ${mode === 'list' ? 'listed' : mode}${mode === 'stack' && state.expanded.has(n.key) ? ' open' : ''}${mode === 'list' && state.folded.has(n.key) ? ' folded' : ''}`;
    g.style.setProperty('--tagc', tagColor(n.parent));
    $('.g-name', g).textContent = n.parent;
    $('.g-count', g).textContent = n.ids.length;
    const cover = pick('groups') === 'cover';
    const sum = cover ? groupSummary(n.ids.map((id) => state.board.items[id]).filter(Boolean)) : '';
    const se = $('.g-sum', g);
    if (se._html !== sum) { se.innerHTML = sum; se._html = sum; }
    const open = mode === 'stack' ? state.expanded.has(n.key) : !state.folded.has(n.key);
    const head = $('.group-head', g);
    head.setAttribute('aria-expanded', open);
    head.dataset.tip = `#${n.parent} · ${n.ids.length} tickets|${mode === 'stack' ? (open ? 'Click to stack them again' : 'Click to fan the stack out') : (open ? 'Click to fold' : 'Click to unfold')}`;
  }
  // The cover look's summary of a group: what kind of work, how urgent, who is on it, how far along.
  function groupSummary(items) {
    const types = ['task', 'issue', 'spike'].map((t) => [t, items.filter((it) => it.type === t).length]).filter(([, k]) => k);
    const top = [...PRIORITIES].reverse().find((p) => items.some((it) => it.priority === p));
    const ck = items.reduce((a, it) => { const c = checklist(it.description); return { done: a.done + c.done, total: a.total + c.total }; }, { done: 0, total: 0 });
    const who = [...new Set(items.flatMap((it) => [activeLease(it)?.claimant, it.assignee]).filter(Boolean))];
    return `${types.map(([t, k]) => `<span class="g-t" data-type="${t}">${icon(t, 'sm')}${k}</span>`).join('')}${top === 'High' || top === 'Critical' ? `<span class="prio" data-p="${top.toLowerCase()}">${top}</span>` : ''}<span class="grow"></span>${who.length ? `<span class="stack-av">${who.slice(0, 3).map((name) => avatar({ name })).join('')}</span>` : ''}${ck.total ? `<span class="g-ck">${icon('checks', 'sm')}${ck.done}/${ck.total}</span><span class="g-prog"><i style="width:${(ck.done / ck.total) * 100}%"></i></span>` : ''}`;
  }
  function toggleGroup(key) {
    const stack = settings.grouping === 'stack';
    const set = stack ? state.expanded : state.folded;
    if (set.has(key)) set.delete(key); else set.add(key);
    const g = groupEls.get(key);
    // Freeze the CSS transitions and note how things look now (mid-flight too) before the class flips.
    if (stack && g?.isConnected && !reduced()) { morphNext = { g, opening: set.has(key), was: stackLook(g) }; g.dataset.morph = ''; }
    render();
    if (morphNext) { morphNext = null; delete g.dataset.morph; }
  }

  /* ─── cards ─── */

  function ensureCard(id) {
    let c = cardEls.get(id);
    if (c) return c;
    c = el(`<article class="card" data-id="${esc(id)}" tabindex="0"><i class="tape"></i><div class="c-body"></div><span class="c-check">${icon('check')}</span><span class="c-ask" title="Needs you|An agent is waiting for your answer">?</span></article>`);
    c.addEventListener('pointerdown', onCardPointerDown);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') openItem(id, c); });
    cardEls.set(id, c);
    return c;
  }

  function updateCard(c, it) {
    if (!c || !it) return;
    const lease = activeLease(it);
    const blockers = openBlockers(it);
    const inGroup = !!c.closest('.group');
    c.dataset.type = it.type;
    c.style.setProperty('--tilt', `${tilt(it.id)}deg`);
    for (const kv of decoVars(it.id).split(';')) { const [k, v] = kv.split(':'); c.style.setProperty(k, v); }
    c.dataset.slot = decoSlot(it.id);
    c.classList.toggle('needs', !!it.needsHuman);
    c.classList.toggle('focused', !state.focusId && focusBoards().some((f) => f.itemIds.includes(it.id)));
    c.classList.toggle('focus-active', !state.focusId && !!activeFocusBoard()?.itemIds.includes(it.id));
    const nq = it.questions?.length || (it.needsHuman ? 1 : 0);
    $('.c-ask', c).textContent = nq > 1 ? `?${nq}` : '?';
    c.classList.toggle('selected', state.selected.has(it.id));
    const ageN = Number(settings.ageDays);
    const age = ageN ? clamp((idleDays(it) - 1) / Math.max(1, ageN - 1), 0, 1) : 0;
    c.style.setProperty('--age', age.toFixed(2));
    c.classList.toggle('aged', age > 0.05);
    c.classList.toggle('review', it.needsHuman?.kind === 'review');
    c.classList.toggle('unseen', !!(state.boardId && seenFor(state.boardId).items[it.id]));
    markFresh(c, it.id);
    const sig = [it.version, settingsVersion, state.board.schema && JSON.stringify(state.board.schema).length, lease?.claimant, lease?.expiresAt, lease?.status, blockers.length, inGroup, state.listeners[it.id]?.join(','), Math.floor(idleDays(it))].join('|');
    if (c._sig === sig) return;
    const changed = c._v != null && c._v !== it.version;
    c._sig = sig;
    c._v = it.version;
    $('.c-body', c).innerHTML = cardHTML(it, lease, blockers, inGroup);
    tickRings(c);
    if (changed && !c.classList.contains('placeholder')) { c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); }
  }

  // Tickets that just landed get a themed "new" highlight for a few seconds.
  const freshUntil = new Map();
  const FRESH_MS = 4500;
  function markFresh(c, id) {
    const left = (freshUntil.get(id) || 0) - Date.now();
    if (left <= 0 || c.classList.contains('is-new')) return;
    c.classList.add('is-new');
    setTimeout(() => { c.classList.remove('is-new'); freshUntil.delete(id); }, left);
  }

  function idleDays(it) {
    const last = state.board?.columns[state.board.columns.length - 1]?.id;
    if (!it || it.columnId === last) return 0;
    const t = Math.max(Date.parse(it.updatedAt) || 0, Date.parse(it.enteredColumnAt) || 0);
    return Math.max(0, (nowMs() - t) / 86400000);
  }

  function checklist(d) {
    let total = 0;
    let done = 0;
    for (const l of String(d || '').split('\n')) { const m = /^\s*[-*+]\s+\[( |x|X)\]\s+\S/.exec(l); if (m) { total++; if (m[1] !== ' ') done++; } }
    return { total, done };
  }

  const TYPE_TIPS = { issue: 'Issue|Something is broken', task: 'Task|A piece of work to do', spike: 'Spike|Time-boxed research or investigation' };

  function stripMd(s) { return String(s).replace(/```[\s\S]*?```/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#>*_`~-]+/g, ' ').replace(/\s+/g, ' ').trim(); }

  function ringHTML(lease) {
    const kind = lease.claimant === settings.userName ? 'user' : 'agent';
    return `<span class="ring" data-exp="${esc(lease.expiresAt)}" data-min="${lease.minutes || 30}" title="Lease|${esc(nameOf(lease.claimant))} is working on this until ${new Date(lease.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}">${avatar({ kind, name: lease.claimant })}<svg viewBox="0 0 24 24"><circle class="trk" cx="12" cy="12" r="10.5" pathLength="100"/><circle class="prg" cx="12" cy="12" r="10.5" pathLength="100"/></svg></span>`;
  }

  // Human-readable rendering of a declared field value (cards, read-only views).
  function fieldText(def, v) {
    if (v == null) return '';
    switch (def.type) {
      case 'boolean': return v ? def.label : '';
      case 'tags': return v.join(', ');
      case 'date': { const d = new Date(v); return Number.isNaN(+d) ? String(v) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
      case 'url': try { return new URL(v).host; } catch { return v; }
      case 'markdown': return stripMd(v).slice(0, 60);
      default: return String(v);
    }
  }
  const optColor = (def, v) => def.options?.find((o) => o.value === v)?.color;

  function cardHTML(it, lease, blockers, inGroup, ls = state.listeners[it.id]) {
    const s = settings.stub;
    const PREF = { blockedBy: 'blocked', cover: 'thumbnail', assignee: 'assignee' };
    const stub = (k) => s[PREF[k] || k] && bi(k).stub && shown(k);
    const fields = schema().fields.filter((f) => f.ui !== 'hidden' && it.fields?.[f.key] != null && s.fields);
    const top = [];
    if (stub('type')) top.push(`<span class="c-type" title="${TYPE_TIPS[it.type]}">${icon(it.type, 'sm')}</span>`);
    if (s.id) top.push(`<span class="c-id">${esc(it.id)}</span>`);
    top.push('<span class="grow"></span>');
    for (const f of fields.filter((x) => x.stub === 'top')) {
      const t = fieldText(f, it.fields[f.key]);
      if (t) top.push(`<span class="fbadge" style="--fc:${esc(optColor(f, it.fields[f.key]) || 'var(--accent)')}" title="${esc(f.label)}|${esc(f.help || t)}">${esc(t)}</span>`);
    }
    if (stub('priority') && it.priority !== 'Medium') {
      const p = it.priority.toLowerCase();
      top.push(`<span class="prio" data-p="${p}" title="Priority|${it.priority}">${icon('flag')}${p === 'high' || p === 'critical' ? it.priority : ''}</span>`);
    }
    if (s.lease && lease) top.push(ringHTML(lease));
    const meta = [];
    if (stub('parent') && it.parent && !inGroup) meta.push(`<span class="chip parent" title="Parent|Grouped with other #${esc(it.parent)} tickets" style="--tagc:${tagColor(it.parent)}">${esc(it.parent)}</span>`);
    if (stub('blockedBy') && blockers.length) meta.push(`<span class="chip blocked" title="Blocked|Waiting on ${esc(blockers.join(', '))}">${icon('lock', 'sm')}${blockers.length}</span>`);
    for (const f of fields.filter((x) => x.stub === 'meta')) {
      const v = it.fields[f.key];
      const t = fieldText(f, v);
      if (!t) continue;
      const ic = ICONS[f.icon] ? f.icon : FIELD_ICON[f.type];
      meta.push(f.type === 'boolean'
        ? `<span class="fchip" style="--fc:var(--ok)" title="${esc(f.label)}">${icon(ic, 'sm')}${esc(f.label)}</span>`
        : `<span class="fchip" style="--fc:${esc(optColor(f, v) || 'var(--muted)')}" title="${esc(f.label)}">${icon(ic, 'sm')}<b>${esc(t)}</b></span>`);
    }
    const idle = Math.floor(idleDays(it));
    if (Number(settings.ageDays) && idle >= Math.ceil(Number(settings.ageDays) / 2)) meta.push(`<span class="m age" title="Untouched|No activity for ${idle} days">${icon('clock', 'sm')}${idle}d</span>`);
    if (s.comments && it.comments.length) meta.push(`<span class="m" title="Comments|${it.comments.length} in the thread">${icon('msg', 'sm')}${it.comments.length}</span>`);
    if (s.attachments && stub('attachments') && it.attachments.length) meta.push(`<span class="m" title="Files|${it.attachments.length} attached">${icon('clip', 'sm')}${it.attachments.length}</span>`);
    const nProps = Object.keys(it.properties || {}).length;
    if (s.properties && shown('properties') && nProps) meta.push(`<span class="m" title="Properties|Free-form data agents attached">${icon('braces', 'sm')}${nProps}</span>`);
    if (it.test) meta.unshift(`<span class="m test-tag" title="Test ticket|Disposable — anyone may delete it for good">${icon('flask', 'sm')}test</span>`);
    if (it.reviewers?.length) meta.push(`<span class="m revs">${it.reviewers.map((r) => reviewerTick(r)).join('')}</span>`);
    if (it.agentDraft) meta.push(`<span class="m drafting" title="Being written up|${esc(nameOf(it.agentDraft.writer))} is turning these notes into a full ticket${it.agentDraft.explicit.length ? ` — keeping ${esc(it.agentDraft.explicit.join(', '))}` : ''}">${icon('sparkle', 'sm')}drafting</span>`);
    if (stub('assignee') && it.assignee) meta.push(`<span class="m assn" title="${esc(bi('assignee').label)}|Handed to ${esc(nameOf(it.assignee))} — they get its events">${icon('move', 'sm')}${avatar({ name: it.assignee })}</span>`);
    const ck = checklist(it.description);
    if (s.checklist && ck.total) meta.push(`<span class="m" title="Checklist|${ck.done} of ${ck.total} done">${icon('checks', 'sm')}${ck.done}/${ck.total}</span>`);
    if (s.listeners && ls?.length) meta.push(`<span class="m listen" title="Listening|${esc(ls.join(', '))} ${ls.length > 1 ? 'get' : 'gets'} events about this ticket">${icon('radio', 'sm')}<span class="stack-av">${ls.slice(0, 3).map((n) => avatar({ kind: 'agent', name: n })).join('')}</span>${ls.length > 3 ? `+${ls.length - 3}` : ''}</span>`);
    const rx = Object.entries(it.reactions || {}).filter(([, w]) => w.length);
    if (rx.length) meta.push(`<span class="c-reacts" title="Reactions|${esc(rx.map(([e, w]) => `${e} ${w.join(', ')}`).join(' · '))}">${rx.slice(0, 3).map(([e, w]) => `<span>${e}${w.length > 1 ? `<b>${w.length}</b>` : ''}</span>`).join('')}${rx.length > 3 ? `<span class="more">+${rx.length - 3}</span>` : ''}</span>`);
    const hasMeta = meta.length > 0;
    if (s.author) meta.push('<span class="grow"></span>', avatar(it.author));
    const desc = s.description && shown('description') && it.description ? `<p class="c-desc">${esc(stripMd(it.description).slice(0, 220))}</p>` : '';
    const img = stub('cover') ? coverOf(it) : null;
    const thumb = img ? `<div class="c-thumb"><img src="${esc(img.url)}" alt="" loading="lazy" draggable="false"></div>` : '';
    // Without an ID the title goes to the top: the type icon leads it, and whatever else was on the
    // top row (priority, badges, lease timer) floats top-right with the title wrapping beside it.
    const right = top.slice(top.indexOf('<span class="grow"></span>') + 1);
    const lead = !s.id && stub('type') ? `<span class="c-type inline" title="${TYPE_TIPS[it.type]}">${icon(it.type, 'sm')}</span>` : '';
    const head = s.id ? `<div class="c-top">${top.join('')}</div>` : right.length ? `<div class="c-top float">${right.join('')}</div>` : '';
    return `${head}<h3 class="c-title ${lead ? 'has-lead' : ''}">${lead}${esc(it.title)}</h3>${s.status && lease?.status ? `<div class="c-status" title="Live status|Posted by ${esc(nameOf(lease.claimant))} while working"><i></i><span>${esc(lease.status)}</span></div>` : ''}${desc}${s.checklist && ck.total ? `<div class="c-prog ${ck.done === ck.total ? 'full' : ''}"><i style="width:${(ck.done / ck.total) * 100}%"></i></div>` : ''}${thumb}${hasMeta || s.author ? `<div class="c-meta">${meta.join('')}</div>` : ''}`;
  }

  function tickRings(root = document) {
    for (const r of $$('.ring[data-exp]', root)) {
      const left = Date.parse(r.dataset.exp) - nowMs();
      const frac = clamp(left / (Number(r.dataset.min) * 60000), 0, 1);
      const prg = $('.prg', r);
      const off = String(Math.round((100 - frac * 100) * 2) / 2);
      if (prg && prg.style.strokeDashoffset !== off) prg.style.strokeDashoffset = off;
      r.classList.toggle('warn', left < 5 * 60000 && left >= 60000);
      r.classList.toggle('crit', left < 60000);
      if (left <= 0) scheduleRefresh(800);
    }
  }

  /* ─── filter ─── */

  function parseQuery(q) {
    const f = { text: [], parent: null, prio: null, type: null, who: null, props: [], is: [] };
    for (const t of q.trim().split(/\s+/).filter(Boolean)) {
      const low = t.toLowerCase();
      if (t[0] === '#' && t.length > 1) f.parent = low.slice(1);
      else if (t[0] === '!' && t.length > 1) f.prio = low.slice(1);
      else if (t[0] === '/' && t.length > 1) f.type = low.slice(1);
      else if (t[0] === '@' && t.length > 1) f.who = low.slice(1);
      else if (low.startsWith('is:')) f.is.push(low.slice(3));
      else if (/^[\w.-]+[:=].+/.test(t)) { const i = t.search(/[:=]/); f.props.push([low.slice(0, i), low.slice(i + 1)]); }
      else f.text.push(low);
    }
    return f;
  }
  function matches(it, f) {
    if (f.parent && !(it.parent || '').toLowerCase().includes(f.parent)) return false;
    if (f.prio && !it.priority.toLowerCase().startsWith(f.prio)) return false;
    if (f.type && !it.type.startsWith(f.type)) return false;
    if (f.who) {
      const names = [it.author?.name, activeLease(it)?.claimant].filter(Boolean).map((x) => x.toLowerCase());
      if (!names.some((n) => n.includes(f.who))) return false;
    }
    for (const flag of f.is) {
      if (flag === 'needs' && !it.needsHuman) return false;
      if (flag === 'blocked' && !openBlockers(it).length) return false;
      if (flag === 'leased' && !activeLease(it)) return false;
      if (flag === 'free' && activeLease(it)) return false;
    }
    const bag = { ...(it.properties || {}), ...(it.fields || {}) };
    for (const [k, v] of f.props) {
      const key = Object.keys(bag).find((x) => x.toLowerCase() === k);
      if (!key || !JSON.stringify(bag[key]).toLowerCase().includes(v)) return false;
    }
    if (f.text.length) {
      const hay = `${it.id} ${it.title} ${it.description} ${it.parent || ''}`.toLowerCase();
      if (!f.text.every((t) => hay.includes(t))) return false;
    }
    return true;
  }
  function applyFilter() {
    const q = state.query.trim();
    const f = q ? parseQuery(q) : null;
    for (const [id, c] of cardEls) c.classList.toggle('dim', !!f && !matches(state.board.items[id], f));
  }

  /* ═════════════════════════ drag & drop ═════════════════════════ */

  function onCardPointerDown(e) {
    if (e.button !== 0 || e.target.closest('button, a, input, textarea, .avatar')) return;
    const card = e.currentTarget;
    if (card.closest('.group.stack:not(.open)')) return;
    const id = card.dataset.id;
    const start = { x: e.clientX, y: e.clientY };
    const move = (ev) => {
      if (!drag) {
        if (state.bulk || Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        beginDrag(card, id, start);
      }
      ev.preventDefault();
      dragMove(ev);
    };
    const up = (ev) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      if (drag) endDrag(ev.type === 'pointercancel');
      else if (ev.type === 'pointerup') { if (state.bulk) toggleSelect(id); else openItem(id, card); }
    };
    addEventListener('pointermove', move, { passive: false });
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }

  function beginDrag(card, id, start) {
    const r = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('flash', 'landed');
    Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px` });
    document.body.append(ghost);
    const from = colById(state.board.items[id].columnId);
    ghost.style.willChange = 'translate, rotate';
    drag = { id, card, ghost, x0: r.left, y0: r.top, off: { x: start.x - r.left, y: start.y - r.top }, fromCol: from.id, targetCol: from.id, beforeId: undefined, key: null, px: start.x, tilt: 0, pointer: start };
    card.classList.add('placeholder');
    document.body.classList.add('dragging');
    for (const col of state.board.columns) {
      const full = col.flags.wipLimit > 0 && col.itemIds.length >= col.flags.wipLimit;
      const ok = col.id === from.id || (from.flags.allowMoveOut && col.flags.allowMoveIn && !full);
      colEls.get(col.id).classList.add(ok ? 'drop-ok' : 'drop-no');
    }
    ghost.animate([{ scale: 1 }, { scale: 1.04 }], { duration: 180, fill: 'forwards', easing: SPRING });
    autoScrollLoop();
  }

  function dropSlots(list, exclude) {
    const slots = [];
    for (const child of list.children) {
      if (child === exclude) continue;
      if (child.classList.contains('card')) slots.push({ el: child, firstId: child.dataset.id });
      else if (child.classList.contains('group')) {
        const cards = $$('.card', child).filter((x) => x !== exclude);
        if (!cards.length) continue;
        if ((child.classList.contains('stack') && !child.classList.contains('open')) || child.classList.contains('folded')) slots.push({ el: child, firstId: cards[0].dataset.id });
        else for (const c of cards) slots.push({ el: c, firstId: c.dataset.id });
      }
    }
    return slots;
  }

  function dragMove(ev) {
    const d = drag;
    d.pointer = { x: ev.clientX, y: ev.clientY };
    const vx = ev.clientX - d.px;
    d.px = ev.clientX;
    d.tilt = clamp(d.tilt * 0.75 + vx * 0.5, -10, 10);
    d.ghost.style.translate = `${ev.clientX - d.off.x - d.x0}px ${ev.clientY - d.off.y - d.y0}px`;
    d.ghost.style.rotate = `${2 + d.tilt * 0.6}deg`;
    const colEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.column');
    $$('.column.hover').forEach((x) => x !== colEl && x.classList.remove('hover'));
    if (!colEl || !colEl.classList.contains('drop-ok')) return;
    colEl.classList.add('hover');
    const list = $('.list', colEl);
    let target = null;
    for (const s of dropSlots(list, d.card)) {
      const r = s.el.getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) { target = s; break; }
    }
    const key = `${colEl.dataset.id}:${target ? target.firstId : '$end'}`;
    if (key === d.key) return;
    d.key = key;
    const before = snapshotRects();
    before.delete(d.card);
    if (target) target.el.parentNode.insertBefore(d.card, target.el);
    else list.appendChild(d.card);
    if (d.targetCol !== colEl.dataset.id && !reduced()) {
      d.card.animate([{ opacity: 0, scale: 0.97 }, { opacity: 1, scale: 1 }], { duration: 420, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    }
    d.targetCol = colEl.dataset.id;
    d.beforeId = target ? target.firstId : null;
    flip(before, { flights: false });
  }

  function autoScrollLoop() {
    if (!drag) return;
    const { x, y } = drag.pointer;
    const board = $('#board');
    const edge = 70;
    if (x < edge) board.scrollLeft -= (edge - x) / 4;
    else if (x > innerWidth - edge) board.scrollLeft += (x - (innerWidth - edge)) / 4;
    const list = document.elementFromPoint(x, y)?.closest('.column')?.querySelector('.list');
    if (list) {
      const r = list.getBoundingClientRect();
      if (y < r.top + 50) list.scrollTop -= (r.top + 50 - y) / 4;
      else if (y > r.bottom - 50) list.scrollTop += (y - (r.bottom - 50)) / 4;
    }
    requestAnimationFrame(autoScrollLoop);
  }

  async function endDrag(cancelled) {
    const d = drag;
    drag = null;
    document.body.classList.remove('dragging');
    $$('.column').forEach((c) => c.classList.remove('drop-ok', 'drop-no', 'hover'));
    const r = d.card.getBoundingClientRect();
    d.ghost.animate([
      { translate: d.ghost.style.translate || '0px 0px', rotate: d.ghost.style.rotate, scale: 1.04 },
      { translate: `${r.left - d.x0}px ${r.top - d.y0}px`, rotate: `${tilt(d.id)}deg`, scale: 1 },
    ], { duration: reduced() ? 1 : 260, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'forwards' }).onfinish = () => {
      d.ghost.remove(); d.card.classList.remove('placeholder', 'landed'); void d.card.offsetWidth; d.card.classList.add('landed');
    };
    const col = colById(d.fromCol);
    const origIdx = col.itemIds.indexOf(d.id);
    const nextOrig = col.itemIds[origIdx + 1] ?? null;
    const unchanged = d.key === null || (d.targetCol === d.fromCol && (d.beforeId === nextOrig || d.beforeId === d.id));
    if (cancelled || unchanged) { setTimeout(render, 280); return; }
    // optimistic local move so a re-render doesn't snap back before the server answers
    col.itemIds.splice(origIdx, 1);
    const to = colById(d.targetCol);
    const at = d.beforeId ? to.itemIds.indexOf(d.beforeId) : -1;
    to.itemIds.splice(at < 0 ? to.itemIds.length : at, 0, d.id);
    state.board.items[d.id].columnId = to.id;
    setTimeout(render, 270);
    const body = { column: d.targetCol };
    if (d.beforeId) body.beforeId = d.beforeId; else body.position = 'bottom';
    try { await api('POST', I(d.id, '/move'), body); } catch (e) { toast(e.message, { kind: 'error' }); }
    scheduleRefresh(0);
  }

  /* ═════════════════════════ bulk ═════════════════════════ */

  function setBulk(on) {
    state.bulk = on;
    state.selected.clear();
    document.body.classList.toggle('bulk', on);
    $('#bulkBtn').classList.toggle('on', on);
    render();
  }
  function toggleSelect(id) {
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    updateCard(cardEls.get(id), state.board.items[id]);
    renderBulkBar(true);
  }
  function renderBulkBar(bump) {
    const bar = $('#bulkbar');
    const n = state.selected.size;
    bar.classList.toggle('show', state.bulk);
    if (!bar.firstChild) {
      bar.innerHTML = `<span class="count"></span>
        <button class="btn ghost" data-a="move">${icon('move')}<span>Move</span></button>
        <button class="btn ghost" data-a="prio">${icon('flag')}<span>Priority</span></button>
        <button class="btn ghost" data-a="focus" title="Focus board|Make a focus board of these tickets, or add them to one">${icon('target')}<span>Focus</span></button>
        <button class="btn danger" data-a="archive">${icon('archive')}<span>Archive</span></button>
        <button class="btn ghost" data-a="close" title="Done">${icon('x')}</button>`;
      bar.onclick = (e) => {
        const btn = e.target.closest('button');
        const a = btn?.dataset.a;
        if (a === 'close') setBulk(false);
        if (a === 'archive') bulkArchive();
        if (a === 'move') menu(btn, state.board.columns.map((c) => ({ label: c.name, color: c.color, disabled: !c.flags.allowMoveIn, run: () => bulkPatch({ column: c.id }) })), { up: true });
        if (a === 'focus') focusMenu(btn);
        if (a === 'prio') menu(btn, PRIORITIES.map((p) => ({ label: p, color: PRIO_VAR[p], run: () => bulkPatch({ priority: p }) })), { up: true });
      };
    }
    const cnt = $('.count', bar);
    cnt.textContent = n;
    if (bump) { cnt.classList.remove('bump'); void cnt.offsetWidth; cnt.classList.add('bump'); }
    $$('button[data-a]:not([data-a="close"])', bar).forEach((b) => { b.disabled = !n; });
  }
  async function bulkPatch(patch) {
    const res = await api('POST', B('/items/bulk'), { ids: [...state.selected], patch });
    const failed = res.filter((r) => !r.ok);
    if (failed.length) toast(`${failed.length} skipped · ${failed[0].error}`, { kind: 'error' });
    scheduleRefresh(0);
  }
  async function bulkArchive() {
    const ids = [...state.selected];
    try {
      await api('POST', B('/archive'), { ids });
      state.selected.clear();
      toast(`Archived ${ids.length}`, { icon: 'archive', action: 'Undo', onAction: () => restoreMany(ids) });
      scheduleRefresh(0);
    } catch (e) { toast(e.message, { kind: 'error' }); }
  }
  async function restoreMany(ids) {
    for (const id of ids) { try { await api('POST', B(`/archive/${encodeURIComponent(id)}/restore`), {}); } catch { /* already restored */ } }
    scheduleRefresh(0);
  }

  /* ═════════════════════════ markdown ═════════════════════════ */

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
  function md(src, { tasks = false } = {}) {
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

  document.addEventListener('click', (e) => {
    const av = e.target.closest('.avatar[data-name]');
    if (av && !e.target.closest('button, .dd, .menu, .tile, .swatches')) { e.preventDefault(); openAgent(av.dataset.name); return; }
    const ref = e.target.closest('a.ref');
    if (ref) { e.preventDefault(); if (state.board.items[ref.dataset.ref]) openItem(ref.dataset.ref); return; }
    const img = e.target.closest('.md img, .att img, .cmt-atts img');
    if (img) { e.preventDefault(); lightbox(img.src); }
  });

  function lightbox(src) {
    const lb = el(`<div class="lightbox"><img src="${esc(src)}" alt=""></div>`);
    lb.onclick = () => lb.remove();
    document.body.append(lb);
  }

  /* ═════════════════════════ scrims, shared-element morph ═════════════════════════ */

  function syncScrimmed() { document.body.classList.toggle('scrimmed', !!$('.scrim:not(.closing):not(.closing-morph)')); }

  // Grow the modal out of the card: start at the card's exact rect, cross-fade a copy of the card away.
  function morphOpen(modal, fromEl) {
    if (reduced() || !fromEl?.isConnected) { modal.classList.add('pop'); return null; }
    const r = fromEl.getBoundingClientRect();
    if (!r.width || r.bottom < 0 || r.top > innerHeight) { modal.classList.add('pop'); return null; }
    const mr = modal.getBoundingClientRect();
    const sx = r.width / mr.width;
    const sy = r.height / mr.height;
    const ghost = fromEl.cloneNode(true);
    ghost.classList.add('morph-ghost');
    ghost.classList.remove('flash', 'landed', 'morph-src', 'selected');
    Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    document.body.append(ghost);
    fromEl.classList.add('morph-src');
    const dur = 280;
    const ease = 'cubic-bezier(.2,.8,.2,1)';
    modal.animate([
      { transformOrigin: '0 0', transform: `translate(${r.left - mr.left}px, ${r.top - mr.top}px) scale(${sx}, ${sy})` },
      { transformOrigin: '0 0', transform: 'none' },
    ], { duration: dur, easing: ease });
    for (const c of modal.children) c.animate([{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1 }], { duration: dur, easing: 'ease-out' });
    ghost.animate([
      { transform: 'none', opacity: 1 },
      { transform: `translate(${mr.left - r.left}px, ${mr.top - r.top}px) scale(${mr.width / r.width}, ${mr.height / r.height})`, opacity: 0, offset: 0.55 },
      { transform: `translate(${mr.left - r.left}px, ${mr.top - r.top}px) scale(${mr.width / r.width}, ${mr.height / r.height})`, opacity: 0 },
    ], { duration: dur, easing: ease }).onfinish = () => ghost.remove();
    return fromEl;
  }

  function closeModal(instant) {
    const m = state.modal;
    if (!m) return;
    if (!instant && isDirty(m)) {
      if (Date.now() - (m.nudgedAt || 0) > 1500) { nudgeDraft(m); return; }
      m.draft = {};
      toast('Changes discarded', { icon: 'x', timeout: 1800 });
    }
    state.modal = null;
    if (m.pendingFiles?.length) dropStaged(m); // a cancelled new ticket uploaded nothing; free the previews
    closeMenus();
    // Prefer the live card for this item (the board may have re-rendered while the modal was open).
    const src = (m.kind === 'item' && cardEls.get(m.id)) || m.src;
    const finish = () => {
      m.root.remove();
      for (const c of [m.src, src]) c?.classList.remove('morph-src', 'is-open');
      syncScrimmed();
    };
    const r = src?.isConnected ? src.getBoundingClientRect() : null;
    const morph = m.enter === 'zoom' && !instant && !reduced() && r && r.width && r.bottom > 0 && r.top < innerHeight;
    // A morph keeps the modal visible and only fades the scrim's tint; otherwise the whole scrim fades.
    m.root.classList.add(morph ? 'closing-morph' : 'closing');
    syncScrimmed();
    if (instant || reduced()) { finish(); return; }
    if (morph) {
      src.classList.add('morph-src');
      const mr = m.modal.getBoundingClientRect();
      const sx = r.width / mr.width;
      const sy = r.height / mr.height;
      const dur = 240;
      const ease = 'cubic-bezier(.4,0,.2,1)';
      for (const c of m.modal.children) c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, fill: 'forwards' });
      m.modal.animate([
        { transformOrigin: '0 0', transform: 'none', opacity: 1 },
        { transformOrigin: '0 0', transform: `translate(${r.left - mr.left}px, ${r.top - mr.top}px) scale(${sx}, ${sy})`, opacity: 1, offset: 0.85 },
        { transformOrigin: '0 0', transform: `translate(${r.left - mr.left}px, ${r.top - mr.top}px) scale(${sx}, ${sy})`, opacity: 0 },
      ], { duration: dur, easing: ease, fill: 'forwards' });
      // The card itself fades in as the modal arrives, so the panel visibly "becomes" the stub.
      const ghost = src.cloneNode(true);
      ghost.classList.add('morph-ghost');
      ghost.classList.remove('flash', 'landed', 'morph-src', 'selected');
      Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      document.body.append(ghost);
      ghost.animate([
        { transform: `translate(${mr.left - r.left}px, ${mr.top - r.top}px) scale(${1 / sx}, ${1 / sy})`, opacity: 0 },
        { opacity: 0, offset: 0.35 },
        { transform: 'none', opacity: 1 },
      ], { duration: dur, easing: ease, fill: 'forwards' }).onfinish = () => {
        finish();
        ghost.remove();
        src.classList.remove('landed'); void src.offsetWidth; src.classList.add('landed');
      };
    } else {
      m.modal.classList.remove('entering');
      m.modal.classList.add('leaving');
      setTimeout(() => { finish(); if (src && m.kind === 'item') { src.classList.remove('landed'); void src.offsetWidth; src.classList.add('landed'); } }, 170);
    }
  }

  function pulseSaved() {
    const s = state.modal && $('.saved', state.modal.root);
    if (!s) return;
    s.classList.add('show');
    clearTimeout(s._t);
    s._t = setTimeout(() => s.classList.remove('show'), 1400);
  }

  /* ═════════════════════════ item modal ═════════════════════════ */

  async function fetchItem(id) {
    if (state.board.items[id]) return { item: state.board.items[id], archived: false };
    const it = await api('GET', I(id));
    return { item: it, archived: !!it.archived };
  }

  async function openItem(id, fromEl, { rail = false } = {}) {
    let got;
    try { got = await fetchItem(id); } catch (e) { toast(e.message, { kind: 'error' }); return; }
    closePalette();
    clearUnseen(id);
    markInboxItemRead(id);
    const cur = state.modal;
    if (cur?.kind === 'item') { cur.rail = rail || cur.rail; cur.switchTo(id, got); return; }
    closeModal(true);
    const root = el(`<div class="scrim"><div class="modal item-modal" role="dialog" aria-modal="true">
      <header class="m-head"><span class="m-type"></span><span class="m-id" title="Copy ID|Copy the ticket number to the clipboard"></span><span class="saved">${icon('check', 'sm')}</span><span class="grow"></span>
        <button class="pill-btn icon-btn sm" data-a="delete" hidden title="Delete|A test ticket: removed for good, with its comments and files">${icon('trash')}</button>
        <button class="pill-btn icon-btn sm" data-a="archive" title="Archive|Kept in the archive and restorable — tickets are never deleted">${icon('archive')}</button>
        <button class="pill-btn icon-btn sm" data-a="close" title="Close">${icon('x')}</button></header>
      <div class="m-frame"><nav class="m-rail" hidden></nav><div class="m-main"></div><aside class="m-side"></aside></div>
      <div class="m-save" hidden><span class="dot"></span><span class="txt"></span><span class="grow"></span>
        <button class="btn ghost sm" data-draft="discard">Discard</button><button class="btn primary sm" data-draft="save" title="Save|Apply your changes (Ctrl+S)">${icon('check', 'sm')}Save</button></div>
      <footer class="m-foot"></footer></div></div>`);
    document.body.append(root);
    syncScrimmed();
    const m = { kind: 'item', id, root, modal: $('.modal', root), item: got.item, archived: got.archived, rail, tab: 'comments', editingDesc: false, staged: [], draft: {}, baseVersion: null };
    state.modal = m;
    m.enter = pick('enter');
    if (m.enter === 'zoom') m.src = morphOpen(m.modal, fromEl);
    else { m.modal.classList.add('entering'); m.src = fromEl?.isConnected ? fromEl : null; m.src?.classList.add('is-open'); }
    m.refresh = () => {
      if (m.rail) renderRail(m);
      const fresh = state.board.items[m.id];
      if (!fresh) {
        if (!m.archived) { if (m.rail && needsIds().length) { m.switchTo(needsIds()[0]); return; } closeModal(); toast(`${m.id} archived`, { icon: 'archive' }); }
        return;
      }
      const changed = fresh.version !== m.item.version;
      const answered = !!m.item.needsHuman && !fresh.needsHuman;
      m.item = fresh;
      if (m.rail && answered) { advanceRail(m); return; }
      pruneDraft(m);
      fillModal(m);
      renderSaveBar(m);
      if (changed && m.tab === 'activity') loadActivity(m);
    };
    m.switchTo = async (nid, pre) => {
      if (nid === m.id && !pre) return;
      if (isDirty(m) && !pre?.force) { nudgeDraft(m); return; }
      const g = pre || await fetchItem(nid).catch(() => null);
      if (!g) return;
      if (m.src) m.src.classList.remove('morph-src', 'is-open');
      m.src = cardEls.get(nid) || null;
      if (m.src && state.modal === m) m.src.classList.add(m.enter === 'zoom' ? 'morph-src' : 'is-open');
      Object.assign(m, { id: nid, item: g.item, archived: g.archived, editingDesc: false, staged: [], tab: 'comments', draft: {}, baseVersion: null });
      renderSaveBar(m);
      buildModalBody(m);
      for (const n of [$('.m-main', root), $('.m-side', root)]) { n.classList.remove('swap-in'); void n.offsetWidth; n.classList.add('swap-in'); n.scrollTop = 0; }
    };
    wireModalShell(m);
    buildModalBody(m);
  }

  /* ─── create mode: write a whole ticket in the ticket modal, then create it ─── */

  function blankItem(colId) {
    const t = new Date().toISOString();
    const fields = {};
    for (const f of schema().fields) if (f.default !== undefined && f.default !== null) fields[f.key] = f.default;
    return {
      id: 'NEW', title: '', description: '', type: 'task', priority: 'Medium', parent: null, columnId: colId, assignee: null,
      blockedBy: [], properties: {}, fields, cover: 'auto', attachments: [], comments: [], questions: [], needsHuman: null,
      reactions: {}, version: 0, author: { kind: 'user', name: settings.userName }, createdAt: t, updatedAt: t, flow: [],
    };
  }

  function openCreate(colId, { template = null } = {}) {
    const col = colById(colId);
    if (!col) return;
    if (!col.flags.allowCreate) { toast(`"${col.name}" doesn't take new tickets`, { kind: 'error' }); return; }
    if (col.flags.wipLimit > 0 && col.itemIds.length >= col.flags.wipLimit) { toast(`"${col.name}" is at its WIP limit`, { kind: 'error' }); return; }
    closePalette();
    closeModal(true);
    const root = el(`<div class="scrim"><div class="modal item-modal creating" role="dialog" aria-modal="true">
      <header class="m-head"><span class="m-type" style="color:var(--accent)">${icon('plus')}</span><span class="m-id">New ticket</span><span class="saved">${icon('check', 'sm')}</span><span class="grow"></span>
        <button class="pill-btn icon-btn sm" data-a="archive" hidden></button>
        <button class="pill-btn icon-btn sm" data-a="close" title="Close">${icon('x')}</button></header>
      <div class="m-frame"><nav class="m-rail" hidden></nav><div class="m-main"></div><aside class="m-side"></aside></div>
      <div class="m-save"><span class="dot"></span><span class="txt"></span><span class="grow"></span>
        <button class="agent-write test-flag" type="button" aria-pressed="false" title="Test ticket|Disposable: anyone may delete it for good later. Can't be changed after Create"><i class="sw"></i>${icon('flask', 'sm')}<span>Test</span></button>
        <button class="agent-write" data-aw type="button" aria-pressed="false"></button>
        <button class="btn ghost sm" data-draft="discard">Cancel</button><button class="btn primary sm" data-draft="save" title="Create|Create the ticket (Ctrl+Enter)">${icon('plus', 'sm')}Create</button></div>
      <footer class="m-foot"></footer></div></div>`);
    document.body.append(root);
    syncScrimmed();
    const m = { kind: 'item', create: { columnId: colId, template: null }, id: 'NEW', root, modal: $('.modal', root), item: blankItem(colId), archived: false, rail: false, tab: 'comments', editingDesc: false, staged: [], draft: {}, baseVersion: 0 };
    state.modal = m;
    m.enter = pick('enter');
    m.modal.classList.add('entering');
    m.refresh = () => { fillModal(m); renderSaveBar(m); };
    m.switchTo = async (nid) => { closeModal(true); openItem(nid); };
    wireModalShell(m);
    buildModalBody(m);
    // template chips above the title
    const tpls = state.board.ticketTemplates || [];
    if (tpls.length) {
      const row = el(`<div class="create-tpls">${tpls.map((t) => `<button class="tpl-chip" data-tpl="${esc(t.key)}" title="${esc(t.label)}|${esc(t.help || 'Start from this template')}">${icon(t.icon || t.type || 'task', 'sm')}${esc(t.label)}</button>`).join('')}</div>`);
      $('.m-main', root).prepend(row);
      row.onclick = (e) => { const b = e.target.closest('[data-tpl]'); if (b) applyTemplateToDraft(m, b.dataset.tpl); };
    }
    if (template) applyTemplateToDraft(m, template);
    // "Let the agent write it": the coordinator turns these notes into a full ticket, keeping what you set.
    const aw = $('[data-aw]', root);
    const tf = $('.test-flag', root);
    tf.onclick = () => { m.create.test = !m.create.test; tf.setAttribute('aria-pressed', String(m.create.test)); };
    const writer = state.board.coordinator;
    const drawAw = () => {
      m.create.agentWrite = !!writer && !!settings.agentWrite;
      aw.setAttribute('aria-pressed', String(m.create.agentWrite));
      aw.disabled = !writer;
      aw.innerHTML = `<i class="sw"></i>${writer ? avatar({ kind: 'agent', name: writer }) : icon('sparkle', 'sm')}<span>Let ${writer ? esc(nameOf(writer)) : 'the agent'} write it</span>`;
      aw.title = writer ? `Let ${nameOf(writer)} write it|Write rough notes; ${nameOf(writer)} turns them into a full ticket — title, description with a checklist, type, priority, fields — but keeps anything you set here yourself` : 'No coordinator|Choose one on the Agents page to let an agent write tickets';
    };
    aw.onclick = () => { settings.agentWrite = !settings.agentWrite; saveSettings(); drawAw(); };
    drawAw();
    renderSaveBar(m);
    const title = $('.m-title', root);
    title.placeholder = 'Title — quick syntax works: #parent !high /issue';
    setTimeout(() => title.focus(), 60);
    // Ctrl+Enter anywhere in the modal creates it (the description box keeps Ctrl+Enter for itself)
    m.modal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.target.closest('.desc-edit, .fmd')) { e.preventDefault(); $('.m-title', root).blur(); saveDraft(m); }
    });
  }

  // Fill from a template without overwriting anything the user already set.
  function applyTemplateToDraft(m, key) {
    const t = (state.board.ticketTemplates || []).find((x) => x.key === key);
    if (!t) return;
    m.create.template = t.key;
    const d = m.draft;
    const patch = {};
    for (const k of ['type', 'priority', 'parent', 'description']) if (t[k] && !(k in d)) patch[k] = t[k];
    if (t.title && !d.title) patch.title = t.title;
    if (t.column && !d.column && colById(t.column)) patch.column = colById(t.column).id;
    const fields = {};
    for (const [k, v] of Object.entries(t.fields || {})) if (!(d.fields && k in d.fields)) fields[k] = v;
    if (Object.keys(fields).length) patch.fields = fields;
    $$('.create-tpls .tpl-chip', m.root).forEach((b) => b.classList.toggle('on', b.dataset.tpl === t.key));
    m.create.fromTemplate = new Set([...(m.create.fromTemplate || []), ...Object.keys(patch).filter((k) => k !== 'fields'), ...Object.keys(fields).map((k) => `fields.${k}`)]);
    m.create.applyingTpl = true;
    editItem(m, patch);
    m.create.applyingTpl = false;
  }

  async function createFromDraft(m) {
    const d = draftView(m);
    // read the title box directly too: Create can be pressed while it still has focus
    const q = parseQuick($('.m-title', m.root)?.value || d.title);
    const err = (msg) => {
      let box = $('.create-err', m.root);
      if (!box) { box = el('<div class="create-err"></div>'); $('.m-main', m.root).prepend(box); }
      box.innerHTML = `${icon('x', 'sm')}<span></span>`;
      $('span', box).textContent = msg;
    };
    if (!q.title) { err('Give it a title'); $('.m-title', m.root).focus(); return; }
    if (m.creating) return; // a double click must not make two tickets
    const fields = Object.fromEntries(Object.entries(d.fields || {}).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length)));
    const body = {
      title: q.title, column: d.columnId, position: 'top',
      type: q.type || d.type, priority: q.priority || d.priority, parent: q.parent || d.parent || undefined,
      description: d.description || undefined, assignee: d.assignee || undefined,
      blockedBy: d.blockedBy?.length ? d.blockedBy : undefined,
      ...(Object.keys(fields).length ? { fields } : {}),
      ...(Object.keys(d.properties || {}).length ? { properties: d.properties } : {}),
      ...(q.template || m.create.template ? { template: q.template || m.create.template } : {}),
    };
    if (m.create.test) body.test = true;
    if (m.create.agentWrite) {
      // explicit = what you set here yourself (not the template's defaults); title and description are the notes
      const tpl = m.create.fromTemplate || new Set();
      const keys = [
        ...Object.keys(d.draft || m.draft).filter((k) => !['title', 'description', 'column', 'columnId', 'position', 'fields', 'properties'].includes(k)),
        ...Object.keys(m.draft.fields || {}).map((k) => `fields.${k}`),
        ...Object.keys(m.draft.properties || {}).map((k) => `properties.${k}`),
      ].filter((k) => !tpl.has(k));
      for (const k of ['type', 'priority', 'parent']) if (q[k]) keys.push(k); // quick syntax: #parent !high /issue
      Object.assign(body, { agentWrite: true, explicit: [...new Set(keys)] });
    }
    m.creating = true;
    m.root.classList.add('busy');
    try {
      const it = await api('POST', B('/items'), withFocus(body));
      if (m.pendingFiles?.length) await uploadStaged(m, it.id, body.description || '');
      m.draft = {};
      // Done: close, and let the board show the new card (it gets the new-ticket highlight).
      if (state.modal === m) closeModal(true);
      toast(it.agentDraft ? `Created ${it.id} — ${nameOf(it.agentDraft.writer)} is writing it up` : `Created ${it.id}`, { icon: it.agentDraft ? 'sparkle' : 'plus', kind: 'ok', timeout: 3000, action: 'Open', onAction: () => openItem(it.id) });
      await loadBoard(state.boardId);
    } catch (e) {
      // stay open with everything typed, and say why
      err(e.message);
    } finally { m.creating = false; m.root.classList.remove('busy'); }
  }

  function wireModalShell(m) {
    const { root } = m;
    root.addEventListener('pointerdown', (e) => { root._down = e.target === root; });
    root.addEventListener('click', (e) => { if (e.target === root && root._down) closeModal(); });
    $('[data-a="close"]', root).onclick = () => closeModal();
    $('.m-save', root).onclick = (e) => {
      const a = e.target.closest('[data-draft]')?.dataset.draft;
      if (a === 'save') saveDraft(m);
      if (a === 'discard') discardDraft(m);
    };
    const del = $('[data-a="delete"]', root);
    if (del) del.onclick = () => armDelete(del, [m.id], () => { m.draft = {}; closeModal(true); });
    $('[data-a="archive"]', root).onclick = async () => {
      if (m.archived) return;
      const keep = m.id;
      try {
        await api('POST', I(keep, '/archive'), {});
        m.draft = {};
        if (!m.rail || !needsIds().filter((x) => x !== keep).length) closeModal();
        toast(`Archived ${keep}`, { icon: 'archive', action: 'Undo', onAction: () => restoreMany([keep]) });
        scheduleRefresh(0);
      } catch (e) { toast(e.message, { kind: 'error' }); }
    };
    $('.m-id', root).onclick = () => { navigator.clipboard?.writeText(m.id); toast(`Copied ${m.id}`, { icon: 'copy', timeout: 1500 }); };

    const modal = m.modal;
    modal.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      const box = e.target.closest('.cmt-compose .tbox');
      $$('.tbox.drop', modal).forEach((b) => b !== box && b.classList.remove('drop'));
      if (box) box.classList.add('drop');
      modal.classList.toggle('dropping', !box);
    });
    modal.addEventListener('dragleave', (e) => { if (!modal.contains(e.relatedTarget)) { modal.classList.remove('dropping'); $$('.tbox.drop', modal).forEach((b) => b.classList.remove('drop')); } });
    modal.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      modal.classList.remove('dropping');
      const box = e.target.closest('.cmt-compose .tbox');
      $$('.tbox.drop', modal).forEach((b) => b.classList.remove('drop'));
      if (box) stageFiles(m, [...e.dataTransfer.files]);
      else if (canEdit('attachments') && !m.archived) uploadFiles(m, [...e.dataTransfer.files]);
    });
    modal.addEventListener('paste', async (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return;
      const target = e.target.closest('textarea');
      e.preventDefault();
      if (target?.closest('.cmt-compose')) { stageFiles(m, files); return; }
      if (!canEdit('attachments') || m.archived) return;
      // A new ticket has nowhere to attach to yet: preview the files locally, upload them after Create.
      const atts = m.create ? stageForCreate(m, files) : await uploadFiles(m, files);
      if (target && target.closest('.desc-edit')) {
        const snippet = atts.map((a) => (isImage(a) ? `![${a.name}](${a.url})` : `[${a.name}](${a.url})`)).join('\n');
        const s = target.selectionStart;
        target.value = target.value.slice(0, s) + snippet + target.value.slice(target.selectionEnd);
        autosize(target);
      }
    });
  }

  /* ─── needs-you rail ─── */

  function renderRail(m) {
    const rail = $('.m-rail', m.root);
    const frame = $('.m-frame', m.root);
    rail.hidden = !m.rail;
    frame.classList.toggle('has-rail', m.rail);
    if (!m.rail) return;
    const ids = needsIds();
    if (!rail.firstChild) rail.innerHTML = `<div class="rail-head">${icon('ask', 'sm')}<span>Needs you</span><span class="n"></span></div>`;
    $('.rail-head .n', rail).textContent = ids.length;
    const existing = new Map($$('.rail-tab', rail).map((t) => [t.dataset.id, t]));
    for (const [id, t] of existing) {
      if (!ids.includes(id) && !t.classList.contains('leaving')) { t.classList.add('leaving'); setTimeout(() => t.remove(), 400); }
    }
    let prev = $('.rail-head', rail);
    ids.forEach((id, i) => {
      const it = state.board.items[id];
      let t = existing.get(id);
      if (!t || t.classList.contains('leaving')) {
        t = el(`<button class="rail-tab" data-id="${esc(id)}" style="animation-delay:${i * 40}ms"></button>`);
        t.onclick = () => m.switchTo(id);
      }
      t.innerHTML = `${avatar({ kind: 'agent', name: it.needsHuman.raisedBy })}<span class="t">${esc(it.title)}</span><span class="s">${esc(id)} · ${rel(it.needsHuman.raisedAt)}</span>`;
      t.classList.toggle('on', id === m.id);
      if (prev.nextSibling !== t) prev.after(t);
      prev = t;
    });
  }

  function advanceRail(m) {
    const left = needsIds();
    renderRail(m);
    if (left.length) { setTimeout(() => { if (state.modal === m) m.switchTo(left[0]); }, 450); return; }
    $('.m-main', m.root).innerHTML = `<div class="all-clear">${icon('check')}<span>All clear</span></div>`;
    $('.m-side', m.root).innerHTML = '';
    setTimeout(() => { if (state.modal === m) closeModal(); }, 1100);
  }

  /* ─── body ─── */

  function buildModalBody(m) {
    const main = $('.m-main', m.root);
    const editDesc = canEdit('description') && !m.archived;
    main.innerHTML = `
      <div class="ask-slot"></div>
      <div class="m-title-wrap"><textarea class="m-title" rows="1" spellcheck="true"></textarea><button class="tb-ok" title="Save title">${icon('check')}</button></div>
      <div class="m-sub"></div>
      ${shown('description') ? `<div class="desc"><div class="md desc-view ${editDesc ? 'editable' : ''}" data-ph="${editDesc ? 'Description…' : '—'}"></div><div class="desc-edit" hidden>${tboxHTML({ mono: true, okTitle: 'Save (Ctrl+Enter)', hint: 'Ctrl+Enter · Esc' })}</div></div>` : ''}
      ${shown('attachments') ? `<div class="section"><div class="section-head">${icon('clip', 'sm')}<span>${esc(bi('attachments').label)}</span><span class="att-n"></span><span class="rule"></span></div><div class="atts"></div></div>` : ''}
      <nav class="tabs"><button data-t="comments" class="on">${icon('msg', 'sm')}<span class="n c-n">0</span></button><button data-t="activity">${icon('activity', 'sm')}</button></nav>
      <div class="tab-comments"><div class="cmts"></div>
        <div class="cmt-compose">${tboxHTML({ ph: 'Comment…', okIcon: 'send', okTitle: 'Send (Ctrl+Enter)', tools: `<label class="tb-btn" title="Attach">${icon('clip')}<input type="file" multiple hidden></label>` })}</div></div>
      <div class="tab-activity" hidden></div>`;
    wireModalBody(m);
    renderRail(m);
    fillModal(m, true);
    const foot = $('.m-foot', m.root);
    foot.dataset.id = m.id;
  }

  /* ─── drafts: modal edits wait for Save (Settings → Board → Ticket edits) ─── */

  const DRAFT_SCALARS = ['title', 'description', 'type', 'priority', 'parent', 'assignee', 'blockedBy', 'cover'];
  const isDirty = (m) => m?.kind === 'item' && Object.keys(m.draft || {}).length > 0;
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  // The item as the modal should show it: stored values with the unsaved draft laid over them.
  function draftView(m) {
    const it = m.item;
    const d = m.draft || {};
    if (!Object.keys(d).length) return it;
    const out = { ...it };
    for (const k of DRAFT_SCALARS) if (k in d) out[k] = d[k];
    if (d.column) out.columnId = d.column;
    for (const bag of ['properties', 'fields']) {
      if (!d[bag]) continue;
      out[bag] = { ...(it[bag] || {}) };
      for (const [k, v] of Object.entries(d[bag])) { if (v === null) delete out[bag][k]; else out[bag][k] = v; }
    }
    return out;
  }

  // Drop draft entries that now match what is stored (e.g. changed back), so "unsaved" stays honest.
  function pruneDraft(m) {
    const d = m.draft;
    const it = m.item;
    for (const k of DRAFT_SCALARS) if (k in d && same(d[k], it[k])) delete d[k];
    if (d.column === it.columnId) { delete d.column; delete d.position; }
    for (const bag of ['properties', 'fields']) {
      if (!d[bag]) continue;
      for (const [k, v] of Object.entries(d[bag])) if (same(v, (it[bag] || {})[k])) delete d[bag][k];
      if (!Object.keys(d[bag]).length) delete d[bag];
    }
    if (!Object.keys(d).length) m.baseVersion = null;
  }

  function editItem(m, body) {
    if (!m.create && (settings.saveMode === 'instant' || m.kind !== 'item')) return patchItem(m.id, body);
    if (m.baseVersion == null) m.baseVersion = m.item.version || 0;
    if (m.create?.fromTemplate && !m.create.applyingTpl) {
      for (const [k, v] of Object.entries(body)) {
        if (k === 'fields' || k === 'properties') for (const x of Object.keys(v || {})) m.create.fromTemplate.delete(`${k}.${x}`);
        else m.create.fromTemplate.delete(k);
      }
    }
    for (const [k, v] of Object.entries(body)) {
      if (k === 'properties' || k === 'fields') m.draft[k] = { ...(m.draft[k] || {}), ...v };
      else m.draft[k] = v;
    }
    pruneDraft(m);
    fillModal(m);
    renderSaveBar(m);
    return Promise.resolve(null);
  }

  function draftLabels(m) {
    const d = m.draft;
    const names = [];
    const label = (k) => ({ column: 'column', blockedBy: bi('blockedBy').label.toLowerCase(), cover: 'card image' }[k] || k);
    for (const k of Object.keys(d)) {
      if (k === 'position') continue;
      if (k === 'fields') names.push(...Object.keys(d.fields).map((x) => schema().fields.find((f) => f.key === x)?.label || x));
      else if (k === 'properties') names.push(...Object.keys(d.properties));
      else names.push(label(k));
    }
    return names;
  }

  function renderSaveBar(m) {
    const bar = $('.m-save', m.root);
    if (!bar) return;
    const names = isDirty(m) ? draftLabels(m) : [];
    if (m.create) {
      bar.hidden = false;
      const col = colById(draftView(m).columnId);
      $('.txt', bar).innerHTML = `New ticket in <b>${esc(col?.name || '')}</b>${names.length ? ` · ${esc(names.filter((n) => n !== 'column').join(', '))}` : ''}`;
      return;
    }
    const was = !bar.hidden;
    bar.hidden = !names.length;
    if (!names.length) return;
    const stale = m.baseVersion != null && m.item.version > m.baseVersion;
    $('.txt', bar).innerHTML = `<b>${names.length} unsaved</b> · ${esc(names.join(', '))}${stale ? ' · <span class="stale">updated meanwhile</span>' : ''}`;
    if (!was) bar.animate([{ opacity: 0, translate: '0 10px' }, { opacity: 1, translate: '0 0' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  function nudgeDraft(m) {
    m.nudgedAt = Date.now();
    const bar = $('.m-save', m.root);
    if (!bar) return;
    bar.classList.remove('nudge');
    void bar.offsetWidth;
    bar.classList.add('nudge');
    $('.txt', bar).insertAdjacentHTML('beforeend', ' · <span class="stale">save or discard — close again to discard</span>');
    $('[data-draft="save"]', bar).focus();
  }

  async function saveDraft(m) {
    if (m.create) return createFromDraft(m);
    if (!isDirty(m)) return;
    const body = { ...m.draft };
    m.draft = {};
    m.baseVersion = null;
    renderSaveBar(m);
    const ok = await patchItem(m.id, body);
    if (!ok) { m.draft = body; renderSaveBar(m); fillModal(m); }
  }

  function discardDraft(m) {
    if (m.create) { m.draft = {}; closeModal(); return; }
    m.draft = {};
    m.baseVersion = null;
    renderSaveBar(m);
    fillModal(m);
  }

  async function patchItem(id, body) {
    try {
      const it = await api('PATCH', I(id), body);
      const { board: _b, column: _c, blocks: _bl, archived: _a, ...plain } = it;
      if (state.board.items[id]) {
        const prevCol = state.board.items[id].columnId;
        state.board.items[id] = { ...plain, lease: state.board.items[id].lease };
        if (prevCol === plain.columnId) { render(); state.modal?.refresh(); }
      }
      pulseSaved();
      scheduleRefresh(0);
      return it;
    } catch (e) {
      toast(e.message, { kind: 'error' });
      state.modal?.refresh();
      return null;
    }
  }

  function wireModalBody(m) {
    const main = $('.m-main', m.root);
    const title = $('.m-title', main);
    const saveTitle = () => {
      const v = title.value.replace(/\s+/g, ' ').trim();
      if (!v) { title.value = draftView(m).title; return; }
      if (v !== draftView(m).title && !m.archived) editItem(m, { title: v });
    };
    title.addEventListener('input', () => autosize(title));
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); if (m.create) view?.click(); } });
    title.addEventListener('blur', saveTitle);
    $('.m-title-wrap .tb-ok', main).addEventListener('pointerdown', (e) => e.preventDefault());
    $('.m-title-wrap .tb-ok', main).onclick = () => title.blur();
    title.readOnly = m.archived;

    const view = $('.desc-view', main);
    if (view) {
      const editWrap = $('.desc-edit', main);
      const box = $('.tbox', editWrap);
      const finish = (save) => {
        if (!m.editingDesc) return;
        m.editingDesc = false;
        const v = $('textarea', box).value;
        editWrap.hidden = true; view.hidden = false;
        if (save && v !== (draftView(m).description || '')) editItem(m, { description: v });
      };
      const ta = wireTbox(box, () => finish(true), { escape: () => finish(true) });
      ta.addEventListener('blur', () => setTimeout(() => { if (!box.contains(document.activeElement)) finish(true); }, 150));
      view.addEventListener('click', (e) => {
        const cb = e.target.closest('input[type="checkbox"][data-line]');
        if (cb) {
          if (!canEdit('description') || m.archived) { e.preventDefault(); return; }
          const lines = (draftView(m).description || '').split('\n');
          const n = Number(cb.dataset.line);
          lines[n] = lines[n].replace(/\[( |x|X)\]/, cb.checked ? '[x]' : '[ ]');
          editItem(m, { description: lines.join('\n') });
          return;
        }
        if (e.target.closest('a, img') || !canEdit('description') || m.archived) return;
        m.editingDesc = true;
        ta.value = draftView(m).description || '';
        view.hidden = true; editWrap.hidden = false;
        autosize(ta); ta.focus();
      });
    }

    for (const t of $$('.tabs button', main)) {
      t.onclick = () => {
        m.tab = t.dataset.t;
        $$('.tabs button', main).forEach((b) => b.classList.toggle('on', b === t));
        $('.tab-comments', main).hidden = m.tab !== 'comments';
        $('.tab-activity', main).hidden = m.tab !== 'activity';
        if (m.tab === 'activity') loadActivity(m);
      };
    }

    const cbox = $('.cmt-compose .tbox', main);
    const send = async () => {
      const ta = $('textarea', cbox);
      const body = ta.value.trim();
      if (!body && !m.staged.length) { ta.focus(); return; }
      const files = m.staged.slice();
      ta.value = ''; autosize(ta);
      m.staged = []; drawStaged(m);
      try {
        const attachments = [];
        for (const f of files) attachments.push({ name: f.name || 'pasted.png', mime: f.type, dataBase64: await readFile(f) });
        await api('POST', I(m.id, '/comments'), { body, attachments });
        scheduleRefresh(0);
      } catch (e) { toast(e.message, { kind: 'error' }); ta.value = body; m.staged = files; drawStaged(m); }
    };
    wireTbox(cbox, send);
    const fi = $('input[type="file"]', cbox);
    fi.onchange = () => { stageFiles(m, [...fi.files]); fi.value = ''; };
    $('.cmt-compose', main).hidden = m.archived;
  }

  function stageFiles(m, files) {
    for (const f of files) {
      if (f.size > 15 * 1024 * 1024) { toast(`${f.name} is over 15 MB`, { kind: 'error' }); continue; }
      m.staged.push(f);
    }
    drawStaged(m);
    $('.cmt-compose textarea', m.root)?.focus();
  }
  function drawStaged(m) {
    const box = $('.cmt-compose .staged', m.root);
    if (!box) return;
    for (const u of box._urls || []) URL.revokeObjectURL(u);
    box._urls = [];
    box.innerHTML = m.staged.map((f, i) => {
      if (/^image\//.test(f.type)) { const u = URL.createObjectURL(f); box._urls.push(u); return `<div class="st"><img src="${u}" alt=""><button data-i="${i}">${icon('x', 'sm')}</button></div>`; }
      return `<div class="st"><span>${esc(f.name.slice(0, 18))}</span><button data-i="${i}">${icon('x', 'sm')}</button></div>`;
    }).join('');
    box.onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) { m.staged.splice(Number(b.dataset.i), 1); drawStaged(m); } };
  }

  function readFile(f) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
  }
  // Paste files into a text box's .staged strip; they travel inline with the message when it is sent,
  // so nothing is uploaded for a draft that is cleared or abandoned.
  function pasteStage(box) {
    const strip = $('.staged', box);
    const st = { files: [] };
    const draw = () => {
      for (const u of strip._urls || []) URL.revokeObjectURL(u);
      strip._urls = [];
      strip.innerHTML = st.files.map((f, i) => {
        if (/^image\//.test(f.type)) { const u = URL.createObjectURL(f); strip._urls.push(u); return `<div class="st"><img src="${u}" alt=""><button type="button" data-i="${i}" title="Remove">${icon('x', 'sm')}</button></div>`; }
        return `<div class="st"><span>${esc((f.name || 'file').slice(0, 18))}</span><button type="button" data-i="${i}" title="Remove">${icon('x', 'sm')}</button></div>`;
      }).join('');
    };
    strip.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) { e.stopPropagation(); st.files.splice(Number(b.dataset.i), 1); draw(); } });
    $('textarea', box).addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return; // text paste: untouched
      e.preventDefault();
      for (const f of files) {
        if (f.size > 15 * 1024 * 1024) { toast(`${f.name} is over 15 MB`, { kind: 'error' }); continue; }
        if (st.files.length >= 10) { toast('At most 10 files per message', { kind: 'error' }); break; }
        st.files.push(f);
      }
      draw();
    });
    st.payload = async () => Promise.all(st.files.map(async (f) => ({ name: f.name || 'pasted.png', mime: f.type, dataBase64: await readFile(f) })));
    st.clear = () => { st.files = []; draw(); };
    return st;
  }
  // Create mode: keep pasted files in the page (blob: URLs) until the ticket exists. Nothing is uploaded
  // before Create, so cancelling leaves no orphan attachments.
  function stageForCreate(m, files) {
    m.pendingFiles ||= [];
    return files.filter((f) => {
      if (f.size <= 15 * 1024 * 1024) return true;
      toast(`${f.name} is over 15 MB`, { kind: 'error' });
      return false;
    }).map((f) => {
      const a = { name: f.name || 'pasted.png', mime: f.type, url: URL.createObjectURL(f), file: f };
      m.pendingFiles.push(a);
      return a;
    });
  }
  function dropStaged(m) {
    for (const a of m.pendingFiles || []) URL.revokeObjectURL(a.url);
    m.pendingFiles = [];
  }
  // After Create: upload the staged files the description still uses and point its links at them.
  async function uploadStaged(m, id, description) {
    const used = (m.pendingFiles || []).filter((a) => description.includes(a.url));
    if (!used.length) return dropStaged(m);
    let desc = description;
    for (const a of used) {
      try {
        const att = await api('POST', I(id, '/attachments'), { name: a.name, mime: a.mime, dataBase64: await readFile(a.file) });
        desc = desc.split(a.url).join(att.url);
      } catch (e) { toast(`${a.name}: ${e.message}`, { kind: 'error' }); desc = desc.split(a.url).join(''); }
    }
    dropStaged(m);
    await api('PATCH', I(id), { description: desc });
  }

  async function uploadFiles(m, files) {
    const out = [];
    for (const f of files) {
      if (f.size > 15 * 1024 * 1024) { toast(`${f.name} is over 15 MB`, { kind: 'error' }); continue; }
      try { out.push(await api('POST', I(m.id, '/attachments'), { name: f.name || 'pasted.png', mime: f.type, dataBase64: await readFile(f) })); }
      catch (e) { toast(e.message, { kind: 'error' }); }
    }
    if (out.length) { pulseSaved(); scheduleRefresh(0); }
    return out;
  }

  function fillModal(m, first = false) {
    const { root } = m;
    const it = draftView(m);
    const main = $('.m-main', root);
    if (!$('.m-title', main)) return; // all-clear screen
    const focus = document.activeElement;
    m.modal.style.setProperty('--type-c', TYPE_VAR[it.type]);
    $('.m-type', root).innerHTML = icon(it.type);
    $('.m-id', root).textContent = m.create ? 'New ticket' : it.id;
    $('[data-a="archive"]', root).hidden = m.archived;
    const del = $('[data-a="delete"]', root);
    if (del) del.hidden = !it.test;

    const title = $('.m-title', main);
    if (focus !== title) { title.value = it.title; autosize(title); }
    if (first) requestAnimationFrame(() => autosize(title));

    const col = colById(it.columnId);
    const rx = $('.m-reacts', main) || (() => { const d = el('<div class="m-reacts"></div>'); $('.m-sub', main).after(d); wireReactions(d, m.id); return d; })();
    rx.innerHTML = reactionsHTML(it.reactions, { add: !m.archived, notes: it.reactionNotes });
    $('.m-sub', main).innerHTML = `${avatar(it.author)}<span>${nameHTML(it.author?.name)}</span><span>·</span><span title="${esc(it.createdAt)}">${rel(it.createdAt)}</span>${col ? `<span>·</span><span class="chip" style="color:${esc(col.color)}">${esc(col.name)}</span>` : ''}${m.archived ? `<span class="chip">${icon('archive', 'sm')}${esc(rel(it.archivedAt))}</span>` : ''}`;

    // needs-you banner
    const slot = $('.ask-slot', main);
    // Every open question gets its own box: reply to it (or resolve it) on its own. Reviews get approve / request changes.
    const qs = it.questions?.length ? it.questions : it.needsHuman ? [it.needsHuman] : [];
    if (qs.length && !m.archived) {
      const key = `${it.id}:${qs.map((q) => q.id || q.raisedAt).join(',')}`;
      if (slot.dataset.key !== key) {
        slot.dataset.key = key;
        slot.innerHTML = qs.map((q, i) => {
          const isReview = q.kind === 'review';
          return `<div class="m-ask ${isReview ? 'is-review' : ''}" data-q="${esc(q.id || '')}" data-kind="${isReview ? 'review' : 'question'}"><div class="ask-head">${icon(isReview ? 'eye' : 'ask')}${avatar({ kind: 'agent', name: q.raisedBy })}<b>${esc(q.raisedBy)}</b><span>${rel(q.raisedAt)}</span>${isReview ? '<span class="chip review-chip">Review</span>' : qs.length > 1 ? `<span class="q-count">${i + 1}/${qs.length}</span>` : ''}</div>
          ${isReview ? reviewNotesHTML(it, q) : `<div class="md">${md(q.reason)}</div>`}
          ${q.form?.length && !isReview ? qFormHTML(q) : ''}
          ${isReview ? `<div class="rv-does">${esc(approveText(q))}</div>` : ''}
          ${isReview
    ? tboxHTML({ ph: 'Feedback — Send back returns the ticket to the agent…', okIcon: 'send', okTitle: 'Send back (Ctrl+Enter)', hint: 'Ctrl+Enter = Send back', tools: `<button class="btn primary sm" data-r="approve" title="${esc(approveText(q))}">${icon('check', 'sm')}${q.landing ? 'Approve and land' : 'Approve'}</button><button class="btn ghost sm" data-r="why" title="Ask why|${esc(q.raisedBy)} explains on the card — nothing else changes and the review stays open">${icon('ask', 'sm')}Ask why</button>${state.app.preview ? `<button class="btn ghost sm" data-r="preview" title="Preview|See it working before you approve: runs ${esc(q.raisedBy)}'s branch on a temporary board with a copy of your tickets, and opens it in a new tab">${icon('eye', 'sm')}Preview</button>` : ''}` })
    : tboxHTML({ ph: q.form?.length ? 'Anything to add? (optional)' : 'Reply…', okIcon: 'send', okTitle: q.form?.length ? 'Send answers (Ctrl+Enter)' : 'Reply & resolve (Ctrl+Enter)', tools:`<button class="tb-btn" data-r="resolve" title="Resolve|Mark this question answered without replying">${icon('check')}</button>` })}</div>`;
        }).join('');
        // Long explanations collapse to a few lines; "See more" only when they actually overflow.
        m.openNotes ||= new Set();
        for (const clamp of $$('.rv-clamp', slot)) {
          const qid = clamp.closest('.m-ask').dataset.q;
          if (m.openNotes.has(qid)) { clamp.classList.add('open'); continue; }
          requestAnimationFrame(() => {
            if (clamp.scrollHeight <= clamp.clientHeight + 4) return;
            clamp.classList.add('clamped');
            const more = el(`<button class="see-more">${icon('chev', 'sm')}<span>See more</span></button>`);
            more.onclick = () => {
              const open = clamp.classList.toggle('open');
              if (open) m.openNotes.add(qid); else m.openNotes.delete(qid);
              $('span', more).textContent = open ? 'See less' : 'See more';
              more.classList.toggle('up', open);
            };
            clamp.after(more);
          });
        }
        for (const card of $$('.m-ask', slot)) {
          const box = $('.tbox', card);
          const qid = card.dataset.q || undefined;
          const resolve = async (withReply) => {
            const ta = $('textarea', box);
            const reply = withReply ? ta.value.trim() : '';
            // a form is sent with the reply; "resolve" without replying skips it
            const form = withReply && $('.q-form', card);
            const answers = form ? readQForm(form, qs.find((x) => x.id === qid)) : undefined;
            if (answers === null) return;
            if (withReply && !reply && !answers) { ta.focus(); return; }
            try { await api('DELETE', I(m.id, '/attention'), { reply, questionId: qid, ...(answers ? { answers } : {}) }); pulseSaved(); scheduleRefresh(0); } catch (e) { toast(e.message, { kind: 'error' }); }
          };
          // One step on the server: verdict recorded, comment posted, moved on (or back), agent told.
          const review = async (approve) => {
            const ta = $('textarea', box);
            const text = ta.value.trim();
            if (!approve && !text) { ta.focus(); return; }
            try {
              await api('POST', I(m.id, '/review/decision'), { verdict: approve ? 'approve' : 'changes', comment: text });
              pulseSaved();
              toast(approve ? `Approved ${m.id}` : `Sent ${m.id} back`, { kind: approve ? 'ok' : '', icon: approve ? 'check' : 'restore' });
              // Approving is the last thing done with a ticket: back to the board (or on to the next
              // ticket that needs you, when working through the rail). Sending back keeps it open.
              if (approve && state.modal === m) {
                const next = m.rail ? needsIds().filter((x) => x !== m.id) : [];
                m.draft = {};
                if (next.length) m.switchTo(next[0]); else closeModal(true);
              }
              scheduleRefresh(0);
            } catch (e) { toast(e.message, { kind: 'error' }); }
          };
          if (card.dataset.kind === 'review') {
            wireTbox(box, () => review(false));
            $('[data-r="approve"]', card).onclick = () => review(true);
            $('[data-r="why"]', card).onclick = () => { const ta = $('textarea', box); askWhy(m.id, ta.value.trim()).then((ok) => { if (ok) ta.value = ''; }); };
            const pv = $('[data-r="preview"]', card);
            if (pv) pv.onclick = async () => {
              // Open the tab now (a click may open one; an await later may not), then point it at the preview.
              const w = window.open('about:blank', '_blank');
              pv.disabled = true;
              toast(`Starting a preview of ${m.id}…`, { icon: 'eye', timeout: 4000 });
              try {
                const r = await api('POST', I(m.id, '/preview'));
                if (w) w.location.href = r.url; else window.open(r.url, '_blank');
                toast(`Preview of ${m.id}: ${r.from === 'main' ? 'main' : `${r.from}'s branch`}`, { icon: 'eye', kind: 'ok', timeout: 3500 });
              } catch (e) { w?.close(); toast(e.message, { kind: 'error' }); }
              pv.disabled = false;
            };
          } else {
            wireTbox(box, () => resolve(true));
            $('[data-r="resolve"]', card).onclick = () => resolve(false);
          }
        }
        if (first || m.rail) setTimeout(() => $('.m-ask textarea', slot)?.focus(), 300);
      }
    } else { slot.innerHTML = ''; slot.dataset.key = ''; }

    const view = $('.desc-view', main);
    if (view && !m.editingDesc) {
      view.innerHTML = md(it.description, { tasks: canEdit('description') && !m.archived });
      view.classList.toggle('empty', !it.description?.trim());
    }

    const atts = $('.atts', main);
    if (atts) fillAttachments(m, atts);

    $('.c-n', main).textContent = it.comments.length;
    const cmts = $('.cmts', main);
    const think = m.create ? [] : thinkers('comments', it.id, (n, since) => it.comments.some((c) => c.author?.name === n && c.createdAt > since));
    const ended = m.create ? [] : endedHere('comments', it.id, it.comments.map((c) => ({ who: c.author?.name, at: c.createdAt })));
    const sig = `${it.id}:${it.comments.map((c) => `${c.id}${c.replacedBy || ''}${JSON.stringify(c.reactions || {})}${JSON.stringify(c.reactionNotes || {})}`).join('|')}:${think}:${think.map((n) => standingOf(n).stalled)}:${ended}:${Object.keys(state.profiles).length}`;
    if (cmts.dataset.sig !== sig) {
      cmts.dataset.sig = sig;
      // A review request that a newer one from the same author replaced folds to one muted line (INT-172).
      // Which folds the reader opened survives a re-render.
      const open = m.unfolded ||= new Set();
      const fold = (c, html) => (c.replacedBy && it.comments.some((x) => x.id === c.replacedBy)
        ? `<details class="cmt-fold" data-cid="${esc(c.id)}"${open.has(c.id) ? ' open' : ''}><summary>${avatar(c.author)}<span class="what">Review request · replaced by the one below</span><span class="when" title="${esc(c.createdAt)}">${rel(c.createdAt)}</span>${icon('chev', 'sm')}</summary>${html}</details>`
        : html);
      cmts.innerHTML = it.comments.map((c) => fold(c, `<div class="cmt ${c.intent === 'explain' ? 'is-explain' : ''}" data-cid="${esc(c.id)}">${avatar(c.author, 'lg')}<div><div class="cmt-head"><b>${nameHTML(c.author?.name)}</b>${c.author?.kind === 'agent' ? `<span class="kind">${icon('bot', 'sm')}</span>` : ''}${c.intent === 'explain' ? '<span class="chip explain-chip">Explain</span>' : ''}<span title="${esc(c.createdAt)}">${rel(c.createdAt)}</span>${c.author?.kind === 'agent' && !m.archived ? `<button class="cmt-why" data-why="${esc(c.id)}" data-who="${esc(c.author.name)}" title="Ask why|${esc(nameOf(c.author.name))} explains this on the card — nothing else changes">${icon('ask', 'sm')}Ask why</button>` : ''}</div>${c.body ? `<div class="md">${md(c.body)}</div>` : ''}${commentAtts(c)}${reactionsHTML(c.reactions, { cid: c.id, add: !m.archived, notes: c.reactionNotes })}</div></div>`)).join('')
        + think.map((n) => `<div class="cmt thinking" aria-live="polite">${avatar({ kind: 'agent', name: n }, 'lg')}<div><div class="cmt-head"><b>${nameHTML(n)}</b><span class="kind">${icon('bot', 'sm')}</span><span>is writing a reply</span></div><div class="think-bubble" role="status" aria-label="${esc(nameOf(n))} is writing a reply">${thinkAge(n)}</div></div></div>`).join('')
        + ended.map((t) => `<div class="cmt-ended muted">${esc(t)}</div>`).join('');
      if (!cmts._reactWired) { cmts._reactWired = true; wireReactions(cmts, m.id); }
      cmts.querySelectorAll('.cmt-fold').forEach((d) => { d.ontoggle = () => (d.open ? open.add(d.dataset.cid) : open.delete(d.dataset.cid)); });
      cmts.onclick = (e) => {
        const b = e.target.closest('[data-why]');
        if (!b || b.closest('.cmt').querySelector('.why-box')) return;
        const box = el(`<div class="why-box">${tboxHTML({ ph: `What should ${esc(b.dataset.who)} explain? (Enter to send, empty = “why this approach?”)`, okIcon: 'send', okTitle: 'Ask (Ctrl+Enter)', rows: 1 })}</div>`);
        b.closest('.cmt').lastElementChild.append(box);
        const ta = $('textarea', box);
        wireTbox($('.tbox', box), () => askWhy(m.id, ta.value.trim(), b.dataset.why, b.dataset.who).then((ok) => ok && box.remove()), { escape: () => box.remove(), submitOnEnter: true });
        ta.focus();
      };
    }

    fillSide(m);
    const foot = $('.m-foot', root);
    foot.innerHTML = `<span>v${it.version}</span><span>updated ${esc(rel(it.updatedAt))}</span><span>created ${esc(new Date(it.createdAt).toLocaleString())}</span>`;
  }

  function commentAtts(c) {
    if (!c.attachments?.length) return '';
    return `<div class="cmt-atts">${c.attachments.map((a) => (isImage(a)
      ? `<img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy">`
      : `<a class="file" href="${esc(a.url)}" target="_blank" rel="noopener">${icon(a.kind === 'link' ? 'link' : 'clip', 'sm')}${esc(a.name)}</a>`)).join('')}</div>`;
  }

  function fillAttachments(m, atts) {
    const it = draftView(m);
    const edit = canEdit('attachments') && !m.archived;
    const coverEdit = canEdit('cover') && shown('cover') && !m.archived;
    const cover = coverOf(it);
    $('.att-n', m.root).textContent = it.attachments.length || '';
    atts.innerHTML = it.attachments.map((a) => {
      const img = isImage(a);
      const isCover = cover && cover.id === a.id;
      const inner = img ? `<img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy">`
        : `<a href="${esc(a.url)}" target="_blank" rel="noopener">${icon(a.kind === 'link' ? 'link' : 'clip')}<span>${esc(a.name)}</span></a>`;
      const tag = isCover && shown('cover') ? `<span class="cover-tag ${it.cover === 'auto' ? 'auto' : ''}">${icon('card', 'sm')}</span>` : '';
      const tools = [
        img && coverEdit ? `<button class="cv ${isCover && it.cover !== 'auto' ? 'on' : ''}" data-cover="${esc(a.id)}" title="${isCover && it.cover !== 'auto' ? 'Hide from card' : 'Show on card'}">${icon(isCover && it.cover !== 'auto' ? 'eyeoff' : 'card', 'sm')}</button>` : '',
        edit ? `<button class="rm" data-rm="${esc(a.id)}" title="Remove">${icon('x', 'sm')}</button>` : '',
      ].join('');
      return `<div class="att ${img ? '' : 'file'} ${isCover && shown('cover') ? 'is-cover' : ''}" title="${esc(a.name)} · ${esc(a.author?.name)}">${inner}${tag}${tools ? `<div class="att-tools">${tools}</div>` : ''}</div>`;
    }).join('') + (edit ? `<label class="att-add" title="Attach">${icon('plus')}<input type="file" multiple hidden></label>` : '');
    if (!it.attachments.length && !edit) atts.innerHTML = '<div class="empty-note">—</div>';
    atts.onclick = async (e) => {
      const rm = e.target.closest('[data-rm]');
      const cv = e.target.closest('[data-cover]');
      if (!rm && !cv) return;
      e.stopPropagation();
      e.preventDefault();
      try {
        if (rm) { await api('DELETE', I(m.id, `/attachments/${rm.dataset.rm}`)); toast('Removed', { icon: 'x', timeout: 1800 }); }
        if (cv) {
          const explicit = it.cover === cv.dataset.cover;
          await editItem(m, { cover: explicit ? 'none' : cv.dataset.cover });
        }
        scheduleRefresh(0);
      } catch (err) { toast(err.message, { kind: 'error' }); }
    };
    const fi = $('input[type="file"]', atts);
    if (fi) fi.onchange = () => uploadFiles(m, [...fi.files]);
  }

  /* ─── side panel (schema-driven) ─── */

  // A question's form (INT-88): the agent names the fields, we draw the controls. Nothing it writes is HTML.
  function qFormHTML(q) {
    return `<div class="q-form">${q.form.map((f) => {
      if (f.type === 'note') return `<div class="md qf-note">${md(f.markdown)}</div>`;
      const name = `qf-${q.id}-${f.key}`;
      const d = f.default;
      const opt = (type, value, label, on) => `<label class="qf-opt"><input type="${type}" name="${esc(name)}" value="${esc(value)}"${on ? ' checked' : ''}><span>${esc(label)}</span></label>`;
      const ctl = f.type === 'longtext' ? `<textarea rows="3">${esc(d ?? '')}</textarea>`
        : f.type === 'choice' ? f.options.map((o) => opt('radio', o.value, o.label, d === o.value)).join('')
          : f.type === 'multi' ? f.options.map((o) => opt('checkbox', o.value, o.label, [].concat(d ?? []).includes(o.value))).join('')
            : f.type === 'yesno' ? opt('radio', 'true', 'Yes', d === true) + opt('radio', 'false', 'No', d === false)
              : f.type === 'number' ? `<input type="number"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''} value="${esc(d ?? '')}">`
                : `<input type="${f.type === 'date' ? 'date' : 'text'}" value="${esc(d ?? '')}">`;
      return `<div class="qf-field" data-key="${esc(f.key)}"><div class="qf-label">${esc(f.label)}${f.required ? '<b class="qf-req" title="Required">*</b>' : ''}</div>${f.help ? `<div class="qf-help">${esc(f.help)}</div>` : ''}<div class="qf-ctl qf-${f.type}">${ctl}</div></div>`;
    }).join('')}</div>`;
  }
  // { key: value } from the controls, or null (and the missing fields marked) when a required one is empty or a number is out of its range (INT-205).
  function readQForm(el, q) {
    const out = {};
    let missing = null;
    let outside = null;
    for (const f of q.form.filter((x) => x.type !== 'note')) {
      const box = $$('.qf-field', el).find((x) => x.dataset.key === f.key);
      const picked = $$('input:checked', box).map((x) => x.value);
      const raw = $('input:not([type=radio]):not([type=checkbox]), textarea', box)?.value.trim() ?? '';
      const v = f.type === 'multi' ? picked : f.type === 'choice' ? picked[0] ?? null : f.type === 'yesno' ? (picked.length ? picked[0] === 'true' : null)
        : f.type === 'number' ? (raw === '' ? null : Number(raw)) : raw || null;
      const empty = v == null || (Array.isArray(v) && !v.length);
      const range = f.type === 'number' && v != null && ((f.min != null && v < f.min) || (f.max != null && v > f.max));
      box.classList.toggle('missing', !!((f.required && empty) || range));
      if (f.required && empty) missing ||= box;
      if (range) outside ||= { box, f };
      out[f.key] = v;
    }
    if (missing) { missing.scrollIntoView({ block: 'nearest' }); toast('Fill in the fields marked *', { kind: 'error' }); return null; }
    if (outside) {
      const { box, f } = outside;
      const bounds = f.min != null && f.max != null ? `between ${f.min} and ${f.max}` : f.min != null ? `at least ${f.min}` : `at most ${f.max}`;
      box.scrollIntoView({ block: 'nearest' });
      toast(`${f.label} must be ${bounds}`, { kind: 'error' });
      return null;
    }
    return out;
  }

  const REVIEW_LABELS = [['changed', 'What changed', 'pencil'],['why', 'Why', 'sparkle'], ['verify', 'How to verify', 'check'], ['evidence', 'Evidence', 'eye'], ['risks', 'Risks & open questions', 'flag']];
  // The agent's explanation in full: its four parts when it gave them, else its whole review comment.
  function reviewNotesHTML(it, q) {
    if (q.notes && Object.keys(q.notes).length > (q.notes.changed && Object.keys(q.notes).length === 1 ? 1 : 0)) {
      return `<div class="rv-clamp"><div class="rv-notes">${REVIEW_LABELS.filter(([k]) => q.notes[k]).map(([k, label, ic]) => `<div class="rv-part"><div class="rv-label">${icon(ic, 'sm')}${label}</div><div class="md">${md(q.notes[k])}</div></div>`).join('')}</div></div>`;
    }
    const full = q.notes?.changed || [...(it.comments || [])].reverse().find((c) => c.author?.name === q.raisedBy && c.body && c.body.startsWith(q.reason.slice(0, 60)))?.body;
    return `<div class="rv-clamp"><div class="md rv-body">${md(full || q.reason)}</div></div>`;
  }
  // What Approve will do, said on the review card and on its hover text. `landing` = agent commits waiting.
  function approveText(q) {
    if (!q.landing) return 'Approve moves it to Done.';
    return `Approve moves it to Done and lands ${q.landing} commit${q.landing === 1 ? '' : 's'} on main.`;
  }
  // "Ask why": a reply-only question — the agent explains on the card and changes nothing else.
  async function askWhy(id, text, replyTo = null, who = null) {
    const body = text || 'Can you explain your reasoning here — why this approach, and what you considered instead?';
    try {
      await api('POST', I(id, '/comments'), { body: who && !/(^|\s)@/.test(body) ? `@${who} ${body}` : body, intent: 'explain', ...(replyTo ? { replyTo } : {}) });
      toast(`Asked ${who || 'the agent'} to explain`, { icon: 'ask', kind: 'ok', timeout: 2500 });
      scheduleRefresh(0);
      return true;
    } catch (e) { toast(e.message, { kind: 'error' }); return false; }
  }

  function fillSide(m) {
    const side = $('.m-side', m.root);
    if (side.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return;
    const it = draftView(m);
    const b = state.board;
    const lock = (k) => !canEdit(k) || m.archived;
    const roIcon = (k) => (lock(k) && !m.archived ? `<span class="ro" title="Read-only|Only agents can change this, through the API">${icon('lock', 'sm')}</span>` : '');
    const lbl = (k, ic, text) => `<div class="lbl">${icon(ic, 'sm')}${esc(text ?? bi(k).label)}${roIcon(k)}</div>`;
    const lease = activeLease(it);
    const col = colById(it.columnId);
    const parts = [];

    // details
    const det = [];
    det.push(`<div class="field">${'<div class="lbl">'}${icon('board', 'sm')}Column</div>${m.archived ? `<div class="ro-val">${esc(col?.name || '—')}</div>` : ddHTML('column', col ? `<span class="sw" style="--c:${esc(col.color)}"></span>${esc(col.name)}` : '')}</div>`);
    if (shown('type')) {
      det.push(`<div class="field">${lbl('type', 'layers')}${lock('type')
        ? `<div class="ro-val" style="color:${TYPE_VAR[it.type]}">${icon(it.type, 'sm')}${it.type}</div>`
        : `<div class="seg" data-f="type">${TYPES.map((t) => `<button class="${t === it.type ? 'on' : ''}" data-v="${t}" style="--c:${TYPE_VAR[t]}">${icon(t, 'sm')}${t}</button>`).join('')}</div>`}</div>`);
    }
    if (shown('priority')) {
      det.push(`<div class="field">${lbl('priority', 'flag')}${lock('priority')
        ? `<div class="ro-val" style="color:${PRIO_VAR[it.priority]}">${icon('flag', 'sm')}${it.priority}</div>`
        : `<div class="seg" data-f="priority">${PRIORITIES.map((p) => `<button class="${p === it.priority ? 'on' : ''}" data-v="${p}" style="--c:${PRIO_VAR[p]}">${p === 'Critical' ? 'Crit' : p}</button>`).join('')}</div>`}</div>`);
    }
    if (shown('parent')) {
      const v = it.parent ? `<span class="sw" style="--c:${tagColor(it.parent)}"></span>${esc(it.parent)}` : '';
      det.push(`<div class="field">${lbl('parent', 'hash')}${lock('parent') ? `<div class="ro-val ${it.parent ? '' : 'empty'}">${v || '—'}</div>` : ddHTML('parent', v, { placeholder: 'None' })}</div>`);
    }
    if (shown('assignee')) {
      const v = it.assignee ? `${avatar({ name: it.assignee })}${nameHTML(it.assignee)}` : '';
      det.push(`<div class="field">${lbl('assignee', 'user')}${lock('assignee') ? `<div class="ro-val ${it.assignee ? '' : 'empty'}">${v || '—'}</div>` : ddHTML('assignee', v, { placeholder: 'Nobody' })}</div>`);
    }
    // specialist reviewers: they comment, you approve
    if (!m.create && ((it.reviewers || []).length || Object.values(state.standing || {}).some((a) => a.reviewer))) {
      det.push(`<div class="field"><div class="lbl">${icon('eye', 'sm')}Reviewers</div><div class="rv-list">${(it.reviewers || []).map((r) => reviewerTick(r, { rm: !m.archived })).join('')}${m.archived ? '' : `<button class="rv-add" type="button" data-act="rv-add" title="Add a reviewer|An agent marked as a reviewer comments its verdict; you still approve">${icon('plus', 'sm')}</button>`}</div></div>`);
    }
    parts.push(`<div class="fgroup">${det.join('')}</div>`);

    // lease + dependencies
    const work = [];
    // Lease, Blocked by and Blocks read as one-line rows (label left, value right), like boolean fields.
    // A held lease opens into a card underneath for the timer and live status.
    if (!m.create) work.push(lease
      ? `<div class="field"><div class="row-line"><div class="lbl">${icon('clock', 'sm')}Lease</div><span class="row-val">${nameHTML(lease.claimant)}${m.archived ? '' : `<button class="mini-x" data-act="revoke" title="Revoke lease|Take the ticket back from this agent">${icon('x', 'sm')}</button>`}</span></div>
        <div class="lease-box">${ringHTML(lease)}<div style="min-width:0"><div class="who">${nameHTML(lease.claimant)}</div><div class="left" data-left="${esc(lease.expiresAt)}"></div></div>${lease.status ? `<div class="lstatus">${esc(lease.status)}</div>` : ''}</div></div>`
      : `<div class="field inline"><div class="lbl">${icon('clock', 'sm')}Lease</div>${m.archived ? '<span class="row-val empty">—</span>' : `<button class="row-btn" data-act="claim" title="Hold|Lease it yourself — agents can't change it until you release it">${icon('lock', 'sm')}Hold</button>`}</div>`);
    if (shown('blockedBy')) {
      const last = b.columns[b.columns.length - 1]?.id;
      const chip = (id, removable) => {
        const d = b.items[id];
        const cls = !d || d.columnId === last ? 'done' : removable ? 'open' : '';
        return `<span class="dep ${cls} ${removable ? '' : 'readonly'}" data-open="${esc(id)}" title="${esc(d?.title || 'archived')}">${esc(id)}${removable ? `<button class="x" data-rmdep="${esc(id)}">${icon('x', 'sm')}</button>` : ''}</span>`;
      };
      const deps = (it.blockedBy || []);
      const blocks = Object.values(b.items).filter((x) => x.blockedBy?.includes(it.id)).map((x) => x.id);
      const add = lock('blockedBy') ? '' : `<button class="row-btn icon" data-dd="blockedBy" title="Add blocker|Pick a ticket this one waits on">${icon('plus', 'sm')}</button>`;
      work.push(`<div class="field inline wrap">${lbl('blockedBy', 'lock')}<span class="row-val">${deps.length ? deps.map((x) => chip(x, !lock('blockedBy'))).join('') : add ? '<span class="empty">None</span>' : '<span class="empty">—</span>'}${add}</span></div>`);
      if (blocks.length) work.push(`<div class="field inline wrap"><div class="lbl">${icon('move', 'sm')}Blocks</div><span class="row-val">${blocks.map((x) => chip(x, false)).join('')}</span></div>`);
    }
    if (!m.create && !m.archived && focusBoards().length) {
      const mine = focusBoards().filter((f) => f.itemIds.includes(it.id));
      const others = focusBoards().length > mine.length;
      work.push(`<div class="field inline wrap"><div class="lbl">${icon('target', 'sm')}Focus</div><span class="row-val">${mine.map((f) => `<span class="dep focus-chip" data-showfocus="${esc(f.id)}" title="Open ${esc(f.name)}">${esc(f.name)}<button class="x" data-rmfocus="${esc(f.id)}" title="Take it out of this focus board">${icon('x', 'sm')}</button></span>`).join('') || '<span class="empty">None</span>'}${others ? `<button class="row-btn icon" data-act="focus-add" title="Add to a focus board">${icon('plus', 'sm')}</button>` : ''}</span></div>`);
    }
    parts.push(`<div class="fgroup">${work.join('')}</div>`);

    // declared fields
    const defs = schema().fields.filter((f) => f.ui !== 'hidden');
    if (defs.length) parts.push(`<div class="fgroup"><div class="fgroup-title">${icon('layers', 'sm')}Fields</div>${defs.map((f) => fieldControl(f, it.fields?.[f.key], f.ui !== 'edit' || m.archived)).join('')}</div>`);

    // free-form properties
    if (shown('properties')) {
      const props = Object.entries(it.properties || {});
      const ro = lock('properties');
      const showVal = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
      parts.push(`<div class="fgroup"><div class="fgroup-title">${icon('braces', 'sm')}${esc(bi('properties').label)}${roIcon('properties')}</div>
        <div class="props">${props.map(([k, v]) => `<div class="prop"><input class="inp k" data-k="${esc(k)}" value="${esc(k)}" ${ro ? 'readonly' : ''}><input class="inp" data-v="${esc(k)}" value="${esc(showVal(v))}" ${ro ? 'readonly' : ''}>${ro ? '<span></span>' : `<button class="x" data-del="${esc(k)}" title="Remove">${icon('x', 'sm')}</button>`}</div>`).join('')}</div>
        ${ro ? (props.length ? '' : '<div class="ro-val empty">—</div>') : `<button class="add-row">${icon('plus', 'sm')}Add</button>`}</div>`);
    }

    if (m.archived) parts.unshift(`<button class="btn primary" data-act="restore" style="width:100%;margin-bottom:14px">${icon('restore')}Restore</button>`);
    side.innerHTML = parts.join('');
    tickRings(side);
    tickModal();
    wireSide(m, side);
  }

  function fieldControl(f, v, ro) {
    const ic = ICONS[f.icon] ? f.icon : FIELD_ICON[f.type];
    const head = `<div class="lbl" ${f.help ? `title="${esc(f.help)}"` : ''}>${icon(ic, 'sm')}${esc(f.label)}${ro ? `<span class="ro" title="Read-only|Only agents can change this, through the API">${icon('lock', 'sm')}</span>` : ''}</div>`;
    const key = esc(f.key);
    if (f.type === 'boolean') return `<div class="field inline">${head}<button class="switch ${v ? 'on' : ''}" data-fbool="${key}" ${ro ? 'disabled' : ''}></button></div>`;
    if (ro) {
      let val;
      if (v == null) val = '—';
      else if (f.type === 'enum') val = `<span class="sw" style="--c:${esc(optColor(f, v) || 'var(--accent)')}"></span>${esc(v)}`;
      else if (f.type === 'tags') val = v.map((t) => `<span class="tagchip" style="--fc:${esc(optColor(f, t) || 'var(--accent)')}">${esc(t)}</span>`).join('');
      else if (f.type === 'url') val = `<a href="${esc(v)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(fieldText(f, v))}</a>`;
      else if (f.type === 'markdown') val = `<div class="md">${md(v)}</div>`;
      else if (f.type === 'user') val = `${avatar({ name: v })}${esc(v)}`;
      else val = esc(f.type === 'date' ? new Date(v).toLocaleDateString() : v);
      return `<div class="field">${head}<div class="ro-val ${v == null ? 'empty' : ''}">${val}</div></div>`;
    }
    switch (f.type) {
      case 'enum': return `<div class="field">${head}${ddHTML(`f:${f.key}`, v != null ? `<span class="sw" style="--c:${esc(optColor(f, v) || 'var(--accent)')}"></span>${esc(v)}` : '', { placeholder: 'None' })}</div>`;
      case 'user': return `<div class="field">${head}${ddHTML(`f:${f.key}`, v ? `${avatar({ name: v })}${esc(v)}` : '', { placeholder: 'Nobody' })}</div>`;
      case 'tags': return `<div class="field">${head}${v?.length ? `<div class="deps">${v.map((t) => `<span class="tagchip" style="--fc:${esc(optColor(f, t) || 'var(--accent)')}">${esc(t)}<button class="x" data-rmtag="${key}" data-tag="${esc(t)}">${icon('x', 'sm')}</button></span>`).join('')}</div>` : ''}${ddHTML(`f:${f.key}`, '', { placeholder: 'Add…' })}</div>`;
      case 'number': return `<div class="field">${head}<input class="inp" type="number" data-fval="${key}" value="${v ?? ''}" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} placeholder="—"></div>`;
      case 'date': return `<div class="field">${head}<input class="inp" type="date" data-fval="${key}" value="${esc(v ? String(v).slice(0, 10) : '')}"></div>`;
      case 'url': return `<div class="field">${head}<div class="url-row"><input class="inp" type="url" data-fval="${key}" value="${esc(v ?? '')}" placeholder="https://…">${v ? `<a class="btn" href="${esc(v)}" target="_blank" rel="noopener" title="Open">${icon('ext', 'sm')}</a>` : ''}</div></div>`;
      case 'markdown': return `<div class="field">${head}<div class="fmd" data-fmd="${key}">${tboxHTML({ okTitle: 'Save', rows: 3 })}</div></div>`;
      default: return `<div class="field">${head}<input class="inp" data-fval="${key}" value="${esc(v ?? '')}" placeholder="—"></div>`;
    }
  }

  function wireSide(m, side) {
    const it = draftView(m);
    const b = state.board;
    const setField = (k, v) => editItem(m, { fields: { [k]: v } });
    for (const box of $$('[data-fmd]', side)) {
      const k = box.dataset.fmd;
      const ta = wireTbox($('.tbox', box), () => setField(k, $('textarea', box).value));
      ta.value = it.fields?.[k] ?? '';
      requestAnimationFrame(() => autosize(ta));
    }
    side.onchange = (e) => {
      const t = e.target;
      if (t.dataset.fval) {
        const k = t.dataset.fval;
        const prev = it.fields?.[k] ?? '';
        const v = t.value.trim();
        if (String(prev) !== v) setField(k, v === '' ? null : v);
      }
      if (t.dataset.v !== undefined || t.dataset.k !== undefined) savePropsFromSide(m);
    };
    side.onkeydown = (e) => { if (e.key === 'Enter' && e.target.matches('input.inp')) e.target.blur(); };
    side.onclick = async (e) => {
      const segBtn = e.target.closest('.seg button');
      if (segBtn && !segBtn.classList.contains('on')) {
        segBtn.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === segBtn));
        editItem(m, { [segBtn.parentElement.dataset.f]: segBtn.dataset.v });
        return;
      }
      const sw = e.target.closest('[data-fbool]');
      if (sw && !sw.disabled) { sw.classList.toggle('on'); setField(sw.dataset.fbool, sw.classList.contains('on')); return; }
      const rmfocus = e.target.closest('[data-rmfocus]');
      if (rmfocus) { e.stopPropagation(); const f = focusBoards().find((x) => x.id === rmfocus.dataset.rmfocus); if (f) patchFocus(f, { remove: [it.id] }, `Took ${it.id} out of "${f.name}"`); return; }
      const showf = e.target.closest('[data-showfocus]');
      if (showf) { showFocus(showf.dataset.showfocus); return; }
      if (e.target.closest('[data-act="focus-add"]')) {
        menu(e.target.closest('button'), focusBoards().filter((f) => !f.itemIds.includes(it.id)).map((f) => ({ label: f.name, icon: 'target', hint: String(f.itemIds.length), run: () => patchFocus(f, { add: [it.id] }, `Added ${it.id} to "${f.name}"`) })));
        return;
      }
      const rmdep = e.target.closest('[data-rmdep]');
      if (rmdep) { e.stopPropagation(); editItem(m, { blockedBy: it.blockedBy.filter((x) => x !== rmdep.dataset.rmdep) }); return; }
      const rmtag = e.target.closest('[data-rmtag]');
      if (rmtag) { const k = rmtag.dataset.rmtag; const next = (it.fields[k] || []).filter((x) => x !== rmtag.dataset.tag); setField(k, next.length ? next : null); return; }
      const dep = e.target.closest('[data-open]');
      if (dep) { openItem(dep.dataset.open); return; }
      const del = e.target.closest('[data-del]');
      if (del) { editItem(m, { properties: { [del.dataset.del]: null } }); return; }
      if (e.target.closest('.add-row')) {
        const props = $('.props', side);
        const row = el(`<div class="prop"><input class="inp k" data-k="" placeholder="key"><input class="inp" data-v="" placeholder="value"><button class="x" title="Cancel">${icon('x', 'sm')}</button></div>`);
        $('.x', row).onclick = () => row.remove();
        props.append(row);
        $('input', row).focus();
        return;
      }
      const dd = e.target.closest('[data-dd]');
      if (dd) { openSideDropdown(m, dd); return; }
      if (e.target.closest('[data-act="rv-add"]')) {
        const it = draftView(m);
        const mine = new Set([it.assignee, ...(it.workedBy || []), ...(it.questions || []).filter((q) => q.kind === 'review').map((q) => q.raisedBy)].filter(Boolean));
        const pool = Object.values(state.standing || {}).filter((a) => a.reviewer && !(it.reviewers || []).some((r) => r.name === a.name));
        menu(e.target.closest('button'), pool.length ? pool.map((a) => ({
          label: nameOf(a.name), avatar: { kind: 'agent', name: a.name }, hint: mine.has(a.name) ? 'worked on it' : (a.areas || []).slice(0, 2).join(', '), cls: mine.has(a.name) ? 'off' : '',
          run: () => (mine.has(a.name) ? toast(`${nameOf(a.name)} worked on this — pick someone else`, { kind: 'error' }) : api('POST', I(m.id, '/reviewers'), { name: a.name }).then(() => scheduleRefresh(0), (err) => toast(err.message, { kind: 'error' }))),
        })) : [{ label: 'No reviewers yet — switch on "Can review" in an agent\'s Speciality', icon: 'info', run: () => {} }]);
        return;
      }
      const rvRm = e.target.closest('[data-act="rv-rm"]');
      if (rvRm) { api('DELETE', I(m.id, `/reviewers/${encodeURIComponent(rvRm.dataset.rv)}`)).then(() => scheduleRefresh(0), (err) => toast(err.message, { kind: 'error' })); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      try {
        if (act === 'revoke') { await api('DELETE', I(m.id, '/lease')); scheduleRefresh(0); }
        if (act === 'claim') {
          menu(e.target.closest('button'), [15, 30, 60, 240].map((min) => ({
            label: min < 60 ? `${min} min` : `${min / 60} h`, icon: 'clock',
            run: async () => { try { await api('POST', I(m.id, '/lease'), { minutes: min, force: true }); scheduleRefresh(0); } catch (err) { toast(err.message, { kind: 'error' }); } },
          })));
        }
        if (act === 'restore') {
          await api('POST', B(`/archive/${encodeURIComponent(m.id)}/restore`), {});
          await loadBoard(state.boardId);
          m.switchTo(m.id, { item: state.board.items[m.id], archived: false });
        }
      } catch (err) { toast(err.message, { kind: 'error' }); }
    };
  }

  function knownPeople() {
    const s = new Set([settings.userName]);
    for (const p of state.presence) s.add(p.name);
    for (const n of Object.keys(state.profiles)) s.add(n);
    for (const it of Object.values(state.board.items)) { if (it.author?.name) s.add(it.author.name); if (it.lease?.claimant) s.add(it.lease.claimant); }
    return [...s].filter(Boolean);
  }

  /* ─── reactions: emoji on cards and comments ─── */

  const REACT_SET = ['👍', '👀', '🎉', '❤️', '🚀', '🤔', '✅', '😄'];
  // An agent's ⏳ (queued) and 👀 (its run started) report status; they are not votes (INT-186, INT-189).
  const STATUS_MARKS = { '⏳': 'Queued', '👀': 'Seen' };
  // Anyone but me without a person's profile counts as an agent: agents need no profile to react.
  const isAgentName = (n) => n !== settings.userName && state.profiles[n]?.kind !== 'user';
  // Chips for a reactions map; mine are highlighted. data-react carries the emoji, data-cid the comment.
  // Agents' status marks draw as quiet spans nobody can toggle; a person's 👀 stays a pill of its own.
  function reactionsHTML(reactions, { cid = '', add = true, compact = false, notes = {} } = {}) {
    const entries = Object.entries(reactions || {}).filter(([, who]) => who.length);
    if (!entries.length && !add) return '';
    const me = settings.userName;
    const named = (e, who) => who.map((n) => (notes?.[`${e}|${n}`] ? `${n} — ${notes[`${e}|${n}`]}` : n)).join(', ');
    const pill = (e, who) => `<button class="react ${who.includes(me) ? 'mine' : ''}" data-react="${esc(e)}" data-cid="${esc(cid)}" title="${esc(e)}|${esc(named(e, who))}"><span>${e}</span><b>${who.length}</b></button>`;
    const mark = (e, who) => {
      const line = e === '⏳' ? (notes?.[`${e}|${who[0]}`] || 'queued').replace(/^queued — /, 'queued · ') : '';
      return `<span class="react status" title="${esc(STATUS_MARKS[e])}|${esc(named(e, who))}"><span>${e}</span>${who.length > 1 ? `<b>${who.length}</b>` : ''}${line ? `<i>${esc(line)}</i>` : ''}</span>`;
    };
    const chips = entries.flatMap(([e, who]) => {
      if (!STATUS_MARKS[e]) return [pill(e, who)];
      const agents = who.filter(isAgentName), people = who.filter((n) => !isAgentName(n));
      return [agents.length && mark(e, agents), people.length && pill(e, people)].filter(Boolean);
    });
    return `<div class="reacts ${compact ? 'compact' : ''}">${chips.join('')}${add ? `<button class="react add" data-react-add data-cid="${esc(cid)}" title="React|Add an emoji — agents see it, it never wakes them">${icon('smile', 'sm')}</button>` : ''}</div>`;
  }
  function reactPicker(anchor, onPick) {
    $$('.react-pick').forEach((x) => x.remove());
    const pick = el(`<div class="react-pick">${REACT_SET.map((e) => `<button data-e="${e}">${e}</button>`).join('')}</div>`);
    document.body.append(pick);
    const r = anchor.getBoundingClientRect();
    pick.style.left = `${Math.min(r.left, innerWidth - pick.offsetWidth - 8)}px`;
    pick.style.top = `${r.top - pick.offsetHeight - 6 < 8 ? r.bottom + 6 : r.top - pick.offsetHeight - 6}px`;
    const close = (e) => { if (!pick.contains(e.target)) { pick.remove(); document.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => document.addEventListener('pointerdown', close, true));
    pick.onclick = (e) => { const b = e.target.closest('[data-e]'); if (!b) return; pick.remove(); document.removeEventListener('pointerdown', close, true); onPick(b.dataset.e); };
  }
  async function toggleReaction(itemId, emoji, commentId) {
    try { await api('POST', I(itemId, '/reactions'), { emoji, toggle: true, ...(commentId ? { commentId } : {}) }); scheduleRefresh(0); }
    catch (e) { toast(e.message, { kind: 'error' }); }
  }
  // One delegated handler for reaction chips and the add button inside a container.
  function wireReactions(root, itemId) {
    root.addEventListener('click', (e) => {
      const add = e.target.closest('[data-react-add]');
      if (add) { e.stopPropagation(); reactPicker(add, (emoji) => toggleReaction(itemId, emoji, add.dataset.cid || null)); return; }
      const chip = e.target.closest('[data-react]');
      if (chip) { e.stopPropagation(); toggleReaction(itemId, chip.dataset.react, chip.dataset.cid || null); }
    });
  }

  /* ─── @mention suggestions in comment-style text boxes ─── */

  // Where the caret sits inside a textarea, in viewport pixels (mirror-div technique).
  function caretPoint(ta) {
    const cs = getComputedStyle(ta);
    const mirror = document.createElement('div');
    for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'boxSizing', 'width', 'tabSize']) mirror.style[p] = cs[p];
    Object.assign(mirror.style, { position: 'fixed', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', top: '0', left: '0' });
    mirror.textContent = ta.value.slice(0, ta.selectionStart);
    const mark = document.createElement('span');
    mark.textContent = '​';
    mirror.append(mark);
    document.body.append(mirror);
    const r = ta.getBoundingClientRect();
    const pt = { x: r.left + mark.offsetLeft - ta.scrollLeft, y: r.top + mark.offsetTop - ta.scrollTop + mark.offsetHeight };
    mirror.remove();
    return pt;
  }

  const mention = { pop: null, ta: null, start: 0, items: [], active: 0 };
  function mentionCandidates(q) {
    const it = state.modal?.kind === 'item' ? state.board?.items[state.modal.id] : null;
    const involved = new Set([...(it?.workedBy || []), it?.assignee, it?.author?.name, ...(it?.questions || []).map((x) => x.raisedBy)].filter(Boolean));
    const names = new Set([...knownPeople(), ...Object.keys(state.standing || {})]);
    names.delete(settings.userName);
    const ql = q.toLowerCase();
    return [...names].map((name) => {
      const p = state.profiles[name] || {};
      const pres = state.presence.find((x) => x.name === name);
      const run = state.standing?.[name]?.status;
      const live = run === 'running' ? 'running' : pres?.online ? 'online' : state.standing?.[name] ? 'standing' : '';
      const hit = !ql ? 1 : name.toLowerCase().startsWith(ql) ? 3 : (p.label || '').toLowerCase().includes(ql) || name.toLowerCase().includes(ql) ? 2 : 0;
      return { name, label: p.label || '', live, score: hit && hit * 100 + (involved.has(name) ? 40 : 0) + (live === 'running' || live === 'online' ? 20 : live ? 10 : 0) };
    }).filter((x) => x.score).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 7);
  }
  function closeMention() { mention.pop?.remove(); mention.pop = null; mention.ta = null; }
  function drawMention() {
    const pop = mention.pop;
    pop.innerHTML = mention.items.map((x, i) => `<button class="mi ${i === mention.active ? 'act' : ''}" data-i="${i}">${avatar({ name: x.name })}<span class="mn">${esc(x.label || x.name)}</span>${x.label && x.label !== x.name ? `<span class="ml">@${esc(x.name)}</span>` : ''}${x.live ? `<i class="mlive ${x.live}" title="${x.live}"></i>` : ''}</button>`).join('');
  }
  function updateMention(ta) {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = /(^|[\s(])@([\w.-]*)$/.exec(upto);
    if (!m) { closeMention(); return; }
    const items = mentionCandidates(m[2]);
    if (!items.length) { closeMention(); return; }
    if (!mention.pop) {
      mention.pop = el('<div class="menu mention-pop" role="listbox"></div>');
      mention.pop.addEventListener('mousedown', (e) => {
        const b = e.target.closest('[data-i]');
        if (b) { e.preventDefault(); pickMention(Number(b.dataset.i)); }
      });
      document.body.append(mention.pop);
    }
    Object.assign(mention, { ta, start: upto.length - m[2].length - 1, items, active: Math.min(mention.active, items.length - 1) });
    drawMention();
    const pt = caretPoint(ta);
    const w = mention.pop.offsetWidth;
    const h = mention.pop.offsetHeight;
    mention.pop.style.left = `${Math.min(pt.x - 10, innerWidth - w - 8)}px`;
    mention.pop.style.top = `${pt.y + h + 8 > innerHeight ? pt.y - h - 26 : pt.y + 4}px`;
  }
  function pickMention(i) {
    const { ta, start, items } = mention;
    const x = items[i];
    if (!ta || !x) return;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(ta.selectionStart);
    ta.value = `${before}@${x.name} ${after.replace(/^\S*/, '')}`;
    const pos = before.length + x.name.length + 2;
    ta.setSelectionRange(pos, pos);
    closeMention();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  }
  const mentionable = (t) => t?.tagName === 'TEXTAREA' && !t.closest('.composer');
  document.addEventListener('input', (e) => { if (mentionable(e.target)) updateMention(e.target); else if (mention.pop) closeMention(); });
  document.addEventListener('click', (e) => { if (mention.pop && !mention.pop.contains(e.target) && e.target !== mention.ta) closeMention(); });
  document.addEventListener('focusout', (e) => { if (e.target === mention.ta) setTimeout(() => { if (document.activeElement !== mention.ta) closeMention(); }, 120); });
  // Capture phase: while suggestions are open, arrows/Enter/Tab/Escape belong to them, not to the text box.
  document.addEventListener('keydown', (e) => {
    if (!mention.pop || e.target !== mention.ta) return;
    const n = mention.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { mention.active = (mention.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; drawMention(); }
    else if (e.key === 'Enter' || e.key === 'Tab') pickMention(mention.active);
    else if (e.key === 'Escape') closeMention();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  document.addEventListener('keyup', (e) => { if (mentionable(e.target) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')) updateMention(e.target); });

  function openSideDropdown(m, btn) {
    const it = draftView(m);
    const b = state.board;
    const key = btn.dataset.dd;
    if (key === 'column') {
      const from = colById(it.columnId);
      openDd(btn, b.columns.map((c) => ({
        label: c.name, color: c.color, cls: c.id === it.columnId ? 'on' : '',
        disabled: c.id !== it.columnId && !(from?.flags.allowMoveOut && c.flags.allowMoveIn),
        run: () => { if (c.id !== it.columnId) editItem(m, { column: c.id, position: 'top' }); },
      })));
    } else if (key === 'parent') {
      const parents = [...new Set(Object.values(b.items).map((x) => x.parent).filter(Boolean))].sort();
      openDd(btn, [
        { label: 'None', icon: 'x', cls: !it.parent ? 'on' : '', run: () => it.parent && editItem(m, { parent: null }) },
        ...(parents.length ? ['-'] : []),
        ...parents.map((p) => ({ label: p, color: tagColor(p), cls: p === it.parent ? 'on' : '', hint: String(Object.values(b.items).filter((x) => x.parent === p).length), run: () => p !== it.parent && editItem(m, { parent: p }) })),
      ], { search: true, creatable: (v) => editItem(m, { parent: v.replace(/^#/, '') }), placeholder: 'Find or add…' });
    } else if (key === 'assignee') {
      openDd(btn, [{ label: 'Nobody', icon: 'x', cls: !it.assignee ? 'on' : '', run: () => it.assignee && editItem(m, { assignee: null }) }, '-',
        ...knownPeople().map((n) => ({ label: n, avatar: { name: n, kind: n === settings.userName ? 'user' : 'agent' }, cls: n === it.assignee ? 'on' : '', run: () => n !== it.assignee && editItem(m, { assignee: n }) }))],
      { search: true, creatable: (v) => editItem(m, { assignee: v }), placeholder: 'Find or add…' });
    } else if (key === 'blockedBy') {
      const pool = Object.values(b.items).filter((x) => x.id !== it.id && !it.blockedBy?.includes(x.id));
      openDd(btn, pool.map((x) => ({ label: `${x.id} · ${x.title}`, icon: x.type, run: () => editItem(m, { blockedBy: [...(it.blockedBy || []), x.id] }) })), { search: true });
    } else if (key.startsWith('f:')) {
      const f = schema().fields.find((x) => x.key === key.slice(2));
      if (!f) return;
      const cur = it.fields?.[f.key];
      const set = (v) => editItem(m, { fields: { [f.key]: v } });
      if (f.type === 'enum') {
        openDd(btn, [{ label: 'None', icon: 'x', cls: cur == null ? 'on' : '', run: () => cur != null && set(null) }, '-',
          ...f.options.map((o) => ({ label: o.value, color: o.color || 'var(--accent)', cls: o.value === cur ? 'on' : '', run: () => set(o.value) }))], { search: f.options.length > 7 });
      } else if (f.type === 'user') {
        openDd(btn, [{ label: 'Nobody', icon: 'x', run: () => cur && set(null) }, '-',
          ...knownPeople().map((n) => ({ label: n, avatar: { name: n, kind: n === settings.userName ? 'user' : 'agent' }, cls: n === cur ? 'on' : '', run: () => set(n) }))],
        { search: true, creatable: (v) => set(v), placeholder: 'Find or add…' });
      } else if (f.type === 'tags') {
        const have = cur || [];
        const pool = f.options?.length ? f.options.map((o) => o.value)
          : [...new Set(Object.values(b.items).flatMap((x) => x.fields?.[f.key] || []))];
        openDd(btn, pool.filter((t) => !have.includes(t)).map((t) => ({ label: t, color: optColor(f, t) || 'var(--accent)', run: () => set([...have, t]) })),
          { search: true, creatable: f.options?.length ? null : (v) => set([...have, v]), placeholder: f.options?.length ? 'Search…' : 'Find or add…' });
      }
    }
  }

  function parseVal(s) {
    const t = s.trim();
    if (t === '') return '';
    try { return JSON.parse(t); } catch { return s; }
  }
  // Diff the key/value rows against the stored bag; renamed keys become delete + add.
  function savePropsFromSide(m) {
    const side = $('.m-side', m.root);
    const rows = $$('.prop', side);
    const next = {};
    for (const r of rows) { const k = $('[data-k]', r).value.trim(); if (k) next[k] = parseVal($('[data-v]', r).value); }
    const cur = draftView(m).properties || {};
    const patch = {};
    for (const k of Object.keys(cur)) if (!(k in next)) patch[k] = null;
    for (const [k, v] of Object.entries(next)) if (JSON.stringify(cur[k]) !== JSON.stringify(v)) patch[k] = v;
    if (Object.keys(patch).length) editItem(m, { properties: patch });
  }

  function tickModal() {
    for (const n of $$('[data-left]')) {
      const left = Date.parse(n.dataset.left) - nowMs();
      n.textContent = left > 0 ? `${fmtLeft(left)} left` : 'expired';
    }
  }

  async function loadActivity(m) {
    const box = $('.tab-activity', m.root);
    try {
      const evs = await api('GET', I(m.id, '/history'));
      box.innerHTML = evs.length ? evs.slice().reverse().map((ev) => `<div class="act">${icon(eventIcon(ev.type), 'sm')}<div>${describe(ev, true)}</div><time title="${esc(ev.ts)}">${rel(ev.ts)}</time></div>`).join('')
        : `<div class="empty-note">${icon('activity')}</div>`;
    } catch { box.innerHTML = ''; }
  }

  /* ═════════════════════════ events → words ═════════════════════════ */

  function eventIcon(t) {
    if (t === 'lease.status') return 'activity';
    if (t === 'item.assigned') return 'user';
    if (t === 'item.unblocked') return 'sparkle';
    if (t === 'review.requested') return 'eye';
    if (t.startsWith('master')) return 'lock';
    if (t === 'digest.added') return 'news';
    if (t.startsWith('lease')) return 'clock';
    if (t.startsWith('attention')) return 'ask';
    if (t.startsWith('comment')) return 'msg';
    if (t === 'item.moved' || t === 'item.reordered') return 'move';
    if (t === 'item.archived') return 'archive';
    if (t === 'item.restored') return 'restore';
    if (t === 'item.created') return 'plus';
    if (t === 'schema.updated') return 'layers';
    return 'pencil';
  }

  function describe(ev, html = false) {
    const b = (s) => (html ? `<b>${esc(s)}</b>` : s);
    const who = b(ev.actor?.name ? nameOf(ev.actor.name) : 'someone');
    const nb = (n) => b(nameOf(n));
    const id = ev.item?.id || ev.itemId || '';
    const fields = Object.keys(ev.changes || {}).map((k) => k.replace(/^(properties|fields)\./, '')).join(', ');
    switch (ev.type) {
      case 'item.created': return `${who} created ${b(id)}${html ? '' : ` · ${ev.item?.title}`}`;
      case 'item.updated': return `${who} changed ${b(id)} ${fields}`;
      case 'item.moved': return `${who} moved ${b(id)} → ${b(ev.item?.column || '')}${ev.delegated ? ' for you' : ''}`;
      case 'item.reordered': return `${who} reordered ${b(id)}`;
      case 'item.archived': return `${who} archived ${b(id)}`;
      case 'item.deleted': return `${who} deleted test ticket ${b(id)}`;
      case 'review.reviewer_assigned': return `${who} asked ${b(nameOf(ev.reviewer))} to review ${b(id)}${ev.again ? ' again' : ''}`;
      case 'review.reviewer_removed': return `${who} removed ${b(nameOf(ev.reviewer))} as reviewer of ${b(id)}`;
      case 'review.reviewed': return `${who} reviewed ${b(id)}: ${ev.verdict === 'ok' ? 'looks good ✓' : 'concerns ⚠'}`;
      case 'agent.managed': return `${who} changed ${b(nameOf(ev.agent))}: ${Object.keys(ev.changes || {}).map((k) => k.replace(/^profile\./, '')).join(', ')}${ev.delegated ? ' for you' : ''}`;
      case 'item.restored': return `${who} restored ${b(id)}`;
      case 'comment.added': return `${who} on ${b(id)}: ${html ? esc(ev.comment?.body?.slice(0, 120)) : ev.comment?.body?.slice(0, 80)}${ev.comment?.attachments ? ` ${html ? icon('clip', 'sm') : '📎'}` : ''}`;
      case 'lease.claimed': return `${nb(ev.claimant)} claimed ${b(id)}`;
      case 'lease.renewed': return `${nb(ev.claimant)} renewed ${b(id)}`;
      case 'lease.released': return `${nb(ev.claimant)} released ${b(id)}`;
      case 'lease.requested': return `${who} asks ${nb(ev.claimant)} for ${b(id)}${ev.reason ? `: ${html ? esc(ev.reason) : ev.reason}` : ''}`;
      case 'lease.handed': return `${nb(ev.from)} handed ${b(id)} to ${nb(ev.claimant)}${ev.note ? `: ${html ? esc(ev.note) : ev.note}` : ''}`;
      case 'lease.declined': return `${who} declined ${nb(ev.requester)}'s request for ${b(id)}${ev.reason ? `: ${html ? esc(ev.reason) : ev.reason}` : ''}`;
      case 'lease.revoked': return `${who} revoked ${nb(ev.claimant)}'s lease on ${b(id)}`;
      case 'lease.warning': return `${nb(ev.claimant)}'s lease on ${b(id)} ends in ${ev.minutesLeft}m`;
      case 'lease.expired': return `${nb(ev.claimant)}'s lease on ${b(id)} expired`;
      case 'attention.raised': return `${who} needs you on ${b(id)}`;
      case 'attention.resolved': return `${who} answered ${b(id)}`;
      case 'column.created': return `${who} added column ${b(ev.column?.name || '')}`;
      case 'column.updated': return `${who} updated column ${b(ev.column?.name || '')}`;
      case 'schema.updated': return `${who} changed the ticket schema`;
      case 'board.updated': return `${who} updated the board`;
      case 'board.external-edit': return 'Board file changed on disk';
      case 'lease.status': return `${nb(ev.claimant)} on ${b(id)}: ${html ? esc(ev.status || '—') : ev.status || '—'}`;
      case 'item.assigned': return `${who} assigned ${b(id)} to ${b(ev.assignee || 'nobody')}`;
      case 'agent.run.started': return `${b(ev.agent)} woke up${ev.items?.length ? ` for ${ev.items.map(b).join(', ')}` : ''}`;
      case 'agent.run.finished': return ev.code === 0 ? `${b(ev.agent)} finished a run` : `${b(ev.agent)}'s run failed (${ev.code}) — retrying`;
      case 'agent.failed': return `${b(ev.agent)} keeps failing — paused until you resume it`;
      case 'agent.status': return `${b(ev.agent)} is ${RUN_LABEL[ev.status] || ev.status}`;
      case 'agents.changed': return ev.error ? `agents.json: ${ev.error}` : 'Standing agents updated';
      case 'master.claimed': return `${b(ev.holder)} is holding the whole board`;
      case 'master.renewed': return `${b(ev.holder)} renewed the board hold`;
      case 'master.released': return `${b(ev.holder)} released the board`;
      case 'master.revoked': return `${who} revoked ${b(ev.holder)}'s board hold`;
      case 'master.expired': return `${b(ev.holder)}'s board hold expired`;
      case 'master.status': return `${b(ev.holder)}: ${html ? esc(ev.status || '—') : ev.status || '—'}`;
      case 'review.requested': return `${who} asked you to review ${b(id)}`;
      case 'reaction.added': return `${who} reacted ${ev.emoji} on ${b(id)}`;
      case 'reaction.removed': return `${who} removed ${ev.emoji} on ${b(id)}`;
      case 'request.created': return `${who} asked ${b(ev.request?.to)}: ${html ? esc(String(ev.request?.body || '').slice(0, 80)) : String(ev.request?.body || '').slice(0, 80)}`;
      case 'request.replied': return `${who} replied to a request${ev.reply ? `: ${html ? esc(ev.reply.slice(0, 80)) : ev.reply.slice(0, 80)}` : ''}`;
      case 'request.done': return `${who} finished a request${ev.reply ? `: ${html ? esc(ev.reply.slice(0, 80)) : ev.reply.slice(0, 80)}` : ''}`;
      case 'review.approved': return `${who} approved ${b(id)}${ev.delegated ? ' for you' : ''}`;
      case 'review.changes_requested': return `${who} sent ${b(id)} back${ev.delegated ? ' for you' : ''}${ev.feedback ? `: ${html ? esc(ev.feedback) : ev.feedback}` : ''}`;
      case 'digest.added': return `${who} posted to the digest`;
      case 'item.unblocked': return `${b(id)} is unblocked (${b(ev.resolvedBy)} done)`;
      case 'app.renamed': return `${who} renamed the app to ${b(ev.to)}`;
      default: return `${who} · ${ev.type}`;
    }
  }

  /* ═════════════════════════ live: SSE + fallback ═════════════════════════ */

  // The stream URL carries a one-use ticket, never the token. The browser's own retry would reuse a spent
  // ticket, so on any error the UI closes the stream and opens a new one with a fresh ticket.
  let liveES = null;
  let retryTimer = null;
  function reconnect() { clearTimeout(retryTimer); liveES?.close(); liveES = null; connect(); }
  function retryLater() { clearTimeout(retryTimer); retryTimer = setTimeout(connect, 2000); }
  async function connect() {
    let ticket;
    try { ({ ticket } = await api('POST', '/api/stream-ticket')); } catch { setLive(false); retryLater(); return; }
    if (liveES) return; // reconnect() ran while this one waited for its ticket
    const es = new EventSource(`/api/stream?ui=1&ticket=${encodeURIComponent(ticket)}`);
    liveES = es;
    es.onopen = () => setLive(true);
    es.onerror = () => { setLive(false); es.close(); if (liveES === es) { liveES = null; retryLater(); } };
    es.onmessage = (msg) => {
      let ev;
      try { ev = JSON.parse(msg.data); } catch { return; }
      onEvent(ev);
    };
  }
  function setLive(on) {
    if (state.live === on) return;
    state.live = on;
    $('.live-dot')?.classList.toggle('on', on);
    if (on) { scheduleRefresh(0); refreshPresence(); }
  }

  const QUIET = new Set(['item.reordered', 'presence.changed', 'lease.renewed', 'board.external-edit', 'profile.updated', 'schema.updated', 'lease.status', 'master.status', 'master.renewed', 'agent.status', 'agent.run.finished', 'reaction.added', 'reaction.removed']);
  function onEvent(ev) {
    if (ev.type === 'hello') return;
    if (ev.type === 'presence.changed' || (ev.type?.startsWith('lease.') && ev.type !== 'lease.status')) refreshPresence();
    if (ev.type === 'presence.changed') scheduleListeners();
    if (ev.type === 'item.created' && ev.itemId) freshUntil.set(ev.itemId, Date.now() + FRESH_MS);
    if (ev.type?.startsWith('request.')) { $('#requestsDrawer .drawer-body')?._reload?.(); if (ev.board === state.boardId) reloadAsk(); }
    if (/^(item\.moved|item\.archived|attention\.|review\.)/.test(ev.type || '')) loadMetrics();
    if (ev.type?.startsWith('agent.') || ev.type === 'agents.changed') refreshPresence();
    if (ev.board && ev.itemId) {
      if (document.hidden) { if (newsworthy(ev)) { noteUnseen(ev); saveSeen(); } }
      else if (ev.board === state.boardId) seenFor(ev.board).seq = ev.seq;
    }
    if (forMe(ev) && !state.inbox.some((x) => x.seq === ev.seq)) { state.inbox.unshift(ev); state.inbox.length = Math.min(200, state.inbox.length); renderInboxBtn(); }
    if (ev.type === 'app.renamed') { state.app.name = ev.to; renderHeader(); }
    if (ev.type === 'profile.updated') refreshProfiles();
    if (ev.type === 'board.created' || ev.type === 'board.updated' || ev.type?.startsWith('item.')) refreshBoards();
    if (ev.board === state.boardId && ev.hash && ev.hash !== state.hash) scheduleRefresh();
    const m = state.modal;
    if (m?.kind === 'item' && ev.itemId === m.id && m.tab === 'activity') setTimeout(() => state.modal === m && loadActivity(m), 120);
    announce(ev);
  }

  function announce(ev) {
    if (ev.actor?.kind === 'user' && ev.actor.name === settings.userName) return;
    if (ev.actor?.kind === 'user' && ev.type !== 'comment.added') return;
    if (QUIET.has(ev.type)) return;
    const important = ev.type === 'attention.raised' || (ev.type === 'comment.added' && ev.mentions?.some((n) => n.toLowerCase() === settings.userName.toLowerCase()));
    if ((ev.type === 'request.replied' || ev.type === 'request.done') && ev.actor?.kind === 'agent') {
      if (askOpen() && ev.board === state.boardId) return; // the reply is landing in the open thread already
      toast(describe(ev), { actor: ev.actor, onClick: () => (ev.board === state.boardId ? openAsk() : openRequests()), timeout: 6000 });
      return;
    }
    if (ev.type === 'agent.failed') {
      toast(describe(ev), { kind: 'needs', icon: 'bot', action: 'Log', onAction: () => showRunLog(ev.agent), onClick: () => openAgent(ev.agent), timeout: 9000 });
      return;
    }
    if (settings.toasts && (ev.board === state.boardId || (!ev.board && ev.type.startsWith('agent')))) {
      toast(describe(ev), { actor: ev.actor, kind: important ? 'needs' : '', onClick: ev.itemId ? () => openItem(ev.itemId, cardEls.get(ev.itemId), { rail: ev.type === 'attention.raised' }) : null, timeout: important ? 7000 : 3800 });
    }
    if (settings.sound) blip(important);
    if (settings.notify && 'Notification' in window && Notification.permission === 'granted' && (!settings.notifyHidden || document.hidden)) {
      try {
        const n = new Notification(important ? `${state.app.name} · needs you` : state.app.name, { body: describe(ev), tag: ev.itemId || ev.type, icon: '/favicon.svg', silent: !important });
        n.onclick = () => { window.focus(); if (ev.itemId) { if (ev.board !== state.boardId) loadBoard(ev.board).then(() => openItem(ev.itemId)); else openItem(ev.itemId); } n.close(); };
      } catch { /* notifications blocked */ }
    }
  }

  let audioCtx = null;
  function blip(important) {
    try {
      audioCtx ||= new AudioContext();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      const t = audioCtx.currentTime;
      o.type = 'sine';
      o.frequency.setValueAtTime(important ? 660 : 880, t);
      o.frequency.exponentialRampToValueAtTime(important ? 990 : 1320, t + 0.09);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.26);
    } catch { /* no audio */ }
  }

  async function fallbackPoll() {
    if (state.live || !state.boardId) return;
    try { const h = await api('GET', B('/hash')); if (h.hash !== state.hash) scheduleRefresh(0); } catch { /* server down */ }
  }

  /* ═════════════════════════ drawers + toasts ═════════════════════════ */

  /* ─── the hub: Inbox, Digest, Agents and friends share one settings-style window ─── */

  // Each page: [page id, label, icon, opener]. Sub-pages (an agent's profile, a run log) light up their parent.
  const HUB = [
    ['requestsDrawer', 'Ask an agent', 'send', () => openRequests()],
    ['inboxDrawer', 'Inbox', 'bell', () => openInbox()],
    ['catchDrawer', 'While you were away', 'sparkle', () => openCatchup()],
    ['digestDrawer', 'Digest', 'news', () => openDigest()],
    ['agentsDrawer', 'Agents', 'bot', () => openAgents()],
    ['rulesDrawer', 'Standing rules', 'pin', () => openRules()],
    ['metricsDrawer', 'Flow', 'activity', () => openMetrics()],
    ['archiveDrawer', 'Archive', 'archive', () => openArchive()],
  ];
  const HUB_PARENT = { agentDrawer: 'agentsDrawer', runLogDrawer: 'agentsDrawer' };

  // Opens (or reuses) the hub on a page and returns that page's body element. Pages keep their old
  // drawer ids, so code that looks for `#agentsDrawer .drawer-body` still finds them.
  function openDrawer(id, title, iconName) {
    let m = state.modal?.kind === 'hub' ? state.modal : null;
    if (!m) {
      closeModal(true);
      const root = el(`<div class="scrim"><div class="modal settings hub entering" role="dialog" aria-modal="true">
        <header class="m-head"><button class="pill-btn icon-btn sm hub-back" hidden title="Back">${icon('chev', 'back')}</button><span class="m-type hub-ic" style="color:var(--accent)"></span><span class="hub-title"></span><span class="grow"></span><button class="pill-btn icon-btn sm" data-close>${icon('x')}</button></header>
        <div class="m-frame"><nav class="set-nav">${HUB.map(([hid, label, ic]) => `<button data-hub="${hid}">${icon(ic)}${label}</button>`).join('')}</nav><div class="set-pane hub-pane"></div></div></div></div>`);
      document.body.append(root);
      m = { kind: 'hub', id: null, root, modal: $('.modal', root), refresh: () => {} };
      state.modal = m;
      syncScrimmed();
      root.addEventListener('pointerdown', (e) => { root._down = e.target === root; });
      root.addEventListener('click', (e) => { if (e.target === root && root._down) closeModal(); });
      $('[data-close]', root).onclick = () => closeModal();
      for (const b of $$('[data-hub]', root)) b.onclick = () => HUB.find(([hid]) => hid === b.dataset.hub)[3]();
      $('.hub-back', root).onclick = () => HUB.find(([hid]) => hid === m.parent)?.[3]();
    }
    const parent = HUB_PARENT[id] || id;
    m.page = id;
    m.parent = parent;
    $$('[data-hub]', m.root).forEach((b) => b.classList.toggle('on', b.dataset.hub === parent));
    $('.hub-ic', m.root).innerHTML = icon(iconName);
    $('.hub-title', m.root).textContent = title;
    $('.hub-back', m.root).hidden = !HUB_PARENT[id];
    const pane = $('.hub-pane', m.root);
    pane.innerHTML = `<div class="hub-page" id="${id}"><div class="drawer-body"></div></div>`;
    pane.scrollTop = 0;
    if (!reduced()) pane.animate([{ opacity: 0, translate: '0 6px' }, { opacity: 1, translate: '0 0' }], { duration: 240, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    return $('.drawer-body', pane);
  }
  function closeDrawers() { if (state.modal?.kind === 'hub') closeModal(); }

  /* ─── requests: free-form asks to an agent (default: the board's coordinator) ─── */
  const agentChoices = () => [...new Set([...Object.keys(state.standing || {}), ...state.presence.map((p) => p.name), ...Object.keys(state.profiles).filter((n) => state.profiles[n]?.kind !== 'user')])].filter((n) => n && n !== settings.userName);
  // The request chat reads like an IM thread: every request and reply in time order, the human on the
  // right, agents on the left with their profile look. One sender's back-to-back messages (same day,
  // within REQ_GROUP_MS) share a single head; a reply that doesn't follow its own request quotes it.
  const REQ_GROUP_MS = 5 * 60 * 1000;
  function reqThread(list, who) {
    const msgs = [];
    for (const q of list) {
      if (who && q.to !== who) continue;
      msgs.push({ id: q.id, q, ask: true, author: q.by, at: q.at, body: q.body, attachments: q.attachments });
      for (const x of q.replies || []) msgs.push({ id: x.id, q, author: x.author, at: x.at, body: x.body, attachments: x.attachments });
    }
    msgs.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    msgs.forEach((m, i) => {
      const p = msgs[i - 1];
      m.mine = m.author?.kind !== 'agent';
      m.day = new Date(m.at).toLocaleDateString('en-CA');
      m.cont = !!p && p.day === m.day && p.author?.name === m.author?.name && Date.parse(m.at) - Date.parse(p.at) < REQ_GROUP_MS;
      m.quote = !m.ask && !(p && p.q === m.q);
      if (p) p.last = !m.cont;
    });
    if (msgs.length) msgs[msgs.length - 1].last = true;
    return msgs;
  }
  let reqWho = ''; // the conversation picked in the chat ('' = all agents); kept while the page is open
  async function openRequests() {
    const body = openDrawer('requestsDrawer', 'Ask an agent', 'send');
    const pane = body.closest('.hub-pane');
    let to = reqWho || state.board.coordinator || '';
    let list = [];
    let seen = null; // message ids already drawn: only new ones animate in
    const toLabel = () => (to ? `${avatar({ name: to })}${nameHTML(to)}${to === state.board.coordinator ? ' <span class="muted">· coordinator</span>' : ''}` : '<span class="muted">Choose an agent</span>');
    const ph = () => (to ? `Message ${nameOf(to)}… — @mention to loop someone in` : 'Choose an agent to message');
    body.innerHTML = `<div class="req-chats"></div><div class="req-thread"></div>
      <div class="req-compose">
        <div class="req-to"><span class="muted">To</span><button class="dd" data-req-to>${toLabel()}${icon('chev', 'sm')}</button></div>
        ${tboxHTML({ ph: ph(), okIcon: 'send', okTitle: 'Send (Ctrl+Enter)', rows: 2 })}
      </div>`;
    const ta = $('.req-compose textarea', body);
    const staged = pasteStage($('.req-compose .tbox', body));
    const setTo = (n) => {
      to = n;
      $('[data-req-to]', body).innerHTML = `${toLabel()}${icon('chev', 'sm')}`;
      ta.placeholder = ph();
    };
    // One chip per agent that has requests (plus the current recipient), most recent conversation first.
    const drawChats = () => {
      const last = new Map();
      for (const q of list) last.set(q.to, Math.max(last.get(q.to) || 0, Date.parse(q.updatedAt || q.at)));
      if (to && !last.has(to)) last.set(to, Infinity);
      if (reqWho && !last.has(reqWho)) last.set(reqWho, Infinity);
      const who = [...last.keys()].sort((a, b) => last.get(b) - last.get(a));
      const open = (n) => list.filter((q) => q.status === 'open' && (!n || q.to === n)).length;
      const chip = (n, inner, tip) => { const k = open(n); return `<button class="req-chat ${reqWho === n ? 'on' : ''}" data-req-who="${esc(n)}" title="${tip}${k ? ` · ${k} open` : ''}">${inner}${k ? `<span class="n">${k}</span>` : ''}</button>`; };
      $('.req-chats', body).innerHTML = chip('', `${icon('send', 'sm')}All`, 'All conversations') + who.map((n) => chip(n, `${avatar({ name: n })}<span class="nm">${esc(nameOf(n))}</span>`, `${esc(nameOf(n))}|Only your conversation with @${esc(n)}`)).join('');
    };
    const msgHTML = (m) => {
      const q = m.q;
      const time = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const quote = m.quote ? `<button class="msg-quote" data-req-jump="${esc(q.id)}" title="Re|Show the request this answers">${icon('chev', 'to')}${esc(String(q.body || '').replace(/\s+/g, ' ').slice(0, 90))}</button>` : '';
      const status = m.ask ? `<span class="msg-st ${q.status}">${q.status === 'done' ? `${icon('check', 'sm')}Done` : 'Open'}</span><button class="msg-act" data-req-toggle="${esc(q.id)}" title="${q.status === 'done' ? 'Reopen|Put this request back on the agent’s list' : 'Mark done|Nothing more needed on this one'}">${icon(q.status === 'done' ? 'restore' : 'check', 'sm')}</button>` : '';
      const stuck = m.ask ? requestStuck(q) : null;
      const meta = m.last || m.ask ? `<div class="msg-meta">${m.ask && !reqWho ? `<span class="to">to ${nameHTML(q.to)}</span>` : ''}<span title="${esc(m.at)}">${time}</span>${status}</div>${stuck ? `<div class="msg-stuck">${esc(stuck)}</div>` : ''}` : '';
      return `<div class="msg ${m.mine ? 'me' : 'them'} ${m.cont ? 'cont' : ''} ${m.ask ? `ask ${q.status}` : ''} ${seen && !seen.has(m.id) ? 'new' : ''}" data-mid="${esc(m.id)}"${m.ask ? ` data-q="${esc(q.id)}"` : ''}>
        ${m.mine ? '' : `<span class="msg-av">${m.cont ? '' : avatar(m.author, 'lg')}</span>`}
        <div class="msg-col">${!m.cont && !m.mine ? `<div class="msg-who">${nameHTML(m.author?.name)}</div>` : ''}${quote}<div class="bubble">${m.body ? `<div class="md">${md(m.body)}</div>` : ''}${commentAtts(m)}</div>${meta}</div></div>`;
    };
    const draw = () => {
      const box = $('.req-thread', body);
      if (!box) return;
      const atEnd = !seen || pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
      drawChats();
      const msgs = reqThread(list, reqWho);
      // one bubble per agent still working on an open request in this conversation
      const think = [...new Set(list.filter((q) => q.status === 'open' && (!reqWho || q.to === reqWho))
        .flatMap((q) => thinkers('requests', q.id, (n, since) => q.replies.some((r) => r.author?.name === n && r.at > since))))];
      let day = '';
      box.innerHTML = msgs.length ? msgs.map((m) => (m.day !== day ? `<div class="msg-day"><span>${esc(dayLabel((day = m.day)))}</span></div>` : '') + msgHTML(m)).join('')
          + think.map((n) => `<div class="msg them thinking" aria-live="polite"><span class="msg-av">${avatar({ kind: 'agent', name: n }, 'lg')}</span><div class="msg-col"><div class="msg-who">${nameHTML(n)}</div><div class="bubble" role="status" aria-label="${esc(nameOf(n))} is writing a reply">${thinkAge(n)}</div></div></div>`).join('')
          + list.filter((q) => !reqWho || q.to === reqWho).flatMap((q) => endedHere('requests', q.id, (q.replies || []).map((r) => ({ who: r.author?.name, at: r.at }))))
            .map((t) => `<div class="msg them cmt-ended muted">${esc(t)}</div>`).join('')
        : `<div class="empty-note">${icon('send')}${reqWho ? `<div>No messages with ${esc(nameOf(reqWho))} yet</div>` : ''}</div>`;
      seen = new Set(msgs.map((m) => m.id));
      if (atEnd) pane.scrollTop = pane.scrollHeight;
    };
    const load = async () => { try { list = await api('GET', B('/requests')); draw(); } catch { /* offline */ } };
    body._reload = load;
    body._redraw = draw;
    const send = async () => {
      const text = ta.value.trim();
      if (!text && !staged.files.length) { ta.focus(); return; }
      if (!to) { toast('Choose an agent first (or set a coordinator on the Agents page)', { kind: 'error' }); return; }
      try {
        await api('POST', B('/requests'), { body: text, to, ...(staged.files.length ? { attachments: await staged.payload() } : {}) });
        staged.clear();
        ta.value = '';
        autosize(ta);
        await load();
        pane.scrollTop = pane.scrollHeight;
      } catch (e) { toast(e.message, { kind: 'error' }); }
    };
    wireTbox($('.req-compose .tbox', body), send);
    body.addEventListener('click', async (e) => {
      const who = e.target.closest('[data-req-who]');
      if (who) {
        reqWho = who.dataset.reqWho;
        if (reqWho) setTo(reqWho);
        seen = null; // a different conversation: land on its newest message, no entrance animation
        draw();
        return;
      }
      const pickTo = e.target.closest('[data-req-to]');
      if (pickTo) {
        // Choosing a recipient opens that conversation (unless you're reading All).
        menu(pickTo, agentChoices().map((n) => ({ label: nameOf(n), avatar: { name: n }, hint: n === state.board.coordinator ? 'coordinator' : '', cls: n === to ? 'on' : '', run: () => { setTo(n); if (reqWho) { reqWho = n; seen = null; draw(); } } })), { search: true });
        return;
      }
      const jump = e.target.closest('[data-req-jump]');
      if (jump) {
        const t = $(`.msg[data-q="${CSS.escape(jump.dataset.reqJump)}"]`, body);
        t?.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
        t?.classList.remove('flash'); void t?.offsetWidth; t?.classList.add('flash');
        return;
      }
      const tg = e.target.closest('[data-req-toggle]');
      if (tg) {
        const q = list.find((x) => x.id === tg.dataset.reqToggle);
        try { await api('POST', B(`/requests/${q.id}/reply`), { done: q.status !== 'done' }); load(); } catch (err) { toast(err.message, { kind: 'error' }); }
      }
    });
    load();
    setTimeout(() => ta.focus(), 250);
  }

  /* ─── the Ask field: the same requests, one keystroke away in the top bar ───
     A quiet field beside the agents button ("Ask recipe-bot…"). Focusing it (click, Tab, or A) unfolds a
     composer over it, with the recipient as a chip and the last few requests as a short thread underneath.
     The field itself reports back: the agent's run dot while it works, an accent dot once it has replied. */
  const ASK_KEY = 'intellagent.ask.v1';
  const askStorage = stored(ASK_KEY, {});
  const askStore = askStorage.get();
  askStore.seen ||= {}; askStore.to ||= {};
  const saveAsk = () => askStorage.save(askStore);
  const ask = { pop: null, to: {}, draft: {}, closing: null };
  const askOpen = () => !!ask.pop?.isConnected && !ask.pop.classList.contains('leaving');
  // Who a new ask goes to: what you picked this session, else the coordinator, else whoever you asked last, else a standing agent.
  const askTo = () => {
    const b = state.boardId;
    return ask.to[b] || state.board?.coordinator || askStore.to[b] || Object.keys(state.standing || {})[0] || '';
  };
  const askReqs = () => (state.board?.requests || []).slice().reverse();
  const agentReplied = (q) => q.replies.filter((r) => r.author?.kind === 'agent');
  const lastAgentReplyAt = () => askReqs().reduce((m, q) => agentReplied(q).reduce((n, r) => (r.at > n ? r.at : n), m), '');
  // Newest open request whose agent hasn't answered since it was asked (or since the human last added to it).
  const askPending = () => askReqs().find((q) => q.status === 'open' && q.replies.at(-1)?.author?.kind !== 'agent');

  function renderAsk() {
    const f = $('#askField');
    if (!f || !state.board) return;
    const to = askTo();
    const pending = askPending();
    const unread = (lastAgentReplyAt() || '') > (askStore.seen[state.boardId] || '') && !askOpen();
    const draft = (ask.draft[state.boardId] || '').trim();
    const lead = pending ? pending.to : to;
    $('#askAv').innerHTML = lead ? avatar({ kind: 'agent', name: lead }) : icon('send');
    const inp = $('#askIn');
    inp.placeholder = draft ? draft.split('\n')[0]
      : unread ? `${(askReqs().find((q) => agentReplied(q).length)?.to) || 'An agent'} replied`
        : pending ? `${pending.to} is on it…`
          : to ? `Ask ${to}…` : 'Ask an agent…';
    f.classList.toggle('draft', !!draft);
    f.classList.toggle('unread', unread);
    f.classList.toggle('pending', !!pending && !unread && !draft);
    $('.ask-dot', f).hidden = !unread;
  }

  async function reloadAsk() {
    try { state.board.requests = (await api('GET', B('/requests'))).reverse(); } catch { return; }
    renderAsk();
    if (askOpen()) { drawAskThread(); markAskSeen(); }
  }
  function markAskSeen() {
    const t = lastAgentReplyAt();
    if (t && t > (askStore.seen[state.boardId] || '')) { askStore.seen[state.boardId] = t; saveAsk(); }
  }

  function wireAskField() {
    const f = $('#askField');
    const inp = $('#askIn');
    // Readonly: the field is a doorway; typing happens in the composer that opens over it.
    inp.addEventListener('focus', () => { if (!ask.suppress) openAsk(); });
    // Focus left on the field after Esc: Enter / Space / ↓ reopen it, and typing carries straight on.
    inp.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); openAsk(); return; }
      if (e.key.length === 1) {
        e.preventDefault();
        ask.draft[state.boardId] = (ask.draft[state.boardId] || '') + e.key;
        openAsk();
      }
    });
    f.addEventListener('pointerdown', (e) => { e.preventDefault(); if (askOpen()) closeAsk(); else openAsk(); });
  }

  function placeAsk() {
    const pop = ask.pop;
    const r = $('#askField').getBoundingClientRect();
    const narrow = innerWidth < 640;
    const w = narrow ? innerWidth - 16 : Math.min(460, innerWidth - 16);
    const left = narrow ? 8 : clamp(r.right - w, 8, innerWidth - w - 8);
    Object.assign(pop.style, { width: `${w}px`, left: `${left}px`, top: `${Math.max(8, r.top - 4)}px` });
  }

  function openAsk() {
    if (!state.board) return;
    if (askOpen()) { $('textarea', ask.pop).focus(); return; }
    if (state.modal) closeModal(true);
    closeMenus();
    ask.pop?.remove();
    const examples = ['Create tickets for…', 'What’s blocked, and why?', 'Summarise what changed today'];
    const pop = el(`<div class="ask-pop" role="dialog" aria-label="Ask an agent">
      ${tboxHTML({ cls: 'ask-box', ph: '', okIcon: 'send', okTitle: 'Send|Enter · Shift+Enter for a new line', hint: '↵ send', tools: '<button class="ask-to" type="button"></button>' })}
      <div class="ask-paused" hidden></div>
      <div class="ask-thread"></div>
      <div class="ask-foot"><button class="ask-all" type="button">All requests${icon('chev', 'sm')}</button><span class="grow"></span><span><kbd>@</kbd> loop someone in</span><span><kbd>Esc</kbd> close</span></div>
    </div>`);
    pop._examples = examples;
    ask.pop = pop;
    document.body.append(pop);
    placeAsk();
    $('#askField').classList.add('open');
    const ta = $('textarea', pop);
    const staged = pasteStage($('.ask-box', pop));
    ta.value = ask.draft[state.boardId] || '';
    autosize(ta);
    const drawTo = () => {
      const to = askTo();
      $('.ask-to', pop).innerHTML = to ? `<span class="muted">To</span>${avatar({ kind: 'agent', name: to })}<b>${nameHTML(to)}</b>${icon('chev', 'sm')}` : `<span class="muted">To</span><b class="ph">Choose an agent</b>${icon('chev', 'sm')}`;
      $('.ask-to', pop).dataset.tip = to === state.board.coordinator ? 'Coordinator|The board’s default agent for asks · click to send to someone else' : 'Recipient|Click to choose another agent';
      ta.placeholder = to ? `Ask ${nameOf(to)} to plan, create tickets, explain…` : 'Ask an agent…';
      // A paused (or failed) standing agent won't answer: say so here, with one click to wake it.
      const sa = to && state.standing?.[to];
      const stuck = sa && (sa.status === 'paused' || sa.status === 'failed');
      const bar = $('.ask-paused', pop);
      bar.hidden = !stuck;
      if (stuck) bar.innerHTML = `${icon('pause', 'sm')}<span><b>${esc(nameOf(to))}</b> is ${sa.status}${sa.queued ? ` · ${sa.queued} waiting` : ''} — it won't answer until resumed</span><button class="btn sm" type="button" data-ask-resume>${icon('play', 'sm')}Resume</button>`;
    };
    pop.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-ask-resume]')) return;
      e.stopPropagation();
      const to = askTo();
      try {
        await api('POST', `/api/agents/${encodeURIComponent(to)}/resume`, {});
        toast(`${nameOf(to)} resumed`, { icon: 'play', kind: 'ok', timeout: 2200 });
        await refreshPresence();
        drawTo();
      } catch (err) { toast(err.message, { kind: 'error' }); }
    });
    const pickTo = () => {
      const btn = $('.ask-to', pop);
      const to = askTo();
      menu(btn, agentChoices().map((n) => ({ label: nameOf(n), avatar: { kind: 'agent', name: n }, hint: n === state.board.coordinator ? 'coordinator' : state.standing?.[n] ? 'standing' : '', cls: n === to ? 'on' : '', run: () => { ask.to[state.boardId] = n; drawTo(); renderAsk(); ta.focus(); } })),
        { search: true, placeholder: 'Find or type a name…', onClose: () => setTimeout(() => { if (askOpen() && !pop.contains(document.activeElement)) ta.focus(); }), creatable: (n) => { ask.to[state.boardId] = n; drawTo(); renderAsk(); ta.focus(); } });
    };
    pop._pickTo = pickTo;
    drawTo();
    drawAskThread();
    const send = async () => {
      const text = ta.value.trim();
      if (!text && !staged.files.length) { ta.focus(); return; }
      const to = askTo();
      if (!to) { pickTo(); return; }
      pop.classList.add('sending');
      try {
        await api('POST', B('/requests'), { body: text, to, ...(staged.files.length ? { attachments: await staged.payload() } : {}) });
        staged.clear();
        ta.value = '';
        ask.draft[state.boardId] = '';
        autosize(ta);
        askStore.to[state.boardId] = to; saveAsk();
        await reloadAsk();
      } catch (e) { toast(e.message, { kind: 'error' }); }
      pop.classList.remove('sending');
      ta.focus();
    };
    wireTbox($('.ask-box', pop), send, { submitOnEnter: true, escape: () => closeAsk(true) });
    ta.addEventListener('input', () => { ask.draft[state.boardId] = ta.value; });
    $('.ask-to', pop).onclick = pickTo;
    $('.ask-all', pop).onclick = () => { closeAsk(); openRequests(); };
    pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAsk(true); } });
    pop.addEventListener('click', (e) => {
      const ex = e.target.closest('[data-example]');
      if (ex) { ta.value = ex.dataset.example.replace(/…$/, ' '); ask.draft[state.boardId] = ta.value; autosize(ta); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); return; }
      if (e.target.closest('a, .avatar')) return;
      if (e.target.closest('[data-req]')) { closeAsk(); openRequests(); }
    });
    const off = (e) => {
      if (!pop.isConnected) { document.removeEventListener('pointerdown', off, true); return; }
      if (pop.contains(e.target) || e.target.closest?.('.menu, .mention-pop, #askField')) return;
      closeAsk();
    };
    setTimeout(() => document.addEventListener('pointerdown', off, true));
    pop._off = off;
    // Tabbing out of the composer folds it back into the field (the draft is kept).
    pop.addEventListener('focusout', (e) => { if (e.relatedTarget && !pop.contains(e.relatedTarget) && !e.relatedTarget.closest('.menu, .mention-pop')) closeAsk(); });
    addEventListener('resize', placeAsk);
    ta.focus();
    markAskSeen();
    renderAsk();
  }

  function closeAsk(refocus = false) {
    const pop = ask.pop;
    if (!pop || pop.classList.contains('leaving')) return;
    document.removeEventListener('pointerdown', pop._off, true);
    removeEventListener('resize', placeAsk);
    closeMenus();
    pop.classList.add('leaving');
    $('#askField')?.classList.remove('open');
    const done = () => { pop.remove(); if (ask.pop === pop) ask.pop = null; renderAsk(); };
    if (reduced() || matchMedia('(prefers-reduced-motion: reduce)').matches) done(); else setTimeout(done, 140);
    if (refocus) { ask.suppress = true; $('#askIn').focus(); ask.suppress = false; }
    else if (pop.contains(document.activeElement)) document.activeElement.blur();
    renderAsk();
  }

  function drawAskThread() {
    const pop = ask.pop;
    if (!pop) return;
    const box = $('.ask-thread', pop);
    const reqs = askReqs().slice(0, 4);
    const seen = pop._seenAt ??= askStore.seen[state.boardId] || '';
    if (!reqs.length) {
      box.innerHTML = `<div class="ask-empty"><span class="muted">Anything that isn’t one ticket — the agent replies here.</span><div class="ask-ex">${pop._examples.map((x) => `<button type="button" data-example="${esc(x)}">${esc(x)}</button>`).join('')}</div></div>`;
      return;
    }
    box.innerHTML = `<div class="ask-sec">Recent</div>${reqs.map((q) => {
      const r = agentReplied(q).at(-1);
      const waiting = q.status === 'open' && q.replies.at(-1)?.author?.kind !== 'agent';
      const fresh = r && r.at > seen;
      return `<div class="ask-item ${q.status} ${fresh ? 'fresh' : ''}" data-req="${esc(q.id)}" title="Open the thread|All replies, and mark it done">
        <div class="ai-q"><span class="ai-body">${q.attachments?.length ? icon('clip', 'sm') : ''}${esc(q.body.split('\n')[0])}</span><span class="ai-meta">${q.status === 'done' ? icon('check', 'sm') : ''}${esc(nameOf(q.to))} · ${rel(q.at)}</span></div>
        ${waiting ? `<div class="ai-r wait">${avatar({ kind: 'agent', name: q.to })}<span>${r ? 'Following up' : 'On it'}<i class="ai-dots"><b></b><b></b><b></b></i></span></div>`
          : r ? `<div class="ai-r">${avatar(r.author)}<div class="md">${md(r.body)}</div></div>` : ''}
      </div>`;
    }).join('')}`;
  }

  function openRules() {
    const body = openDrawer('rulesDrawer', 'Standing rules', 'pin');
    let project = [];
    api('GET', B('/directives')).then((r) => { project = r.projectRules || []; if (!body.querySelector('.tbox')) show(); }, () => {});
    const show = () => {
      const txt = state.board.directives || '';
      const proj = project.map((r) => `<details class="proj-rules"><summary>${icon('text', 'sm')}<b>${esc(r.file)}</b><span>project conventions · read-only</span></summary><div class="md">${md(r.content)}</div></details>`).join('');
      body.innerHTML = `${proj}${proj ? `<div class="section-head" style="margin-top:14px">${icon('pin', 'sm')}<span>Board rules</span><span class="rule"></span></div>` : ''}<div class="md desc-view editable ${txt.trim() ? '' : 'empty'}" data-ph="How agents should use this board…" style="margin:0">${md(txt)}</div>`;
      $('.desc-view', body).onclick = (e) => { if (!e.target.closest('a')) edit(); };
    };
    const edit = () => {
      body.innerHTML = tboxHTML({ mono: true, okTitle: 'Save (Ctrl+Enter)', hint: 'Ctrl+Enter · Esc' });
      const box = $('.tbox', body);
      const save = async () => {
        const v = $('textarea', box).value;
        try { await api('PUT', B('/directives'), { directives: v }); state.board.directives = v; renderHeader(); show(); toast('Rules saved', { kind: 'ok', icon: 'check', timeout: 1600 }); scheduleRefresh(0); }
        catch (e) { toast(e.message, { kind: 'error' }); }
      };
      const ta = wireTbox(box, save, { escape: show });
      ta.style.minHeight = '320px';
      ta.value = state.board.directives || '';
      autosize(ta);
      ta.focus();
    };
    show();
  }

  async function openArchive() {
    const body = openDrawer('archiveDrawer', 'Archive', 'archive');
    body.innerHTML = '<input class="inp" placeholder="Filter" style="margin-bottom:12px"><div class="arch-list"></div>';
    let rows = [];
    try { rows = await api('GET', B('/archive')); } catch (e) { toast(e.message, { kind: 'error' }); }
    const list = $('.arch-list', body);
    const draw = (q = '') => {
      const f = rows.filter((r) => `${r.id} ${r.title} ${r.parent || ''}`.toLowerCase().includes(q.toLowerCase()));
      list.innerHTML = f.length ? f.map((r, i) => `<div class="arch-row" style="animation-delay:${Math.min(i, 12) * 25}ms"><div style="min-width:0;cursor:pointer" data-open="${esc(r.id)}"><div class="t">${icon(r.type, 'sm')}<span>${esc(r.title)}</span></div><div class="s">${esc(r.id)} · ${new Date(r.archivedAt).toLocaleString()} · ${esc(r.archivedBy?.name || '')}</div></div><button class="btn sm" data-restore="${esc(r.id)}" title="Restore">${icon('restore', 'sm')}</button></div>`).join('')
        : `<div class="empty-note">${icon('archive')}</div>`;
    };
    $('input', body).oninput = (e) => draw(e.target.value);
    list.onclick = async (e) => {
      const r = e.target.closest('[data-restore]');
      if (r) {
        try { await api('POST', B(`/archive/${encodeURIComponent(r.dataset.restore)}/restore`), {}); rows = rows.filter((x) => x.id !== r.dataset.restore); draw($('input', body).value); scheduleRefresh(0); toast(`Restored ${r.dataset.restore}`, { icon: 'restore', kind: 'ok' }); }
        catch (err) { toast(err.message, { kind: 'error' }); }
        return;
      }
      const o = e.target.closest('[data-open]');
      if (o) openItem(o.dataset.open);
    };
    draw();
  }

  // With a name (from the awake strip), scrolls to that agent's row and marks it for a moment.
  function openAgents(name) {
    const body = openDrawer('agentsDrawer', 'Agents', 'bot');
    fillAgents(body);
    // the refresh redraws the rows, so the spot goes on after it
    refreshPresence().then(() => {
      const row = name && $$('.agent-row', body).find((r) => r.dataset.agent === name);
      if (row) { row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); row.classList.add('spot'); }
    });
  }
  const RUN_LABEL = { running: 'running', queued: 'queued', retrying: 'retrying', throttled: 'throttled', failed: 'failed — needs you', paused: 'paused', idle: 'idle' };
  // Controls for a standing agent (one the board runs itself, from agents.json).
  const LISTEN_LABEL = { addressed: 'mentions & assignments', inbox: 'everything on its tickets', human: 'everything you do', 'new-tickets': 'new tickets' };
  const listenLabel = (l) => [].concat(l || 'inbox').map((x) => (typeof x === 'string' ? LISTEN_LABEL[x] || x : Object.entries(x).map(([k, v]) => `${k}=${v}`).join(' '))).join(' + ');

  // "mid · sonnet · last run 12.3k in / 800 out · today 41k in / 3.2k out (5 runs)"; n/a when the run reported none
  function usageLine(a) {
    const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
    const pair = (u) => `${k(u.input)} in / ${k(u.output)} out`;
    const last = a.lastRun?.usage;
    const day = a.usageToday;
    const model = a.model ? `${a.tier ? `${esc(a.tier)} · ` : ''}${esc(a.model)}` : 'default model';
    const tip = (u) => (u ? `cache read ${u.cacheRead || 0}, cache written ${u.cacheCreated || 0}` : 'This run reported no token usage');
    return `<div class="standing-usage"><span>${model}</span><span title="${tip(last)}">last run ${last ? pair(last) : 'n/a'}</span><span>today ${day ? `${pair(day)} (${day.runs} run${day.runs === 1 ? '' : 's'})` : 'n/a'}</span></div>`;
  }
  function standingControls(a) {
    const btn = (act, ic, label, tip) => `<button class="btn sm ghost" data-standing="${act}" data-name="${esc(a.name)}" title="${tip}">${icon(ic, 'sm')}<span>${label}</span></button>`;
    return `${usageLine(a)}<div class="standing-ctl">
      <span class="run-state" data-run="${a.status}">${esc(RUN_LABEL[a.status] || a.status)}${a.queued ? ` · ${a.queued} waiting` : ''}</span>
      ${a.status === 'paused' || a.status === 'failed' ? btn('resume', 'play', 'Resume', 'Resume|Clear failures and run any waiting events') : btn('pause', 'pause', 'Pause', 'Pause|The current run finishes; new events wait')}
      ${btn('run', 'sparkle', 'Run now', 'Run now|Start a run with whatever is waiting, or just to check the board')}
      ${btn('edit', 'pencil', 'Edit', 'Edit|Change role, permissions, model, what wakes it and its throttle')}
      ${btn('log', 'terminal', 'Log', 'Last run|Output of the most recent run')}
      ${btn('remove', 'x', 'Remove', 'Remove|Delete this standing agent from agents.json — its tickets and history stay')}</div>`;
  }
  async function standingAction(btn) {
    const { standing: act, name } = btn.dataset;
    if (act === 'log') return showRunLog(name);
    if (act === 'edit') {
      // the same form as Add, filled in; shown in the Agents drawer whichever page the button was on
      const body = openDrawer('agentsDrawer', 'Agents', 'bot');
      body.innerHTML = '<div></div>';
      return addAgentForm(body.firstChild, state.standing[name]);
    }
    if (act === 'remove') {
      if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; $('span', btn).textContent = 'Click to confirm'; setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ''; $('span', btn).textContent = 'Remove'; } }, 3000); return; }
      try { await api('DELETE', `/api/agents/${encodeURIComponent(name)}`); toast(`Removed ${name}`, { icon: 'bot', timeout: 2200 }); refreshPresence(); } catch (e) { toast(e.message, { kind: 'error' }); }
      return;
    }
    try { await api('POST', `/api/agents/${encodeURIComponent(name)}/${act}`, {}); await refreshPresence(); }
    catch (e) { toast(e.message, { kind: 'error' }); }
  }
  async function showRunLog(name) {
    const body = openDrawer('runLogDrawer', `${name} · last run`, 'terminal');
    body.innerHTML = '<pre class="run-log">…</pre>';
    try {
      const r = await api('GET', `/api/agents/${encodeURIComponent(name)}/log`);
      $('.run-log', body).textContent = r.log || 'No runs yet.';
      $('.run-log', body).scrollTop = 1e9;
    } catch (e) { $('.run-log', body).textContent = e.message; }
  }

  // The board's coordinator receives requests (Ask an agent) unless another agent is picked.
  async function setCoordinator(name) {
    try {
      await api('PATCH', B(''), { coordinator: name });
      state.board.coordinator = name;
      toast(name ? `${name} is now the coordinator` : 'No coordinator', { icon: 'send', kind: 'ok', timeout: 2200 });
      if ($('#agentsDrawer')) fillAgents($('#agentsDrawer .drawer-body'));
    } catch (e) { toast(e.message, { kind: 'error' }); }
  }

  /* ─── add a standing agent: name + role + permissions (never a raw command) ─── */
  let rolesCache = null;
  async function addAgentForm(host, edit = null) {
    rolesCache ||= await api('GET', '/api/agents/roles');
    const { roles, perms } = rolesCache;
    let role = edit?.role && roles[edit.role] ? edit.role : 'builder';
    let chosen = new Set(edit?.perms || roles[role].perms);
    // what wakes it: one simple choice; an array or filter written in agents.json is left as it is
    const LISTENS = [['', 'Role default'], ...Object.entries(LISTEN_LABEL)];
    const listenNow = typeof edit?.listen === 'string' ? edit.listen : '';
    const customListen = edit?.listen != null && typeof edit.listen !== 'string';
    const modelNow = edit?.model || '';
    const f = el(`<div class="add-agent">
      <div class="aa-row"><input class="inp" data-aa-name placeholder="Name, e.g. builder" spellcheck="false" maxlength="64"${edit ? ` value="${esc(edit.name)}" readonly` : ''}></div>
      <div class="aa-label">Role</div>
      <div class="aa-roles">${Object.entries(roles).map(([k, v]) => `<button class="aa-role" data-role="${k}">${icon(v.icon || 'bot')}<b>${esc(v.label)}</b><span>${esc(v.description)}</span></button>`).join('')}</div>
      <div class="aa-label">Allowed to</div>
      <div class="aa-perms">${Object.entries(perms).map(([k, label]) => `<button class="toggle-chip" data-perm="${k}">${esc(label)}</button>`).join('')}<span class="aa-note">plus the board itself, always</span></div>
      <div class="aa-label">Model</div>
      <div class="aa-perms aa-models">${[['', 'Default'], ['haiku', 'Haiku · junior'], ['sonnet', 'Sonnet · mid'], ['opus', 'Opus · senior']].map(([k, l]) => `<button class="toggle-chip ${k === modelNow ? 'on' : ''}" data-model="${k}">${l}</button>`).join('')}<span class="aa-note">the receptionist routes small tickets to juniors, risky ones to seniors</span></div>
      <div class="aa-label">Wakes on</div>
      <div class="aa-perms aa-listens">${LISTENS.map(([k, l]) => `<button class="toggle-chip ${!customListen && k === listenNow ? 'on' : ''}" data-listen="${k}">${esc(l)}</button>`).join('')}${customListen ? `<span class="aa-note">custom in agents.json: ${esc(listenLabel(edit.listen))} (kept unless you pick one)</span>` : ''}</div>
      <div class="aa-label">Throttle</div>
      <div class="aa-row"><input class="inp" type="number" min="0" step="1" data-aa-throttle placeholder="role default" value="${edit?.throttleMinutes ?? ''}" style="max-width:9em"><span class="aa-note">minutes events wait to arrive together in one run (0 = wake at once)</span></div>
      <div class="aa-label">Runs per hour</div>
      <div class="aa-row"><input class="inp" type="number" min="1" step="1" data-aa-maxruns placeholder="${edit?.maxRunsPerHour === null ? 'no limit' : 'default 20'}" value="${edit?.maxRunsPerHour ?? ''}" style="max-width:9em"><label class="aa-check"><input type="checkbox" data-aa-nolimit ${edit && edit.maxRunsPerHour === null ? 'checked' : ''}> no limit</label><span class="aa-note">a ceiling on cost if something keeps waking it</span></div>
      <label class="aa-check"><input type="checkbox" data-aa-keepalive ${edit?.keepAlive ? 'checked' : ''}> <span><b>Keep alive</b> — one live session between wakes (cheaper per wake; recycled now and then)</span></label>
      <div class="aa-label">Board access</div>
      <div class="aa-perms aa-cols">${(state.board?.columns || []).map((c) => `<button class="toggle-chip ${(edit?.limits?.columns || []).map((x) => String(x).toLowerCase()).includes(c.name.toLowerCase()) ? 'on' : ''}" data-col="${esc(c.name)}">${esc(c.name)}</button>`).join('')}<span class="aa-note">columns it may change — none picked: all of them</span></div>
      <label class="aa-check"><input type="checkbox" data-aa-readonly ${edit?.limits?.readOnly ? 'checked' : ''}> <span><b>Read-only</b> — may comment and ask, never change tickets</span></label>
      <div class="aa-label">Grants <span class="aa-note">powers that skip your approval</span></div>
      <div class="aa-grants"><div class="aa-note">Checking…</div></div>
      <div class="aa-label">Description</div>
      <textarea class="inp aa-desc" rows="2" data-aa-desc></textarea>
      <label class="aa-coord" hidden><input type="checkbox" data-aa-coord checked> Make it this board's coordinator (requests go to it)</label>
      <div class="aa-foot"><span class="aa-hint">It runs headless Claude Code when something is for it — needs <code>claude</code> installed and signed in.</span><span class="grow"></span><button class="btn ghost sm" data-aa-cancel>Cancel</button><button class="btn primary sm" data-aa-add>${edit ? icon('check', 'sm') : icon('plus', 'sm')}${edit ? 'Save changes' : 'Add agent'}</button></div>
    </div>`);
    host.replaceWith(f);
    // Grants: editable only by the signed-in human on a board with a sign-in token
    const GRANTS = [
      ['review.decide', 'Decide reviews', 'approve or send back tickets for you', 'column=Review; fields.risk=low'],
      ['column.gate', 'Move through Done', 'move tickets into and out of approval columns', 'fields.risk=low'],
      ['agents.control', 'Control agents', 'pause, resume and run other agents', ''],
      ['agents.manage', 'Manage agents', "change other agents' label, model, speciality, narrow their access", 'agents=junior,mid'],
    ];
    const scopeText = (w) => Object.entries(w || {}).map(([k, v]) => `${k}=${[].concat(v).join(',')}`).join('; ');
    // "fields.risk=low; column=Review". A part that doesn't parse is an error, never skipped: skipping it
    // could save the grant with no scope at all, i.e. everywhere.
    const parseScope = (t) => {
      const w = {};
      for (const part of String(t || '').split(';')) {
        if (!part.trim()) continue;
        const [k, ...rest] = part.split('=');
        const v = rest.join('=').trim();
        if (!k.trim() || !v) throw new Error(`Scope "${part.trim()}" needs the form key=value (e.g. fields.risk=low)`);
        const vs = v.split(',').map((x) => x.trim()).filter(Boolean);
        if (!vs.length) throw new Error(`Scope "${part.trim()}" has no value`);
        w[k.trim()] = vs.length > 1 ? vs : vs[0];
      }
      return Object.keys(w).length ? w : null;
    };
    let grantsEditable = false;
    const drawGrants = (ok) => {
      grantsEditable = ok;
      const have = Object.fromEntries((edit?.grants || []).map((g) => (typeof g === 'string' ? [g, {}] : [g.power, g.where || {}])));
      $('.aa-grants', f).innerHTML = (ok ? '' : `<div class="aa-lock">${icon('lock', 'sm')}<span>Locked: grants can be set here only on a board with a sign-in token. Run <code>intellagent token</code>, restart the board and sign in with <code>intellagent open</code> — or edit agents.json.</span></div>`)
        + GRANTS.map(([k, label, help, eg]) => `<div class="aa-grant ${ok ? '' : 'locked'}"><label class="aa-check"><input type="checkbox" data-grant="${k}" ${k in have ? 'checked' : ''} ${ok ? '' : 'disabled'}> <span><b>${esc(label)}</b> — ${esc(help)}</span></label><input class="inp" data-grant-where="${k}" placeholder="${eg ? `only where… e.g. ${esc(eg)}` : 'only where… (optional)'}" value="${esc(scopeText(have[k]))}" ${ok ? '' : 'disabled'}></div>`).join('');
    };
    api('GET', '/api/permissions/me').then((p) => drawGrants(!!p.boardHasUserToken), () => drawGrants(false));
    const paint = () => {
      $$('.aa-role', f).forEach((b) => b.classList.toggle('on', b.dataset.role === role));
      $$('[data-perm]', f).forEach((b) => b.classList.toggle('on', chosen.has(b.dataset.perm)));
      $('.aa-coord', f).hidden = role !== 'coordinator';
    };
    const pickRole = (k) => {
      const desc = $('[data-aa-desc]', f);
      if (!desc.value || desc.value === roles[role].description) desc.value = roles[k].description;
      role = k;
      chosen = new Set(roles[k].perms);
      const name = $('[data-aa-name]', f);
      if (!edit && (!name.value || Object.keys(roles).includes(name.value))) name.value = k;
      paint();
    };
    if (edit) {
      $('[data-aa-desc]', f).value = edit.description || '';
      paint();
    } else pickRole('builder');
    f.addEventListener('click', async (e) => {
      const rb = e.target.closest('[data-role]');
      if (rb) { pickRole(rb.dataset.role); return; }
      const mb = e.target.closest('[data-model]');
      if (mb) { $$('[data-model]', f).forEach((b) => b.classList.toggle('on', b === mb)); return; }
      const lb = e.target.closest('[data-listen]');
      if (lb) { $$('[data-listen]', f).forEach((b) => b.classList.toggle('on', b === lb)); return; }
      const cb = e.target.closest('[data-col]');
      if (cb) { cb.classList.toggle('on'); return; }
      const pb = e.target.closest('[data-perm]');
      if (pb) { if (chosen.has(pb.dataset.perm)) chosen.delete(pb.dataset.perm); else chosen.add(pb.dataset.perm); paint(); return; }
      if (e.target.closest('[data-aa-cancel]')) { fillAgents($('#agentsDrawer .drawer-body')); return; }
      if (e.target.closest('[data-aa-add]')) {
        const name = $('[data-aa-name]', f).value.trim();
        try {
          const listen = $('[data-listen].on', f)?.dataset.listen || undefined; // blank: leave as it is / role default
          const throttle = $('[data-aa-throttle]', f).value.trim();
          const coord = !edit && role === 'coordinator' && $('[data-aa-coord]', f).checked;
          await api('POST', `/api/agents?board=${encodeURIComponent(state.boardId)}`, {
            name, role, perms: [...chosen], model: $('[data-model].on', f)?.dataset.model || null, description: $('[data-aa-desc]', f).value.trim(),
            ...(listen ? { listen } : {}), ...(throttle !== '' ? { throttleMinutes: Number(throttle) } : edit ? { throttleMinutes: null } : {}), coordinator: coord,
            ...(() => {
              const max = $('[data-aa-maxruns]', f).value.trim();
              return $('[data-aa-nolimit]', f).checked ? { maxRunsPerHour: null } : max !== '' ? { maxRunsPerHour: Number(max) } : {};
            })(),
            // only what you changed: untouched settings keep coming from the board defaults
            ...($('[data-aa-keepalive]', f).checked !== !!edit?.keepAlive ? { keepAlive: $('[data-aa-keepalive]', f).checked } : {}),
            ...(() => {
              const lim = { columns: $$('[data-col].on', f).map((b) => b.dataset.col), readOnly: $('[data-aa-readonly]', f).checked };
              const was = { columns: (edit?.limits?.columns || []).map(String), readOnly: !!edit?.limits?.readOnly };
              return JSON.stringify(lim) !== JSON.stringify(was) ? { limits: lim } : {};
            })(),
            ...(grantsEditable ? { grants: $$('[data-grant]', f).filter((c) => c.checked).map((c) => { const where = parseScope($(`[data-grant-where="${c.dataset.grant}"]`, f).value); return where ? { power: c.dataset.grant, where } : c.dataset.grant; }) } : {}),
          });
          if (coord) state.board.coordinator = name;
          toast(edit ? `Saved ${name}` : `${name} is on call`, { icon: 'bot', kind: 'ok', timeout: 2500 });
          await refreshPresence();
          if ($('#agentsDrawer')) fillAgents($('#agentsDrawer .drawer-body'));
        } catch (err) { toast(err.message, { kind: 'error' }); }
      }
    });
    setTimeout(() => $('[data-aa-name]', f).select(), 50);
  }

  // "Approves for you": who may approve on the human's behalf and when, in plain words, with the one switch
  // that stops all of it (the board enforces it: approval grants are suspended while it is off).
  const scopeWords = (where) => (!where ? 'any review' : Object.entries(where).map(([k, v]) => {
    const vs = [].concat(v).join(' or ');
    const rv = /^reviewers\.(.+)$/.exec(k);
    return rv ? `${nameOf(rv[1])} says ${vs}` : k === 'column' ? `it's in ${vs}` : `${k.replace(/^(fields|properties)\./, '')} is ${vs}`;
  }).join(' and '));
  async function fillApprovals(el) {
    if (!el || !state.board) return;
    let v;
    try { v = await api('GET', `/api/boards/${state.board.id}/approvals`); } catch { el.innerHTML = ''; return; }
    if (!v.approvers.length) { el.innerHTML = ''; return; }
    const who = v.approvers.map((a) => {
      const when = (power) => a.grants.filter((g) => g.power === power).map((g) => scopeWords(g.where));
      const parts = [];
      if (when('review.decide').length) parts.push(`approves when ${when('review.decide').join(', or when ')}`);
      if (when('column.gate').length) parts.push(`moves work past your gates when ${when('column.gate').join(', or when ')}`);
      return `<div class="appr-who">${avatar({ kind: 'agent', name: a.name })}<b>${esc(nameOf(a.name))}</b><span>${esc(parts.join('; '))}${a.status === 'paused' ? ' · paused' : ''}${a.standing === false ? ' · not a standing agent (granted in the manifest)' : ''}</span></div>`;
    }).join('');
    el.innerHTML = `<div class="cr-label"><span>Approves for you</span><span class="sr-auto">${v.on ? 'On: these agents may approve on your behalf' : 'Off: every approval waits for you'}</span></div>
      <button class="switch ${v.on ? 'on' : ''}" data-appr-toggle title="${v.on ? 'Stop all approvals|Suspend every approval grant on this board until you switch it back on' : 'Allow approvals|Let these agents approve on your behalf again'}"></button>
      <div class="appr-list ${v.on ? '' : 'off'}">${who}</div>`;
    $('[data-appr-toggle]', el).onclick = async () => {
      try {
        await api('PUT', `/api/boards/${state.board.id}/approvals`, { on: !v.on });
        toast(v.on ? 'Approvals stopped: everything waits for you' : 'Approvals on', { icon: v.on ? 'x' : 'check', kind: v.on ? '' : 'ok', timeout: 2500 });
        fillApprovals(el);
      } catch (e) { toast(e.message, { kind: 'error' }); }
    };
  }
  function fillAgents(body) {
    const seen = new Set(state.presence.map((p) => p.name));
    const rows = [...Object.keys(state.standing).filter((n) => !seen.has(n)).map((name) => ({ name, connections: {}, leases: [], subscriptions: [], online: false })), ...state.presence]
      .sort((a, b) => Number(!!state.standing[b.name]) - Number(!!state.standing[a.name]));
    const coord = state.board?.coordinator || null;
    const coordRow = `<div class="coord-row"><div class="cr-label"><span>Coordinator</span><span class="sr-auto">gets “Ask an agent” requests by default</span></div><button class="dd" data-coord>${coord ? `${avatar({ name: coord })}${nameHTML(coord)}` : '<span class="v ph">None</span>'}${icon('chev', 'sm')}</button></div>`;
    const addBtn = '<button class="add-agent-btn" data-add-agent>＋ Add standing agent</button>';
    // One control to halt everything; once everyone is paused it offers to bring them back.
    const sa = Object.values(state.standing || {});
    const allPaused = sa.length && sa.every((a) => a.status === 'paused');
    const stopRow = sa.length || state.presence.some((p) => p.leases?.length) ? `<div class="stop-row">${allPaused
      ? `<button class="btn sm" data-resume-all title="Resume all|Unpause every standing agent; their queued events run">${icon('play', 'sm')}Resume all agents</button>`
      : `<button class="btn sm danger" data-stop-all title="Stop all agents|Kill every run, pause every standing agent, release agent leases and send their In Progress tickets back to Ready">${icon('pause', 'sm')}Stop all agents</button>`}</div>` : '';
    body.innerHTML = stopRow + '<div class="appr-row" data-appr></div>' + coordRow + addBtn + (rows.length ? rows.map((p, i) => {
      const sa = state.standing[p.name];
      const mode = sa?.status === 'running' ? 'running now' : p.connections.stream ? 'stream' : p.connections.waiting ? 'polling' : p.online ? 'active' : sa ? 'standing by' : 'offline';
      const leases = p.leases.map((l) => `<span class="mini-chip link" data-board="${esc(l.board)}" data-open="${esc(l.id)}" title="${esc(l.title)}">${icon('clock', 'sm')}${esc(l.id)}</span>`).join('');
      const subs = p.subscriptions.map((s) => `<span class="mini-chip" title="${esc(JSON.stringify(s.filter))}">${icon('bell', 'sm')}${esc(s.label || Object.entries(s.filter).map(([k, v]) => `${k}=${v}`).join(' ') || 'all')}</span>`).join('');
      return `<div class="agent-row ${p.online || sa ? '' : 'off'}" data-agent="${esc(p.name)}" style="animation-delay:${i * 40}ms">${avatar({ kind: 'agent', name: p.name }, 'lg')}
        <div style="min-width:0"><div class="nm"><span class="status-dot ${p.online ? 'on' : ''}"></span>${esc(nameOf(p.name))}${nameOf(p.name) !== p.name ? `<span class="nm-id">@${esc(p.name)}</span>` : ''}${p.name === coord ? '<span class="chip coord-chip" title="Coordinator|Requests from the Ask field go to this agent unless you pick another">takes requests</span>' : ''}${!p.online && !sa && !p.leases.length ? `<button class="forget" data-forget="${esc(p.name)}" title="Forget|Remove from this list — it reappears if it connects again">${icon('x', 'sm')}Forget</button>` : ''}</div><div class="sub" title="${esc(p.lastAction || '')}">${mode} · ${p.lastSeen ? rel(p.lastSeen) : '—'}${p.lastAction ? ` · ${esc(p.lastAction)}` : ''}</div></div>
        ${leases || subs ? `<div class="extra">${leases}${subs}</div>` : ''}${sa ? standingControls(sa) : ''}${p.name !== coord ? `<button class="make-coord" data-make-coord="${esc(p.name)}" title="Make coordinator|Requests go to this agent by default">${icon('send', 'sm')}Make coordinator</button>` : ''}</div>`;
    }).join('') : `<div class="empty-note">${icon('bot')}</div>`);
    fillApprovals($('[data-appr]', body));
    body.onclick = async (e) => {
      const co = e.target.closest('[data-coord]');
      if (co) {
        e.stopPropagation();
        menu(co, [{ label: 'None', icon: 'x', run: () => setCoordinator(null) }, ...agentChoices().map((n) => ({ label: nameOf(n), avatar: { name: n }, cls: n === coord ? 'on' : '', run: () => setCoordinator(n) }))], { search: true });
        return;
      }
      const aa = e.target.closest('[data-add-agent]');
      if (aa) { e.stopPropagation(); addAgentForm(aa); return; }
      const stop = e.target.closest('[data-stop-all]');
      if (stop) {
        e.stopPropagation();
        if (!stop.classList.contains('armed')) { stop.classList.add('armed'); stop.lastChild.textContent = 'Click again to stop everything'; setTimeout(() => { if (stop.isConnected) { stop.classList.remove('armed'); stop.lastChild.textContent = 'Stop all agents'; } }, 3500); return; }
        try {
          const r = await api('POST', '/api/agents/stop-all', {});
          toast(`Stopped ${r.stopped.length ? r.stopped.join(', ') : 'all agents'}${r.moved.length ? ` · ${r.moved.length} ticket${r.moved.length > 1 ? 's' : ''} back to Ready` : ''}`, { icon: 'pause', kind: 'ok' });
          await refreshPresence();
          scheduleRefresh(0);
          fillAgents(body);
        } catch (err) { toast(err.message, { kind: 'error' }); }
        return;
      }
      if (e.target.closest('[data-resume-all]')) {
        e.stopPropagation();
        try { await api('POST', '/api/agents/resume-all', {}); toast('All agents resumed', { icon: 'play', kind: 'ok' }); await refreshPresence(); fillAgents(body); } catch (err) { toast(err.message, { kind: 'error' }); }
        return;
      }
      if (e.target.closest('.add-agent')) return;
      const mk = e.target.closest('[data-make-coord]');
      if (mk) { e.stopPropagation(); setCoordinator(mk.dataset.makeCoord); return; }
      const sb = e.target.closest('[data-standing]');
      if (sb) { e.stopPropagation(); standingAction(sb); return; }
      const fg = e.target.closest('[data-forget]');
      if (fg) {
        e.stopPropagation();
        const row = fg.closest('.agent-row');
        try {
          await api('DELETE', `/api/presence/${encodeURIComponent(fg.dataset.forget)}`);
          row.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '12px 0' }], { duration: 220, easing: 'ease-in', fill: 'forwards' }).onfinish = () => refreshPresence();
        } catch (err) { toast(err.message, { kind: 'error' }); }
        return;
      }
      const o = e.target.closest('[data-open]');
      if (!o) { const a = e.target.closest('[data-agent]'); if (a && !e.target.closest('.avatar')) openAgent(a.dataset.agent); return; }
      if (o.dataset.board !== state.boardId) await loadBoard(o.dataset.board);
      openItem(o.dataset.open);
    };
  }

  function toast(msg, { kind = '', icon: ic = null, actor = null, action = null, onAction = null, onClick = null, timeout = 3800, wrap = false } = {}) {
    const lead = actor ? avatar(actor) : ic ? icon(ic) : kind === 'error' ? icon('x') : kind === 'needs' ? icon('ask') : icon('sparkle');
    const t = el(`<div class="toast ${kind === 'needs' ? '' : kind} ${onClick ? 'click' : ''} ${wrap ? 'wrap' : ''}" ${kind === 'needs' ? 'style="--tc:var(--accent-2)"' : ''}>${lead}<span class="msg"></span>${action ? `<button>${esc(action)}</button>` : ''}<i class="bar" style="animation-duration:${timeout}ms"></i></div>`);
    $('.msg', t).textContent = msg;
    const host = $('#toasts');
    host.append(t);
    while (host.children.length > 4) host.firstChild.remove();
    const kill = () => { t.classList.add('out'); setTimeout(() => t.remove(), 250); };
    if (action) $('button', t).onclick = (e) => { e.stopPropagation(); onAction?.(); kill(); };
    if (onClick) t.onclick = () => { onClick(); kill(); };
    let timer = setTimeout(kill, timeout);
    t.onmouseenter = () => clearTimeout(timer);
    t.onmouseleave = () => { timer = setTimeout(kill, 1500); };
  }

  /* ═════════════════════════ token prompt ═════════════════════════ */

  let tokenPrompt = null;
  function promptToken() {
    if (tokenPrompt) return tokenPrompt;
    tokenPrompt = new Promise((resolve) => {
      const root = el(`<div class="scrim" style="z-index:700"><div class="modal token-modal pop">${icon('lock', 'big')}<div style="font:700 16px var(--display)">${esc(state.app.name)}</div>
        <div class="row2"><input class="inp" type="password" placeholder="Access token" autocomplete="off"><button class="btn primary">${icon('check')}</button></div>
        <div class="token-hint">Run <code>intellagent open</code> in the project to sign in, or paste <code>userToken</code> from <code>.intellagent/local.json</code></div></div></div>`);
      document.body.append(root);
      syncScrimmed();
      const inp = $('input', root);
      const done = () => {
        const v = inp.value.trim();
        if (!v) { inp.focus(); return; }
        AUTH.token = v;
        tokenStore.save(v);
        root.remove();
        syncScrimmed();
        tokenPrompt = null;
        reconnect();
        resolve(true);
      };
      $('button', root).onclick = done;
      inp.onkeydown = (e) => { if (e.key === 'Enter') done(); };
      setTimeout(() => inp.focus(), 50);
    });
    return tokenPrompt;
  }

  /* ═════════════════════════ listeners ═════════════════════════ */

  let listenTimer = null;
  function scheduleListeners() { clearTimeout(listenTimer); listenTimer = setTimeout(refreshListeners, 300); }
  async function refreshListeners() {
    if (!state.boardId) return;
    try {
      const l = await api('GET', B('/listeners'));
      const sig = JSON.stringify(l);
      if (sig !== state.listenersSig) { state.listeners = l; state.listenersSig = sig; render(); }
    } catch { /* offline */ }
  }

  /* ═════════════════════════ while you were away ═════════════════════════ */

  const SEEN_KEY = 'intellagent.seen.v1';
  const seenStorage = stored(SEEN_KEY, {});
  const seen = seenStorage.get();
  function saveSeen() { seenStorage.save(seen); }
  const seenFor = (b) => (seen[b] ||= { seq: null, items: {} });
  const catchupDone = new Set();
  const newsworthy = (ev) => !!ev.itemId && !QUIET.has(ev.type) && ev.type !== 'lease.warning' && !(ev.actor?.kind === 'user' && ev.actor.name === settings.userName);

  function noteUnseen(ev) {
    const list = (seenFor(ev.board).items[ev.itemId] ||= []);
    if (list.some((x) => x.seq === ev.seq)) return;
    list.push({ seq: ev.seq, ts: ev.ts, actor: ev.actor, text: describe(ev) });
    if (list.length > 12) list.shift();
  }
  async function catchUp(b) {
    const s = seenFor(b);
    if (s.seq == null) { s.seq = state.seq; saveSeen(); return; }
    if (s.seq < state.seq) {
      try {
        const r = await api('GET', `/api/events?since=${s.seq}&board=${encodeURIComponent(b)}&limit=1000`);
        for (const ev of r.events) if (newsworthy(ev)) noteUnseen(ev);
      } catch { return; }
      s.seq = state.seq;
      saveSeen();
    }
    render();
    renderCatch();
    const n = Object.keys(s.items).filter((id) => state.board.items[id]).length;
    if (n) toast(`${n} ticket${n > 1 ? 's' : ''} changed while you were away`, { icon: 'sparkle', action: 'Show', onAction: openCatchup, timeout: 6000 });
  }
  function clearUnseen(id) {
    if (!state.boardId) return;
    const s = seenFor(state.boardId);
    if (!s.items[id]) return;
    delete s.items[id];
    saveSeen();
    updateCard(cardEls.get(id), state.board.items[id]);
    renderCatch();
    if ($('#catchDrawer')) drawCatch($('#catchDrawer .drawer-body'));
  }
  function renderCatch() {
    const btn = $('#catchBtn');
    if (!btn || !state.board) return;
    const n = Object.keys(seenFor(state.boardId).items).filter((id) => state.board.items[id]).length;
    btn.hidden = !n;
    $('#catchCount').textContent = n;
  }
  function drawCatch(body) {
    const s = seenFor(state.boardId);
    const ids = Object.keys(s.items).filter((id) => state.board.items[id]);
    body.innerHTML = ids.length
      ? `<div class="feed-head"><span class="grow"></span><button class="btn sm" data-allseen>${icon('check', 'sm')}Mark all seen</button></div>${ids.map((id, i) => {
        const it = state.board.items[id];
        return `<div class="catch-item" data-open="${esc(id)}" style="animation-delay:${Math.min(i, 12) * 30}ms"><div class="t">${icon(it.type, 'sm')}<span style="font:11px var(--mono);color:var(--muted)">${esc(id)}</span>${esc(it.title)}</div>
          ${s.items[id].slice(-5).reverse().map((e) => `<div class="ev">${avatar(e.actor)}<span>${esc(e.text)}</span><time>${rel(e.ts)}</time></div>`).join('')}</div>`;
      }).join('')}`
      : `<div class="empty-note">${icon('check')}</div>`;
  }
  function openCatchup() {
    const body = openDrawer('catchDrawer', 'While you were away', 'sparkle');
    drawCatch(body);
    body.onclick = (e) => {
      if (e.target.closest('[data-allseen]')) { seenFor(state.boardId).items = {}; saveSeen(); render(); renderCatch(); drawCatch(body); return; }
      const o = e.target.closest('[data-open]');
      if (o && !e.target.closest('.avatar')) openItem(o.dataset.open, cardEls.get(o.dataset.open));
    };
  }

  /* ═════════════════════════ inbox ═════════════════════════ */

  const INBOX_KEY = 'intellagent.inbox.v1';
  const inboxStorage = stored(INBOX_KEY, { seq: 0, ids: [] });
  const inboxRead = inboxStorage.get();
  function saveInbox() { inboxStorage.save(inboxRead); }
  const myName = () => (settings.userName || 'You').toLowerCase();
  const forMe = (ev) => ev.actor?.name?.toLowerCase() !== myName() && !QUIET.has(ev.type)
    && ((ev.recipients || []).some((r) => r.toLowerCase() === myName()) || ev.type === 'attention.raised');
  const isUnread = (ev) => ev.seq > inboxRead.seq && !inboxRead.ids.includes(ev.seq);

  async function refreshInbox() {
    const n = encodeURIComponent(settings.userName || 'You');
    try {
      const [a, b] = await Promise.all([
        api('GET', `/api/events?since=0&limit=400&tail=true&for=${n}`),
        api('GET', '/api/events?since=0&limit=200&tail=true&types=attention.raised'),
      ]);
      const map = new Map();
      for (const ev of [...a.events, ...b.events]) if (forMe(ev)) map.set(ev.seq, ev);
      state.inbox = [...map.values()].sort((x, y) => y.seq - x.seq).slice(0, 200);
    } catch { return; }
    renderInboxBtn();
  }
  function renderInboxBtn() {
    const badge = $('#hubBtn .badge');
    if (!badge) return;
    const n = state.inbox.filter(isUnread).length;
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : n;
    renderPresenceButton();
    if ($('#inboxDrawer')) drawInbox($('#inboxDrawer .drawer-body'));
  }
  function markRead(seq) { if (!inboxRead.ids.includes(seq)) { inboxRead.ids.push(seq); inboxRead.ids = inboxRead.ids.slice(-500); saveInbox(); } }
  function markInboxItemRead(id) {
    const hits = state.inbox.filter((ev) => ev.itemId === id && isUnread(ev));
    if (!hits.length) return;
    hits.forEach((ev) => markRead(ev.seq));
    renderInboxBtn();
  }
  function drawInbox(body) {
    const unread = state.inbox.filter(isUnread).length;
    body.innerHTML = `<div class="feed-head"><span class="grow"></span>${unread ? `<button class="btn sm" data-allread>${icon('check', 'sm')}Mark all read</button>` : ''}</div>`
      + (state.inbox.length ? state.inbox.map((ev, i) => `<div class="feed-row ${isUnread(ev) ? 'unread' : ''}" data-seq="${ev.seq}" data-board="${esc(ev.board || '')}" data-item="${esc(ev.itemId || '')}" style="animation-delay:${Math.min(i, 15) * 20}ms">
          <span class="dot"></span>${avatar(ev.actor)}<div>${describe(ev, true)}${ev.board && ev.board !== state.boardId ? `<span class="brd">${esc(ev.board)}</span>` : ''}</div><time>${rel(ev.ts)}</time></div>`).join('')
        : `<div class="empty-note">${icon('bell')}</div>`);
  }
  function openInbox() {
    const body = openDrawer('inboxDrawer', 'Inbox', 'bell');
    drawInbox(body);
    body.onclick = async (e) => {
      if (e.target.closest('[data-allread]')) { inboxRead.seq = Math.max(inboxRead.seq, ...state.inbox.map((x) => x.seq)); inboxRead.ids = []; saveInbox(); renderInboxBtn(); return; }
      if (e.target.closest('.avatar')) return;
      const row = e.target.closest('[data-seq]');
      if (!row) return;
      markRead(Number(row.dataset.seq));
      renderInboxBtn();
      if (!row.dataset.item) return;
      if (row.dataset.board && row.dataset.board !== state.boardId) await loadBoard(row.dataset.board);
      openItem(row.dataset.item, cardEls.get(row.dataset.item));
    };
  }

  /* ═════════════════════════ digest ═════════════════════════ */

  const DIGEST_KEY = 'intellagent.digest.v1';
  const digestStorage = stored(DIGEST_KEY, {});
  const digestSeen = digestStorage.get();
  function markDigestSeen() {
    digestSeen[state.boardId] = state.board.digest?.[state.board.digest.length - 1]?.ts || '';
    digestStorage.save(digestSeen);
    renderHeader();
  }
  function dayLabel(d) {
    const today = new Date(nowMs()).toLocaleDateString('en-CA');
    const yday = new Date(nowMs() - 86400000).toLocaleDateString('en-CA');
    if (d === today) return 'Today';
    if (d === yday) return 'Yesterday';
    return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }
  function openDigest() {
    const body = openDrawer('digestDrawer', 'Digest', 'news');
    const post = async () => {
      const ta = $('.digest-compose textarea', body);
      const v = ta.value.trim();
      if (!v) { ta.focus(); return; }
      try { await api('POST', B('/digest'), { summary: v }); ta.value = ''; await loadBoard(state.boardId); draw(); markDigestSeen(); }
      catch (e) { toast(e.message, { kind: 'error' }); }
    };
    const draw = () => {
      const byDay = new Map();
      for (const e of (state.board.digest || []).slice().reverse()) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e); }
      body.innerHTML = `<div class="digest-compose">${tboxHTML({ ph: 'Add a note…', okIcon: 'send', okTitle: 'Post (Ctrl+Enter)' })}</div>${[...byDay].map(([d, list]) => `<div class="dg-day"><div class="section-head"><span>${esc(dayLabel(d))}</span><span class="rule"></span></div>
        ${list.map((e) => `<div class="dg-entry">${avatar(e.author, 'lg')}<div style="min-width:0"><div class="cmt-head"><b>${nameHTML(e.author?.name)}</b><span>${new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>${(e.items || []).map((id) => `<span class="mini-chip link" data-open="${esc(id)}">${esc(id)}</span>`).join('')}</div><div class="md">${md(e.summary)}</div></div></div>`).join('')}</div>`).join('') || `<div class="empty-note">${icon('news')}</div>`}`;
      wireTbox($('.tbox', body), post);
    };
    body._redraw = draw;
    body.onclick = (e) => { const o = e.target.closest('[data-open]'); if (o && !e.target.closest('.avatar')) openItem(o.dataset.open, cardEls.get(o.dataset.open)); };
    draw();
    markDigestSeen();
  }

  /* ═════════════════════════ agent profile ═════════════════════════ */

  function standingSection(a) {
    const l = a.lastRun;
    const listen = listenLabel(a.listen);
    const why = l?.why ? ` for ${esc(l.why.replace('work.pending', 'work waiting on the board'))}` : '';
    const live = a.keepAlive ? (a.session ? `session alive · turn ${a.session.turns}/${a.session.recycleAfter}${a.session.context != null ? ` · context ${Math.round(a.session.context / 1000)}k${a.session.recycleAboveTokens ? `/${Math.round(a.session.recycleAboveTokens / 1000)}k` : ''}` : ''} · ` : 'keep-alive (starts on next wake) · ') : '';
    const meta = `${live}${a.model ? `runs on <b>${esc(a.model)}</b>${a.tier ? ` (${a.tier})` : ''} · ` : ''}can ${esc((a.perms || []).concat('board').join(', '))} · wakes on ${esc(listen)}${a.pickup ? ` · picks up ${a.pickup === 'all' ? 'every unassigned ticket' : 'unassigned Ready tickets'}` : ''} · ${a.runsLastHour}/${a.maxRunsPerHour ?? '∞'} runs this hour${l ? ` · last run ${rel(l.endedAt || l.startedAt)}${why}${l.code != null && l.code !== 0 ? ` (exit ${esc(l.code)})` : ''}` : ''}`;
    // Who changed this agent (the human or an agent manager), newest first, each undoable.
    const fmt = (v) => (v == null ? '—' : typeof v === 'object' ? (Array.isArray(v) ? v.join(', ') : Object.entries(v).map(([k, x]) => `${k}: ${Array.isArray(x) ? x.join('/') : x}`).join(', ')) : String(v));
    const changes = (a.changes || []).slice(-5).reverse().map((c) => `<div class="chg"><span class="who">${avatar(c.by)}${nameHTML(c.by?.name)}</span><span class="what">${Object.entries(c.changes).map(([k, v]) => `<b>${esc(k.replace(/^profile\./, ''))}</b> ${esc(fmt(v.from))} → ${esc(fmt(v.to))}`).join(' · ')}</span><time>${rel(c.at)}</time><button class="btn sm ghost" data-revert="${esc(c.id)}" data-agent="${esc(a.name)}" title="Revert|Put these values back">${icon('restore', 'sm')}</button></div>`).join('');
    return `<div class="section"><div class="section-head">${icon('radio', 'sm')}<span>Standing agent</span><span class="rule"></span></div>${standingControls(a)}<div class="standing-meta">${meta}</div>${changes ? `<div class="chg-list"><div class="chg-head">Recent changes</div>${changes}</div>` : ''}</div>`;
  }
  // Undo one change: send the old values back (as the human).
  async function revertChange(btn) {
    const a = state.standing[btn.dataset.agent];
    const c = (a?.changes || []).find((x) => x.id === btn.dataset.revert);
    if (!c) return;
    const body = {};
    for (const [k, v] of Object.entries(c.changes)) {
      if (k.startsWith('profile.')) body[k.slice(8)] = v.from;
      else if (k === 'limits') body.permissions = { columns: v.from?.columns ?? null, readOnly: !!v.from?.readOnly };
      else body[k] = v.from;
    }
    try { await api('PATCH', `/api/agents/${encodeURIComponent(a.name)}`, body); toast(`Reverted ${nameOf(a.name)}`, { icon: 'restore', kind: 'ok' }); await refreshPresence(); await refreshProfiles(); } catch (e) { toast(e.message, { kind: 'error' }); }
  }

  async function openAgent(name) {
    const body = openDrawer('agentDrawer', name, 'bot');
    let spec = null; // the Speciality editor survives redraws (a half-typed edit must not vanish)
    const draw = (activity = null) => {
      const p = state.profiles[name] || {};
      const pres = state.presence.find((x) => x.name === name);
      const items = Object.values(state.board?.items || {});
      const chip = (id, ic) => `<span class="mini-chip link" data-open="${esc(id)}" title="${esc(state.board.items[id]?.title || '')}">${icon(ic, 'sm')}${esc(id)}</span>`;
      const section = (title, ic, html) => (html ? `<div class="section"><div class="section-head">${icon(ic, 'sm')}<span>${title}</span><span class="rule"></span></div><div class="deps">${html}</div></div>` : '');
      const mode = pres ? (pres.connections.stream ? 'stream' : pres.connections.waiting ? 'polling' : pres.online ? 'active' : 'offline') : 'never seen';
      body.innerHTML = `<div class="agent-hero">${avatar({ kind: p.kind || 'agent', name }, 'xl')}<div style="min-width:0"><div class="ah-name">${esc(p.label || name)}</div>
          <div class="ah-sub"><span class="status-dot ${pres?.online ? 'on' : ''}"></span><span>${esc(name)}</span><span>· ${mode}</span>${pres?.lastSeen ? `<span>· ${rel(pres.lastSeen)}</span>` : ''}</div></div></div>
        ${p.description || state.standing[name]?.description ? `<div class="md ah-desc">${md(p.description || state.standing[name].description)}</div>` : ''}
        ${state.standing[name] ? standingSection(state.standing[name]) : ''}
        ${state.standing[name] ? '<div class="spec-slot"></div>' : ''}
        ${section('Holding', 'clock', (pres?.leases || []).map((l) => chip(l.id, 'clock')).join(''))}
        ${section('Assigned', 'user', items.filter((i) => i.assignee === name).map((i) => chip(i.id, i.type)).join(''))}
        ${section('Listening to', 'radio', Object.entries(state.listeners).filter(([, ns]) => ns.includes(name)).map(([id]) => chip(id, 'radio')).join(''))}
        ${section('Subscriptions', 'bell', (pres?.subscriptions || []).map((x) => `<span class="mini-chip" title="${esc(JSON.stringify(x.filter))}">${icon('bell', 'sm')}${esc(x.label || Object.entries(x.filter).map(([k, v]) => `${k}=${v}`).join(' ') || 'all')}</span>`).join(''))}
        <div class="section"><div class="section-head">${icon('activity', 'sm')}<span>Activity</span><span class="rule"></span></div>
          <div class="ah-act">${activity == null ? '' : activity.length ? activity.map((ev) => `<div class="act">${icon(eventIcon(ev.type), 'sm')}<div>${describe(ev, true)}</div><time>${rel(ev.ts)}</time></div>`).join('') : `<div class="empty-note">${icon('activity')}</div>`}</div></div>`;
      const slot = $('.spec-slot', body);
      if (slot) { spec ||= specialityEditor(name); slot.replaceWith(spec); }
    };
    draw();
    body.onclick = (e) => {
      const sb = e.target.closest('[data-standing]');
      if (sb) { standingAction(sb).then(() => draw()); return; }
      const rv = e.target.closest('[data-revert]');
      if (rv) { revertChange(rv).then(() => draw()); return; }
      const o = e.target.closest('[data-open]'); if (o) openItem(o.dataset.open, cardEls.get(o.dataset.open));
    };
    try {
      const r = await api('GET', `/api/events?since=0&limit=30&tail=true&actor=${encodeURIComponent(name)}`);
      if ($('#agentDrawer')) draw(r.events.slice().reverse());
    } catch { /* offline */ }
  }

  /* What makes an agent a specialist: the code it owns (guidance), what it watches for, and its context page.
     Edited here, saved to agents.json and agent-context/<name>.md through PATCH /api/agents/<name>. */
  // A reviewer's tick: ✓ looks good, ! concerns, … still looking.
  const reviewerTick = (r, { rm = false } = {}) => `<span class="rv-tick ${r.verdict || 'pending'}" title="${esc(nameOf(r.name))}|${r.verdict === 'ok' ? 'Looks good' : r.verdict === 'concerns' ? 'Has concerns — see the comment' : 'Reviewing…'}">${avatar({ kind: 'agent', name: r.name })}<i>${r.verdict === 'ok' ? '✓' : r.verdict === 'concerns' ? '!' : '…'}</i>${rm ? `<button type="button" data-act="rv-rm" data-rv="${esc(r.name)}" title="Remove reviewer">${icon('x', 'sm')}</button>` : ''}</span>`;

  function specialityEditor(name) {
    const a = state.standing[name] || {};
    const st = { areas: [...(a.areas || [])], concerns: [...(a.concerns || [])], context: '', loaded: false, dirty: false };
    const root = el(`<div class="section spec"><div class="section-head">${icon('target', 'sm')}<span>Speciality</span><span class="rule"></span></div>
      <div class="spec-ed">
        <div class="spec-label">Owns <span class="muted">— code areas it is routed for (guidance, not a limit)</span></div>
        <div class="spec-chips" data-k="areas"></div>
        <div class="spec-add"><input class="inp" data-add="areas" placeholder="Add a file or folder — type to search the repo" autocomplete="off" list="specfiles-${esc(name)}"><datalist id="specfiles-${esc(name)}"></datalist><button class="btn sm ghost" type="button" data-add-btn="areas">${icon('plus', 'sm')}Add</button></div>
        <div class="spec-label">Watches for <span class="muted">— concerns it checks before asking for review</span></div>
        <div class="spec-chips" data-k="concerns"></div>
        <div class="spec-add"><input class="inp" data-add="concerns" placeholder="e.g. accessibility contrast, dark/light parity, performance" autocomplete="off"><button class="btn sm ghost" type="button" data-add-btn="concerns">${icon('plus', 'sm')}Add</button></div>
        <label class="spec-toggle"><input type="checkbox" data-reviewer ${a.reviewer ? 'checked' : ''}> <span><b>Can review</b> other agents' work in its areas — the receptionist may assign it; it comments, you approve</span></label>
        <div class="spec-label">Context <span class="muted spec-file">${esc(a.contextFile || '')} — how its area works, conventions, traps; read on each session's first turn</span></div>
        <textarea class="inp spec-ctx" rows="8" placeholder="Loading…" spellcheck="true"></textarea>
        <div class="spec-foot"><span class="spec-state muted"></span><span class="grow"></span><button class="btn primary sm" type="button" data-spec-save disabled>${icon('check', 'sm')}Save</button></div>
      </div></div>`);
    const ta = $('.spec-ctx', root);
    const saveBtn = $('[data-spec-save]', root);
    const touch = () => { st.dirty = true; saveBtn.disabled = false; $('.spec-state', root).textContent = 'Unsaved changes'; };
    const drawChips = (k) => {
      $(`[data-k="${k}"]`, root).innerHTML = st[k].length
        ? st[k].map((x, i) => `<span class="spec-chip ${k === 'areas' ? 'path' : ''}">${k === 'areas' ? icon('text', 'sm') : icon('eye', 'sm')}<span>${esc(x)}</span><button type="button" data-rm="${k}" data-i="${i}" title="Remove">${icon('x', 'sm')}</button></span>`).join('')
        : `<span class="muted spec-none">${k === 'areas' ? 'No areas yet' : 'No concerns yet'}</span>`;
    };
    drawChips('areas');
    drawChips('concerns');
    const add = (k) => {
      const inp = $(`[data-add="${k}"]`, root);
      const v = inp.value.trim();
      if (!v) { inp.focus(); return; }
      if (!st[k].includes(v)) { st[k].push(v); drawChips(k); touch(); }
      inp.value = '';
      inp.focus();
    };
    api('GET', `/api/agents/${encodeURIComponent(name)}/context`).then((r) => { ta.value = r.text || ''; ta.placeholder = 'Markdown: what this agent should know about its area'; st.loaded = true; autosize(ta); }, () => { ta.placeholder = 'Could not load the context page'; });
    // file suggestions from the repo as you type a path
    let t = null;
    $('[data-add="areas"]', root).addEventListener('input', (e) => {
      clearTimeout(t);
      const q = e.target.value.trim();
      t = setTimeout(async () => {
        try { const list = await api('GET', `/api/files?q=${encodeURIComponent(q)}`); $('datalist', root).innerHTML = list.map((x) => `<option value="${esc(x)}"></option>`).join(''); } catch { /* offline */ }
      }, 150);
    });
    root.addEventListener('keydown', (e) => { const k = e.target.dataset?.add; if (k && e.key === 'Enter') { e.preventDefault(); add(k); } });
    ta.addEventListener('input', () => { autosize(ta); touch(); });
    $('[data-reviewer]', root).addEventListener('change', touch);
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-add-btn]');
      if (b) { add(b.dataset.addBtn); return; }
      const rm = e.target.closest('[data-rm]');
      if (rm) { st[rm.dataset.rm].splice(Number(rm.dataset.i), 1); drawChips(rm.dataset.rm); touch(); return; }
      if (e.target.closest('[data-spec-save]')) {
        saveBtn.disabled = true;
        try {
          const r = await api('PATCH', `/api/agents/${encodeURIComponent(name)}`, { areas: st.areas, concerns: st.concerns, reviewer: $('[data-reviewer]', root).checked, ...(st.loaded ? { context: ta.value } : {}) });
          st.dirty = false;
          $('.spec-state', root).textContent = Object.keys(r.changes || {}).length ? 'Saved — used from its next session' : 'No changes';
          await refreshPresence();
        } catch (err) { saveBtn.disabled = false; toast(err.message, { kind: 'error' }); }
      }
    });
    return root;
  }

  /* ═════════════════════════ command palette (Ctrl+K) ═════════════════════════ */

  function togglePalette() { if ($('.palette-scrim')) closePalette(); else openPalette(); }
  function closePalette() { const p = $('.palette-scrim'); if (p) { p.remove(); syncScrimmed(); } }

  function ticketStage(it) {
    const lease = activeLease(it);
    const fail = (e) => toast(e.message, { kind: 'error' });
    return {
      title: it.id,
      items: [
        { label: 'Open', icon: 'eye', run: () => openItem(it.id, cardEls.get(it.id)) },
        { label: 'Move to…', icon: 'move', run: () => ({ title: 'Move', items: state.board.columns.filter((c) => c.id !== it.columnId).map((c) => ({ label: c.name, color: c.color, run: () => patchItem(it.id, { column: c.id, position: 'top' }) })) }) },
        { label: 'Priority…', icon: 'flag', run: () => ({ title: 'Priority', items: PRIORITIES.map((p) => ({ label: p, color: PRIO_VAR[p], hint: p === it.priority ? '●' : '', run: () => patchItem(it.id, { priority: p }) })) }) },
        { label: 'Assign…', icon: 'user', run: () => ({ title: 'Assign', items: [{ label: 'Nobody', icon: 'x', run: () => patchItem(it.id, { assignee: null }) }, ...knownPeople().map((n) => ({ label: n, avatar: { name: n }, run: () => patchItem(it.id, { assignee: n }) }))] }) },
        lease
          ? { label: `Revoke ${lease.claimant}'s lease`, icon: 'x', run: () => api('DELETE', I(it.id, '/lease')).then(() => scheduleRefresh(0), fail) }
          : { label: 'Hold 30 min', icon: 'lock', run: () => api('POST', I(it.id, '/lease'), { minutes: 30, force: true }).then(() => scheduleRefresh(0), fail) },
        { label: 'Copy ID', icon: 'copy', run: () => { navigator.clipboard?.writeText(it.id); toast(`Copied ${it.id}`, { icon: 'copy', timeout: 1500 }); } },
        { label: 'Archive', icon: 'archive', run: () => api('POST', I(it.id, '/archive'), {}).then(() => { toast(`Archived ${it.id}`, { icon: 'archive', action: 'Undo', onAction: () => restoreMany([it.id]) }); scheduleRefresh(0); }, fail) },
        ...(it.test ? [{ label: 'Delete (test ticket)', icon: 'trash', run: () => deleteTests([it.id]) }] : []),
      ],
    };
  }

  function rootStage() {
    const b = state.board;
    const A = 'Actions';
    const cmds = [
      ...(b ? b.columns.filter((c) => c.flags.allowCreate).map((c) => ({ section: A, label: `New ticket in ${c.name}`, icon: 'plus', run: () => openCreate(c.id) })) : []),
      { section: A, label: 'Needs you', icon: 'ask', hint: String(needsIds().length), run: () => { const ids = needsIds(); if (ids.length) openItem(ids[0], cardEls.get(ids[0]), { rail: true }); } },
      { section: A, label: 'Inbox', icon: 'bell', run: openInbox },
      { section: A, label: 'While you were away', icon: 'sparkle', run: openCatchup },
      { section: A, label: 'Standing rules', icon: 'pin', run: openRules },
      { section: A, label: 'Digest', icon: 'news', run: openDigest },
      activeMaster()
        ? { section: A, label: `Release the board (${activeMaster().holder})`, icon: 'x', run: () => api('DELETE', B('/master')).then(() => scheduleRefresh(0), (e) => toast(e.message, { kind: 'error' })) }
        : { section: A, label: 'Hold the whole board', icon: 'lock', hint: 'master lease', run: () => api('POST', B('/master'), { force: true }).then(() => scheduleRefresh(0), (e) => toast(e.message, { kind: 'error' })) },
      { section: A, label: 'Ask an agent…', icon: 'send', hint: askTo() || '', run: () => setTimeout(openAsk, 0) },
      { section: A, label: 'Agents', icon: 'bot', run: openAgents },
      { section: A, label: 'Archive', icon: 'archive', run: openArchive },
      { section: A, label: 'Select mode', icon: 'checks', run: () => setBulk(!state.bulk) },
      { section: A, label: 'Settings', icon: 'sliders', run: () => openSettings() },
      { section: A, label: 'Ticket fields', icon: 'layers', run: () => openSettings('fields') },
      { section: 'Go to', label: 'Switch board…', icon: 'board', run: () => ({ title: 'Board', items: state.boards.map((x) => ({ label: x.name, icon: 'board', hint: String(x.items), run: () => { closeModal(true); loadBoard(x.id); } })) }) },
      { section: 'Look', label: 'Theme…', icon: 'palette', run: () => ({ title: 'Theme', items: Object.entries(THEMES).map(([k, t]) => ({ label: t.label, color: t.vars.accent, hint: k === settings.theme ? '●' : '', run: () => switchTheme(k) })) }) },
      { section: 'Look', label: 'Background…', icon: 'wave', run: () => ({ title: 'Background', items: BACKGROUNDS.map(([k, l]) => ({ label: l, icon: 'wave', hint: k === pick('bg') ? '●' : '', run: () => { settings.bg = k; saveSettings(); } })) }) },
    ];
    const tickets = b ? b.columns.flatMap((c) => c.itemIds).map((id) => b.items[id]).filter(Boolean)
      .map((it) => ({ section: 'Tickets', label: `${it.id}  ${it.title}`, icon: it.type, hint: colById(it.columnId)?.name, keys: `${it.parent || ''} ${it.assignee || ''}`, run: () => ticketStage(it) })) : [];
    return { title: '', items: [...cmds, ...tickets] };
  }

  function openPalette() {
    closeMenus();
    const root = el(`<div class="scrim palette-scrim"><div class="palette" role="dialog" aria-modal="true">
      <div class="pal-head">${icon('search')}<span class="pal-crumb"></span><input class="pal-input" spellcheck="false" placeholder="Search tickets or type a command…"></div>
      <div class="pal-list"></div>
      <div class="pal-foot"><span><kbd>↑↓</kbd></span><span><kbd>Enter</kbd></span><span><kbd>⌫</kbd> back</span><span><kbd>Esc</kbd></span></div></div></div>`);
    document.body.append(root);
    syncScrimmed();
    root.addEventListener('pointerdown', (e) => { if (e.target === root) closePalette(); });
    const input = $('.pal-input', root);
    const list = $('.pal-list', root);
    const crumb = $('.pal-crumb', root);
    const stack = [rootStage()];
    let active = 0;
    let shownItems = [];
    const draw = () => {
      const st = stack[stack.length - 1];
      crumb.innerHTML = stack.slice(1).map((x) => `<span>${esc(x.title)}</span>`).join('');
      const q = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      shownItems = st.items.filter((it) => !q.length || q.every((t) => `${it.label} ${it.hint || ''} ${it.keys || ''}`.toLowerCase().includes(t))).slice(0, 60);
      active = clamp(active, 0, Math.max(0, shownItems.length - 1));
      let sec = null;
      let html = '';
      shownItems.forEach((it, i) => {
        if (it.section && it.section !== sec && !q.length) { sec = it.section; html += `<div class="pal-sec">${esc(sec)}</div>`; }
        const lead = it.avatar ? avatar(it.avatar) : it.color ? `<span class="sw" style="--c:${esc(it.color)}"></span>` : icon(it.icon || 'sparkle');
        html += `<button class="pal-item ${i === active ? 'act' : ''}" data-i="${i}">${lead}<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</button>`;
      });
      list.innerHTML = html || '<div class="empty-note">—</div>';
      $('.pal-item.act', list)?.scrollIntoView({ block: 'nearest' });
    };
    const run = (it) => {
      if (!it) return;
      const next = it.run?.();
      if (next && Array.isArray(next.items)) { stack.push(next); input.value = ''; active = 0; draw(); input.focus(); }
      else closePalette();
    };
    input.oninput = () => { active = 0; draw(); };
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = clamp(active + (e.key === 'ArrowDown' ? 1 : -1), 0, shownItems.length - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); run(shownItems[active]); }
      else if (e.key === 'Backspace' && !input.value && stack.length > 1) { stack.pop(); active = 0; draw(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (stack.length > 1) { stack.pop(); input.value = ''; active = 0; draw(); } else closePalette(); }
    };
    list.onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) run(shownItems[Number(b.dataset.i)]); };
    list.onmousemove = (e) => {
      const b = e.target.closest('[data-i]');
      if (!b || Number(b.dataset.i) === active) return;
      active = Number(b.dataset.i);
      $$('.pal-item', list).forEach((x) => x.classList.toggle('act', Number(x.dataset.i) === active));
    };
    draw();
    input.focus();
  }

  /* ═════════════════════════ settings ═════════════════════════ */

  const STUB_TIPS = {
    id: 'The ticket number, e.g. INT-12', type: 'Issue, task or spike icon', priority: 'Shown when not Medium', parent: 'The #group tag (hidden inside groups)',
    author: 'Who created it', lease: 'Who is working on it, with a countdown ring', comments: 'How many comments', attachments: 'How many files',
    blocked: 'Blockers that are not done yet', fields: 'Custom fields set to show on cards', properties: 'Count of free-form agent data',
    description: 'First lines of the description', thumbnail: 'The chosen card image', assignee: 'Who it is handed to',
    status: 'The live status line from the agent holding it', checklist: 'Progress of description checkboxes', listeners: 'Agents subscribed to this ticket',
  };
  const STUB_FIELDS = [
    ['id', 'ID', 'hash'], ['type', 'Type', 'layers'], ['priority', 'Priority', 'flag'], ['parent', 'Parent', 'hash'],
    ['author', 'Author', 'user'], ['lease', 'Lease', 'clock'], ['comments', 'Comments', 'msg'], ['attachments', 'Files', 'clip'],
    ['blocked', 'Blocked', 'lock'], ['fields', 'Fields', 'layers'], ['properties', 'Properties', 'braces'], ['description', 'Description', 'text'], ['thumbnail', 'Image', 'image'],
    ['assignee', 'Assignee', 'user'], ['status', 'Status', 'activity'], ['checklist', 'Checklist', 'checks'], ['listeners', 'Listeners', 'radio'],
  ];

  function openSettings(tab = 'look') {
    closeModal(true);
    lookKind = null;
    const root = el(`<div class="scrim"><div class="modal settings entering" role="dialog" aria-modal="true">
      <header class="m-head"><span class="m-type" style="color:var(--accent)">${icon('sliders')}</span><span style="font:700 16px var(--display);color:var(--text)">Settings</span><span class="saved">${icon('check', 'sm')}</span><span class="grow"></span><button class="pill-btn icon-btn sm" data-close>${icon('x')}</button></header>
      <div class="m-frame"><nav class="set-nav">
        <button data-tab="look">${icon('palette')}Appearance</button>
        <button data-tab="cards">${icon('card')}Cards</button>
        <button data-tab="board">${icon('board')}Board</button>
        <button data-tab="fields">${icon('layers')}Fields</button>
        <button data-tab="columns">${icon('board')}Columns</button>
        <button data-tab="templates">${icon('copy')}Templates</button>
        <button data-tab="notify">${icon('bell')}Alerts</button>
        <button data-tab="about">${icon('info')}About</button>
      </nav><div class="set-pane"></div></div></div></div>`);
    document.body.append(root);
    const m = { kind: 'settings', id: null, root, modal: $('.modal', root), tab, refresh: () => {} };
    state.modal = m;
    syncScrimmed();
    root.addEventListener('pointerdown', (e) => { root._down = e.target === root; });
    root.addEventListener('click', (e) => { if (e.target === root && root._down) closeModal(); });
    $('[data-close]', root).onclick = () => closeModal();
    const pane = $('.set-pane', root);
    const show = (t, quiet = false) => {
      m.tab = t;
      const scroll = pane.scrollTop;
      $$('.set-nav button', root).forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
      pane.innerHTML = settingsPane(t);
      if (quiet) pane.scrollTop = scroll;
      else pane.animate([{ opacity: 0, translate: '0 6px' }, { opacity: 1, translate: '0 0' }], { duration: 260, easing: SPRING });
      for (const r of $$('input[type="range"]', pane)) paintRange(r);
      wirePane(t, pane, show);
    };
    // Re-clicking the open tab does nothing: no re-render, scroll kept (INT-197)
    $$('.set-nav button', root).forEach((b) => { b.onclick = () => { if (b.dataset.tab !== m.tab) show(b.dataset.tab); }; });
    // Live data (schema, profiles) changed elsewhere: redraw quietly unless the user is typing in the pane.
    m.refresh = () => {
      const typing = pane.contains(document.activeElement) && document.activeElement.matches('input, textarea');
      if (['fields', 'board', 'templates', 'columns'].includes(m.tab) && !typing) show(m.tab, true);
    };
    show(tab);
  }

  const paintRange = (r) => r.style.setProperty('--p', `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
  // A labelled row of equal-width options (settings). opts: [value, label, tip?]
  const choiceRow = (key, label, opts, val, { themeVal = null, sub = '' } = {}) => `<div class="choice-row">
      <div class="cr-label"><span>${label}</span>${sub}</div>
      <div class="opt-grid" data-set="${key}" style="--n:${opts.length}">${opts.map(([v, l, tip]) => `<button class="${v === val ? 'on' : ''} ${v === themeVal ? 'is-theme' : ''}" data-v="${v}"${tip ? ` title="${l}|${tip}${v === themeVal ? ' · the theme\'s choice' : ''}"` : ''}>${l}</button>`).join('')}</div></div>`;
  const seg = (key, opts, val) => `<div class="seg" data-set="${key}">${opts.map(([v, label, tip]) => `<button class="${v === val ? 'on' : ''}" data-v="${v}"${tip ? ` title="${label}|${tip}"` : ''}>${label}</button>`).join('')}</div>`;
  const sw = (key, on) => `<button class="switch ${on ? 'on' : ''}" data-sw="${key}" role="switch" aria-checked="${on}"></button>`;

  /* ─── live previews (same cardHTML as the board) ─── */
  function sampleValue(f) {
    switch (f.type) {
      case 'number': return f.min ?? 3;
      case 'boolean': return true;
      case 'enum': return f.options?.[0]?.value ?? null;
      case 'tags': return [f.options?.[0]?.value || 'ui'];
      case 'date': return new Date(nowMs()).toISOString().slice(0, 10);
      case 'url': return 'https://example.com/pull/12';
      case 'user': return 'storage-bot';
      default: return 'Sample';
    }
  }
  function sampleItem(o = {}) {
    const t = new Date(nowMs()).toISOString();
    const fields = {};
    for (const f of schema().fields) fields[f.key] = sampleValue(f);
    return {
      id: 'DEMO-7', title: 'Ship the onboarding flow', type: 'task', priority: 'High', parent: 'onboarding', columnId: '__preview',
      author: { kind: 'agent', name: 'claude-builder' }, assignee: 'storage-bot',
      description: 'Polish the first-run experience.\n- [x] Copy\n- [x] Layout\n- [ ] Analytics',
      comments: [{}, {}], attachments: [{ id: 'img', kind: 'file', mime: 'image/svg+xml', name: 'mockup.svg', url: SAMPLE_IMG }, { id: 'a', kind: 'file', mime: 'text/plain', name: 'notes.txt', url: '#' }],
      properties: { env: 'staging' }, fields, blockedBy: [], cover: 'auto', version: 1, createdAt: t, updatedAt: t, ...o,
    };
  }
  // A tiny inline landscape so the "Image" card option has something to show in previews.
  const SAMPLE_IMG = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b7bff"/><stop offset="1" stop-color="#2fe0c4"/></linearGradient></defs><rect width="320" height="180" fill="url(#s)"/><circle cx="240" cy="52" r="22" fill="#fff" opacity=".85"/><path d="M0 150 L70 92 L120 128 L190 70 L320 160 V180 H0Z" fill="#1d2035" opacity=".55"/></svg>')}`;
  const demoLease = () => ({ claimant: 'claude-builder', expiresAt: new Date(nowMs() + 18 * 60000).toISOString(), minutes: 30, status: 'running tests 4/12' });
  function previewCard(it, { lease = null, blockers = [], listeners = [], needs = false, inGroup = false, si = null } = {}) {
    return `<article class="card ${needs ? 'needs' : ''}" data-type="${it.type}" data-slot="${decoSlot(it.id)}" style="--tilt:${tilt(it.id)}deg;${decoVars(it.id)}${si != null ? `;--si:${si}` : ''}"><i class="tape"></i><div class="c-body">${cardHTML(it, lease, blockers, inGroup, listeners)}</div><span class="c-check">${icon('check')}</span><span class="c-ask">?</span></article>`;
  }
  // A group exactly as the board draws it (grouping mode and label placement come from the page's classes/attributes).
  const pvGroup = (parent, items, first = {}) => `<section class="group ${settings.grouping === 'list' ? 'listed' : settings.grouping}" style="--tagc:${tagColor(parent)}"><button class="group-head"><i class="tape"></i><span class="g-dot"></span><span class="g-name">${esc(parent)}</span><span class="g-count">${items.length}</span><span class="grow"></span>${icon('chev', 'g-chev')}<span class="g-sum">${pick('groups') === 'cover' ? groupSummary(items) : ''}</span></button><i class="g-bg"></i><div class="group-cards">${items.map((it, i) => previewCard(it, { ...(i ? {} : first), inGroup: true, si: i })).join('')}</div></section>`;
  function previewStage(kind) {
    const col = (name, color, inner, n) => `<section class="column pv-col" style="--col:${color}"><header class="col-head"><span class="col-dot"></span><h2 class="col-name">${name}</h2><span class="col-count">${n}</span></header><div class="list">${inner}</div></section>`;
    const bare = { parent: null, assignee: null, description: '', comments: [], attachments: [], fields: {}, properties: {} };
    if (kind === 'cards') {
      return `<div class="pv-stage">${col('In Progress', '#f2a541', previewCard(sampleItem(), { lease: demoLease(), blockers: ['DEMO-3'], listeners: ['storage-bot'] }), 1)}</div>`;
    }
    if (kind === 'style') {
      const a = previewCard(sampleItem({ ...bare, id: 'DEMO-4', title: 'Token refresh race on wake', type: 'issue', priority: 'Critical' }), { needs: true });
      const bi = [sampleItem({ ...bare, id: 'DEMO-9', title: 'Benchmark cache options', type: 'spike', priority: 'Medium', parent: 'storage' }), sampleItem({ ...bare, id: 'DEMO-11', title: 'Evict stale entries', type: 'task', priority: 'Low', parent: 'storage' })];
      const b = settings.grouping === 'off' ? previewCard(bi[0], { lease: demoLease() }) : pvGroup('storage', bi, { lease: demoLease() });
      return `<div class="pv-stage pv-wide">${col('Review', '#b07cf2', a + b, 3)}<div class="pv-side"><button class="pill-btn">${icon('board', 'sm')}Main${icon('chev', 'sm')}</button><button class="btn primary">${icon('check', 'sm')}Save</button><button class="btn">${icon('archive', 'sm')}Archive</button><span class="chip parent" style="--tagc:${tagColor('storage')}">storage</span><div class="seg"><button class="on">Edit</button><button>Read</button></div>${avatar({ kind: 'agent', name: 'claude-builder' })}</div></div>`;
    }
    const items = ['Login form', 'Session cookie', 'Refresh endpoint'].map((title, i) => sampleItem({ ...bare, id: `DEMO-${i + 1}`, title, type: i === 2 ? 'issue' : 'task', priority: ['Medium', 'Low', 'High'][i], parent: 'auth' }));
    const inner = settings.grouping === 'off'
      ? items.map((it) => previewCard(it)).join('')
      : pvGroup('auth', items);
    return `<div class="pv-stage">${col('Ready', '#5aa9e6', inner, 3)}</div>`;
  }

  // The kind of theme open in Appearance; null shows the kind of the current theme (reset each time Settings opens).
  let lookKind = null;

  function settingsPane(t) {
    if (t === 'look') {
      const kind = lookKind || themeKind(settings.theme);
      const kinds = THEME_KINDS.map(([id, label, keys]) => `<button class="theme-kind ${id === kind ? 'on' : ''}" data-theme-kind="${id}" aria-pressed="${id === kind}">${label}<small>${keys.length}</small></button>`).join('');
      const tiles = THEME_KINDS.find(([id]) => id === kind)[2].map((k) => [k, THEMES[k]]).map(([k, th]) => {
        const v = th.vars;
        return `<button class="tile ${settings.theme === k ? 'on' : ''}" data-pick-theme="${k}"><span class="pv" style="background:${v.bg}">
          <i style="background:${v.panel}"><b style="background:${v.issue};opacity:.85"></b><b style="background:${v.surface}"></b></i>
          <i style="background:${v.panel}"><b style="background:${v.task};opacity:.85"></b><b style="background:${v.accent}"></b></i>
          <i style="background:${v.panel}"><b style="background:${v.spike};opacity:.85"></b></i></span><span class="nm">${th.label}</span></button>`;
      }).join('');
      const themeBg = themeStyle().bg;
      const bgs = [['theme', `Theme · ${BACKGROUNDS.find(([k]) => k === themeBg)?.[1] || ''}`], ...BACKGROUNDS].map(([k, label]) => `<button class="tile ${(settings.bg || 'theme') === k ? 'on' : ''}" data-bgfx="${k}"><span class="bgpv ${k === 'theme' ? themeBg : k}" style="${art.tile(k === 'theme' ? themeBg : k)}"></span><span class="nm">${label}</span></button>`).join('');
      // A style choice: equal-width options, the theme's own pick marked with a dot. Choosing one overrides
      // the theme; "Theme default" (shown only while overridden) hands the choice back to the theme.
      const opt = (key, label, list) => {
        const tv = themeStyle()[key];
        const themeVal = typeof tv === 'boolean' ? (tv ? 'on' : 'off') : tv; // texture is stored as a boolean
        const own = settings[key] != null && settings[key] !== 'theme';
        return choiceRow(key, label, list, own ? settings[key] : themeVal, {
          themeVal,
          sub: own ? `<button class="sr-reset" data-reset="${key}" title="Theme default|Use what ${esc(THEMES[settings.theme]?.label || 'the theme')} chooses">${icon('restore', 'sm')}Theme default</button>` : '<span class="sr-auto">from theme</span>',
        });
      };
      return `<div class="theme-pick"><div class="theme-kinds" role="group" aria-label="Kind of theme">${kinds}</div><div class="tiles theme-tiles">${tiles}</div></div>
        <div class="look-sticky">${previewStage('style')}</div>
        <h3>Style</h3>
        <div class="choices">
        ${opt('cards', 'Cards', [['sticky', 'Sticky', 'Tinted sticky notes, slightly tilted'], ['clean', 'Clean', 'Flat cards with a type marker'], ['elevated', 'Raised', 'Borderless, lifted on layered soft shadows'], ['outline', 'Line', 'Transparent with a fine outline'], ['glass', 'Glass', 'Frosted, see-through cards'], ['index', 'Index', 'Ruled index cards with a type-coloured header rule']])}
        ${opt('tape', 'Decoration', [['tape', 'Tape', 'A strip of tape on sticky notes'], ['pin', 'Pin', 'A push-pin at the top'], ['clip', 'Clip', 'A binder clip on the edge'], ['corner', 'Fold', 'A folded top corner'], ['none', 'None', 'No decoration']])}
        ${opt('attn', 'Needs you', [['orbit', 'Orbit', 'Spinning ring and a bouncing badge'], ['glow', 'Glow', 'A soft breathing halo'], ['bar', 'Bar', 'Accent edge and tint — calm'], ['outline', 'Outline', 'A solid outline and small badge'], ['ribbon', 'Ribbon', 'A bookmark tab on the card']])}
        ${opt('enter', 'Opening', [['rise', 'Rise', 'Fades in with a small lift'], ['sheet', 'Sheet', 'Slides in from the right as a side panel'], ['fade', 'Fade', 'A quick cross-fade'], ['pop', 'Pop', 'Snaps in with a little bounce'], ['zoom', 'Zoom', 'Grows out of the ticket']])}
        ${opt('groups', 'Groups', [['tray', 'Tray', 'Tickets sharing a parent sit on a faintly tinted panel'], ['rail', 'Rail', 'A coloured rail beside the cards, no panel'], ['rule', 'Rule', 'A header with a hairline underneath'], ['tab', 'Tab', 'A folder tab joined to the top of the cards'], ['spine', 'Spine', 'The #tag runs down a spine beside the cards'], ['foot', 'Footer', 'A quiet #tag caption under the cards'], ['cover', 'Cover', 'A summary card on top of the pile; the tickets list out beneath it']])}
        ${opt('lanes', 'Columns', [['glass', 'Glass', 'Translucent panels'], ['solid', 'Solid', 'Opaque panels'], ['outline', 'Outline', 'Bordered, see-through'], ['lane', 'Lanes', 'No panels — dividers between lanes']])}
        ${opt('texture', 'Texture', [['on', 'On', 'Film grain and dotted board'], ['off', 'Off', 'Plain surfaces']])}
        ${opt('drop', 'Drop target', [['ring', 'Ring', 'An outline glow in the column colour'], ['tint', 'Tint', 'The column floods with its colour'], ['lift', 'Lift', 'The column rises to meet the card'], ['spotlight', 'Spot', 'Other columns dim; the target lights up'], ['dashed', 'Dashed', 'A technical dashed outline'], ['pulse', 'Pulse', 'A gentle breathing glow']])}
        ${opt('avStyle', 'Avatars', [['gem', 'Gem', 'Glossy colour with depth'], ['flat', 'Flat', 'Solid colour'], ['tint', 'Tint', 'Soft colour fill, coloured initials'], ['ring', 'Ring', 'Outline only'], ['pebble', 'Pebble', 'Organic, slightly irregular stone'], ['stamp', 'Stamp', 'Printed, with an offset shadow']])}
        ${opt('md', 'Markdown', [['clean', 'Clean', 'Hairline rows, small-caps headers, soft code blocks'], ['grid', 'Grid', 'Ruled cells and strong rules — structured'], ['paper', 'Paper', 'Editorial: serif headings, double-ruled tables, pull quotes'], ['terminal', 'Terminal', 'Monospace, dashed rules, inverted headers'], ['notebook', 'Notebook', 'Ruled paper, margin line, handwritten headings'], ['ledger', 'Ledger', 'Green-bar rows, tabular figures, accountant rules']])}
        </div>
        <h3>Layout</h3>
        <div class="choices">
        ${choiceRow('density', 'Density', [['cozy', 'Cozy', 'Roomy cards'], ['compact', 'Compact', 'Tighter cards, more on screen']], settings.density)}
        ${choiceRow('motion', 'Motion', [['full', 'Full', 'All animations'], ['reduced', 'Reduced', 'Only the essentials']], settings.motion)}
        <div class="choice-row"><div class="cr-label"><span>Column width</span><span class="sr-auto">${settings.colw}px</span></div><input type="range" min="240" max="440" step="10" value="${settings.colw}" data-range="colw"></div>
        </div>
        <h3>Background</h3><div class="tiles">${bgs}</div>`;
    }
    if (t === 'cards') {
      return `<div class="look-sticky">${previewStage('cards')}</div><h3>Show on card</h3><div class="chips-grid">${STUB_FIELDS.map(([k, label, ic]) => `<button class="toggle-chip ${settings.stub[k] ? 'on' : ''}" data-stub="${k}" title="${label}|${STUB_TIPS[k] || ''}">${icon(ic)}${label}</button>`).join('')}</div>`;
    }
    if (t === 'board') {
      const me = state.profiles[settings.userName] || {};
      return `<h3>Parent groups</h3>
        ${choiceRow('metrics', 'Metrics strip', [['on', 'Show', 'Done, cycle time and how long agents wait on you, under the top bar'], ['off', 'Hide', 'No metrics strip']], settings.metrics ? 'on' : 'off')}
        ${choiceRow('grouping', 'Grouping', [['off', 'Off', 'Show every ticket separately'], ['list', 'List', 'Group tickets sharing a parent under a heading'], ['stack', 'Stack', 'Pile tickets sharing a parent — click to fan out']], settings.grouping)}
        ${previewStage('grouping')}
        <h3>Ticket edits</h3>
        ${choiceRow('saveMode', 'Apply changes', [['accept', 'Save button', 'Edits wait until you press Save'], ['instant', 'Instant', 'Every change applies immediately']], settings.saveMode)}
        <h3>Ageing</h3>
        ${choiceRow('ageDays', 'Fade idle tickets', [['0', 'Off', 'Never fade tickets'], ['3', '3d', 'Fully faded after 3 idle days'], ['7', '7d', 'Fully faded after a week'], ['14', '14d', 'Fully faded after two weeks']], String(settings.ageDays))}
        <h3>You</h3>
        <div class="row"><span>Name</span>${avatar({ kind: 'user', name: settings.userName }, 'lg')}<input class="inp" data-text="userName" value="${esc(settings.userName)}" style="max-width:200px"></div>
        <div class="row"><span>Colour</span><div class="swatches">${SWATCHES.map((c) => `<button class="swatch ${me.color === c ? 'on' : ''}" data-ucolor="${c}" style="--c:${c}"></button>`).join('')}<button class="swatch none ${me.color ? '' : 'on'}" data-ucolor="" title="Automatic">${icon('x', 'sm')}</button></div></div>
        <div class="row"><span>Glyph</span><input class="inp" data-uglyph value="${esc(me.glyph || '')}" placeholder="${esc(initials(settings.userName))}" maxlength="4" style="max-width:80px;text-align:center"></div>`;
    }
    if (t === 'fields') return fieldsPane();
    if (t === 'templates') return templatesPane();
    if (t === 'columns') return columnsPane();
    if (t === 'notify') {
      const perm = 'Notification' in window ? Notification.permission : 'unsupported';
      return `<h3>Alerts</h3>
        <div class="row"><span>Toasts</span>${sw('toasts', settings.toasts)}</div>
        <div class="row"><span>Sound</span>${sw('sound', settings.sound)}</div>
        <div class="row"><span>Desktop notifications</span>${perm === 'denied' ? '<span class="chip blocked">blocked</span>' : sw('notify', settings.notify && perm === 'granted')}</div>
        <div class="row"><span>Only when hidden</span>${sw('notifyHidden', settings.notifyHidden)}</div>`;
    }
    return `<h3>${esc(state.app.name)}</h3><div class="about-grid">
        <span>Version</span><code>${esc(state.app.version)}</code>
        <span>Build</span><code>${esc(state.app.build)}</code>
        <span>Board</span><code>${esc(state.boardId)}</code>
        <span>Hash</span><code>${esc(state.hash)}</code>
        <span>API</span><code>${esc(location.origin)}/api</code></div>
      <h3>Agents</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-copy>${icon('copy')}Copy agent prompt</button><a class="btn" href="/api/docs" target="_blank" rel="noopener">${icon('ext')}Docs</a></div>
      <pre class="md" style="margin-top:12px"><code>${esc(agentPrompt())}</code></pre>`;
  }

  const SWATCHES = ['#8b7bff', '#5aa9e6', '#2fe0c4', '#3ddc97', '#ffc857', '#ffb454', '#ff6b8b', '#ff5fa2', '#b07cf2', '#a3adc2'];
  const UI_LABEL = { edit: ['Edit', 'Humans can edit'], read: ['Read', 'Humans see it; only agents/API can change it'], hidden: ['Hidden', 'API only'] };
  const uiSeg = (val) => `<div class="seg mini" data-uiseg>${Object.entries(UI_LABEL).map(([v, [l, tip]]) => `<button class="${v === val ? 'on' : ''}" data-v="${v}" title="${tip}">${l}</button>`).join('')}</div>`;
  const BUILTIN_ROWS = [['type', 'layers'], ['priority', 'flag'], ['parent', 'hash'], ['description', 'text'], ['blockedBy', 'lock'], ['attachments', 'clip'], ['cover', 'image'], ['assignee', 'user'], ['properties', 'braces']];

  // Schema editor: built-in field config + the board's custom typed fields.
  function fieldsPane() {
    const sc = schema();
    const bis = BUILTIN_ROWS.map(([k, ic]) => {
      const c = bi(k);
      return `<div class="srow" data-bi="${k}"><span class="ficon">${icon(ic)}</span><input class="inp lab" data-bilabel value="${esc(c.label)}">${uiSeg(c.ui)}<button class="switch ${c.stub ? 'on' : ''}" data-bistub title="Show on card|Display this field on the ticket stub"></button></div>`;
    }).join('');
    const customs = sc.fields.map((f) => {
      const opts = f.type === 'enum' || f.type === 'tags'
        ? `<div class="opts">${(f.options || []).map((o) => `<span class="tagchip" style="--fc:${esc(o.color || 'var(--accent)')}"><button class="sw-btn" data-ocolor="${esc(o.value)}" style="--c:${esc(o.color || 'var(--accent)')}" title="Colour"></button>${esc(o.value)}<button class="x" data-orm="${esc(o.value)}">${icon('x', 'sm')}</button></span>`).join('')}<input class="inp opt-add" data-oadd placeholder="+ option"></div>` : '';
      const nums = f.type === 'number'
        ? `<div class="srow sub"><span class="mini-lbl">min</span><input class="inp num" type="number" data-fmin value="${f.min ?? ''}"><span class="mini-lbl">max</span><input class="inp num" type="number" data-fmax value="${f.max ?? ''}"></div>` : '';
      return `<div class="fcard" data-key="${esc(f.key)}">
        <div class="srow"><span class="ficon">${icon(ICONS[f.icon] ? f.icon : FIELD_ICON[f.type])}</span><input class="inp lab" data-flabel value="${esc(f.label)}"><code class="fkey">${esc(f.key)}</code><button class="dd tiny" data-ftype>${esc(f.type)}${icon('chev', 'sm')}</button><button class="icon-x" data-fdel title="Remove">${icon('x', 'sm')}</button></div>
        <div class="srow sub">${uiSeg(f.ui)}<div class="seg mini" data-stubseg>${[['none', 'Off'], ['top', 'Top'], ['meta', 'Footer']].map(([v, l]) => `<button class="${v === f.stub ? 'on' : ''}" data-v="${v}" title="On card: ${l}">${icon('card', 'sm')}${l}</button>`).join('')}</div></div>
        ${opts}${nums}</div>`;
    }).join('');
    return `<h3>${esc(state.board?.name || '')} · built-in</h3><div class="bi-list">${bis}</div>
      <h3>Custom</h3>${customs || ''}
      <div class="fadd"><input class="inp" data-newlabel placeholder="New field"><button class="dd tiny" data-newtype data-type="text">text${icon('chev', 'sm')}</button><button class="btn primary sm" data-newadd>${icon('plus', 'sm')}Add</button></div>`;
  }

  // Ticket templates: presets for new tickets on this board (agents use them too: { "template": "bug" }).
  function templatesPane() {
    const list = state.board?.ticketTemplates || [];
    const cols = state.board?.columns || [];
    const cards = list.map((t) => `<div class="fcard tcard" data-tkey="${esc(t.key)}">
        <div class="srow"><button class="ficon icon-pick" data-ticon title="Icon">${icon(t.icon || t.type || 'task')}</button><input class="inp lab" data-tf="label" value="${esc(t.label)}"><code class="fkey">/${esc(t.key)}</code><button class="icon-x" data-tdel title="Remove">${icon('x', 'sm')}</button></div>
        <div class="srow sub">
          <div class="seg mini" data-tseg="type">${['', ...TYPES].map((v) => `<button class="${(t.type || '') === v ? 'on' : ''}" data-v="${v}" title="${v ? `Type: ${v}` : 'Type|Keep the default'}">${v ? `${icon(v, 'sm')}${v}` : '–'}</button>`).join('')}</div>
          <button class="dd tiny" data-tdd="priority">${icon('flag', 'sm')}${esc(t.priority || 'Priority')}${icon('chev', 'sm')}</button>
          <button class="dd tiny" data-tdd="column">${icon('board', 'sm')}${esc(cols.find((c) => c.id === t.column || c.name === t.column)?.name || 'Column')}${icon('chev', 'sm')}</button>
          <input class="inp tparent" data-tf="parent" value="${esc(t.parent || '')}" placeholder="#parent">
        </div>
        <input class="inp" data-tf="help" value="${esc(t.help || '')}" placeholder="Hint shown on the chip">
        <textarea class="inp tdesc" data-tf="description" rows="3" placeholder="Description (markdown, checklists…)">${esc(t.description || '')}</textarea>
        ${Object.keys(t.fields || {}).length ? `<div class="tfields">${Object.entries(t.fields).map(([k, v]) => `<span class="mini-chip">${esc(k)}=${esc(Array.isArray(v) ? v.join(',') : v)}</span>`).join('')}</div>` : ''}
      </div>`).join('');
    return `<h3>${esc(state.board?.name || '')} · ticket templates</h3>
      ${cards || `<div class="empty-note">${icon('copy')}</div>`}
      <div class="fadd"><input class="inp" data-newtpl placeholder="New template, e.g. Bug"><button class="btn primary sm" data-tpladd>${icon('plus', 'sm')}Add</button></div>`;
  }

  /* ─── columns: rename, colour, icon, flags, reorder, add; delete only when empty ─── */
  const COL_FLAGS = [
    ['allowCreate', 'New tickets', 'New tickets can be created here'],
    ['pickup', 'Pick-up', 'Agents pick up work from here'],
    ['working', 'In progress', 'Where "start" moves tickets'],
    ['review', 'Review', 'Where "request review" moves tickets'],
    ['humanOnlyIn', 'Only you move in', 'Agents can\'t move tickets into this column (an approval gate)'],
    ['humanOnlyOut', 'Only you move out', 'Agents can\'t move tickets out of this column'],
    ['sleeping', 'Sleeping', 'Tickets wait here without waking anyone, even when assigned; moving one out wakes its assignee. Agents file new tickets here'],
    ['releaseLeaseOnEnter', 'Release on enter', 'Entering this column releases the ticket\'s lease'],
  ];
  const COL_ICONS = ['inbox', 'target', 'play', 'eye', 'check', 'flag', 'clock', 'ask', 'layers', 'sparkle', 'lock', 'archive', 'bot', 'pin'];
  function columnsPane() {
    const cols = state.board?.columns || [];
    return `<h3>${esc(state.board?.name || '')} · columns</h3>
      ${cols.map((c, i) => `<div class="fcard ccard" data-col="${esc(c.id)}">
        <div class="srow"><button class="ficon icon-pick" data-cicon title="Icon">${icon(ICONS[c.icon] ? c.icon : 'board')}</button><button class="sw-btn ccolor" data-ccolor style="--c:${esc(c.color)}" title="Colour"></button><input class="inp lab" data-cname value="${esc(c.name)}"><span class="ccount" title="Tickets in this column">${c.itemIds.length}</span>
          <button class="icon-x" data-cmove="-1" ${i === 0 ? 'disabled' : ''} title="Move left">${icon('chev', 'cleft')}</button><button class="icon-x" data-cmove="1" ${i === cols.length - 1 ? 'disabled' : ''} title="Move right">${icon('chev', 'cright')}</button>
          <button class="icon-x" data-cdel ${c.itemIds.length ? 'disabled' : ''} title="${c.itemIds.length ? 'Delete|Move or archive its tickets first' : 'Delete column'}">${icon('x', 'sm')}</button></div>
        <div class="cflags">${COL_FLAGS.map(([k, label, tip]) => `<button class="toggle-chip ${c.flags[k] ? 'on' : ''}" data-cflag="${k}" title="${esc(label)}|${esc(tip)}">${esc(label)}</button>`).join('')}
          <label class="cnum" title="WIP limit|Hard cap on tickets in this column (0 = none)">WIP <input class="inp num" type="number" min="0" data-cwip value="${c.flags.wipLimit || 0}"></label>
          <label class="cnum" title="Auto-archive|Archive tickets that sit here this many days (0 = never)">archive after <input class="inp num" type="number" min="0" data-carch value="${c.flags.autoArchiveAfterDays || 0}"> d</label></div>
      </div>`).join('')}
      <div class="fadd"><input class="inp" data-newcol placeholder="New column, e.g. QA"><button class="btn primary sm" data-coladd>${icon('plus', 'sm')}Add</button></div>`;
  }
  async function columnCall(method, id, body) {
    try { await api(method, B(`/columns${id ? `/${encodeURIComponent(id)}` : ''}`), body); pulseSaved(); scheduleRefresh(0); }
    catch (e) { toast(e.message, { kind: 'error' }); }
  }
  function wireColumns(pane) {
    const colOf = (n) => state.board.columns.find((c) => c.id === n.closest('[data-col]')?.dataset.col);
    pane.addEventListener('click', (e) => {
      const c = colOf(e.target);
      const fl = e.target.closest('[data-cflag]');
      if (fl && c) { fl.classList.toggle('on'); columnCall('PATCH', c.id, { flags: { [fl.dataset.cflag]: fl.classList.contains('on') } }); return; }
      const mv = e.target.closest('[data-cmove]');
      if (mv && c) { const i = state.board.columns.indexOf(c); columnCall('PATCH', c.id, { position: i + Number(mv.dataset.cmove) }); return; }
      const cc = e.target.closest('[data-ccolor]');
      if (cc && c) { menu(cc, SWATCHES.map((col) => ({ label: col, color: col, run: () => columnCall('PATCH', c.id, { color: col }) }))); return; }
      const ci = e.target.closest('[data-cicon]');
      if (ci && c) { menu(ci, COL_ICONS.map((n) => ({ label: n, icon: n, cls: n === c.icon ? 'on' : '', run: () => columnCall('PATCH', c.id, { icon: n }) }))); return; }
      if (e.target.closest('[data-cdel]') && c && !c.itemIds.length) { columnCall('DELETE', c.id); return; }
      if (e.target.closest('[data-coladd]')) addColumn();
    });
    pane.addEventListener('change', (e) => {
      const c = colOf(e.target);
      if (!c) return;
      if (e.target.matches('[data-cname]')) { const v = e.target.value.trim(); if (v) columnCall('PATCH', c.id, { name: v }); else e.target.value = c.name; }
      if (e.target.matches('[data-cwip]')) columnCall('PATCH', c.id, { flags: { wipLimit: Math.max(0, Number(e.target.value) || 0) } });
      if (e.target.matches('[data-carch]')) columnCall('PATCH', c.id, { flags: { autoArchiveAfterDays: Math.max(0, Number(e.target.value) || 0) } });
    });
    pane.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-newcol]')) addColumn(); });
    const addColumn = async () => {
      const inp = $('[data-newcol]', pane);
      const name = inp.value.trim();
      if (!name) { inp.focus(); return; }
      await columnCall('POST', null, { name, color: SWATCHES[state.board.columns.length % SWATCHES.length], icon: 'layers', position: Math.max(0, state.board.columns.length - 1) });
      inp.value = '';
    };
  }

  async function templateCall(method, key, body) {
    try { await api(method, B(`/ticket-templates${key ? `/${encodeURIComponent(key)}` : ''}`), body); pulseSaved(); scheduleRefresh(0); }
    catch (e) { toast(e.message, { kind: 'error' }); }
  }

  function wireTemplates(pane) {
    const tplOf = (node) => { const k = node.closest('[data-tkey]')?.dataset.tkey; return k && state.board.ticketTemplates.find((t) => t.key === k); };
    pane.addEventListener('click', (e) => {
      const t = tplOf(e.target);
      const sb = e.target.closest('[data-tseg] button');
      if (sb && t) { sb.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === sb)); templateCall('PATCH', t.key, { [sb.parentElement.dataset.tseg]: sb.dataset.v || null }); return; }
      const dd = e.target.closest('[data-tdd]');
      if (dd && t) {
        const k = dd.dataset.tdd;
        const items = k === 'priority'
          ? [{ label: 'Default', icon: 'x', run: () => templateCall('PATCH', t.key, { priority: null }) }, ...PRIORITIES.map((p) => ({ label: p, color: PRIO_VAR[p], cls: p === t.priority ? 'on' : '', run: () => templateCall('PATCH', t.key, { priority: p }) }))]
          : [{ label: 'Where it is created', icon: 'x', run: () => templateCall('PATCH', t.key, { column: null }) }, ...state.board.columns.filter((c) => c.flags.allowCreate).map((c) => ({ label: c.name, color: c.color, cls: c.id === t.column || c.name === t.column ? 'on' : '', run: () => templateCall('PATCH', t.key, { column: c.id }) }))];
        menu(dd, items);
        return;
      }
      const ic = e.target.closest('[data-ticon]');
      if (ic && t) { menu(ic, ['issue', 'task', 'spike', 'sparkle', 'ask', 'flag', 'inbox', 'layers', 'eye', 'lock', 'clock', 'msg'].map((n) => ({ label: n, icon: n, cls: n === t.icon ? 'on' : '', run: () => templateCall('PATCH', t.key, { icon: n }) }))); return; }
      if (e.target.closest('[data-tdel]') && t) {
        templateCall('DELETE', t.key).then(() => toast(`Removed ${t.label}`, { icon: 'copy', action: 'Undo', onAction: () => templateCall('POST', null, t) }));
        return;
      }
      if (e.target.closest('[data-tpladd]')) addTemplate(pane);
    });
    pane.addEventListener('change', (e) => {
      const f = e.target.dataset.tf;
      const t = tplOf(e.target);
      if (!f || !t) return;
      const v = e.target.value.trim().replace(/^#/, '');
      if (f === 'label' && !v) { e.target.value = t.label; return; }
      templateCall('PATCH', t.key, { [f]: f === 'description' ? e.target.value : v || null });
    });
    pane.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-newtpl]')) addTemplate(pane); });
  }
  async function addTemplate(pane) {
    const inp = $('[data-newtpl]', pane);
    const label = inp.value.trim();
    if (!label) { inp.focus(); return; }
    await templateCall('POST', null, { label });
    inp.value = '';
  }

  async function schemaCall(method, path, body, undo) {
    try { await api(method, B(`/schema${path}`), body); pulseSaved(); scheduleRefresh(0); if (undo) toast(undo.msg, { icon: 'layers', action: 'Undo', onAction: undo.run }); }
    catch (e) { toast(e.message, { kind: 'error' }); state.modal?.refresh(); }
  }
  const fieldKey = (label) => { let k = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 38); if (!/^[a-z]/.test(k)) k = `f-${k}`; return k; };

  function wireFields(pane) {
    pane.addEventListener('click', (e) => {
      const card = e.target.closest('.fcard');
      const row = e.target.closest('[data-bi]');
      const key = card?.dataset.key;
      const f = key && schema().fields.find((x) => x.key === key);
      const segHit = e.target.closest('[data-uiseg] button, [data-stubseg] button');
      if (segHit) segHit.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === segHit));
      const uiBtn = e.target.closest('[data-uiseg] button');
      if (uiBtn) {
        if (row) schemaCall('PUT', '', { builtins: { [row.dataset.bi]: { ui: uiBtn.dataset.v } } });
        else if (f) schemaCall('PATCH', `/fields/${encodeURIComponent(key)}`, { ui: uiBtn.dataset.v });
        return;
      }
      const stubBtn = e.target.closest('[data-stubseg] button');
      if (stubBtn && f) { schemaCall('PATCH', `/fields/${encodeURIComponent(key)}`, { stub: stubBtn.dataset.v }); return; }
      const sw = e.target.closest('[data-bistub]');
      if (sw && row) { sw.classList.toggle('on'); schemaCall('PUT', '', { builtins: { [row.dataset.bi]: { stub: sw.classList.contains('on') } } }); return; }
      if (e.target.closest('[data-fdel]') && f) { schemaCall('DELETE', `/fields/${encodeURIComponent(key)}`, undefined, { msg: `Removed ${f.label}`, run: () => schemaCall('POST', '/fields', f) }); return; }
      const rm = e.target.closest('[data-orm]');
      if (rm && f) { schemaCall('PATCH', `/fields/${encodeURIComponent(key)}`, { options: f.options.filter((o) => o.value !== rm.dataset.orm) }); return; }
      const oc = e.target.closest('[data-ocolor]');
      if (oc && f) {
        menu(oc, SWATCHES.map((c) => ({ label: c, color: c, run: () => schemaCall('PATCH', `/fields/${encodeURIComponent(key)}`, { options: f.options.map((o) => (o.value === oc.dataset.ocolor ? { ...o, color: c } : o)) }) })));
        return;
      }
      const ft = e.target.closest('[data-ftype]');
      if (ft && f) {
        menu(ft, Object.keys(FIELD_ICON).map((t) => ({ label: t, icon: FIELD_ICON[t], cls: t === f.type ? 'on' : '',
          run: () => schemaCall('PATCH', `/fields/${encodeURIComponent(key)}`, { type: t, ...((t === 'enum' || t === 'tags') && !f.options?.length ? { options: t === 'enum' ? ['Option'] : [] } : {}) }) })));
        return;
      }
      const nt = e.target.closest('[data-newtype]');
      if (nt) {
        menu(nt, Object.keys(FIELD_ICON).map((t) => ({ label: t, icon: FIELD_ICON[t], cls: t === nt.dataset.type ? 'on' : '', run: () => { nt.dataset.type = t; nt.innerHTML = `${t}${icon('chev', 'sm')}`; } })));
        return;
      }
      if (e.target.closest('[data-newadd]')) addField(pane);
    });
    pane.addEventListener('change', (e) => {
      const t = e.target;
      const row = t.closest('[data-bi]');
      const key = t.closest('.fcard')?.dataset.key;
      if (t.matches('[data-bilabel]') && row) schemaCall('PUT', '', { builtins: { [row.dataset.bi]: { label: t.value.trim() } } });
      if (t.matches('[data-flabel]') && key && t.value.trim()) schemaCall('PATCH', `/fields/${encodeURIComponent(key)}`, { label: t.value.trim() });
      if (t.matches('[data-fmin], [data-fmax]') && key) schemaCall('PATCH', `/fields/${encodeURIComponent(key)}`, { [t.matches('[data-fmin]') ? 'min' : 'max']: t.value === '' ? null : Number(t.value) });
    });
    pane.addEventListener('keydown', (e) => {
      const t = e.target;
      if (e.key !== 'Enter') return;
      if (t.matches('[data-oadd]')) {
        const key = t.closest('.fcard').dataset.key;
        const f = schema().fields.find((x) => x.key === key);
        const v = t.value.trim();
        if (!v || f.options?.some((o) => o.value.toLowerCase() === v.toLowerCase())) return;
        const color = SWATCHES[(f.options?.length || 0) % SWATCHES.length];
        t.value = '';
        schemaCall('PATCH', `/fields/${encodeURIComponent(key)}`, { options: [...(f.options || []), { value: v, color }] });
        setTimeout(() => $(`.fcard[data-key="${CSS.escape(key)}"] [data-oadd]`, pane)?.focus(), 400);
      } else if (t.matches('[data-newlabel]')) addField(pane);
      else if (t.matches('input.inp')) t.blur();
    });
  }

  function addField(pane) {
    const input = $('[data-newlabel]', pane);
    const label = input.value.trim();
    if (!label) { input.focus(); return; }
    const type = $('[data-newtype]', pane).dataset.type;
    schemaCall('POST', '/fields', { key: fieldKey(label), label, type, stub: 'none', ...(type === 'enum' ? { options: ['Option'] } : {}) });
    input.value = '';
  }

  function agentPrompt() {
    return `Use the ${state.app.name} kanban at ${location.origin} (board "${state.boardId}") to coordinate work with me.\n`
      + `First read ${location.origin}/api/docs and follow it. Send the header "X-Agent: <your-name>" on every request.`;
  }

  function wirePane(t, pane, show) {
    if (t === 'fields' && !pane._fieldsWired) { pane._fieldsWired = true; wireFields(pane); }
    if (t === 'templates' && !pane._tplWired) { pane._tplWired = true; wireTemplates(pane); }
    if (t === 'columns' && !pane._colWired) { pane._colWired = true; wireColumns(pane); }
    pane.onclick = async (e) => {
      const uc = e.target.closest('[data-ucolor]');
      if (uc) { try { await api('PATCH', '/api/profiles/me', { color: uc.dataset.ucolor || null }); pulseSaved(); } catch (err) { toast(err.message, { kind: 'error' }); } return; }
      const kd = e.target.closest('[data-theme-kind]');
      if (kd) { lookKind = kd.dataset.themeKind; show('look', true); $(`[data-theme-kind="${lookKind}"]`, pane)?.focus(); return; }
      const th = e.target.closest("[data-pick-theme]");
      if (th) { switchTheme(th.dataset.pickTheme, e.clientX, e.clientY, () => show('look', true)); return; }
      const bg = e.target.closest('[data-bgfx]');
      if (bg) { settings.bg = bg.dataset.bgfx; saveSettings(); show('look', true); return; }
      const rs = e.target.closest('[data-reset]');
      if (rs) { settings[rs.dataset.reset] = 'theme'; saveSettings(); pulseSaved(); show(t, true); return; }
      const sb = e.target.closest('.seg[data-set] button, .opt-grid[data-set] button');
      if (sb) {
        const k = sb.parentElement.dataset.set;
        settings[k] = k === 'metrics' ? sb.dataset.v === 'on' : sb.dataset.v;
        saveSettings(); pulseSaved(); show(t, true);
        if (k === 'metrics') loadMetrics(true);
        return;
      }
      const s = e.target.closest('[data-sw]');
      if (s) {
        const k = s.dataset.sw;
        if (k === 'notify' && !settings.notify && 'Notification' in window && Notification.permission !== 'granted') {
          if (await Notification.requestPermission() !== 'granted') { show(t); return; }
        }
        settings[k] = !settings[k];
        saveSettings(); pulseSaved(); show(t);
        if (k === 'sound' && settings.sound) blip(false);
        return;
      }
      const st = e.target.closest('[data-stub]');
      if (st) { settings.stub[st.dataset.stub] = !settings.stub[st.dataset.stub]; saveSettings(); pulseSaved(); show(t, true); return; }
      if (e.target.closest('[data-copy]')) { navigator.clipboard?.writeText(agentPrompt()); toast('Copied', { icon: 'copy', kind: 'ok', timeout: 1500 }); }
    };
    pane.oninput = (e) => {
      const r = e.target.dataset.range;
      if (r) { paintRange(e.target); settings[r] = Number(e.target.value); applySettings(); updateOverflow(); }
    };
    pane.onchange = (e) => {
      if (e.target.dataset.range) { saveSettings(); pulseSaved(); }
      const k = e.target.dataset.text;
      if (k) { settings[k] = e.target.value.trim() || DEFAULTS[k]; saveSettings(); pulseSaved(); show(t, true); if (k === 'userName') refreshInbox(); }
      if (e.target.matches('[data-uglyph]')) api('PATCH', '/api/profiles/me', { glyph: e.target.value.trim() || null }).then(pulseSaved, (err) => toast(err.message, { kind: 'error' }));
    };
  }

  /* ═════════════════════════ tooltips ═════════════════════════ */
  // One themed tooltip for the whole app. Any element with title="Title|Explanation" (or data-tip) gets it:
  // the native title is moved aside on hover so the browser's own tooltip never appears.
  const tip = el('<div class="tip" role="tooltip"></div>');
  let tipTimer = null;
  let tipFor = null;
  let warmUntil = 0;
  function hideTip() {
    clearTimeout(tipTimer);
    if (tip.classList.contains('show')) warmUntil = Date.now() + 450;
    tip.classList.remove('show');
    tipFor = null;
  }
  function showTip(t) {
    if (!t.isConnected || drag || !t.dataset.tip) return;
    const [title, desc] = t.dataset.tip.split('|');
    tip.innerHTML = desc ? `<b>${esc(title)}</b><span>${esc(desc)}</span>` : `<b>${esc(title)}</b>`;
    tip.style.left = '0px';
    tip.style.top = '0px';
    const r = t.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let top = r.top - tr.height - 9;
    let place = 'top';
    if (top < 8) { top = r.bottom + 9; place = 'bottom'; }
    const left = clamp(r.left + r.width / 2 - tr.width / 2, 8, innerWidth - tr.width - 8);
    Object.assign(tip.style, { left: `${left}px`, top: `${top}px` });
    tip.style.setProperty('--ax', `${clamp(r.left + r.width / 2 - left, 12, tr.width - 12)}px`);
    tip.dataset.place = place;
    tip.classList.add('show');
  }
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest?.('[title], [data-tip]');
    if (!t || t === tipFor) return;
    if (t.hasAttribute('title')) { const v = t.getAttribute('title'); if (v) t.dataset.tip = v; t.removeAttribute('title'); }
    if (!t.dataset.tip) return;
    hideTip();
    tipFor = t;
    tipTimer = setTimeout(() => showTip(t), Date.now() < warmUntil ? 40 : 550);
  }, true);
  document.addEventListener('pointerout', (e) => { if (tipFor && !tipFor.contains(e.relatedTarget)) hideTip(); }, true);
  for (const ev of ['pointerdown', 'keydown', 'wheel']) addEventListener(ev, hideTip, true);
  addEventListener('scroll', hideTip, true);

  /* ═════════════════════════ keyboard + boot ═════════════════════════ */

  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input, textarea, select, [contenteditable]');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); togglePalette(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && state.modal?.kind === 'item') {
      e.preventDefault();
      if (document.activeElement?.matches('input, textarea')) document.activeElement.blur(); // commit the field being typed in
      setTimeout(() => saveDraft(state.modal), 0);
      return;
    }
    if (e.key === 'Escape') {
      if ($('.menu')) { closeMenus(); return; }
      if ($('.palette-scrim')) { closePalette(); return; }
      if (askOpen()) { closeAsk(true); return; }
      if ($('.lightbox')) { $('.lightbox').remove(); return; }
      if (state.modal) { if (typing) e.target.blur(); closeModal(); return; }
      if (state.bulk) { setBulk(false); return; }
      if (state.query) { $('#search').value = ''; state.query = ''; applyFilter(); $('#search').blur(); }
      return;
    }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
    if ((e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey && !e.altKey && !state.modal && !$('.palette-scrim')) { e.preventDefault(); openAsk(); }
    const m = state.modal;
    if (m?.kind === 'item' && m.rail && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const ids = needsIds();
      const i = ids.indexOf(m.id);
      const n = ids[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, ids.length - 1)];
      if (n && n !== m.id) { e.preventDefault(); m.switchTo(n); }
    }
  });

  addEventListener('hashchange', () => {
    const h = parseHash();
    if (h.board && h.board !== state.boardId) { closeModal(true); state.focusId = h.focus; loadBoard(h.board).catch((e) => toast(e.message, { kind: 'error' })); }
    else if (h.board && h.focus !== state.focusId) showFocus(h.focus, { push: false });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { saveSeen(); return; }
    scheduleRefresh(0);
    renderCatch();
    if (state.boardId) { seenFor(state.boardId).seq = state.seq; saveSeen(); }
  });
  addEventListener('beforeunload', saveSeen);

  async function boot() {
    document.body.append(tip);
    applySettings();
    buildChrome();
    try {
      Object.assign(state.app, await api('GET', '/api/app'));
      try { state.profiles = await api('GET', '/api/profiles'); } catch { /* none yet */ }
      await refreshBoards();
      const h = parseHash();
      state.focusId = h.focus;
      await loadBoard(h.board || state.app.defaultBoard || state.boards[0]?.id);
    } catch (e) {
      toast(`Can't reach the server · ${e.message}`, { kind: 'error', timeout: 10000 });
    }
    connect();
    refreshPresence();
    setInterval(() => { tickRings(); tickModal(); }, 1000);
    setInterval(fallbackPoll, 5000);
    setInterval(refreshPresence, 20000);
    setInterval(refreshListeners, 15000);
    refreshInbox();
  }
  boot();
})();
