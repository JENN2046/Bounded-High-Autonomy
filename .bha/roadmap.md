# BHA Roadmap

Status source of truth:
- Runtime evidence: `.bha/ledger.jsonl`
- Current state: `.bha/state.json`
- Validation plan: `.bha/validation.yaml`
- Design context: `BHA_DESIGN.md`

## Current V1 Kernel

Goal:
- BHA v1 Kernel = Local Evidence + Push Gate.
- Bound the agent. Verify the work. Gate the risk.

Completed:
- Mission is first-class and bound by `mission_hash`.
- Policy uses one canonical `bha.policy.v1` layout.
- Capability v1 is limited to `git_push`.
- Dirty unvalidated worktree changes produce `UNVERIFIED_WORKTREE_CHANGE`.
- Validation binds `policy_hash`, `mission_hash`, validation input hash, and ledger head.
- Verifier rejects malformed policy, duplicate ledger event ids, stale validation, unsigned valid capabilities, capability policy/mission hash mismatch, and unsupported closeout claims.
- `prepush-check` fails closed without a signed consumed `git_push` capability.
- Closeout can be recorded as `closeout_completed` ledger evidence.
- `git-push-capability-flow` exposes the read-only happy path from unsigned payload to prepush gate.
- Repeated closeouts are allowed, but `state.closeout` must reference the newest recorded closeout.
- `rollback-drill` verifies `.bha/rollback.md` is local, non-destructive, and evidence-based.
- `checkpoint` writes `.bha/checkpoint.json`, appends `checkpoint_written`, and updates `state.last_checkpoint`.
- `prepush-check` reports verifier-backed evidence gates and fails closed unless validation, rollback, checkpoint, closeout, git status, and consumed `git_push` capability all pass.

Current verified state:
- `node scripts/bha-run.js validate` is expected to pass.
- `node scripts/bha-verify.js` is expected to pass.
- `node scripts/bha-run.js closeout --record --format json` records the closeout event when verifier and validation are passing.

## V1 Handoff / Release Note

Status:
- V1 is a local runtime kernel, not a release, deploy, or remote attestation service.
- Source of truth remains repository reality, `.bha/ledger.jsonl`, `.bha/state.json`, verifier output, and policy/mission hashes.

Implemented:
- Canonical JSON hashing for policy, mission, ledger events, and capability events.
- Repository-local policy and mission parsing.
- Path normalization, denied-path checks, and command classification.
- Append-only ledger with hash-chain verification.
- State consistency checks against ledger and repository reality.
- Read-only verifier with negative self-tests.
- Validation evidence with policy-gated command execution, freshness checks, and recorded `decision`, `allowed`, and `spawned` fields.
- `git_push`-only capability flow with signed payload verification, issue, consume, replay checks, and fail-closed prepush integration.
- Checkpoint and closeout evidence bound to verifier and ledger state.

Explicitly not implemented:
- Provider-call automation, memory-write automation, deploy/release/tag control, package publishing, database, web UI, CI platform, remote attestation, private key custody, multi-agent scheduling, or OS-level sandboxing.

Final local acceptance commands:
- `node scripts/bha-run.js validate`
- `node scripts/bha-verify.js`
- `node scripts/bha-run.js closeout --format json`
- `node scripts/bha-run.js prepush-check --internal-git-hook origin`

Expected final gate:
- Verifier: `PASS` with no issues or warnings.
- Closeout: `PASS`.
- Prepush: `FAIL_CLOSED` unless a signed, consumed `git_push` capability matches the current run, remote, branch, HEAD, policy hash, mission hash, and ledger head.

## Next Tasks

1. Prepush capability UX hardening
   - Keep the happy path clear: generate payload, sign externally, issue capability, consume capability, prepush-check.
   - Keep private key material out of the repository and logs.
   - Extend operator-facing docs only after the local command flow stays stable.

2. Roadmap hygiene
   - Keep this roadmap short and update it only when the kernel state changes.
   - Keep the next safe action aligned with verifier-backed evidence.

## Deferred

- CI integration.
- Remote attestation.
- Provider governance.
- Memory governance.
- MCP broker policy.
- Multi-agent scheduling.
- Deployment, release, tag, and package publishing capabilities.

## Hard Boundaries

- V1 is tamper-evident, not tamper-proof.
- V1 does not claim OS-level network proof.
- V1 does not authorize provider calls, memory writes, deployments, releases, tags, force pushes, package publishes, or destructive filesystem actions.
- A passing closeout is evidence only for what verifier, validation, ledger, and capability records actually support.
