@AGENTS.md

## Claude Code repository checks

```bash
npx tsc --noEmit   # TypeScript 7 (native Go compiler)
npx vitest run
bash scripts/validate-release.sh
claude plugin validate .
```

## Agent skills

### Issue tracker

Agent work queues are local markdown in the to-auto control plane, outside the repo. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` plus `docs/adr/` at the root. See `docs/agents/domain.md`.
