# Owned background jobs and direct user steering

For users of the integrated shell runtime and maintainers reviewing its lifecycle. Enabled by default in new Pi processes; existing sessions are not reloaded.

## Default activation and migration

After updating pi-subagents, launch ordinary **`pi` in a new process**. No activation flag or separate Patty installation is required. pi-subagents provides `bash`, `bash_bg`, `jobs`, `monitor`, and `agent_bg` for the main session, even when no subagent runs. Remove the standalone pi-patty-bg-tasks package registration when migrating. If the updated standalone copy is deliberately retained for rollback, it skips registration by default regardless of extension load order. An older Patty copy without that guard must not be loaded alongside the merged runtime.

To disable the merged runtime for one process, start `PI_SUBAGENTS_JOB_RUNTIME=0 pi`. This does not reinstall Patty: standalone background tools are available only if its package registration is explicitly restored. Only the exact value `0` disables fusion; `1` remains accepted but is unnecessary. Do not change the variable halfway through an activation. A standalone Patty-only installation of this fork must also use `0`.

Do not reload/uninstall a provider holding live tasks. Existing sessions can finish normally on their original instance while separate new processes use the merged runtime. There is no live registry transfer. No package removal, model/provider change, or global settings rewrite is needed when these two local git packages are already registered. `PI_PATTY_DISABLE_AGENT_BG` still disables the external `pi -p` helper.

Eligible non-isolated child sessions receive the same service through an explicit inline extension, not a second standalone registry or a global lookup. `extensions: false`, isolated agents, and extension/tool filters remain authoritative. The extension names `pi-subagents-jobs` and `pi-patty-bg-tasks` identify this surface for filtering. If omitted, their normal tools and queue semantics remain in force.

## Ownership and controls

One activation owns a shared job store. Each job records the owning agent, session, working directory, process capability and capture paths. Main can inspect/control all jobs; a child can inspect/control only its own. Foreground wait slots are owner-scoped: steering main cannot release a child's wait and vice versa. The shared running-job cap is 16.

| Operation | Effect |
| --- | --- |
| Normal `bash` | Waits for completion; keeps captured output. |
| Interactive/explicit steer while owned `bash` waits | Releases **that wait** immediately and returns job ID/capture path; shell continues. |
| `bash(run_in_background: true)` / `bash_bg` | Starts tracked background work and returns its ID. |
| `jobs(action: "attach")` on a shell | Waits again; steer or cancellation detaches without killing the shell. |
| Esc cancelling foreground `bash` | Terminates its supervised process group, escalating TERM to KILL. |
| `jobs(action: "kill")` / Agent stop | Terminates the job / owned jobs and descendants. |
| `jobs(action: "cleanup")` | Deletes only terminal jobs and their captures; never live work or active attach consumers. |

Only merged local shell waits and shell attach waits have the fast-release behavior. `read`, `write`, `edit`, arbitrary third-party tools, monitor attach, and unmerged builtin bash do **not** get globally interrupted or cancelled. Their steering stays queued. Passive extension follow-ups do not release waits. The foreground timeout defaults to 60 seconds and promotes the command to background rather than killing execution; explicit timeouts must be finite, positive and at most 86400 seconds.

## Lifecycle and output

The original run/resume promise, event collectors, concurrency slot, and worktree remain alive while owned jobs run. Steering an idle session in this drain phase starts a continuation **inside that same promise**. Natural completion occurs only after jobs settle. Persistent monitors therefore keep their owner running until explicitly stopped. Abort, hard turn cap, provider failure, session switch and shutdown stop owned processes before cleanup; unconfirmed termination prevents releasing the worktree. Resume-turn accounting is separate from job ownership.

Logs and terminal metadata remain available after agent completion and memory cleanup, until explicit job cleanup. `jobs output` returns a bounded tail; `jobs search` searches the retained capture, and the returned path allows reading the full shell log. Monitor output retains its existing bounded/rolling behavior: it is not an unlimited historical archive. Counters and terminal notifications are accounted once; attaching consumers suppress premature completion notices without losing a detached job's eventual notice.

State is activation-memory, not a durable process registry. Conversation resume restores chat history, **not running processes**. Supervisor/process-group termination covers ordinary descendants, including TERM-resistant processes, but does not guarantee control over `setsid`/cgroup escapes, arbitrary host crashes, or cross-host restart. `agent_bg` remains an external `pi -p` subprocess, not a native SDK child with steering/resume semantics.

## Direct user steering from child views

With the runtime enabled, press **Ctrl+Alt+S** in the child viewer or on a selected FleetView row to open the force-steer composer. Native transcript presentation stays readonly; ordinary typing/paste does not become a prompt until the composer is open. Queued children without a session get a composer instead of a fabricated transcript. Enter submits; Esc or blank input cancels without stopping the child. Finished/stopped children reject submission.

“Force” means release an eligible owned shell **wait**, not SIGINT, session restart, or a global tool abort. The exact untrimmed user message is delivered to the child (or its startup queue). A separately marked `[USER DIRECT SUBAGENT STEER]` JSON notice carries that original text, agent ID/name/alias, direct-parent ID and unique notice ID to **only its direct parent**. For top-level children the actual main AgentSession receives a steer; idle main sessions leave it queued for the next normal turn. Programmatic steering and mentions do not echo these notices, preventing forwarding loops.

Delivery statuses distinguish child acceptance from parent acceptance. Parent acceptance means SDK queue acknowledgment, not model execution or comprehension. If parent delivery fails after child acceptance, the UI retains a visible partial receipt. **Ctrl+Alt+R** retries only the pending parent notice, in FIFO order for that parent; it never replays the child message. Duplicate submission is blocked while pending. An ended/replaced parent or changed main session is rejected rather than rerouted. The outbox is in-memory, not a durable transactional delivery guarantee across process restart.

See [provenance](../src/jobs/PROVENANCE.md) for the upstream MIT-derived implementation and integration changes.
