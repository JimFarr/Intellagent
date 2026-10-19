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

// What is using the machine: the busiest processes, each with its command line, so whoever watches the leases
// can see what runs outside them (a test left running after its agent's run ended, most often). `agent` marks
// one started from the board's own folders (a worktree, a review checkout, an agent's build); a preview server
// serving an agent's build is meant to stay up, so it is not marked.
const AGENT_PATH = /[\\/](\.intellagent[\\/](worktrees|review|builds)|\.worktrees)[\\/]/i;
function isAgentProcess(command) {
  const c = String(command || '');
  return AGENT_PATH.test(c) && !/vite(\.js)?["']?\s+preview\b/i.test(c);
}

// Windows: PowerShell's { IDProcess, PercentProcessorTime, Name } joined with { ProcessId, CommandLine,
// CreationDate }. PercentProcessorTime is per core, so a process on every thread reads cores × 100.
function parseWindowsProcesses(perfJson, procJson, cores) {
  const arr = (j) => (j == null ? [] : Array.isArray(j) ? j : [j]);
  const info = new Map(arr(procJson).map((p) => [Number(p.ProcessId), p]));
  return arr(perfJson)
    .filter((p) => Number(p.IDProcess) > 0 && !/^(_Total|Idle)$/i.test(p.Name))
    .map((p) => {
      const i = info.get(Number(p.IDProcess)) || {};
      const started = /\/Date\((\d+)\)\//.exec(String(i.CreationDate || ''))?.[1];
      return {
        pid: Number(p.IDProcess), name: String(p.Name).replace(/#\d+$/, ''),
        cpuPercent: Math.round((Number(p.PercentProcessorTime) || 0) / cores),
        startedAt: started ? new Date(Number(started)).toISOString() : null,
        command: String(i.CommandLine || '').slice(0, 300),
      };
    });
}

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 15000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, out) => resolve(err ? null : out)));

// The busiest processes now, most first.
async function processes(top = 10) {
  if (process.platform !== 'win32') return [];
  const ps = (q) => run('powershell', ['-NoProfile', '-Command', q]);
  const [perf, procs] = await Promise.all([
    ps('Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Select-Object IDProcess,PercentProcessorTime,Name | ConvertTo-Json -Compress'),
    ps('Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress'),
  ]);
  let list = [];
  try { list = parseWindowsProcesses(JSON.parse(perf || '[]'), JSON.parse(procs || '[]'), os.cpus().length); } catch { list = []; }
  return list.sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, top).map((p) => ({ ...p, agent: isAgentProcess(p.command) }));
}

async function reading() {
  const [cpu, cards, busiest] = await Promise.all([cpuBusy(), gpus(), processes(8)]);
  return {
    at: new Date().toISOString(),
    cpu,
    memory: { totalMB: Math.round(os.totalmem() / 1048576), freeMB: Math.round(os.freemem() / 1048576) },
    gpu: cards[0] || null,
    processes: busiest,
  };
}

module.exports = { reading, gpus, cpuBusy, parseNvidiaSmi, processes, isAgentProcess, parseWindowsProcesses };
