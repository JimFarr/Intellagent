#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Measure what the Intellagent MCP server costs an agent to carry: the JSON size of its tools/list
// (what the client loads into context), per profile. Usage: node scripts/measure-mcp.js [profile|tools=a,b …]
//   node scripts/measure-mcp.js            → core and full
//   node scripts/measure-mcp.js full        → one profile
//   node scripts/measure-mcp.js tools=get_item,add_comment   → an allow-list
const { spawn } = require('child_process');
const path = require('path');

function toolsList(env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'mcp.js')], {
      // no board needed: tools/list works without one
      env: { ...process.env, INTELLAGENT_URL: 'http://127.0.0.1:1', INTELLAGENT_AGENT: 'measure', ...env },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      const line = out.split('\n').find((l) => l.includes('"id":2'));
      if (line) { p.kill(); resolve(JSON.parse(line).result.tools); }
    });
    p.on('error', reject);
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'measure' } } })}\n`);
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    setTimeout(() => { p.kill(); reject(new Error('mcp.js did not answer tools/list')); }, 10000);
  });
}

async function measure(spec) {
  const env = spec.startsWith('tools=') ? { INTELLAGENT_MCP_TOOLS: spec.slice(6) } : { INTELLAGENT_MCP_PROFILE: spec };
  const tools = await toolsList(env);
  const chars = JSON.stringify(tools).length;
  return { spec, tools: tools.length, chars, approxTokens: Math.round(chars / 4), names: tools.map((t) => t.name) };
}

module.exports = { toolsList, measure };

if (require.main === module) {
  const specs = process.argv.slice(2).length ? process.argv.slice(2) : ['core', 'full'];
  (async () => {
    for (const s of specs) {
      const m = await measure(s);
      console.log(`${m.spec.padEnd(8)} ${String(m.tools).padStart(3)} tools  ${String(m.chars).padStart(6)} chars  ~${m.approxTokens} tokens`);
      if (specs.length === 1 || s !== 'full') console.log(`         ${m.names.join(', ')}`);
    }
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
