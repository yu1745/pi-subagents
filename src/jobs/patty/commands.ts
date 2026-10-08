// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
/**
 * Slash command registration.
 *
 *   - /bg: same as Ctrl+Shift+B — background the foreground process
 *   - /bg-list: enter the unified task tree
 *   - /bg-version: show the loaded extension version/path
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { type ControlContext, takeControl } from "./lifecycle.js";
import type { BackgroundRegistry } from "./state.js";
import { openBgListPanel } from "./ui.js";

const packageJsonPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
const packageRoot = dirname(packageJsonPath);

/** Register all slash commands. */
export function registerCommands(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    pi.registerCommand("bg", {
        description: "Background the current process and hand control to the agent",
        handler: async (_args, ctx) => {
            takeControl(reg, ctx as unknown as ControlContext);
        },
    });

    pi.registerCommand("bg-list", {
        description: "Enter the unified Agent and bash task tree",
        handler: async (_args, ctx: ExtensionCommandContext) => {
            await openBgListPanel(reg, ctx);
        },
    });

    pi.registerCommand("bg-version", {
        description: "Show the loaded background tasks extension version",
        handler: async (_args, ctx) => {
            const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
                name?: string;
                version?: string;
            };
            ctx.ui.notify(
                `${pkg.name ?? "pi-patty-bg-tasks"}@${pkg.version ?? "unknown"} loaded from ${packageRoot}`,
                "info"
            );
        },
    });
}
