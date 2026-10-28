'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* confluence: the Confluence REST calls the Integrations page needs (REST API, Data Center and Server; Cloud too, with
   its address ending in /wiki and an API token as the password), as one account (basic auth), and the library of
   Confluence actions the human names.

   An action is one page change: { id, name, does, page?, pageId?, space?, parent?, title?, heading?, text? }.
     does: create (a page in space, under parent, called title) | append (to the page) | section (replace what is under
           heading on the page, or add that section at the end)
     page: fixed (pageId) | ask (given when it runs). text is markdown; left out, it is given when it runs.
   title and text may say {id}, {title}, {field.<key>}… (filled per ticket by the caller). Each action is a permission,
   confluence.action.<id>, granted per agent in Assignments; its rules name space.
   The password stays in this closure: no method returns it, and no error message carries it. */
const jsonfile = require('../jsonfile');
const { toStorage, toMarkdown, replaceSection } = require('./markdown.ts');

type Obj = Record<string, any>;
type Fail = (status: number, message: string, extra?: Obj) => never;

class ConfluenceError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// A page's id from what a person pastes: the id, or a page link (…?pageId=123, …/pages/123/…); a Cloud folder's
// link (…/folder/123/…) too, as a parent
function pageIdOf(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (/^\d{1,20}$/.test(s)) return s;
  return /[?&]pageId=(\d+)/.exec(s)?.[1] || /\/(?:pages|folder)\/(\d+)(?:[/?#]|$)/.exec(s)?.[1] || null;
}

// The site's root from any Confluence link a person pastes: Cloud keeps up to /wiki (added when missing), Data Center
// drops a page or space path but keeps a context path (https://x.com/confluence/display/ENG → https://x.com/confluence)
function siteOf(v: string): string {
  let u: URL;
  try { u = new URL(String(v).trim()); } catch { return String(v).trim(); }
  const wiki = /^(.*?\/wiki)(?:\/|$)/i.exec(u.pathname);
  let path = wiki ? wiki[1] : u.pathname.replace(/\/(display|spaces|pages|x|rest|plugins|[a-z]+\.action)(\/.*)?$/i, '');
  if (!wiki && /\.atlassian\.net$/i.test(u.hostname)) path = '/wiki';
  return `${u.origin}${path.replace(/\/+$/, '')}`;
}

// Atlassian Cloud: its API takes the account's email and an API token, never the account's password
const isCloud = (url: string) => { try { return /\.atlassian\.net$/i.test(new URL(url).hostname); } catch { return false; } };

// deps: { url, username, password, fetch?, timeoutMs? }
function createConfluence({ url, username, password, fetch = globalThis.fetch, timeoutMs = 30000 }: { url: string; username: string; password: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }) {
  const base = url.replace(/\/+$/, '');
  const root = `${base}/rest/api`;
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

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
    } catch (e: any) { throw new ConfluenceError(502, `Confluence could not be reached: ${e?.cause?.code || e?.message || e}`); }
    const content = await res.text();
    if (res.status >= 300 && res.status < 400) throw new ConfluenceError(401, 'Confluence sent the sign-in page: check the address, username and password');
    if (!res.ok) throw new ConfluenceError(res.status === 401 || res.status === 403 ? res.status : res.status >= 500 ? 502 : res.status, errorText(content, res.status));
    if (content.trimStart().startsWith('<')) throw new ConfluenceError(401, 'Confluence sent a web page instead of an answer: check the address (Cloud ends in /wiki), username and password');
    try { return content ? JSON.parse(content) : {}; } catch { throw new ConfluenceError(502, 'Confluence sent something that is not JSON'); }
  }
  function errorText(content: string, status: number): string {
    try { const m = JSON.parse(content)?.message; if (m) return String(m).slice(0, 300); } catch { /* not json */ }
    if (status === 401) return 'Confluence refused the username or password';
    if (status === 409) return 'Someone changed the page at the same moment: run it again';
    return status === 404 ? 'Not found in Confluence (or the account can\'t see it)' : `Confluence answered ${status}`;
  }
  const view = (d: Obj) => ({
    id: String(d.id), title: String(d.title || ''), space: d.space?.key || null, version: Number(d.version?.number || 1),
    url: d._links?.webui ? `${d._links.base || base}${d._links.webui}` : `${base}/pages/viewpage.action?pageId=${d.id}`,
  });
  const storageBody = (value: string) => ({ storage: { value, representation: 'storage' } });

  async function page(id: string) {
    const d = await send('GET', `/content/${encodeURIComponent(id)}?expand=body.storage,version,space`);
    return { ...view(d), storage: String(d.body?.storage?.value || '') };
  }
  // write a page's new body over the version read: a change in between answers 409, never overwritten
  async function write(p: Obj, storage: string, message: string) {
    const d = await send('PUT', `/content/${encodeURIComponent(p.id)}`, { id: p.id, type: 'page', title: p.title, version: { number: p.version + 1, message }, body: storageBody(storage) });
    return view(d);
  }
  return {
    whoami: async () => { const u = await send('GET', '/user/current'); return { name: u.username || u.accountId || username, displayName: u.displayName || u.publicName || username }; },
    spaces: async () => ((await send('GET', '/space?limit=500&type=global')).results || []).map((s: Obj) => ({ key: s.key, name: s.name })).sort((a: Obj, b: Obj) => a.name.localeCompare(b.name)),
    page,
    markdown: async (id: string) => { const p = await page(id); return { id: p.id, title: p.title, space: p.space, version: p.version, url: p.url, markdown: toMarkdown(p.storage) }; },
    create: async (f: { space: string; parent?: string | null; title: string; markdown: string }) =>
      view(await send('POST', '/content', { type: 'page', title: f.title, space: { key: f.space }, ...(f.parent ? { ancestors: [{ id: f.parent }] } : {}), body: storageBody(toStorage(f.markdown)) })),
    append: async (id: string, markdown: string, message: string) => { const p = await page(id); return write(p, p.storage + toStorage(markdown), message); },
    section: async (id: string, heading: string, markdown: string, message: string) => {
      const p = await page(id);
      const r = replaceSection(p.storage, heading, markdown);
      return { ...(await write(p, r.storage, message)), found: r.found };
    },
  };
}

