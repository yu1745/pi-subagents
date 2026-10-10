import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import * as lifecycle from "../src/jobs/patty/lifecycle.js";
import { terminateJobSilently } from "../src/jobs/patty/lifecycle.js";
import { acquireLogLease, hasLogReaders } from "../src/jobs/patty/log-leases.js";
import { cleanupJob, cleanupTerminal, deleteJobLogs } from "../src/jobs/patty/registry.js";
import { registerShortcuts } from "../src/jobs/patty/shortcuts.js";
import { BackgroundRegistry } from "../src/jobs/patty/state.js";
import type { Job } from "../src/jobs/patty/types.js";
import type { AgentRecord } from "../src/types.js";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";
import { openJobLogView } from "../src/ui/job-log-view.js";
import { jobHost } from "./helpers/job-runtime.js";
import { flushViews, nativeViewer } from "./helpers/session-view.js";

vi.mock("../src/jobs/patty/lifecycle.js", async original => ({
  ...await original<typeof lifecycle>(),
  terminateJobSilently: vi.fn(async () => true),
}));
vi.mock("../src/ui/job-log-view.js", () => ({ openJobLogView: vi.fn() }));

const DOWN = "\x1b[B", UP = "\x1b[A", LEFT = "\x1b[D", RIGHT = "\x1b[C", ESC = "\x1b", ENTER = "\r";
const theme = { fg: (colour: string, text: string) => `<${colour}>${text}</${colour}>`, bold: (text: string) => text };
const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); vi.useRealTimers(); vi.clearAllMocks(); });

function job(id: string, ownerAgentId?: string): Job {
  return { id, ownerAgentId, ownerSessionId: ownerAgentId ? "child-session" : "root", command: `command-${id}`, logPath: `/missing/${id}.log`, pid: 0, startTime: 0, status: "running", toolCallId: id, isBackgrounded: true };
}
function agent(id: string, more: Partial<AgentRecord> = {}): AgentRecord {
  return { id, type: "general-purpose", description: `Agent-${id}`, status: "running", startedAt: 0, toolUses: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0, ...more } as AgentRecord;
}
function harness(records: AgentRecord[], jobs: Job[]) {
  const reg = new BackgroundRegistry();
  reg.retainResults = true;
  for (const j of jobs) reg.jobs.set(j.id, j);
  const native = nativeViewer();
  const manager = {
    listAgents: () => records, getRecord: (id: string) => records.find(r => r.id === id),
    hasJobRuntime: true, hasSessionViews: () => false, abort: vi.fn(() => true), steer: vi.fn(),
    acquireSessionView: (record: AgentRecord) => {
      const controller = new AbortController();
      return { session: record.session, signal: controller.signal, close: () => controller.abort(), release: vi.fn() };
    },
  } as unknown as AgentManager;
  let widget: { render(width: number): string[] } | undefined;
  const requestRender = vi.fn();
  let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
  const ui: FleetUICtx = {
    notify: vi.fn(), getEditorText: () => "", viewSession: native.viewSession,
    onTerminalInput: handler => { input = handler; return () => { input = undefined; }; },
    setWidget: (_key, factory) => { widget = factory?.({ requestRender }, theme); },
  };
  const fleet = new FleetList(manager);
  fleet.setJobSource(reg, () => "root");
  fleet.setUICtx(ui);
  fleet.update();
  disposers.push(() => fleet.dispose());
  const lines = () => widget?.render(240) ?? [];
  const press = (key: string) => input?.(key);
  const select = (needle: string) => {
    press(ESC); press(DOWN);
    for (let n = 0; n < 50; n++) {
      if (lines().some(line => line.includes("●") && line.includes(needle))) return;
      press(DOWN);
    }
    throw new Error(`Row not reachable: ${needle}\n${lines().join("\n")}`);
  };
  return { fleet, reg, ui, manager, lines, press, select, native, requestRender };
}

