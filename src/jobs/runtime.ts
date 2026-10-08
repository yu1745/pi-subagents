import type { AgentSession, ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerCommands } from "./patty/commands.js";
import { registerInputHandlers } from "./patty/input.js";
import { detectNonInteractive, pauseAllForeground, terminateJobSilently } from "./patty/lifecycle.js";
import { renderSidebar, stopSidebarTicker } from "./patty/registry.js";
import { registerShortcuts } from "./patty/shortcuts.js";
import { BackgroundRegistry } from "./patty/state.js";
import { registerAgentBgTool } from "./patty/tools/agent-bg.js";
import { registerBashTool } from "./patty/tools/bash.js";
import { registerBashBgTool } from "./patty/tools/bash-bg.js";
import { registerJobsTool } from "./patty/tools/jobs.js";
import { registerMonitorTool } from "./patty/tools/monitor.js";
import { EVENT, type Job } from "./patty/types.js";
import { createJobWatchdog } from "./patty/watchdog/index.js";
import { formatWatchdogTraceStats, readWatchdogTrace } from "./patty/watchdog/trace-report.js";

/** Opt-in at next process startup only. Never changes installed packages/settings. */
export function jobRuntimeEnabled(): boolean {
  return process.env.PI_SUBAGENTS_JOB_RUNTIME !== "0";
}

export const JOB_RUNTIME_EXTENSION = "pi-subagents-jobs";

interface Owner {
  agentId?: string;
  sessionId?: string;
  cwd?: string;
  registry: BackgroundRegistry;
  steers: string[];
  draining: boolean;
  stopped: boolean;
  termination?: Promise<boolean>;
}

/** One storage map, different capabilities: main can inspect/manage all jobs;
 * children can only inspect/manage their own. Foreground wait slots are NOT
 * shared, so a steer to main cannot accidentally release another agent's wait. */
class OwnedJobs extends Map<string, Job> {
  constructor(private storage: Map<string, Job>, private owner: Owner, private all: boolean) { super(); }
  private readable(job: Job): boolean { return this.all || job.ownerAgentId === this.owner.agentId; }
  override get(id: string): Job | undefined {
    const job = this.storage.get(id);
    return job && this.readable(job) ? job : undefined;
  }
  override has(id: string): boolean { return this.get(id) !== undefined; }
  override set(id: string, job: Job): this {
    if (this.storage.has(id) && this.storage.get(id) !== job) throw new Error(`Duplicate job ID: ${id}`);
    job.ownerAgentId = this.owner.agentId;
    job.ownerSessionId = this.owner.sessionId;
    job.cwd ??= this.owner.cwd;
    this.storage.set(id, job);
    this.owner.registry.onChange?.();
    return this;
  }
  override delete(id: string): boolean { return this.has(id) && this.storage.delete(id); }
  private snapshot(): Map<string, Job> { return new Map([...this.storage].filter(([, job]) => this.readable(job))); }
  override clear(): void { for (const id of this.keys()) this.delete(id); }
  override get size(): number { return this.snapshot().size; }
  override entries(): MapIterator<[string, Job]> { return this.snapshot().entries(); }
  override keys(): MapIterator<string> { return this.snapshot().keys(); }
  override values(): MapIterator<Job> { return this.snapshot().values(); }
  override [Symbol.iterator](): MapIterator<[string, Job]> { return this.entries(); }
  override forEach(callback: (value: Job, key: string, map: Map<string, Job>) => void, thisArg?: unknown): void {
    for (const [id, job] of this.entries()) callback.call(thisArg, job, id, this);
  }
}

/** Parent-session service, not a child extension's lifetime. Patty's file-fd
 * capture/process capabilities live here; AgentManager owns the agent identity
 * and the runner explicitly joins its jobs before settling/releasing a tree. */
export class JobRuntime {
  readonly registry = new BackgroundRegistry();
  private storage = new Map<string, Job>();
  private owners = new Map<string, Owner>();
  private changed = new Set<() => void>();
  private ctx?: ExtensionContext;
  private root: Owner;

  constructor(private pi: ExtensionAPI) {
    this.registry.allJobs = this.storage;
    this.registry.retainResults = true;
    this.registry.onChange = () => { for (const wake of [...this.changed]) wake(); };
    this.root = this.makeOwner();
  }

  private makeOwner(agentId?: string): Owner {
    const registry = agentId === undefined ? this.registry : new BackgroundRegistry();
    if (agentId !== undefined) registry.shareLifetime(this.registry);
    const owner: Owner = { agentId, registry, steers: [], draining: false, stopped: false };
    registry.jobs = new OwnedJobs(this.storage, owner, agentId === undefined);
    if (agentId !== undefined) {
      this.owners.set(agentId, owner);
      this.registry.ownerRegistries.set(agentId, registry);
    }
    return owner;
  }

