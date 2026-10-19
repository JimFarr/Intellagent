'use strict';
// Area notes (INT-403): what runs learn about the code, kept by area for whoever works there next.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const NOTES = require('../lib/notes');
const { startServer, USER } = require('./helpers');

const B = '/api/boards/main';
const agent = (name) => ({ kind: 'agent', name });
const human = { kind: 'user', name: 'James' };
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
  let i = 0;
  const fail = (status, message, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
  return NOTES.createNotes({ file: path.join(dir, 'notes.json'), fail, now: () => new Date(Date.parse('2026-10-20T09:00:00Z') + i * 1000).toISOString(), rid: (p) => `${p}_${++i}` });
}

describe('area note rules', () => {
  it('an area is a project path: relative, forward slashes; nothing outside the project', () => {
    assert.equal(NOTES.areaOf('.\\lib\\alerts\\'), 'lib/alerts/');
    assert.equal(NOTES.areaOf('server.js'), 'server.js');
    assert.equal(NOTES.areaOf('.'), '');
    assert.equal(NOTES.areaOf('../secrets'), null);
    assert.equal(NOTES.areaOf('C:/Windows'), null);
    assert.equal(NOTES.areaOf('/etc/passwd'), null);
  });
  it('a folder note covers what is in it, and asking about a folder finds the notes inside it', () => {
    assert.ok(NOTES.covers('lib/alerts/', 'lib/alerts/work.js'));
    assert.ok(NOTES.covers('lib/alerts/work.js', 'lib/alerts/'));
    assert.ok(NOTES.covers('', 'anything.js'), 'a note on the whole project');
    assert.ok(!NOTES.covers('lib/alerts/work.js', 'lib/alerts/stuck.js'));
    assert.ok(!NOTES.covers('lib/al', 'lib/alerts/work.js'), 'a prefix that is not a folder covers nothing');
  });
  it('finds the paths a ticket names', () => {
    assert.deepEqual(NOTES.pathsIn('Fix `lib/alerts/work.js` and server.js; see docs/ (not https://x.io/a/b)').sort(), ['docs/', 'lib/alerts/work.js', 'server.js']);
  });
  it('reads a review\'s learned part: "area: lesson" lines, a list, or none', () => {
    assert.deepEqual(NOTES.parseLearned('- lib/alerts/work.js: the TAG table decides when work is new\n- `server.js`: tx() rolls back journeys too').notes,
      [{ area: 'lib/alerts/work.js', text: 'the TAG table decides when work is new' }, { area: 'server.js', text: 'tx() rolls back journeys too' }]);
    assert.deepEqual(NOTES.parseLearned('none'), { notes: [], none: true });
    assert.deepEqual(NOTES.parseLearned('it was fun').bad, ['it was fun']);
    assert.equal(NOTES.parseLearned([{ area: 'a/', text: 'b' }]).notes.length, 1);
  });
});

describe('the store', () => {
  it('keeps notes by area, most confirmed first; the same lesson again counts as a confirmation', () => {
    const s = store();
    const a = s.add({ area: 'lib/alerts/', text: 'work.js and stuck.js share NOT_OWNING', from: 'int-1' }, agent('groot')).note;
    s.add({ area: 'lib/alerts/work.js', text: 'TAG decides when work is new again' }, agent('rocket'));
    assert.equal(a.from, 'INT-1');
    const again = s.add({ area: 'lib/alerts/', text: 'Work.js and stuck.js share NOT_OWNING' }, agent('nebula'));
    assert.equal(again.duplicate, true);
    assert.deepEqual(s.forPaths(['lib/alerts/work.js']).map((n) => n.id), [a.id, 'n_2'], 'confirmed first');
    assert.deepEqual(s.forPaths(['public/app.js']), []);
    assert.equal(s.forPaths(['public/'], { from: 'INT-1' }).length, 1, 'and the ticket\'s own notes');
  });
  it('caps each area; what is dropped is retired, not lost', () => {
    const s = store();
    for (let i = 0; i < NOTES.PER_AREA + 2; i++) s.add({ area: 'x/', text: `lesson ${i}` }, agent('groot'));
    assert.equal(s.list({ path: 'x/' }).length, NOTES.PER_AREA);
    assert.equal(s.list({ retired: true }).length, 2);
    assert.ok(!s.list({ path: 'x/' }).some((n) => n.text === 'lesson 0'), 'the oldest went');
  });
  it('who may do what: the author or the human edits, anyone confirms (not its author) or retires with why, the human removes', () => {
    const s = store();
    const n = s.add({ area: 'a.js', text: 'one' }, agent('groot')).note;
    assert.throws(() => s.edit(n.id, { text: 'two' }, agent('rocket')), { code: 'FORBIDDEN' });
    assert.equal(s.edit(n.id, { text: 'two' }, agent('groot')).history.length, 1);
    assert.throws(() => s.confirm(n.id, agent('groot')), { code: 'OWN_WORK' });
    assert.deepEqual(s.confirm(n.id, agent('rocket')).confirmedBy, ['rocket']);
    assert.throws(() => s.remove(n.id, agent('rocket')), { code: 'HUMAN_ONLY' });
    assert.throws(() => s.retire(n.id, {}, agent('rocket')), { status: 400 });
    assert.equal(s.retire(n.id, { why: 'a.js was deleted' }, agent('rocket')).retiredBy, 'rocket');
    assert.equal(s.list().length, 0);
    const m = s.add({ area: 'b.js', text: 'three' }, agent('groot')).note;
    s.remove(m.id, human);
    assert.throws(() => s.add({ area: 'b.js', text: 'x'.repeat(NOTES.TEXT_MAX + 1) }, agent('groot')), { status: 413 });
    assert.throws(() => s.add({ area: '../b', text: 'x' }, agent('groot')), { status: 400 });
  });
});

