import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLogLease } from "../src/jobs/patty/log-leases.js";
import { cleanupTerminal } from "../src/jobs/patty/registry.js";
import { EVENT } from "../src/jobs/patty/types.js";
import { JobRuntime } from "../src/jobs/runtime.js";
import { JobLogView } from "../src/ui/job-log-view.js";
import { jobChild, jobHost, until } from "./helpers/job-runtime.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllEnvs(); });

describe("live log viewing is not an attach consumer", () => {
  it("keeps child completion notices intact during viewing and protects captures against scoped cleanup", async () => {
    vi.stubEnv("PI_PATTY_WATCHDOG", "0"); vi.stubEnv("PI_PATTY_WATCHDOG_LOG", "0");
    const cwd = mkdtempSync(join(tmpdir(), "log-lifecycle-"));
    const host = jobHost(cwd);
    const runtime = new JobRuntime(host.pi);
    runtime.installRoot(); await host.emit("session_start");
    const child = await jobChild(runtime, cwd, "owner");
    let view: JobLogView | undefined;
    let release: (() => void) | undefined;
    cleanups.push(async () => {
      view?.dispose(); release?.(); await runtime.dispose(); cleanupTerminal(runtime.registry);
      rmSync(cwd, { recursive: true, force: true });
    });
    await child.execute("bash", { command: "printf 'stdout-live\\n'; sleep 0.3; printf 'stderr-final\\n' >&2; exit 7", run_in_background: true }, "log-test");
    const job = [...runtime.registry.jobs.values()][0];
    release = acquireLogLease(job);
    const close = vi.fn();
    view = new JobLogView(job, vi.fn(), close);
    await until(() => job.status === "failed");
    await view.refresh();
    await until(() => view!.render(160).join("\n").includes("stderr-final"));
    const output = view.render(160).join("\n");
    expect(output).toContain("stdout-live"); expect(output).toContain("stderr-final");
    expect(output).toContain("failed · exit 7");
    expect(close).not.toHaveBeenCalled();
    expect(job.waiters).toBeUndefined();
    expect(host.notices.filter(n => n.customType === EVENT.taskNotification)).toHaveLength(0);
    expect(child.notices.filter(n => n.customType === EVENT.taskNotification)).toHaveLength(1);
    expect(cleanupTerminal(runtime.registry).purged).toBe(0);
    expect((await child.execute("jobs", { action: "cleanup" })).content).toBeDefined();
    expect(runtime.registry.jobs.get(job.id)).toBe(job);
    view.handleInput("\x1b");
    expect(close).toHaveBeenCalledOnce();
    expect(job.status).toBe("failed");
    view.dispose(); release();
    expect(cleanupTerminal(runtime.registry).purged).toBe(1);
    expect(host.notices.filter(n => n.customType === EVENT.taskNotification)).toHaveLength(0);
    expect(child.notices.filter(n => n.customType === EVENT.taskNotification)).toHaveLength(1);
  });
});
