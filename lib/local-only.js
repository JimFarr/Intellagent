// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
/* Guards shared by the programs that listen on this PC (the board, the lease program).

   DNS rebinding: a web page on evil.example points its name at 127.0.0.1 and calls the program from the
   browser. Its requests then carry Host (and Origin) "evil.example:<port>", so a same-origin check passes.
   Checking Host against the names this program answers to stops it before anything runs. */

const os = require('os');

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const ANY = ['0.0.0.0', '::', ''];

// The Host headers a program bound to `host`:`port` answers to: loopback always; the bound address when it
// is a real one; every local address when it listens on all of them; plus any names the human added.
function allowedHosts(port, { host = '127.0.0.1', extra = [] } = {}) {
  const names = new Set(LOOPBACK);
  const h = String(host || '').toLowerCase();
  if (ANY.includes(h)) {
    names.add(os.hostname().toLowerCase());
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) names.add(a.family === 'IPv6' || a.family === 6 ? `[${a.address.toLowerCase()}]` : a.address);
    }
  } else names.add(h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);
  const out = new Set([...names].map((n) => `${n}:${port}`));
  for (const e of extra.map((x) => String(x).toLowerCase())) out.add(/^(\[[^\]]+\]|[^:]+):\d+$/.test(e) ? e : `${e}:${port}`);
  return out;
}

// null when the Host is one of ours, else what to refuse with.
function hostProblem(req, hosts, base) {
  if (hosts.has(String(req.headers.host || '').toLowerCase())) return null;
  return { status: 403, error: `Host "${req.headers.host || ''}" is not this program`, code: 'BAD_HOST', hint: `Call ${base} directly` };
}

// null when a write says it is JSON (or is not a write), else what to refuse with.
function jsonProblem(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || /^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return null;
  return { status: 415, error: 'Writes must be sent as JSON', code: 'BAD_REQUEST', hint: 'Send the header content-type: application/json' };
}

module.exports = { allowedHosts, hostProblem, jsonProblem };
