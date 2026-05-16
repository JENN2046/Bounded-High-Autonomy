# BHA v1 Local Dry-Run Rollback

This rollback plan is local and dry-run scoped. It is recovery guidance for the BHA v1 kernel files only; it is not a deployment rollback, release rollback, or remote state rollback.

## Recovery Drill

1. Stop relying on the local pre-push hook before trusting a recovered state.
   - If `core.hooksPath` was configured for this dry-run, an operator may unset or restore that Git config outside the drill.
   - The drill itself does not run `git config`, edit hooks, or modify repository files.
2. Inspect repository reality before choosing a recovery source.
   - Review the current branch, HEAD, dirty files, `.bha/state.json`, `.bha/ledger.jsonl`, and `.bha/capabilities.jsonl`.
   - Treat conversation memory and closeout prose as advisory only.
3. Restore only BHA v1 evidence and runtime files from version control or a known-good local copy.
   - Primary evidence files: `.bha/state.json`, `.bha/ledger.jsonl`, `.bha/capabilities.jsonl`.
   - Runtime policy files: `.bha/mission.yaml`, `.bha/policy.yaml`, `.bha/validation.yaml`, `.bha/rollback.md`, `.bha/roadmap.md`, `scripts/bha-run.js`, `scripts/bha-verify.js`, `.githooks/pre-push`, and `BHA_DESIGN.md`.
4. Re-run local validation after recovery.
   - `node scripts/bha-run.js validate`
   - `node scripts/bha-verify.js`
   - `node scripts/bha-run.js closeout --record --format json`
5. Trust the recovered state only after verifier, validation, and closeout evidence pass again.

## Hard Boundaries

- Do not run `git reset --hard`.
- Do not run `git clean`, `git clean -fd`, or `git clean -fdx`.
- Do not run `Remove-Item -Recurse` or `Remove-Item -Recurse -Force`.
- Do not delete untracked files as part of this drill.
- Do not push.
- Do not tag.
- Do not release.
- Do not deploy.
- Do not publish.
- Do not write to remote systems.
- Do not call provider APIs or write memory stores.
- Do not read, request, print, log, or store private key material.
- Do not read or write secrets.

## Drill Evidence

`node scripts/bha-run.js rollback-drill --format json` is read-only. It verifies that this rollback plan contains the local scope, evidence recovery steps, known-good recovery source, hook recovery note, destructive-command boundary, remote-effect boundary, and secret/private key boundary.
