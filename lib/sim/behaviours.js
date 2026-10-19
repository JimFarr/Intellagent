'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Stub agents for the alerting simulator (INT-383): what each role does when a run starts, as a policy function.
//
// Two ways an agent can decide what to look at, because real agents differ and the difference matters:
//   'events'  only the tickets and requests the run's events are about (what agents on the Lenza board did: "they
//             weren't in this run's events"), plus the work a work.pending summary hands it
//   'brief'   everything in its …/work as well
// Every policy finishes what it takes on within the run (a builder starts a ticket and asks for review at once), so a
// scenario is about who is told what, not about how long the work takes.

// What a run sees: [{ action, id, requestId }] from its brief, narrowed to what woke it unless it reads the brief.
function look(run, reads) {
  const about = new Set([...run.items, ...run.events.map((e) => e.itemId)].filter(Boolean));
  const offered = new Set(run.work);
  return run.brief.next.filter((n) => reads === 'brief' || about.has(n.id) || offered.has(`${n.action}:${n.id || n.requestId}`)
    || (n.action === 'handle_request' && run.why.includes('request.created')));
}

/**
 * A role-shaped policy. { reads: 'events' | 'brief', builders?: [names] (who a coordinator routes to),
 * reviewers?: [names], does?: [actions] (only these) }
 */
function agentLike({ reads = 'events', builders = [], reviewers = [], does = null } = {}) {
  return (run, act) => {
    for (const n of look(run, reads)) {
      if (does && !does.includes(n.action)) continue;
      switch (n.action) {
        case 'start': case 'resume': case 'address_feedback':
          act.start(n.id);
          act.review(n.id, { summary: 'done', evidence: 'tests pass' });
          break;
        case 'review_ticket': act.verdict(n.id, 'ok'); break;
        case 'decide': act.decide(n.id, 'approve', 'Approved for the human'); break;
        case 'assign_reviewer': { const who = reviewers.find((r) => r !== run.agent); if (who) act.addReviewer(n.id, who); break; }
        case 'triage': { if (builders[0]) act.assign(n.id, builders[0]); break; }
        case 'handle_request': act.replyRequest(n.requestId, 'Done', true); break;
        default: break; // chase, supervise, land, explain, reply, write, renew, continue: noted, not acted on
      }
    }
  };
}

const idle = () => {};

module.exports = { agentLike, idle, look };
