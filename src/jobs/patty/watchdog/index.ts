// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
import { open, stat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describeJob } from "../format.js";
import type { BackgroundRegistry } from "../state.js";
import {
    DELIVER_STEER,
    EVENT,
    type Job,
    type UiContext,
} from "../types.js";
import { discoverJevService, type JevServiceV1 } from "./jev-service.js";
import { type ProcessGroupSnapshot, sampleProcessGroup } from "./proc-sampler.js";
import { boundJson, createWatchdogTrace, summarizeTail, type WatchdogTrace } from "./trace.js";

export const WATCHDOG_POLL_MS = 15_000;
export const WATCHDOG_MIN_AGE_MS = 30_000;
export const WATCHDOG_QUIET_MS = 30_000;
export const WATCHDOG_REPEAT_MS = 60_000;
export const WATCHDOG_RECHECK_MS = 30_000;
export const WATCHDOG_ALERT_COOLDOWN_MS = 15 * 60_000;
export const WATCHDOG_MAX_LOG_BYTES = 8_000;
export const WATCHDOG_MAX_REFERENCED_FILES = 3;
export const WATCHDOG_MAX_REFERENCED_FILE_BYTES = 4_000;
export const WATCHDOG_BLOCK_THRESHOLD = 0.7;
export const WATCHDOG_DIRECT_BLOCK_THRESHOLD = 0.85;
export const WATCHDOG_SUPPRESSION_THRESHOLD = 0.5;
export const WATCHDOG_REQUIRED_CONSECUTIVE = 2;
export const WATCHDOG_JEV_TIMEOUT_MS = 10_000;

export interface WatchdogEvidence {
    missedTerminalState: number;
    unavailableInteractiveInput: number;
    deadRequiredDependency: number;
    mistakenNonproductiveScope: number;
    repeatingNonprogress: number;
}

export interface WatchdogVerdict {
    /** Maximum of the five independently judged blocking-evidence signals. */
    stuck: number;
    /** Alias of stuck: alert policy is deterministic code, not another broad model question. */
    shouldAlert: number;
    credibleProgress: number;
    intentionallyPersistent: number;
    validFiniteWait: number;
    evidence: WatchdogEvidence;
    likelyCause: string;
    model: string;
}

interface ReferencedFileObservation {
    path: string;
    size: number;
    tail: string;
    sizeDelta: number | null;
    quietSeconds: number;
}

interface TrackedJob {
    job: Job;
    ctx: UiContext;
    cancelled: boolean;
    timer?: NodeJS.Timeout;
    lastLogSize: number;
    lastLogGrowthAt: number;
    repeatSince?: number;
    lastFingerprint?: string;
    referencedFileSizes: Map<string, number>;
    referencedFileGrowthAt: Map<string, number>;
    previousProcess?: ProcessGroupSnapshot;
    lastCheckedAt?: number;
    checking: boolean;
    consecutiveHigh: number;
    /** Count of Jev verdicts produced for this job, for the trace's stop record. */
    verdictCount: number;
    lastAlertAt?: number;
    lastVerdict?: WatchdogVerdict;
}

export interface JobWatchdog {
    track(job: Job, ctx: UiContext, signal: AbortSignal): void;
    inspectNow(jobId: string, ctx: UiContext): Promise<WatchdogVerdict | undefined>;
    status(): Array<{ jobId: string; ageSeconds: number; verdict?: WatchdogVerdict }>;
    setEnabled(value: boolean): void;
    isEnabled(): boolean;
    /** Bounded JSONL trace of sampling, verdicts, and alerts. Undefined when tracing is disabled. */
    readonly trace?: WatchdogTrace;
    dispose(): void;
}

async function readLogTail(path: string, maxBytes = WATCHDOG_MAX_LOG_BYTES): Promise<{ size: number; tail: string }> {
    const info = await stat(path);
    const length = Math.min(info.size, maxBytes);
    if (length <= 0) return { size: info.size, tail: "" };
    const handle = await open(path, "r");
    try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, info.size - length));
        return { size: info.size, tail: buffer.toString("utf8", 0, bytesRead) };
    } finally {
        await handle.close();
    }
}

