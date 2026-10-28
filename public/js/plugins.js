// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* The Integrations section: the plugins on this board (INT-462), what each asks for, its connection, the actions it
   offers with who may run each, and every run with its approvals. Everything goes through /api/plugins; this page never
   sees a secret (the server sends "••••" and the last 4, and a secret is sent only when a new one is typed).
   Shape after the fork's deploy.js, made generic: one list, one form builder, whatever the plugin declares. */
import { $, $$, esc, icon } from './util.js';

export const PLUGIN_VIEWS = { connectors: ['deployDrawer', 'Connectors', 'link'], actions: ['actionsDrawer', 'Actions', 'play'], runs: ['runsDrawer', 'Runs', 'activity'] };

const enc = encodeURIComponent;
const STATE = { on: ['ok', 'On'], off: [null, 'Off'], changed: ['warn', 'Changed: switch on again'], crashed: ['danger', 'Crashed'], invalid: ['danger', 'Invalid'] };
const RUN_TONE = { succeeded: 'ok', failed: 'danger', timedout: 'danger', canceled: 'danger', rejected: 'danger', running: 'accent', waiting: 'warn' };
const SK = `<div class="ent-list" aria-busy="true">${'<div class="ent sk" aria-hidden="true"><i></i><b></b><b class="s"></b></div>'.repeat(3)}</div>`;

