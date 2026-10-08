// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
/**
 * Reader for the watchdog JSONL trace (`~/.pi/agent/watchdog/events.jsonl`).
 *
 * Keeps the observability surface honest: `/stuck-watchdog log` and
 * `/stuck-watchdog stats` read the same records the watchdog writes, with no
 * separate in-memory accounting that could drift from the file on disk.
 */

import { readFile } from "node:fs/promises";
import { resolveWatchdogTracePath, type WatchdogTraceRecord } from "./trace.js";

export interface WatchdogTraceStats {
    path: string;
    totalLines: number;
    malformedLines: number;
    firstTimestamp?: string;
    lastTimestamp?: string;
    trackedJobs: number;
    polls: number;
    gateHistogram: Record<string, number>;
    jevRequests: number;
    verdicts: number;
    highVerdicts: number;
    directHighVerdicts: number;
    alerts: number;
    suppressedAlerts: Record<string, number>;
    jevErrors: number;
    missingService: number;
    /** Alert verdicts that a human can compare against ground truth. */
    alertCauses: Record<string, number>;
    likelyCauses: Record<string, number>;
    /** Wall-clock between first and last record, in seconds. */
    spanSeconds?: number;
    /** Jev call latency, in milliseconds. */
    latencyMs: { count: number; min?: number; max?: number; mean?: number; p95?: number };
}

const bump = (histogram: Record<string, number>, key: unknown) => {
    const name = typeof key === "string" && key ? key : "(unset)";
    histogram[name] = (histogram[name] ?? 0) + 1;
};

/** Read and aggregate a trace file. Returns undefined when no trace exists yet. */
export async function readWatchdogTrace(
    path: string | undefined = resolveWatchdogTracePath(),
): Promise<{ stats: WatchdogTraceStats; records: WatchdogTraceRecord[] } | undefined> {
    if (!path) return undefined;
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch {
        return undefined;
    }

    const records: WatchdogTraceRecord[] = [];
    let malformedLines = 0;
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
            const parsed = JSON.parse(line) as WatchdogTraceRecord;
            if (typeof parsed?.event === "string") records.push(parsed);
            else malformedLines += 1;
        } catch {
            malformedLines += 1;
        }
    }

    const stats: WatchdogTraceStats = {
        path,
        totalLines: records.length + malformedLines,
        malformedLines,
        trackedJobs: 0,
        polls: 0,
        gateHistogram: {},
        jevRequests: 0,
        verdicts: 0,
        highVerdicts: 0,
        directHighVerdicts: 0,
        alerts: 0,
        suppressedAlerts: {},
        jevErrors: 0,
        missingService: 0,
        alertCauses: {},
        likelyCauses: {},
        latencyMs: { count: 0 },
    };

    const latencies: number[] = [];
    for (const record of records) {
        stats.firstTimestamp ??= typeof record.ts === "string" ? record.ts : undefined;
        if (typeof record.ts === "string") stats.lastTimestamp = record.ts;
        switch (record.event) {
            case "track":
                stats.trackedJobs += 1;
                break;
            case "poll":
                stats.polls += 1;
                bump(stats.gateHistogram, record.gate);
                break;
            case "jev_request":
                stats.jevRequests += 1;
                break;
            case "verdict":
                stats.verdicts += 1;
                if (record.isHigh === true) stats.highVerdicts += 1;
                if (record.isDirectHigh === true) stats.directHighVerdicts += 1;
                bump(stats.likelyCauses, record.likelyCause);
                if (typeof record.latencyMs === "number") latencies.push(record.latencyMs);
                break;
            case "alert":
                stats.alerts += 1;
                bump(stats.alertCauses, record.likelyCause);
                break;
            case "alert_suppressed":
                bump(stats.suppressedAlerts, record.reason);
                break;
            case "error":
                stats.jevErrors += 1;
                break;
            case "no_service":
                stats.missingService += 1;
                break;
            default:
                break;
        }
    }

    if (stats.firstTimestamp && stats.lastTimestamp) {
        const span = (Date.parse(stats.lastTimestamp) - Date.parse(stats.firstTimestamp)) / 1_000;
        if (Number.isFinite(span)) stats.spanSeconds = Math.round(span);
    }
    if (latencies.length) {
        const sorted = [...latencies].sort((a, b) => a - b);
        stats.latencyMs = {
            count: sorted.length,
            min: sorted[0],
            max: sorted[sorted.length - 1],
            mean: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
            p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
        };
    }

    return { stats, records };
}

function histogramLines(histogram: Record<string, number>, indent = "  "): string[] {
    const entries = Object.entries(histogram).sort(([, a], [, b]) => b - a);
    if (!entries.length) return [`${indent}(none)`];
    return entries.map(([key, count]) => `${indent}${key}: ${count}`);
}

/** Human-readable multi-line summary for the `/stuck-watchdog stats` command. */
export function formatWatchdogTraceStats(stats: WatchdogTraceStats): string {
    const latency = stats.latencyMs.count
        ? `min=${stats.latencyMs.min}ms mean=${stats.latencyMs.mean}ms p95=${stats.latencyMs.p95}ms max=${stats.latencyMs.max}ms`
        : "(no samples)";
    const span = stats.spanSeconds === undefined
        ? "n/a"
        : `${Math.floor(stats.spanSeconds / 3600)}h${Math.floor((stats.spanSeconds % 3600) / 60)}m`;
    return [
        `Watchdog trace: ${stats.path}`,
        `Window: ${stats.firstTimestamp ?? "n/a"} → ${stats.lastTimestamp ?? "n/a"} (${span})`,
        `Records: ${stats.totalLines}${stats.malformedLines ? ` (${stats.malformedLines} malformed)` : ""}`,
        `Jobs tracked: ${stats.trackedJobs} | polls: ${stats.polls} | Jev requests: ${stats.jevRequests}`,
        `Verdicts: ${stats.verdicts} (high ${stats.highVerdicts}, direct-high ${stats.directHighVerdicts})`,
        `Alerts: ${stats.alerts} | Jev errors: ${stats.jevErrors} | missing service: ${stats.missingService}`,
        `Jev latency: ${latency}`,
        "Poll gate histogram:",
        ...histogramLines(stats.gateHistogram),
        "Alert causes:",
        ...histogramLines(stats.alertCauses),
        "Suppressed alerts:",
        ...histogramLines(stats.suppressedAlerts),
        "Verdict likely-cause histogram:",
        ...histogramLines(stats.likelyCauses),
    ].join("\n");
}
