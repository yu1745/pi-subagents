import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, type SessionViewLease } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { openAgentSessionView } from "../src/ui/session-view.js";
import { flushViews, nativeViewer } from "./helpers/session-view.js";

vi.mock("../src/ui/native-pi-1.0.0/index.js", () => ({
  SUPPORTED_PI_VERSION: "1.0.0",
  getNativeSessionViewUnavailableReason: () => "Readonly viewing requires the Pi 1.0.0 runtime patch; reload or restart Pi.",
}));

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(), cleanupWorktree: vi.fn(), pruneWorktrees: vi.fn(),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";

const TICK = 60_000;
const RETENTION = 10 * TICK;

describe("native session view leases", () => {
  let manager: AgentManager;
  let native: ReturnType<typeof nativeViewer>;
  let leases: SessionViewLease[];

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new AgentManager();
    native = nativeViewer();
    leases = [];
  });
  afterEach(async () => {
    for (const view of native.views) view.close();
    await flushViews();
    for (const lease of leases) lease.release();
    await manager.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function settled() {
    const session = {
      dispose: vi.fn(),
      steer: vi.fn(),
      prompt: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      messages: [],
      extensionRunner: { hasHandlers: () => true, emit: vi.fn(async () => {}) },
    };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done", session: session as unknown as AgentSession, aborted: false, steered: false,
    });
    const id = manager.spawn({} as never, { cwd: "/tmp" } as never, "general-purpose", "read", {
      description: "Read the routes", isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.resultConsumed = true;
    record.completedAt = Date.now() - RETENTION - TICK;
    record.sessionFile = "/sessions/child.jsonl";
    return { record, session };
  }
  function acquire(record: AgentRecord) {
    const lease = manager.acquireSessionView(record)!;
    expect(lease).toBeDefined();
    leases.push(lease);
    return lease;
  }

  it("refcounts the exact record, defers timed GC, and releases idempotently", async () => {
    const { record, session } = await settled();
    const first = acquire(record);
    const second = acquire(record);
    expect(first.session).toBe(record.session);
    expect(second.session).toBe(first.session);
    expect(manager.acquireSessionView({ ...record })).toBeUndefined();
    await vi.advanceTimersByTimeAsync(TICK);
    expect(manager.getRecord(record.id)).toBe(record);
    expect(record.session).toBe(first.session);
    expect(session.extensionRunner.emit).not.toHaveBeenCalled();
    first.release();
    first.release();
    expect(manager.hasSessionViews()).toBe(true);
    expect(session.dispose).not.toHaveBeenCalled();
    second.release();
    await flushViews();
    expect(manager.hasSessionViews()).toBe(false);
    expect(manager.getRecord(record.id)).toBeUndefined();
    expect(record.session).toBeUndefined();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(manager.resolveMention(record.handle!)?.kind).toBe("tombstone");
    expect(session.extensionRunner.emit.mock.invocationCallOrder[0]).toBeLessThan(session.dispose.mock.invocationCallOrder[0]);
  });

  it.each([false, true])("defers clearCompleted(%s) across a boundary without resurrecting handles", async skipUnconsumed => {
    const { record, session } = await settled();
    const first = acquire(record);
    const second = acquire(record);
    manager.clearCompleted(skipUnconsumed);
    manager.configurePersistence(undefined, "next-parent");
    // A later timer cannot downgrade a boundary removal into a tombstoning GC.
    await vi.advanceTimersByTimeAsync(TICK);
    first.release();
    expect(manager.getRecord(record.id)).toBe(record);
    expect(session.dispose).not.toHaveBeenCalled();
    second.release();
    await flushViews();
    expect(manager.getRecord(record.id)).toBeUndefined();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(manager.listTombstones()).toEqual([]);
    expect(manager.resolveMention(record.handle!)).toBeUndefined();
  });

  it("does not consume unread results or evict them on release", async () => {
    const { record, session } = await settled();
    record.resultConsumed = false;
    const lease = acquire(record);
    manager.clearCompleted(true);
    await vi.advanceTimersByTimeAsync(TICK);
    lease.release();
    expect(record.resultConsumed).toBe(false);
    expect(manager.getRecord(record.id)).toBe(record);
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it("rechecks consumption and age rather than executing a stale timed sweep", async () => {
    const { record, session } = await settled();
    const lease = acquire(record);
    await vi.advanceTimersByTimeAsync(TICK);
    record.completedAt = Date.now();
    record.resultConsumed = false;
    lease.release();
    expect(manager.getRecord(record.id)).toBe(record);
    expect(session.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RETENTION + TICK);
    expect(manager.getRecord(record.id)).toBe(record);
    record.resultConsumed = true;
    await vi.advanceTimersByTimeAsync(TICK);
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("a new continuation cancels deferred eviction without treating viewing as execution", async () => {
    const { record, session } = await settled();
    const lease = acquire(record);
    manager.clearCompleted();
    vi.mocked(resumeAgent).mockResolvedValue({ text: "new result" });
    expect(await manager.resume(record.id, "continue")).toBe(record);
    lease.release();
    await flushViews();
    expect(record.result).toBe("new result");
    expect(manager.getRecord(record.id)).toBe(record);
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it("never disposes a resumed run still settling when the last lease releases", async () => {
    const { record, session } = await settled();
    const lease = acquire(record);
    manager.clearCompleted();
    let finish!: (result: { text: string }) => void;
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const resumed = manager.resume(record.id, "continue");
    manager.abort(record.id); // terminal status, but the run remains inFlight
    manager.clearCompleted();
    lease.release();
    expect(session.dispose).not.toHaveBeenCalled();
    finish({ text: "partial" });
    await resumed;
    expect(manager.getRecord(record.id)).toBe(record);
  });

  it("uses only the readonly API, preserving method receiver and execution state", async () => {
    const { record, session } = await settled();
    record.resultConsumed = false;
    const ui = { notify: vi.fn(), custom: vi.fn(), viewSession: native.viewSession };
    const handle = openAgentSessionView(manager, ui, record)!;
    expect(manager.hasSessionViews()).toBe(true); // before the first await
    await flushViews();
    expect(native.viewSession.mock.contexts[0]).toBe(ui);
    expect(native.views[0].session).toBe(record.session);
    expect(native.views[0].options).toEqual({
      title: expect.stringContaining(`${record.description} · ${record.id}`), signal: handle.signal,
    });
    expect(handle.signal).not.toBe(record.abortController?.signal);
    handle.close();
    await handle.closed;
    expect(handle.signal.aborted).toBe(true);
    expect(record.abortController?.signal.aborted).toBe(false);
    expect(record.resultConsumed).toBe(false);
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(session.subscribe).not.toHaveBeenCalled(); // core owns rendering/subscriptions
    expect(ui.custom).not.toHaveBeenCalled();
    expect(manager.hasSessionViews()).toBe(false);
  });

  it("can close before core opens without leaking a pin", async () => {
    const { record } = await settled();
    const handle = openAgentSessionView(manager, { notify: vi.fn(), viewSession: native.viewSession }, record)!;
    handle.close();
    await handle.closed;
    expect(native.viewSession).not.toHaveBeenCalled();
    expect(manager.hasSessionViews()).toBe(false);
  });

  it.each([undefined, null, "not callable"])("requires the exact-version runtime patch, without acquiring a lease: %s", async capability => {
    const { record } = await settled();
    const acquireSpy = vi.spyOn(manager, "acquireSessionView");
    const ui = { notify: vi.fn(), custom: vi.fn(), viewSession: capability };
    expect(openAgentSessionView(manager, ui as never, record)).toBeUndefined();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Pi 1.0.0 runtime patch"), "warning");
    expect(ui.custom).not.toHaveBeenCalled();
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it("refuses stale/sessionless records and acquisition after disposal", async () => {
    const { record } = await settled();
    const ui = { notify: vi.fn(), viewSession: native.viewSession };
    expect(openAgentSessionView(manager, ui, { ...record })).toBeUndefined();
    manager.clearCompleted();
    expect(openAgentSessionView(manager, ui, record)).toBeUndefined();
    await manager.dispose();
    expect(manager.acquireSessionView(record)).toBeUndefined();
    expect(native.viewSession).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("no session available"), "info");
  });

  it.each(["throw", "reject"])("releases a lease on native open failure: %s", async failure => {
    const { record, session } = await settled();
    native.viewSession.mockImplementation(() => {
      if (failure === "throw") throw new Error("native failed");
      return Promise.reject(new Error("native failed"));
    });
    const handle = openAgentSessionView(manager, { notify: vi.fn(), viewSession: native.viewSession }, record)!;
    manager.clearCompleted();
    await expect(handle.closed).rejects.toThrow("native failed");
    await flushViews();
    expect(manager.hasSessionViews()).toBe(false);
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("shutdown aborts every presentation and waits for detach before child disposal", async () => {
    const { record, session } = await settled();
    native = nativeViewer(false); // core detaches asynchronously after signal
    const ui = { notify: vi.fn(), viewSession: native.viewSession };
    const first = openAgentSessionView(manager, ui, record)!;
    const second = openAgentSessionView(manager, ui, record)!;
    await flushViews();
    const shutdown = manager.dispose();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(manager.acquireSessionView(record)).toBeUndefined();
    native.views[0].close();
    await first.closed;
    expect(session.extensionRunner.emit).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    native.views[1].fail(new Error("presentation aborted"));
    await second.closed; // cancellation is normal, not a detached rejection
    await shutdown;
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(record.session).toBeUndefined();
  });

  it("closing all views is presentation-only and refuses reentrant opens until detached", async () => {
    const { record, session } = await settled();
    record.status = "running";
    native = nativeViewer(false);
    const view = openAgentSessionView(manager, { notify: vi.fn(), viewSession: native.viewSession }, record)!;
    await flushViews();
    const closing = manager.closeSessionViews();
    expect(view.signal.aborted).toBe(true);
    expect(manager.acquireSessionView(record)).toBeUndefined();
    expect(record.status).toBe("running");
    expect(record.abortController!.signal.aborted).toBe(false);
    native.views[0].close();
    await closing;
    expect(session.dispose).not.toHaveBeenCalled();
    const next = acquire(record);
    next.release();
  });
});
