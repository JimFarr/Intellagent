'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// A benchmark for how agents are woken (INT-390): the same scenarios on the alerting simulator, and per scenario
// the runs, the runs that changed nothing, what woke them, and the tickets left that nobody will touch. Run it before
// and after a change to the waking rules and compare.
//
//   node scripts/sim-bench.js           a table
//   node scripts/sim-bench.js --json    the numbers
//   node scripts/sim-bench.js --wake work   with every agent waking from its work (INT-390)
const { createSim } = require('../lib/sim');
const { agentLike } = require('../lib/sim/behaviours');

const COLUMNS = [
  { name: 'Backlog', flags: { allowCreate: true, sleeping: true } },
  { name: 'Ready', flags: { pickup: true, allowCreate: true } },
  { name: 'In Progress', flags: { working: true } },
  { name: 'Review', flags: { review: true } },
  { name: 'Done', flags: { releaseLeaseOnEnter: true, humanOnlyIn: true } },
];
// This board's team, in miniature; agents act on what woke them
const team = (over = {}) => ({
  gamora: { role: 'coordinator', behave: agentLike({ builders: ['groot', 'rocket'], reviewers: ['nebula'] }) },
  groot: { role: 'builder', behave: agentLike() },
  rocket: { role: 'builder', behave: agentLike() },
  nebula: { role: 'reviewer', behave: agentLike() },
  stakar: { role: 'builder', grants: ['review.decide'], behave: agentLike({ does: ['decide'] }) },
  ...over,
});

const SCENARIOS = {
  'a day of work: 12 tickets over 3 h': (sim) => {
    for (let i = 0; i < 12; i++) { sim.human.create({ title: `job ${i + 1}`, column: 'Ready', priority: ['High', 'Medium', 'Low'][i % 3] }); sim.tick('15m'); }
    sim.tick('8h');
  },
  'chatty human: a question and a thanks on each of 6 tickets': (sim) => {
    for (let i = 0; i < 6; i++) sim.human.create({ title: `job ${i + 1}`, column: 'Ready', assignee: i % 2 ? 'rocket' : 'groot' });
    sim.tick('5m');
    for (let i = 1; i <= 6; i++) { const who = i % 2 ? 'groot' : 'rocket'; sim.human.comment(`T-${i}`, `@${who} is the edge case covered?`); sim.tick('3m'); sim.human.comment(`T-${i}`, `@${who} thanks!`); sim.tick('3m'); }
    sim.tick('6h');
  },
  'reassignments: 4 tickets moved between builders': (sim) => {
    for (let i = 0; i < 4; i++) sim.human.create({ title: `job ${i + 1}`, column: 'Backlog', assignee: 'groot' });
    for (let i = 1; i <= 4; i++) sim.human.assign(`T-${i}`, 'rocket');
    for (let i = 1; i <= 4; i++) sim.human.move(`T-${i}`, 'Ready');
    sim.tick('6h');
  },
  'busy builder: 6 tickets assigned to one builder at once': (sim) => {
    for (let i = 0; i < 6; i++) sim.human.create({ title: `job ${i + 1}`, column: 'Ready', assignee: 'groot' });
    sim.tick('8h');
  },
};

const rows = [];
for (const [name, run] of Object.entries(SCENARIOS)) {
  const wake = process.argv.includes('--wake') ? process.argv[process.argv.indexOf('--wake') + 1] : null;
  const sim = createSim({ columns: COLUMNS, team: team(), ...(wake ? { defaults: { wakeFrom: wake } } : {}) });
  try {
    run(sim);
    const m = sim.metrics();
    const done = Object.values(sim.board.items).filter((it) => it.columnId === 'done').length;
    rows.push({ scenario: name, tickets: Object.keys(sim.board.items).length, done, runs: m.runs, idle: m.idleRuns, unowned: m.unowned.length, wakes: m.wakes });
  } finally { sim.close(); }
}

if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else {
  console.log(`${'scenario'.padEnd(58)} done   runs  idle  stuck`);
  for (const r of rows) console.log(`${r.scenario.padEnd(58)} ${`${r.done}/${r.tickets}`.padEnd(6)} ${String(r.runs).padStart(4)}  ${String(r.idle).padStart(4)}  ${String(r.unowned).padStart(5)}`);
  console.log('\nwhat woke them:');
  for (const r of rows) console.log(`  ${r.scenario}: ${Object.entries(r.wakes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}
