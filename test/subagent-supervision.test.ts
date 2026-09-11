import { describe, expect, it, vi } from "vitest";
import {
  collectSubagentActivity,
  DEFAULT_WATCH_INTERVAL_SECONDS,
  formatActivityPage,
  getSubagentActivityDetail,
  MAX_WATCHES,
  SupervisionScheduler,
  type SupervisionTarget,
  type TimerHandle,
  type TranscriptSource,
} from "../src/subagent-supervision.js";

function source(identity: string, messages: unknown[]): TranscriptSource {
  return { identity, messages };
}

const old = { role: "user", content: "old task context", timestamp: 1 };
const assistant = {
  role: "assistant",
  timestamp: 2,
  content: [
    { type: "thinking", thinking: "private chain of thought" },
    { type: "text", text: "I found the scheduler entry point." },
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts", blob: "A".repeat(300) } },
  ],
};
const result = {
  role: "toolResult",
  timestamp: 3,
  toolCallId: "call-1",
  toolName: "read",
  content: [{ type: "text", text: "line\n".repeat(300) }, { type: "image", data: "image-data", mimeType: "image/png" }],
  isError: false,
};

function schedulerWith(targets: Map<string, SupervisionTarget>, send: (content: string) => void, now: () => number) {
  return new SupervisionScheduler({
    getTarget: id => targets.get(id),
    isParentBusy: () => false,
    hasPendingParentMessages: () => false,
    send,
    now,
    setInterval: () => ({}),
    clearInterval: () => {},
  });
}

