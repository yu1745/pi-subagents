// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
/**
 * Shared mutable state for the background-tasks extension.
 *
 * One instance per session, threaded through every tool and helper.
 */

import type { ForegroundSlot, Job } from "./types.js";
import type { JobWatchdog } from "./watchdog/index.js";

export class BackgroundRegistry {
    jobs = new Map<string, Job>();
    /** Root-owned storage; scoped views enforce child ownership. */
    allJobs: Map<string, Job> = this.jobs;
    parent: BackgroundRegistry | undefined;
    ownerRegistries = new Map<string, BackgroundRegistry>();
    retainResults = false;
    onChange: (() => void) | undefined;
    watchdog: JobWatchdog | undefined;
    foreground = new Map<string, ForegroundSlot>();

    /** Per-job AbortController — abort() cancels all monitors/pollers for that job. */
    jobAborts = new Map<string, AbortController>();

    nonInteractive = false;
    /** Async callbacks must match this runtime generation and never call host
     * APIs after shutdown. A new session can reuse the extension instance. */
    private lifetime = { disposed: false, generation: 0 };
    get disposed(): boolean { return this.lifetime.disposed; }
    set disposed(value: boolean) { this.lifetime.disposed = value; }
    get generation(): number { return this.lifetime.generation; }
    set generation(value: number) { this.lifetime.generation = value; }

    shareLifetime(parent: BackgroundRegistry): void {
        this.parent = parent;
        this.ownerRegistries = parent.ownerRegistries;
        this.lifetime = parent.lifetime;
        this.jobAborts = parent.jobAborts;
        this.allJobs = parent.allJobs;
        this.watchdog = parent.watchdog;
        this.retainResults = parent.retainResults;
        this.onChange = parent.onChange;
    }

    completedCount = 0;
    failedCount = 0;
    killedCount = 0;
    totalStarted = 0;
    totalDurationMs = 0;
    recentTerminal: Job[] = [];

    /** Live-duration ticker for the sidebar pills; runs while jobs are alive. */
    sidebarTimer: NodeJS.Timeout | undefined = undefined;
    /** Last rendered sidebar content — used to skip redundant widget updates. */
    lastSidebarContent: string | undefined = undefined;
}
