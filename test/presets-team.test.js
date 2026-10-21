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
    assert.match(lines, /context page of 15 characters the agent is taught, starting: "Route by areas\."/);
    assert.match(lines, /base context \(9 characters\): every agent on the board is taught it, so it is installed only if you ask \(--base\).*starts: "Be brief\."/);
  });

  it('a context page that is a directory (or far too large) is refused before it is read', () => {
    const d = folder(team(), FILES);
    fs.rmSync(path.join(d, 'agent-context', 'lead.md'));
    fs.mkdirSync(path.join(d, 'agent-context', 'lead.md'));
    assert.throws(() => presets.load(d, null), { code: 'BAD_PRESET', message: /not a regular file/ });
    fs.rmSync(path.join(d, 'agent-context', 'lead.md'), { recursive: true });
    fs.writeFileSync(path.join(d, 'agent-context', 'lead.md'), 'x'.repeat(40000));
    assert.throws(() => presets.load(d, null), { code: 'BAD_PRESET', message: /longer than 8000/ });
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

  it('grants are accepted one by one ("slot#i"), and the question names each one\'s whole scope', () => {
    const p = loaded();
    const one = presets.teamInstall(p, { ...ctx, grants: ['lead#1'] }).steps[0];
    assert.deepEqual(one.define.grants, [{ power: 'review.decide', where: { 'reviewers.checker': 'ok' } }], 'only the scoped one');
    assert.match(one.notes.join(' '), /1 proposed grant not accepted/);
    assert.equal(presets.grantText({ power: 'review.decide', where: { 'reviewers.checker': 'ok' }, minOks: 2, from: ['a', 'b'] }), 'review.decide where {"reviewers.checker":"ok"}, needs 2 oks from a, b');
    assert.notEqual(presets.grantText('review.decide'), presets.grantText({ power: 'review.decide', where: { column: 'Done' } }), 'scoped never reads like unscoped');
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

  it('the base context installs only with --base (or its own yes): --yes alone leaves every agent\'s teaching alone', async () => {
    const { spawnSync } = require('child_process');
    const { startServer, cleanEnv } = require('./helpers');
    const cli = (args, cwd) => { const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'intellagent.js'), ...args], { cwd, env: cleanEnv({}), encoding: 'utf8', input: '', timeout: 60000 }); return { code: r.status, out: r.stdout, err: r.stderr }; };
    const baseOf = (s) => cli(['api', 'GET', '/api/agents/base-context'], s.dir).out;
    for (const withFlag of [false, true]) {
      const p = team({ roles: undefined }); p.team.slots.lead.role = 'builder'; p.team.slots.lead.pickup = 'ready';
      const dir = folder(p, FILES);
      const s = await startServer({ manifest: { auth: { userToken: 'test-human-token' } } }); // the base can be written only with a sign-in token
      try {
        const r = cli(['preset', 'add', dir, '--yes', ...(withFlag ? ['--base'] : []), '--agents', 'lead=rocket'], s.dir);
        assert.equal(r.code, 0, r.err);
        assert.equal(JSON.parse(baseOf(s)).edited, withFlag, withFlag ? '--base installs it' : '--yes alone does not');
        assert.equal(Boolean(presets.readLock(s.dir).presets.crew.parts.base), withFlag);
      } finally { await s.stop(); }
    }
  });

  it('teamDiff: same, update, edited, dropped and gone, with the never-overwrite-edited rule; a changed proposal is reported, not written', () => {
    const p = loaded();
    const wasP = presets.teamParts(p);
    const lock = { parts: { ...wasP }, agents: { lead: 'boss' }, proposals: { lead: [] } };
    const mine = { name: 'boss', ...wasP['slot:lead'], reviewer: undefined };
    const live = (over = {}) => ({ agents: { boss: { ...mine, ...over } }, contexts: { boss: 'Route by areas.' }, base: { text: 'Be brief.', edited: true } });
    const by = (d) => Object.fromEntries(d.steps.map((s) => [s.id, s.state]));
    assert.deepEqual(by(presets.teamDiff(p, lock, live())), { 'slot:lead': 'same', 'context:lead': 'same', base: 'same' });
    // the preset moves on (new model, new page), the board still has what was installed: both can update
    const v2 = presets.load(folder({ ...team({ roles: undefined }), version: '2', team: { ...team({ roles: undefined }).team, slots: { lead: { ...team().team.slots.lead, model: 'opus' } } } }, { ...FILES, 'agent-context/lead.md': 'New page.' }), null);
    const d2 = presets.teamDiff(v2, lock, live());
    assert.deepEqual([by(d2)['slot:lead'], by(d2)['context:lead']], ['update', 'update']);
    assert.deepEqual(d2.proposals, [{ slot: 'lead', name: 'boss', from: [], to: v2.team.slots.lead.grants }], 'the proposed grants differ from the ones the human saw');
    // the human changed the model by hand: kept
    assert.equal(by(presets.teamDiff(v2, lock, live({ model: 'haiku' })))['slot:lead'], 'edited');
    // the agent was removed
    assert.equal(by(presets.teamDiff(v2, lock, { agents: {}, contexts: {}, base: { edited: false } }))['slot:lead'], 'dropped');
    // a slot installed under a name that the preset no longer has
    const none = presets.load(folder({ ...team({ roles: undefined }), team: { slots: {} } }, {}), null);
    assert.deepEqual(by(presets.teamDiff(none, lock, live())), { 'slot:lead': 'gone', 'context:lead': 'gone', base: 'gone' });
  });

  it('preset diff and update follow the team: an update changes only what the human has not edited, and says a proposal changed', async () => {
    const { spawnSync } = require('child_process');
    const { startServer, cleanEnv, USER } = require('./helpers');
    const cli = (args, cwd) => { const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'intellagent.js'), ...args], { cwd, env: cleanEnv({}), encoding: 'utf8', input: '', timeout: 60000 }); return { code: r.status, out: r.stdout, err: r.stderr }; };
    const make = (version, areas, page, grants) => { const p = team({ roles: undefined }); delete p.team.base; p.version = version; Object.assign(p.team.slots.lead, { role: 'builder', pickup: 'ready', areas, grants }); return folder(p, { 'agent-context/lead.md': page }); };
    const s = await startServer();
    try {
      assert.equal(cli(['preset', 'add', make('1', ['docs/'], 'Page one.', ['agents.control']), '--yes', '--agents', 'lead=rocket'], s.dir).code, 0);
      const same = cli(['preset', 'diff', make('1', ['docs/'], 'Page one.', ['agents.control'])], s.dir);
      assert.match(same.out, /up to date/, 'a fresh install reads as the preset has it: ' + same.out);
      const v2 = make('2', ['lib/'], 'Page two.', ['agents.control', 'review.decide']);
      const diff = cli(['preset', 'diff', v2], s.dir);
      assert.match(diff.out, /update\s+slot:lead/);
      assert.match(diff.out, /update\s+context:lead/);
      assert.match(diff.out, /proposal rocket \(slot lead\): .*was agents\.control, now agents\.control, review\.decide/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'agents.json'), 'utf8')).agents.rocket.grants, undefined, 'a proposal is never written');
      const up = cli(['preset', 'update', v2, '--accept', 'all'], s.dir);
      assert.equal(up.code, 0, up.err);
      const a = JSON.parse(fs.readFileSync(path.join(s.dir, 'agents.json'), 'utf8')).agents.rocket;
      assert.deepEqual(a.areas, ['lib/']);
      assert.match(JSON.stringify(a.contextItems), /Page two\./);
      assert.ok(a.probation, 'an update does not accept the agent');
      // the human edits the areas; a v3 that changes them again is "edited" and kept
      await s.ok('PATCH', '/api/agents/rocket', { areas: ['mine/'] }, USER);
      const v3 = make('3', ['theirs/'], 'Page two.', ['agents.control', 'review.decide']);
      assert.match(cli(['preset', 'diff', v3], s.dir).out, /edited\s+slot:lead\s+\(yours, kept\)/);
      assert.equal(cli(['preset', 'update', v3, '--accept', 'slot:lead'], s.dir).code, 1, 'an edited piece cannot be taken');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, 'agents.json'), 'utf8')).agents.rocket.areas, ['mine/']);
    } finally { await s.stop(); }
  });

  it('record keeps the agent names across later records', () => {
    const dir = tmp('rec2');
    const p = loaded();
    presets.record(dir, p, ['slot:lead'], { lead: 'boss' });
    presets.record(dir, p, []); // a board-only update
    assert.deepEqual(presets.readLock(dir).presets.crew.agents, { lead: 'boss' });
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

describe('the shipped software-team preset (INT-304)', () => {
  const p = presets.load(path.join(__dirname, '..', 'presets', 'software-team'), null);
  const slots = p.team.slots;

  it('loads and validates, extending software, with one page per slot and no agent names', () => {
    assert.equal(p.extends, 'software'); // load above already validated it and read every page (it throws BAD_PRESET otherwise)
    assert.deepEqual(Object.keys(slots), ['coordinator', 'senior-a', 'senior-b', 'mid', 'junior', 'designer', 'code-reviewer', 'design-reviewer', 'lander', 'lead']);
    for (const k of Object.keys(slots)) assert.ok(p.team.files[k], `slot ${k} has a context page`);
    assert.doesNotMatch(JSON.stringify(p.team.files), /\b(rocket|gamora|yondu|kraglin|nebula|stakar|drax)\b/i, 'slots, not our names');
  });

  it('proposes the playbook grants only to the slots that need them, and leaves the areas to the setup skill', () => {
    const grants = Object.fromEntries(Object.entries(slots).filter(([, s]) => s.grants).map(([k, s]) => [k, s.grants]));
    assert.deepEqual(grants, { coordinator: ['agents.control'], lander: ['work.land'], lead: [{ power: 'review.decide', minOks: 'all' }] });
    assert.deepEqual([slots['senior-a'].areas, slots['senior-b'].areas], [[], []]);
    assert.equal(slots.lander.idleAlarm, true);
  });

  it('the lander page keeps its duties and the coordinator page its five routing rules', () => {
    assert.match(p.team.files.lander, /hunks, never whole files/);
    assert.match(p.team.files.lander, /Push every landing/);
    assert.match(p.team.files.lander, /revert of the revert/);
    assert.equal((p.team.files.coordinator.match(/^\d\. /gm) || []).length, 5);
  });
});
