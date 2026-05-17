# BHA V1 Stability

V1 is the smallest local-first BHA kernel that should remain reliable, repeatable, and auditable without relying on prompts or closeout prose as proof.

## Scope

- Runtime code uses Node.js built-in modules only.
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
