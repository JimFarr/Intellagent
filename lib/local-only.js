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

// An address on this PC or its network: loopback, private, shared (CGNAT), link-local, unique-local, unspecified.
function isPrivateAddress(ip) {
  const a = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = a.startsWith('::ffff:') && require('net').isIPv4(a.slice(7)) ? a.slice(7) : a;
  if (require('net').isIPv4(v4)) {
    const [x, y] = v4.split('.').map(Number);
    return x === 0 || x === 10 || x === 127 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127);
  }
  return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
}

// Why the board must not fetch this address for someone (an agent's avatar URL), or null: https only, and never
// a host that resolves to this PC or its network, so no agent can make the board call what sits behind it.
// shortcut: the name is resolved here and again by fetch, so a host that changes its answer in between (DNS
// rebinding) slips through; pin the address on the request if the board ever fetches anything that matters.
async function publicUrlProblem(url) {
  let u;
  try { u = new URL(url); } catch { return 'it is not a web address'; }
  if (u.protocol !== 'https:') return 'only https addresses are fetched';
  let addrs;
  try { addrs = await require('dns').promises.lookup(u.hostname.replace(/^\[|\]$/g, ''), { all: true }); } catch { return `${u.hostname} does not resolve`; }
  return addrs.some((x) => isPrivateAddress(x.address)) ? `${u.hostname} is on this PC or its network` : null;
}

module.exports = { allowedHosts, hostProblem, jsonProblem, isPrivateAddress, publicUrlProblem };
