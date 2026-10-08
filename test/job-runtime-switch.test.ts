import { afterEach, beforeEach, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { JobRuntime } from "../src/jobs/runtime.js";
import { ctx, hermeticDir, makePi } from "./helpers/boot-extension.js";

let home: ReturnType<typeof hermeticDir>;
let boot: ReturnType<typeof makePi>;
beforeEach(() => {
  home = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false } });
  vi.stubEnv("PI_SUBAGENTS_JOB_RUNTIME", undefined);
  // This is the top-level switch wiring; process cleanup is exercised by the
  // real-runtime/SDK suites. No runtime hooks or watchdog resources here.
  vi.spyOn(JobRuntime.prototype, "installRoot").mockImplementation(() => {});
  boot = makePi();
  extension(boot.pi);
});
afterEach(async () => {
  await boot.lifecycle.get("session_shutdown")?.();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  home.restore();
});

it.each(["unconfirmed", "throws"])("cancels session replacement when job termination %s", async failure => {
  const stop = vi.spyOn(JobRuntime.prototype, "stopAll");
  if (failure === "throws") stop.mockRejectedValue(new Error("termination failed"));
  else stop.mockResolvedValue(false);
  const context = ctx();
  const receipt = await boot.lifecycle.get("session_before_switch")({ reason: "new" }, context);
  expect(receipt).toEqual({ cancel: true });
  expect(context.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Cannot switch sessions:"), "error");
  stop.mockResolvedValue(true);
  expect(await boot.lifecycle.get("session_before_switch")({ reason: "new" }, context)).toBeUndefined();
});
