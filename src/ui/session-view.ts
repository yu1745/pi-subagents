/** Prefer native readonly viewing; otherwise reuse the existing conversation overlay. */
import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { userSteerBroker, userSteerStatus } from "../user-steer.js";
import { type AgentActivity, getDisplayName } from "./agent-widget.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";
import { ForceSteerComposer, type ForceSteerOptions } from "./force-steer-composer.js";
import { getNativeSessionViewUnavailableReason } from "./native-pi-1.0.0/index.js";
import type { ReadOnlySessionViewOptions } from "./native-pi-1.0.0/read-only-view.js";

/** Local optional API installed by this plugin's exact Pi 1.0.0 runtime patch. */
export interface SessionViewUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  viewSession?(session: AgentSession, options?: ReadOnlySessionViewOptions & { signal?: AbortSignal }): Promise<void>;
  getSubagentsMainSession?(): AgentSession;
  custom?: ExtensionUIContext["custom"];
}

export interface LegacyViewerOptions {
  activity?: AgentActivity;
  showCost?: boolean;
  viewerMarkdown?: () => ViewerMarkdownMode;
  onMarkdownMode?: (mode: ViewerMarkdownMode) => void;
  initialForceSteer?: boolean;
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
  const broker = userSteerBroker(manager);
  const canSteer = () => {
    const current = manager.getRecord(record.id);
    return current === record && (record.status === "running" || record.status === "queued") && !record.abortController?.signal.aborted;
  };
  const send = async (message: string, main: AgentSession): Promise<string> => {
    try {
      const receipt = await broker.send(record.id, message, main);
      const status = userSteerStatus(receipt);
      ui.notify(status, receipt.parentPending ? "warning" : "info");
      return status;
    } catch (error) {
      ui.notify(`Steer failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      throw error;
    }
  };
  const retryParent = async (): Promise<string> => {
    try {
      await broker.retry(record.id);
      ui.notify("Direct parent forwarding queued; child was not re-steered.", "info");
      return "Direct parent forwarding queued; child was not re-steered.";
    } catch (error) {
      ui.notify(`Parent forwarding still pending: ${error instanceof Error ? error.message : String(error)}`, "error");
      throw error;
    }
  };
  if (!record.session && manager.hasJobRuntime && canSteer()) {
    const main = ui.getSubagentsMainSession?.();
    if (!main || !ui.custom) {
      ui.notify("Cannot compose queued-agent steer: parent-session UI access is unavailable.", "warning");
      return undefined;
    }
    return openQueuedSteerView(ui, record, {
      canSteer, send: message => send(message, main), retryParent,
      hasPendingParent: () => broker.hasPending(record.id), initiallyOpen: legacy.initialForceSteer,
    });
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
            ...(manager.hasJobRuntime ? {
              canSteer,
              initialForceSteer: legacy.initialForceSteer,
              onUserSteer: send,
              retryParentSteer: retryParent,
              hasPendingParentSteer: () => broker.hasPending(record.id),
            } : {}),
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
            manager.hasJobRuntime ? {
              canSteer,
              initiallyOpen: legacy.initialForceSteer,
              send: message => {
                const main = ui.getSubagentsMainSession?.();
                if (!main) return Promise.reject(new Error("Cannot forward user steer: native parent-session access is unavailable"));
                return send(message, main);
              },
              retryParent,
              hasPendingParent: () => broker.hasPending(record.id),
            } : undefined,
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

/** No transcript exists before SDK readiness. Offer the same scoped composer
 * without fabricating a child transcript or retaining a nonexistent session. */
function openQueuedSteerView(ui: SessionViewUI, record: AgentRecord,
  controls: Omit<ForceSteerOptions, "requestRender">): SessionViewHandle {
  const controller = new AbortController();
  let closeOverlay: (() => void) | undefined;
  const close = () => { controller.abort(); closeOverlay?.(); };
  const closed = Promise.resolve().then(async () => {
    if (controller.signal.aborted) return;
    await ui.custom!<undefined>((tui, theme, _keys, done) => {
      closeOverlay = () => done(undefined);
      const composer = new ForceSteerComposer({ ...controls, requestRender: () => tui.requestRender(),
        send: async message => {
          const status = await controls.send(message);
          // End this standard prompt once both queues acknowledge, so it
          // cannot keep main in a UI-prompt wait after successful forwarding.
          if (!controls.hasPendingParent()) done(undefined);
          return status;
        },
      });
      if (controller.signal.aborted) closeOverlay();
      return {
        render: width => [
          ...new Text(theme.fg("accent", `${record.description} · ${record.id} · waiting for SDK session`), 0, 0).render(width),
          ...new Text("Ctrl+Alt+S force steer (queued until ready) · Ctrl+Alt+R retry parent · Esc back", 0, 0).render(width),
          ...composer.render(width),
        ],
        handleInput: data => {
          if (composer.handleInput(data)) return;
          if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) close();
        },
        invalidate: () => composer.invalidate(),
      };
    }, { overlay: true, overlayOptions: { anchor: "center", width: "85%", maxHeight: "60%" } });
  });
  return { close, signal: controller.signal, closed };
}
