'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// The alerting simulator (INT-383): a board in memory, a team of stub agents and a fake clock, so a test can say
// exactly who is woken, when, and with what. It runs the board's own rules: who an event is for
// (lib/alerts/recipients), what work each agent has (lib/alerts/work), the wake filters (lib/alerts/filters through
// the real agent config), and the real scheduler (settle, throttle, hourly cap, sweeps, seen work, idle alarm).
// Only the agent's run is a stub: a policy function you write, called when the run starts.
//
//   const sim = createSim({ team: { groot: { role: 'builder', behave: (run, act) => act.start(run.work[0]?.id) } } });
//   const t = sim.human.create({ title: 'Fix it', column: 'Ready', assignee: 'groot' });
//   sim.tick('5m');
//   sim.runs        → [{ agent: 'groot', at, why: ['item.assigned'], items: ['T-1'], work: [], events: […] }]
//   sim.close();
//
// What it does not do: check permissions, leases or gates (an action always succeeds), run git, or wait on real
// processes. Board actions emit the same events as the board's routes, with the same addressing; the contract test
// (INT-384) holds the two together.
//
// The clock: node:test's mock timers own setTimeout, setInterval and Date while a simulator is open, so create it
// inside a test and close it at the end (sim.close()).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mock } = require('node:test');
const { createRecipients, mentionsIn } = require('../alerts/recipients');
const { createOks } = require('../alerts/oks');
const { createWork } = require('../alerts/work');
const { parseFilter, matchesFilter } = require('../alerts/filters');
const { seenOnStart } = require('../alerts/seen');
const ASKS = require('../alerts/asks');
const AUTONOMY = require('../alerts/autonomy');
const { doneColumnId, openBlockersOf, asleep } = require('../alerts/board');
const { createState } = require('../agents/state');
const { createConfig } = require('../agents/config');
const { createScheduler } = require('../agents/scheduler');

// The default board template's columns (lib/templates.js), so a simulated board looks like a new one.
const COLUMNS = [
  { name: 'Backlog', flags: { allowCreate: true } },
  { name: 'Ready', flags: { pickup: true, allowCreate: true } },
  { name: 'In Progress', flags: { working: true } },
  { name: 'Review', flags: { review: true } },
  { name: 'Done', flags: { releaseLeaseOnEnter: true, humanOnlyIn: true } },
];
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const HUMAN = { kind: 'user', name: 'James' };
const SYSTEM = { kind: 'system', name: 'intellagent' };

