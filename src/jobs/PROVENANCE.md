# Background runtime provenance

`patty/` is derived from the MIT-licensed pi-patty-bg-tasks source at
https://github.com/yu1745/pi-patty-bg-tasks, revision
`ba2db19f9db8608eaea54bfd6382b5e6d287b803`.
The original copyright and license are preserved in [patty/LICENSE](patty/LICENSE).

Copied infrastructure includes shell supervision and capture, job registry,
notifications, monitor sources, watchdog, tool adapters, commands and UI helpers.
These are local source copies, not a runtime dependency on another installed
extension. The upstream entry point is replaced by `runtime.ts`.

Integration changes add parent-owned storage with owner-scoped capabilities and
foreground waits, retained terminal results, shell-only steer/attach release,
confirmed process termination before worktree cleanup, and notification/attach
consumption coordination. `runtime.ts`, the manager/runner integration, and the
user-steer broker/composer are pi-subagents integration code. See
[the runtime guide](../../docs/job-runtime.md) for lifecycle and migration limits.
