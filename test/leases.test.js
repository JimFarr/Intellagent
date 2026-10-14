'use strict';
// The machine's leases: the ledger's decisions with a fake clock, the card reading, and the program over HTTP.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Ledger } = require('../lib/leases');
const { parseNvidiaSmi } = require('../lib/machine');

const MIN = 60_000;
function clock() {
  let t = Date.parse('2026-10-13T09:00:00Z');
  return { now: () => t, pass: (minutes) => { t += minutes * MIN; } };
}
const machine = (c, extra = {}) => new Ledger({ capacity: { cpu: 12, gpuMB: 8192 }, now: c.now, ...extra });

test('grants what fits under the ceiling and tracks the floor', () => {
  const c = clock();
  const l = machine(c);
  const a = l.ask({ holder: 'natasha', cpu: 11, gpuMB: 2048, minutes: 20, ticket: 'LNZ-3', purpose: 'heat solve' });
  assert.equal(a.granted, true);
  assert.deepEqual(a.floor, { cpu: 11, gpuMB: 2048 });
  assert.equal(a.lease.holder, 'natasha');
  assert.equal(a.lease.expiresAt, '2026-10-13T09:20:00.000Z');
  const b = l.ask({ holder: 'peter', cpu: 1, gpuMB: 500 });
  assert.equal(b.granted, true, 'one thread left, and card to spare');
  assert.deepEqual(l.floor(), { cpu: 12, gpuMB: 2548 });
});

test('says no when there is no room, and when room frees', () => {
  const c = clock();
  const l = machine(c);
  l.ask({ holder: 'tony', cpu: 8, minutes: 30 });
  l.ask({ holder: 'banner', cpu: 3, minutes: 10 });
  const no = l.ask({ holder: 'natasha', cpu: 4 });
  assert.equal(no.granted, false);
  assert.match(no.reason, /no room: 11 threads/);
  assert.equal(no.freesAt, '2026-10-13T09:10:00.000Z', "banner's lease ending leaves 4 threads");
  const big = l.ask({ holder: 'natasha', cpu: 9 });
  assert.equal(big.freesAt, '2026-10-13T09:30:00.000Z', "only tony's ending leaves 9");
});

test('counts the card as well as the threads', () => {
  const l = machine(clock());
  l.ask({ holder: 'tony', cpu: 2, gpuMB: 6000 });
  const no = l.ask({ holder: 'natasha', cpu: 2, gpuMB: 3000 });
  assert.equal(no.granted, false);
  assert.match(no.reason, /6000 MB of card in use of 12 threads, 8192 MB/);
});

test('a request bigger than the ceiling is refused outright, with no time to wait for', () => {
  const l = machine(clock());
  l.setCeiling({ cpu: 6 });
  const no = l.ask({ holder: 'tony', cpu: 8 });
  assert.equal(no.granted, false);
  assert.equal(no.freesAt, null);
  assert.match(no.reason, /more than the ceiling allows \(6 threads/);
});

test('an exclusive lease waits for an empty machine and then keeps everyone else out', () => {
  const c = clock();
  const l = machine(c);
  const a = l.ask({ holder: 'peter', cpu: 1, minutes: 5 });
  const busy = l.ask({ holder: 'tony', exclusive: true, cpu: 11, purpose: 'timing run' });
  assert.equal(busy.granted, false);
  assert.equal(busy.freesAt, '2026-10-13T09:05:00.000Z');
  l.done(a.lease.id);
  const timing = l.ask({ holder: 'tony', exclusive: true, cpu: 11, minutes: 15 });
  assert.equal(timing.granted, true);
  const tiny = l.ask({ holder: 'peter', cpu: 0.5 });
  assert.equal(tiny.granted, false);
  assert.match(tiny.reason, /tony has the machine to itself/);
  assert.equal(tiny.freesAt, '2026-10-13T09:15:00.000Z');
});

test('a lease ends by itself when its time is up, unless renewed', () => {
  const c = clock();
  const l = machine(c);
  const a = l.ask({ holder: 'natasha', cpu: 11, minutes: 10 }).lease;
  c.pass(8);
  l.renew(a.id, 10);
  c.pass(8);
  assert.equal(l.status().leases.length, 1, 'renewed at 8 minutes, so alive at 16');
  c.pass(3);
  assert.deepEqual(l.floor(), { cpu: 0, gpuMB: 0 });
  const recent = l.status().recent[0];
  assert.equal(recent.id, a.id);
  assert.equal(recent.ended, 'expired');
  assert.throws(() => l.renew(a.id), /already ended \(expired\)/);
});

test('no lease outlives the cap, however long it asks for', () => {
  const c = clock();
  const l = machine(c, { maxMinutes: 120 });
  const a = l.ask({ holder: 'tony', cpu: 1, minutes: 600 });
  assert.equal(a.lease.expiresAt, '2026-10-13T11:00:00.000Z');
});

test('lowering the ceiling under the floor keeps leases already granted', () => {
  const l = machine(clock());
  l.ask({ holder: 'tony', cpu: 8 });
  assert.deepEqual(l.setCeiling({ cpu: 4, gpuMB: 99999 }), { cpu: 4, gpuMB: 8192 }, 'never above what the machine has');
  assert.equal(l.status().leases.length, 1);
  assert.equal(l.ask({ holder: 'banner', cpu: 1 }).granted, false);
});

test('without a card, only threads are counted', () => {
  const l = new Ledger({ capacity: { cpu: 4, gpuMB: null }, now: clock().now });
  const a = l.ask({ holder: 'peter', cpu: 2, gpuMB: 99999 });
  assert.equal(a.granted, true);
  assert.equal(a.lease.gpuMB, 0);
});

test('bad requests are refused with a reason', () => {
  const l = machine(clock());
  assert.throws(() => l.ask({ cpu: 1 }), /holder/);
  assert.throws(() => l.ask({ holder: 'x', cpu: -1 }), /cpu must be a number/);
  assert.throws(() => l.ask({ holder: 'x', minutes: 0 }), /minutes/);
  assert.throws(() => l.done('L99'), /no lease L99/);
});

test('picks up where it left off: leases and ceiling survive a restart, expired ones do not', () => {
  const c = clock();
  const l = machine(c);
  l.setCeiling({ cpu: 10 });
  const keep = l.ask({ holder: 'tony', cpu: 4, minutes: 30 }).lease;
  l.ask({ holder: 'peter', cpu: 1, minutes: 5 });
  const saved = JSON.parse(JSON.stringify(l));
  c.pass(10);
  const again = machine(c, { state: saved });
  assert.deepEqual(again.status().leases.map((x) => x.id), [keep.id]);
  assert.equal(again.ceiling.cpu, 10);
  assert.equal(again.ask({ holder: 'banner', cpu: 1 }).lease.id, 'L3', 'ids keep counting');
});

test('records the board beside the holder, so two boards\' natashas stay apart; old leases without one still load', () => {
  const c = clock();
  const l = machine(c);
  const lenza = l.ask({ holder: 'natasha', board: 'Lenza', cpu: 2, exclusive: true, minutes: 10 }).lease;
  assert.equal(lenza.holder, 'natasha', 'the holder stays the bare name');
  assert.equal(lenza.board, 'Lenza');
  const no = l.ask({ holder: 'natasha', board: 'Intellagent', cpu: 1 });
  assert.match(no.reason, /^natasha@Lenza has the machine to itself/);
  assert.equal(l.ask({ holder: 'x', cpu: 0 }).granted, false);
  assert.throws(() => l.ask({ holder: 'x', board: 'b'.repeat(65) }), /board must be/);
  l.done(lenza.id);
  assert.equal(l.ask({ holder: 'peter', cpu: 1 }).lease.board, null, 'no board: recorded as none');

  // a ledger saved before boards were recorded
  const old = { seq: 1, ceiling: { cpu: 12, gpuMB: 8192 }, leases: [{ id: 'L1', holder: 'tony', ticket: null, purpose: '', cpu: 2, gpuMB: 0, exclusive: true, grantedAt: c.now(), expiresAt: c.now() + 10 * MIN, renewals: 0 }], history: [] };
  const again = machine(c, { state: old });
  assert.match(again.ask({ holder: 'peter', cpu: 1 }).reason, /^tony has the machine to itself/);
});

test('reads nvidia-smi', () => {
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 3070, 53, 2374, 8192\r\n'), [
    { name: 'NVIDIA GeForce RTX 3070', busyPercent: 53, usedMB: 2374, totalMB: 8192 },
  ]);
  assert.deepEqual(parseNvidiaSmi(''), []);
  assert.deepEqual(parseNvidiaSmi('NVIDIA X, [N/A], 100, 4096').map((g) => g.busyPercent), [null]);
});

