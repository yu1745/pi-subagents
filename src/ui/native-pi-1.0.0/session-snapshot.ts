import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import type { AgentSession, AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

type AgentMessage = Extract<AgentSessionEvent, { type: "message_start" }>["message"];
type ToolResult = { content: (TextContent | ImageContent)[]; details: unknown };

export interface SessionViewTool {
  toolCallId: string;
  toolName: string;
  args: unknown;
  started: boolean;
  partialResult?: ToolResult;
  result?: ToolResult;
  isError?: boolean;
  complete?: boolean;
}

/** Read-only by contract; opaque extension details are deliberately not cloned. */
export interface SessionViewSnapshot {
  entries: SessionEntry[];
  streamingMessage?: AssistantMessage;
  pendingMessages: readonly AgentMessage[];
  tools: readonly SessionViewTool[];
  revision: number;
}
export type SessionViewEventListener = (event: AgentSessionEvent, revision: number) => void;

type Internals = {
  _emit: (event: AgentSessionEvent) => unknown;
  _appendCustomMessage: (message: AgentMessage) => unknown;
  dispose: () => unknown;
  _entryIdsByMessage: WeakMap<object, string>;
  _isAgentRunActive: boolean;
};
type Registration = { listener: SessionViewEventListener };
// Jiti can evaluate this module separately for each extension. The actual session
// owns the state; neither module identity nor a prototype-global patch is involved.
const stateKey = Symbol.for("pi-subagents.session-view-tracking.pi-1.0.0");
const stateSchema = "pi-subagents.session-view-tracking.pi-1.0.0/v1";

function getState(session: AgentSession): ViewState | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(session, stateKey);
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable) return undefined;
  const value: unknown = descriptor.value;
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<ViewState>;
  if (state.schema !== stateSchema || typeof state.disposed !== "boolean" ||
    typeof state.revision !== "number" || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
    typeof state.clear !== "function" || typeof state.prune !== "function" || typeof state.publish !== "function") {
    return undefined;
  }
  for (const collection of [state.pending, state.custom, state.listeners, state.tools]) {
    if (!collection || typeof collection.has !== "function" || typeof collection.delete !== "function" ||
      typeof collection.clear !== "function" || typeof collection[Symbol.iterator] !== "function") return undefined;
  }
  if (typeof state.pending?.add !== "function" || typeof state.custom?.add !== "function" ||
    typeof state.listeners?.add !== "function" || typeof state.tools?.get !== "function" ||
    typeof state.tools?.set !== "function" || typeof state.tools?.values !== "function") return undefined;
  return state as ViewState;
}

function copyArguments<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copyArguments) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyArguments(item)])) as T;
  }
  return value;
}
function copyResult(result: ToolResult): ToolResult {
  return { ...result, content: (result.content ?? []).map((block) => ({ ...block })) };
}

class ViewState {
  readonly schema = stateSchema;
  revision = 0;
  disposed = false;
  streamingMessage?: AssistantMessage;
  pending = new Set<AgentMessage>();
  tools = new Map<string, SessionViewTool>();
  listeners = new Set<Registration>();
  // v1.0.0 appends custom entries before emitting, without associating appMessage.
  custom = new Set<AgentMessage>();

  clear(): void {
    this.streamingMessage = undefined;
    this.pending.clear();
    this.tools.clear();
  }

  prune(internals: Internals, entries?: SessionEntry[]): void {
    for (const message of this.pending) {
      if (internals._entryIdsByMessage.has(message) || this.custom.has(message) ||
        entries?.some((entry) => entry.type === "message" && entry.message === message)) {
        this.pending.delete(message);
      }
    }
  }

  publish(event: AgentSessionEvent): void {
    this.revision++;
    if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
      const message = event.message;
      if (message.role === "assistant") {
        const copy = { ...message, content: (message.content ?? []).map((block) => block.type === "toolCall"
          ? { ...block, arguments: copyArguments(block.arguments) } : { ...block }) };
        this.streamingMessage = event.type === "message_end" ? undefined : copy;
        for (const [id, tool] of this.tools) if (!tool.started) this.tools.delete(id);
        for (const block of copy.content) {
          if (block.type === "toolCall") this.tools.set(block.id, {
            toolCallId: block.id, toolName: block.name, args: block.arguments,
            started: false, ...this.tools.get(block.id),
          });
        }
      }
      if ((event.type === "message_start" && (message.role === "user" || message.role === "custom")) ||
        event.type === "message_end") this.pending.add(message);
      if (event.type === "message_end" && message.role === "toolResult") this.tools.delete(message.toolCallId);
    } else if (event.type === "tool_execution_start" || event.type === "tool_execution_update" ||
      event.type === "tool_execution_end") {
      if (event.parentToolCallId !== undefined) return;
      const previous = this.tools.get(event.toolCallId);
      this.tools.set(event.toolCallId, {
        ...previous, toolCallId: event.toolCallId, toolName: event.toolName,
        args: event.type === "tool_execution_end" ? previous?.args : copyArguments(event.args), started: true,
        ...(event.type === "tool_execution_update" ? { partialResult: copyResult(event.partialResult) } : {}),
        ...(event.type === "tool_execution_end"
          ? { result: copyResult(event.result), isError: event.isError, complete: true } : {}),
      });
    } else if (event.type === "agent_end" || event.type === "agent_settled") this.clear();
  }
}

