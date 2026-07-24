# Tianshu × AWKN Memory OS Integration

## Responsibility boundary

| Component | Authority |
|---|---|
| Agent loop, tools, Run / Step, checkpoints, replay evaluation | Tianshu |
| Working-memory cache and offline fallback | Tianshu local MemoryService |
| Long-term experiences, active rules, context receipts, renders and observed usage | AWKN Memory OS |

## Required services

1. Start AWKN Memory OS Core on a loopback address.
2. Create or expose the target project to the Tianshu token.
3. Configure Tianshu with the same project ID.

```bash
export AWKN_MEMORY_BACKEND=memory-os
export AWKN_MEMORY_OS_URL=http://127.0.0.1:8765
export AWKN_MEMORY_OS_TOKEN_PATH=/absolute/path/to/data/session.token
export AWKN_PROJECT_ID=<memory-os-project-id>
export AWKN_MEMORY_SESSION_ID=<stable-session-id>
```

Windows PowerShell:

```powershell
$env:AWKN_MEMORY_BACKEND = "memory-os"
$env:AWKN_MEMORY_OS_URL = "http://127.0.0.1:8765"
$env:AWKN_MEMORY_OS_TOKEN_PATH = "C:\absolute\path\to\data\session.token"
$env:AWKN_PROJECT_ID = "<memory-os-project-id>"
$env:AWKN_MEMORY_SESSION_ID = "<stable-session-id>"
```

## Diagnosis

Protocol and authorization only:

```bash
npm run memory -- diagnose
```

Protocol, authorization, project access, Context Receipt and Render / empty-context contract:

```bash
npm run memory -- diagnose \
  --project <memory-os-project-id> \
  --session smoke-session \
  --query "memory integration smoke"
```

Healthy non-empty response:

```text
remote.capabilities.online = true
remote.capabilities.protocol.protocol = awkn-core-sdk/1.0
remote.context.receiptId is present
remote.context.renderId is present
remote.context.stale = false
```

Healthy empty-memory response:

```text
remote.context.receiptId is present
remote.context.renderId is absent
remote.context.prompt = ""
remote.context.items = []
remote.context.stale = false
```

An empty Context Receipt is a valid first-cycle result. It must not trigger local stale fallback.

## Outboxes

Transport and Core 5xx operations:

```bash
npm run memory -- flush-remote
```

Terminal Run evidence stored in SQLite authority outbox:

```bash
npm run memory -- flush-authority --limit 20
```

HTTP 4xx, authorization failures and protocol mismatches fail directly and do not enter a retry queue.

## Rule governance

Default flow:

```text
Replay PASS
→ Memory OS Experience PROMOTED
→ Memory OS Rule PROPOSED
→ Tianshu candidate APPROVED
→ explicit activation
→ old remote Rule PAUSED
→ new remote Rule ACTIVE
→ old local candidate RETIRED
→ new local candidate ACTIVE
```

Commands:

```bash
npm run evolution -- promote <candidate-id>
npm run evolution -- activate <candidate-id>
npm run evolution -- quarantine <candidate-id> "reason"
npm run evolution -- rollback <experience-id>
```

Automatic governance is opt-in:

```bash
export AWKN_MEMORY_OS_AUTO_GOVERNANCE=1
```

When enabled, `promote` still creates a PROPOSED remote Rule first. The orchestrator then performs the same single-active switch and compensation path.

## Failure semantics

| Failure | Runtime behavior |
|---|---|
| Memory OS unavailable during context read | Use local cache and set `stale=true` |
| Empty remote context | Continue with remote Receipt and no Render |
| Capture transport / Core 5xx | Durable JSONL Outbox |
| Terminal Run sync failure | Durable SQLite Authority Outbox |
| Protocol mismatch | Fail remote connection; no retry queue |
| Rule activation failure | Restore previous remote Rule; keep previous local candidate ACTIVE |
| Local activation failure after remote switch | Pause new remote Rule and restore previous remote Rule |
| Quarantine / rollback partial failure | Execute compensating remote transition before returning failure |