const DOES = ['create', 'append', 'section'];

function createConfluenceStore({ file, fail }: { file: string; fail: Fail }) {
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
    if (!DOES.includes(does)) fail(400, `does is one of ${DOES.join(', ')}: create a page, append to one, or replace a section of one`);
    const out: Obj = { name: text(b.name, 'name', 80, true), does };
    if (does === 'create') {
      out.space = text(b.space, 'space', 60, true);
      const parent = text(b.parent, 'parent', 500);
      if (parent) { out.parent = pageIdOf(parent) || fail(400, `"${parent}" is not a page id or a page link`, { hint: 'Paste the parent page\'s link, or its id' }); }
      out.title = text(b.title, 'title', 250) || '{title}';
    } else {
      out.page = text(b.page, 'page', 10) || 'fixed';
      if (!['fixed', 'ask'].includes(out.page)) fail(400, 'page is fixed (the page given here) or ask (given when it runs)');
      if (out.page === 'fixed') { const p = text(b.pageId, 'pageId', 500, true); out.pageId = pageIdOf(p) || fail(400, `"${p}" is not a page id or a page link`, { hint: 'Paste the page\'s link, or its id' }); }
      if (does === 'section') out.heading = text(b.heading, 'heading', 200, true);
    }
    const t = text(b.text, 'text', 20000);
    if (t) out.text = t; // left out: given when it runs (an agent writes it)
    return out;
  }
  const action = (id: string) => lib.actions.find((a) => a.id === id) || null;
  function saveAction(b: Obj, by: string, id?: string): Obj {
    const a = clean(b);
    if (id) {
      const i = lib.actions.findIndex((x) => x.id === id);
      if (i < 0) fail(404, `No Confluence action "${id}"`);
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
    if (!action(id)) fail(404, `No Confluence action "${id}"`);
    lib.actions = lib.actions.filter((a) => a.id !== id);
    save();
  }
  return { actions: () => lib.actions, action, saveAction, deleteAction };
}

module.exports = { createConfluence, createConfluenceStore, ConfluenceError, pageIdOf, siteOf, isCloud, DOES };
