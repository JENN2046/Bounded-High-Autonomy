# BHA Long-Term Goal Audit

Status: local Commander audit, not proof.

This file maps the long-term BHA direction to repository artifacts and verification commands so future work does not drift into push, private-key, provider, dependency, deploy, release, or automation scope by accident.

## Proof Boundary

This document is a checklist. It is not proof by itself.

Proof still comes from repository reality, `.bha/ledger.jsonl`, `.bha/state.json`, verifier output, policy/mission hashes, validation evidence, local-only capability evidence when required, and git reality.

## Deliverable Map

| Goal area | Current artifact | Current verification | Status |
| --- | --- | --- | --- |
| V1 stable local-first kernel | `BHA_V1_STABILITY.md`, `.bha/roadmap.md`, `scripts/bha-run.js`, `scripts/bha-verify.js` | `node scripts/bha-run.js validate`, `node scripts/bha-verify.js`, `node scripts/bha-run.js audit-v1-stable --format json` | stable candidate |
| V1.3 operator UX freeze | `push-prep`, `signed-payload-status`, `operator-signer-preflight`, `gate-status` | validation command ids `push_prep_current_head_payload`, `signed_payload_status_readonly`, `operator_signer_preflight_readonly`, `gate_status_readonly` | stable candidate |
| V1.4 recovery and resume freeze | `recover-status`, checkpoint, closeout, fresh clone regressions | validation command id `recover_status_readonly`, regression ids `fresh_clone_without_bha_local_verifier_passes`, `fresh_clone_recover_status_explains_missing_local_capability`, `fresh_clone_gate_status_blocks_without_local_capability`, `fresh_clone_push_prep_generates_local_handoff` | stable candidate |
| V1 stable audit and exit status | `audit-v1-stable`, `stable-exit-status`, `stable-exit-review`, `next-local-plan-status`, `long-term-goal-status`, `BHA_V1_STABILITY.md`, `.bha/validation.yaml` | `node scripts/bha-run.js audit-v1-stable --format json`; `node scripts/bha-run.js stable-exit-status --remote 'origin' --branch 'master' --format json`; `node scripts/bha-run.js stable-exit-review --remote 'origin' --branch 'master' --format json`; `node scripts/bha-run.js next-local-plan-status --remote 'origin' --branch 'master' --format json`; `node scripts/bha-run.js long-term-goal-status --remote 'origin' --branch 'master' --format json` | stable candidate |
| V2 capability framework | `BHA_V2_CAPABILITY_FRAMEWORK.md`, `capability-framework-status` | `node scripts/bha-run.js capability-framework-status --format json` | preview, default deny |
| V2+ Council Runtime | `BHA_V2_COUNCIL_RUNTIME.md`, `council-status` | `node scripts/bha-run.js council-status --format json` | preview, no automation |

## Prompt-to-Artifact Checklist

