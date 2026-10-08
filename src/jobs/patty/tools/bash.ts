// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
/**
 * `bash` tool override.
 *
 * Single file-descriptor backend (no tmux):
 *   - run_in_background=true spawns immediately and returns a job handle
 *   - foreground commands race completion against backgrounding
 *   - a 2s quick-completion window skips the backgrounding machinery
 *   - Ctrl+Shift+B (manual) or the timeout timer move a command to background
 */

import { statSync, unlinkSync } from "node:fs";
import type {
    AgentToolResult,
    AgentToolUpdateCallback,
    ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
    type BashToolDetails,
    createBashToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { textBlock } from "../format.js";
import { clearBackgroundHint, showBackgroundHint } from "../hint.js";
import {
    assertJobSlot,
    completeJob,
    ensureCompletionPromise,
    isBlankCommand,
    requireExistingCwd,
    startBackgroundJob,
    terminateJob,
} from "../lifecycle.js";
import { streamLog } from "../output.js";
import {
    add,
    createRunningJob,
    logPathFor,
    markStarted,
    newJobId,
    readLogTail,
} from "../registry.js";
import { killProcessTree, type SpawnExit, spawnWithFileOutput } from "../spawn.js";
import type { BackgroundRegistry } from "../state.js";
import {
    DEFAULT_TIMEOUT_MS,
    type ForegroundSlot,
    isTerminalStatus,
    MAX_LOG_BYTES,
    OUTPUT_PREVIEW_CHARS,
    QUICK_COMPLETION_MS,
    type UiContext,
} from "../types.js";
import { bashParamSchema } from "./bash-params.js";

/** UI context + cwd is all this tool needs from the host context. */
type BashCtx = UiContext & { cwd: string };

/** Register the overridden `bash` tool. */
export function registerBashTool(
    pi: ExtensionAPI,
    reg: BackgroundRegistry,
    originalBash: ReturnType<typeof createBashToolDefinition>
): void {
    pi.registerTool({
        ...originalBash,
        // The SDK's synchronous output schema cannot represent a job handoff.
        outputSchema: undefined,
        name: "bash",
        description:
            "Run a bash command. Long-running commands auto-background after timeout. " +
            "Set run_in_background=true to start in background immediately. " +
            "Use /bg to manually background a running command.",
        promptSnippet:
            "Run shell commands; long-running commands auto-background or use run_in_background=true",
        promptGuidelines: [
            "Use bash with run_in_background=true when a command is expected to run for a long time.",
            "run_in_background is for ONE notification (the command exits when done). For per-event streaming (watching logs, polling an API, file changes), use the monitor tool instead.",
            "For waits, prefer jobs action='attach' or a condition-based monitor when those express the real completion condition; explicit finite sleep commands remain allowed.",
            "Check background job status with jobs action='list'.",
            "Read background output with jobs action='output'.",
        ],
        parameters: bashParamSchema,

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const p = params as {
                command: string;
                timeout?: number;
                run_in_background?: boolean;
                description?: string;
            };
            const bashCtx = ctx as BashCtx;

            signal?.throwIfAborted();
            if (isBlankCommand(p.command)) throw new Error("Command is empty.");
            if (p.timeout !== undefined && (!Number.isFinite(p.timeout) || p.timeout <= 0 || p.timeout > 86_400)) {
                throw new Error("timeout must be a finite positive number of seconds (maximum 86400)");
            }
            requireExistingCwd(bashCtx.cwd);

            assertJobSlot(reg);

            // Explicit background mode — spawn and return immediately.
            if (p.run_in_background) {
                return spawnBackground({
                    toolCallId,
                    command: p.command,
                    name: p.description,
                    cwd: bashCtx.cwd,
                    reg,
                    pi,
                    ctx: bashCtx,
                });
            }

            // Foreground mode — race completion against backgrounding.
            return runForeground({
                toolCallId,
                command: p.command,
                timeoutMs: p.timeout === undefined ? DEFAULT_TIMEOUT_MS : p.timeout * 1000,
                signal,
                onUpdate,
                ctx: bashCtx,
                reg,
                pi,
            });
        },
    });
}