describe("collectSubagentActivity", () => {
  it("defaults to a latest bounded snapshot, marks omitted history, then progresses chronologically", () => {
    const transcript = source("agent-a", [old, assistant, result]);
    const recent = collectSubagentActivity(transcript, 2);

    expect(recent.recentSnapshot).toBe(true);
    expect(recent.earlierOmitted).toBe(true);
    expect(recent.events.map(event => event.role)).toEqual(["assistant", "tool"]);
    expect(formatActivityPage(recent)).toContain("earlier retained activity omitted");

    transcript.messages.push({ role: "assistant", timestamp: 4, content: [{ type: "text", text: "new progress" }] });
    const incremental = collectSubagentActivity(transcript, 2, recent.cursor);
    expect(incremental.recentSnapshot).toBeUndefined();
    expect(incremental.events.map(event => event.text)).toEqual(["new progress"]);
  });

  it("does not claim omitted history when the complete retained activity fits", () => {
    const page = collectSubagentActivity(source("agent-a", [assistant]), 2);

    expect(page.recentSnapshot).toBe(true);
    expect(page.earlierOmitted).toBe(false);
    expect(formatActivityPage(page)).not.toContain("earlier retained activity omitted");
  });

  it("excludes private/binary data while bounding blocks, calls, output, and cursor size", () => {
    const huge = source("agent-a", [{
      role: "assistant",
      timestamp: 2,
      content: [
        { type: "text", text: `text ${"x".repeat(5_000)}` },
        ...Array.from({ length: 20 }, (_, index) => ({ type: "toolCall", id: `call-${index}`, name: "tool".repeat(100), arguments: { payload: "A".repeat(100_000) } })),
      ],
    }]);
    const page = collectSubagentActivity(huge, 20);
    const event = page.events[0];

    expect(event.text).not.toContain("x".repeat(1_000));
    expect(event.toolCalls?.length).toBeLessThanOrEqual(3);
    expect(event.toolCalls?.[0].arguments).toContain("[base64 omitted]");
    expect(event.truncated).toContain("tool calls");
    expect(formatActivityPage(page).length).toBeLessThanOrEqual(9_000);
    expect(page.cursor.length).toBeLessThan(500);
  });

  it("keeps every text block after the public limit omitted", () => {
    const page = collectSubagentActivity(source("agent-a", [{
      role: "assistant",
      timestamp: 1,
      content: Array.from({ length: 4 }, (_, index) => ({ type: "text", text: `text-${index}` })),
    }]), 1);

    expect(page.events[0].text).toBe("text-0\ntext-1");
    expect(page.events[0].text).not.toContain("text-2");
    expect(page.events[0].text).not.toContain("text-3");
    expect(page.events[0].truncated).toContain("text blocks");
  });

  it("surfaces error-only assistant and tool-result messages", () => {
    const page = collectSubagentActivity(source("agent-a", [
      { role: "assistant", timestamp: 1, content: [], stopReason: "error", errorMessage: "provider failed" },
      { role: "toolResult", timestamp: 2, toolName: "bash", toolCallId: "call", content: [], isError: true },
    ]), 5);

    expect(page.events[0]).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "provider failed" });
    expect(page.events[1]).toMatchObject({ role: "tool", toolName: "bash", isError: true });
  });

  it("explicitly resets cursors after source mismatch or transcript replacement", () => {
    const first = collectSubagentActivity(source("agent-a", [old, assistant, result]), 1);
    const other = collectSubagentActivity(source("agent-b", [assistant]), 2, first.cursor);
    expect(other.gap).toContain("does not belong");

    const replacement = collectSubagentActivity(source("agent-a", [old, assistant, { role: "assistant", timestamp: 4, content: [{ type: "text", text: "replacement" }] }]), 3, first.cursor);
    expect(replacement.gap).toContain("cursor reset");
  });

  it("keeps public activity IDs stable on append and rejects another agent, session, or replacement", () => {
    const messages = [{ role: "assistant", timestamp: 1, content: [{ type: "text", text: "first" }] }];
    const transcript = source("agent-a:session-a", messages);
    const first = collectSubagentActivity(transcript, 1);
    const id = first.events[0].id;

    messages.push({ role: "assistant", timestamp: 2, content: [{ type: "text", text: "second" }] });
    expect(collectSubagentActivity(transcript, 2).events[0].id).toBe(id);
    expect(getSubagentActivityDetail(source("agent-b:session-a", messages), id).available).toBe(false);
    expect(getSubagentActivityDetail(source("agent-a:session-b", messages), id).available).toBe(false);

    messages[0] = { role: "assistant", timestamp: 1, content: [{ type: "text", text: "replacement" }] };
    const unavailable = getSubagentActivityDetail(transcript, id);
    expect(unavailable.available).toBe(false);
    expect(unavailable.unavailableReason).toContain("compacted, replaced, or reset");
  });

  it("paginates one public message without exposing thinking, images, or base64", () => {
    const publicText = `progress ${"plain text ".repeat(3_000)}`;
    const transcript = source("agent-a:session-a", [{
      role: "assistant",
      timestamp: 1,
      stopReason: "error",
      errorMessage: "provider failed",
      content: [
        { type: "thinking", thinking: "private chain of thought" },
        { type: "text", text: publicText },
        { type: "image", data: "secret-image", mimeType: "image/png" },
        { type: "text", text: `data:text/plain;base64,${"A".repeat(300)}` },
        { type: "toolCall", name: "edit", arguments: { path: "src/a.ts", patch: "public patch" } },
      ],
    }]);
    const id = collectSubagentActivity(transcript, 1).events[0].id;
    let offset = 0;
    let reconstructed = "";
    let detail = getSubagentActivityDetail(transcript, id, offset, 997);
    while (true) {
      reconstructed += detail.text;
      if (!detail.hasMore) break;
      offset = detail.nextOffset;
      detail = getSubagentActivityDetail(transcript, id, offset, 997);
    }

    expect(reconstructed).toContain(publicText);
    expect(reconstructed).toContain("tool call edit arguments");
    expect(reconstructed).toContain("stop reason: error");
    expect(reconstructed).toContain("error: provider failed");
    expect(reconstructed).not.toContain("private chain of thought");
    expect(reconstructed).not.toContain("secret-image");
    expect(reconstructed).not.toContain("data:text/plain;base64");
    expect(detail.truncated).toBe(false);
    expect(detail.omitted).toEqual(expect.arrayContaining(["thinking", "image", "base64"]));
  });

  it("pages a capped long tool result without serializing its whole output", () => {
    const transcript = source("agent-a:session-a", [{
      role: "toolResult",
      timestamp: 1,
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "tool output ".repeat(10_000) }],
    }]);
    const id = collectSubagentActivity(transcript, 1).events[0].id;
    let offset = 0;
    let reconstructed = "";
    let detail = getSubagentActivityDetail(transcript, id, offset, 8_192);
    while (true) {
      reconstructed += detail.text;
      if (!detail.hasMore) break;
      offset = detail.nextOffset;
      detail = getSubagentActivityDetail(transcript, id, offset, 8_192);
    }

    expect(reconstructed).toContain("tool name: bash");
    expect(reconstructed.length).toBeLessThanOrEqual(65_536);
    expect(detail.truncated).toBe(true);
  });

  it("keeps every detail tool call after the public limit omitted", () => {
    const detailSource = source("agent-a:session-a", [{
      role: "assistant",
      timestamp: 1,
      content: Array.from({ length: 18 }, (_, index) => ({
        type: "toolCall",
        name: "edit",
        arguments: { path: `src/${index}.ts` },
      })),
    }]);
    const id = collectSubagentActivity(detailSource, 1).events[0].id;
    const detail = getSubagentActivityDetail(detailSource, id, 0, 8_192);

    expect(detail.text.match(/tool call edit arguments/g)).toHaveLength(16);
    expect(detail.text).not.toContain("src/16.ts");
    expect(detail.text).not.toContain("src/17.ts");
    expect(detail.truncated).toBe(true);
  });

  it("prioritizes public calls after private blocks and marks a bounded scan that cannot reach one", () => {
    const visible = collectSubagentActivity(source("agent-a", [{
      role: "assistant",
      timestamp: 1,
      content: [
        ...Array.from({ length: 20 }, () => ({ type: "thinking", thinking: "private" })),
        { type: "toolCall", name: "edit", arguments: { path: "src/index.ts" } },
      ],
    }]), 1).events[0];
    expect(visible.toolCalls?.[0]).toMatchObject({ name: "edit" });
    expect(visible.omitted).toContain("thinking");

    const beyondScan = collectSubagentActivity(source("agent-a", [{
      role: "assistant",
      timestamp: 1,
      content: [
        ...Array.from({ length: 80 }, () => ({ type: "thinking", thinking: "private" })),
        { type: "toolCall", name: "edit", arguments: { path: "src/index.ts" } },
      ],
    }]), 1).events[0];
    expect(beyondScan.toolCalls).toBeUndefined();
    expect(beyondScan.truncated).toContain("content blocks");
  });

  it("uses practical bounded argument excerpts", () => {
    const page = collectSubagentActivity(source("agent-a", [{
      role: "assistant",
      timestamp: 1,
      content: [{ type: "toolCall", name: "edit", arguments: { patch: "plain text ".repeat(100) } }],
    }]), 1);
    expect(page.events[0].toolCalls?.[0].arguments.length).toBe(240);
    expect(page.events[0].truncated).toContain("arguments");
  });
});

