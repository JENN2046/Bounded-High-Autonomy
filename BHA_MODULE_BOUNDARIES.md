# BHA Runtime Module Boundaries

This is a current-state boundary map for the modules extracted from `scripts/bha-run.js`.
It is documentation, not proof or authorization. Repository reality, verifier output,
ledger/state evidence, policy, and validation results remain authoritative.

## Boundary Rules

- Runtime entrypoints stay in `scripts/bha-run.js` and `scripts/bha-verify.js`.
- Pure modules must not read files, write files, call subprocesses, read environment,
  mutate ledger/state, consume/reserve capabilities, or perform remote actions.
- Modules that are allowed to write must receive guards and paths from the runtime
  boundary; they must not invent their own authority.
- Signature verification, trusted key lookup, policy/state/mission loading, and ledger
  writes remain runtime-boundary responsibilities unless explicitly moved with tests.
- Time-dependent pure summaries must accept caller-provided time when determinism matters.

## Current Modules

### `scripts/lib/command-effects.js`

Purpose: classify BHA CLI commands as `read_only`, `ledger_write`,
`local_only_write`, or `external_guarded`.

Allowed:
- Pure command/effect classification.
- JSON parsing of CLI `--json` text for capability type detection.

Forbidden:
- File I/O, ledger writes, local capability writes, subprocesses, network, env reads.
- Deciding whether a write is safe without runtime enforcement.

### `scripts/lib/policy-check.js`

Purpose: normalize command/path inputs and evaluate allow/deny policy decisions.
Boundary drift is covered by regression-selftest check
`policy_check_has_only_caller_provided_inputs`; this is a guardrail, not a proof
source above repository reality.

Allowed:
- Pure policy evaluation from caller-provided `policy`, `mission`, and `argv`.
- `path` helper usage for command basename normalization.
- `process.platform` only for deterministic Windows path normalization.

Forbidden:
- Loading policy or mission files.
- Recording decisions to ledger.
- Running or spawning commands.
- Reading environment, secrets, or remote state.

### `scripts/lib/validation-runner.js`

Purpose: run configured validation commands through caller-provided execution and
policy hooks, then normalize validation results.
Boundary drift is covered by regression-selftest check
`validation_runner_executes_only_through_injected_run_command`; this is a
guardrail, not a proof source above repository reality.

Allowed:
- Use caller-provided `evaluateValidationCommandPolicy`, `runCommand`,
  `parseJsonLine`, `scrubArgv`, `truncate`, and `appendValidationStep`.
- Spawn validation only through the injected `runCommand`.
- Create validation record objects from command output.

Forbidden:
- Direct `child_process` usage.
- Direct policy, mission, state, or ledger file reads.
- Direct ledger writes.
- Expanding validation authority beyond caller-provided policy decisions.

### `scripts/lib/capability-store.js`

Purpose: manage capability event construction and tracked/local capability stores.

Allowed:
- File writes only to caller-provided capability paths.
- Ledger recording only through injected `deps.appendLedger`.
- State/policy/mission access only through injected deps.
- Local capability writes only after injected local-write guards.
- Tracked capability writes only after injected tracked-write guards.

Forbidden:
- Bypassing `ensureTrackedWriteAllowed` or `ensureLocalWriteAllowed`.
- Reading private keys or verifying signatures.
- Reserving or consuming capabilities outside the runtime lock path.
- Writing paths not supplied and resolved by the runtime boundary.
- Remote actions.

### `scripts/lib/git-reality.js`

Purpose: parse git status output and build git-reality summary objects from
caller-provided values.
Boundary drift is covered by regression-selftest check
`git_reality_has_only_caller_provided_inputs`; this is a guardrail, not a proof
source above repository reality.

Allowed:
- Pure parsing of git status porcelain output.
- Pure construction of checkpoint/closeout/current head comparison summaries.

Forbidden:
- Running git commands.
- Reading `.git` files.
- Writing evidence, ledger, state, or checkpoints.
- Claiming current git reality without caller-provided command output.

### `scripts/lib/local-payload-status.js`

Purpose: convert local unsigned/signed payload summaries into reason codes,
human messages, and next local recovery commands.

Allowed:
- Pure status/reason construction from caller-provided summaries.
- Building local command strings for operator handoff.

Forbidden:
- Reading payload files.
- Writing payload, handoff, capability, ledger, or state files.
- Signing, verifying, issuing, consuming, or reserving capabilities.
- Treating suggested commands as authorization to run them.

### `scripts/lib/payload-summary.js`

Purpose: summarize caller-provided local payload file objects against a
caller-provided current context.

Allowed:
- Pure summary construction from supplied file values.
- Expiry calculations using caller-provided `nowMs`; missing `nowMs` produces
  deterministic unknown expiry status instead of reading the current clock.

Forbidden:
- Reading local payload files.
- Verifying signatures.
- Writing payload, ledger, state, or capability files.
- Looking up policy, mission, ledger head, git head, or trusted keys.
- `Date.now`, `process`, `fs`, ledger writes, or file writes.

### `scripts/lib/capability-verifier.js`

Purpose: pure capability shape, hash, canonicalization, binding, expiration, and
key-purpose checks from caller-provided values.

Allowed:
- Deterministic canonical JSON and SHA-256 hash construction.
- Pure reason-code checks for schema, id, run id, policy hash, mission hash,
  ledger head hash, one-use, expiration, command binding, and key purpose.
- Normalize trusted signing key policy items without reading policy.

Forbidden:
- `Date.now`, `process`, `fs`, ledger writes, or file writes.
- `crypto.verify`, `crypto.sign`, private key access, or trusted key lookup.
- Capability reserve/consume logic.
- Loading policy, mission, state, ledger, or capability stores.

### `scripts/lib/push-gate.js`

Purpose: construct push-gate decisions, handoff commands, protected-branch
policy summaries, post-push summaries, and pre-push evidence gate booleans from
caller-provided evidence.
Boundary drift is covered by regression-selftest check
`push_gate_has_only_injected_evidence_helpers`; this is a guardrail, not a proof
source above repository reality.

Allowed:
- Pure gate decision logic from supplied state, ledger events, verifier result,
  rollback checks, capability status, and helper functions.
- Build command strings and operator-facing next-action summaries.

Forbidden:
- Running git or BHA commands.
- Reading/writing ledger, state, checkpoint, closeout, or capability files.
- Consuming capabilities or reserving sessions.
- Treating generated commands or summaries as remote authorization.

## Current Boundary Debt

- `capability-store.js` is intentionally not pure. It is a guarded store adapter,
  so future changes must preserve injected guards and paths.
- `push-gate.js` contains evidence semantics but no I/O. Keep current/replayed
  evidence facts caller-provided.
