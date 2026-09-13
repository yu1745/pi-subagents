import { describe, expect, it, vi } from "vitest";
import {
  appendContextManagementAgentIdentity,
  CONTEXT_MANAGEMENT_AGENT_IDENTITY,
  isValidContextManagementAgentName,
} from "../src/context-management-identity.js";

type IdentityData = {
  version: 1;
  sessionId: string;
  rootSessionId: string;
  agentName: string;
};

function identity(data: IdentityData) {
  return { type: "custom", customType: CONTEXT_MANAGEMENT_AGENT_IDENTITY, data };
}

function manager(sessionId: string, entries: unknown[] = []) {
  return {
    getSessionId: vi.fn(() => sessionId),
    getEntries: vi.fn(() => entries),
    appendCustomEntry: vi.fn(),
  };
}

describe("context-management agent identity", () => {
  it("places a root child in the parent's actual root session and stable agent namespace", () => {
    const parent = manager("root-session");
    const child = manager("child-session");

    appendContextManagementAgentIdentity(parent, child, "e46f1d3a-0f4b-4da4-a0a5-77dcd0c3955a");

    expect(child.appendCustomEntry).toHaveBeenCalledWith(CONTEXT_MANAGEMENT_AGENT_IDENTITY, {
      version: 1,
      sessionId: "child-session",
      rootSessionId: "root-session",
      agentName: "/root/e46f1d3a-0f4b-4da4-a0a5-77dcd0c3955a",
    });
  });

  it("extends a valid parent identity for nested agents while retaining the root session", () => {
    const parent = manager("parent-session", [identity({
      version: 1,
      sessionId: "parent-session",
      rootSessionId: "root-session",
      agentName: "/root/parent-agent",
    })]);
    const child = manager("child-session");

    appendContextManagementAgentIdentity(parent, child, "nested-agent");

    expect(child.appendCustomEntry).toHaveBeenCalledWith(CONTEXT_MANAGEMENT_AGENT_IDENTITY, expect.objectContaining({
      rootSessionId: "root-session",
      agentName: "/root/parent-agent/nested-agent",
    }));
  });

  it("does not append duplicate metadata when a resumed child already has its own valid identity", () => {
    const parent = manager("parent-session");
    const child = manager("child-session", [identity({
      version: 1,
      sessionId: "child-session",
      rootSessionId: "root-session",
      agentName: "/root/existing-agent",
    })]);

    appendContextManagementAgentIdentity(parent, child, "new-agent");

    expect(child.appendCustomEntry).not.toHaveBeenCalled();
  });

  it("ignores fork-copied metadata whose session id does not equal the current parent", () => {
    const parent = manager("fork-session", [identity({
      version: 1,
      sessionId: "original-session",
      rootSessionId: "root-session",
      agentName: "/root/original-agent",
    })]);
    const child = manager("child-session");

    appendContextManagementAgentIdentity(parent, child, "child-agent");

    expect(child.appendCustomEntry).toHaveBeenCalledWith(CONTEXT_MANAGEMENT_AGENT_IDENTITY, expect.objectContaining({
      rootSessionId: "fork-session",
      agentName: "/root/child-agent",
    }));
  });

  it("creates an independent root identity when there is no parent context", () => {
    const child = manager("standalone-session");

    appendContextManagementAgentIdentity(undefined, child, "standalone-agent");

    expect(child.appendCustomEntry).toHaveBeenCalledWith(CONTEXT_MANAGEMENT_AGENT_IDENTITY, expect.objectContaining({
      rootSessionId: "standalone-session",
      agentName: "/root/standalone-agent",
    }));
  });

  it("does not make memory-like or incomplete SessionManager mocks fail child startup", () => {
    expect(() => appendContextManagementAgentIdentity(
      { getSessionId: () => "parent" },
      { getSessionId: () => "child" },
      "agent",
    )).not.toThrow();
    expect(() => appendContextManagementAgentIdentity(
      undefined,
      { appendCustomEntry: vi.fn() },
      "agent",
    )).not.toThrow();
  });

  it("rejects unsafe paths and invalid root ids, then falls back from an invalid agent id", () => {
    expect(isValidContextManagementAgentName("/root/agent_1")).toBe(true);
    expect(isValidContextManagementAgentName("/root/notes")).toBe(false);
    expect(isValidContextManagementAgentName("/root/../agent")).toBe(false);
    expect(isValidContextManagementAgentName("root/agent")).toBe(false);
    expect(isValidContextManagementAgentName("/other/agent")).toBe(false);
    expect(isValidContextManagementAgentName(`/root/${"a".repeat(1020)}`)).toBe(false);

    const parent = manager("parent-session", [identity({
      version: 1,
      sessionId: "parent-session",
      rootSessionId: "root\0session",
      agentName: "/root/notes",
    })]);
    const child = manager("safe-child-id");
    appendContextManagementAgentIdentity(parent, child, "../../display-name");

    expect(child.appendCustomEntry).toHaveBeenCalledWith(CONTEXT_MANAGEMENT_AGENT_IDENTITY, expect.objectContaining({
      rootSessionId: "parent-session",
      agentName: "/root/safe-child-id",
    }));
  });
});
