import { describe, expect, it } from "vitest";
import { isSubagentDepth, RecursionPolicy } from "../src/recursion-policy.js";

describe("central recursion policy", () => {
  it("defaults off with depth 2 and keeps overrides separate from persistent settings", () => {
    const policy = new RecursionPolicy();
    expect(policy.effective).toEqual({ nestedAgentsEnabled: false, maxSubagentDepth: 2 });
    expect(policy.canSpawn(1)).toBe(false);
    policy.configure({ nestedAgentsEnabled: true, maxSubagentDepth: 3 });
    expect(policy.canSpawn(2)).toBe(true);
    expect(policy.canSpawn(3)).toBe(false);
    policy.command("off");
    policy.command("depth 0");
    expect(policy.effective).toEqual({ nestedAgentsEnabled: false, maxSubagentDepth: 0 });
    expect(policy.configured).toEqual({ nestedAgentsEnabled: true, maxSubagentDepth: 3 });
    policy.configure({ nestedAgentsEnabled: true, maxSubagentDepth: 4 });
    expect(policy.effective.maxSubagentDepth).toBe(0);
    expect(policy.command("status").message).toContain("Configuration baseline: enabled=true, depth=4");
    policy.command("reset");
    expect(policy.effective).toEqual({ nestedAgentsEnabled: true, maxSubagentDepth: 4 });
    expect(policy.command("").message).toContain("Session overrides: enabled=none, depth=none");
  });

  it.each(["depth -1", "depth 17", "depth 1.2", "depth Infinity", "depth NaN", "depth", "depth 2 junk", "on junk", "off junk", "reset junk", "status junk", "unknown"])("rejects %s atomically", input => {
    const policy = new RecursionPolicy();
    policy.command("on");
    policy.command("depth 5");
    const before = policy.command("status");
    expect(policy.command(input).level).toBe("warning");
    expect(policy.command("status")).toEqual(before);
  });

  it("accepts boundary depths and explicit false without clamping", () => {
    const policy = new RecursionPolicy();
    policy.command("on");
    for (const depth of [0, 1, 2, 16]) {
      expect(isSubagentDepth(depth)).toBe(true);
      expect(policy.command(`depth ${depth}`).level).toBe("info");
      expect(policy.canSpawn(1)).toBe(depth > 1);
    }
    for (const value of [-1, 17, 2.5, NaN, Infinity, "2", null, undefined]) expect(isSubagentDepth(value)).toBe(false);
    policy.command("off");
    expect(policy.canSpawn(1)).toBe(false);
    policy.reset();
    expect(policy.effective).toEqual({ nestedAgentsEnabled: false, maxSubagentDepth: 2 });
  });
});
