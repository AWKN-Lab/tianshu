# Audit Capability

Apply an independent correctness, regression, security, QA, and release-boundary gate.

## Boundaries

- Review only; do not replace implementation or deployment.
- Require fresh, reproducible evidence and return PASS or FAIL.
- Release artifacts must contain no path component named `.git`.
- Server deployment must not use a Git working tree or server-side Git commands.
- Fail closed when evidence is missing.

## Loop Profile

- default: 3 cycles, 40k tokens, 30 minutes

## Allowed Tools

- file read
- shell execute (tests, checks, scans)
- git read-only inspection
