import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import * as runner from "../src/agent-runner.js";
import { BackgroundRegistry } from "../src/jobs/patty/state.js";
import type { AgentRecord } from "../src/types.js";
import { FleetList } from "../src/ui/fleet-list.js";

vi.mock("../src/agent-runner.js", async original => ({
  ...await original<typeof runner>(),
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it.each([false, true])("sorts by actual manager resume start, not completion (background=%s)", async isBackground => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const session = { dispose: vi.fn() } as unknown as NonNullable<AgentRecord["session"]>;
  vi.mocked(runner.runAgent).mockResolvedValue({ responseText: "done", session, aborted: false, steered: false });
  let finish!: (result: { text: string }) => void;
  vi.mocked(runner.resumeAgent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const manager = new AgentManager();
  const fleet = new FleetList(manager);
  const registry = new BackgroundRegistry();
  fleet.setJobSource(registry, () => "root");
  let widget: { render(width: number): string[] } | undefined;
  fleet.setUICtx({
    setWidget: (_key, factory) => { widget = factory?.({ requestRender: () => {} }, { fg: (_colour, text) => text, bold: text => text }); },
    onTerminalInput: () => () => {}, getEditorText: () => "", notify: () => {},
  });
  const pi = {} as ExtensionAPI;
  const ctx = { cwd: process.cwd() } as ExtensionContext;
  const order = () => widget?.render(240).filter(line => /first-agent|second-agent/.test(line)).map(line => line.includes("first-agent") ? "first" : "second");
  try {
    const firstId = manager.spawn(pi, ctx, "general-purpose", "first", { description: "first-agent" });
    const first = manager.getRecord(firstId)!;
    await first.promise;
    vi.setSystemTime(2000);
    const secondId = manager.spawn(pi, ctx, "general-purpose", "second", { description: "second-agent" });
    const second = manager.getRecord(secondId)!;
    await second.promise;
    fleet.update();
    expect(order()).toEqual(["second", "first"]);
    vi.setSystemTime(3000);
    const resumed = manager.resume(firstId, "continue", undefined, { isBackground });
    expect(first.startedAt).toBe(3000);
    fleet.update();
    expect(order()).toEqual(["first", "second"]);
    vi.setSystemTime(4000);
    finish({ text: "resumed" });
    await resumed;
    await first.promise;
    fleet.update();
    expect(first.status).toBe("completed");
    expect(first.startedAt).toBe(3000);
    expect(order()).toEqual(["first", "second"]);
  } finally {
    fleet.dispose();
    manager.dispose();
  }
});