describe('area notes on a real board', () => {
  const TEAM = { agents: { groot: { role: 'builder', enabled: false, areas: ['lib/alerts/'] }, rocket: { role: 'builder', enabled: false } } };
  const as = (name) => ({ agent: name });
  it('a review keeps what was learned; the next agent gets it at start and in its brief; nothing learned is warned about', async () => {
    const s = await startServer({ agents: TEAM });
    try {
      const t1 = await s.ok('POST', `${B}/items`, { title: 'Tidy lib/alerts/work.js', column: 'Ready' }, USER);
      await s.ok('POST', `${B}/items/${t1.id}/start`, {}, as('groot'));
      const r1 = await s.ok('POST', `${B}/items/${t1.id}/review`, { changed: 'x', why: 'y', verify: 'z', evidence: 'tests pass' }, as('groot'));
      assert.ok(r1.warnings.some((w) => /^Nothing learned/.test(w)), 'nothing learned: warned');
      const r2 = await s.ok('POST', `${B}/items/${t1.id}/review`, { changed: 'x', why: 'y', verify: 'z', evidence: 'tests pass',
        learned: 'lib/alerts/work.js: the TAG table decides when work is new again\nthis line has no area' }, as('groot'));
      assert.equal(r2.notes.length, 1);
      assert.ok(r2.warnings.some((w) => /^Not kept as area notes/.test(w)));
      assert.match(r2.comments.at(-1).body, /\*\*Learned for next time\*\*\nlib\/alerts\/work\.js: the TAG table/);
      // another agent starting a ticket that names the file gets the note
      const t2 = await s.ok('POST', `${B}/items`, { title: 'Speed up `lib/alerts/work.js`', column: 'Ready' }, USER);
      const st = await s.ok('POST', `${B}/items/${t2.id}/start`, {}, as('rocket'));
      assert.deepEqual(st.notes.map((n) => [n.area, n.by, n.from]), [['lib/alerts/work.js', 'groot', t1.id]]);
      // groot owns lib/alerts/: its brief lists the note
      const brief = (await s.api('GET', `${B}/brief`, undefined, as('groot'))).body;
      assert.match(brief, /## Area notes[\s\S]*On your areas:[\s\S]*the TAG table decides/);
      // confirm, look up, retire
      await s.ok('POST', `/api/notes/${r2.notes[0]}/confirm`, {}, as('rocket'));
      assert.deepEqual((await s.ok('GET', '/api/notes?path=lib/alerts/')).notes[0].confirmedBy, ['rocket']);
      assert.equal((await s.api('DELETE', `/api/notes/${r2.notes[0]}`, undefined, as('rocket'))).body.code, 'HUMAN_ONLY');
      await s.ok('POST', `/api/notes/${r2.notes[0]}/retire`, { why: 'TAG moved' }, as('rocket'));
      assert.equal((await s.ok('GET', '/api/notes')).count, 0);
      // "none" is an answer: no warning
      const r3 = await s.ok('POST', `${B}/items/${t2.id}/review`, { changed: 'x', why: 'y', verify: 'z', evidence: 'tests pass', learned: 'none' }, as('rocket'));
      assert.ok(!(r3.warnings || []).some((w) => /learned/i.test(w)));
    } finally { await s.stop(); }
  });
});
