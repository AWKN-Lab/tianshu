# Engineer Capability

Build-stage code execution: implement features, fix bugs, run tests.

## Boundaries

- Writes code under the current project scope.
- Does not modify release tags, CI workflows, or signed artifacts.
- All changes are local until committed.

## Loop Profile

- default: 3 cycles, 40k tokens, 30 minutes
- explicit_long_run: 10 cycles, 150k tokens, 120 minutes

## Allowed Tools

- file read/write
- shell execute (build, test)
- git add/commit (no push)
