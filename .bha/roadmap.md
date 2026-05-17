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

## V1 Stable Candidate Freeze

Completed locally:
- `regression-selftest` exercises V1.1 local-only push authorization invariants in an isolated `.bha/local/` fixture without reading or storing operator private keys.
- Validation includes the V1.2 regression self-test so LF/CRLF hash stability, local-only `git_push` issue/consume evidence, preflight non-consumption, hook USED sessions, replay rejection, fresh clone verifier trust, and denied external capability classes are checked automatically.
- `inspect`, `gate-status`, `checkpoint`, and `closeout` are the first local trusted-shell UX surfaces for Codex daily work.
- `audit-v12` is a read-only artifact coverage audit that maps V1.2 requirements to repository files, recorded validation evidence, verifier status, and git reality.
- `audit-v1-stable` freezes V1 hard boundaries, proof sources, V1-only production capability scope, V2 preview default-deny status, council preview no-automation status, and local reproduction documentation.
- `push-prep`, `signed-payload-status`, and `operator-signer-preflight` guide the operator through current-HEAD unsigned payload generation and signed payload checks without BHA reading private key material.
- `recover-status` explains fresh clone and missing `.bha/local/` recovery without treating local push capability evidence as tracked trust.
- `recover-status` also reports stale, expired, mismatched, or otherwise unusable unsigned/signed payload files as local-only recovery context.
- `stable-exit-status` reports whether the V1 Stable Candidate is clean enough to enter the next local planning stage without implying that push is required.
- `stable-exit-review` turns the stable exit review into a read-only prompt-to-artifact checklist over verifier, validation, audits, recovery, gate, docs, and V2 hold-line evidence.
- `next-local-plan-status` reports the next local planning queue and hard boundaries without enabling remote actions, new production capabilities, or automated council runtime.
- `next-local-plan-status` also surfaces incomplete V2 capability and council coverage in the local planning queue so missing future prerequisites are visible without enabling them.
- `long-term-goal-status` reports the long-term prompt-to-artifact completion boundary, current V1 stable candidate state, future V2 work, and hard hold lines without marking future objectives complete.
- `capability-framework-status` reports the default-deny V2 capability preview and the deny/replay test gate for any future capability type.
- `council-status` reports the V2+ Council Runtime preview contract as read-only, local-only coordination context, not proof.
- Ledger writes are guarded by a local `.bha/local/ledger.lock` so concurrent local evidence writers fail closed instead of corrupting the hash chain.
- Local capability payload, event, session, and lock paths are physically confined to `.bha/local/`; symlink or junction traversal is rejected before local-only writes.
- Current local acceptance requires `node scripts/bha-run.js validate`, `node scripts/bha-verify.js`, `node scripts/bha-run.js checkpoint --format json`, and `node scripts/bha-run.js closeout --record --format json` to pass after any tracked change.

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
- Validation input hashing normalizes text line endings to LF so fresh clones with different Git `core.autocrlf` settings can restore verifier trust.

Explicitly not implemented:
- Provider-call automation, memory-write automation, deploy/release/tag control, package publishing, database, web UI, CI platform, remote attestation, private key custody, automated multi-agent scheduling, or OS-level sandboxing.

Stable candidate local acceptance commands:
- `node scripts/bha-run.js validate`
- `node scripts/bha-run.js checkpoint --format json`
- `node scripts/bha-run.js closeout --record --format json`
- `node scripts/bha-verify.js`
- `node scripts/bha-run.js audit-v12 --format json`
- `node scripts/bha-run.js audit-v1-stable --format json`
- `node scripts/bha-run.js stable-exit-status --remote 'origin' --branch 'master' --format json`
- `node scripts/bha-run.js stable-exit-review --remote 'origin' --branch 'master' --format json`
- `node scripts/bha-run.js next-local-plan-status --remote 'origin' --branch 'master' --format json`
- `node scripts/bha-run.js long-term-goal-status --remote 'origin' --branch 'master' --format json`
- `node scripts/bha-run.js recover-status --remote 'origin' --branch 'master' --format json`
- `node scripts/bha-run.js gate-status --remote 'origin' --branch 'master' --format json`

Expected final gate:
- Verifier: `PASS` with no issues or warnings.
- Closeout: `PASS`.
- Gate status: fail closed for real git_push authorization unless a signed, consumed `git_push` capability matches the current run, remote, branch, HEAD, policy hash, mission hash, and ledger head.
- Push requirement: `required_now=false` unless the operator separately chooses a real push.

## V1 Operator Flow

Minimal local loop:
1. Inspect repository reality with `git status --short`, `git branch --show-current`, and the `.bha/` files.
2. Run `node scripts/bha-run.js validate` to execute policy-gated validation and record evidence.
3. Run `node scripts/bha-verify.js` and require `PASS` before trusting state.
4. Run `node scripts/bha-run.js checkpoint --format json` when work should be resumable from files.
5. Run `node scripts/bha-run.js closeout --format json --record` to record final evidence.
6. Only if the operator separately chooses a real push, run `node scripts/bha-run.js push-prep --remote 'origin' --branch 'master' --expires-minutes 20 --key-id owner-main-pkcs8 --format json`, sign the flat JSON outside BHA, write the signed JSON under `.bha/local/`, then run `verify-signed-capability --file`, `issue-capability --file`, and `consume-capability`. For `git_push`, issue/consume evidence is local-only.
7. Only before an operator-authorized real push, run `node scripts/bha-run.js prepush-check --preflight --internal-git-hook 'origin'`; the actual `git push origin master` remains outside BHA and requires separate operator intent.

