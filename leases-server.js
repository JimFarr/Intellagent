'use strict';
// The machine's lease program: one per PC, shared by every board (lib/leases.js says what it decides).
// HTTP on 127.0.0.1 only. State is kept in ~/.intellagent/leases.json (INTELLAGENT_LEASES_FILE) across restarts.
//   GET  /status                       capacity, ceiling, floor, live leases, recently ended
//   GET  /machine                      what the processor and the card are doing now, with the ledger beside it
//   POST /ask      { holder, board, cpu, gpuMB, minutes, exclusive, ticket, purpose }   → { granted, lease | reason, freesAt }
//   POST /leases/<id>/renew { minutes }
//   POST /leases/<id>/done
//   PUT  /ceiling  { cpu, gpuMB }
//   POST /shutdown
// Only programs on this PC may drive it, never a web page: the Host must be this address (no DNS rebinding),
// a request carrying an Origin (every browser sends one on a POST) is refused, and writes must say they are JSON
// (a page can send a cross-site text/plain POST without asking first, but not an application/json one).
// Errors are { error, code, hint }, like the board's.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Ledger } = require('./lib/leases');
const machine = require('./lib/machine');

const PORT = Number(process.env.INTELLAGENT_LEASES_PORT) || 7499;
const FILE = process.env.INTELLAGENT_LEASES_FILE || path.join(os.homedir(), '.intellagent', 'leases.json');
const SWEEP_MS = 15_000;

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return undefined; }
}
function save(ledger) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, FILE);
}

async function main() {
  // How much there is to share: every thread, and the first card's memory where one can be read.
  // INTELLAGENT_LEASES_CAPACITY='{"cpu":12,"gpuMB":8192}' overrides it (tests, or a card nvidia-smi cannot see).
  const forced = process.env.INTELLAGENT_LEASES_CAPACITY ? JSON.parse(process.env.INTELLAGENT_LEASES_CAPACITY) : null;
  const card = forced ? null : (await machine.gpus())[0];
  const capacity = forced || { cpu: os.cpus().length, gpuMB: card?.totalMB ?? null };
  const ledger = new Ledger({ capacity, state: load() });
  save(ledger);

  const body = (req) => new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 1e5) reject(fail(413, 'body too large', 'TOO_LARGE', 'Send under 100 kB')); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(fail(400, 'body is not JSON', 'BAD_REQUEST', 'Send a JSON object')); } });
  });
  const send = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  };
  const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  const guard = (req) => {
    if (!hosts.has(String(req.headers.host || '').toLowerCase())) {
      throw fail(403, `Host "${req.headers.host || ''}" is not this program`, 'BAD_HOST', `Call http://127.0.0.1:${PORT} directly`);
    }
    if (req.headers.origin !== undefined) {
      throw fail(403, 'Requests from web pages are refused', 'BAD_ORIGIN', 'Use "intellagent leases …" or call it from a program on this PC, without an Origin header');
    }
    if (req.method !== 'GET' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      throw fail(415, 'Writes must be sent as JSON', 'BAD_REQUEST', 'Send the header content-type: application/json');
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      guard(req);
      const url = new URL(req.url, 'http://x');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const m = p.match(/^\/leases\/([^/]+)\/(renew|done)$/);
      if (req.method === 'GET' && (p === '/' || p === '/status')) return send(res, 200, ledger.status());
      if (req.method === 'GET' && p === '/machine') return send(res, 200, { ...(await machine.reading()), ledger: ledger.status() });
      if (req.method === 'POST' && p === '/ask') {
        const out = ledger.ask(await body(req));
        if (out.granted) save(ledger);
        return send(res, 200, out);
      }
      if (req.method === 'POST' && m) {
        const d = await body(req);
        const out = m[2] === 'renew' ? ledger.renew(m[1], d.minutes) : ledger.done(m[1]);
        save(ledger);
        return send(res, 200, out);
      }
      if (req.method === 'PUT' && p === '/ceiling') {
        const out = ledger.setCeiling(await body(req));
        save(ledger);
        return send(res, 200, { ceiling: out, floor: ledger.floor() });
      }
      if (req.method === 'POST' && p === '/shutdown') {
        send(res, 200, { stopping: true });
        return setImmediate(() => process.exit(0));
      }
      send(res, 404, { error: `No route for ${req.method} ${p}`, code: 'NOT_FOUND', hint: 'See routes', routes: ['GET /status', 'GET /machine', 'POST /ask', 'POST /leases/<id>/renew', 'POST /leases/<id>/done', 'PUT /ceiling', 'POST /shutdown'] });
    } catch (e) {
      send(res, e.status || 500, { error: e.message, code: e.code || CODES[e.status] || 'ERROR', ...(e.hint || HINTS[e.status] ? { hint: e.hint || HINTS[e.status] } : {}) });
    }
  });

  setInterval(() => { if (ledger.sweep().length) save(ledger); }, SWEEP_MS).unref();
  server.listen(PORT, '127.0.0.1', () => console.log(`leases on http://127.0.0.1:${PORT} · ${capacity.cpu} threads${capacity.gpuMB ? `, ${capacity.gpuMB} MB of card` : ''} · ${FILE}`));
}

function fail(status, message, code, hint) { return Object.assign(new Error(message), { status, code, hint }); }
// The ledger's own errors carry only a status (lib/leases.js stays free of HTTP): name them here.
const CODES = { 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 410: 'ENDED' };
const HINTS = { 404: 'intellagent leases status lists the live leases', 410: 'Ask for a new lease' };

main().catch((e) => { console.error(e); process.exit(1); });
