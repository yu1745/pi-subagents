import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import type { AgentRecord } from "../src/types.js";
import { createWorktree } from "../src/worktree.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: () => true,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const pi = {} as ExtensionAPI;
const ctx = { cwd: "/tmp" } as ExtensionContext;
const result = { responseText: "DONE", session: { dispose: vi.fn() } as unknown as AgentSession, aborted: false, steered: false };
let manager: AgentManager;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  manager = new AgentManager(undefined, 1);
});
afterEach(async () => {
  await manager.dispose();
  vi.useRealTimers();
});

describe("shared result collection", () => {
  it("waits through queued-to-running startup before the run promise exists", async () => {
    const holder = deferred<Awaited<ReturnType<typeof runAgent>>>();
    const child = deferred<Awaited<ReturnType<typeof runAgent>>>();
    const copy = deferred<Awaited<ReturnType<typeof createWorktree>>>();
    vi.mocked(runAgent).mockReturnValueOnce(holder.promise).mockReturnValueOnce(child.promise);
    vi.mocked(createWorktree).mockReturnValueOnce(copy.promise);
    manager.spawn(pi, ctx, "X", "holder", { description: "holder", isBackground: true });
    const id = manager.spawn(pi, ctx, "X", "child", { description: "child", isBackground: true, isolation: "worktree" });
    const record = manager.getRecord(id)!;
    let returned = false;
    const waiting = manager.waitForTerminal(record).then(() => { returned = true; });
    holder.resolve(result);
    await vi.advanceTimersByTimeAsync(50);
    expect(record.status).toBe("running");
    expect(record.promise).toBeUndefined();
    expect(returned).toBe(false);
    copy.resolve({ path: "/tmp/fake", workPath: "/tmp/fake", branch: "fake", baseSha: "fake" });
    await vi.advanceTimersByTimeAsync(50);
    expect(returned).toBe(false);
    child.resolve(result);
    await waiting;
    expect(record.result).toBe("DONE");
    expect(record.status).toBe("completed");
  });

  it("cancels collection during startup without stopping or consuming the child", async () => {
    const copy = deferred<Awaited<ReturnType<typeof createWorktree>>>();
    vi.mocked(createWorktree).mockReturnValueOnce(copy.promise);
    vi.mocked(runAgent).mockResolvedValueOnce(result);
    const id = manager.spawn(pi, ctx, "X", "child", { description: "child", isBackground: true, isolation: "worktree" });
    const record = manager.getRecord(id)!;
    const controller = new AbortController();
    const waiting = manager.waitForTerminal(record, controller.signal);
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(record.abortController?.signal.aborted).toBe(false);
    expect(record.resultConsumed).not.toBe(true);
    copy.resolve({ path: "/tmp/fake", workPath: "/tmp/fake", branch: "fake", baseSha: "fake" });
    await manager.waitForTerminal(record);
    expect(record.result).toBe("DONE");
  });

  it("does not spin on a previous run's settled promise during foreground resume", async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(result);
    const id = manager.spawn(pi, ctx, "X", "first", { description: "first", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.status = "running";
    let returned = false;
    const waiting = manager.waitForTerminal(record).then(() => { returned = true; });
    await vi.advanceTimersByTimeAsync(50);
    expect(returned).toBe(false);
    record.status = "completed";
    await vi.advanceTimersByTimeAsync(50);
    await waiting;
    expect(returned).toBe(true);
  });

  it("resolves exact IDs and handles before unique prefixes and rejects ambiguity", () => {
    const a = { id: "12345678-aaaa", handle: "explore", alias: "audit" } as AgentRecord;
    const b = { id: "12345678-bbbb", handle: "12345678" } as AgentRecord;
    Reflect.set(manager, "agents", new Map([[a.id, a], [b.id, b]]));
    expect(manager.resolveAgentRef(a.id)).toBe(a);
    expect(manager.resolveAgentRef("AUDIT")).toBe(a);
    expect(manager.resolveAgentRef("12345678")).toBe(b);
    b.handle = "plan";
    expect(() => manager.resolveAgentRef("12345678")).toThrow("Ambiguous agent ID prefix");
    expect(manager.resolveAgentRef("12345678-a")).toBe(a);
    expect(manager.resolveAgentRef("1234567")).toBeUndefined();
    b.parentAgentId = "owner";
    expect(manager.resolveAgentRef("12345678")).toBe(a);
    expect(manager.resolveAgentRef("12345678", "owner")).toBe(b);
    expect(manager.resolveAgentRef(a.id, "owner")).toBeUndefined();
  });
});
