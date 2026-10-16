'use strict';
// Presets: packages of board. The library (lib/presets.js) and the CLI that installs them (init --preset, preset …).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const presets = require('../lib/presets');
const { startServer, cleanEnv, USER } = require('./helpers');

const ROOT = path.join(__dirname, '..');
function cli(args, { cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'intellagent.js'), ...args], { cwd, env: cleanEnv(env), encoding: 'utf8', input: '', timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const board = async (s) => (await s.ok('GET', '/api/boards/main', undefined, USER)).board;
const tmp = (what) => fs.mkdtempSync(path.join(os.tmpdir(), `ia-${what}-`));
function writePreset(dir, p) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'preset.json'), JSON.stringify(p, null, 2));
  return dir;
}
// a small preset of our own: two columns, one field, one ticket template, one rule
const mini = (version, extra = {}) => ({
  name: 'mini', version, label: 'Mini',
  board: {
    columns: [{ name: 'Todo', color: '#111111', flags: { pickup: true, allowCreate: true } }, { name: 'Shipped', color: '#222222', flags: { humanOnlyIn: true } }],
    schema: { fields: [{ key: 'size', label: 'Size', type: 'enum', options: ['s', 'm', 'l'] }] },
    ticketTemplates: [{ key: 'task', label: 'Task', type: 'task' }],
    directives: '- keep it small',
    ...extra,
  },
});

