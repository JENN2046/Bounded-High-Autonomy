# Repository Guidelines

## Project Structure & Module Organization

This repository contains the local-first BHA runtime kernel. Runtime source lives in `scripts/`: `bha-run.js` handles checked actions, validation, checkpoints, closeout, and capability flow; `bha-verify.js` is the read-only verifier. Project evidence and contracts live in `.bha/`, including `policy.yaml`, `mission.yaml`, `ledger.jsonl`, `state.json`, `validation.yaml`, `capabilities.jsonl`, `rollback.md`, and `checkpoint.json`. Git integration is limited to `.githooks/pre-push`. `BHA_DESIGN.md` is the architecture and design reference.

## Build, Test, and Development Commands

There is no package manager setup for v1; use Node.js built-in modules only.

- `node --check scripts/bha-run.js` checks runtime syntax.
- `node --check scripts/bha-verify.js` checks verifier syntax.
- `node scripts/bha-verify.js --self-test` runs the verifier negative-test matrix.
- `node scripts/bha-run.js validate` runs configured validation and records evidence.
- `node scripts/bha-run.js verify` runs verifier through the runtime wrapper.
- `node scripts/bha-run.js audit-v12 --format json` checks V1.2 requirement coverage against repository artifacts and recorded evidence.
- `node scripts/bha-run.js closeout --format json` previews generated closeout evidence.
- `node scripts/bha-run.js prepush-check` exercises the fail-closed local push gate.

## Coding Style & Naming Conventions

Write CommonJS JavaScript with `'use strict'`, 2-space indentation, semicolons, and Node built-ins only (`fs`, `path`, `crypto`, `child_process`). Use `UPPER_SNAKE_CASE` for file path constants and `camelCase` for functions and local variables. Keep changes small and deterministic; canonical JSON and hashes must not depend on object insertion order.

## Testing Guidelines

Prefer focused verifier and validation checks over broad ad hoc scripts. Add or update self-test cases in `scripts/bha-verify.js` when changing policy, ledger, capability, validation, checkpoint, or closeout behavior. Validation evidence must be recorded in `.bha/ledger.jsonl` through `bha-run`, not claimed only in prose.

## Codex Trusted Shell Flow

For day-to-day local work, prefer the BHA shell commands before claiming trusted state: `node scripts/bha-run.js inspect --format json`, `node scripts/bha-run.js validate`, `node scripts/bha-verify.js`, `node scripts/bha-run.js audit-v12 --format json`, `node scripts/bha-run.js checkpoint --format json`, `node scripts/bha-run.js closeout --format json`, and `node scripts/bha-run.js gate-status --remote origin --branch master --format json`. Use `closeout --record --format json` only when verifier and validation evidence support recording a final local closeout.

`AGENTS.md` is behavior guidance, not proof. Proof still comes from repository reality, `.bha/ledger.jsonl`, `.bha/state.json`, verifier output, policy hash, mission hash, validation evidence, necessary `.bha/local/` gate evidence, and git reality.

## Commit & Pull Request Guidelines

Recent history uses conventional commit prefixes such as `feat:`, `fix:`, `chore:`, and `test:`. Keep commits narrow and describe the verified behavior, not just the edited file. Pull requests should summarize changed runtime boundaries, list validation commands run, identify skipped checks, and call out any capability or pre-push gate impact.

## Security & Agent-Specific Rules

Do not store private keys, secrets, tokens, provider credentials, or `.env` values in the repository. Do not add dependencies, network calls, provider automation, deploy/release controls, tag publishing, or destructive external actions for v1. Treat repository reality, ledger evidence, verifier output, and policy hash as sources of truth; prompts and closeout prose are not proof.
