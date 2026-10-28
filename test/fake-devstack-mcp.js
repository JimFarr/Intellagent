// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Stand-in for the devstack MCP server (sb-hygiene tools/devstack-mcp), over stdio JSON-RPC as the real one speaks:
// devstack_status answers ready; devstack_gate / devstack_test start run "r1" and note their arguments in
// FAKE_DS_LOG; devstack_run_result says running once, then finished with FAKE_DS_VERDICT (default PASS).
const fs = require('fs');
let polls = 0;
const reply = (id, obj) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(obj) }] } })}\n`);
const note = (x) => { if (process.env.FAKE_DS_LOG) fs.appendFileSync(process.env.FAKE_DS_LOG, `${JSON.stringify(x)}\n`); };
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-devstack', version: '0' } } })}\n`); continue; }
    if (m.method !== 'tools/call') continue;
    const { name, arguments: args } = m.params;
    note({ tool: name, args, env: { url: process.env.DEVSTACK_URL, agent: process.env.DEVSTACK_AGENT, leaked: Object.keys(process.env).filter((k) => k.startsWith('INTELLAGENT_')) } });
    if (name === 'devstack_status') reply(m.id, { ok: true, ready: true, lease: { holder: null } });
    else if (name === 'devstack_gate' || name === 'devstack_test') { polls = 0; reply(m.id, { ok: true, state: 'started', runId: 'r1' }); }
    else if (name === 'devstack_run_result') {
      if (args.cancel) { reply(m.id, { ok: true, state: 'cancelling', runId: 'r1' }); continue; }
      const verdict = process.env.FAKE_DS_VERDICT || 'PASS';
      reply(m.id, ++polls < 2 ? { ok: true, state: 'running', step: 'regression', runId: 'r1' }
        : { ok: verdict === 'PASS', state: 'finished', runId: 'r1', verdict, reasons: verdict === 'PASS' ? [] : ['2 tests failed'], section: `### DevStack\n${verdict}` });
    } else reply(m.id, { ok: false, code: 'unknown', message: `no tool ${name}` });
  }
});
