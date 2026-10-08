// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

export interface ProcStat {
    pid: number;
    comm: string;
    state: string;
    ppid: number;
    pgrp: number;
    cpuTicks: number;
    rssPages: number;
}

export interface ProcessSample extends ProcStat {
    rssKb: number;
    wchan?: string;
}

export interface ProcessGroupSnapshot {
    supported: boolean;
    sampledAt: number;
    rootPid: number;
    leaderAlive: boolean;
    processCount: number;
    pids: number[];
    totalCpuTicks: number;
    totalRssKb: number;
    states: Record<string, number>;
    waitChannels: Record<string, number>;
    clockTicksPerSecond?: number;
    processes: ProcessSample[];
}

/** Parse /proc/<pid>/stat. The command name can contain spaces and `)`, so the
 * final closing parenthesis, not whitespace splitting, separates it. */
export function parseProcStat(text: string): ProcStat | undefined {
    const open = text.indexOf("(");
    const close = text.lastIndexOf(")");
    if (open <= 0 || close <= open) return undefined;
    const pid = Number(text.slice(0, open).trim());
    const fields = text.slice(close + 1).trim().split(/\s+/);
    if (!Number.isInteger(pid) || fields.length < 22) return undefined;
    const state = fields[0] ?? "?";
    const ppid = Number(fields[1]);
    const pgrp = Number(fields[2]);
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    const rssPages = Number(fields[21]);
    if (![ppid, pgrp, utime, stime, rssPages].every(Number.isFinite)) return undefined;
    return {
        pid,
        comm: text.slice(open + 1, close),
        state,
        ppid,
        pgrp,
        cpuTicks: utime + stime,
        rssPages,
    };
}

function getconf(name: "CLK_TCK" | "PAGESIZE"): number | undefined {
    try {
        const value = Number(execFileSync("getconf", [name], { encoding: "utf8", timeout: 1_000 }).trim());
        return Number.isFinite(value) && value > 0 ? value : undefined;
    } catch {
        return undefined;
    }
}

let cachedClockTicks: number | undefined;
let cachedPageKb: number | undefined;
function clockTicks(): number | undefined {
    cachedClockTicks ??= getconf("CLK_TCK");
    return cachedClockTicks;
}
function pageKb(): number {
    cachedPageKb ??= (getconf("PAGESIZE") ?? 4096) / 1024;
    return cachedPageKb;
}

async function optionalText(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, "utf8");
    } catch {
        return undefined;
    }
}

function statusRssKb(text: string | undefined, fallbackPages: number): number {
    const match = text?.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) : Math.max(0, fallbackPages * pageKb());
}

function descendantsOf(rootPid: number, all: Map<number, ProcStat>): Set<number> {
    const selected = new Set<number>([rootPid]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const process of all.values()) {
            if (!selected.has(process.pid) && selected.has(process.ppid)) {
                selected.add(process.pid);
                changed = true;
            }
        }
    }
    return selected;
}

/** Sample the union of the detached process group and current descendants. */
export async function sampleProcessGroup(rootPid: number, procRoot = "/proc"): Promise<ProcessGroupSnapshot> {
    const sampledAt = Date.now();
    if (process.platform !== "linux" || rootPid <= 0) {
        return {
            supported: false,
            sampledAt,
            rootPid,
            leaderAlive: false,
            processCount: 0,
            pids: [],
            totalCpuTicks: 0,
            totalRssKb: 0,
            states: {},
            waitChannels: {},
            processes: [],
        };
    }

    let names: string[];
    try {
        names = await readdir(procRoot);
    } catch {
        return {
            supported: false,
            sampledAt,
            rootPid,
            leaderAlive: false,
            processCount: 0,
            pids: [],
            totalCpuTicks: 0,
            totalRssKb: 0,
            states: {},
            waitChannels: {},
            processes: [],
        };
    }

    const stats = await Promise.all(names.filter((name) => /^\d+$/.test(name)).map(async (name) => {
        const text = await optionalText(`${procRoot}/${name}/stat`);
        return text ? parseProcStat(text) : undefined;
    }));
    const all = new Map(stats.filter((entry): entry is ProcStat => entry !== undefined).map((entry) => [entry.pid, entry]));
    const selected = descendantsOf(rootPid, all);
    for (const process of all.values()) {
        if (process.pgrp === rootPid) selected.add(process.pid);
    }

    const processes = (await Promise.all([...selected].map(async (pid): Promise<ProcessSample | undefined> => {
        const current = all.get(pid);
        if (!current) return undefined;
        const [status, rawWchan] = await Promise.all([
            optionalText(`${procRoot}/${pid}/status`),
            optionalText(`${procRoot}/${pid}/wchan`),
        ]);
        const wchan = rawWchan?.trim();
        return {
            ...current,
            rssKb: statusRssKb(status, current.rssPages),
            ...(wchan && wchan !== "0" ? { wchan } : {}),
        };
    }))).filter((entry): entry is ProcessSample => entry !== undefined)
        .sort((a, b) => a.pid - b.pid);

    const states: Record<string, number> = {};
    const waitChannels: Record<string, number> = {};
    for (const process of processes) {
        states[process.state] = (states[process.state] ?? 0) + 1;
        if (process.wchan) waitChannels[process.wchan] = (waitChannels[process.wchan] ?? 0) + 1;
    }
    return {
        supported: true,
        sampledAt,
        rootPid,
        leaderAlive: all.has(rootPid),
        processCount: processes.length,
        pids: processes.map((process) => process.pid),
        totalCpuTicks: processes.reduce((sum, process) => sum + process.cpuTicks, 0),
        totalRssKb: processes.reduce((sum, process) => sum + process.rssKb, 0),
        states,
        waitChannels,
        ...(clockTicks() ? { clockTicksPerSecond: clockTicks() } : {}),
        processes,
    };
}
