# Security Policy

Claude Architect is a public-beta security-oriented plugin. Its isolation and
verification controls reduce risk, but they do not replace review by the human
who accepts a candidate.

## Supported versions

Only the latest released minor version receives security fixes. Older minor
versions are unsupported; upgrade before reporting or reproducing an issue.

| Version | Supported |
| --- | --- |
| Latest minor release | Yes |
| Earlier minor releases | No |

## Report a vulnerability privately

Do **not** open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability reporting form](https://github.com/PyModel/claude-architect/security/advisories/new).
If the form is unavailable, contact maintainer Mohamed Elkholy (`elkaix`)
privately through GitHub before sharing details publicly.

Include as much of the following as is safe to share:

- the affected plugin version or commit;
- host operating system and architecture, Claude Code version, and Node.js
  version;
- Producer CLI and version (`codex`, `opencode`, `pi`, `pythinker`, or `agy`);
- a clear description of the impact and the trust boundary involved;
- minimal reproduction steps or a proof of concept;
- redacted logs, diagnostics, candidate artifacts, or stack traces; and
- any known mitigations or evidence that the issue is being exploited.

Never include credentials, tokens, personal data, or third-party secrets.

## What to expect

The maintainer aims to acknowledge a report within 3 business days and provide
an initial assessment or request for more information within 7 business days.
Complex reports may take longer to resolve, but material status changes will be
communicated through the private advisory.

Please allow time for investigation, a supported-release fix, and user
notification before disclosure. Coordinate any public disclosure with the
maintainer through the private advisory; do not publish exploit details while
a fix is being developed or distributed.

