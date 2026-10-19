'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Who a board event is for (INT-381). Pure rules over plain data: a ticket, the actor, the board's master lease
// and the time. The board (server.js) and the alerting simulator (lib/sim) use the same functions, so a test can
// say exactly who hears about an event and who is woken by it.
//
//   recipients  everyone who hears about it (their inbox, …/work): leaseholder, past leaseholders, whoever asked
//               for help, the agent author, the assignee, thread participants, @mentions, the master-lease holder
//   addressed   the ones it is *for* (a mention, an assignment, a handover, an answer, a verdict): standing agents
//               wake on these; the rest of the recipients just hear about it. Always a subset of recipients.

// Housekeeping events never wake anyone (a status line from one agent must not wake the others).
const QUIET_TYPES = new Set(['lease.status', 'lease.renewed', 'item.reordered', 'reaction.added', 'reaction.removed']);
// INT-343: how long a seen-but-unanswered mention stays listed
const UNANSWERED_DAYS = 3;

// @names in markdown that count as mentions: not inside `code`, ``` blocks or > quotes (so talking *about* an
// agent doesn't wake it).
const plainText = (md) => String(md || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
function mentionsIn(text) {
  return [...new Set([...plainText(text).matchAll(/(?:^|[\s(])@([\w.-]+)/g)].map((m) => m[1].replace(/[.-]+$/, '')))];
}

/**
 * deps: { now: () => ms, isRunning: (name) => bool } — the clock, and whether a standing agent is mid-run.
 */
function createRecipients({ now = () => Date.now(), isRunning = () => false } = {}) {
  const activeLease = (item) => (item.lease && Date.parse(item.lease.expiresAt) > now() ? item.lease : null);
  const activeMaster = (ctx) => {
    const m = ctx.board.master;
    return m && (!m.expiresAt || Date.parse(m.expiresAt) > now()) ? m : null;
  };

  function snapshot(ctx, item) {
    const col = ctx.board.columns.find((c) => c.id === item.columnId);
    return {
      id: item.id, title: item.title, type: item.type, priority: item.priority,
      columnId: item.columnId, column: col ? col.name : null, parent: item.parent,
      claimant: activeLease(item)?.claimant || null, needsHuman: !!item.needsHuman, assignee: item.assignee || null,
    };
  }

  // Everyone who hears about an event on this ticket, minus the actor.
  function recipientsFor(item, actor, extra = []) {
    const s = new Set(extra);
    const l = activeLease(item);
    if (l) s.add(l.claimant);
    if (item.needsHuman) s.add(item.needsHuman.raisedBy);
    if (item.author?.kind === 'agent') s.add(item.author.name);
    if (item.assignee) s.add(item.assignee);
    for (const w of item.workedBy || []) s.add(w); // released after review, still owns the follow-up
    for (const c of item.comments || []) if (c.author?.name && c.author.kind !== 'system') s.add(c.author.name); // thread participants (the board's own notes have none)
    s.delete(actor.name);
    return [...s];
  }

  // INT-343: a comment that @mentions an agent which saw it (its 👀 is on it) but has not answered by the end of its
  // run: no later comment from it on the card and no reaction on the comment other than 👀/⏳. Read-only and derived,
  // so it never wakes anyone; it clears by itself the moment the agent answers. An agent mid-run is still answering.
  function unansweredIn(item) {
    const out = [];
    for (const c of item.comments || []) {
      if (c.intent === 'explain' || !c.author || !c.reactions?.['👀']?.length) continue; // explain has its own action; no 👀 = still queued
      if (now() - Date.parse(c.createdAt) > UNANSWERED_DAYS * 86400000) continue;
      const mentioned = new Set(mentionsIn(c.body).map((n) => n.toLowerCase()));
      for (const who of c.reactions['👀']) {
        if (who === c.author.name || !mentioned.has(who.toLowerCase())) continue;
        const answered = (item.comments || []).some((x) => x.author?.name === who && x.createdAt > c.createdAt)
          || Object.entries(c.reactions).some(([emoji, names]) => emoji !== '👀' && emoji !== '⏳' && names.includes(who));
        if (!answered && !isRunning(who)) out.push({ commentId: c.id, agent: who, by: c.author.name, since: c.createdAt });
      }
    }
    return out;
  }

  // Who an "explain" comment is for: its @mentions, else the agent it replies to, else whoever asked for the review,
  // else whoever worked the ticket last, else the assignee. The event and …/work both use this.
  function explainTargets(item, c) {
    const mentions = mentionsIn(c.body);
    if (mentions.length) return mentions;
    const target = (c.replyTo && item.comments?.find((x) => x.id === c.replyTo)?.author) || null;
    const who = target?.kind === 'agent' ? target.name : item.questions?.find((q) => q.kind === 'review')?.raisedBy || item.workedBy?.at(-1) || item.assignee;
    return who ? [who] : [];
  }

  // An event about a ticket, with who it is for. extra.mentions: who it addresses (mentions, assignees, the asker…).
  function itemEvent(ctx, type, item, actor, extra = {}) {
    const { mentions = [], ...rest } = extra;
    if (QUIET_TYPES.has(type)) {
      return { board: ctx.id, type, actor, itemId: item.id, columnId: item.columnId, item: snapshot(ctx, item), recipients: [], ...rest };
    }
    // An approval is news, not a task: the requester stays in recipients (inbox, …/work) but isn't woken for it.
    const approval = type === 'review.approved' || (type === 'attention.resolved' && rest.verdict === 'approve');
    const addressed = approval ? [] : [...new Set(mentions.filter((n) => n && n !== actor.name))];
    return {
      board: ctx.id, type, actor, itemId: item.id, columnId: item.columnId,
      // The master-lease holder works every ticket without leasing it, so it hears about all of them.
      item: snapshot(ctx, item), recipients: recipientsFor(item, actor, [...mentions, activeMaster(ctx)?.holder].filter((n) => n && n !== actor.name)),
      ...(addressed.length ? { addressed } : {}),
      ...(mentions.length ? { mentions } : {}), ...rest,
    };
  }

  return { activeLease, activeMaster, snapshot, recipientsFor, unansweredIn, explainTargets, itemEvent };
}

module.exports = { createRecipients, QUIET_TYPES, UNANSWERED_DAYS, plainText, mentionsIn };