| Prompt item | Concrete artifact | Evidence command or gate | Coverage note |
| --- | --- | --- | --- |
| V1 stable local-first kernel is reliable, repeatable, auditable, and not prose-driven | `BHA_V1_STABILITY.md`, `.bha/roadmap.md`, `scripts/bha-run.js`, `scripts/bha-verify.js` | `node scripts/bha-run.js validate`; `node scripts/bha-verify.js`; `node scripts/bha-run.js audit-v1-stable --format json` | Stable candidate evidence is local and verifier-backed, not a release claim. |
| Trust comes from repository reality, ledger/state evidence, verifier, policy/mission hash, validation evidence, local-only capability evidence when needed, and git reality | `BHA_V1_STABILITY.md`, `audit-v1-stable`, `gate-status`, `recover-status` | `audit-v1-stable` checks proof and non-proof separation; `gate-status` reports tracked git reality and local payload status | `AGENTS.md`, prompts, approvals, hooks, and closeout prose remain non-proof. |
| V1.3 operator UX reduces signing, payload, preflight, and push mistakes without private-key custody | `push-prep`, `signed-payload-status`, `operator-signer-preflight`, `gate-status` | validation ids `push_prep_current_head_payload`, `signed_payload_status_readonly`, `operator_signer_preflight_readonly`, `gate_status_readonly`; regression ids for single-line PowerShell and stale payload status | BHA handles unsigned/signed payload files only; signer remains operator-controlled. |
| V1.4 recovery/resume handles fresh clone, missing `.bha/local`, stale payload, and replay/USED fail-closed paths | `recover-status`, checkpoint, closeout, local capability stores under `.bha/local/` | validation id `recover_status_readonly`; regression ids `fresh_clone_without_bha_local_verifier_passes`, `fresh_clone_recover_status_explains_missing_local_capability`, `fresh_clone_gate_status_blocks_without_local_capability`, `local_git_push_replay_fail_closed_after_used_session` | Fresh clones can verify tracked trust without local push authorization evidence. |
| V1 stable audit freezes hard boundaries, proof sources, validation coverage, and V1-only production capability scope | `audit-v1-stable`, `stable-exit-status`, `stable-exit-review`, `next-local-plan-status`, `long-term-goal-status`, `.bha/validation.yaml`, `.bha/policy.yaml` | `node scripts/bha-run.js audit-v1-stable --format json`; `node scripts/bha-run.js stable-exit-status --remote 'origin' --branch 'master' --format json`; `node scripts/bha-run.js stable-exit-review --remote 'origin' --branch 'master' --format json`; `node scripts/bha-run.js next-local-plan-status --remote 'origin' --branch 'master' --format json`; `node scripts/bha-run.js long-term-goal-status --remote 'origin' --branch 'master' --format json` | Stable exit status, stable exit review, next local plan status, and long-term goal status are read-only phase readiness; they do not replace `validate` or the verifier. |
| V1 stability documentation lets new operators reproduce validate/recover locally | `BHA_V1_STABILITY.md`, `.bha/roadmap.md` | `audit-v1-stable` checks local reproduction documentation and roadmap alignment | Documentation is guidance; proof remains in current command output and evidence files. |
| V2 capability framework stays preview/default deny and does not enable new production capabilities | `BHA_V2_CAPABILITY_FRAMEWORK.md`, `capability-framework-status` | `node scripts/bha-run.js capability-framework-status --format json`; validation id `capability_framework_status_readonly` | Production capability types must remain exactly `git_push`; non-enabling drafts may exist, but future capability enablement coverage remains incomplete until a new explicit objective adds schema, binding, allowed command, evidence policy, deny tests, replay tests, verifier evidence, and policy change. |
| V2+ Council Runtime stays preview/status and does not spawn agents or create side effects | `BHA_V2_COUNCIL_RUNTIME.md`, `council-status` | `node scripts/bha-run.js council-status --format json`; validation id `council_status_readonly` | Role output is coordination context, not proof; non-enabling drafts may exist, but activation coverage remains incomplete until workflow schema, role boundary tests, local dry-run evidence, verifier evidence, validation wiring, and activation regression tests exist. |
| Long-term completion remains explicitly incomplete until future V2 enablement has a new objective and evidence | `long-term-goal-status`, `next-local-plan-status`, `capability-framework-status`, `council-status`, `BHA_LONG_TERM_GOAL_AUDIT.md` | `node scripts/bha-run.js long-term-goal-status --remote 'origin' --branch 'master' --format json`; validation ids `long_term_goal_status_readonly` and `next_local_plan_status_readonly` | Current local state may be clean while `completion_boundary.long_term_goal_complete=false`; long-term and next local plan status surface incomplete future capability and council coverage directly. |
| Hard boundaries remain no push without separate operator authorization, no private-key access, no dependencies, no provider/deploy/release/tag/package publish/memory write | `.bha/policy.yaml`, `BHA_V1_STABILITY.md`, `rollback-drill`, `regression-selftest`, `audit-v1-stable` | validation deny checks `check_git_push_deny`, `check_git_tag_deny`, `check_npm_install_deny`, `check_npm_publish_deny`, `check_openai_deny`, `check_codex_memory_deny`; stable audit hard-boundary checks | A real `git push` is outside BHA and requires separate operator intent plus current local capability. |

## Current Local Acceptance Commands

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

## Hold Lines

- No push unless the operator separately authorizes a real push.
- No private key read, print, log, storage, or custody.
- No provider call, deploy, release, tag, package publish, memory write, dependency addition, production write, or force push.
- V1 production capability scope remains `git_push` only.
- V2 capability framework remains preview/default deny until schema, binding, allowed command, evidence policy, deny tests, replay tests, and verifier evidence exist.
- V2+ Council Runtime remains read-only preview/status and does not spawn agents, write memory, call providers, push, deploy, release, tag, or publish packages.

## Remaining Boundary

The long-term goal is not a remote release or push state. The current local stable candidate is clean only when verifier, validation, checkpoint, closeout, stable audit, recovery status, and gate-status are freshly checked against repository reality.

