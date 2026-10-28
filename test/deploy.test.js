// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Deployments: the board holds one Azure DevOps token, runs steps and sequences of pipelines the way KM.Launchpad
// did, and lets an agent run them only within its deploy.run grants, checked before the run and before each step.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer, until, USER: HUMAN } = require('./helpers');
// deployments change only on a board that can tell the human apart: these boards have a sign-in token
const AUTH = { userToken: 'user-token', requireAgentTokens: false };
const USER = { ...HUMAN, token: AUTH.userToken };

const PAT = 'good-pat-1234';
const DEPLOY_YAML = `parameters:
  - name: environment
    type: string
    default: int
    values: [int, test1, prod]
  - name: imageTag
    type: string
    default: latest
steps:
  - script: echo deploy
`;

// A stand-in Azure DevOps for org "acme", project "Sportsteam": pipelines 11 (build), 12 (deploy), 13 (migrate).
// Every run is in progress on its first read and completed on the next; failNext makes one pipeline's next run fail.
function fakeAdo() {
  const triggers = [];
  const builds = new Map();
  const failNext = new Set();
  const branches = []; // more branches of r1, oldest first, as a test pushes them
  let nextId = 100;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const u = new URL(req.url, 'http://x');
    const json = (st, b) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.headers.authorization !== `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`) { res.writeHead(302, { location: '/_signin' }); return res.end(); }
    const p = u.pathname;
    if (p === '/acme/_apis/connectionData') return json(200, { authenticatedUser: { id: 'u1', providerDisplayName: 'James Farrugia', properties: { Account: { $value: 'james@example.com' } } } });
    if (p === '/acme/_apis/projects') return json(200, { value: [{ id: 'p1', name: 'Sportsteam' }] });
    if (p === '/acme/Sportsteam/_apis/build/definitions') return json(200, { value: [{ id: 11, name: 'Placement-CI', path: '\\' }, { id: 12, name: 'Placement-Deploy', path: '\\deploy' }, { id: 13, name: 'Migrate', path: '\\' }] });
    const def = /^\/acme\/Sportsteam\/_apis\/build\/definitions\/(\d+)$/.exec(p);
    if (def) {
      const id = Number(def[1]);
      return json(200, { id, name: { 11: 'Placement-CI', 12: 'Placement-Deploy', 13: 'Migrate' }[id], repository: { id: 'r1', name: 'placement', defaultBranch: 'refs/heads/main' },
        process: { yamlFilename: id === 12 ? 'deploy.yml' : 'ci.yml' }, variables: id === 12 ? { region: { value: 'eu', allowOverride: true }, apiKey: { isSecret: true, value: null } } : {} });
    }
    if (p === '/acme/Sportsteam/_apis/git/repositories/r1/items') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(u.searchParams.get('path') === 'deploy.yml' ? DEPLOY_YAML : 'steps:\n  - script: echo build\n');
    }
    if (p === '/acme/Sportsteam/_apis/git/repositories/r1/stats/branches') {
      return json(200, { value: [{ name: 'main', commit: { author: { email: 'someone@example.com', date: '2026-10-20T10:00:00Z' } } }, { name: 'feature/mine', commit: { author: { email: 'james@example.com', date: '2026-10-01T10:00:00Z' } } },
        ...branches.map((name, i) => ({ name, commit: { author: { email: 'someone@example.com', date: `2026-10-2${i + 1}T10:00:00Z` } } }))] });
    }
    const run = /^\/acme\/Sportsteam\/_apis\/pipelines\/(\d+)\/runs$/.exec(p);
    if (run && req.method === 'POST') {
      const body = JSON.parse(raw);
      const pipelineId = Number(run[1]);
      const id = nextId++;
      triggers.push({ pipelineId, id, body });
      builds.set(id, { pipelineId, reads: 0, fail: failNext.delete(pipelineId), branch: body.resources.repositories.self.refName });
      return json(200, { id });
    }
    if (/\/_apis\/build\/builds\/\d+\/tags$/.test(p)) return json(200, { value: ['🚀 intellagent'] });
    const b = /^\/acme\/Sportsteam\/_apis\/build\/builds\/(\d+)$/.exec(p);
    if (b) {
      const x = builds.get(Number(b[1]));
      if (!x) return json(404, { message: 'no such build' });
      const done = x.reads++ >= 1;
      return json(200, { id: Number(b[1]), buildNumber: `20261027.${b[1]}`, status: done ? 'completed' : 'inProgress', result: done ? (x.fail ? 'failed' : 'succeeded') : null,
        sourceBranch: x.branch, definition: { id: x.pipelineId, name: 'p' }, _links: { web: { href: `https://ado.example/build/${b[1]}` } }, finishTime: done ? new Date().toISOString() : null });
    }
    json(404, { message: `fake ADO has no ${req.method} ${p}` });
  });
  return { server, triggers, failNext, branches };
}

