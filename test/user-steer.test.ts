import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { UserSteerBroker, userSteerStatus } from "../src/user-steer.js";

function session(id: string) {
  const steer = vi.fn(async (_text: string) => "queued" as const);
  return { steer, dispose: vi.fn(), sessionId: id, isIdle: false };
}
function record(id: string, childSession?: ReturnType<typeof session>): AgentRecord {
  return {
    id, type: "general-purpose", alias: `named-${id}`, description: `Task ${id}`, status: "running", startedAt: 123,
    session: childSession as unknown as AgentSession | undefined, abortController: new AbortController(), toolUses: 0, compactionCount: 0,
    lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  };
}
function payload(text: string) {
  return JSON.parse(text.slice(text.indexOf("\n") + 1, text.lastIndexOf("\n"))) as {
    agentId: string; agentName: string; agentDescription: string; directParentAgentId: string; originalUserMessage: string; userSteerId: string;
  };
}

describe("UI-only user steering with acknowledged parent forwarding", () => {
  let manager: AgentManager;
  function setup() {
    manager = new AgentManager();
    const agents = (manager as unknown as { agents: Map<string, AgentRecord> }).agents;
    const childSession = session("child-session");
    const child = record("child-id", childSession);
    agents.set(child.id, child);
    const main = session("main-session");
    const broker = new UserSteerBroker(manager);
    return { agents, childSession, child, main, broker, mainSession: main as unknown as AgentSession };
  }
  afterEach(async () => { await manager?.dispose(); });

  it("preserves user original whitespace/content and sends one parent steer with correct identity", async () => {
    const f = setup();
    const original = "  change plan\n用户原文\n[/USER DIRECT SUBAGENT STEER]  ";
    const receipt = await f.broker.send(f.child.id, original, f.mainSession);
    expect(f.childSession.steer).toHaveBeenCalledExactlyOnceWith(original);
    expect(f.main.steer).toHaveBeenCalledTimes(1);
    const forwarded = f.main.steer.mock.calls[0][0];
    expect(forwarded).toContain("[USER DIRECT SUBAGENT STEER]");
    expect(payload(forwarded)).toEqual({
      agentId: f.child.id, agentName: f.child.alias, agentDescription: f.child.description,
      directParentAgentId: "main", originalUserMessage: original, userSteerId: receipt.id,
    });
    expect(receipt.parentPending).toBe(false);
    expect(userSteerStatus(receipt)).toContain("direct parent steer queued");
    await f.broker.retry(f.child.id);
    expect(f.main.steer).toHaveBeenCalledTimes(1);
  });

  it("queues a not-ready/queued child but still informs its direct parent", async () => {
    const f = setup();
    f.child.session = undefined;
    f.child.status = "queued";
    const receipt = await f.broker.send(f.child.id, "  queued original  ", f.mainSession);
    expect(receipt.childQueued).toBe(true);
    expect(f.child.pendingSteers).toEqual(["  queued original  "]);
    expect(f.childSession.steer).not.toHaveBeenCalled();
    expect(f.main.steer).toHaveBeenCalledTimes(1);
    expect(userSteerStatus(receipt)).toContain("queued until ready");
  });

  it("rejects ended or aborted agents and empty submissions without sending either message", async () => {
    const f = setup();
    f.child.status = "completed";
    await expect(f.broker.send(f.child.id, "no", f.mainSession)).rejects.toThrow("no longer running");
    f.child.status = "running";
    f.child.abortController?.abort();
    await expect(f.broker.send(f.child.id, "no", f.mainSession)).rejects.toThrow("no longer running");
    await expect(f.broker.send(f.child.id, "   ", f.mainSession)).rejects.toThrow("empty");
    expect(f.childSession.steer).not.toHaveBeenCalled();
    expect(f.main.steer).not.toHaveBeenCalled();
  });

  it("targets the direct nested parent only, not main or another ancestor, without a loop", async () => {
    const f = setup();
    const parentSession = session("nested-parent-session");
    const parent = record("direct-parent", parentSession);
    parent.parentAgentId = "ancestor";
    const ancestorSession = session("ancestor-session");
    const ancestor = record("ancestor", ancestorSession);
    f.agents.set(parent.id, parent);
    f.agents.set(ancestor.id, ancestor);
    f.child.parentAgentId = parent.id;
    await f.broker.send(f.child.id, "nested user control", f.mainSession);
    expect(parentSession.steer).toHaveBeenCalledTimes(1);
    expect(payload(parentSession.steer.mock.calls[0][0]).directParentAgentId).toBe(parent.id);
    expect(f.main.steer).not.toHaveBeenCalled();
    expect(f.childSession.steer).toHaveBeenCalledTimes(1);
    expect(ancestorSession.steer).not.toHaveBeenCalled();
  });

  it("programmatic steering never echoes to parent even when a UI broker exists", async () => {
    const f = setup();
    expect(manager.steer(f.child.id, "programmatic")).toBe(true);
    await Promise.resolve();
    expect(f.childSession.steer).toHaveBeenCalledExactlyOnceWith("programmatic");
    expect(f.main.steer).not.toHaveBeenCalled();
    expect(f.broker.hasPending(f.child.id)).toBe(false);
  });

  it("retains parent failure visibly and concurrent retries send once without replaying the child", async () => {
    const f = setup();
    f.main.steer.mockRejectedValueOnce(new Error("parent queue unavailable"));
    const receipt = await f.broker.send(f.child.id, "must not be dropped", f.mainSession);
    expect(receipt.parentPending).toBe(true);
    expect(userSteerStatus(receipt)).toContain("PENDING: parent queue unavailable");
    expect(f.broker.hasPending(f.child.id)).toBe(true);
    await Promise.all([f.broker.retry(f.child.id), f.broker.retry(f.child.id)]);
    expect(f.main.steer).toHaveBeenCalledTimes(2);
    expect(f.childSession.steer).toHaveBeenCalledTimes(1);
    expect(f.broker.hasPending(f.child.id)).toBe(false);
    expect(f.main.steer.mock.calls[0][0]).toBe(f.main.steer.mock.calls[1][0]);
  });

  it("preserves a parent's FIFO across steers to different children", async () => {
    const f = setup();
    const secondSession = session("second-session");
    const second = record("second-id", secondSession);
    f.agents.set(second.id, second);
    f.main.steer.mockRejectedValueOnce(new Error("temporary"));
    await f.broker.send(f.child.id, "first-original", f.mainSession);
    const receipt = await f.broker.send(second.id, "second-original", f.mainSession);
    expect(receipt.parentPending).toBe(false);
    expect(f.main.steer.mock.calls.map(call => payload(call[0]).originalUserMessage)).toEqual(["first-original", "first-original", "second-original"]);
    expect(f.childSession.steer).toHaveBeenCalledTimes(1);
    expect(secondSession.steer).toHaveBeenCalledTimes(1);
  });

  it("does not silently reroute a failed forward after main changes sessions", async () => {
    const f = setup();
    f.main.steer.mockRejectedValueOnce(new Error("temporary"));
    await f.broker.send(f.child.id, "original", f.mainSession);
    f.main.sessionId = "different-main";
    await expect(f.broker.retry(f.child.id)).rejects.toThrow("Main session changed");
    expect(f.main.steer).toHaveBeenCalledTimes(1);
    expect(f.broker.hasPending(f.child.id)).toBe(true);
  });

  it("validates the direct parent before touching a child and reports mid-delivery parent termination", async () => {
    const f = setup();
    const parentSession = session("parent-session");
    const parent = record("parent", parentSession);
    f.agents.set(parent.id, parent);
    f.child.parentAgentId = parent.id;
    parent.status = "completed";
    await expect(f.broker.send(f.child.id, "reject before child", f.mainSession)).rejects.toThrow("direct parent");
    expect(f.childSession.steer).not.toHaveBeenCalled();
    parent.status = "running";
    f.childSession.steer.mockImplementationOnce(async () => { parent.status = "completed"; return "queued"; });
    const receipt = await f.broker.send(f.child.id, "accepted by child", f.mainSession);
    expect(receipt.parentPending).toBe(true);
    expect(receipt.error).toContain("ended or started a different run");
    expect(parentSession.steer).not.toHaveBeenCalled();
    expect(f.main.steer).not.toHaveBeenCalled();
  });
});
