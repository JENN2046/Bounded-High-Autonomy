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
- `gate-status` reports the current read-only gate state and next action for operators.
- `git_push` issue, consume, and hook USED evidence are local-only under `.bha/local/` to prevent recursive evidence commits.

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
- V1.1 local-only push authorization strategy: tracked evidence records verifier-ready repository state; `.bha/local/capabilities.jsonl` records `git_push` issue/consume events and `.bha/local/capability-sessions.jsonl` records hook USED sessions for local replay protection.

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

## V1 Operator Flow

Minimal local loop:
1. Inspect repository reality with `git status --short`, `git branch --show-current`, and the `.bha/` files.
2. Run `node scripts/bha-run.js validate` to execute policy-gated validation and record evidence.
3. Run `node scripts/bha-verify.js` and require `PASS` before trusting state.
4. Run `node scripts/bha-run.js checkpoint --format json` when work should be resumable from files.
5. Run `node scripts/bha-run.js closeout --format json --record` to record final evidence.
6. For push, run `node scripts/bha-run.js make-push-payload --remote origin --branch master --expires-minutes 20 --key-id owner-main-pkcs8 --out .bha/local/push-payload.json`, sign the flat JSON outside BHA, write the signed JSON under `.bha/local/`, then run `verify-signed-capability --file`, `issue-capability --file`, and `consume-capability`. For `git_push`, issue/consume evidence is local-only.
7. Run `node scripts/bha-run.js prepush-check --preflight --internal-git-hook origin` before `git push origin master`.

Fresh clone note:
- A fresh clone of the current remote can restore verifier trust by running `validate`, `checkpoint`, `closeout --record`, and `verify`.
- A fresh clone should be able to restore tracked verifier trust from repository files without local push authorization evidence.
- Local push authorization evidence is intentionally not synchronized through the protected branch.

Operator status:
- `node scripts/bha-run.js gate-status --remote origin --branch master --format json` is read-only and reports verifier gates, hook configuration, capability status, post-push evidence strategy, and the next action.
- `make-push-payload --out`, `verify-signed-capability --file`, and `issue-capability --file` use `.bha/local/` paths so operators do not need to paste long signed JSON on the command line.

## Next Tasks

1. Post-push evidence strategy
   - Keep `git_push` issue, consume, and USED session evidence local-only under `.bha/local/`.
   - Keep tracked evidence focused on verifier-ready repository state before push.
   - Avoid an infinite loop where every pushed evidence commit creates another evidence-only commit.

2. Capability UX hardening
   - Keep the happy path clear: generate payload, sign externally, issue capability, consume capability, preflight, push.
   - Add or refine local helpers that prepare unsigned payloads and validate signed JSON without reading private keys.
   - Keep private key material out of the repository and logs.

3. Preflight and hook semantics
   - Keep `--preflight` read-only and non-consuming.
   - Keep the actual hook as the only path that consumes a one-use session.
   - Add self-test coverage for this distinction.

4. Hook install detection
   - Add a local command that reports whether `core.hooksPath` points at `.githooks`.
   - Keep hook installation local-only and never treat it as proof by itself.

5. Roadmap hygiene
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
