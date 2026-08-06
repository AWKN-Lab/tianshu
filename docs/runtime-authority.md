# Runtime Authority

## Single source of truth

The authoritative AWKN Runtime source is:

```text
<repo>/runtime
```

All governance, Cron, Evolution Lifecycle, CLI, MCP and migration work must target this directory.

## Legacy package copy

```text
<repo>/packages/awkn-engine-mcp/runtime
```

is a legacy packaged copy. It must not be used as an independently evolving source tree or as the execution root for governance scripts. Until it is removed or generated automatically, changes in that directory require an explicit synchronization task and must not be assumed to contain current Runtime behavior.

## Required runtime identity

Every long-running Runtime or MCP instance should expose:

- build commit SHA;
- runtime root;
- database path alias;
- process and instance ID;
- start time;
- schema migration version.

This identity is required to diagnose split-brain execution and transport errors.

## Enforcement

- `scripts/phase4-evolve-governance.ps1` resolves `<repo>/runtime` from its own location.
- Governance scripts must fail if the authoritative Runtime is missing.
- New scripts must not contain `packages/awkn-engine-mcp/runtime` as their execution root.
