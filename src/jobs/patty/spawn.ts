// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
// src/spawn.ts
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, constants, lstatSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { supervisorSource } from "./spawn-supervisor.js";

/** How the child ended: an exit code, or the signal that killed it. Node
 *  reports `code === null` when the child died by signal (external kill, OOM),
 *  so the signal half is what tells a crash apart from a clean exit. */
export interface SpawnExit {
    code: number | null;
    signal: NodeJS.Signals | null;
}

/** Per-spawn capability, not a PID lookup. Retaining an old capability can
 * never acquire authority over a later process assigned the same numeric PID. */
export interface ProcessIdentity { readonly pid: number; }

export interface SpawnResult {
    pid: number;
    identity: ProcessIdentity;
    logPath: string;
    exit: Promise<SpawnExit>;
    /** Release the foreground event-loop hold after promotion/cancellation. */
    release: () => void;
}

/**
 * Spawn a child with stdout+stderr written directly to a file descriptor — the
 * Claude Code pattern: the kernel writes output to disk with zero JS in the
 * data path. Progress is read back by polling the file tail separately.
 *
 * Pass `command` to run `bash -c <command>`, or `file`/`fileArgs` to exec a
 * binary directly (e.g. agent_bg launching `pi -p`). The child is detached so
 * the whole process group can be signalled.
 */
export function spawnWithFileOutput(args: {
    command?: string;
    file?: string;
    fileArgs?: string[];
    cwd: string;
    logPath: string;
    /** When set, stderr is written here instead of merged into logPath. Used by
     *  the monitor tool so stdout is a clean event stream and stderr is captured
     *  separately (readable, but never emitted as an event). */
    errPath?: string;
    signal?: AbortSignal;
    foreground?: boolean;
}): SpawnResult {
    ensureLogDir(args.logPath);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    const outFd = openSync(args.logPath, flags, 0o600);
    let errFd: number;
    try {
        if (args.errPath) ensureLogDir(args.errPath);
        errFd = args.errPath ? openSync(args.errPath, flags, 0o600) : outFd;
    } catch (err) {
        closeSync(outFd);
        throw err;
    }

    const [bin, binArgs]: [string, string[]] = args.file
        ? [args.file, args.fileArgs ?? []]
        : ["bash", ["-c", args.command ?? ""]];

    let proc: ReturnType<typeof spawnSupervisedProcess>;
    try {
        proc = spawnSupervisedProcess({ file: bin, fileArgs: binArgs, cwd: args.cwd, stdout: outFd, stderr: errFd });
    } finally {
        closeSync(outFd);
        if (errFd !== outFd) closeSync(errFd);
    }

    // Build the exit promise and attach the 'error' listener BEFORE any throw,
    // so an asynchronous spawn failure (ENOENT / EMFILE / EAGAIN) can never
    // surface as an uncaught exception that takes pi down.
    const exit = new Promise<SpawnExit>((resolve) => {
        // A supervisor's command-exit report is not resource release: it still
        // owns the process group until cleanup. Settle only on supervisor exit,
        // preserving the command's code/signal, before worktree release.
        let commandExit: SpawnExit | undefined;
        proc.on("message", (message: unknown) => {
            const result = message as SpawnExit;
            if (result && (result.code === null || typeof result.code === "number") &&
                (result.signal === null || typeof result.signal === "string")) commandExit = result;
        });
        proc.on("exit", (code, signal) => resolve(commandExit ?? { code, signal }));
        proc.on("error", () => resolve({ code: 1, signal: null }));
    });

    if (!proc.pid) {
        try { unlinkSync(args.logPath); } catch { /* best-effort */ }
        if (args.errPath) {
            try { unlinkSync(args.errPath); } catch { /* best-effort */ }
        }
        throw new Error("Failed to spawn process");
    }
    const pid = proc.pid;

    // Kill the process group on abort. Most callers manage abort themselves and
    // do not pass a signal; this is offered for direct/background spawns.
    const identity = proc.identity!;
    const onAbort = () => killProcessTree(identity);
    if (args.signal) {
        if (args.signal.aborted) onAbort();
        else args.signal.addEventListener("abort", onAbort, { once: true });
    }
    void exit.finally(() => args.signal?.removeEventListener("abort", onAbort));

    // The IPC channel must not accidentally keep background-only Pi alive.
    proc.channel?.unref();
    const release = () => proc.unref();
    if (!args.foreground) release();

    return { pid, identity, logPath: args.logPath, exit, release };
}

