// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Confluence: one account, and actions that create a page, append to one, or replace the section under a heading,
// from markdown; each a permission an agent holds within its space. The rest of a page, macros and all, stays.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, USER: HUMAN } = require('./helpers');
const { fakeConfluence } = require('./fake-confluence');
const MD = require('../lib/confluence/markdown.ts');
const { siteOf } = require('../lib/confluence/confluence.ts');

const AUTH = { userToken: 'user-token', requireAgentTokens: false };
const USER = { ...HUMAN, token: AUTH.userToken };
const WRITER = { agent: 'writer' };

describe('markdown and the storage format', () => {
  it('writes markdown as storage and reads it back', () => {
    const md = '## Notes\n\nSome **bold**, *it*, `a<b>` and [docs](https://e.com).\n\n- one\n  - nested\n1. first\n\n```js\nconst a = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    const s = MD.toStorage(md);
    assert.match(s, /<code>a&lt;b&gt;<\/code>/, 'escaped');
    assert.match(s, /<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js<\/ac:parameter><ac:plain-text-body><!\[CDATA\[const a = 1;\]\]>/);
    assert.equal(MD.toMarkdown(s), '## Notes\n\nSome **bold**, *it*, `a<b>` and [docs](https://e.com).\n\n- one\n  - nested\n\n1. first\n\n```js\nconst a = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
    assert.ok(!MD.toStorage('[x](javascript:alert(1))').includes('href'), 'only http(s), mailto and relative links');
  });
  it('replaces a section up to the next heading of its level, and adds a missing one at the end', () => {
    const page = '<h1>Doc</h1><ac:structured-macro ac:name="toc" /><h2>Unreleased</h2><p>old</p><h3>sub</h3><p>old sub</p><h2>1.0</h2><p>keep</p>';
    const r = MD.replaceSection(page, 'unreleased', '- new');
    assert.equal(r.found, true);
    assert.equal(r.storage, '<h1>Doc</h1><ac:structured-macro ac:name="toc" /><h2>Unreleased</h2><ul><li>new</li></ul><h2>1.0</h2><p>keep</p>');
    assert.match(MD.replaceSection(page, '### Later', 'x').storage, /<h2>1\.0<\/h2><p>keep<\/p><h3>Later<\/h3><p>x<\/p>$/);
  });
});

it('takes the site from any link a person pastes', () => {
  assert.equal(siteOf('https://km.atlassian.net'), 'https://km.atlassian.net/wiki', 'Cloud without /wiki');
  assert.equal(siteOf('https://km.atlassian.net/wiki/spaces/ENG/pages/123/Notes'), 'https://km.atlassian.net/wiki');
  assert.equal(siteOf('https://docs.example.com/confluence/display/ENG/Home'), 'https://docs.example.com/confluence', 'a context path stays');
  assert.equal(siteOf('https://docs.example.com/pages/viewpage.action?pageId=1'), 'https://docs.example.com');
  assert.equal(siteOf('http://127.0.0.1:7597/'), 'http://127.0.0.1:7597');
});

describe('Confluence on a board', () => {
  let conf, s, url;
  before(async () => {
    conf = fakeConfluence();
    await new Promise((r) => conf.server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${conf.server.address().port}`;
    s = await startServer({ manifest: { auth: AUTH }, agents: { agents: { writer: { enabled: false, role: 'writer' } } } });
  });
  after(async () => { await s?.stop(); conf?.server.close(); });

  it('connects an account only the human gives, and never shows the password', async () => {
    assert.equal((await s.api('PUT', '/api/confluence/connection', { url, username: 'svc', password: 's3cret' }, WRITER)).status, 403, 'an agent cannot');
    assert.equal((await s.api('PUT', '/api/confluence/connection', { url, username: 'svc', password: 'wrong' }, USER)).body.code, 'CONFLUENCE_REFUSED');
    const ok = await s.ok('PUT', '/api/confluence/connection', { url, username: 'svc', password: 's3cret' }, USER);
    assert.equal(ok.user.displayName, 'Docs service');
    assert.ok(!JSON.stringify(await s.ok('GET', '/api/confluence', undefined, USER)).includes('s3cret'));
    assert.deepEqual((await s.ok('GET', '/api/confluence/spaces', undefined, USER)).map((x) => x.key), ['ENG', 'OPS']);
  });

  it('a writer replaces a section within its grant, the rest of the page stays, and it reads pages only with a grant', async () => {
    const a = await s.ok('POST', '/api/confluence/actions', { name: 'Release notes', does: 'section', pageId: `${url}/pages/viewpage.action?pageId=100`, heading: 'Unreleased' }, USER);
    assert.equal(a.pageId, '100', 'a pasted link is its page id');
    const t = await s.ok('POST', '/api/boards/main/items', { title: 'Faster settlement', column: 'Ready' }, USER);
    const body = { item: t.id, text: '- {id}: {title}' };
    assert.equal((await s.api('POST', `/api/confluence/actions/${a.id}/run`, body, WRITER)).body.code, 'HUMAN_ONLY', 'no grant yet');
    assert.equal((await s.api('GET', '/api/confluence/pages/100/markdown', undefined, WRITER)).status, 403, 'nor may it read');
    await s.ok('PUT', `/api/agents/writer/permissions/confluence.action.${a.id}`, { mode: 'rules', rules: { where: { space: 'OPS' } } }, USER);
    assert.equal((await s.api('POST', `/api/confluence/actions/${a.id}/run`, body, WRITER)).body.code, 'OUT_OF_SCOPE', 'the page is in ENG');
    await s.ok('PUT', `/api/agents/writer/permissions/confluence.action.${a.id}`, { mode: 'rules', rules: { where: { space: 'ENG' } } }, USER);
    const read = await s.ok('GET', '/api/confluence/pages/100/markdown', undefined, WRITER);
    assert.match(read.markdown, /\[macro: toc\]/);
    const run = await s.ok('POST', `/api/confluence/actions/${a.id}/run`, body, WRITER);
    assert.equal(run.status, 'succeeded', run.message);
    assert.match(run.message, /Replaced the section "Unreleased" on "Release notes" \(version 2\)/);
    assert.equal(run.md, undefined, 'the run keeps what happened, not the text');
    const page = conf.pages.get('100');
    assert.equal(page.body, `<p>What shipped, newest first.</p><ac:structured-macro ac:name="toc" /><h2>Unreleased</h2><ul><li>${t.id}: Faster settlement</li></ul><h2>1.0</h2><p>First release.</p>`);
    assert.equal(page.lastMessage, `Intellagent: Release notes for ${t.id}`);
    assert.match(run.url, /pageId=100$/);
  });

  it('creates a page from the ticket, and appends to a page given when it runs', async () => {
    const c = await s.ok('POST', '/api/confluence/actions', { name: 'Design note', does: 'create', space: 'ENG', parent: '100', title: 'Design: {title}' }, USER);
    const t = await s.ok('POST', '/api/boards/main/items', { title: 'Odds cache', column: 'Ready' }, USER);
    assert.equal((await s.api('POST', `/api/confluence/actions/${c.id}/run`, { item: t.id }, USER)).body.code, 'BAD_REQUEST', 'it needs the text');
    const made = await s.ok('POST', `/api/confluence/actions/${c.id}/run`, { item: t.id, text: '# Why\n\nBecause.' }, USER);
    assert.equal(made.status, 'succeeded', made.message);
    const p = conf.pages.get(made.pageId);
    assert.deepEqual([p.title, p.space, p.parent, p.body], ['Design: Odds cache', 'ENG', '100', '<h1>Why</h1><p>Because.</p>']);
    const ap = await s.ok('POST', '/api/confluence/actions', { name: 'Log it', does: 'append', page: 'ask', text: '- {id} done' }, USER);
    assert.equal((await s.api('POST', `/api/confluence/actions/${ap.id}/run`, { item: t.id }, USER)).body.code, 'BAD_REQUEST', 'it needs the page');
    const done = await s.ok('POST', `/api/confluence/actions/${ap.id}/run`, { item: t.id, page: made.pageId }, USER);
    assert.equal(done.status, 'succeeded', done.message);
    assert.equal(conf.pages.get(made.pageId).body, `<h1>Why</h1><p>Because.</p><ul><li>${t.id} done</li></ul>`);
    assert.ok((await s.ok('GET', '/api/permissions', undefined, USER)).permissions.some((x) => x.key === `confluence.action.${ap.id}`), 'each action is a permission');
  });
});
