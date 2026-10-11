import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPowerShellToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnCommandSource } from "../src/jobs/patty/monitor-source.js";
import { cleanupTerminal, stopSidebarTicker } from "../src/jobs/patty/registry.js";
import { resolvePwsh } from "../src/jobs/patty/shell-command.js";
import { killProcessTree, processExists, spawnWithFileOutput } from "../src/jobs/patty/spawn.js";
import { BackgroundRegistry } from "../src/jobs/patty/state.js";
import { registerBashTool } from "../src/jobs/patty/tools/bash.js";
import { ResumeStore } from "../src/resume-store.js";
import { jobHost } from "./helpers/job-runtime.js";

// These tests launch only pwsh 7 / Node: never bash.exe, WSL or a model.
describe.skipIf(process.platform !== "win32")("Windows PowerShell 7 jobs", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pi-pwsh-test-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it.each(["foreground", "background", "promoted"] as const)("retains the PowerShell label for %s execution and completion", async mode => {
    const reg = new BackgroundRegistry();
    reg.retainResults = true;
    const host = jobHost(dir);
    registerBashTool(host.pi, reg, createPowerShellToolDefinition(dir), "powershell");
    const result = host.execute("powershell", { command: "Write-Output 'label-test'", run_in_background: mode === "background" }, "label-test");
    const tracked = [...reg.jobs.values()][0];
    try {
      expect(tracked?.shell).toBe("powershell");
      if (mode === "promoted") reg.foreground.get("label-test")!.requestPause("manual");
      await result;
      expect(tracked.isBackgrounded).toBe(mode !== "foreground");
      await tracked.donePromise;
      expect(reg.jobs.get(tracked.id)?.shell).toBe("powershell");
      expect(tracked.status).toBe("completed");
    } finally {
      if (tracked) killProcessTree(tracked.identity, "SIGKILL");
      await result;
      await tracked?.donePromise;
      stopSidebarTicker(reg);
      cleanupTerminal(reg);
    }
  }, 20_000);

  it("requires pwsh rather than falling back to Windows PowerShell or WSL", () => {
    expect(resolvePwsh()).toMatch(/pwsh\.exe$/i);
    expect(() => resolvePwsh({ PATH: "" })).toThrow("PowerShell 7");
  });

  it("captures Unicode/quotes and propagates exit codes without opening a console", async () => {
    const log = join(dir, "output.log");
    const job = spawnWithFileOutput({ shell: "powershell", command: `Write-Output '中文 "quotes" $literal'; exit 7`, cwd: dir, logPath: log, foreground: true });
    try {
      expect((await job.exit).code).toBe(7);
      expect(readFileSync(log, "utf8")).toContain('中文 "quotes" $literal');
    } finally { killProcessTree(job.identity, "SIGKILL"); job.release(); }
  }, 20_000);

  it("kills the shell's owned descendant when the shell is stopped", async () => {
    const log = join(dir, "tree.log");
    const exe = process.execPath.replaceAll("'", "''");
    const command = `$p = [Diagnostics.ProcessStartInfo]::new(); $p.FileName = '${exe}'; $p.UseShellExecute = $false; $p.CreateNoWindow = $true; $p.ArgumentList.Add('-e'); $p.ArgumentList.Add('setInterval(()=>{},1000)'); $child = [Diagnostics.Process]::Start($p); Write-Output $child.Id; Start-Sleep 30`;
    const job = spawnWithFileOutput({ shell: "powershell", command, cwd: dir, logPath: log, foreground: true });
    try {
      await expect.poll(() => readFileSync(log, "utf8").trim(), { timeout: 15_000 }).toMatch(/^\d+$/);
      const child = Number(readFileSync(log, "utf8").trim());
      expect(processExists(child)).toBe(true);
      killProcessTree(job.identity, "SIGKILL");
      await job.exit;
      await expect.poll(() => processExists(child), { timeout: 5000 }).toBe(false);
    } finally { killProcessTree(job.identity, "SIGKILL"); await job.exit; job.release(); }
  }, 25_000);

  it("uses pwsh for command monitors and drains Unicode events", async () => {
    const source = spawnCommandSource({ command: "Write-Output '事件'; Write-Output 'done'", cwd: dir, logPath: join(dir, "monitor.log"), errPath: join(dir, "monitor.err") });
    try {
      expect((await source.exit).code).toBe(0);
      expect(readFileSync(source.logPath, "utf8")).toContain("事件");
    } finally { source.stop(); }
  }, 20_000);

  it("flushes and atomically replaces the resume index without directory fsync", () => {
    const parent = join(dir, "parent.jsonl");
    const store = new ResumeStore(parent, "parent");
    const entry = { id: "child", handle: "child", type: "Explore", description: "test", sessionFile: join(dir, "child.jsonl"), completedAt: 1,
      resumeState: { sessionId: "child-session", cwd: dir, configCwd: dir, isolated: false } };
    store.put(entry);
    store.put({ ...entry, description: "updated" });
    expect(new ResumeStore(parent, "parent").list()).toEqual([{ ...entry, description: "updated" }]);
  });
});
