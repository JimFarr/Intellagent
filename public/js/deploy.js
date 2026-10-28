// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* The Integrations section: the connections (Azure DevOps, Jira), the actions they offer (Azure DevOps steps, Jira
   actions, and sequences of steps listed with them), and every run with its approvals. Everything goes through /api/deploy and /api/jira
   (lib/deploy, lib/jira on the server); this page never sees a token or password. The editors follow KM.Launchpad's (MIT): a step is a pipeline with its branch and values; a sequence
   asks for inputs, then runs steps in order, each value bound to an input, an earlier step's run or a literal. */
import { $, $$, esc, el, icon } from './util.js';

const SMART = '__smart__';
const TICKET = '__ticket__'; // the branch of the ticket a run is for (lib/deploy/store.ts)
const OUTPUTS = [['runId', 'run id'], ['buildNumber', 'build number'], ['tag', 'image tag (branch.build)'], ['branch', 'branch']];
const enc = encodeURIComponent;
let uid = 0;
const nid = (p) => `${p}-${++uid}`;
// An input's id is made from its name the way the server makes it, so a binding can name a new input before it is saved
const idOf = (name) => String(name).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 48);
const iid = (x) => x.id || idOf(x.name || '');

// A run reads as a headline in words ("Failed at build"), its steps as a pipeline: ✓ build → ▷ deploy.
const STATE = {
  succeeded: ['ok', 'check'], completed: ['ok', 'check'], failed: ['danger', 'x'], canceled: ['danger', 'x'], rejected: ['danger', 'x'],
  running: ['warn', 'play'], inProgress: ['warn', 'play'], waiting: ['warn', 'clock'], pending: [null, 'clock'], notStarted: [null, 'clock'], skipped: [null, 'chev'],
};
const toneOf = (s) => STATE[s] || [null, 'clock'];
// tones for a run's status (app.css data-tone): running is accent everywhere
const TONE = { succeeded: 'ok', completed: 'ok', failed: 'danger', canceled: 'danger', rejected: 'danger', running: 'accent', inProgress: 'accent', waiting: 'warn' };
const SK = `<div class="ent-list" aria-busy="true">${'<div class="ent sk" aria-hidden="true"><i></i><b></b><b class="s"></b></div>'.repeat(3)}</div>`;
const stepState = (s) => (s.state === 'completed' ? s.result || 'completed' : s.state);