/** Validate each destination, not a global once flag: stderr and tests may use
 * different directories. The registry supplies a private, trusted temp root.
 * O_EXCL/O_NOFOLLOW also prevent replacing/truncating preexisting log files. */
function ensureLogDir(logPath: string): void {
    const dir = dirname(logPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!isSafeLogDirectory(stat)) {
        throw new Error(`Unsafe log directory: ${dir}`);
    }
}

/** Windows mode bits are synthesized, not ACL permission evidence. Keep real
 * directory/symlink checks everywhere; apply Unix owner/mode checks only on POSIX.
 * Windows inherits the temp parent's ACL; this is not an ACL privacy guarantee. */
export function isSafeLogDirectory(stat: {
    isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number;
}, platform: NodeJS.Platform = process.platform, uid?: number): boolean {
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (platform === "win32") return true;
    const owner = uid ?? process.getuid?.();
    return (owner === undefined || stat.uid === owner) && !(stat.mode & 0o022);
}

interface OwnedState { alive: boolean; proc?: ChildProcess; supervised: boolean; }
// Weak keys avoid PID tombstones and let completed capabilities disappear with
// their jobs. No numeric PID can recover a capability or revive a dead one.
const ownedProcesses = new WeakMap<ProcessIdentity, OwnedState>();

/** Shared supervisor for file-backed tasks and bounded pipe-backed monitors.
 * The supervisor owns the group identity until it has killed descendants. */
export function spawnSupervisedProcess(args: {
    file: string;
    fileArgs: string[];
    cwd: string;
    stdout: number | "pipe";
    stderr: number | "pipe";
}) {
    const supervised = process.platform !== "win32";
    const proc = spawn(supervised ? process.execPath : args.file,
        supervised ? ["-e", supervisorSource, JSON.stringify([args.file, args.fileArgs])] : args.fileArgs, {
            stdio: supervised ? ["ignore", args.stdout, args.stderr, "ipc"] : ["ignore", args.stdout, args.stderr],
            cwd: args.cwd,
            detached: true,
            env: { ...process.env },
        });
    const identity = retainProcessIdentity(proc, supervised);
    proc.channel?.unref();
    return Object.assign(proc, { identity });
}

/** Capture a child handle once, including direct external children. Call this
 * while owning the actual ChildProcess, never by looking up a numeric PID. */
export function retainProcessIdentity(proc: ChildProcess, supervised = false): ProcessIdentity | undefined {
    if (!proc.pid) return undefined;
    const identity = Object.freeze({ pid: proc.pid });
    const state: OwnedState = { alive: proc.exitCode === null && proc.signalCode === null, proc, supervised };
    ownedProcesses.set(identity, state);
    const ended = () => { state.alive = false; delete state.proc; };
    proc.once("exit", ended);
    proc.once("error", ended);
    return identity;
}

/** Liveness is tied to the retained capability, never to a reused PID. */
export const ownedProcessAlive = (identity: ProcessIdentity): boolean => ownedProcesses.get(identity)?.alive ?? false;

/** Signal only a retained spawn capability. POSIX supervisors signal their own
 * anchored group over IPC; direct/Windows children use their ChildProcess handle.
 * Never infer signal authority from a bare PID or fall back to one. */
export function killProcessTree(
    target: ProcessIdentity | undefined,
    signal: NodeJS.Signals = "SIGTERM"
): void {
    if (typeof target === "object" && target !== null) {
        const state = ownedProcesses.get(target);
        if (!state?.alive || !state.proc) return;
        try {
            if (state.supervised) {
                // IPC addresses the original supervisor, not a numeric PID. It
                // signals its own anchored group, even if parent exit delivery
                // is delayed. Never fall back to numeric signalling on failure.
                if (state.proc.connected) state.proc.send!({ signal }, () => {});
            } else state.proc.kill(signal);
        } catch { /* gone/disconnected: no unsafe PID fallback */ }
        return;
    }
    // Bare PID inputs are deliberately rejected, including untyped callers.
    // There is no safe way to infer which spawn a reused number once denoted.
}

/** Cheap liveness probe via signal 0. */
export function processExists(target: ProcessIdentity | number | undefined): boolean {
    if (typeof target === "object" && target !== null) return ownedProcessAlive(target);
    const pid = target;
    if (typeof pid !== "number" || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}