describe('Deployments: Azure DevOps steps and sequences run by the board', () => {
  let ado, s;
  // each deployment is its own power; a grant may name one before it exists, and holds once it does
  const grants = [
    { power: 'deploy.sequence.ship-placement', where: { 'inputs.env': ['int', 'test1'] } },
    { power: 'deploy.step.deploy-placement', where: { 'parameters.environment': ['int', 'test1'] } },
    { power: 'deploy.step.deploy-placement', approve: 'human' },
  ];
  const finished = async (id) => until(async () => { const r = await s.ok('GET', `/api/deploy/runs/${id}`, undefined, USER); return ['succeeded', 'failed', 'canceled'].includes(r.status) && r; }, 10000, `run ${id} to end`);

  before(async () => {
    ado = fakeAdo();
    await new Promise((r) => ado.server.listen(0, '127.0.0.1', r));
    s = await startServer({
      env: { INTELLAGENT_ADO_URL: `http://127.0.0.1:${ado.server.address().port}`, INTELLAGENT_DEPLOY_POLL_MS: '30' },
      manifest: { auth: AUTH, permissions: { deployer: { grants }, tagger: { grants: [{ power: 'deploy.step.deploy-placement', where: { 'parameters.imageTag': 'release.*' } }] } } },
    });
  });
  after(async () => { await s?.stop(); ado?.server.close(); });

  it('connects a token only the human gives, tries it first, and never shows it again', async () => {
    assert.equal((await s.api('PUT', '/api/deploy/connection', { org: 'acme', pat: PAT })).status, 403, 'an agent cannot connect it');
    const bad = await s.api('PUT', '/api/deploy/connection', { org: 'acme', pat: 'wrong' }, USER);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'ADO_REFUSED');
    const ok = await s.ok('PUT', '/api/deploy/connection', { org: 'acme', pat: PAT }, USER);
    assert.equal(ok.user.displayName, 'James Farrugia');
    assert.equal(ok.patHint, '1234');
    const view = await s.ok('GET', '/api/deploy', undefined, USER);
    assert.equal(view.connected, true);
    assert.ok(!JSON.stringify(view).includes(PAT), 'the token is never in a reply');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'local.json'), 'utf8')).deploy.pat, PAT, 'it is kept in local.json');
  });

  it('reads what a pipeline takes: YAML parameters, overridable variables (no secrets) and branches, its owner\'s first', async () => {
    assert.deepEqual((await s.ok('GET', '/api/deploy/projects/Sportsteam/pipelines')).map((x) => x.name), ['Placement-CI', 'Placement-Deploy', 'Migrate']);
    const d = await s.ok('GET', '/api/deploy/projects/Sportsteam/pipelines/12');
    const env = d.parameters.find((x) => x.name === 'environment');
    assert.deepEqual([env.type, env.defaultValue, env.allowedValues], ['enum', 'int', ['int', 'test1', 'prod']]);
    assert.deepEqual(d.parameters.filter((x) => x.kind === 'variable').map((x) => x.name), ['region']);
    assert.deepEqual(d.branches.map((b) => [b.name, b.mine]), [['feature/mine', true], ['main', false]]);
  });

  it('keeps a library of steps and sequences that only the human changes, and refuses wiring that cannot run', async () => {
    assert.equal((await s.api('POST', '/api/deploy/steps', { name: 'x', project: 'Sportsteam', pipelineId: 11 })).status, 403);
    const build = await s.ok('POST', '/api/deploy/steps', { name: 'Build placement', project: 'Sportsteam', pipelineId: 11 }, USER);
    const deploy = await s.ok('POST', '/api/deploy/steps', { name: 'Deploy placement', project: 'Sportsteam', pipelineId: 12, branch: 'main', templateParameters: { environment: 'int' } }, USER);
    await s.ok('POST', '/api/deploy/steps', { name: 'Migrate', project: 'Sportsteam', pipelineId: 13 }, USER);
    assert.deepEqual([build.id, deploy.id], ['build-placement', 'deploy-placement']);
    const later = await s.api('POST', '/api/deploy/sequences', { name: 'Bad', items: [{ stepId: 'build-placement', bindings: [{ name: 'x', kind: 'step', ref: '1.tag' }] }, { stepId: 'deploy-placement' }] }, USER);
    assert.equal(later.status, 400, 'a step can only take from a step before it');
    const seq = await s.ok('POST', '/api/deploy/sequences', {
      name: 'Ship placement',
      inputs: [{ id: 'env', name: 'Environment', kind: 'environment', default: 'int', sourceProject: 'Sportsteam', sourcePipelineId: 12, sourceParameter: 'environment' }],
      items: [{ stepId: 'build-placement' }, { stepId: 'deploy-placement', bindings: [{ name: 'environment', kind: 'input', ref: 'env' }, { name: 'imageTag', kind: 'step', ref: '0.tag' }] }],
    }, USER);
    assert.equal(seq.id, 'ship-placement');
    assert.equal((await s.api('DELETE', '/api/deploy/steps/build-placement', undefined, USER)).status, 409, 'a step a sequence uses stays');
  });

  it('runs a sequence in order, handing the build\'s image tag to the deploy, and tags each run', async () => {
    const before = ado.triggers.length;
    const run = await s.ok('POST', '/api/deploy/sequences/ship-placement/run', { inputs: { env: 'test1' } }, USER);
    const done = await finished(run.id);
    assert.equal(done.status, 'succeeded');
    const [b, d] = ado.triggers.slice(before);
    assert.deepEqual([b.pipelineId, d.pipelineId], [11, 12]);
    assert.equal(b.body.resources.repositories.self.refName, 'refs/heads/main', 'no branch: the pipeline\'s default');
    assert.deepEqual(d.body.templateParameters, { environment: 'test1', imageTag: `main.20261027.${b.id}` });
    assert.deepEqual(done.steps.map((x) => [x.state, x.result, x.webUrl]), [['completed', 'succeeded', `https://ado.example/build/${b.id}`], ['completed', 'succeeded', `https://ado.example/build/${d.id}`]]);
  });

  it('stops at a failed step and skips the rest', async () => {
    const before = ado.triggers.length;
    ado.failNext.add(11);
    const done = await finished((await s.ok('POST', '/api/deploy/sequences/ship-placement/run', {}, USER)).id);
    assert.equal(done.status, 'failed');
    assert.deepEqual(done.steps.map((x) => x.state), ['completed', 'skipped']);
    assert.equal(ado.triggers.length - before, 1, 'the deploy never started');
  });

  it('lets an agent run what its grant covers, and wakes it when the run ends', async () => {
    const run = await s.ok('POST', '/api/deploy/sequences/ship-placement/run', { inputs: { env: 'test1' }, item: 't-1' }, { agent: 'deployer' });
    assert.equal(run.status, 'running');
    assert.equal(run.item, 'T-1');
    assert.equal((await finished(run.id)).status, 'succeeded');
    const ev = await until(async () => (await s.ok('GET', '/api/events?types=deploy.run.finished&tail=true')).events.find((e) => e.run.id === run.id), 5000, 'the finished event');
    assert.deepEqual(ev.recipients, ['deployer']);
  });

  it('files a run outside the conditions but inside an approve grant as waiting, and runs it once the human says OK', async () => {
    const run = await s.ok('POST', '/api/deploy/steps/deploy-placement/run', { parameters: { environment: 'prod' } }, { agent: 'deployer' });
    assert.equal(run.status, 'waiting');
    assert.equal((await s.api('POST', `/api/deploy/runs/${run.id}/approve`, {}, { agent: 'deployer' })).status, 403, 'an agent never approves');
    assert.ok((await s.ok('GET', '/api/events?types=deploy.run.requested&tail=true')).events.some((e) => e.run.id === run.id));
    await s.ok('POST', `/api/deploy/runs/${run.id}/approve`, {}, USER);
    const done = await finished(run.id);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.steps[0].parameters.environment, 'prod');
    assert.equal(done.approval.by, 'James');
  });

  it('a double-clicked Approve starts the run once: the second finds it no longer waiting', async () => {
    const run = await s.ok('POST', '/api/deploy/steps/deploy-placement/run', { parameters: { environment: 'prod' } }, { agent: 'deployer' });
    const before = ado.triggers.length;
    const both = await Promise.all([1, 2].map(() => s.api('POST', `/api/deploy/runs/${run.id}/approve`, {}, USER)));
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    await finished(run.id);
    assert.equal(ado.triggers.length - before, 1, 'one pipeline run, not two');
  });

  it('on a board with no sign-in token, X-User cannot run or change deployments: anyone could send it', async () => {
    const open = await startServer({ agents: { agents: {} } });
    try {
      const r = await open.api('PUT', '/api/deploy/connection', { org: 'acme', pat: PAT }, HUMAN);
      assert.deepEqual([r.status, r.body.code], [403, 'NO_TOKEN']);
      assert.equal((await open.api('PUT', '/api/jira/connection', { url: 'https://j.example', username: 'u', password: 'p' }, HUMAN)).body.code, 'NO_TOKEN');
      assert.equal((await open.api('GET', '/api/deploy', undefined, HUMAN)).status, 200, 'reading stays open');
    } finally { await open.stop(); }
  });

  it('refuses a deployment the agent holds no grant of, and a value outside the grant it holds', async () => {
    const none = await s.api('POST', '/api/deploy/steps/migrate/run', {}, { agent: 'deployer' });
    assert.deepEqual([none.status, none.body.code], [403, 'HUMAN_ONLY']);
    assert.match(none.body.hint, /deploy\.step\.migrate/, 'the hint names the permission to grant');
    const env = await s.api('POST', '/api/deploy/sequences/ship-placement/run', { inputs: { env: 'prod' } }, { agent: 'deployer' });
    assert.deepEqual([env.status, env.body.code], [403, 'OUT_OF_SCOPE']);
    assert.match(env.body.error, /inputs\.env is "prod", the grant allows int, test1/);
  });

  it('holds a sequence by its own permission alone, never by the steps in it', async () => {
    const before = ado.triggers.length;
    // tagger holds the deploy step, not the sequence that runs it
    const refused = await s.api('POST', '/api/deploy/sequences/ship-placement/run', {}, { agent: 'tagger' });
    assert.deepEqual([refused.status, refused.body.code], [403, 'HUMAN_ONLY']);
    assert.equal(ado.triggers.length, before, 'nothing was triggered');
  });

  it('lets an agent stop only its own runs', async () => {
    const waiting = await s.ok('POST', '/api/deploy/steps/deploy-placement/run', { parameters: { environment: 'prod' } }, { agent: 'deployer' });
    assert.equal((await s.api('POST', `/api/deploy/runs/${waiting.id}/cancel`, {}, { agent: 'tagger' })).status, 403);
    assert.equal((await s.ok('POST', `/api/deploy/runs/${waiting.id}/cancel`, {}, { agent: 'deployer' })).status, 'canceled');
  });

  it('lists each deployment as a read-only permission, says who holds it, and drops it with the deployment', async () => {
    const lib = await s.ok('GET', '/api/permissions', undefined, USER);
    const all = lib.permissions || lib;
    const step = all.find((x) => x.key === 'deploy.step.deploy-placement');
    assert.deepEqual([step.kind, step.name, step.heldBy, step.builtin], ['deployment', 'Run Deploy placement', 'grants', true]);
    assert.ok(all.some((x) => x.key === 'deploy.sequence.ship-placement'));
    assert.ok(!all.some((x) => x.key === 'deploy.run'), 'no catch-all deployment power');
    assert.notEqual((await s.api('DELETE', '/api/permissions/deploy.step.deploy-placement', undefined, USER)).status, 200, 'not removable from the library');
    const listed = (await s.ok('GET', '/api/deploy/steps', undefined, USER)).find((x) => x.id === 'deploy-placement');
    assert.equal(listed.power, 'deploy.step.deploy-placement');
    assert.deepEqual(listed.holders.map((h) => [h.name, h.approve || null]), [['deployer', null], ['deployer', 'human'], ['tagger', null]]);
    const me = await s.ok('GET', '/api/deploy', undefined, { agent: 'deployer' });
    assert.deepEqual(me.you.grants.map((g) => g.power), ['deploy.sequence.ship-placement', 'deploy.step.deploy-placement', 'deploy.step.deploy-placement']);
    await s.ok('POST', '/api/deploy/steps', { name: 'Smoke test', project: 'Sportsteam', pipelineId: 13 }, USER);
    const libWith = await s.ok('GET', '/api/permissions', undefined, USER);
    assert.ok((libWith.permissions || libWith).some((x) => x.key === 'deploy.step.smoke-test'), 'a new step is a permission at once');
    await s.ok('DELETE', '/api/deploy/steps/smoke-test', undefined, USER);
    const libAfter = await s.ok('GET', '/api/permissions', undefined, USER);
    assert.ok(!(libAfter.permissions || libAfter).some((x) => x.key === 'deploy.step.smoke-test'), 'and goes with it');
  });

  it('builds the ticket\'s branch: its branch field, else the newest branch naming its id or Jira key; a branch sent with the run wins', async () => {
    await s.ok('POST', '/api/deploy/steps', { name: 'Build ticket', project: 'Sportsteam', pipelineId: 11, branch: '__ticket__' }, USER);
    const t = await s.ok('POST', '/api/boards/main/items', { title: 'Odds cache', column: 'Ready' }, USER);
    const jira = await s.ok('POST', '/api/boards/main/items', { title: 'BET-77 Settle voids', column: 'Ready' }, USER);
    ado.branches.push(`feature/${t.id}0-other`, `feature/${t.id}-odds-cache`, 'bugfix/bet-77-voids');
    const built = async (body) => {
      const before = ado.triggers.length;
      const done = await finished((await s.ok('POST', '/api/deploy/steps/build-ticket/run', body, USER)).id);
      return [done.status, ado.triggers.slice(before).map((x) => x.body.resources.repositories.self.refName)[0] || done.steps[0].message];
    };
    assert.deepEqual(await built({ item: t.id }), ['succeeded', `refs/heads/feature/${t.id}-odds-cache`], `${t.id}0 is another ticket`);
    assert.deepEqual(await built({ item: jira.id }), ['succeeded', 'refs/heads/bugfix/bet-77-voids'], 'by its Jira key, in any case');
    assert.deepEqual(await built({ item: t.id, branch: 'feature/hand-picked' }), ['succeeded', 'refs/heads/feature/hand-picked']);
    await s.ok('PATCH', `/api/boards/main/items/${t.id}`, { properties: { branch: 'release/odds' } }, USER);
    assert.deepEqual(await built({ item: t.id }), ['succeeded', 'refs/heads/release/odds'], 'the ticket says its branch');
    const lone = await s.ok('POST', '/api/boards/main/items', { title: 'Nothing pushed', column: 'Ready' }, USER);
    const [st, why] = await built({ item: lone.id });
    assert.equal(st, 'failed');
    assert.match(why, new RegExp(`No branch of the pipeline's repository names ${lone.id}: push one`), 'never the default branch instead');
    assert.match((await built({}))[1], /names no ticket/);
    // each run shows on its ticket's Activity: started and finished, with the branch; never each poll's update
    const hist = await s.ok('GET', `/api/boards/main/items/${t.id}/history`, undefined, USER);
    const runs = hist.filter((e) => e.type.startsWith('deploy.run.'));
    assert.ok(runs.some((e) => e.type === 'deploy.run.finished' && e.run.steps[0].branch === `feature/${t.id}-odds-cache`));
    assert.ok(runs.length && !runs.some((e) => e.type === 'deploy.run.updated'));
  });
});