  /** A manager run (including resume) may reuse the same SDK session. */
  beginRun(agentId: string): void {
    const owner = this.owners.get(agentId) ?? this.makeOwner(agentId);
    if (this.hasRunning(agentId)) throw new Error(`Agent ${agentId} still owns running jobs`);
    owner.stopped = false;
    owner.steers = [];
    owner.termination = undefined;
  }

  private owner(agentId: string): Owner { return this.owners.get(agentId) ?? this.makeOwner(agentId); }

  installRoot(): void {
    this.registry.nonInteractive = detectNonInteractive(process.argv, !!process.stdin.isTTY);
    this.registry.watchdog = createJobWatchdog(this.pi, this.registry);
    this.install(this.pi, this.root);
    registerCommands(this.pi, this.registry);
    registerShortcuts(this.pi, this.registry);
    for (const event of Object.values(EVENT)) {
      this.pi.registerMessageRenderer(event, (message, _options, theme) => {
        const details = message.details as { status?: string; summary?: string; ownerAgentId?: string } | undefined;
        const colour = details?.status === "completed" ? "success" : details?.status === "failed" ? "error" : "warning";
        const owner = details?.ownerAgentId ? `[agent ${details.ownerAgentId}] ` : "";
        return new Text(theme.fg(colour, `${owner}${details?.summary ?? String(message.content)}`), 0, 0);
      });
    }
    this.pi.registerCommand("stuck-watchdog", {
      description: "Inspect or toggle unified Jev-based semantic stall detection",
      handler: async (args, ctx) => {
        const [action = "status", id] = args.trim().split(/\s+/, 2);
        const watchdog = this.registry.watchdog!;
        if (action === "on" || action === "off") {
          watchdog.setEnabled(action === "on");
          ctx.ui.notify(`Semantic stuck watchdog ${action === "on" ? "enabled" : "disabled; no jobs were changed"}.`, "info");
          return;
        }
        if (action === "check") {
          if (!id) { ctx.ui.notify("Usage: /stuck-watchdog check <job-id>", "warning"); return; }
          await watchdog.inspectNow(id, ctx);
          return;
        }
        if (action === "log" || action === "stats") {
          const path = watchdog.trace?.path;
          if (!path) { ctx.ui.notify("Watchdog tracing is disabled (PI_PATTY_WATCHDOG_LOG=0).", "warning"); return; }
          const report = await readWatchdogTrace(path);
          ctx.ui.notify(report ? formatWatchdogTraceStats(report.stats) : `No watchdog trace yet at ${path}.`, "info");
          return;
        }
        const items = watchdog.status();
        const lines = items.map(item => `${item.jobId} age=${item.ageSeconds}s${item.verdict ? ` stuck=${item.verdict.stuck.toFixed(2)} cause=${item.verdict.likelyCause}` : " unchecked"}`);
        ctx.ui.notify(`Semantic stuck watchdog is ${watchdog.isEnabled() ? "on" : "off"}. Tracking ${items.length} job(s).${lines.length ? `\n${lines.join("\n")}` : ""}\nTrace: ${watchdog.trace?.path ?? "disabled"} (use /stuck-watchdog stats)`, "info");
      },
    });
    this.pi.on("session_start", async (_event, ctx) => {
      if (this.registry.disposed) {
        if ([...this.storage.values()].some(job => job.status === "running")) throw new Error("Cannot restart job runtime while old jobs remain unconfirmed");
        this.registry.generation++;
        this.registry.disposed = false;
        this.registry.watchdog = createJobWatchdog(this.pi, this.registry);
        for (const owner of this.owners.values()) owner.registry.watchdog = this.registry.watchdog;
      }
      this.ctx = ctx;
      this.root.sessionId = ctx.sessionManager.getSessionId();
      this.root.cwd = ctx.cwd;
      this.root.stopped = false;
    });
    this.pi.on("session_shutdown", async () => { await this.dispose(); });
  }

  /** Passed by the runner as a builtin inline extension: no sibling dependency,
   * no second manager, and no global lookup that can bind to the wrong parent. */
  childExtension(agentId: string): InlineExtension {
    return { name: JOB_RUNTIME_EXTENSION, factory: pi => this.install(pi, this.owner(agentId)) };
  }

