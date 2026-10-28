'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* pr-actions: the human's library of Azure DevOps pull request actions, each one call made with the board's token:
     reply    (text) on the thread a comment started
     resolve  (status: fixed | wontFix | closed; text? replied first) that thread
     comment  (text) as a new thread on the PR
     approve  the PR, as the token's owner (vote 10)
   An action is { id, name, does, status?, text? }; its text may say {id} {title} {comment.author}… (filled by the
   caller), and left out it is given when it runs (an agent writes it). Which PR and thread: what the run is given,
   else what set the rule off (a "PR is commented on" event), else the ticket's pr field or property. Each action is
   a permission, ado.action.<id>, granted per agent in Assignments; its rules name repo. */
const jsonfile = require('../jsonfile');

type Obj = Record<string, any>;
type Fail = (status: number, message: string, extra?: Obj) => never;

const DOES = ['reply', 'resolve', 'comment', 'approve'];
const STATUSES = ['fixed', 'wontFix', 'closed'];

// A PR's id from what a person or a ticket gives: the id, or its link (…/pullrequest/123)
function prIdOf(v: unknown): number | null {
  const s = String(v ?? '').trim();
  if (/^\d{1,9}$/.test(s)) return Number(s);
  const m = /\/pullrequest\/(\d+)/i.exec(s);
  return m ? Number(m[1]) : null;
}

function createPrActionStore({ file, fail }: { file: string; fail: Fail }) {
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
    if (!DOES.includes(does)) fail(400, `does is one of ${DOES.join(', ')}: reply on a thread, resolve it, comment on the PR, or approve it`);
    const out: Obj = { name: text(b.name, 'name', 80, true), does };
    if (does === 'resolve') {
      out.status = text(b.status, 'status', 20) || 'fixed';
      if (!STATUSES.includes(out.status)) fail(400, `status is one of ${STATUSES.join(', ')}`);
    }
    if (does !== 'approve') { const t = text(b.text, 'text', 4000); if (t) out.text = t; } // left out: given when it runs (resolve: none)
    return out;
  }
  const action = (id: string) => lib.actions.find((a) => a.id === id) || null;
  function saveAction(b: Obj, by: string, id?: string): Obj {
    const a = clean(b);
    if (id) {
      const i = lib.actions.findIndex((x) => x.id === id);
      if (i < 0) fail(404, `No pull request action "${id}"`);
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
    if (!action(id)) fail(404, `No pull request action "${id}"`);
    lib.actions = lib.actions.filter((a) => a.id !== id);
    save();
  }
  return { actions: () => lib.actions, action, saveAction, deleteAction };
}

// What it does, in a few words
const doesWords = (a: Obj) => ({ reply: 'reply on the comment\'s thread', resolve: `resolve the thread as ${a.status}${a.text ? ', with a reply' : ''}`, comment: 'comment on the PR', approve: 'approve the PR' }[a.does as string] || a.does);

module.exports = { createPrActionStore, prIdOf, doesWords, DOES, STATUSES };