describe('Deployments: each one a cell in Assignments', () => {
  const TOKEN = 'grid-token';
  let s;
  const human = (method, p, body) => fetch(`${s.base}${p}`, { method, headers: { 'content-type': 'application/json', 'x-user': 'James', origin: s.base, authorization: `Bearer ${TOKEN}` }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const KEY = 'deploy.step.deploy-placement';
  before(async () => {
    s = await startServer({ manifest: { auth: { userToken: TOKEN, requireAgentTokens: false } }, agents: { agents: { shipper: { enabled: false, role: 'builder' } } } });
    assert.equal((await human('POST', '/api/deploy/steps', { name: 'Deploy placement', project: 'Sportsteam', pipelineId: 12 })).status, 201);
    assert.equal((await human('POST', '/api/deploy/sequences', { name: 'Ship', inputs: [{ id: 'env', name: 'Environment' }], items: [{ stepId: 'deploy-placement' }] })).status, 201);
  });
  after(() => s?.stop());

  it('shows each deployment as a column, and sets its rules and "waits for your OK" per agent', async () => {
    const grid = await s.ok('GET', '/api/agents/grid');
    assert.ok(grid.permissions.some((p) => p.key === KEY && p.kind === 'deployment'));
    const r = await human('PUT', `/api/agents/shipper/permissions/${KEY}`, { mode: 'rules', rules: { where: { 'parameters.environment': ['int', 'test1'], branch: 'release/*' }, approve: 'human' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'agents.json'), 'utf8')).agents.shipper.grants;
    assert.deepEqual(saved, [{ power: KEY, where: { 'parameters.environment': ['int', 'test1'], branch: 'release/*' }, approve: 'human' }]);
    const c = (await s.ok('GET', '/api/agents/grid')).agents.find((a) => a.name === 'shipper').cells[KEY];
    assert.equal(c.mode, 'rules');
    assert.equal(c.rules.approve, 'human');
    assert.match(c.brief[0], /\*\*deploy\.step\.deploy-placement\*\* — Run the deployment step "Deploy placement".*each run waits for the human's OK.*POST \/api\/deploy\/steps\/deploy-placement\/run/);
    assert.equal((await human('PUT', '/api/agents/shipper/permissions/deploy.sequence.ship', { mode: 'rules', rules: { where: { 'inputs.env': 'int' } } })).status, 200, 'a sequence takes inputs');
  });

  it('refuses rules a deployment cannot take, and "approve" on anything else', async () => {
    assert.equal((await human('PUT', `/api/agents/shipper/permissions/${KEY}`, { mode: 'rules', rules: { where: { 'fields.risk': 'low' } } })).status, 400);
    assert.equal((await human('PUT', `/api/agents/shipper/permissions/${KEY}`, { mode: 'rules', rules: { where: { 'inputs.env': 'int' } } })).status, 400, 'a step has no inputs');
    assert.equal((await human('PUT', '/api/agents/shipper/permissions/review.decide', { mode: 'rules', rules: { approve: 'human' } })).status, 400);
    assert.equal((await human('PUT', `/api/agents/shipper/permissions/${KEY}`, { mode: 'rules', rules: { approve: 'later' } })).status, 400);
  });

  it('takes an agent\'s grants of a deployment away when the deployment is deleted', async () => {
    const r = await human('DELETE', '/api/deploy/sequences/ship');
    assert.deepEqual(r.body.grantsDropped, ['shipper']);
    const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'agents.json'), 'utf8')).agents.shipper.grants;
    assert.deepEqual(saved.map((g) => g.power), [KEY], 'the step\'s grant stays');
  });
});

