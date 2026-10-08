import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendTaskNotification } from "../src/jobs/patty/notify.js";
import { cleanupTerminal } from "../src/jobs/patty/registry.js";
import { EVENT, type Job } from "../src/jobs/patty/types.js";
import * as watchdog from "../src/jobs/patty/watchdog/index.js";
import { JobRuntime } from "../src/jobs/runtime.js";
import { jobChild, jobHost, until } from "./helpers/job-runtime.js";

vi.mock("../src/jobs/patty/watchdog/index.js", async original => {
  const actual = await original<typeof watchdog>();
  return { ...actual, createJobWatchdog: vi.fn(actual.createJobWatchdog) };
});

describe("job notifications stay in the owning session", () => {
  let cwd: string;
  let runtime: JobRuntime;
  let main: ReturnType<typeof jobHost>;
  beforeEach(async () => {
    vi.stubEnv("PI_PATTY_WATCHDOG", "0"); vi.stubEnv("PI_PATTY_WATCHDOG_LOG", "0");
    cwd = mkdtempSync(join(tmpdir(), "job-owner-route-"));
    main = jobHost(cwd); runtime = new JobRuntime(main.pi); runtime.installRoot();
    await main.emit("session_start");
  });
  afterEach(async () => {
    await runtime.dispose(); cleanupTerminal(runtime.registry);
    rmSync(cwd, { recursive: true, force: true }); vi.unstubAllEnvs();
  });

  it.each([0, 7])("routes child exit %i once to the owner, with UI refresh but no main message", async exitCode => {
    const child = await jobChild(runtime, cwd, "owned");
    const refresh = vi.fn(); runtime.setTaskUI({ refresh, open: vi.fn() });
    await child.execute("bash", { command: `sleep 0.1; echo RESULT; exit ${exitCode}`, run_in_background: true });
    const job = [...runtime.registry.jobs.values()][0];
    const reads = main.execute("jobs", { action: "attach", jobId: job.id });
    expect(job.waiters).toBeUndefined();
    await reads;
    await until(() => child.notices.length === 1);
    expect(job.status).toBe(exitCode ? "failed" : "completed");
    expect(main.notices).toHaveLength(0);
    expect(child.notices[0].customType).toBe(EVENT.taskNotification);
    expect(JSON.stringify(child.notices[0].details)).toContain(child.ctx.sessionManager.getSessionId());
    expect(refresh).toHaveBeenCalled();
    await main.execute("jobs", { action: "output", jobId: job.id });
    await main.execute("jobs", { action: "list" });
    expect(child.notices).toHaveLength(1); expect(main.notices).toHaveLength(0);
  });

  it("shared watchdog notices also stay with the owner and never fall back to main after eviction", async () => {
    const child = await jobChild(runtime, cwd, "watched");
    await child.execute("bash", { command: "sleep 1", run_in_background: true });
    const job = [...runtime.registry.jobs.values()][0];
    const routed = vi.mocked(watchdog.createJobWatchdog).mock.calls.at(-1)![0];
    const message = { customType: EVENT.semanticStall, content: "fixture", display: true, details: { jobId: job.id } };
    routed.sendMessage(message, { triggerTurn: false });
    expect(child.notices).toHaveLength(1); expect(main.notices).toHaveLength(0);
    routed.sendMessage({ ...message, details: { jobId: "evicted-owner-job" } }, { triggerTurn: true });
    expect(main.notices).toHaveLength(0);
    await child.emit("session_shutdown");
    routed.sendMessage(message, { triggerTurn: true });
    expect(child.notices).toHaveLength(1); expect(main.notices).toHaveLength(0);
    expect(runtime.registry.jobs.get(job.id)).toBe(job);
  });

  it("main's own jobs still notify main exactly once", async () => {
    await main.execute("bash", { command: "sleep 0.05; echo MAIN", run_in_background: true });
    await until(() => main.notices.length === 1);
    expect(main.notices[0].customType).toBe(EVENT.taskNotification);
    expect([...runtime.registry.jobs.values()][0].notified).toBe(true);
  });

  it("parent output/attach cannot latch or suppress an owner's as-yet-undelivered outcome", async () => {
    const child = await jobChild(runtime, cwd, "owned");
    const reg = runtime.registry.ownerRegistries.get("owned")!;
    const job: Job = { id: "manual-terminal", command: "fixture", pid: 0, startTime: 0, endTime: 1, status: "failed", exitCode: 7,
      logPath: join(cwd, "result.log"), toolCallId: "fixture", isBackgrounded: true, notified: false };
    writeFileSync(job.logPath, "OWNER_RESULT"); reg.jobs.set(job.id, job);
    await main.execute("jobs", { action: "output", jobId: job.id });
    await main.execute("jobs", { action: "attach", jobId: job.id });
    expect(job.notified).toBe(false);
    expect(sendTaskNotification({ reg, pi: child.pi, job })).toBe(true);
    expect(sendTaskNotification({ reg, pi: child.pi, job })).toBe(false);
    expect(child.notices).toHaveLength(1); expect(main.notices).toHaveLength(0);
  });

  it("queues idle completion for a managed owner continuation, protecting captures until it settles", async () => {
    const child = await jobChild(runtime, cwd, "idle");
    Object.assign(child.ctx, { isIdle: () => true });
    await child.execute("bash", { command: "sleep 0.05; echo IDLE_RESULT", run_in_background: true });
    const job = [...runtime.registry.jobs.values()][0];
    await until(() => job.notified === true);
    expect(child.notices).toHaveLength(0); expect(main.notices).toHaveLength(0);
    expect(cleanupTerminal(runtime.registry).purged).toBe(0);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sendCustomMessage = vi.fn(async (...args: Parameters<ExtensionAPI["sendMessage"]>) => {
      child.pi.sendMessage(...args);
      await gate;
    });
    let settled = false;
    const drain = runtime.drain("idle", { sendCustomMessage } as unknown as AgentSession).then(() => { settled = true; });
    try {
      await until(() => sendCustomMessage.mock.calls.length === 1);
      expect(settled).toBe(false);
      expect(existsSync(job.logPath)).toBe(true);
      expect(cleanupTerminal(runtime.registry).purged).toBe(0);
      expect(child.notices).toHaveLength(1); expect(main.notices).toHaveLength(0);
    } finally { release(); await drain; }
    expect(settled).toBe(true);
    expect(sendCustomMessage).toHaveBeenCalledOnce();
    expect(cleanupTerminal(runtime.registry).purged).toBe(1);
  });

  it("a stop during idle drain records accepted results without launching another model turn", async () => {
    const child = await jobChild(runtime, cwd, "stopping");
    Object.assign(child.ctx, { isIdle: () => true });
    await child.execute("bash", { command: "sleep 0.05; echo STOP_RESULT", run_in_background: true });
    await until(() => [...runtime.registry.jobs.values()][0].notified === true);
    const delivered = vi.spyOn(child.pi, "sendMessage");
    await runtime.stopOwner("stopping");
    const sendCustomMessage = vi.fn(async (...args: Parameters<ExtensionAPI["sendMessage"]>) => child.pi.sendMessage(...args));
    await runtime.drain("stopping", { sendCustomMessage } as unknown as AgentSession);
    expect(sendCustomMessage).not.toHaveBeenCalled();
    expect(delivered).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ triggerTurn: false }));
    expect(child.notices).toHaveLength(1); expect(main.notices).toHaveLength(0);
    expect(cleanupTerminal(runtime.registry).purged).toBe(1);
  });
});
