# How work reaches agents: the obligation ledger

Status (2026-10-19): INT-389 (metrics) landed; INT-390 (wake from work) landed behind `wakeFrom: "work"`; INT-391 (asks) next. The alerting simulator (docs/simulator.md) is where each step is tried before it ships, and the Prometheus metrics from INT-389 measure it on the real board.

## Today

```
board change ─► event (events.jsonl) ─► wake filter (listen) ─► agent queue: copies of events
                sweep (every 10 min) ─► pendingWork() ─► one "work.pending" event ─┘
run starts ─► prompt: the queued events ─► the agent pulls its brief, work and tickets through the API
```

What goes wrong, as found with the simulator and on the Lenza board:

1. **Two channels that disagree.** Events are pushed and work is pulled. The board guesses which one the agent acted on: that guess is the "seen work" bookkeeping. INT-378 (work counted as seen that the agent never looked at) and INT-388 (concerns with no work item) both lived in that gap.
2. **The queue holds copies of events, not obligations.** Ten comments are ten queued events. What the agent owes is never stored.
3. **Obligations have no lifecycle.** Work items are recomputed by scanning every ticket, and the only state kept is a list of keys already offered. Nothing says delivered, done or overdue, so escalation is rebuilt by counting comments.
4. **Agent-to-agent obligations are prose.** "@groot please fix this" is a comment. Whether it is acted on depends on a model reading it.

## Proposed

```
board change ─► event log (unchanged: history, the UI's live feed, the audit)
                   │
                   ▼
          ledger: each agent's work items, recomputed for the agents the change concerns
          + asks (stored: the only obligations not derived from ticket state)
                   │  diff: new · changed · resolved
                   ▼
          deliver: wake with the new items; the events that caused them come along as context
                   │
                   ▼
          the agent's writes resolve items (done) · items not done by their due time escalate (overdue)
```

- **The ledger is what an agent receives.** An item is `{ key, action, ticket, why, call, state, due? }`, with state one of `new`, `delivered`, `done` or `overdue`. It is derived from board state (the rules in lib/alerts/work.js), apart from asks.
- **A wake is a ledger diff.** A run is given its new items. A run with no item is not started. "Woken for nothing" is then a bug the metrics can count, not a normal outcome.
- **Events stop being the delivery mechanism.** An @mention is conversation: it reaches the agent as a `reply` item once. An assignment, an answer, a verdict, concerns, a lease request or a request are each already an item.
- **Asks** (`POST …/items/<ID>/asks { to, what, kind, dueMinutes }`) are stored items with an owner and a due time.
  - **Answered:** by doing the thing (a verdict answers a verdict ask; a new review request answers a fix ask) or by `…/asks/<id>/done`.
  - **Overdue:** escalated once, to the coordinator; an escalation never escalates again and the human is not asked (with no coordinator, or when it is the asker or owner, `ask.overdue` wakes the asker).
  - **chase and supervise** create asks instead of asking an agent to write a comment.
- **The queue holds item keys.** It is small and can't drift from the board. A restart recomputes the ledger.

## Steps

1. **INT-389, the baseline:** metrics for wakes by reason, runs that changed nothing, and tickets nobody will touch. On the board, in Grafana and in the simulator.
2. **INT-390, the ledger:** delivered as diffs. It is tried in the simulator first. It must keep liveness, cut wakes, and leave no run without an item; the contract test keeps the simulator honest.
3. **INT-391, asks:** stored ledger items, so chase and supervise become commands.

Each step lands only when the simulator shows it is better, and the metrics say whether the real board agrees.

## What the numbers said (2026-10-19)

From this board's event log since 2026-10-11: 2,626 finished runs; 16% (411) changed nothing.
- **Comments:** 56% of all runs were woken by comments, and 975 of the 1,008 runs woken only by comments were woken by another agent's comment (25 by the human). Agents talking to agents in prose is the main cost, which is what asks (INT-391) replace.
- **Landing news:** 329 runs, about a quarter of them idle. INT-386 stopped them.

In the simulator's benchmark (`node scripts/sim-bench.js`, `--wake work`), waking from work keeps liveness and gives the same runs where every wake already had work. It removes the wakes for news without work (a lease released, a reassignment's previous owner) and guarantees every wake carries an item.