describe("SupervisionScheduler", () => {
  it("defaults watches to 240 seconds and schedules their first wake at 240000ms", () => {
    const scheduler = schedulerWith(
      new Map([["a", { id: "a", status: "running", isBackground: true }]]),
      () => {},
      () => 0,
    );

    const defaultWatch = scheduler.start({ agentId: "a" });
    expect(defaultWatch).toMatchObject({
      ok: true,
      watch: { intervalSeconds: DEFAULT_WATCH_INTERVAL_SECONDS, nextDueAt: 240_000 },
    });

    const explicitWatch = scheduler.start({ agentId: "a", intervalSeconds: 30 });
    expect(explicitWatch).toMatchObject({ ok: true, watch: { intervalSeconds: 30, nextDueAt: 30_000 } });
  });

  it("starts no timer until opted in, defers busy work, wakes on silence, and cleans up terminal watches", async () => {
    let now = 0;
    let busy = false;
    let pending = false;
    const sent: string[] = [];
    const timers: Array<{ callback: () => void; handle: TimerHandle }> = [];
    const clearInterval = vi.fn();
    const unref = vi.fn();
    const targets = new Map<string, SupervisionTarget>([
      ["a", { id: "a", status: "running", isBackground: true, description: "first", session: source("a", [old, assistant]) }],
      ["b", { id: "b", status: "running", isBackground: true, description: "second", session: source("b", [result]) }],
    ]);
    const scheduler = new SupervisionScheduler({
      getTarget: id => targets.get(id),
      isParentBusy: () => busy,
      hasPendingParentMessages: () => pending,
      send: content => sent.push(content),
      now: () => now,
      setInterval: callback => { const handle = { unref }; timers.push({ callback, handle }); return handle; },
      clearInterval,
    });

    expect(timers).toHaveLength(0);
    expect(scheduler.start({ agentId: "a", intervalSeconds: 30 }).ok).toBe(true);
    expect(scheduler.start({ agentId: "b", intervalSeconds: 30 }).ok).toBe(true);
    expect(timers).toHaveLength(1);
    expect(unref).toHaveBeenCalledOnce();

    now = 30_000;
    busy = true;
    await scheduler.tick();
    expect(sent).toHaveLength(0);
    expect(scheduler.status("a")[0].cursor).toBeUndefined();

    busy = false;
    pending = true;
    await scheduler.tick();
    expect(sent).toHaveLength(0);

    pending = false;
    await scheduler.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("<subagent-supervision>");
    expect(sent[0]).toContain("observation opportunity, not a mandate to steer");
    expect(sent[0]).toContain("direction, scope, or acceptance drift");
    expect(sent[0]).toContain("silence or one error is not enough");
    expect(sent[0]).toContain("desired boundary");
    expect(sent[0]).toContain("Agent a (first)");
    expect(sent[0]).toContain("Agent b (second)");
    expect(scheduler.status("a")[0].cursor).toBeTruthy();

    now = 60_000;
    await scheduler.tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("No new retained public evidence");
    expect(sent[1]).toContain("Last delivered progress evidence");

    targets.get("a")!.status = "completed";
    targets.get("b")!.status = "error";
    now = 90_000;
    await scheduler.tick();
    expect(scheduler.status().every(watch => watch.state === "stopped")).toBe(true);
    expect(clearInterval).toHaveBeenCalledOnce();
  });

  it("uses latest evidence for periodic backlogs while retaining a manual catch-up cursor", async () => {
    let now = 0;
    let fail = false;
    const sent: string[] = [];
    const messages: unknown[] = Array.from({ length: 100 }, (_, index) => ({
      role: "assistant",
      timestamp: index + 1,
      content: [{ type: "text", text: `progress-${index}` }],
    }));
    const target: SupervisionTarget = {
      id: "a",
      status: "running",
      isBackground: true,
      description: "d".repeat(160),
      session: source("a", messages),
    };
    const scheduler = schedulerWith(new Map([["a", target]]), content => {
      if (fail) throw new Error("transport unavailable");
      sent.push(content);
    }, () => now);
    expect(scheduler.start({
      agentId: "a",
      intervalSeconds: 30,
      reviewBrief: "r".repeat(400),
      criteria: "c".repeat(400),
    }).ok).toBe(true);

    now = 30_000;
    await scheduler.tick();
    const firstCursor = scheduler.status("a")[0].cursor!;
    messages.push(...Array.from({ length: 120 }, (_, index) => ({
      role: "assistant",
      timestamp: 101 + index,
      content: [{ type: "text", text: `progress-${100 + index}` }],
    })));

    now = 60_000;
    await scheduler.tick();
    expect(sent[1]).toContain("progress-219");
    expect(sent[1]).toContain("Skipped intervening retained activity");
    expect(sent[1]).not.toContain("progress-100");
    const catchUp = /catch-up cursor: <([^>]+)>/.exec(sent[1])![1];
    expect(catchUp).toBe(firstCursor);
    expect(collectSubagentActivity(target.session, 8, catchUp).events[0].text).toBe("progress-100");

    const snapshotCursor = scheduler.status("a")[0].cursor!;
    messages.push(...Array.from({ length: 120 }, (_, index) => ({
      role: "assistant",
      timestamp: 221 + index,
      content: [{ type: "text", text: `progress-${220 + index}` }],
    })));
    fail = true;
    now = 90_000;
    await scheduler.tick();
    expect(scheduler.status("a")[0].cursor).toBe(snapshotCursor);

    fail = false;
    await scheduler.tick();
    expect(sent.at(-1)).toContain("progress-339");
    expect(sent.at(-1)).toContain("Skipped intervening retained activity");
    expect(scheduler.status("a")[0].cursor).not.toBe(snapshotCursor);
  });

  it("does not advance a selected cursor until a bounded combined notification sends", async () => {
    let now = 0;
    let fail = true;
    const target: SupervisionTarget = { id: "a", status: "running", isBackground: true, session: source("a", [assistant]) };
    const scheduler = schedulerWith(new Map([["a", target]]), () => {
      if (fail) throw new Error("transport unavailable");
    }, () => now);

    expect(scheduler.start({ agentId: "a", intervalSeconds: 30 }).ok).toBe(true);
    now = 30_000;
    await scheduler.tick();
    expect(scheduler.status("a")[0].cursor).toBeUndefined();
    expect(scheduler.status("a")[0].lastError).toContain("Could not send");

    fail = false;
    await scheduler.tick();
    const cursor = scheduler.status("a")[0].cursor;
    expect(cursor).toBeTruthy();
    const activityId = collectSubagentActivity(target.session, 1).events[0].id;
    expect(getSubagentActivityDetail(target.session, activityId, 0, 100).available).toBe(true);
    expect(scheduler.status("a")[0].cursor).toBe(cursor);
    now += 30_000;
  });

  it("delivers a watch section with expanded argument excerpts instead of stalling its cursor", async () => {
    let now = 0;
    const sent: string[] = [];
    const target: SupervisionTarget = {
      id: "a",
      status: "running",
      isBackground: true,
      description: "d".repeat(160),
      session: source("a", [{
        role: "assistant",
        timestamp: 1,
        content: [
          { type: "toolCall", name: "edit", arguments: { patch: "plain text ".repeat(100) } },
          { type: "toolCall", name: "write", arguments: { content: "plain text ".repeat(100) } },
        ],
      }]),
    };
    const scheduler = schedulerWith(new Map([["a", target]]), content => sent.push(content), () => now);
    expect(scheduler.start({
      agentId: "a",
      intervalSeconds: 30,
      reviewBrief: "r".repeat(400),
      criteria: "c".repeat(400),
    }).ok).toBe(true);

    now = 30_000;
    await scheduler.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("tool call edit");
    expect(sent[0]).toContain("tool call write");
    expect(scheduler.status("a")[0].cursor).toBeTruthy();
  });

  it("rotates deferred due watches so a bounded combined notification does not starve later agents", async () => {
    let now = 0;
    const sent: string[] = [];
    const targets = new Map<string, SupervisionTarget>();
    for (let index = 0; index < 10; index++) {
      targets.set(`a${index}`, {
        id: `a${index}`,
        status: "running",
        isBackground: true,
        description: "d".repeat(160),
        session: source(`a${index}`, [{ role: "assistant", timestamp: index + 1, content: [{ type: "text", text: "p".repeat(480) }] }]),
      });
    }
    const scheduler = schedulerWith(targets, content => sent.push(content), () => now);
    for (const id of targets.keys()) expect(scheduler.start({ agentId: id, intervalSeconds: 30, reviewBrief: "r".repeat(400), criteria: "c".repeat(400) }).ok).toBe(true);

    now = 30_000;
    await scheduler.tick();
    await scheduler.tick();
    const delivered = sent.join("\n");
    for (const id of targets.keys()) expect(delivered).toContain(`Agent ${id}`);
  });

  it("enforces active limit when restarting a stopped record and keeps stopped history bounded", () => {
    const targets = new Map<string, SupervisionTarget>();
    for (let index = 0; index <= MAX_WATCHES; index++) targets.set(`a${index}`, { id: `a${index}`, status: "running", isBackground: true });
    const scheduler = schedulerWith(targets, () => {}, () => 0);
    expect(scheduler.start({ agentId: "a0" }).ok).toBe(true);
    scheduler.stop("a0");
    for (let index = 1; index <= MAX_WATCHES; index++) expect(scheduler.start({ agentId: `a${index}` }).ok).toBe(true);
    expect(scheduler.start({ agentId: "a0" })).toMatchObject({ ok: false, error: expect.stringContaining("Watch limit") });
  });

  it("cleans up an opted-in timer on session disposal and rejects non-top-level targets", () => {
    const clearInterval = vi.fn();
    const target: SupervisionTarget = { id: "a", status: "running", isBackground: true };
    const scheduler = new SupervisionScheduler({
      getTarget: () => target,
      isParentBusy: () => false,
      hasPendingParentMessages: () => false,
      send: () => {},
      setInterval: () => ({}),
      clearInterval,
    });
    expect(scheduler.start({ agentId: "a" }).ok).toBe(true);
    scheduler.dispose();
    expect(clearInterval).toHaveBeenCalledOnce();

    target.parentAgentId = "parent";
    expect(scheduler.start({ agentId: "a" })).toMatchObject({ ok: false, error: "Only top-level agents can be supervised." });
  });
});
