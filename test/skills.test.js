// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Skills per agent (INT-237): SKILL.md files the human attaches; listed in the prompt, copied into the agent's own worktree.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { startServer, USER } = require('./helpers');
const skills = require('../lib/agents/skills');

const patch = (s, name, body, who = USER) => s.api('PATCH', `/api/agents/${name}`, body, who);
const SKILL = '---\nname: security-review\ndescription: Review auth changes for holes\n---\nCheck every token path.\n';

function project(dir) {
  fs.mkdirSync(path.join(dir, 'skills', 'sec'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'sec', 'SKILL.md'), SKILL);
  fs.writeFileSync(path.join(dir, 'skills', 'sec', 'checklist.md'), 'one\n');
}

describe('skills (INT-237)', () => {
  it('attach by SKILL.md or folder: name and description are read from the file, the list is the human\'s, bad paths are refused with a hint', async () => {
    const s = await startServer({ agents: { agents: { dev: { role: 'builder', enabled: false }, manager: { role: 'coordinator', enabled: false, grants: ['agents.manage'] } } } });
    try {
      project(s.dir);
      const r = await patch(s, 'dev', { skills: [{ path: 'skills/sec' }] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      let list = await s.ok('GET', '/api/agents/dev/skills', undefined, USER);
      assert.deepEqual(list.skills.map(({ id, name, description, on }) => ({ id, name, description, on })), [{ id: 'sec', name: 'security-review', description: 'Review auth changes for holes', on: true }]);
      // a file path works too, an edit to the file shows at once, and it is in the agent's prompt
      assert.equal((await patch(s, 'dev', { skills: [{ path: 'skills/sec/SKILL.md', id: 'sec', on: true }] })).status, 200);
      fs.writeFileSync(path.join(s.dir, 'skills', 'sec', 'SKILL.md'), SKILL.replace('Review auth changes for holes', 'Review login code'));
      const prev = await s.ok('GET', '/api/agents/dev/preview', undefined, USER);
      assert.match(prev.prompt, /\*\*security-review\*\* — Review login code \(`skills\/sec\/SKILL\.md`\)/);
      assert.ok(!prev.prompt.includes('Check every token path'), 'only name and description are in the prompt');
      // switched off: not in the prompt
      await patch(s, 'dev', { skills: [{ path: 'skills/sec', id: 'sec', on: false }] });
      assert.ok(!(await s.ok('GET', '/api/agents/dev/preview', undefined, USER)).prompt.includes('security-review'));
      // the board's own files, outside the project, and a folder with no SKILL.md
      for (const p of ['local.json', 'agents.json', 'agent-context/dev.md', 'data/board.json','../outside', path.join(os.tmpdir(), 'x')]) {
        const bad = await patch(s, 'dev', { skills: [{ path: p }] });
        assert.equal(bad.status, 403, `${p}: ${JSON.stringify(bad.body)}`);
        assert.equal(bad.body.code, 'FORBIDDEN');
        assert.ok(bad.body.hint);
      }
      const none = await patch(s, 'dev', { skills: [{ path: 'skills' }] });
      assert.equal(none.status, 400);
      assert.equal(none.body.code, 'BAD_REQUEST');
      assert.ok(none.body.hint);
      assert.equal((await patch(s, 'dev', { skills: 'x' })).status, 400);
      // an agent manager may not attach, change or clear them
      const m = await patch(s, 'dev', { skills: [{ path: 'skills/sec' }] }, { agent: 'manager' });
      assert.equal(m.status, 403, JSON.stringify(m.body));
      assert.equal(m.body.code, 'HUMAN_ONLY');
      assert.ok(m.body.hint);
      // kept in the history; null clears
      const hist = (await s.ok('GET', '/api/agents/dev')).changes;
      assert.ok(hist.some((c) => c.changes.skills), 'the change is in the agent\'s history');
      await patch(s, 'dev', { skills: null });
      assert.equal((await s.ok('GET', '/api/agents/dev')).skills, null);
    } finally { await s.stop(); }
  });

  it('deliver: copies the folder into the worktree, leaves nothing to commit, removes only what the board wrote, and a changed list changes the signature', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    try {
      const src = path.join(tmp, 'src');
      const wt = path.join(tmp, 'wt');
      fs.mkdirSync(path.join(src, 'sec'), { recursive: true });
      fs.mkdirSync(wt, { recursive: true });
      fs.writeFileSync(path.join(src, 'sec', 'SKILL.md'), SKILL);
      fs.writeFileSync(path.join(src, 'sec', 'checklist.md'), 'one\n');
      fs.writeFileSync(path.join(src, 'sec', 'agents.json'), '{}');
      const ok = (checkPath) => ({ ok: true, abs: path.join(src, checkPath) });
      const res = skills.resolve([{ id: 'sec', path: 'sec' }, { id: 'off', path: 'sec', on: false }], ok);
      assert.deepEqual(res.map((r) => r.id), ['sec'], 'a switched-off skill is not resolved');
      assert.deepEqual(skills.deliver(wt, res), []);
      const to = path.join(wt, '.claude', 'skills', 'sec');
      assert.equal(fs.readFileSync(path.join(to, 'SKILL.md'), 'utf8'), SKILL);
      assert.ok(fs.existsSync(path.join(to, 'checklist.md')), 'files beside the SKILL.md come too');
      assert.ok(!fs.existsSync(path.join(to, 'agents.json')), 'the board\'s own file names are never copied');
      assert.equal(fs.readFileSync(path.join(to, '.gitignore'), 'utf8'), '*\n');
      // a folder of the project's own is never touched; an old one of the board's goes when the skill is gone
      fs.mkdirSync(path.join(wt, '.claude', 'skills', 'theirs'), { recursive: true });
      fs.writeFileSync(path.join(wt, '.claude', 'skills', 'theirs', 'SKILL.md'), 'mine');
      const sig = skills.signature(res);
      assert.deepEqual(skills.deliver(wt, []), []);
      assert.ok(!fs.existsSync(to), 'a skill the agent no longer has is removed');
      assert.ok(fs.existsSync(path.join(wt, '.claude', 'skills', 'theirs', 'SKILL.md')));
      assert.notEqual(skills.signature([]), sig);
      // an edit to a file of the skill changes the signature too, so a warm session is replaced
      fs.appendFileSync(path.join(src, 'sec', 'checklist.md'), 'two\n');
      assert.notEqual(skills.signature(res), sig, 'edited content means a new session');
      // an id that would overwrite the project's own folder is reported, not written
      const clash = skills.deliver(wt, [{ ...res[0], id: 'theirs' }]);
      assert.match(clash[0], /not the board's/);
      assert.equal(fs.readFileSync(path.join(wt, '.claude', 'skills', 'theirs', 'SKILL.md'), 'utf8'), 'mine');
      // a skill that can't be read is reported and the rest still go
      const bad = skills.resolve([{ id: 'gone', path: 'nope' }, { id: 'sec', path: 'sec' }], ok);
      assert.match(skills.deliver(wt, bad)[0], /gone/);
      assert.ok(fs.existsSync(path.join(to, 'SKILL.md')));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('deliver: a failed copy is retried next run; board folders are not copied; ids of dots are refused', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    try {
      const src = path.join(tmp, 'src');
      const wt = path.join(tmp, 'wt');
      fs.mkdirSync(path.join(src, 'data'), { recursive: true });
      fs.mkdirSync(path.join(src, 'agent-context'), { recursive: true });
      fs.mkdirSync(wt, { recursive: true });
      fs.writeFileSync(path.join(src, 'SKILL.md'), SKILL);
      fs.writeFileSync(path.join(src, 'data', 'x.json'), '{}');
      fs.writeFileSync(path.join(src, 'agent-context', 'a.md'), 'x');
      const ok = (p) => ({ ok: true, abs: path.join(src, p) });
      const res = skills.resolve([{ id: 'sec', path: '.' }], ok);
      assert.deepEqual(skills.deliver(wt, res), []);
      const to = path.join(wt, '.claude', 'skills', 'sec');
      assert.ok(!fs.existsSync(path.join(to, 'data')) && !fs.existsSync(path.join(to, 'agent-context')));
      // over the file cap: the copy throws half way, and the next run still owns the folder
      for (let i = 0; i < 201; i++) fs.writeFileSync(path.join(src, `f${i}.txt`), 'x');
      assert.match(skills.deliver(wt, res)[0], /more than/);
      fs.rmSync(path.join(src, 'f0.txt'));
      for (let i = 1; i < 201; i++) fs.rmSync(path.join(src, `f${i}.txt`));
      assert.deepEqual(skills.deliver(wt, res), [], 'the half copy had its marker, so it is replaced');
      const clean = skills.cleanSkills([{ id: '..', path: '.' }, { id: '.', path: '.' }], ok);
      assert.ok(clean.every((c) => !/^\.+$/.test(c.id)), 'an id of dots is replaced');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
