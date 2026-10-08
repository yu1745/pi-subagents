import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { JobRuntime } from "../src/jobs/runtime.js";
import type { AgentRecord } from "../src/types.js";
import { openAgentSessionView, type SessionViewUI } from "../src/ui/session-view.js";
import { jobHost, until } from "./helpers/job-runtime.js";
import { flushViews } from "./helpers/session-view.js";

describe("not-ready queued agent UI steering", () => {
  let manager: AgentManager;
  let runtime: JobRuntime;
  let view: ReturnType<typeof openAgentSessionView>;
  function fixture() {
    manager = new AgentManager();
    runtime = new JobRuntime(jobHost("/tmp").pi);
    manager.setJobRuntime(runtime);
    const record: AgentRecord = { id: "queued-child", type: "general-purpose", description: "Queued task", status: "queued",
      startedAt: 0, abortController: new AbortController(), toolUses: 0, compactionCount: 0,
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    };
    (manager as unknown as { agents: Map<string, AgentRecord> }).agents.set(record.id, record);
    const main = { sessionId: "main-id", steer: vi.fn(async (_message: string) => "queued" as const) };
    let component: Component | undefined;
    type Factory = Parameters<NonNullable<SessionViewUI["custom"]>>[0];
    const raw = {
      notify: vi.fn(), getSubagentsMainSession: () => main as unknown as AgentSession,
      custom: (factory: Factory) => new Promise<undefined>(resolve => {
        const tui = { requestRender: vi.fn(), terminal: { columns: 120, rows: 30 } } as Parameters<Factory>[0];
        const theme = { fg: (_token: string, text: string) => text } as Parameters<Factory>[1];
        void Promise.resolve(factory(tui, theme, {} as Parameters<Factory>[2], () => resolve(undefined))).then(value => { component = value; });
      }),
    };
    const ui = raw as unknown as SessionViewUI;
    view = openAgentSessionView(manager, ui, record, { initialForceSteer: true });
    return { record, main, raw, component: () => component! };
  }
  afterEach(async () => {
    view?.close();
    await view?.closed;
    await manager?.dispose();
    await runtime?.dispose();
  });

  it("composes without a nonexistent session lease and queues original text to child plus parent", async () => {
    const f = fixture();
    expect(view).toBeDefined();
    await flushViews();
    expect(f.component().render(120).join("\n")).toContain("waiting for SDK session");
    f.component().handleInput?.("  pending user text  ");
    f.component().handleInput?.("\r");
    await view!.closed;
    expect(f.record.pendingSteers).toEqual(["  pending user text  "]);
    expect(f.main.steer).toHaveBeenCalledTimes(1);
    expect(f.main.steer.mock.calls[0][0]).toContain(f.record.id);
    expect(f.raw.notify).toHaveBeenCalledWith(expect.stringContaining("Child steer queued until ready"), "info");
    expect(f.record.abortController?.signal.aborted).toBe(false);
  });

  it("cancel/back sends nothing and never stops the queued agent", async () => {
    const f = fixture();
    await until(() => !!f.component());
    f.component().handleInput?.("cancelled user text");
    f.component().handleInput?.("\u001b");
    f.component().handleInput?.("\u001b");
    await view!.closed;
    expect(f.record.pendingSteers).toBeUndefined();
    expect(f.main.steer).not.toHaveBeenCalled();
    expect(f.record.abortController?.signal.aborted).toBe(false);
    expect(view!.signal.aborted).toBe(true);
  });
});
