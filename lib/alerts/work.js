'use strict';
// What each agent has to do, read off the boards (INT-382): workFor is an agent's …/work (its "next" actions);
// pendingWork turns that into stable keys the scheduler wakes it for, once per key; waitingWork and stalledFor feed
// the idle alarm and supervision. Moved out of server.js unchanged: everything the board knows that these rules read
// comes in through `world`, so the board and the alerting simulator run the very same rules.
const crypto = require('crypto');
const { PRIO_RANK, doneColumnId, openBlockersOf, asleep, pickupColumns, replyAfter, ownWork, authorsOf, activeFocus, inActiveFocus, focusNames } = require('./board');

/**
 * world: {
 *   now: () => ms, boards: () => iterable of { id, board }, leaseWarningMinutes: () => number,
 *   recipients: lib/alerts/recipients (activeLease, activeMaster, explainTargets, unansweredIn),
 *   oks: lib/alerts/oks (inScope, okStatus, reviewerRule, assignedOks),
 *   agents: { get(name) → { status, queued, lastRun } (throws if not a standing agent), isRunning(name), superviseOf(name),
 *             pickupOf(name) → false | "ready" | "all", grantsOf(name) → [{ power, where?, minOks?, from? }], isHelper(name),
 *             reviewerPool() → [{ name, areas }] },
 *   isCoordinator(ctx, name), approvalsOff(ctx), commitsPending(item, ctx),
 * }
 */
