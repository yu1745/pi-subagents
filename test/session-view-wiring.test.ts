import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const patch = vi.hoisted(() => ({
  dispose: vi.fn(),
  install: vi.fn(),
  track: vi.fn(),
}));
vi.mock("../src/ui/native-pi-1.0.0/index.js", () => ({
  SUPPORTED_PI_VERSION: "1.0.0",
  installNativeSessionViewPatch: patch.install,
  getNativeSessionViewUnavailableReason: () => "Readonly viewing requires the Pi 1.0.0 runtime patch; reload or restart Pi.",
}));
vi.mock("../src/ui/native-pi-1.0.0/session-snapshot.js", () => ({ installSessionViewTracking: patch.track }));

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import { ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";
import { flushViews, nativeViewer } from "./helpers/session-view.js";

const MANAGER = Symbol.for("pi-subagents:manager");
const globalRegistry = globalThis as { [key: symbol]: unknown };

describe("readonly native viewing through the real extension", () => {
  let hermetic: Hermetic;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, outputTranscript: false, defaultJoinMode: "async" } });
    vi.useFakeTimers();
    vi.mocked(runAgent).mockReset();
    patch.dispose.mockReset();
    patch.install.mockReset().mockReturnValue({ supported: true, dispose: patch.dispose });
    patch.track.mockReset().mockReturnValue(true);
    delete globalRegistry[MANAGER];
  });
  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    vi.useRealTimers();
    hermetic.restore();
  });

  async function boot(supported = true) {
    const native = nativeViewer();
    const session = {
      sessionId: "native-child",
      messages: [{ role: "assistant", timestamp: 1, content: [{ type: "text", text: "public progress" }] }],
      dispose: vi.fn(), steer: vi.fn(), prompt: vi.fn(), subscribe: vi.fn(() => vi.fn()),
    };
    let finish!: () => void;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await Promise.resolve(); // index's spawn id must be assigned first
      options.onSessionCreated?.(session as unknown as AgentSession);
      await new Promise<void>(resolve => { finish = resolve; });
      return { responseText: "done", session: session as unknown as AgentSession, aborted: false, steered: false };
    });
    let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
    const overlays: ConversationViewer[] = [];
    let pickedMenu = false;
    let pickedAgent = false;
    const ui = {
      ...ctx().ui,
      onTerminalInput: vi.fn((handler: typeof input) => { input = handler; return () => { input = undefined; }; }),
      getEditorText: () => "",
      custom: vi.fn((factory: (...args: unknown[]) => unknown) => new Promise(resolve => {
        const tui = { requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } };
        const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
        let viewer: ConversationViewer;
        const done = () => { viewer.dispose(); resolve(undefined); };
        viewer = factory(tui, theme, undefined, done) as ConversationViewer;
        overlays.push(viewer);
      })),
      ...(supported ? { viewSession: native.viewSession } : {}),
      select: vi.fn(async (title: string, options: string[]) => {
        if (title === "Agents" && !pickedMenu) {
          pickedMenu = true;
          return options.find(option => option.startsWith("Running agents"));
        }
        if (title === "Running agents" && !pickedAgent) {
          pickedAgent = true;
          return options[0];
        }
        return undefined;
      }),
    };
    const context = ctx({ hasUI: true, ui, isIdle: () => true, hasPendingMessages: () => false });
    const booted = makePi();
    subagentsExtension(booted.pi);
    expect(patch.install).toHaveBeenCalledOnce(); // before session_start/UI binding
    shutdown = () => booted.lifecycle.get("session_shutdown")({}, context);
    await booted.lifecycle.get("session_start")({}, context);
    expect(patch.install).toHaveBeenCalledOnce();
    const spawned = await booted.tools.get("Agent").execute("spawn", {
      subagent_type: "general-purpose", description: "native target", prompt: "work", run_in_background: true,
    }, undefined, undefined, context);
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))![1];
    const record = (globalRegistry[MANAGER] as { getRecord(id: string): AgentRecord }).getRecord(id);
    await flushViews();
    const openMenu = () => booted.commands.get("agents").handler("", context) as Promise<void>;
    const openFleet = async () => {
      input?.("\x1b[B"); input?.("\x1b[B"); input?.("\r");
      await flushViews();
    };
    return { ...booted, native, overlays, ui, context, record, session, finish, openMenu, openFleet, press: (data: string) => input?.(data) };
  }

  it("/agents uses the live readonly session and returns to its list on normal close", async () => {
    const h = await boot();
    const menu = h.openMenu();
    await flushViews();
    expect(h.native.views).toHaveLength(1);
    expect(h.native.views[0].session).toBe(h.session);
    expect(h.native.views[0].options).toEqual({ title: expect.stringContaining(h.record.id), signal: expect.any(AbortSignal) });
    // Menu opens are guarded too; unknown parent-editor focus cannot steal keys.
    for (const key of ["\x1b[B", "\r", "\x1b", "x"]) expect(h.press(key)).toBeUndefined();
    h.native.views[0].close();
    await menu;
    expect(h.ui.select.mock.calls.filter(([title]) => title === "Running agents")).toHaveLength(2);
    expect(h.ui.custom).not.toHaveBeenCalled();
    expect(h.session.steer).not.toHaveBeenCalled();
    expect(h.session.prompt).not.toHaveBeenCalled();
    expect(h.record.status).toBe("running");
    expect(h.record.resultConsumed).toBeUndefined();
    expect(h.record.abortController?.signal.aborted).toBe(false);
  });

  it("fleet viewing survives completion and consumed-result GC until native close", async () => {
    const h = await boot();
    await h.openFleet();
    h.finish();
    await h.record.promise;
    h.record.resultConsumed = true;
    await vi.advanceTimersByTimeAsync(12 * 60_000);
    expect(h.native.views[0].detached).toBe(false);
    expect(h.native.views[0].options.signal?.aborted).toBe(false);
    expect(h.record.session).toBe(h.session);
    expect(h.session.dispose).not.toHaveBeenCalled();
    h.native.views[0].close();
    await flushViews();
    expect(h.record.session).toBeUndefined();
    expect(h.session.dispose).toHaveBeenCalledOnce();
    expect(h.ui.custom).not.toHaveBeenCalled();
  });

  it.each(["menu", "fleet"])("unavailable runtime patch opens a retained fallback from %s", async entry => {
    const h = await boot(false);
    const menu = entry === "menu" ? h.openMenu() : undefined;
    if (entry === "fleet") await h.openFleet();
    await flushViews();
    expect(h.ui.custom).toHaveBeenCalledOnce();
    expect(h.overlays[0]).toBeInstanceOf(ConversationViewer);
    expect(h.overlays[0].render(120).join("\n")).toContain("public progress");
    expect(h.native.viewSession).not.toHaveBeenCalled();
    expect(h.record.resultConsumed).toBeUndefined();
    for (const key of ["\x1b[B", "\r", "x"]) expect(h.press(key)).toBeUndefined();
    h.finish();
    await h.record.promise;
    h.record.resultConsumed = true;
    await vi.advanceTimersByTimeAsync(12 * 60_000);
    expect(h.record.session).toBe(h.session);
    expect(h.session.dispose).not.toHaveBeenCalled();
    h.overlays[0].handleInput("\x1b");
    await menu;
    await flushViews();
    expect(h.record.session).toBeUndefined();
    expect(h.session.dispose).toHaveBeenCalledOnce();
    expect(h.session.steer).not.toHaveBeenCalled();
    expect(h.session.prompt).not.toHaveBeenCalled();
  });

  it.each(["session_before_switch", "session_shutdown"])("%s closes the fallback without reopening old menus", async event => {
    const h = await boot(false);
    const menu = h.openMenu();
    await flushViews();
    expect(h.overlays).toHaveLength(1);
    const selects = h.ui.select.mock.calls.length;
    await h.lifecycle.get(event)({}, h.context);
    await menu;
    expect(h.ui.select).toHaveBeenCalledTimes(selects);
    expect(h.ui.custom).toHaveBeenCalledOnce();
    expect(h.session.subscribe.mock.results[0].value).toHaveBeenCalledOnce();
    if (event === "session_before_switch") {
      expect(h.record.abortController?.signal.aborted).toBe(false);
      expect(h.session.dispose).not.toHaveBeenCalled();
    } else {
      expect(h.session.dispose).toHaveBeenCalledOnce();
    }
  });

  it.each(["session_before_switch", "session_shutdown"])("%s closes the native view without reopening old menus", async event => {
    const h = await boot();
    const menu = h.openMenu();
    await flushViews();
    const selects = h.ui.select.mock.calls.length;
    await h.lifecycle.get(event)({}, h.context);
    await menu;
    expect(h.native.views[0].options.signal?.aborted).toBe(true);
    expect(h.native.views[0].detached).toBe(true);
    expect(h.ui.select).toHaveBeenCalledTimes(selects);
    if (event === "session_before_switch") {
      expect(h.record.status).toBe("running");
      expect(h.record.abortController?.signal.aborted).toBe(false);
      expect(h.session.dispose).not.toHaveBeenCalled();
    } else {
      expect(h.session.dispose).toHaveBeenCalledOnce();
      expect(patch.dispose).toHaveBeenCalledOnce();
      expect(h.session.dispose.mock.invocationCallOrder[0]).toBeLessThan(patch.dispose.mock.invocationCallOrder[0]);
    }
  });

  it.each(["quit", "reload", "new", "resume", "fork"])("releases the patch after manager disposal on %s", async reason => {
    const h = await boot();
    await h.openFleet();
    await h.lifecycle.get("session_shutdown")({ reason }, h.context);
    expect(h.native.views[0].detached).toBe(true);
    expect(h.session.dispose).toHaveBeenCalledOnce();
    expect(patch.dispose).toHaveBeenCalledOnce();
    expect(h.session.dispose.mock.invocationCallOrder[0]).toBeLessThan(patch.dispose.mock.invocationCallOrder[0]);
  });

  it("releases the patch when manager shutdown rejects and preserves the error", async () => {
    const h = await boot();
    const error = new Error("manager shutdown failed");
    const dispose = vi.spyOn(AgentManager.prototype, "dispose").mockRejectedValueOnce(error);
    try {
      await expect(h.lifecycle.get("session_shutdown")({ reason: "quit" }, h.context)).rejects.toBe(error);
      expect(patch.dispose).toHaveBeenCalledOnce();
      expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(patch.dispose.mock.invocationCallOrder[0]);
      // Retry real cleanup: the patch handle was cleared even on rejection.
      await h.lifecycle.get("session_shutdown")({ reason: "quit" }, h.context);
      expect(h.session.dispose).toHaveBeenCalledOnce();
      expect(patch.dispose).toHaveBeenCalledOnce();
    } finally {
      dispose.mockRestore();
    }
  });

  it.each(["false", "throw"])("uses the fallback without interrupting execution when tracking returns %s", async failure => {
    patch.track.mockImplementation(() => {
      if (failure === "throw") throw new Error("unsupported session shape");
      return false;
    });
    const h = await boot();
    expect(patch.track).toHaveBeenCalledWith(h.session);
    expect(h.record.status).toBe("running");
    const menu = h.openMenu();
    await flushViews();
    expect(h.overlays[0]).toBeInstanceOf(ConversationViewer);
    expect(h.ui.custom).toHaveBeenCalledOnce();
    expect(h.native.viewSession).not.toHaveBeenCalled();
    expect(h.record.abortController?.signal.aborted).toBe(false);
    h.overlays[0].handleInput("\x1b");
    await menu;
    expect(h.ui.select.mock.calls.filter(([title]) => title === "Running agents")).toHaveLength(2);
  });

  it("does not disable child execution when patch installation is unsupported", async () => {
    patch.install.mockReturnValue({ supported: false, reason: "Pi version mismatch", dispose: patch.dispose });
    const h = await boot(false);
    expect(h.record.status).toBe("running");
    h.finish();
    await h.record.promise;
    expect(h.record.status).toBe("completed");
  });

  it("Watch continues delivering while viewing, without consuming or steering the child", async () => {
    const h = await boot();
    const watchTool = h.tools.get("watch_subagent");
    await watchTool.execute("watch", { action: "start", agent_id: h.record.id, interval_seconds: 30 }, undefined, undefined, h.context);
    await h.openFleet();
    const consumption = h.record.resultConsumed;
    await vi.advanceTimersByTimeAsync(30_000);
    const messages = h.pi.sendMessage.mock.calls.filter(([message]: [{ customType: string }]) => message.customType === "subagent-supervision");
    expect(messages).toHaveLength(1);
    expect(messages[0][0].content).toContain("public progress");
    expect(messages[0][1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(h.native.views[0].detached).toBe(false);
    expect(h.record.resultConsumed).toBe(consumption);
    expect(h.session.steer).not.toHaveBeenCalled();
    h.native.views[0].close();
    await flushViews();
    const status = await watchTool.execute("status", { action: "status", agent_id: h.record.id }, undefined, undefined, h.context);
    expect(textOf(status)).toContain(": active");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.pi.sendMessage.mock.calls.filter(([message]: [{ customType: string }]) => message.customType === "subagent-supervision")).toHaveLength(2);
  });
});
