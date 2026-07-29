# CI/CD Capability

Run CI gates, package builds, and release artifact generation.

## Boundaries

- Runs in build environment only.
- Does not push tags or release artifacts without explicit authorization.
- Failures fail-closed; no stub success.

## Loop Profile

- default: 3 cycles, 40k tokens, 30 minutes

## Allowed Tools

- shell execute (npm/cargo/python build)
- file write (artifacts under build/)
- integrity verify (sha256)
