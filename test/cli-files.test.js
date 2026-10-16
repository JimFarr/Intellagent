'use strict';
// key=@file in intellagent api / do, and the warning when a comment's whole body is a file path (INT-242).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { startServer, cleanEnv, USER } = require('./helpers');

const ROOT = path.join(__dirname, '..');
function cli(args, { cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'intellagent.js'), ...args], { cwd, env: cleanEnv(env), encoding: 'utf8', input: '', timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
}
const as = { INTELLAGENT_AGENT: 'ada' };

describe('key=@file reads one value from a file', () => {
  it('api and do take the text of the file, as text; @@ is a literal @; an @mention in a sentence is untouched', async () => {
    const s = await startServer();
    try {
      const it1 = await s.ok('POST', '/api/boards/main/items', { title: 'files', column: 'Backlog' }, USER);
      const note = path.join(s.dir, 'note.md');
      const text = '# Review\n\n- one\n- two with "quotes" and a {brace}\n';
      fs.writeFileSync(note, text);
      const a = cli(['api', 'POST', `/api/boards/main/items/${it1.id}/comments`, `body=@${note.replace(/\\/g, '/')}`], { cwd: s.dir, env: as });
      assert.equal(a.code, 0, a.err);
      assert.equal(a.json.body, text, 'the file, exactly');
      assert.equal(a.json.warning, undefined);
      const d = cli(['do', 'add_comment', `id=${it1.id}`, `body=@${note}`], { cwd: s.dir, env: as });
      assert.equal(d.code, 0, d.err);
      assert.equal(d.json.body, text);
      // a file that holds only 3 stays the text "3", not the number
      fs.writeFileSync(path.join(s.dir, 'three.txt'), '3');
      assert.equal(cli(['api', 'POST', `/api/boards/main/items/${it1.id}/comments`, `body=@${path.join(s.dir, 'three.txt')}`], { cwd: s.dir, env: as }).json.body, '3');
      const lit = cli(['api', 'POST', `/api/boards/main/items/${it1.id}/comments`, 'body=@@ada is not a file'], { cwd: s.dir, env: as });
      assert.equal(lit.json.body, '@ada is not a file');
      const mention = cli(['api', 'POST', `/api/boards/main/items/${it1.id}/comments`, 'body=@ada take this'], { cwd: s.dir, env: as });
      assert.equal(mention.code, 0, mention.err);
      assert.equal(mention.json.body, '@ada take this');
      const bare = cli(['api', 'POST', `/api/boards/main/items/${it1.id}/comments`, 'body=@ada'], { cwd: s.dir, env: as });
      assert.equal(bare.json.body, '@ada');
    } finally { await s.stop(); }
  });
  it('a file that is not there, is a folder, or is off limits is refused with a code and a hint, and nothing is posted', async () => {
    const s = await startServer();
    try {
      const it1 = await s.ok('POST', '/api/boards/main/items', { title: 'refused', column: 'Backlog' }, USER);
      const post = (v) => cli(['api', 'POST', `/api/boards/main/items/${it1.id}/comments`, `body=${v}`], { cwd: s.dir, env: as });
      const missing = post(`@${path.join(s.dir, 'nope.md').replace(/\\/g, '/')}`);
      assert.equal(missing.code, 2);
      assert.match(missing.err, /error 400 BAD_REQUEST: no file at .*nope\.md — hint: give the absolute path/);
      assert.match(post(`@${s.dir.replace(/\\/g, '/')}`).err, /error 400 BAD_REQUEST: .* is not a file/);
      fs.writeFileSync(path.join(s.dir, 'local.json'), '{"userToken":"secret"}');
      const tok = post(`@${path.join(s.dir, 'local.json').replace(/\\/g, '/')}`);
      assert.equal(tok.code, 2);
      assert.match(tok.err, /error 403 FORBIDDEN: .*tokens or data.* — hint:/);
      fs.mkdirSync(path.join(s.dir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(s.dir, 'data', 'x.json'), '{}');
      assert.match(post(`@${path.join(s.dir, 'data', 'x.json').replace(/\\/g, '/')}`).err, /error 403 FORBIDDEN/);
      // outside the project, its worktrees and the temp folder: this repo's own files
      const outside = post(`@${path.join(ROOT, 'package.json').replace(/\\/g, '/')}`);
      assert.equal(outside.code, 2);
      assert.match(outside.err, /error 403 FORBIDDEN: .*outside the folders an agent may read from/);
      const got = await s.ok('GET', `/api/boards/main/items/${it1.id}`, undefined, USER);
      assert.equal(got.comments.length, 0, 'none of them posted anything');
    } finally { await s.stop(); }
  });
});

describe('a comment or verdict that is only a file path', () => {
  it('is saved as written, and the reply says the file was not read', async () => {
    const s = await startServer({ agents: { agents: { rev: { role: 'reviewer', reviewer: true, enabled: false } } } });
    try {
      const it1 = await s.ok('POST', '/api/boards/main/items', { title: 'path only', column: 'Backlog' }, USER);
      for (const body of ['C:/Users/x/scratch/c.md', '/tmp/c.md', '@C:/Users/x/scratch/c.md', './notes/c.md']) {
        const c = await s.ok('POST', `/api/boards/main/items/${it1.id}/comments`, { body }, { agent: 'ada' });
        assert.equal(c.body, body, 'saved as written');
        assert.match(c.warning, /whole text you sent is a file path.*does not read files.*body=@/s, body);
      }
      for (const body of ['see /tmp/c.md for the notes', 'fixed in lib/request.js', 'The plan', '@ada /tmp/c.md']) {
        const c = await s.ok('POST', `/api/boards/main/items/${it1.id}/comments`, { body }, { agent: 'ada' });
        assert.equal(c.warning?.match(/file path/), undefined, `no warning for: ${body}`);
      }
      // a verdict's comment is covered the same way
      await s.ok('POST', `/api/boards/main/items/${it1.id}/reviewers`, { name: 'rev' }, USER);
      const v = await s.ok('POST', `/api/boards/main/items/${it1.id}/reviewers/rev/verdict`, { verdict: 'concerns', comment: 'C:/Users/x/scratch/c.md' }, { agent: 'rev' });
      assert.match(v.warning, /file path/);
      assert.ok(v.comments.some((c) => c.body.includes('C:/Users/x/scratch/c.md')), 'the verdict still counted');
      const fine = await s.ok('POST', `/api/boards/main/items/${it1.id}/reviewers/rev/verdict`, { verdict: 'ok', comment: 'looks fine' }, { agent: 'rev' });
      assert.equal(fine.warning, undefined);
    } finally { await s.stop(); }
  });
  it('the help and the guide say how to send a file\'s text', () => {
    assert.match(cli(['help']).out, /key=@path reads that one value from a file/);
    assert.match(fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'), /`key=@path` reads that value from the file/);
  });
});
