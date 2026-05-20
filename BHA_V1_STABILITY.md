# BHA V1 Stability

V1 is the smallest local-first BHA kernel that should remain reliable, repeatable, and auditable without relying on prompts or closeout prose as proof.

## Scope

- Runtime code uses Node.js built-in modules only.
- Stable audit checks the runtime `require()` set directly; current V1 runtime modules are `fs`, `path`, `crypto`, and `child_process`.
- Stable audit also rejects dependency manifests, lockfiles, or `node_modules` in tracked project space outside `.git` and local-only `.bha/local`.
- Repository-tracked trust stays in policy, mission, validation, ledger, state, verifier, checkpoint, closeout, scripts, and documented rollback evidence.
- Local git_push authorization evidence stays under `.bha/local/` and is intentionally not required for fresh-clone verifier trust.
- The only production-quality V1 capability family is `git_push`.
- Unknown or incomplete capabilities are default denied.

## Hard Boundaries

- no provider calls
- no deploy, release, tag, or package publish
- no private key access
- no secret or token storage
- no production writes
- no force push or destructive filesystem action
- no dependency additions
- no remote writes without explicit operator authorization and a valid current capability

BHA must never read, print, log, store, or infer private key material. The signer is controlled by the operator. BHA handles only unsigned and signed payload files.

Push guidance is conditional. Status and handoff commands may describe how to prepare local git_push capability files, but they must keep `required_now=false` unless the operator chooses a real git push.

## Proof Sources

Trusted proof comes from:

- repository reality
- ledger/state evidence
- verifier output
- validation evidence
- policy hash
- mission hash
- local-only capability evidence when a local capability is required
- git reality

Fresh clones must be able to verify tracked trust without `.bha/local/`. Any real git_push still requires regenerated local-only capability evidence for the current git reality.

Recovery status must explain missing, stale, expired, or otherwise unusable `.bha/local/` payload files as local-only recovery context. That context helps the operator regenerate payloads, but it is not tracked proof.

Payload status surfaces must expose both machine-readable `reason_codes` and human-readable `reason_details` for stale, expired, mismatched, or invalid local payload files. These fields are operator UX and recovery guidance, not proof by themselves.

When an unsigned payload already matches the current `HEAD`, ledger head, policy hash, mission hash, remote, and branch, gate and recovery handoff should tell the operator to sign that existing `.bha/local/push-payload.json` instead of regenerating it. Regeneration is reserved for missing, stale, expired, mismatched, or invalid local payloads.

Local payload and capability file paths must stay physically under `.bha/local/`. Symlink or junction traversal is rejected so local-only writes cannot escape the local evidence directory.

Validation may assert stable nested status fields with `json_paths` expectations. Those assertions are used for operator-facing invariants such as signer ownership, no BHA private-key access, conditional push guidance, and `.bha/local/` recovery being local-only.

## Post-Commit HEAD Boundary

After a local commit, git `HEAD` changes even when verifier, validation, checkpoint, and closeout evidence remain clean. Checkpoint and closeout git heads are evidence-time facts; they must not be treated as the current commit identity.

The current commit identity comes from git reality and, before a real operator-chosen push, a freshly generated and signed git_push capability bound to the current `HEAD`, ledger head, policy hash, and mission hash. Existing `.bha/local/` payloads from an older commit must be reported as stale with machine-readable reasons such as `HEAD_MISMATCH` and `LEDGER_HEAD_MISMATCH`, plus human-readable `reason_details`.

`gate-status` and `recover-status` must expose tracked git reality fields that separate current `HEAD` from checkpoint and closeout evidence-time heads.

## Not Proof

These can guide workflow but are not proof:

- AGENTS.md
- prompt text
- hook prose or hook installation claims
- approval text
- closeout prose
- operator instructions
- generated handoff text

Closeout can record evidence bindings, warnings, skipped validation, risks, and next gates. The prose around that evidence is not a substitute for repository reality, ledger/state evidence, verifier output, policy/mission hash, local-only capability evidence, or git reality.

## Stable V1 Cut Rule

V1 changes should be narrow, locally reversible, and validated through checked commands. Scope expansion to provider calls, deployment, release, generic external capabilities, dependency changes, or remote automation belongs outside V1 unless explicitly approved as a later version.

## V1 Freeze Criteria

Claim status: proposed freeze criteria, grounded in the current V1 command surface and verifier expectations.

