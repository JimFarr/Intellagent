'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* webhooks: Azure DevOps service hooks, received by the board (POST /hooks/ado). Azure DevOps signs nothing, so each
   call carries the username and password the human put on the service hook (basic auth); anything else is refused.

   A call is answered at once and its event goes on a buffer; every flushMs (10 s) the buffer is handed to onFlush,
   which sets off the rules, and what was handed on leaves the buffer. Azure DevOps retries a call it thinks failed,
   so an event already seen (by its key) is taken once.

   Events, normalized:
     comment: { kind: 'comment', key, pr: { id, title, repo, project, source, target, url, by }, comment: { id, threadId,
              parentId, text, author, url, at } }  ("Pull request commented on"; system comments are left out) */
const crypto = require('crypto');

type Obj = Record<string, any>;
type Creds = { username: string; password: string } | null;
type Deps = { creds: () => Creds; onFlush: (events: Obj[]) => void | Promise<void>; flushMs?: number; log?: (m: string) => void };

const SEEN_KEPT = 2000;
const shortRef = (r: unknown) => (r ? String(r).replace(/^refs\/heads\//, '') : null);
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// The board's view of a PR, from a service hook's pullRequest (the same fields the PR watch gives)
function prOf(p: Obj): Obj {
  const repo = String(p.repository?.name || '');
  const web = String(p.repository?.remoteUrl || p.repository?.webUrl || '').replace(/\/$/, '');
  return {
    id: Number(p.pullRequestId), title: String(p.title || ''), repo, project: p.repository?.project?.name ?? null,
    source: shortRef(p.sourceRefName), target: shortRef(p.targetRefName), by: p.createdBy?.displayName ?? null,
    url: web ? `${web}/pullrequest/${Number(p.pullRequestId)}` : null,
  };
}

// One service hook call → the event the board keeps, or null for one it doesn't use
function parse(body: Obj): Obj | null {
  if (body?.eventType !== 'ms.vss-code.git-pullrequest-comment-event') return null;
  const c = body.resource?.comment, p = body.resource?.pullRequest;
  if (!c || !p?.pullRequestId || c.commentType === 'system') return null;
  const pr = prOf(p);
  const threadId = Number(/\/threads\/(\d+)/.exec(String(c._links?.threads?.href || c._links?.self?.href || ''))?.[1]) || null;
  return {
    kind: 'comment', key: `comment:${pr.id}:${threadId}:${c.id}`, pr,
    comment: {
      id: Number(c.id), threadId, parentId: Number(c.parentCommentId) || null, text: String(c.content || ''),
      author: c.author?.displayName ?? null, url: pr.url && threadId ? `${pr.url}?discussionId=${threadId}` : pr.url, at: c.publishedDate ?? null,
    },
  };
}

function createAdoWebhooks({ creds, onFlush, flushMs = 10_000, log = console.warn }: Deps) {
  let buffer: Obj[] = [];
  const seen = new Set<string>();
  let lastAt: string | null = null;
  let flushing = false;

  // basic auth against the hook's username and password; no credentials set means the hook is off
  function allowed(authorization: unknown): boolean {
    const want = creds();
    if (!want) return false;
    const m = /^Basic\s+(.+)$/i.exec(String(authorization || ''));
    if (!m) return false;
    const got = Buffer.from(m[1], 'base64').toString('utf8');
    return same(got, `${want.username}:${want.password}`);
  }

  // → what was done with it: 'buffered', 'repeat' (a retry of one already taken) or 'ignored'
  function receive(body: Obj): 'buffered' | 'repeat' | 'ignored' {
    lastAt = new Date().toISOString();
    const ev = parse(body);
    if (!ev) return 'ignored';
    if (seen.has(ev.key)) return 'repeat';
    seen.add(ev.key);
    if (seen.size > SEEN_KEPT) seen.delete(seen.values().next().value as string);
    buffer.push(ev);
    return 'buffered';
  }

  // Hand the buffer on, then drop what was handed on; an event that lands meanwhile waits for the next pass
  async function flush() {
    if (flushing || !buffer.length) return;
    flushing = true;
    const batch = [...buffer]; // a copy: what lands during the pass must not join it
    try { await onFlush(batch); } catch (e: any) { log(`webhooks: a flush failed: ${e?.message || e}`); } finally {
      buffer = buffer.filter((e) => !batch.includes(e));
      flushing = false;
    }
  }
  const timer = setInterval(() => { flush(); }, flushMs);
  timer.unref?.();

  return { allowed, receive, flush, stop: () => clearInterval(timer), view: () => ({ buffered: buffer.length, lastAt }) };
}

const newCreds = () => ({ username: 'intellagent', password: crypto.randomBytes(24).toString('base64url') });

module.exports = { createAdoWebhooks, parse, newCreds };