/** Pi 1.0.0 only. Install on the actual session before its first prompt. */
export function installSessionViewTracking(session: AgentSession): boolean {
  const existing = getState(session);
  if (existing) return !existing.disposed;
  // Do not overwrite an incompatible state or wrap its methods a second time.
  if (Object.getOwnPropertyDescriptor(session, stateKey)) return false;
  const internals = session as unknown as Internals;
  const keys = ["_emit", "_appendCustomMessage", "dispose"] as const;
  if (internals._isAgentRunActive !== false || session.isStreaming ||
    !(internals._entryIdsByMessage instanceof WeakMap) ||
    typeof session.sessionManager?.buildContextEntries !== "function" ||
    !Object.isExtensible(session)) return false;
  const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(session, key));
  if (keys.some((key, index) => typeof internals[key] !== "function" ||
    (descriptors[index] && (!descriptors[index]?.configurable || !("value" in descriptors[index]))))) return false;
  const state = new ViewState();
  const originals = { _emit: internals._emit, _appendCustomMessage: internals._appendCustomMessage, dispose: internals.dispose };
  const wrappers = {
    _emit(this: Internals, event: AgentSessionEvent): unknown {
      if (state.disposed) return originals._emit.call(this, event);
      state.prune(internals);
      state.publish(event);
      state.prune(internals);
      const revision = state.revision;
      const listeners = [...state.listeners];
      // Publish before native public listeners; subscriptions opened there already include this event.
      for (const registration of listeners) {
        if (!state.listeners.has(registration)) continue;
        try { registration.listener(event, revision); } catch { /* Presentation must not affect execution. */ }
      }
      try { return originals._emit.call(this, event); }
      finally {
        // Native persistence follows _emit synchronously. Do not retain finalized messages until the next event.
        queueMicrotask(() => { if (!state.disposed) state.prune(internals); });
      }
    },
    _appendCustomMessage(this: Internals, message: AgentMessage): unknown {
      state.custom.add(message);
      try { return originals._appendCustomMessage.call(this, message); }
      finally { state.pending.delete(message); state.custom.delete(message); }
    },
    dispose(this: Internals): unknown {
      if (!state.disposed) {
        state.disposed = true;
        state.clear();
        state.custom.clear();
        state.listeners.clear();
        keys.forEach((key, index) => {
          // Another owner may have wrapped/replaced us. Never overwrite their property.
          if (Object.getOwnPropertyDescriptor(session, key)?.value !== wrappers[key]) return;
          const descriptor = descriptors[index];
          if (descriptor) Object.defineProperty(session, key, descriptor);
          else Reflect.deleteProperty(session, key);
        });
      }
      return originals.dispose.call(this);
    },
  };
  keys.forEach((key, index) => {
    Object.defineProperty(session, key,
      descriptors[index] ? { ...descriptors[index], value: wrappers[key] } :
        { configurable: true, enumerable: false, writable: true, value: wrappers[key] });
  });
  // Keep the marker after disposal so all module copies reject reuse.
  Object.defineProperty(session, stateKey, { value: state, enumerable: false, configurable: false, writable: false });
  return true;
}

/** Snapshot and registration are synchronous: replay pending rows once, then consume subsequent events. */
export function subscribeSessionView(session: AgentSession, listener: SessionViewEventListener): {
  snapshot: SessionViewSnapshot;
  unsubscribe: () => void;
} {
  let state = getState(session);
  if (!state) {
    if (!installSessionViewTracking(session)) {
      throw new Error("Session view requires an idle, supported Pi 1.0.0 session tracked before running");
    }
    state = getState(session)!;
  }
  if (state.disposed) throw new Error("Cannot subscribe to a disposed session view");
  const entries = session.sessionManager.buildContextEntries();
  state.prune(session as unknown as Internals, entries);
  const snapshot: SessionViewSnapshot = {
    entries, streamingMessage: state.streamingMessage, pendingMessages: [...state.pending],
    tools: [...state.tools.values()], revision: state.revision,
  };
  const registration = { listener };
  state.listeners.add(registration);
  return { snapshot, unsubscribe: () => { state.listeners.delete(registration); } };
}