// "90s", "5m", "2h", or milliseconds
function ms(t) {
  if (typeof t === 'number') return t;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(String(t).trim());
  if (!m) throw new Error(`sim: "${t}" is not a duration (use 90s, 5m, 2h or milliseconds)`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
}

/**
 * opts: {
 *   team: { name: { ...an agents.json entry (role, listen, pickup, grants, helper, throttleMinutes…),
 *                   behave?: (run, act) => void — what the agent does when a run starts (default: nothing),
 *                   runFor?: '1m' — how long its runs last (default 1 minute) } },
 *   defaults?: agents.json defaults, columns?: [{ name, flags }], coordinator?: name,
 *   start?: ISO time the clock starts at, sweeps?: true — run the scheduler's sweeps (pending work, idle alarm),
 *   landing?: 'lands' | 'fails' (conflict: to the agents with work.land) | 'nothing' (no commits) | 'off' — what approving does,
 * }
 */
function createSim(opts = {}) {
  const T0 = Date.parse(opts.start || '2026-10-19T09:00:00Z');
  const landing = opts.landing || 'lands'; // what approving an agent's ticket does: lands | fails | nothing | off
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 });
  const now = () => Date.now();
  const iso = () => new Date().toISOString();

  // The board
  const ctx = { id: 'main', board: { columns: [], items: {}, requests: [], focusBoards: [], activeFocus: null, master: null, coordinator: opts.coordinator || null } };
  for (const c of opts.columns || COLUMNS) ctx.board.columns.push({ id: slug(c.name), name: c.name, flags: { ...c.flags }, itemIds: [] });
  const col = (ref) => {
    const r = String(ref).toLowerCase();
    const c = ctx.board.columns.find((x) => x.id === r || x.name.toLowerCase() === r);
    if (!c) throw new Error(`sim: no column "${ref}"`);
    return c;
  };
  const item = (id) => { const it = ctx.board.items[String(id).toUpperCase()]; if (!it) throw new Error(`sim: no ticket ${id}`); return it; };
  let nextId = 1;
  let nextRid = 1;
  const rid = (p) => `${p}_${nextRid++}`;

  // Events: numbered, kept, and handed to the scheduler as the board hands them to its agents
  const events = [];
  let seq = 0;
  const recipients = createRecipients({ now, isRunning: (n) => running.has(n) });
  const { itemEvent, activeLease, explainTargets } = recipients;
  function emitAll(list) {
    for (const e of list) {
      e.seq = ++seq;
      e.ts = iso();
      events.push(e);
      scheduler.onEvent(e);
    }
  }

  // The team: a real agents.json in a temp folder, read by the board's own config (roles, defaults, helpers…)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellagent-sim-'));
  const behave = {};
  const runFor = {};
  const team = {};
  for (const [name, d] of Object.entries(opts.team || {})) {
    const { behave: b, runFor: r, ...def } = d;
    behave[name] = b || (() => {});
    runFor[name] = ms(r || '1m');
    team[name] = { run: 'node -e 0', worktree: false, ...def };
  }
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({ defaults: opts.defaults || {}, agents: team }));

  const { state, save, st, requeueInflight } = createState({ stateFile: null, seq: () => seq });
  const running = new Map();
  const core = {
    deps: {
      file: path.join(dir, 'agents.json'), stateFile: path.join(dir, 'agents.state.json'), cwd: dir,
      emit: (e) => { e.seq = ++seq; e.ts = iso(); events.push(e); }, // agent.* events: kept, never routed (as on the board)
      seq: () => seq, recent: () => events,
      parseFilter: (src) => parseFilter(src, (board, ref) => ctx.board.columns.find((c) => c.id === String(ref).toLowerCase() || c.name.toLowerCase() === String(ref).toLowerCase())?.id),
      matchesFilter,
      pending: (name) => work.pendingWork(name, config.api.pickupOf(name)),
      waiting: (board) => work.waitingWork(board),
      log: () => {},
    },
    state, save, st, requeueInflight, defs: {}, running, sessions: new Map(), timers: new Map(), procs: new Map(), held: new Map(),
    view: (name) => ({ name, ...st(name) }),
  };
  const config = core.config = createConfig(core);
  config.load();
  const scheduler = core.scheduler = createScheduler(core);

  // What each agent has to do: the board's own rules over this board
  const oks = createOks({ verdictStands: (it, r) => !!r.verified, now });
  const work = createWork({
    now, boards: () => [ctx], leaseWarningMinutes: () => 5, recipients, oks,
    agents: {
      get: (n) => { if (!core.defs[n]) throw new Error(`not a standing agent: ${n}`); const s = st(n); return { status: s.status, queued: s.queue.length, lastRun: s.lastRun, reviewer: !!core.defs[n].reviewer }; },
      isRunning: (n) => running.has(n), superviseOf: (n) => config.api.superviseOf(n), pickupOf: (n) => config.api.pickupOf(n),
      grantsOf: (n) => [].concat(config.api.grantsOf(n) || []).map((g) => (typeof g === 'string' ? { power: g } : g)),
      isHelper: (n) => config.api.helperOf(n),
      reviewerPool: () => Object.values(core.defs).filter((d) => d.reviewer).map((d) => ({ name: d.name, areas: d.areas || [] })),
      routers: (c) => Object.values(core.defs).filter((d) => (d.role === 'coordinator' || d.name === c.board.coordinator) && d.enabled && !st(d.name).paused && st(d.name).status !== 'failed').map((d) => d.name),
    },
    isCoordinator: (c, n) => (!!n && n === c.board.coordinator) || core.defs[n]?.role === 'coordinator',
    approvalsOff: () => false, commitsPending: () => false,
  });

  // A run: the scheduler calls start(); the policy acts at once; the run ends runFor later
  const runs = [];
  core.runner = {
    lingering: () => 0, endSession() {}, endLingering() { return 0; },
    start(name, def, s) {
      const batch = s.queue.splice(0, s.queue.length);
      if (s.context?.length) { batch.push(...s.context.filter((c) => !batch.some((x) => x.seq === c.seq && x.type === c.type))); s.context = []; } // as the runner (INT-390)
      const pend = (() => { try { return core.deps.pending(name, def); } catch { return []; } })();
      s.seenWork = [...new Set([...(s.seenWork || []), ...seenOnStart(batch, pend)])];
      s.inflight = batch;
      s.runs.push(iso());
      const run = {
        agent: name, at: iso(), why: [...new Set(batch.map((e) => e.type))],
        items: [...new Set(batch.flatMap((e) => e.itemId || (e.work || []).map((w) => w.id)).filter(Boolean))],
        work: batch.filter((e) => e.type === 'work.pending').flatMap((e) => e.work.map((w) => `${w.action}:${w.id || w.requestId}`)),
        events: batch.map((e) => ({ seq: e.seq, type: e.type, itemId: e.itemId || null })),
      };
      runs.push(run);
      running.set(name, { startedAt: run.at });
      scheduler.setStatus(name, 'running', { lastRun: { startedAt: run.at, why: run.why.join(', '), items: run.items } });
      // the board's onRunStart: each comment that woke the run gets the agent's 👀 (seen), as on the board
      for (const e of batch) {
        if (e.type !== 'comment.added' || !e.comment?.id) continue;
        const c = ctx.board.items[e.itemId]?.comments.find((x) => x.id === e.comment.id);
        if (!c) continue;
        c.reactions ||= {};
        c.reactions['👀'] = [...new Set([...(c.reactions['👀'] || []), name])];
      }
      const before = events.length;
      try { behave[name]({ ...run, brief: work.workFor(ctx, name), pending: pend }, actorApi({ kind: 'agent', name })); } catch (e) { run.error = e.message; }
      // what woke it and what it changed, as the board's metrics count them (INT-389)
      run.reasons = [...new Set(batch.flatMap((e) => (e.type === 'work.pending' ? (e.work || []).map((w) => w.action) : [e.type])))];
      run.writes = events.slice(before).filter((e) => e.actor?.name === name && !/^(agent.|reaction.|lease.(status|renewed)$)/.test(e.type)).length;
      setTimeout(() => {
        running.delete(name);
        s.inflight = null;
        s.lastRun = { ...s.lastRun, endedAt: iso(), code: 0 };
        scheduler.setStatus(name, s.queue.length ? 'queued' : 'idle');
        if (!s.queue.length) scheduler.checkPending(name);
        if (s.queue.length) scheduler.schedule(name, def.settleSeconds * 1000);
      }, runFor[name]);
    },
  };

  // Board actions, by someone. Each emits what the board's route emits, addressed the same way.
  function enter(it, to) { const from = col(it.columnId); from.itemIds.splice(from.itemIds.indexOf(it.id), 1); to.itemIds.unshift(it.id); it.columnId = to.id; it.enteredColumnAt = iso(); return from; }
  function moveTo(it, toRef, actor, out) {
    const to = col(toRef);
    if (to.id === it.columnId) return;
    // a human moving a ticket with an open review into an approval gate approves it
    if (actor.kind === 'user' && to.flags.humanOnlyIn && (it.questions || []).some((q) => q.kind === 'review')) recordVerdict(it, actor, out, 'approve', `Approved ✓ (moved to ${to.name})`);
    const from = enter(it, to);
    const woken = from.flags.sleeping && !to.flags.sleeping && it.assignee && it.assignee !== actor.name ? [it.assignee] : [];
    out.push(itemEvent(ctx, 'item.moved', it, actor, { fromColumnId: from.id, columnId: to.id, position: 0, ...(woken.length ? { mentions: woken } : {}) }));
    if (to.flags.releaseLeaseOnEnter && it.lease) { const c = it.lease.claimant; it.lease = null; out.push(itemEvent(ctx, 'lease.released', it, actor, { claimant: c, reason: `entered ${to.name}`, mentions: [c] })); }
    if (to.id === doneColumnId(ctx)) {
      for (const x of Object.values(ctx.board.items)) {
        if (x.id === it.id || !x.blockedBy?.includes(it.id) || openBlockersOf(ctx, x).length) continue;
        out.push(itemEvent(ctx, 'item.unblocked', x, actor, { resolvedBy: it.id, mentions: [asleep(ctx, x) ? null : x.assignee, activeLease(x)?.claimant].filter(Boolean) }));
      }
    }
  }
  function openQuestion(it, q, actor, out) {
    it.questions.push(q);
    it.needsHuman = it.questions[0];
    out.push(itemEvent(ctx, 'attention.raised', it, actor, { questionId: q.id, reason: q.reason, kind: q.kind, open: it.questions.length }));
  }
  function closeQuestions(it, actor, out, pick, reply, extra = {}) {
    const closing = it.questions.filter(pick);
    it.questions = it.questions.filter((q) => !closing.includes(q));
    it.needsHuman = it.questions[0] || null;
    for (const q of closing) {
      (it.waits ||= []).push({ id: q.id, reason: q.reason, raisedBy: q.raisedBy, raisedAt: q.raisedAt, resolvedAt: iso(), by: actor.name, kind: q.kind });
      out.push(itemEvent(ctx, 'attention.resolved', it, actor, { questionId: q.id, raisedBy: q.raisedBy, reason: q.reason, kind: q.kind, reply, open: it.questions.length, mentions: [q.raisedBy], ...extra }));
    }
  }
  function recordVerdict(it, actor, out, verdict, comment) {
    const prev = it.questions.find((q) => q.kind === 'review') || null;
    const requestedBy = prev?.raisedBy || it.workedBy?.at(-1) || null;
    const body = comment || 'Approved ✓';
    if (comment || verdict === 'approve') it.comments.push({ id: rid('c'), author: actor, body, createdAt: iso() });
    closeQuestions(it, actor, out, (q) => q.kind === 'review', body, { verdict });
    it.review = { verdict, comment: comment || null, by: actor.name, at: iso(), requestedBy };
    out.push(itemEvent(ctx, verdict === 'approve' ? 'review.approved' : 'review.changes_requested', it, actor, { verdict, feedback: comment || null, mentions: [requestedBy, ...(it.workedBy || [])].filter(Boolean) }));
    // the board lands an approved agent ticket's commits after the decision is saved (its own transaction, so after
    // every event of this one): out.later
    if (verdict === 'approve' && requestedBy && core.defs[requestedBy] && landing !== 'off') (out.later ||= []).push(() => land(it, requestedBy, actor));
  }
  // What the board's landing records (lib/reviews.js recordLanding): landed; failed with commits waiting (it goes to
  // the agents with work.land, and to the author); or nothing to land (no commits). Only the failure addresses anyone.
  function land(it, agent, actor) {
    const waiting = landing === 'fails';
    const landers = waiting ? Object.values(core.defs).filter((d) => d.enabled && [].concat(config.api.grantsOf(d.name) || []).some((g) => (g.power || g) === 'work.land')).map((d) => d.name).filter((n) => n !== actor.name) : [];
    it.landing = landing === 'lands' ? { state: 'landed', from: agent, at: iso() } : waiting ? { state: 'failed', reason: 'conflict', from: agent, at: iso() } : { state: 'nothing', at: iso() };
    return [itemEvent(ctx, landing === 'lands' ? 'item.landed' : 'item.land_failed', it, actor, { agent, landed: [], ...(waiting ? { mentions: [agent, ...landers] } : {}) })];
  }
  // Asks (INT-391), as the board's (server.js createAsk / answerAsk / closeAsks / sweepAsks)
  function closeAsks(it, out, trigger, actor) {
    for (const a of ASKS.closeBy(it, trigger, iso())) {
      out.push(itemEvent(ctx, 'ask.done', it, actor, { ask: { ...a }, mentions: [a.by].filter((n) => n !== actor.name) }));
      for (const up of ASKS.closeEscalations(it, a, iso())) out.push(itemEvent(ctx, 'ask.done', it, actor, { ask: { ...up } }));
    }
  }
  const coordinatorOf = () => ctx.board.coordinator || Object.values(core.defs).find((d) => d.enabled && d.role === 'coordinator')?.name || null;
  function sweepAsks() {
    const out = [];
    for (const it of Object.values(ctx.board.items)) for (const a of ASKS.overdueAsks(it, now())) {
      a.escalated = iso();
      out.push(itemEvent(ctx, 'ask.overdue', it, SYSTEM, { ask: { ...a }, mentions: [a.by] }));
      const coord = coordinatorOf();
      if (coord && coord !== a.to && coord !== a.by) {
        const up = ASKS.newAsk({ id: rid('ask'), by: 'intellagent', to: coord, kind: 'unblock', escalates: a.id, what: `${a.by} asked ${a.to} (${a.kind}): ${a.what}. Overdue`, now: now() });
        it.asks.push(up);
        out.push(itemEvent(ctx, 'ask.created', it, SYSTEM, { ask: { ...up }, escalates: a.id, mentions: [coord] }));
      } else openQuestion(it, { id: rid('q'), reason: `${a.by} asked ${a.to} and it is overdue (${a.kind}): ${a.what}`, raisedBy: a.by, raisedAt: iso(), kind: 'question' }, SYSTEM, out);
    }
    emitAll(out);
  }
  // Autonomy (INT-393), as the board's tx steps it (server.js stepJourneys)
  function journeys(evs) {
    const byItem = new Map();
    for (const e of evs) if (e.itemId) (byItem.get(e.itemId) || byItem.set(e.itemId, []).get(e.itemId)).push({ ...e, ts: e.ts || iso() });
    const cols = AUTONOMY.columnsOf(ctx.board);
    for (const [id, list] of byItem) {
      const it = ctx.board.items[id];
      if (!it) continue;
      const j = AUTONOMY.stepJourney(it.journey, list, cols);
      if (j) it.journey = j; else delete it.journey;
    }
  }
  const addWorker = (it, name) => { if (!it.workedBy.includes(name)) it.workedBy = [...it.workedBy, name].slice(-5); };

  function actorApi(actor) {
    const act = (fn) => (...a) => {
      const out = []; const r = fn(out, ...a);
      journeys(out); emitAll(out);
      for (const f of out.later || []) { const more = f(); journeys(more); emitAll(more); }
      return r;
    };
    return {
      // a new ticket; returns its id
      create: act((out, d) => {
        const id = `T-${nextId++}`;
        const c = col(d.column || 'Backlog');
        const it = { id, title: d.title || id, type: d.type || 'task', priority: d.priority || 'Medium', columnId: c.id, parent: d.parent || null, author: actor,
          assignee: d.assignee || null, blockedBy: d.blockedBy || [], comments: [], questions: [], workedBy: [], reviewers: [], createdAt: iso(), updatedAt: iso(), enteredColumnAt: iso(), version: 1 };
        ctx.board.items[id] = it;
        c.itemIds.push(id);
        out.push(itemEvent(ctx, 'item.created', it, actor));
        if (it.assignee) out.push(itemEvent(ctx, 'item.assigned', it, actor, { assignee: it.assignee, from: null, mentions: asleep(ctx, it) ? [] : [it.assignee] }));
        return id;
      }),
      // a comment; @names in it wake those agents (not in `code` or > quotes). { intent: 'explain' } asks for an explanation
      comment: act((out, id, body, o = {}) => {
        const it = item(id);
        const c = { id: rid('c'), author: actor, body, createdAt: iso(), ...(o.intent ? { intent: o.intent } : {}), ...(o.replyTo ? { replyTo: o.replyTo } : {}) };
        it.comments.push(c);
        it.updatedAt = c.createdAt;
        const mentions = actor.kind === 'agent' && core.defs[actor.name]?.probation ? [] : o.intent === 'explain' ? explainTargets(it, c) : mentionsIn(body);
        out.push(itemEvent(ctx, 'comment.added', it, actor, { comment: { id: c.id, body }, mentions, ...(o.intent ? { intent: o.intent } : {}) }));
        return c.id;
      }),
      assign: act((out, id, to) => {
        const it = item(id);
        const prev = it.assignee || null;
        it.assignee = to || null;
        out.push(itemEvent(ctx, 'item.updated', it, actor, { changes: { assignee: { from: prev, to: it.assignee } } }));
        out.push(itemEvent(ctx, 'item.assigned', it, actor, { assignee: it.assignee, from: prev, mentions: asleep(ctx, it) ? [] : [it.assignee, prev].filter(Boolean) }));
      }),
      move: act((out, id, column) => moveTo(item(id), column, actor, out)),
      // an agent starts a ticket: leases it, moves it to the working column (unless it is already there or further), takes it
      start: act((out, id) => {
        const it = item(id);
        const working = ctx.board.columns.find((c) => c.flags.working);
        const cols = ctx.board.columns;
        if (working && cols.indexOf(working) > cols.findIndex((c) => c.id === it.columnId)) moveTo(it, working.id, actor, out);
        addWorker(it, actor.name);
        it.lease = { claimant: actor.name, leasedAt: iso(), expiresAt: new Date(now() + 30 * 60_000).toISOString(), minutes: 30 };
        out.push(itemEvent(ctx, 'lease.claimed', it, actor, { claimant: actor.name, expiresAt: it.lease.expiresAt, via: 'start' }));
        if (!it.assignee) { it.assignee = actor.name; out.push(itemEvent(ctx, 'item.assigned', it, actor, { assignee: actor.name, from: null })); }
      }),
      // an agent asks for review: into the review column, lease released, the review question opened, reviewers asked again
      review: act((out, id, o = {}) => {
        const it = item(id);
        const rc = ctx.board.columns.find((c) => c.flags.review);
        if (rc && rc.id !== it.columnId) moveTo(it, rc.id, actor, out);
        const lease = it.lease;
        if (lease && lease.claimant === actor.name) it.lease = null;
        it.comments.push({ id: rid('c'), author: actor, body: o.summary || 'Ready for review', createdAt: iso() });
        it.questions = it.questions.filter((q) => q.kind !== 'review');
        if (lease && !it.lease) out.push(itemEvent(ctx, 'lease.released', it, actor, { claimant: lease.claimant, reason: 'review requested' }));
        out.push(itemEvent(ctx, 'review.requested', it, actor, { summary: o.summary || null, reason: 'Ready for review' }));
        openQuestion(it, { id: rid('q'), reason: o.summary || 'Ready for review', raisedBy: actor.name, raisedAt: iso(), kind: 'review', notes: { evidence: o.evidence ?? 'tests pass' } }, actor, out);
        closeAsks(it, out, { kind: 'review_requested', who: actor.name }, actor);
        for (const r of it.reviewers) {
          if (!r.verdict) continue;
          r.verdict = null;
          out.push(itemEvent(ctx, 'review.reviewer_assigned', it, actor, { reviewer: r.name, again: true, mentions: [r.name] }));
        }
      }),
      addReviewer: act((out, id, name) => {
        const it = item(id);
        it.reviewers.push({ name, verdict: null, at: iso() });
        out.push(itemEvent(ctx, 'review.reviewer_assigned', it, actor, { reviewer: name, mentions: [name] }));
        closeAsks(it, out, { kind: 'reviewer_assigned' }, actor);
      }),
      // a reviewer's verdict: ok, or concerns (which @mention the author)
      verdict: act((out, id, verdict, comment = '') => {
        const it = item(id);
        const r = it.reviewers.find((x) => x.name === actor.name);
        if (!r) throw new Error(`sim: ${actor.name} is not a reviewer on ${id}`);
        const author = it.questions.find((q) => q.kind === 'review')?.raisedBy || it.review?.requestedBy || it.workedBy.at(-1) || null;
        const ask = verdict === 'concerns' && author && !comment.includes(`@${author}`) ? `\n\n@${author} please take a look.` : '';
        const body = `${verdict === 'ok' ? '✅ **Looks good**' : '⚠ **Concerns**'} — review by ${actor.name}${comment ? `\n\n${comment}` : ''}${ask}`;
        const c = { id: rid('c'), author: actor, body, createdAt: iso() };
        it.comments.push(c);
        Object.assign(r, { verdict, at: c.createdAt, commentId: c.id, verified: true });
        out.push(itemEvent(ctx, 'comment.added', it, actor, { comment: { id: c.id, body }, mentions: mentionsIn(body) }));
        out.push(itemEvent(ctx, 'review.reviewed', it, actor, { reviewer: actor.name, verdict }));
        closeAsks(it, out, { kind: 'verdict', who: actor.name }, actor);
      }),
      // the review decided: approve → into the next gate (Done); changes → back to the working column
      decide: act((out, id, verdict, comment = '') => {
        const it = item(id);
        const cols = ctx.board.columns;
        const idx = cols.findIndex((c) => c.id === it.columnId);
        const working = cols.find((c) => c.flags.working);
        const target = verdict === 'approve' ? (cols.slice(idx + 1).find((c) => c.flags.humanOnlyIn) || cols[idx + 1])
          : (working && cols.indexOf(working) < idx ? working : cols[idx - 1]);
        recordVerdict(it, actor, out, verdict, comment);
        if (target && target.id !== it.columnId) moveTo(it, target.id, actor, out);
      }),
      // an agent asks the human on the card
      ask: act((out, id, reason) => openQuestion(item(id), { id: rid('q'), reason, raisedBy: actor.name, raisedAt: iso(), kind: 'question' }, actor, out)),
      // the human answers every open question on the card (or one by id)
      answer: act((out, id, reply, questionId = null) => {
        const it = item(id);
        it.comments.push({ id: rid('c'), author: actor, body: reply, createdAt: iso() });
        closeQuestions(it, actor, out, (q) => q.kind !== 'review' && (!questionId || q.id === questionId), reply);
      }),
      // a request to an agent (the coordinator when `to` is left out); returns its id
      request: act((out, body, to = null) => {
        const target = to || ctx.board.coordinator || Object.values(core.defs).find((d) => d.role === 'coordinator')?.name;
        if (!target) throw new Error('sim: no agent to send the request to');
        const req = { id: rid('r'), body, to: target, by: actor, at: iso(), status: 'open', replies: [] };
        ctx.board.requests.push(req);
        const who = [target].filter((n) => n !== actor.name);
        out.push({ board: ctx.id, type: 'request.created', actor, request: { id: req.id, body, to: target }, recipients: who, addressed: who });
        return req.id;
      }),
      replyRequest: act((out, id, body, done = false) => {
        const req = ctx.board.requests.find((x) => x.id === id);
        if (body) req.replies.push({ id: rid('c'), author: actor, body, at: iso() });
        if (done) req.status = 'done';
        const to = actor.name === req.to ? [] : [req.to];
        const asker = req.by?.kind === 'agent' && req.by.name !== actor.name ? [req.by.name] : [];
        const who = [...new Set([...to, ...asker])];
        out.push({ board: ctx.id, type: done ? 'request.done' : 'request.replied', actor, request: { id: req.id, to: req.to, by: req.by?.name, status: req.status }, recipients: who, ...(who.length ? { addressed: who } : {}) });
      }),
      // ask another agent for something (INT-391); returns the ask's id
      askAgent: act((out, id, d) => {
        const it = item(id);
        const a = ASKS.newAsk({ id: rid('ask'), by: actor.name, to: d.to, kind: d.kind || 'answer', what: d.what, options: d.options, dueMinutes: d.dueMinutes, now: now() });
        (it.asks ||= []).push(a);
        out.push(itemEvent(ctx, 'ask.created', it, actor, { ask: { ...a }, mentions: [d.to] }));
        return a.id;
      }),
      answerAsk: act((out, id, askId, answer) => {
        const it = item(id);
        const a = it.asks.find((x) => x.id === askId);
        Object.assign(a, { state: 'done', answer, doneAt: iso(), doneBy: actor.name });
        it.comments.push({ id: rid('c'), author: actor, body: `↩ **${a.by}'s ask** (${a.kind}): ${a.what}\n\n${answer}`, createdAt: iso() });
        out.push(itemEvent(ctx, 'ask.done', it, actor, { ask: { ...a }, mentions: [a.by].filter((n) => n !== actor.name) }));
        for (const up of ASKS.closeEscalations(it, a, iso())) out.push(itemEvent(ctx, 'ask.done', it, actor, { ask: { ...up } }));
      }),
      archive: act((out, id) => { const it = item(id); const c = col(it.columnId); c.itemIds.splice(c.itemIds.indexOf(it.id), 1); delete ctx.board.items[it.id]; out.push(itemEvent(ctx, 'item.archived', it, actor, {})); }),
    };
  }

  let askTimer = null;
  if (opts.sweeps !== false) { scheduler.startSweeps(); askTimer = setInterval(sweepAsks, 30_000); }

  const sim = {
    board: ctx.board, events, runs, human: actorApi(HUMAN), as: (name) => actorApi({ kind: 'agent', name }), system: actorApi(SYSTEM),
    item,
    // Advance the clock; timers due meanwhile fire in order. In steps of a second: node's mock timers move Date to the
    // end of a tick before firing what fell due, so one big tick would start every run late and push its follow-ups.
    tick(t) {
      let left = ms(t);
      while (left > 0) { const step = Math.min(1000, left); mock.timers.tick(step); left -= step; }
      return sim;
    },
    now: () => iso(),
    // runs, optionally of one agent, as compact lines: "groot item.assigned T-1"
    wakes: (agent = null) => runs.filter((r) => !agent || r.agent === agent).map((r) => `${r.agent} ${r.why.join(',')}${r.items.length ? ` ${r.items.join(',')}` : ''}`),
    agent: (name) => ({ ...st(name), def: core.defs[name] }),
    work: (name) => work.workFor(ctx, name),
    pending: (name) => core.deps.pending(name),
    // who an event (by seq, or the last one) was for
    addressed: (s = seq) => events.find((e) => e.seq === s)?.addressed || [],
    def: (name) => core.defs[name],
    // the board's alerting metrics for this run so far (INT-389): wakes by reason, runs that changed nothing, and the
    // open tickets nobody will touch
    metrics() {
      const wakes = {};
      for (const r of runs) for (const reason of r.reasons || []) wakes[reason] = (wakes[reason] || 0) + 1;
      const finished = Object.values(ctx.board.items).filter((it) => it.journey?.doneAt);
      const autonomy = Object.fromEntries(AUTONOMY.LEVELS.map((l) => [l, finished.filter((it) => it.journey.level === l).length]));
      const interventions = {};
      for (const it of finished) for (const [k, n] of Object.entries(it.journey.touches)) interventions[k] = (interventions[k] || 0) + n;
      return { runs: runs.length, wakes, idleRuns: runs.filter((r) => r.writes === 0).length, autonomy, interventions,
        rework: finished.reduce((n, it) => n + (it.journey.back || 0), 0),
        unowned: work.unownedTickets(ctx, Object.values(core.defs).filter((d) => d.enabled).map((d) => d.name)).map((it) => it.id) };
    },
    close() {
      scheduler.stopSweeps();
      clearInterval(askTimer);
      for (const t of core.timers.values()) clearTimeout(t);
      mock.timers.reset();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return sim;
}

module.exports = { createSim, ms };
