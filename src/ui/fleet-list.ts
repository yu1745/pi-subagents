/**
 * fleet-list.ts — Claude Code-style "FleetView" list rendered below the editor.
 *
 * Shows `main` + each running/queued subagent as a navigable list. Pressing ↓ (or
 * ←) at an empty prompt activates the list; ↑/↓ move the selection (filled ● marker),
 * Enter opens the selected agent's conversation (native or legacy fallback), Esc returns to the prompt.
 * A viewer stays open when its agent finishes; finished agents linger briefly in the list.
 *
 * Mechanics (see plan): the list is a `belowEditor` widget (render-only), and ALL key
 * handling goes through `onTerminalInput` — which fires before the focused editor and
 * can `consume` keys — gated on `getEditorText() === ""` so normal typing is untouched.
 */

import { Editor, isKeyRelease, Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { hasAgentBadge, renderAgentName } from "../agent-color.js";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import { terminateJobSilently } from "../jobs/patty/lifecycle.js";
import { acquireLogLease } from "../jobs/patty/log-leases.js";
import { cleanupJob } from "../jobs/patty/registry.js";
import type { BackgroundRegistry } from "../jobs/patty/state.js";
import { isTerminalStatus, type Job } from "../jobs/patty/types.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeCost, getLifetimeTotal } from "../usage.js";
import { FORCE_STEER_KEY } from "../user-steer.js";
import { formatCost, type Theme } from "./agent-widget.js";
import { openJobLogView } from "./job-log-view.js";
import { type LegacyViewerOptions, openAgentSessionView, type SessionViewUI } from "./session-view.js";

/** Widget key for the below-editor fleet list. */
const FLEET_KEY = "fleet";
/** Max agent rows shown at once; extras collapse into a "↓ N more" indicator. */
const MAX_AGENT_ROWS = 5;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** Avoid expanding the tree for commands that finish almost immediately. */
const JOB_ROW_DELAY_MS = 500;
/** How long a finished agent lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 4000;

/** Minimal UI surface the FleetView needs from `ctx.ui` (structural subset). */
export type FleetUICtx = SessionViewUI & {
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
};

/**
 * A workflow run, as the fleet list needs to see it.
 *
 * Narrow on purpose: the list knows nothing about `WorkflowTask`, the runtime
 * or the dialog, so it stays as testable as it was when it only held agents.
 * The extension maps its tasks into this shape and injects an opener.
 */
export interface FleetWorkflow {
  id: string;
  /** The `meta.name` of the run, or its id when the script named nothing. */
  name: string;
  status: "running" | "completed" | "failed" | "killed" | "paused";
  doneCount: number;
  totalCount: number;
  startedAt: number;
  /** Set once the run settles, which is what freezes its clock. */
  completedAt?: number;
  tokens: number;
}

type MainEntry = { kind: "main" };
type AgentEntry = { kind: "agent"; record: AgentRecord };
type WorkflowEntry = { kind: "workflow"; workflow: FleetWorkflow };
type JobEntry = { kind: "job"; job: Job; depth: number };
type GroupEntry = { kind: "group"; id: string; label: string; depth: number };
type OwnerEntry = { kind: "owner"; id: string; description: string };
type FleetEntry = MainEntry | WorkflowEntry | AgentEntry | JobEntry | GroupEntry | OwnerEntry;

function entryKey(entry: FleetEntry): string {
  return entry.kind === "agent" ? `agent:${entry.record.id}`
    : entry.kind === "job" ? `job:${entry.job.id}`
    : entry.kind === "workflow" ? `workflow:${entry.workflow.id}`
    : entry.kind === "main" ? "main" : `${entry.kind}:${entry.id}`;
}

function safeLabel(text: string): string {
  return stripTerminalSequences(text).replace(/[\r\n\t]/g, " ");
}

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** `↓ 13.1k tokens` — down-arrow prefix, compact magnitude, plural "tokens". */
export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact} tokens`;
}

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 * The final clamp guarantees the line never exceeds `width` (which would wrap and
 * desync pi's line-diff → flicker) even on a terminal too narrow for the stats.
 */
function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  private enabled = true;
  /** Whether arrow keys currently navigate the list (vs. flow to the editor). */
  private active = false;
  /** 0 = `main`, 1..N = subagents. */
  private selectedIndex = 0;
  private selectedKey = "main";
  /** Set while a view is open; closes presentation, not execution. */
  private viewerClose: (() => void) | undefined;
  private viewerToken: symbol | undefined;
  private viewingAgentId: string | undefined;
  /** Injected by the extension; absent until workflows are wired (or at all). */
  private workflowSource: (() => readonly FleetWorkflow[]) | undefined;
  private openWorkflow: ((id: string) => Promise<void> | void) | undefined;
  /**
   * Set while the workflow inspector is up.
   *
   * It does the two jobs `viewerClose` does for an agent's overlay — keep the
   * list out of the dialog's keys, and remember which row to come back to —
   * minus the close handle, because that overlay belongs to the extension.
   */
  private viewingWorkflowId: string | undefined;
  private jobs: BackgroundRegistry | undefined;
  private rootSessionId: (() => string | undefined) | undefined;
  private knownOwners = new Map<string, string>();
  private collapsed = new Set<string>();
  private expandedCompleted = new Set<string>();
  private viewingJobId: string | undefined;
  private confirmation: { entry: AgentEntry | JobEntry; action: "stop" | "clean" } | undefined;
  private actionPending = false;
  private generation = 0;

  constructor(
    private manager: AgentManager,
    /**
     * Read live at render time. Whether each row shows an estimated cost after
     * its token count. Defaults to off — the extension supplies the user's
     * `showCost` setting.
     */
    private showCost: () => boolean = () => false,
    /** Existing overlay settings/activity, used only when native viewing is unavailable. */
    private legacyViewerOptions?: (record: AgentRecord) => LegacyViewerOptions,
  ) {}

  setJobSource(registry: BackgroundRegistry, rootSessionId: () => string | undefined): void {
    this.jobs = registry;
    this.rootSessionId = rootSessionId;
  }

  /** Slash-command alias enters the very same tree. */
  activate(): void {
    if (!this.ui) return;
    if (!this.enabled) { this.ui.notify("Enable Fleet view in /agents → Settings to navigate tasks.", "info"); return; }
    if (this.viewerClose || this.viewingWorkflowId) return;
    this.active = true;
    this.selectIndex(0);
    this.update();
    if (this.roster(true).length <= 1) this.ui.notify("No tasks in this session.", "info");
  }

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) { this.active = false; this.confirmation = undefined; }
    this.update();
  }

  /** Capture the UI context and (re)register the global input handler. */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput(data => this.handleKey(data));
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  /**
   * Called when an agent finishes. The viewer (if open on it) stays open so the
   * final output remains readable, and the row lingers in the list — just refresh.
   */
  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    this.generation++;
    this.confirmation = undefined;
    this.actionPending = false;
    this.knownOwners.clear();
    this.collapsed.clear();
    this.expandedCompleted.clear();
    this.viewingJobId = undefined;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    this.viewerToken = undefined;
    if (this.viewerClose) { this.viewerClose(); this.viewerClose = undefined; }
    this.viewingAgentId = undefined;
    // No handle to close the workflow inspector with, but the list is going
    // away — leaving the id set would keep it swallowing input forever.
    this.viewingWorkflowId = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.active = false;
    // Null last so a `viewerClose()` microtask above can't re-register the widget.
    this.ui = undefined;
  }

  /** Re-register/refresh the below-editor widget; clears it when nothing remains. */
  update(): void {
    if (!this.ui) return;
    // A run with no agents of its own left in the list is still worth a row —
    // it is the thing the user opens to see what its children did. Read off the
    // roster for the same reason activation does: two counts of "is there
    // anything here" drifted apart once before.
    // Pending rows keep the timer alive even when nothing is visible yet.
    const hasRows = this.enabled && this.roster(true, true).length > 1;

    if (!hasRows) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      this.active = false;
      this.selectIndex(0);
      return;
    }

    this.clampSelection();
    this.ensureTimer(); // keep stats ticking whenever the list is shown (e.g. after a re-enable)

    if (!this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (w: number) => this.renderBar(w, theme),
          invalidate: () => { this.widgetRegistered = false; this.tui = undefined; },
        };
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  // ---- Roster ----

  /**
   * Agents shown in the list, ordered earliest-launched first so the ones you
   * started sooner sit at the top. Every row is openable (has a session), so Enter
   * never dead-ends. Included: running/queued, plus the agent currently being
   * viewed, plus recently-finished ones (they linger briefly before dropping out).
   * Pending agents with no session yet are hidden until they start.
   * (`listAgents()` is newest-first, so we re-sort.)
   */
  private agentRecords(): AgentRecord[] {
    const now = Date.now();
    return this.manager.listAgents()
      .filter(a => isTopLevelAgent(a) && (a.session || (this.manager.hasJobRuntime && (a.status === "running" || a.status === "queued"))) && (
        a.status === "running" || a.status === "queued"
        || a.id === this.viewingAgentId
        || (a.completedAt != null && now - a.completedAt < FINISHED_LINGER_MS)
      ))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Wire workflow runs into the list.
   *
   * Injected rather than constructed here because the fleet list predates
   * workflows and must keep working without them — a session with the feature
   * switched off never calls this, and the roster is agents-only exactly as
   * before.
   */
  setWorkflowSource(
    source: () => readonly FleetWorkflow[],
    open: (id: string) => Promise<void> | void,
  ): void {
    this.workflowSource = source;
    this.openWorkflow = open;
  }

  /** Live runs, plus recently settled ones — the same linger the agents get. */
  private workflows(): FleetWorkflow[] {
    if (!this.workflowSource) return [];
    const now = Date.now();
    return [...this.workflowSource()]
      .filter(run =>
        run.status === "running"
        || run.status === "paused"
        || (run.completedAt != null && now - run.completedAt < FINISHED_LINGER_MS)
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Runs sit above the agents rather than interleaved by start time: a run owns
   * most of the agents under it, so listing the container first is what makes
   * the list read as a hierarchy rather than a shuffle.
   */
  private roster(ignoreCollapse = false, includePending = false): FleetEntry[] {
    const entries: FleetEntry[] = [{ kind: "main" }];
    // Only owners already visible in this scope may introduce job rows. Never
    // infer visibility from the all-jobs store or turn an unknown owner into main.
    const records = this.manager.listAgents().filter(isTopLevelAgent);
    for (const record of records) this.knownOwners.set(record.id, record.description);
    const jobs = this.jobs && !this.jobs.disposed ? [...this.jobs.jobs.values()].filter(job =>
      job.ownerAgentId ? this.knownOwners.has(job.ownerAgentId)
        : job.ownerSessionId === this.rootSessionId?.(),
    ).sort((a, b) => a.startTime - b.startTime) : [];
    for (const id of this.knownOwners.keys()) {
      if (!records.some(record => record.id === id) && !jobs.some(job => job.ownerAgentId === id)) this.knownOwners.delete(id);
    }
    const addJobs = (owner: string | undefined, depth: number) => {
      const owned = jobs.filter(job => job.ownerAgentId === owner);
      const done = owned.filter(job => isTerminalStatus(job.status));
      entries.push(...owned.filter(job => !isTerminalStatus(job.status)
        && (includePending || Date.now() - job.startTime >= JOB_ROW_DELAY_MS))
        .map(job => ({ kind: "job" as const, job, depth })));
      if (done.length) {
        const id = `completed:${owner ?? "main"}`;
        const failed = done.filter(job => job.status === "failed" || job.status === "killed").length;
        entries.push({ kind: "group", id, label: `Completed (${done.length}${failed ? `, ${failed} failed/stopped` : ""})`, depth });
        if (ignoreCollapse || this.expandedCompleted.has(id) || done.some(job => job.id === this.viewingJobId)) {
          entries.push(...done.map(job => ({ kind: "job" as const, job, depth: depth + 1 })));
        }
      }
    };
    if (!ignoreCollapse && this.collapsed.has("main")) return entries;
    entries.push(...this.workflows().map(workflow => ({ kind: "workflow" as const, workflow })));
    const visible = this.jobs ? records.filter(record => record.session || record.status === "running" || record.status === "queued" || jobs.some(job => job.ownerAgentId === record.id))
      .sort((a, b) => a.startedAt - b.startedAt) : this.agentRecords();
    for (const record of visible) {
      entries.push({ kind: "agent", record });
      if (ignoreCollapse || !this.collapsed.has(`agent:${record.id}`)) addJobs(record.id, 2);
    }
    // Keep only a label for evicted owners, not a retained AgentSession. Logs
    // outlive agent GC, but never gain a new steering/execution capability.
    for (const [id, description] of this.knownOwners) {
      if (!records.some(record => record.id === id) && jobs.some(job => job.ownerAgentId === id)) {
        entries.push({ kind: "owner", id, description });
        if (ignoreCollapse || !this.collapsed.has(`owner:${id}`)) addJobs(id, 2);
      }
    }
    addJobs(undefined, 1);
    return entries;
  }

  private selectIndex(index: number): void {
    this.selectedIndex = index;
    const entry = this.roster()[index];
    this.selectedKey = entry ? entryKey(entry) : "main";
  }

  private clampSelection(): void {
    const rows = this.roster();
    const stable = rows.findIndex(entry => entryKey(entry) === this.selectedKey);
    this.selectIndex(stable >= 0 ? stable : Math.max(0, Math.min(this.selectedIndex, rows.length - 1)));
  }

  // ---- Key handling ----

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only, or every
    // tap would move/fire twice. Repeats still pass through for held-key nav.
    if (isKeyRelease(data)) return undefined;
    // While an overlay is open, let it own all input. Checked before the focus
    // test below, which would otherwise read the dialog holding the keyboard as
    // "the user left the list" and reset the selection out from under it.
    if (this.viewerClose || this.viewingWorkflowId || this.manager.hasSessionViews()) return undefined;
    // Input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. So when
    // anything but the editor owns the keyboard, stay out of its keys (#123).
    if (!this.editorHasFocus()) {
      this.confirmation = undefined;
      if (this.active) this.deactivate();
      return undefined;
    }
    this.clampSelection();
    if (this.actionPending) return { consume: true };
    if (this.confirmation) {
      if (matchesKey(data, "escape") || matchesKey(data, "n")) this.confirmation = undefined;
      else if (matchesKey(data, "y") || matchesKey(data, Key.enter)) void this.confirmAction();
      this.update();
      return { consume: true };
    }
    if (!this.active) {
      // Activate: ↓ or ← at an empty prompt moves focus into the list.
      const isActivator = matchesKey(data, "down") || matchesKey(data, "left");
      // Gated on the roster, not the agents: a session whose only row is a
      // workflow run still has somewhere to go, and requiring an agent would
      // render the row but refuse to move into it.
      if (isActivator && this.roster(true).length > 1 && this.ui.getEditorText() === "") {
        this.active = true;
        this.selectIndex(0);
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Active — arrows navigate, Enter opens, Esc / Up-past-top exits.
    if (matchesKey(data, "down")) {
      const max = this.roster().length - 1;
      this.selectIndex(Math.min(max, this.selectedIndex + 1));
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      if (this.selectedIndex === 0) { this.deactivate(); return { consume: true }; }
      this.selectIndex(this.selectedIndex - 1);
      this.update();
      return { consume: true };
    }
    if (this.jobs && (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "space"))) {
      this.toggleSelected(matchesKey(data, "left") ? false : matchesKey(data, "right") ? true : undefined);
      return { consume: true };
    }
    if (this.jobs && (matchesKey(data, "x") || matchesKey(data, "d"))) {
      const entry = this.roster()[this.selectedIndex];
      const clean = matchesKey(data, "d");
      if (entry?.kind === "job" && (clean ? isTerminalStatus(entry.job.status) : entry.job.status === "running")) {
        this.confirmation = { entry, action: clean ? "clean" : "stop" };
      } else if (!clean && entry?.kind === "agent" && (entry.record.status === "running" || entry.record.status === "queued")) {
        this.confirmation = { entry, action: "stop" };
      }
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) { this.deactivate(); return { consume: true }; }
    if (matchesKey(data, Key.enter)) { this.openSelected(); return { consume: true }; }
    if (this.manager.hasJobRuntime && matchesKey(data, FORCE_STEER_KEY)) { this.openSelected(true); return { consume: true }; }

    // Any other key cancels navigation and flows to the editor.
    this.deactivate();
    return undefined;
  }

  /**
   * True when pi's prompt editor owns the keyboard. pi's editor is an `Editor`
   * subclass (CustomEditor) while every dialog/selector is not, and the loader
   * aliases pi-tui to pi's own copy, so `instanceof` is a reliable identity
   * check. `focusedComponent` is TUI-private (no public accessor), hence the
   * best-effort peek: unknowable focus (no tui seen yet, nothing focused)
   * counts as the editor so activation keeps working.
   */
  private editorHasFocus(): boolean {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    return focused == null || focused instanceof Editor;
  }

  private deactivate(): void {
    this.active = false;
    this.selectIndex(0);
    this.update();
  }

  private toggleSelected(expand?: boolean): void {
    const entry = this.roster()[this.selectedIndex];
    if (!entry) return;
    if (entry.kind === "group") {
      const next = expand ?? !this.expandedCompleted.has(entry.id);
      if (next) this.expandedCompleted.add(entry.id);
      else this.expandedCompleted.delete(entry.id);
    } else if (entry.kind === "main" || entry.kind === "agent" || entry.kind === "owner") {
      const key = entryKey(entry);
      const next = expand ?? this.collapsed.has(key);
      if (next) this.collapsed.delete(key);
      else this.collapsed.add(key);
    }
    this.update();
  }

  private async confirmAction(): Promise<void> {
    const pending = this.confirmation;
    this.confirmation = undefined;
    if (!pending) return;
    const { entry, action } = pending;
    const generation = this.generation;
    this.actionPending = true;
    try {
      if (entry.kind === "agent") {
        if (this.manager.getRecord(entry.record.id) === entry.record) this.manager.abort(entry.record.id);
      } else if (this.jobs && !this.jobs.disposed && this.jobs.jobs.get(entry.job.id) === entry.job) {
        if (action === "clean") {
          const removed = cleanupJob(this.jobs, entry.job);
          this.ui?.notify(removed ? `Removed ${entry.job.id} and its logs.` : "Task is active or its log is being viewed; close the viewer and retry cleanup.", removed ? "info" : "warning");
        } else if (entry.job.status === "running") {
          const stopped = await terminateJobSilently(this.jobs, entry.job);
          if (generation === this.generation) this.ui?.notify(stopped ? `Stopped ${entry.job.id}; its Agent was not stopped.` : `Termination of ${entry.job.id} is unconfirmed.`, stopped ? "info" : "error");
        }
      }
    } catch (error) {
      if (generation === this.generation) this.ui?.notify(`Task action failed: ${String(error)}`, "error");
    } finally {
      if (generation === this.generation) { this.actionPending = false; this.update(); }
    }
  }

  private openSelected(forceSteer = false): void {
    const entry = this.roster()[this.selectedIndex];
    // A shell is never an agent: Ctrl+Alt+S must not become a shell prompt.
    if (forceSteer && entry?.kind !== "agent") return;
    if (entry?.kind === "group" || entry?.kind === "owner") { this.toggleSelected(); return; }
    if (entry?.kind === "job") {
      if (!this.ui || !this.jobs || this.jobs.jobs.get(entry.job.id) !== entry.job) return;
      const release = acquireLogLease(entry.job);
      const view = openJobLogView(this.ui, entry.job);
      if (!view) { release(); return; }
      const token = Symbol();
      this.viewerToken = token;
      this.viewingJobId = entry.job.id;
      this.viewerClose = view.close;
      void view.closed.catch(error => {
        if (this.viewerToken === token) this.ui?.notify(`Could not open log: ${String(error)}`, "warning");
      }).finally(() => { release(); this.clearViewer(token); });
      return;
    }
    if (!entry || entry.kind === "main") {
      // `main` = return to the prompt; the native transcript is already shown.
      this.deactivate();
      return;
    }
    if (entry.kind === "workflow") {
      // The extension owns this overlay and closes it, so there is no
      // `viewerClose` to hold — but the list still has to know one is up, and
      // still has to put the cursor back on the run when it comes down.
      this.viewingWorkflowId = entry.workflow.id;
      const token = Symbol();
      this.viewerToken = token;
      void (async () => this.openWorkflow?.(entry.workflow.id))().then(
        () => this.clearViewer(token),
        () => this.clearViewer(token),
      );
      return;
    }
    const record = entry.record;
    if (!this.ui) return;
    const view = openAgentSessionView(this.manager, this.ui, record, {
      showCost: this.showCost(), ...this.legacyViewerOptions?.(record), initialForceSteer: forceSteer,
    });
    if (!view) return;
    const token = Symbol();
    this.viewerToken = token;
    this.viewingAgentId = record.id;
    this.viewerClose = view.close;
    void view.closed.then(
      () => this.clearViewer(token),
      error => {
        if (this.viewerToken !== token) return;
        this.ui?.notify(`Could not open the conversation: ${error instanceof Error ? error.message : String(error)}`, "warning");
        this.clearViewer(token);
      },
    );
  }

  /** Reset overlay state and return to the list (on close, auto-close, or error). */
  private clearViewer(token: symbol): void {
    if (this.viewerToken !== token) return;
    this.viewerToken = undefined;
    // Keep the cursor on the agent we were viewing — re-resolve by id so it
    // still feels natural if the list reordered (an earlier agent finished)
    // while the overlay was open. If that agent is gone, leave the index for
    // update()'s clamp to settle.
    const viewed = this.viewingAgentId ?? this.viewingWorkflowId ?? this.viewingJobId;
    if (this.viewingJobId) {
      const job = this.jobs?.jobs.get(this.viewingJobId);
      if (job && isTerminalStatus(job.status)) this.expandedCompleted.add(`completed:${job.ownerAgentId ?? "main"}`);
    }
    if (viewed !== undefined) {
      const idx = this.roster().findIndex(e =>
        e.kind === "agent" ? e.record.id === viewed
        : e.kind === "workflow" ? e.workflow.id === viewed
        : e.kind === "job" ? e.job.id === viewed : false,
      );
      if (idx >= 0) this.selectIndex(idx);
    }
    this.viewerClose = undefined;
    this.viewingJobId = undefined;
    this.viewingAgentId = undefined;
    this.viewingWorkflowId = undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    const rows = this.roster().slice(1);
    if (rows.length === 0 && this.roster(true).length <= 1) return [];
    // Clamp locally so a render between a roster shrink and the next update()
    // (e.g. on terminal resize) never loses the selection marker.
    const stable = this.roster().findIndex(entry => entryKey(entry) === this.selectedKey);
    const sel = stable >= 0 ? stable : Math.min(this.selectedIndex, rows.length);

    const selected = this.roster()[sel];
    const hint = this.confirmation ? `${this.confirmation.action === "clean" ? "Remove task and logs" : this.confirmation.entry.kind === "agent" ? "Stop Agent and its owned tasks/descendants" : "Stop bash process group ONLY (Agent continues)"}: ${safeLabel(this.confirmation.entry.kind === "agent" ? this.confirmation.entry.record.description : this.confirmation.entry.job.id)}? Enter/y confirm · Esc/n cancel`
      : this.actionPending ? "Task action in progress…"
      : this.active
        ? `↑↓ select · enter view${this.jobs ? " · ←→ fold · x stop · d clean" : ""}${this.manager.hasJobRuntime && selected?.kind === "agent" ? " · Ctrl+Alt+S force steer" : ""} · esc back`
        : this.jobs ? "esc to interrupt · ↓ tasks" : "esc to interrupt · ← for agents · ↓ to manage";
    const lines: string[] = [];
    lines.push(truncateToWidth("  " + theme.fg("dim", hint), width));
    lines.push("");
    lines.push(truncateToWidth(`  ${this.bullet(0, sel, theme)} ${this.jobs ? this.collapsed.has("main") ? "▸ " : "▾ " : ""}main`, width));

    // Window the rows so the selected one stays visible.
    const visible = Math.min(MAX_AGENT_ROWS, rows.length);
    const selRow = Math.max(0, sel - 1);
    const start = selRow < visible ? 0 : selRow - visible + 1;
    const hiddenBelow = rows.length - (start + visible);

    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (let a = start; a < start + visible; a++) {
      const row = rows[a];
      lines.push(
        row.kind === "workflow" ?
          this.renderWorkflowRow(a + 1, sel, row.workflow, width, theme)
        : row.kind === "agent" ? this.renderAgentRow(a + 1, sel, row.record, width, theme)
        : this.renderTaskRow(a + 1, sel, row, width, theme),
      );
    }
    if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));

    return lines;
  }

  private renderTaskRow(index: number, sel: number, row: FleetEntry, width: number, theme: Theme): string {
    if (row.kind === "job") {
      const job = row.job;
      const colour = job.status === "failed" || job.status === "killed" ? "error" : job.status === "completed" ? "success" : "text";
      const label = `${job.kind === "agent" ? "process" : job.kind === "monitor" ? "monitor" : "bash"} ${safeLabel(job.name ?? job.command)} (${job.id})`;
      const status = `${job.status}${job.exitCode !== undefined ? ` exit=${job.exitCode}` : ""} · ${formatFleetElapsed((job.endTime ?? Date.now()) - job.startTime)}`;
      return rightAlign(`${"  ".repeat(row.depth + 1)}${this.bullet(index, sel, theme)} ${label}`, theme.fg(colour, status), width);
    }
    if (row.kind === "group") return truncateToWidth(`${"  ".repeat(row.depth + 1)}${this.bullet(index, sel, theme)} ${this.expandedCompleted.has(row.id) ? "▾" : "▸"} ${theme.fg(row.label.includes("failed") ? "error" : "muted", row.label)}`, width);
    if (row.kind === "owner") return truncateToWidth(`    ${this.bullet(index, sel, theme)} ${this.collapsed.has(`owner:${row.id}`) ? "▸" : "▾"} Agent ${safeLabel(row.description)} (session released)`, width);
    return "";
  }

  private bullet(rosterIndex: number, sel: number, theme: Theme): string {
    return rosterIndex === sel ? theme.fg("accent", "●") : theme.fg("dim", "○");
  }

  /**
   * A run's row. Shaped like an agent's — bullet, kind, name, stats flush right
   * — so the two read as one list, with the agent count where an agent has its
   * description and the same elapsed/token tail.
   */
  private renderWorkflowRow(
    rosterIndex: number,
    sel: number,
    workflow: FleetWorkflow,
    width: number,
    theme: Theme,
  ): string {
    const selected = rosterIndex === sel;
    const kind = theme.fg(selected ? "text" : "muted", "workflow");
    const name = selected ? theme.fg("text", workflow.name) : workflow.name;
    const left = `  ${this.bullet(rosterIndex, sel, theme)} ${kind}  ${name}`;
    // Frozen once the run settles, exactly as an agent's clock is.
    const elapsed = (workflow.completedAt ?? Date.now()) - workflow.startedAt;
    const agents = `${workflow.doneCount}/${workflow.totalCount} agent${workflow.totalCount === 1 ? "" : "s"}`;
    const stats = `${agents} · ${formatFleetElapsed(elapsed)} · ${formatFleetTokens(workflow.tokens)}`;
    return rightAlign(left, selected ? theme.fg("text", stats) : theme.fg("dim", stats), width);
  }

  private renderAgentRow(rosterIndex: number, sel: number, record: AgentRecord, width: number, theme: Theme): string {
    // The selected row renders in the theme's primary text color so it reads as
    // one selection (#230). A configured badge survives — Claude Code's FleetView
    // keeps the agent color on the selected row too and only bolds it — which also
    // keeps the row's width fixed as the selection moves.
    const selected = rosterIndex === sel;
    const name = renderAgentName(record.type, theme, selected
      ? { fallbackColor: "text", bold: hasAgentBadge(record.type) }
      : { fallbackColor: "muted" });
    const description = selected ? theme.fg("text", record.description) : record.description;
    const left = `${this.jobs ? "    " : "  "}${this.bullet(rosterIndex, sel, theme)} ${this.jobs ? this.collapsed.has(`agent:${record.id}`) ? "▸ " : "▾ " : ""}${name}  ${description}`;
    // The record, not the activity tracker — see the note in AgentWidget's
    // running line: only the record carries a nested child's spend, and only it
    // outlives the agent.
    const tokens = getLifetimeTotal(record.lifetimeUsage);
    const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt; // freezes once finished
    const cost = this.showCost() ? formatCost(getLifetimeCost(record.lifetimeUsage)) : "";
    const stats = `${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(tokens)}${cost ? ` · ${cost}` : ""}`;
    const failed = record.status === "error" || record.status === "aborted" || record.status === "stopped";
    const right = this.jobs ? theme.fg(failed ? "error" : selected ? "text" : "dim", `${record.status} · ${stats}`)
      : selected ? theme.fg("text", stats) : theme.fg("dim", stats);
    return rightAlign(left, right, width);
  }
}
