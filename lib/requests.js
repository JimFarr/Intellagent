'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* requests: free-form asks from the human to an agent ("let's create some tickets for X"), not tied
   to a ticket. They go to a chosen agent, else the board's coordinator, else the project's default agent. */

// deps: { fail, str, rid, now, tx, trimChange, saveAttachment, path, M (the manifest: defaultAgent),
//   mayWithdraw, withdrawReason (shared with withdrawing a question on a ticket) }
function createRequests({ fail, str, rid, now, tx, trimChange, saveAttachment, path, M, mayWithdraw, withdrawReason }) {
  // Files sent with a request or a reply (pasted screenshots…): stored like ticket attachments. Events carry
  // each file's local path too, so a woken agent can open it with its file tools.
  function requestFiles(ctx, req, list, actor) {
    if (list == null) return [];
    if (!Array.isArray(list)) fail(400, '"attachments" must be an array');
    if (list.length > 10) fail(400, 'At most 10 attachments per message');
    return list.map((a) => saveAttachment(ctx, req, a, actor));
  }
  const filesForEvent = (ctx, atts) => (atts || []).map((a) => ({
    name: a.name, mime: a.mime, url: a.url,
    ...(a.kind === 'file' ? { path: path.join(ctx.attachDir, decodeURIComponent(a.url.split('/').pop())) } : {}),
  }));

  function requestTarget(ctx, to) {
    return (to && str(to, 64).trim()) || ctx.board.coordinator || M.defaultAgent || null;
  }
  // The conversation so far between the human and this agent (earlier requests and their replies), oldest
  // first, so a follow-up question reaches the agent with its context. Bounded: the last 10 messages of the
  // last week, each trimmed.
  function conversation(ctx, req) {
    const since = Date.now() - 7 * 86_400_000;
    const msgs = [];
    for (const q of ctx.board.requests || []) {
      if (q.id === req.id || q.to !== req.to || Date.parse(q.at) < since) continue;
      msgs.push({ from: q.by?.name || '?', at: q.at, body: q.body, request: q.id });
      for (const r of q.replies || []) msgs.push({ from: r.author?.name || '?', at: r.at, body: r.body, request: q.id });
    }
    return msgs.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-10)
      .map((m) => ({ ...m, body: m.body.length > 500 ? `${m.body.slice(0, 500)}…` : m.body }));
  }

  function createRequest(ctx, d, actor) {
    const body = str(d.body || '', 20_000).trim();
    if (!body && !d.attachments?.length) fail(400, '"body" is required');
    const to = requestTarget(ctx, d.to);
    if (!to) fail(400, 'No agent to send this to: pass "to", or set a coordinator (PATCH /api/boards/<board> { "coordinator": "name" }).', { code: 'NO_AGENT' });
    return tx(ctx, (events) => {
      const req = { id: rid('r'), body, to, by: actor, at: now(), status: 'open', replies: [] };
      const atts = requestFiles(ctx, req, d.attachments, actor);
      if (atts.length) req.attachments = atts;
      (ctx.board.requests ||= []).push(req);
      if (ctx.board.requests.length > 300) ctx.board.requests.splice(0, ctx.board.requests.length - 300);
      const history = conversation(ctx, req);
      events.push({ board: ctx.id, type: 'request.created', actor, request: { id: req.id, body: trimChange(body), to, ...(atts.length ? { attachments: filesForEvent(ctx, atts) } : {}), ...(history.length ? { history } : {}) }, recipients: [to].filter((n) => n !== actor.name), addressed: [to].filter((n) => n !== actor.name) });
      return req;
    });
  }
  function getRequest(ctx, id) {
    const req = (ctx.board.requests || []).find((x) => x.id === id);
    if (!req) fail(404, `No request "${id}"`);
    return req;
  }
  function replyRequest(ctx, id, d, actor) {
    return tx(ctx, (events) => {
      const req = getRequest(ctx, id);
      const body = str(d.body || '', 20_000).trim();
      const atts = requestFiles(ctx, req, d.attachments, actor);
      if (!body && !atts.length && d.done == null) fail(400, '"body" or "done" is required');
      if (body || atts.length) req.replies.push({ id: rid('c'), author: actor, body, at: now(), ...(atts.length ? { attachments: atts } : {}) });
      if (d.done === true) req.status = 'done';
      if (d.done === false) req.status = 'open';
      req.updatedAt = now();
      const to = actor.name === req.to ? [] : [req.to];
      // Both ends of a conversation are waiting on the other: the agent asked hears a follow-up ("done with the
      // lease"), and an agent that asked another (a builder asking the Guard for a lease) hears the answer.
      const asker = req.by?.kind === 'agent' && req.by.name !== actor.name ? [req.by.name] : [];
      events.push({ board: ctx.id, type: req.status === 'done' && d.done ? 'request.done' : 'request.replied', actor, request: { id: req.id, body: trimChange(req.body), to: req.to, by: req.by?.name, status: req.status }, ...(body ? { reply: trimChange(body) } : {}), ...(atts.length ? { attachments: filesForEvent(ctx, atts) } : {}), recipients: [...new Set([...to, ...asker])], ...(to.length || asker.length ? { addressed: [...new Set([...to, ...asker])] } : {}) });
      return req;
    });
  }

  function withdrawRequest(ctx, id, d, actor) {
    const reason = withdrawReason(d);
    return tx(ctx, (events) => {
      const req = getRequest(ctx, id);
      if (req.status !== 'open') fail(409, `Request ${req.id} is already ${req.withdrawn ? 'withdrawn' : 'done'}`, { code: 'CONFLICT', hint: 'Nothing to withdraw' });
      mayWithdraw(ctx, actor, req.by?.name, `Request ${req.id}`);
      // status stays open|done for older readers; `withdrawn` says how it ended
      req.status = 'done';
      req.withdrawn = { by: actor.name, reason, at: now() };
      req.updatedAt = now();
      // Nobody is woken: there is nothing left to do, and the request is gone from its agent's …/work.
      events.push({ board: ctx.id, type: 'request.withdrawn', actor, request: { id: req.id, body: trimChange(req.body), to: req.to, by: req.by?.name, status: req.status }, reason, recipients: [] });
      return req;
    });
  }

  return { requestFiles, filesForEvent, requestTarget, conversation, createRequest, getRequest, replyRequest, withdrawRequest };
}

module.exports = { createRequests };
