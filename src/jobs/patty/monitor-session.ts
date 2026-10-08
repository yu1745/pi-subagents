// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
/**
 * The monitor session lifecycle — the tricky part of the monitor tool, lifted
 * out of the tool action so its invariants are unit-testable through a fake
 * MonitorSource (no real spawning, no real sockets).
 *
 * Responsibilities: stream each batch of new log lines as a notification,
 * rate-limit a firehose, emit exactly one terminal event (on natural exit,
 * kill, timeout, or firehose), and tear the source down. The tool just
 * validates, builds a source, and hands it here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startBackgroundJob, terminateJob } from "./lifecycle.js";
import { followLines, type MonitorFollower } from "./monitor-follow.js";
import type { MonitorSource } from "./monitor-source.js";
import { completionSummary, sendTaskNotification, type TerminalStatus } from "./notify.js";
import { forget, renderSidebar } from "./registry.js";
import type { BackgroundRegistry } from "./state.js";
import {
    DELIVER_FOLLOWUP,
    EVENT,
    type Job,
    MONITOR_MAX_LINES_PER_WINDOW,
    MONITOR_RATE_WINDOW_MS,
    type UiContext,
} from "./types.js";

/**
 * Wire a monitor's source to its event stream, terminal event, deadline, and
 * teardown. The job must already be in the registry. Returns nothing — the
 * session runs until the source ends, the deadline fires, or it is killed.
 */
