import { describe, expect, it, vi } from "vitest";
import { ForceSteerComposer } from "../src/ui/force-steer-composer.js";
import { until } from "./helpers/job-runtime.js";

const FORCE = "\u001b[115;7u";
const RETRY = "\u001b[114;7u";
function fixture() {
  let active = true;
  let pendingParent = false;
  const send = vi.fn(async (_text: string) => "Child steer sent; direct parent steer queued.");
  const retry = vi.fn(async () => { pendingParent = false; return "Parent forward queued"; });
  const render = vi.fn();
  const component = new ForceSteerComposer({
    canSteer: () => active, send, retryParent: retry, hasPendingParent: () => pendingParent, requestRender: render,
  });
  return { component, send, retry, render, finish: () => { active = false; }, parentPending: () => { pendingParent = true; } };
}

describe("scoped force-steer composer", () => {
  it("opens with a non-default modal shortcut, preserves spaces and reports a successful receipt", async () => {
    const f = fixture();
    expect(f.component.handleInput(FORCE)).toBe(true);
    expect(f.component.composing).toBe(true);
    expect(f.component.render(100).join("\n")).toContain("bash/its attach waits only");
    f.component.handleInput("  exact user input  ");
    f.component.handleInput("\r");
    await until(() => f.component.status.includes("parent steer queued"));
    expect(f.send).toHaveBeenCalledExactlyOnceWith("  exact user input  ");
  });

  it("Esc and blank input cancel without sending to child or parent", async () => {
    const f = fixture();
    f.component.handleInput(FORCE);
    f.component.handleInput("discard me");
    f.component.handleInput("\u001b");
    f.component.handleInput(FORCE);
    f.component.handleInput("   ");
    f.component.handleInput("\r");
    await Promise.resolve();
    expect(f.component.composing).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.retry).not.toHaveBeenCalled();
  });

  it("rejects a terminal agent both before opening and after the user started typing", async () => {
    const f = fixture();
    f.component.handleInput(FORCE);
    f.component.handleInput("too late");
    f.finish();
    f.component.handleInput("\r");
    expect(f.component.status).toContain("finished while composing");
    f.component.handleInput(FORCE);
    expect(f.component.status).toContain("no longer running");
    expect(f.component.composing).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("reports failure, does not silently swallow it, and retries only an explicitly pending parent forward", async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error("delivery rejected"));
    f.component.handleInput(FORCE);
    f.component.handleInput("hello");
    f.component.handleInput("\r");
    await until(() => f.component.status.includes("FAILED: delivery rejected"));
    f.component.handleInput(RETRY);
    expect(f.retry).not.toHaveBeenCalled();
    f.parentPending();
    f.component.handleInput(RETRY);
    await until(() => f.component.status === "Parent forward queued");
    expect(f.retry).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("repeat shortcuts/submit during delivery do not send twice or create a loop", async () => {
    const f = fixture();
    let finish!: (value: string) => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.component.handleInput(FORCE);
    f.component.handleInput("once");
    f.component.handleInput("\r");
    f.component.handleInput(FORCE);
    f.component.handleInput("\r");
    await until(() => f.send.mock.calls.length === 1);
    expect(f.component.composing).toBe(false);
    finish("one receipt");
    await until(() => f.component.status === "one receipt");
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.retry).not.toHaveBeenCalled();
  });
});