export function createDeployments({ api, toast, openDrawer, rel, nameOf, menu, isOpen, openGrant }) {
  const S = { tab: null, view: null, status: null, jira: { connected: false }, jactions: [], jprojects: null, devstack: { connected: false }, dactions: [], confluence: { connected: false }, cactions: [], cspaces: null, pactions: [], prWatch: { projects: [] }, steps: [], seqs: [], runs: [], projects: null, pipelines: new Map(), details: new Map(), body: null };
  const ago = (ts) => { const r = rel(ts); return !r ? '' : r === 'now' ? 'just now' : `${r} ago`; };
  // how long a run took, short: 48s, 3m, 1h 5m
  const dur = (a, b) => { const s = a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 1000) : NaN; return !(s >= 0) ? '' : s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`; };
  const fail = (e) => toast(e.message + (e.data?.hint ? ` — ${e.data.hint}` : ''), { kind: 'error', wrap: true, timeout: 7000 });

  // Azure DevOps lookups, kept for the life of the page: the editors ask for the same ones again and again
  const projects = async () => (S.projects ||= await api('GET', '/api/deploy/projects'));
  async function pipelines(project) {
    if (!project) return [];
    if (!S.pipelines.has(project)) S.pipelines.set(project, api('GET', `/api/deploy/projects/${enc(project)}/pipelines`).catch((e) => { S.pipelines.delete(project); throw e; }));
    return S.pipelines.get(project);
  }
  async function detail(project, id) {
    if (!project || !id) return null;
    const k = `${project}/${id}`;
    if (!S.details.has(k)) S.details.set(k, api('GET', `/api/deploy/projects/${enc(project)}/pipelines/${enc(id)}`).catch((e) => { S.details.delete(k); throw e; }));
    return S.details.get(k);
  }
  const stepById = (id) => S.steps.find((s) => s.id === id);

  async function load() {
    const [status, steps, seqs, runs, jira, jactions, devstack, dactions, prWatch, confluence, cactions, pactions] = await Promise.all([
      api('GET', '/api/deploy'), api('GET', '/api/deploy/steps'), api('GET', '/api/deploy/sequences'), api('GET', '/api/deploy/runs?top=40'),
      api('GET', '/api/jira').catch(() => ({ connected: false })), api('GET', '/api/jira/actions').catch(() => []),
      api('GET', '/api/devstack').catch(() => ({ connected: false })), api('GET', '/api/devstack/actions').catch(() => []),
      api('GET', '/api/deploy/pr-watch').catch(() => ({ projects: [] })),
      api('GET', '/api/confluence').catch(() => ({ connected: false })), api('GET', '/api/confluence/actions').catch(() => []),
      api('GET', '/api/ado/actions').catch(() => []),
    ]);
    Object.assign(S, { status, steps, seqs, runs, jira, jactions, devstack, dactions, prWatch, confluence, cactions, pactions });
  }

  async function open(tab) {
    S.body = openDrawer('deployDrawer', 'Integrations', 'link');
    S.body.innerHTML = SK;
    S.view = null;
    try { await load(); } catch (e) { S.body.innerHTML = `<div class="empty-note">${icon('play')}<span>${esc(e.message)}</span></div>`; return; }
    // the views' old names (steps, sequences, settings) still land on their new ones
    S.tab = ({ steps: 'actions', sequences: 'actions', settings: 'connections' })[tab] || tab || S.tab || (connected().length ? 'runs' : 'connections');
    render();
  }

  function render() {
    if (!isOpen()) return;
    const waiting = S.runs.filter((r) => r.status === 'waiting').length;
    const tabs = [['connections', 'Connections', 'link', 0], ['actions', 'Actions', 'zap', 0], ['runs', 'Runs', 'activity', waiting]];
    const tabsHTML = tabs.map(([k, l, ic, n]) => `<button type="button" role="tab" data-dt="${k}" aria-selected="${S.tab === k}" class="${S.tab === k ? 'on' : ''}">${icon(ic, 'sm')}<span>${l}</span>${n ? `<span class="chip" style="background:color-mix(in oklab, var(--warn) 18%, transparent);color:var(--warn)">${n}</span>` : ''}</button>`).join('');
    // on the Integrations page the tabs are its picker, beside the page; elsewhere a tab bar above it
    const wrap = S.body.closest('.page-wrap');
    let nav = wrap && $(':scope > .page-nav', wrap);
    if (wrap && !nav) { nav = document.createElement('nav'); nav.className = 'page-nav dp-tabs'; nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', 'Integrations'); wrap.prepend(nav); }
    if (nav) nav.innerHTML = tabsHTML;
    // the page is titled after the view it shows (Runs, Steps…), with that view's icon
    const head = wrap && $('.page-head', wrap);
    const [, label, ic] = tabs.find(([k]) => k === S.tab);
    if (head) { $('.page-title', head).textContent = label; $('.page-ic', head).innerHTML = icon(ic); }
    S.body.innerHTML = `${nav ? '' : `<div class="seg dp-tabs" role="tablist" aria-label="Integrations">${tabsHTML}</div>`}<div class="dp-pane"></div>`;
    // a tab shows the library as it is now: an agent, a script or another tab may have changed it
    for (const b of $$('[data-dt]', nav || S.body)) b.onclick = () => { if (S.tab === b.dataset.dt && !S.view) return; S.tab = b.dataset.dt; S.view = null; render(); load().then(() => !S.view && render(), fail); };
    const pane = $('.dp-pane', S.body);
    if (S.view) return S.view(pane);
    ({ runs: drawRuns, actions: drawActions, connections: drawConnections })[S.tab](pane);
  }

  /* ─── Runs ─── */
  function runHTML(r) {
    const steps = r.steps || [];
    const broke = toneOf(r.status)[0] === 'danger' && steps.find((s) => toneOf(stepState(s))[0] === 'danger');
    const word = String(r.status || 'unknown');
    const head = `${word[0].toUpperCase()}${word.slice(1)}${r.status === 'failed' && broke ? ` at ${broke.name}` : ''}`;
    const who = esc(r.by?.kind === 'agent' ? nameOf(r.by.name) : nameOf(r.by?.name) || 'you');
    // one muted line: who, the values it ran with, the ticket, and for a sequence its steps; a failure says where
    const values = Object.entries(r.kind === 'sequence' ? r.inputs || {} : { ...(r.overrides?.branch ? { branch: r.overrides.branch } : {}), ...(r.overrides?.parameters || {}), ...(r.overrides?.variables || {}) })
      .map(([k, v]) => `${esc(k)} ${v === SMART ? 'smart' : v === TICKET ? 'the ticket\'s' : `<code>${esc(v)}</code>`}`).join(' · ');
    const chain = steps.length > 1 ? steps.map((s) => { const st = stepState(s); return `${esc(s.name)} ${TONE[st] === 'ok' ? '✓' : TONE[st] === 'danger' ? '✗' : TONE[st] === 'accent' ? '…' : ''}`.trim(); }).join(' → ') : '';
    const failed = [r.message, ...steps.filter((s) => s.message).map((s) => `${s.name}: ${s.message}`)].filter(Boolean)[0];
    const line = [who, values, r.item && `<code>${esc(r.item)}</code>`, chain, r.status === 'failed' && (failed ? esc(failed) : esc(head)), r.status === 'waiting' && 'waiting for your OK'].filter(Boolean).join(' · ');
    const jira = r.kind === 'jira' || r.kind === 'confluence';
    const ds = r.kind === 'devstack', pr = r.kind === 'ado';
    const link = r.kind === 'confluence' || pr ? r.url : jira ? r.issue && S.jira.url && `${S.jira.url}/browse/${r.issue}` : steps.find((s) => s.webUrl)?.webUrl;
    const tone = TONE[r.status] || 'muted';
    // a Jira or DevStack run is one call, or one long one: its message is the whole story (DevStack: where it is, then the verdict)
    const jline = (jira || ds || pr) && [who, r.item && `<code>${esc(r.item)}</code>`, ds && r.source && `<code>${esc(r.source)}</code>`, r.message ? esc(r.message) : r.issue && `<code>${esc(r.issue)}</code>`, r.status === 'waiting' && 'waiting for your OK'].filter(Boolean).join(' · ');
    return `<article class="ent${r.status === 'waiting' ? ' needs' : ''}" data-run="${esc(r.id)}">
      <span class="ent-lead ent-tile" data-tone="${tone}" title="${esc(head)}">${icon(tone === 'ok' ? 'check' : tone === 'danger' ? 'x' : r.status === 'waiting' ? 'clock' : 'play')}</span>
      <div class="ent-body"><h3 class="ent-title"><span class="ent-name">${esc(r.name)}</span></h3><div class="ent-sub">${jline || line}</div></div>
      <div class="ent-side">
        <span class="ent-col when" title="${esc(new Date(r.startedAt || r.createdAt).toLocaleString())}">${esc(ago(r.startedAt || r.createdAt))}</span>
        <span class="ent-col extra">${esc(dur(r.startedAt, r.finishedAt))}</span>
        <div class="ent-acts">${r.status === 'waiting' ? `<button class="btn sm primary" data-approve>${icon('check', 'sm')}Approve</button><button class="btn sm ghost" data-reject>Turn down</button>`
          : r.status === 'running' ? `<button class="btn sm ghost" data-stop title="${ds ? 'Stops the DevStack run; the stack is put back' : 'No further step starts; a pipeline already running carries on in Azure DevOps'}">Stop</button>`
          : link ? `<a class="btn sm ghost icon-only" href="${esc(link)}" target="_blank" rel="noopener noreferrer" title="Open in ${r.kind === 'confluence' ? 'Confluence' : jira ? 'Jira' : 'Azure DevOps'}">${icon('ext', 'sm')}</a>` : ''}</div>
      </div>
    </article>`;
  }
  function drawRuns(pane) {
    const waiting = S.runs.filter((r) => r.status === 'waiting');
    const rest = S.runs.filter((r) => r.status !== 'waiting');
    const box = (name, rows) => `<div class="ent-list"><div class="ent-lh">${name} <span class="cnt">${rows.length}</span></div>${rows.map(runHTML).join('')}</div>`;
    pane.innerHTML = `${waiting.length ? box('Waiting for you', waiting) : ''}
      ${rest.length ? box('Recent runs', rest) : `<div class="ent-empty">${icon('activity')}<h3>No runs yet</h3><p>Run an action or a sequence from its view, or let a rule run one.</p></div>`}`;
    pane.onclick = async (e) => {
      const card = e.target.closest('[data-run]');
      if (!card || e.target.closest('a')) return;
      const id = card.dataset.run;
      const act = e.target.closest('[data-approve]') ? 'approve' : e.target.closest('[data-reject]') ? 'reject' : e.target.closest('[data-stop]') ? 'cancel' : null;
      if (!act) return;
      try {
        await api('POST', `/api/deploy/runs/${enc(id)}/${act}`, {});
        toast({ approve: 'Approved: it runs now', reject: 'Turned down', cancel: 'Stopping: no further step starts' }[act], { kind: 'ok', icon: 'play' });
        await refreshRuns();
      } catch (err) { fail(err); }
    };
  }
  async function refreshRuns() {
    try { [S.runs, S.status] = await Promise.all([api('GET', '/api/deploy/runs?top=40'), api('GET', '/api/deploy')]); } catch { return; }
    if (S.tab === 'runs' && !S.view) render();
  }

  /* ─── shared editor bits ─── */
  const option = (v, label, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;
  const field = (label, inner, extra = '') => `<label ${extra}><span class="aa-label">${esc(label)}</span>${inner}</label>`;
  async function fillProjects(sel, current) {
    try {
      const list = await projects();
      sel.innerHTML = `${option('', 'Choose a project…', !current)}${list.map((p) => option(p.name, p.name, p.name === current)).join('')}`;
    } catch (e) { sel.innerHTML = option(current || '', current || 'Could not list projects', true); fail(e); }
  }
  async function fillPipelines(sel, project, current) {
    if (!project) { sel.innerHTML = option('', 'Choose a project first', true); sel.disabled = true; return; }
    sel.disabled = false;
    sel.innerHTML = option(current || '', 'Loading…', true);
    try {
      const list = await pipelines(project);
      sel.innerHTML = `${option('', 'Choose a pipeline…', !current)}${list.map((p) => option(p.id, `${p.folder ? `${p.folder}/` : ''}${p.name}${p.enabled ? '' : ' (disabled)'}`, String(p.id) === String(current))).join('')}`;
      searchable(sel, list);
    } catch (e) { sel.innerHTML = option(current || '', current ? `#${current}` : 'Could not list pipelines', true); fail(e); }
  }
  // Hundreds of pipelines: the list opens as a search (any words, of the name or folder) instead of the browser's own
  function searchable(sel, list) {
    const sorted = [...list].sort((a, b) => `${a.folder}/${a.name}`.localeCompare(`${b.folder}/${b.name}`));
    const items = () => sorted.map((p) => ({
      label: `${p.name}${p.enabled ? '' : ' (disabled)'}`, hint: p.folder || '', find: `${p.folder}/${p.name} #${p.id}`, cls: String(p.id) === sel.value ? 'on' : '',
      run: () => { sel.value = String(p.id); sel.dispatchEvent(new Event('change', { bubbles: true })); },
    }));
    const open = (e) => { e.preventDefault(); if (!sel.disabled) menu(sel, items(), { search: true, placeholder: `Search ${list.length} pipelines: name, folder or #id`, width: Math.max(sel.offsetWidth, 560), wide: true }); };
    sel.onmousedown = open;
    sel.onkeydown = (e) => { if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) open(e); };
  }
  // A branch picker: the pipeline's default, the ticket's own, the token owner's latest (smart), or a named branch
  const branchOptions = (branches, current, { allowDefault = true } = {}) => {
    const named = branches.map((b) => b.name);
    const extra = current && current !== SMART && current !== TICKET && !named.includes(current) ? [current] : [];
    return `${allowDefault ? option('', 'Pipeline default', !current) : ''}${option(TICKET, 'The ticket\'s branch: its branch field, or one that names it', current === TICKET)}${option(SMART, 'Smart: the token owner\'s latest branch', current === SMART)}${[...extra, ...named].map((n) => {
      const b = branches.find((x) => x.name === n);
      return option(n, `${n}${b?.mine ? ' ★' : ''}${b?.isDefault ? ' (default)' : ''}`, n === current);
    }).join('')}`;
  };
  // One control per pipeline value: a list for enums and booleans, a text box otherwise; empty = its default
  function valueControl(p, value, attrs) {
    const dv = p.defaultValue == null ? '' : ` (default ${p.defaultValue})`;
    if (p.allowedValues?.length || p.type === 'boolean') {
      const vals = p.allowedValues?.length ? p.allowedValues : ['true', 'false'];
      const extra = value && !vals.includes(value) ? [value] : [];
      return `<select class="inp" ${attrs}>${option('', `Default${dv}`, !value)}${[...extra, ...vals].map((v) => option(v, v, v === value)).join('')}</select>`;
    }
    return `<input class="inp" ${attrs} value="${esc(value ?? '')}" placeholder="${esc(`Default${dv}`.trim())}" spellcheck="false">`;
  }

  /* ─── Actions: Azure DevOps steps and Jira actions ─── */
  // A new action starts in the editor of a connected integration; its Connection list switches between them
  const EDITORS = { ado: (p) => stepEditor(p, null), adopr: (p) => prEditor(p, null), jira: (p) => jiraEditor(p, null), confluence: (p) => confluenceEditor(p, null), devstack: (p) => devstackEditor(p, null) };
  const connected = () => [['ado', 'Azure DevOps', S.status.connected], ['adopr', 'Azure DevOps pull requests', S.status.connected], ['jira', 'Jira', S.jira.connected], ['confluence', 'Confluence', S.confluence.connected], ['devstack', 'DevStack', S.devstack.connected]].filter((x) => x[2]);
  const newAction = (p) => EDITORS[connected()[0]?.[0] || 'jira'](p);
  // the Connection list of an editor: locked once the action exists (its id names its integration)
  const connField = (cur, locked) => field('Connection', `<select class="inp" data-conn ${locked ? 'disabled' : ''}>${(locked ? connected().filter((x) => x[0] === cur) : connected()).map(([k, l]) => option(k, l, k === cur)).join('') || option(cur, cur, true)}</select>`);
  const wireConn = (f, cur) => { const c = $('[data-conn]', f); if (c) c.onchange = () => { if (c.value !== cur) { S.view = EDITORS[c.value]; render(); } }; };
  function drawActions(pane) {
    // one row each: what it does, who may run it (opens Assignments), and Run / Edit
    const none = (what) => `<div class="ent-empty"><p>${what} is not connected. <button class="btn sm" data-go-conn>Connect it</button></p></div>`;
    pane.innerHTML = `<div class="ent-bar"><button class="btn sm primary" data-new ${connected().length ? '' : 'disabled title="Connect Azure DevOps, Jira or the DevStack first"'}>${icon('plus', 'sm')}New action</button>${S.status.connected ? `<button class="btn sm" data-new-seq ${S.steps.length ? '' : 'disabled title="Add an Azure DevOps action first: a sequence chains them"'}>${icon('layers', 'sm')}New sequence</button>` : ''}</div>
      <div class="ent-list one-line"><div class="ent-lh">Azure DevOps <span class="cnt">${S.steps.length + S.seqs.length + S.pactions.length}</span></div>${S.status.connected || S.steps.length || S.seqs.length || S.pactions.length ? `${drawStepsBox()}${seqRowsHTML()}${drawPrBox()}` : none('Azure DevOps')}</div>
      <div class="ent-list one-line" style="margin-top:16px"><div class="ent-lh">Jira <span class="cnt">${S.jactions.length}</span></div>${S.jira.connected || S.jactions.length ? drawJiraBox() : none('Jira')}</div>
      <div class="ent-list one-line" style="margin-top:16px"><div class="ent-lh">Confluence <span class="cnt">${S.cactions.length}</span></div>${S.confluence.connected || S.cactions.length ? drawConfluenceBox() : none('Confluence')}</div>
      <div class="ent-list one-line" style="margin-top:16px"><div class="ent-lh">DevStack <span class="cnt">${S.dactions.length}</span></div>${S.devstack.connected || S.dactions.length ? drawDevstackBox() : none('The DevStack')}</div>`;
    wireActions(pane);
  }
  const CDOES = { create: 'Create a page', append: 'Append to a page', section: 'Replace a section' };
  function drawConfluenceBox() {
    return S.cactions.map((a) => {
      const where = a.does === 'create' ? `in ${esc(a.space)}${a.parent ? ` under page ${esc(a.parent)}` : ''} · titled <code>${esc(a.title)}</code>` : `${a.does === 'section' ? `"${esc(a.heading)}" on ` : ''}${a.page === 'ask' ? 'a page given when it runs' : `page ${esc(a.pageId)}`}`;
      const line = [CDOES[a.does], where, a.text ? 'its own text' : 'text given when it runs'].join(' · ');
      return `<article class="ent" data-confluence="${esc(a.id)}">
        <span class="ent-lead ent-tile" data-tone="accent" title="Confluence">${icon('text')}</span>
        <div class="ent-body"><h3 class="ent-title"><span class="ent-name">${esc(a.name)}</span></h3><div class="ent-sub">${line}</div></div>
        <div class="ent-side">${holdersCol(a)}<div class="ent-acts"><button class="btn sm ghost" data-run>${icon('play', 'sm')}Run</button><button class="btn sm ghost" data-edit>Edit</button></div></div></article>`;
    }).join('') || '<div class="ent-empty"><p>No Confluence actions yet: one creates a page, appends to one, or replaces a section of one, from markdown.</p></div>';
  }
  const DTOOL = { gate: 'PR gate', test: 'Tests by tag' };
  function drawDevstackBox() {
    return S.dactions.map((a) => {
      const what = a.tool === 'gate' ? (a.kind === 'behaviour' ? 'the affected tests' : 'A/B, then the full regression') : `tags ${a.tags.map(esc).join(', ')}`;
      const line = [DTOOL[a.tool], esc(a.service), what, `<code>${esc(a.source)}</code>`].join(' · ');
      return `<article class="ent" data-devstack="${esc(a.id)}">
        <span class="ent-lead ent-tile" data-tone="ok" title="DevStack">${icon('flask')}</span>
        <div class="ent-body"><h3 class="ent-title"><span class="ent-name">${esc(a.name)}</span></h3><div class="ent-sub">${line}</div></div>
        <div class="ent-side">${holdersCol(a)}<div class="ent-acts"><button class="btn sm ghost" data-run>${icon('play', 'sm')}Run</button><button class="btn sm ghost" data-edit>Edit</button></div></div></article>`;
    }).join('') || '<div class="ent-empty"><p>No DevStack actions yet: one runs the PR gate or a tagged suite on a ticket\'s build.</p></div>';
  }
  function drawStepsBox() {
    return `${S.steps.map((s) => {
        const vals = Object.entries({ ...s.templateParameters, ...s.variables }).map(([k, v]) => `${esc(k)} <code>${esc(v)}</code>`).join(' · ');
        const branch = s.branch === SMART ? 'smart branch' : s.branch === TICKET ? 'the ticket\'s branch' : s.branch ? `<code>${esc(s.branch)}</code>` : 'default branch';
        const line = [esc(s.pipelineName || `#${s.pipelineId}`), esc(s.project), branch, vals, s.usedBy?.length && `in ${s.usedBy.map(esc).join(', ')}`].filter(Boolean).join(' · ');
        return `<article class="ent" data-step="${esc(s.id)}">
          <span class="ent-lead ent-tile" data-tone="muted" title="Azure DevOps">${icon('play')}</span>
          <div class="ent-body"><h3 class="ent-title"><span class="ent-name">${esc(s.name)}</span></h3><div class="ent-sub">Run pipeline · ${line}</div></div>
          <div class="ent-side">${holdersCol(s)}<div class="ent-acts"><button class="btn sm ghost" data-run>${icon('play', 'sm')}Run</button><button class="btn sm ghost" data-edit>Edit</button></div></div></article>`;
      }).join('') || '<div class="ent-empty"><p>No Azure DevOps actions yet: one runs a pipeline with its branch and values.</p></div>'}`;
  }
  const PRDOES = { reply: 'Reply on the thread', resolve: 'Resolve the thread', comment: 'Comment on the PR', approve: 'Approve the PR' };
  const PRSTATUS = { fixed: 'Fixed', wontFix: 'Won\'t fix', closed: 'Closed' };
  function drawPrBox() {
    return S.pactions.map((a) => {
      const text = a.does === 'approve' ? 'as the token\'s owner' : a.text ? 'its own text' : a.does !== 'resolve' && 'text given when it runs';
      const line = [PRDOES[a.does], a.does === 'resolve' && `as <b>${esc(PRSTATUS[a.status] || a.status)}</b>`, text, 'on the PR a rule or the ticket names'].filter(Boolean).join(' · ');
      return `<article class="ent" data-prx="${esc(a.id)}">
        <span class="ent-lead ent-tile" data-tone="muted" title="Azure DevOps pull request">${icon(a.does === 'approve' ? 'check' : 'msg')}</span>
        <div class="ent-body"><h3 class="ent-title"><span class="ent-name">${esc(a.name)}</span></h3><div class="ent-sub">${line}</div></div>
        <div class="ent-side">${holdersCol(a)}<div class="ent-acts"><button class="btn sm ghost" data-run>${icon('play', 'sm')}Run</button><button class="btn sm ghost" data-edit>Edit</button></div></div></article>`;
    }).join('');
  }
  const JDOES = { transition: 'Move issue to status', comment: 'Comment on issue', assign: 'Assign issue', create: 'Create issue' };
  const jIssue = (a) => (a.does === 'create' ? `in ${esc(a.project)}` : a.issue === 'fixed' ? `<code>${esc(a.key)}</code>` : a.issue === 'ask' ? 'asks for the issue' : 'the ticket\'s Jira issue');
  function drawJiraBox() {
    return S.jactions.map((a) => {
      const what = a.does === 'transition' ? `<b>${esc(a.status)}</b>` : a.does === 'assign' ? (a.assignee ? `to ${esc(a.assignee)}` : 'unassigns') : a.does === 'comment' ? (a.text ? '' : 'asks for the text') : esc(a.issueType);
      const line = [JDOES[a.does], what, jIssue(a)].filter(Boolean).join(' · ');
      return `<article class="ent" data-jira="${esc(a.id)}">
        <span class="ent-lead ent-tile" data-tone="accent" title="Jira">${icon('issue')}</span>
        <div class="ent-body"><h3 class="ent-title"><span class="ent-name">${esc(a.name)}</span></h3><div class="ent-sub">${line}</div></div>
        <div class="ent-side">${holdersCol(a)}<div class="ent-acts"><button class="btn sm ghost" data-run>${icon('play', 'sm')}Run</button><button class="btn sm ghost" data-edit>Edit</button></div></div></article>`;
    }).join('') || '<div class="ent-empty"><p>No Jira actions yet: one moves, comments on, assigns or creates an issue.</p></div>';
  }
  function wireActions(pane) {
    $('[data-new]', pane).onclick = () => { S.view = newAction; render(); };
    const newSeq = $('[data-new-seq]', pane);
    if (newSeq) newSeq.onclick = () => { S.view = (p) => seqEditor(p, null); render(); };
    pane.onclick = (e) => {
      if (grantClick(e)) return;
      const qcard = e.target.closest('[data-seq]');
      const q = qcard && S.seqs.find((x) => x.id === qcard.dataset.seq);
      if (q && e.target.closest('[data-edit]')) { S.view = (p) => seqEditor(p, q); render(); return; }
      if (q && e.target.closest('[data-run]')) { S.view = (p) => seqRunner(p, q); render(); return; }
      if (e.target.closest('[data-go-conn]')) { S.tab = 'connections'; render(); return; }
      const card = e.target.closest('[data-step]');
      const s = card && stepById(card.dataset.step);
      const jcard = e.target.closest('[data-jira]');
      const j = jcard && S.jactions.find((x) => x.id === jcard.dataset.jira);
      if (s && e.target.closest('[data-edit]')) { S.view = (p) => stepEditor(p, s); render(); }
      if (s && e.target.closest('[data-run]')) { S.view = (p) => stepRunner(p, s); render(); }
      if (j && e.target.closest('[data-edit]')) { S.view = (p) => jiraEditor(p, j); render(); }
      if (j && e.target.closest('[data-run]')) { S.view = (p) => jiraRunner(p, j); render(); }
      const ccard = e.target.closest('[data-confluence]');
      const c = ccard && S.cactions.find((x) => x.id === ccard.dataset.confluence);
      if (c && e.target.closest('[data-edit]')) { S.view = (p) => confluenceEditor(p, c); render(); }
      if (c && e.target.closest('[data-run]')) { S.view = (p) => confluenceRunner(p, c); render(); }
      const xcard = e.target.closest('[data-prx]');
      const x = xcard && S.pactions.find((y) => y.id === xcard.dataset.prx);
      if (x && e.target.closest('[data-edit]')) { S.view = (p) => prEditor(p, x); render(); }
      if (x && e.target.closest('[data-run]')) { S.view = (p) => prRunner(p, x); render(); }
      const dcard = e.target.closest('[data-devstack]');
      const d = dcard && S.dactions.find((x) => x.id === dcard.dataset.devstack);
      if (d && e.target.closest('[data-edit]')) { S.view = (p) => devstackEditor(p, d); render(); }
      if (d && e.target.closest('[data-run]')) { S.view = (p) => devstackRunner(p, d); render(); }
    };
  }

  // The values section of a step: one row per parameter and overridable variable the pipeline declares, plus
  // any other name typed by hand (a pipeline whose YAML we couldn't read).
  function valuesHTML(d, tps = {}, vars = {}) {
    const params = (d?.parameters || []).filter((p) => p.kind === 'parameter');
    const variables = (d?.parameters || []).filter((p) => p.kind === 'variable' && p.allowOverride);
    const known = new Set([...params.map((p) => `p:${p.name}`), ...variables.map((p) => `v:${p.name}`)]);
    const extra = [...Object.entries(tps).filter(([k]) => !known.has(`p:${k}`)).map(([k, v]) => ['parameter', k, v]), ...Object.entries(vars).filter(([k]) => !known.has(`v:${k}`)).map(([k, v]) => ['variable', k, v])];
    const row = (p, kind, v) => field(`${p.name}${kind === 'variable' ? ' (variable)' : ''}`, valueControl(p, v, `data-val="${kind}" data-name="${esc(p.name)}"`));
    return `${params.length || variables.length ? `<div class="dp-grid">${params.map((p) => row(p, 'parameter', tps[p.name])).join('')}${variables.map((p) => row(p, 'variable', vars[p.name])).join('')}</div>`
      : `<div class="s">${d ? 'This pipeline declares no parameters we could read. Add them by name below.' : ''}</div>`}
      <div class="dp-extra">${extra.map(([kind, k, v]) => extraRow(kind, k, v)).join('')}</div>
      <button type="button" class="btn sm ghost" data-add-extra>${icon('plus', 'sm')}Add a value by name</button>`;
  }
  const extraRow = (kind = 'parameter', name = '', value = '') => `<div class="dp-row dp-x"><select class="inp" data-x-kind style="width:auto">${option('parameter', 'parameter', kind === 'parameter')}${option('variable', 'variable', kind === 'variable')}</select><input class="inp dp-grow" data-x-name placeholder="name" value="${esc(name)}" spellcheck="false"><input class="inp dp-grow" data-x-value placeholder="value" value="${esc(value)}" spellcheck="false"><button type="button" class="btn sm ghost" data-x-del title="Remove">${icon('x', 'sm')}</button></div>`;
  function readValues(root) {
    const tps = {}, vars = {};
    for (const c of $$('[data-val]', root)) if (c.value !== '') (c.dataset.val === 'variable' ? vars : tps)[c.dataset.name] = c.value;
    for (const r of $$('.dp-x', root)) {
      const k = $('[data-x-name]', r).value.trim();
      if (k) ($('[data-x-kind]', r).value === 'variable' ? vars : tps)[k] = $('[data-x-value]', r).value;
    }
    return { tps, vars };
  }
  function wireValues(root) {
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-add-extra]')) $('.dp-extra', root).append(el(extraRow()));
      if (e.target.closest('[data-x-del]')) e.target.closest('.dp-x').remove();
    });
  }

  function stepEditor(pane, s) {
    const st = { project: s?.project || '', pipelineId: s?.pipelineId || '', detail: null };
    pane.innerHTML = `<form class="dp-form" autocomplete="off">
      ${!s && connected().length > 1 ? connField('ado', false) : ''}
      <div class="dp-grid">${field('Name', `<input class="inp" name="name" required maxlength="80" value="${esc(s?.name || '')}" placeholder="Deploy placement">`)}
        ${field('Short label (optional)', `<input class="inp" name="alias" maxlength="40" value="${esc(s?.alias || '')}" placeholder="deploy">`)}</div>
      ${s ? `<div class="s">id <code>${esc(s.id)}</code>: grants use it, and it never changes</div>` : ''}
      <div class="dp-grid">${field('Project', '<select class="inp" name="project"></select>')}${field('Pipeline', '<select class="inp" name="pipeline"></select>')}</div>
      ${field('Branch', '<select class="inp" name="branch"><option value="">Pipeline default</option></select>')}
      <div class="aa-label">Values to pass</div><div class="dp-values"><div class="s">Choose a pipeline to see what it takes.</div></div>
      <div class="dp-bar">${s ? `<button type="button" class="btn sm danger" data-del>${icon('trash', 'sm')}Delete</button>` : ''}<span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('check', 'sm')}${s ? 'Save' : 'Add action'}</button></div></form>`;
    const f = $('form', pane);
    wireConn(f, 'ado');
    const pSel = $('[name="project"]', f), plSel = $('[name="pipeline"]', f), bSel = $('[name="branch"]', f), vals = $('.dp-values', f);
    wireValues(vals);
    async function loadDetail(keepValues) {
      const cur = keepValues ? readValues(vals) : { tps: s?.templateParameters || {}, vars: s?.variables || {} };
      st.detail = null;
      if (!st.pipelineId) { vals.innerHTML = '<div class="s">Choose a pipeline to see what it takes.</div>'; return; }
      vals.innerHTML = '<div class="s">Reading the pipeline…</div>';
      try { st.detail = await detail(st.project, st.pipelineId); } catch (e) { fail(e); }
      bSel.innerHTML = branchOptions(st.detail?.branches || [], bSel.value || s?.branch || '');
      vals.innerHTML = valuesHTML(st.detail, cur.tps, cur.vars);
    }
    pSel.onchange = async () => { st.project = pSel.value; st.pipelineId = ''; await fillPipelines(plSel, st.project, ''); loadDetail(true); };
    plSel.onchange = () => { st.pipelineId = plSel.value; loadDetail(true); };
    fillProjects(pSel, st.project);
    fillPipelines(plSel, st.project, st.pipelineId).then(() => loadDetail(false));
    $('[data-cancel]', f).onclick = () => { S.view = null; render(); };
    const del = $('[data-del]', f);
    if (del) del.onclick = async () => {
      if (!confirm(`Delete "${s.name}"? Agents' grants of it go too.`)) return;
      try { await api('DELETE', `/api/deploy/steps/${enc(s.id)}`); toast('Action deleted', { kind: 'ok' }); S.view = null; await load(); render(); } catch (e) { fail(e); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const { tps, vars } = readValues(vals);
      const body = { name: f.elements.name.value, alias: f.elements.alias.value, project: pSel.value, pipelineId: Number(plSel.value), pipelineName: plSel.selectedOptions[0]?.textContent.split('/').pop().replace(/ \(disabled\)$/, ''), branch: bSel.value, templateParameters: tps, variables: vars };
      try {
        await api(s ? 'PUT' : 'POST', s ? `/api/deploy/steps/${enc(s.id)}` : '/api/deploy/steps', body);
        toast(s ? 'Action saved' : 'Action added', { kind: 'ok', icon: 'play' });
        S.view = null; await load(); render();
      } catch (err) { fail(err); }
    };
  }

  // Run a step: its own values, changed for this run only
  function stepRunner(pane, s) {
    pane.innerHTML = `<form class="dp-form" autocomplete="off"><div class="t">${icon('play', 'sm')} Run ${esc(s.name)}</div>
      <div class="s">${esc(`${s.pipelineName || `#${s.pipelineId}`} · ${s.project}`)}. Changes here are for this run only.</div>
      ${field('Branch', `<select class="inp" name="branch">${branchOptions([], s.branch || '')}</select>`)}
      <div class="dp-values"><div class="s">Reading the pipeline…</div></div>
      ${field('Ticket (optional)', '<input class="inp" name="item" placeholder="INT-12" maxlength="40">')}
      <div class="dp-bar"><span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('play', 'sm')}Run</button></div></form>`;
    const f = $('form', pane), vals = $('.dp-values', f);
    wireValues(vals);
    detail(s.project, s.pipelineId).catch((e) => { fail(e); return null; }).then((d) => {
      f.branch.innerHTML = branchOptions(d?.branches || [], s.branch || '');
      vals.innerHTML = valuesHTML(d, s.templateParameters, s.variables);
    });
    $('[data-cancel]', f).onclick = () => { S.view = null; render(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const { tps, vars } = readValues(vals);
      // send only what differs from the step, so the run's record shows what was changed for it
      const diff = (a, b) => Object.fromEntries(Object.entries(a).filter(([k, v]) => b?.[k] !== v));
      try {
        await api('POST', `/api/deploy/steps/${enc(s.id)}/run`, { ...(f.branch.value !== (s.branch || '') ? { branch: f.branch.value } : {}), parameters: diff(tps, s.templateParameters), variables: diff(vars, s.variables), item: f.item.value.trim() || undefined });
        toast(`${s.name} started`, { kind: 'ok', icon: 'play' });
        S.view = null; S.tab = 'runs'; await refreshRuns(); render();
      } catch (err) { fail(err); }
    };
  }

  /* ─── Sequences: Azure DevOps steps in order, listed with the steps under Azure DevOps ─── */
  function seqRowsHTML() {
    return S.seqs.map((q) => {
      const chain = q.items.map((x) => esc(stepById(x.stepId)?.alias || stepById(x.stepId)?.name || x.stepId)).join(' → ');
      const line = [chain, q.inputs.length ? `asks for ${esc(q.inputs.map((x) => x.name).join(', '))}` : ''].filter(Boolean).join(' · ');
      return `<article class="ent" data-seq="${esc(q.id)}">
        <span class="ent-lead ent-tile" data-tone="muted" title="Azure DevOps sequence">${icon('layers')}</span>
        <div class="ent-body"><h3 class="ent-title"><span class="ent-name">${esc(q.name)}</span></h3><div class="ent-sub">Sequence · ${line}</div></div>
        <div class="ent-side">${holdersCol(q)}<div class="ent-acts"><button class="btn sm ghost" data-run>${icon('play', 'sm')}Run</button><button class="btn sm ghost" data-edit>Edit</button></div></div></article>`;
    }).join('');
  }

  function seqEditor(pane, q) {
    // the model is the editor's own copy; the DOM is read back into it before anything re-draws
    const m = { name: q?.name || '', inputs: structuredClone(q?.inputs || []), items: structuredClone(q?.items || [{ stepId: S.steps[0]?.id }]) };
    const dl = nid('dl');
    pane.innerHTML = `<form class="dp-form" autocomplete="off"></form>`;
    const f = $('form', pane);
    function read() {
      m.name = $('[name="name"]', f)?.value ?? m.name;
      $$('[data-input]', f).forEach((r, i) => {
        const x = m.inputs[i];
        Object.assign(x, { name: $('[data-i="name"]', r).value, kind: $('[data-i="kind"]', r).value, default: $('[data-i="default"]', r).value || undefined });
        for (const k of ['sourceProject', 'sourcePipelineId', 'sourceParameter']) { const c = $(`[data-i="${k}"]`, r); if (c) x[k] = c.value || undefined; }
      });
      $$('[data-item]', f).forEach((r, i) => {
        const x = m.items[i];
        x.stepId = $('[data-it="step"]', r).value;
        const b = $('[data-it="branch"]', r).value;
        const prevBranch = x.branch;
        delete x.branch; delete x.branchInputId;
        // a field that a choice brings (the custom branch, a fixed value) is not there yet on the read that follows
        // the choice: an empty one keeps the mode, and the next draw shows the field
        if (b.startsWith('input:')) x.branchInputId = b.slice(6); else if (b === 'custom') x.branch = $('[data-it="branchText"]', r)?.value.trim() ?? prevBranch ?? '';
        x.bindings = $$('[data-bind]', r).map((g) => {
          const src = $('[data-b="src"]', g).value;
          const [kind, ...rest] = src.split(':');
          return { target: $('[data-b="target"]', g).value, name: $('[data-b="name"]', g).value.trim(), kind, ref: kind === 'literal' ? $('[data-b="literal"]', g)?.value ?? '' : rest.join(':') };
        });
        const lm = $('[data-it="linkMode"]', r)?.value;
        // the key and value fields appear only once a mode is picked: read what is there
        x.link = lm && lm !== 'none' ? { mode: lm, key: $('[data-it="linkKey"]', r)?.value.trim() ?? x.link?.key ?? '', source: $('[data-it="linkSource"]', r)?.value || x.link?.source || 'runId' } : undefined;
      });
    }
    function draw() {
      const branchInputs = m.inputs.filter((x) => x.name);
      f.innerHTML = `${field('Name', `<input class="inp" name="name" required maxlength="80" value="${esc(m.name)}" placeholder="Ship placement">`)}
        ${q ? `<div class="s">id <code>${esc(q.id)}</code>: grants can name it as sequence=${esc(q.id)}</div>` : ''}
        <div class="aa-label">Inputs (asked for when it runs)</div>
        ${m.inputs.map((x, i) => `<div class="dp-card" data-input>
          <div class="dp-grid">${field('Name', `<input class="inp" data-i="name" value="${esc(x.name || '')}" placeholder="Environment">`)}
            ${field('Kind', `<select class="inp" data-i="kind">${option('value', 'A value', x.kind === 'value')}${option('branch', 'A branch', x.kind === 'branch')}${option('environment', 'An environment (from a pipeline parameter)', x.kind === 'environment')}</select>`)}
            ${field('Default', `<input class="inp" data-i="default" value="${esc(x.default || '')}" list="${dl}-i${i}" placeholder="${x.kind === 'branch' ? 'empty: the step\'s own' : ''}" spellcheck="false"><datalist id="${dl}-i${i}"></datalist>`)}</div>
          ${x.kind !== 'value' ? `<div class="dp-grid">${field('Offer values from project', `<select class="inp" data-i="sourceProject" data-cur="${esc(x.sourceProject || '')}"></select>`)}
            ${field('pipeline', `<select class="inp" data-i="sourcePipelineId" data-cur="${esc(x.sourcePipelineId || '')}"></select>`)}
            ${x.kind === 'environment' ? field('parameter', `<select class="inp" data-i="sourceParameter" data-cur="${esc(x.sourceParameter || '')}"></select>`) : ''}</div>` : ''}
          <div class="dp-bar"><span class="s dp-grow">${x.id ? `id ${esc(x.id)}` : 'id is made from the name'}</span><button type="button" class="btn sm ghost" data-del-input="${i}">${icon('x', 'sm')}Remove</button></div></div>`).join('')}
        <button type="button" class="btn sm ghost" data-add-input>${icon('plus', 'sm')}Add an input</button>
        <div class="aa-label">Steps, in order</div>
        ${m.items.map((x, i) => {
          const s = stepById(x.stepId);
          const earlier = m.items.slice(0, i);
          const srcOptions = (cur) => `${branchInputs.map((inp) => option(`input:${iid(inp)}`, `input: ${inp.name}`, cur === `input:${iid(inp)}`)).join('')}${earlier.flatMap((e2, j) => OUTPUTS.map(([o, l]) => option(`step:${j}.${o}`, `step ${j + 1} (${stepById(e2.stepId)?.alias || stepById(e2.stepId)?.name || e2.stepId}): ${l}`, cur === `step:${j}.${o}`))).join('')}${option('literal', 'a fixed value', cur === 'literal')}`;
          const branchCur = x.branchInputId ? `input:${x.branchInputId}` : x.branch != null ? 'custom' : '';
          return `<div class="dp-card" data-item>
            <div class="dp-row"><b>${i + 1}.</b><select class="inp dp-grow" data-it="step">${S.steps.map((st) => option(st.id, `${st.name} — ${st.pipelineName || `#${st.pipelineId}`}`, st.id === x.stepId)).join('')}</select>
              <button type="button" class="btn sm ghost" data-up="${i}" ${i ? '' : 'disabled'} title="Earlier">↑</button><button type="button" class="btn sm ghost" data-down="${i}" ${i < m.items.length - 1 ? '' : 'disabled'} title="Later">↓</button><button type="button" class="btn sm ghost" data-del-item="${i}" ${m.items.length > 1 ? '' : 'disabled'} title="Remove">${icon('x', 'sm')}</button></div>
            <div class="dp-sub">
              <div class="dp-grid">${field('Branch', `<select class="inp" data-it="branch">${option('', `the step's own (${s?.branch === SMART ? 'smart' : s?.branch === TICKET ? 'the ticket\'s' : s?.branch || 'pipeline default'})`, !branchCur)}${branchInputs.map((inp) => option(`input:${iid(inp)}`, `from input: ${inp.name}`, branchCur === `input:${iid(inp)}`)).join('')}${option('custom', 'a branch named here', branchCur === 'custom')}</select>`)}
                ${branchCur === 'custom' ? field('branch name', `<input class="inp" data-it="branchText" value="${esc(x.branch || '')}" spellcheck="false">`) : ''}</div>
              <div class="aa-label">Values from inputs or earlier steps</div>
              ${(x.bindings || []).map((g) => {
                const cur = g.kind === 'literal' ? 'literal' : `${g.kind}:${g.ref}`;
                return `<div class="dp-row" data-bind><select class="inp" data-b="target" style="width:auto">${option('parameter', 'parameter', g.target !== 'variable')}${option('variable', 'variable', g.target === 'variable')}</select>
                  <input class="inp dp-grow" data-b="name" value="${esc(g.name || '')}" placeholder="name" list="${dl}-p${i}" spellcheck="false"><span class="muted">←</span>
                  <select class="inp dp-grow" data-b="src">${srcOptions(cur)}</select>
                  ${g.kind === 'literal' ? `<input class="inp dp-grow" data-b="literal" value="${esc(g.ref || '')}" placeholder="value" spellcheck="false">` : ''}
                  <button type="button" class="btn sm ghost" data-del-bind title="Remove">${icon('x', 'sm')}</button></div>`;
              }).join('')}
              <datalist id="${dl}-p${i}"></datalist>
              <button type="button" class="btn sm ghost" data-add-bind="${i}">${icon('plus', 'sm')}Add a value</button>
              ${i ? `<div class="dp-grid">${field('Hand on the previous run as', `<select class="inp" data-it="linkMode">${option('none', 'nothing', !x.link)}${['resource', 'container', 'parameter', 'variable'].map((k) => option(k, { resource: 'a pipeline resource', container: 'a container image tag', parameter: 'a parameter', variable: 'a variable' }[k], x.link?.mode === k)).join('')}</select>`)}
                ${x.link ? `${field(x.link.mode === 'resource' ? 'resource alias' : x.link.mode === 'container' ? 'container alias' : 'name', `<input class="inp" data-it="linkKey" value="${esc(x.link.key || '')}" list="${dl}-r${i}" spellcheck="false"><datalist id="${dl}-r${i}"></datalist>`)}
                  ${x.link.mode === 'resource' ? '<input type="hidden" data-it="linkSource" value="buildNumber">' : field('value', `<select class="inp" data-it="linkSource">${OUTPUTS.map(([o, l]) => option(o, l, (x.link.source || 'runId') === o)).join('')}</select>`)}` : ''}</div>` : ''}
            </div></div>`;
        }).join('')}
        <button type="button" class="btn sm ghost" data-add-item>${icon('plus', 'sm')}Add a step</button>
        <div class="dp-bar">${q ? `<button type="button" class="btn sm danger" data-del>${icon('trash', 'sm')}Delete</button>` : ''}<span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('check', 'sm')}${q ? 'Save' : 'Add sequence'}</button></div>`;
      suggest();
    }
    // fill pickers and suggestions from Azure DevOps after drawing; nothing waits on them
    function suggest() {
      $$('[data-input]', f).forEach(async (r, i) => {
        const x = m.inputs[i];
        const sp = $('[data-i="sourceProject"]', r), spl = $('[data-i="sourcePipelineId"]', r), spar = $('[data-i="sourceParameter"]', r);
        if (sp) { await fillProjects(sp, x.sourceProject); await fillPipelines(spl, x.sourceProject, x.sourcePipelineId); }
        const d = x.sourceProject && x.sourcePipelineId ? await detail(x.sourceProject, x.sourcePipelineId).catch(() => null) : null;
        if (spar) spar.innerHTML = `${option('', 'Choose a parameter…', !x.sourceParameter)}${(d?.parameters || []).filter((p) => p.kind === 'parameter').map((p) => option(p.name, p.name, p.name === x.sourceParameter)).join('')}`;
        const list = $(`#${dl}-i${i}`, f);
        if (list && d) {
          const vals = x.kind === 'branch' ? [SMART, ...d.branches.map((b) => b.name)] : x.kind === 'environment' ? (d.parameters.find((p) => p.name === x.sourceParameter)?.allowedValues || []) : [];
          list.innerHTML = vals.map((v) => `<option value="${esc(v)}">`).join('');
        }
      });
      $$('[data-item]', f).forEach(async (r, i) => {
        const s = stepById(m.items[i].stepId);
        const d = s ? await detail(s.project, s.pipelineId).catch(() => null) : null;
        const pl = $(`#${dl}-p${i}`, f), rl = $(`#${dl}-r${i}`, f);
        if (pl && d) pl.innerHTML = d.parameters.map((p) => `<option value="${esc(p.name)}">${esc(p.kind)}</option>`).join('');
        if (rl && d) rl.innerHTML = d.resources.map((x) => `<option value="${esc(x.alias)}">${esc(x.source || '')}</option>`).join('');
      });
    }
    f.addEventListener('change', (e) => {
      // a change that alters the shape of the form re-draws it; anything else is read at save
      if (e.target.matches('[data-i="kind"], [data-it="step"], [data-it="branch"], [data-it="linkMode"], [data-b="src"], [data-i="sourceProject"], [data-i="sourcePipelineId"], [data-i="sourceParameter"]')) {
        if (e.target.matches('[data-i="sourceProject"]')) { const r = e.target.closest('[data-input]'); $('[data-i="sourcePipelineId"]', r).value = ''; }
        read();
        draw();
      }
    });
    f.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t || t.type === 'submit') return;
      const at = (k) => Number(t.dataset[k]);
      if (t.matches('[data-cancel]')) { S.view = null; render(); return; }
      if (t.matches('[data-del]')) {
        if (!confirm(`Delete the sequence "${q.name}"? Its past runs stay.`)) return;
        try { await api('DELETE', `/api/deploy/sequences/${enc(q.id)}`); toast('Sequence deleted', { kind: 'ok' }); S.view = null; await load(); render(); } catch (err) { fail(err); }
        return;
      }
      read();
      if (t.matches('[data-add-input]')) m.inputs.push({ name: '', kind: 'value' });
      else if (t.matches('[data-del-input]')) m.inputs.splice(at('delInput'), 1);
      else if (t.matches('[data-add-item]')) m.items.push({ stepId: S.steps[0]?.id });
      else if (t.matches('[data-del-item]')) m.items.splice(at('delItem'), 1);
      else if (t.matches('[data-up]')) { const i = at('up'); [m.items[i - 1], m.items[i]] = [m.items[i], m.items[i - 1]]; }
      else if (t.matches('[data-down]')) { const i = at('down'); [m.items[i + 1], m.items[i]] = [m.items[i], m.items[i + 1]]; }
      else if (t.matches('[data-add-bind]')) (m.items[at('addBind')].bindings ||= []).push({ target: 'parameter', name: '', kind: 'literal', ref: '' });
      else if (t.matches('[data-del-bind]')) { const r = t.closest('[data-item]'); const i = $$('[data-item]', f).indexOf(r); m.items[i].bindings.splice($$('[data-bind]', r).indexOf(t.closest('[data-bind]')), 1); }
      else return;
      draw();
    });
    f.onsubmit = async (e) => {
      e.preventDefault();
      read();
      // a new input goes up with the id its bindings already use
      const body = {
        name: m.name,
        inputs: m.inputs.filter((x) => x.name.trim()).map((x) => ({ ...x, id: iid(x), ...(x.sourcePipelineId ? { sourcePipelineId: Number(x.sourcePipelineId) } : {}) })),
        items: m.items.map((x) => ({ ...x, bindings: (x.bindings || []).filter((g) => g.name) })),
      };
      try {
        await api(q ? 'PUT' : 'POST', q ? `/api/deploy/sequences/${enc(q.id)}` : '/api/deploy/sequences', body);
        toast(q ? 'Sequence saved' : 'Sequence added', { kind: 'ok', icon: 'layers' });
        S.view = null; await load(); render();
      } catch (err) { fail(err); }
    };
    draw();
  }

  function seqRunner(pane, q) {
    const dl = nid('dl');
    pane.innerHTML = `<form class="dp-form" autocomplete="off"><div class="t">${icon('layers', 'sm')} Run ${esc(q.name)}</div>
      <div class="s">${esc(q.items.map((x) => stepById(x.stepId)?.name || x.stepId).join(' → '))}</div>
      ${q.inputs.length ? `<div class="dp-grid">${q.inputs.map((x, i) => field(x.name, `<input class="inp" data-input="${esc(x.id)}" value="${esc(x.default || '')}" list="${dl}-${i}" placeholder="${x.kind === 'branch' ? 'empty: each step\'s own' : ''}" spellcheck="false"><datalist id="${dl}-${i}"></datalist>`)).join('')}</div>` : '<div class="s">It asks for nothing.</div>'}
      ${field('Ticket (optional)', '<input class="inp" name="item" placeholder="INT-12" maxlength="40">')}
      <div class="dp-bar"><span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('play', 'sm')}Run</button></div></form>`;
    const f = $('form', pane);
    q.inputs.forEach(async (x, i) => {
      if (x.kind === 'value' || !x.sourceProject || !x.sourcePipelineId) return;
      const d = await detail(x.sourceProject, x.sourcePipelineId).catch(() => null);
      if (!d) return;
      const vals = x.kind === 'branch' ? [SMART, ...d.branches.map((b) => b.name)] : d.parameters.find((p) => p.name === x.sourceParameter)?.allowedValues || [];
      $(`#${dl}-${i}`, f).innerHTML = vals.map((v) => `<option value="${esc(v)}">`).join('');
    });
    $('[data-cancel]', f).onclick = () => { S.view = null; render(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const inputs = Object.fromEntries($$('[data-input]', f).map((c) => [c.dataset.input, c.value]));
      try {
        await api('POST', `/api/deploy/sequences/${enc(q.id)}/run`, { inputs, item: f.item.value.trim() || undefined });
        toast(`${q.name} started`, { kind: 'ok', icon: 'play' });
        S.view = null; S.tab = 'runs'; await refreshRuns(); render();
      } catch (err) { fail(err); }
    };
  }

  /* ─── Connections ─── */
  function drawConnections(pane) {
    const st = S.status, jr = S.jira, dv = S.devstack, cf = S.confluence;
    const u = st.user;
    const pill = (on) => `<span class="status-pill" data-tone="${on ? 'ok' : 'muted'}">${on ? 'Connected' : 'Not connected'}</span>`;
    const used = (n) => `used by ${n} action${n === 1 ? '' : 's'}`;
    const prs = S.prWatch.projects || [];
    pane.innerHTML = `<div class="ent-list"><div class="ent-lh">Connections <span class="cnt">4</span></div>
      <article class="ent"><span class="ent-lead ent-tile" data-tone="muted" title="Azure DevOps">${icon('play')}</span>
        <div class="ent-body"><h3 class="ent-title"><span class="ent-name">Azure DevOps</span></h3>
          <div class="ent-sub">${st.connected ? `dev.azure.com/${esc(st.org)} · ${u ? esc(u.displayName) : 'connected'} · token <code>••••${esc(st.patHint || '')}</code>${st.source === 'env' ? ' · set in the environment' : ''} · ${used(S.steps.length)} · ${prs.length ? `watches PRs in ${prs.map(esc).join(', ')}` : 'watches no PRs'}${S.prWatch.error ? ` · <span style="color:var(--danger)">${esc(S.prWatch.error.project)}: ${esc(S.prWatch.error.message)}</span>` : ''}` : 'Runs pipelines: deployments, builds, migrations; sees the PRs that name a ticket'}</div></div>
        <div class="ent-side">${pill(st.connected)}<div class="ent-acts">${st.connected ? `<button class="btn sm ghost" data-pr-edit title="Pull requests|Which projects' PRs fire &quot;a PR is raised&quot;">${icon('send', 'sm')}Pull requests</button><button class="btn sm ghost" data-hook-edit title="Webhook|Azure DevOps tells the board when a PR is commented on">${icon('zap', 'sm')}Webhook</button>` : ''}${st.source === 'env' ? '' : `<button class="btn sm ghost" data-ado-edit>${st.connected ? 'Edit' : 'Connect'}</button>`}${st.connected && st.source === 'local' ? '<button class="btn sm ghost danger" data-disconnect>Disconnect</button>' : ''}</div></div></article>
      <article class="ent"><span class="ent-lead ent-tile" data-tone="accent" title="Jira">${icon('issue')}</span>
        <div class="ent-body"><h3 class="ent-title"><span class="ent-name">Jira</span></h3>
          <div class="ent-sub">${jr.connected ? `${esc(jr.url.replace(/^https?:\/\//, ''))} · service account <code>${esc(jr.username)}</code> · ${used(S.jactions.length)}` : 'Moves, comments on, assigns and creates issues'}</div></div>
        <div class="ent-side">${pill(jr.connected)}<div class="ent-acts">${jr.connected ? `<button class="btn sm ghost" data-jira-test>${icon('check', 'sm')}Test</button>` : ''}<button class="btn sm ghost" data-jira-edit>${jr.connected ? 'Edit' : 'Connect'}</button>${jr.connected ? '<button class="btn sm ghost danger" data-jira-off>Disconnect</button>' : ''}</div></div></article>
      <article class="ent"><span class="ent-lead ent-tile" data-tone="accent" title="Confluence">${icon('text')}</span>
        <div class="ent-body"><h3 class="ent-title"><span class="ent-name">Confluence</span></h3>
          <div class="ent-sub">${cf.connected ? `${esc(cf.url.replace(/^https?:\/\//, ''))} · account <code>${esc(cf.username)}</code> · ${used(S.cactions.length)}` : 'Creates pages, appends to them, and replaces their sections, from markdown'}</div></div>
        <div class="ent-side">${pill(cf.connected)}<div class="ent-acts">${cf.connected ? `<button class="btn sm ghost" data-cf-test>${icon('check', 'sm')}Test</button>` : ''}<button class="btn sm ghost" data-cf-edit>${cf.connected ? 'Edit' : 'Connect'}</button>${cf.connected ? '<button class="btn sm ghost danger" data-cf-off>Disconnect</button>' : ''}</div></div></article>
      <article class="ent"><span class="ent-lead ent-tile" data-tone="ok" title="DevStack">${icon('flask')}</span>
        <div class="ent-body"><h3 class="ent-title"><span class="ent-name">DevStack</span></h3>
          <div class="ent-sub">${dv.connected ? `${esc(dv.url.replace(/^https?:\/\//, ''))} · through <code>${esc(dv.mcp.split(/[\\/]/).slice(-3).join('/'))}</code> · ${used(S.dactions.length)}` : 'Runs the PR gate and tagged suites on the local stack'}</div></div>
        <div class="ent-side">${pill(dv.connected)}<div class="ent-acts">${dv.connected ? `<button class="btn sm ghost" data-ds-test>${icon('check', 'sm')}Test</button>` : ''}<button class="btn sm ghost" data-ds-edit>${dv.connected ? 'Edit' : 'Connect'}</button>${dv.connected ? '<button class="btn sm ghost danger" data-ds-off>Disconnect</button>' : ''}</div></div></article></div>
      <form class="dp-form" data-cf-form autocomplete="off" style="margin-top:24px" hidden>
        <div class="aa-label">Confluence</div>
        ${field('Address', `<input class="inp" name="url" required value="${esc(cf.url || '')}" placeholder="https://confluence.example.com or https://site.atlassian.net" spellcheck="false">`)}
        <div class="s">Any link from the site works. Data Center: a username and password. Cloud never takes your password here: use your Atlassian email and an API token from <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener">id.atlassian.com</a> ("Create API token", without scopes).</div>
        <div class="dp-grid">${field('Username', `<input class="inp" name="username" required value="${esc(cf.username || '')}" placeholder="svc-account, or your email on Cloud" spellcheck="false">`)}
          ${field('Password or API token', `<input class="inp" name="password" type="password" autocomplete="new-password" ${cf.connected ? 'placeholder="Unchanged"' : 'required'}>`)}</div>
        <div class="dp-bar"><span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('link', 'sm')}${cf.connected ? 'Save' : 'Connect'}</button></div></form>
      <form class="dp-form" data-ds-form autocomplete="off" style="margin-top:24px" hidden>
        <div class="aa-label">DevStack</div>
        <div class="dp-grid">${field('Address', `<input class="inp" name="url" value="${esc(dv.url || 'http://127.0.0.1:5050')}" placeholder="http://127.0.0.1:5050" spellcheck="false">`)}
          ${field('MCP server', `<input class="inp" name="mcp" required value="${esc(dv.mcp || '')}" placeholder="C:\\…\\tools\\devstack-mcp\\dist\\index.js" spellcheck="false">`)}</div>
        <div class="s">The board drives the stack through the devstack MCP server, as an agent would: build it once (npm run build in tools/devstack-mcp). The address is this machine's only.</div>
        <div class="dp-bar"><span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('link', 'sm')}${dv.connected ? 'Save' : 'Connect'}</button></div></form>
      <form class="dp-form" data-pr-form autocomplete="off" style="margin-top:24px" hidden>
        <div class="aa-label">Pull requests</div>
        <div class="s">Once a minute the board looks at the newest PRs of these projects. One whose branch or title names a ticket (its id or Jira key) fires "a PR is raised" for that ticket. The first look fires nothing.</div>
        <div class="dp-check-bar"><input class="inp" type="search" data-pr-filter placeholder="Filter projects" aria-label="Filter projects" spellcheck="false"><span class="s" data-pr-count></span></div>
        <div class="dp-checks" data-pr-list><div class="s">Loading projects…</div></div>
        <div class="dp-bar"><span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('check', 'sm')}Save</button></div></form>
      <form class="dp-form" data-hook-form autocomplete="off" style="margin-top:24px" hidden>
        <div class="aa-label">Webhook</div>
        <div class="s">Azure DevOps tells the board when someone comments on a pull request. Every 10 seconds, each comment on a PR whose branch or title names a ticket fires "a PR is commented on" for that ticket. In Azure DevOps: Project settings › Service hooks › + › Web Hooks › <b>Pull request commented on</b>, then paste these under Basic authentication.</div>
        <div class="dp-stack" data-hook-body><div class="s">Loading…</div></div>
        <div class="dp-bar"><span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Close</button></div></form>
      <form class="dp-form" data-jira-form autocomplete="off" style="margin-top:24px" hidden>
        <div class="aa-label">Jira</div>
        ${field('Address', `<input class="inp" name="url" required value="${esc(jr.url || '')}" placeholder="https://jira.example.com or https://site.atlassian.net" spellcheck="false">`)}
        <div class="s">Data Center or Server: a username and password. Cloud never takes your password here: use your Atlassian email and an API token from <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener">id.atlassian.com</a> ("Create API token", without scopes); the Confluence one works too.</div>
        <div class="dp-grid">${field('Username', `<input class="inp" name="username" required value="${esc(jr.username || '')}" placeholder="svc-account, or your email on Cloud" spellcheck="false">`)}
          ${field('Password or API token', `<input class="inp" name="password" type="password" autocomplete="new-password" ${jr.connected ? 'placeholder="Unchanged"' : 'required'}>`)}</div>
        ${field('How a ticket finds its Jira issue', `<select class="inp" name="find">${option('title', 'Its jira field, or a key like BET-1234 in its title', jr.find !== 'field')}${option('field', 'Its jira field only', jr.find === 'field')}</select>`)}
        <div class="dp-bar"><span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('link', 'sm')}${jr.connected ? 'Save' : 'Connect'}</button></div></form>
      <form class="dp-form" data-connect autocomplete="off" style="margin-top:24px" hidden>
        <div class="aa-label">Azure DevOps</div>
        <div class="dp-grid">${field('Organization', `<input class="inp" name="org" required value="${esc(st.org || '')}" placeholder="MyOrg (from dev.azure.com/MyOrg)" spellcheck="false">`)}
          ${field('Personal access token', '<input class="inp" name="pat" type="password" required autocomplete="new-password" placeholder="Build (read & execute), Code (read), Project (read)" spellcheck="false">')}</div>
        <div class="dp-bar"><span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('link', 'sm')}Connect</button></div></form>`;
    const form = $('[data-connect]', pane), jform = $('[data-jira-form]', pane), dform = $('[data-ds-form]', pane), pform = $('[data-pr-form]', pane), cform = $('[data-cf-form]', pane);
    const hform = $('[data-hook-form]', pane);
    const forms = [form, jform, dform, pform, cform, hform];
    // The webhook: what to paste into the service hook, and on, new password or off
    const drawHook = (h) => {
      const body = $('[data-hook-body]', hform);
      const copy = (label, value, key) => field(label, `<div class="dp-row"><input class="inp dp-grow" readonly value="${esc(value)}" data-hook-val="${key}" spellcheck="false"><button type="button" class="btn sm ghost" data-hook-copy="${key}">${icon('copy', 'sm')}Copy</button></div>`);
      body.innerHTML = h.on
        ? `${copy('URL', `${location.origin}${h.path}`, 'url')}<div class="dp-grid">${copy('Username', h.username, 'user')}${copy('Password', h.password, 'pass')}</div>
          <div class="dp-row"><span class="s">${h.lastAt ? `Last heard from Azure DevOps ${esc(ago(h.lastAt))}` : 'Not heard from Azure DevOps yet'}</span><span class="dp-grow"></span>
            <button type="button" class="btn sm ghost" data-hook-new>New password</button><button type="button" class="btn sm ghost danger" data-hook-off>Turn off</button></div>`
        : '<div class="dp-row"><span class="s">Off: the board refuses its calls.</span><span class="dp-grow"></span><button type="button" class="btn sm primary" data-hook-new>Turn on</button></div>';
      for (const b of $$('[data-hook-copy]', body)) b.onclick = () => navigator.clipboard.writeText($(`[data-hook-val="${b.dataset.hookCopy}"]`, body).value).then(() => toast('Copied', { kind: 'ok' }), () => fail(new Error('Could not copy')));
      const nw = $('[data-hook-new]', body);
      nw.onclick = async () => {
        if (h.on && !confirm('Make a new password? The service hook in Azure DevOps stops working until you paste the new one into it.')) return;
        try { drawHook(await api('PUT', '/api/deploy/webhook', {})); } catch (err) { fail(err); }
      };
      const off = $('[data-hook-off]', body);
      if (off) off.onclick = async () => {
        if (!confirm('Turn the webhook off? The board refuses Azure DevOps\'s calls until it is turned on again, with a new password.')) return;
        try { drawHook(await api('DELETE', '/api/deploy/webhook')); } catch (err) { fail(err); }
      };
    };
    $('[data-hook-edit]', pane)?.addEventListener('click', async () => {
      show(hform);
      try { drawHook(await api('GET', '/api/deploy/webhook')); } catch (err) { fail(err); }
    });
    hform.onsubmit = (e) => e.preventDefault();
    $('[data-cf-edit]', pane).onclick = () => show(cform);
    cform.onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('button.primary', cform);
      btn.disabled = true;
      try {
        await api('PUT', '/api/confluence/connection', { url: cform.url.value.trim(), username: cform.username.value.trim(), password: cform.password.value || undefined });
        S.cspaces = null;
        toast('Confluence connected', { kind: 'ok', icon: 'link' });
        await load(); render();
      } catch (err) { fail(err); } finally { btn.disabled = false; }
    };
    const ct = $('[data-cf-test]', pane);
    if (ct) ct.onclick = async () => {
      try { const r = await api('POST', '/api/confluence/connection/test', {}); r.ok ? toast(`Confluence answers: signed in as ${r.user.displayName}`, { kind: 'ok', icon: 'check' }) : toast(`Confluence refused it: ${r.error}`, { kind: 'error', wrap: true }); } catch (err) { fail(err); }
    };
    const coff = $('[data-cf-off]', pane);
    if (coff) coff.onclick = async () => {
      if (!confirm('Disconnect Confluence? The password is removed from this PC; Confluence actions fail until it is connected again.')) return;
      try { await api('DELETE', '/api/confluence/connection'); toast('Confluence disconnected', { kind: 'ok' }); await load(); render(); } catch (err) { fail(err); }
    };
    const show = (f) => { for (const x of forms) x.hidden = x !== f; $('input', f)?.focus(); };
    for (const c of $$('[data-cancel]', pane)) c.onclick = () => { for (const x of forms) x.hidden = true; };
    $('[data-ado-edit]', pane)?.addEventListener('click', () => show(form));
    $('[data-jira-edit]', pane).onclick = () => show(jform);
    $('[data-ds-edit]', pane).onclick = () => show(dform);
    dform.onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('button.primary', dform);
      btn.disabled = true;
      try { await api('PUT', '/api/devstack/connection', { url: dform.url.value.trim(), mcp: dform.mcp.value.trim() }); toast('DevStack connected', { kind: 'ok', icon: 'flask' }); await load(); render(); } catch (err) { fail(err); } finally { btn.disabled = false; }
    };
    const dt = $('[data-ds-test]', pane);
    if (dt) dt.onclick = async () => {
      try { const r = await api('POST', '/api/devstack/connection/test', {}); r.ok ? toast(`DevStack answers${r.status?.lease?.holder ? `: leased to ${r.status.lease.holder}` : ''}`, { kind: 'ok', icon: 'check' }) : toast(`DevStack didn't answer: ${r.error}`, { kind: 'error', wrap: true }); } catch (err) { fail(err); }
    };
    const doff = $('[data-ds-off]', pane);
    if (doff) doff.onclick = async () => {
      if (!confirm('Disconnect the DevStack? A run in flight fails; DevStack actions wait until it is connected again.')) return;
      try { await api('DELETE', '/api/devstack/connection'); toast('DevStack disconnected', { kind: 'ok' }); await load(); render(); } catch (err) { fail(err); }
    };
    $('[data-pr-edit]', pane)?.addEventListener('click', async () => {
      show(pform);
      const list = $('[data-pr-list]', pform), filter = $('[data-pr-filter]', pform), count = $('[data-pr-count]', pform);
      const counted = () => { const n = $$('input:checked', list).length; count.textContent = n ? `Watching ${n}` : 'Watching none'; };
      try {
        const ps = await projects();
        const on = new Set(S.prWatch.projects || []);
        // the watched ones first, so what is on shows without scrolling
        const sorted = [...ps].sort((a, b) => Number(on.has(b.name)) - Number(on.has(a.name)));
        list.innerHTML = sorted.map((p) => `<label class="dp-check" title="${esc(p.name)}"><input type="checkbox" value="${esc(p.name)}"${on.has(p.name) ? ' checked' : ''}><span>${esc(p.name)}</span></label>`).join('') || '<div class="s">No projects</div>';
        filter.value = '';
        filter.oninput = () => { const q = filter.value.trim().toLowerCase(); for (const l of $$('.dp-check', list)) l.hidden = !!q && !l.title.toLowerCase().includes(q); };
        list.onchange = counted;
        counted();
        filter.focus();
      } catch (err) { list.innerHTML = '<div class="s">Could not list projects</div>'; fail(err); }
    });
    pform.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('PUT', '/api/deploy/pr-watch', { projects: $$('input:checked', pform).map((x) => x.value) });
        toast(r.projects.length ? `Watching PRs in ${r.projects.join(', ')}` : 'Watching no PRs', { kind: 'ok', icon: 'send' });
        await load(); render();
      } catch (err) { fail(err); }
    };
    if (!st.connected && !jr.connected && !dv.connected) show(jform);
    jform.onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('button.primary', jform);
      btn.disabled = true;
      try {
        await api('PUT', '/api/jira/connection', { url: jform.url.value.trim(), username: jform.username.value.trim(), password: jform.password.value || undefined, find: jform.find.value });
        S.jprojects = null;
        toast('Jira connected', { kind: 'ok', icon: 'link' });
        await load(); render();
      } catch (err) { fail(err); } finally { btn.disabled = false; }
    };
    const jt = $('[data-jira-test]', pane);
    if (jt) jt.onclick = async () => {
      try { const r = await api('POST', '/api/jira/connection/test', {}); r.ok ? toast(`Jira answers: signed in as ${r.user.displayName}`, { kind: 'ok', icon: 'check' }) : toast(`Jira refused it: ${r.error}`, { kind: 'error', wrap: true }); } catch (err) { fail(err); }
    };
    const joff = $('[data-jira-off]', pane);
    if (joff) joff.onclick = async () => {
      if (!confirm('Disconnect Jira? The password is removed from this PC; Jira actions fail until it is connected again.')) return;
      try { await api('DELETE', '/api/jira/connection'); toast('Jira disconnected', { kind: 'ok' }); await load(); render(); } catch (err) { fail(err); }
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('button.primary', form);
      btn.disabled = true;
      try {
        await api('PUT', '/api/deploy/connection', { org: form.org.value.trim(), pat: form.pat.value.trim() });
        form.pat.value = '';
        S.projects = null; S.pipelines.clear(); S.details.clear();
        toast('Azure DevOps connected', { kind: 'ok', icon: 'link' });
        await load(); render();
      } catch (err) { fail(err); } finally { btn.disabled = false; }
    };
    const dis = $('[data-disconnect]', pane);
    if (dis) dis.onclick = async () => {
      if (!confirm('Disconnect Azure DevOps? The token is removed from this PC; running deployments fail at their next step.')) return;
      try { await api('DELETE', '/api/deploy/connection'); toast('Azure DevOps disconnected', { kind: 'ok' }); await load(); render(); } catch (err) { fail(err); }
    };
  }

  /* ─── Azure DevOps pull request actions ─── */
  function prEditor(pane, a) {
    const v = { does: 'reply', status: 'fixed', ...(a || {}) };
    pane.innerHTML = `<form class="dp-form" autocomplete="off">
      <div class="dp-grid">${field('Name', `<input class="inp" name="name" required maxlength="80" value="${esc(v.name || '')}" placeholder="Reply to the reviewer">`)}
        ${connField('adopr', !!a)}</div>
      ${a ? `<div class="s">id <code>${esc(a.id)}</code>: grants use it, and it never changes</div>` : ''}
      <div class="dp-grid">${field('Does', `<select class="inp" name="does">${Object.entries(PRDOES).map(([k, l]) => option(k, l, k === v.does)).join('')}</select>`)}
        ${field('As', `<select class="inp" name="status">${Object.entries(PRSTATUS).map(([k, l]) => option(k, l, k === v.status)).join('')}</select>`, 'data-for="resolve"')}</div>
      ${field('Text', `<textarea class="inp" name="text" rows="3" placeholder="Thanks {comment.author}: picked up as {id}">${esc(v.text || '')}</textarea>`, 'data-for="text"')}
      <div class="s" data-for="text">Markdown; {id}, {title}, {comment.author}, {comment.text} and {pr.url} are filled in. Left empty, it is given when it runs (resolving then posts no reply).</div>
      <div class="s">Which PR: the one a "PR is commented on" rule fired for, with its thread; else the ticket's <code>pr</code> field or property; else one given when it runs.<span data-for="approve"> It approves as the Azure DevOps token's owner.</span></div>
      <div class="dp-bar">${a ? `<button type="button" class="btn sm danger" data-del>${icon('trash', 'sm')}Delete</button>` : ''}<span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('check', 'sm')}${a ? 'Save' : 'Add action'}</button></div></form>`;
    const f = $('form', pane);
    const sync = () => { const d = f.does.value; const on = { resolve: d === 'resolve', text: d !== 'approve', approve: d === 'approve' }; for (const x of $$('[data-for]', f)) x.hidden = !on[x.dataset.for]; };
    f.does.onchange = sync; sync();
    wireConn(f, 'adopr');
    $('[data-cancel]', f).onclick = () => { S.view = null; render(); };
    const del = $('[data-del]', f);
    if (del) del.onclick = async () => {
      if (!confirm(`Delete "${a.name}"? Agents' grants of it go too.`)) return;
      try { await api('DELETE', `/api/ado/actions/${enc(a.id)}`); toast('Action deleted', { kind: 'ok' }); S.view = null; await load(); render(); } catch (e) { fail(e); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const does = f.does.value;
      const body = { name: f.elements.name.value, does, ...(does === 'resolve' ? { status: f.status.value } : {}), ...(does !== 'approve' ? { text: f.text.value } : {}) };
      try {
        await api(a ? 'PUT' : 'POST', a ? `/api/ado/actions/${enc(a.id)}` : '/api/ado/actions', body);
        toast(a ? 'Action saved' : 'Action added', { kind: 'ok', icon: 'msg' });
        S.view = null; await load(); render();
      } catch (err) { fail(err); }
    };
  }
  // Run a pull request action now: the ticket, the PR (else the ticket's), the thread and the text when it needs them
  function prRunner(pane, a) {
    const thread = a.does === 'reply' || a.does === 'resolve';
    const ask = a.does !== 'approve' && !a.text;
    pane.innerHTML = `<form class="dp-form" autocomplete="off"><div class="aa-label">Run ${esc(a.name)}</div>
      <div class="dp-grid">${field('Ticket', '<input class="inp" name="item" placeholder="INT-12" maxlength="40">')}
        ${field('Pull request', '<input class="inp" name="pr" placeholder="1234 or its link (empty: the ticket\'s)" spellcheck="false">')}
        ${thread ? field('Thread', '<input class="inp" name="thread" required placeholder="its id, or a link with discussionId" spellcheck="false">') : ''}</div>
      ${ask ? field(a.does === 'resolve' ? 'Reply first (optional)' : 'Text', `<textarea class="inp" name="text" rows="3" ${a.does === 'resolve' ? '' : 'required'}></textarea>`) : ''}
      <div class="dp-bar"><span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('play', 'sm')}Run</button></div></form>`;
    const f = $('form', pane);
    $('[data-cancel]', f).onclick = () => { S.view = null; render(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const th = f.thread?.value.trim() || '';
      const body = { item: f.item.value.trim() || undefined, pr: f.pr.value.trim() || undefined, thread: (/discussionId=(\d+)/.exec(th)?.[1] || th) || undefined, text: f.text?.value || undefined };
      try {
        const r = await api('POST', `/api/ado/actions/${enc(a.id)}/run`, body);
        toast(r.message || `${a.name}: ${r.status}`, { kind: r.status === 'failed' ? 'error' : 'ok', icon: 'msg', wrap: true });
        S.view = null; S.tab = 'runs'; await refreshRuns(); render();
      } catch (err) { fail(err); }
    };
  }

  /* ─── Jira actions ─── */
  const jprojects = () => (S.jprojects ||= api('GET', '/api/jira/projects').catch((e) => { S.jprojects = null; fail(e); return []; }));
  function jiraEditor(pane, a) {
    const v = { does: 'transition', issue: 'ticket', issueType: 'Task', summary: '{title}', ...(a || {}) };
    pane.innerHTML = `<form class="dp-form" autocomplete="off">
      <div class="dp-grid">${field('Name', `<input class="inp" name="name" required maxlength="80" value="${esc(v.name || '')}" placeholder="Move to Done">`)}
        ${connField('jira', !!a)}</div>
      ${a ? `<div class="s">id <code>${esc(a.id)}</code>: grants use it, and it never changes</div>` : ''}
      ${field('Does', `<select class="inp" name="does">${Object.entries(JDOES).map(([k, l]) => option(k, l, k === v.does)).join('')}</select>`)}
      <div class="dp-grid" data-for="issue">${field('Which issue', `<select class="inp" name="issue">${option('ticket', 'The ticket\'s Jira issue', v.issue === 'ticket')}${option('fixed', 'A fixed issue', v.issue === 'fixed')}${option('ask', 'Asked when it runs', v.issue === 'ask')}</select>`)}
        ${field('Issue key', `<input class="inp" name="key" value="${esc(v.key || '')}" placeholder="BET-1234" spellcheck="false">`, 'data-for="key"')}</div>
      <div class="dp-grid" data-for="transition">${field('Project', '<select class="inp" name="sproject"></select>')}${field('To status', `<select class="inp" name="status">${option(v.status || '', v.status || 'Choose a project…', true)}</select>`)}</div>
      <div class="s" data-for="transition">The board finds the transition that reaches this status from wherever the issue is.</div>
      ${field('Assign to', `<input class="inp" name="assignee" value="${esc(v.assignee || '')}" placeholder="Jira username; empty unassigns" spellcheck="false">`, 'data-for="assign"')}
      <div class="dp-grid" data-for="create">${field('Project', '<select class="inp" name="project"></select>')}${field('Issue type', `<input class="inp" name="issueType" value="${esc(v.issueType)}">`)}</div>
      ${field('Summary', `<input class="inp" name="summary" value="${esc(v.summary)}" placeholder="{title}">`, 'data-for="create"')}
      ${field('Text', `<textarea class="inp" name="text" rows="3" placeholder="{id} and {title} name the ticket">${esc(v.text || '')}</textarea>`, 'data-for="text"')}
      <div class="s" data-for="comment">Left empty, the text is asked for when it runs.</div>
      <div class="dp-bar">${a ? `<button type="button" class="btn sm danger" data-del>${icon('trash', 'sm')}Delete</button>` : ''}<span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('check', 'sm')}${a ? 'Save' : 'Add action'}</button></div></form>`;
    const f = $('form', pane);
    // show the fields this kind of action takes
    const sync = () => {
      const does = f.does.value;
      const on = { issue: does !== 'create', key: does !== 'create' && f.issue.value === 'fixed', transition: does === 'transition', assign: does === 'assign', create: does === 'create', text: does === 'comment' || does === 'create', comment: does === 'comment' };
      for (const x of $$('[data-for]', f)) x.hidden = !on[x.dataset.for];
    };
    f.does.onchange = sync; f.issue.onchange = sync; sync();
    wireConn(f, 'jira');
    // projects for both lists; a move's statuses come from the project picked (the key's own project when fixed)
    const statuses = async (project) => {
      if (!project) return;
      try {
        const list = await api('GET', `/api/jira/projects/${enc(project)}/statuses`);
        const cur = f.status.value;
        f.status.innerHTML = `${option('', 'Choose a status…', !cur)}${[...new Set([...(cur ? [cur] : []), ...list])].map((x) => option(x, x, x === cur)).join('')}`;
      } catch (e) { fail(e); }
    };
    jprojects().then((ps) => {
      const pick = (sel, cur) => { sel.innerHTML = ps.map((p) => option(p.key, `${p.key} · ${p.name}`, p.key === cur)).join('') || option('', 'No projects', true); };
      pick(f.project, v.project || ps[0]?.key);
      pick(f.sproject, (v.key || '').split('-')[0] || ps[0]?.key);
      statuses(f.sproject.value);
    });
    f.sproject.onchange = () => statuses(f.sproject.value);
    $('[data-cancel]', f).onclick = () => { S.view = null; render(); };
    const del = $('[data-del]', f);
    if (del) del.onclick = async () => {
      if (!confirm(`Delete "${a.name}"? Agents' grants of it go too.`)) return;
      try { await api('DELETE', `/api/jira/actions/${enc(a.id)}`); toast('Action deleted', { kind: 'ok' }); S.view = null; await load(); render(); } catch (e) { fail(e); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const does = f.does.value;
      const body = { name: f.elements.name.value, does, issue: f.issue.value, key: f.key.value, status: f.status.value, assignee: f.assignee.value, project: f.project.value, issueType: f.issueType.value, summary: f.summary.value, text: f.text.value };
      if (does !== 'create' && body.issue !== 'fixed') delete body.key;
      try {
        await api(a ? 'PUT' : 'POST', a ? `/api/jira/actions/${enc(a.id)}` : '/api/jira/actions', body);
        toast(a ? 'Action saved' : 'Action added', { kind: 'ok', icon: 'issue' });
        S.view = null; await load(); render();
      } catch (err) { fail(err); }
    };
  }
  // Run a Jira action now: for a ticket, and the issue or text when the action asks for them
  function jiraRunner(pane, a) {
    pane.innerHTML = `<form class="dp-form" autocomplete="off"><div class="aa-label">Run ${esc(a.name)}</div>
      ${field('Ticket', '<input class="inp" name="item" placeholder="INT-12" maxlength="40">')}
      ${a.issue === 'ask' ? field('Issue key', '<input class="inp" name="issue" required placeholder="BET-1234" spellcheck="false">') : ''}
      ${a.does === 'comment' && !a.text ? field('Text', '<textarea class="inp" name="text" rows="3" required></textarea>') : ''}
      <div class="dp-bar"><span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('play', 'sm')}Run</button></div></form>`;
    const f = $('form', pane);
    $('[data-cancel]', f).onclick = () => { S.view = null; render(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', `/api/jira/actions/${enc(a.id)}/run`, { item: f.item.value.trim() || undefined, issue: f.issue?.value.trim() || undefined, text: f.text?.value || undefined });
        toast(r.message || `${a.name}: ${r.status}`, { kind: r.status === 'failed' ? 'error' : 'ok', icon: 'issue', wrap: true });
        S.view = null; S.tab = 'runs'; await refreshRuns(); render();
      } catch (err) { fail(err); }
    };
  }

  /* ─── Confluence actions ─── */
  const cspaces = () => (S.cspaces ||= api('GET', '/api/confluence/spaces').catch((e) => { S.cspaces = null; fail(e); return []; }));
  function confluenceEditor(pane, a) {
    const v = { does: 'section', page: 'fixed', title: '{title}', ...(a || {}) };
    pane.innerHTML = `<form class="dp-form" autocomplete="off">
      <div class="dp-grid">${field('Name', `<input class="inp" name="name" required maxlength="80" value="${esc(v.name || '')}" placeholder="Update the release notes">`)}${connField('confluence', !!a)}</div>
      ${a ? `<div class="s">id <code>${esc(a.id)}</code>: grants use it, and it never changes</div>` : ''}
      ${field('Does', `<select class="inp" name="does">${Object.entries(CDOES).map(([k, l]) => option(k, l, k === v.does)).join('')}</select>`)}
      <div class="dp-grid" data-for="page">${field('Which page', `<select class="inp" name="page">${option('fixed', 'This page', v.page === 'fixed')}${option('ask', 'Given when it runs', v.page === 'ask')}</select>`)}
        ${field('Page', `<input class="inp" name="pageId" value="${esc(v.pageId || '')}" placeholder="Its link, or its id" spellcheck="false">`, 'data-for="fixed"')}</div>
      ${field('Heading', `<input class="inp" name="heading" value="${esc(v.heading || '')}" placeholder="Release notes (## Release notes adds it as an h2 when missing)">`, 'data-for="section"')}
      <div class="s" data-for="section">What is under this heading, up to the next heading of the same level, is replaced. The rest of the page, macros and all, stays as it is.</div>
      <div class="dp-grid" data-for="create">${field('Space', `<select class="inp" name="space">${option(v.space || '', v.space || 'Loading…', true)}</select>`)}
        ${field('Under page (optional)', `<input class="inp" name="parent" value="${esc(v.parent || '')}" placeholder="Its link, or its id" spellcheck="false">`)}</div>
      ${field('Title', `<input class="inp" name="title" value="${esc(v.title)}" placeholder="{title}">`, 'data-for="create"')}
      ${field('Text (markdown)', `<textarea class="inp mono" name="text" rows="6" placeholder="Left empty, it is given when it runs: an agent writes it. {id} {title} {field.key} {property.name} name the ticket">${esc(v.text || '')}</textarea>`)}
      <div class="dp-bar">${a ? `<button type="button" class="btn sm danger" data-del>${icon('trash', 'sm')}Delete</button>` : ''}<span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('check', 'sm')}${a ? 'Save' : 'Add action'}</button></div></form>`;
    const f = $('form', pane);
    const sync = () => {
      const does = f.does.value;
      const on = { page: does !== 'create', fixed: does !== 'create' && f.page.value === 'fixed', section: does === 'section', create: does === 'create' };
      for (const x of $$('[data-for]', f)) x.hidden = !on[x.dataset.for];
    };
    f.does.onchange = sync; f.page.onchange = sync; sync();
    wireConn(f, 'confluence');
    cspaces().then((ss) => { f.space.innerHTML = ss.map((s) => option(s.key, `${s.key} · ${s.name}`, s.key === v.space)).join('') || option(v.space || '', v.space || 'No spaces', true); });
    $('[data-cancel]', f).onclick = () => { S.view = null; render(); };
    const del = $('[data-del]', f);
    if (del) del.onclick = async () => {
      if (!confirm(`Delete "${a.name}"? Agents' grants of it go too.`)) return;
      try { await api('DELETE', `/api/confluence/actions/${enc(a.id)}`); toast('Action deleted', { kind: 'ok' }); S.view = null; await load(); render(); } catch (e) { fail(e); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const does = f.does.value;
      const body = { name: f.elements.name.value, does, text: f.text.value };
      if (does === 'create') Object.assign(body, { space: f.space.value, parent: f.parent.value.trim(), title: f.title.value });
      else Object.assign(body, { page: f.page.value, ...(f.page.value === 'fixed' ? { pageId: f.pageId.value.trim() } : {}), ...(does === 'section' ? { heading: f.heading.value } : {}) });
      try {
        await api(a ? 'PUT' : 'POST', a ? `/api/confluence/actions/${enc(a.id)}` : '/api/confluence/actions', body);
        toast(a ? 'Action saved' : 'Action added', { kind: 'ok', icon: 'text' });
        S.view = null; await load(); render();
      } catch (err) { fail(err); }
    };
  }
  // Run a Confluence action now: for a ticket, with the page and the text when the action asks for them
  function confluenceRunner(pane, a) {
    pane.innerHTML = `<form class="dp-form" autocomplete="off"><div class="aa-label">Run ${esc(a.name)}</div>
      ${field('Ticket', '<input class="inp" name="item" placeholder="INT-12" maxlength="40">')}
      ${a.does !== 'create' && a.page === 'ask' ? field('Page', '<input class="inp" name="page" required placeholder="Its link, or its id" spellcheck="false">') : ''}
      ${a.text ? '' : field('Text (markdown)', '<textarea class="inp mono" name="text" rows="8" required></textarea>')}
      <div class="dp-bar"><span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('play', 'sm')}Run</button></div></form>`;
    const f = $('form', pane);
    $('[data-cancel]', f).onclick = () => { S.view = null; render(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', `/api/confluence/actions/${enc(a.id)}/run`, { item: f.item.value.trim() || undefined, page: f.page?.value.trim() || undefined, text: f.text?.value || undefined });
        toast(r.message || `${a.name}: ${r.status}`, { kind: r.status === 'failed' ? 'error' : 'ok', icon: 'text', wrap: true });
        S.view = null; S.tab = 'runs'; await refreshRuns(); render();
      } catch (err) { fail(err); }
    };
  }

  /* ─── DevStack actions ─── */
  const SOURCES = [['path:{worktree}', 'The folder of the agent that worked the ticket'], ['branch:{branch}', 'The ticket\'s branch (pushed)']];
  function devstackEditor(pane, a) {
    const v = { tool: 'gate', kind: 'upgrade', service: 'placement', source: 'path:{worktree}', tags: ['regression'], ...(a || {}) };
    const custom = !SOURCES.some(([k]) => k === v.source);
    pane.innerHTML = `<form class="dp-form" autocomplete="off">
      <div class="dp-grid">${field('Name', `<input class="inp" name="name" required maxlength="80" value="${esc(v.name || '')}" placeholder="Regression on the ticket's build">`)}${connField('devstack', !!a)}</div>
      ${a ? `<div class="s">id <code>${esc(a.id)}</code>: grants use it, and it never changes</div>` : ''}
      <div class="dp-grid">${field('Runs', `<select class="inp" name="tool">${Object.entries(DTOOL).map(([k, l]) => option(k, l, k === v.tool)).join('')}</select>`)}
        ${field('Service', `<select class="inp" name="service">${(S.devstack.services || [v.service]).map((x) => option(x, x, x === v.service)).join('')}</select>`)}</div>
      ${field('Gate', `<select class="inp" name="kind">${option('upgrade', 'Upgrade: A/B against develop, then the full regression', v.kind === 'upgrade')}${option('behaviour', 'Behaviour: the tests that cover the service', v.kind === 'behaviour')}</select>`, 'data-for="gate"')}
      ${field('Tags', `<input class="inp" name="tags" value="${esc((v.tags || []).join(', '))}" placeholder="smoke, regression" spellcheck="false">`, 'data-for="test"')}
      ${field('The build it tests', `<select class="inp" name="sourcePick">${SOURCES.map(([k, l]) => option(k, l, k === v.source)).join('')}${option('custom', 'Another build…', custom)}</select>`)}
      ${field('Build', `<input class="inp" name="source" value="${esc(custom ? v.source : '')}" placeholder="branch:develop, commit:<sha> or path:C:\\work\\SB.Placement" spellcheck="false">`, 'data-for="custom"')}
      <div class="s">It queues for the stack's lease, swaps the build in, runs, puts the stack back, then posts the verdict on the ticket. One run at a time; a gate can take an hour.</div>
      <div class="dp-bar">${a ? `<button type="button" class="btn sm danger" data-del>${icon('trash', 'sm')}Delete</button>` : ''}<span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('check', 'sm')}${a ? 'Save' : 'Add action'}</button></div></form>`;
    const f = $('form', pane);
    const sync = () => { const on = { gate: f.tool.value === 'gate', test: f.tool.value === 'test', custom: f.sourcePick.value === 'custom' }; for (const x of $$('[data-for]', f)) x.hidden = !on[x.dataset.for]; };
    f.tool.onchange = sync; f.sourcePick.onchange = sync; sync();
    wireConn(f, 'devstack');
    $('[data-cancel]', f).onclick = () => { S.view = null; render(); };
    const del = $('[data-del]', f);
    if (del) del.onclick = async () => {
      if (!confirm(`Delete "${a.name}"? Agents' grants of it go too.`)) return;
      try { await api('DELETE', `/api/devstack/actions/${enc(a.id)}`); toast('Action deleted', { kind: 'ok' }); S.view = null; await load(); render(); } catch (e) { fail(e); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: f.elements.name.value, tool: f.tool.value, service: f.service.value, kind: f.kind.value, tags: f.tags.value, source: f.sourcePick.value === 'custom' ? f.source.value.trim() : f.sourcePick.value };
      try {
        await api(a ? 'PUT' : 'POST', a ? `/api/devstack/actions/${enc(a.id)}` : '/api/devstack/actions', body);
        toast(a ? 'Action saved' : 'Action added', { kind: 'ok', icon: 'flask' });
        S.view = null; await load(); render();
      } catch (err) { fail(err); }
    };
  }
  // Run a DevStack action now: for a ticket (its build), or a build named here
  function devstackRunner(pane, a) {
    pane.innerHTML = `<form class="dp-form" autocomplete="off"><div class="aa-label">Run ${esc(a.name)}</div>
      <div class="dp-grid">${field('Ticket', '<input class="inp" name="item" placeholder="INT-12" maxlength="40">')}
        ${field('Build (optional)', `<input class="inp" name="source" placeholder="${esc(a.source)}" spellcheck="false">`)}</div>
      <div class="s">Left empty, the build is the action's: ${esc(a.source)}, for the ticket's agent.</div>
      <div class="dp-bar"><span class="dp-grow"></span><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary">${icon('play', 'sm')}Run</button></div></form>`;
    const f = $('form', pane);
    $('[data-cancel]', f).onclick = () => { S.view = null; render(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', `/api/devstack/actions/${enc(a.id)}/run`, { item: f.item.value.trim() || undefined, source: f.source.value.trim() || undefined });
        toast(r.status === 'waiting' ? `${a.name}: waiting for your OK` : `${a.name} started: it queues for the stack`, { kind: 'ok', icon: 'flask' });
        S.view = null; S.tab = 'runs'; await refreshRuns(); render();
      } catch (err) { fail(err); }
    };
  }

  // Who may run a deployment, read off its permission: "drax (environment int, test1) · drax, with your OK"
  const holdersCol = (d) => `<button type="button" class="link-btn ent-col who" data-grant="${esc(d.power || '')}" title="Who may run it|Opens Assignments">${(d.holders || []).length ? (d.holders || []).map((x) => esc(nameOf(x.name))).join(', ') : 'Only you'}</button>`;

  // "who may run it": Assignments, at this deployment's column
  const grantClick = (e) => {
    const a = e.target.closest('[data-grant]');
    if (!a) return false;
    e.preventDefault();
    openGrant(a.dataset.grant);
    return true;
  };

  // Live: runs change as their pipelines move; editors are never redrawn under the human's hands
  let pending = null;
  function onEvent(ev) {
    if (!ev.type?.startsWith('deploy.') || !isOpen()) return;
    clearTimeout(pending);
    pending = setTimeout(refreshRuns, 250);
  }

  return { open, onEvent };
}