/** Find bounded text-like files explicitly named by the command. This is
 * intentionally narrow: only absolute .log/.out/.txt paths are observed, so
 * the watchdog can see a polled producer log without crawling arbitrary paths. */
export function referencedLogPaths(command: string): string[] {
    const paths: string[] = [];
    const seen = new Set<string>();
    const pattern = /(?<![.\w])\/(?:[^\s'"`;|&()<>])+\.(?:log|out|txt)\b/giu;
    for (const match of command.matchAll(pattern)) {
        const path = match[0];
        if (!seen.has(path)) {
            seen.add(path);
            paths.push(path);
        }
        if (paths.length >= WATCHDOG_MAX_REFERENCED_FILES) break;
    }
    return paths;
}

async function readReferencedLogs(command: string, ownLogPath: string): Promise<Array<{ path: string; size: number; tail: string }>> {
    const observations = await Promise.all(referencedLogPaths(command)
        .filter((path) => path !== ownLogPath)
        .map(async (path) => {
            try {
                const value = await readLogTail(path, WATCHDOG_MAX_REFERENCED_FILE_BYTES);
                return { path, ...value };
            } catch {
                return undefined;
            }
        }));
    return observations.filter((value): value is { path: string; size: number; tail: string } => value !== undefined);
}

function normalizedLines(text: string): string[] {
    return text.split(/\r?\n/)
        .slice(-30)
        .map((line) => line
            .replace(/\b\d{4}-\d{2}-\d{2}T[^\s]+/g, "<timestamp>")
            .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>")
            .replace(/\b\d+\b/g, "<n>")
            .trim())
        .filter(Boolean);
}

function outputFingerprint(text: string): { fingerprint: string; repetitive: boolean } {
    const lines = normalizedLines(text);
    return {
        fingerprint: lines.join("\n"),
        repetitive: lines.length >= 6 && new Set(lines).size <= Math.max(2, Math.floor(lines.length / 5)),
    };
}

function probability(answer: { noul?: number } | undefined, name: string): number {
    if (typeof answer?.noul !== "number" || answer.noul < 0 || answer.noul > 1) {
        throw new Error(`Jev returned invalid ${name} probability`);
    }
    return answer.noul;
}

function processObservation(previous: ProcessGroupSnapshot | undefined, current: ProcessGroupSnapshot) {
    const elapsedSeconds = previous ? Math.max(0.001, (current.sampledAt - previous.sampledAt) / 1_000) : 0;
    const cpuTicksDelta = previous ? Math.max(0, current.totalCpuTicks - previous.totalCpuTicks) : 0;
    const ticksPerSecond = current.clockTicksPerSecond;
    const cpuCoreUtilization = ticksPerSecond && elapsedSeconds > 0
        ? cpuTicksDelta / ticksPerSecond / elapsedSeconds
        : undefined;
    return {
        supported: current.supported,
        root_pid: current.rootPid,
        leader_alive: current.leaderAlive,
        process_count: current.processCount,
        process_set_changed: previous ? previous.pids.join(",") !== current.pids.join(",") : null,
        states: current.states,
        wait_channels: current.waitChannels,
        total_rss_kb: current.totalRssKb,
        cumulative_cpu_ticks: current.totalCpuTicks,
        sample_interval_seconds: elapsedSeconds,
        cpu_ticks_delta: cpuTicksDelta,
        ...(cpuCoreUtilization === undefined ? {} : { cpu_core_utilization: Number(cpuCoreUtilization.toFixed(4)) }),
        processes: current.processes.slice(0, 24).map((process) => ({
            pid: process.pid,
            ppid: process.ppid,
            pgrp: process.pgrp,
            command: process.comm,
            state: process.state,
            cpu_ticks: process.cpuTicks,
            rss_kb: process.rssKb,
            ...(process.wchan ? { wait_channel: process.wchan } : {}),
        })),
    };
}

async function askJev(
    service: JevServiceV1,
    tracked: TrackedJob,
    log: { size: number; tail: string },
    process: ProcessGroupSnapshot,
    referencedFiles: ReferencedFileObservation[],
    now: number,
    trace: WatchdogTrace,
): Promise<WatchdogVerdict> {
    const job = tracked.job;
    const state = {
        task: {
            id: job.id,
            kind: job.kind ?? "shell",
            name: job.name ?? null,
            command: job.command,
            elapsed_seconds: Math.round((now - job.startTime) / 1_000),
            intentionally_persistent: job.persistent === true,
        },
        log_observation: {
            total_bytes: log.size,
            quiet_seconds: Math.round((now - tracked.lastLogGrowthAt) / 1_000),
            repetitive_seconds: tracked.repeatSince ? Math.round((now - tracked.repeatSince) / 1_000) : 0,
            recent_tail: log.tail || "(no output)",
        },
        process_observation: processObservation(tracked.previousProcess, process),
        referenced_file_observations: referencedFiles.map((file) => ({
            path: file.path,
            total_bytes: file.size,
            size_delta_since_last_sample: file.sizeDelta,
            quiet_seconds: file.quietSeconds,
            recent_tail: file.tail || "(empty)",
        })),
        decision_policy: {
            action: "Advisory inspection only; never terminate or mutate a job automatically.",
            risk_bias: "Avoid false alerts caused only by duration, quiet output, low CPU, or an ordinary bounded wait.",
        },
    };
    const noul = (question: string, yes: string, no: string) => ({
        type: "noul" as const,
        instructions: {
            question,
            rule: "Use only the supplied task, log, referenced-file, and process observations. Uncertainty means false.",
        },
        criteria: { true: { what: yes }, false: { what: no } },
    });
    const questions = {
        missed_terminal_state: noul(
            "Does `log_observation.recent_tail` or `referenced_file_observations` already show a terminal success or failure state that the polling predicate in `task.command` fails to recognize?",
            "Output explicitly reports termination, failure, crash, exit, or success while the command is still waiting for a different marker.",
            "No terminal state is visible, or the command's predicate recognizes it.",
        ),
        unavailable_interactive_input: noul(
            "Is `task` waiting for interactive input that cannot be supplied to this detached background process?",
            "Output requests input and process telemetry supports a stdin/read wait with no interactive channel.",
            "No input is requested, or an input channel is available.",
        ),
        dead_required_dependency: noul(
            "Does the evidence show that a producer, child, service, file, socket, or upstream dependency required by `task.command` has terminated or become unreachable?",
            "A required dependency is explicitly reported failed, exited, or unreachable while the task continues waiting for it.",
            "The dependency is alive or available, or its failure is not established.",
        ),
        mistaken_nonproductive_scope: noul(
            "Is `task.command` an unbounded or grossly over-broad filesystem traversal for its stated target, with prolonged telemetry showing no useful result?",
            "A root- or home-wide search is clearly disproportionate to locating the named target and has spent several minutes traversing without output.",
            "The scope is bounded or reasonable, useful matches are appearing, or a scope error is not established.",
        ),
        repeating_nonprogress: noul(
            "Does `log_observation` show the same failed state repeating long enough that `task` is not approaching completion?",
            "Repeated normalized output reports the same state for at least two minutes with no changed process or result.",
            "Output changes, repetition represents progress, or no sustained repetition is shown.",
        ),
        credible_useful_progress: noul(
            "Is `task` credibly progressing toward a useful terminating result without operator intervention?",
            "Recent log growth, meaningful CPU work, process evolution, transfer progress, or a bounded still-valid wait supports useful completion.",
            "Evidence specifically supports a broken completion path, rather than mere silence or low CPU.",
        ),
        expected_indefinite_service: noul(
            "Is `task` intentionally designed to stay alive indefinitely as a server, watcher, event monitor, or log follower?",
            "The declared command is a long-lived service or monitor whose continued running is success.",
            "The command is expected to terminate with a result; a finite sleep or bounded poll is not an indefinite service.",
        ),
        valid_finite_wait: noul(
            "Is `task` in an explicitly bounded finite wait whose deadline or attempt limit has not elapsed?",
            "The command states a finite sleep, deadline, or retry count and is still within it, with no contradictory terminal evidence.",
            "The wait is unbounded, expired, or contradicted by terminal or dependency-failure evidence.",
        ),
        likely_cause: {
            type: "choice" as const,
            instructions: {
                question: "Which explanation best matches `task`, `log_observation`, `referenced_file_observations`, and `process_observation`?",
                rule: "Choose insufficient_evidence unless one explanation has direct evidence.",
            },
            criteria: {
                legitimate_progress: "Useful work is credibly progressing.",
                intentional_persistent_task: "A server, watcher, or monitor is correctly remaining alive.",
                finite_requested_wait: "A bounded wait is still valid.",
                insufficient_evidence: "No specific block or healthy path is established.",
                stdin_or_interactive_wait: "Unavailable interactive input is required.",
                missed_terminal_state: "Output already reports a terminal state omitted from the wait predicate.",
                mistaken_scope: "A grossly over-broad traversal is operationally non-useful.",
                dead_dependency: "A required producer or dependency is explicitly gone.",
                buffering_or_pipeline_stall: "Buffering or an unclosed stream prevents completion.",
                repeating_nonprogress_loop: "The same state repeats without progress.",
                process_deadlock: "Wait states support a deadlock or circular wait.",
            },
        },
    };
    // Record exactly what the model was asked to judge, so a run can be audited
    // after the fact rather than reconstructed from memory.
    trace.record("jev_request", {
        jobId: job.id,
        questionNames: Object.keys(questions),
        state: boundJson(state),
    });
    const response = await service.evaluate({ state, questions }, { timeoutMs: WATCHDOG_JEV_TIMEOUT_MS });
    const evidence: WatchdogEvidence = {
        missedTerminalState: probability(response.answers.missed_terminal_state, "missed_terminal_state"),
        unavailableInteractiveInput: probability(response.answers.unavailable_interactive_input, "unavailable_interactive_input"),
        deadRequiredDependency: probability(response.answers.dead_required_dependency, "dead_required_dependency"),
        mistakenNonproductiveScope: probability(response.answers.mistaken_nonproductive_scope, "mistaken_nonproductive_scope"),
        repeatingNonprogress: probability(response.answers.repeating_nonprogress, "repeating_nonprogress"),
    };
    const stuck = Math.max(...Object.values(evidence));
    return {
        stuck,
        shouldAlert: stuck,
        credibleProgress: probability(response.answers.credible_useful_progress, "credible_useful_progress"),
        intentionallyPersistent: probability(response.answers.expected_indefinite_service, "expected_indefinite_service"),
        validFiniteWait: probability(response.answers.valid_finite_wait, "valid_finite_wait"),
        evidence,
        likelyCause: response.answers.likely_cause?.choice ?? "insufficient_evidence",
        model: response.model,
    };
}

export function isHigh(verdict: WatchdogVerdict): boolean {
    return verdict.stuck >= WATCHDOG_BLOCK_THRESHOLD &&
        verdict.credibleProgress <= WATCHDOG_SUPPRESSION_THRESHOLD &&
        verdict.intentionallyPersistent <= WATCHDOG_SUPPRESSION_THRESHOLD &&
        verdict.validFiniteWait <= WATCHDOG_SUPPRESSION_THRESHOLD;
}

/** Direct, externally verifiable failures do not benefit from waiting for the
 * same mostly deterministic model judgment twice. Scope and repetition remain
 * two-sample decisions because they depend more heavily on user intent. */
export function isDirectHigh(verdict: WatchdogVerdict): boolean {
    const directEvidence = Math.max(
        verdict.evidence.missedTerminalState,
        verdict.evidence.unavailableInteractiveInput,
        verdict.evidence.deadRequiredDependency,
    );
    return isHigh(verdict) && directEvidence >= WATCHDOG_DIRECT_BLOCK_THRESHOLD;
}

/** Administrative shape of a verdict for trace lines: scores only, no evidence text. */
function verdictTraceFields(verdict: WatchdogVerdict) {
    return {
        stuck: Number(verdict.stuck.toFixed(3)),
        credibleProgress: Number(verdict.credibleProgress.toFixed(3)),
        intentionallyPersistent: Number(verdict.intentionallyPersistent.toFixed(3)),
        validFiniteWait: Number(verdict.validFiniteWait.toFixed(3)),
        likelyCause: verdict.likelyCause,
        model: verdict.model,
        evidence: Object.fromEntries(
            Object.entries(verdict.evidence).map(([key, value]) => [key, Number(value.toFixed(3))]),
        ),
    };
}

export function createJobWatchdog(pi: ExtensionAPI, reg: BackgroundRegistry): JobWatchdog {
    const tracked = new Map<string, TrackedJob>();
    const trace = createWatchdogTrace();
    let enabled = true;
    let disposed = false;
    let missingServiceNotified = false;

    if (trace.path) trace.record("watchdog_start", { tracePath: trace.path, enabled });

    const schedule = (entry: TrackedJob) => {
        if (entry.cancelled || disposed || !enabled) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            entry.timer = undefined;
            void inspect(entry, false);
        }, WATCHDOG_POLL_MS);
        entry.timer.unref();
    };

    const alert = (entry: TrackedJob, verdict: WatchdogVerdict, tail: string) => {
        const job = entry.job;
        const summary = `Background job "${describeJob(job.name, job.command)}" may be semantically blocked (${verdict.likelyCause})`;
        const evidence = tail.trim().split(/\r?\n/).slice(-5).join("\n").slice(0, 1_500) || "(no recent output)";
        const content = [
            `⚠️ ${summary}`,
            `task=${job.id} pid=${job.pid} block=${verdict.stuck.toFixed(2)} progress=${verdict.credibleProgress.toFixed(2)} persistent=${verdict.intentionallyPersistent.toFixed(2)} finite-wait=${verdict.validFiniteWait.toFixed(2)} model=${verdict.model}`,
            `Recent output:\n${evidence}`,
            "Advisory only: inspect the command, process tree, and waiting assumption. Do not terminate it solely because of this notice.",
        ].join("\n");
        entry.ctx.ui.notify(summary, "warning");
        trace.record("alert", {
            jobId: job.id,
            pid: job.pid,
            command: job.command,
            logPath: job.logPath,
            summary,
            ...verdictTraceFields(verdict),
            evidenceTail: summarizeTail(evidence, 800),
        });
        pi.sendMessage({
            customType: EVENT.semanticStall,
            content,
            display: true,
            details: {
                jobId: job.id,
                pid: job.pid,
                logPath: job.logPath,
                command: job.command,
                verdict,
                summary,
            },
        }, DELIVER_STEER);
    };

    const inspect = async (entry: TrackedJob, force: boolean): Promise<WatchdogVerdict | undefined> => {
        if (entry.cancelled || disposed || (!enabled && !force) || entry.checking || entry.job.status !== "running" || reg.jobs.get(entry.job.id) !== entry.job) return;
        if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = undefined;
        }
        entry.checking = true;
        try {
            const now = Date.now();
            const [log, process, referencedFiles] = await Promise.all([
                readLogTail(entry.job.logPath),
                sampleProcessGroup(entry.job.pid),
                readReferencedLogs(entry.job.command, entry.job.logPath),
            ]);
            if (log.size !== entry.lastLogSize) {
                const output = outputFingerprint(log.tail);
                if (output.repetitive && output.fingerprint === entry.lastFingerprint) entry.repeatSince ??= now;
                else entry.repeatSince = undefined;
                entry.lastFingerprint = output.fingerprint;
                entry.lastLogSize = log.size;
                entry.lastLogGrowthAt = now;
            }

            const referencedObservations = referencedFiles.map((file): ReferencedFileObservation => {
                const previousSize = entry.referencedFileSizes.get(file.path);
                if (previousSize === undefined || previousSize !== file.size) {
                    entry.referencedFileGrowthAt.set(file.path, now);
                }
                entry.referencedFileSizes.set(file.path, file.size);
                const growthAt = entry.referencedFileGrowthAt.get(file.path) ?? now;
                return {
                    ...file,
                    sizeDelta: previousSize === undefined ? null : file.size - previousSize,
                    quietSeconds: Math.round((now - growthAt) / 1_000),
                };
            });

            const oldEnough = now - entry.job.startTime >= WATCHDOG_MIN_AGE_MS;
            const quiet = now - entry.lastLogGrowthAt >= WATCHDOG_QUIET_MS;
            const repeating = entry.repeatSince !== undefined && now - entry.repeatSince >= WATCHDOG_REPEAT_MS;
            const due = entry.lastCheckedAt === undefined || now - entry.lastCheckedAt >= WATCHDOG_RECHECK_MS;
            entry.previousProcess ??= process;
            const skipReason = !force
                ? (entry.job.persistent === true ? "persistent_job"
                    : !oldEnough ? "job_too_young"
                        : (!quiet && !repeating) ? "log_still_growing"
                            : !due ? "recheck_interval"
                                : undefined)
                : undefined;
            trace.record("poll", {
                jobId: entry.job.id,
                pid: entry.job.pid,
                force,
                ageSeconds: Math.round((now - entry.job.startTime) / 1_000),
                logBytes: log.size,
                logQuietSeconds: Math.round((now - entry.lastLogGrowthAt) / 1_000),
                repetitiveSeconds: entry.repeatSince ? Math.round((now - entry.repeatSince) / 1_000) : 0,
                process: {
                    supported: process.supported,
                    leaderAlive: process.leaderAlive,
                    processCount: process.processCount,
                    states: process.states,
                    waitChannels: process.waitChannels,
                    totalRssKb: process.totalRssKb,
                },
                gate: skipReason ?? "passed",
                tail: summarizeTail(log.tail),
            });
            if (skipReason) return;

            const service = discoverJevService(pi);
            if (!service) {
                trace.record("no_service", { jobId: entry.job.id, notified: !missingServiceNotified });
                if (!missingServiceNotified) {
                    missingServiceNotified = true;
                    entry.ctx.ui.notify("Semantic watchdog is waiting for TypeSafe Jev. Install/enable pi-extensions and run /login typesafe-jev.", "warning");
                }
                return;
            }
            missingServiceNotified = false;
            entry.lastCheckedAt = now;
            const startedAt = Date.now();
            const verdict = await askJev(service, entry, log, process, referencedObservations, now, trace);
            entry.lastVerdict = verdict;
            entry.verdictCount += 1;
            entry.previousProcess = process;
            entry.consecutiveHigh = isHigh(verdict) ? entry.consecutiveHigh + 1 : 0;
            const cooldownPassed = entry.lastAlertAt === undefined || now - entry.lastAlertAt >= WATCHDOG_ALERT_COOLDOWN_MS;
            const shouldEmit = force
                ? isHigh(verdict)
                : isDirectHigh(verdict) || entry.consecutiveHigh >= WATCHDOG_REQUIRED_CONSECUTIVE;
            trace.record("verdict", {
                jobId: entry.job.id,
                pid: entry.job.pid,
                force,
                latencyMs: Date.now() - startedAt,
                isHigh: isHigh(verdict),
                isDirectHigh: isDirectHigh(verdict),
                consecutiveHigh: entry.consecutiveHigh,
                cooldownPassed,
                shouldEmit,
                ...verdictTraceFields(verdict),
            });
            if (shouldEmit && cooldownPassed) {
                entry.lastAlertAt = now;
                const evidenceTail = [
                    log.tail,
                    ...referencedObservations.map((file) => `[${file.path}]\n${file.tail}`),
                ].filter(Boolean).join("\n");
                alert(entry, verdict, evidenceTail);
            } else if (shouldEmit && !cooldownPassed) {
                // Suppressed only to avoid repeating a recent reminder — worth
                // recording, since a long run may otherwise look silent.
                trace.record("alert_suppressed", {
                    jobId: entry.job.id,
                    reason: "cooldown",
                    cooldownRemainingSeconds: Math.round(
                        (WATCHDOG_ALERT_COOLDOWN_MS - (now - (entry.lastAlertAt ?? now))) / 1_000,
                    ),
                });
            } else if (isHigh(verdict)) {
                trace.record("alert_suppressed", {
                    jobId: entry.job.id,
                    reason: "needs_consecutive_samples",
                    consecutiveHigh: entry.consecutiveHigh,
                    required: WATCHDOG_REQUIRED_CONSECUTIVE,
                });
            }
            return verdict;
        } catch (error) {
            trace.record("error", {
                jobId: entry.job.id,
                pid: entry.job.pid,
                force,
                message: error instanceof Error ? error.message : String(error),
            });
            if (force) entry.ctx.ui.notify(`Semantic watchdog check failed for ${entry.job.id}: ${error instanceof Error ? error.message : String(error)}`, "error");
            return undefined;
        } finally {
            entry.checking = false;
            schedule(entry);
        }
    };

    return {
        track(job, ctx, signal) {
            if (disposed || tracked.has(job.id)) return;
            const now = Date.now();
            const entry: TrackedJob = {
                job,
                ctx,
                cancelled: false,
                lastLogSize: 0,
                lastLogGrowthAt: now,
                referencedFileSizes: new Map(),
                referencedFileGrowthAt: new Map(),
                checking: false,
                consecutiveHigh: 0,
                verdictCount: 0,
            };
            tracked.set(job.id, entry);
            trace.record("track", {
                jobId: job.id,
                pid: job.pid,
                kind: job.kind ?? "shell",
                name: job.name ?? null,
                persistent: job.persistent === true,
                command: job.command,
                logPath: job.logPath,
                alreadyAborted: signal.aborted,
            });
            const stop = (reason: string) => {
                entry.cancelled = true;
                if (entry.timer) clearTimeout(entry.timer);
                tracked.delete(job.id);
                trace.record("stop", {
                    jobId: job.id,
                    pid: job.pid,
                    reason,
                    status: job.status,
                    exitCode: job.exitCode ?? null,
                    ageSeconds: Math.round((Date.now() - job.startTime) / 1_000),
                    verdictCount: entry.verdictCount,
                    lastVerdict: entry.lastVerdict ? verdictTraceFields(entry.lastVerdict) : null,
                });
            };
            if (signal.aborted) stop("aborted_on_track");
            else signal.addEventListener("abort", () => stop("aborted"), { once: true });
            schedule(entry);
        },
        async inspectNow(jobId, ctx) {
            const entry = tracked.get(jobId);
            if (!entry) {
                ctx.ui.notify(`No running watchdog job: ${jobId}`, "warning");
                return undefined;
            }
            const verdict = await inspect(entry, true);
            if (verdict) {
                ctx.ui.notify(
                    `${jobId}: block=${verdict.stuck.toFixed(2)}, progress=${verdict.credibleProgress.toFixed(2)}, persistent=${verdict.intentionallyPersistent.toFixed(2)}, finite-wait=${verdict.validFiniteWait.toFixed(2)}, cause=${verdict.likelyCause}`,
                    isHigh(verdict) ? "warning" : "info",
                );
            }
            return verdict;
        },
        status() {
            return [...tracked.values()].map((entry) => ({
                jobId: entry.job.id,
                ageSeconds: Math.round((Date.now() - entry.job.startTime) / 1_000),
                ...(entry.lastVerdict ? { verdict: entry.lastVerdict } : {}),
            }));
        },
        setEnabled(value) {
            enabled = value;
            trace.record("set_enabled", { enabled: value, trackedJobs: tracked.size });
            for (const entry of tracked.values()) {
                if (entry.timer) {
                    clearTimeout(entry.timer);
                    entry.timer = undefined;
                }
                if (enabled && !entry.cancelled) schedule(entry);
            }
        },
        isEnabled() { return enabled; },
        trace,
        dispose() {
            disposed = true;
            for (const entry of tracked.values()) {
                entry.cancelled = true;
                if (entry.timer) clearTimeout(entry.timer);
            }
            trace.record("watchdog_dispose", { trackedJobs: tracked.size });
            tracked.clear();
        },
    };
}