// --- Foreground backend --------------------------------------------------

async function runForeground(args: {
    toolCallId: string;
    command: string;
    timeoutMs: number;
    signal: AbortSignal | undefined;
    onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined;
    ctx: BashCtx;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
}): Promise<AgentToolResult<BashToolDetails | undefined>> {
    const { toolCallId, command, timeoutMs, signal, onUpdate, ctx, reg, pi } =
        args;
    const generation = reg.generation;
    const isActive = () => !reg.disposed && reg.generation === generation;
    const id = newJobId("shell", reg);
    const logPath = logPathFor(id);

    // Waiting and process ownership are separate. Steering releases the wait
    // without aborting this turn; a genuine turn cancellation terminates the
    // foreground process with bounded escalation.
    const spawned = spawnWithFileOutput({
        command,
        cwd: ctx.cwd,
        logPath,
        foreground: true,
    });

    // Register the foreground slot so Ctrl+Shift+B can find this command.
    let pauseRequested = false;
    let cancelled = false;
    let handedToBackground = false;
    let pauseResolve: ((reason: "manual" | "timeout") => void) | null = null;
    const pausePromise = new Promise<"manual" | "timeout">((r) => {
        pauseResolve = r;
    });
    const requestPause = (reason: "manual" | "timeout") => {
        if (cancelled) return;
        pauseRequested = true;
        pauseResolve?.(reason);
    };

    const slot: ForegroundSlot = { requestPause };
    reg.foreground.set(toolCallId, slot);

    const job = createRunningJob({
        id,
        command,
        pid: spawned.pid,
        identity: spawned.identity,
        logPath,
        toolCallId,
        isBackgrounded: false,
    });
    // Foreground jobs are tracked for the sidebar / Ctrl+Shift+B but not counted
    // as "started" until they actually move to the background (see below).
    reg.jobs.set(id, job);
    markStarted(reg);
    ensureCompletionPromise(job);
    reg.onChange?.();
    const onTurnAbort = () => {
        if (handedToBackground) return;
        cancelled = true;
        void terminateJob(job);
    };
    if (signal) {
        if (signal.aborted) onTurnAbort();
        else signal.addEventListener("abort", onTurnAbort, { once: true });
    }

    // Promote the running command to a tracked background job (cooperative
    // steering / Ctrl+Shift+B / auto-bg timeout). Idempotent.
    const promoteToBackground = () => {
        if (handedToBackground) return;
        if (!isActive()) throw new Error("Session ended before command promotion.");
        handedToBackground = true;
        spawned.release();
        // Clear the foreground slot now (not only in `finally`) so a backgrounded
        // command can't strand a stale slot when cooperative steering tears down
        // the turn right after requesting the pause.
        reg.foreground.delete(toolCallId);
        job.isBackgrounded = true;
        startBackgroundJob({ reg, pi, ctx, job, exit: spawned.exit });
    };

    // Timeout timer.
    const timeoutTimer = setTimeout(() => {
        if (!isActive() || !reg.foreground.has(toolCallId)) return;
        requestPause("timeout");
    }, timeoutMs);
    (timeoutTimer as NodeJS.Timeout).unref();

    let progressPoller: { stop: () => void } | undefined;
    let hintShown = false;

    // Foreground output needs the same disk budget as background output.
    let outputLimitExceeded = false;
    const outputGuard = setInterval(() => {
        try {
            if (statSync(logPath).size > MAX_LOG_BYTES) {
                outputLimitExceeded = true;
                killProcessTree(spawned.identity, "SIGKILL");
            }
        } catch { /* spawn/teardown may remove the file */ }
    }, 200);
    outputGuard.unref();

    const cleanup = () => {
        clearInterval(outputGuard);
        progressPoller?.stop();
        clearTimeout(timeoutTimer);
        if (signal) signal.removeEventListener("abort", onTurnAbort);
    };

    // Foreground completion (quick or normal): read output, surface errors.
    // Registry teardown happens in `finally` so no exit path can strand the job.
    const finishForeground = (
        exit: SpawnExit
    ): AgentToolResult<BashToolDetails | undefined> => {
        // The foreground tool result is the single delivery of this outcome.
        job.notified = true;
        completeJob({ job, code: exit.code, signal: exit.signal, reg, pi, ctx, shouldNotify: false, generation });
        const output = readLogTail(job, OUTPUT_PREVIEW_CHARS);
        if (outputLimitExceeded) throw new Error(`Command exceeded output limit (${MAX_LOG_BYTES} bytes).`);
        // Only a genuine turn cancellation suppresses signal failure. External
        // signal death (including OOM/SIGKILL) must remain a failed tool result.
        if (exit.signal !== null && !signal?.aborted) {
            throw new Error(`Command terminated by ${exit.signal}${output ? `\n${output}` : ""}`);
        }
        if (exit.signal === null && exit.code !== 0) {
            throw new Error(output || `Command exited with code ${exit.code ?? 1}`);
        }
        return { content: [textBlock(output || "(no output)")], details: { fullOutputPath: logPath } };
    };

    // The quick window delays only presentation, never pause handling.
    const quickTimer = setTimeout(() => {
        if (!isActive() || pauseRequested || cancelled) return;
        progressPoller = streamLog(logPath, onUpdate);
        showBackgroundHint(ctx);
        hintShown = true;
    }, QUICK_COMPLETION_MS);
    quickTimer.unref();

    try {
        // Race: completion vs backgrounding, including the very first instant.
        const race = await Promise.race<
            | { kind: "completed"; exit: SpawnExit }
            | { kind: "backgrounded"; reason: "manual" | "timeout" }
        >([
            spawned.exit.then((exit) => ({ kind: "completed" as const, exit })),
            pausePromise.then((reason) => ({ kind: "backgrounded" as const, reason })),
        ]);

        if (race.kind === "backgrounded") {
            if (cancelled) {
                await terminateJob(job);
                return finishForeground(await spawned.exit);
            }
            promoteToBackground();
            // Claude Code's exact tool-result strings: a distinct line for a
            // manual background, one generic line for the timeout path.
            const text =
                race.reason === "manual"
                    ? `Command was manually backgrounded by user with ID: ${id}. Output is being written to: ${logPath}`
                    : `Command running in background with ID: ${id}. Output is being written to: ${logPath}`;
            return { content: [textBlock(text)], details: undefined };
        }

        // Normal completion.
        return finishForeground(race.exit);
    } finally {
        // Single teardown for every exit path (return, throw, background hand-off).
        clearTimeout(quickTimer);
        cleanup();
        spawned.release();
        if (hintShown) clearBackgroundHint(ctx, isActive());
        reg.foreground.delete(toolCallId);
        if (!handedToBackground && !reg.retainResults) {
            reg.jobs.delete(id);
            try { unlinkSync(logPath); } catch { /* best-effort */ }
        } else if (!handedToBackground && !isTerminalStatus(job.status) && isActive()) {
            // An unexpected presentation/tool error must not orphan a process.
            startBackgroundJob({ reg, pi, ctx, job, exit: spawned.exit });
        }
    }
}

// --- Background backend --------------------------------------------------

function spawnBackground(args: {
    toolCallId: string;
    command: string;
    name?: string;
    cwd: string;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
}): AgentToolResult<BashToolDetails | undefined> {
    const id = newJobId("shell", args.reg);
    const logPath = logPathFor(id);

    const spawned = spawnWithFileOutput({
        command: args.command,
        cwd: args.cwd,
        logPath,
    });

    const job = createRunningJob({
        id,
        name: args.name,
        command: args.command,
        pid: spawned.pid,
        identity: spawned.identity,
        logPath,
        toolCallId: args.toolCallId,
    });
    add(args.reg, job);
    startBackgroundJob({ reg: args.reg, pi: args.pi, ctx: args.ctx, job, exit: spawned.exit });

    return {
        content: [
            textBlock(
                `Command running in background with ID: ${id}. Output is being written to: ${logPath}`
            ),
        ],
        details: undefined,
    };
}
