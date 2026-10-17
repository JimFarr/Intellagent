'use strict';
// Which model a run needs (INT-308). Most wakes never build anything: a work.pending that offers nothing to start,
// a comment to acknowledge, a lease request, a focus change. Those run on the agent's cheap `triage` model; a wake
// that can need building (a start, feedback, an assignment, a request, an explain) runs on its `build` model, the
// agent's own. Anything the table doesn't know is build: a wrong guess costs money, never work.

// event types that can never need building
const TRIAGE_EVENTS = new Set([
  'lease.request', 'lease.handover', 'lease.declined', 'lease.warning', 'lease.expired',
  'board.idle', 'focus.created', 'focus.updated', 'focus.activated', 'focus.retired',
]);
// work.pending actions a run answers without building: renewing, answering a lease request, nudging, chasing
const TRIAGE_ACTIONS = new Set(['renew', 'answer_lease_request', 'supervise', 'chase']);

// A comment needs building when it asks for something: an explain, feedback, or a request
const commentNeedsBuild = (e) => e.intent === 'explain' || e.intent === 'request' || e.kind === 'feedback';

function eventNeedsBuild(e) {
  if (e.type === 'work.pending') return (e.work || []).some((w) => !TRIAGE_ACTIONS.has(w.action));
  if (e.type === 'comment.added') return commentNeedsBuild(e);
  return !TRIAGE_EVENTS.has(e.type);
}

// 'triage' when no event in the batch can need building, else 'build'. An empty batch is build.
const classify = (events) => (events?.length && !events.some(eventNeedsBuild) ? 'triage' : 'build');

// The model for a run: runModels = { triage, build } (either may be missing; a missing one is the agent's model)
const modelFor = (def, kind) => (def.runModels && def.runModels[kind]) || def.model || null;

module.exports = { classify, modelFor, eventNeedsBuild, TRIAGE_EVENTS, TRIAGE_ACTIONS };
