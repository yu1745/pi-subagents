import {
  type AgentSession, type AgentSessionEvent, FooterComponent, sessionEntryToContextMessages, type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, ScrollView, Text, type TuiMouseEvent, VStack } from "@earendil-works/pi-tui";
import { assertNativeHost, type NativeFooterData, type NativeHost, NativeTranscript } from "./native-transcript.js";
import { subscribeSessionView } from "./session-snapshot.js";

export interface ReadOnlySessionViewOptions { title?: string }

export class ReadOnlySessionView extends VStack {
  readonly transcript: NativeTranscript;
  readonly scrollView: ScrollView;
  private readonly host: NativeHost;
  private readonly session: AgentSession;
  private readonly back: () => void;
  private readonly footer: FooterComponent;
  private readonly footerData: NativeFooterData;
  private unsubscribe?: () => void;
  private unsubscribeBranch?: () => void;
  private disposed = false;
  private revision = -1;
  private replaying = true;
  private queued: Array<{ event: AgentSessionEvent; revision: number }> = [];
  private readonly renderedEntries = new Set<string>();

  constructor(mode: unknown, session: AgentSession, theme: Theme, back: () => void, options: ReadOnlySessionViewOptions = {}) {
    assertNativeHost(mode);
    const transcript = new NativeTranscript(mode, session);
    const footerData = new mode.footerDataProvider.constructor(session.sessionManager.getCwd());
    const footer = new FooterComponent(session, footerData);
    footer.setAutoCompactEnabled(session.autoCompactionEnabled);
    const dock = new Container();
    dock.addChild({
      render: (width) => new Text(theme.fg("accent", `${options.title ?? session.sessionManager.getSessionName() ?? "Session"} · read-only · Esc/Ctrl-C/q back`), 0, 0).render(width),
      invalidate() {},
    });
    dock.addChild(footer);
    const scrollView = new ScrollView(transcript.container, {
      follow: "end", primary: true, overscroll: "chain", scrollbar: session.settingsManager.getFullscreenScrollbar(),
      scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
      scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
    });
    super([
      { component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
    ]);
    this.host = mode;
    this.session = session;
    this.back = back;
    this.transcript = transcript;
    this.scrollView = scrollView;
    this.footerData = footerData;
    this.footer = footer;
    try {
      this.unsubscribeBranch = footerData.onBranchChange(() => { if (!this.disposed) mode.ui.requestRender(); });
      const subscription = subscribeSessionView(session, (event, revision) => this.onEvent(event, revision));
      this.unsubscribe = subscription.unsubscribe;
      this.revision = subscription.snapshot.revision;
      for (const entry of subscription.snapshot.entries) this.renderedEntries.add(entry.id);
      transcript.replay(subscription.snapshot);
      this.replaying = false;
      const queued = this.queued;
      this.queued = [];
      for (const item of queued) this.onEvent(item.event, item.revision);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private onEvent(event: AgentSessionEvent, revision: number): void {
    if (this.disposed || revision <= this.revision) return;
    if (this.replaying) { this.queued.push({ event, revision }); return; }
    this.revision = revision;
    const r = this.transcript.receiver;
    if (event.type === "compaction_end" && event.result) {
      for (const id of this.transcript.renderCompaction()) this.renderedEntries.add(id);
    } else if (event.type === "entry_appended") {
      const entry = event.entry;
      if (this.renderedEntries.has(entry.id)) return;
      this.renderedEntries.add(entry.id);
      if (entry.type === "compaction") {
        for (const id of this.transcript.renderCompaction()) this.renderedEntries.add(id);
      } else if (entry.type === "custom") r.addCustomEntryToChat(entry);
      else if (entry.type === "usage" && entry.kind === "cache_warm") r.addCacheWarmingUsage(entry);
      else if (entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "bashExecution")) {
        for (const message of sessionEntryToContextMessages(entry)) r.addMessageToChat(message);
      }
    } else this.transcript.handleEvent(event);
    this.footer.invalidate();
    this.host.ui.requestRender();
  }

  /** Only presentation actions. Never dispatch to the parent or to renderer input handlers. */
  handleInput(data: string): void {
    if (this.disposed || data.includes("\u001b[200~") || data.includes("\u001b[201~")) return;
    const keys = this.host.keybindings;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") { this.back(); return; }
    // 1.0.0 has no app.sessionView actions: use configurable native navigation actions.
    if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.altScreen.lineUp")) this.scrollView.scrollBy(-1);
    else if (keys.matches(data, "tui.select.down") || keys.matches(data, "tui.altScreen.lineDown")) this.scrollView.scrollBy(1);
    else if (keys.matches(data, "tui.altScreen.pageUp")) this.scrollView.scrollBy(-Math.max(1, this.scrollView.viewportHeight - 1));
    else if (keys.matches(data, "tui.altScreen.pageDown")) this.scrollView.scrollBy(Math.max(1, this.scrollView.viewportHeight - 1));
    else if (keys.matches(data, "tui.altScreen.top")) this.scrollView.scrollToStart();
    else if (keys.matches(data, "tui.altScreen.bottom")) this.scrollView.scrollToEnd();
    else if (keys.matches(data, "app.tools.expand")) this.transcript.toggleTools();
    else if (keys.matches(data, "app.thinking.toggle")) this.transcript.toggleThinking();
    else return;
    this.host.ui.requestRender();
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<VStack["handleMouse"]> {
    if (!this.disposed && event.type === "wheel" && event.wheelDelta) {
      const lines = this.session.settingsManager.getFullscreenWheelScrollLines();
      this.scrollView.scrollBy(event.wheelDelta * (typeof lines === "number" ? lines : 3));
      this.host.ui.requestRender();
    }
    return { handled: true, target: {
      component: this, originX: event.screenX - event.x, originY: event.screenY - event.y,
      width: event.width, height: event.height,
    } };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queued = [];
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeBranch?.();
    this.unsubscribeBranch = undefined;
    this.scrollView.setScrollbar("hidden");
    this.footer.dispose();
    this.footerData.dispose();
  }
}

/** Bridge entry point. The modal host owns mounting and calls dispose when leaving. */
export function createReadOnlySessionView(mode: unknown, session: AgentSession, theme: Theme, back: () => void,
  options?: ReadOnlySessionViewOptions): ReadOnlySessionView {
  return new ReadOnlySessionView(mode, session, theme, back, options);
}
