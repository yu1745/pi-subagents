import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type JobShell = "bash" | "powershell";

// Hold a non-inheritable job handle in the shell itself. Closing the shell's
// process handle (including a forced kill) closes the job and kills ordinary
// descendants. No PID-based taskkill race and no second console/supervisor.
const windowsJob = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PiOwnedJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic Basic; public Io Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref Extended value, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static IntPtr handle;
  public static void Install() {
    handle = CreateJobObject(IntPtr.Zero, null);
    if (handle == IntPtr.Zero) throw new Win32Exception();
    var limits = new Extended(); limits.Basic.Flags = 0x2000;
    if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(typeof(Extended))) ||
        !AssignProcessToJobObject(handle, GetCurrentProcess())) {
      int error = Marshal.GetLastWin32Error(); CloseHandle(handle); handle = IntPtr.Zero;
      throw new Win32Exception(error);
    }
  }
}
'@
[PiOwnedJob]::Install()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$ProgressPreference = 'SilentlyContinue'
`;

/** Resolve without executing PATH candidates; never fall back to WSL or PS 5. */
export function resolvePwsh(env: NodeJS.ProcessEnv = process.env): string {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path");
  const candidates = [
    ...(env.ProgramFiles ? [join(env.ProgramFiles, "PowerShell", "7", "pwsh.exe")] : []),
    ...(env[pathKey ?? "PATH"] ?? "").split(delimiter).filter(isAbsolute).map(dir => join(dir, "pwsh.exe")),
  ];
  const found = candidates.find(path => existsSync(path));
  if (!found) throw new Error("PowerShell 7 (pwsh.exe) is required for owned Windows jobs. Install it or add it to PATH; Windows PowerShell 5 and WSL are not used.");
  return found;
}

export function shellCommand(command: string, shell: JobShell): { file: string; fileArgs: string[] } {
  if (shell === "bash") return { file: "bash", fileArgs: ["-c", command] };
  if (process.platform !== "win32") throw new Error("Owned PowerShell jobs currently require Windows and PowerShell 7.");
  // Encode the user's script as data, not source interpolated into the wrapper.
  // -EncodedCommand also preserves Unicode/quotes through CreateProcess.
  const encoded = Buffer.from(command, "utf8").toString("base64");
  const script = `${windowsJob}\ntry {\n$global:LASTEXITCODE = 0\n& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))\n$ok = $?\nif (!$ok) { exit 1 }\nexit $LASTEXITCODE\n} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }`;
  return { file: resolvePwsh(), fileArgs: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
}
