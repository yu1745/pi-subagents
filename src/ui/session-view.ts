/** Prefer native readonly viewing; otherwise reuse the existing conversation overlay. */
import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { type AgentActivity, getDisplayName } from "./agent-widget.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";
import { getNativeSessionViewUnavailableReason } from "./native-pi-1.0.0/index.js";

/** Local optional API installed by this plugin's exact Pi 1.0.0 runtime patch. */
export interface SessionViewUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  viewSession?(session: AgentSession, options?: { title?: string; signal?: AbortSignal }): Promise<void>;
  custom?: ExtensionUIContext["custom"];
}

export interface LegacyViewerOptions {
  activity?: AgentActivity;
  showCost?: boolean;
  viewerMarkdown?: () => ViewerMarkdownMode;
  onMarkdownMode?: (mode: ViewerMarkdownMode) => void;
}

export interface SessionViewHandle {
  /** Closes presentation ONLY, never the child's execution. */
  close(): void;
  signal: AbortSignal;
  /** Settles after core has detached and the manager lease has been released. */
  closed: Promise<void>;
}

/** Acquire before yielding: a menu may hold an already-evicted record. */
export function openAgentSessionView(manager: AgentManager, ui: SessionViewUI, record: AgentRecord, legacy: LegacyViewerOptions = {}): SessionViewHandle | undefined {
  const viewSession = ui.viewSession;
  if (typeof viewSession !== "function" && typeof ui.custom !== "function") {
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
      if (lease.signal.aborted) return;
      let reason = lease.unavailableReason ?? getNativeSessionViewUnavailableReason();
      if (typeof viewSession === "function" && !lease.unavailableReason) {
        try {
          await viewSession.call(ui, lease.session, {
            title: `${getDisplayName(record.type)} · ${record.description} · ${record.id}`,
            signal: lease.signal,
          });
          return;
        } catch (error) {
          if (lease.signal.aborted) return;
          reason = error instanceof Error ? error.message : String(error);
        }
      }
      if (typeof ui.custom !== "function") throw new Error(reason);
      ui.notify(`Using the legacy conversation viewer: ${reason}`, "warning");
      if (lease.signal.aborted) return;
      let closeOverlay: (() => void) | undefined;
      const close = () => closeOverlay?.();
      lease.signal.addEventListener("abort", close, { once: true });
      try {
        await ui.custom<undefined>((tui, theme, keybindings, done) => {
          closeOverlay = () => done(undefined);
          const viewer = new ConversationViewer(
            tui, lease.session, record, legacy.activity, theme, done,
            () => {
              if (manager.abort(record.id)) ui.notify(`Stopped "${record.description}".`, "info");
            },
            keybindings, message => manager.steer(record.id, message),
            legacy.showCost, legacy.viewerMarkdown, legacy.onMarkdownMode,
          );
          if (lease.signal.aborted) closeOverlay();
          return viewer;
        }, {
          overlay: true,
          overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
        });
      } finally {
        lease.signal.removeEventListener("abort", close);
      }
    } catch (error) {
      if (!lease.signal.aborted) throw error;
    } finally {
      lease.release();
    }
  });
  return { close: lease.close, signal: lease.signal, closed };
}
