import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import {
  type AgentSession, type AgentSessionEvent, createAgentSession, DefaultResourceLoader,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { installSessionViewTracking, subscribeSessionView } from "../src/ui/native-pi-1.0.0/session-snapshot.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

type AgentMessage = Extract<AgentSessionEvent, { type: "message_start" }>["message"];

function fake() {
  const sessionManager = SessionManager.inMemory("/tmp");
  const publicListener = vi.fn();
  const raw = {
    sessionManager, isStreaming: false, _isAgentRunActive: false,
    _entryIdsByMessage: new WeakMap<object, string>(),
    _emit(event: AgentSessionEvent) { publicListener(event); return 42; },
    _appendCustomMessage(message: AgentMessage) {
      if (message.role !== "custom") throw new Error("not custom");
      sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      this._emit({ type: "message_start", message });
      this._emit({ type: "message_end", message });
      return 17;
    },
    dispose: vi.fn(() => 23),
  };
  const session = raw as unknown as AgentSession;
  const snapshot = () => {
    const view = subscribeSessionView(session, () => {});
    view.unsubscribe();
    return view.snapshot;
  };
  return { raw, session, snapshot, publicListener };
}
const user: AgentMessage = { role: "user", content: "hello", timestamp: 1 };

describe("Pi 1.0.0 session view runtime tracking", () => {
  it("publishes before observers and covers persistence gaps with atomic subscriptions", async () => {
    const { raw, session, snapshot, publicListener } = fake();
    expect(installSessionViewTracking(session)).toBe(true);
    const emit = raw._emit;
    expect(installSessionViewTracking(session)).toBe(true);
    expect(raw._emit).toBe(emit);
    const late = vi.fn();
    subscribeSessionView(session, () => { throw new Error("observer"); });
    subscribeSessionView(session, () => {
      expect(snapshot().pendingMessages).toEqual([user]);
      expect(subscribeSessionView(session, late).snapshot.revision).toBe(1);
    });
    publicListener.mockImplementation(() => expect(snapshot().pendingMessages).toEqual([user]));
    expect(raw._emit({ type: "message_end", message: user })).toBe(42);
    expect(late).not.toHaveBeenCalled();
    const id = raw.sessionManager.appendMessage(user);
    raw._entryIdsByMessage.set(user, id);
    await Promise.resolve();
    expect(snapshot().pendingMessages).toEqual([]);
    expect(snapshot().entries.some((entry) => entry.type === "message")).toBe(true);
  });

  it("keeps duplicate registrations independent and restores only owned descriptors", () => {
    const { raw, session } = fake();
    const original = Object.getOwnPropertyDescriptor(raw, "_emit");
    const dispose = raw.dispose;
    installSessionViewTracking(session);
    const listener = vi.fn();
    const a = subscribeSessionView(session, listener);
    subscribeSessionView(session, listener);
    a.unsubscribe(); a.unsubscribe();
    raw._emit({ type: "agent_start" });
    expect(listener).toHaveBeenCalledTimes(1);
    const replacement = vi.fn();
    raw._appendCustomMessage = replacement;
    expect(raw.dispose()).toBe(23);
    expect(Object.getOwnPropertyDescriptor(raw, "_emit")).toEqual(original);
    expect(raw._appendCustomMessage).toBe(replacement);
    raw.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(installSessionViewTracking(session)).toBe(false);
    expect(() => subscribeSessionView(session, listener)).toThrow("disposed");
  });

  it("shares actual-session state across independent module evaluations", async () => {
    const { raw, session, snapshot } = fake();
    const originalEmit = raw._emit;
    expect(installSessionViewTracking(session)).toBe(true);
    const wrappers = [raw._emit, raw._appendCustomMessage, raw.dispose];
    const firstListener = vi.fn();
    const first = subscribeSessionView(session, firstListener);
    raw._isAgentRunActive = true;
    raw.isStreaming = true;
    raw._emit({ type: "message_start", message: user });
    const message = fauxAssistantMessage([fauxText("streaming")]);
    raw._emit({ type: "message_start", message });
    raw._emit({ type: "tool_execution_start", toolCallId: "shared", toolName: "test", args: {} });

    vi.resetModules();
    const second = await vi.importActual<{
      installSessionViewTracking: typeof installSessionViewTracking;
      subscribeSessionView: typeof subscribeSessionView;
    }>("../src/ui/native-pi-1.0.0/session-snapshot.js");
    expect(second.installSessionViewTracking).not.toBe(installSessionViewTracking);
    expect(second.installSessionViewTracking(session)).toBe(true);
    expect([raw._emit, raw._appendCustomMessage, raw.dispose]).toEqual(wrappers);
    const secondListener = vi.fn();
    const view = second.subscribeSessionView(session, secondListener);
    expect(view.snapshot).toEqual(snapshot());
    expect(view.snapshot).toMatchObject({ revision: 3, pendingMessages: [user], streamingMessage: message });
    expect(view.snapshot.tools).toHaveLength(1);
    const key = Symbol.for("pi-subagents.session-view-tracking.pi-1.0.0");
    expect(Object.getOwnPropertyDescriptor(session, key)?.enumerable).toBe(false);

    raw._emit({ type: "message_end", message: user });
    expect(firstListener).toHaveBeenLastCalledWith({ type: "message_end", message: user }, 4);
    expect(secondListener).toHaveBeenCalledExactlyOnceWith({ type: "message_end", message: user }, 4);
    raw._entryIdsByMessage.set(user, raw.sessionManager.appendMessage(user));
    await Promise.resolve();
    const cleaned = second.subscribeSessionView(session, () => {});
    expect(cleaned.snapshot.pendingMessages).toEqual([]);
    cleaned.unsubscribe();
    first.unsubscribe();
    raw._emit({ type: "agent_settled" });
    expect(firstListener).toHaveBeenCalledTimes(4);
    expect(secondListener).toHaveBeenCalledTimes(2);
    expect(snapshot()).toMatchObject({ revision: 5, tools: [], streamingMessage: undefined });

    raw.dispose();
    expect(raw._emit).toBe(originalEmit);
    expect(installSessionViewTracking(session)).toBe(false);
    expect(second.installSessionViewTracking(session)).toBe(false);
    expect(() => subscribeSessionView(session, () => {})).toThrow("disposed");
    expect(() => second.subscribeSessionView(session, () => {})).toThrow("disposed");
    view.unsubscribe();
    raw._emit({ type: "agent_start" });
    expect(secondListener).toHaveBeenCalledTimes(2);
  });

  it("rejects incompatible shared state without replacing it or wrapping methods", () => {
    for (const value of [{ schema: "unknown" }, { schema: "pi-subagents.session-view-tracking.pi-1.0.0/v1", revision: 0, disposed: false }]) {
      const { raw, session } = fake();
      const key = Symbol.for("pi-subagents.session-view-tracking.pi-1.0.0");
      Object.defineProperty(session, key, { value });
      const emit = raw._emit;
      expect(installSessionViewTracking(session)).toBe(false);
      expect(() => subscribeSessionView(session, () => {})).toThrow("supported Pi 1.0.0");
      expect(raw._emit).toBe(emit);
      expect(Object.getOwnPropertyDescriptor(session, key)?.value).toBe(value);
    }
  });

  it("rejects missing internals and untracked running sessions without modifying them", () => {
    expect(installSessionViewTracking({} as AgentSession)).toBe(false);
    const { raw, session } = fake();
    raw._isAgentRunActive = true;
    const emit = raw._emit;
    expect(() => subscribeSessionView(session, () => {})).toThrow("before running");
    expect(raw._emit).toBe(emit);
  });

  it("recognizes already-persisted custom messages at both emissions", () => {
    const { raw, session, snapshot } = fake();
    installSessionViewTracking(session);
    const seen: number[] = [];
    subscribeSessionView(session, () => {
      seen.push(snapshot().entries.filter((entry) => entry.type === "custom_message").length);
      expect(snapshot().pendingMessages).toEqual([]);
    });
    expect(raw._appendCustomMessage({ role: "custom", customType: "test", content: "x", display: true, timestamp: 1 })).toBe(17);
    expect(seen).toEqual([1, 1]);
    expect(snapshot().pendingMessages).toEqual([]);
  });

  it("copies mutable stream arguments, normalizes lax content, and retains tools until message_end", () => {
    const { raw, session, snapshot } = fake();
    installSessionViewTracking(session);
    const message = fauxAssistantMessage([fauxText("hello")]);
    raw._emit({ type: "message_start", message });
    const old = snapshot();
    message.content.length = 0;
    expect(old.streamingMessage?.content).toHaveLength(1);
    const args = { nested: [1] };
    raw._emit({ type: "tool_execution_start", toolCallId: "a", toolName: "test", args });
    args.nested.push(2);
    expect(snapshot().tools[0].args).toEqual({ nested: [1] });
    raw._emit({ type: "tool_execution_end", toolCallId: "a", toolName: "test", result: { content: null, details: {} }, isError: false } as unknown as AgentSessionEvent);
    expect(snapshot().tools[0]).toMatchObject({ complete: true, result: { content: [] } });
    raw._emit({ type: "message_end", message: { role: "toolResult", toolCallId: "a", toolName: "test", content: [], isError: false, timestamp: 2 } });
    expect(snapshot().tools).toEqual([]);
    expect(snapshot().pendingMessages).toHaveLength(1);
    raw._emit({ type: "message_start", message: { ...message, content: null } } as unknown as AgentSessionEvent);
    expect(snapshot().streamingMessage?.content).toEqual([]);
    raw._emit({ type: "agent_settled" });
    expect(snapshot()).toMatchObject({ streamingMessage: undefined, tools: [], pendingMessages: [] });
  });

  it("preserves native errors and does not change other instances", () => {
    const { raw, session } = fake();
    const error = new Error("native");
    raw._emit = () => { throw error; };
    const other = fake();
    const emit = other.raw._emit;
    installSessionViewTracking(session);
    expect(() => raw._emit({ type: "agent_start" })).toThrow(error);
    expect(other.raw._emit).toBe(emit);
  });

  it("tracks the actual published SDK captured event handler and custom append path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "native-view-"));
    const faux = registerFauxProvider({ provider: "native-view-faux", models: [{ id: "test" }] });
    let session: AgentSession | undefined;
    try {
      faux.setResponses([fauxAssistantMessage([fauxText("answer")])]);
      const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, noExtensions: true, noSkills: true,
        noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      ({ session } = await createAgentSession({ cwd, agentDir: cwd, model: faux.getModel(),
        modelRuntime: fauxModelBackend(faux.getModel()).modelRuntime,
        resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      }));
      expect(installSessionViewTracking(session)).toBe(true);
      const target = session;
      const events: string[] = [];
      const failures: unknown[] = [];
      target.subscribe((event) => {
        const view = subscribeSessionView(target, () => {});
        view.unsubscribe();
        events.push(event.type);
        try {
          if (event.type === "message_end") {
            expect(view.snapshot.pendingMessages.includes(event.message)).toBe(event.message.role !== "custom");
          }
        } catch (error) { failures.push(error); }
      });
      await target.prompt("hello");
      await target.sendCustomMessage({ customType: "test", content: "custom", display: true });
      expect(failures).toEqual([]);
      expect(events).toContain("message_update");
      const view = subscribeSessionView(target, () => {});
      expect(view.snapshot.pendingMessages).toEqual([]);
      expect(view.snapshot.entries.some((entry) => entry.type === "custom_message")).toBe(true);
      expect(view.snapshot.revision).toBe(events.length);
      view.unsubscribe();
    } finally {
      session?.dispose();
      faux.unregister();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
