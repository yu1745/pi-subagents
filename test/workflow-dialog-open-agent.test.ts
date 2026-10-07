/**
 * workflow-dialog-open-agent.test.ts — the inspector's `c` key, end to end.
 *
 * `workflow-dialog.test.ts` proves the key raises the action and the footer
 * advertises it; this proves the half only the real extension can: that a
 * child's manager record id actually reaches the row (runtime → host →
 * progress entry), that `c` opens THAT record's native readonly conversation,
 * and that the dialog hides itself until the native view closes.
 *
 * Without the id on the row there is nothing to open, so the run's agents were
 * the one part of the fleet with no way to read what they did.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These synthetic sessions test inspector routing, not Pi's private tracker
// internals. Explicitly model successful tracking; production guards stay real.
vi.mock("../src/ui/native-pi-1.0.0/session-snapshot.js", () => ({
  installSessionViewTracking: vi.fn(() => true),
}));

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";
import { flushViews, nativeViewer } from "./helpers/session-view.js";

/** Enough of a pi session for the manager to keep, and the viewer to render. */
const fakeSession = () => ({
  dispose: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  messages: [],
  getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
});

/** One overlay the extension asked `ui.custom` for, held open like a real one. */
interface OpenOverlay {
  options: { overlay?: boolean; onHandle?: (handle: unknown) => void };
  instance: { handleInput?(data: string): void; render?(width: number): string[]; dispose?(): void };
  /** Resolve the overlay's promise, as closing it does. */
  close(): void;
}

/**
 * A ctx whose `ui.custom` keeps overlays OPEN.
 *
 * The other workflow tests close each overlay the moment it is built, which is
 * enough to assert on wiring. Here the dialog has to stay up while a second
 * overlay opens on top of it, because that stacking is the thing under test.
 */
function overlayCtx() {
  const overlays: OpenOverlay[] = [];
  const hidden: boolean[] = [];
  const native = nativeViewer();
  let entryTaken = false;
  const context = ctx({
    ui: {
      notify: vi.fn(),
      viewSession: native.viewSession,
      select: vi.fn(async (title: string, options: string[]) => {
        if (title !== "Agents" || entryTaken) return undefined;
        entryTaken = true;
        return options.find(option => /^Workflows \(\d+\)$/.test(option));
      }),
      custom: vi.fn(async (factory: (...args: unknown[]) => unknown, options?: OpenOverlay["options"]) => {
        // `terminal` included: the conversation viewer sizes itself off it, so
        // a bare `requestRender` stub would throw on the second overlay.
        const tui = { requestRender: () => {}, terminal: { columns: 120, rows: 40 } };
        const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
        return await new Promise(resolve => {
          const instance = factory(tui, theme, undefined, resolve) as OpenOverlay["instance"];
          overlays.push({ options: options ?? {}, instance, close: () => resolve(undefined) });
          options?.onHandle?.({ setHidden: (value: boolean) => hidden.push(value) });
        });
      }),
    },
  });
  return { context, overlays, hidden, native };
}

