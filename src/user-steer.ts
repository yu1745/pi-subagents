import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agent-manager.js";
import type { AgentRecord } from "./types.js";

export const FORCE_STEER_KEY = "ctrl+alt+s";
export const RETRY_PARENT_STEER_KEY = "ctrl+alt+r";

export interface UserSteerReceipt {
  id: string;
  childQueued: boolean;
  parentPending: boolean;
  error?: string;
}
interface Forward {
  id: string;
  childId: string;
  content: string;
  parentId?: string;
  parentStartedAt?: number;
  main: AgentSession;
  mainSessionId: string;
  sending?: Promise<void>;
}

export function formatUserSteerForward(record: AgentRecord, message: string, id: string): string {
  // JSON preserves original whitespace, newlines, and delimiter-looking text
  // losslessly. This is user-originated control, never a child/tool quotation.
  return `[USER DIRECT SUBAGENT STEER]\n${JSON.stringify({
    userSteerId: id,
    agentId: record.id,
    agentName: record.alias ?? record.handle ?? record.type,
    agentDescription: record.description,
    directParentAgentId: record.parentAgentId ?? "main",
    originalUserMessage: message,
  }, null, 2)}\n[/USER DIRECT SUBAGENT STEER]`;
}

function active(record: AgentRecord | undefined): record is AgentRecord {
  return !!record && (record.status === "running" || record.status === "queued") && !record.abortController?.signal.aborted;
}

/** Only UI calls this broker. Programmatic steering never forwards, preventing
 * duplicate delivery and feedback loops. Partial parent failures are retained
 * in a FIFO in-memory outbox and retried WITHOUT re-steering the child. */
export class UserSteerBroker {
  private outbox = new Map<string, Forward>();
  constructor(private manager: AgentManager) {}

  async send(childId: string, original: string, main: AgentSession): Promise<UserSteerReceipt> {
    if (!original.trim()) throw new Error("Steering message is empty");
    const child = this.manager.getRecord(childId);
    if (!active(child)) throw new Error("Cannot steer: agent is no longer running or queued");
    if (child.rootSessionId && child.rootSessionId !== main.sessionId) throw new Error("Cannot steer: agent belongs to a different main session");
    const parent = child.parentAgentId ? this.manager.getRecord(child.parentAgentId) : undefined;
    if (child.parentAgentId && !active(parent)) throw new Error("Cannot steer: direct parent is no longer running or queued");
    const childQueued = !child.session;
    const id = randomUUID();
    const forward: Forward = {
      id, childId, content: formatUserSteerForward(child, original, id),
      parentId: child.parentAgentId, parentStartedAt: parent?.startedAt,
      main, mainSessionId: main.sessionId,
    };
    if (!await this.manager.steerChecked(childId, original)) throw new Error("Cannot steer: agent finished before delivery");
    this.outbox.set(id, forward);
    try {
      // Preserve FIFO if a previous UI action has a failed parent delivery.
      await this.retry(childId);
      return { id, childQueued, parentPending: false };
    } catch (error) {
      return { id, childQueued, parentPending: this.outbox.has(id), error: this.outbox.has(id) ? (error instanceof Error ? error.message : String(error)) : undefined };
    }
  }

  hasPending(childId: string): boolean { return [...this.outbox.values()].some(item => item.childId === childId); }

  async retry(childId: string): Promise<void> {
    const target = (item: Forward) => item.parentId ?? `main:${item.mainSessionId}`;
    const targets = new Set([...this.outbox.values()].filter(item => item.childId === childId).map(target));
    for (const forward of this.outbox.values()) {
      if (!targets.has(target(forward))) continue;
      // Concurrent retries share a delivery receipt; an acknowledged item is
      // removed before the next entry. Never repeat the child's command.
      forward.sending ??= this.deliver(forward).then(() => { this.outbox.delete(forward.id); });
      try { await forward.sending; }
      catch (error) { forward.sending = undefined; throw error; }
    }
  }

  private async deliver(forward: Forward): Promise<void> {
    if (forward.parentId) {
      const parent = this.manager.getRecord(forward.parentId);
      if (!active(parent) || parent.startedAt !== forward.parentStartedAt) {
        throw new Error(`Direct parent ${forward.parentId} ended or started a different run; forward retained, not rerouted`);
      }
      if (!await this.manager.steerChecked(forward.parentId, forward.content)) throw new Error("Direct parent rejected the forwarded steer");
    } else {
      if (forward.main.sessionId !== forward.mainSessionId) throw new Error("Main session changed; forward retained, not delivered to a different session");
      const result = await forward.main.steer(forward.content);
      if (result === "handled") throw new Error("Main input was intercepted by another extension; forwarding receipt is unconfirmed");
    }
  }
}

const brokers = new WeakMap<AgentManager, UserSteerBroker>();
export function userSteerBroker(manager: AgentManager): UserSteerBroker {
  let broker = brokers.get(manager);
  if (!broker) { broker = new UserSteerBroker(manager); brokers.set(manager, broker); }
  return broker;
}

export function userSteerStatus(receipt: UserSteerReceipt): string {
  const child = receipt.childQueued ? "Child steer queued until ready" : "Child steer sent";
  return receipt.parentPending
    ? `${child}; parent forwarding PENDING: ${receipt.error}. Ctrl+Alt+R retries parent only.`
    : `${child}; direct parent steer queued.`;
}
