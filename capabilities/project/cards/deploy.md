# Deploy Capability

Deploy a pinned Windows-validated ReleaseBundle to production and produce DeployResult v1.

## Boundaries

- Require explicit approval plus audit=PASS and cicd=PASS.
- Never use server-side Git or a deployment directory containing `.git`.
- Require source.git_pushed=true and an empty origin branch difference.
- Verify the ReleaseBundle SHA-256 before switching traffic.
- Use a versioned clean release directory, preserve persistent data, and keep rollback ready.
- Complete only after PM2, local/public health, admin-page, and API smoke checks pass.
- Fail closed and roll back when verification fails.

## Loop Profile

- default: 3 cycles, 40k tokens, 30 minutes

## Allowed Tools

- shell execute (SSH/SCP, checksum, PM2, health checks)
- file write (release and DeployResult artifacts)
- integrity verify (SHA-256)
