import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processExists } from "../src/jobs/patty/spawn.js";
import { EVENT, type Job } from "../src/jobs/patty/types.js";
import { JobRuntime, jobRuntimeEnabled } from "../src/jobs/runtime.js";
import { jobChild, jobHost, textOf, until } from "./helpers/job-runtime.js";

vi.setConfig({ testTimeout: 15000 });

describe("parent-owned Patty job runtime", () => {
  let cwd: string;
  let runtime: JobRuntime;
  let main: ReturnType<typeof jobHost>;
  beforeEach(async () => {
    vi.stubEnv("PI_PATTY_WATCHDOG_LOG", "0");
    vi.stubEnv("PI_PATTY_WATCHDOG", "0");
    cwd = mkdtempSync(join(tmpdir(), "subagents-job-test-"));
    main = jobHost(cwd);
    runtime = new JobRuntime(main.pi);
    runtime.installRoot();
    await main.emit("session_start");
  });
  afterEach(async () => {
    await runtime.dispose();
    await main.execute("jobs", { action: "cleanup" }).catch(() => {});
    for (const job of runtime.registry.jobs.values()) {
      if (job.status === "running") throw new Error(`Test leaked a live process: ${job.id}`);
      rmSync(job.logPath, { force: true });
      rmSync(job.logPath.replace(/\.log$/, ".err"), { force: true });
    }
    rmSync(cwd, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const notices = (host = main) => host.notices.filter(message => message.customType === EVENT.taskNotification);
  const ownJob = (id: string): Job => {
    const job = [...runtime.registry.jobs.values()].find(job => job.toolCallId === id);
    if (!job) throw new Error(`No owned job for ${id}`);
    return job;
  };

  it("is enabled by default with an explicit legacy opt-out", () => {
    vi.stubEnv("PI_SUBAGENTS_JOB_RUNTIME", undefined);
    expect(jobRuntimeEnabled()).toBe(true);
    vi.stubEnv("PI_SUBAGENTS_JOB_RUNTIME", "0");
    expect(jobRuntimeEnabled()).toBe(false);
    vi.stubEnv("PI_SUBAGENTS_JOB_RUNTIME", "1");
    expect(jobRuntimeEnabled()).toBe(true);
  });

  it.each([0, 10, 12000, 12001])("only advertises the full capture when %i output bytes exceed the preview", async size => {
    const result = await main.execute("bash", { command: `printf '%s' '${"x".repeat(size)}'` }, "preview");
    const job = ownJob("preview");
    expect(readFileSync(job.logPath, "utf8")).toHaveLength(size);
    expect(result.details).toEqual(size > 12000 ? { fullOutputPath: job.logPath } : undefined);
    expect(textOf(result).includes("[truncated")).toBe(size > 12000);
  });

  it("quick-window steer returns ID immediately, preserves the original signal and captures final output once", async () => {
    const child = await jobChild(runtime, cwd, "child-quick");
    const ac = new AbortController();
    const bash = child.execute("bash", { command: "printf 'START\\n'; sleep 0.8; printf 'FINAL\\n'", timeout: 86400 }, "quick", ac.signal);
    const job = ownJob("quick");
    await until(() => readFileSync(job.logPath, "utf8").includes("START"));
    const started = Date.now();
    await child.input("  change direction  ", "interactive", [{ type: "image", data: "kept by Pi" }]);
    const result = textOf(await bash);
    expect(Date.now() - started).toBeLessThan(700);
    expect(result).toContain(job.id);
    expect(result).toContain("background");
    expect(ac.signal.aborted).toBe(false);
    expect(child.ctx.abort).not.toHaveBeenCalled();
    expect(processExists(job.pid)).toBe(true);
    expect(job.ownerAgentId).toBe("child-quick");
    expect(job.ownerSessionId).toBe(child.ctx.sessionManager.getSessionId());
    expect(job.cwd).toBe(cwd);
    await until(() => job.status !== "running");
    expect(notices(child)).toHaveLength(1);
    expect(notices()).toHaveLength(0);
    expect(textOf(await main.execute("jobs", { action: "output", jobId: job.id }))).toContain("FINAL");
    await main.execute("jobs", { action: "list" });
    expect(textOf(await main.execute("jobs", { action: "search", pattern: "FINAL" }))).toContain(job.id);
    expect(runtime.registry.jobs.get(job.id)).toBe(job);
    expect(existsSync(job.logPath)).toBe(true);
    expect(notices(child)).toHaveLength(1);
  });

  it("a real long command releases after its progress window without killing descendants", async () => {
    const child = await jobChild(runtime, cwd, "child-long");
    const promise = child.execute("bash", { command: "printf 'START\\n'; sleep 4; printf 'LONG_FINAL\\n'" }, "long");
    const job = ownJob("long");
    await until(() => readFileSync(job.logPath, "utf8").includes("START"));
    await delay(2100);
    const start = Date.now();
    await child.input("steer while synchronous bash is running");
    expect(textOf(await promise)).toContain(job.id);
    expect(Date.now() - start).toBeLessThan(700);
    expect(processExists(job.pid)).toBe(true);
    await until(() => job.status === "completed");
    expect(textOf(await main.execute("jobs", { action: "output", jobId: job.id }))).toContain("LONG_FINAL");
    expect(notices(child)).toHaveLength(1);
    expect(notices()).toHaveLength(0);
  });

  it("attach steer releases only its wait, permits continuous steers and later notifies exactly once", async () => {
    const child = await jobChild(runtime, cwd, "child-attach");
    await child.execute("bash", { command: "printf 'BEGIN\\n'; sleep 0.6; printf 'ATTACHED_FINAL\\n'", run_in_background: true }, "background");
    const job = ownJob("background");
    const ac = new AbortController();
    const first = child.execute("jobs", { action: "attach", jobId: job.id }, "attach-a", ac.signal);
    await child.input("first steer");
    expect(textOf(await first)).toContain(`job ID: ${job.id}`);
    const second = child.execute("jobs", { action: "attach", jobId: job.id }, "attach-b", ac.signal);
    await child.input("second steer");
    expect(textOf(await second)).toContain(job.id);
    await child.input("third steer with no registered wait");
    expect(ac.signal.aborted).toBe(false);
    expect(child.ctx.abort).not.toHaveBeenCalled();
    expect(job.waiters).toBe(0);
    expect(job.notified).not.toBe(true);
    expect(processExists(job.pid)).toBe(true);
    await until(() => job.status === "completed");
    expect(notices(child)).toHaveLength(1);
    expect(notices()).toHaveLength(0);
    expect(textOf(await main.execute("jobs", { action: "output", jobId: job.id }))).toContain("ATTACHED_FINAL");
  });

  it("one detached attach cannot undo another attach's consumption latch", async () => {
    await main.execute("bash", { command: "sleep 0.3; echo ONE_OUTCOME", run_in_background: true }, "multi");
    const job = ownJob("multi");
    const a = new AbortController();
    const first = main.execute("jobs", { action: "attach", jobId: job.id }, "watch-a", a.signal);
    const second = main.execute("jobs", { action: "attach", jobId: job.id }, "watch-b");
    a.abort();
    expect(textOf(await first)).toContain("still running");
    expect(job.waiters).toBe(1);
    expect(textOf(await second)).toContain("finished");
    expect(job.notified).toBe(true);
    expect(notices()).toHaveLength(0);
    expect(existsSync(job.logPath)).toBe(true);
    expect(runtime.registry.completedCount).toBe(1);
    await main.execute("jobs", { action: "cleanup" });
    expect(runtime.registry.completedCount).toBe(1);
  });

  it("main steering does not release a child's foreground slot; foreign children cannot kill/read jobs", async () => {
    const a = await jobChild(runtime, cwd, "owner-a");
    const b = await jobChild(runtime, cwd, "owner-b");
    let returned = false;
    const promise = a.execute("bash", { command: "sleep 0.4; echo OWNED" }, "owned").then(result => { returned = true; return result; });
    const job = ownJob("owned");
    await main.input("main-only steer");
    await delay(50);
    expect(returned).toBe(false);
    await expect(b.execute("jobs", { action: "kill", jobId: job.id })).rejects.toThrow("No task found");
    await expect(b.execute("jobs", { action: "output", jobId: job.id })).rejects.toThrow("No task found");
    expect(textOf(await promise)).toContain("OWNED");
    expect(textOf(await main.execute("jobs", { action: "list" }))).toContain("owner=owner-a");
  });

  it("Esc is a genuine foreground cancellation with bounded kill escalation; never a steer", async () => {
    const ac = new AbortController();
    const promise = main.execute("bash", { command: "trap '' TERM; printf 'TRAPPED\\n'; sleep 30" }, "cancel", ac.signal);
    const job = ownJob("cancel");
    await until(() => readFileSync(job.logPath, "utf8").includes("TRAPPED"));
    ac.abort();
    expect(textOf(await promise)).toContain("TRAPPED");
    expect(processExists(job.pid)).toBe(false);
    expect(job.status).toBe("killed");
    expect(notices()).toHaveLength(0);
    expect(existsSync(job.logPath)).toBe(true);
  });

  it("explicit kill terminates the owned process group while cleanup never kills a live job", async () => {
    const child = await jobChild(runtime, cwd, "stop-me");
    await child.execute("bash", { command: "sleep 30 & printf '%s\\n' \"$!\"; wait", run_in_background: true }, "tree");
    const job = ownJob("tree");
    await until(() => readFileSync(job.logPath, "utf8").trim().length > 0);
    const descendant = Number(readFileSync(job.logPath, "utf8").trim());
    expect(processExists(descendant)).toBe(true);
    await main.execute("jobs", { action: "cleanup" });
    expect(existsSync(job.logPath)).toBe(true);
    expect(processExists(job.pid)).toBe(true);
    expect(textOf(await main.execute("jobs", { action: "kill", jobId: job.id }))).toContain("Successfully stopped");
    await until(() => !processExists(descendant));
    expect(processExists(job.pid)).toBe(false);
    expect(notices()).toHaveLength(0);
    await main.execute("jobs", { action: "cleanup" });
    expect(runtime.registry.jobs.has(job.id)).toBe(false);
    expect(existsSync(job.logPath)).toBe(false);
    expect(runtime.registry.killedCount).toBe(1);
    expect(runtime.registry.totalStarted).toBe(1);
  });

  it("owner drain keeps the original session promise alive and handles idle-time steering inside it", async () => {
    const child = await jobChild(runtime, cwd, "draining");
    await child.execute("bash", { command: "sleep 0.5; echo DRAIN_FINAL", run_in_background: true }, "drain-job");
    const job = ownJob("drain-job");
    const prompt = vi.fn(async () => {});
    const session = { prompt, sendCustomMessage: vi.fn(async () => {}) } as unknown as AgentSession;
    let settled = false;
    const drain = runtime.drain("draining", session).then(() => { settled = true; });
    await delay(20);
    expect(settled).toBe(false);
    expect(runtime.offerSteer("draining", "idle managed continuation")).toBe(true);
    await until(() => prompt.mock.calls.length === 1);
    expect(settled).toBe(false);
    await drain;
    expect(job.status).toBe("completed");
    expect(prompt).toHaveBeenCalledWith("idle managed continuation");
    expect(textOf(await main.execute("jobs", { action: "output", jobId: job.id }))).toContain("DRAIN_FINAL");
    await child.emit("session_shutdown");
    expect(existsSync(job.logPath)).toBe(true);
  });

  it("owner stop and parent shutdown terminate jobs, retain logs, and cannot kill another owner's work", async () => {
    const a = await jobChild(runtime, cwd, "stop-a");
    const b = await jobChild(runtime, cwd, "stop-b");
    await a.execute("bash", { command: "echo A; sleep 30", run_in_background: true }, "a-stop");
    await b.execute("bash", { command: "echo B; sleep 30", run_in_background: true }, "b-stop");
    const first = ownJob("a-stop");
    const second = ownJob("b-stop");
    expect(await runtime.stopOwner("stop-a")).toBe(true);
    expect(processExists(first.pid)).toBe(false);
    expect(processExists(second.pid)).toBe(true);
    await expect(a.execute("bash", { command: "echo no" })).rejects.toThrow("owner has stopped");
    await runtime.dispose();
    expect(processExists(second.pid)).toBe(false);
    expect(existsSync(first.logPath)).toBe(true);
    expect(existsSync(second.logPath)).toBe(true);
    expect(notices()).toHaveLength(0);
  });

  it("steer never aborts read, write, or a third-party long tool without a shell wait slot", async () => {
    for (const name of ["read", "write", "third_party_long"]) {
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const ac = new AbortController();
      const read = createReadToolDefinition(cwd, { operations: { access: async () => {}, readFile: async () => { await blocked; return Buffer.from("READ_DONE"); } } });
      const write = createWriteToolDefinition(cwd, { operations: { mkdir: async () => {}, writeFile: async () => { await blocked; } } });
      let settled = false;
      const pending = (name === "read" ? read.execute("external", { path: "file" }, ac.signal, undefined, main.ctx)
        : name === "write" ? write.execute("external", { path: "file", content: "unchanged" }, ac.signal, undefined, main.ctx)
          : blocked.then(() => ({ content: [{ type: "text" as const, text: "THIRD_DONE" }], details: undefined })))
        .then(result => { settled = true; return result; });
      await main.input(`steer while ${name} is awaiting`);
      await delay(20);
      expect(settled).toBe(false);
      expect(ac.signal.aborted).toBe(false);
      expect(main.ctx.abort).not.toHaveBeenCalled();
      expect(runtime.registry.foreground.size).toBe(0);
      release();
      await pending;
      expect(settled).toBe(true);
    }
  });

  it("steer does not detach jobs attach to monitor/agent tasks", async () => {
    await main.execute("monitor", { command: "printf 'EVENT\\n'; sleep 30", description: "not a bash wait", persistent: true }, "monitor");
    const job = [...runtime.registry.jobs.values()][0];
    let returned = false;
    const ac = new AbortController();
    const attach = main.execute("jobs", { action: "attach", jobId: job.id }, "monitor-attach", ac.signal).then(result => { returned = true; return result; });
    await main.input("must not interrupt a monitor attach");
    await delay(30);
    expect(returned).toBe(false);
    expect(runtime.registry.foreground.size).toBe(0);
    expect(ac.signal.aborted).toBe(false);
    ac.abort();
    await attach;
    expect(processExists(job.pid)).toBe(true);
    await main.execute("jobs", { action: "kill", jobId: job.id });
  });

  it("passive extension follow-ups leave waits intact while explicit extension steers release them", async () => {
    let returned = false;
    const pending = main.execute("bash", { command: "sleep 30" }, "extension-input")
      .then(result => { returned = true; return result; });
    const job = ownJob("extension-input");
    await main.input("passive notice", "extension", undefined, "followUp");
    await delay(20);
    expect(returned).toBe(false);
    expect(runtime.registry.foreground.size).toBe(1);
    await main.input("explicit steer", "extension", undefined, "steer");
    expect(textOf(await pending)).toContain(job.id);
    expect(processExists(job.pid)).toBe(true);
    expect(main.ctx.abort).not.toHaveBeenCalled();
    await main.execute("jobs", { action: "kill", jobId: job.id });
  });

  it("restart reuses retained captures without reviving processes or double-counting outcomes", async () => {
    await main.execute("bash", { command: "echo FIRST_RUN" }, "first-run");
    const job = ownJob("first-run");
    const before = textOf(await main.execute("jobs", { action: "stats" }));
    await runtime.dispose();
    await main.emit("session_start");
    expect(textOf(await main.execute("jobs", { action: "output", jobId: job.id }))).toContain("FIRST_RUN");
    expect(textOf(await main.execute("jobs", { action: "stats" }))).toBe(before);
    expect(processExists(job.pid)).toBe(false);
    expect(notices()).toHaveLength(0);
    expect(textOf(await main.execute("bash", { command: "echo NEXT_RUN" }, "next-run"))).toContain("NEXT_RUN");
    expect(runtime.registry.jobs.size).toBe(2);
  });

  it("rejects invalid timeout before spawning instead of creating an unbounded or overflowed wait", async () => {
    for (const timeout of [NaN, Infinity, -1, 0, 86401]) {
      await expect(main.execute("bash", { command: "sleep 30", timeout })).rejects.toThrow("finite positive");
    }
    expect(runtime.registry.jobs.size).toBe(0);
  });
});
