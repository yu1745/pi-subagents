// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
/**
 * Lifecycle helpers for background jobs.
 *
 * Collects the cross-cutting concerns — completion notification, timeout
 * scheduling, terminal-state marking, and cleanup (kill) — in one place.
 * Monitoring (progress polling, stall detection) lives in monitoring.ts.
 */

import { statSync as fsStatSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { watchStalls } from "./monitoring.js";
import { markNotified, sendTaskNotification } from "./notify.js";
import { atConcurrencyLimit, deleteJobLogs, forget, renderSidebar } from "./registry.js";
import { killProcessTree, processExists, type SpawnExit } from "./spawn.js";
import type { BackgroundRegistry } from "./state.js";
import {
    isTerminalStatus,
    type Job,
    type JobStatus,
    MAX_CONCURRENT_JOBS,
    type UiContext,
} from "./types.js";

// --- Background-job orchestration ----------------------------------------

/** Throw a standard error when no concurrency slot is free. */
export function assertJobSlot(reg: BackgroundRegistry): void {
    if (atConcurrencyLimit(reg)) {
        throw new Error(
            `Max concurrent background jobs (${MAX_CONCURRENT_JOBS}) reached. ` +
                `Kill or wait for existing jobs before starting new ones.`
        );
    }
}

/**
 * Wire a background job's lifecycle: completion promise, abort controller,
 * stall watcher, and the exit→completeJob hand-off. The job must already be in
 * the registry. Returns the job's AbortController so callers can attach extra
 * monitors (e.g. agent_bg's progress poller).
 */
export function startBackgroundJob(args: {
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
    job: Job;
    exit: Promise<SpawnExit>;
    shouldNotify?: boolean;
    /** Suppress the interactive-prompt stall heuristic (monitors stream their
     *  own output, so a quiet tail is normal, not a stuck prompt). */
    disablePromptStall?: boolean;
    /** Suppress the ordinary-job oversize kill for independently bounded sources. */
    disableOversizeKill?: boolean;
    /** Session-bound completion work; fenced after disposal/replacement. */
    onExit?: (result: SpawnExit) => void;
    /** Resource-only teardown, always run even when the host context expires. */
    onCleanup?: (result: SpawnExit) => void;
}): AbortController {
    const generation = args.reg.generation;
    ensureCompletionPromise(args.job);
    const jobAc = createJobAbort(args.reg, args.job.id);
    args.reg.watchdog?.track(args.job, args.ctx, jobAc.signal);
    const cancelStall = watchStalls({
        jobId: args.job.id,
        command: args.job.command,
        name: args.job.name,
        logPath: args.job.logPath,
        pi: args.pi,
        disablePromptStall: args.disablePromptStall,
        disableOversizeKill: args.disableOversizeKill,
        isActive: () => !args.reg.disposed && args.reg.generation === generation,
        // Preserve the authoritative completion notice even when the warning
        // fails or cleanup aborts its retry timer.
        onOversize: () => { void terminateJob(args.job); },
    });
    jobAc.signal.addEventListener("abort", cancelStall, { once: true });
    void args.exit.then((result) => {
        try {
            if (!args.reg.disposed && args.reg.generation === generation) args.onExit?.(result);
        } catch (error) {
            console.error("[bg-tasks] exit callback failed:", error);
        } finally {
            try { args.onCleanup?.(result); }
            catch (error) { console.error("[bg-tasks] resource cleanup failed:", error); }
            jobAc.abort();
        }
        completeJob({
            job: args.job,
            code: result.code,
            signal: result.signal,
            reg: args.reg,
            pi: args.pi,
            ctx: args.ctx,
            shouldNotify: args.shouldNotify,
            generation,
        });
    });
    renderSidebar(args.reg, args.ctx);
    return jobAc;
}

// --- Terminal-state marking ----------------------------------------------

/**
 * Standard completion flow after a job exits — abortJob → markTerminal →
 * notify → renderSidebar. Shared by every tool's exit callback (bash,
 * bash_bg, agent_bg, monitor) as the canonical termination protocol.
 *
 * The notification is Claude Code's per-job <task-notification>, sent the
 * moment the job exits (see notify.ts). A successful send evicts the job
 * from the live registry (terminal + notified). Jobs whose outcome is
 * already known (killed silently, or read via jobs output/attach) skip the
 * notification and linger until the lazy sweep in `jobs list`. Monitors own
 * their terminal notification (monitor-session, shouldNotify: false) and are
 * evicted here once it has fired. A `shouldNotify: false` job (bash_bg
 * `notify: false`) is latched notified WITHOUT sending — "don't notify" IS
 * notified — so it evicts too and never lingers as a permanent entry.
 */
export function completeJob(args: {
    job: Job;
    code: number | null | undefined;
    /** The signal that killed the job, when it died by signal. */
    signal?: NodeJS.Signals | null;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
    shouldNotify?: boolean;
    generation?: number;
}): void {
    // Always clean resources, including an exit arriving after prior marking.
    if (args.reg.jobs.get(args.job.id) === args.job) abortJob(args.reg, args.job.id);
    if (isTerminalStatus(args.job.status)) return;
    // The caller passes the authoritative Job (the object held in the registry),
    // so no lookup is needed.
    const finished = args.job;
    markTerminal(finished, statusFromExit(args.code, args.signal), args.code ?? undefined);
    // In retained mode accounting follows the outcome, not whether a notice
    // or attach consumed it; cleanup may delete the metadata immediately.
    if (args.reg.retainResults) forget(args.reg, finished);
    args.reg.onChange?.();
    if (args.reg.disposed || (args.generation !== undefined && args.generation !== args.reg.generation)) {
        markNotified(finished);
        if (!args.reg.retainResults) {
            if (args.reg.jobs.get(finished.id) === finished) args.reg.jobs.delete(finished.id);
            deleteJobLogs(finished);
        }
        return;
    }
    if (args.shouldNotify !== false) {
        sendTaskNotification({ reg: args.reg, pi: args.pi, job: finished });
        // Monitors may already have sent their richer summary in onExit.
        if (finished.kind === "monitor" && finished.notified) forget(args.reg, finished);
    } else {
        markNotified(finished);
        forget(args.reg, finished);
    }
    renderSidebar(args.reg, args.ctx);
}

/**
 * Mark a job terminal and resolve its donePromise. Idempotent — already-
 * terminal jobs are ignored.
 */
export function markTerminal(
    job: Job,
    status: JobStatus,
    exitCode?: number
): void {
    if (isTerminalStatus(job.status)) {
        return;
    }
    job.status = status;
    job.endTime = Date.now();
    job.exitCode = exitCode;
    if (job.resolveDone) {
        job.resolveDone();
        delete job.resolveDone;
    }
    delete job.donePromise;
}

/** Map an exit result to a JobStatus: a signal death (external kill, OOM) is
 *  "killed" (CC marks these killed), exit code 0 is "completed", anything else
 *  is "failed". */
export function statusFromExit(
    code: number | null | undefined,
    signal?: NodeJS.Signals | null
): JobStatus {
    if (signal) return "killed";
    return code === 0 ? "completed" : "failed";
}

/**
 * Create a job's donePromise. This is the entry point that attach/log-wait
 * flows await for a result. Idempotent — does not recreate an existing promise.
 */
export function ensureCompletionPromise(job: Job): void {
    if (isTerminalStatus(job.status)) { job.donePromise = Promise.resolve(); return; }
    if (job.donePromise) return;
    let resolveDone: (() => void) | undefined;
    job.donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    job.resolveDone = resolveDone;
}

/**
 * Mark a job "killed" and latch the notified flag, so the exit callback does
 * not emit a spurious completion notification on any termination path.
 * `markTerminal` flips status to "killed" first; `markNotified` then records
 * that the outcome needs no <task-notification> (Claude Code parity — a
 * deliberate kill is intentional cleanup the agent already knows about).
 */
export function markKilledSilently(job: Job): void {
    markTerminal(job, "killed");
    markNotified(job);
}

/* Kill quietly and abort registered monitors/timers. Suppress notifications
 * before signalling, but keep status running until death is observed. Returns
 * false if bounded escalation cannot confirm death; callers must not claim
 * successful termination in that case. */
const silentTerminations = new WeakMap<Job, Promise<boolean>>();
export function terminateJobSilently(reg: BackgroundRegistry, job: Job): Promise<boolean> {
    const existing = silentTerminations.get(job);
    if (existing) return existing;
    const wasNotified = job.notified;
    markNotified(job);
    abortJob(reg, job.id);
    const result = terminateJob(job).then((stopped) => {
        if (stopped) {
            markKilledSilently(job);
            if (reg.retainResults) forget(reg, job);
            reg.onChange?.();
        }
        else if (!isTerminalStatus(job.status)) job.notified = wasNotified;
        return stopped;
    });
    silentTerminations.set(job, result);
    void result.then(() => silentTerminations.delete(job));
    return result;
}

// --- Per-job abort (cleanup) ---------------------------------------------

/** Create an AbortController for a job. Aborting it cancels all monitors. */
export function createJobAbort(
    reg: BackgroundRegistry,
    jobId: string
): AbortController {
    const existing = reg.jobAborts.get(jobId);
    if (existing) return existing;
    const ac = new AbortController();
    reg.jobAborts.set(jobId, ac);
    return ac;
}

/** Abort all monitors for a job and remove the controller. */
export function abortJob(reg: BackgroundRegistry, jobId: string): void {
    const ac = reg.jobAborts.get(jobId);
    if (ac) {
        ac.abort();
        reg.jobAborts.delete(jobId);
    }
}

/**
 * In-flight termination operations are shared across concurrent callers.
 * Process-group liveness also covers descendants after the direct child exits.
 */
const terminations = new WeakMap<Job, Promise<boolean>>();

/** Bounded TERM → KILL escalation. Keep the timer referenced until cleanup
 * finishes, even in print mode; never claim death solely from sending TERM. */
export function terminateJob(job: Job): Promise<boolean> {
    const existing = terminations.get(job);
    if (existing) return existing;
    const pid = job.pid;
    const target = job.identity; // A displayed PID is never signal authority.
    const alive = () => {
        if (job.identity) return processExists(job.identity);
        if (pid <= 0) return false;
        try {
            process.kill(-pid, 0);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
            return processExists(pid);
        }
    };
    // Register before stop(), since a source may synchronously resolve exit.
    const result = Promise.resolve().then(async () => {
        try { job.stop?.(); } catch (error) {
            console.error("[bg-tasks] source teardown failed:", error);
        }
        killProcessTree(target, "SIGTERM");
        for (let attempt = 0; attempt < 40; attempt++) {
            if (!alive()) return true;
            if (attempt === 20) killProcessTree(target, "SIGKILL");
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        const stopped = !alive();
        if (!stopped) console.error(`[bg-tasks] could not confirm termination of ${job.id} (pid ${pid})`);
        return stopped;
    });
    terminations.set(job, result);
    void result.then((stopped) => {
        // A failed attempt is not a permanent tombstone: an operator may retry
        // after the cause (e.g. permissions) changes.
        if (!stopped) terminations.delete(job);
    });
    return result;
}

// --- Foreground backgrounding --------------------------------------------

/** Richer context for Ctrl+Shift+B / `/bg`: the UI plus the turn-control surface
 *  (idle check and whether a user message is already queued). */
export type ControlContext = UiContext & {
    isIdle(): boolean;
    hasPendingMessages(): boolean;
};

/**
 * Flip every running foreground command into the background — Claude Code's
 * Ctrl+B `backgroundAll`. Pure mechanic — no toast, no agent message. Returns
 * false when there is nothing in the foreground to pause. Callers compose the
 * messaging.
 */
export function pauseAllForeground(reg: BackgroundRegistry, ctx: UiContext): boolean {
    if (reg.foreground.size === 0) return false;
    for (const slot of reg.foreground.values()) {
        slot.requestPause("manual");
    }
    reg.foreground.clear();
    renderSidebar(reg, ctx);
    return true;
}

/** Move the current foreground command(s) to the background. The tool result
 *  already tells the model what happened (CC's exact `Command was manually
 *  backgrounded by user with ID: ...` string), so no synthetic agent message
 *  is sent — only the UI toast. */
export function backgroundActiveForeground(
    reg: BackgroundRegistry,
    ctx: UiContext
): boolean {
    if (!pauseAllForeground(reg, ctx)) return false;
    ctx.ui.notify("▶ Backgrounded — continuing.", "info");
    return true;
}

/** Outcome of a Ctrl+Shift+B / `/bg` control-handover. */
export type ControlOutcome = "backgrounded" | "queued" | "nothing";

/**
 * Claude Code's Ctrl+B, faithfully (on Ctrl+Shift+B here, since pi owns
 * Ctrl+B): background ALL running foreground commands (CC's `backgroundAll`).
 *
 * It deliberately does NOT call ctx.abort(): in pi, aborting restores any queued
 * message to the editor (unsent), renders a scary "Operation aborted", AND kills
 * the running process — exactly the data-loss we must avoid. Instead, like
 * Claude Code, backgrounding makes the bash tool return; the turn ends and any
 * queued message drains at the natural turn boundary.
 */
export function takeControl(
    reg: BackgroundRegistry,
    ctx: ControlContext
): ControlOutcome {
    if (pauseAllForeground(reg, ctx)) {
        ctx.ui.notify("▶ Backgrounded — continuing.", "info");
        return "backgrounded";
    }

    // Nothing in the foreground to background. If a message is queued behind the
    // current turn, set expectations rather than abort (abort would lose it).
    if (!ctx.isIdle() && ctx.hasPendingMessages()) {
        ctx.ui.notify("Message queued — it'll send when the current step finishes.", "info");
        return "queued";
    }

    ctx.ui.notify("No running process to background.", "warning");
    return "nothing";
}

// --- Helpers -------------------------------------------------------------

/** Verify the cwd actually exists. Throws a clear error if not. */
export function requireExistingCwd(cwd: string): void {
    try {
        fsStatSync(cwd);
    } catch {
        throw new Error(`Working directory does not exist: ${cwd}`);
    }
}

/** True for whitespace-only commands. bash silently passes empty commands, so reject them explicitly. */
export function isBlankCommand(command: string): boolean {
    return command.trim().length === 0;
}

// --- Non-interactive mode detection --------------------------------------

/** Detect whether pi is running non-interactively (print / non-TTY). */
export function detectNonInteractive(
    argv: readonly string[],
    stdinIsTTY: boolean
): boolean {
    if (!stdinIsTTY) return true;
    return argv.includes("-p") || argv.includes("--print");
}
