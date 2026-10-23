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

it('--manifest wins over a run\'s INTELLAGENT_URL and INTELLAGENT_TOKEN; an explicit --url still picks the address', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-manifest-'));
  fs.writeFileSync(path.join(dir, 'local.json'), JSON.stringify({ agentTokens: { quill: 'quill-docs-token' } }));
  const s = await startServer({ dir, manifest: { auth: { requireAgentTokens: true } } });
  const run = { INTELLAGENT_URL: 'http://127.0.0.1:9', INTELLAGENT_TOKEN: 'main-board-token', INTELLAGENT_AGENT: 'quill' };
  const mp = path.join(dir, 'intellagent.manifest.json');
  try {
    const r = cli(['api', 'GET', '/api/permissions/me', '--manifest', mp], run);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).name, 'quill');
    const u = cli(['api', 'GET', '/api/permissions/me', '--manifest', mp, '--url', s.base], run);
    assert.equal(u.status, 0, u.stderr);
    const without = cli(['api', 'GET', '/api/permissions/me', '--url', s.base], run);
    assert.notEqual(without.status, 0, 'without --manifest the run\'s token is still the one sent');
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
