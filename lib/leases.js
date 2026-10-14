'use strict';
// The machine's ledger of heavy work: who may use how much of the processor and the graphics card, and until when.
// One per PC, not per board — every board's agents share the same machine. A Guard asks on an agent's behalf
// ("4 threads and 2 GB of card for 20 minutes?") and gets yes with a lease, or no with when room frees.
// Leases end when declared done, or by themselves when their time runs out, so a crashed agent never strands
// the machine. Pure: no clock, files or network of its own (leases-server.js does those).

const MAX_MINUTES = 120; // a lease longer than this is a forgotten one; renew instead
const HISTORY = 50; // ended leases kept, newest first, so the Guard can see what just happened

class Ledger {
  // capacity: { cpu: threads, gpuMB: card memory or null when there is no card to count }
  constructor({ capacity, ceiling, now = Date.now, maxMinutes = MAX_MINUTES, state } = {}) {
    if (!capacity || !(capacity.cpu > 0)) throw new Error('capacity.cpu (threads) is required');
    this.now = now;
    this.maxMinutes = maxMinutes;
    this.capacity = { cpu: capacity.cpu, gpuMB: capacity.gpuMB > 0 ? capacity.gpuMB : null };
    this.ceiling = { ...this.capacity };
    this.leases = [];
    this.history = [];
    this.seq = 0;
    if (state) this.#restore(state);
    if (ceiling) this.setCeiling(ceiling);
  }

  // What is in use now: the sum of every live lease.
  floor() {
    this.sweep();
    return this.leases.reduce((f, l) => ({ cpu: f.cpu + l.cpu, gpuMB: f.gpuMB + l.gpuMB }), { cpu: 0, gpuMB: 0 });
  }

