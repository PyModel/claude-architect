# Operations

## Filesystem requirements for managed worktrees

Managed-worktree mutation requires filesystem directory identities with a nonzero birth timestamp and same-directory hard-link support for durable manifest publication. Linux mounts or filesystems without stable birth time, plus exFAT or network mounts that reject hard links, are diagnostics-only: delegation and cleanup fail closed rather than risk inode reuse or an unowned transaction.

## Worktree cleanup guarantees

POSIX `unlink` and `rmdir` remove directory entries by name; they cannot atomically delete an already-opened inode. Cleanup therefore runs only after the supervised Producer tree has settled, moves the worktree outside Producer write scope, binds traversal to its opened inode, and rechecks the named identity at each removal boundary. A malicious process already running as the same OS account, or a sandbox or kernel escape that can mutate plugin state concurrently, is outside this guarantee.

Windows cleanup uses packaged x64/arm64 native helpers for ACL validation, directory flushing, and deletion by validated handle; it does not depend on PowerShell.

Emptying a disposable worktree's contents is bounded by a timeout (default 120s; override with `CLAUDE_ARCHITECT_EMPTY_DIRECTORY_TIMEOUT_MS` for repositories with an unusually large checkout such as a big `node_modules` tree). Exceeding it does not discard the attempt's own result: a baseline or attempt outcome that was already produced is archived with the teardown failure recorded alongside it, and the interrupted removal is retried by startup recovery.

## Update during an active attempt

The previously installed `${CLAUDE_PLUGIN_ROOT}` remains live for a running MCP server until `/reload-plugins`. After an update and reload, startup recovery on the next server start owns and cancels any unfinished run left by the old plugin root. Runtime state is stored under `${CLAUDE_PLUGIN_DATA}`, which remains stable across plugin versions.

Checkout locks are JSON records containing both `pid` and `processToken`. Recovery requires the process token to establish owner identity and never treats a PID alone as proof of ownership. A dead owner or a live PID whose start token differs from the recorded token is stale; only a live owner with a matching token retains its lock. Missing or malformed identity data fails closed rather than authorizing PID-only signalling or reclamation.

For a live unfinished process with a matching token, startup recovery requests cooperative termination first and waits for a grace period. If the process remains alive, recovery forcibly terminates its process tree and records whether cancellation completed cooperatively or required forced escalation. Dead processes and recycled PIDs with mismatched tokens are never signalled.
