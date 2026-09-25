# Verification preflight and `expectBaselineFailure`

Reference for the baseline gate the runtime runs before every dispatch. The
delegate skill states the rule; this page states why each part of it exists.

Set `baselineFailureExitCodes` alongside the flag whenever the runner distinguishes "the test ran and failed" from "the test could not be collected". Without it, any completed non-zero exit satisfies the flag, so a missing test file (pytest exit 4 or 5) proves exactly what a genuine RED assertion proves — nothing. Declaring `[1]` for pytest turns the baseline into a real fail-before/pass-after proof; omit it only when the runner has no such distinction.

The flag is enforced in both directions. It declares that the command *runs* at clean HEAD and *reports failure*, so the baseline gate rejects a command carrying it that could not run at all — unresolvable executable, timeout, cancellation, or death by signal — and equally rejects one that passes, because a green run contradicts the declaration and leaves no fail-before/pass-after evidence. A command whose baseline behavior surprises you is a spec defect to repair, not a result to reinterpret.

The flag is all-or-nothing for the command it sits on: a tolerated command proves nothing at baseline. So do not blanket-mark the command set. When a command would cover both a path that already exists and a path the candidate creates, split it in two — one command over the existing paths with the flag absent, one over the new paths with the flag set — so a real lint, type, or test regression at clean HEAD still surfaces. Marking every command tolerant, which is the tempting shortcut when a new test file appears in several of them, silently disables the entire baseline signal for the attempt.

## Text-search gates

- A text-search gate must not be able to match prose. An absence check such as `rg "except RuntimeError" <files>` with `expectedExitCodes: [1]` also matches the phrase inside a comment, a docstring, or a changelog line — so a Producer that writes a comment reading "Deliberately NOT `except RuntimeError`" fails a gate its code actually satisfies, and the attempt is rejected for a comment. Anchor the pattern to the syntax you mean (`^\s*except RuntimeError\b`), exclude comment lines, or assert over a parsed structure instead of raw text. The same trap applies to any grep-style presence check whose pattern is an ordinary English phrase.
