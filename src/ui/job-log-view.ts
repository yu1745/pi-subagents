import { open } from "node:fs/promises";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, isKeyRelease, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isTerminalStatus, type Job } from "../jobs/patty/types.js";
import type { SessionViewHandle, SessionViewUI } from "./session-view.js";

export const JOB_LOG_PAGE_BYTES = 64 * 1024;
const SEARCH_BYTES = 16 * 1024 * 1024;
const QUERY_CHARS = 256;

/** Each read owns its descriptor, so disposal never races a shared descriptor. */
async function readPage(path: string, position: number | undefined) {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const start = Math.max(0, Math.min(position ?? Math.max(0, size - JOB_LOG_PAGE_BYTES), size));
    const buffer = Buffer.alloc(Math.min(JOB_LOG_PAGE_BYTES, size - start));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    return { start, size, buffer: buffer.subarray(0, bytesRead) };
  } finally { await file.close(); }
}

/** Read-only, bounded byte windows; no registry/tool/notification side effects. */
export class JobLogView {
  private lines: string[] = [];
  private row = 0;
  private start = 0;
  private size = 0;
  private bytes = 0;
  private height = 15;
  private following = true;
  private disposed = false;
  private generation = 0;
  private searching = false;
  private editing = false;
  private query = "";
  private searchPosition = 0;
  private message = "Loading log…";
  private stderr = false;
  private frozenEnd: number | undefined;
  private readonly input = new Input({ prompt: "/ " });
  private readonly timer: ReturnType<typeof setInterval>;
  private loading = false;
  private reads = new Set<ReturnType<typeof readPage>>();
  focused = true;

  constructor(private readonly job: Job, private readonly requestRender: () => void,
    private readonly close: () => void, private readonly theme?: Theme,
    private readonly terminalRows: () => number = () => 24) {
    this.input.onSubmit = value => {
      this.editing = false;
      this.query = value.slice(0, QUERY_CHARS);
      this.input.setValue(this.query);
      this.searchPosition = 0;
      void this.search();
    };
    this.timer = setInterval(() => { void this.refresh(); }, 250);
    void this.refresh();
  }

  private get path(): string { return this.stderr ? this.job.logPath.replace(/\.log$/, ".err") : this.job.logPath; }

  /** Keep the caller's read lease until all outstanding descriptors are closed. */
  async settled(): Promise<void> { await Promise.allSettled([...this.reads]); }

  private page(position: number | undefined): ReturnType<typeof readPage> {
    const request = readPage(this.path, position);
    this.reads.add(request);
    void request.then(() => this.reads.delete(request), () => this.reads.delete(request));
    return request;
  }