export function createPlugins({ api, toast, openDrawer, rel, nameOf, isOpen, openPerms }) {
  const S = { view: 'connectors', plugins: [], runs: [], body: null, form: null };
  const ago = (ts) => { const r = rel(ts); return !r ? '' : r === 'now' ? 'just now' : `${r} ago`; };
  const fail = (e) => toast(e.message + (e.data?.hint ? ` — ${e.data.hint}` : ''), { kind: 'error', wrap: true, timeout: 7000 });
  const get = (name) => S.plugins.find((p) => p.name === name);

  async function load() {
    [{ plugins: S.plugins }, { runs: S.runs }] = await Promise.all([api('GET', '/api/plugins'), api('GET', '/api/plugins/runs?top=40')]);
  }
  async function open(view = 'connectors') {
    S.view = PLUGIN_VIEWS[view] ? view : 'connectors';
    S.form = null;
    S.body = openDrawer(...PLUGIN_VIEWS[S.view]);
    S.body.innerHTML = SK;
    try { await load(); } catch (e) { S.body.innerHTML = `<div class="empty-note">${icon('play')}<span>${esc(e.message)}</span></div>`; return; }
    render();
  }
  function render() {
    if (!isOpen() || !S.body?.isConnected) return;
    const pane = S.body;
    pane.innerHTML = '<div class="dp-pane"></div>';
    const p = $('.dp-pane', pane);
    if (S.form) return S.form(p);
    ({ connectors: drawPlugins, actions: drawActions, runs: drawRuns })[S.view](p);
  }
  const back = () => { S.form = null; render(); };
  const reload = async () => { try { await load(); } catch (e) { return fail(e); } render(); };
  // a call that changes a plugin: toast what happened, then show the library as it is now
  async function act(method, path, body, ok) {
    try { const r = await api(method, path, body); if (ok) toast(ok, { kind: 'ok', icon: 'link' }); await load(); render(); return r; } catch (e) { fail(e); }
  }

  /* ─── one control per declared field: the board's own field types ─── */
  const opt = (o) => (typeof o === 'string' ? { value: o } : o);
  function control(f, value, { secret } = {}) {
    const a = `name="${esc(f.key)}" data-type="${esc(f.type)}" ${f.required && !secret ? 'required' : ''}`;
    const v = value ?? '';
    if (f.type === 'boolean') return `<label class="aa-check"><input type="checkbox" ${a} ${v === true ? 'checked' : ''}> <span>${esc(f.label || f.key)}</span></label>`;
    const label = `<span class="aa-label">${esc(f.label || f.key)}${f.required ? ' *' : ''}</span>`;
    const help = f.help ? `<span class="s">${esc(f.help)}</span>` : '';
    let inner;
    if (f.type === 'enum') inner = `<select class="inp" ${a}>${f.required ? '' : '<option value=""></option>'}${(f.options || []).map(opt).map((o) => `<option value="${esc(o.value)}" ${o.value === v ? 'selected' : ''}>${esc(o.label || o.value)}</option>`).join('')}</select>`;
    else if (f.type === 'markdown') inner = `<textarea class="inp" rows="3" ${a}>${esc(v)}</textarea>`;
    else if (secret) inner = `<input class="inp" type="password" autocomplete="new-password" ${a} placeholder="${esc(value || 'not set')}" spellcheck="false">`;
    else inner = `<input class="inp" ${a} type="${{ number: 'number', date: 'date', url: 'url' }[f.type] || 'text'}" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} value="${esc(Array.isArray(v) ? v.join(', ') : v)}" ${f.type === 'tags' ? 'placeholder="comma, separated"' : ''} spellcheck="false">`;
    return `<label>${label}${inner}${help}</label>`;
  }
  // The form back into values; a blank is left out (the server keeps a connection value left out), and `all` sends blanks as null
  function readValues(form, fields, { all = false } = {}) {
    const out = {};
    for (const f of fields) {
      const c = form.elements[f.key];
      if (!c) continue;
      let v = f.type === 'boolean' ? c.checked : c.value.trim();
      if (v === '') { if (all) out[f.key] = null; continue; }
      if (f.type === 'number') v = Number(v);
      if (f.type === 'tags') v = v.split(',').map((x) => x.trim()).filter(Boolean);
      out[f.key] = v;
    }
    return out;
  }

  /* ─── Connectors: the plugins ─── */
  const chip = (p) => { const [tone, label] = STATE[p.state] || [null, p.state]; return `<span class="chip" ${tone ? `style="background:color-mix(in oklab, var(--${tone}) 18%, transparent);color:var(--${tone})"` : ''}>${esc(label)}</span>`; };
  function drawPlugins(pane) {
    const rows = S.plugins.map((p) => {
      const c = p.connection;
      const line = [p.version && `v${esc(p.version)}`, c.fields?.length && (c.connected ? 'connected' : 'not connected'), p.runs?.waiting && `${p.runs.waiting} waiting for your OK`, p.state === 'crashed' && p.crashes?.lastError && esc(p.crashes.lastError)].filter(Boolean).join(' · ');
      return `<article class="ent${p.state === 'changed' || p.state === 'crashed' ? ' needs' : ''}" data-plugin="${esc(p.name)}">
        <span class="ent-lead ent-tile" data-tone="${p.state === 'on' ? 'ok' : p.state === 'off' ? 'muted' : 'danger'}">${icon(p.icon && /^[a-z-]+$/.test(p.icon) ? p.icon : 'link')}</span>
        <div class="ent-body"><h3 class="ent-title"><span class="ent-name">${esc(p.label || p.name)}</span> ${chip(p)}</h3><div class="ent-sub">${line}</div></div>
        <div class="ent-side"><div class="ent-acts"><button class="btn sm ghost" data-open>${p.state === 'on' ? 'Set up' : p.state === 'invalid' ? 'Problems' : 'Review'}</button></div></div>
      </article>`;
    }).join('');
    pane.innerHTML = `<form class="ent-bar dp-add" autocomplete="off">
        <input class="inp dp-grow" name="path" placeholder="Folder of a plugin: C:/plugins/slack" aria-label="Folder of a plugin" spellcheck="false">
        <button class="btn sm primary">${icon('plus', 'sm')}Add plugin</button>
        <label class="btn sm">or a .zip<input type="file" accept=".zip" hidden name="zip"></label></form>
      ${rows ? `<div class="ent-list"><div class="ent-lh">Plugins <span class="cnt">${S.plugins.length}</span></div>${rows}</div>`
        : `<div class="ent-empty">${icon('link')}<h3>No connectors yet</h3><p>A connector is a plugin: a folder or .zip you add here that connects the board to a service. Nothing runs until you switch it on.</p></div>`}`;
    const add = $('.dp-add', pane);
    const added = (p) => { toast(`${p.label || p.name} added: review what it asks for, then switch it on`, { kind: 'ok', icon: 'link' }); S.form = (x) => pluginView(x, p.name); reload(); };
    add.onsubmit = async (e) => {
      e.preventDefault();
      const path = add.path.value.trim();
      if (!path) return add.path.focus();
      try { added(await api('POST', '/api/plugins', { path })); } catch (err) { fail(err); }
    };
    add.zip.onchange = () => {
      const file = add.zip.files[0];
      if (!file) return;
      const r = new FileReader();
      r.onload = async () => { try { added(await api('POST', '/api/plugins', { zipBase64: String(r.result).split(',')[1], filename: file.name })); } catch (err) { fail(err); } };
      r.readAsDataURL(file);
    };
    pane.onclick = (e) => { const c = e.target.closest('[data-plugin]'); if (c && e.target.closest('[data-open]')) { S.form = (x) => pluginView(x, c.dataset.plugin); render(); } };
  }

  // One plugin: what it asks for (the human reads it before switching it on), its connection, on/off, remove
  function pluginView(pane, name) {
    const p = get(name);
    if (!p) return back();
    const a = p.asks || {};
    const asks = [
      ['Secrets it keeps', a.secrets], ['Hosts it talks to', a.hosts], ['Actions it offers', a.actions], ['Events it raises', a.events],
      ['Extra access', Object.entries(a.needs || {}).filter(([, v]) => (Array.isArray(v) ? v.length : v)).map(([k, v]) => (Array.isArray(v) ? `${k}: ${v.join(', ')}` : k))],
      ['A web hook at', a.webhook ? [a.webhook] : []],
    ].map(([l, v]) => `<div class="dp-ask"><b>${l}</b><span>${v?.length ? v.map((x) => `<code>${esc(x)}</code>`).join(' ') : 'none'}</span></div>`).join('');
    const fields = p.connection.fields || [];
    const on = p.state === 'on';
    pane.innerHTML = `<div class="dp-form">
      <div class="t">${icon('link', 'sm')} ${esc(p.label || p.name)} ${chip(p)}</div>
      ${p.description ? `<div class="s">${esc(p.description)}</div>` : ''}
      ${p.problems?.length ? `<div class="empty-note" role="alert">${icon('x')}<span>${p.problems.map(esc).join('<br>')}</span></div>` : ''}
      ${p.state === 'changed' ? `<div class="empty-note" role="alert">${icon('x')}<span>Its files changed since you switched it on, so it is stopped. Read what it asks for and switch it on again.</span></div>` : ''}
      <div class="aa-label">What it asks for</div><div class="dp-asks">${asks}</div>
      <div class="dp-bar">${on ? `<button type="button" class="btn sm" data-off>Switch off</button>` : p.state === 'invalid' ? '' : `<button type="button" class="btn sm primary" data-on>${icon('check', 'sm')}Allow this and switch on</button>`}<span class="dp-grow"></span><button type="button" class="btn sm danger" data-remove>${icon('trash', 'sm')}Remove</button></div>
      ${fields.length ? `<form class="dp-form dp-conn" autocomplete="off"><div class="aa-label">Connection</div>
        ${p.connection.test ? `<div class="s" role="status">Last test ${p.connection.test.ok ? 'passed' : 'failed'}: ${esc(p.connection.test.message || '')} ${esc(ago(p.connection.test.at))}</div>` : ''}
        ${fields.map((f) => control(f, p.connection.values?.[f.key], { secret: f.secret })).join('')}
        <div class="dp-bar"><button type="button" class="btn sm ghost" data-disconnect ${p.connection.connected ? '' : 'disabled'}>Disconnect</button><span class="dp-grow"></span><button type="button" class="btn sm" data-test ${on ? '' : 'disabled title="Switch it on to test"'}>Test</button><button class="btn sm primary">${icon('check', 'sm')}Save</button></div></form>` : ''}
      <div class="dp-bar"><button type="button" class="btn sm ghost" data-cancel>Back</button></div></div>`;
    const q = (s) => $(s, pane);
    const conn = q('.dp-conn');
    q('[data-cancel]').onclick = back;
    const onBtn = q('[data-on]');
    // the hash is the one the human just read: a changed folder answers PLUGIN_CHANGED and the page shows it again
    if (onBtn) onBtn.onclick = async () => { try { await api('POST', `/api/plugins/${enc(name)}/enable`, { hash: p.hash }); toast(`${p.label || name} is on`, { kind: 'ok', icon: 'link' }); await load(); render(); } catch (e) { fail(e); if (e.data?.code === 'PLUGIN_CHANGED') reload(); } };
    const offBtn = q('[data-off]');
    if (offBtn) offBtn.onclick = () => act('POST', `/api/plugins/${enc(name)}/disable`, {}, `${p.label || name} is off`);
    q('[data-remove]').onclick = async () => {
      if (!confirm(`Remove "${p.label || name}"? Its folder, connection and agents' grants of it go; past runs stay in the log.`)) return;
      try { const r = await api('DELETE', `/api/plugins/${enc(name)}`); toast(`Removed${r.grantsDropped?.length ? `; grants dropped for ${r.grantsDropped.join(', ')}` : ''}`, { kind: 'ok', icon: 'trash' }); S.form = null; await load(); render(); } catch (e) { fail(e); }
    };
    if (!conn) return;
    // a secret goes only when typed; a blank keeps what is saved
    conn.onsubmit = (e) => { e.preventDefault(); act('PUT', `/api/plugins/${enc(name)}/connection`, { values: readValues(conn, fields) }, 'Connection saved'); };
    q('[data-disconnect]').onclick = () => confirm('Disconnect? The saved values are cleared.') && act('DELETE', `/api/plugins/${enc(name)}/connection`, undefined, 'Disconnected');
    q('[data-test]').onclick = async () => {
      try { const r = await api('POST', `/api/plugins/${enc(name)}/connection/test`, { values: readValues(conn, fields) }); toast(r.message || (r.ok ? 'Connected' : 'Failed'), { kind: r.ok ? 'ok' : 'error', icon: 'link' }); } catch (err) { fail(err); }
    };
  }

  /* ─── Actions: what each plugin offers and who holds it ─── */
  function drawActions(pane) {
    const boxes = S.plugins.filter((p) => p.actions?.length).map((p) => `<div class="ent-list one-line"><div class="ent-lh">${esc(p.label || p.name)} ${chip(p)} <span class="cnt">${p.actions.length}</span></div>${p.actions.map((x) => {
      const who = x.holders?.length ? x.holders.map((h) => `<button type="button" class="chip" data-holder="${esc(h.name)}" title="Open ${esc(h.name)}'s permissions">${esc(nameOf(h.name))}${h.approve === 'human' ? ' · OK each' : ''}</button>`).join(' ') : '<span class="muted">nobody yet</span>';
      return `<article class="ent" data-plugin="${esc(p.name)}" data-action="${esc(x.id)}">
        <span class="ent-lead ent-tile" data-tone="accent">${icon('play')}</span>
        <div class="ent-body"><h3 class="ent-title"><span class="ent-name">${esc(x.label || x.id)}</span></h3><div class="ent-sub">${x.help ? `${esc(x.help)} · ` : ''}held by ${who}</div></div>
        <div class="ent-side"><div class="ent-acts"><button class="btn sm ghost" data-run ${p.state === 'on' ? '' : 'disabled title="Switch the plugin on first"'}>${icon('play', 'sm')}Run</button></div></div></article>`;
    }).join('')}</div>`).join('');
    pane.innerHTML = boxes || `<div class="ent-empty">${icon('play')}<h3>No actions yet</h3><p>Each plugin brings its actions. Agents and rules run the ones you grant them.</p></div>`;
    pane.onclick = (e) => {
      if (e.target.closest('[data-holder]')) return openPerms?.();
      const c = e.target.closest('[data-action]');
      if (c && e.target.closest('[data-run]')) { S.form = (x) => runForm(x, c.dataset.plugin, c.dataset.action); render(); }
    };
  }
  function runForm(pane, name, id) {
    const p = get(name), x = p?.actions.find((y) => y.id === id);
    if (!x) return back();
    pane.innerHTML = `<form class="dp-form" autocomplete="off"><div class="t">${icon('play', 'sm')} ${esc(x.label || x.id)} <span class="s">${esc(p.label || p.name)}</span></div>
      ${(x.inputs || []).map((f) => control(f, f.default)).join('')}
      <label><span class="aa-label">Ticket (optional)</span><input class="inp" name="__item" placeholder="INT-12" maxlength="40"></label>
      <div class="dp-bar"><span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('play', 'sm')}Run</button></div></form>`;
    const f = $('form', pane);
    $('[data-cancel]', f).onclick = back;
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', `/api/plugins/${enc(name)}/actions/${enc(id)}/run`, { inputs: readValues(f, x.inputs || []), item: f.elements.__item.value.trim() || undefined });
        toast(`${x.label || id} started`, { kind: 'ok', icon: 'play' });
        S.form = null; S.view = 'runs'; await open('runs');
      } catch (err) { fail(err); }
    };
  }

  /* ─── Runs ─── */
  function runHTML(r) {
    const tone = RUN_TONE[r.status] || 'muted';
    const who = r.by?.kind === 'agent' ? nameOf(r.by.name) : nameOf(r.by?.name) || 'you';
    const line = [esc(who), r.item && `<code>${esc(r.item)}</code>`, r.status === 'waiting' && 'waiting for your OK', r.error && esc(r.error), r.result?.message && esc(r.result.message)].filter(Boolean).join(' · ');
    const link = r.result?.url && /^https?:/.test(r.result.url) ? `<a class="btn sm ghost icon-only" href="${esc(r.result.url)}" target="_blank" rel="noopener noreferrer" title="Open" aria-label="Open the result">${icon('ext', 'sm')}</a>` : '';
    return `<article class="ent${r.status === 'waiting' ? ' needs' : ''}" data-run-id="${esc(r.id)}">
      <span class="ent-lead ent-tile" data-tone="${tone}" title="${esc(r.status)}">${icon(tone === 'ok' ? 'check' : tone === 'danger' ? 'x' : r.status === 'waiting' ? 'clock' : 'play')}</span>
      <div class="ent-body"><h3 class="ent-title"><span class="ent-name">${esc(r.plugin)} · ${esc(r.action)}</span></h3><div class="ent-sub">${line}</div></div>
      <div class="ent-side"><span class="ent-col when" title="${esc(new Date(r.startedAt || r.createdAt).toLocaleString())}">${esc(ago(r.startedAt || r.createdAt))}</span>
        <div class="ent-acts">${r.status === 'waiting' ? `<button class="btn sm primary" data-do="approve">${icon('check', 'sm')}Approve</button><button class="btn sm ghost" data-do="reject">Turn down</button>`
          : r.status === 'running' ? '<button class="btn sm ghost" data-do="cancel">Stop</button>' : link}</div></div></article>`;
  }
  function drawRuns(pane) {
    const waiting = S.runs.filter((r) => r.status === 'waiting'), rest = S.runs.filter((r) => r.status !== 'waiting');
    const box = (n, rows) => `<div class="ent-list"><div class="ent-lh">${n} <span class="cnt">${rows.length}</span></div>${rows.map(runHTML).join('')}</div>`;
    pane.innerHTML = `${waiting.length ? box('Waiting for you', waiting) : ''}${rest.length ? box('Recent runs', rest) : `<div class="ent-empty">${icon('activity')}<h3>No runs yet</h3><p>Run an action from its view, or let an agent or a rule run one.</p></div>`}`;
    pane.onclick = async (e) => {
      const b = e.target.closest('[data-do]'), c = b?.closest('[data-run-id]');
      if (!c) return;
      const verb = b.dataset.do;
      await act('POST', `/api/plugins/runs/${enc(c.dataset.runId)}/${verb}`, {}, { approve: 'Approved: it runs now', reject: 'Turned down', cancel: 'Stopping' }[verb]);
    };
  }

  // Live: a change to a plugin or a run redraws the view, unless a form is open (someone may be typing in it)
  function onEvent(ev) {
    if (!isOpen() || S.form || !ev.type?.startsWith('plugin.') || ev.type === 'plugin.event') return;
    clearTimeout(onEvent.t);
    onEvent.t = setTimeout(() => !S.form && reload(), 150);
  }

  return { open, onEvent };
}
