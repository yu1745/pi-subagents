import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { ctx, flush, makePi, textOf } from "./helpers/boot-extension.js";

interface ManagerRegistry {
  getRecord: (id: string) => AgentRecord | undefined;
}

function managerRegistry(): ManagerRegistry {
  const registry = (globalThis as { [key: symbol]: unknown })[Symbol.for("pi-subagents:manager")];
  return registry as ManagerRegistry;
}

function heldRun() {
  let createSession: ((session: object) => void) | undefined;
  vi.mocked(runAgent).mockImplementation(
    (_ctx, _type, _prompt, options) => new Promise(() => {
      createSession = session => options.onSessionCreated?.(session as never);
    }) as never,
  );
  return {
    create() {
      createSession?.({
        sessionId: "supervision-session",
        messages: [{ role: "assistant", timestamp: 1, content: [{ type: "text", text: "public progress" }] }],
        dispose: vi.fn(),
        subscribe: vi.fn(() => () => {}),
        steer: vi.fn(),
        getActiveToolNames: vi.fn(() => []),
      });
    },
  };
}

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  delete (globalThis as { [key: symbol]: unknown })[Symbol.for("pi-subagents:manager")];
});

describe("parent supervision tool wiring", () => {
  it("keeps supervision policy on Agent and operation details on the other tools", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const guidelines = (name: string) => (tools.get(name) as { promptGuidelines?: string[] }).promptGuidelines?.join("\n") ?? "";
    expect(guidelines("Agent")).toContain("continue useful independent work");
    expect(guidelines("Agent")).toContain("direction, scope, or acceptance");
    const operationGuidelines = ["get_subagent_activity", "get_subagent_activity_detail", "watch_subagent", "steer_subagent"].map(guidelines).join("\n");
    expect(operationGuidelines).not.toMatch(/recoverable|only for explicit|direction, scope, or acceptance/);
    expect(guidelines("watch_subagent")).toContain("a blocking get_subagent_result(wait: true) defers them");
    expect(guidelines("get_subagent_activity_detail")).toContain("activity ID returned by get_subagent_activity");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("uses top-level ownership checks and activity reads never consume the result", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const run = heldRun();

    const spawned = await tools.get("Agent").execute(
      "spawn",
      { prompt: "work", description: "supervision target", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))![1];
    run.create();
    await flush();

    const record = managerRegistry().getRecord(id)!;
    record.parentAgentId = "owner";
    const deniedActivity = await tools.get("get_subagent_activity").execute("activity", { agent_id: id }, undefined, undefined, ctx());
    const deniedWatch = await tools.get("watch_subagent").execute("watch", { action: "start", agent_id: id }, undefined, undefined, ctx());
    expect(textOf(deniedActivity)).toContain("Agent not found");
    expect(textOf(deniedWatch)).toContain("Agent not found");

    record.parentAgentId = undefined;
    const activity = await tools.get("get_subagent_activity").execute("activity", { agent_id: id }, undefined, undefined, ctx());
    const activityText = textOf(activity);
    expect(activityText).toContain("public progress");
    const activityId = /activity id: ([^\]]+)/.exec(activityText)![1];
    const detail = await tools.get("get_subagent_activity_detail").execute(
      "detail",
      { agent_id: id, activity_id: activityId, limit: 100 },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(detail)).toContain("public progress");
    expect(textOf(detail)).toContain("has_more: false");
    expect(record.resultConsumed).toBeUndefined();

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("rejects periodic watches in print and JSON modes", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);

    for (const mode of ["print", "json"] as const) {
      const result = await booted.tools.get("watch_subagent").execute(
        "watch",
        { action: "start", agent_id: "missing" },
        undefined,
        undefined,
        ctx({ mode }),
      );
      expect(textOf(result)).toContain("unavailable in print or JSON mode");
    }

    await booted.lifecycle.get("session_shutdown")?.({}, ctx());
  });
});
