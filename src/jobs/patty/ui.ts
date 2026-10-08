// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
/**
 * Background tasks TUI panel — the /bg-list interactive manager.
 *
 * Uses Pi's ctx.ui.select()/ctx.ui.editor() primitives (available in both
 * command and shortcut contexts) to provide Claude Code-style job management:
 * - pick a job from the list
 * - show output / kill / remove actions
 */

import { formatDuration, jobLabel } from "./format.js";
import { terminateJobSilently } from "./lifecycle.js";
import { forget, readLogTail, renderSidebar } from "./registry.js";
import type { BackgroundRegistry } from "./state.js";
import type { Job, UiContext } from "./types.js";
import { OUTPUT_PREVIEW_CHARS, PREVIEW_CHARS } from "./types.js";

export async function openBgListPanel(
    reg: BackgroundRegistry,
    ctx: UiContext
): Promise<void> {
    // Use select()-based panel (works in both command and shortcut contexts).
    const generation = reg.generation;
    while (!reg.disposed && reg.generation === generation) {
        const jobs = getJobList(reg);
        if (jobs.length === 0) {
            ctx.ui.notify("No background tasks", "info");
            return;
        }

        const items = jobs.map((job) => {
            const icon = statusIcon(job);
            const dur = formatDuration(Date.now() - job.startTime);
            const label = job.name ? `${job.name} (${job.id})` : job.id;
            const statusStr = job.status === "running" ? `running (${dur})` : job.status;
            const cmd = job.command.slice(0, PREVIEW_CHARS.taskList);
            return `${icon} ${label}: ${cmd} · ${statusStr}`;
        });

        const choice = await ctx.ui.select("Background Tasks", items);
        if (choice === undefined || reg.disposed || reg.generation !== generation) return;

        const idx = items.indexOf(choice);
        const job = jobs[idx];
        if (!job) return;

        const continued = await showJobActions(job, reg, ctx);
        if (!continued) return;
    }
}

async function showJobActions(
    job: Job,
    reg: BackgroundRegistry,
    ctx: UiContext
): Promise<boolean> {
    const name = jobLabel(job);
    const generation = reg.generation;
    const isActive = () => !reg.disposed && reg.generation === generation;

    if (job.status === "running") {
        const options = ["Show Output", "Kill", "← Back"];
        const action = await ctx.ui.select(
            `▶ ${name} · ${job.command.slice(0, PREVIEW_CHARS.detail)}`,
            options
        );
        if (action === undefined || !isActive()) return false;
        if (action === "Show Output") { await showOutput(job, ctx); return true; }
        if (action === "Kill") {
            const stopped = await terminateJobSilently(reg, job);
            if (!isActive()) return false;
            renderSidebar(reg, ctx);
            try { ctx.ui.notify(stopped ? `Killed ${name}` : `Could not confirm termination of ${name}`, stopped ? "info" : "error"); }
            catch { return false; }
            return true;
        }
        return true;
    }

    const options = ["Show Output", "Remove", "← Back"];
    const action = await ctx.ui.select(`${statusIcon(job)} ${name} · ${job.status}`, options);
    if (action === undefined || !isActive()) return false;
    if (action === "Show Output") { await showOutput(job, ctx); return true; }
    if (action === "Remove") {
        forget(reg, job);
        renderSidebar(reg, ctx);
        ctx.ui.notify(`Removed ${name}`, "info");
        return true;
    }
    return true;
}

async function showOutput(job: Job, ctx: UiContext): Promise<void> {
    const out = readLogTail(job, OUTPUT_PREVIEW_CHARS);
    const dur = formatDuration(Date.now() - job.startTime);
    const exitLine = job.exitCode !== undefined ? `\nExit code: ${job.exitCode}` : "";
    await ctx.ui.editor(
        `${statusIcon(job)} ${jobLabel(job)}`,
        `Command: ${job.command}\n` +
        `PID: ${job.pid} · Started: ${new Date(job.startTime).toLocaleString()}\n` +
        `Duration: ${dur} · Status: ${job.status}${exitLine}\n` +
        `Log: ${job.logPath}\n\n--- OUTPUT ---\n${out}`
    );
}

function getJobList(reg: BackgroundRegistry): Job[] {
    const all = Array.from(reg.jobs.values());
    const running = all.filter((j) => j.status === "running").sort((a, b) => b.startTime - a.startTime);
    const terminal = all.filter((j) => j.status !== "running").sort((a, b) => b.startTime - a.startTime);
    return [...running, ...terminal];
}

function statusIcon(job: Job): string {
    switch (job.status) {
        case "pending": return "◌";
        case "running": return "▶";
        case "completed": return "✓";
        case "failed": return "✗";
        case "killed": return "✗";
    }
}
