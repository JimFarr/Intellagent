'use strict';
// A standing agent's runtime state (data/agents.state.json): queue, cursor, failures, last run. Shared by the
// scheduler, the runner and the config, which each read and change it through st(name) and save().
const fs = require('fs');
const jsonfile = require('../jsonfile');

function createState({ stateFile, seq }) {
  const state = readState();

  function readState() {
    try { return jsonfile.read(stateFile); } catch { return { agents: {} }; }
  }
  // Written immediately, not debounced: a power cut right after a run starts must still find it here.
  function save() {
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile);
  }
  const st = (name) => (state.agents[name] ||= { status: 'idle', cursor: seq(), queue: [], inflight: null, runs: [], failures: 0, lastRun: null });
  // The events a run was given go back to the front of the queue, ahead of anything that arrived meanwhile.
  function requeueInflight(s) {
    s.queue = [...(s.inflight || []), ...s.queue.filter((e) => !(s.inflight || []).some((i) => i.seq === e.seq))];
    s.inflight = null;
  }

  return { state, save, st, requeueInflight };
}

module.exports = { createState };
