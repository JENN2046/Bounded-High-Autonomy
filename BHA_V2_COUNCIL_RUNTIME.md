# BHA V2+ Council Runtime

Status: preview contract only.

The Council Runtime is the planned local workflow for Commander, Domain Leads, Worker, Verifier, and Commander decision loops. It is not an authority source, not proof, and not a provider integration.

## Boundary

The preview contract is local-only and read-only.

It must not:

- spawn automated sub-agents by default
- call providers
- write memory
- push, deploy, release, tag, or publish packages
- read, print, store, or forward private key material
- treat role prose, AGENTS.md, prompts, approvals, hooks, or closeout prose as proof

## Roles

Commander:
- defines scope, risk level, stop conditions, and the next safe local task

Domain Leads:
- split work into bounded local queue items with clear ownership

Worker:
- makes the smallest reversible local change inside the accepted queue item

Verifier:
- reviews the diff, runs local validation, and reports pass, fail, or blocker

Commander:
- decides whether to continue locally or stop at a hard boundary

## Proof Model

Council output is coordination context only.

Real trust still comes from:

- repository reality
- `.bha/ledger.jsonl`
- `.bha/state.json`
- verifier output
- policy hash
- mission hash
- local-only capability evidence when needed
- git reality

## Stop Conditions

The workflow must stop when the next step would cross any of these boundaries:

- completion
- validation failure requiring a design decision
- missing context
- remote or side-effectful action
- credential or private key access
- risk to user-owned work

## Local Status

`node scripts/bha-run.js council-status --format json` reports this preview contract. It does not execute the workflow, spawn agents, write memory, push, deploy, release, tag, or call providers.

## Non-Enabling Draft

The current Council Runtime draft shape is planning context only:

- workflow schema sketch: Commander boundary, Domain Lead queue, Worker local change, Verifier check, Commander decision
- role boundary matrix sketch: every role may create coordination context, but no role output is proof and no role may grant remote authority
- local dry-run trace sketch: future activation would need a recorded local trace that proves no provider call, memory write, push, deploy, release, tag, package publish, private-key access, or automated agent spawn occurred
- role boundary test plan sketch: every future role transition needs tests that prove the role cannot grant remote authority, bypass validation, read private keys, write memory, or turn prose into proof
- activation regression plan sketch: any future runtime must first prove fail-closed behavior for missing verifier evidence, stale local trace, blocked side effect, attempted provider call, attempted memory write, and attempted automated spawn

These sketches do not satisfy the activation requirement by themselves. `council-status` must keep `draft_artifacts.satisfies_activation_requirement=false` until a new explicit objective adds a verifier-backed workflow model, local dry-run evidence, role boundary tests, activation regression tests, and validation wiring.

The current draft explicitly does not provide:

- a verifier-enforced workflow model
- executable local dry-run trace evidence
- implemented role boundary tests
- implemented activation regression tests
- validation wiring that can activate automated scheduling
- authority for automated sub-agent spawning, provider calls, memory writes, push, deploy, release, tag, package publish, or private-key access

## Activation Gate

`council-status` must report `activation_gate.runtime_activation_allowed=false` until a new explicit objective adds a verifier-backed workflow model and local dry-run evidence. Planning can continue locally, but automated agent spawning, provider calls, memory writes, push, deploy, release, tag, package publishing, and private key access remain forbidden without a new objective.

## Test Gate

`council-status` must report activation coverage as incomplete until workflow schema, role boundary tests, local dry-run trace evidence, verifier evidence, validation wiring, and activation regression tests exist. The current status command may expose the missing activation requirements, but that is planning context only; it does not activate automated scheduling or make role prose proof.
