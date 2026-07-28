# CICD Capability

Windows local validation, testing, Git-metadata-free build, ReleaseBundle and artifact hashing.

## Responsibilities

- Run local validation gates before deployment
- Generate ReleaseBundle with source provenance
- Verify artifact hashes match manifest

## Constraints

- Deployment must follow: CICD -> GIT push -> server deployment
- ReleaseBundle must include source.git_pushed = true
- Skipping GIT push is blocked
