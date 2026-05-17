# BHA V2 Capability Framework

This is the V2 preview contract for turning the current `git_push` capability into an extensible framework without opening new authority by default.

## Default deny

Unknown, incomplete, expired, replayed, unsigned, unsupported, overbroad, or policy-denied capabilities must fail closed.

The only production capability type enabled now is:

- `git_push`

The following remain denied by default:

- provider calls
- deploy
- release
- tag
- package publish
- production write
- force push
- destructive filesystem action
- private key access
- secret access
- memory write

## Capability Type Contract

Each future capability type must define:

- `type`
- required binding fields
- allowed command or local action
- one-use or session policy
- local-only or tracked evidence policy
- signing key purpose
- replay behavior
- deny tests
- replay tests
- verifier evidence

No capability is enabled merely because it appears in a payload. Policy must explicitly list it, verifier must understand it, and regression tests must cover the deny path before any allow path exists.

## Test Gate

Before any new capability can move from preview to enabled, it must have:

- runtime regression coverage for unknown, disallowed, incomplete, expired, and replayed payloads
- verifier self-test coverage for unsupported, policy-denied, incomplete, and replayed records
- validation wiring that runs the relevant negative matrix locally
- an explicit evidence policy stating whether records are tracked or local-only

The framework status command reports these requirements so operator/Codex can see that new capability types are not enabled by documentation alone.

## Enablement Gate

`capability-framework-status` must report `enablement_gate.new_production_capability_allowed=false` until a new explicit objective adds a schema, binding, allowed command, evidence policy, deny tests, replay tests, verifier evidence, and policy change. Planning and test design can continue locally, but provider calls, deploy, release, tag, package publish, memory write, private key access, and production write remain forbidden without a new objective.

## git_push Capability

`git_push` is the first production capability.

Required bindings:

- `run_id`
- `remote`
- `branch`
- `head`
- `ledger_head_hash`
- `policy_hash`
- `mission_hash`
- `expires_at`

Rules:

- command must be `git push <remote> <branch>`
- signing key purpose must be `owner`
- capability must be one-use
- replay is blocked
- issue and consume evidence is local-only under `.bha/local/capabilities.jsonl`
- push hook USED session evidence is local-only under `.bha/local/capability-sessions.jsonl`

## Proof Boundary

Framework status, documentation, handoff text, AGENTS.md, prompts, hooks, approval prose, and closeout prose are not proof.

Trust still comes from repository reality, ledger/state evidence, verifier output, validation evidence, policy hash, mission hash, local-only capability evidence when a local capability is required, and git reality.
