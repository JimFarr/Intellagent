// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// Ties standing-agent runs to the board's life on Windows (INT-262). Built at first use by lib/agents/guard.js
// with the csc.exe that ships with the .NET Framework; nothing to install.
//
//   jobguard hold <board pid> <job name>   create a kill-on-close job and keep its only handle. Print "ready",
//                                          then add each pid read on stdin to the job ("ok <pid>" / "err <pid> <code>").
//                                          Exit when the board's process ends or stdin closes: the handle closes
//                                          with this process, and Windows ends everything in the job.
//   jobguard join <job name>               put this process's parent (the run's cmd.exe) in the job and exit, before
//                                          cmd starts the run itself, so the run and all it starts are born inside.
//                                          Silent on success, one stderr line otherwise; always exit 0, never read stdin.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

static class JobGuard {
  const int JobObjectExtendedLimitInformation = 9;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  const uint JOB_OBJECT_ASSIGN_PROCESS = 0x0001;
  const uint PROCESS_TERMINATE = 0x0001;
  const uint PROCESS_SET_QUOTA = 0x0100;

  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct BasicInfo { public IntPtr ExitStatus, Peb, Affinity, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref ExtendedLimits info, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int cls, ref BasicInfo info, int len, out int ret);

  static int Main(string[] args) {
    if (args.Length == 3 && args[0] == "hold") return Hold(int.Parse(args[1]), args[2]);
    if (args.Length == 2 && args[0] == "join") return Join(args[1]);
    Console.Error.WriteLine("usage: jobguard hold <board pid> <job name> | join <job name>");
    return 2;
  }

  static int Hold(int boardPid, string name) {
    Process board;
    try { board = Process.GetProcessById(boardPid); } catch (Exception e) { Console.Error.WriteLine("no board process " + boardPid + ": " + e.Message); return 1; }
    IntPtr job = CreateJobObject(IntPtr.Zero, name);
    if (job == IntPtr.Zero) { Console.Error.WriteLine("CreateJobObject failed: " + Marshal.GetLastWin32Error()); return 1; }
    var info = new ExtendedLimits();
    info.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(ExtendedLimits)))) {
      Console.Error.WriteLine("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
      return 1;
    }
    Console.Out.WriteLine("ready");
    Console.Out.Flush();
    var reader = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        int pid;
        if (!int.TryParse(line.Trim(), out pid)) continue;
        int err = Add(job, pid);
        Console.Out.WriteLine(err == 0 ? "ok " + pid : "err " + pid + " " + err);
        Console.Out.Flush();
      }
      Environment.Exit(0); // the board closed our stdin: it is gone, or done with us
    });
    reader.IsBackground = true;
    reader.Start();
    board.WaitForExit();
    return 0; // the job's only handle closes with this process
  }

  static int Add(IntPtr job, int pid) {
    IntPtr p = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
    if (p == IntPtr.Zero) return Marshal.GetLastWin32Error();
    try { return AssignProcessToJobObject(job, p) ? 0 : Marshal.GetLastWin32Error(); } finally { CloseHandle(p); }
  }

  static int Join(string name) {
    try {
      IntPtr job = OpenJobObject(JOB_OBJECT_ASSIGN_PROCESS, false, name);
      if (job == IntPtr.Zero) { Console.Error.WriteLine("intellagent run guard: no job " + name + " (" + Marshal.GetLastWin32Error() + "); this run is not tied to the board"); return 0; }
      var bi = new BasicInfo();
      int ret;
      int status = NtQueryInformationProcess(GetCurrentProcess(), 0, ref bi, Marshal.SizeOf(typeof(BasicInfo)), out ret);
      int err = status != 0 ? status : Add(job, bi.InheritedFromUniqueProcessId.ToInt32());
      if (err != 0) Console.Error.WriteLine("intellagent run guard: could not join " + name + " (" + err + "); this run is not tied to the board");
      CloseHandle(job);
    } catch (Exception e) {
      Console.Error.WriteLine("intellagent run guard: " + e.Message + "; this run is not tied to the board");
    }
    return 0;
  }
}
