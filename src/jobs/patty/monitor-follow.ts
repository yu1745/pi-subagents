// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { monitorCaptureEpoch } from "./monitor-capture.js";
import { MONITOR_POLL_MS } from "./types.js";

// Bounds apply before splitting/joining, including newline-free producers.
export const MONITOR_READ_BYTES = 16 * 1024;
export const MONITOR_LINE_CHARS = 4096;
export const MONITOR_BATCH_LINES = 128;
const FINAL_READ_LIMIT = 16;
export interface MonitorFollower { stop(flush?: boolean): void; }

export function followLines(
    logPath: string,
    onLines: (lines: string[]) => void,
    intervalMs = MONITOR_POLL_MS,
    onError: (error: unknown) => void = (error) => console.error("[monitor follower]", error),
): MonitorFollower {
    const epoch = monitorCaptureEpoch(logPath);
    let generation = epoch?.generation;
    let offset = 0;
    let remainder = "";
    let truncated = false;
    let stopped = false;
    let decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(MONITOR_READ_BYTES);
    const deliver = (lines: string[]) => {
        if (!lines.length) return;
        try { onLines(lines); } catch (error) { onError(error); }
    };
    function consume(text: string): void {
        let lines: string[] = [];
        for (const part of text.split(/(?<=\n)/)) {
            const complete = part.endsWith("\n");
            const body = complete ? part.slice(0, -1) : part;
            const room = MONITOR_LINE_CHARS - remainder.length;
            remainder += body.slice(0, room);
            if (body.length > room) truncated = true;
            if (complete) {
                lines.push(remainder + (truncated ? " [line truncated]" : ""));
                remainder = "";
                truncated = false;
                if (lines.length === MONITOR_BATCH_LINES) { deliver(lines); lines = []; }
            }
        }
        deliver(lines);
    }
    function readNew(): boolean {
        let fd: number | undefined;
        try {
            let size: number;
            try { size = statSync(logPath).size; } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
                throw error;
            }
            if (size < offset || epoch?.generation !== generation) {
                offset = 0; remainder = ""; truncated = false; decoder = new StringDecoder("utf8");
                generation = epoch?.generation;
                deliver(["[monitor retained output rotated; older events may be omitted]"]);
            }
            if (size <= offset) return false;
            fd = openSync(logPath, "r");
            const n = readSync(fd, buffer, 0, Math.min(size - offset, buffer.length), offset);
            offset += n;
            consume(decoder.write(buffer.subarray(0, n)));
            return offset < size;
        } catch (error) { onError(error); return false; }
        finally { if (fd !== undefined) { try { closeSync(fd); } catch (error) { onError(error); } } }
    }
    const timer = setTimeout(function tick() {
        if (stopped) return;
        readNew();
        if (!stopped) timer.refresh();
    }, intervalMs);
    timer.unref();
    return {
        stop(flush = false) {
            if (stopped) return;
            stopped = true;
            clearTimeout(timer);
            if (!flush) return;
            let more = false;
            for (let i = 0; i < FINAL_READ_LIMIT; i++) { more = readNew(); if (!more) break; }
            if (more) { deliver(["[monitor final backlog omitted: flush limit reached]"]); remainder = ""; }
            else { consume(decoder.end()); if (remainder) deliver([remainder + (truncated ? " [line truncated]" : "")]); }
            remainder = "";
        },
    };
}
