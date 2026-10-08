// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
/**
 * `agent_bg` tool — runs a separate `pi -p` process in the background.
 *
 * Builds a continuity prompt from the current session's first user prompt and
 * latest assistant message, then spawns a detached `pi -p` process with the
 * same model. Output is written to the job log and surfaced live via progress
 * streaming; completion is reported with a background-job notification.
 */

import { execSync } from "node:child_process";
import { closeSync, constants, openSync, unlinkSync, writeFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { textBlock } from "../format.js";
import {
    assertJobSlot,
    isBlankCommand,
    requireExistingCwd as requireCwd,
    startBackgroundJob,
} from "../lifecycle.js";
import { streamLog } from "../output.js";
import { add, createRunningJob, LOG_DIR, logPathFor, newJobId } from "../registry.js";
import { type SpawnResult, spawnWithFileOutput } from "../spawn.js";
import type { BackgroundRegistry } from "../state.js";

/** Resolve the full path to the pi binary, memoised for the session. */
let cachedPiBinary: string | undefined;
function resolvePiBinary(): string {
    if (cachedPiBinary !== undefined) return cachedPiBinary;
    try {
        cachedPiBinary = execSync("which pi", { encoding: "utf-8", timeout: 3000 }).trim();
    } catch {
        cachedPiBinary = "pi";
    }
    return cachedPiBinary;
}

interface ContentMessage {
    role: string;
    content: string | { type: string; text?: string }[];
}

/** Narrow a session entry to a message entry with content. */
function isMessageEntry(entry: SessionEntry): entry is SessionEntry & { message: ContentMessage } {
    return entry.type === "message" && "message" in entry;
}

/** Extract text from message content; unknown blocks are ignored. */
function extractText(content: string | { type: string; text?: string }[]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((b): b is { type: string; text: string } =>
            typeof b === "object" && b !== null && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
}

/** Latest assistant message text from the session, or "" if none. */
function lastAssistantText(entries: SessionEntry[]): string {
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (isMessageEntry(e) && e.message.role === "assistant") {
            return extractText(e.message.content).slice(-2_000);
        }
    }
    return "";
}

/** First user prompt from the session, or "" if none. */
function firstUserPrompt(entries: SessionEntry[]): string {
    for (const e of entries) {
        if (isMessageEntry(e) && e.message.role === "user") {
            return extractText(e.message.content).slice(0, 2_000);
        }
    }
    return "";
}

/** Register the `agent_bg` tool. */
export function registerAgentBgTool(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.registerTool({
        name: "agent_bg",
        label: "Background Agent",
        description: "Run a separate pi -p process in the background with continuity context.",
        promptSnippet: "Delegate work to a background pi -p process",
        promptGuidelines: [
            "Use agent_bg for work that can run independently from the current session.",
            "Completion is reported with a background-job notification.",
        ],
        parameters: Type.Object({
            prompt: Type.String({ description: "Task to send to the background agent" }),
            cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
        }),

        async execute(toolCallId, params, _signal, onUpdate, ctx) {
            const p = params as { prompt: string; cwd?: string };
            if (isBlankCommand(p.prompt)) throw new Error("Prompt is empty.");
            const cwd = p.cwd ?? ctx.cwd;
            requireCwd(cwd);

            assertJobSlot(reg);

            const id = newJobId("agent", reg);
            const logPath = logPathFor(id);

            // The prompt, truncated for display — doubles as the job name so
            // notifications and the jobs list name the actual task.
            const promptLabel =
                p.prompt.slice(0, 100) + (p.prompt.length > 100 ? "…" : "");

            // Build continuity prompt.
            const entries = ctx.sessionManager.getEntries();
            const summary = lastAssistantText(entries);
            const originalPrompt = firstUserPrompt(entries);
            const promptContent = [
                "You are continuing a task that was backgrounded.",
                "", "## Original task", p.prompt,
                ...(originalPrompt ? ["", "## Previous user context", originalPrompt] : []),
                ...(summary ? ["", "## Where you left off", summary] : []),
                "", "Continue from where you left off.",
            ].join("\n");

            const promptFile = `${LOG_DIR}/prompt-${id}.md`;
            const promptFd = openSync(promptFile,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try { writeFileSync(promptFd, promptContent); }
            catch (error) {
                try { unlinkSync(promptFile); } catch { /* best-effort */ }
                throw error;
            } finally { closeSync(promptFd); }

            const model = ctx.model;
            const modelArg = model ? `${model.provider}/${model.id}` : undefined;
            const piBin = resolvePiBinary();
            const spawnArgs = [
                "-p", "--mode", "text",
                ...(modelArg ? ["--model", modelArg] : []),
                `@${promptFile}`,
            ];

            let spawned: SpawnResult;
            try {
                spawned = spawnWithFileOutput({
                    file: piBin,
                    fileArgs: spawnArgs,
                    cwd,
                    logPath,
                });
            } catch (err) {
                try { unlinkSync(promptFile); } catch { /* already gone */ }
                throw err;
            }

            const job = createRunningJob({
                id, name: promptLabel, command: `pi -p (background agent)`, pid: spawned.pid, identity: spawned.identity,
                logPath, toolCallId, kind: "agent", cwd,
            });
            add(reg, job);

            // Progress streaming — surface agent output via onUpdate.
            const progressPoller = streamLog(logPath, onUpdate);
            const jobAc = startBackgroundJob({
                reg, pi, ctx, job, exit: spawned.exit,
                onCleanup: () => { try { unlinkSync(promptFile); } catch { /* already gone */ } },
            });
            jobAc.signal.addEventListener("abort", () => progressPoller.stop(), { once: true });

            return {
                content: [textBlock(
                    `Agent running in background with ID: ${id}. Output is being written to: ${logPath}\n` +
                    `Prompt: ${promptLabel}`
                )],
                details: undefined,
            };
        },
    });
}