  private install(pi: ExtensionAPI, owner: Owner): void {
    const registerTool: ExtensionAPI["registerTool"] = tool => {
      pi.registerTool({
        ...tool,
        execute: async (id, params, signal, update, ctx) => {
          // Stopped owners cannot start processes, but inspection/kill/cleanup
          // must remain available for an unconfirmed termination or retained log.
          if ((this.registry.disposed || owner.stopped) && tool.name !== "jobs") throw new Error("Job owner has stopped");
          owner.cwd = ctx.cwd;
          owner.sessionId = ctx.sessionManager.getSessionId();
          return tool.execute(id, params, signal, update, ctx);
        },
      });
    };
    // Child notices always go to the parent. They never start a free-floating
    // child prompt after runAgent's original promise has resolved.
    const sendMessage: ExtensionAPI["sendMessage"] = (message, options) => {
      this.pi.sendMessage({
        ...message,
        content: owner.agentId && typeof message.content === "string"
          ? `[agent ${owner.agentId}]\n${message.content}` : message.content,
      }, options);
    };
    const scopedPi = new Proxy(pi, { get: (target, key) => {
      if (key === "registerTool") return registerTool;
      if (key === "sendMessage") return sendMessage;
      return Reflect.get(target, key);
    } });
    const reg = owner.registry;
    reg.watchdog = this.registry.watchdog;
    registerBashTool(scopedPi, reg, createBashToolDefinition(process.cwd()));
    registerBashBgTool(scopedPi, reg);
    registerJobsTool(scopedPi, reg);
    registerMonitorTool(scopedPi, reg);
    if (!/^(1|true|yes)$/i.test(process.env.PI_PATTY_DISABLE_AGENT_BG ?? "")) registerAgentBgTool(scopedPi, reg);
    registerInputHandlers(scopedPi, reg);
    if (owner.agentId) pi.on("session_shutdown", async () => {
      // Session GC is not job/log eviction. The parent owns the storage.
      stopSidebarTicker(reg);
    });
  }

  hasRunning(agentId: string): boolean {
    return [...this.storage.values()].some(job => job.ownerAgentId === agentId && job.status === "running");
  }

  /** Used only while the session is idle in the runner's managed job-drain
   * phase. Streaming steers still go through session.steer/input normally. */
  offerSteer(agentId: string, message: string): boolean {
    const owner = this.owners.get(agentId);
    if (!owner || owner.stopped || (!owner.draining && !this.hasRunning(agentId))) return false;
    owner.steers.push(message);
    this.registry.onChange?.();
    return true;
  }

  /** Hold the ORIGINAL runAgent/resumeAgent promise and subscriptions until
   * jobs settle. A steer during the drain starts a managed continuation within
   * that promise, never an untracked pi.sendUserMessage callback. */
  async drain(agentId: string, session: AgentSession, signal?: AbortSignal, shouldStop?: () => boolean): Promise<void> {
    const owner = this.owner(agentId);
    owner.draining = true;
    const keepAlive = setInterval(() => {}, 1000);
    const wakeOnAbort = () => this.registry.onChange?.();
    signal?.addEventListener("abort", wakeOnAbort, { once: true });
    try {
      for (;;) {
        if (signal?.aborted || owner.stopped || shouldStop?.()) {
          if (!await this.stopOwner(agentId)) throw new Error(`Could not terminate jobs owned by ${agentId}`);
          return;
        }
        const steer = owner.steers.shift();
        if (steer !== undefined) { await session.prompt(steer); continue; }
        if (!this.hasRunning(agentId)) return;
        await new Promise<void>(resolve => {
          const wake = () => { this.changed.delete(wake); resolve(); };
          this.changed.add(wake);
          // Registration and state check happen without an await: no missed
          // wake between observing a running job and arming the listener.
          if (signal?.aborted || owner.stopped || owner.steers.length || !this.hasRunning(agentId)) wake();
        });
      }
    } finally {
      owner.draining = false;
      clearInterval(keepAlive);
      signal?.removeEventListener("abort", wakeOnAbort);
    }
  }

  /** Stop owns processes; steering owns waits. Stop never discards captures. */
  stopOwner(agentId: string): Promise<boolean> {
    const owner = this.owner(agentId);
    if (owner.termination) return owner.termination;
    owner.stopped = true;
    owner.steers = [];
    // Release attach waits as well as foreground waits while the model aborts.
    if (this.ctx) pauseAllForeground(owner.registry, this.ctx);
    else { for (const slot of owner.registry.foreground.values()) slot.requestPause("manual"); }
    this.registry.onChange?.();
    owner.termination = Promise.all([...owner.registry.jobs.values()]
      .filter(job => job.status === "running")
      .map(job => terminateJobSilently(owner.registry, job)))
      .then(stopped => stopped.every(Boolean));
    void owner.termination.then(stopped => { if (!stopped) owner.termination = undefined; });
    return owner.termination;
  }

  async stopAll(): Promise<boolean> {
    this.root.stopped = true;
    for (const owner of this.owners.values()) owner.stopped = true;
    this.registry.onChange?.();
    const stopped = await Promise.all([...this.storage.values()]
      .filter(job => job.status === "running")
      .map(job => terminateJobSilently(this.registry, job)));
    for (const owner of [this.root, ...this.owners.values()]) stopSidebarTicker(owner.registry);
    if (this.ctx) renderSidebar(this.registry, this.ctx);
    return stopped.every(Boolean);
  }

  async dispose(): Promise<void> {
    if (this.registry.disposed) return;
    const stopped = await this.stopAll();
    this.registry.disposed = true;
    this.registry.generation++;
    this.registry.watchdog?.dispose();
    this.registry.onChange?.();
    this.ctx = undefined;
    if (!stopped) throw new Error("Job termination unconfirmed at shutdown; captures retained and live worktrees must not be removed");
  }
}
