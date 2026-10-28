'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* devstack: the local DevStack as an integration. The board talks to the devstack MCP server (sb-hygiene's
   tools/devstack-mcp) the way an agent does, over stdio: that server already queues for the stack's lease, swaps a
   build in, runs the suite, puts everything back and reports a verdict. So a DevStack action is one tool call to
   start (devstack_gate or devstack_test) and long-polls of devstack_run_result until it is finished. The library of
   actions is data/devstack.json; each action is a power (devstack.action.<id>) granted in Assignments. */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

type Obj = Record<string, any>;
class DevstackError extends Error {}

const PROTOCOL = '2025-03-26';
const SERVICES = ['relay', 'settlement-engine', 'middleware-settlement', 'betsearch-api', 'betsearch-importer', 'cashout-importer', 'cashout-api', 'placement', 'bff', 'frontend', 'my-bets'];

// One MCP server process, started on first use and again after it ends. call(tool, args) → the tool's JSON reply.
// command: [executable, ...args]; env: what the server reads (DEVSTACK_URL, DEVSTACK_AGENT).
function createMcp({ command, env = {}, cwd, callTimeoutMs = 240_000 }: { command: string[]; env?: Obj; cwd?: string; callTimeoutMs?: number }) {
  let child: any = null;
  let ready: Promise<void> | null = null;
  let next = 1;
  let buf = '';
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }>();
  const failAll = (why: string) => { for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new DevstackError(why)); } pending.clear(); };

  function send(msg: Obj) { child.stdin.write(`${JSON.stringify(msg)}\n`); }
  function request(method: string, params: Obj, timeoutMs = callTimeoutMs): Promise<any> {
    const id = next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new DevstackError(`the devstack server did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { send({ jsonrpc: '2.0', id, method, params }); } catch (e: any) { clearTimeout(timer); pending.delete(id); reject(new DevstackError(`the devstack server is gone: ${e.message}`)); }
    });
  }
  function start(): Promise<void> {
    if (ready) return ready;
    ready = (async () => {
      const [cmd, ...args] = command;
      // the board's own INTELLAGENT_* (its tokens, the deploy PAT) never reach it
      const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^INTELLAGENT_/i.test(k)));
      child = spawn(cmd, args, { cwd, env: { ...base, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stdin.on('error', () => {});
      child.stderr.on('data', () => {}); // its logs; the replies carry what matters
      child.stdout.on('data', (d: Buffer) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let m: Obj;
          try { m = JSON.parse(line); } catch { continue; }
          const p = m.id != null && pending.get(m.id);
          if (!p) continue;
          pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.error) p.reject(new DevstackError(String(m.error.message || 'the devstack server refused the call')));
          else p.resolve(m.result);
        }
      });
      const gone = (why: string) => { child = null; ready = null; buf = ''; failAll(why); };
      child.on('error', (e: Error) => gone(`the devstack server could not start: ${e.message}`));
      child.on('exit', (code: number) => gone(`the devstack server stopped (exit ${code})`));
      await request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'intellagent', version: '1' } }, 30_000);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })();
    ready.catch(() => { ready = null; });
    return ready;
  }
  // Every devstack tool answers one JSON object in its text content
  async function call(tool: string, args: Obj = {}): Promise<Obj> {
    await start();
    const r = await request('tools/call', { name: tool, arguments: args });
    const text = r?.content?.find((c: Obj) => c.type === 'text')?.text;
    try { return JSON.parse(text); } catch { throw new DevstackError(`${tool} answered something that is not JSON`); }
  }
  function stop() { if (child) { try { child.kill(); } catch { /* gone */ } } child = null; ready = null; }
  return { call, stop, running: () => !!child };
}

// The library: what each action runs. source is the build to test, with placeholders filled per ticket:
// {worktree} (the folder of the agent that worked it), {branch} (its ticket branch), {id}, {field.<key>}…
function createDevstackStore({ file, fail }: { file: string; fail: (s: number, m: string, x?: Obj) => never }) {
  let data: Obj = { actions: [] };
  try { data = { actions: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first use */ }
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, file); };
  const slug = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'action';
  const str = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
  function clean(b: Obj, id: string) {
    const name = str(b.name, 80);
    if (!name) fail(400, 'A DevStack action needs a name', { code: 'BAD_REQUEST', hint: 'e.g. "Regression on the ticket\'s build"' });
    const tool = b.tool === 'test' ? 'test' : b.tool === 'gate' ? 'gate' : fail(400, 'tool is gate (the PR gate: A/B then the full regression, or the affected tests) or test (tests by tag)', { code: 'BAD_REQUEST' });
    const service = str(b.service, 60);
    if (!SERVICES.includes(service)) fail(400, `"${service}" is not a DevStack service`, { code: 'BAD_REQUEST', hint: SERVICES.join(', ') });
    const source = str(b.source, 400) || 'path:{worktree}';
    if (!/^(branch|path|commit|image):\S/.test(source)) fail(400, 'source is branch:<name>, path:<folder>, commit:<sha> or image:<tag>', { code: 'BAD_REQUEST', hint: 'path:{worktree} tests the folder the agent worked in; branch:{branch} its ticket branch (pushed)' });
    const out: Obj = { id, name, tool, service, source };
    if (tool === 'gate') out.kind = b.kind === 'behaviour' ? 'behaviour' : 'upgrade';
    else {
      const tags = (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',')).map((t: unknown) => str(t, 60).replace(/^@/, '')).filter(Boolean).slice(0, 10);
      if (!tags.length) fail(400, 'A test action needs at least one tag', { code: 'BAD_REQUEST', hint: 'e.g. smoke, regression, placement' });
      out.tags = tags;
    }
    return out;
  }
  function saveAction(b: Obj, by: string, id?: string) {
    if (id && !data.actions.some((a: Obj) => a.id === id)) fail(404, `No DevStack action "${id}"`, { code: 'NOT_FOUND' });
    let newId = id;
    if (!newId) { const base = slug(b.name); newId = base; for (let i = 2; data.actions.some((a: Obj) => a.id === newId); i++) newId = `${base}-${i}`; }
    const a = { ...clean(b, newId as string), updatedBy: by, updatedAt: new Date().toISOString() };
    data.actions = id ? data.actions.map((x: Obj) => (x.id === id ? a : x)) : [...data.actions, a];
    save();
    return a;
  }
  function deleteAction(id: string) {
    if (!data.actions.some((a: Obj) => a.id === id)) fail(404, `No DevStack action "${id}"`, { code: 'NOT_FOUND' });
    data.actions = data.actions.filter((a: Obj) => a.id !== id);
    save();
  }
  return { actions: () => data.actions, action: (id: string) => data.actions.find((a: Obj) => a.id === id) || null, saveAction, deleteAction };
}

// The arguments of the tool that starts an action's run
function startCall(a: Obj, source: string, ticket: string | null, why: string) {
  if (a.tool === 'gate') return { tool: 'devstack_gate', args: { service: a.service, source, kind: a.kind, ...(ticket ? { ticket } : {}), why } };
  return { tool: 'devstack_test', args: { tag: a.tags, swap: { [a.service]: source }, why } };
}

module.exports = { createMcp, createDevstackStore, startCall, DevstackError, SERVICES };
