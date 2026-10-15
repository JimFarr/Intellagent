#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/*
 * Intellagent MCP server (stdio). Zero dependencies — thin wrapper over the HTTP API.
 *   claude mcp add intellagent -e INTELLAGENT_AGENT=my-agent -- node /abs/path/intellagent/mcp.js
 * Env: INTELLAGENT_URL (default http://127.0.0.1:7420), INTELLAGENT_AGENT, INTELLAGENT_BOARD (default main),
 *      INTELLAGENT_MCP_PROFILE core (default) | full, or --profile <name>; INTELLAGENT_MCP_TOOLS=name,name for an explicit list
 */
'use strict';

const { baseUrl, defaultAgent, findManifest, NO_BOARD } = require('./lib/locate');
const request = require('./lib/request');
const jsonfile = require('./lib/jsonfile');
const fs = require('fs');
const nodePath = require('path');

const BASE = baseUrl(); // nearest .intellagent/ manifest from the working directory, or INTELLAGENT_URL
// Agent name: INTELLAGENT_AGENT, else the project's default agent (manifest), else the MCP client's own name.
// The project default keeps one identity whether the agent uses the CLI or these tools.
let AGENT = process.env.INTELLAGENT_AGENT || defaultAgent() || 'mcp-agent';
let CLIENT = 'default';
// The name an agent chose when it introduced itself is remembered per MCP client, so it keeps it next session.
const identityFile = () => { const mp = findManifest(); return mp ? nodePath.join(nodePath.dirname(mp), 'cursors', 'mcp-identity.json') : null; };
function savedIdentity() { try { return jsonfile.read(identityFile())[CLIENT] || null; } catch { return null; } }
function setAgent(name) {
  AGENT = name;
  const f = identityFile();
  if (!f || process.env.INTELLAGENT_AGENT) return;
  let m = {};
  try { m = jsonfile.read(f); } catch { /* new */ }
  m[CLIENT] = name;
  fs.mkdirSync(nodePath.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(m, null, 2));
}
const BOARD = process.env.INTELLAGENT_BOARD || 'main';
const VERSION = '1.0.0';

const TOOLS = require('./lib/tools').makeTools({ board: BOARD, agent: () => AGENT, onIdentity: (name) => setAgent(name) });

/* Profiles: which tools are listed (all stay callable by name).
   core  (default) — what an agent uses on nearly every turn; the rest is one CLI call away (skills/intellagent)
   full  — everything (the old behaviour)
   INTELLAGENT_MCP_TOOLS=name,name — an explicit list instead */
const CORE = ['get_briefing', 'get_my_work', 'get_item', 'start_work', 'set_status', 'add_comment', 'ask_human', 'request_review', 'wait_for_events', 'finish_session'];
const argProfile = (() => { const i = process.argv.indexOf('--profile'); return i > 0 ? process.argv[i + 1] : (process.argv.find((x) => x.startsWith('--profile=')) || '').slice(10) || null; })();
const PROFILE = String(process.env.INTELLAGENT_MCP_PROFILE || argProfile || 'core').toLowerCase();
const ALLOW = (process.env.INTELLAGENT_MCP_TOOLS || '').split(',').map((x) => x.trim()).filter(Boolean);
let needsIntro = false; // set at initialize: a new agent also gets introduce_yourself until it has a role
function listed() {
  const names = new Set(TOOLS.map((t) => t[0]));
  if (ALLOW.length) return ALLOW.filter((n) => names.has(n));
  if (PROFILE === 'full') return [...names];
  return [...CORE, ...(needsIntro ? ['introduce_yourself'] : [])];
}

{
  const known = new Set(TOOLS.map((t) => t[0]));
  const unknown = ALLOW.filter((n) => !known.has(n));
  if (unknown.length) process.stderr.write(`intellagent mcp: unknown tool(s) in INTELLAGENT_MCP_TOOLS ignored: ${unknown.join(', ')}\n`);
  if (!ALLOW.length && !['core', 'full'].includes(PROFILE)) process.stderr.write(`intellagent mcp: unknown profile "${PROFILE}", using core\n`);
}
const tools = TOOLS.map(([name, description, properties, required, call]) => ({
  name, description,
  // No per-call "agent" override: one MCP server speaks as one agent (set by INTELLAGENT_AGENT or the project default).
  inputSchema: { type: 'object', properties, required },
  call,
}));

async function callTool(name, args = {}) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Unknown tool ${name}`);
  if (!BASE) return { text: NO_BOARD, isError: true };
  // A tool spec may look something up first (e.g. create-or-update), so it can be async and gets a JSON GET helper.
  const getJson = async (m, p) => (await request.send(m, p, undefined, { agent: AGENT })).json;
  const [method, path, body] = await t.call(args, getJson);
  // AGENT is read after the call: introduce_yourself may have just changed it
  const r = await request.send(method, path, body, { agent: AGENT });
  return { text: r.raw, isError: !r.ok };
}

function send(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`); }