  // board: which board the holder works for. Names repeat across boards (two boards may each have a natasha),
  // so it is kept beside the bare holder name; leases from before it existed have none.
  ask({ holder, board = null, cpu = 0, gpuMB = 0, minutes = 15, exclusive = false, ticket = null, purpose = '' } = {}) {
    if (!holder || typeof holder !== 'string') throw bad('holder (who the lease is for) is required');
    if (board != null && (typeof board !== 'string' || board.length > 64)) throw bad('board must be a name of up to 64 characters');
    if (typeof exclusive !== 'boolean') throw bad('exclusive must be true or false');
    cpu = amount(cpu, 'cpu');
    // No card to count (none found, or nvidia-smi can't see it): card memory isn't rationed, and the answer says so.
    const uncounted = this.capacity.gpuMB == null && amount(gpuMB, 'gpuMB') > 0;
    gpuMB = this.capacity.gpuMB == null ? 0 : amount(gpuMB, 'gpuMB');
    minutes = this.#minutes(minutes);
    const floor = this.floor();
    const answer = (granted, extra) => ({
      granted, floor, ceiling: { ...this.ceiling }, ...extra,
      ...(uncounted ? { note: 'no graphics card is counted on this machine: the card memory asked for is not rationed' } : {}),
    });

    if (cpu > this.ceiling.cpu || (this.ceiling.gpuMB != null && gpuMB > this.ceiling.gpuMB)) {
      return answer(false, { reason: `more than the ceiling allows (${this.#said(this.ceiling)})`, freesAt: null });
    }
    const sole = this.leases.find((l) => l.exclusive);
    if (sole) return answer(false, { reason: `${who(sole)} has the machine to itself`, freesAt: iso(sole.expiresAt) });
    if (exclusive && this.leases.length) {
      return answer(false, { reason: 'wants the machine to itself, and it is in use', freesAt: iso(Math.max(...this.leases.map((l) => l.expiresAt))) });
    }
    if (!this.#fits(floor, cpu, gpuMB)) {
      return answer(false, { reason: `no room: ${this.#said(floor)} in use of ${this.#said(this.ceiling)}`, freesAt: this.#freesAt(cpu, gpuMB) });
    }

    const t = this.now();
    const lease = {
      id: `L${++this.seq}`, holder, board: board || null, ticket, purpose: String(purpose || ''), cpu, gpuMB, exclusive: !!exclusive,
      grantedAt: t, expiresAt: t + minutes * 60_000, renewals: 0,
    };
    this.leases.push(lease);
    return answer(true, { lease: view(lease), floor: this.floor() });
  }

  // Renewing only ever extends: "15 more minutes" on a lease with 40 left keeps the 40.
  renew(id, minutes = 15) {
    const l = this.#live(id);
    l.expiresAt = Math.max(l.expiresAt, this.now() + this.#minutes(minutes) * 60_000);
    l.renewals++;
    return view(l);
  }

  done(id) {
    const l = this.#live(id);
    this.#end(l, 'done');
    return view(l);
  }

  // The Guard sets the ceiling from what the machine is doing (the human's own work never asks for a lease).
  // Lowering it below the floor keeps the leases already granted; new ones wait until the floor drops.
  setCeiling({ cpu, gpuMB } = {}) {
    if (cpu != null) this.ceiling.cpu = Math.min(amount(cpu, 'cpu'), this.capacity.cpu);
    if (gpuMB != null && this.capacity.gpuMB != null) this.ceiling.gpuMB = Math.min(amount(gpuMB, 'gpuMB'), this.capacity.gpuMB);
    return { ...this.ceiling };
  }

  // Ends every lease whose time is up; returns them.
  sweep() {
    const t = this.now();
    const gone = this.leases.filter((l) => l.expiresAt <= t);
    for (const l of gone) this.#end(l, 'expired');
    return gone.map(view);
  }

  status() {
    const floor = this.floor();
    return {
      capacity: { ...this.capacity }, ceiling: { ...this.ceiling }, floor,
      leases: this.leases.map(view), recent: this.history.map(view),
    };
  }

  toJSON() {
    return { seq: this.seq, ceiling: this.ceiling, leases: this.leases, history: this.history };
  }

  #restore(s) {
    this.seq = Number(s.seq) || 0;
    if (s.ceiling) this.ceiling = { cpu: Math.min(s.ceiling.cpu ?? this.capacity.cpu, this.capacity.cpu), gpuMB: this.capacity.gpuMB == null ? null : Math.min(s.ceiling.gpuMB ?? this.capacity.gpuMB, this.capacity.gpuMB) };
    this.leases = Array.isArray(s.leases) ? s.leases.filter((l) => l && l.id && l.expiresAt) : [];
    this.history = Array.isArray(s.history) ? s.history.slice(0, HISTORY) : [];
    this.sweep();
  }

  #fits(floor, cpu, gpuMB) {
    return floor.cpu + cpu <= this.ceiling.cpu + 1e-9
      && (this.ceiling.gpuMB == null || floor.gpuMB + gpuMB <= this.ceiling.gpuMB + 1e-9);
  }

  // When enough leases will have run out for the request to fit, if nothing new is granted meanwhile.
  #freesAt(cpu, gpuMB) {
    const left = [...this.leases].sort((a, b) => a.expiresAt - b.expiresAt);
    let floor = { cpu: left.reduce((s, l) => s + l.cpu, 0), gpuMB: left.reduce((s, l) => s + l.gpuMB, 0) };
    for (const l of left) {
      floor = { cpu: floor.cpu - l.cpu, gpuMB: floor.gpuMB - l.gpuMB };
      if (this.#fits(floor, cpu, gpuMB)) return iso(l.expiresAt);
    }
    return null;
  }

  #live(id) {
    this.sweep();
    const l = this.leases.find((x) => x.id === id);
    if (!l) {
      const ended = this.history.find((x) => x.id === id);
      throw Object.assign(new Error(ended ? `lease ${id} already ended (${ended.ended})` : `no lease ${id}`), { status: ended ? 410 : 404 });
    }
    return l;
  }

  #end(l, how) {
    this.leases = this.leases.filter((x) => x !== l);
    l.ended = how;
    l.endedAt = this.now();
    this.history.unshift(l);
    this.history.length = Math.min(this.history.length, HISTORY);
  }

  #minutes(m) {
    const n = Number(m);
    if (!Number.isFinite(n) || n <= 0) throw bad('minutes must be a positive number');
    return Math.min(n, this.maxMinutes);
  }

  #said(r) {
    return `${round(r.cpu)} threads${this.capacity.gpuMB == null ? '' : `, ${Math.round(r.gpuMB)} MB of card`}`;
  }
}

function amount(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${name} must be a number, 0 or more`);
  return n;
}
function bad(msg) { return Object.assign(new Error(msg), { status: 400 }); }
function iso(t) { return new Date(t).toISOString(); }
function round(n) { return Math.round(n * 10) / 10; }
function who(l) { return l.board ? `${l.holder}@${l.board}` : l.holder; }
function view(l) {
  const { grantedAt, expiresAt, endedAt, ...rest } = l;
  return { ...rest, grantedAt: iso(grantedAt), expiresAt: iso(expiresAt), ...(endedAt ? { endedAt: iso(endedAt) } : {}) };
}

module.exports = { Ledger, MAX_MINUTES };