describe('presets: the library', () => {
  it('the built-in templates and the shipped stories preset are all presets', () => {
    const all = presets.all(null);
    for (const n of ['default', 'simple', 'empty', 'software', 'research', 'ops']) assert.equal(all[n].source, 'built-in', n);
    assert.equal(all.stories.source, 'shipped');
    assert.equal(all.stories.broken, undefined);
    assert.ok(all.stories.board.columns.length >= 4);
    assert.doesNotMatch(JSON.stringify(all.stories.board.columns), /Review|Triage|In Progress/, 'nothing in stories is about code');
  });
  it('validate says what is wrong, in words', () => {
    assert.match(presets.validate({ name: 'Bad Name', version: '1', board: {} }), /name must be lowercase/);
    assert.match(presets.validate({ name: 'ok', version: 'one', board: {} }), /version/);
    assert.match(presets.validate({ name: 'ok', version: '1' }), /board is required/);
    assert.match(presets.validate({ name: 'ok', version: '1', board: { columns: [{ icon: 'x' }] } }), /columns/);
    assert.equal(presets.validate(mini('1')), null);
  });
  it('extends folds the parent in: the child wins by name, new pieces follow, rules join', () => {
    const dir = tmp('ext');
    writePreset(path.join(dir, 'presets', 'child'), { name: 'child', version: '1', extends: 'simple', board: {
      columns: [{ name: 'Doing', color: '#abcdef' }, { name: 'Blocked' }], directives: '- child rule' } });
    const p = presets.resolve('child', dir);
    assert.deepEqual(p.board.columns.map((c) => c.name), ['To Do', 'Doing', 'Done', 'Blocked']);
    assert.equal(p.board.columns.find((c) => c.name === 'Doing').color, '#abcdef');
    assert.equal(p.board.directives, '- child rule');
  });
  it('a preset that extends itself, a missing parent and a broken file are refused with a reason', () => {
    const dir = tmp('bad');
    writePreset(path.join(dir, 'presets', 'a'), { name: 'a', version: '1', extends: 'b', board: {} });
    writePreset(path.join(dir, 'presets', 'b'), { name: 'b', version: '1', extends: 'a', board: {} });
    assert.throws(() => presets.resolve('a', dir), /extends itself/);
    writePreset(path.join(dir, 'presets', 'c'), { name: 'c', version: '1', extends: 'nope', board: {} });
    assert.throws(() => presets.resolve('c', dir), /No preset "nope"/);
    writePreset(path.join(dir, 'presets', 'd'), { name: 'd', version: 'x', board: {} });
    assert.throws(() => presets.resolve('d', dir), /not usable: version/);
    assert.throws(() => presets.resolve('missing', dir), (e) => e.code === 'NOT_FOUND');
  });
  it('powers lists what a preset gives it power over, so the prompt can show it before anything is written', () => {
    const list = presets.powers(presets.resolve('software', null));
    assert.ok(list.some((x) => /column "Done": humanOnlyIn/.test(x)));
    assert.ok(list.some((x) => /field "ci": only agents and the API can change it/.test(x)));
    assert.ok(list.some((x) => /board rules/.test(x)));
    assert.deepEqual(presets.powers({ board: { columns: [{ name: 'A' }] } }), []);
  });
  it('powers names every column flag and built-in field setting, so the prompt never says "no powers" over a changed rule', () => {
    const list = presets.powers({ board: {
      columns: [{ name: 'A', flags: { allowMoveOut: false, allowCreate: false, review: true, sleeping: true, pickup: true, working: true, shiny: true } }],
      schema: { builtins: { blockedBy: { ui: 'hidden' }, type: { label: 'Kind' } } },
    } });
    const text = list.join('\n');
    for (const k of ['allowMoveOut off', 'allowCreate off', 'review', 'sleeping', 'pickup', 'working', 'shiny']) assert.match(text, new RegExp(`column "A": ${k}`), k);
    assert.match(text, /built-in field "blockedBy": ui "hidden" \(changes who can edit it\)/);
    assert.match(text, /built-in field "type": label "Kind"/);
  });
  it('built-in field settings are a piece of the preset: builtin:<key>', () => {
    const p = presets.resolve('stories', null);
    assert.deepEqual(presets.parts(p)['builtin:type'], { label: 'Kind' });
    const state = (live) => Object.fromEntries(presets.plan(p, undefined, live).map((s) => [s.id, s.state]))['builtin:type'];
    assert.equal(state({ schema: { builtins: { type: { ui: 'edit', stub: true, label: 'Type' } } } }), 'new', 'the default is not an edit');
    const lock = { 'builtin:type': { label: 'Kind' } };
    assert.equal(Object.fromEntries(presets.plan(p, lock, { schema: { builtins: { type: { label: 'Mine' } } } }).map((s) => [s.id, s.state]))['builtin:type'], 'edited', 'once installed, a change by the human is kept');
    assert.equal(state({ schema: { builtins: { type: { ui: 'edit', label: 'Kind' } } } }), 'same');
    assert.equal(state({ schema: {} }), 'new');
  });
  it('plan: new, same, update, edited, dropped and gone are told apart, and an edit is never an update', () => {
    const v1 = presets.parts({ board: mini('1').board });
    const next = mini('2');
    next.board.columns[0].color = '#999999';            // changed upstream, not touched by the human → update
    next.board.columns[1].color = '#888888';            // changed upstream, but the human edited it → edited
    next.board.ticketTemplates = [];                    // dropped upstream → gone
    next.board.schema.fields.push({ key: 'extra', label: 'Extra', type: 'text' }); // new
    const live = {
      columns: [{ name: 'Todo', color: '#111111', flags: { pickup: true, allowCreate: true }, id: 'todo', itemIds: [] }, { name: 'Shipped', color: '#5555ff', flags: { humanOnlyIn: true } }],
      schema: { fields: [{ key: 'size', label: 'Size', type: 'enum', options: [{ value: 's' }, { value: 'm' }, { value: 'l' }] }] },
      ticketTemplates: [{ key: 'task', label: 'Task', type: 'task' }], directives: '- keep it small',
    };
    const state = Object.fromEntries(presets.plan({ ...next, board: next.board }, v1, live).map((s) => [s.id, s.state]));
    assert.equal(state['column:Todo'], 'update');
    assert.equal(state['column:Shipped'], 'edited');
    assert.equal(state['field:extra'], 'new');
    assert.equal(state['ticket-template:task'], 'gone');
    assert.equal(state.directives, 'same');
  });
});

