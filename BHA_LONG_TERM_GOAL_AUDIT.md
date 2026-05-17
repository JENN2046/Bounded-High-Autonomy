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
| V1 stable audit | `audit-v1-stable`, `BHA_V1_STABILITY.md`, `.bha/validation.yaml` | `node scripts/bha-run.js audit-v1-stable --format json` | stable candidate |
| V2 capability framework | `BHA_V2_CAPABILITY_FRAMEWORK.md`, `capability-framework-status` | `node scripts/bha-run.js capability-framework-status --format json` | preview, default deny |
| V2+ Council Runtime | `BHA_V2_COUNCIL_RUNTIME.md`, `council-status` | `node scripts/bha-run.js council-status --format json` | preview, no automation |

## Current Local Acceptance Commands

```powershell
node scripts/bha-run.js validate
node scripts/bha-run.js checkpoint --format json
node scripts/bha-run.js closeout --record --format json
node scripts/bha-verify.js
node scripts/bha-run.js audit-v12 --format json
node scripts/bha-run.js audit-v1-stable --format json
node scripts/bha-run.js recover-status --remote origin --branch master --format json
node scripts/bha-run.js gate-status --remote origin --branch master --format json
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
