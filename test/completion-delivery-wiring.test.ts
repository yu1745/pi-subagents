import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

let hermetic: Hermetic;
let booted: ReturnType<typeof makePi>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(runAgent).mockReset();
  hermetic = hermeticDir({ settings: { schedulingEnabled: false, outputTranscript: false } });
  booted = makePi();
  subagentsExtension(booted.pi);
});
afterEach(async () => {
  await booted.lifecycle.get("session_shutdown")({}, ctx());
  vi.useRealTimers();
  hermetic.restore();
});

const result = () => ({ responseText: "done", session: { dispose: vi.fn() } as unknown as AgentSession, aborted: false, steered: false });
async function spawn(background = true) {
  return booted.tools.get("Agent").execute("spawn", {
    prompt: "work", description: "target", subagent_type: "general-purpose", run_in_background: background,
  }, undefined, undefined, ctx());
}

describe("completion delivery wiring", () => {
  it("holds solo completion for 200ms after batch finalization, then steers", async () => {
    vi.mocked(runAgent).mockResolvedValue(result());
    await spawn();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(199);
    expect(booted.pi.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(booted.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-notification" }),
      { deliverAs: "steer", triggerTurn: true },
    );
  });

  it("aggregates two smart completions into one steering message", async () => {
    const finishes: (() => void)[] = [];
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => {
      finishes.push(() => resolve(result()));
    }));
    await spawn();
    await spawn();
    await vi.advanceTimersByTimeAsync(100);
    for (const finish of finishes) finish();
    await vi.advanceTimersByTimeAsync(200);
    expect(booted.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(booted.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Background agent group completed"), details: expect.objectContaining({ others: expect.any(Array) }) }),
      { deliverAs: "steer", triggerTurn: true },
    );
  });

  it("suppresses consumed and foreground results", async () => {
    vi.mocked(runAgent).mockResolvedValue(result());
    const started = await spawn();
    await vi.advanceTimersByTimeAsync(100);
    const id = /Agent ID: (\S+)/.exec(textOf(started))![1];
    await booted.tools.get("get_subagent_result").execute("consume", { agent_id: id }, undefined, undefined, ctx());
    await spawn(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(booted.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps Watch idle-only followUp delivery", async () => {
    let busy = true;
    const context = ctx({ isIdle: () => !busy, hasPendingMessages: () => false });
    await booted.lifecycle.get("session_start")({}, context);
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.({
        sessionId: "watch-session", messages: [], dispose: vi.fn(),
      } as unknown as AgentSession);
      return new Promise(() => {});
    });
    const started = await spawn();
    const id = /Agent ID: (\S+)/.exec(textOf(started))![1];
    await booted.tools.get("watch_subagent").execute("watch", { action: "start", agent_id: id, interval_seconds: 30 }, undefined, undefined, context);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(booted.pi.sendMessage).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(booted.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-supervision" }),
      { deliverAs: "followUp", triggerTurn: true },
    );
  });
});