describe("the inspector opens a workflow agent's conversation", () => {
  let hermetic: Hermetic;

  beforeEach(() => {
    hermetic = hermeticDir({ settings: { workflowsEnabled: true } });
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
      const session = fakeSession();
      opts.onSessionCreated?.(session as any);
      return { responseText: "child done", session: session as any, aborted: false, steered: false };
    });
  });
  afterEach(() => {
    vi.mocked(runAgent).mockReset();
    hermetic.restore();
  });

  /** Boot the extension and start a one-agent run in the background. */
  async function bootWithChild() {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const command = booted.commands.get("agents");
    if (!command) throw new Error("the extension did not register /agents");
    await booted.tools.get("SubagentWorkflow").execute(
      "tc-0",
      {
        script:
          'export const meta = { name: "wf", description: "d" };\n' +
          'return await agent("read the routes", { label: "child" });\n',
      },
      undefined,
      undefined,
      ctx({ cwd: hermetic.dir }),
    );
    return { ...booted, command };
  }

  it("carries the child's record id onto the row and opens its conversation on c", async () => {
    const { command, lifecycle } = await bootWithChild();
    const ui = overlayCtx();

    // Not awaited: the dialog overlay stays open, which is the point.
    void command.handler("", ui.context);
    await vi.waitFor(() => expect(ui.overlays).toHaveLength(1));
    const dialog = ui.overlays[0].instance;

    // The footer is live, so waiting on it is waiting for the id to travel
    // host → runtime → progress entry → row. Until it lands there is nothing
    // to open and the key is correctly not advertised.
    await vi.waitFor(() => expect(dialog.render?.(120).at(-1)).toContain("c convo"));

    dialog.handleInput?.("c");
    await vi.waitFor(() => expect(ui.native.views).toHaveLength(1));
    expect(ui.overlays).toHaveLength(1); // no mutable ConversationViewer
    const child = vi.mocked(runAgent).mock.results[0];
    const result = await child.value;
    expect(ui.native.views[0].session).toBe(result.session);
    expect(ui.native.views[0].options).toEqual({ title: expect.any(String), signal: expect.any(AbortSignal) });
    expect(ui.hidden).toEqual([true]);

    ui.native.views[0].close();
    // And back, so closing the conversation returns to the run it was opened
    // from rather than to an empty screen.
    await vi.waitFor(() => expect(ui.hidden).toEqual([true, false]));

    ui.overlays[0].close();
    await lifecycle.get("session_shutdown")({}, ui.context);
  });

  it.each(["missing", "throw", "reject"])("keeps the inspector hidden until the fallback closes: %s", async failure => {
    const { command, lifecycle } = await bootWithChild();
    const ui = overlayCtx();
    if (failure === "missing") delete ui.context.ui.viewSession;
    else ui.native.viewSession.mockImplementation(() => {
      if (failure === "throw") throw new Error("native open failed");
      return Promise.reject(new Error("native open failed"));
    });
    void command.handler("", ui.context);
    await vi.waitFor(() => expect(ui.overlays).toHaveLength(1));
    const dialog = ui.overlays[0].instance;
    await vi.waitFor(() => expect(dialog.render?.(120).at(-1)).toContain("c convo"));
    dialog.handleInput?.("c");
    await flushViews();
    expect(ui.overlays).toHaveLength(2);
    expect(ui.overlays[1].instance).toBeInstanceOf(ConversationViewer);
    expect(ui.overlays[1].options.overlay).toBe(true);
    expect(ui.hidden).toEqual([true]);
    dialog.handleInput?.("c");
    await flushViews();
    expect(ui.overlays).toHaveLength(2);
    if (failure === "missing") expect(ui.native.viewSession).not.toHaveBeenCalled();
    else expect(ui.native.viewSession).toHaveBeenCalledOnce();
    ui.overlays[1].instance.handleInput?.("\x1b");
    await flushViews();
    expect(ui.hidden).toEqual([true, false]);
    ui.overlays[0].close();
    await lifecycle.get("session_shutdown")({}, ui.context);
  });

  it.each(["native", "fallback"])("a late %s close never unhides an inspector that already closed", async viewer => {
    const { command, lifecycle } = await bootWithChild();
    const ui = overlayCtx();
    void command.handler("", ui.context);
    await vi.waitFor(() => expect(ui.overlays).toHaveLength(1));
    const dialog = ui.overlays[0].instance;
    await vi.waitFor(() => expect(dialog.render?.(120).at(-1)).toContain("c convo"));
    if (viewer === "fallback") delete ui.context.ui.viewSession;
    dialog.handleInput?.("c");
    dialog.handleInput?.("c"); // a second key cannot start another child view
    await flushViews();
    expect(ui.native.views).toHaveLength(viewer === "native" ? 1 : 0);
    expect(ui.overlays).toHaveLength(viewer === "native" ? 1 : 2);
    ui.overlays[0].close();
    await flushViews();
    if (viewer === "native") ui.native.views[0].close();
    else ui.overlays[1].instance.handleInput?.("\x1b");
    await flushViews();
    expect(ui.hidden).toEqual([true]);
    await lifecycle.get("session_shutdown")({}, ui.context);
  });
});
