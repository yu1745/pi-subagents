import type { Job } from "./types.js";

// Presentation leases are deliberately separate from attach waiters: opening a
// log must not suppress completion delivery or mark an outcome consumed.
const readers = new WeakMap<Job, number>();

export function acquireLogLease(job: Job): () => void {
    readers.set(job, (readers.get(job) ?? 0) + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const count = (readers.get(job) ?? 1) - 1;
        if (count) readers.set(job, count);
        else readers.delete(job);
    };
}

export function hasLogReaders(job: Job): boolean {
    return (readers.get(job) ?? 0) > 0;
}
