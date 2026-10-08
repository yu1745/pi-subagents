// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
/**
 * A monitor's event source, behind one seam.
 *
 * Both kinds of monitor produce the same thing the session needs: a log file
 * whose appended lines are events, a promise that resolves when the source
 * ends, and a teardown hook. Naming that contract lets the session (see
 * monitor-session.ts) treat command and WebSocket monitors identically, and
 * makes a third source (named pipe, file replay, …) a drop-in later.
 */

import { openMonitorCapture } from "./monitor-capture.js";
import { openWsSource, type WsSpec } from "./monitor-ws.js";
import { killProcessTree, type ProcessIdentity, type SpawnExit, spawnSupervisedProcess } from "./spawn.js";

export interface MonitorSource {
    /** File the follower reads; appended lines become events. */
    logPath: string;
    /** OS pid backing the source, or 0 when there is no process (ws). */
    pid: number;
    identity?: ProcessIdentity;
    /** Human-readable label shown in the sidebar / jobs list. */
    label: string;
    /** Resolves when the source ends (process exit, or ws close as code-only). */
    exit: Promise<SpawnExit>;
    /** Teardown beyond the standard process kill (closes the ws socket). */
    stop: () => void;
}

/** Command source: a shell child whose stdout is the event stream and whose
 *  stderr is captured separately (readable, never emitted). */
export function spawnCommandSource(args: {
    command: string;
    cwd: string;
    logPath: string;
    errPath: string;
}): MonitorSource {
    const out = openMonitorCapture(args.logPath);
    let err: ReturnType<typeof openMonitorCapture>;
    try { err = openMonitorCapture(args.errPath); }
    catch (error) { out.close(); throw error; }
    let proc: ReturnType<typeof spawnSupervisedProcess>;
    try {
        proc = spawnSupervisedProcess({
            file: "bash", fileArgs: ["-c", args.command], cwd: args.cwd,
            stdout: "pipe", stderr: "pipe",
        });
    } catch (error) { out.close(); err.close(); throw error; }
    let settled = false;
    let resolveExit!: (result: SpawnExit) => void;
    const exit = new Promise<SpawnExit>((resolve) => { resolveExit = resolve; });
    const settle = (result: SpawnExit) => {
        if (settled) return;
        settled = true;
        proc.stdout?.destroy();
        proc.stderr?.destroy();
        try { out.close(); } catch { result = { code: 1, signal: null }; }
        try { err.close(); } catch { result = { code: 1, signal: null }; }
        resolveExit(result);
    };
    let captureFailed = false;
    let commandExit: SpawnExit | undefined;
    const fail = () => {
        captureFailed = true;
        proc.ref();
        killProcessTree(proc.identity, "SIGKILL");
        proc.stdout?.destroy();
        proc.stderr?.destroy();
        if (!proc.pid) settle({ code: 1, signal: null });
    };
    proc.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        try { out.write(chunk); } catch { fail(); }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
        if (settled) return;
        try { err.write(chunk); } catch { fail(); }
    });
    proc.stdout?.on("error", fail);
    proc.stderr?.on("error", fail);
    proc.on("error", fail);
    // Drain buffered pipe output before reporting completion. Descendants that
    // inherit pipes can delay close; stop() explicitly tears those pipes down.
    proc.on("message", (message: unknown) => {
        const result = message as SpawnExit;
        if (result && (result.code === null || typeof result.code === "number") &&
            (result.signal === null || typeof result.signal === "string")) commandExit = result;
    });
    proc.on("close", (code, signal) => settle(captureFailed ? { code: 1, signal: null } : commandExit ?? { code, signal }));
    // Capture pipes must not pin a background-only host either.
    for (const stream of [proc.stdout, proc.stderr]) {
        if (stream && "unref" in stream && typeof stream.unref === "function") stream.unref();
    }
    proc.unref();
    return {
        logPath: args.logPath,
        pid: proc.pid ?? 0,
        identity: proc.identity,
        label: args.command,
        exit,
        stop: () => {
            if (settled) return;
            // Lifecycle owns bounded escalation; report exit only on close.
            proc.ref();
            killProcessTree(proc.identity);
        },
    };
}

/** WebSocket source: each text frame is appended to the log as a line. */
export function openWsMonitorSource(spec: WsSpec, logPath: string): MonitorSource {
    const ws = openWsSource(spec, logPath);
    return {
        logPath,
        pid: 0,
        label: `ws ${spec.url}`,
        // A socket has no signal — the close code maps to the code half.
        exit: ws.exit.then((code) => ({ code, signal: null })),
        stop: ws.close,
    };
}
