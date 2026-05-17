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

## Non-Enabling Draft

This section is intentionally non-enabling.

The current V2 draft shape is planning context only:

- schema sketch: `type`, binding fields, allowed command or local action, one-use or session policy, evidence policy, signing key purpose, replay behavior
- binding contract sketch: every capability binds to current policy hash, mission hash, run id, and the smallest git or local state needed for the requested action
- evidence policy sketch: tracked evidence is allowed only when it cannot dirty the protected action path; local-only evidence is required for action authorization that would otherwise recurse into new tracked commits
- deny test plan sketch: every future type starts with unknown, disallowed, incomplete, expired, overbroad, wrong-policy, wrong-mission, and wrong-binding fail-closed cases before any allow path is considered
- replay test plan sketch: every future one-use or session policy needs issue, consume, USED-session, stale-session, and duplicate-consume fail-closed cases
- verifier evidence plan sketch: every future type needs verifier-readable ledger or local-only evidence rules before it can affect a gate decision

These sketches do not satisfy the enablement requirement by themselves. `capability-framework-status` must keep `draft_artifacts.satisfies_enablement_requirement=false` until a new explicit objective adds verifier-backed schema, deny tests, replay tests, validation wiring, and policy changes.

## Machine-Readable Preview Contract

`capability-framework-status` exposes the preview contract as structured JSON, not only prose.

The machine-readable schema draft is `bha.capability_schema.v2.preview`. It includes:

- schema draft fields: `type`, `binding`, `allowed_command`, `one_use_or_session_policy`, `evidence_policy`, `signing_key_purpose`, `expiry`, and `replay_policy`
- binding model requirements: `run_id`, `policy_hash`, `mission_hash`, `expires_at`, and the smallest action-specific binding needed for the requested local action
- allowed command constraints: no shell expansion, no provider/deploy/release/tag/package publish/memory/private-key command class, and exact command matching before any allow path
- evidence policy: draft evidence is not authorization, verifier-readable evidence is required before allow, and tracked/local scope must be declared explicitly
- replay policy: one-use or session policy is required, and duplicate consume, USED session, and stale session cases fail closed

The deny/replay matrix is also machine-readable and executable in preview mode. It must include unknown type, disallowed type, incomplete binding, stale binding, wrong policy hash, wrong mission hash, expired, replayed, and overbroad command cases before any future allow path is considered. Each case records the expected reason, observed reason, pass/fail status, and `authorization_effect=false`.

The verifier evidence contract is explicit: incomplete preview schema is a verifier failure, draft evidence is not authorization, `audit-v2-preview` is verifier-gated in strict mode, and future authorization requires policy allow, verifier evidence, and validation wiring.

The current draft explicitly does not provide:

- a verifier-enforced schema for any future capability type
- a policy allow entry for any future capability type
- implemented future deny or replay tests beyond the existing `git_push` negative coverage
- verifier evidence that can authorize any future capability type
- an explicit policy change that would move any future type from default deny to allowed

## Test Gate

Before any new capability can move from preview to enabled, it must have:

- runtime regression coverage for unknown, disallowed, incomplete, expired, and replayed payloads
- verifier self-test coverage for unsupported, policy-denied, incomplete, and replayed records
- validation wiring that runs the relevant negative matrix locally
- an explicit evidence policy stating whether records are tracked or local-only

The framework status command reports these requirements so operator/Codex can see that new capability types are not enabled by documentation alone.

`capability-framework-status` must report future capability enablement coverage as incomplete until a future capability schema, binding, allowed command, evidence policy, deny tests, replay tests, verifier evidence, and explicit policy change exist.

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
