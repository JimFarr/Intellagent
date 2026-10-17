'use strict';
// Presets: the team part (INT-302). The library only: what may enter a board is decided here, before any install.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const presets = require('../lib/presets');

const tmp = (what) => fs.mkdtempSync(path.join(os.tmpdir(), `ia-${what}-`));
const team = (extra = {}) => ({
  name: 'crew', version: '1',
  board: { columns: [{ name: 'Todo' }], schema: {}, ticketTemplates: [], directives: '- small' },
  team: {
    roles: { scout: { label: 'Scout', brief: 'Looks first.', perms: ['read'], model: 'haiku' } },
    slots: { lead: { role: 'coordinator', model: 'sonnet', areas: ['docs/'], listen: 'addressed', pickup: 'all', context: 'agent-context/lead.md', grants: ['agents.control', { power: 'review.decide', where: { 'reviewers.checker': 'ok' } }] } },
    base: 'base-context.md', ...extra,
  },
});
const FILES = { 'agent-context/lead.md': 'Route by areas.', 'base-context.md': 'Be brief.' };
function folder(p, files = FILES) {
  const d = tmp('team');
  fs.writeFileSync(path.join(d, 'preset.json'), JSON.stringify(p));
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); }
  return d;
}

describe('presets: the team part (INT-302)', () => {
  it('a valid team loads, its context pages are read from the folder, and it lists as pieces', () => {
    const p = presets.load(folder(team()), null);
    assert.deepEqual(p.team.files, { lead: 'Route by areas.', base: 'Be brief.' });
    assert.deepEqual(Object.keys(presets.teamParts(p)).sort(), ['base', 'context:lead', 'role:scout', 'slot:lead']);
    assert.equal(presets.teamParts(p)['slot:lead'].grants, undefined, 'proposed grants are not a piece that installs');
    assert.deepEqual(Object.keys(presets.parts(p)).filter((k) => /^(role|slot|context|base)/.test(k)), [], 'parts stays the board until the team is installed');
  });

  it('run, env, inheritEnv, commands and MCP configs are refused, in a slot, a role or a proposal, naming the key', () => {
    for (const key of ['run', 'env', 'inheritEnv', 'commands', 'mcpServers', 'mcpConfig']) {
      const inSlot = team(); inSlot.team.slots.lead[key] = 'x';
      assert.match(presets.validate(inSlot), new RegExp(`team\\.slots\\.lead carries "${key}": a preset never brings it`));
      const inRole = team(); inRole.team.roles.scout[key] = 'x';
      assert.match(presets.validate(inRole), new RegExp(`team\\.roles\\.scout carries "${key}"`));
    }
    const inGrant = team(); inGrant.team.slots.lead.grants = [{ power: 'x', commands: ['rm'] }];
    assert.match(presets.validate(inGrant), /grants carries "commands"/);
    const p = team(); p.team = { slots: { lead: { role: 'builder', run: 'evil' } } };
    assert.throws(() => presets.load(folder(p), null), { code: 'BAD_PRESET', message: /carries "run"/ });
  });

  it('names, models and settings are checked', () => {
    const bad = (mut) => { const p = team(); mut(p.team); return presets.validate(p); };
    assert.match(bad((t) => { t.slots['Lead Agent'] = { role: 'builder' }; }), /the name must be lowercase/);
    assert.match(bad((t) => { t.slots.lead.model = 'opus; rm -rf /'; }), /plain model name/);
    assert.match(bad((t) => { delete t.slots.lead.role; }), /role is required/);
    assert.match(bad((t) => { t.slots.lead.surprise = 1; }), /not a slot setting/);
    assert.match(bad((t) => { t.slots.lead.context = '../../etc/passwd'; }), /agent-context\/lead\.md/);
    assert.match(bad((t) => { t.base = '/etc/passwd'; }), /base-context\.md/);
    assert.match(bad((t) => { t.stuff = 1; }), /not part of a team/);
    assert.match(bad((t) => { t.roles.scout.grants = ['x']; }), /not a role setting/);
    assert.equal(presets.validate(team()), null);
  });

  it('a context page must be in the folder, inside it, and at most 8000 characters', () => {
    assert.throws(() => presets.load(folder(team(), {}), null), { code: 'BAD_PRESET', message: /not in the preset folder/ });
    assert.throws(() => presets.load(folder(team(), { ...FILES, 'agent-context/lead.md': 'x'.repeat(8001) }), null), { code: 'BAD_PRESET', message: /longer than 8000/ });
    const d = folder(team(), { 'base-context.md': 'ok' });
    const outside = path.join(tmp('outside'), 'secret.md');
    fs.writeFileSync(outside, 'secret');
    fs.mkdirSync(path.join(d, 'agent-context'), { recursive: true });
    try { fs.symlinkSync(outside, path.join(d, 'agent-context', 'lead.md')); } catch { return; } // no right to make links on this PC
    assert.throws(() => presets.load(d, null), { code: 'BAD_PRESET', message: /leaves the preset folder/ });
  });

  it('extends: slots and roles merge by name with the child winning, and so do the context pages and the base', () => {
    const parent = { name: 'p', version: '1', team: { roles: { scout: { model: 'haiku' } }, slots: { lead: { role: 'coordinator' }, helper: { role: 'builder' } }, base: 'base-context.md', files: { lead: 'parent page', base: 'parent base' } }, board: { columns: [], schema: {}, ticketTemplates: [] } };
    const child = { name: 'c', version: '1', team: { slots: { lead: { role: 'reviewer' } }, files: { lead: 'child page' } }, board: { columns: [], schema: {}, ticketTemplates: [] } };
    const f = presets.fold(child, parent);
    assert.equal(f.team.slots.lead.role, 'reviewer');
    assert.equal(f.team.slots.helper.role, 'builder');
    assert.equal(f.team.roles.scout.model, 'haiku');
    assert.deepEqual(f.team.files, { lead: 'child page', base: 'parent base' });
    assert.equal(presets.fold({ ...child, team: undefined }, { ...parent, team: undefined }).team, undefined, 'no team on either side: none');
  });

  it('powers lists every role, slot, model, pickup, proposed grant, context page and the base, and says probation', () => {
    const lines = presets.powers(presets.load(folder(team()), null)).join('\n');
    assert.match(lines, /role "scout" \(model haiku\): permissions read/);
    assert.match(lines, /agent slot "lead": role coordinator, model sonnet, listen "addressed", pickup "all"; you name it at install, it starts on probation and runs nothing until you accept it/);
    assert.match(lines, /PROPOSED grant for "lead": agents\.control \(not written unless you accept it; --yes alone writes none\)/);
    assert.match(lines, /PROPOSED grant for "lead": review\.decide where \{"reviewers\.checker":"ok"\}/);
    assert.match(lines, /context page of 15 characters/);
    assert.match(lines, /base context \(9 characters\): every agent on the board is taught it/);
  });
});

