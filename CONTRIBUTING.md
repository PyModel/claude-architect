# Contributing to Claude Architect

Thank you for helping improve Claude Architect. The project treats external
coding agents as untrusted Producers, so changes should preserve isolation,
independent verification, and provenance-recorded acceptance under the
configured decision authority.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
For usage help, see [SUPPORT.md](SUPPORT.md). Report vulnerabilities privately
as described in [SECURITY.md](SECURITY.md).

## Prerequisites and setup

Use Node.js 22 or newer (the current package engine requirement) and npm.

```bash
git clone https://github.com/PyModel/claude-architect.git
cd claude-architect
npm install
git config core.hooksPath .githooks
```

Before submitting a change, run:

```bash
npx tsc --noEmit
npx vitest run
```

Run `bash scripts/validate-release.sh` and `claude plugin validate .` as well
for release-facing or packaging changes.

## Make a focused change

Open an issue before substantial design work when the expected behavior or
trust implications are unclear. Keep the patch narrowly scoped, preserve
unrelated work, and add the smallest test that fails without the change. Cover
relevant failure paths and platform differences across macOS, Linux, and
Windows.

Commit subjects in this repository are written in imperative mood and are at
most 72 characters. Existing history commonly uses Conventional Commit-style
prefixes such as `feat:`, `fix:`, `docs:`, and `chore:`; match that observed
practice where it fits, but it is not a hard Conventional Commits mandate.
Do not add AI or tool co-author trailers, or generated-by footers, to commits or
pull requests.

## Architecture and trust boundaries

Respect the ownership boundaries documented in [AGENTS.md](AGENTS.md):

- `schemas/` and `src/protocol/` define public, versioned contracts.
- `src/runtime/` owns lifecycle, artifacts, recovery, redaction, and manifests.
- `src/producers/` owns capability probes, routing, and CLI adapters.
- `src/verify/` independently evaluates structural and project checks.
- `src/pipeline/` coordinates fresh-context implementation and review roles.
- `src/integrate/` applies only accepted, hash-matched artifacts.
- `src/platform/` owns operating-system process and confinement behavior.
- `src/mcp/` exposes thin, validated orchestration handlers.

Producer output and self-reported success are never trusted evidence. The Host
runtime—not a Producer adapter—must enforce scope, confinement, artifact,
verification, decision, and integration policy. An implementer must not review
or approve its own work. Candidate acceptance follows the configured decision
authority: the shipped autonomous policy accepts only independently verified,
unwarned, readable pipeline candidates; every other case requires human MCP
elicitation and fails closed without it.

Changes involving process execution, sandboxing, paths, environment variables,
credentials, redaction, candidate identity, verification, decisions, or
integration cross a trust boundary. Explain the threat and security impact in
the pull request, include adversarial fail-closed tests, and request explicit
maintainer security review. Do not mock the component whose security property
the test claims to prove.

## Add or change a Producer adapter

1. Implement the bounded adapter contract under `src/producers/`, following the
   existing argv-array spawning and plain-text parsing patterns.
2. Add the Producer to capability probing, the explicit registry/allowlist, and
   routing only for capabilities the Host can prove.
3. Keep policy in the Host runtime. An adapter must not grant itself edit
   eligibility, acceptance authority, or a weaker fallback when confinement is
   unavailable.
4. Add unit, contract, routing, platform, and opt-in real-adapter smoke coverage
   appropriate to the lane. Document whether each platform is certified,
   tested, legacy, diagnostics-only, or unsupported.
5. Update user-facing compatibility and security documentation without implying
   equal assurance across Producers.

## Add or change a skill

Skills live under `skills/`. Follow the established skill structure and keep
instructions consistent with canonical schemas and runtime behavior. A skill
may construct a bounded, versioned specification and present evidence, but it
must not bypass validation, conflate implementation with review, claim that a
Producer accepted its own work, or imply automatic commit, push, or deployment.
Add contract coverage for protocol markers or packaged references that change.

## Change a schema or protocol

Schemas are public versioned APIs. Prefer additive, backward-compatible
changes. Update the canonical schema, TypeScript types, validators, fixtures,
contract tests, runtime compatibility checks, skill protocol marker, and
documentation together. For a breaking semantic change, increment the relevant
protocol/spec version and return an explicit mismatch diagnostic. Never accept
unknown semantics merely to preserve compatibility.

## Pull requests

Complete the pull request template, link related issues, explain verification
results, and identify trust-boundary and platform effects. Generated `runtime/`
assets must be reproducible and current whenever source changes require them.
All checks must pass before review.

## Releases

Marketplace releases advance the minor version only (for example, `0.15.0` to
`0.16.0`); do not publish patch-version tags. Keep
`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, the README
version badge, and `CHANGELOG.md` synchronized. Run:

```bash
bash scripts/validate-release.sh
```

Do not commit, push, or tag a release if validation fails. The repository's
`.githooks/pre-push` gate runs TypeScript and Vitest on every push; pushes to
`main` or a tag also run release validation and check the latest `origin/main`
CI result.

