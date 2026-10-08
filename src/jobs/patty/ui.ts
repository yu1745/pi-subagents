// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
import type { BackgroundRegistry } from "./state.js";
import type { UiContext } from "./types.js";

/** /bg-list is an alias for the same task tree, not a second job manager. */
export async function openBgListPanel(reg: BackgroundRegistry, ctx: UiContext): Promise<void> {
    if (reg.disposed) return;
    if (reg.taskUI) reg.taskUI.open();
    else ctx.ui.notify("Task navigation is unavailable in this session. Use the jobs tool to inspect tasks.", "info");
}