describe('presets: installing the team (INT-302 step 2)', () => {
  const loaded = () => presets.load(folder(team({ roles: undefined })), null);
  const ctx = { names: { lead: 'boss' }, agents: ['rocket'], roles: ['coordinator', 'builder'] };

  it('names a slot, builds the POST and PATCH bodies, and never carries run, env or commands', () => {
    const { steps, skipped, problems } = presets.teamInstall(loaded(), ctx);
    assert.deepEqual([skipped, problems], [[], []]);
    assert.deepEqual(steps[0].define, { name: 'boss', role: 'coordinator', model: 'sonnet', listen: 'addressed', pickup: 'all' });
    assert.deepEqual(steps[0].patch, { areas: ['docs/'], contextItems: [{ kind: 'note', title: 'Context', body: 'Route by areas.' }] });
    for (const k of ['run', 'env', 'inheritEnv', 'commands', 'grants']) assert.equal(k in steps[0].define || k in steps[0].patch, false, k);
  });

  it('an unnamed slot is skipped, not guessed', () => {
    assert.deepEqual(presets.teamInstall(loaded(), { ...ctx, names: {} }).skipped, ['lead']);
  });

  it('a name that is taken, badly written or used twice, and a role the board lacks, stop it with a code and a hint', () => {
    const two = team({ roles: undefined }); two.team.slots.second = { role: 'builder' };
    const p = presets.load(folder(two), null);
    const taken = presets.teamInstall(p, { ...ctx, names: { lead: 'rocket' }, agents: ['Rocket'] });
    assert.equal(taken.problems[0].code, 'CONFLICT');
    assert.match(taken.problems[0].hint, /pick another name/);
    assert.equal(presets.teamInstall(p, { ...ctx, names: { lead: 'Bad Name' } }).problems[0].code, 'BAD_REQUEST');
    assert.match(presets.teamInstall(p, { ...ctx, names: { lead: 'x', second: 'x' } }).problems[0].why, /names both lead and second/);
    assert.match(presets.teamInstall(p, { ...ctx, roles: ['builder'], names: { lead: 'boss' } }).problems[0].why, /needs the role "coordinator"/);
  });

  it('proposed grants are written only for a slot whose grants were accepted', () => {
    const p = loaded();
    assert.equal(presets.teamInstall(p, ctx).steps[0].define.grants, undefined, 'none by default');
    assert.match(presets.teamInstall(p, ctx).steps[0].notes.join(' '), /2 proposed grants not accepted/);
    assert.deepEqual(presets.teamInstall(p, { ...ctx, grants: ['lead'] }).steps[0].define.grants, [{ power: 'agents.control' }, { power: 'review.decide', where: { 'reviewers.checker': 'ok' } }]);
    assert.equal(presets.teamInstall(p, { ...ctx, grants: ['other'] }).steps[0].define.grants, undefined);
  });

  it('listen, pickup, the flags and the description are checked', () => {
    for (const [k, v, re] of [['listen', 'x', /listen must be one of/], ['pickup', 'sometimes', /pickup must be/], ['reviewer', 'yes', /reviewer must be true or false/], ['keepAlive', 'stream-json', /keepAlive must be true or false/], ['description', 'x'.repeat(2001), /at most 2000/]]) {
      const p = team(); p.team.slots.lead[k] = v;
      assert.match(presets.validate(p), re, k);
    }
  });

  it('preset add installs named slots as agents on probation through the API; --yes writes no grants, --yes --grants writes the listed ones', async () => {
    const { spawnSync } = require('child_process');
    const { startServer, cleanEnv } = require('./helpers');
    const cli = (args, cwd) => { const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'intellagent.js'), ...args], { cwd, env: cleanEnv({}), encoding: 'utf8', input: '', timeout: 60000 }); return { code: r.status, out: r.stdout, err: r.stderr }; };
    const p = team({ roles: undefined }); delete p.team.base; p.team.slots.lead.role = 'builder'; p.team.slots.lead.pickup = 'ready';
    const dir = folder(p, { 'agent-context/lead.md': 'Route by areas.' });
    const s = await startServer();
    try {
      const no = cli(['preset', 'add', dir, '--yes', '--agents', 'lead=rocket'], s.dir); // rocket: a name we may take
      assert.equal(no.code, 0, no.err);
      const a = JSON.parse(fs.readFileSync(path.join(s.dir, 'agents.json'), 'utf8')).agents.rocket;
      assert.equal(a.role, 'builder');
      assert.ok(a.probation, 'a preset never hands out an agent nobody accepted');
      assert.equal(a.grants, undefined, '--yes alone writes no grant');
      for (const k of ['run', 'env', 'inheritEnv', 'commands']) assert.equal(k in a, false, k);
      assert.deepEqual(a.areas, ['docs/']);
      assert.match(JSON.stringify(a.contextItems), /Route by areas\./);
      assert.deepEqual(presets.readLock(s.dir).presets.crew.agents, { lead: 'rocket' });
      const again = cli(['preset', 'add', dir, '--yes', '--agents', 'lead=rocket'], s.dir);
      assert.equal(again.code, 1, 'the preset is already installed');
      assert.equal(cli(['preset', 'add', dir, '--yes', '--agents', 'nosuch=x'], s.dir).code, 1);
    } finally { await s.stop(); }
  });

  it('record keeps the team pieces and the agent names, and plan does not call them "gone"', () => {
    const dir = tmp('rec');
    const p = loaded();
    presets.record(dir, p, ['slot:lead', 'context:lead'], { lead: 'boss' });
    const lock = presets.readLock(dir).presets.crew;
    assert.deepEqual(lock.agents, { lead: 'boss' });
    assert.ok(lock.parts['slot:lead'] && lock.parts['context:lead']);
    assert.equal(presets.plan(p, lock.parts, { columns: [], schema: {} }).some((s) => s.state === 'gone'), false);
  });
});