  async refresh(position?: number, bottom = false): Promise<void> {
    if (this.disposed || this.loading || this.searching) return;
    this.loading = true;
    const generation = this.generation;
    try {
      const page = await this.page(position ?? (this.following ? undefined : this.start));
      if (this.disposed || generation !== this.generation) return;
      this.start = page.start;
      this.size = page.size;
      this.bytes = page.buffer.length;
      // Never execute log control sequences (including cursor motion and OSC).
      this.lines = page.buffer.toString("utf8").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").split("\n");
      if (this.following || bottom) this.row = Math.max(0, this.lines.length - this.height);
      else this.row = Math.min(this.row, Math.max(0, this.lines.length - 1));
      if (this.message === "Loading log…" || this.message.startsWith("Log unavailable")) this.message = "";
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.lines = [];
        this.message = `Log unavailable (missing, cleaned, or unreadable): ${error instanceof Error ? error.message : String(error)}`;
      }
    } finally {
      this.loading = false;
      if (!this.disposed) this.requestRender();
    }
  }

  private async search(): Promise<void> {
    if (!this.query || this.disposed || this.searching) return;
    this.following = false;
    this.searching = true;
    const generation = ++this.generation;
    const needle = Buffer.from(this.query);
    const begin = this.searchPosition;
    let position = begin;
    let overlap = Buffer.alloc(0);
    this.message = "Searching… Esc cancels";
    this.requestRender();
    try {
      while (!this.disposed && generation === this.generation && position - begin < SEARCH_BYTES) {
        const page = await this.page(position);
        if (this.disposed || generation !== this.generation) return;
        const data = Buffer.concat([overlap, page.buffer]);
        const found = data.indexOf(needle);
        if (found >= 0) {
          const match = page.start - overlap.length + found;
          this.searchPosition = match + needle.length;
          this.searching = false;
          this.row = 0;
          // A poll begun before the search must settle before opening its result.
          while (this.loading && !this.disposed && generation === this.generation) await yieldTurn();
          if (this.disposed || generation !== this.generation) return;
          await this.refresh(match);
          this.message = `Match at byte ${match} · n next`;
          return;
        }
        position = page.start + page.buffer.length;
        if (position >= page.size || !page.buffer.length) {
          this.searchPosition = 0;
          this.message = "End of log · n searches from beginning";
          return;
        }
        overlap = Buffer.from(data.subarray(Math.max(0, data.length - needle.length + 1)));
        await yieldTurn();
      }
      if (generation === this.generation) {
        this.searchPosition = position - overlap.length;
        this.message = "Search limit: 16 MiB scanned · n continues";
      }
    } catch (error) {
      if (generation === this.generation) this.message = `Search unavailable: ${String(error)}`;
    } finally {
      if (generation === this.generation) this.searching = false;
      if (!this.disposed) this.requestRender();
    }
  }

  handleInput(data: string): void {
    if (this.disposed || isKeyRelease(data)) return;
    if (matchesKey(data, "escape")) {
      if (this.searching || this.editing) {
        this.generation++;
        this.searching = this.editing = false;
        this.message = "Search cancelled";
        this.requestRender();
      } else this.close();
      return;
    }
    if (this.editing) {
      this.input.handleInput(data);
      if (this.input.getValue().length > QUERY_CHARS) this.input.setValue(this.input.getValue().slice(0, QUERY_CHARS));
      this.requestRender();
      return;
    }
    if (this.searching) return;
    if (data === "/") { this.editing = true; this.input.setValue(""); }
    else if (data === "n") { void this.search(); }
    else if (data === "e" && this.job.kind === "monitor") {
      this.stderr = !this.stderr; this.generation++; this.following = true; this.row = 0;
      void this.refresh();
    } else if (matchesKey(data, "end")) { this.following = true; void this.refresh(); }
    else if (matchesKey(data, "up") || matchesKey(data, "pageUp")) {
      this.following = false;
      const step = matchesKey(data, "up") ? 1 : this.height;
      if (this.row > 0) this.row = Math.max(0, this.row - step);
      else if (this.start > 0) void this.refresh(Math.max(0, this.start - JOB_LOG_PAGE_BYTES), true);
    } else if (matchesKey(data, "down") || matchesKey(data, "pageDown")) {
      this.following = false;
      const step = matchesKey(data, "down") ? 1 : this.height;
      if (this.row + this.height < this.lines.length) this.row = Math.min(this.lines.length - 1, this.row + step);
      else if (this.start + this.bytes < this.size) { this.row = 0; void this.refresh(this.start + this.bytes); }
    }
    this.requestRender();
  }

  render(width: number): string[] {
    // Overlay maxHeight only clips: the component must provide every row.
    const terminalHeight = Math.max(1, Math.floor(this.terminalRows()));
    const bodyHeight = Math.max(0, terminalHeight - 4);
    this.height = Math.max(1, bodyHeight);
    if (this.following) this.row = Math.max(0, this.lines.length - this.height);
    if (isTerminalStatus(this.job.status)) this.frozenEnd ??= this.job.endTime ?? Date.now();
    const elapsed = Math.max(0, (this.job.endTime ?? this.frozenEnd ?? Date.now()) - this.job.startTime);
    const status = `${this.job.status} · exit ${this.job.exitCode ?? "—"} · ${(elapsed / 1000).toFixed(1)}s`;
    const title = `${stripTerminalSequences(this.job.name ?? this.job.id).replace(/[\x00-\x1f\x7f-\x9f]/g, "")} · ${status}`;
    const heading = this.theme ? this.theme.fg(this.job.status === "failed" || this.job.status === "killed" ? "error" : "accent", title) : title;
    const metadata = `${this.stderr ? "stderr" : "output"} · ${this.following ? "following" : "paused"} · bytes ${this.start}–${this.start + this.bytes}/${this.size} (64 KiB window; edge lines may be partial)`;
    const empty = this.bytes === 0 ? isTerminalStatus(this.job.status) ? "No output captured." : "Waiting for output…" : "";
    const body = this.bytes === 0 || this.lines.length === 0
      ? [this.message.startsWith("Log unavailable") || this.message === "Loading log…" ? this.message : empty || this.message] : this.lines.slice(this.row, this.row + bodyHeight);
    let footer = "↑/PgUp pause · ↓/PgDn browse · End follow · / search · n next · Esc back" + (this.job.kind === "monitor" ? " · e stdout/stderr" : "");
    if (visibleWidth(footer) > width) footer = "↑↓ scroll · End follow · / search · Esc back";
    if (visibleWidth(footer) > width) footer = "Esc back";
    this.input.focused = this.focused;
    const statusLine = this.editing ? this.input.render(Math.max(1, width))[0] ?? "/ " : this.message || empty || status;
    const rows = terminalHeight >= 4
      ? [heading, metadata, ...Array.from({ length: bodyHeight }, (_, index) => body[index] ?? ""), statusLine, footer]
      : terminalHeight === 3 ? [heading, statusLine, footer]
      : terminalHeight === 2 ? [heading, footer] : ["Esc back"];
    return rows.map(line => {
      const clipped = truncateToWidth(line, Math.max(0, width));
      return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
    });
  }

  invalidate(): void { this.input.invalidate(); }
  dispose(): void { this.disposed = true; this.generation++; clearInterval(this.timer); }
}

export function openJobLogView(ui: SessionViewUI, job: Job): SessionViewHandle | undefined {
  if (!ui.custom) { ui.notify("Job log viewing requires an interactive UI.", "warning"); return undefined; }
  const controller = new AbortController();
  let finish: (() => void) | undefined;
  let viewer: JobLogView | undefined;
  const close = () => { controller.abort(); viewer?.dispose(); finish?.(); };
  const closed = Promise.resolve().then(async () => {
    if (controller.signal.aborted) return;
    try {
      await ui.custom!<undefined>((tui, theme, _keys, done) => {
        finish = () => done(undefined);
        viewer = new JobLogView(job, () => tui.requestRender(), close, theme, () => tui.terminal.rows);
        if (controller.signal.aborted) close();
        return viewer;
      }, { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } });
    } finally {
      viewer?.dispose();
      controller.abort();
      await viewer?.settled();
    }
  });
  return { close, signal: controller.signal, closed };
}
