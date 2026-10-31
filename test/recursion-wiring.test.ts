import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settingsUI = vi.hoisted(() => ({ items: [] as SettingItem[], change: undefined as ((id: string, value: string) => void) | undefined }));
vi.mock("@earendil-works/pi-tui", async original => ({
  ...await original<typeof import("@earendil-works/pi-tui")>(),
  SettingsList: class {
    constructor(items: SettingItem[], _height: number, _theme: unknown, change: (id: string, value: string) => void) {
      settingsUI.items = items;
      settingsUI.change = change;
    }
    render() { return []; }
    invalidate() {}
  },
}));
vi.mock("@earendil-works/pi-coding-agent", async original => ({
  ...await original<typeof import("@earendil-works/pi-coding-agent")>(),
  getSettingsListTheme: () => ({}),
}));

import subagentsExtension from "../src/index.js";
import { JobRuntime } from "../src/jobs/runtime.js";
import { jobChild, jobHost } from "./helpers/job-runtime.js";

describe("recursion command and persistent settings wiring", () => {
  let dir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let host: ReturnType<typeof jobHost>;
  let commands: Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>;
  let context: ExtensionCommandContext;
  let active: string[];
  const globalKey = Symbol.for("pi-subagents:manager");
  let previousManager: unknown;
  const file = () => join(dir, ".pi", "subagents.json");
  const command = (args: string) => commands.get("subagent-recursion")!.handler(args, context);
  const status = async () => {
    await command("status");
    return vi.mocked(host.ctx.ui.notify).mock.calls.at(-1)?.[0];
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "recursion-wiring-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(dir, "global");
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    mkdirSync(join(dir, ".pi"));
    writeFileSync(file(), JSON.stringify({ nestedAgentsEnabled: false, maxSubagentDepth: 3 }));
    process.chdir(dir);
    previousManager = Reflect.get(globalThis, globalKey);
    Reflect.deleteProperty(globalThis, globalKey);
    host = jobHost(dir);
    commands = new Map();
    active = [];
    Object.assign(host.pi, {
      registerCommand: (name: string, definition: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, definition),
      registerFlag: vi.fn(), getFlag: vi.fn(), appendEntry: vi.fn(), registerEntryRenderer: vi.fn(),
      events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      getAllTools: () => [...host.tools.values()], getActiveTools: () => active,
      setActiveTools: (names: string[]) => { active = names; },
    });
    Object.assign(host.ctx, { hasUI: false, modelRegistry: { find: vi.fn(), getAvailable: () => [] }, getSystemPrompt: () => "test" });
    // No persistent parent identity: no scheduler/resume registry writes.
    host.ctx.sessionManager.getSessionId = () => undefined as unknown as string;
    context = host.ctx as unknown as ExtensionCommandContext;
    subagentsExtension(host.pi);
    await host.emit("session_start");
  });

  afterEach(async () => {
    await host?.emit("session_shutdown");
    if (previousManager === undefined) Reflect.deleteProperty(globalThis, globalKey);
    else Reflect.set(globalThis, globalKey, previousManager);
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("completes actions and bounded depth arguments without changing policy", async () => {
    const complete = commands.get("subagent-recursion")!.getArgumentCompletions!;
    const before = await status();
    expect(await complete("")).toEqual(["on", "off", "depth", "status", "reset"].map(value => ({ value, label: value })));
    expect(await complete("o")).toEqual(["on", "off"].map(value => ({ value, label: value })));
    expect(await complete("depth ")).toEqual(Array.from({ length: 17 }, (_, depth) => ({ value: `depth ${depth}`, label: `depth ${depth}` })));
    expect(await complete("depth 1")).toEqual([1, 10, 11, 12, 13, 14, 15, 16].map(depth => ({ value: `depth ${depth}`, label: `depth ${depth}` })));
    expect(await complete("depth 17")).toBeNull();
    expect(await complete("on extra")).toBeNull();
    expect(await status()).toBe(before);
    for (const depth of [0, 16]) {
      await command(`depth ${depth}`);
      expect(await status()).toContain(`depth=${depth}`);
    }
  });

  it("commands do not write files, do not toggle main tools, and invalid input is atomic", async () => {
    const before = readFileSync(file(), "utf8");
    expect(active).not.toContain("Agent");
    await command("on");
    await command("depth 5");
    expect(await status()).toContain("enabled=true, depth=5");
    const valid = await status();
    for (const invalid of ["depth -1", "depth 17", "depth 1.5", "depth", "on extra", "reset extra"]) {
      await command(invalid);
      expect(vi.mocked(host.ctx.ui.notify).mock.calls.at(-1)?.[1]).toBe("warning");
      expect(await status()).toBe(valid);
    }
    expect(readFileSync(file(), "utf8")).toBe(before);
    expect(active).not.toContain("Agent");
    await commands.get("subagent-tools")!.handler("on", context);
    expect(active).toContain("Agent");
    expect(await status()).toBe(valid);
    await command("off");
    expect(active).toContain("Agent");
  });

  it("reset reloads configuration and session boundaries discard both overrides", async () => {
    await command("on"); await command("depth 8");
    writeFileSync(file(), JSON.stringify({ nestedAgentsEnabled: false, maxSubagentDepth: 4 }));
    await command("reset");
    expect(await status()).toContain("enabled=false, depth=4");
    expect(await status()).toContain("Session overrides: enabled=none, depth=none");
    await command("on"); await command("depth 9");
    await host.emit("session_start");
    expect(await status()).toContain("enabled=false, depth=4");
    expect(await status()).toContain("Session overrides: enabled=none, depth=none");
  });

  it("Settings UI persists baseline only, including unrelated saves during overrides", async () => {
    await command("on"); await command("depth 8");
    const select = vi.fn().mockResolvedValueOnce("Settings").mockResolvedValue(undefined);
    Object.assign(context.ui, {
      select,
      custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value?: string) => void) => unknown) => {
        factory({}, {}, {}, () => {});
        expect(settingsUI.items.find(item => item.id === "nestedAgentsEnabled")?.currentValue).toBe("off");
        expect(settingsUI.items.find(item => item.id === "maxSubagentDepth")?.currentValue).toBe("3");
        settingsUI.change!("showCost", "on");
        expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({ nestedAgentsEnabled: false, maxSubagentDepth: 3 });
        settingsUI.change!("nestedAgentsEnabled", "on");
        settingsUI.change!("maxSubagentDepth", "6");
        expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({ nestedAgentsEnabled: true, maxSubagentDepth: 6 });
        return undefined;
      },
    });
    await commands.get("agents")!.handler("", context);
    expect(settingsUI.change).toBeDefined();
    expect(await status()).toContain("enabled=true, depth=8");
    expect(await status()).toContain("Configuration baseline: enabled=true, depth=6");
  });

  it("does not register agent_bg in root or owned-child job surfaces", async () => {
    expect(host.tools.has("agent_bg")).toBe(false);
    const root = jobHost(dir);
    const runtime = new JobRuntime(root.pi);
    try {
      runtime.installRoot();
      expect(root.tools.has("agent_bg")).toBe(false);
      expect([...root.tools.keys()]).toEqual(expect.arrayContaining(["bash", "bash_bg", "jobs", "monitor"]));
      const child = await jobChild(runtime, dir, "child");
      expect(child.tools.has("agent_bg")).toBe(false);
      expect([...child.tools.keys()]).toEqual(expect.arrayContaining(["bash", "bash_bg", "jobs", "monitor"]));
    } finally { await runtime.dispose(); }
  });
});