describe('presets: init --preset', () => {
  it('writes the preset into the new board folder and lists its powers before it writes anything', () => {
    const dir = tmp('init-preset');
    const no = cli(['init', '--preset', 'stories', '--no-start', '--no-open', '--no-mcp', '--no-claude'], { cwd: dir });
    assert.equal(no.code, 1, 'no terminal and no --yes: it will not write');
    assert.match(no.err, /error 400 BAD_REQUEST.*hint: add --yes/);
    assert.equal(fs.existsSync(path.join(dir, '.intellagent')), false, 'nothing was written');
    const yes = cli(['init', '--preset', 'stories', '--yes', '--no-start', '--no-open', '--no-mcp', '--no-claude'], { cwd: dir });
    assert.equal(yes.code, 0, yes.err);
    assert.match(yes.out, /stories@1\.0 brings/);
    assert.match(yes.out, /column "Published": humanOnlyIn/);
    const m = JSON.parse(fs.readFileSync(path.join(dir, '.intellagent', 'intellagent.manifest.json'), 'utf8'));
    assert.equal(m.template, 'stories');
    const lock = JSON.parse(fs.readFileSync(path.join(dir, '.intellagent', 'presets.json'), 'utf8'));
    assert.equal(lock.presets.stories.version, '1.0');
    assert.ok(lock.presets.stories.parts['column:Drafting']);
  });
  it('--preset takes a folder too: the board keeps its own copy; an unknown name and a broken folder say why', () => {
    const dir = tmp('init-folder');
    const src = writePreset(path.join(tmp('src'), 'mine'), mini('1'));
    const r = cli(['init', '--preset', src, '--yes', '--no-start', '--no-open', '--no-mcp', '--no-claude'], { cwd: dir });
    assert.equal(r.code, 0, r.err);
    assert.ok(fs.existsSync(path.join(dir, '.intellagent', 'presets', 'mini', 'preset.json')));
    const bad = cli(['init', '--preset', 'nope', '--yes', '--no-start', '--no-open', '--no-mcp', '--no-claude'], { cwd: tmp('init-bad') });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /error 404 NOT_FOUND: No preset "nope".*hint: intellagent preset list/);
    const broken = writePreset(path.join(tmp('src'), 'broken'), { name: 'broken', version: 'x', board: {} });
    const b2 = cli(['init', '--preset', broken, '--yes', '--no-start'], { cwd: tmp('init-bad2') });
    assert.equal(b2.code, 1);
    assert.match(b2.err, /BAD_PRESET|version/);
    assert.equal(cli(['init', '--preset', 'stories', '--template', 'ops', '--yes', '--no-start'], { cwd: tmp('init-both') }).code, 1);
  });
  it('a board started from the shipped preset has its columns, fields and rules', async () => {
    const s = await startServer({ manifest: { template: 'stories' } });
    try {
      const b = await board(s);
      assert.deepEqual(b.columns.map((c) => c.name), ['Ideas', 'Outlined', 'Drafting', 'Editing', 'Published']);
      assert.ok(b.schema.fields.some((f) => f.key === 'pov'));
      assert.match(b.directives, /Published\*\* is the human's/);
      assert.ok((await s.ok('GET', '/api/templates')).some((t) => t.key === 'stories'), 'GET /api/templates lists presets');
    } finally { await s.stop(); }
  });
});

