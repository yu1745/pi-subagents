// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
/**
 * Bounded JSONL trace for the semantic stuck watchdog.
 *
 * The watchdog is advisory and otherwise invisible: verdicts only reach the UI
 * as transient notifications and the session transcript as `bg-semantic-stall`
 * messages. That makes it impossible to review what it actually did over a long
 * real-work run — how often it sampled, what it decided, which gate suppressed
 * an alert, and what the model saw.
 *
 * This module appends one JSON object per line to a trace file so a run can be
 * audited after the fact. Events:
 *
 *   watchdog_start / watchdog_dispose / set_enabled   extension lifecycle
 *   track        a background job entered watchdog tracking
 *   poll         a sample ran; `gate` says whether it passed to Jev or why not
 *   jev_request  the bounded state actually sent to the model
 *   verdict      the model's scores, latency, and the alert decision
 *   alert        an advisory alert was emitted
 *   alert_suppressed  a high verdict was withheld (cooldown / needs 2 samples)
 *   no_service   Jev service was unavailable
 *   error        a check threw
 *   stop         a job left tracking (terminal or abort), with its last verdict
 *
 * Tracing is best-effort and never allowed to break the watchdog: every write
 * is wrapped, and a failure disables the tracer for the process.
 *
 * Location, in order:
 *   1. `PI_PATTY_WATCHDOG_LOG` — explicit file path.
 *      `0` / `off` / `false` / empty disables tracing.
 *   2. `${PI_CODING_AGENT_DIR:-~/.pi/agent}/watchdog/events.jsonl`
 *
 * Set `PI_PATTY_WATCHDOG_LOG=0` to turn tracing off entirely. Under the Node
 * test runner tracing stays off unless a path is set explicitly, so a test run
 * cannot contaminate the trace of a real session.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse } from "node:path";

/** Rotate once a trace file reaches this size; one previous file is kept. */
export const WATCHDOG_TRACE_MAX_BYTES = 8 * 1024 * 1024;

const DISABLED_VALUES = new Set(["", "0", "off", "false", "no", "none"]);

/** Parent directory of a path, without importing `dirname` for one use. */
function dirnameOf(path: string): string {
    const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return index > 0 ? path.slice(0, index) : path;
}

function defaultTracePath(env: NodeJS.ProcessEnv): string {
    const configDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
    return join(configDir, "watchdog", "events.jsonl");
}

/** Resolve the trace path, or `undefined` when tracing is disabled. */
export function resolveWatchdogTracePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const configured = env.PI_PATTY_WATCHDOG_LOG?.trim();
    if (configured) return DISABLED_VALUES.has(configured.toLowerCase()) ? undefined : configured;
    // An unset or empty override means "use the default", except inside the Node
    // test runner where the default would pollute a real session's trace.
    if (configured === "" || env.NODE_TEST_CONTEXT) return undefined;
    return defaultTracePath(env);
}

export interface WatchdogTraceRecord {
    event: string;
    [key: string]: unknown;
}

export interface WatchdogTrace {
    /** Resolved trace file, or undefined when tracing is disabled. */
    readonly path?: string;
    record(event: string, data?: Record<string, unknown>): void;
}

/**
 * Create a directory one level at a time.
 *
 * `mkdir(..., { recursive: true })` can hang forever instead of failing on some
 * virtual filesystems (reproducibly under `/proc`), and a hang here would block
 * pi's main thread — the watchdog must never be able to do that. Plain mkdir
 * always returns promptly with a real errno, so walk the path manually and treat
 * an existing level as success.
 */
function ensureDirSync(dir: string): void {
    const { root } = parse(dir);
    let current = root;
    for (const part of dir.slice(root.length).split(/[/\\]/).filter(Boolean)) {
        current = current ? join(current, part) : part;
        try {
            mkdirSync(current);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
            throw error;
        }
    }
}

/** Roll a full trace aside so a long run cannot grow without bound. */
function rotateIfOversized(path: string): void {
    try {
        if (statSync(path).size < WATCHDOG_TRACE_MAX_BYTES) return;
        renameSync(path, `${path}.1`);
    } catch {
        /* missing file or a racing rotation — either way, keep appending */
    }
}

export function createWatchdogTrace(path: string | undefined = resolveWatchdogTracePath()): WatchdogTrace {
    if (!path) return { path: undefined, record() {} };

    let active = true;
    try {
        ensureDirSync(dirnameOf(path));
        rotateIfOversized(path);
    } catch {
        active = false;
    }

    return {
        path: active ? path : undefined,
        record(event, data = {}) {
            if (!active) return;
            const line = JSON.stringify({
                ts: new Date().toISOString(),
                event,
                extensionPid: process.pid,
                sessionId: process.env.PI_SESSION_ID ?? null,
                ...data,
            });
            try {
                appendFileSync(path, `${line}\n`);
            } catch {
                // A read-only or vanished path must not take the watchdog down.
                active = false;
            }
        },
    };
}

/** Compact, bounded view of the job log used as Jev evidence. */
export function summarizeTail(tail: string, maxChars = 400): string {
    const text = tail.replace(/\s+$/u, "");
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…[truncated]`;
}

/**
 * Deep, size-bounded copy of a Jev state object for tracing.
 * `undefined` object members are dropped so the result is real JSON, nesting is
 * capped, and any string longer than `maxStringChars` is truncated — the trace
 * must not balloon to the size of the state it describes.
 */
export function boundJson<T>(value: T, maxStringChars = 4_000, depth = 8): unknown {
    if (value === undefined) return undefined;
    if (typeof value === "string") {
        return value.length <= maxStringChars ? value : `${value.slice(0, maxStringChars)}…[truncated]`;
    }
    if (typeof value !== "object" || value === null) return value;
    if (depth <= 0) return "[depth-limit]";
    if (Array.isArray(value)) return value.slice(0, 64).map((item) => boundJson(item, maxStringChars, depth - 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        out[key] = boundJson(item, maxStringChars, depth - 1);
    }
    return out;
}
