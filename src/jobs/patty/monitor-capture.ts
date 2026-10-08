// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
import { closeSync, constants, ftruncateSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

// Monitor-only limits: ordinary background jobs retain their existing capture.
export const MONITOR_LOG_BYTES = 1024 * 1024;
export const MONITOR_CHUNK_BYTES = 64 * 1024;
export const MONITOR_FRAME_BYTES = 64 * 1024;

const epochs = new Map<string, { generation: number }>();
export const monitorCaptureEpoch = (path: string) => epochs.get(path);

/** Bounded, same-inode log. The follower must detect truncation and reset its offset.
 * Old output is intentionally discarded; persistent sources are never stopped
 * merely because they have produced more than the retention budget. */
export function openMonitorCapture(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const epoch = { generation: 0 };
    epochs.set(path, epoch);
    let size = 0;
    let closed = false;
    return {
        write(data: Uint8Array) {
            if (closed) throw new Error("Monitor capture is closed");
            for (let offset = 0; offset < data.byteLength; offset += MONITOR_CHUNK_BYTES) {
                const chunk = data.subarray(offset, offset + MONITOR_CHUNK_BYTES);
                if (size + chunk.byteLength > MONITOR_LOG_BYTES) {
                    ftruncateSync(fd, 0);
                    epoch.generation++;
                    size = 0;
                }
                // Explicit positions avoid the stale fd offset after truncate.
                const written = writeSync(fd, chunk, 0, chunk.byteLength, size);
                if (written !== chunk.byteLength) throw new Error("Short monitor log write");
                size += written;
            }
        },
        close() {
            if (closed) return;
            closed = true;
            if (epochs.get(path) === epoch) epochs.delete(path);
            closeSync(fd);
        },
    };
}
