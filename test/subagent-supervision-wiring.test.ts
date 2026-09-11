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
  it("registers directional supervision policy and distinguishes direct steering", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const guidelines = (name: string) => (tools.get(name) as { promptGuidelines?: string[] }).promptGuidelines?.join("\n") ?? "";
    const activityPolicy = guidelines("get_subagent_activity");
    const detailPolicy = guidelines("get_subagent_activity_detail");
    const watchPolicy = guidelines("watch_subagent");
    const steer = tools.get("steer_subagent") as { description: string; promptGuidelines?: string[] };

    for (const policy of [activityPolicy, detailPolicy, watchPolicy]) {
      expect(policy).toContain("observation opportunity");
      expect(policy).toContain("direction, scope, or acceptance");
      expect(policy).toContain("self-heal");
      expect(policy.toLowerCase()).toContain("silence");
      expect(policy).toContain("desired boundary");
    }
    const steerPolicy = steer.promptGuidelines?.join("\n") ?? "";
    expect(steerPolicy).toContain("Direct user-requested steering is normal");
    expect(steerPolicy).toContain("direction, scope, or acceptance");
    expect(steerPolicy).toContain("self-heal");
    expect(steerPolicy).toContain("silence");
    expect(steerPolicy).toContain("desired boundary");
    expect(steer.description).toContain("direct user-requested steer");
    expect(steer.description).toContain("evidence-based supervision correction");
    expect(steer.description).toContain("micromanaged steps");

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
