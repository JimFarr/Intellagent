# The alerting simulator

Who gets woken, when and why: on a board in memory, with stub agents and a fake clock, using the board's own rules. A scenario runs in milliseconds, with no processes and no HTTP.

```js
const { createSim } = require('../lib/sim');
const { agentLike } = require('../lib/sim/behaviours');

const sim = createSim({ team: {
  gamora: { role: 'coordinator', behave: agentLike({ builders: ['groot'], reviewers: ['nebula'] }) },
  groot: { role: 'builder', behave: agentLike() },
  nebula: { role: 'reviewer', behave: agentLike() },
} });
const t = sim.human.create({ title: 'Fix the login', column: 'Ready' });
sim.tick('1h');
sim.wakes();      // ['gamora item.created T-1', 'groot item.assigned T-1', …]
sim.close();      // always: the simulator owns the clock (node:test mock timers) while it is open
```

## What is real and what is a stub

| Real (the board's own code) | Stub |
|---|---|
| Who an event is for and addresses: `lib/alerts/recipients.js` | The agent's run: a policy function you write (`behave`) |
| Each agent's work and wake keys: `lib/alerts/work.js`, `board.js`, `oks.js` | Board actions: `lib/sim` emits what each route emits; the contract test holds them to the board |
| The wake filters (`listen`) through the real agent config: roles, defaults, helpers, probation | Permissions, leases and gates are not checked: an action always succeeds |
| The scheduler: settle, throttle, hourly cap, sweeps, seen work, idle alarm | Git: landing is an option (`landing: 'lands' \| 'fails' \| 'nothing' \| 'off'`) |

## Writing a scenario

- **Actions**:
  - `sim.human.…` or `sim.as('groot').…`, each one of: `create`, `comment`, `assign`, `move`, `start`, `review`, `addReviewer`, `verdict`, `decide`, `ask`, `answer`, `request`, `replyRequest`, `archive`.
- **Time**:
  - `sim.tick('90s' | '5m' | '2h')` advances the clock.
  - Every timer due in that time fires at its own moment (the clock moves in one-second steps).
- **Reading the result**:
  - `sim.runs`: each run, as `{ agent, at, why, items, work, events }`.
  - `sim.wakes(agent?)`: the same, as short lines.
  - `sim.work(name)`: an agent's `…/work`.
  - `sim.pending(name)`: what would wake it.
  - `sim.item(id)`: a ticket.
- **Agents**:
  - `agentLike({ reads: 'events' | 'brief' })` takes the actions of its role and finishes them within the run.
  - `'events'` (the default) acts only on what woke it, which is how agents on real boards behave.
  - Write your own `behave(run, act)` for anything else.

## Where the tests are

- **`test/sim.test.js`**: the simulator's own flows.
- **`test/sim-contract.test.js`**:
  - runs one script on the simulator and on a real board, and they must give the same events for the same people;
  - fails if a route changes who it addresses and `lib/sim` is not changed with it.
- **`test/sim-scenarios.test.js`**: how alerting should work.
  - **Liveness**: nothing gets stuck with nobody told.
  - **Quiet**: nobody is woken for nothing.
  - A behaviour the board doesn't meet yet is a `todo` naming its ticket. The todo comes off with the fix.
