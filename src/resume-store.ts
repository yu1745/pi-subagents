/** Durable, parent-session-scoped descriptors. One active writer per parent. */
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentTombstone } from "./types.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** SDK open() creates a new session for a missing/invalid header: never let it. */
export function validateResumeSession(path: string, sessionId?: string): void {
  try {
    if (!isAbsolute(path)) throw new Error("session path must be absolute");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const header: unknown = JSON.parse(lines[0]);
    if (!object(header) || header.type !== "session" || typeof header.id !== "string" || !header.id
      || typeof header.cwd !== "string" || !isAbsolute(header.cwd)
      || typeof header.timestamp !== "string" || !Number.isFinite(Date.parse(header.timestamp))
      || ![1, 2, 3].includes(header.version as number)) throw new Error("invalid session header");
    if (sessionId !== undefined && header.id !== sessionId) throw new Error(`session ID mismatch (expected ${sessionId})`);
    // Do not silently discard corrupt lines the SDK's tolerant loader would skip.
    for (const line of lines.slice(1)) {
      const entry: unknown = JSON.parse(line);
      if (!object(entry) || typeof entry.type !== "string") throw new Error("invalid session entry");
    }
  } catch (error) {
    throw new Error(`Cannot resume session "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isDescriptor(value: unknown): value is AgentTombstone {
  if (!object(value) || typeof value.id !== "string" || !value.id
    || typeof value.handle !== "string" || !/^[a-z0-9_-]{1,64}$/.test(value.handle)
    || (value.alias !== undefined && (typeof value.alias !== "string" || !/^[a-z0-9_-]{1,64}$/.test(value.alias)))
    || typeof value.type !== "string" || !value.type || typeof value.description !== "string"
    || typeof value.sessionFile !== "string" || !isAbsolute(value.sessionFile)
    || typeof value.completedAt !== "number" || !Number.isFinite(value.completedAt)) return false;
  const state = value.resumeState;
  return object(state) && typeof state.sessionId === "string" && state.sessionId.length > 0
    && typeof state.cwd === "string" && isAbsolute(state.cwd)
    && typeof state.configCwd === "string" && isAbsolute(state.configCwd)
    && typeof state.isolated === "boolean"
    && (state.worktreeBase === undefined || (typeof state.worktreeBase === "string" && isAbsolute(state.worktreeBase)))
    && (state.maxTurns === undefined || (typeof state.maxTurns === "number" && Number.isFinite(state.maxTurns) && state.maxTurns >= 0))
    && (state.thinkingLevel === undefined || ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(state.thinkingLevel as string))
    && (state.invocation === undefined || object(state.invocation));
}

export class ResumeStore {
  readonly path: string;
  private entries = new Map<string, AgentTombstone>();

  constructor(parentFile: string, private parentId: string) {
    if (!isAbsolute(parentFile) || !/^[a-zA-Z0-9_-]+$/.test(parentId)) throw new Error("Invalid parent resume identity");
    this.path = join(dirname(parentFile), "subagents", parentId, "resume-registry.json");
    let text: string;
    try { text = readFileSync(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`Cannot read resume registry ${this.path}: ${String(error)}`);
    }
    try {
      const data: unknown = JSON.parse(text);
      if (!object(data) || data.version !== 1 || data.parentId !== parentId || !Array.isArray(data.agents)) throw new Error("invalid registry envelope");
      const handles = new Set<string>();
      for (const entry of data.agents) {
        if (!isDescriptor(entry) || this.entries.has(entry.id)) throw new Error("invalid or duplicate agent descriptor");
        for (const handle of [entry.handle, entry.alias]) {
          if (handle === undefined) continue;
          if (handles.has(handle)) throw new Error(`duplicate handle ${handle}`);
          handles.add(handle);
        }
        this.entries.set(entry.id, entry);
      }
    } catch (error) {
      throw new Error(`Cannot load resume registry ${this.path}: ${String(error)}`);
    }
  }

  list(): AgentTombstone[] { return [...this.entries.values()]; }

  put(entry: AgentTombstone): void {
    if (!isDescriptor(entry)) throw new Error("Cannot persist invalid resume descriptor");
    const next = new Map(this.entries).set(entry.id, entry);
    const dir = dirname(this.path);
    const temp = join(dir, `.resume-${randomUUID()}.tmp`);
    try {
      mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ version: 1, parentId: this.parentId, agents: [...next.values()] }) + "\n");
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temp, this.path);
      const directory = openSync(dir, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
      this.entries = next;
    } catch (error) {
      try { unlinkSync(temp); } catch { /* no temporary file or already renamed */ }
      throw new Error(`Cannot persist resume registry ${this.path}: ${String(error)}`);
    }
  }
}
