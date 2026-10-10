# Issue tracker: Local Markdown (to-auto control plane)

Issues and specs for autonomous runs live as markdown files in the to-auto control plane, outside this repository, so run branches carry only code. The control plane is the folder `node <matt-automations>/scripts/goal.mjs control` prints (default `~/.local/state/to-auto/<repo-id>/`).

GitHub Issues and pull requests on `PyModel/claude-architect` remain the public surface for releases and external reports; they are not the agent work queue.

## Conventions

- One feature per directory: `<control>/tracker/<feature-slug>/`
- The spec is `<control>/tracker/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `<control>/tracker/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Each issue carries exactly one status line, `**Status:** ready-for-agent | in-flight | done | stuck | blocked | needs-human`, plus `**Blocked by:**` and `**Claims:**` lines (to-auto `CONTROL.md` § Tracker grammar)
- Status changes go through `goal.mjs take` and `goal.mjs status`, never a hand edit
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `<control>/tracker/<feature-slug>/` and commit it with `goal.mjs commit`.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.
