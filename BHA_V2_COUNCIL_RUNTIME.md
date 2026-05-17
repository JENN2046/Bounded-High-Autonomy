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
