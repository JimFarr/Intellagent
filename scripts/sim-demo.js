'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Watch the alerting simulator (lib/sim) work: a small team handles a few tickets from the human, and the timeline
// shows every board event and every agent woken, minute by minute, on the board's own rules.
//
//   node scripts/sim-demo.js            the timeline, in the terminal
//   node scripts/sim-demo.js --json     the same as JSON (for a page that draws it)
const { createSim } = require('../lib/sim');
const { agentLike } = require('../lib/sim/behaviours');

const sim = createSim({
  columns: [
    { name: 'Backlog', flags: { allowCreate: true, sleeping: true } },
    { name: 'Ready', flags: { pickup: true, allowCreate: true } },
    { name: 'In Progress', flags: { working: true } },
    { name: 'Review', flags: { review: true } },
    { name: 'Done', flags: { releaseLeaseOnEnter: true, humanOnlyIn: true } },
  ],
  team: {
    gamora: { role: 'coordinator', behave: agentLike({ builders: ['groot', 'rocket'], reviewers: ['nebula'] }) },
    groot: { role: 'builder', behave: agentLike() },
    rocket: { role: 'builder', behave: agentLike() },
    nebula: { role: 'reviewer', behave: (run, act) => {
      // concerns on the first ticket's first review, ok otherwise
      for (const id of run.items) {
        const it = sim.item(id);
        const me = it.reviewers.find((r) => r.name === 'nebula');
        if (!me || me.verdict) continue;
        const first = id === 'T-1' && !it.comments.some((c) => /Concerns/.test(c.body));
        act.verdict(id, first ? 'concerns' : 'ok', first ? 'No test for the error path.' : '');
      }
    } },
    stakar: { role: 'builder', grants: ['review.decide'], behave: agentLike({ does: ['decide'] }) },
  },
});

const script = [
  [0, () => sim.human.create({ title: 'Fix the login error', column: 'Ready', priority: 'High' })],
  [5, () => sim.human.create({ title: 'Add CSV export', column: 'Ready' })],
  [8, () => sim.human.create({ title: 'Tidy the settings page', column: 'Backlog', assignee: 'rocket' })],
  [40, () => sim.human.move('T-3', 'Ready')],
  [70, () => sim.human.comment('T-2', 'Rocket, can you also add a header row?')],
  [75, () => sim.human.comment('T-2', '@rocket can you also add a header row?')],
];
for (let minute = 0; minute <= 180; minute++) {
  for (const [at, step] of script) if (at === minute) step();
  sim.tick('1m');
}

// One timeline: what happened on the board, and who was woken for it
const t0 = Date.parse('2026-10-19T09:00:00Z');
const clock = (iso) => { const m = Math.round((Date.parse(iso) - t0) / 1000); return `${String(Math.floor(m / 3600)).padStart(2, '0')}:${String(Math.floor((m % 3600) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const lines = [];
for (const e of sim.events) {
  if (/^agent\./.test(e.type) || !e.actor) continue;
  lines.push({ at: e.ts, kind: 'event', who: e.actor.name, what: e.type, item: e.itemId || e.request?.id || '', addressed: e.addressed || [] });
}
for (const r of sim.runs) lines.push({ at: r.at, kind: 'wake', who: r.agent, what: r.why.join(', '), item: r.items.join(', '), work: r.work });
lines.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (b.kind === 'wake') - (a.kind === 'wake'));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ lines: lines.map((l) => ({ ...l, clock: clock(l.at) })), board: Object.values(sim.board.items).map((it) => ({ id: it.id, title: it.title, column: it.columnId, assignee: it.assignee })) }, null, 2));
} else {
  for (const l of lines) {
    if (l.kind === 'wake') console.log(`${clock(l.at)}  ⏰ ${l.who.padEnd(7)} woken  ${l.what}${l.item ? ` · ${l.item}` : ''}${l.work?.length ? `  (work: ${l.work.join(', ')})` : ''}`);
    else console.log(`${clock(l.at)}     ${l.who.padEnd(7)} ${l.what.padEnd(26)} ${l.item.padEnd(5)}${l.addressed.length ? ` → wakes ${l.addressed.join(', ')}` : ''}`);
  }
  console.log('\nEnd of the run:');
  for (const it of Object.values(sim.board.items)) console.log(`  ${it.id} ${it.title.padEnd(26)} ${it.columnId}${it.assignee ? ` (${it.assignee})` : ''}`);
}
sim.close();
