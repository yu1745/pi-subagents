import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import {
  type AgentSession, type AgentSessionEvent, AssistantMessageComponent,
  type KeybindingsManager, type MarkdownTransformer, type ReadonlyFooterDataProvider,
  type SessionEntry, ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import type { SessionViewSnapshot } from "./session-snapshot.js";

type Message = Extract<AgentSessionEvent, { type: "message_start" }>["message"];
export interface NativeFooterData extends ReadonlyFooterDataProvider { dispose(): void }

/** Deliberately pinned to the presentation fields/methods of InteractiveMode 1.0.0. */
interface Presentation {
  session: AgentSession;
  sessionManager: AgentSession["sessionManager"];
  settingsManager: AgentSession["settingsManager"];
  ui: TUI;
  chatContainer: Container;
  pendingTools: Map<string, ToolExecutionComponent>;
  streamingComponent?: AssistantMessageComponent;
  streamingMessage?: AssistantMessage;
  outputPad: number;
  hideThinkingBlock: boolean;
  hiddenThinkingLabel: string;
  toolOutputExpanded: boolean;
  mermaidMarkdownTransformer: MarkdownTransformer;
  renderSessionEntries(entries: SessionEntry[]): void;
  renderSessionItems(items: unknown[]): void;
  addMessageToChat(message: Message): void;
  addCustomEntryToChat(entry: Extract<SessionEntry, { type: "custom" }>): void;
  getRegisteredToolDefinition(name: string): ConstructorParameters<typeof ToolExecutionComponent>[4];
  getMarkdownThemeWithSettings(): MarkdownTheme;
  getMarkdownTransformers(): MarkdownTransformer[];
  getUserMessageText(message: Message): string;
  addCacheWarmingUsage(entry: SessionEntry): void;
  addCompactionCostNotice(notice: unknown): void;
  addCacheMissNotice(notice: unknown): void;
  maybeShowThinkingDropNotice(message: AssistantMessage): void;
  maybeShowCacheMissNotice(message: AssistantMessage): void;
}
export interface NativeHost extends Presentation {
  keybindings: KeybindingsManager;
  footerDataProvider: NativeFooterData & { constructor: new (cwd: string) => NativeFooterData };
}

export function assertNativeHost(mode: unknown): asserts mode is NativeHost {
  if (!mode || typeof mode !== "object") throw new Error("Expected Pi 1.0.0 InteractiveMode");
  const host = mode as NativeHost;
  const methods = ["renderSessionEntries", "renderSessionItems", "addMessageToChat", "addCustomEntryToChat",
    "getRegisteredToolDefinition", "getMarkdownThemeWithSettings", "getMarkdownTransformers", "getUserMessageText",
    "addCacheWarmingUsage", "addCompactionCostNotice", "addCacheMissNotice", "maybeShowThinkingDropNotice",
    "maybeShowCacheMissNotice"] as const;
  const prototype = Object.getPrototypeOf(host) as Presentation | null;
  if (!prototype || methods.some((key) => typeof prototype[key] !== "function") ||
    typeof host.ui?.requestRender !== "function" || typeof host.keybindings?.matches !== "function" ||
    typeof host.mermaidMarkdownTransformer !== "function" ||
    typeof host.footerDataProvider?.constructor !== "function" ||
    typeof host.footerDataProvider?.onBranchChange !== "function" ||
    typeof host.footerDataProvider?.dispose !== "function") {
    throw new Error("Unsupported Pi host: native session view requires InteractiveMode 1.0.0 presentation API");
  }
}

/** No InteractiveMode construction, controller initialization, or parent instance inheritance. */
export class NativeTranscript {
  readonly receiver: Presentation;
  readonly container = new Container();
  private readonly tools = new Map<string, ToolExecutionComponent>();

  constructor(mode: unknown, session: AgentSession) {
    assertNativeHost(mode);
    const fields = {
      session, sessionManager: session.sessionManager, settingsManager: session.settingsManager,
      ui: mode.ui, chatContainer: this.container, pendingTools: new Map<string, ToolExecutionComponent>(),
      streamingComponent: undefined, streamingMessage: undefined,
      outputPad: session.settingsManager.getOutputPad(), hideThinkingBlock: session.settingsManager.getHideThinkingBlock(),
      hiddenThinkingLabel: mode.hiddenThinkingLabel, toolOutputExpanded: false,
      mermaidMarkdownTransformer: mode.mermaidMarkdownTransformer,
    };
    // Native session/sessionManager/settingsManager are getter-only on the prototype.
    this.receiver = Object.defineProperties(Object.create(Object.getPrototypeOf(mode)),
      Object.getOwnPropertyDescriptors(fields)) as Presentation;
  }

  ensureTool(name: string, id: string, args: unknown): ToolExecutionComponent {
    const r = this.receiver;
    let tool = this.tools.get(id) ?? r.pendingTools.get(id);
    if (!tool) {
      tool = new ToolExecutionComponent(name, id, args, {
        showImages: r.settingsManager.getShowImages(), imageWidthCells: r.settingsManager.getImageWidthCells(),
      }, r.getRegisteredToolDefinition(name), r.ui, r.sessionManager.getCwd());
      tool.setExpanded(r.toolOutputExpanded);
      this.container.addChild(tool);
      r.pendingTools.set(id, tool);
    } else tool.updateArgs(args);
    this.tools.set(id, tool);
    return tool;
  }

  private indexRenderedTools(): void {
    // Native replay removes finalized/error tools from pendingTools. Keep their 1.0.0
    // component IDs as well, so a snapshot's final-event gap cannot render them twice.
    for (const child of this.container.children) {
      if ("toolCallId" in child && typeof child.toolCallId === "string" &&
        "updateResult" in child && typeof child.updateResult === "function") {
        this.tools.set(child.toolCallId, child as unknown as ToolExecutionComponent);
      }
    }
  }

  replay(snapshot: SessionViewSnapshot): void {
    const r = this.receiver;
    this.container.clear();
    this.tools.clear();
    r.streamingComponent = undefined;
    r.streamingMessage = undefined;
    r.renderSessionEntries([...snapshot.entries, ...snapshot.pendingMessages.map((message, index) => ({
      type: "message" as const, id: `pending-${index}`, parentId: null,
      timestamp: new Date(message.timestamp).toISOString(), message,
    }))]);
    this.indexRenderedTools();
    if (snapshot.streamingMessage) this.handleEvent({ type: "message_start", message: snapshot.streamingMessage });
    for (const tool of snapshot.tools) {
      const component = this.ensureTool(tool.toolName, tool.toolCallId, tool.args);
      if (tool.started) { component.setArgsComplete(); component.markExecutionStarted(); }
      if (tool.complete && tool.result) {
        component.updateResult({ ...tool.result, isError: tool.isError ?? false });
        r.pendingTools.delete(tool.toolCallId);
      } else if (tool.partialResult) component.updateResult({ ...tool.partialResult, isError: false }, true);
    }
  }

  /** Put a newly committed compaction at its chronological, not model-context, position. */
  renderCompaction(): readonly string[] {
    const r = this.receiver;
    const entries = r.sessionManager.buildContextEntries();
    const first = entries[0];
    if (first?.type !== "compaction") return [];
    const branch = r.sessionManager.getBranch();
    const index = branch.findIndex((entry) => entry.id === first.id);
    const after = new Set(branch.slice(index + 1).map((entry) => entry.id));
    this.container.clear();
    this.tools.clear();
    r.renderSessionEntries([
      ...entries.slice(1).filter((entry) => !after.has(entry.id)), first,
      ...entries.slice(1).filter((entry) => after.has(entry.id)),
    ]);
    this.indexRenderedTools();
    return entries.map((entry) => entry.id);
  }

  handleEvent(event: AgentSessionEvent): void {
    const r = this.receiver;
    switch (event.type) {
      case "agent_start": r.pendingTools.clear(); break;
      case "message_start":
        if (event.message.role === "user" || event.message.role === "custom") r.addMessageToChat(event.message);
        else if (event.message.role === "assistant") {
          r.streamingMessage = event.message;
          r.streamingComponent = new AssistantMessageComponent(undefined, r.hideThinkingBlock,
            r.getMarkdownThemeWithSettings(), r.hiddenThinkingLabel, r.outputPad, r.getMarkdownTransformers());
          this.container.addChild(r.streamingComponent);
          r.streamingComponent.updateContent(event.message, true);
        }
        break;
      case "message_update":
        if (event.message.role !== "assistant" || !r.streamingComponent) break;
        r.streamingMessage = event.message;
        r.streamingComponent.updateContent(event.message, true);
        for (const block of event.message.content) {
          if (block.type === "toolCall") this.ensureTool(block.name, block.id, block.arguments);
        }
        break;
      case "message_end": {
        if (event.message.role !== "assistant") break;
        const message = event.message.stopReason === "aborted" ? { ...event.message,
          errorMessage: r.session.retryAttempt > 0 ? `Aborted after ${r.session.retryAttempt} retry attempt${r.session.retryAttempt > 1 ? "s" : ""}` : "Operation aborted",
        } : event.message;
        if (r.streamingComponent) r.streamingComponent.updateContent(message, false);
        else r.addMessageToChat(message);
        for (const block of message.content) {
          if (block.type === "toolCall") this.ensureTool(block.name, block.id, block.arguments);
        }
        if (message.stopReason === "aborted" || message.stopReason === "error") {
          for (const tool of r.pendingTools.values()) tool.updateResult({
            content: [{ type: "text", text: message.errorMessage || "Error" }], isError: true,
          });
          r.pendingTools.clear();
        } else {
          for (const tool of r.pendingTools.values()) tool.setArgsComplete();
          r.maybeShowThinkingDropNotice(message);
          r.maybeShowCacheMissNotice(message);
        }
        r.streamingComponent = undefined;
        r.streamingMessage = undefined;
        break;
      }
      case "tool_execution_start":
        if (!event.parentToolCallId) this.ensureTool(event.toolName, event.toolCallId, event.args).markExecutionStarted();
        break;
      case "tool_execution_update":
        if (!event.parentToolCallId) r.pendingTools.get(event.toolCallId)?.updateResult({ ...event.partialResult, isError: false }, true);
        break;
      case "tool_execution_end":
        if (!event.parentToolCallId) {
          r.pendingTools.get(event.toolCallId)?.updateResult({ ...event.result, isError: event.isError });
          r.pendingTools.delete(event.toolCallId);
        }
        break;
      case "agent_end":
        if (r.streamingComponent) this.container.removeChild(r.streamingComponent);
        r.streamingComponent = undefined;
        r.streamingMessage = undefined;
        r.pendingTools.clear();
        this.tools.clear();
        break;
    }
    r.ui.requestRender();
  }

  toggleTools(): void {
    const r = this.receiver;
    r.toolOutputExpanded = !r.toolOutputExpanded;
    for (const child of this.container.children) {
      if ("setExpanded" in child && typeof child.setExpanded === "function") child.setExpanded(r.toolOutputExpanded);
    }
  }

  toggleThinking(): void {
    const r = this.receiver;
    r.hideThinkingBlock = !r.hideThinkingBlock;
    // Structural: replay components can come from the bundled host's constructor.
    for (const child of this.container.children) {
      if ("setHideThinkingBlock" in child && typeof child.setHideThinkingBlock === "function") child.setHideThinkingBlock(r.hideThinkingBlock);
    }
  }
}
