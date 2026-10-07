/** Native readonly child viewing. No session/runtime switch or mutable fallback. */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord } from "../types.js";
import { getDisplayName } from "./agent-widget.js";
import { getNativeSessionViewUnavailableReason } from "./native-pi-1.0.0/index.js";

/** Local optional API installed by this plugin's exact Pi 1.0.0 runtime patch. */
export interface SessionViewUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  viewSession?(session: AgentSession, options?: { title?: string; signal?: AbortSignal }): Promise<void>;
}

export interface SessionViewHandle {
  /** Closes presentation ONLY, never the child's execution. */
  close(): void;
  signal: AbortSignal;
  /** Settles after core has detached and the manager lease has been released. */
  closed: Promise<void>;
}

/** Acquire before yielding: a menu may hold an already-evicted record. */
export function openAgentSessionView(manager: AgentManager, ui: SessionViewUI, record: AgentRecord): SessionViewHandle | undefined {
  const viewSession = ui.viewSession;
  if (typeof viewSession !== "function") {
    ui.notify(getNativeSessionViewUnavailableReason(), "warning");
    return undefined;
  }
  const lease = manager.acquireSessionView(record);
  if (!lease) {
    ui.notify(`Agent is ${record.status === "queued" ? "queued" : "unavailable"} — no session available for viewing.`, "info");
    return undefined;
  }
  // Defer opening one microtask so callers install their close/focus guard
  // first. Even a synchronous open failure must release the pin.
  const closed = Promise.resolve().then(async () => {
    try {
      if (!lease.signal.aborted) {
        if (lease.unavailableReason) throw new Error(lease.unavailableReason);
        await viewSession.call(ui, lease.session, {
          title: `${getDisplayName(record.type)} · ${record.description} · ${record.id}`,
          signal: lease.signal,
        });
      }
    } catch (error) {
      if (!lease.signal.aborted) throw error;
    } finally {
      lease.release();
    }
  });
  return { close: lease.close, signal: lease.signal, closed };
}