Entering the next local planning stage requires `stable-exit-review` to report `PASS`, `next-local-plan-status` to report `NEXT_LOCAL_PLAN_READY`, a clean worktree, and `push_required_now=false`. That state means local planning can continue; it does not mean the long-term goal is complete, does not authorize push, and does not enable V2 capability or council runtime activation.

Any future move beyond the current hold lines requires a new explicit objective and local deny/replay/verifier coverage before enablement.

## Next-Stage Threat Model And Gate Plan

Status: proposed next-stage planning artifact, not proof.

This section turns the next local planning queue into concrete stop gates. Each claim should be read as one of:

- verified: observed in current command output or repository files
- inferred: derived from observed repository state
- proposed: planned requirement not yet implemented
- unknown: requires future inspection, CI output, or remote settings

### Threat Model

| Threat or failure mode | Claim | Current treatment | Required next control |
| --- | --- | --- | --- |
| Local agent runs a denied command | verified | runner policy denies known command families | keep deny taxonomy and add regression when a new family appears |
| Shell success after denied check | verified | `check` and `assert-deny` now have distinct exit semantics | keep validation negative tests on `assert-deny` |
| Runtime changes files outside allowed paths | verified | `exec` records before/after git status, fails closed when either status is unavailable, and enforces policy paths | keep path enforcement in regression coverage |
| Ledger write race | verified | local ledger lock exists | keep stale lock recovery and add replay checks before stable freeze |
| Capability double consume | verified | local capability consume is lock-protected | add future black-box concurrency fixture if needed |
| Local hook bypass with `--no-verify` | verified risk | local hook cannot prevent it | remote CI and branch protection required |
| Hook not installed or hooksPath changed | verified risk | `hook-status` reports local setup | remote branch protection required |
| GitHub UI or token push | verified risk | local BHA cannot block it | remote branch protection and required checks required |
| Workflow tampering | proposed risk | no CI workflow is implemented yet | minimum-permission CI and branch protection for workflow changes required |
| Verifier tampering | proposed risk | verifier self-test exists but lives in repo | required remote checks and code review required |
| Hand-edited ledger/state | verified risk | verifier hash-chain and consistency checks detect some edits | ledger/state replay minimum required |
| Old checkpoint/closeout replay | verified | gate and status expose current git reality mismatch | keep stable-exit and gate checks bound to current HEAD |
| `.bha/local` missing in fresh clone | verified | fresh clone can verify tracked trust without local push authorization | keep local-only recovery path explicit |
| Signed wrong payload | proposed risk | status reports mismatch and signer boundary | operator playbook and signed-payload-status required before push |
| CI writes tracked evidence | proposed risk | not implemented | CI must remain read-only until a dedicated evidence model exists |

### Bypass Matrix

| Bypass path | Claim | Classification | Stop gate |
| --- | --- | --- | --- |
| `git push --no-verify` | verified risk | remote protection required | branch protection with required BHA checks |
| Missing `.githooks/pre-push` install | verified risk | remote protection required | branch protection; hook is convenience only |
| Local `core.hooksPath` changed | verified risk | remote protection required | branch protection; `hook-status` is diagnostic |
| GitHub UI edit | verified risk | remote protection required | restrict direct writes and require checks |
| Token push from another machine | verified risk | remote protection required | restrict pushers and require checks |
| Force push | proposed risk | remote protection required | block force pushes |
| Branch deletion | proposed risk | remote protection required | block deletions |
| Admin bypass | unknown | accepted only if explicitly documented | branch protection ADR must state bypass policy |
| Modify workflow to skip checks | proposed risk | remote protection required | protect workflow changes and review required |
| Modify verifier to ignore failures | proposed risk | remote protection plus review required | required checks and reviewer focus on verifier diffs |
| Hand edit `.bha/state.json` | verified risk | verifier detect target | state replay consistency |
| Hand edit `.bha/ledger.jsonl` | verified risk | verifier detect target | hash chain and event schema checks |
| Reuse old signed capability | verified | local block | expiry, head, ledger head, policy hash, mission hash, replay checks |
| Reuse consumed capability | verified | local block | local session and consume checks |
| Copy `.bha/local` across machines | proposed risk | local block or accepted residual risk | local-only evidence remains non-tracked and context-bound |

### Minimum Operator Playbook

Claim status: proposed operator procedure using existing commands.

Normal local verification:

```powershell
git status --short --branch
node scripts/bha-run.js validate
node scripts/bha-run.js checkpoint --format json
node scripts/bha-run.js closeout --record --format json
node scripts/bha-verify.js
node scripts/bha-run.js stable-exit-status --remote 'origin' --branch 'master' --format json
```

Evidence repair after tracked file changes:

1. Treat dirty tracked files as unverified until validation runs.
2. Run `node scripts/bha-run.js validate`.
3. If validation passes, run `checkpoint` and `closeout --record`.
4. Run the verifier.
5. Commit evidence only after explicit commit authorization.

Gate blocked recovery:

- `VALIDATION_STALE_INPUTS`: run validation after finishing tracked edits.
- `UNVERIFIED_WORKTREE_CHANGE`: validate the current tracked change or commit/revert it with explicit authorization.
- `CLOSEOUT_NOT_CURRENT_LEDGER_HEAD`: record a new closeout only after verifier-compatible evidence exists.
- `HEAD_MISMATCH`: regenerate checkpoint/closeout or push payload for current git `HEAD`.
- `NO_VALID_CONSUMED_GIT_PUSH_CAPABILITY`: only relevant before an operator-chosen real push; regenerate and sign current local payload outside BHA.

Rollback path:

- Stop the next phase.
- Keep remote actions disabled.
- Use the failing verifier or gate reason as the repair target.
- Make the smallest local repair.
- Rerun validation and verifier before recording checkpoint/closeout.

### CI Read-Only JSON Strict Gate

Claim status: implemented read-only gate, verified on `master` at `8a8b869bc501c03177c4a9e606aa2dda14f7e6b1`.

Observed workflow:

- `.github/workflows/bha-readonly-gate.yml`
- workflow name: `bha-readonly-gate`
- job/check name: `BHA read-only gate`
- latest observed run: `https://github.com/JENN2046/Bounded-High-Autonomy/actions/runs/26160950357`
- latest observed result: success
- permissions observed from workflow file: `contents: read`
- checkout setting observed from workflow file: `persist-credentials: false`
- tracked evidence writes: none in CI
- JSON artifacts: uploaded as `bha-readonly-gate-json`

CI requirements:

- `permissions: contents: read`
- no repository secrets
- no write token
- no `pull_request_target`
- no checkout credentials persisted after checkout
- no dependency install or package manager mutation
- no provider calls
- no deploy, release, tag, package publish, or push
- no writes to `.bha/ledger.jsonl`, `.bha/state.json`, or `.bha/checkpoint.json`
- JSON artifact is an observation report, not ledger evidence

Implemented checks:

```powershell
node --check scripts/bha-run.js
node --check scripts/bha-verify.js
node scripts/bha-verify.js
node scripts/bha-run.js audit-v12 --format json
node scripts/bha-run.js audit-v1-stable --format json
node scripts/bha-run.js stable-exit-status --remote origin --branch master --format json
git clone --depth 1 --branch master https://github.com/${GITHUB_REPOSITORY}.git "$fresh"
node scripts/bha-verify.js
node scripts/bha-run.js recover-status --remote origin --branch master --format json
node scripts/bha-run.js gate-status --remote origin --branch master --format json
node scripts/bha-run.js stable-exit-status --remote origin --branch master --format json
```

Required check name for current branch protection:

- `BHA read-only gate`

Future granular required check names, if the workflow is later split into multiple jobs:

- `bha/syntax`
- `bha/verifier-self-test`
- `bha/verifier`
- `bha/audit-v12`
- `bha/audit-v1-stable`
- `bha/fresh-clone-readonly`
- `bha/bypass-matrix-readonly`

Proposed JSON artifacts:

- `bha-syntax.json`
- `bha-verifier-self-test.json`
- `bha-verifier.json`
- `bha-audit-v12.json`
- `bha-audit-v1-stable.json`
- `bha-fresh-clone-readonly.json`
- `bha-bypass-matrix-readonly.json`

Fresh clone read-only matrix:

```powershell
git status --short --branch
node --check scripts/bha-run.js
node --check scripts/bha-verify.js
node scripts/bha-verify.js --self-test
node scripts/bha-verify.js
node scripts/bha-run.js recover-status --remote 'origin' --branch 'master' --format json
node scripts/bha-run.js gate-status --remote 'origin' --branch 'master' --format json
```

Bypass matrix read-only assertions:

