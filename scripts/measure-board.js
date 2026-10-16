#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Measure what a big board costs (INT-11, INT-142, INT-155): load, save, the board payload, and what the
// browser spends redrawing it on each change and during a burst of agent writes.
// It builds a throwaway board in a temp folder by cloning the tickets of a real one, so comments, flow and
// reviews have real shapes, and starts its own server on it. The real board is only read.
//
//   intellagent api GET /api/boards/main > board.json
//   node scripts/measure-board.js --from board.json [--items 2000] [--writes 20] [--burst 40] [--agents 7] [--human-burst 100] [--no-ui] [--json]
//
// The UI part drives a headless Edge or Chrome over the DevTools protocol (no dependencies); --browser <exe>
// picks one. Main-thread time comes from Performance.getMetrics (TaskDuration and its parts).
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('../test/helpers');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const flag = (k) => args.includes(`--${k}`);
const N = Number(opt('items', 2000));
const WRITES = Number(opt('writes', 20));
const BURST = Number(opt('burst', 40));
// INT-154: --agents <n> defines n standing agents (named after this board's team, so the cloned tickets'
// comments put them in their inboxes; the usual mix of listen settings). They are disabled, so nothing ever
// runs and their queues only grow: the scheduler's worst case. --human-burst <n> human edits are timed with
// a reader polling GET …/summary alongside, for what the UI's requests wait meanwhile.
const AGENTS = Number(opt('agents', 0));
const HUMAN_BURST = Number(opt('human-burst', 100));
const TEAM = ['gamora', 'rocket', 'nebula', 'quill', 'cosmo', 'mantis', 'drax', 'yondu', 'groot', 'kraglin'];
const LISTEN = [['addressed', 'new-tickets'], 'inbox', 'inbox', 'human', 'addressed', 'inbox', 'human'];
const agentsJson = (n) => (n ? {
  defaults: { worktree: false },
  agents: Object.fromEntries(Array.from({ length: n }, (_, i) => [`${TEAM[i % TEAM.length]}${i >= TEAM.length ? i : ''}`, { enabled: false, listen: LISTEN[i % LISTEN.length], run: 'node -e 0' }])),
} : undefined);
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(0.95 * (s.length - 1))] : 0; };

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const kb = (n) => Math.round(n / 1024);
const sleep = (t) => new Promise((r) => setTimeout(r, t));

// Clone the source tickets round-robin up to n, keeping each one's column. Ids run 1..n, so parent and
// blockedBy references to the source's own ids still point at a ticket. Leases are dropped (no expiry noise).
function buildBoard(src, n) {
  const b = JSON.parse(JSON.stringify(src));
  const colOf = {};
  for (const c of b.columns) for (const id of c.itemIds) colOf[id] = c.id;
  const srcItems = Object.values(src.items);
  const ids = new Set(Array.from({ length: n }, (_, i) => `${b.idPrefix}-${i + 1}`));
  b.items = {};
  for (const c of b.columns) c.itemIds = [];
  for (let i = 0; i < n; i++) {
    const s = srcItems[i % srcItems.length];
    const it = JSON.parse(JSON.stringify(s));
    it.id = `${b.idPrefix}-${i + 1}`;
    it.lease = null;
    it.blockedBy = (it.blockedBy || []).filter((x) => ids.has(x));
    if (it.parent && !ids.has(it.parent)) it.parent = null;
    b.items[it.id] = it;
    const col = b.columns.find((c) => c.id === (colOf[s.id] || s.columnId)) || b.columns[0];
    it.columnId = col.id;
    col.itemIds.push(it.id);
  }
  b.nextNumber = n + 1;
  b.master = null;
  return b;
}

// What one tx() write does to the whole board, outside the server: three stringifies, a hash, a file write.
function txParts(board, dir) {
  const file = path.join(dir, 'probe.json');
  const runs = 5;
  const t = { stringifyCompact: [], stringifyPretty: [], sha256: [], write: [], parse: [] };
  for (let i = 0; i < runs; i++) {
    let t0 = process.hrtime.bigint(); const c = JSON.stringify(board); t.stringifyCompact.push(ms(t0));
    t0 = process.hrtime.bigint(); const p = JSON.stringify(board, null, 2); t.stringifyPretty.push(ms(t0));
    t0 = process.hrtime.bigint(); crypto.createHash('sha256').update(p).digest('hex'); t.sha256.push(ms(t0));
    t0 = process.hrtime.bigint(); fs.writeFileSync(file, p); t.write.push(ms(t0));
    t0 = process.hrtime.bigint(); JSON.parse(c); t.parse.push(ms(t0));
  }
  const m = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, +median(v).toFixed(1)]));
  // tx(): compact before + compact after (compare) + pretty in persist + sha256 + write
  m.txEstimate = +(2 * m.stringifyCompact + m.stringifyPretty + m.sha256 + m.write).toFixed(1);
  return m;
}

/* ───────── DevTools protocol, just enough ───────── */

