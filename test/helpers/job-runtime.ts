import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import type { JobRuntime } from "../../src/jobs/runtime.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
export function jobHost(cwd: string) {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Handler[]>();
  const notices: Array<{ customType: string; content: unknown; details?: unknown }> = [];
  const raw = {
    registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); },
    on: (name: string, handler: Handler) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    sendMessage: (message: (typeof notices)[number]) => { notices.push(message); },
    events: new EventEmitter(),
    registerCommand: vi.fn(), registerShortcut: vi.fn(), registerMessageRenderer: vi.fn(),
  };
  const ctx = {
    cwd, sessionManager: SessionManager.inMemory(cwd),
    ui: { notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn(), theme: { fg: (_token: string, text: string) => text } },
    abort: vi.fn(), isIdle: () => false, tools: [],
  } as unknown as ExtensionToolContext;
  const pi = raw as unknown as ExtensionAPI;
  return {
    pi, ctx, tools, notices,
    async input(text: string, source = "interactive", images?: unknown[], streamingBehavior?: "steer" | "followUp") {
      for (const handler of handlers.get("input") ?? []) {
        const result = await handler({ text, source, images, streamingBehavior }, ctx);
        if (result && typeof result === "object" && "action" in result && result.action === "handled") throw new Error("Input was stolen instead of queued");
      }
    },
    async emit(name: string) { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); },
    execute(name: string, params: unknown, id = `${name}-${Date.now()}`, signal = new AbortController().signal) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Missing tool ${name}`);
      return tool.execute(id, params, signal, undefined, ctx);
    },
  };
}

export async function jobChild(runtime: JobRuntime, cwd: string, id: string) {
  runtime.beginRun(id);
  const host = jobHost(cwd);
  const extension = runtime.childExtension(id);
  if (typeof extension === "function") await extension(host.pi);
  else await extension.factory(host.pi);
  return host;
}

export async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition not reached before deadline");
    await delay(10);
  }
}

export function textOf(result: { content: unknown[] }): string {
  return result.content.map(block => {
    const b = block as { type?: string; text?: string };
    return b.type === "text" ? b.text : "";
  }).join("\n");
}
