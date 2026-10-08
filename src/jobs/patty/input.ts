// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pauseAllForeground } from "./lifecycle.js";
import type { BackgroundRegistry } from "./state.js";

/** Release tool waits, never abort the agent run or create a second prompt.
 * Pi queues the original input (including images) at its normal tool boundary. */
export function registerInputHandlers(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.on("input", async (event, ctx) => {
        if (event.source !== "extension" || event.streamingBehavior === "steer") pauseAllForeground(reg, ctx);
        return { action: "continue" };
    });
}
