# Autopilot terminal states

What each terminal state proves, and what it forbids. The delegate skill points here.

The controller may proceed without a mid-loop prompt only while every eligibility and shipping gate remains objectively proven. Interpret terminal states exactly:

- `ready-for-human-review`: the workflow branch was pushed, the draft PR was proven for the expected head, configured required checks were green for that head, the PR was marked ready, and runtime cleanup completed. Review the cumulative PR evidence; only the human may merge or otherwise advance `main`.
- `human-decision-required`: ambiguity, a non-waivable finding, ownership mismatch, shipping uncertainty, or another fail-closed condition requires a human decision. Preserve the workflow branch, worktree, and evidence; do not improvise continuation.
- `failed`: the workflow ended without authority to ship. Present the durable reason and evidence. Do not claim the PR is ready or retry under altered policy.
- `cancelled`: cancellation is a durable terminal classification. Present preserved cleanup/evidence and do not resume it as if non-terminal; a human chooses any next action.

Autopilot is autonomous only up to a PR ready for human review. It never merges, deploys, releases, or deletes the remote feature branch. Successful cleanup removes temporary local workflow resources while retaining durable evidence and recovery records; fail-closed terminals retain what the runtime needs for inspection.