- `check -- git push origin master` returns DENY with exit 2.
- `assert-deny -- git push origin master` returns success because DENY is expected.
- `assert-deny -- git push --force origin master` returns success because force push is denied.
- `assert-deny -- git tag v0.0.0` returns success because tag/release is denied.
- `assert-deny -- npm install` and `assert-deny -- npm publish` return success because package install/publish is denied.
- `assert-deny -- openai models list` and `assert-deny -- codex-memory write` return success because provider and memory writes are denied.
- `gate-status` reports `push_requirement.required_now=false` and blocks real push readiness without a current consumed `git_push` capability.

Workflow hardening requirements:

- Use `actions/checkout` with `persist-credentials: false`.
- Do not request or inherit write permissions.
- Do not upload `.bha/local/`.
- Do not run `validate`, `checkpoint`, `closeout --record`, `push-prep`, `issue-capability`, `consume-capability`, or any command that writes tracked evidence.
- Treat artifacts as CI observations only. They do not update ledger/state and do not replace local closeout evidence.

Future strict interface target:

```powershell
node scripts/bha-verify.js --format json --strict
```

Stop gate:

Do not make CI required until the latest `master` run is green and the exact GitHub check name is confirmed from the repository UI or API. The currently observed check name is `BHA read-only gate`.

### V1 Stable Exit Review

Claim status: verified local review complete at `8a8b869bc501c03177c4a9e606aa2dda14f7e6b1`; no P1/P2 found in this review.

Verified:

- worktree clean on `master`
- local `master` aligned with `origin/master`
- `node scripts/bha-verify.js` reports `PASS` with no issues or warnings
- `node scripts/bha-run.js stable-exit-status --remote origin --branch master --format json` reports `PASS`
- `node scripts/bha-run.js audit-v1-stable --format json` reports `PASS`
- `node scripts/bha-run.js audit-v12 --format json` reports `PASS`
- `node scripts/bha-run.js stable-exit-review --remote origin --branch master --format json` reports `PASS`
- GitHub Actions run `26160950357` reports success for head `8a8b869bc501c03177c4a9e606aa2dda14f7e6b1`
- local one-use `git_push` capability is replay-blocked after push, as expected
- CI workflow is read-only and does not write ledger, state, checkpoint, closeout, local capability files, tags, releases, packages, deployments, or remote branches

Verified:

- V1 local trust kernel reached remote branch protection readiness and `master` protection is now applied.
- Fresh-clone tracked trust is represented in CI through verifier, recover-status, gate-status, and stable-exit-status.
- GitHub `master` branch protection is enabled.
- Required check for `master`: `BHA read-only gate`.
- Require branch up to date before merge: enabled.
- Require pull request review before merge: enabled with 1 approval.
- Dismiss stale approvals: enabled.
- Require conversation resolution: enabled.
- Require linear history: enabled.
- Include/enforce administrators: enabled.
- Force pushes and branch deletion: disabled.

Proposed:

- Keep future split checks optional until the workflow is intentionally decomposed into multiple jobs.
- Add CODEOWNERS before claiming code-owner review enforcement.
- Document any emergency direct-push bypass after it happens, then repair through the normal protected PR path.

Unknown:

- Whether signed commits are operationally available for the repository owner.
- Whether push restrictions should be narrowed to an explicit maintainer set beyond the current protection rules.

P1 findings: none.

P2 findings: none.

P3 findings:

- Documentation previously described the read-only CI gate as proposed and named future granular checks instead of the currently implemented required check name. The plan now distinguishes the implemented `BHA read-only gate` from future split checks.

Residual risks:

- Local hooks remain bypassable by `--no-verify`, missing hooksPath, or direct shell use.
- GitHub UI edits, workflow edits, admin emergency actions, and tokens with sufficient authority remain remote risks even after branch protection.
- V1 is tamper-evident, not OS-level tamper-proof.

Stop gate:

Do not claim complete remote enforcement beyond the verified `master` protection settings. Any emergency bypass must be explicitly recorded afterward.

### Branch Protection Enforcement

Claim status: verified applied for `master` on GitHub.

Verified applied settings:

- required status checks before merge
- fixed required check name for the current workflow: `BHA read-only gate`
- require branch up to date before merge
- block force pushes
- block branch deletion
- require PR before merging to `master`; direct owner push is emergency-only
- require at least one approving review
- require conversation resolution before merge
- enforce administrators
- require linear history

Not enabled / not claimed:

- Future split-check names, only after workflow decomposition: `bha/syntax`, `bha/verifier-self-test`, `bha/verifier`, `bha/audit-v12`, `bha/audit-v1-stable`, `bha/fresh-clone-readonly`, and `bha/bypass-matrix-readonly`.
- Code-owner reviews are not claimed until CODEOWNERS exists and is enabled.
- Push restrictions are not claimed beyond the configured branch protection.
- Signed commits are not claimed until the repository owner can support them operationally.
- protect workflow changes with review and required checks

Current verified configuration for `master`:

- Require a pull request before merging: enabled.
- Required approvals: 1 minimum.
- Dismiss stale approvals when new commits are pushed: enabled.
- Require review from Code Owners: not enabled / not claimed.
- Require conversation resolution before merge: enabled.
- Require status checks to pass before merging: enabled.
- Required status check: `BHA read-only gate`.
- Require branches to be up to date before merging: enabled.
- Require deployments before merging: disabled for V1.
- Require signed commits: not enabled / not claimed.
- Require linear history: enabled.
- Include administrators: enabled.
- Restrict who can push to matching branches: not enabled / not claimed.
- Allow force pushes: disabled.
- Allow deletions: disabled.
- Lock branch: disabled unless the repository is intentionally frozen.
- Ruleset target: branch `master`.

Standard remote update flow after enforcement:

1. Complete local evidence work and keep `stable-exit-status` passing.
2. Create a topic branch for the next change.
3. Push the topic branch only after local BHA gate/capability checks that apply to that branch.
4. Open a pull request targeting `master`.
5. Wait for `BHA read-only gate` and required review before merge.
6. Treat direct `git push origin master` as emergency-only, even if a local `git_push` capability can be generated.

Recommended protected path review focus:

- `.bha/**`
- `scripts/bha-run.js`
- `scripts/bha-verify.js`
- `.githooks/**`
- `.github/workflows/**`
- `AGENTS.md`
- `BHA_*.md`

Stop gate:

No claim of broader remote enforcement until any additional protection, CODEOWNERS, signed-commit, or push-restriction settings are actually applied and verified from GitHub repository settings.

Emergency bypass path:

1. State the reason, affected branch, exact bypass action, and rollback command before acting.
2. Keep the bypass local or remote-minimal; do not combine it with release, deploy, tag, or provider actions.
3. After the emergency action, run the read-only CI gate and local verifier path.
4. Record the bypass as accepted residual risk or repair it with a normal protected PR.

### Fresh Clone And Bypass Validation Matrix

Claim status: proposed validation matrix.

Fresh clone acceptance:

- `node scripts/bha-verify.js` passes or reports only tracked evidence issues that can be repaired without `.bha/local`.
- `recover-status` explains that `.bha/local` is not required for tracked verifier trust.
- `gate-status` fails closed for real push capability when no local consumed capability exists.
- validation, checkpoint, closeout, and verifier can restore tracked local trust.

Bypass validation:

- simulate missing hook configuration with `hook-status`
- run prepush-check without valid capability and require fail-closed
- verify stale unsigned and signed payloads are rejected
- verify old checkpoint/closeout HEAD mismatch is reported
- verify denied command families stay denied through `assert-deny`

### 30-Day Stability Window

Claim status: proposed release discipline.

The window is not just elapsed time. It requires:

- repeated CI dry-run passes after remote gate exists
- at least one fresh clone trust restoration drill
- no unresolved P1 issue
- no unresolved P2 issue without an accepted risk note
- documented handling for any verifier, validation, or gate regression
- platform support statement: Windows local and Linux CI minimum, unless narrowed explicitly

P1 failure resets the window. P2 failure either resets the window or requires a written accepted-risk note.

### Packaging Readiness Review

Claim status: proposed future review, not approval.

Skill, repo template, MCP, CLI, or reusable workflow work remains non-activating until:

- V1 freeze criteria pass
- remote gate is applied or explicitly deferred with accepted risk
- fresh clone behavior is documented
- supported platforms are declared
- the package does not include `.bha/local`, secrets, one-use capabilities, or dynamic evidence
- the package cannot bypass `bha-run` or `bha-verify`

Default decision: not ready until the above are true.

### Capability Expansion Readiness Review

Claim status: proposed future review, not approval.

Any new capability family stays denied unless all are present:

- explicit user objective
- policy taxonomy and deny-by-default entry
- schema and binding rules
- runner behavior
- ledger event
- verifier rule
- negative tests
- replay tests
- rollback or recovery path
- remote gate impact analysis

Default decision: do not enable provider, memory, deploy, release, package, ssh, or arbitrary command capabilities.