describe('presets: preset add, diff and update on a board that exists', () => {
  it('list shows built-in, shipped and added presets, and what is installed', async () => {
    const s = await startServer();
    try {
      const before = cli(['preset', 'list'], { cwd: s.dir });
      assert.equal(before.code, 0, before.err);
      assert.match(before.out, /software\s+1\s+Software project\s+\[built-in\]/);
      assert.match(before.out, /stories\s+1\.0\s+Writing stories\s+\[shipped\]/);
      assert.equal(cli(['preset', 'add', 'stories', '--yes'], { cwd: s.dir }).code, 0);
      assert.match(cli(['preset', 'list'], { cwd: s.dir }).out, /stories .*\[shipped\]\s+installed 1\.0/);
    } finally { await s.stop(); }
  });
  it('add lists the powers and asks first; with --yes it adds only what is new and keeps what the board already has', async () => {
    const s = await startServer();
    try {
      await s.ok('POST', '/api/boards/main/columns', { name: 'Todo', color: '#abcabc' }, USER); // already there, differently
      const dir = writePreset(path.join(tmp('mini'), 'mini'), mini('1'));
      const no = cli(['preset', 'add', dir], { cwd: s.dir });
      assert.equal(no.code, 1);
      assert.match(no.err, /hint: add --yes/);
      assert.match(no.out, /mini@1 brings/);
      assert.match(no.out, /column "Shipped": humanOnlyIn/);
      assert.match(no.out, /edited\s+column:Todo\s+\(yours, kept\)/);
      assert.equal((await board(s)).columns.some((c) => c.name === 'Shipped'), false, 'nothing was added');
      const yes = cli(['preset', 'add', dir, '--yes'], { cwd: s.dir });
      assert.equal(yes.code, 0, yes.err);
      const b = await board(s);
      assert.equal(b.columns.find((c) => c.name === 'Todo').color, '#abcabc', 'the human\'s own column was not overwritten');
      assert.ok(b.columns.some((c) => c.name === 'Shipped'));
      assert.ok(b.schema.fields.some((f) => f.key === 'size'));
      assert.ok(b.ticketTemplates.some((t) => t.key === 'task'));
      assert.equal(b.directives, '- keep it small');
      assert.ok(fs.existsSync(path.join(s.dir, 'presets', 'mini', 'preset.json')), 'the board keeps a copy');
      const lock = JSON.parse(fs.readFileSync(path.join(s.dir, 'presets.json'), 'utf8')).presets.mini;
      assert.ok(lock.parts['column:Shipped'] && !lock.parts['column:Todo'], 'only what was installed is recorded; the edited column is not');
      const again = cli(['preset', 'add', 'mini', '--yes'], { cwd: s.dir });
      assert.equal(again.code, 1);
      assert.match(again.err, /error 409 CONFLICT: mini@1 is already on this board.*hint: intellagent preset diff mini/);
    } finally { await s.stop(); }
  });
  it('the setup skill offers presets and AGENTS.md says the human-only check of the CLI is a speed bump', () => {
    const skill = fs.readFileSync(path.join(ROOT, 'skills', 'intellagent-setup', 'SKILL.md'), 'utf8');
    assert.match(skill, /intellagent preset list/);
    assert.match(skill, /init --preset <name\|folder>/);
    assert.match(skill, /without `--yes` once/);
    const guide = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
    assert.match(guide, /init --preset <name\|folder>/);
    assert.match(guide, /speed bump, not a wall: the CLI trusts `INTELLAGENT_AGENT`/);
  });
  it('init --preset and init then preset add give the same built-in fields; diff of an installed preset says it is up to date', async () => {
    const s = await startServer();
    const t = await startServer({ manifest: { template: 'stories' } });
    try {
      const add = cli(['preset', 'add', 'stories', '--yes'], { cwd: s.dir });
      assert.equal(add.code, 0, add.err);
      assert.match(add.out, /built-in field "type": label "Kind"/, 'the prompt lists it');
      const a = (await board(s)).schema.builtins, b = (await board(t)).schema.builtins;
      assert.equal(a.type.label, 'Kind');
      assert.deepEqual(a, b, 'the same preset gives the same board either way');
      const diff = cli(['preset', 'diff', 'stories'], { cwd: s.dir });
      assert.equal(diff.code, 0, diff.err);
      assert.match(diff.out, /up to date/);
      assert.match(cli(['preset', 'diff'], { cwd: s.dir }).err, /Usage: intellagent preset diff <name\|folder>/);
    } finally { await s.stop(); await t.stop(); }
  });
  it('update shows a new version as a diff and takes it piece by piece; what the human edited is never overwritten', async () => {
    const s = await startServer();
    try {
      const v1 = writePreset(path.join(tmp('v1'), 'mini'), mini('1'));
      assert.equal(cli(['preset', 'add', v1, '--yes'], { cwd: s.dir }).code, 0);
      // the human recolours Shipped; upstream recolours both columns, adds a field, and changes the rule
      await s.ok('PATCH', '/api/boards/main/columns/Shipped', { color: '#00ff00' }, USER);
      const v2 = mini('2');
      v2.board.columns[0].color = '#333333';
      v2.board.columns[1].color = '#444444';
      v2.board.schema.fields.push({ key: 'owner', label: 'Owner', type: 'text' });
      v2.board.directives = '- keep it small\n- and tested';
      const dir2 = writePreset(path.join(tmp('v2'), 'mini'), v2);

      const diff = cli(['preset', 'diff', dir2], { cwd: s.dir });
      assert.equal(diff.code, 0, diff.err);
      assert.match(diff.out, /installed 1, available 2/);
      assert.match(diff.out, /update\s+column:Todo/);
      assert.match(diff.out, /edited\s+column:Shipped\s+\(yours, kept\)/);
      assert.match(diff.out, /new\s+field:owner/);
      assert.match(diff.out, /update\s+directives/);

      const plain = cli(['preset', 'update', dir2], { cwd: s.dir });
      assert.match(plain.out, /Accept them with: intellagent preset update/);
      let b = await board(s);
      assert.equal(b.columns.find((c) => c.name === 'Todo').color, '#111111', 'nothing changes without --accept');

      const one = cli(['preset', 'update', dir2, '--accept', 'column:Todo,field:owner'], { cwd: s.dir });
      assert.equal(one.code, 0, one.err);
      b = await board(s);
      assert.equal(b.columns.find((c) => c.name === 'Todo').color, '#333333');
      assert.ok(b.schema.fields.some((f) => f.key === 'owner'));
      assert.equal(b.directives, '- keep it small', 'the piece that was not accepted is untouched');

      const edited = cli(['preset', 'update', dir2, '--accept', 'column:Shipped'], { cwd: s.dir });
      assert.equal(edited.code, 1);
      assert.match(edited.err, /error 400 BAD_REQUEST: cannot take column:Shipped.*edited pieces are yours/);

      assert.equal(cli(['preset', 'update', dir2, '--accept', 'all'], { cwd: s.dir }).code, 0);
      b = await board(s);
      assert.equal(b.directives, '- keep it small\n- and tested');
      assert.equal(b.columns.find((c) => c.name === 'Shipped').color, '#00ff00', 'the human\'s colour survived every update');
      assert.match(cli(['preset', 'list'], { cwd: s.dir }).out, /installed 2/);
    } finally { await s.stop(); }
  });
  it('intellagent help preset and the command list explain them', () => {
    const h = cli(['help', 'preset']);
    assert.equal(h.code, 0, h.err);
    assert.match(h.out, /preset list.*add.*diff.*update/);
    assert.match(cli(['help']).out, /init --preset NAME\|FOLDER/);
  });
  it('it is the human\'s: an agent is refused, and an unknown preset or a preset that is not installed has a code and a hint', async () => {
    const s = await startServer();
    try {
      const r = cli(['preset', 'add', 'stories', '--yes'], { cwd: s.dir, env: { INTELLAGENT_AGENT: 'ada' } });
      assert.equal(r.code, 1);
      assert.match(r.err, /error 403 HUMAN_ONLY.*hint: ask the human/);
      assert.equal(cli(['preset', 'list'], { cwd: s.dir, env: { INTELLAGENT_AGENT: 'ada' } }).code, 0, 'reading the list is open');
      const none = cli(['preset', 'diff', 'stories'], { cwd: s.dir });
      assert.equal(none.code, 1);
      assert.match(none.err, /error 404 NOT_FOUND: stories is not installed.*hint: intellagent preset add stories/);
      assert.match(cli(['preset', 'add', 'nope', '--yes'], { cwd: s.dir }).err, /error 404 NOT_FOUND.*hint: intellagent preset list/);
    } finally { await s.stop(); }
  });
});
