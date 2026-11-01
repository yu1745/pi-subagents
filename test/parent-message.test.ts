import { setImmediate as immediate } from "node:timers/promises";
import type { AgentSession, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { type RunResult, runAgent } from "../src/agent-runner.js";
import { createParentMessageTool } from "../src/parent-message.js";

vi.mock("../src/agent-runner.js", async original => ({
  ...await original<typeof import("../src/agent-runner.js")>(), runAgent: vi.fn(),
}));

describe("child-to-parent interim messages", () => {
  let manager: AgentManager;
  let complete: ReturnType<typeof vi.fn>;
  const sendMessage = vi.fn();
  const pi = { sendMessage } as unknown as ExtensionAPI;
  const ctx = { cwd: process.cwd() } as ExtensionToolContext;
  let finish: Array<() => void>;

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    sendMessage.mockReset();
    complete = vi.fn();
    manager = new AgentManager(complete);
    finish = [];
    vi.mocked(runAgent).mockImplementation(() => new Promise<RunResult>(resolve => {
      finish.push(() => resolve({ responseText: "finished", session: { dispose: vi.fn() } as unknown as AgentSession, aborted: false, steered: false }));
    }));
  });
  afterEach(async () => {
    for (const resolve of finish) resolve();
    await Promise.all(manager.listAgents().map(record => record.promise));
    await manager.dispose();
  });
  const spawn = (parentAgentId?: string) => manager.spawn(pi, ctx, "general-purpose", "task", { description: "task", isBackground: true, parentAgentId });
  const send = (index: number, message: string) => vi.mocked(runAgent).mock.calls[index][3].onParentMessage!(message);

  it("queues a report while the child continues, wakes collection, and preserves its eventual completion", async () => {
    const id = spawn();
    const record = manager.getRecord(id)!;
    const waiting = manager.waitForTerminal(record, undefined, true);
    const tool = createParentMessageTool(message => send(0, message));
    await tool.execute("report", { message: "Need a decision: API source shows two incompatible units." }, undefined, undefined, ctx);
    await waiting;
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: "subagent-message", content: expect.stringContaining(id),
      details: expect.objectContaining({ agentId: id }),
    }), { deliverAs: "steer", triggerTurn: true });
    expect(sendMessage.mock.calls[0][0].content).toContain("Need a decision");
    expect(record.status).toBe("running");
    expect(record.resultConsumed).toBeFalsy();
    expect(complete).not.toHaveBeenCalled();
    finish[0](); await record.promise;
    expect(record.result).toBe("finished");
    expect(complete).toHaveBeenCalledWith(record);
  });

  it("does not miss a report sent just before collection and releases parallel sibling waits", async () => {
    const first = manager.getRecord(spawn())!;
    const sibling = manager.getRecord(spawn())!;
    await send(0, "Plan-changing discovery");
    await Promise.all([manager.waitForTerminal(first, undefined, true), manager.waitForTerminal(sibling, undefined, true)]);
    const next = Promise.all([manager.waitForTerminal(first, undefined, true), manager.waitForTerminal(sibling, undefined, true)]);
    await send(0, "Need a scope decision");
    await next;
    expect([first.status, sibling.status]).toEqual(["running", "running"]);
  });

  it("routes nested reports only to the immediate parent and leaves other parents' waits alone", async () => {
    const parent = manager.getRecord(spawn())!;
    const siblingParent = manager.getRecord(spawn())!;
    const steer = vi.fn().mockResolvedValue("queued");
    parent.session = { steer, isIdle: false, dispose: vi.fn() } as unknown as AgentSession;
    const child = manager.getRecord(spawn(parent.id))!;
    const unrelated = manager.getRecord(spawn(siblingParent.id))!;
    let unrelatedReturned = false;
    const otherWait = manager.waitForTerminal(unrelated, undefined, true).then(() => { unrelatedReturned = true; });
    const waiting = manager.waitForTerminal(child, undefined, true);
    await send(2, "Nested finding"); await waiting;
    await immediate();
    expect(steer).toHaveBeenCalledWith(expect.stringContaining(child.id));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(unrelatedReturned).toBe(false);
    finish[3](); await otherWait;
  });

  it("rejects delivery failures, stopped children and old-session callbacks instead of claiming delivery", async () => {
    const record = manager.getRecord(spawn())!;
    sendMessage.mockImplementationOnce(() => { throw new Error("delivery failed"); });
    await expect(send(0, "hello")).rejects.toThrow("delivery failed");
    manager.abort(record.id);
    await expect(send(0, "late")).rejects.toThrow("no longer running");
    manager.configurePersistence(undefined, "old");
    spawn();
    manager.configurePersistence(undefined, "new");
    await expect(send(1, "stale")).rejects.toThrow("no longer running");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("preserves caller cancellation and rejects blank or cancelled reports", async () => {
    const record = manager.getRecord(spawn())!;
    const controller = new AbortController();
    const waiting = manager.waitForTerminal(record, controller.signal, true);
    controller.abort(new Error("cancel collection"));
    await expect(waiting).rejects.toThrow("cancel collection");
    expect(record.status).toBe("running");
    const sender = vi.fn();
    const tool = createParentMessageTool(sender);
    await expect(tool.execute("blank", { message: "  " }, undefined, undefined, ctx)).rejects.toThrow("blank");
    await expect(tool.execute("cancelled", { message: "hello" }, controller.signal, undefined, ctx)).rejects.toThrow("cancel collection");
    expect(sender).not.toHaveBeenCalled();
  });
});