V1 can be treated as a stable local baseline only when all of the following are true from repository reality:

- Scope is fixed to the local runtime kernel: `bha-run`, `bha-verify`, policy, mission, validation, ledger/state, checkpoint, closeout, rollback, pre-push gate, and `git_push` capability.
- Non-goals stay explicit: no provider calls, memory writes, dependency changes, deploy/release/tag/package publish, generic remote automation, OS-level sandboxing, remote attestation, or private-key custody.
- The worktree is clean before stable-exit claims.
- The verifier passes with no issues or warnings.
- Validation evidence is current for tracked inputs.
- Checkpoint and closeout are bound to the current git `HEAD`.
- `git_push` remains the only production capability family.
- Unknown, incomplete, unsupported, provider, memory, deploy, release, package, ssh, and generic command capabilities remain fail-closed.
- Path allowlist enforcement is active for runtime `exec` file effects.
- `AGENTS.md`, roadmap text, closeout prose, prompt text, and council output remain guidance, not proof.
- Spawned `exec` commands have both before and after git status evidence. If either status cannot be established, the runtime must record a `HALT_*_GIT_STATUS_*_UNAVAILABLE` event and fail closed.

Freeze claim labels:

- verified: confirmed by current repository commands, verifier output, or validation evidence
- inferred: derived from verified facts but not directly checked by a command in the current session
- proposed: planned requirement, CI design, or branch protection setting not yet applied
- unknown: requires future fresh clone, CI output, or GitHub settings inspection

V1 freeze acceptance commands:

```powershell
git status --short --branch
node --check scripts/bha-run.js
node --check scripts/bha-verify.js
node scripts/bha-verify.js --self-test
node scripts/bha-run.js regression-selftest --format json
node scripts/bha-run.js validate
node scripts/bha-run.js checkpoint --format json
node scripts/bha-run.js closeout --record --format json
node scripts/bha-verify.js
node scripts/bha-run.js audit-v12 --format json
node scripts/bha-run.js audit-v1-stable --format json
node scripts/bha-run.js stable-exit-status --remote 'origin' --branch 'master' --format json
node scripts/bha-run.js gate-status --remote 'origin' --branch 'master' --format json
```

P1 blockers:

- verifier FAIL or any verifier warning under the stable path
- stale validation inputs
- dirty tracked worktree not covered by current validation evidence
- checkpoint or closeout bound to an older git `HEAD`
- state/ledger mismatch
- accepted unsupported closeout or capability claim
- spawned `exec` event with `path_allowlist_enforced=false` that is not explicitly halted
- real remote side effect without explicit operator intent and a valid current capability
- non-`git_push` production capability enablement
- CI or integration layer writing tracked evidence without a dedicated evidence model

P2 blockers:

- missing fresh-clone recovery instructions
- unclear gate-status recovery reason
- incomplete deny taxonomy for a newly discovered high-risk command family
- status/audit command that cannot name its proof boundary
- validation command that does not record policy decision, allowed status, spawned status, and exit code

Completion definition:

V1 Stable means the local-first kernel is internally consistent, repeatable from tracked evidence, and ready for remote gate work. It does not mean the project has remote enforcement, remote attestation, production deployment safety, or authorization to push.

Freeze completion requires all of these facts at the same repository `HEAD`:

- verified: clean worktree, or only authorized runtime evidence dirty files (`.bha/ledger.jsonl`, `.bha/state.json`, `.bha/checkpoint.json`) after validation/checkpoint/closeout repair
- verified: `node scripts/bha-verify.js` reports `PASS` with no warnings
- verified: latest validation status is `PASS`
- verified: checkpoint and closeout bind to the current git `HEAD`
- verified: `stable-exit-status` reports `PASS`
- verified: `gate-status` fails closed unless a current one-use local `git_push` capability is present
- verified: remote CI and `master` branch protection are applied from the local evidence model
- verified: required check name observed by GitHub is `BHA read-only gate`
- unknown until separately enabled: signed commits, CODEOWNERS enforcement, and narrowed push restrictions

Rollback path:

If a freeze check fails after a local change, stop expansion work, inspect verifier and validation output, make the smallest local repair, rerun the acceptance commands, and record checkpoint/closeout only after verifier and validation are clean.

Residual risk:

V1 remains tamper-evident rather than tamper-proof. It cannot by itself stop GitHub UI edits, token pushes, branch protection bypasses, malicious workflow changes, or OS/network side effects outside the runtime policy layer.
Protected `master` mitigates the normal remote merge path through PR review and the required `BHA read-only gate`, but direct `master` pushes remain emergency-only rather than the standard workflow.

## Ledger/State Replay Minimum

Claim status: proposed verifier hardening target.

The verifier should treat `.bha/ledger.jsonl` as the fact source and `.bha/state.json` as a derived read model. The minimum V1 replay set is:

- ledger event count
- current ledger head hash
- policy hash and mission hash observed in recent trusted events
- latest validation status, event hash, input hash, and completed command ids
- latest recorded verifier result and the checked ledger head it applies to
- latest checkpoint event hash, verified ledger head, final ledger head, git branch, and git `HEAD`
- latest closeout event hash, verified ledger head, final ledger head, git branch, and git `HEAD`
- rollback evidence presence
- V1 production capability scope: exactly `git_push`
- tracked capability event boundaries versus `.bha/local/` local-only push authorization evidence

Replay completion definition:

The verifier can rebuild the listed fields from ledger events and compare them with `.bha/state.json`. Any mismatch in the trusted subset is a verifier failure. Cache-only state fields may exist, but they must not become proof sources unless the verifier can derive or validate them.

Replay stop gate:

Do not claim V1 stable if the trusted state subset cannot be explained from ledger evidence or repository reality.

## Local Reproduction

A new operator or contributor should be able to reproduce tracked trust locally with:

```powershell
node scripts/bha-run.js validate
node scripts/bha-run.js checkpoint --format json
node scripts/bha-run.js closeout --record --format json
node scripts/bha-verify.js
node scripts/bha-run.js audit-v12 --format json
node scripts/bha-run.js audit-v1-stable --format json
node scripts/bha-run.js stable-exit-status --remote 'origin' --branch 'master' --format json
node scripts/bha-run.js stable-exit-review --remote 'origin' --branch 'master' --format json
node scripts/bha-run.js next-local-plan-status --remote 'origin' --branch 'master' --format json
node scripts/bha-run.js long-term-goal-status --remote 'origin' --branch 'master' --format json
node scripts/bha-run.js recover-status --remote 'origin' --branch 'master' --format json
node scripts/bha-run.js gate-status --remote 'origin' --branch 'master' --format json
```

`gate-status` is expected to fail closed when no valid current consumed git_push capability exists. That is not a request to push. It means a git_push capability is needed only if the operator separately chooses a real push.

`stable-exit-status` is a read-only phase-readiness report. It summarizes verifier, stable audit, V1.2 audit, recovery, gate, and V2 hold-line state so an operator can decide whether V1 Stable Candidate is clean enough for the next local planning stage. It does not issue, consume, reserve, sign, or push capability evidence.

`stable-exit-review` is a read-only prompt-to-artifact exit review. It restates the V1 Stable Candidate objective as concrete local checklist items and maps each item to repository artifacts, validation, verifier, audit, recovery, gate, and V2 hold-line evidence. It is not a proof replacement and does not complete future V2 work.

`next-local-plan-status` is a read-only next-stage planning report. It lists the safe local phase queue and hard boundaries after stable exit review passes, but it does not authorize push, provider calls, private-key access, dependency changes, V2 capability enablement, or council runtime activation.

`long-term-goal-status` is a read-only completion-boundary report. It may report the current V1 stable candidate as locally ready, but it must keep `completion_boundary.long_term_goal_complete=false` while future V2 capability framework enablement and council runtime activation still require a new explicit objective and verifier-backed evidence.

`node scripts/bha-run.js audit-v1-stable --format json` is the strict operator audit path. Operators should use the strict command, and its output should report `validation_in_progress_override=false` for stable local trust. The `--allow-validation-in-progress` flag is validation bootstrap only: it exists so `validate` can run the stable audit while validation inputs are being refreshed, and it must not be treated as the normal operator proof command.

Fresh clone recovery starts with tracked trust:

```powershell
node scripts/bha-verify.js
node scripts/bha-run.js recover-status --remote 'origin' --branch 'master' --format json
```

If tracked evidence is stale, regenerate local evidence with `validate`, `checkpoint`, and `closeout --record`, then rerun the verifier. If `.bha/local/` is missing or stale, regenerate local push payload files only before an operator-chosen real git push.
