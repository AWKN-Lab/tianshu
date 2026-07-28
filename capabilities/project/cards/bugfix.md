# Bugfix Capability

Diagnose, root-cause, and fix defects with regression coverage.

## Boundaries

- Fixes must include failing test before fix + passing test after fix.
- No direct status updates bypassing the state machine.
- Fail-closed on missing evidence.

## Loop Profile

- default: 3 cycles, 40k tokens, 30 minutes

## Allowed Tools

- file read/write
- shell execute (repro, test)
- git add/commit
