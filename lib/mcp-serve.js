'use strict';
/* A small stdio MCP server for the authoring tools (plugin-mcp.js, theme-mcp.js): one JSON-RPC message per line.
   tools: [[name, description, properties, required, run(args) → text]]; run may be async and throws to fail. */
function serve({ name, version, instructions, tools }) {
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  async function handle({ id, method, params }) {
    if (id === undefined) return;
    try {
      if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version }, instructions } });
      if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
      if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: tools.map(([n, description, properties, required]) => ({ name: n, description, inputSchema: { type: 'object', properties, required } })) } });
      if (method === 'tools/call') {
        const t = tools.find(([n]) => n === params?.name);
        let text, isError = false;
        try { if (!t) throw new Error(`no tool ${params?.name}`); text = await t[4](params.arguments || {}); } catch (e) { text = `Error: ${e.message}`; isError = true; }
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } });
      }
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (e) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }); }
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
}

// Run directly, or through the CLI's forward() (which requires the file with it as argv[1]); not when a test imports it.
const launched = (mod, file) => require.main === mod || require('node:path').resolve(process.argv[1] || '') === file;

module.exports = { serve, launched };
