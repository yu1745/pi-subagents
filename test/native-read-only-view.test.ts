import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import {
  type AgentSession, type AgentSessionEvent, getMarkdownTheme, InteractiveMode, initTheme,
  type MarkdownTransformer, SessionManager, SettingsManager, type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, type KeyId, matchesKey, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createReadOnlySessionView, type ReadOnlySessionViewOptions } from "../src/ui/native-pi-1.0.0/read-only-view.js";
import { installSessionViewTracking } from "../src/ui/native-pi-1.0.0/session-snapshot.js";
import { until } from "./helpers/job-runtime.js";

class FooterData {
  static instances: FooterData[] = [];
  dispose = vi.fn();
  callback?: () => void;
  constructor(readonly cwd: string) { FooterData.instances.push(this); }
  getGitBranch() { return null; }
  getExtensionStatuses() { return new Map<string, string>(); }
  getAvailableProviderCount() { return 1; }
  onBranchChange(callback: () => void) { this.callback = callback; return () => { this.callback = undefined; }; }
}

const theme = { fg: (_token: string, text: string) => text } as Theme;
const assistant = () => fauxAssistantMessage([fauxText("answer")]);
const toolMessage = () => ({ ...assistant(), content: [{ type: "toolCall" as const, name: "read", id: "tool-a", arguments: { path: "/tmp/example.ts" } }], stopReason: "toolUse" as const });

function fixture() {
  const manager = SessionManager.inMemory("/tmp");
  const settings = SettingsManager.inMemory({ showCacheMissNotices: false });
  const entryRenderer = vi.fn(() => new Text("custom entry native", 0, 0));
  const raw = {
    sessionManager: manager, settingsManager: settings, isStreaming: false, _isAgentRunActive: false,
    _entryIdsByMessage: new WeakMap<object, string>(), retryAttempt: 0, autoCompactionEnabled: false,
    state: { model: undefined }, model: undefined, thinkingLevel: "off", getContextUsage: () => undefined,
    extensionRunner: { getMarkdownTransformers: () => [], getEntryRenderer: () => entryRenderer, getMessageRenderer: () => undefined },
    getToolDefinition: () => undefined,
    _emit(_event: AgentSessionEvent) {}, _appendCustomMessage() {}, dispose: vi.fn(),
  };
  const session = raw as unknown as AgentSession;
  const bindings: Record<string, KeyId[]> = {
    "tui.select.up": ["up"], "tui.select.down": ["down"],
    "tui.altScreen.pageUp": ["pageUp"], "tui.altScreen.pageDown": ["pageDown"],
    "tui.altScreen.top": ["home"], "tui.altScreen.bottom": ["end"],
    "app.tools.expand": ["ctrl+o"], "app.thinking.toggle": ["ctrl+t"],
  };
  // The actual SDK prototype, not copied renderer helpers. No controller constructor/init/run.
  const host = Object.defineProperties(Object.create(InteractiveMode.prototype), Object.getOwnPropertyDescriptors({
    session: { parent: true }, chatContainer: new Container(), pendingTools: new Map(),
    ui: { requestRender: vi.fn() }, footerDataProvider: new FooterData("/parent"),
    mermaidMarkdownTransformer: ((text: string) => text) as MarkdownTransformer,
    hiddenThinkingLabel: "Thinking...", toolOutputExpanded: true,
    keybindings: { matches: (data: string, action: string) => (bindings[action] ?? []).some((key) => matchesKey(data, key)) },
    editor: { addToHistory: vi.fn() },
  }));
  const dispose = raw.dispose;
  installSessionViewTracking(session);
  const back = vi.fn();
  const open = (options: ReadOnlySessionViewOptions = {}) => createReadOnlySessionView(host, session, theme, back, { title: "child", ...options });
  return { raw, session, manager, host, back, open, bindings, entryRenderer, dispose };
}

beforeAll(() => { initTheme("dark"); getMarkdownTheme(); });

