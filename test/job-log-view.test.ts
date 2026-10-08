import * as fs from "node:fs/promises";
import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../src/jobs/patty/types.js";
import { JOB_LOG_PAGE_BYTES, JobLogView, openJobLogView } from "../src/ui/job-log-view.js";
import type { SessionViewUI } from "../src/ui/session-view.js";

vi.mock("node:fs/promises", async original => ({ ...await original<typeof fs>() }));

describe("bounded job log viewer", () => {
  let directory: string;
  let job: Job;
  let view: JobLogView | undefined;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "job-view-"));
    job = { id: "btest", command: "echo test", pid: 1, startTime: Date.now(), status: "running",
      logPath: join(directory, "test.log"), toolCallId: "test", isBackgrounded: true, notified: false, waiters: 0 };
    await writeFile(job.logPath, "first\nsecond\n");
  });
  afterEach(async () => { view?.dispose(); await view?.settled(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
  async function create() {
    const close = vi.fn();
    view = new JobLogView(job, vi.fn(), close);
    await vi.waitFor(() => expect(view!.render(200).join("\n")).not.toContain("Loading"));
    return close;
  }
  it("bounds a giant single-line file and allows paging", async () => {
    await truncate(job.logPath, 512 * 1024 * 1024);
    const allocations = vi.spyOn(Buffer, "alloc");
    await create();
    expect(allocations.mock.calls.every(([size]) => size <= JOB_LOG_PAGE_BYTES)).toBe(true);
    allocations.mockRestore();
    expect(view!.render(200).join("\n")).toContain(`bytes ${512 * 1024 * 1024 - JOB_LOG_PAGE_BYTES}–${512 * 1024 * 1024}`);
    expect(view!.render(200).join("\n").length).toBeLessThanOrEqual(24 * 201);
    view!.handleInput("\x1b[5~");
    await vi.waitFor(() => expect(view!.render(200).join("\n")).toContain(`bytes ${512 * 1024 * 1024 - 2 * JOB_LOG_PAGE_BYTES}–`));
  });
  it("pauses on Up, resumes on End, and stays open on completion without consuming notices", async () => {
    const close = await create();
    view!.handleInput("\x1b[A");
    expect(view!.render(200).join("\n")).toContain("paused");
    await appendFile(job.logPath, "new output\n");
    view!.handleInput("\x1b[F");
    await vi.waitFor(() => expect(view!.render(200).join("\n")).toContain("new output"));
    job.status = "failed"; job.exitCode = 7; job.endTime = job.startTime + 1234;
    const snapshot = { ...job };
    expect(view!.render(200).join("\n")).toContain("failed · exit 7 · 1.2s");
    expect(close).not.toHaveBeenCalled();
    view!.handleInput("\x1b");
    expect(close).toHaveBeenCalledOnce();
    expect(job).toEqual(snapshot);
  });
  it("reports missing logs", async () => {
    await rm(job.logPath);
    await create();
    expect(view!.render(200).join("\n")).toContain("Log unavailable");
  });
  it("searches across chunk boundaries and supports next match", async () => {
    await writeFile(job.logPath, `${"a".repeat(JOB_LOG_PAGE_BYTES - 2)}needle\nneedle\n`);
    await create();
    view!.handleInput("/"); view!.handleInput("needle"); view!.handleInput("\r");
    await vi.waitFor(() => expect(view!.render(200).join("\n")).toContain(`Match at byte ${JOB_LOG_PAGE_BYTES - 2}`));
    view!.handleInput("n");
    await vi.waitFor(() => expect(view!.render(200).join("\n")).toContain(`Match at byte ${JOB_LOG_PAGE_BYTES + 5}`));
    view!.handleInput("n");
    await vi.waitFor(() => expect(view!.render(200).join("\n")).toContain("End of log"));
  });
  it("cancels a search without closing and disposes safely during reads", async () => {
    await truncate(job.logPath, 512 * 1024 * 1024);
    const close = await create();
    view!.handleInput("/"); view!.handleInput("absent"); view!.handleInput("\r");
    view!.handleInput("\x1b");
    expect(view!.render(200).join("\n")).toContain("Search cancelled");
    expect(close).not.toHaveBeenCalled();
    view!.handleInput("n"); view!.dispose();
    expect(job.notified).toBe(false);
    expect(job.waiters).toBe(0);
  });
  it("bounds each search pass and explicitly offers continuation", async () => {
    await truncate(job.logPath, 32 * 1024 * 1024);
    await create();
    view!.handleInput("/"); view!.handleInput("absent"); view!.handleInput("\r");
    await vi.waitFor(() => expect(view!.render(200).join("\n")).toContain("Search limit: 16 MiB scanned"), { timeout: 5000 });
  });
  it("exposes monitor stderr separately", async () => {
    job.kind = "monitor";
    await writeFile(job.logPath.replace(/\.log$/, ".err"), "monitor failure");
    await create(); view!.handleInput("e");
    await vi.waitFor(() => expect(view!.render(200).join("\n")).toContain("monitor failure"));
  });
  it("uses an overlay so fullscreen PageUp reaches logs, and holds closure until pending reads close", async () => {
    const actual = await fs.open(job.logPath, "r");
    let releaseRead!: () => void;
    const gate = new Promise<void>(resolve => { releaseRead = resolve; });
    const read = actual.read.bind(actual);
    vi.spyOn(actual, "read").mockImplementation(async (...args: Parameters<typeof actual.read>) => {
      await gate;
      return read(...args);
    });
    const closeFile = vi.spyOn(actual, "close");
    vi.spyOn(fs, "open").mockResolvedValueOnce(actual);
    let shown: JobLogView | undefined;
    const custom = vi.fn((factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => JobLogView) =>
      new Promise<void>(done => {
        shown = factory({ requestRender: vi.fn(), terminal: { rows: 24 } }, undefined, undefined, done);
      }));
    const handle = openJobLogView({ custom, notify: vi.fn() } as unknown as SessionViewUI, job)!;
    await vi.waitFor(() => expect(shown).toBeDefined());
    let closed = false;
    void handle.closed.then(() => { closed = true; });
    handle.close();
    await Promise.resolve(); await Promise.resolve();
    expect(closed).toBe(false);
    expect(closeFile).not.toHaveBeenCalled();
    releaseRead();
    await handle.closed;
    expect(closeFile).toHaveBeenCalledOnce();
    expect(closed).toBe(true);
    expect(custom).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } }));
  });
  it("ignores key releases and strips terminal control codes from task titles", async () => {
    await create();
    view!.handleInput("\x1b[57352;1:3u");
    expect(view!.render(200).join("\n")).toContain("following");
    job.name = "safe\x1b[2J\nlabel";
    expect(view!.render(200)[0]).toContain("safelabel");
    expect(view!.render(200)[0]).not.toContain("\x1b");
  });
  it.each(["", "one line", Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n")])("fills tall screens and resizes without exposing background (%s)", async content => {
    await writeFile(job.logPath, content);
    let height = 100;
    view = new JobLogView(job, vi.fn(), vi.fn(), undefined, () => height);
    await vi.waitFor(() => expect(view!.render(120).join("\n")).not.toContain("Loading"));
    for (const size of [100, 140, 12, 3, 2, 1, 100]) {
      height = size;
      const rows = view.render(120);
      expect(rows).toHaveLength(size);
      expect(rows.every(row => visibleWidth(row) === 120)).toBe(true);
      expect(rows.at(-1)).toContain("Esc back");
      if (size >= 4) expect(rows[0]).toContain("btest · running");
      if (size >= 5 && !content) expect(rows[2]).toContain("Waiting for output");
      if (size === 140 && content.includes("line-199")) {
        expect(rows[2]).toContain("line-64");
        expect(rows[137]).toContain("line-199");
      }
    }
    for (const width of [1, 8, 24, 70]) {
      const narrow = view.render(width);
      expect(narrow).toHaveLength(100);
      expect(narrow.every(row => visibleWidth(row) <= width)).toBe(true);
      if (width >= 8) expect(narrow[99]).toContain("Esc back");
    }
    if (content) expect(view.render(120)[98]).toContain("running · exit");
    view.handleInput("/");
    const searching = view.render(120);
    expect(searching).toHaveLength(100);
    expect(searching[98]).toContain("/ ");
    expect(searching[99]).toContain("Esc back");
    view.handleInput("\x1b");
    expect(view.render(120)[99]).toContain("Esc back");
    if (!content) {
      job.status = "completed"; job.exitCode = 0;
      expect(view.render(120)[2]).toContain("No output captured");
    }
  });
  it("can close before the custom UI opens", async () => {
    const custom = vi.fn();
    const handle = openJobLogView({ custom, notify: vi.fn() }, job)!;
    handle.close(); await handle.closed;
    expect(custom).not.toHaveBeenCalled();
    expect(handle.signal.aborted).toBe(true);
  });
});
