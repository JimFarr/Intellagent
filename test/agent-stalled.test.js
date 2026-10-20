// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// The agent view's `stalled` flag for an agent held by a wait (INT-379): fake clock, no board, no runs.
const { describe, it, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgents } = require('../lib/agents');

const MIN = 60_000;

describe('agent view: stalled when a resume is late (INT-379)', () => {
  let dir; let agents; let resumesAt;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-stalled-'));
    const file = path.join(dir, 'agents.json');
    const stateFile = path.join(dir, 'agents.state.json');
    fs.writeFileSync(file, JSON.stringify({ agents: { bot: { run: 'node -e 0', maxRunsPerHour: 2 } } }));
    resumesAt = new Date(Date.now() + 60 * MIN).toISOString();
    // nothing queued, so nothing is dispatched or timed when the board starts
    fs.writeFileSync(stateFile, JSON.stringify({ agents: { bot: { status: 'throttled', resumesAt, cursor: 0, queue: [], inflight: null, runs: [], failures: 0, lastRun: null } } }));
    agents = createAgents({ file, stateFile, logDir: path.join(dir, 'logs'), cwd: dir, env: {}, emit() {}, matchesFilter: () => true, parseFilter: () => ({}), recent: () => [], seq: () => 0, log() {}, noRuns: true });
    mock.timers.enable({ apis: ['Date'], now: Date.parse(resumesAt) });
  });
  afterEach(() => { mock.timers.reset(); agents.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('is false up to the 5-minute grace after resumesAt (4 minutes late), true past it (6 minutes)', () => {
    assert.equal(agents.get('bot').status, 'throttled');
    assert.equal(agents.get('bot').stalled, false, 'not due yet');
    mock.timers.setTime(Date.parse(resumesAt) + 4 * MIN);
    assert.equal(agents.get('bot').stalled, false, '4 minutes late is within the grace');
    mock.timers.setTime(Date.parse(resumesAt) + 6 * MIN);
    assert.equal(agents.get('bot').stalled, true, '6 minutes late');
    assert.equal(agents.get('bot').resumesAt, resumesAt, 'the view still says when it was due');
  });
});
