import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { setGraceTurns } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { processExists } from "../src/jobs/patty/spawn.js";
import { JobRuntime } from "../src/jobs/runtime.js";
import type { AgentConfig } from "../src/types.js";
import { UserSteerBroker } from "../src/user-steer.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { jobHost, textOf, until } from "./helpers/job-runtime.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

const exec = promisify(execFile);
vi.setConfig({ testTimeout: 30000 });

describe("fused jobs through the real SDK runner/manager lifecycle", () => {
  let cwd: string;
  let home: string;
  let main: ReturnType<typeof jobHost>;
  let pi: ExtensionAPI;
  let ctx: ExtensionContext;
  let runtime: JobRuntime;
  let manager: AgentManager;
  let faux: ReturnType<typeof registerFauxProvider>;
  const completed = vi.fn();

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "fusion-sdk-repo-"));
    home = mkdtempSync(join(tmpdir(), "fusion-sdk-home-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_SUBAGENTS_JOB_RUNTIME", "1");
    vi.stubEnv("PI_PATTY_WATCHDOG_LOG", "0");
    vi.stubEnv("PI_PATTY_WATCHDOG", "0");
    // Fixture-only git repository, never either plugin's working tree.
    await exec("git", ["init", "-q", cwd]);
    await exec("git", ["-C", cwd, "config", "user.name", "Test Fixture"]);
    await exec("git", ["-C", cwd, "config", "user.email", "test@example.invalid"]);
    writeFileSync(join(cwd, "tracked.txt"), "unchanged\n");
    await exec("git", ["-C", cwd, "add", "tracked.txt"]);
    await exec("git", ["-C", cwd, "commit", "-q", "-m", "fixture"]);
    main = jobHost(cwd);
    pi = Object.assign(main.pi, {
      exec: async (command: string, args: string[], options: { cwd?: string; timeout?: number } = {}) => {
        try {
          const result = await exec(command, args, { cwd: options.cwd ?? cwd, timeout: options.timeout });
          return { code: 0, killed: false, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          const result = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
          return { code: typeof result.code === "number" ? result.code : 1, killed: result.killed ?? false, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
        }
      },
    });
    runtime = new JobRuntime(pi);
    runtime.installRoot();
    await main.emit("session_start");
    completed.mockClear();
    manager = new AgentManager(completed);
    manager.setJobRuntime(runtime);
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-fusion", contextWindow: 200000 }] });
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    // Real ExtensionContext exposes the runtime behind its registry facade.
    backend.modelRegistry.runtime = backend.modelRuntime;
    ctx = {
      ...main.ctx, model, ...backend, getSystemPrompt: () => "PARENT", hasUI: false,
    } as unknown as ExtensionContext;
    registerAgents(new Map([["fusion-sdk", {
      name: "fusion-sdk", description: "SDK ownership test", systemPrompt: "You are a shell test.", promptMode: "replace",
      builtinToolNames: ["read", "write", "edit", "bash"], skills: false, extensions: true, isolated: false,
      inheritContext: false, runInBackground: true,
    } as AgentConfig]]));
  });

  afterEach(async () => {
    setGraceTurns(5);
    manager.abortAll();
    await runtime.dispose();
    await manager.waitForAll();
    await manager.dispose();
    faux.unregister();
    for (const job of runtime.registry.jobs.values()) {
      expect(job.status).not.toBe("running");
      rmSync(job.logPath, { force: true });
      rmSync(job.logPath.replace(/\.log$/, ".err"), { force: true });
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function script(command: string, runInBackground = false) {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command, run_in_background: runInBackground })),
      fauxAssistantMessage("model finished but owned shell is still alive"),
      fauxAssistantMessage("managed continuation finished"),
    ]);
  }
  function spawn(worktree = true, cleanup?: () => void) {
    return manager.spawn(pi, ctx, "fusion-sdk", "run the shell", {
      isBackground: true, isolation: worktree ? "worktree" : "off", configCwd: cwd,
      onBeforeWorktreeCleanup: cleanup,
    });
  }

  it("quick steer preserves the original run promise and worktree, then idle steering stays in that same managed run", async () => {
    const marker = join(home, "started");
    const release = join(home, "release");
    script(`printf 'SDK_BEGIN\\n'; printf yes > '${marker}'; while [ ! -e '${release}' ]; do sleep 0.05; done; printf 'SDK_FINAL\\n'`);
    let cleanupCalled = false;
    const id = spawn(true, () => {
      cleanupCalled = true;
      const jobs = [...runtime.registry.jobs.values()].filter(job => job.ownerAgentId === id);
      expect(jobs.every(job => job.status !== "running" && !processExists(job.pid))).toBe(true);
    });
    await manager.awaitStartup(id);
    await until(() => existsSync(marker));
    const record = manager.getRecord(id)!;
    const originalPromise = record.promise;
    const tree = record.worktree!.path;
    const signal = record.abortController!.signal;
    const start = Date.now();
    expect(await manager.steerChecked(id, "  SDK user steer  ")).toBe(true);
    await until(() => faux.state.callCount >= 2 && !!record.session?.isIdle);
    expect(Date.now() - start).toBeLessThan(1800);
    expect(record.status).toBe("running");
    expect(record.promise).toBe(originalPromise);
    expect(existsSync(tree)).toBe(true);
    expect(cleanupCalled).toBe(false);
    expect(completed).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(false);
    expect([...runtime.registry.jobs.values()].some(job => job.ownerAgentId === id && job.status === "running")).toBe(true);
    expect(await manager.steerChecked(id, "idle continuation steer")).toBe(true);
    await until(() => faux.state.callCount === 3 && !!record.session?.isIdle);
    expect(record.promise).toBe(originalPromise);
    expect(record.status).toBe("running");
    writeFileSync(release, "go");
    await originalPromise;
    expect(record.status).toBe("completed");
    expect(record.result).toContain("managed continuation finished");
    expect(cleanupCalled).toBe(true);
    expect(existsSync(tree)).toBe(false);
    expect(completed).toHaveBeenCalledTimes(1);
    const job = [...runtime.registry.jobs.values()].find(job => job.ownerAgentId === id)!;
    expect(textOf(await main.execute("jobs", { action: "output", jobId: job.id }))).toContain("SDK_FINAL");
    expect(main.notices.filter(notice => notice.customType === "task-notification")).toHaveLength(1);
    const userTexts = record.session!.messages.filter(message => message.role === "user").map(message => JSON.stringify(message));
    expect(userTexts.join("\n")).toContain("  SDK user steer  ");
    expect(userTexts.join("\n")).toContain("idle continuation steer");
  });

  it.each([false, true])("hard cap during managed drain stops owned jobs and counts this invocation (resume=%s)", async (resume) => {
    setGraceTurns(1);
    faux.setResponses([fauxAssistantMessage("initial run done")]);
    const counts: number[] = [];
    let id: string;
    if (resume) {
      id = spawn(false);
      await manager.awaitStartup(id);
      await manager.getRecord(id)!.promise;
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("bash", { command: "echo CAP_CAPTURE; sleep 30", run_in_background: true })),
        fauxAssistantMessage("draining"),
        fauxAssistantMessage("soft ceiling continuation"),
        fauxAssistantMessage("hard ceiling continuation"),
      ]);
      await manager.resume(id, "resume with owned jobs", undefined, { isBackground: true, maxTurns: 3, onTurnEnd: count => counts.push(count) });
    } else {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("bash", { command: "echo CAP_CAPTURE; sleep 30", run_in_background: true })),
        fauxAssistantMessage("draining"),
        fauxAssistantMessage("soft ceiling continuation"),
        fauxAssistantMessage("hard ceiling continuation"),
      ]);
      id = manager.spawn(pi, ctx, "fusion-sdk", "owned jobs with cap", {
        isBackground: true, isolation: "worktree", configCwd: cwd, maxTurns: 3,
        onTurnEnd: count => counts.push(count),
      });
      await manager.awaitStartup(id);
    }
    const record = manager.getRecord(id)!;
    const tree = record.worktree?.path;
    await until(() => counts.length === 2 && !!record.session?.isIdle && runtime.hasRunning(id));
    const originalPromise = record.promise;
    expect(await manager.steerChecked(id, "continue inside drain")).toBe(true);
    await originalPromise;
    expect(counts).toEqual([1, 2, 3, 4]);
    expect(record.status).toBe("aborted");
    expect(runtime.hasRunning(id)).toBe(false);
    if (tree) expect(existsSync(tree)).toBe(false);
    const job = [...runtime.registry.jobs.values()].find(job => job.ownerAgentId === id)!;
    expect(processExists(job.pid)).toBe(false);
    expect(existsSync(job.logPath)).toBe(true);
  });

  it("provider failure stops owned background shells before error settlement and worktree cleanup", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo ERROR_CAPTURE; sleep 30", run_in_background: true })),
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "scripted provider error" }),
    ]);
    const id = spawn();
    await manager.awaitStartup(id);
    const record = manager.getRecord(id)!;
    const tree = record.worktree!.path;
    await record.promise;
    expect(record.status).toBe("error");
    expect(record.error).toContain("scripted provider error");
    expect(runtime.hasRunning(id)).toBe(false);
    expect(existsSync(tree)).toBe(false);
    const job = [...runtime.registry.jobs.values()].find(job => job.ownerAgentId === id)!;
    expect(processExists(job.pid)).toBe(false);
    expect(existsSync(job.logPath)).toBe(true);
  });

  it("explicit stop kills descendants and completes the managed promise before deleting a live worktree", async () => {
    const marker = join(home, "stop-started");
    script(`trap '' TERM; echo STOP_CAPTURE; printf yes > '${marker}'; sleep 30`, true);
    const id = spawn();
    await manager.awaitStartup(id);
    const record = manager.getRecord(id)!;
    const tree = record.worktree!.path;
    await until(() => existsSync(marker));
    expect(manager.abort(id)).toBe(true);
    expect(existsSync(tree)).toBe(true);
    await record.promise;
    expect(record.status).toBe("stopped");
    expect(runtime.hasRunning(id)).toBe(false);
    expect(existsSync(tree)).toBe(false);
    const job = [...runtime.registry.jobs.values()].find(job => job.ownerAgentId === id)!;
    expect(readFileSync(job.logPath, "utf8")).toContain("STOP_CAPTURE");
    expect(processExists(job.pid)).toBe(false);
  });

  it("real third-party tools retain their signal and finish normally before a steer reaches the next model call", async () => {
    const marker = join(home, "external-started");
    const release = join(home, "external-release");
    const aborted = join(home, "external-aborted");
    const extension = join(home, "slow-external.mjs");
    writeFileSync(extension, `import { Type } from '@earendil-works/pi-ai';
import { existsSync, writeFileSync } from 'node:fs';
export default function(pi) {
  pi.registerTool({ name: 'external_long', label: 'external', description: 'long external tool', parameters: Type.Object({}),
    async execute(_id, _p, signal) {
      const abort = () => writeFileSync(${JSON.stringify(aborted)}, 'aborted');
      signal?.addEventListener('abort', abort);
      writeFileSync(${JSON.stringify(marker)}, 'started');
      while (!existsSync(${JSON.stringify(release)})) await new Promise(r => setTimeout(r, 10));
      signal?.removeEventListener('abort', abort);
      return { content: [{type: 'text', text: 'EXTERNAL_FINISHED_NORMALLY'}], details: undefined };
    }
  });
}`);
    registerAgents(new Map([["fusion-sdk", {
      name: "fusion-sdk", description: "SDK external test", systemPrompt: "External test", promptMode: "replace",
      builtinToolNames: ["read", "write"], skills: false, extensions: [extension, "pi-subagents-jobs"], isolated: false,
      inheritContext: false, runInBackground: true,
    } as AgentConfig]]));
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("external_long", {})),
      fauxAssistantMessage("external tool finished then steer was processed"),
    ]);
    const id = spawn(false);
    await manager.awaitStartup(id);
    const record = manager.getRecord(id)!;
    await until(() => existsSync(marker));
    expect(await manager.steerChecked(id, "must wait for external tool")).toBe(true);
    expect(record.abortController!.signal.aborted).toBe(false);
    expect(existsSync(aborted)).toBe(false);
    expect(faux.state.callCount).toBe(1);
    expect(record.status).toBe("running");
    writeFileSync(release, "go");
    await record.promise;
    expect(existsSync(aborted)).toBe(false);
    expect(record.status).toBe("completed");
    expect(record.result).toContain("external tool finished then steer was processed");
  });

  it("UI steering releases a real child bash while its busy parent receives one steer and keeps a third-party tool signal intact", async () => {
    await runtime.dispose();
    let parentPi!: ExtensionAPI;
    let parentStarted = false;
    let parentSignal: AbortSignal | undefined;
    let releaseParent!: () => void;
    const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
    const marker = join(home, "ui-child-started");
    const release = join(home, "ui-child-release");
    const loader = new DefaultResourceLoader({ cwd, agentDir: home, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noContextFiles: true, noThemes: true,
      extensionFactories: [{ name: "ui-parent-host", factory: api => {
        parentPi = api;
        runtime = new JobRuntime(api);
        runtime.installRoot();
        manager.setJobRuntime(runtime);
        api.registerTool({ name: "parent_external", label: "parent external", description: "blocked external parent tool", parameters: Type.Object({}),
          execute: async (_id, _params, signal) => {
            parentSignal = signal;
            parentStarted = true;
            await parentGate;
            return { content: [{ type: "text", text: "parent external finished normally" }], details: undefined };
          },
        });
      } }],
    });
    await loader.reload();
    const backend = fauxModelBackend(faux.getModel());
    const { session: parent } = await createAgentSession({ cwd, agentDir: home, model: faux.getModel(),
      modelRuntime: backend.modelRuntime, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    });
    await parent.bindExtensions({});
    ctx = parent.extensionRunner!.createContext();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("parent_external", {})),
      fauxAssistantMessage(fauxToolCall("bash", { command: `printf yes > '${marker}'; while [ ! -e '${release}' ]; do sleep 0.05; done; echo UI_CAPTURE_FINAL` })),
      fauxAssistantMessage("child processed original UI text"),
      fauxAssistantMessage("parent processed forwarded user steer"),
      fauxAssistantMessage("parent acknowledged one task completion"),
    ]);
    const parentPrompt = parent.prompt("run parent external tool");
    try {
      await until(() => parentStarted);
      const id = manager.spawn(parentPi, ctx, "fusion-sdk", "run child bash", { isBackground: true, isolation: "off", configCwd: cwd });
      await manager.awaitStartup(id);
      await until(() => existsSync(marker));
      const record = manager.getRecord(id)!;
      const broker = new UserSteerBroker(manager);
      const original = "  UI 原文\nkeep all whitespace  ";
      const receipt = await broker.send(id, original, parent);
      expect(receipt.parentPending).toBe(false);
      const queued = parent.getSteeringMessages();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toContain(id);
      const payload = JSON.parse(queued[0].slice(queued[0].indexOf("\n") + 1, queued[0].lastIndexOf("\n"))) as { originalUserMessage: string };
      expect(payload.originalUserMessage).toBe(original);
      expect(parentSignal?.aborted).toBe(false);
      expect(record.abortController!.signal.aborted).toBe(false);
      expect(parent.isStreaming).toBe(true);
      await until(() => faux.state.callCount === 3 && !!record.session?.isIdle);
      expect(record.status).toBe("running");
      await broker.retry(id);
      expect(parent.getSteeringMessages()).toHaveLength(1);
      writeFileSync(release, "go");
      await record.promise;
      expect(record.status).toBe("completed");
      releaseParent();
      await parentPrompt;
      expect(parentSignal?.aborted).toBe(false);
      const userMessages = parent.messages.filter(message => message.role === "user").map(message => JSON.stringify(message));
      expect(userMessages.filter(message => message.includes("[USER DIRECT SUBAGENT STEER]"))).toHaveLength(1);
    } finally {
      writeFileSync(release, "go");
      releaseParent();
      manager.abortAll();
      await manager.waitForAll();
      await parent.abort();
      await parentPrompt.catch(() => {});
      await runtime.dispose();
      parent.dispose();
    }
  });
});
