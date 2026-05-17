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
| V2 capability framework stays preview/default deny and does not enable new production capabilities | `BHA_V2_CAPABILITY_FRAMEWORK.md`, `capability-framework-status` | `node scripts/bha-run.js capability-framework-status --format json`; validation id `capability_framework_status_readonly` | Production capability types must remain exactly `git_push`; future capability enablement coverage remains incomplete until a new explicit objective adds schema, binding, allowed command, evidence policy, deny tests, replay tests, verifier evidence, and policy change. |
| V2+ Council Runtime stays preview/status and does not spawn agents or create side effects | `BHA_V2_COUNCIL_RUNTIME.md`, `council-status` | `node scripts/bha-run.js council-status --format json`; validation id `council_status_readonly` | Role output is coordination context, not proof; activation coverage remains incomplete until workflow schema, role boundary tests, local dry-run evidence, verifier evidence, validation wiring, and activation regression tests exist. |
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

Any future move beyond the current hold lines requires a new explicit objective and local deny/replay/verifier coverage before enablement.
