// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Run: npm test   (node --test, no dependencies)
const { describe, it: test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startServer, USER } = require('./helpers');

let s;

const B = '/api/boards/main';
const mk = (body, as) => s.ok('POST', `${B}/items`, { title: 'x', column: 'Backlog', ...body }, as);
const cursor = async () => (await s.ok('GET', '/api/app')).seq;
const eventsSince = async (since, q = '') => (await s.ok('GET', `/api/events?since=${since}&board=main${q}`)).events;

describe('board API', () => {
  before(async () => { s = await startServer(); });
  after(async () => { await s.stop(); });

  test('board starts from the template', async () => {
    const sum = await s.ok('GET', `${B}/summary`);
    assert.deepEqual(sum.columns.map((c) => c.name), ['Backlog', 'Ready', 'In Progress', 'Review', 'Done']);
  });

  test('items: create, patch, move, version conflicts', async () => {
    const it = await mk({ title: 'Login bug', type: 'issue', properties: { risk: 'low' } });
    assert.match(it.id, /^T-\d+$/);
    assert.equal(it.priority, 'Medium');
    assert.equal(it.author.kind, 'agent');

    const p = await s.ok('PATCH', `${B}/items/${it.id}`, { priority: 'High', properties: { risk: null, area: 'api' }, version: it.version });
    assert.equal(p.priority, 'High');
    assert.deepEqual(p.properties, { area: 'api' }, 'properties merge; null deletes');

    const stale = await s.api('PATCH', `${B}/items/${it.id}`, { priority: 'Low', version: it.version });
    assert.equal(stale.status, 409);

    const bad = await s.api('PATCH', `${B}/items/${it.id}`, { colour: 'red' });
    assert.equal(bad.status, 400, 'unknown fields are rejected');

    const m = await s.ok('POST', `${B}/items/${it.id.toLowerCase()}/move`, { column: 'In Progress' });
    assert.equal(m.columnId, 'in-progress', 'ids are case-insensitive, columns accept names');
  });

  test('column flags and approval gates', async () => {
    const noCreate = await s.api('POST', `${B}/items`, { title: 'y', column: 'Review' });
    assert.equal(noCreate.status, 403);

    const it = await mk({});
    const toDone = await s.api('POST', `${B}/items/${it.id}/move`, { column: 'Done' });
    assert.equal(toDone.status, 403, 'Done is human-only for agents');
    await s.ok('POST', `${B}/items/${it.id}/move`, { column: 'Done' }, USER);

    await s.ok('PATCH', `${B}/columns/Ready`, { flags: { wipLimit: 1 } }, USER);
    await mk({ column: 'Ready' });
    const over = await s.api('POST', `${B}/items`, { title: 'z', column: 'Ready' });
    assert.equal(over.status, 409, 'wipLimit is a hard cap');
    await s.ok('PATCH', `${B}/columns/Ready`, { flags: { wipLimit: null } }, USER);
  });

  test('agents cannot loosen the board they are held to', async () => {
    const no = async (method, url, body) => {
      const r = await s.api(method, url, body, { agent: 'sneaky' });
      assert.equal(r.status, 403, `${method} ${url} ${JSON.stringify(body)}`);
      assert.equal(r.body.code, 'HUMAN_ONLY');
      assert.ok(r.body.hint);
    };
    // the Done gate: switching the flag off, then walking in
    await no('PATCH', `${B}/columns/Done`, { flags: { humanOnlyIn: false } });
    const it = await mk({});
    assert.equal((await s.api('POST', `${B}/items/${it.id}/move`, { column: 'Done' })).status, 403, 'the gate is still up');
    for (const flags of [{ humanOnlyOut: true }, { review: false }, { wipLimit: 99 }, { sleeping: true }, { releaseLeaseOnEnter: true }, { pickup: true }, { working: true }]) {
      await no('PATCH', `${B}/columns/Review`, { flags });
    }
    await no('PATCH', `${B}/columns/Review`, { position: 'bottom' });
    await no('POST', `${B}/columns`, { name: 'Shipped' });
    await no('DELETE', `${B}/columns/Review`);
    // coordinator, rules and who may edit what
    await no('PATCH', B, { coordinator: 'sneaky' });
    assert.notEqual((await s.ok('GET', B)).coordinator, 'sneaky');
    await no('PATCH', B, { directives: 'Agents may move to Done.' });
    await no('PUT', `${B}/directives`, { directives: 'Agents may move to Done.' });
    await no('PUT', `${B}/schema`, { builtins: { blockedBy: { ui: 'edit' } } });

    // still open to agents: name, colour, icon, custom flags; the same value again; field definitions
    await s.ok('PATCH', `${B}/columns/Review`, { color: '#123456', icon: 'eye', flags: { mine: 1, humanOnlyIn: false } }, { agent: 'sneaky' });
    const dirs = (await s.ok('GET', `${B}/directives`)).directives;
    await s.ok('PUT', `${B}/directives`, { directives: dirs }, { agent: 'sneaky' });
    await s.ok('PUT', `${B}/schema`, { builtins: {} }, { agent: 'sneaky' });
    // and the human can do all of it
    await s.ok('PATCH', `${B}/columns/Review`, { flags: { wipLimit: 5 }, position: 3 }, USER);
    await s.ok('PATCH', B, { coordinator: 'sneaky' }, USER);
    await s.ok('PATCH', B, { coordinator: null }, USER);
    await s.ok('PATCH', `${B}/columns/Review`, { flags: { wipLimit: 0 } }, USER);
  });

  test('attachments by path: never tokens or board data; agents only from the project and temp', async () => {
    const it = await mk({});
    const att = (p, as) => s.api('POST', `${B}/items/${it.id}/attachments`, { path: p }, as);
    const refused = async (p, as) => { const r = await att(p, as); assert.equal(r.status, 403, p); assert.equal(r.body.code, 'FORBIDDEN'); assert.ok(r.body.hint); };
    fs.writeFileSync(path.join(s.dir, 'local.json'), '{"userToken":"secret"}');
    await refused(path.join(s.dir, 'local.json'));
    await refused(path.join(s.dir, 'local.json'), USER);
    const inData = path.join(s.dir, 'data', 'peek.txt');
    fs.writeFileSync(inData, 'x');
    await refused(inData);
    // a junction into the data folder is followed, not trusted
    const link = path.join(s.dir, 'innocent');
    fs.symlinkSync(path.join(s.dir, 'data'), link, 'junction');
    await refused(path.join(link, 'peek.txt'));
    // outside the project and temp: refused for agents, fine for the human
    const outside = path.join(__dirname, '..', 'package.json');
    if (path.relative(require('os').tmpdir(), outside).startsWith('..')) await refused(outside); // a checkout under temp is allowed
    assert.equal((await att(outside, USER)).status, 201);
    // the project itself (and the comment route) still work
    fs.writeFileSync(path.join(s.dir, 'shot.png'), 'png');
    assert.equal((await att(path.join(s.dir, 'shot.png'))).status, 201);
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: 'see', attachments: [{ path: path.join(s.dir, 'shot.png') }] });
    const c = await s.api('POST', `${B}/items/${it.id}/comments`, { body: 'see', attachments: [{ path: path.join(s.dir, 'local.json') }] });
    assert.equal(c.status, 403);
    // avatars by path too
    const av = await s.api('PATCH', '/api/profiles/me', { imagePath: path.join(s.dir, 'local.json') });
    assert.equal(av.status, 403);
  });

  test('leases lock other agents but never the human', async () => {
    const it = await mk({});
    await s.ok('POST', `${B}/items/${it.id}/lease`, { minutes: 10, status: 'reading' }, { agent: 'a1' });
    const blocked = await s.api('PATCH', `${B}/items/${it.id}`, { priority: 'Low' }, { agent: 'a2' });
    assert.equal(blocked.status, 423);
    const steal = await s.api('POST', `${B}/items/${it.id}/lease`, {}, { agent: 'a2' });
    assert.equal(steal.status, 409);
    await s.ok('PATCH', `${B}/items/${it.id}`, { priority: 'Low' }, USER);
    await s.ok('DELETE', `${B}/items/${it.id}/lease`, undefined, { agent: 'a1' });
    await s.ok('PATCH', `${B}/items/${it.id}`, { priority: 'High' }, { agent: 'a2' });
  });

  test('master lease: holder works freely, others are read-only but may comment', async () => {
    const it = await mk({});
    await s.ok('POST', `${B}/master`, { status: 'solo run' }, { agent: 'solo' });
    await s.ok('PATCH', `${B}/items/${it.id}`, { priority: 'Low' }, { agent: 'solo' });
    const other = await s.api('PATCH', `${B}/items/${it.id}`, { priority: 'High' }, { agent: 'other' });
    assert.equal(other.status, 423);
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: 'fyi' }, { agent: 'other' });
    await s.ok('PATCH', `${B}/items/${it.id}`, { priority: 'High' }, USER);
    await s.ok('DELETE', `${B}/master`, undefined, { agent: 'solo' });
    await s.ok('PATCH', `${B}/items/${it.id}`, { priority: 'Low' }, { agent: 'other' });
  });

  test('master lease is refused while others hold ticket leases', async () => {
    const it = await mk({});
    await s.ok('POST', `${B}/items/${it.id}/lease`, {}, { agent: 'worker' });
    const r = await s.api('POST', `${B}/master`, {}, { agent: 'solo' });
    assert.ok(r.status >= 400, `expected refusal, got ${r.status}`);
    await s.ok('DELETE', `${B}/items/${it.id}/lease`, undefined, { agent: 'worker' });
  });

  test('inbox: a human comment reaches everyone involved with the ticket', async () => {
    const it = await mk({}, USER); // created by the human, so no agent author
    await s.ok('POST', `${B}/items/${it.id}/lease`, {}, { agent: 'builder' });
    await s.ok('POST', `${B}/items/${it.id}/review`, { summary: 'done, run npm test' }, { agent: 'builder' });
    const since = await cursor();
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: 'one more thing' }, USER);
    const [ev] = await eventsSince(since, '&for=builder&types=comment.added');
    assert.ok(ev, 'past leaseholder hears follow-up comments after releasing');

    await s.ok('POST', `${B}/master`, {}, { agent: 'solo' });
    const since2 = await cursor();
    const other = await mk({}, USER);
    await s.ok('POST', `${B}/items/${other.id}/comments`, { body: 'hello?' }, USER);
    const evs = await eventsSince(since2, '&for=solo');
    assert.ok(evs.some((e) => e.type === 'comment.added' && e.itemId === other.id), 'master holder hears about every ticket');
    await s.ok('DELETE', `${B}/master`, undefined, { agent: 'solo' });
  });

  test('inbox: @mentions and own echoes', async () => {
    const it = await mk({}, USER);
    const since = await cursor();
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@helper can you look?' }, USER);
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: 'on it' }, { agent: 'helper' });
    const evs = await eventsSince(since, '&for=helper');
    assert.equal(evs.length, 1, 'mentioned, and not told about its own comment');
  });

  test('long-poll wakes on a matching event', async () => {
    const it = await mk({}, USER);
    const since = await cursor();
    const waiting = s.ok('GET', `/api/events/wait?since=${since}&for=sleeper&timeout=10`, undefined, { agent: 'sleeper' });
    await new Promise((r) => setTimeout(r, 200));
    const t = Date.now();
    await s.ok('POST', `${B}/items/${it.id}/comments`, { body: '@sleeper wake up' }, USER);
    const r = await waiting;
    assert.equal(r.events[0].type, 'comment.added');
    assert.ok(Date.now() - t < 3000, 'returned promptly, not at timeout');
  });

  test('attention round trip', async () => {
    const it = await mk({});
    await s.ok('POST', `${B}/items/${it.id}/attention`, { reason: 'Which DB?' }, { agent: 'asker' });
    const since = await cursor();
    await s.ok('DELETE', `${B}/items/${it.id}/attention`, { reply: 'Postgres' }, USER);
    const [ev] = await eventsSince(since, '&for=asker&types=attention.resolved');
    assert.equal(ev.reply, 'Postgres');
  });

  test('schema: typed fields are validated, UI-read-only fields reject humans', async () => {
    await s.ok('POST', `${B}/schema/fields`, { key: 'risk', type: 'enum', options: ['low', 'high'] });
    await s.ok('POST', `${B}/schema/fields`, { key: 'score', type: 'number', min: 0, max: 5, ui: 'read' });
    const it = await mk({ fields: { risk: 'low' } });
    assert.equal((await s.api('PATCH', `${B}/items/${it.id}`, { fields: { risk: 'meh' } })).status, 400);
    assert.equal((await s.api('PATCH', `${B}/items/${it.id}`, { fields: { score: 9 } })).status, 400);
    assert.equal((await s.api('PATCH', `${B}/items/${it.id}`, { fields: { nope: 1 } })).status, 400);
    await s.ok('PATCH', `${B}/items/${it.id}`, { fields: { score: 3 } });
    const human = await s.api('PATCH', `${B}/items/${it.id}`, { fields: { score: 4 } }, USER);
    assert.equal(human.status, 403);
  });

  test('schema: field values keep their lenient forms and their messages (INT-133)', async () => {
    await s.ok('POST', `${B}/schema/fields`, { key: 'sev', type: 'enum', options: ['low', 'high'] });
    await s.ok('POST', `${B}/schema/fields`, { key: 'pts', type: 'number', min: 1, max: 5 });
    await s.ok('POST', `${B}/schema/fields`, { key: 'ok', type: 'boolean' });
    await s.ok('POST', `${B}/schema/fields`, { key: 'areas', type: 'tags', options: ['server', 'ui'] });
    const it = await mk({});
    const put = (fields) => s.api('PATCH', `${B}/items/${it.id}`, { fields });
    const err = async (fields) => (await put(fields)).body.error;
    assert.match(await err({ sev: 'meh' }), /Field "sev" expects one of: low, high/);
    assert.match(await err({ pts: 0 }), /Field "pts" must be >= 1/);
    assert.match(await err({ pts: 9 }), /Field "pts" must be <= 5/);
    assert.match(await err({ pts: 'x' }), /Field "pts" expects a number, got "x"/);
    assert.match(await err({ ok: 'maybe' }), /Field "ok" expects true or false/);
    assert.match(await err({ areas: ['db'] }), /Field "areas" tags must be from: server, ui/);
    const done = await put({ sev: 'HIGH', pts: '3', ok: 'true', areas: ['UI', 'ui'] });
    assert.equal(done.status, 200);
    assert.deepEqual(done.body.fields, { sev: 'high', pts: 3, ok: true, areas: ['ui'] });
  });

  test('archive and restore instead of delete', async () => {
    const it = await mk({ title: 'archivable' });
    await s.ok('POST', `${B}/archive`, { ids: [it.id], reason: 'dup' });
    assert.equal((await s.api('GET', `${B}/items/${it.id}`)).body.archived ?? true, true);
    const sum = await s.ok('GET', `${B}/summary`);
    assert.ok(!JSON.stringify(sum).includes('archivable'));
    await s.ok('POST', `${B}/archive/${it.id}/restore`);
    assert.ok(JSON.stringify(await s.ok('GET', `${B}/summary`)).includes('archivable'));
  });

  test('big replies are gzipped for clients that ask, but not over loopback unless the manifest says "always" (INT-11)', async () => {
    const get = (srv, p, enc) => new Promise((resolve, reject) => {
      http.get(srv.base + p, { headers: { 'x-agent': 'tester', ...(enc ? { 'accept-encoding': enc } : {}) } }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ enc: r.headers['content-encoding'], buf: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    await mk({ title: 'bulky', description: 'x'.repeat(20_000) });
    assert.equal((await get(s, B, 'gzip')).enc, undefined, 'loopback stays plain by default');
    const t = await startServer({ manifest: { compress: 'always' } });
    try {
      await t.ok('POST', `${B}/items`, { title: 'bulky', column: 'Backlog', description: 'x'.repeat(20_000) });
      const gz = await get(t, B, 'gzip, deflate');
      assert.equal(gz.enc, 'gzip');
      const plain = await get(t, B);
      assert.equal(plain.enc, undefined);
      assert.equal(JSON.parse(require('zlib').gunzipSync(gz.buf)).id, JSON.parse(plain.buf).id);
      assert.ok(gz.buf.length * 5 < plain.buf.length, `${gz.buf.length} gzipped vs ${plain.buf.length}`);
      assert.equal((await get(t, `${B}/hash`, 'gzip')).enc, undefined, 'small replies stay plain');
    } finally { await t.stop(); }
  });

  test('board.json is compact, survives a restart, and a failed write changes nothing (INT-11)', async () => {
    const t = await startServer();
    try {
      const file = path.join(t.dir, 'data', 'boards', 'main', 'board.json');
      const it = await t.ok('POST', `${B}/items`, { title: 'keep me', column: 'Backlog' });
      const gone = await t.ok('POST', `${B}/items`, { title: 'archive me', column: 'Backlog' });
      await t.ok('POST', `${B}/archive`, { ids: [gone.id] });
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!text.includes('\n'), 'one line on disk');
      assert.match(JSON.parse(text).updatedAt, /^\d{4}-/);
      assert.equal(JSON.parse(text).items[it.id].title, 'keep me');
      const h = (await t.ok('GET', `${B}/hash`)).hash;
      const bad = await t.api('PATCH', `${B}/items/${it.id}`, { title: 'lost', version: 999 });
      assert.equal(bad.status, 409);
      assert.equal((await t.ok('GET', `${B}/hash`)).hash, h);
      assert.equal(fs.readFileSync(file, 'utf8'), text);
      await t.stop({ keep: true });
      const t2 = await startServer({ dir: t.dir });
      try {
        assert.equal((await t2.ok('GET', `${B}/items/${it.id}`)).title, 'keep me');
        assert.equal((await t2.ok('GET', `${B}/archive`)).map((x) => x.id).join(), gone.id);
        await t2.ok('POST', `${B}/archive/${gone.id}/restore`);
      } finally { await t2.stop(); }
    } catch (e) { await t.stop().catch(() => {}); throw e; }
  });

  test('search and board hash', async () => {
    const h1 = (await s.ok('GET', `${B}/hash`)).hash;
    await mk({ title: 'needle in haystack', properties: { risk: 'high' } });
    const h2 = (await s.ok('GET', `${B}/hash`)).hash;
    assert.notEqual(h1, h2);
    const r = await s.ok('POST', '/api/search', { board: 'main', q: 'needle', where: { 'properties.risk': 'high' } });
    const hits = r.items || r.results || r;
    assert.equal(hits.length, 1);
  });

  test('durable subscription keeps its own cursor', async () => {
    const sub = await s.ok('POST', '/api/subscriptions', { filter: { types: 'item.created' } }, { agent: 'subber' });
    await mk({ title: 'one' });
    const first = await s.ok('GET', `/api/subscriptions/${sub.id}/next?timeout=1`, undefined, { agent: 'subber' });
    assert.equal(first.events.length, 1);
    const again = await s.ok('GET', `/api/subscriptions/${sub.id}/next?timeout=1`, undefined, { agent: 'subber' });
    assert.equal(again.events.length, 0);
  });

  test('ticket templates fill a new ticket; the caller overrides', async () => {
    const list = await s.ok('GET', `${B}/ticket-templates`);
    assert.deepEqual(list.map((t) => t.key), ['bug', 'feature', 'question'], 'copied from the board preset');
    const bug = await mk({ template: 'bug', title: 'Crash on save' });
    assert.equal(bug.type, 'issue');
    assert.equal(bug.priority, 'High');
    assert.equal(bug.template, 'bug');
    assert.match(bug.description, /Steps to reproduce/);
    const low = await mk({ template: 'bug', title: 'Typo', priority: 'Low', description: 'just a typo' });
    assert.equal(low.priority, 'Low');
    assert.equal(low.description, 'just a typo');
    assert.equal((await s.api('POST', `${B}/items`, { title: 'x', template: 'nope' })).status, 400);

    const t = await s.ok('POST', `${B}/ticket-templates`, { label: 'Hotfix', type: 'issue', priority: 'Critical', column: 'Ready', properties: { hot: true } }, USER);
    assert.equal(t.key, 'hotfix');
    const hot = await mk({ template: 'hotfix', title: 'Prod down', column: undefined });
    assert.equal(hot.columnId, 'ready');
    assert.deepEqual(hot.properties, { hot: true });
    await s.ok('PATCH', `${B}/ticket-templates/hotfix`, { priority: 'High' });
    assert.equal((await mk({ template: 'hotfix', title: 'y', column: undefined })).priority, 'High');
    await s.ok('DELETE', `${B}/ticket-templates/hotfix`);
    assert.equal((await s.ok('GET', `${B}/ticket-templates`)).length, 3);
  });

  test('flow and wait history are recorded for metrics', async () => {
    const it = await mk({});
    await s.ok('POST', `${B}/items/${it.id}/move`, { column: 'Ready' });
    await s.ok('POST', `${B}/items/${it.id}/attention`, { reason: 'ok?' });
    await s.ok('DELETE', `${B}/items/${it.id}/attention`, { reply: 'yes' }, USER);
    const full = await s.ok('GET', `${B}/items/${it.id}`);
    assert.deepEqual(full.flow.map((f) => f.col), ['backlog', 'ready']);
    assert.equal(full.waits.length, 1);
    assert.equal(full.waits[0].by, 'James');
  });

  test('Idempotency-Key replays the first reply instead of acting twice', async () => {
    const it = await mk({ title: 'idem' });
    const post = (agent, key) => fetch(`${s.base}${B}/items/${it.id}/comments`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent': agent, 'idempotency-key': key }, body: '{"body":"once"}' });
    const a = await post('ia', 'k1');
    const b = await post('ia', 'k1');
    assert.equal(b.headers.get('idempotent-replayed'), 'true');
    assert.equal((await a.json()).id, (await b.json()).id);
    await post('other', 'k1'); // keys are per caller
    const full = await s.ok('GET', `${B}/items/${it.id}`);
    assert.equal(full.comments.filter((c) => c.body === 'once').length, 2);
  });

  test('events carry the run that caused them', async () => {
    const it = await mk({ title: 'runs' });
    await fetch(`${s.base}${B}/items/${it.id}/comments`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent': 'runner', 'x-intellagent-run': 'run_abc' }, body: '{"body":"from a run"}' });
    const evs = (await s.ok('GET', '/api/events?since=0&run=run_abc')).events;
    assert.equal(evs.length, 1);
    assert.equal(evs[0].actor.run, 'run_abc');
  });

  test('subscriptions: peek, then ack, for at-least-once delivery', async () => {
    const sub = await s.ok('POST', '/api/subscriptions', { filter: { types: 'item.created' } }, { agent: 'acker' });
    await mk({ title: 'ack me' });
    const peek = await s.ok('GET', `/api/subscriptions/${sub.id}/next?timeout=1&peek=true`);
    assert.equal(peek.events.length, 1);
    assert.equal((await s.ok('GET', `/api/subscriptions/${sub.id}/next?timeout=1&peek=true`)).events.length, 1, 'still there until acked');
    await s.ok('POST', `/api/subscriptions/${sub.id}/ack`, { cursor: peek.cursor });
    assert.equal((await s.ok('GET', `/api/subscriptions/${sub.id}/next?timeout=1&peek=true`)).events.length, 0);
  });

  test('forgetting offline agents', async () => {
    const it = await mk({ title: 'forget me' });
    await s.ok('POST', `${B}/items/${it.id}/lease`, {}, { agent: 'ghost' });
    assert.equal((await s.api('DELETE', '/api/presence/ghost', undefined, { agent: 'other' })).status, 403, 'human only');
    const busy = await s.api('DELETE', '/api/presence/ghost', undefined, USER);
    assert.ok(['ONLINE', 'HOLDS_LEASES'].includes(busy.body.code), 'not while online or holding a lease');
    assert.equal((await s.api('DELETE', '/api/presence/nobody', undefined, USER)).status, 404);
  });

  test('cross-origin writes are refused', async () => {
    const r = await fetch(`${s.base}${B}/items`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example', 'x-user': 'James' }, body: '{"title":"x"}' });
    assert.equal(r.status, 403);
  });

  test('DNS rebinding: a Host the board does not answer to is refused, and a browser write must be JSON', async () => {
    const port = Number(new URL(s.base).port);
    const raw = (method, p, headers, data) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
        let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(t || '{}') }));
      });
      req.on('error', reject);
      req.end(data);
    });
    // after rebinding, a page on evil.example sends Origin and Host both "evil.example:<port>": same-origin, but not us
    const evil = `evil.example:${port}`;
    const rebound = await raw('POST', `${B}/items`, { host: evil, origin: `http://${evil}`, 'content-type': 'application/json', 'x-agent': 'page' }, '{"title":"rebound","column":"Backlog"}');
    assert.equal(rebound.status, 403);
    assert.equal(rebound.body.code, 'BAD_HOST');
    assert.match(rebound.body.hint, /allowedHosts/);
    assert.equal((await raw('GET', '/api/app', { host: evil })).body.code, 'BAD_HOST', 'reads too');
    assert.equal((await raw('GET', '/', { host: evil })).status, 403, 'and the page itself');
    // the board's own names still work, in any case
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      assert.equal((await raw('GET', '/api/app', { host })).status, 200, host);
    }
    assert.equal((await raw('GET', '/api/app', { host: '127.0.0.1' })).body.code, 'BAD_HOST', 'another port is another program');
    // a same-origin browser write that isn't JSON (a form) is refused; programs without Origin keep working
    const form = await raw('POST', `${B}/items`, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'text/plain', 'x-agent': 'page' }, '{"title":"form","column":"Backlog"}');
    assert.equal(form.status, 415);
    const curl = await raw('POST', `${B}/items`, { host: `127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', 'x-agent': 'curl' }, '{"title":"curl -d","column":"Backlog"}');
    assert.equal(curl.status, 201, 'curl -d without a content-type header still works');
    const titles = (await s.ok('POST', '/api/search', { board: 'main', full: true, limit: 1000 })).items.map((i) => i.title);
    assert.ok(titles.includes('curl -d') && !titles.includes('rebound') && !titles.includes('form'), 'only the curl ticket was created');
  });

  test('allowedHosts: loopback always, the bound address, every local address on 0.0.0.0, and extra names', () => {
    const { allowedHosts } = require('../lib/local-only');
    const local = allowedHosts(7420);
    assert.deepEqual([...local].sort(), ['127.0.0.1:7420', '[::1]:7420', 'localhost:7420']);
    assert.ok(allowedHosts(7420, { host: '192.168.1.5' }).has('192.168.1.5:7420'));
    const all = allowedHosts(7420, { host: '0.0.0.0' });
    assert.ok(all.has(`${require('os').hostname().toLowerCase()}:7420`));
    const extra = allowedHosts(7420, { extra: ['Board.Example', 'proxy.example:443', '[fe80::1]'] });
    assert.ok(extra.has('board.example:7420') && extra.has('proxy.example:443') && extra.has('[fe80::1]:7420'));
  });
});
