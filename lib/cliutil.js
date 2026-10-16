'use strict';
// Small helpers the CLI, the lease commands and the sandbox share.
const net = require('net');

// `--key value`, `--key=value` (the value may contain '='), `--flag`; what is left lands in `_`.
function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const [k, v] = eq < 0 ? [a.slice(2)] : [a.slice(2, eq), a.slice(eq + 1)];
      out[k] = v ?? (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
    } else out._.push(a);
  }
  return out;
}

// Can a server listen on this port (on 127.0.0.1)?
const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
  s.listen(port, '127.0.0.1');
});

// The board's /api/app (an object, truthy) when a board answers at url, else null.
async function alive(url) {
  try { const r = await fetch(`${url}/api/app`); return r.ok ? r.json() : null; } catch { return null; }
}

module.exports = { flags, portFree, alive };
