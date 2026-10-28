'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* jira: the Jira REST calls the Integrations page needs (REST API 2, Jira Data Center and Server), as one service
   account (username and password, basic auth), and the library of Jira actions the human names.

   An action is one call with what it needs: { id, name, does, issue, key?, status?, text?, assignee?, project?,
   issueType?, summary? }.
     does:  transition (to status) | comment (text) | assign (assignee) | create (project, issueType, summary, text?)
     issue: ticket (the ticket's Jira issue) | fixed (key) | ask (given when it runs). create makes one instead.
   text and summary may name the ticket: {id} {title}. Each action is a permission, jira.action.<id>, granted per
   agent in Assignments (lib/deploy/grants.ts judges it: its rules name project and status).
   The password stays in this closure: no method returns it, and no error message carries it. */
const jsonfile = require('../jsonfile');

type Obj = Record<string, any>;
type Fail = (status: number, message: string, extra?: Obj) => never;

class JiraError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// Jira Cloud: email and an API token (never the account's password), and people by account id
const isCloud = (url: string) => { try { return /\.atlassian\.net$/i.test(new URL(url).hostname); } catch { return false; } };

// deps: { url, username, password, fetch?, timeoutMs? }
function createJira({ url, username, password, fetch = globalThis.fetch, timeoutMs = 30000 }: { url: string; username: string; password: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }) {
  const root = `${url.replace(/\/+$/, '')}/rest/api/2`;
  const cloud = isCloud(url);
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const k = (key: string) => encodeURIComponent(key);

  async function send(method: string, path: string, body?: unknown): Promise<Obj> {
    let res: Response;
    try {
      res = await fetch(root + path, {
        method,
        headers: { authorization: auth, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: any) { throw new JiraError(502, `Jira could not be reached: ${e?.cause?.code || e?.message || e}`); }
    const content = await res.text();
    if (res.status >= 300 && res.status < 400) throw new JiraError(401, 'Jira sent the sign-in page: check the address, username and password');
    if (!res.ok) throw new JiraError(res.status === 401 || res.status === 403 ? res.status : res.status >= 500 ? 502 : res.status, errorText(content, res.status));
    if (content.trimStart().startsWith('<')) throw new JiraError(401, 'Jira sent a web page instead of an answer: check the address, username and password');
    try { return content ? JSON.parse(content) : {}; } catch { throw new JiraError(502, 'Jira sent something that is not JSON'); }
  }
  function errorText(content: string, status: number): string {
    try {
      const d = JSON.parse(content);
      const m = [...(d?.errorMessages || []), ...Object.values(d?.errors || {})].join('; ');
      if (m) return String(m).slice(0, 300);
    } catch { /* not json */ }
    if (status === 401) return 'Jira refused the username or password';
    return status === 404 ? 'Not found in Jira' : `Jira answered ${status}`;
  }

  return {
    whoami: async () => { const u = await send('GET', '/myself'); return { name: u.name || u.key || username, displayName: u.displayName || username }; },
    projects: async () => (await send('GET', '/project') as any as Obj[]).map((p) => ({ key: p.key, name: p.name })),
    // every status the project's workflows use, in order, once each
    statuses: async (project: string) => [...new Set(((await send('GET', `/project/${k(project)}/statuses`)) as any as Obj[]).flatMap((t) => (t.statuses || []).map((s: Obj) => s.name)))],
    issue: async (key: string) => { const d = await send('GET', `/issue/${k(key)}?fields=status,summary`); return { key: d.key, status: d.fields?.status?.name || null, summary: d.fields?.summary || '' }; },
    transitions: async (key: string) => ((await send('GET', `/issue/${k(key)}/transitions`)).transitions || []).map((t: Obj) => ({ id: String(t.id), name: t.name, to: t.to?.name || t.name })),
    transition: (key: string, id: string) => send('POST', `/issue/${k(key)}/transitions`, { transition: { id } }),
    comment: (key: string, body: string) => send('POST', `/issue/${k(key)}/comment`, { body }),
    // Cloud names people by account id: an email or display name is looked up first, and must match one person
    assign: async (key: string, name: string) => {
      if (!cloud) return send('PUT', `/issue/${k(key)}/assignee`, { name: name || null });
      if (!name || /^[0-9a-f]{24}$|^\d+:[0-9a-f-]{36}$/i.test(name)) return send('PUT', `/issue/${k(key)}/assignee`, { accountId: name || null });
      const found = (await send('GET', `/user/search?query=${encodeURIComponent(name)}`)) as any as Obj[];
      const exact = found.filter((u) => [u.emailAddress, u.displayName].some((v) => String(v || '').toLowerCase() === name.toLowerCase()));
      const one = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : null;
      if (!one) throw new JiraError(400, found.length ? `"${name}" matches ${found.length} Jira users: use their email` : `No Jira user matches "${name}"`);
      return send('PUT', `/issue/${k(key)}/assignee`, { accountId: one.accountId });
    },
    create: async (f: { project: string; issueType: string; summary: string; description?: string }) => {
      const d = await send('POST', '/issue', { fields: { project: { key: f.project }, issuetype: { name: f.issueType }, summary: f.summary, ...(f.description ? { description: f.description } : {}) } });
      return { key: d.key };
    },
  };
}

const DOES = ['transition', 'comment', 'assign', 'create'];
const ISSUE = ['ticket', 'fixed', 'ask'];
const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

function createJiraStore({ file, fail }: { file: string; fail: Fail }) {
  const lib: { actions: Obj[] } = { actions: [], ...jsonfile.readOr(file, {}) };
  const save = () => jsonfile.writeAtomic(file, lib);
  const text = (v: unknown, what: string, max = 200, required = false): string => {
    if (v == null || v === '') { if (required) fail(400, `${what} is required`); return ''; }
    if (typeof v !== 'string') fail(400, `${what} must be text`);
    const s = String(v).trim();
    if (s.length > max) fail(400, `${what} is longer than ${max} characters`);
    if (required && !s) fail(400, `${what} is required`);
    return s;
  };
  const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s_-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '') || 'action';

  function clean(b: Obj): Obj {
    if (!b || typeof b !== 'object') fail(400, 'Send the action as an object');
    const does = text(b.does, 'does', 20, true);
    if (!DOES.includes(does)) fail(400, `does is one of ${DOES.join(', ')}`);
    const out: Obj = { name: text(b.name, 'name', 80, true), does };
    if (does === 'create') {
      out.project = text(b.project, 'project', 40, true).toUpperCase();
      out.issueType = text(b.issueType, 'issueType', 60) || 'Task';
      out.summary = text(b.summary, 'summary', 250) || '{title}';
      const t = text(b.text, 'text', 4000);
      if (t) out.text = t;
      return out;
    }
    out.issue = text(b.issue, 'issue', 10) || 'ticket';
    if (!ISSUE.includes(out.issue)) fail(400, `issue is one of ${ISSUE.join(', ')}`);
    if (out.issue === 'fixed') {
      out.key = text(b.key, 'key', 40, true).toUpperCase();
      if (!KEY_RE.test(out.key)) fail(400, `"${out.key}" is not a Jira issue key such as BET-1234`);
    }
    if (does === 'transition') out.status = text(b.status, 'status', 80, true);
    if (does === 'comment') { const t = text(b.text, 'text', 4000); if (t) out.text = t; } // left out: asked for when it runs
    if (does === 'assign') out.assignee = text(b.assignee, 'assignee', 100); // "" unassigns
    return out;
  }
  const action = (id: string) => lib.actions.find((a) => a.id === id) || null;
  function saveAction(b: Obj, by: string, id?: string): Obj {
    const a = clean(b);
    if (id) {
      const i = lib.actions.findIndex((x) => x.id === id);
      if (i < 0) fail(404, `No Jira action "${id}"`);
      lib.actions[i] = { id, ...a, updatedBy: by };
      save();
      return lib.actions[i];
    }
    let nid = slug(a.name);
    for (let n = 2; action(nid); n++) nid = `${slug(a.name)}-${n}`;
    const out = { id: nid, ...a, createdBy: by };
    lib.actions.push(out);
    save();
    return out;
  }
  function deleteAction(id: string) {
    if (!action(id)) fail(404, `No Jira action "${id}"`);
    lib.actions = lib.actions.filter((a) => a.id !== id);
    save();
  }
  return { actions: () => lib.actions, action, saveAction, deleteAction };
}

// {id} and {title} of the ticket, in a comment or summary
const fill = (s: string, item: Obj | null) => String(s || '').replace(/\{(id|title)\}/g, (_m, f) => (item ? String(item[f] ?? '') : ''));

/* The ticket's Jira issue: its "jira" field or property, else (find: "title") the first key in its title that isn't
   one of this board's own ids. → the key, or null. */
function issueOfTicket(item: Obj | null, { find = 'title', boardPrefix = '' }: { find?: string; boardPrefix?: string } = {}): string | null {
  if (!item) return null;
  const own = String(item.fields?.jira || item.properties?.jira || '').trim().toUpperCase();
  if (KEY_RE.test(own)) return own;
  if (find !== 'title') return null;
  for (const m of String(item.title || '').toUpperCase().matchAll(/\b([A-Z][A-Z0-9_]*-\d+)\b/g)) {
    if (!boardPrefix || !m[1].startsWith(`${boardPrefix.toUpperCase()}-`)) return m[1];
  }
  return null;
}

module.exports = { createJira, createJiraStore, JiraError, issueOfTicket, fill, isCloud, KEY_RE, DOES };