describe("native Pi 1.0.0 read-only session view", () => {
  it("replays using native built-in/custom renderers without touching the parent", () => {
    const f = fixture();
    f.manager.appendMessage({ role: "user", content: "question", timestamp: 1 });
    f.manager.appendMessage(toolMessage());
    f.manager.appendMessage({ role: "toolResult", toolCallId: "tool-a", toolName: "read", content: [{ type: "text", text: "const native = true;" }], isError: false, timestamp: 2 });
    f.manager.appendCustomEntry("example", {});
    const before = Object.getOwnPropertyDescriptors(f.host);
    const view = f.open();
    try {
      const output = view.transcript.container.render(100).join("\n");
      expect(output).toContain("question");
      expect(output).toContain("example.ts");
      expect(output).toContain("native");
      expect(output).toContain("custom entry native");
      expect(f.entryRenderer).toHaveBeenCalled();
      expect(view.transcript.receiver.getRegisteredToolDefinition("read")?.renderCall).toBeTypeOf("function");
      expect(view.transcript.receiver).not.toBe(f.host);
      expect(Object.getPrototypeOf(view.transcript.receiver)).toBe(InteractiveMode.prototype);
      expect(Object.getOwnPropertyDescriptors(f.host)).toEqual(before);
      expect(f.host.chatContainer.children).toHaveLength(0);
      expect(f.host.pendingTools.size).toBe(0);
      expect(f.host.editor.addToHistory).not.toHaveBeenCalled();
    } finally { view.dispose(); f.raw.dispose(); }
  });

  it("retains message-end and tool-end persistence gaps exactly once", () => {
    const f = fixture();
    const message = toolMessage();
    f.raw._emit({ type: "message_start", message });
    f.raw._emit({ type: "message_end", message });
    f.raw._emit({ type: "tool_execution_start", toolName: "read", toolCallId: "tool-a", args: { path: "/tmp/example.ts" } });
    f.raw._emit({ type: "tool_execution_end", toolName: "read", toolCallId: "tool-a", result: { content: [{ type: "text", text: "final gap result" }], details: {} }, isError: false });
    const view = f.open();
    try {
      view.transcript.toggleTools();
      const text = view.transcript.container.render(100).join("\n").replace(/\u001b\[[\d;]*m/g, "");
      expect(text.match(/final gap result/g)).toHaveLength(1);
      const count = view.transcript.container.children.length;
      const result = { role: "toolResult" as const, toolCallId: "tool-a", toolName: "read", content: [{ type: "text" as const, text: "final gap result" }], isError: false, timestamp: 3 };
      f.raw._emit({ type: "message_end", message: result });
      expect(view.transcript.container.children).toHaveLength(count);
      expect(view.transcript.receiver.pendingTools.size).toBe(0);
    } finally { view.dispose(); f.raw.dispose(); }
  });

  it("does not duplicate aborted tool rows from the final-message snapshot gap", () => {
    const f = fixture();
    const message = { ...toolMessage(), stopReason: "aborted" as const };
    f.raw._emit({ type: "message_end", message });
    const view = f.open();
    try {
      const output = view.transcript.container.render(100).join("\n");
      expect(output.match(/example\.ts/g)).toHaveLength(1);
      expect(output).toContain("Operation aborted");
      expect(view.transcript.receiver.pendingTools.size).toBe(0);
    } finally { view.dispose(); f.raw.dispose(); }
  });

  it("updates a replayed stream and partial tool output in place", () => {
    const f = fixture();
    const message = toolMessage();
    f.raw._emit({ type: "message_start", message });
    f.raw._emit({ type: "tool_execution_start", toolName: "read", toolCallId: "tool-a", args: { path: "/tmp/example.ts" } });
    f.raw._emit({ type: "tool_execution_update", toolName: "read", toolCallId: "tool-a", args: {}, partialResult: { content: [{ type: "text", text: "partial output" }], details: {} } });
    const view = f.open();
    try {
      view.transcript.toggleTools();
      expect(view.transcript.container.render(100).join("\n").replace(/\u001b\[[\d;]*m/g, "")).toContain("partial output");
      const count = view.transcript.container.children.length;
      f.raw._emit({ type: "message_end", message });
      f.raw._emit({ type: "tool_execution_end", toolName: "read", toolCallId: "tool-a", result: { content: [{ type: "text", text: "completed output" }], details: {} }, isError: false });
      expect(view.transcript.container.children).toHaveLength(count);
      expect(view.transcript.container.render(100).join("\n").replace(/\u001b\[[\d;]*m/g, "")).toContain("completed output");
      expect(view.transcript.receiver.streamingComponent).toBeUndefined();
    } finally { view.dispose(); f.raw.dispose(); }
  });

  it("whitelists configurable navigation and local toggles; blocks execution, paste and renderer clicks", () => {
    const f = fixture();
    const view = f.open();
    try {
      const scroll = vi.spyOn(view.scrollView, "scrollBy");
      const rendererInput = vi.fn();
      view.transcript.container.addChild({ render: () => ["click me"], invalidate() {}, handleInput: rendererInput, handleMouse: rendererInput });
      for (const input of ["hello", "\r", "\u001b\r", "\u0016", "\u001b[200~q\u001b[201~"]) view.handleInput(input);
      expect(f.back).not.toHaveBeenCalled();
      expect(scroll).not.toHaveBeenCalled();
      view.handleInput("\u001b[A");
      expect(scroll).toHaveBeenLastCalledWith(-1);
      f.bindings["tui.select.up"] = ["k"];
      view.handleInput("k");
      expect(scroll).toHaveBeenCalledTimes(2);
      view.handleInput("\u000f");
      expect(view.transcript.receiver.toolOutputExpanded).toBe(true);
      const thinking = view.transcript.receiver.hideThinkingBlock;
      view.handleInput("\u0014");
      expect(view.transcript.receiver.hideThinkingBlock).toBe(!thinking);
      view.handleMouse({ type: "down", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 24 } as TuiMouseEvent);
      view.handleMouse({ type: "wheel", wheelDelta: 1, x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 24 } as TuiMouseEvent);
      expect(scroll).toHaveBeenCalledTimes(3);
      expect(rendererInput).not.toHaveBeenCalled();
      for (const key of ["q", "\u001b", "\u0003"]) view.handleInput(key);
      expect(f.back).toHaveBeenCalledTimes(3);
      expect(f.dispose).not.toHaveBeenCalled();
    } finally { view.dispose(); f.raw.dispose(); }
  });

  it("preserves chronological compaction and native billing notices without duplicate entry replay", () => {
    const f = fixture();
    vi.spyOn(f.session.settingsManager, "getShowCacheMissNotices").mockReturnValue(true);
    const first = f.manager.appendMessage({ role: "user", content: "before boundary", timestamp: 1 });
    const view = f.open();
    try {
      const usage = { ...assistant().usage, input: 123, cost: { input: 0.2, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.2 } };
      const id = f.manager.appendCompaction("native summary", first, 12345, undefined, undefined, usage);
      f.manager.appendMessage({ role: "user", content: "after boundary", timestamp: 2 });
      const entry = f.manager.getEntries().find((item) => item.id === id)!;
      f.raw._emit({ type: "entry_appended", entry });
      view.transcript.toggleTools();
      const output = view.transcript.container.render(100).join("\n").replace(/\u001b\[[\d;]*m/g, "");
      expect(output).toContain("native summary");
      expect(output).toContain("tokens billed");
      expect(output.indexOf("before boundary")).toBeLessThan(output.indexOf("native summary"));
      expect(output.indexOf("native summary")).toBeLessThan(output.indexOf("after boundary"));
      const count = view.transcript.container.children.length;
      f.raw._emit({ type: "entry_appended", entry });
      expect(view.transcript.container.children).toHaveLength(count);
      const warming = f.manager.appendUsage("cache_warm", "test", "test", usage);
      f.raw._emit({ type: "entry_appended", entry: warming });
      expect(view.transcript.container.children.length).toBeGreaterThan(count);
    } finally { view.dispose(); f.raw.dispose(); }
  });

  it("unsubscribes and disposes only its own footer, including failed construction", () => {
    const f = fixture();
    const view = f.open();
    const own = FooterData.instances.at(-1)!;
    expect(own.cwd).toBe("/tmp");
    expect(own.callback).toBeTypeOf("function");
    const count = view.transcript.container.children.length;
    view.dispose(); view.dispose();
    expect(own.dispose).toHaveBeenCalledTimes(1);
    expect(own.callback).toBeUndefined();
    expect(f.host.footerDataProvider.dispose).not.toHaveBeenCalled();
    f.raw._emit({ type: "message_start", message: assistant() });
    view.handleInput("q");
    expect(view.transcript.container.children).toHaveLength(count);
    expect(f.back).not.toHaveBeenCalled();
    f.raw.dispose();
    expect(() => f.open()).toThrow("disposed");
    expect(FooterData.instances.at(-1)?.dispose).toHaveBeenCalledTimes(1);
    expect(() => createReadOnlySessionView({}, f.session, theme, f.back)).toThrow("Unsupported Pi host");
  });

  it("force-steer input belongs to the child view and receives the real parent host session", async () => {
    const f = fixture();
    const send = vi.fn(async (_message: string, _parent: AgentSession) => "Child steer sent; direct parent steer queued.");
    const view = f.open({ canSteer: () => true, onUserSteer: send });
    try {
      expect(view.render(120).join("\n")).toContain("Ctrl+Alt+S force steer");
      view.handleInput("\u001b[115;7u");
      view.handleInput("  child original  ");
      view.handleInput("\r");
      await until(() => send.mock.calls.length === 1);
      expect(send).toHaveBeenCalledExactlyOnceWith("  child original  ", f.host.session);
      expect(f.host.editor.addToHistory).not.toHaveBeenCalled();
      expect(f.back).not.toHaveBeenCalled();
      expect(f.dispose).not.toHaveBeenCalled();
    } finally { view.dispose(); f.raw.dispose(); }
  });

  it("cancelled native input and an agent ending while typing send no steering messages", async () => {
    const f = fixture();
    let active = true;
    const send = vi.fn(async () => "sent");
    const view = f.open({ canSteer: () => active, onUserSteer: send });
    try {
      view.handleInput("\u001b[115;7u"); view.handleInput("cancel this"); view.handleInput("\u001b");
      expect(f.back).not.toHaveBeenCalled();
      view.handleInput("\u001b[115;7u"); view.handleInput("too late"); active = false; view.handleInput("\r");
      await Promise.resolve();
      expect(send).not.toHaveBeenCalled();
      expect(view.render(120).join("\n")).toContain("finished while composing");
      expect(f.host.editor.addToHistory).not.toHaveBeenCalled();
    } finally { view.dispose(); f.raw.dispose(); }
  });
});