describe('Deployments: a grant that checks a handed-on value', () => {
  let ado, s;
  before(async () => {
    ado = fakeAdo();
    await new Promise((r) => ado.server.listen(0, '127.0.0.1', r));
    s = await startServer({
      env: { INTELLAGENT_ADO_URL: `http://127.0.0.1:${ado.server.address().port}`, INTELLAGENT_DEPLOY_POLL_MS: '30', INTELLAGENT_ADO_ORG: 'acme', INTELLAGENT_ADO_PAT: PAT },
      // the build sends no imageTag, so the rule binds only the deploy, whose tag the build hands on
      manifest: { auth: AUTH, permissions: { tagger: { grants: [{ power: 'deploy.sequence.ship', where: { 'parameters.imageTag': 'release.*' } }] } } },
    });
    await s.ok('POST', '/api/deploy/steps', { name: 'Build', project: 'Sportsteam', pipelineId: 11 }, USER);
    await s.ok('POST', '/api/deploy/steps', { name: 'Deploy', project: 'Sportsteam', pipelineId: 12 }, USER);
    await s.ok('POST', '/api/deploy/sequences', { name: 'Ship', items: [{ stepId: 'build' }, { stepId: 'deploy', bindings: [{ name: 'imageTag', kind: 'step', ref: '0.tag' }] }] }, USER);
  });
  after(async () => { await s?.stop(); ado?.server.close(); });

  it('lets the run start, then stops it before the step whose real value is outside the grant', async () => {
    const run = await s.ok('POST', '/api/deploy/sequences/ship/run', {}, { agent: 'tagger' });
    assert.equal(run.status, 'running', 'the tag is not known yet, so it may start');
    const done = await until(async () => { const r = await s.ok('GET', `/api/deploy/runs/${run.id}`); return r.status !== 'running' && r; }, 10000, 'the run to end');
    assert.equal(done.status, 'failed');
    assert.equal(done.steps[0].result, 'succeeded');
    assert.match(done.steps[1].message, /parameters\.imageTag is "main\.20261027\.\d+", the grant allows release\.\*/);
    assert.equal(ado.triggers.length, 1, 'the deploy was never triggered');
  });

  it('uses a token from the environment when local.json has none, and says so', async () => {
    const v = await s.ok('GET', '/api/deploy', undefined, USER);
    assert.deepEqual([v.connected, v.source], [true, 'env']);
  });
});