function findBrowser() {
  const given = opt('browser');
  const list = given ? [given] : [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return list.find((p) => fs.existsSync(p)) || null;
}

async function openBrowser(exe, url) {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-measure-browser-'));
  const proc = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new',
    '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up */ }
    if (!target) await sleep(100);
  }
  if (!target) { proc.kill(); throw new Error('browser did not start'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let next = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
    else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++next; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('Performance.enable', { timeDomain: 'threadTicks' });
  await send('Network.enable');
  await send('Page.enable');
  // board fetches the page makes, with their sizes
  const fetches = [];
  const reqs = new Map();
  listeners.push((m) => {
    if (m.method === 'Network.requestWillBeSent') reqs.set(m.params.requestId, m.params.request.url);
    if (m.method === 'Network.loadingFinished') {
      const u = reqs.get(m.params.requestId) || '';
      fetches.push({ url: u, bytes: m.params.encodedDataLength, at: Date.now() });
    }
  });
  const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  await send('Page.navigate', { url });
  const close = async () => { try { ws.close(); } catch { /* gone */ } proc.kill(); await sleep(300); try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ } };
  return { send, metrics, fetches, close };
}

const isBoardFetch = (u) => /\/api\/boards\/[^/?]+$/.test(u.split('?')[0]);
const isBoardsList = (u) => /\/api\/boards$/.test(u.split('?')[0]);
const DUR = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'];
const delta = (a, b) => Object.fromEntries(DUR.map((k) => [k, (b[k] - a[k]) * 1000]));

// Waits until no board fetch has finished for quietMs (and at least one did, if expectFetch).
async function settle(br, since, { quietMs = 400, maxMs = 15000, expectFetch = true } = {}) {
  const end = Date.now() + maxMs;
  for (;;) {
    const mine = br.fetches.filter((f) => f.at >= since && isBoardFetch(f.url));
    const last = mine.length ? mine[mine.length - 1].at : 0;
    if ((!expectFetch || mine.length) && Date.now() - Math.max(last, since) > quietMs) return;
    if (Date.now() > end) return;
    await sleep(50);
  }
}

async function main() {
  const fromFile = opt('from');
  if (!fromFile) { console.error('Usage: node scripts/measure-board.js --from <board.json from GET /api/boards/main> [--items 2000]'); process.exit(2); }
  const raw = JSON.parse(fs.readFileSync(fromFile, 'utf8').replace(/^\uFEFF/, ''));
  const src = raw.board || raw;
  const board = buildBoard(src, N);
  const out = { source: { items: Object.keys(src.items).length, comments: Object.values(src.items).reduce((n, i) => n + (i.comments || []).length, 0) }, items: N };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-measure-'));
  const bdir = path.join(dir, 'data', 'boards', board.id);
  fs.mkdirSync(bdir, { recursive: true });
  const text = JSON.stringify(board, null, 2);
  fs.writeFileSync(path.join(bdir, 'board.json'), text);
  fs.writeFileSync(path.join(bdir, 'archive.json'), JSON.stringify({ items: {} }));
  out.disk = { boardJsonKB: kb(Buffer.byteLength(text)), comments: Object.values(board.items).reduce((n, i) => n + (i.comments || []).length, 0) };
  out.tx = txParts(board, dir);

  let t0 = process.hrtime.bigint();
  const s = await startServer({ dir, manifest: { idPrefix: board.idPrefix }, agents: agentsJson(AGENTS) });
  out.bootMs = Math.round(ms(t0));
  const B = `/api/boards/${board.id}`;
  const ids = Object.keys(board.items);
  const pick = (i) => ids[(i * 97) % ids.length];
  try {
    const get = async (p) => { const t = process.hrtime.bigint(); const r = await fetch(s.base + p, { headers: { 'x-agent': 'measure' } }); const body = await r.arrayBuffer(); return { ms: ms(t), bytes: body.byteLength }; };
    const gb = []; const gl = []; let bytes = 0; let listBytes = 0;
    for (let i = 0; i < 10; i++) { const r = await get(B); gb.push(r.ms); bytes = r.bytes; const l = await get('/api/boards'); gl.push(l.ms); listBytes = l.bytes; }
    out.getBoard = { KB: kb(bytes), medianMs: +median(gb).toFixed(1) };
    out.getBoards = { bytes: listBytes, medianMs: +median(gl).toFixed(1) };
    const sum = await get(`${B}/summary`);
    out.getSummary = { KB: kb(sum.bytes), ms: +sum.ms.toFixed(1) };

    const wr = [];
    for (let i = 0; i < WRITES; i++) {
      const t = process.hrtime.bigint();
      await s.ok('PATCH', `${B}/items/${pick(i)}`, { properties: { measure: i } }, { agent: 'measure' });
      wr.push(ms(t));
    }
    out.write = { medianMs: +median(wr).toFixed(1), maxMs: +Math.max(...wr).toFixed(1), writesPerSecond: +(1000 / median(wr)).toFixed(1) };

    // human edits wake standing agents (INT-154): the writes' own latency, and a reader's alongside them
    if (HUMAN_BURST) {
      const stateFile = path.join(dir, 'data', 'agents.state.json');
      let reading = true;
      const lat = [];
      const reader = (async () => { while (reading) { lat.push((await get(`${B}/summary`)).ms); await sleep(10); } })();
      const hw = [];
      for (let i = 0; i < HUMAN_BURST; i++) {
        const t = process.hrtime.bigint();
        await s.ok('PATCH', `${B}/items/${pick(3000 + i)}`, { properties: { human: i } }, { user: 'James' });
        hw.push(ms(t));
      }
      reading = false;
      await reader;
      const team = AGENTS ? (await s.ok('GET', '/api/agents', undefined, { user: 'James' })).agents : [];
      out.humanBurst = {
        writes: HUMAN_BURST, agents: AGENTS,
        writeMedianMs: +median(hw).toFixed(1), writeP95Ms: +p95(hw).toFixed(1),
        readerMedianMs: +median(lat).toFixed(1), readerP95Ms: +p95(lat).toFixed(1), reads: lat.length,
        queuedEvents: team.reduce((n, a) => n + (a.queued || 0), 0),
        stateKB: fs.existsSync(stateFile) ? kb(fs.statSync(stateFile).size) : 0,
      };
    }

    const exe = flag('no-ui') ? null : findBrowser();
    if (!flag('no-ui') && !exe) out.ui = 'skipped: no Edge or Chrome found (--browser <exe>)';
    if (exe) {
      const br = await openBrowser(exe, `${s.base}/#/${board.id}`);
      try {
        // first paint: until the board has loaded and the page is quiet
        let since = Date.now();
        await settle(br, since, { quietMs: 1500, maxMs: 30000 });
        await sleep(1000);
        const first = await br.metrics();
        out.ui = { firstLoad: { TaskMs: Math.round(first.TaskDuration * 1000), ScriptMs: Math.round(first.ScriptDuration * 1000), LayoutMs: Math.round(first.LayoutDuration * 1000), Nodes: first.Nodes } };

        // idle: what the page costs with nothing happening (timers, presence, listeners)
        const a0 = await br.metrics(); since = Date.now();
        await sleep(10000);
        const a1 = await br.metrics();
        out.ui.idle10s = { TaskMs: Math.round(delta(a0, a1).TaskDuration), boardFetches: br.fetches.filter((f) => f.at >= since && isBoardFetch(f.url)).length };

        // one event at a time: a write, then wait for the page to refetch and redraw
        const per = [];
        for (let i = 0; i < Math.min(WRITES, 10); i++) {
          const m0 = await br.metrics(); since = Date.now();
          await s.ok('PATCH', `${B}/items/${pick(1000 + i)}`, { properties: { ui: i } }, { agent: 'measure' });
          await settle(br, since);
          const m1 = await br.metrics();
          const f = br.fetches.filter((x) => x.at >= since);
          per.push({ ...delta(m0, m1), boardFetches: f.filter((x) => isBoardFetch(x.url)).length, listFetches: f.filter((x) => isBoardsList(x.url)).length, KB: kb(f.reduce((n, x) => n + x.bytes, 0)) });
        }
        out.ui.perEvent = Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'boardFetches', 'listFetches', 'KB']
          .map((k) => [k, Math.round(median(per.map((p) => p[k])))]));

        // a burst: BURST writes back to back, like several agents working at once
        const b0 = await br.metrics(); since = Date.now();
        const tb = process.hrtime.bigint();
        for (let i = 0; i < BURST; i++) await s.ok('PATCH', `${B}/items/${pick(2000 + i)}`, { properties: { burst: i } }, { agent: `agent${i % 4}` });
        const burstMs = ms(tb);
        await settle(br, since, { quietMs: 1000 });
        const b1 = await br.metrics();
        const f = br.fetches.filter((x) => x.at >= since);
        const d = delta(b0, b1);
        out.ui.burst = {
          writes: BURST, writesOverMs: Math.round(burstMs),
          boardFetches: f.filter((x) => isBoardFetch(x.url)).length, listFetches: f.filter((x) => isBoardsList(x.url)).length,
          MB: +(f.reduce((n, x) => n + x.bytes, 0) / 1048576).toFixed(1),
          TaskMs: Math.round(d.TaskDuration), ScriptMs: Math.round(d.ScriptDuration), LayoutMs: Math.round(d.LayoutDuration), StyleMs: Math.round(d.RecalcStyleDuration),
        };
      } finally { await br.close(); }
    }
  } finally { await s.stop(); }

  if (flag('json')) { console.log(JSON.stringify(out, null, 2)); return; }
  const L = (k, v) => console.log(`${k.padEnd(22)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  for (const [k, v] of Object.entries(out)) {
    if (k === 'ui' && typeof v === 'object') for (const [k2, v2] of Object.entries(v)) L(`ui.${k2}`, v2);
    else L(k, v);
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