test('the program over HTTP: ask, refuse, done, ceiling, and state kept across a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-leases-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = {
    ...process.env,
    INTELLAGENT_LEASES_PORT: String(port),
    INTELLAGENT_LEASES_FILE: path.join(dir, 'leases.json'),
    INTELLAGENT_LEASES_CAPACITY: JSON.stringify({ cpu: 12, gpuMB: 8192 }),
  };
  const base = `http://127.0.0.1:${port}`;
  const run = async () => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'leases-server.js')], { env, stdio: 'ignore' });
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${base}/status`)).ok) return proc; } catch { /* not up yet */ }
      if (i > 100) throw new Error('lease program did not start');
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  let proc = await run();
  try {
    const yes = await call('POST', '/ask', { holder: 'natasha', cpu: 11, gpuMB: 2048, minutes: 20 });
    assert.equal(yes.body.granted, true);
    const no = await call('POST', '/ask', { holder: 'peter', cpu: 2 });
    assert.equal(no.status, 200);
    assert.equal(no.body.granted, false);
    assert.ok(no.body.freesAt);
    assert.equal((await call('POST', '/ask', { cpu: 1 })).status, 400);
    assert.equal((await call('POST', '/leases/L99/done')).status, 404);
    assert.deepEqual((await call('PUT', '/ceiling', { cpu: 11 })).body.ceiling, { cpu: 11, gpuMB: 8192 });

    proc.kill();
    await new Promise((r) => proc.on('exit', r));
    proc = await run();
    const st = (await call('GET', '/status')).body;
    assert.deepEqual(st.leases.map((l) => l.holder), ['natasha'], 'the lease outlived the restart');
    assert.equal(st.ceiling.cpu, 11);
    assert.equal((await call('POST', `/leases/${yes.body.lease.id}/done`)).body.ended, 'done');
    assert.deepEqual((await call('GET', '/status')).body.floor, { cpu: 0, gpuMB: 0 });
    assert.equal((await call('GET', '/nowhere')).status, 404);

    // the CLI records the board it belongs to (the nearest manifest's app name) unless told otherwise
    fs.writeFileSync(path.join(dir, 'intellagent.manifest.json'), JSON.stringify({ appName: 'Lenza' }));
    const cli = (...args) => JSON.parse(spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'intellagent.js'), 'leases', 'ask', '--holder', 'natasha', ...args], { cwd: dir, env: { ...env, INTELLAGENT_MANIFEST: '' }, encoding: 'utf8' }).stdout);
    assert.equal(cli('--cpu', '1').lease.board, 'Lenza');
    assert.equal(cli('--cpu', '1', '--board', 'Other').lease.board, 'Other');
  } finally {
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
