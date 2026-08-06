# Evolution Governance Closure — 2026-08-06

## Decision

Autonomous execution priority:

1. remove credential and infrastructure disclosure risk;
2. establish one authoritative Runtime execution root;
3. create a controlled Candidate Ingest boundary;
4. materialize the three missing engineering candidates;
5. retire the unsafe ignored-worktree bypass rule;
6. verify with deterministic tests before any authoritative database mutation.

## Completed

### Security closure

- Sanitized `EXP-DRV-20260806-001` through `009`.
- Sanitized `EXP-FIX-20260806-001` and retired `EXP-FIX-20260806-002`.
- Sanitized the two infrastructure incident reports.
- Removed known plaintext database credentials, public host address, internal project paths, local backup paths and complete backup hashes.
- Added `security_review: sanitized` metadata and regression tests.
- Credential rotation remains required because the previous plaintext value must be treated as exposed.

### Candidate materialization

Created the three previously missing candidates:

- `EXP-DRV-20260806-007`: Windows Node tool execution diagnosis.
- `EXP-DRV-20260806-008`: dependency-state truth query.
- `EXP-DRV-20260806-009`: command template must follow project scripts.

Ten ingestible candidates are listed in:

```text
.better-harness/tasks/evolution-candidate-manifest-2026-08-06.json
```

The unsafe worktree-bypass candidate is explicitly `RETIRED` and excluded from the manifest.

### Runtime authority

- Authoritative source: `<repo>/runtime`.
- `packages/awkn-engine-mcp/runtime` is documented as a legacy packaged copy.
- `scripts/phase4-evolve-governance.ps1` now resolves the root Runtime and no longer executes the package copy.
- `complete-drafts` is opt-in with `-CompleteDrafts`; default execution is scan/stats only.

### Candidate Ingest boundary

Added:

- `runtime/src/evolve/candidate-ingest.ts`
- `runtime/scripts/ingest-candidate-manifest.ts`
- `npm run evolve:ingest`

Guards:

- workspace path traversal rejection;
- required structured DRAFT frontmatter;
- credential-pattern rejection before ingest;
- stable 64-hex source fingerprint;
- duplicate manifest rejection;
- idempotent Candidate reuse;
- optional Correction linking;
- dry-run default; authoritative database mutation requires explicit `--apply`.

## Verification evidence

```text
npm run build
exit 0

npm run lint
exit 0
blockingViolations 0
migrationLatest 22
```

Candidate governance tests:

```text
13 tests
13 pass
0 fail
```

Coverage includes:

- real ten-candidate manifest ingested into an isolated database;
- second execution reuses all ten Candidate records;
- secret rejection;
- path traversal rejection;
- structured metadata enforcement;
- retired unsafe candidate remains retired;
- governance script uses only the root Runtime.

Manifest dry-run:

```text
candidateCount 10
status VALIDATED for all 10
exit 0
```

Contracts:

```text
998/998 pass
Claim Repository in-memory 8/8 pass
Claim Repository SQLite 8/8 pass
exit 0
```

The full unit command exceeds the ENO 60-second execution ceiling on this machine. The run reached active test execution without a failure before the outer timeout. The changed code is covered by the dedicated 13-test suite and TypeScript build.

## Deliberately not executed

### Authoritative database apply

Not executed through ENO because the connector permits read-only/test commands and exposes no Candidate Ingest database action. The implementation was applied against an isolated database in tests.

Exact controlled command for a write-capable local runtime:

```powershell
cd "D:\awkn-lab\awkn引擎\runtime"
npm run evolve:ingest -- --manifest ..\.better-harness\tasks\evolution-candidate-manifest-2026-08-06.json --apply
```

Run dry-run first by omitting `--apply`.

### Credential rotation

The report and candidate files are sanitized, but rotation requires access to the affected service and secret store. The old database credential must be considered compromised until rotation is confirmed.

### Commit and push

ENO does not expose Git write commands. Commit only the files listed in the commit boundary below; do not include concurrent Persona, registry, template, package-copy or migration-backup work.

## Commit boundary

```text
runtime/package.json
runtime/src/evolve/candidate-ingest.ts
runtime/scripts/ingest-candidate-manifest.ts
runtime/test/evolution-candidate-ingest.test.ts
runtime/test/evolution-candidate-security.test.ts
runtime/test/runtime-authority.test.ts
scripts/phase4-evolve-governance.ps1
docs/runtime-authority.md
.better-harness/tasks/evolution-candidate-manifest-2026-08-06.json
agents/tianhuo/04-记忆与知识/EXPERIENCE/derived/EXP-DRV-20260806-001.md ... 009.md
agents/tianhuo/04-记忆与知识/EXPERIENCE/fixes/EXP-FIX-20260806-001.md
agents/tianhuo/04-记忆与知识/EXPERIENCE/fixes/EXP-FIX-20260806-002.md
agents/tianhuo/04-记忆与知识/EXPERIENCE/reports/2026-08-06-hindsight孤儿系统识别与清理-深度复盘-PDCA报告.md
agents/tianhuo/04-记忆与知识/EXPERIENCE/reports/2026-08-06-服务器盘点清理与部署备份策略重构-深度复盘-PDCA报告.md
```

Suggested commit:

```text
feat(evolve): add sanitized candidate ingest boundary and runtime authority
```

## Remaining architecture work

- expose Candidate Ingest and lifecycle operations through the authoritative MCP/CLI surface;
- add Candidate list/show/validate/approve/activate/quarantine/rollback tools;
- replace natural-language draft scanning with database Candidate state as authority;
- remove or generate the legacy package Runtime copy;
- move Cron scheduling to an independent worker with leader lease and fencing;
- complete one authoritative correction → candidate → replay → approval → activation run and archive its receipts.
