// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// A stand-in Jira Data Center for the tests and the Jira example plugin: one account (svc / s3cret), project BET with
// a To Do → In Progress → In QA → Done workflow, its issues kept in memory. node test/fake-jira.js <port> runs it alone.
const http = require('http');

const USER = 'svc';
const PASSWORD = 's3cret';
const FLOW = { 'To Do': ['In Progress'], 'In Progress': ['In QA', 'To Do'], 'In QA': ['Done', 'In Progress'], Done: ['To Do'] };
const STATUSES = Object.keys(FLOW);

function fakeJira() {
  const issues = new Map([['BET-1', { status: 'To Do', summary: 'Fix login', comments: [], assignee: null }], ['BET-2', { status: 'In Progress', summary: 'Odds feed', comments: [], assignee: null }]]);
  let next = 3;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const json = (st, b) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(b === undefined ? '' : JSON.stringify(b)); };
    if (req.headers.authorization !== `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`) return json(401, { errorMessages: ['You are not authenticated'] });
    const p = new URL(req.url, 'http://x').pathname.replace(/^\/rest\/api\/2/, '');
    if (p === '/myself') return json(200, { name: USER, displayName: 'Intellagent service' });
    if (p === '/project') return json(200, [{ key: 'BET', name: 'Betting' }]);
    if (p === '/project/BET/statuses') return json(200, [{ name: 'Task', statuses: STATUSES.map((name) => ({ name })) }]);
    if (p === '/issue' && req.method === 'POST') {
      const key = `${body.fields.project.key}-${next++}`;
      issues.set(key, { status: 'To Do', summary: body.fields.summary, comments: [], assignee: null, type: body.fields.issuetype?.name });
      return json(201, { key });
    }
    const m = /^\/issue\/([A-Z]+-\d+)(\/\w+)?$/.exec(p);
    const issue = m && issues.get(m[1]);
    if (!issue) return json(404, { errorMessages: ['Issue Does Not Exist'] });
    const what = m[2] || '';
    const moves = () => FLOW[issue.status].map((to) => ({ id: String(STATUSES.indexOf(to) + 11), name: `Go to ${to}`, to: { name: to } }));
    if (!what && req.method === 'GET') return json(200, { key: m[1], fields: { status: { name: issue.status }, summary: issue.summary } });
    if (what === '/transitions' && req.method === 'GET') return json(200, { transitions: moves() });
    if (what === '/transitions' && req.method === 'POST') {
      const t = moves().find((x) => x.id === body.transition?.id);
      if (!t) return json(400, { errorMessages: ['It seems that you have tried to perform a workflow operation that is not valid'] });
      issue.status = t.to.name;
      return json(204);
    }
    if (what === '/comment' && req.method === 'POST') { issue.comments.push(body.body); return json(201, { id: String(issue.comments.length) }); }
    if (what === '/assignee' && req.method === 'PUT') { issue.assignee = body.name; return json(204); }
    return json(404, { errorMessages: ['No such call'] });
  });
  return { server, issues, USER, PASSWORD };
}

module.exports = { fakeJira };

if (require.main === module) {
  const j = fakeJira();
  j.server.listen(Number(process.argv[2]) || 7599, '127.0.0.1', () => console.log(`fake Jira on http://127.0.0.1:${j.server.address().port} (${USER} / ${PASSWORD})`));
}
