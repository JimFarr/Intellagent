// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// An in-memory Confluence (Data Center REST API) for the tests and the demo: account svc / s3cret, spaces ENG and OPS,
// page 100 "Release notes" in ENG (an intro, a table of contents macro, two sections). Pages keep versions, and a
// write that doesn't follow the version read is refused with 409, as Confluence does.
//   node test/fake-confluence.js [port]
const http = require('http');

function fakeConfluence() {
  const pages = new Map();
  let next = 101;
  const add = (p) => { pages.set(String(p.id), { version: 1, ...p }); return pages.get(String(p.id)); };
  add({ id: '100', title: 'Release notes', space: 'ENG', body: '<p>What shipped, newest first.</p><ac:structured-macro ac:name="toc" /><h2>Unreleased</h2><p>Nothing yet.</p><h2>1.0</h2><p>First release.</p>' });
  const view = (p) => ({ id: p.id, type: 'page', title: p.title, space: { key: p.space }, version: { number: p.version }, body: { storage: { value: p.body, representation: 'storage' } }, _links: { webui: `/pages/viewpage.action?pageId=${p.id}` } });
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== `Basic ${Buffer.from('svc:s3cret').toString('base64')}`) return send(401, { message: 'Unauthorized' });
      const u = new URL(req.url, 'http://x');
      const m = /^\/rest\/api\/content\/(\d+)$/.exec(u.pathname);
      if (req.method === 'GET' && u.pathname === '/rest/api/user/current') return send(200, { username: 'svc', displayName: 'Docs service' });
      if (req.method === 'GET' && u.pathname === '/rest/api/space') return send(200, { results: [{ key: 'ENG', name: 'Engineering' }, { key: 'OPS', name: 'Operations' }] });
      if (req.method === 'GET' && m) { const p = pages.get(m[1]); return p ? send(200, view(p)) : send(404, { message: `No content with id ${m[1]}` }); }
      if (req.method === 'POST' && u.pathname === '/rest/api/content') {
        const b = JSON.parse(raw);
        if (!['ENG', 'OPS'].includes(b.space?.key)) return send(400, { message: 'No space with that key' });
        if ([...pages.values()].some((p) => p.space === b.space.key && p.title === b.title)) return send(400, { message: 'A page with this title already exists' });
        return send(200, view(add({ id: String(next++), title: b.title, space: b.space.key, parent: b.ancestors?.[0]?.id || null, body: b.body.storage.value })));
      }
      if (req.method === 'PUT' && m) {
        const p = pages.get(m[1]);
        if (!p) return send(404, { message: `No content with id ${m[1]}` });
        const b = JSON.parse(raw);
        if (b.version?.number !== p.version + 1) return send(409, { message: `Version must be incremented on update. Current version is: ${p.version}` });
        Object.assign(p, { title: b.title, body: b.body.storage.value, version: b.version.number, lastMessage: b.version.message });
        return send(200, view(p));
      }
      send(404, { message: 'no such endpoint' });
    });
  });
  return { server, pages };
}

module.exports = { fakeConfluence };
if (require.main === module) {
  const port = Number(process.argv[2]) || 7597;
  fakeConfluence().server.listen(port, '127.0.0.1', () => console.log(`fake Confluence on http://127.0.0.1:${port} (svc / s3cret)`));
}