describe("unified task tree", () => {
  it("keeps short child commands in Completed without changing the tree height", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const done = { ...job("done", "a"), status: "completed" as const };
    const h = harness([agent("a")], [done]);
    const height = h.lines().length;
    const quick = { ...job("quick", "a"), startTime: Date.now() };
    h.reg.jobs.set(quick.id, quick);
    h.fleet.update();
    vi.advanceTimersByTime(499);
    expect(h.lines().length).toBe(height);
    expect(h.lines().join("\n")).not.toContain("command-quick");
    quick.status = "completed";
    h.fleet.update();
    expect(h.lines().length).toBe(height);
    expect(h.lines().join("\n")).toContain("Completed (2)");
    h.select("Completed"); h.press(ENTER);
    expect(h.lines().join("\n")).toContain("command-quick");
  });

  it("shows a lone main command after 500ms and keeps the refresh timer alive", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const h = harness([], [{ ...job("slow"), startTime: Date.now() }]);
    expect(h.lines()).toEqual([]);
    vi.advanceTimersByTime(499);
    expect(h.lines()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.lines().join("\n")).toContain("command-slow");
    h.requestRender.mockClear();
    vi.advanceTimersByTime(100);
    expect(h.requestRender).toHaveBeenCalled();
    h.select("command-slow");
    expect(h.lines().some(line => line.includes("●") && line.includes("command-slow"))).toBe(true);
  });

  it("nests owned bash under visible Agents and excludes foreign sessions and hidden owners", () => {
    const h = harness([agent("a"), agent("hidden", { parentAgentId: "a" })], [job("owned", "a"), job("main"), job("secret", "hidden"), { ...job("foreign"), ownerSessionId: "elsewhere" }]);
    const text = h.lines().join("\n");
    expect(text).toContain("Agent-a");
    expect(text).toContain("command-owned");
    expect(text).toContain("command-main");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("foreign");
    h.select("Agent-a"); h.press(LEFT);
    expect(h.lines().join("\n")).not.toContain("command-owned");
    expect(h.lines().join("\n")).toContain("command-main");
    h.press(RIGHT);
    expect(h.lines().join("\n")).toContain("command-owned");
    h.select("main"); h.press(LEFT);
    expect(h.lines().join("\n")).not.toContain("Agent-a");
    h.press(RIGHT);
    expect(h.lines().join("\n")).toContain("Agent-a");
  });

  it("keeps selection identity when an Agent or owned job is inserted between UI ticks", () => {
    const records: AgentRecord[] = [];
    const h = harness(records, [job("first"), job("second")]);
    h.select("command-first");
    records.push(agent("late"));
    h.reg.jobs.set("child", job("child", "late"));
    expect(h.lines().some(line => line.includes("●") && line.includes("command-first"))).toBe(true);
    h.press(DOWN);
    expect(h.lines().some(line => line.includes("●") && line.includes("command-second"))).toBe(true);
    h.select("main"); h.press(LEFT); h.press(ESC); h.press(DOWN); h.press(RIGHT);
    expect(h.lines().join("\n")).toContain("command-first");
  });

  it("retains completed logs grouped by owner after Agent GC and cleans only explicitly", () => {
    const records = [agent("a")];
    const j = { ...job("retained", "a"), status: "failed" as const, exitCode: 7, endTime: 10 };
    const h = harness(records, [j]);
    records.length = 0;
    h.fleet.update();
    expect(h.lines().join("\n")).toContain("Agent-a (session released)");
    expect(h.lines().join("\n")).toContain("Completed (1, 1 failed/stopped)");
    expect(h.lines().join("\n")).not.toContain("command-retained");
    h.select("Completed"); h.press(ENTER);
    expect(h.lines().join("\n")).toContain("<error>failed exit=7");
    h.select("command-retained"); h.press("d"); h.press(ESC);
    expect(h.reg.jobs.has(j.id)).toBe(true);
    h.press("d"); h.press(ENTER);
    expect(h.reg.jobs.has(j.id)).toBe(false);
    expect(j.notified).toBeUndefined();
  });

  it("switches Agent/native and bash/log details without consuming completion or steering bash", async () => {
    const session = { subscribe: () => () => {}, messages: [] } as unknown as NonNullable<AgentRecord["session"]>;
    const record = agent("a", { session });
    const j = job("log", "a");
    const h = harness([record], [j]);
    h.select("Agent-a"); h.press(ENTER); await flushViews();
    expect(h.native.views[0].session).toBe(session);
    h.native.views[0].close(); await flushViews();
    let resolve!: () => void;
    const controller = new AbortController();
    vi.mocked(openJobLogView).mockImplementation(() => ({ close: () => { controller.abort(); resolve(); }, signal: controller.signal, closed: new Promise<void>(r => { resolve = r; }) }));
    h.select("command-log"); h.press("\u001b[115;7u");
    expect(openJobLogView).not.toHaveBeenCalled();
    h.press(ENTER);
    expect(openJobLogView).toHaveBeenCalledWith(h.ui, j);
    expect(hasLogReaders(j)).toBe(true);
    expect(h.press(DOWN)).toBeUndefined();
    j.status = "completed"; j.exitCode = 0; j.endTime = Date.now(); h.fleet.update();
    expect(controller.signal.aborted).toBe(false);
    expect(cleanupTerminal(h.reg).purged).toBe(0);
    resolve(); await flushViews();
    expect(hasLogReaders(j)).toBe(false);
    expect(h.lines().some(line => line.includes("●") && line.includes("command-log"))).toBe(true);
    expect(h.press(UP)).toEqual({ consume: true });
    expect(j.notified).toBeUndefined();
    expect(j.waiters).toBeUndefined();
    expect(record.resultConsumed).toBeUndefined();
    expect(h.manager.steer).not.toHaveBeenCalled();
    expect(h.manager.abort).not.toHaveBeenCalled();
  });

  it("requires typed stop confirmation and never crosses Agent/bash stop scope", async () => {
    const record = agent("a"); const j = job("log", "a");
    const h = harness([record], [j]);
    h.select("command-log"); h.press("x");
    expect(h.lines()[0]).toContain("Agent continues");
    h.press(ESC);
    expect(terminateJobSilently).not.toHaveBeenCalled();
    h.press("x"); h.press(ENTER); await flushViews();
    expect(terminateJobSilently).toHaveBeenCalledWith(h.reg, j);
    expect(h.manager.abort).not.toHaveBeenCalled();
    h.select("Agent-a"); h.press("x");
    expect(h.lines()[0]).toContain("owned tasks/descendants");
    h.press("n");
    expect(h.manager.abort).not.toHaveBeenCalled();
    h.press("x"); h.press("y"); await flushViews();
    expect(h.manager.abort).toHaveBeenCalledWith("a");
    expect(terminateJobSilently).toHaveBeenCalledTimes(1);
  });

  it("revalidates exact task identity after confirmation and on disposal", async () => {
    const j = job("original"); const h = harness([], [j]);
    h.select("command-original"); h.press("x");
    h.reg.jobs.set(j.id, { ...j });
    h.press(ENTER); await flushViews();
    expect(terminateJobSilently).not.toHaveBeenCalled();
    h.press("x"); h.fleet.dispose(); h.press(ENTER);
    expect(terminateJobSilently).not.toHaveBeenCalled();
  });

  it("confirms the legacy stop shortcut and rechecks the job after confirmation", async () => {
    const host = jobHost(process.cwd());
    const reg = new BackgroundRegistry(); const j = job("shortcut"); reg.jobs.set(j.id, j);
    const confirm = vi.fn(async () => false);
    Object.assign(host.ctx.ui, { confirm });
    registerShortcuts(host.pi, reg);
    const shortcut = vi.mocked(host.pi.registerShortcut).mock.calls.find(([key]) => key === "ctrl+shift+x")![1];
    await shortcut.handler(host.ctx);
    expect(confirm).toHaveBeenCalledWith("Stop bash task?", expect.stringContaining("Agent will not be stopped"));
    expect(terminateJobSilently).not.toHaveBeenCalled();
    confirm.mockResolvedValueOnce(true);
    await shortcut.handler(host.ctx);
    expect(terminateJobSilently).toHaveBeenCalledWith(reg, j);
    confirm.mockImplementationOnce(async () => { reg.jobs.delete(j.id); return true; });
    await shortcut.handler(host.ctx);
    expect(terminateJobSilently).toHaveBeenCalledTimes(1);
  });

  it("removes both independent background-navigation shortcuts", () => {
    const host = jobHost(process.cwd());
    registerShortcuts(host.pi, new BackgroundRegistry());
    expect(host.pi.registerShortcut).not.toHaveBeenCalledWith("shift+down", expect.anything());
    expect(host.pi.registerShortcut).not.toHaveBeenCalledWith("ctrl+shift+j", expect.anything());
    expect(host.pi.registerShortcut).toHaveBeenCalledWith("ctrl+shift+b", expect.anything());
  });
});

describe("log read leases", () => {
  it("protects files across concurrent scoped cleanup and releases idempotently without wait/notice changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-tree-lease-"));
    disposers.push(() => rmSync(dir, { recursive: true, force: true }));
    const j = { ...job("lease"), status: "completed" as const, logPath: join(dir, "lease.log") };
    writeFileSync(j.logPath, "stdout\nstderr\n");
    const parent = new BackgroundRegistry(); parent.jobs.set(j.id, j);
    const child = new BackgroundRegistry(); child.jobs = parent.jobs;
    const a = acquireLogLease(j), b = acquireLogLease(j);
    expect(cleanupTerminal(parent).purged).toBe(0);
    expect(cleanupJob(child, j)).toBe(false);
    expect(deleteJobLogs(j)).toBe(0);
    expect(existsSync(j.logPath)).toBe(true);
    a(); a();
    expect(cleanupTerminal(child).purged).toBe(0);
    b();
    expect(cleanupTerminal(parent).purged).toBe(1);
    expect(existsSync(j.logPath)).toBe(false);
    expect(j.notified).toBeUndefined(); expect(j.waiters).toBeUndefined();
  });
});
