// One themed tooltip for the whole app. Any element with title="Title|Explanation" (or data-tip) gets it:
// the native title is moved aside on hover so the browser's own tooltip never appears.
import { el, esc, clamp } from './util.js';

export const tip = el('<div class="tip" role="tooltip"></div>');
let tipTimer = null;
let tipFor = null;
let warmUntil = 0;
// The page says whether a drag is on (no tooltip then); set by app.js.
let dragging = () => false;
export const tipPausedWhen = (fn) => { dragging = fn; };
// A button that took keyboard focus shows its tip at once.
export const focusTip = (t) => { hideTip(); tipFor = t; showTip(t); };
export function hideTip() {
  clearTimeout(tipTimer);
  if (tip.classList.contains('show')) warmUntil = Date.now() + 450;
  tip.classList.remove('show');
  tipFor = null;
}
function showTip(t) {
  if (!t.isConnected || dragging() || !t.dataset.tip) return;
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
