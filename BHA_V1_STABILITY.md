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

## Local Reproduction

A new operator or contributor should be able to reproduce tracked trust locally with:

```powershell
node scripts/bha-run.js validate
node scripts/bha-run.js checkpoint --format json
node scripts/bha-run.js closeout --record --format json
node scripts/bha-verify.js
node scripts/bha-run.js audit-v12 --format json
node scripts/bha-run.js audit-v1-stable --format json
node scripts/bha-run.js recover-status --remote 'origin' --branch 'master' --format json
node scripts/bha-run.js gate-status --remote 'origin' --branch 'master' --format json
```

`gate-status` is expected to fail closed when no valid current consumed git_push capability exists. That is not a request to push. It means a git_push capability is needed only if the operator separately chooses a real push.

`node scripts/bha-run.js audit-v1-stable --format json` is the strict operator audit path. Operators should use the strict command, and its output should report `validation_in_progress_override=false` for stable local trust. The `--allow-validation-in-progress` flag is validation bootstrap only: it exists so `validate` can run the stable audit while validation inputs are being refreshed, and it must not be treated as the normal operator proof command.

Fresh clone recovery starts with tracked trust:

```powershell
node scripts/bha-verify.js
node scripts/bha-run.js recover-status --remote 'origin' --branch 'master' --format json
```

If tracked evidence is stale, regenerate local evidence with `validate`, `checkpoint`, and `closeout --record`, then rerun the verifier. If `.bha/local/` is missing or stale, regenerate local push payload files only before an operator-chosen real git push.
