# Fork maintenance

This fork (`yu1745/pi-subagents`) is maintained independently for a parent-supervised subagent workflow. Upstream is https://github.com/tintinweb/pi-subagents (branch `master`).

## Policy

- Maintain custom features directly in source, with tests and documentation. Do not regenerate the fork from inline CI patches.
- No scheduled upstream resets or force-push synchronization. The former `sync-and-patch.yml` workflow has been disabled on GitHub and removed from this checkout.
- Review upstream changes manually and selectively merge or cherry-pick useful fixes. Fetching upstream must not replace local customizations.
- Preserve upstream attribution and licensing, and the existing turn-counter glyph spacing fix.
- Follow `AGENTS.md` for development and verification. Commits and pushes remain manual unless explicitly authorized.

## Upstream review

If needed, configure the local remote once:

```sh
git remote add upstream https://github.com/tintinweb/pi-subagents.git
```

Fetch and inspect without modifying the working tree:

```sh
git fetch upstream master
git log --oneline HEAD..upstream/master
git diff HEAD...upstream/master -- src test
```

Inspect individual commits before integrating them. Run the repository checks after integration; do not restore the old hard-reset synchronization workflow.

## Planned customization

Parent supervision is delivered for top-level background agents: `get_subagent_activity` returns bounded cursor-based public activity, and opt-in session-scoped `watch_subagent` sends deferred/coalesced evidence notifications for evidence-based steering. v1 excludes nested children and workflow-owned agents.
