'use strict';
// --manifest names the board, even inside a standing run whose INTELLAGENT_URL and INTELLAGENT_TOKEN are another
// board's (INT-320: quill reaching its own board from a run on the main one).
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { startServer, cleanEnv } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'intellagent.js');
const cli = (args, env) => spawnSync(process.execPath, [CLI, ...args], { cwd: os.tmpdir(), env: cleanEnv(env), encoding: 'utf8', input: '', timeout: 60000 });

it('--manifest wins over a run\'s INTELLAGENT_URL, and the run\'s INTELLAGENT_TOKEN is never sent to another board (INT-467)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-manifest-'));
  // the board would accept the run's token, so a 200 shows it was sent and a 401 that it was held back
  fs.writeFileSync(path.join(dir, 'local.json'), JSON.stringify({ agentTokens: { quill: require('../lib/locate').hashToken('run-token') } }));
  const s = await startServer({ dir, manifest: { auth: { requireAgentTokens: true } } });
  const run = { INTELLAGENT_URL: 'http://127.0.0.1:9', INTELLAGENT_TOKEN: 'run-token', INTELLAGENT_AGENT: 'quill' };
  const mp = path.join(dir, 'intellagent.manifest.json');
  try {
    const r = cli(['api', 'GET', '/api/permissions/me', '--manifest', mp], run);
    assert.equal(r.status, 1, 'the address is the manifest\'s board; the token, another board\'s, stays home');
    assert.match(r.stderr, /error 401 UNAUTHORIZED: Agent "quill" must send its token/);
    const same = cli(['api', 'GET', '/api/permissions/me', '--manifest', mp], { ...run, INTELLAGENT_URL: s.base });
    assert.equal(same.status, 0, `the run's own board: its token goes with it: ${same.stderr}`);
    assert.equal(JSON.parse(same.stdout).name, 'quill');
    const without = cli(['api', 'GET', '/api/permissions/me', '--url', s.base], run);
    assert.equal(without.status, 0, `without --manifest the run's token is the one sent: ${without.stderr}`);
  } finally { await s.stop(); }
});

it('a --manifest path with no manifest is refused with a hint, never ignored (INT-439)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-manifest-'));
  fs.mkdirSync(path.join(dir, '.intellagent'));
  fs.writeFileSync(path.join(dir, '.intellagent', 'intellagent.manifest.json'), '{}');
  const r = cli(['brief', '--manifest', path.join(dir, 'intellagent.manifest.json')], {});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /error 400 BAD_REQUEST: no manifest at .* — hint: did you mean .*\.intellagent[\\/]intellagent\.manifest\.json\?/);
});
