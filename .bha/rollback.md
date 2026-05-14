# BHA v1 Dry-Run Rollback

This runtime is local and dry-run only.

Rollback path:

1. Stop using `.githooks/pre-push` as the Git hooks path if it was configured outside this task.
2. Remove or restore only the ten BHA dry-run files listed in `.bha/mission.yaml`.
3. If the ledger or state becomes inconsistent during testing, restore `.bha/state.json`, `.bha/ledger.jsonl`, and `.bha/capabilities.jsonl` from version control or a known-good local copy.
4. No remote resources, provider APIs, memory stores, deployments, releases, tags, or package dependencies are intentionally created by this dry-run kernel.
