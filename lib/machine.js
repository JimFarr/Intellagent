'use strict';
// What the machine is doing right now: the processor, its memory and the graphics card. The Guard reads this to
// set the ledger's ceiling (lib/leases.js) — the human's own work never asks for a lease, so it only shows here.
const os = require('os');
const { execFile } = require('child_process');

// Processor busy over a short window: how much of each thread was not idle.
async function cpuBusy(ms = 500) {
  const before = os.cpus();
  await new Promise((r) => setTimeout(r, ms));
  const after = os.cpus();
  let busy = 0, total = 0;
  after.forEach((c, i) => {
    const a = c.times, b = before[i]?.times;
    if (!b) return;
    const all = (k) => a[k] - b[k];
    const t = all('user') + all('nice') + all('sys') + all('idle') + all('irq');
    total += t;
    busy += t - all('idle');
  });
  const threads = after.length;
  const share = total > 0 ? busy / total : 0;
  return { threads, busyPercent: Math.round(share * 100), busyThreads: Math.round(share * threads * 10) / 10 };
}

// One line per card from `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits`.
function parseNvidiaSmi(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, util, used, total] = l.split(',').map((s) => s.trim());
    const n = (s) => (Number.isFinite(Number(s)) ? Number(s) : null);
    return { name, busyPercent: n(util), usedMB: n(used), totalMB: n(total) };
  }).filter((g) => g.name && g.totalMB != null);
}

// The cards nvidia-smi can see, or [] where there is none or no tool to ask.
function gpus() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? [] : parseNvidiaSmi(out)));
  });
}

async function reading() {
  const [cpu, cards] = await Promise.all([cpuBusy(), gpus()]);
  return {
    at: new Date().toISOString(),
    cpu,
    memory: { totalMB: Math.round(os.totalmem() / 1048576), freeMB: Math.round(os.freemem() / 1048576) },
    gpu: cards[0] || null,
  };
}

module.exports = { reading, gpus, cpuBusy, parseNvidiaSmi };
