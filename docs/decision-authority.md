# Candidate decision authority

Which decisions the runtime may record without a person, what it refuses, and what
integration accepts. `CLAUDE_ARCHITECT_DECISION_AUTHORITY` selects the authority;
unset or `autonomous` is the shipped default, `human` requires confirmation for every
decision.

Under the shipped `autonomous` authority, `decideCandidate` records `accepted` as `policy-autonomous` without elicitation for any independently verified candidate carrying no failure and no advisory warnings from a readable archive — either a `delegatePipeline` candidate with a well-formed `pipelineGateCleared` record bound to the same candidate commit and `requiresHumanDecision:false`, or a plain `delegate` candidate, which carries no pipeline evidence at all and is judged on its independent verification result alone. Every other case — including rejection, revision, refusal, incomplete review, malformed or mismatched clearance, and every decision under `human` — raises an MCP elicitation prompt and records nothing unless a person confirms; `elicitation-unavailable`, `decision-not-confirmed`, and `elicitation-failed` all mean no decision was written. Do not treat a refused confirmation as a transient error to retry; report it and stop. The recorded decision carries `decidedBy` and the candidate `manifestHash` it binds to. Integration accepts `human-elicitation` and `policy-autonomous` provenance, while refusing a different artifact and any legacy or caller-asserted acceptance.