async function handle(msg) {
  const { id: rid, method, params } = msg;
  if (rid === undefined) return; // notification
  try {
    if (method === 'initialize') {
      const client = params?.clientInfo?.name;
      CLIENT = String(client || 'default');
      const saved = !process.env.INTELLAGENT_AGENT && savedIdentity();
      if (saved) AGENT = saved;
      else if (!process.env.INTELLAGENT_AGENT && !defaultAgent() && client) AGENT = String(client).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 64);
      // A new agent (no role on the board yet) starts by asking the human who it should be.
      let intro = '';
      try {
        const res = await request.send('GET', '/api/profiles/me', undefined, { agent: AGENT });
        const me = res.json;
        // an error reply says nothing about the role: do not mistake it for an unintroduced agent
        const unintroduced = BASE && res.ok && !me?.role;
        if (unintroduced) needsIntro = true;
        if (unintroduced) intro = ' FIRST, before any other work: you have not introduced yourself on this board. Ask the human, in one message: (1) your name — blank means you pick a friendly generated one, (2) your role — coordinator, builder, reviewer, researcher, writer or other, (3) your alignment — how you should behave, (4) anything to avoid or focus on. Then call introduce_yourself with the answers.';
      } catch { /* board not running */ }
      return send({ jsonrpc: '2.0', id: rid, result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'intellagent', version: VERSION },
        instructions: BASE
          ? `Kanban shared with the human at ${BASE}. You are "${AGENT}". Call get_briefing first: it says what to do next, how this board works and which calls to use. Work a ticket with start_work → set_status → request_review; ask_human when unsure; finish_session at the end.${listed().length < TOOLS.length ? ' Anything else (search, move, assign, attach, leases, digest, schema) is one CLI call: `intellagent do <operation> key=value` — e.g. `intellagent do search q=payment`, `intellagent do move_item id=INT-12 column=Ready`; `intellagent help <word>` lists the operations and their parameters (the intellagent skill has the full list).' : ''}${intro}`
          : NO_BOARD,
      } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id: rid, result: {} });
    if (method === 'tools/list') {
      const show = new Set(listed());
      return send({ jsonrpc: '2.0', id: rid, result: { tools: tools.filter((t) => show.has(t.name)).map(({ call, ...t }) => t) } });
    }
    if (method === 'tools/call') {
      let out;
      try { out = await callTool(params.name, params.arguments); }
      catch (e) { out = { text: `Error: ${e.message} (is the server running at ${BASE}?)`, isError: true }; }
      return send({ jsonrpc: '2.0', id: rid, result: { content: [{ type: 'text', text: out.text }], isError: out.isError } });
    }
    send({ jsonrpc: '2.0', id: rid, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', id: rid, error: { code: -32603, message: e.message } });
  }
}

let buf = '';
const pending = new Set();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const p = handle(msg).finally(() => pending.delete(p));
    pending.add(p);
  }
});
process.stdin.on('end', async () => { await Promise.allSettled([...pending]); process.exit(0); });
