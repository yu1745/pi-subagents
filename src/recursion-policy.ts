import type { SubagentsSettings } from "./settings.js";

export const SUBAGENT_DEPTH_CEILING = 16;

export interface RecursionSettings {
  nestedAgentsEnabled: boolean;
  maxSubagentDepth: number;
}

export function isSubagentDepth(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= SUBAGENT_DEPTH_CEILING;
}

/** One policy per root manager. Baseline is persistent; overrides never are. */
export class RecursionPolicy {
  private baseline: RecursionSettings = { nestedAgentsEnabled: false, maxSubagentDepth: 2 };
  private overrides: Partial<RecursionSettings> = {};

  get configured(): RecursionSettings { return { ...this.baseline }; }
  get effective(): RecursionSettings { return { ...this.baseline, ...this.overrides }; }

  configure(settings: Pick<SubagentsSettings, keyof RecursionSettings>): void {
    this.baseline = {
      nestedAgentsEnabled: settings.nestedAgentsEnabled ?? false,
      maxSubagentDepth: settings.maxSubagentDepth ?? 2,
    };
  }

  reset(): void { this.overrides = {}; }

  canSpawn(depth: number): boolean {
    const policy = this.effective;
    return policy.nestedAgentsEnabled && depth < policy.maxSubagentDepth;
  }

  /** Validate the whole command before changing either override. */
  command(args: string): { message: string; level: "info" | "warning" } {
    const words = args.trim().toLowerCase().split(/\s+/);
    const action = words[0];
    if (words.length === 1 && (action === "on" || action === "off")) {
      this.overrides.nestedAgentsEnabled = action === "on";
    } else if (words.length === 2 && action === "depth" && /^\d+$/.test(words[1]) && isSubagentDepth(Number(words[1]))) {
      this.overrides.maxSubagentDepth = Number(words[1]);
    } else if (words.length === 1 && action === "reset") {
      this.reset();
    } else if (words.length !== 1 || (action !== "status" && action !== "")) {
      return { message: `Use /subagent-recursion on|off|depth N|status|reset (depth 0-${SUBAGENT_DEPTH_CEILING}).`, level: "warning" };
    }
    const effective = this.effective;
    return {
      message: `Subagent recursion: enabled=${effective.nestedAgentsEnabled}, depth=${effective.maxSubagentDepth}. ` +
        `Configuration baseline: enabled=${this.baseline.nestedAgentsEnabled}, depth=${this.baseline.maxSubagentDepth}. ` +
        `Session overrides: enabled=${this.overrides.nestedAgentsEnabled ?? "none"}, depth=${this.overrides.maxSubagentDepth ?? "none"}.`,
      level: "info",
    };
  }
}
