import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { agentCall, type PrintModeRun, runPrintMode, toolResultsNamed } from "./helpers/print-mode-runner.js";

// Real loader/session startup can exceed the unit-test default under a full run.
vi.setConfig({ testTimeout: 30_000 });

function textOf(context: Context): string {
  return context.messages.map(message => typeof message.content === "string" ? message.content
    : message.content.filter(item => item.type === "text").map(item => item.text).join("\n")).join("\n");
}

describe("real child-to-parent messaging", () => {
  it("honors disallowed_tools without advertising an unavailable reporting tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "parent-message-denied-"));
    mkdirSync(join(root, ".pi/agents"), { recursive: true });
    writeFileSync(join(root, ".pi/agents/reporter.md"), "---\ntools: read\nextensions: false\ndisallowed_tools: send_parent_message\n---\nPerform the assigned task.\n");
    let run: PrintModeRun | undefined;
    try {
      run = await runPrintMode({ cwd: root, prompt: "ROOT_DENIED", live: false,
        respond: context => {
          const text = textOf(context);
          if (text.includes("ROOT_DENIED")) {
            if (!context.messages.some(message => message.role === "toolResult")) {
              return agentCall({ subagent_type: "reporter", prompt: "CHILD_DENIED", description: "Check scope", run_in_background: false });
            }
            return text.includes("CHILD_SCOPE_OK") ? "ROOT_SCOPE_OK" : "ROOT_SCOPE_FAILED";
          }
          expect(context.tools?.map(tool => tool.name)).not.toContain("send_parent_message");
          expect(context.systemPrompt).not.toContain("proactively share important findings");
          return "CHILD_SCOPE_OK";
        },
      });
      expect(run.responseText).toBe("ROOT_SCOPE_OK");
    } finally {
      await run?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["replace", "append"])("unblocks a parent's result wait and receives guidance before finishing (%s prompt)", async promptMode => {
    const root = mkdtempSync(join(tmpdir(), "parent-message-e2e-"));
    mkdirSync(join(root, ".pi/agents"), { recursive: true });
    writeFileSync(join(root, ".pi/subagents.json"), JSON.stringify({ nestedAgentsEnabled: false, rememberAgents: false }));
    writeFileSync(join(root, ".pi/agents/reporter.md"), `---\ntools: read\nextensions: false\nskills: false\nisolated: true\nprompt_mode: ${promptMode}\n---\nPerform the assigned task.\n`);
    writeFileSync(join(root, "evidence.txt"), "relevant source evidence");
    let startReport!: () => void;
    let replySent!: () => void;
    const reportGate = new Promise<void>(resolve => { startReport = resolve; });
    const replyGate = new Promise<void>(resolve => { replySent = resolve; });
    let parentStep = 0;
    let childStep = 0;
    let id = "";
    let run: PrintModeRun | undefined;
    try {
      run = await runPrintMode({ cwd: root, prompt: "ROOT_TASK", live: false, timeoutMs: 12_000, maxModelCalls: 16,
        respond: async context => {
          const text = textOf(context);
          if (text.includes("ROOT_TASK")) {
            switch (parentStep++) {
              case 0: return agentCall({ subagent_type: "reporter", prompt: "CHILD_TASK", description: "Inspect source", run_in_background: true });
              case 1:
                id = /Agent ID: ([^\n]+)/.exec(text)?.[1] ?? "";
                expect(id).not.toBe("");
                startReport();
                return fauxToolCall("get_subagent_result", { agent_id: id, wait: true });
              case 2:
                expect(text).toContain("API_UNITS_NEED_DECISION");
                expect(text).toContain("Agent is still running");
                replySent();
                return fauxToolCall("steer_subagent", { agent_id: id, message: "USE_CONSERVATIVE_UNITS" });
              case 3: return fauxToolCall("get_subagent_result", { agent_id: id, wait: true });
              default: return "ROOT_DONE";
            }
          }
          if (childStep++ === 0) {
            expect(context.tools?.map(tool => tool.name)).toContain("send_parent_message");
            expect(context.systemPrompt).toContain("proactively share important findings");
            await reportGate;
            return fauxToolCall("send_parent_message", { message: "API_UNITS_NEED_DECISION: source evidence.txt; decide units." });
          }
          if (childStep === 2) {
            await replyGate;
            return fauxToolCall("read", { path: join(root, "evidence.txt") });
          }
          expect(text).toContain("USE_CONSERVATIVE_UNITS");
          return "CHILD_DONE";
        },
      });
      expect(run.responseText).toBe("ROOT_DONE");
      const record = run.manager?.getRecord(id) as AgentRecord | undefined;
      expect(record?.status).toBe("completed");
      expect(record?.result).toBe("CHILD_DONE");
      expect(toolResultsNamed(run.parentSession, "get_subagent_result").at(-1)).toContain("CHILD_DONE");
    } finally {
      startReport(); replySent();
      await run?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
