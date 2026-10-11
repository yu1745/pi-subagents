import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  type AgentSession, type AgentSessionEvent, createAgentSession, DefaultResourceLoader,
  InteractiveMode, initTheme, SessionManager, SettingsManager, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NativeTranscript } from "../src/ui/native-pi-1.1.0/native-transcript.js";
import { installSessionViewTracking, subscribeSessionView } from "../src/ui/native-pi-1.1.0/session-snapshot.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

beforeAll(() => initTheme("dark"));

describe("Pi 1.1 native tool rendering contracts", () => {
  it.each([0, 1, 3].flatMap(padding => ["live", "snapshot", "persisted"].flatMap(source =>
    ["render_probe", "unknown_probe"].map(name => ({ padding, source, name })),
  )))("preserves resolver, configured padding $padding and duration for $source $name", async ({ padding, source, name }) => {
    const cwd = mkdtempSync(join(tmpdir(), "native-render-110-"));
    const faux = registerFauxProvider({ provider: "native-render-110", models: [{ id: "test" }] });
    let session: AgentSession | undefined;
    const calls: string[] = [];
    const results: Array<{ durationMs: number | undefined; outputPad: number }> = [];
    const renderers: ToolRenderers = {
      renderShell: "self",
      renderCall: (_args, _theme, context) => new Text(`${" ".repeat(context.outputPad)}resolved call`, 0, 0),
      renderResult: (_result, _options, _theme, context) => {
        results.push({ durationMs: context.durationMs, outputPad: context.outputPad });
        return new Text(`${" ".repeat(context.outputPad)}resolved result ${context.durationMs ?? "pending"}`, 0, 0);
      },
    };
    try {
      const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, noExtensions: true,
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [
          pi => {
            pi.registerTool({ name: "render_probe", label: "Probe", description: "Test renderer",
              parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }), ...renderers });
            pi.registerToolRenderer((toolName, next) => { calls.push(`first:${toolName}`); return next(); });
          },
          pi => {
            pi.registerToolRenderer((toolName, next) => {
              calls.push(`second:${toolName}`);
              return next() ?? (toolName === "unknown_probe" ? renderers : undefined);
            });
          },
        ],
      });
      await loader.reload();
      ({ session } = await createAgentSession({ cwd, agentDir: cwd, model: faux.getModel(),
        modelRuntime: fauxModelBackend(faux.getModel()).modelRuntime, resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory({ outputPad: padding, showCacheMissNotices: false }),
      }));
      await session.bindExtensions({});
      expect(installSessionViewTracking(session)).toBe(true);
      expect(session.getToolDefinition("unknown_probe")).toBeUndefined();
      const noop = () => {};
      const parentRenderer = new TuiAltScreen({ columns: 80, rows: 24, kittyProtocolActive: false,
        start: noop, stop: noop, drainInput: async () => {}, write: noop, moveBy: noop,
        hideCursor: noop, showCursor: noop, clearLine: noop, clearFromCursor: noop, clearScreen: noop,
        setTitle: noop, setProgress: noop, setProgramStatus: noop });
      const resetSelection = vi.spyOn(parentRenderer, "resetTextSelection");
      class FooterData {
        onBranchChange() { return noop; }
        dispose() {}
      }
      const host = Object.defineProperties(Object.create(InteractiveMode.prototype), Object.getOwnPropertyDescriptors({
        session: { parent: true }, renderer: parentRenderer, ui: { requestRender: vi.fn() },
        keybindings: { matches: () => false }, footerDataProvider: new FooterData(),
        mermaidMarkdownTransformer: (text: string) => text, hiddenThinkingLabel: "Thinking...",
      }));
      const message = fauxAssistantMessage([{ type: "toolCall", id: "probe-call", name, arguments: {} }]);
      const result = { content: [{ type: "text" as const, text: "done" }], details: {} };
      const end = { type: "tool_execution_end" as const, toolCallId: "probe-call", toolName: name,
        result, isError: false, durationMs: 2345 };
      if (source === "persisted") {
        session.sessionManager.appendMessage(message);
        session.sessionManager.appendMessage({ role: "toolResult", toolCallId: "probe-call", toolName: name,
          ...result, isError: false, durationMs: 2345, timestamp: 2 });
      } else if (source === "snapshot") {
        const emit = (event: AgentSessionEvent) => (session as unknown as { _emit(event: AgentSessionEvent): void })._emit(event);
        emit({ type: "message_end", message });
        emit({ type: "tool_execution_start", toolCallId: "probe-call", toolName: name, args: {} });
        emit(end);
      }
      const transcript = new NativeTranscript(host, session);
      const view = subscribeSessionView(session, () => {});
      try { transcript.replay(view.snapshot); } finally { view.unsubscribe(); }
      if (source === "live") {
        transcript.handleEvent({ type: "tool_execution_start", toolCallId: "probe-call", toolName: name, args: {} });
        transcript.handleEvent(end);
      }
      const lines = transcript.container.render(80).map(line => stripTerminalSequences(line).trimEnd());
      // Pi 1.1 accepts outputPad 0/1 only: a configured 3 normalizes to 1.
      // Preserve the host's effective setting rather than inventing plugin padding.
      const effectivePadding = padding === 0 ? 0 : 1;
      expect(session.settingsManager.getOutputPad()).toBe(effectivePadding);
      expect(lines).toContain(`${" ".repeat(effectivePadding)}resolved call`);
      expect(lines).toContain(`${" ".repeat(effectivePadding)}resolved result 2345`);
      expect(results.at(-1)).toEqual({ durationMs: 2345, outputPad: effectivePadding });
      expect(calls).toContain(`first:${name}`);
      expect(calls.indexOf(`first:${name}`)).toBeLessThan(calls.indexOf(`second:${name}`));
      // The borrowed prototype's new selection reset must never reach the parent.
      expect(resetSelection).not.toHaveBeenCalled();
      expect(Object.hasOwn(transcript.receiver, "renderer")).toBe(false);
    } finally {
      session?.dispose();
      faux.unregister();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
