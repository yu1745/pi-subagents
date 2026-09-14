import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import extension from "../src/index.js";
import { ResumeStore, validateResumeSession } from "../src/resume-store.js";
import { ctx, flush, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let home: ReturnType<typeof hermeticDir>;
let parent: SessionManager;
let boots: ReturnType<typeof makePi>[];
let managers: AgentManager[];

beforeEach(() => {
  home = hermeticDir({ settings: { outputTranscript: false, schedulingEnabled: false, workflowsEnabled: false } });
  parent = SessionManager.create(home.dir, join(home.dir, "sessions"));
  boots = [];
  managers = [];
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, prompt, options) => {
    await Promise.resolve();
    const sm = options.resumeSessionFile ? SessionManager.open(options.resumeSessionFile) : SessionManager.create(home.dir, join(home.dir, "children"));
    const session = {
      sessionManager: sm, messages: sm.buildSessionContext().messages,
      dispose: vi.fn(), subscribe: () => () => {}, steer: async () => {},
    } as unknown as AgentSession;
    options.onSessionCreated?.(session);
    sm.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
    sm.appendMessage(fauxAssistantMessage("historical answer"));
    return { session, responseText: "historical answer", aborted: false, steered: false };
  });
});

afterEach(async () => {
  for (const boot of boots) await boot.lifecycle.get("session_shutdown")?.();
  for (const manager of managers) await manager.dispose();
  home.restore();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function boot(sm = parent) {
  const b = makePi();
  boots.push(b);
  extension(b.pi);
  const context = ctx({ sessionManager: sm });
  await b.lifecycle.get("session_start")({}, context);
  return { ...b, context };
}

async function spawn(b: Awaited<ReturnType<typeof boot>>) {
  const response = await b.tools.get("Agent").execute("spawn", {
    subagent_type: "general-purpose", prompt: "historical user", description: "Original", name: "audit", isolated: true, run_in_background: false,
  }, undefined, undefined, b.context);
  return response.details.agentId as string;
}

it("fresh extension recovers original ID, handles and historical messages, ignoring caller placeholders", async () => {
  const first = await boot();
  const id = await spawn(first);
  await first.lifecycle.get("session_shutdown")();
  const second = await boot();
  vi.mocked(runAgent).mockClear();
  const response = await second.tools.get("Agent").execute("resume", {
    resume: id, subagent_type: "nonexistent-placeholder", model: "invalid/model", isolated: false,
    prompt: "continue", description: "Not original", run_in_background: false,
  }, undefined, undefined, second.context);
  expect(response.details.agentId).toBe(id);
  expect(response.details.description).toBe("Original");
  const call = vi.mocked(runAgent).mock.calls[0];
  expect(call[1]).toBe("general-purpose");
  expect(call[3]).toMatchObject({ agentId: id, isolated: true, inheritContext: false });
  const sm = SessionManager.open(call[3].resumeSessionFile!);
  expect(JSON.stringify(sm.buildSessionContext().messages)).toContain("historical user");
  expect(JSON.stringify(sm.buildSessionContext().messages)).toContain("continue");
  const saved = new ResumeStore(parent.getSessionFile()!, parent.getSessionId()).list()[0];
  expect(saved).toMatchObject({ id, handle: "general-purpose", alias: "audit" });
});

it("fresh extension uses the same cold path for @alias", async () => {
  const first = await boot();
  const id = await spawn(first);
  await first.lifecycle.get("session_shutdown")();
  const second = await boot();
  vi.mocked(runAgent).mockClear();
  await second.lifecycle.get("input")({ source: "interactive", text: "@audit continue" }, second.context);
  await flush();
  expect(vi.mocked(runAgent).mock.calls[0][3].agentId).toBe(id);
  expect(second.context.ui.notify).toHaveBeenCalledWith("Resuming @audit", "info");
});

it("GC retains the original ID without a live session", async () => {
  const manager = new AgentManager();
  managers.push(manager);
  manager.configurePersistence(parent.getSessionFile(), parent.getSessionId());
  const { id } = await manager.spawnAndWait(makePi().pi, ctx(), "general-purpose", "one", { description: "original" });
  vi.useFakeTimers();
  // The interval predates fake timers; invoke the real GC boundary deterministically.
  vi.setSystemTime(Date.now() + 11 * 60000);
  const gc = manager as unknown as { cleanup(): void };
  gc.cleanup();
  expect(manager.getRecord(id)).toBeUndefined();
  const target = manager.resolveMention(id);
  expect(target?.kind).toBe("tombstone");
  if (target?.kind !== "tombstone") throw new Error("missing descriptor");
  const restored = await manager.spawnAndWait(makePi().pi, ctx(), target.entry.type, "two", { description: "ignored", restore: target.entry });
  expect(restored.id).toBe(id);
});

it.each(["missing", "corrupt", "wrong-id"])("refuses %s child files without replacing them", async (kind) => {
  const first = await boot();
  const id = await spawn(first);
  const saved = new ResumeStore(parent.getSessionFile()!, parent.getSessionId()).list()[0];
  await first.lifecycle.get("session_shutdown")();
  if (kind === "missing") unlinkSync(saved.sessionFile);
  else if (kind === "corrupt") writeFileSync(saved.sessionFile, "broken json\n");
  else writeFileSync(saved.sessionFile, readFileSync(saved.sessionFile, "utf8").replace(saved.resumeState!.sessionId, "wrong"));
  const bytes = kind === "missing" ? undefined : readFileSync(saved.sessionFile, "utf8");
  const second = await boot();
  vi.mocked(runAgent).mockClear();
  await expect(second.tools.get("Agent").execute("resume", {
    resume: id, subagent_type: "Plan", prompt: "continue", description: "resume", run_in_background: false,
  }, undefined, undefined, second.context)).rejects.toThrow("Cannot resume session");
  expect(runAgent).not.toHaveBeenCalled();
  expect(kind === "missing" ? undefined : readFileSync(saved.sessionFile, "utf8")).toBe(bytes);
  if (kind === "missing") expect(existsSync(saved.sessionFile)).toBe(false);
});

it("ephemeral parent has no durable registry; another parent cannot resolve old IDs", async () => {
  const first = await boot(SessionManager.inMemory(home.dir));
  const id = await spawn(first);
  expect(existsSync(join(home.dir, "sessions", "subagents"))).toBe(false);
  await first.lifecycle.get("session_shutdown")();
  const second = await boot();
  const response = await second.tools.get("Agent").execute("resume", {
    resume: id, subagent_type: "Plan", prompt: "continue", description: "resume",
  }, undefined, undefined, second.context);
  expect(textOf(response)).toContain("original parent session");
});

it("registry is owner-only, uncapped and fails closed on corrupt input", async () => {
  const b = await boot();
  await spawn(b);
  const store = new ResumeStore(parent.getSessionFile()!, parent.getSessionId());
  const original = store.list()[0];
  for (let i = 0; i < 102; i++) store.put({ ...original, id: `id-${i}`, handle: `agent-${i}`, alias: undefined });
  expect(new ResumeStore(parent.getSessionFile()!, parent.getSessionId()).list()).toHaveLength(103);
  expect(statSync(store.path).mode & 0o777).toBe(0o600);
  writeFileSync(store.path, "{}");
  expect(() => new ResumeStore(parent.getSessionFile()!, parent.getSessionId())).toThrow("Cannot load resume registry");
});

it("refuses overlapping foreground resumes and spawns after shutdown", async () => {
  const manager = new AgentManager();
  managers.push(manager);
  const { id } = await manager.spawnAndWait(makePi().pi, ctx(), "general-purpose", "one", { description: "original" });
  let finish!: (value: { text: string }) => void;
  vi.mocked(resumeAgent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = manager.resume(id, "two");
  expect(await manager.resume(id, "three")).toBeUndefined();
  expect(resumeAgent).toHaveBeenCalledTimes(1);
  finish({ text: "done" });
  await first;
  await manager.dispose();
  expect(() => manager.spawn(makePi().pi, ctx(), "Plan", "four", { description: "late" })).toThrow("shutting down");
});

it("validates a cold session again after it waits in the background queue", async () => {
  const manager = new AgentManager(undefined, 1);
  managers.push(manager);
  const { id } = await manager.spawnAndWait(makePi().pi, ctx(), "general-purpose", "one", { description: "original" });
  manager.getRecord(id)!.completedAt = 0;
  (manager as unknown as { cleanup(): void }).cleanup();
  const target = manager.resolveMention(id);
  if (target?.kind !== "tombstone") throw new Error("missing descriptor");
  let finish!: (value: Awaited<ReturnType<typeof runAgent>>) => void;
  vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  manager.spawn(makePi().pi, ctx(), "Plan", "held", { description: "held", isBackground: true });
  const recovered = manager.spawn(makePi().pi, ctx(), target.entry.type, "two", { description: "ignored", restore: target.entry, isBackground: true });
  expect(recovered).toBe(id);
  expect(manager.getRecord(id)?.status).toBe("queued");
  expect(() => manager.spawn(makePi().pi, ctx(), target.entry.type, "duplicate", { description: "duplicate", restore: target.entry })).toThrow("still running");
  unlinkSync(target.entry.sessionFile);
  finish({ session: {} as AgentSession, responseText: "done", aborted: false, steered: false });
  await flush();
  expect(manager.getRecord(id)?.error).toContain("Cannot resume session");
  expect(existsSync(target.entry.sessionFile)).toBe(false);
});

it("reserves the pool slot before cold recovery yields to session teardown", async () => {
  const manager = new AgentManager(undefined, 1);
  managers.push(manager);
  const a = await manager.spawnAndWait(makePi().pi, ctx(), "general-purpose", "a", { description: "a" });
  const b = await manager.spawnAndWait(makePi().pi, ctx(), "general-purpose", "b", { description: "b" });
  manager.getRecord(a.id)!.completedAt = 0;
  manager.getRecord(b.id)!.completedAt = 0;
  (manager as unknown as { cleanup(): void }).cleanup();
  const ta = manager.resolveMention(a.id);
  const tb = manager.resolveMention(b.id);
  if (ta?.kind !== "tombstone" || tb?.kind !== "tombstone") throw new Error("missing descriptors");
  const finishes: ((value: Awaited<ReturnType<typeof runAgent>>) => void)[] = [];
  vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
  manager.spawn(makePi().pi, ctx(), "Plan", "held", { description: "held", isBackground: true });
  manager.spawn(makePi().pi, ctx(), ta.entry.type, "resume a", { description: "a", restore: ta.entry, isBackground: true });
  manager.spawn(makePi().pi, ctx(), tb.entry.type, "resume b", { description: "b", restore: tb.entry, isBackground: true });
  const done = { session: {} as AgentSession, responseText: "done", aborted: false, steered: false };
  finishes[0](done);
  await flush();
  expect(manager.getRecord(a.id)?.status).toBe("running");
  expect(manager.getRecord(b.id)?.status).toBe("queued");
  expect(finishes).toHaveLength(2);
  finishes[1](done);
  await flush();
  expect(finishes).toHaveLength(3);
  finishes[2](done);
  await flush();
});

it("keeps vanished worktrees from falling back to the parent directory", async () => {
  const first = await boot();
  const id = await spawn(first);
  await first.lifecycle.get("session_shutdown")();
  const store = new ResumeStore(parent.getSessionFile()!, parent.getSessionId());
  const saved = store.list()[0];
  store.put({ ...saved, resumeState: { ...saved.resumeState!, cwd: join(home.dir, "vanished-worktree"), worktreeBase: home.dir } });
  const second = await boot();
  vi.mocked(runAgent).mockClear();
  await expect(second.tools.get("Agent").execute("resume", {
    resume: id, subagent_type: "Plan", prompt: "continue", description: "resume",
  }, undefined, undefined, second.context)).rejects.toThrow("does not exist");
  expect(runAgent).not.toHaveBeenCalled();
});

it("surfaces atomic registry write failures rather than promising durability", async () => {
  const first = await boot();
  const store = new ResumeStore(parent.getSessionFile()!, parent.getSessionId());
  // Occupy the intended directory with a file so mkdir fails on every UID.
  writeFileSync(join(home.dir, "sessions", "subagents"), "not a directory");
  const result = await first.tools.get("Agent").execute("spawn", {
    subagent_type: "general-purpose", prompt: "one", description: "one", run_in_background: false,
  }, undefined, undefined, first.context);
  expect(textOf(result)).toContain("Cannot persist resume registry");
  expect(existsSync(store.path)).toBe(false);
});

it("rejects a valid header with corrupt trailing JSON", () => {
  const path = join(home.dir, "bad.jsonl");
  writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "id", cwd: home.dir, timestamp: new Date().toISOString() }) + "\nbroken\n");
  expect(() => validateResumeSession(path, "id")).toThrow("Cannot resume session");
});