function createWork(world) {
  const { now, boards, leaseWarningMinutes, agents, isCoordinator, approvalsOff, commitsPending } = world;
  const { activeLease, activeMaster, explainTargets, unansweredIn } = world.recipients;
  const { inScope, okStatus, reviewerRule, assignedOks } = world.oks;

  function delegationGaps(ctx, it, q, grants) {
    const gaps = [];
    const gap = (key, text) => gaps.push({ key, text });
    let early = false;
    if (!String(q.notes?.evidence || '').trim()) gap('evidence', `evidence from ${q.raisedBy} (the review has none: screenshots, outputs, what to look at in the Preview)`);
    const worried = (it.reviewers || []).filter((r) => r.verdict === 'concerns').map((r) => r.name);
    if (worried.length) gap(`concerns:${worried.join(',')}`, `${worried.join(', ')}'s concerns resolved (the author fixes them and asks for review again)`);
    const open = openBlockersOf(ctx, it);
    if (open.length) gap(`blocked:${open.join(',')}`, `its blockers done first: it waits on ${open.join(', ')}`);
    const scoped = grants.filter((g) => inScope(ctx, it, g.where));
    if (scoped.length && !scoped.some((g) => okStatus(ctx, it, g).met)) {
      // In scope, waiting on a required-reviewers rule: name each ok still missing (the closest grant's).
      const st = scoped.map((g) => okStatus(ctx, it, g)).sort((a, b) => (a.need - a.have) - (b.need - b.have))[0];
      if (st.early) early = true;
      else gap(st.key, st.text);
    } else if (scoped.length) {
      // Only rule-less grants are met: the floor has to hold too (decideReview)
      const st = scoped.some((g) => reviewerRule(g) && okStatus(ctx, it, g).met) ? { met: true } : assignedOks(ctx, it);
      if (st.met) { /* nothing missing */ } else if (st.early) early = true;
      else gap(st.key, st.text);
    } else {
      // Several grants can each name a reviewer (reviewers.nebula, reviewers.drax): any one of them passing is
      // enough. Only reviewers who could review this ticket count (never one of its authors).
      const authors = authorsOf(it);
      const who = [...new Set(grants.flatMap((g) => Object.keys(g.where || {}).map((k) => /^reviewers\.([\w.-]+)$/.exec(k)?.[1]).filter(Boolean)))].filter((n) => !authors.has(n));
      const rs = who.map((n) => (it.reviewers || []).find((x) => x.name.toLowerCase() === n.toLowerCase())).filter(Boolean);
      const waiting = rs.filter((r) => !r.verdict);
      const oks = rs.filter((r) => r.verdict === 'ok');
      if (grants.every((g) => !Object.keys(g.where || {}).some((k) => k.startsWith('reviewers.')))) {
        for (const g of grants.slice(0, 1)) for (const [k, want] of Object.entries(g.where || {})) if (!inScope(ctx, it, { [k]: want })) gap(`scope:${k}`, `${k} to be ${[].concat(want).join(' or ')}`);
      } else if (!who.length) gap('reviewer:none', 'a reviewer your grant trusts, but every one of them worked on this ticket');
      else if (oks.some((r) => !r.verified)) gap(`unverified:${oks.map((r) => r.name).join(',')}`, `${oks.map((r) => r.name).join(' or ')}'s ok can't stand in for the human: this board doesn't check that reviewer's token (the human turns on agent tokens)`);
      else if (oks.length && commitsPending(it, ctx)) early = true; // the commits are being looked up: tell next time
      else if (oks.length) gap(`stale:${oks.map((r) => r.name).join(',')}`, `a fresh verdict from ${oks.map((r) => r.name).join(' or ')}: there are commits on the ticket since the ok`);
      else if (!rs.length) gap(`assign:${who.join(',')}`, `${who.join(' or ')} assigned as reviewer`);
      else if (waiting.some((r) => now() - Date.parse(r.at || 0) < 30 * 60_000)) early = true;
      else if (waiting.length) gap(`verdict:${waiting.map((r) => r.name).join(',')}`, `${waiting.map((r) => r.name).join(' or ')}'s verdict (asked ${Math.round((now() - Math.min(...waiting.map((r) => Date.parse(r.at)))) / 60_000)} min ago)`);
      else gap(`ok:${who.join(',')}`, `an ok from ${who.join(' or ')} (verdicts so far: ${rs.map((r) => `${r.name} ${r.verdict}`).join(', ')})`);
    }
    return !gaps.length && early ? null : gaps;
  }
  
  // What still reaches an agent outside the active focus board (see workFor).
  const FOCUS_THROUGH = new Set(['explain', 'write', 'renew', 'continue', 'land', 'answer_lease_request']);
  function workFor(ctx, name) {
    const b = ctx.board;
    const items = b.columns.flatMap((c) => c.itemIds.map((id) => b.items[id]).filter(Boolean));
    const done = doneColumnId(ctx);
    const colName = (it) => b.columns.find((c) => c.id === it.columnId)?.name;
    const brief = (it, extra = {}) => { const focus = focusNames(ctx, it.id); return { id: it.id, title: it.title, column: colName(it), priority: it.priority, type: it.type, ...(focus.length ? { focus } : {}), ...extra }; };
    const focus = activeFocus(ctx);
    const lastMine = (it) => Math.max(0, ...(it.comments || []).filter((c) => c.author?.name === name).map((c) => Date.parse(c.createdAt)),
      it.lease?.claimant === name ? Date.parse(it.lease.leasedAt) : 0);
    const master = activeMaster(ctx);
    const leases = [];
    const answered = [];
    const feedback = [];
    const concerns = [];
    const waiting = [];
    const assigned = [];
    for (const it of items) {
      const l = activeLease(it);
      if (l?.claimant === name) leases.push(brief(it, { expiresAt: l.expiresAt, minutesLeft: Math.max(0, Math.round((Date.parse(l.expiresAt) - now()) / 60000)), status: l.status || null }));
      const mine = (it.questions || []).filter((q) => q.raisedBy === name);
      for (const q of mine) waiting.push(brief(it, { questionId: q.id, question: q.reason, kind: q.kind, since: q.raisedAt }));
      // A reviewer's concerns on the review you asked for are work for you (INT-388): fix them and ask again. Verdicts are
      // cleared when a review is requested again, so any standing now came after this request.
      const asked = mine.find((q) => q.kind === 'review');
      const worried = asked ? (it.reviewers || []).filter((r) => r.verdict === 'concerns') : [];
      if (worried.length) concerns.push(brief(it, { reviewers: worried.map((r) => ({ name: r.name, comment: (it.comments || []).find((c) => c.id === r.commentId)?.body || null })), commentIds: worried.map((r) => r.commentId || r.at).join(',') }));
      if (mine.length) continue;
      const w = (it.waits || []).filter((x) => x.raisedBy === name && x.kind !== 'review').at(-1);
      // your own withdrawal is no answer; someone else's (the coordinator's) is, with its reason
      if (w && !(w.withdrawn && w.by === name) && Date.parse(w.resolvedAt) > lastMine(it) && it.columnId !== done) answered.push(brief(it, { questionId: w.id, question: w.reason || null, answer: replyAfter(it, w), ...(w.form ? { form: w.form } : {}), answeredBy: w.by, ...(w.withdrawn ? { withdrawn: true } : {}) }));
      const rv = it.review;
      if (rv?.verdict === 'changes' && (rv.requestedBy === name || it.workedBy?.includes(name)) && Date.parse(rv.at) > lastMine(it)) feedback.push(brief(it, { feedback: rv.comment, by: rv.by }));
      if (it.assignee === name && it.columnId !== done && !asleep(ctx, it) && !(l && l.claimant !== name) && !leases.some((x) => x.id === it.id)) assigned.push(brief(it));
    }
    const requests = (b.requests || []).filter((q) => q.status === 'open' && q.to === name).map((q) => ({ requestId: q.id, request: q.body, from: q.by?.name, at: q.at, replies: q.replies.length }));
    // "Explain" questions addressed to me that I haven't answered since they were asked.
    const explain = [];
    for (const it of items) {
      const asks = (it.comments || []).filter((c) => c.intent === 'explain');
      for (const c of asks) {
        const addressed = explainTargets(it, c).includes(name);
        const answered = (it.comments || []).some((x) => x.author?.name === name && x.createdAt > c.createdAt);
        if (addressed && !answered) explain.push(brief(it, { question: c.body, commentId: c.id }));
      }
    }
    const pick = new Set(pickupColumns(ctx).map((c) => c.id));
    const ready = items.filter((it) => pick.has(it.columnId) && inActiveFocus(ctx, it) && !activeLease(it) && !it.needsHuman && (!it.assignee || it.assignee === name) && !openBlockersOf(ctx, it).length)
      .sort((a, c) => PRIO_RANK[a.priority] - PRIO_RANK[c.priority]).slice(0, 5).map((it) => brief(it));
    const call = (id, what) => `POST /api/boards/${ctx.id}/items/${id}/${what}`;
    const next = [];
    const seen = new Set();
    // One suggestion per ticket (renewing is separate: it is just housekeeping).
    // While a focus board is active, work outside it waits: only a direct ask from the human (explain, a ticket to
    // write), the lease housekeeping on what you already hold, and landing approved work get through.
    const held = [];
    const add = (action, it, why, how) => {
      const k = action === 'renew' ? `renew:${it.id}` : it.id;
      if (seen.has(k)) return;
      if (focus && !FOCUS_THROUGH.has(action) && !focus.itemIds.includes(it.id)) { if (!held.includes(it.id)) held.push(it.id); return; }
      seen.add(k); next.push({ action, id: it.id, title: it.title, why, call: how });
    };
    for (const q of requests) next.push({ action: 'handle_request', requestId: q.requestId, why: `Request from ${q.from}: ${String(q.request).slice(0, 160)}`, call: `POST /api/boards/${ctx.id}/requests/${q.requestId}/reply { "body": "what you did", "done": true }` });
    for (const it of items) {
      const l = activeLease(it);
      if (l?.claimant !== name) continue;
      for (const q of it.leaseRequests || []) next.push({ action: 'answer_lease_request', id: it.id, title: it.title, why: `${q.by} asks for it${q.reason ? `: ${q.reason}` : ''}`, call: `POST /api/boards/${ctx.id}/items/${it.id}/lease/handover { "to": "${q.by}" } — or …/lease/decline { "to": "${q.by}", "reason": "…" }` });
    }
    for (const it of items) {
      const dr = it.agentDraft;
      if (dr?.writer !== name) continue;
      add('write', brief(it), `Write this ticket from ${dr.by}'s notes${dr.explicit.length ? ` — keep what they set: ${dr.explicit.join(', ')}` : ''}. Quote their original title/description in a comment, then clear the marker`,
        `PATCH /api/boards/${ctx.id}/items/${it.id} { "title": "…", "description": "…", …, "agentDraft": null }`);
    }
    for (const x of explain) add('explain', x, `Asked to explain (reply on the card only — change nothing): ${String(x.question).slice(0, 140)}`, `POST /api/boards/${ctx.id}/items/${x.id}/comments { "body": "…" }`);
    // seen, not answered (INT-343): listed so the next run answers it; never a reason to wake (pendingWork skips it)
    const unanswered = items.flatMap((it) => it.columnId === done ? [] : unansweredIn(it).filter((u) => u.agent === name).map((u) => ({ ...u, id: it.id, title: it.title })));
    for (const u of unanswered) add('reply', u, `You saw ${u.by}'s comment (${u.commentId}) but did not answer it: reply on the card, or react if no words are needed`, `POST /api/boards/${ctx.id}/items/${u.id}/comments { "body": "…" }`);
    for (const x of leases.filter((l) => l.minutesLeft <= leaseWarningMinutes())) add('renew', x, `Your lease ends in ${x.minutesLeft} min`, `${call(x.id, 'lease')} { "minutes": 30 }`);
    for (const x of feedback) add('address_feedback', x, `Review sent back: ${String(x.feedback || '').slice(0, 120)}`, call(x.id, 'start'));
    for (const x of concerns) add('address_concerns', x, `${x.reviewers.map((r) => r.name).join(', ')} raised concerns on your review: ${String(x.reviewers[0].comment || '').replace(/\s+/g, ' ').slice(0, 160)}. Fix them, then ask for review again`, call(x.id, 'start'));
    for (const x of answered) add('resume', x, `Your question was answered: ${String(x.answer || '').slice(0, 120)}`, call(x.id, 'start'));
    for (const x of leases) add('continue', x, x.status ? `You were: ${x.status}` : 'You hold this lease', `${call(x.id, 'review')} { "summary": "…" } when done`);
    for (const it of items.filter((x) => x.columnId !== done && (x.reviewers || []).some((r) => r.name === name && !r.verdict))) {
      add('review_ticket', brief(it), 'You are a reviewer: read its commits (listed in the review comment; git show <sha>) against your concerns, then give a verdict — ok, or concerns with what should change',
        `POST /api/boards/${ctx.id}/items/${it.id}/reviewers/${name}/verdict { "verdict": "ok" | "concerns", "comment": "…" }`);
    }
    // Blocked ones stay listed, after the rest and marked: they can't be started until their blockers are done
    const blockers = (x) => openBlockersOf(ctx, b.items[x.id]);
    for (const x of [...assigned].sort((p, q) => !!blockers(p).length - !!blockers(q).length)) {
      const on = blockers(x);
      add('start', x, on.length ? `Assigned to you · blocked by ${on.join(', ')}: start it once ${on.length > 1 ? 'they are' : 'that is'} done` : 'Assigned to you', call(x.id, 'start'));
    }
    // A router (the coordinator) assigns Ready work; it never picks it up itself.
    const router = isCoordinator(ctx, name);
    if (!router && !agents.isHelper(name) && (!next.length || next.every((n) => n.action === 'renew' || n.action === 'reply'))) for (const x of ready.slice(0, 3)) add('start', x, `Ready to pick up (${x.priority})`, call(x.id, 'start'));
    // A router assigns reviewers to tickets waiting in review, when a reviewer other than the author exists.
    if (router) {
      const pool = agents.reviewerPool();
      for (const it of items) {
        if (!(it.questions || []).some((q) => q.kind === 'review') || (it.reviewers || []).length || it.test) continue;
        const mine = authorsOf(it);
        const cand = pool.filter((a) => !mine.has(a.name));
        if (!cand.length) continue;
        add('assign_reviewer', brief(it), `In review with no reviewer — pick one whose areas or concerns fit: ${cand.map((a) => `${a.name}${a.areas?.length ? ` (owns ${a.areas.slice(0, 3).join(', ')})` : ''}`).join('; ')}. Or leave it if none fits`,
          `POST /api/boards/${ctx.id}/items/${it.id}/reviewers { "name": "…" }`);
      }
    }
    // An agent the human delegated reviews to (review.decide) hears about each ticket waiting for a decision:
    // "decide" when everything its grant needs is in, "chase" naming exactly what is missing, so it pushes the
    // others for it. What they can't provide stays with the human.
    const decideGrants = agents.grantsOf(name).filter((g) => g.power === 'review.decide');
    if (decideGrants.length && !approvalsOff(ctx)) {
      for (const it of items) {
        const q = (it.questions || []).find((x) => x.kind === 'review');
        if (!q || it.test || ownWork(it, name)) continue;
        const gaps = delegationGaps(ctx, it, q, decideGrants);
        if (gaps === null) continue; // nothing to chase yet (a reviewer is still within its time)
        if (!gaps.length) add('decide', brief(it), 'Everything is in for you to approve it for the human: your grant covers it, the evidence is there and no reviewer has concerns. Approve with a one-line why, or leave it for the human if anything looks off',
          `POST /api/boards/${ctx.id}/items/${it.id}/review/decision { "verdict": "approve", "comment": "…" }`);
        else add('chase', brief(it), `To approve this for the human you still need: ${gaps.map((g) => g.text).join('; ')}. @mention whoever owes it and say what you need; if they can't provide it, leave the ticket for the human`,
          `POST /api/boards/${ctx.id}/items/${it.id}/comments { "body": "@… …" }`);
        // the wake tag: what kind of gap, and whose — never the wording (which carries changing minutes)
        const last = next.at(-1);
        if (last?.id === it.id && (last.action === 'decide' || last.action === 'chase')) last.tag = last.action === 'decide' ? 'decide' : gaps.map((g) => g.key).join('|');
      }
    }
    // An agent allowed to land (work.land) hears about every approved ticket whose landing failed.
    if (agents.grantsOf(name).some((g) => g.power === 'work.land')) {
      for (const it of items) {
        if (it.landing?.state !== 'failed' || it.review?.verdict !== 'approve') continue;
        const from = it.landing.from;
        add('land', brief(it), `Approved, but landing failed: ${it.landing.reason}. In your worktree, catch up with main, cherry-pick ${from}'s commits for ${it.id} (git log main..ticket/${from}/${it.id}, or main..agent/${from} --grep ${it.id} when it has no ticket branch), resolve any conflicts keeping both sides' intent, run the tests, then land from your branch`,
          `POST /api/boards/${ctx.id}/items/${it.id}/land { "agent": "${name}" }`);
        const last = next.at(-1);
        if (last?.id === it.id && last.action === 'land') last.tag = it.landing.at;
      }
    }
    // A supervising agent hears about other agents' stalled tickets.
    const supervise = stalledFor(ctx, name, agents.superviseOf(name) || 0).map((x) => brief(x.it, { assignee: x.who, agentStatus: x.status, idleMinutes: x.idleMin, lastActivity: new Date(x.lastMs).toISOString() }));
    for (const x of supervise) {
      const off = x.agentStatus === 'paused' || x.agentStatus === 'failed';
      add('supervise', x, off ? `Assigned to ${x.assignee}, which is ${x.agentStatus} — resume it` : `Assigned to ${x.assignee}, untouched for ${x.idleMinutes} min — nudge it`,
        off ? `POST /api/agents/${x.assignee}/resume` : `POST /api/agents/${x.assignee}/run { "note": "…" } — or comment @${x.assignee} on the card`);
    }
    // A receptionist triages open unassigned tickets: everywhere with pickup "all", in the pickup columns
    // (Ready) with pickup "ready".
    const pk = agents.pickupOf(name);
    const pickCols = new Set(pickupColumns(ctx).map((c) => c.id));
    const triage = pk && (router || pk === 'all') ? untriaged(ctx).filter((it) => pk === 'all' || pickCols.has(it.columnId)).map((it) => brief(it)) : [];
    for (const x of triage) add('triage', x, `Unassigned in ${x.column}: assign it, ask on the card, or leave it`, `PATCH /api/boards/${ctx.id}/items/${x.id} { "assignee": "…" }`);
    const blockedByMaster = master && master.holder !== name;
    return {
      agent: name, board: ctx.id,
      ...(master ? { master: { holder: master.holder, you: master.holder === name, status: master.status || null } } : {}),
      ...(blockedByMaster ? { note: `${master.holder} holds the whole board — you can read, comment and ask, but not change tickets.` } : {}),
      next: blockedByMaster ? [] : next,
      ...(focus ? { focus: { id: focus.id, name: focus.name, items: [...focus.itemIds], note: `The human is focused on "${focus.name}" (${focus.itemIds.length} tickets): start and review only those. Work elsewhere waits until the focus board is retired${held.length ? ` (held back: ${held.join(', ')})` : ''}; an @mention, a request or an explain from the human still gets an answer (to start a ticket the human asked you for directly, pass "outsideFocus": true to …/start).` } } : {}),
      requests, explain, unanswered, leases, feedback, ...(concerns.length ? { concerns } : {}), answered, waitingOnHuman: waiting, assigned, ready, ...(triage.length ? { triage } : {}), ...(supervise.length ? { supervise } : {}),
    };
  }
  
  // Tickets another standing agent was given but is not working on, for a supervising agent (the receptionist).
  // Stalled: the assignee is paused or failed, or nobody holds the ticket, the assignee is neither running nor
  // queued and nothing has happened on it for `minutes`. Never: Done, test tickets, tickets waiting on the human.
  // After two receptionist comments in a row with no answer it stops proposing the ticket (no nagging loop).
  // Queued, not stalled (INT-211), unless the assignee is paused or failed: the assignee is busy (holds a lease
  // anywhere, or its last run ended within `minutes`); the ticket has an open blocker; or the assignee's own last
  // word on it names an open ticket that hasn't changed column since ("after INT-11"). The assignee's own
  // comment otherwise counts as activity for four times as long.
  function stalledFor(ctx, name, minutes) {
    if (!minutes) return [];
    const b = ctx.board;
    const done = doneColumnId(ctx);
    const out = [];
    const busy = new Map();
    const isBusy = (who, a) => {
      if (!busy.has(who)) {
        const leased = [...boards()].some((c) => Object.values(c.board.items).some((x) => activeLease(x)?.claimant === who));
        busy.set(who, leased || now() - Date.parse(a.lastRun?.endedAt || 0) < minutes * 60_000);
      }
      return busy.get(who);
    };
    // the ticket the assignee said this one waits on: open, and still in the column it was in when they said so
    const waitsOn = (it, c) => (c.body.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) || []).some((id) => {
      const x = id !== it.id && b.items[id];
      return x && x.columnId !== done && Date.parse(x.enteredColumnAt || 0) <= Date.parse(c.createdAt);
    });
    for (const it of b.columns.filter((c) => c.id !== done).flatMap((c) => c.itemIds.map((id) => b.items[id]).filter(Boolean))) {
      const who = it.assignee;
      // a helper's ticket is one the human gave it by hand: the human follows it up, not the supervisor (INT-252)
      if (!who || who === name || asleep(ctx, it) || it.test || (it.questions || []).length || activeLease(it) || agents.isHelper(who)) continue;
      let a;
      try { a = agents.get(who); } catch { continue; } // only standing agents can be woken
      if (agents.isRunning(who)) continue;
      const off = a.status === 'paused' || a.status === 'failed';
      if (!off && (a.queued || ['queued', 'waiting', 'throttled', 'retrying'].includes(a.status))) continue;
      const cs = it.comments || [];
      if (cs.length >= 2 && cs.slice(-2).every((c) => c.author?.name === name)) continue;
      const own = cs.findLast((c) => c.author?.name === who);
      if (!off && (isBusy(who, a) || openBlockersOf(ctx, it).length || (own && waitsOn(it, own)))) continue;
      const lastMs = Math.max(Date.parse(it.updatedAt || 0), Date.parse(it.enteredColumnAt || 0), ...cs.map((c) => Date.parse(c.createdAt)));
      const idleMin = Math.round((now() - lastMs) / 60_000);
      if (!off && now() - lastMs < minutes * 60_000) continue;
      if (!off && own && now() - Date.parse(own.createdAt) < 4 * minutes * 60_000) continue;
      out.push({ it, who, status: a.status, idleMin, lastMs });
    }
    return out;
  }
  
  // Work already sitting on the boards for a standing agent, so an idle agent wakes without being poked.
  // Each entry has a stable key: the dispatcher wakes the agent once per key, and again only after the key
  // has left the list and come back (reassigned, answered anew…), so leaving something alone never loops.
  // pickup: false | 'ready' (also unassigned tickets in the pickup columns) | 'all' (every open unassigned
  // ticket — the receptionist's view of the board).
  // Open tickets nobody owns: unassigned, not leased, not waiting on the human, not in the final column.
  function untriaged(ctx) {
    const b = ctx.board;
    const done = doneColumnId(ctx);
    return b.columns.filter((c) => c.id !== done).flatMap((c) => c.itemIds.map((id) => b.items[id]).filter(Boolean))
      .filter((it) => !it.test && !it.assignee && !activeLease(it) && !(it.questions || []).length);
  }
  
  function pendingWork(name, pickup = false) {
    const out = [];
    for (const ctx of boards()) {
      const b = ctx.board;
      const w = workFor(ctx, name);
      const waitingOnHuman = (it) => (it.questions || []).length > 0;
      // A builder's queue (assigned, not started) is offered only while it holds no lease, and again each time it
      // finishes a ticket (its newest review request is in the key): one finished means it is free for the next.
      // A queue it looked at and left alone stays quiet until then, so it never loops.
      const busy = w.leases.length > 0;
      const freedAt = Math.max(0, ...Object.values(b.items).flatMap((it) => [
        ...(it.questions || []).filter((q) => q.kind === 'review' && q.raisedBy === name).map((q) => Date.parse(q.raisedAt) || 0),
        it.review?.requestedBy === name ? Date.parse(it.review.at) || 0 : 0,
      ]));
      for (const n of w.next) {
        if (n.action === 'renew' || n.action === 'continue' || n.action === 'triage' || n.action === 'reply') continue; // housekeeping, mid-run, pickup's job, or a reply owed (listed, never a wake: INT-343)
        const it = n.id && b.items[n.id];
        if (it && n.action === 'start' && (busy || it.assignee !== name || waitingOnHuman(it))) continue; // "ready" suggestions are pickup's job
        // a blocked ticket can't be started: its item.unblocked wakes the assignee, and its key coming back then offers it once more
        if (it && n.action === 'start' && openBlockersOf(ctx, it).length) continue;
        const tag = n.action === 'start' ? freedAt.toString(36)
          : n.action === 'supervise' ? w.supervise?.find((x) => x.id === n.id)?.lastActivity
          : n.action === 'resume' ? w.answered.find((x) => x.id === n.id)?.questionId
          : n.action === 'address_feedback' ? it?.review?.at
          : n.action === 'address_concerns' ? w.concerns?.find((x) => x.id === n.id)?.commentIds
            : n.action === 'explain' ? w.explain.find((x) => x.id === n.id)?.commentId
              : n.action === 'decide' || n.action === 'chase' || n.action === 'land' ? crypto.createHash('sha1').update(String(n.tag || n.action)).digest('hex').slice(0, 10) : '';
        out.push({ key: `${ctx.id}:${n.action}:${n.requestId || n.id}${tag ? `:${tag}` : ''}`, board: ctx.id, action: n.action, id: n.id || null, requestId: n.requestId || null, title: n.title || null, why: n.why });
      }
      if (!pickup) continue;
      const router = isCoordinator(ctx, name);
      const cols = new Set((pickup === 'all' ? b.columns : pickupColumns(ctx)).map((c) => c.id));
      for (const it of untriaged(ctx)) {
        if (!cols.has(it.columnId) || !inActiveFocus(ctx, it)) continue;
        if (!(pickup === 'all' || router) && openBlockersOf(ctx, it).length) continue; // nothing to pick up yet; triage still sees it
        out.push({ key: `${ctx.id}:triage:${it.id}`, board: ctx.id, action: pickup === 'all' || router ? 'triage' : 'pickup', id: it.id, title: it.title,
          why: pickup === 'all' || router ? `Unassigned in ${b.columns.find((c) => c.id === it.columnId)?.name}: triage it — assign, ask, or leave it` : `Ready and unassigned (${it.priority})` });
      }
    }
    return out;
  }
  
  // Tickets a builder could start now, for the idle-board alarm: in a pickup column, not held, not blocked, not
  // waiting on the human, and on the active focus board if there is one. boardId: that board only.
  function waitingWork(boardId = null) {
    const out = [];
    for (const ctx of boards()) {
      if (boardId && ctx.id !== boardId) continue;
      const cols = new Set(pickupColumns(ctx).map((c) => c.id));
      for (const c of ctx.board.columns.filter((x) => cols.has(x.id))) {
        for (const it of c.itemIds.map((id) => ctx.board.items[id]).filter(Boolean)) {
          if (it.test || activeLease(it) || (it.questions || []).length || openBlockersOf(ctx, it).length || !inActiveFocus(ctx, it)) continue;
          out.push({ board: ctx.id, id: it.id, title: it.title, assignee: it.assignee || null });
        }
      }
    }
    return out;
  }

  return { delegationGaps, workFor, stalledFor, untriaged, pendingWork, waitingWork, FOCUS_THROUGH };
}

module.exports = { createWork };
