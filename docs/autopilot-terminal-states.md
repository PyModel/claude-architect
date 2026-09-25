# Autopilot terminal states

What each terminal state proves, and what it forbids. The delegate skill points here.

The controller may proceed without a mid-loop prompt only while every eligibility gate remains objectively proven. Interpret terminal states exactly:

- `ready-for-human-review`: every task was promoted onto the workflow branch under the user's Git identity, the cumulative final review passed for the exact head, the workflow worktree and private base ref were removed, and the branch was kept at that head. Nothing was pushed. Review the branch and its final-review evidence; deliver it through the repository's gate (No Mistakes here) only with the human's approval.
- `human-decision-required`: ambiguity, a non-waivable finding, ownership mismatch, or another fail-closed condition requires a human decision. Preserve the workflow branch, worktree, and evidence; do not improvise continuation.
- `failed`: the workflow ended without a reviewed branch to hand off. Present the durable reason and evidence. Do not claim the branch is ready or retry under altered policy.
- `cancelled`: cancellation is a durable terminal classification. Present preserved cleanup/evidence and do not resume it as if non-terminal; a human chooses any next action.

Autopilot is autonomous only up to a final-reviewed local branch. It never pushes, opens a pull request, merges, deploys, or releases. It reads the remote once, at create, to fetch the base; after that it works offline. A crash during cleanup is finished by `autopilotResume`: startup recovery reports such a workflow as `resume` instead of finalizing it itself, so one state machine owns the transition. Successful cleanup removes temporary local workflow resources while retaining durable evidence and recovery records; fail-closed terminals retain what the runtime needs for inspection.
