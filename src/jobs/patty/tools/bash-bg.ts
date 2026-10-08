// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
// src/tools/bash-bg.ts
//
// `bash_bg` tool — start a bash command in the background immediately.
//
// Unlike the `bash` override, there is no race/timeout/quick-completion
// window. The child runs in the background for its lifetime and a
// <task-notification> is sent on completion. This is a thin wrapper over the
// file-fd spawn backend plus the per-job AbortController + stall watcher.

import { appendFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { textBlock } from "../format.js";
import {
    assertJobSlot, isBlankCommand, requireExistingCwd, startBackgroundJob,
} from "../lifecycle.js";
import { add, createRunningJob, logPathFor, newJobId } from "../registry.js";
import { killProcessTree, spawnWithFileOutput } from "../spawn.js";
import type { BackgroundRegistry } from "../state.js";
import { isTerminalStatus, type UiContext } from "../types.js";

type BashBgCtx = UiContext & { cwd: string };

export function registerBashBgTool(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.registerTool({
        name: "bash_bg",
        label: "Background Bash",
        description:
            "Start a bash command in the background immediately. " +
            "Output is saved to a private temporary log path returned by the tool.",
        promptSnippet: "Start long-running commands directly in the background",
        promptGuidelines: [
            "Use bash_bg when a command should definitely start in the background.",
            "bash_bg gives ONE completion notification. For a per-event stream (tail -f | grep, poll loop, file watch, WebSocket feed), use the monitor tool instead.",
            "For waits, prefer jobs action='attach' or a condition-based monitor when those express the real completion condition; explicit finite sleep commands remain allowed.",
            "Give the job a name when it will be easier to track in jobs list.",
        ],
        parameters: Type.Object({
            command: Type.String({ description: "Command to run" }),
            name: Type.Optional(Type.String({ description: "Label shown in jobs list" })),
            timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
            notify: Type.Optional(Type.Boolean({ description: "Notify on completion (default: true)" })),
        }),

        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as { command: string; name?: string; timeout?: number; notify?: boolean };
            const ctx2 = ctx as BashBgCtx;
            if (isBlankCommand(p.command)) throw new Error("Command is empty.");
            requireExistingCwd(ctx2.cwd);
            assertJobSlot(reg);

            const id = newJobId("shell", reg);
            const logPath = logPathFor(id);
            const spawned = spawnWithFileOutput({
                command: p.command, cwd: ctx2.cwd, logPath,
            });

            const job = createRunningJob({
                id, name: p.name, command: p.command, pid: spawned.pid, identity: spawned.identity,
                logPath, toolCallId,
            });
            add(reg, job);
            const jobAc = startBackgroundJob({
                reg, pi, ctx: ctx2, job, exit: spawned.exit,
                shouldNotify: p.notify !== false,
            });

            // An explicit timeout applies uniformly to every command. It is a
            // caller-selected execution deadline, not a command-text policy.
            if (p.timeout) {
                const timer = setTimeout(() => {
                    if (isTerminalStatus(job.status) || reg.nonInteractive) return;
                    try {
                        appendFileSync(logPath, `Command timed out after ${p.timeout}s\n`);
                    } catch { /* best-effort — the kill below still happens */ }
                    killProcessTree(job.identity, "SIGTERM");
                }, p.timeout * 1000);
                (timer as NodeJS.Timeout).unref();
                jobAc.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
            }

            return {
                content: [textBlock(
                    `Command running in background with ID: ${id}.` +
                    `${p.name ? ` Name: ${p.name}.` : ""} Output is being written to: ${logPath}`
                )],
                details: undefined,
            };
        },
    });
}
