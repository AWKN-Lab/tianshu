# Git Delivery Note

- Repository: `AWKN-Lab/tianshu`
- Delivery branch: `codex/phase6-runtime-audit-fixes`
- Audit source baseline: supplied ZIP at `b090fa9535ea3324eb518021cf9b327625fe03e3`
- Remote branch base at delivery: `main@bc3869412e9b683b03ad808304ba682c2d5fe995`

Remote `main` advanced by two commits during the audit. The later tree already contains a rewritten `policy-ast-deep.test.ts` with correct odd/even `none` semantics. To preserve newer remote work, this delivery commit stores the source audit, test evidence, remaining risks, and a gzip-compressed unified patch for the supplied ZIP worktree. It does not replace current `main` source files.

Reconstruct and apply the patch in an isolated copy of the supplied ZIP worktree:

```bash
gzip -dc audit/AWKN-audit-fixes.patch.gz > AWKN-audit-fixes.patch
git apply --check AWKN-audit-fixes.patch
git apply AWKN-audit-fixes.patch
```

Then run the commands in `TEST-EVIDENCE.md`. When rebasing individual fixes onto current `main`, omit the older Policy AST test hunk and retain the parity tests already present on `main`.

No pull request, merge, deployment, release, production database change, or real Memory OS operation is included.
