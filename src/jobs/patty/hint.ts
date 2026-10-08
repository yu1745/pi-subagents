// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
/**
 * Live "(ctrl+shift+b to run in background)" hint shown below the editor while
 * a foreground bash command is running — mirrors Claude Code's BackgroundHint,
 * which appears once a command has run past the quick-completion window.
 */

import type { UiContext } from "./types.js";

const HINT_KEY = "bg-hint";

/**
 * Ref-count of foreground commands currently showing the hint. The widget is a
 * single shared key, but bash commands run in parallel — so we only render it on
 * the 0→1 transition and clear it on the last 1→0, keeping the hint up as long
 * as any foreground command is still running. Each caller must pair exactly one
 * showBackgroundHint() with one clearBackgroundHint().
 */
const hints = new WeakMap<UiContext["ui"], number>();

/** Show the background hint below the editor (idempotent across parallel commands). */
export function showBackgroundHint(ctx: UiContext): void {
    const activeHints = (hints.get(ctx.ui) ?? 0) + 1;
    hints.set(ctx.ui, activeHints);
    if (activeHints === 1) {
        try {
            ctx.ui.setWidget(HINT_KEY, ["(ctrl+shift+b to run in background)"], {
                placement: "belowEditor",
            });
        } catch { /* Rendering must not strand foreground cleanup on stale ctx. */ }
    }
}

/** Release one hint; clears the widget only when the last command is done. */
export function clearBackgroundHint(ctx: UiContext, render = true): void {
    const activeHints = hints.get(ctx.ui) ?? 0;
    if (activeHints === 0) return;
    hints.set(ctx.ui, activeHints - 1);
    if (activeHints === 1 && render) {
        try { ctx.ui.setWidget(HINT_KEY, undefined); }
        catch { /* Old session UI is already gone. */ }
    }
}
