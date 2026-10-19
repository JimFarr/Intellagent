'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Which of an agent's pending work counts as seen when a run starts (INT-378, INT-383). The runner and the
// alerting simulator share this rule.
//
// Pending work this run's events are about counts as seen, so an answer or a request doesn't wake it twice (once
// for the event, once as pending work). Only that: a run acts on what woke it and leaves the rest of its brief
// alone, so counting the whole brief as seen stranded work for good (a builder's queue; INT-378, a ticket that
// became decidable while the agent waited out its hourly cap). The rest counts once a work.pending event has
// offered it. Pickup and a builder's queue (start) only ever count that way.
function seenOnStart(events, pending) {
  const about = new Set(events.flatMap((e) => [e.itemId, e.request?.id]).filter(Boolean));
  return pending.filter((w) => w.action !== 'triage' && w.action !== 'pickup' && w.action !== 'start' && (about.has(w.id) || about.has(w.requestId))).map((w) => w.key);
}

module.exports = { seenOnStart };