export function startMonitorSession(args: {
    pi: ExtensionAPI;
    reg: BackgroundRegistry;
    ctx: UiContext;
    job: Job;
    source: MonitorSource;
    description: string;
    persistent: boolean;
    timeoutMs: number;
}): void {
    const { pi, reg, ctx, job, source, description, persistent, timeoutMs } = args;
    const { id, logPath } = job;
    const generation = reg.generation;
    const isActive = () => !reg.disposed && reg.generation === generation;

    let terminalEmitted = false;
    let finishing = false;
    let requestedStop: { status: TerminalStatus; summary: string } | undefined;
    let windowStart = Date.now();
    let windowLines = 0;

    // Stream events stay live but passive (delivered as a follow-up, no wake) —
    // they carry data the agent is actively watching and surface on the agent's
    // next natural turn without spawning an unsolicited one. The terminal
    // notice (stream ended / stopped / failed) is its own <task-notification>
    // (see finishMonitor), sent the moment the source ends.
    const emitEvent = (lines: string[]): void => {
        if (!isActive() || lines.length === 0) return;
        try { pi.sendMessage(
            {
                customType: EVENT.monitorEvent,
                content: `◉ ${description}\n${lines.join("\n")}`,
                display: true,
                details: { jobId: id, description, logPath, terminal: false },
            },
            DELIVER_FOLLOWUP
        ); } catch (error) {
            // Never let delivery failures escape the follower's timer. Stop
            // rather than retrying an unbounded stream against a broken host.
            console.error(`[monitor ${id}] stream delivery failed`, error);
            if (!finishing) stopMonitor("failed", `Monitor "${description}" stopped (stream delivery failed)`);
        }
    };

    const follower: MonitorFollower = followLines(logPath, (lines) => {
        if (terminalEmitted || !isActive()) return;

        // Sliding-window firehose check.
        const now = Date.now();
        if (now - windowStart > MONITOR_RATE_WINDOW_MS) {
            windowStart = now;
            windowLines = 0;
        }
        windowLines += lines.length;

        // Enforce the guard before allocating/enqueueing a notification.
        if (!finishing && windowLines > MONITOR_MAX_LINES_PER_WINDOW) {
            stopMonitor(
                "killed",
                `Monitor "${description}" stopped (too many events (>${MONITOR_MAX_LINES_PER_WINDOW}/${MONITOR_RATE_WINDOW_MS / 1000}s) — restart with a tighter filter)`
            );
            return;
        }
        // Bound each queued message independently of line count. There is no
        // local retry queue; a delivery failure terminates the source.
        let batch: string[] = [];
        let chars = 0;
        for (const line of lines) {
            if (chars + line.length + 1 > 16 * 1024 && batch.length) {
                emitEvent(batch);
                if (terminalEmitted) return;
                batch = []; chars = 0;
            }
            batch.push(line); chars += line.length + 1;
        }
        emitEvent(batch);
    }, undefined, (error) => {
        console.error(`[monitor ${id}] capture failed`, error);
        if (!finishing) stopMonitor("failed", `Monitor "${description}" stopped (capture failed)`);
    });

    // job.stop: transient teardown invoked by the kill path. Tears down the
    // source (closes the ws socket) — the follower is stopped *and flushed* by
    // finishMonitor on the exit path (kill → process/socket close → exit →
    // onExit), so a user-initiated kill stays lossless.
    job.stop = source.stop;

    /**
     * Emit exactly one terminal <task-notification> for the monitor. Sent
     * before the job is marked terminal (onExit runs ahead of completeJob), so
     * the status/summary are explicit and eviction is left to completeJob.
     */
    const finishMonitor = (status: TerminalStatus, summary: string): void => {
        if (terminalEmitted) return;
        if (!isActive()) {
            terminalEmitted = true;
            follower.stop(false);
            return;
        }
        // Flush remaining lines first (while terminalEmitted is still false so
        // the follower callback emits them), then the terminal notification.
        finishing = true;
        follower.stop(status !== "failed" && windowLines <= MONITOR_MAX_LINES_PER_WINDOW);
        terminalEmitted = true;
        try { sendTaskNotification({ reg, pi, job, status, summary, evict: false }); }
        catch (error) { console.error(`[monitor ${id}] terminal delivery failed`, error); }
        // onExit runs before completeJob marks terminal. Evict only afterward,
        // and only if delivery succeeded; failed sends retain retry ownership.
        queueMicrotask(() => {
            if (job.notified && job.status !== "running") forget(reg, job);
        });
    };

    /** Forced stop (timeout / firehose). Save the summary and terminate the
     * source with escalation; onExit owns the eventual terminal notification. */
    function stopMonitor(status: TerminalStatus, summary: string): void {
        if (requestedStop) return;
        requestedStop = { status, summary };
        // Stop polling now, but report terminal status only after source exit.
        follower.stop(false);
        void terminateJob(job);
        if (isActive()) renderSidebar(reg, ctx);
    }

    // Wire exit → terminal event. Successful custom terminal delivery latches
    // notified; completeJob retries when that send failed. Monitor captures have
    // their own rolling disk bounds, independent of persistence/deadlines.
    const jobAc = startBackgroundJob({
        reg,
        pi,
        ctx,
        job,
        exit: source.exit,
        shouldNotify: true,
        disablePromptStall: true,
        disableOversizeKill: persistent,
        onExit: ({ code, signal }) => {
            // A signal death (external kill) is the "stopped" summary, never
            // "stream ended". Natural exits reuse completionSummary — the job
            // carries name: description, so the summary names the watch.
            if (requestedStop) {
                finishMonitor(requestedStop.status, requestedStop.summary);
            } else if (job.status === "killed" || signal !== null) {
                finishMonitor("killed", completionSummary(job, "killed"));
            } else if (code === 0) {
                finishMonitor("completed", completionSummary(job, "completed"));
            } else {
                // completeJob marks terminal after onExit — set the exit code
                // now so completionSummary can name it.
                job.exitCode = code ?? undefined;
                finishMonitor("failed", completionSummary(job, "failed"));
            }
        },
    });

    jobAc.signal.addEventListener("abort", () => follower.stop(false), { once: true });

    // Deadline (skipped for persistent watches). Cleared when the job aborts
    // (natural exit or kill) so a short monitor doesn't keep a live timer +
    // closure alive for the whole timeout window.
    if (!persistent) {
        const deadline = setTimeout(() => {
            stopMonitor(
                "killed",
                `Monitor "${description}" stopped (timeout after ${Math.round(timeoutMs / 1000)}s)`
            );
        }, timeoutMs);
        (deadline as NodeJS.Timeout).unref();
        jobAc.signal.addEventListener("abort", () => clearTimeout(deadline), { once: true });
    }
}
