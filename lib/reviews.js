'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* reviews and landing: asking for review, the agent reviewers and their verdicts, the human's (or a delegated)
   decision, and landing an approved ticket's commits on main. The routes stay in server.js. */

const { authorsOf } = require('./alerts/board'); // who counts as an author (shared with the alerting rules, INT-382)
// deps: the server's helpers these read or call, plus getStanding() and getWorktrees(): both are set at boot,
// after this is made, so they are read when called.
function createReviews({ fail, str, rid, now, tx, getItem, itemEvent, trimChange, mentionsIn, M, SYSTEM, boards,
  findColumn, doneColumnId, workingColumn, moveInto, guardWrite, helperOwns, parseNeedsHuman, syncNeeds, openQuestion,
  closeQuestions, writeVerdict, afterCommit, isCoordinator, ticketCommits, agentBranch, grantsOf, grantFor, reviewerRule, assignedOks,
  openBlockersOf, reviewWithdrawnUndecided, landers, closeAsks = () => {}, getStanding, getWorktrees }) {
  // Review column: one flagged `review`, else the column just before the first human-only gate.
  function reviewColumn(ctx) {
    const cols = ctx.board.columns;
    const flagged = cols.find((c) => c.flags.review);
    if (flagged) return flagged;
    const gate = cols.findIndex((c) => c.flags.humanOnlyIn);
    return gate > 0 ? cols[gate - 1] : null;
  }

  const REVIEW_PARTS = [['changed', 'What changed'], ['why', 'Why'], ['verify', 'How to verify'], ['evidence', 'Evidence'], ['risks', 'Risks and open questions'], ['learned', 'Learned for next time']];

  /* Agent reviewers (INT-64): specialists the receptionist (or the human) asks to look at a ticket in review.
     They comment — ✅ looks good, or ⚠ concerns with the author @mentioned — and the card shows their ticks.
     They never decide the review: the human still approves into Done. */
  const isReviewer = (name) => { try { return !!getStanding()?.get(name).reviewer; } catch { return false; } };
  // every agent marked as a reviewer, paused ones too (the receptionist can resume them)
  const reviewerPool = () => { try { return (getStanding()?.list().agents || []).filter((a) => a.reviewer); } catch { return []; } };
  const mayAssignReviewers = (ctx, actor) => actor.kind === 'user' || isCoordinator(ctx, actor.name);
  function addReviewer(ctx, id, d, actor) {
    if (!mayAssignReviewers(ctx, actor)) fail(403, 'Only the human or the receptionist assigns reviewers', { code: 'HUMAN_ONLY' });
    const who = str(d.name || d.reviewer || '', 64).trim();
    if (!who) fail(400, '"name" is required');
    if (!isReviewer(who)) fail(400, `${who} is not a reviewer — switch on "Can review" in its Speciality (or "reviewer": true in agents.json)`, { code: 'NOT_REVIEWER', hint: `Reviewers: ${reviewerPool().map((a) => a.name).join(', ') || 'none yet'}` });
    return tx(ctx, (events) => {
      const item = getItem(ctx, id);
      if (authorsOf(item).has(who)) fail(403, `${who} worked on ${item.id} — a reviewer must be someone else`, { code: 'OWN_WORK' });
      item.reviewers ||= [];
      if (item.reviewers.some((r) => r.name === who)) return item;
      item.reviewers.push({ name: who, by: actor.name, at: now(), verdict: null });
      item.version++;
      item.updatedAt = now();
      events.push(itemEvent(ctx, 'review.reviewer_assigned', item, actor, { reviewer: who, mentions: [who] }));
      closeAsks(ctx, item, events, { kind: 'reviewer_assigned' }, actor); // asks for a reviewer are answered (INT-391)
      return item;
    });
  }
  function removeReviewer(ctx, id, name, actor) {
    if (!mayAssignReviewers(ctx, actor)) fail(403, 'Only the human or the receptionist removes reviewers', { code: 'HUMAN_ONLY' });
    return tx(ctx, (events) => {
      const item = getItem(ctx, id);
      const before = (item.reviewers || []).length;
      item.reviewers = (item.reviewers || []).filter((r) => r.name !== name);
      if (item.reviewers.length === before) return item;
      item.version++;
      item.updatedAt = now();
      events.push(itemEvent(ctx, 'review.reviewer_removed', item, actor, { reviewer: name }));
      return item;
    });
  }
  function reviewerVerdict(ctx, id, name, d, actor) {
    if (actor.name !== name) fail(403, 'Only that reviewer gives its verdict', { code: 'FORBIDDEN' });
    const verdict = ['ok', 'approve', 'good'].includes(d.verdict) ? 'ok' : d.verdict === 'concerns' ? 'concerns' : fail(400, '"verdict" must be "ok" or "concerns"');
    const comment = str(d.comment || '', 20_000).trim();
    if (verdict === 'concerns' && !comment) fail(400, 'Say what concerns you in "comment"');
    return tx(ctx, (events) => {
      const item = getItem(ctx, id);
      const r = (item.reviewers || []).find((x) => x.name === name);
      if (!r) fail(404, `${name} is not a reviewer on ${item.id}`, { code: 'NOT_REVIEWER', hint: `An @mention doesn't make a reviewer: ask the receptionist or the human to add you (POST …/items/${item.id}/reviewers { "name": "${name}" }), or post your review as a comment` });
      if (authorsOf(item).has(name)) fail(403, `${name} has worked on ${item.id} since being asked to review it — a reviewer never judges its own work`, { code: 'OWN_WORK', hint: 'Leave the verdict to another reviewer or the human' });
      const author = (item.questions || []).find((q) => q.kind === 'review')?.raisedBy || item.review?.requestedBy || item.workedBy?.at(-1) || null;
      const ask = verdict === 'concerns' && author && !comment.includes(`@${author}`) ? `\n\n@${author} please take a look.` : '';
      const body = `${verdict === 'ok' ? '✅ **Looks good**' : '⚠ **Concerns**'} — review by ${name}${comment ? `\n\n${comment}` : ''}${ask}`;
      const c = { id: rid('c'), author: actor, body, createdAt: now() };
      item.comments.push(c);
      // verified: the board checked the reviewer's token (a name with a token must send it); commits: what was
      // reviewed, so a later commit makes the verdict stale for anyone relying on it.
      Object.assign(r, { verdict, at: c.createdAt, commentId: c.id, verified: !!M.auth.agentTokens?.[name], commits: ticketCommits(item, ctx) });
      item.version++;
      item.updatedAt = c.createdAt;
      events.push(itemEvent(ctx, 'comment.added', item, actor, { comment: { id: c.id, body: trimChange(body) }, mentions: mentionsIn(body) }));
      events.push(itemEvent(ctx, 'review.reviewed', item, actor, { reviewer: name, verdict }));
      closeAsks(ctx, item, events, { kind: 'verdict', who: name }, actor); // asks for this verdict are answered (INT-391)
      return item;
    });
  }

  // commits: the ticket's commits on the agent's branch, looked up by the caller before the transaction (git
  // never runs inside one).
  function requestReview(ctx, id, d, actor, commits = null) {
    return tx(ctx, (events) => {
      const item = getItem(ctx, id);
      if (item.columnId === doneColumnId(ctx)) fail(409, `${item.id} is already done (approved) — it can't go back to review`, { code: 'ALREADY_DONE', hint: 'If something is left to do, file a new ticket or comment on this one' });
      const col = d.column ? findColumn(ctx.board, d.column) : reviewColumn(ctx);
      if (!col) fail(400, 'No review column. Flag one with { "flags": { "review": true } } or pass "column".');
      helperOwns(actor, item, 'request review');
      guardWrite(ctx, item, actor);
      if (item.columnId !== col.id) moveInto(ctx, item, col.id, 'top', actor, events);
      // A review explains itself in five parts (changed / why / evidence / verify / risks); a plain
      // summary still works. The parts become one readable comment and travel with the review question.
      const part = (k) => str(d[k] || '', 8000).trim();
      const notes = Object.fromEntries(REVIEW_PARTS.map(([k]) => [k, part(k)]).filter(([, v]) => v));
      let summary = str(d.summary || '', 20_000).trim();
      if (Object.keys(notes).length) {
        summary = [summary, ...REVIEW_PARTS.filter(([k]) => notes[k]).map(([k, label]) => `**${label}**\n${notes[k]}`)].filter(Boolean).join('\n\n');
      }
      const wt = actor.kind === 'agent' && getWorktrees() ? agentBranch(actor.name) : null;
      let landing = 0; // commits approval will land on main: the review card and Approve's label read it
      if (wt) {
        commits ||= []; // the route looked them up before the transaction
        landing = commits.length;
        summary = [summary, commits.length
          ? `**Commits** on \`${wt.branch}\` (they land on approval)\n${commits.map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.subject}`).join('\n')}`
          : `⚠ No commits mentioning ${item.id} on \`${wt.branch}\` — approving lands nothing.`].filter(Boolean).join('\n\n');
      }
      const cid = summary ? rid('c') : null;
      if (summary) item.comments.push({ id: cid, author: actor, body: summary, createdAt: now(), ...(Object.keys(notes).length ? { review: notes } : {}) });
      const lease = item.lease;
      if (lease && lease.claimant === actor.name) item.lease = null;
      syncNeeds(item);
      // Asked again before a decision (INT-172): the earlier, undecided request's comment is marked as
      // replaced, and the thread folds it to one line. Decided reviews closed their question, so never fold.
      const prev = item.questions.find((q) => q.kind === 'review');
      if (prev && cid && prev.raisedBy === actor.name) {
        const old = prev.commentId ? item.comments.find((c) => c.id === prev.commentId)
          : item.comments.findLast((c) => c.review && c.id !== cid && c.author?.name === actor.name && c.createdAt <= prev.raisedAt);
        if (old) old.replacedBy = cid;
      }
      item.questions = item.questions.filter((q) => q.kind !== 'review');
      // The review card shows this text: keep the summary's whole first paragraph, not a clipped line.
      const rq = parseNeedsHuman({ reason: str(d.reason || notes.changed?.split(/\n\s*\n/)[0] || (summary ? summary.split(/\n\s*\n/)[0] : 'Ready for review'), 2000), kind: 'review' }, actor);
      if (Object.keys(notes).length) rq.notes = notes;
      else if (summary) rq.notes = { changed: summary };
      if (landing) rq.landing = landing;
      if (cid) rq.commentId = cid;
      item.version++;
      item.updatedAt = now();
      if (lease && !item.lease) events.push(itemEvent(ctx, 'lease.released', item, actor, { claimant: lease.claimant, reason: 'review requested' }));
      events.push(itemEvent(ctx, 'review.requested', item, actor, { summary: trimChange(summary) || null, reason: rq.reason }));
      openQuestion(ctx, item, rq, actor, events);
      closeAsks(ctx, item, events, { kind: 'review_requested', who: actor.name }, actor); // asks to fix it are answered (INT-391)
      // asked again (e.g. after changes): every assigned reviewer looks again
      for (const r of item.reviewers || []) {
        if (!r.verdict) continue;
        r.verdict = null;
        events.push(itemEvent(ctx, 'review.reviewer_assigned', item, actor, { reviewer: r.name, again: true, mentions: [r.name] }));
      }
      return item;
    });
  }

  // Human verdict on a review, in one step. approve: through the gate; changes: back to the working column.
  function decideReview(ctx, id, d, actor) {
    // A reviewer's ok or concerns sent here (INT-377: on Lenza the supervisor told one to): point at the verdict route
    // with the exact call, instead of a refusal that only talks about delegating decisions.
    const asReviewer = () => {
      const item = getItem(ctx, id);
      const said = d.verdict === 'ok' || d.verdict === 'concerns' ? d.verdict : null;
      if (!said && !(item.reviewers || []).some((r) => r.name === actor.name)) return null;
      return `POST /api/boards/${ctx.id}/items/${item.id}/reviewers/${actor.name}/verdict { "verdict": "${said || 'ok'}", "comment": "…" }`;
    };
    if (actor.kind !== 'user' && !grantsOf(actor.name).some((g) => g.power === 'review.decide')) {
      const call = asReviewer();
      if (call) fail(403, 'Reviewers record a verdict; only the human decides the review', { code: 'HUMAN_ONLY', hint: `Record your verdict (ok, or concerns with what should change): ${call}`, call });
      fail(403, 'Only the human decides reviews', { code: 'HUMAN_ONLY', hint: 'The human can delegate this with "grants": ["review.decide"] in agents.json' });
    }
    if (d.verdict === 'ok' || d.verdict === 'concerns') {
      const call = actor.kind === 'user' ? null : asReviewer();
      fail(400, `"${d.verdict}" is a reviewer's verdict: deciding a review takes "approve" or "changes"`, { hint: call ? `To record it as a reviewer: ${call}` : 'Send "approve" or "changes"', ...(call ? { call } : {}) });
    }
    const verdict = d.verdict === 'approve' || d.verdict === 'approved' ? 'approve' : d.verdict === 'changes' ? 'changes' : fail(400, '"verdict" must be "approve" or "changes"');
    return tx(ctx, (events) => {
      const item = getItem(ctx, id);
      // The permission, scope and own-work checks first, without the oks: a ticket with no open review says so next
      // (INT-372), rather than asking for oks on a review that doesn't exist.
      const allowed = grantFor(ctx, actor, 'review.decide', item, 'decide reviews', { oks: false });
      // No open review: say whether it was already decided (and by whom), before the oks and evidence checks read the review.
      const decided = item.review?.verdict && !reviewWithdrawnUndecided(item) ? item.review : null;
      if (allowed && !(item.questions || []).some((x) => x.kind === 'review')) {
        if (decided) fail(409, `${item.id} was already decided: ${decided.by} ${decided.verdict === 'approve' ? 'approved' : 'sent it back'} it at ${decided.at}`, { code: 'ALREADY_DECIDED', hint: 'Leave it: that decision stands, and the human can override it', decidedBy: decided.by, decidedAt: decided.at });
        fail(409, `${item.id} has no open review to decide`, { code: 'NO_REVIEW', hint: 'Ask the author to request review first' });
      }
      // Then the oks, for an approval only (asking for changes needs none): the same grantFor as before, unchanged
      const grant = allowed && verdict === 'approve' ? grantFor(ctx, actor, 'review.decide', item, 'decide reviews') : allowed;
      // A delegated approval never overrules a reviewer: with any concerns open, only the human approves.
      const worried = (item.reviewers || []).filter((r) => r.verdict === 'concerns').map((r) => r.name);
      const evidence = String((item.questions || []).find((x) => x.kind === 'review')?.notes?.evidence || '').trim();
      if (grant && verdict === 'approve' && !evidence) fail(409, `${item.id}'s review has no evidence: only the human approves without it`, { code: 'NO_EVIDENCE', hint: 'Ask the author for evidence (screenshots, outputs, what to look at in the Preview) and to request review again' });
      if (grant && verdict === 'approve' && worried.length) fail(409, `${item.id} has concerns from ${worried.join(', ')}: only the human approves over a reviewer's concerns`, { code: 'CONCERNS_OPEN', hint: 'Leave it for the human, or @mention the author to address the concerns' });
      // Nor before its reviewers have passed it: no concerns yet is not an ok.
      const rv = grant && verdict === 'approve' && !reviewerRule(grant) ? assignedOks(ctx, item) : { met: true };
      if (!rv.met && rv.none) fail(409, `${item.id} has no reviewer: only the human approves what nobody has reviewed`, { code: 'NO_REVIEWER', hint: 'Leave it until the coordinator assigns a reviewer and they say ok, or leave it for the human' });
      if (!rv.met) fail(409, `${item.id} needs ${rv.text} before it is approved for the human`, { code: 'REVIEW_PENDING', missing: rv.short || [], hint: 'Wait for the verdicts (@mention whoever owes one), or leave it for the human' });
      // Nor does it carry a ticket past work it waits on: approving moves it on, and only the human can undo that.
      const open = openBlockersOf(ctx, item);
      if (grant && verdict === 'approve' && open.length) fail(409, `${item.id} is blocked by ${open.join(', ')}: only the human approves it before they are done`, { code: 'BLOCKED', hint: `Leave it for the human, or approve it once ${open.join(', ')} ${open.length > 1 ? 'are' : 'is'} done`, blockedBy: open });
      const comment = str(d.comment || '', 20_000).trim();
      if (verdict === 'changes' && !comment) fail(400, 'Say what needs to change in "comment"');
      // Where it goes: approve → through the next gate; changes → back to the working column.
      const cols = ctx.board.columns;
      const idx = cols.findIndex((c) => c.id === item.columnId);
      const target = d.column ? findColumn(ctx.board, d.column)
        : verdict === 'approve' ? (cols.slice(idx + 1).find((c) => c.flags.humanOnlyIn) || cols[idx + 1])
          : (workingColumn(ctx) && cols.indexOf(workingColumn(ctx)) < idx ? workingColumn(ctx) : cols[idx - 1]);
      recordVerdict(ctx, item, actor, events, verdict, comment, grant);
      // a delegated verdict carries its move through the gate with it
      if (target && target.id !== item.columnId) moveInto(ctx, item, target.id, 'top', actor, events, { ...(grant ? { gateBy: grant } : {}), confirm: d.confirm === true, approving: verdict === 'approve' });
      item.version++;
      item.updatedAt = now();
      return item;
    });
  }

  // One place that records a review verdict (lib/alerts/ticket.js, shared with the simulator), then lands an approval.
  // Used by the review decision and by a human moving a reviewed ticket into an approval gate.
  function recordVerdict(ctx, item, actor, events, verdict, comment = '', grant = null) {
    const requestedBy = writeVerdict(ctx, item, actor, events, verdict, comment, grant);
    // landing on approval is a rule the human can switch off (behaviours.landOnApprove, the Rules page)
    if (verdict === 'approve' && requestedBy && ctx.board.behaviours?.landOnApprove !== false && getWorktrees() && agentBranch(requestedBy)) afterCommit(ctx, () => startLanding(ctx, item.id, requestedBy, actor));
  }

  // Put a ticket's commits from the agent's worktree branch on main, then say on the card what happened. Git runs
  // outside any transaction and never blocks the board; the outcome is recorded in a transaction of its own.
  // Routes that approve await landingOf() before they answer, so their reply still comes after the landing.
  const landings = new Map(); // "<board>:<id>" → promise of the landing's result
  function startLanding(ctx, id, agent, actor) {
    const key = `${ctx.id}:${id}`;
    const p = getWorktrees().land(agent, id)
      .catch((e) => ({ landed: [], reason: e.message, command: `intellagent merge ${id}` }))
      .then((r) => {
        try {
          tx(ctx, (events) => {
            const item = ctx.board.items[id];
            if (!item) return; // archived meanwhile: git is the record
            recordLanding(ctx, item, agent, actor, events, r);
            item.version++;
            item.updatedAt = now();
          });
        } catch (e) { console.error(`[${ctx.id}] recording the landing of ${id}: ${e.message}`); }
        return r;
      })
      .finally(() => { if (landings.get(key) === p) landings.delete(key); });
    landings.set(key, p);
    return p;
  }
  const landingOf = (ctx, id) => landings.get(`${ctx.id}:${String(id).toUpperCase()}`) || Promise.resolve(null);

  function recordLanding(ctx, item, agent, actor, events, r) {
    // A failed landing with commits waiting goes to the agents allowed to land (work.land), not the human.
    const waiting = !r.landed.length && !!r.commits?.length;
    const lands = waiting ? landers().filter((n) => n !== actor.name) : [];
    const body = r.landed.length
      ? `⤵ Landed on ${r.branch || 'main'}: ${r.landed.map((x) => `\`${x}\``).join(', ')} from \`agent/${agent}\`${r.via === 'merge' ? ` by merge commit \`${r.merge}\` (a cherry-pick conflicted; the merge keeps the branch's own conflict resolution)` : ''}.${r.equivalent?.length ? ` Already on ${r.branch || 'main'}: ${r.equivalent.map((e) => (e.unmatched ? `\`${e.sha}\` (its patch is on ${r.branch || 'main'}, but not among the newest commits searched, so which commit has it is unknown)` : `\`${e.sha}\` as \`${e.main}\``)).join(', ')}.` : ''}`
      : `⚠ Not landed: ${r.reason}.${waiting ? (lands.length ? ` ${lands.map((n) => `@${n}`).join(' ')} will land it.` : ` When that's sorted${r.hint ? ` (${r.hint})` : ''}, run \`${r.command}\`.`) : ''}`;
    item.comments.push({ id: rid('c'), author: SYSTEM, body, createdAt: now() });
    item.landing = r.landed.length ? { state: 'landed', commits: r.landed, from: agent, at: now() }
      : waiting ? { state: 'failed', reason: r.reason, ...(r.code ? { code: r.code } : {}), from: agent, at: now() } : { state: 'nothing', reason: r.reason, at: now() };
    events.push(itemEvent(ctx, r.landed.length ? 'item.landed' : 'item.land_failed', item, actor, { agent, landed: r.landed, ...(r.via ? { via: r.via } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(r.code ? { code: r.code } : {}),
      // landed, or nothing to land: news, like the approval before it (INT-386). Only a failure with commits waiting is work.
      ...(waiting ? { mentions: [agent, ...lands] } : {}) }));
    return r;
  }

  // A landing someone finished by hand (a cherry-pick with a resolved conflict has other ids) still reads
  // "failed" and keeps producing land actions. Mark it landed, by hand, with the commits found on main.
  function markLandedByHand(ctx, id, shas, actor) {
    return tx(ctx, (events) => {
      const item = ctx.board.items[id];
      if (!item || item.landing?.state === 'landed') return null;
      item.landing = { state: 'landed', commits: shas, from: item.landing?.from || null, by: 'hand', at: now() };
      item.comments.push({ id: rid('c'), author: SYSTEM, body: `⤵ Landed by hand on main: ${shas.map((x) => `\`${x}\``).join(', ')}.`, createdAt: now() });
      item.version++;
      item.updatedAt = now();
      events.push(itemEvent(ctx, 'item.landed', item, actor, { agent: item.landing.from, landed: shas, via: 'hand' }));
      return item.landing;
    });
  }
  // Every sweep: an approved ticket whose landing failed, but whose id main mentions after the approval, was landed by hand.
  // And one that failed only because the main checkout had uncommitted changes lands again once it is clean, or once
  // at all if it failed under the old rule, which refused any uncommitted change (now only those its commits touch),
  // or because another branch was open in the main checkout (NOT_ON_MAIN, before landing moved out of it in INT-440).
  const DIRTY_OLD = 'the main checkout has uncommitted changes';
  async function reconcileLandings() {
    if (!getWorktrees()) return;
    let clean = null;
    for (const ctx of boards.values()) {
      for (const item of Object.values(ctx.board.items)) {
        const l = item.landing;
        if (l?.state !== 'failed' || item.review?.verdict !== 'approve' || !l.from || landings.has(`${ctx.id}:${item.id}`)) continue;
        if (l.reason !== DIRTY_OLD && l.code !== 'DIRTY' && l.code !== 'NOT_ON_MAIN') continue;
        if (l.code === 'DIRTY') { clean ??= !(await getWorktrees().dirtyMain()).length; if (!clean) continue; }
        await startLanding(ctx, item.id, l.from, SYSTEM);
      }
    }
    for (const ctx of boards.values()) {
      for (const item of Object.values(ctx.board.items)) {
        if (item.landing?.state !== 'failed' || item.review?.verdict !== 'approve') continue;
        try {
          const shas = await getWorktrees().mentionedOnMain(item.id, item.review.at);
          if (shas.length) markLandedByHand(ctx, item.id, shas, SYSTEM);
        } catch (e) { console.warn(`landing check for ${item.id}: ${e.message}`); }
      }
    }
  }

  return {
    reviewColumn, REVIEW_PARTS, reviewerPool, authorsOf, addReviewer, removeReviewer, reviewerVerdict, requestReview,
    decideReview, recordVerdict, startLanding, landingOf, markLandedByHand, reconcileLandings,
  };
}

module.exports = { createReviews };