Fresh clone note:
- A fresh clone of the current remote can restore verifier trust by running `validate`, `checkpoint`, `closeout --record`, and `verify`.
- A fresh clone should be able to restore tracked verifier trust from repository files without local push authorization evidence.
- Local push authorization evidence is intentionally not synchronized through the protected branch.

Operator status:
- `node scripts/bha-run.js gate-status --remote 'origin' --branch 'master' --format json` is read-only and reports verifier gates, hook configuration, capability status, post-push evidence strategy, and the next action.
- `node scripts/bha-run.js hook-status --format json` is read-only and reports whether local `core.hooksPath` points at `.githooks` and whether `.githooks/pre-push` exists. Hook installation remains local setup, not proof.
- `node scripts/bha-run.js recover-status --remote 'origin' --branch 'master' --format json` is read-only and explains tracked verifier trust, missing `.bha/local/`, and how to regenerate local-only push capability evidence.
- `node scripts/bha-run.js capability-framework-status --format json` is read-only and keeps unknown capability types default-denied unless schema, policy, evidence, deny tests, and replay tests exist.
- `node scripts/bha-run.js council-status --format json` is read-only and reports the Commander / Domain Leads / Worker / Verifier workflow contract without spawning agents, writing memory, or calling providers.
- `node scripts/bha-run.js stable-exit-status --remote 'origin' --branch 'master' --format json` is read-only and summarizes V1 stable exit readiness, conditional push state, recovery state, and V2 hold lines for local planning.
- `node scripts/bha-run.js stable-exit-review --remote 'origin' --branch 'master' --format json` is read-only and maps the V1 Stable Candidate objective to concrete artifacts and command evidence before entering next local planning.
- `node scripts/bha-run.js next-local-plan-status --remote 'origin' --branch 'master' --format json` is read-only and exposes the local planning queue, validation coverage, hard boundaries, and V2 hold lines for the next safe local step.
- `node scripts/bha-run.js long-term-goal-status --remote 'origin' --branch 'master' --format json` is read-only and keeps V1 stable candidate readiness separate from unfinished future V2 capability and council runtime enablement.
- `make-push-payload --out`, `verify-signed-capability --file`, and `issue-capability --file` use `.bha/local/` paths so operators do not need to paste long signed JSON on the command line.
- `gate-status` includes an `operator_handoff` block with local payload/signed-file status, the current capability id when it can be derived from `.bha/local/push-payload.json`, and PowerShell-safe single-line gate commands. It does not print signatures or private key material.
- If `.bha/local/push-payload.json` already matches the current git, ledger, policy, mission, remote, and branch context, `gate-status` and `recover-status` tell the operator to sign that existing unsigned payload instead of regenerating it.
- `gate-status` and `recover-status` distinguish "needed before an operator-chosen real push" from "required now" with machine-readable fields such as `push_requirement.required_now`, `next_action_required_now`, `operator_handoff.capability_flow_required_now`, and `git_push_recovery.required_now`.

## Next Tasks

1. V1 stable candidate maintenance
   - Keep verifier, validation, checkpoint, closeout, audit, and gate-status passing from a clean worktree.
   - Keep post-commit evidence-time HEAD mismatch explicit so operator knows when a fresh capability is needed.
   - Keep all proof claims tied to repository reality, ledger/state evidence, verifier, policy/mission hash, local-only capability evidence, and git reality.
   - Keep roadmap, stability docs, validation, and audit checks aligned before treating V1 as frozen.
   - Keep `stable-exit-status` passing from a clean worktree before entering the next local planning stage.
   - Keep `stable-exit-review` passing before claiming the V1 stable exit review is complete.
   - Keep `next-local-plan-status` aligned with the roadmap before selecting the next local work item.
   - Keep `long-term-goal-status` explicit that future V2 enablement is incomplete without a new objective.

2. V1.3 operator UX freeze
   - Keep stale payload and command-splitting mistakes machine-readable and human-readable.
   - Keep external signer ownership explicit and keep BHA limited to unsigned/signed payload files.
   - Keep push guidance conditional: BHA may explain how to prepare a current capability, but must not imply that a push is required now.
   - Add more recovery hints only when they do not weaken the private key or remote-action boundary.

3. V1.4 recovery and resume freeze
   - Keep fresh clone flows self-explanatory without requiring `.bha/local/`.
   - Keep local-only capability replay blocked after push and after USED sessions.
   - Keep checkpoint and closeout resume facts separated from proof claims.

4. V2 capability framework hold line
   - Keep `git_push` as the only production capability.
   - Require schema, binding, allowed command, evidence policy, deny tests, replay tests, and verifier evidence before considering any new capability.
   - Keep provider, deploy, release, tag, package publish, memory write, and private key access denied by default.

5. V2+ Council Runtime hold line
   - Keep the current status command as a contract preview only.
   - Do not add real automated scheduling until there is a local verifier-backed workflow model.
   - Treat Commander / Domain Leads / Worker / Verifier output as coordination context, not proof.

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
