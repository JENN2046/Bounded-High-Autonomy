# BHA Design Document

Document status:

- Current stage: V1 local trust kernel stable candidate.
- Primary scope: define and maintain BHA's local safety model, evidence model, capability model, and
  V1 runtime boundaries.
- Implementation status: the V1 local runtime is implemented enough to run validation, verifier,
  checkpoint, closeout, signed `git_push` capability flow, local pre-push gate, and real `git push`
  through the gate. Repository reality and verifier output outrank this design text.
- Remote status: GitHub `master` branch protection is verified applied for this repository with the
  required check `BHA read-only gate`. Local BHA evidence is not a remote attestation by itself, and
  repository settings must still be read back from GitHub before making remote enforcement claims.
- Design posture: freeze and harden the small verifiable V1 before expanding V2 capability or council
  runtime work.

Current runtime reality addendum:

- `gate-status` is a read-only operator command that reports verifier gates, hook configuration,
  capability state, and the next safe action.
- Capability signing remains external to BHA. Runtime helpers may prepare unsigned payloads or verify
  signed JSON from `.bha/local/` files, but they must not read, print, store, or request private key
  material.
- `git_push` issue, consume, and hook USED evidence are local-only under `.bha/local/` and ignored by
  Git. This keeps the signed authorization bound to the already-created HEAD without making push
  produce another required evidence commit.
- `prepush-check --preflight` is read-only. The real Git hook path may write a local-only USED
  session under `.bha/local/capability-sessions.jsonl` to reserve the one-use `git_push`
  capability. That local session is gate evidence, not tracked verifier proof.
- Repository-tracked evidence proves local trust readiness for the HEAD: policy, mission,
  validation, checkpoint, closeout, ledger, state, and verifier consistency. It does not mean a push
  is required now, and a real operator-chosen push still requires a fresh one-use local `git_push`
  capability bound to the current HEAD and ledger state.
- After validation/checkpoint/closeout repair, `.bha/ledger.jsonl`, `.bha/state.json`, and
  `.bha/checkpoint.json` may be dirty by design. Stable-exit and the local push gate may treat only
  those authorized runtime evidence files as acceptable dirtiness; code, policy, hook, validation, or
  documentation dirtiness remains blocking unless revalidated and committed.
- A Git commit changes repository HEAD but does not, by itself, make validation stale. Validation
  freshness is bound to the validation input hash, policy hash, mission hash, and the recorded
  `validation_completed` event. When those inputs are unchanged, BHA should use
  `evidence-ux-status` and `repair-evidence --fast` to rebind checkpoint/closeout evidence instead
  of rerunning the full validation matrix.
- An evidence-only commit that changes only `.bha/checkpoint.json`, `.bha/ledger.jsonl`, and
  `.bha/state.json` is an evidence carrier commit when its parent is the subject HEAD referenced by
  checkpoint and closeout. Carrier commits do not recursively require new evidence for themselves;
  the subject evidence remains the proof target and the carrier only transports tracked evidence.
- After a real push succeeds, the one-use `git_push` capability must become USED and replay-blocked.
  `gate-status` should report that as a successful post-push state for that capability, not as a
  reusable authorization.
- With protected `master`, the standard remote update path is topic branch, pull request targeting
  `master`, and required check `BHA read-only gate`. A direct `git push origin master` is
  emergency-only and requires explicit operator authorization, a fresh local `git_push` capability,
  and GitHub protection allowing the action.
- Ordinary topic branch push is intentionally simpler: `ship --yes` may push the current
  non-protected branch and create or reuse a pull request after local evidence gates pass. This path
  does not require the operator to manually sign a payload; the remote PR required check remains the
  final trust gate before `master`.
- `install-git-ship-alias --yes` may install a repository-local `git ship` alias that forwards to
  `node scripts/bha-run.js ship`; it never writes global Git config and does not weaken `ship` gates.
- Remote tracking refs are local Git observations after fetch or push; they are useful evidence, but
  they are not remote proof by themselves.
- Validation input hashes normalize text line endings to LF before hashing so trust recovery does not
  depend on a clone's `core.autocrlf` setting.
- V2 capability framework and council runtime artifacts are preview only. They must remain marked as
  non-authoritative, non-activating, and incapable of granting runtime authority until a separate
  explicit objective adds verifier-backed runtime evidence.

## 1. BHA Design Rhythm and Roadmap

BHA should proceed in controlled phases. The goal is to avoid both premature implementation and
endless research.

The optimal rhythm is:

```text
Codex Reality -> BHA Principles -> BHA Core Architecture -> Minimal Runtime -> Validation Loop -> Adapter Expansion
```

### 1.1 Phase 1: Codex Grounding

Purpose:

- understand how Codex actually works
- identify native control surfaces
- identify where Codex controls are partial
- define what BHA must add

Key outputs:

- Codex operating model
- CLI and App comparison
- approvals, rules, and hooks analysis
- AGENTS.md and instruction priority analysis
- context, compaction, and resume analysis
- tools and side effects analysis
- subagents and worktrees analysis
- automation and model limits analysis
- Codex boundary summary
- source exploration plan
- source findings
- findings-to-requirements mapping

Completion standard:

- BHA can explain what it should reuse from Codex.
- BHA can explain what it must enforce itself.
- Key source questions are prepared before reading Codex source.
- First-pass source findings are recorded with stability labels.
- Codex findings are translated into BHA requirements.

Status:

- Complete enough to move into BHA Core Design.
- Remaining Codex source work should be targeted follow-up only when a BHA architecture decision
  depends on it.

### 1.2 Phase 2: BHA Core Design

Purpose:

- define what BHA is as a system
- separate concepts, files, roles, and runtime responsibilities
- avoid baking CLI-only assumptions into the core

Key outputs:

- BHA core architecture
- role and phase model
- risk model
- state and evidence model
- capability lifecycle
- validation strategy
- checkpoint and resume contract

Completion standard:

- every core object has a clear responsibility
- every write path has an owner
- every high-risk action has a gate
- every long-running task has a resume strategy
- every validation claim has an evidence source

### 1.3 Phase 3: Minimal BHA Runtime

Purpose:

- implement only the smallest useful runtime loop
- prove the core design with real local execution

Priority commands:

- `inspect`
- `risk-classify`
- `checkpoint`
- `validate`
- `verify`
- `closeout`
- `make-push-payload`
- `verify-signed-capability`
- `issue-capability`
- `consume-capability`
- `prepush-check`

Completion standard:

- a real Codex task can move from inspection to closeout
- interrupted work can be resumed from repository state
- verifier PASS remains meaningful
- push requires capability
- failed validation produces clear reason codes

### 1.4 Phase 4: Codex-Native Integration

Purpose:

- connect BHA to Codex's native surfaces without depending on them as the only safety boundary

Key outputs:

- AGENTS.md template
- Codex rules template
- Codex hooks template
- subagent role templates
- worktree policy
- automation posture config

Completion standard:

- Codex naturally receives BHA guidance at session start
- risky commands are caught early by Codex controls where possible
- BHA runtime still independently verifies critical claims
- integration does not weaken verifier or capability gates

### 1.5 Phase 5: Automation and Scaling

Purpose:

- support unattended, multi-agent, and App/worktree workflows

Key outputs:

- unattended mode
- per-worktree runtime state
- handoff checkpoint format
- multi-agent write ownership rules
- CI-friendly closeout
- tool risk calibration table

Completion standard:

- unattended runs fail closed by default
- multi-agent work has disjoint ownership
- worktree handoff is auditable
- external writes remain gated
- automation output is machine-readable and reviewable

### 1.6 Current Next Step

The next best step is not more broad Codex research and not immediate BHA runtime implementation.

The next best step is finishing the BHA design document itself: close the architecture questions,
make the v1 implementation boundary explicit, and define the entry criteria for runtime work.

Sections 12, 14, and 15 should be treated as the bridge from Codex reality to BHA architecture.
Sections 16 through 27 should be treated as the first complete BHA core design pass.

Research should continue only when it answers a specific architecture question. It should not
continue just because more source code exists.

## 2. Codex Operating Model

BHA must be designed around how Codex actually works, not around an imagined fully autonomous
executor. Codex is best understood as a coding agent stack with three layers.

### 2.1 Bottom Logic

Codex is not a direct executor. The model reasons, plans, decides, and generates actions. Actual
effects happen through runtime tools such as file reads, file edits, shell commands, browser tools,
MCP tools, and GitHub/app integrations.

This means:

- Prompt instructions are important, but they are not a complete safety boundary.
- Tool permissions, sandboxing, approvals, rules, and hooks are part of the real execution model.
- BHA should not rely only on Codex saying it will be careful.
- BHA should provide deterministic local checks for high-risk actions.

### 2.2 Runtime Logic

A typical Codex task loop is:

1. Receive user goal and constraints.
2. Load relevant context such as system rules, developer rules, AGENTS.md, current files, and
   observed repository state.
3. Inspect the workspace with read-only tools.
4. Choose a safe next action.
5. Edit files or run commands through the tool layer.
6. Observe tool results.
7. Validate, repair narrowly if safe, or stop when a boundary is reached.
8. Report changed files, validation, risks, and next steps.

This loop can be interrupted by:

- sandbox restrictions
- approval gates
- denied paths
- dirty worktree state
- failed validation
- context compaction
- user interruption
- remote or irreversible action boundaries

BHA should make these interruptions explicit and resumable.

### 2.3 Design Logic

Codex is designed as a collaborative coding agent, not as an unbounded autonomous process. It works
best when the project provides:

- clear goals
- narrow scope
- reliable validation
- explicit stop conditions
- readable repository conventions
- safe command boundaries
- recoverable checkpoints

BHA should therefore act as a project-local governance layer for Codex autonomy. Its job is to make
safe progress easier and unsafe progress harder.

## 3. Codex CLI and Codex App

Codex CLI and Codex App share the same basic agent model, but they expose different operating
surfaces.

### 3.1 Where They Are Basically Aligned

At the three-layer level, CLI and App are mostly consistent:

- Bottom logic: both use a model to reason and tools to act.
- Runtime logic: both follow an inspect, edit, validate, report loop.
- Design logic: both depend on sandboxing, approvals, project rules, and user supervision.

Both should be treated as Codex agent environments rather than separate kinds of intelligence.

### 3.2 Where They Differ

Codex CLI is primarily a local single-window workflow:

- one active working directory
- one main conversation thread
- local shell and local filesystem
- direct terminal feedback
- good for focused single-task execution

Codex App is more of a multi-agent command center:

- multiple agents or task threads
- worktree-based isolation
- diff review and comments
- easier task switching
- better fit for long-running and parallel work

The App adds orchestration surfaces, but the core safety problem remains the same: Codex actions
must be bounded, validated, and auditable.

### 3.3 BHA Implication

BHA should not be designed as CLI-only glue. It should have a core layer and adapters.

Core BHA should define:

- policy
- ledger
- state
- verifier
- checkpoint
- capability gate
- closeout

CLI adapter should focus on:

- single working tree
- single active task
- local commands
- terminal-friendly reports

App adapter should eventually support:

- multiple agents
- worktrees
- task queue state
- per-agent write boundaries
- cross-thread checkpoint and closeout

The design goal is one BHA autonomy model that can run through different Codex surfaces.

## 4. Codex Control Surfaces

BHA should reuse Codex native control surfaces where they are strong, and add deterministic
project-local enforcement where they are incomplete.

The three most important Codex control surfaces are:

- Approvals and sandboxing
- Rules
- Hooks

### 4.1 Approvals and Sandboxing

Codex security starts with two layers:

- Sandbox mode: what the agent can technically touch.
- Approval policy: when the agent must stop and ask before acting.

For local CLI and IDE use, Codex normally runs with OS-level sandboxing. In the common
`workspace-write` mode, Codex can read and edit inside the workspace, while network access is off
unless explicitly enabled. Approval is required for actions that leave the sandbox, use network, or
otherwise require elevated permission.

Important BHA implications:

- BHA should assume network is disabled by default, and treat enabling network as a high-risk gate.
- BHA should treat `.git`, `.codex`, and `.agents` as protected paths, even when the workspace is
  otherwise writable.
- BHA should not depend on approval prompts as the only safety mechanism, because approval settings
  can vary by user, profile, app surface, or enterprise policy.
- BHA should treat `danger-full-access`, `--yolo`, or bypass-permissions modes as incompatible with
  high-assurance automation unless an outer sandbox exists.
- BHA should prefer read-only or workspace-write plus on-request approvals for normal operation.

Approval modes are useful for human supervision, but BHA should still verify repository-local facts
before high-risk actions. For example, even if a human approves an escalated command, BHA should
still require a valid capability before allowing a real push.

### 4.2 Rules

Codex Rules control which commands may run outside the sandbox. Rules are prefix-based and can
return:

- `allow`: run without prompting
- `prompt`: ask before each matching invocation
- `forbidden`: block without prompting

Codex applies the most restrictive matching decision. This matters because BHA can express broad
hard stops as forbidden rules while allowing narrow validation commands.

Rules are strongest when commands are simple argument lists. For simple shell chains, Codex can
split commands and evaluate each segment. For advanced shell syntax such as redirection,
substitution, environment variables, wildcards, or control flow, Codex treats the full shell
invocation as one command.

Important BHA implications:

- BHA should generate or recommend rules for high-risk command families such as `git push`, `git tag`,
  release tools, deployment tools, provider CLIs, package installs, and destructive filesystem
  commands.
- BHA should avoid broad allow rules. Rules such as `git` or `node` are too wide.
- BHA should prefer narrow allow or prompt prefixes for known validation commands.
- BHA should not rely only on rules for commands hidden behind complex shell syntax.
- BHA should include match and not_match examples when generating rules, so rule mistakes fail early.

Rules are a useful Codex-native policy layer, but they are not a substitute for BHA's own verifier,
ledger, and capability gate.

### 4.3 Hooks

Codex Hooks can run command handlers at lifecycle points such as:

- `SessionStart`
- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`
- `UserPromptSubmit`
- `Stop`

Hooks can inspect session metadata, the current working directory, the active model, permission mode,
and tool input. Some hooks can add model-visible context, and supported tool calls can be denied by
returning the expected JSON block or a blocking exit code.

Hooks are useful for BHA because they can:

- load BHA session context at startup or resume
- warn Codex about dirty state before edits
- block obvious dangerous shell commands
- review command output after execution
- remind Codex to checkpoint before stopping
- attach BHA risk context to approval requests

However, hooks are not a complete enforcement boundary. Codex documentation states that `PreToolUse`
is a guardrail rather than full enforcement because equivalent work may be possible through another
tool path, and some newer or non-shell tool paths may not be intercepted.

Important BHA implications:

- BHA should use hooks as early-warning and workflow glue, not as the only safety layer.
- BHA should keep critical checks inside deterministic runtime commands such as `verify`,
  `prepush-check`, and capability verification.
- BHA should not depend on transcript format as stable state. Hook docs expose transcript paths for
  convenience, but the format is not a stable interface.
- BHA should treat hook failures conservatively when they guard high-risk behavior.

### 4.4 What BHA Can Reuse

BHA can reuse Codex-native controls for:

- local filesystem sandboxing
- network default-deny behavior
- approval prompts for sandbox escapes and side-effecting tool calls
- rules for broad command allow/prompt/forbidden behavior
- hooks for startup context, preflight warnings, approval context, post-tool review, and stop checks
- protected path behavior for `.git`, `.codex`, and `.agents`

### 4.5 What BHA Must Enforce Itself

BHA must enforce the following itself because Codex-native controls are configurable, partial, or not
designed as project-local audit systems:

- ledger hash chain integrity
- state consistency
- validation freshness
- canonical capability format
- offline public-key signature verification
- one-use capability consumption
- prepush fail-closed behavior
- closeout evidence
- checkpoint/resume facts
- project-specific stop conditions

BHA should treat Codex controls as the outer operating environment and BHA runtime checks as the
project-specific governance layer.

## 5. AGENTS.md and Instruction Priority

AGENTS.md is Codex's project guidance mechanism. It gives Codex durable instructions before work
starts, but it should be treated as an instruction layer rather than an enforcement layer.

### 5.1 Discovery Model

Codex builds an instruction chain once per run or launched session.

The discovery order is:

1. Global scope
   - Codex home defaults to `~/.codex`, unless `CODEX_HOME` is set.
   - Codex reads `AGENTS.override.md` if present.
   - Otherwise it reads `AGENTS.md`.
   - Only the first non-empty global file is used.

2. Project scope
   - Codex starts at the project root, usually the Git root.
   - It walks down to the current working directory.
   - In each directory, it checks `AGENTS.override.md`, then `AGENTS.md`, then configured fallback
     names such as `TEAM_GUIDE.md`.
   - Codex includes at most one file per directory.

3. Merge order
   - Files are concatenated from root to current directory.
   - More local guidance appears later and can override earlier guidance.
   - Empty files are skipped.
   - Combined guidance is capped by `project_doc_max_bytes`, 32 KiB by default.

### 5.2 What AGENTS.md Is Good For

AGENTS.md is useful for stable project guidance:

- repository conventions
- preferred commands
- validation expectations
- coding style
- known hazards
- allowed and denied paths
- risk posture
- handoff format
- when Codex should stop and ask

BHA should use AGENTS.md to teach Codex how to behave in this repository before it touches files.

### 5.3 What AGENTS.md Is Not Good For

AGENTS.md is not a complete safety boundary.

Reasons:

- It is natural-language guidance, not deterministic enforcement.
- It can be too large, stale, ambiguous, or partially truncated.
- Local overrides can change behavior by directory.
- It is loaded at session start, so changes during a session may not be active until a new run.
- User prompts can introduce new task-specific constraints that must be interpreted against the
  existing instruction chain.
- The model can still misunderstand instructions.

BHA should therefore avoid relying on AGENTS.md for irreversible or high-risk guarantees.

### 5.4 BHA Instruction Priority Model

BHA should model instruction priority explicitly.

The practical priority order should be:

1. Non-negotiable safety and platform constraints
2. Current explicit user instruction
3. Observed repository reality
4. Closest applicable project AGENTS.md
5. Checked-in project documentation
6. Global AGENTS.md
7. Historical memory or prior handoff
8. General model knowledge

Observed repository reality includes:

- actual file contents
- current branch
- worktree state
- diffs
- validation output
- verifier output
- command exit codes

If AGENTS.md conflicts with observed reality, BHA should follow observed reality and report the
conflict. If current user instruction conflicts with AGENTS.md but stays inside safety boundaries,
the current user instruction should steer the task.

### 5.5 BHA AGENTS.md Strategy

BHA should keep AGENTS.md concise and stable.

Good AGENTS.md content:

- "Inspect git status before editing."
- "Treat uncommitted changes as user-owned."
- "Do not push, tag, release, deploy, or modify secrets without explicit approval."
- "Run `node scripts/bha-run.js validate` and `node scripts/bha-run.js verify` after BHA runtime
  changes."
- "Stop if verifier cannot pass."
- "Never read, request, print, or store private key material."

Poor AGENTS.md content:

- long design essays
- volatile branch state
- temporary task plans
- raw command output
- secrets or credentials
- detailed implementation state that belongs in checkpoint files

BHA should keep durable behavior rules in AGENTS.md and keep changing task state in BHA checkpoint
or ledger files.

### 5.6 BHA Implication

AGENTS.md should be the soft behavioral contract. BHA policy, verifier, ledger, and capability gate
should be the hard project-local control system.

In other words:

- AGENTS.md tells Codex what kind of partner to be.
- BHA runtime proves what actually happened.
- BHA policy decides what is allowed.
- BHA verifier decides whether recorded state is trustworthy.

## 6. Context, Compaction, and Resume

Long-running Codex work cannot assume the full conversation will remain perfectly available or
perfectly interpreted. BHA needs its own project-local resume layer.

### 6.1 Codex Context Model

Codex carries task context through the active conversation, tool results, loaded files, project
instructions, and runtime configuration. In CLI, Codex also stores local transcripts so a previous
session can be resumed.

Useful Codex CLI controls include:

- `/compact`: replace earlier turns with a concise summary to free context while keeping critical
  details.
- `/resume`: reload a saved conversation transcript.
- `/fork`: branch the current conversation into a new thread.
- `/side`: start a focused side conversation without disrupting the main thread.
- `/status`: inspect model, approval policy, writable roots, and context usage.
- `/diff`: inspect current working tree changes.

This gives Codex practical continuity, but it is not the same as project-local truth.

### 6.2 Compaction Reality

Compaction is useful because long-running conversations eventually become too large. OpenAI's
general compaction model reduces context size while preserving state needed for later turns.

Important design facts:

- Compaction is lossy from the human user's point of view.
- The compacted state may carry important prior reasoning, but it should not be treated as an
  auditable source of truth.
- A compacted summary can omit details that later matter.
- Compaction helps Codex continue, but BHA must still verify current repository reality.

BHA should therefore never treat "the model remembers" as proof. It should treat compaction as a
continuation aid only.

### 6.3 Resume Reality

Codex resume can reload previous transcript, plan history, and approvals. This is useful for
continuing work without restating the entire task.

However, a resumed transcript may be stale relative to the repository:

- files may have changed
- branch may have changed
- working tree may be dirty
- validation may be stale
- permissions may differ
- hooks, rules, or AGENTS.md may have changed
- a previous command may have partially executed before interruption

BHA should require reality checks after every resume.

### 6.4 BHA Resume Contract

On resume, BHA should verify before trusting previous state:

1. Workspace root
2. Git repository presence
3. Current branch
4. Worktree status
5. Relevant diff
6. BHA state file
7. Ledger head and hash chain
8. Validation freshness
9. Verifier result
10. Any active capability or consumed capability state
11. Current user instruction versus previous checkpoint

If any of these disagree with the prior transcript or checkpoint, repository reality wins.

### 6.5 Checkpoint Design

BHA checkpoints should be human-readable and machine-checkable.

A useful checkpoint should include:

- original goal
- current phase
- active role or phase
- workspace root
- branch
- HEAD
- worktree status
- changed files
- allowed paths
- denied paths
- validation commands run
- validation result
- verifier result
- ledger head
- open risks
- blockers
- next safe action
- hard stop conditions

Checkpoint data should not contain secrets, private keys, raw env values, or unnecessary command
output.

### 6.6 Interruption Handling

When a user interrupts Codex or a command is aborted, BHA should assume partial execution is possible.

After interruption, BHA should:

1. Stop issuing new write actions.
2. Check whether any process is still running if the runtime exposes that information.
3. Re-read worktree status and relevant diffs.
4. Re-run verifier if BHA files may have changed.
5. Mark the previous phase as interrupted unless it can be proven complete.
6. Continue only after the next safe action is clear.

Interruption should not be treated as failure by default. It should be treated as an uncertain state
requiring inspection.

### 6.7 BHA Implication

BHA should create an explicit project-local memory of work, separate from Codex conversation memory.

The split should be:

- Codex transcript: useful working context
- Codex compaction: useful continuation aid
- Codex resume: useful session restoration
- BHA checkpoint: authoritative handoff summary
- BHA ledger: authoritative event evidence
- BHA verifier: authoritative consistency check

BHA should make every long-running task resumable by another Codex session that starts with no
private memory and only the repository files.

## 7. Tools and Side Effects

Codex produces real-world effects through tools. The model decides, but tools act.

For BHA, the unit of risk should be the tool action, not only the natural-language request and not
only shell commands.

### 7.1 Tool Layer as the Effect Layer

Codex can interact with a project through several tool families:

- file reads and repository search
- file edits and patch application
- local shell commands
- browser or computer-use tools
- MCP tools and connectors
- GitHub or other code-hosting integrations
- app-specific tools such as Slack, Notion, spreadsheets, documents, presentations, or image
  generation
- subagents that can themselves use tools

Each tool family has different side effects. A command-line deny rule for `git push` does not
automatically control a GitHub connector that can create a PR, post a comment, or update an issue.

### 7.2 Side Effect Classes

BHA should classify tool actions by effect, not by implementation.

Suggested classes:

- `read_local`: read files, inspect diffs, inspect local config
- `write_local`: edit files inside allowed workspace paths
- `execute_local`: run local commands without network or external side effects
- `write_git_metadata`: commit, stage, rewrite history, change branches, edit `.git`
- `network_read`: fetch remote docs, query APIs, inspect remote resources
- `network_write`: create or update remote resources
- `provider_call`: call model/provider APIs
- `secret_access`: read secrets, tokens, private keys, or env values
- `package_change`: install, remove, upgrade, or audit-fix dependencies
- `release_action`: tag, release, deploy, publish, or production write
- `destructive_action`: delete data, remove files, reset history, force push

The same user intent can map to different risk classes depending on the tool used.

### 7.3 Non-Shell Tools Matter

BHA must not be shell-only.

Examples:

- A GitHub app tool can create a PR without running `git push`.
- A Slack connector can send a message without shell network commands.
- A browser tool can click a production admin UI.
- A document/spreadsheet tool can modify local artifacts.
- An MCP connector can read or write external system state.

Therefore, BHA's risk gate should reason about semantic action classes:

- What system is targeted?
- Is the action read-only or write-capable?
- Is it local or remote?
- Does it expose secrets?
- Does it modify user-owned work?
- Does it create external side effects?
- Can it be rolled back?

### 7.4 Tool Permission Is Not Intent

A tool being available does not mean the current task authorizes its use.

BHA should distinguish:

- capability: the environment exposes a tool
- permission: sandbox or approval policy allows the tool
- intent: the user asked for this kind of action
- safety: the action is inside current risk boundaries
- evidence: the action and result are recorded or verifiable

All five must be satisfied for high-impact actions.

### 7.5 BHA Implication

BHA should define a tool-risk abstraction that sits above individual tools.

At minimum, every BHA-controlled action should record:

- tool family
- action class
- target
- read/write classification
- local/remote classification
- expected side effects
- whether user intent explicitly authorizes it
- whether approval was required
- whether the action was actually executed
- validation or rollback evidence

This lets BHA govern Codex CLI shell commands, Codex App integrations, and future tools with one
consistent safety vocabulary.

## 8. Subagents and Parallel Work

Codex can spawn subagents to run specialized work in parallel, then collect results into the parent
thread. This is useful, but it changes the risk model.

### 8.1 What Subagents Are For

Subagents are best for work that is:

- parallelizable
- bounded
- easy to describe
- easy to verify independently
- not immediately blocking the parent agent

Good examples:

- codebase exploration across separate areas
- independent PR review dimensions such as security, bugs, tests, and maintainability
- documentation research
- repeated audits over many files or components
- bounded implementation slices with disjoint write scopes

Poor examples:

- urgent blocking work the parent must know before the next step
- vague "think more" tasks
- broad refactors without clear ownership
- parallel edits to the same files
- high-risk actions requiring human authorization

### 8.2 Subagent Permission Model

Subagents inherit the current sandbox and approval policy unless configured otherwise. Runtime
overrides in the parent session, including approval changes, are also reapplied to spawned children.

This means:

- A permissive parent session can make subagents permissive too.
- Read-only subagents should be explicitly configured read-only when their job is exploration or
  review.
- In non-interactive flows, a subagent action that needs fresh approval may fail because there is no
  active human approval surface.
- A custom agent can have its own model, reasoning effort, sandbox mode, MCP servers, skills, and
  instructions, but defaults inherit from the parent when omitted.

BHA should not assume subagents are safer merely because they are separate threads.

### 8.3 Built-in and Custom Agent Roles

Codex has built-in roles such as:

- `default`: general fallback
- `explorer`: read-heavy codebase exploration
- `worker`: implementation and fixes

Custom agents can be defined with a name, description, and developer instructions. Good custom
agents are narrow and opinionated. Each should have:

- a clear job
- a matching tool surface
- explicit read/write limits
- clear output format
- stop conditions

BHA should prefer read-only explorer/reviewer subagents before allowing write-capable worker
subagents.

### 8.4 Coordination Risks

Parallel work introduces new failure modes:

- write conflicts
- duplicated effort
- stale assumptions between agents
- inconsistent validation
- unclear ownership
- nested fan-out cost
- approval prompts coming from inactive threads
- parent agent over-trusting subagent conclusions

BHA should treat subagent output as evidence, not authority. The parent agent still owns final
integration and validation.

### 8.5 BHA Subagent Policy

BHA should allow subagents only when explicitly authorized by the user or by a clear BHA workflow.

When subagents are used, BHA should require:

- one bounded task per subagent
- declared role
- declared read/write scope
- declared expected output
- no remote writes
- no private key or secret access
- no capability issue or consume unless specifically authorized
- no overlapping write sets for implementation agents
- parent review before integration

Recommended role defaults:

- `explorer`: read-only, gathers code evidence
- `reviewer`: read-only, finds bugs, regressions, and missing tests
- `docs_researcher`: read-only plus approved documentation tools
- `worker`: write-capable only for explicit files or modules
- `verifier`: runs validation, preferably read-only except generated local validation output

### 8.6 Concurrency Limits

Codex supports global subagent settings such as maximum open agent threads and maximum nesting
depth. BHA should keep concurrency conservative.

Suggested defaults:

- max depth: 1
- max active implementation workers: 1 unless write sets are disjoint
- max exploratory/review agents: small fixed number
- no recursive delegation unless explicitly enabled

The goal is controlled parallelism, not uncontrolled fan-out.

### 8.7 BHA Implication

Subagents are a way to scale cognition and inspection, not a way to bypass risk gates.

BHA should use subagents to improve:

- exploration coverage
- review quality
- documentation verification
- independent validation
- parallel low-risk work

BHA should not use subagents to weaken:

- path ownership
- approval boundaries
- capability gates
- verifier requirements
- final parent accountability

## 9. Worktrees and Isolation

Codex App uses Git worktrees to let Codex run independent tasks in the same repository without
disturbing the user's foreground checkout. BHA should treat worktrees as an important execution
surface, not as an implementation detail.

### 9.1 What Worktrees Provide

A Git worktree is another checkout of the same repository. Each worktree has its own working files,
but the repository metadata is shared through Git.

In Codex App:

- background automations for Git repositories run in dedicated worktrees
- a user can start a thread directly on a worktree
- a thread can be handed off between Local and Worktree
- Codex-managed worktrees are usually lightweight and disposable
- Codex-managed worktrees are created under `$CODEX_HOME/worktrees`
- threads commonly start from a selected branch in detached HEAD mode

This makes worktrees useful for parallel work, background tasks, and keeping the user's local
checkout stable.

### 9.2 What Worktrees Do Not Solve

Worktrees isolate files, but they do not eliminate coordination risk.

Important limitations:

- Worktrees share Git metadata.
- Git prevents the same branch from being checked out in multiple worktrees at once.
- Creating a branch in a worktree can affect what can be checked out elsewhere.
- Handoff uses Git operations and can move work between environments.
- Files ignored by `.gitignore` do not move with handoff.
- Worktrees can be deleted or restored from snapshots.
- Detached HEAD work may still need branch creation, review, commit, or PR flow later.

BHA should not assume a worktree is disposable if it contains uncommitted useful work.

### 9.3 BHA Worktree Identity

BHA needs to distinguish execution contexts.

A BHA checkpoint should record:

- workspace kind: local checkout or worktree
- absolute workspace path
- repository root
- branch or detached HEAD status
- HEAD commit
- worktree identifier when available
- parent/local checkout relationship when known
- whether the thread was handed off

Without this, a resumed task may confuse local checkout state with background worktree state.

### 9.4 State and Ledger Across Worktrees

Worktrees create a hard design question for BHA: what is shared, and what is per-worktree?

Recommended split:

- Policy: repository-level source of truth, versioned with the repo.
- Validation config: repository-level source of truth, versioned with the repo.
- Runtime state: per-worktree unless explicitly merged.
- Ledger: per-worktree or per-run unless BHA has a merge protocol.
- Capability consume/session markers: per-run and tied to exact HEAD, remote, branch, and ledger head.
- Checkpoints: per-thread or per-run, with worktree identity recorded.

The dangerous failure mode is two agents writing one shared ledger from different worktrees without
coordination. That can corrupt ordering assumptions or make resume ambiguous.

### 9.5 Handoff Rules

When a task moves between Local and Worktree, BHA should require a handoff checkpoint.

The handoff checkpoint should record:

- source workspace
- target workspace
- HEAD before handoff
- dirty files before handoff
- ignored files that may not transfer
- validation status before handoff
- verifier status before handoff
- remaining tasks
- next safe action

After handoff, BHA should re-run the resume reality check instead of trusting the previous
workspace's state.

### 9.6 Parallel Worktree Policy

BHA should allow worktree parallelism when:

- tasks are independent
- write scopes are disjoint
- each worktree has its own checkpoint
- each worktree can validate independently
- merge or handoff is explicit
- high-risk actions still require capability gates

BHA should stop or ask when:

- two worktrees modify the same source-of-truth BHA state without a merge protocol
- a branch is checked out or created in one worktree and expected in another
- ignored files are required for validation
- a worktree contains uncommitted useful work and cleanup is requested
- a push, PR, release, deploy, or external write is proposed

### 9.7 BHA Implication

BHA core should not assume a single working tree.

It should model:

- run identity
- workspace identity
- thread identity
- branch or detached HEAD state
- source-of-truth files
- runtime artifact files
- merge or handoff events

Worktrees are a strong isolation primitive for Codex App, but BHA still needs explicit state,
checkpoint, and capability semantics to make parallel autonomy safe.

## 10. Non-Interactive and Automation Mode

Codex does not always run with a human watching every step. CLI exec runs, scheduled automations,
GitHub workflows, and background tasks change the safety model.

BHA should be stricter when the user is not actively present.

### 10.1 Interactive Versus Unattended

Interactive Codex sessions can ask clarifying questions, surface approval prompts, show diffs, and
let the user interrupt.

Unattended Codex runs cannot rely on timely human judgment. This includes:

- CLI non-interactive execution
- scheduled Codex App automations
- background worktree tasks
- CI and GitHub Action style runs
- recurring plugin or skill workflows
- thread automations that wake up on a schedule

In unattended mode, actions that require fresh approval may fail, or the environment may run with an
approval policy that never asks. BHA must treat both cases carefully.

### 10.2 Automation Sandbox Reality

Codex automations run with sandbox settings. The risk changes sharply by sandbox mode:

- Read-only: write, network, and app-computer actions should fail.
- Workspace-write: workspace edits are possible, but outside-workspace, network, and app-computer
  actions should require stronger permission or fail.
- Full access: background automation can carry elevated risk because file changes, commands, and
  network access may happen without an interactive prompt.

BHA should consider full-access unattended automation high risk by default.

### 10.3 BHA Policy for Unattended Runs

Unattended BHA mode should default to fail closed.

Allowed by default:

- local read-only inspection
- repository status and diff inspection
- deterministic local validation
- generation of reports
- generation of unsigned payloads
- read-only verifier runs

Allowed only with explicit preconfiguration:

- local file edits in declared paths
- checkpoint or ledger writes
- package cache reads
- limited documentation lookup
- worktree-local validation output

Human-gated or denied:

- push
- tag
- release
- deploy
- production write
- provider call
- memory write
- package install or dependency change
- secret or private key access
- destructive filesystem operations
- external service writes

### 10.4 Automation Prompt Durability

Automations need durable prompts. A good automation prompt should specify:

- exact scope
- what to inspect
- what to ignore
- allowed write paths
- denied actions
- validation required
- how to decide "nothing to report"
- when to stop
- what output format to produce

BHA should prefer skills or checked-in workflow definitions for repeated automations instead of
free-form prompts that drift over time.

### 10.5 First-Run Review

Before scheduling or trusting an automation, BHA should require manual test runs.

The first few automation outputs should be reviewed for:

- scope accuracy
- sandbox behavior
- tool usage
- diff quality
- validation quality
- absence of forbidden side effects
- clean closeout

Only after repeated clean runs should an automation be trusted for recurring use.

### 10.6 BHA Runtime Requirements for Automation

In non-interactive mode, BHA should provide machine-readable outputs.

Useful requirements:

- JSON output for gate decisions
- stable exit codes
- explicit reason codes
- no interactive prompts
- no hidden network fallback
- no private key access
- deterministic validation selection
- clear "blocked" state
- closeout artifact suitable for CI logs

This lets automation wrappers decide whether to continue, fail a job, or require human review.

### 10.7 BHA Implication

BHA should have two safety postures:

- interactive posture: safe local progress, ask at boundaries
- unattended posture: narrower scope, explicit preauthorization, fail closed at uncertainty

The absence of a human should make BHA more conservative, not more permissive.

## 11. Model Limits and Human Supervision

Codex is powerful, but BHA must not treat the model as infallible. BHA exists partly because model
judgment needs external structure, verification, and human boundaries.

### 11.1 What Codex Is Good At

Codex is strongest when:

- the task is clearly scoped
- relevant files and context are available
- repository conventions are visible
- validation commands exist
- the work can be decomposed into small steps
- tool results can correct assumptions
- humans review high-impact outcomes

Codex quality improves when it can verify its work. Tasks with repro steps, test commands, lint
commands, or clear acceptance criteria are safer for automation than open-ended requests.

### 11.2 Where Codex Can Fail

BHA should assume Codex can:

- misunderstand user intent
- overfit to stale context
- miss hidden repository conventions
- choose insufficient validation
- make a plausible but wrong inference
- continue from a compacted summary that omitted an important detail
- trust old transcript state over current repository reality
- fix the symptom instead of the root cause
- expand scope while trying to be helpful
- underweight rare but severe side effects

These are normal model risks, not exceptional failures.

### 11.3 Long-Running Task Risks

Long-running agent work adds specific risks:

- plan drift
- validation drift
- context rot
- repeated compaction loss
- stale assumptions after user interruption
- untracked side effects from tools
- multiple small changes accumulating into broad behavior change
- forgotten stop conditions

BHA should respond with checkpoints, verifier runs, and explicit phase boundaries.

### 11.4 Human Supervision Boundary

Humans should not need to approve every safe local step. That would defeat autonomy.

Humans should approve:

- remote writes
- pushes
- releases
- deployments
- production changes
- private key or secret handling
- destructive operations
- dependency changes
- broad refactors
- security-sensitive behavior changes
- unresolved validation failures requiring design judgment

BHA's goal is not "human always in the loop." It is "human at the right loop boundary."

### 11.5 Verification Over Confidence

BHA should prefer verified facts over model confidence.

Examples:

- "Tests passed" requires test output.
- "Worktree clean" requires git status.
- "Policy allows this" requires policy evaluation.
- "Capability is valid" requires cryptographic verification.
- "No forbidden side effects occurred" requires ledger or tool evidence.
- "Resume is safe" requires reality checks.

The model may summarize, but deterministic checks should decide critical gates.

### 11.6 Review as a Control Surface

Review is not just a final polish step. It is part of the safety model.

BHA should encourage review when:

- the diff touches shared runtime behavior
- the task changes safety policy
- validation coverage is weak
- code was produced by multiple agents
- the work crosses module boundaries
- the change affects user data, auth, secrets, or external systems
- an automation produced changes without interactive supervision

Review should focus on behavior, risks, missing tests, and rollback, not style-only comments.

### 11.7 BHA Implication

BHA should make Codex more useful by giving it structure:

- smaller tasks
- explicit roles
- clear risk gates
- durable checkpoints
- validation requirements
- deterministic verifier
- capability gates
- closeout evidence

BHA should not pretend this removes the need for human judgment. It should make human judgment
rarer, better timed, and better informed.

## 12. Codex Boundary Summary

This section closes the Codex analysis phase. It summarizes what Codex provides natively, where its
native boundaries are partial, and what BHA must add.

### 12.1 Codex Native Strengths

Codex already provides a strong execution environment for software work:

- model-driven planning and code reasoning
- repository inspection
- file editing
- local command execution
- validation loops
- sandboxing
- approval prompts
- AGENTS.md project guidance
- rules for command approval and denial
- hooks for lifecycle integration
- subagents for parallel work
- worktrees for App-based isolation
- transcript resume and compaction
- interactive human steering

BHA should reuse these strengths instead of rebuilding them.

### 12.2 Codex Native Boundaries

Codex native controls are useful but not complete for high-assurance autonomous project execution.

Key boundaries:

- Prompt instructions can be misunderstood or forgotten after context changes.
- AGENTS.md is a soft instruction layer, not deterministic enforcement.
- Rules are command-oriented and may not cover all non-shell tools.
- Hooks are guardrails, not complete enforcement boundaries.
- Approvals depend on current profile, sandbox mode, app surface, and human availability.
- Transcript resume helps continuity but is not project-local truth.
- Compaction is useful but lossy.
- Subagents increase coverage but also increase coordination risk.
- Worktrees isolate files but do not automatically solve shared state and merge semantics.
- Unattended automation cannot rely on real-time human judgment.
- Model confidence is not verification.

BHA should assume Codex can make progress but should not assume Codex alone can prove safety.

### 12.3 What BHA Must Add

BHA should add a deterministic project-local governance layer:

- explicit policy
- side-effect classification
- allowed and denied path model
- risk gate
- ledger hash chain
- current state file
- validation freshness checks
- verifier
- checkpoint and resume contract
- closeout evidence
- canonical capability format
- public-key signature verification
- one-use capability consumption
- prepush fail-closed behavior
- worktree/run identity
- unattended-mode fail-closed posture

These are the pieces that turn Codex from a capable coding agent into a bounded autonomous project
partner.

### 12.4 Design Requirements Derived from Codex

BHA core should follow these requirements:

1. Verify repository reality before trusting conversation memory.
2. Treat tool actions, not only shell commands, as the unit of risk.
3. Separate soft guidance from hard enforcement.
4. Use Codex rules and hooks as integration surfaces, not as the only safety system.
5. Keep high-risk actions behind explicit human or cryptographic gates.
6. Make every long-running task resumable from repository files.
7. Record evidence in a form another session can verify.
8. Support both interactive and unattended safety postures.
9. Treat subagents and worktrees as separate execution contexts.
10. Prefer verified facts over model confidence.

### 12.5 Codex Surface Matrix

| Surface | Human Present | Isolation | Default Risk | BHA Posture |
| --- | --- | --- | --- | --- |
| CLI interactive | yes | local sandbox | medium | proceed on safe local work, gate remote and irreversible actions |
| CLI non-interactive | no | configured sandbox | high | narrow allowlist, fail closed on uncertainty |
| Codex App local thread | yes | local checkout or worktree | medium | checkpoint before handoff, verify after resume |
| Codex App background worktree | partial | worktree | medium-high | per-worktree state, explicit merge/handoff |
| Scheduled automation | no | configured sandbox | high | read-mostly, strict scope, machine-readable closeout |
| Cloud or remote task | partial | remote environment | high | explicit sync/PR gate, no implicit production action |

### 12.6 Closure

The Codex analysis phase establishes the design constraint:

BHA should not try to replace Codex. BHA should wrap Codex with project-local policy, evidence,
verification, checkpointing, and capability gates so Codex can safely do more work with fewer
unnecessary interruptions.

## 13. Codex Source Exploration Plan (Completed Reference)

This section records the source exploration plan used for the first Codex grounding pass. It is now
a completed reference, not the current execution plan. Future source reading should be targeted to a
specific BHA architecture decision.

### 13.1 Exploration Principles

1. Question-driven exploration
   - Start from BHA design questions.
   - Search for source evidence.
   - Stop when the question has enough evidence for a design decision.

2. Boundary-focused exploration
   - Prioritize sandbox, approval, rules, hooks, tools, AGENTS.md, resume, subagents, worktrees, and
     automation.
   - Deprioritize UI polish, packaging, telemetry, install flow, and unrelated product code.

3. Contract versus implementation
   - Treat official documentation as public contract.
   - Treat source code as current implementation evidence.
   - Do not assume current implementation details are permanent unless docs also describe them.

4. Safety-first interpretation
   - When source behavior is unclear, BHA should choose the safer design.
   - If a Codex layer is partial, configurable, or bypassable, BHA should not rely on it as the only
     enforcement boundary.

5. Minimal useful reading
   - Prefer targeted `rg` searches and nearby context.
   - Avoid reading broad files without a question.
   - Record files inspected and what was learned.

### 13.2 Target Themes

The first source exploration pass focused on:

1. Command and tool execution path
2. Approval and sandbox enforcement
3. Rules engine
4. Hooks runtime
5. AGENTS.md loader
6. Resume, compact, and transcript handling
7. Subagents and delegation
8. Worktrees and handoff
9. Tool, MCP, and connector side effects
10. Non-interactive and automation behavior

### 13.3 Questions Per Theme

#### 13.3.1 Command and Tool Execution Path

- How does a model tool call become a local action?
- Which code path handles shell command execution?
- Are shell commands represented as argv arrays, shell strings, or both?
- Where are stdout, stderr, exit code, signal, and errors captured?
- How are command outputs truncated or summarized before returning to the model?
- Where are sensitive arguments scrubbed?
- How does command failure affect the agent loop?
- What is the order between hooks, rule evaluation, approval, sandboxing, and execution?

#### 13.3.2 Approval and Sandbox Enforcement

- Where are sandbox modes represented?
- Which paths are writable under `workspace-write`?
- How are protected paths such as `.git`, `.codex`, and `.agents` enforced?
- How is network access denied or allowed?
- When does Codex request escalation?
- Are approvals evaluated before or after rules?
- How are approval decisions recorded?
- How does behavior change in non-interactive mode?

#### 13.3.3 Rules Engine

- Where are rules files discovered?
- What is the rule schema?
- How is prefix matching implemented?
- How are allow, prompt, and forbidden decisions combined?
- Does the most restrictive rule always win?
- How are shell chains split?
- Which shell constructs prevent fine-grained splitting?
- Can rules apply to non-shell tools?
- Can rule decisions be surfaced as machine-readable evidence?

#### 13.3.4 Hooks Runtime

- Where is hook configuration loaded?
- Which lifecycle events are supported?
- What inputs does each hook receive?
- Which tool calls can `PreToolUse` inspect?
- How does a hook deny or block a tool call?
- Are hook failures fail-open or fail-closed by event type?
- Does hook output enter model context?
- Are transcript paths exposed to hooks?
- Which tool families are not covered by hooks?

#### 13.3.5 AGENTS.md Loader

- Where does Codex discover global AGENTS files?
- How are `AGENTS.override.md` and fallback filenames handled?
- How does Codex find project root?
- How does it walk from root to current working directory?
- How is the max byte limit applied?
- How are multiple files merged?
- Are AGENTS files reloaded during a session?
- How are conflicts between local AGENTS files represented to the model?

#### 13.3.6 Resume, Compact, and Transcript Handling

- Where are transcripts stored?
- What does `/resume` load?
- What state does resume restore besides messages?
- What does `/compact` replace or summarize?
- Is compacted content visible or structured?
- How are tool results preserved across resume?
- What happens after user interruption or aborted tool calls?
- Which resume facts are stable enough for BHA to rely on?

#### 13.3.7 Subagents and Delegation

- Where is subagent spawning implemented?
- What triggers are required before spawning?
- How is context forked or withheld?
- Do subagents inherit sandbox and approval policy?
- Can subagents have distinct models, tools, or instructions?
- How are subagent results returned to the parent?
- How are concurrent writes handled or prevented?
- Are nested subagents limited?

#### 13.3.8 Worktrees and Handoff

- Where are Codex-managed worktrees created?
- How is the worktree path chosen?
- How is detached HEAD represented?
- How does handoff move work between local and worktree contexts?
- What happens to ignored files during handoff?
- How are uncommitted changes preserved or restored?
- How are branch conflicts handled across worktrees?
- What cleanup paths can delete worktree state?

#### 13.3.9 Tool, MCP, and Connector Side Effects

- How are non-shell tools represented?
- Do tools expose read/write metadata?
- How are MCP tools discovered and invoked?
- Are connector calls classified as local, remote, read, or write?
- Do approval gates cover non-shell external writes?
- Are tool calls logged uniformly?
- Can BHA observe enough metadata to classify tool risk?
- Which tool families require BHA-specific wrappers or policy?

#### 13.3.10 Non-Interactive and Automation Behavior

- How does Codex detect non-interactive execution?
- What approval policy is used when no human is present?
- How are prompts or blocked approvals handled?
- How are automation outputs stored?
- What exit codes signal blocked, failed, or completed states?
- Are hooks and rules active in automation?
- Is network disabled by default?
- Can unattended runs write files, comments, PRs, or remote state?

### 13.4 Output Format

Each source exploration result should use this format:

```text
### Source Observation: <Theme>

Question:
- <specific question>

Files inspected:
- <path>

Observed behavior:
- <what the source appears to do>

BHA implication:
- <what this means for BHA design>

Stability:
- <public_contract | implementation_observation | uncertain>

Follow-up:
- <optional next question>
```

### 13.5 Stability Labels

Use these labels when recording source findings:

- `public_contract`
  - The behavior is documented by OpenAI public docs or stable user-facing configuration.
  - BHA may rely on it with normal version awareness.

- `implementation_observation`
  - The behavior is observed in current source code but not clearly documented as a contract.
  - BHA may use it cautiously, but should avoid depending on it for critical safety.

- `uncertain`
  - The source is ambiguous, incomplete, inaccessible, or contradicted by observed behavior.
  - BHA should choose the safer design and mark the question for follow-up.

- `do_not_depend`
  - The behavior is explicitly unstable, private, or unsuitable as a design dependency.
  - BHA should not rely on it except for debugging.

### 13.6 Completion Criteria

The Codex source exploration phase was complete enough when BHA could answer:

- Where can BHA safely reuse Codex controls?
- Which Codex controls are partial or advisory?
- Which high-risk actions require BHA runtime enforcement?
- Which state must BHA record itself?
- Which assumptions are public contract versus current implementation?

## 14. Codex Source Findings

This section records the first source-backed pass over Codex key boundaries. The purpose is to
validate the BHA design assumptions from earlier sections, not to fully document Codex internals.

### 14.1 Local Installation Shape

Question:

- Is the installed Codex package in the user environment source-readable?

Files inspected:

- `%APPDATA%\npm\codex.ps1`
- `%APPDATA%\npm\node_modules\@openai\codex\bin\codex.js`
- `%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\codex\codex.exe`
- `%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\codex\codex-command-runner.exe`
- `%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\codex\codex-windows-sandbox-setup.exe`

Observed behavior:

- The local npm package is mainly a launcher plus platform binaries.
- The Rust implementation source was not present in the installed package.
- Local `.codex` runtime files include sensitive or private session material and are not a suitable
  source exploration target for BHA design.

BHA implication:

- Source exploration should use the public `openai/codex` repository for implementation evidence.
- BHA should avoid depending on private local runtime files such as auth, logs, history, state DBs,
  or memories.

Stability:

- `implementation_observation`

Follow-up:

- Keep source findings tied to Codex version or commit when BHA begins relying on exact behavior.

### 14.2 Shell Rules and Exec Policy

Question:

- How does Codex decide whether a shell command is allowed, prompted, forbidden, or sandboxed?

Files inspected:

- `codex-rs/core/src/exec_policy.rs`
- `codex-rs/core/src/tools/handlers/shell/shell_command.rs`
- `codex-rs/core/src/tools/sandboxing.rs`

Observed behavior:

- Shell command policy flows through an exec policy manager that normalizes commands before matching
  rules.
- Simple shell invocations can be split into command segments for more precise matching.
- Complex shell syntax falls back to coarser prefix handling and disables some automatic rule
  amendment behavior.
- Decisions include allow, prompt, and forbidden outcomes.
- A command may bypass the sandbox only when the policy path explicitly permits it.
- Codex avoids suggesting broad unsafe rules for high-power interpreters or shells.

BHA implication:

- Codex rules are useful, but BHA must not rely on them as the only boundary for high-risk actions.
- BHA should generate narrow command rules and avoid broad prefixes such as `git`, `node`, `python`,
  or shell interpreters.
- BHA should treat complex shell commands as higher risk because fine-grained command intent may be
  less visible.

Stability:

- `implementation_observation`

Follow-up:

- Later BHA rule templates should test simple commands and complex shell expressions separately.

### 14.3 Approval, Sandbox, and Cached Decisions

Question:

- Are approval prompts a deterministic safety boundary?

Files inspected:

- `codex-rs/core/src/tools/sandboxing.rs`

Observed behavior:

- Approval requirements can be skipped, requested, or forbidden depending on approval mode, sandbox
  policy, and explicit sandbox permissions.
- Approved decisions can be cached for the session.
- Escalated execution can bypass the sandbox under approved conditions.
- Managed network behavior depends on the sandbox permission path.

BHA implication:

- BHA cannot assume every risky operation will prompt every time.
- Session-level approval caching means BHA needs its own deterministic gate for push, release,
  deploy, provider calls, private key access, and other high-risk actions.
- BHA should record whether a gate decision was made by policy, by human approval, or by signed
  capability.

Stability:

- `implementation_observation`

Follow-up:

- BHA should define how to treat runs that start with already-granted session approvals.

### 14.4 Hooks Runtime

Question:

- Are hooks a complete enforcement layer?

Files inspected:

- `codex-rs/core/src/hook_runtime.rs`
- `codex-rs/core/src/tools/handlers/shell/shell_command.rs`
- `codex-rs/core/src/mcp_tool_call.rs`

Observed behavior:

- Hook events include session start, pre-tool use, permission request, post-tool use, pre-compact,
  post-compact, user prompt submit, and stop.
- Pre-tool hooks can continue with updated input or block a tool call.
- Permission request hooks can allow or deny some approval requests.
- Hook output can become model-visible context.
- Shell hooks expose a command-oriented payload.
- MCP permission request hooks can inspect MCP tool input during approval flow.

BHA implication:

- Hooks are valuable workflow and early-blocking surfaces.
- Hooks should load BHA context, detect obvious hazards, and improve evidence collection.
- Hooks should not be the only enforcement path because coverage depends on tool support, event type,
  and current runtime path.
- BHA verifier and capability checks must remain independent of hook success.

Stability:

- `public_contract` for hook event concepts, `implementation_observation` for exact payload and
  blocking behavior.

Follow-up:

- BHA hook templates should fail closed only for narrow high-risk checks where false positives are
  acceptable.

### 14.5 AGENTS.md Loader

Question:

- Is AGENTS.md a hard policy layer or model-visible guidance?

Files inspected:

- `codex-rs/core/src/agents_md.rs`

Observed behavior:

- Codex finds the project root by walking upward to project root markers, with `.git` as the default
  marker.
- Global guidance prefers `AGENTS.override.md`, then `AGENTS.md`.
- Project guidance is collected from project root down to the current working directory.
- In each directory, Codex chooses at most one applicable guidance file.
- Combined project guidance is capped by a configured byte budget.

BHA implication:

- AGENTS.md is source-confirmed as an instruction delivery layer, not a deterministic enforcement
  layer.
- BHA AGENTS guidance should be concise, stable, and non-secret.
- BHA must not put volatile task state, raw command output, secrets, or verifier evidence only in
  AGENTS.md.

Stability:

- `public_contract` for AGENTS.md concept, `implementation_observation` for exact discovery and
  truncation behavior.

Follow-up:

- BHA should keep a short AGENTS template separate from runtime checkpoint files.

### 14.6 Compaction and Resume Risk

Question:

- Can BHA trust compacted or resumed conversation context as project truth?

Files inspected:

- `codex-rs/core/src/compact.rs`

Observed behavior:

- Compaction rewrites earlier conversation history into a summary message.
- Long user messages are bounded before compaction.
- Pre-compact and post-compact hooks can participate in the process.
- Codex warns that long threads and repeated compactions can reduce model accuracy.
- History may be shortened when context limits require it.

BHA implication:

- Compaction is a continuation aid, not an audit source.
- BHA must resume from repository files, ledger, state, checkpoints, and current git reality.
- BHA should require a reality check after resume or compaction before continuing risky work.

Stability:

- `implementation_observation`

Follow-up:

- BHA checkpoint format should explicitly list facts that must be revalidated after resume.

### 14.7 Subagents

Question:

- What should BHA assume about Codex subagent isolation?

Files inspected:

- `codex-rs/core/src/tools/handlers/multi_agents/spawn.rs`

Observed behavior:

- Subagents are spawned through a dedicated tool path.
- Spawn requests can include role, model, reasoning effort, service tier, context items, and
  `fork_context`.
- Spawn depth is limited.
- Full-context forks reject some overrides.
- Child agents inherit substantial parent runtime and environment selections.

BHA implication:

- Subagents are coordination units, not automatic isolation boundaries.
- BHA should assign explicit ownership, write scopes, and validation responsibility before using
  parallel agents.
- BHA should model each subagent as a separate actor in checkpoints or ledger entries.

Stability:

- `implementation_observation`

Follow-up:

- BHA should later inspect how subagent results and file edits are merged back into parent work.

### 14.8 MCP and Connector Tool Calls

Question:

- How are non-shell external tool calls approved and executed?

Files inspected:

- `codex-rs/core/src/mcp_tool_call.rs`

Observed behavior:

- MCP calls parse JSON arguments, build an invocation object, look up tool metadata, and determine an
  approval mode.
- For Codex Apps connectors, app tool policy can disable a tool before execution.
- Approval can be skipped when policy and permission profile auto-approve the request.
- Tool annotations affect approval: destructive tools require approval, read-only tools can avoid
  approval, and unknown destructive or open-world hints default conservatively.
- Permission request hooks can allow or deny MCP approval requests.
- Approved MCP calls are executed through the session MCP connection manager.
- MCP request metadata may include sandbox state when the server supports it.
- Large MCP results are truncated for event storage.

BHA implication:

- BHA must treat non-shell tools as first-class side-effect paths.
- A policy that only watches shell commands is incomplete.
- BHA should classify MCP and connector tools by read/write, local/remote, destructive, open-world,
  and provider-call risk.
- BHA should not assume read-only from a tool name alone; metadata and BHA policy must agree.

Stability:

- `implementation_observation`

Follow-up:

- BHA should define a tool-risk registry for shell, MCP, browser, GitHub, memory, provider, and file
  edit tools.

### 14.9 Source-Validated Boundary Summary

The first source pass supports the current BHA direction:

- Codex already has meaningful native control surfaces.
- Those surfaces are configurable, partial, and runtime-dependent.
- Shell command policy is not enough because MCP and connector tools have their own side-effect
  paths.
- AGENTS.md and hooks are useful guidance and guardrail layers, not sufficient proof.
- Compaction and resume require repository-local checkpoints.
- Subagents require explicit ownership and actor tracking.
- BHA should remain a project-local policy, evidence, verifier, checkpoint, and capability layer
  around Codex rather than trying to replace Codex itself.

The design implication is clear: BHA should reuse Codex controls for early blocking and workflow
alignment, then independently verify high-risk claims with local state, ledger evidence, and
capability gates.

## 15. Codex Findings to BHA Requirements

This section converts the Codex grounding work into concrete BHA design requirements. It is the
handoff from research to architecture.

### 15.1 Requirement Mapping

| Codex finding | Boundary | BHA requirement | Required component |
| --- | --- | --- | --- |
| Local Codex install is mostly launcher plus binaries | Local runtime files are not a stable or safe source of truth | Use public docs/source for design evidence and avoid private `.codex` runtime data | source evidence policy |
| Shell rules and exec policy are command-oriented | Complex shell syntax and non-shell tools can escape simple prefix reasoning | Classify risk at the action level, not only by command prefix | tool risk registry |
| Approval prompts can be skipped or cached | A prior approval may reduce future prompts inside the same session | Critical actions need BHA-owned gates independent of Codex prompts | capability gate |
| Sandbox bypass can be explicitly approved | Sandbox state alone does not prove safety | Record why a high-risk action was allowed and by which authority | ledger and closeout |
| Hooks can block or modify supported tool calls | Hook coverage depends on tool support and runtime path | Use hooks for early warning, but keep verifier independent | Codex integration adapter |
| AGENTS.md is model-visible guidance | It can be stale, overridden, truncated, or misunderstood | Keep AGENTS concise and move hard checks into BHA runtime | policy and verifier |
| Compaction rewrites history into summaries | Conversation memory is not auditable truth | Resume from repository state, checkpoint, ledger, and validation evidence | checkpoint model |
| Subagents inherit substantial context | Subagents are not automatic isolation boundaries | Assign actor identity, write ownership, and validation responsibility | actor and role model |
| MCP and connector calls have separate approval paths | Shell-only policy misses external side effects | Classify MCP, browser, GitHub, memory, provider, and connector tools explicitly | tool risk registry |
| Unattended runs cannot rely on real-time human judgment | Prompts may be unavailable or inappropriate | Default unattended posture must fail closed with machine-readable reason codes | automation posture |

### 15.2 Core Objects Implied by Codex Analysis

BHA core should now define these objects before adding more runtime behavior:

- `Policy`: allowed paths, denied paths, action classes, authority rules, and stop conditions.
- `Run`: one bounded execution attempt with run id, actor, workspace, branch, and mode.
- `Actor`: human, Codex main agent, subagent, automation, hook, or verifier.
- `ToolRisk`: classification for shell, file edit, MCP, browser, GitHub, memory, provider, and other
  tool families.
- `Ledger`: append-only evidence chain for material actions and gate decisions.
- `State`: current resumable project-local view derived from ledger and repository reality.
- `Checkpoint`: compact handoff record that can be revalidated after interruption or compaction.
- `Capability`: signed, scoped, one-use authorization for high-risk actions.
- `Verifier`: deterministic checker for ledger integrity, state consistency, validation freshness,
  and capability rules.
- `Adapter`: integration layer for Codex CLI, Codex App, hooks, rules, worktrees, and automation.

### 15.3 Design Decisions Now Supported

The Codex analysis supports these BHA design decisions:

1. BHA should not replace Codex execution.
2. BHA should not rely on prompts, AGENTS.md, hooks, rules, or compaction as proof.
3. BHA should treat every tool family as a possible side-effect path.
4. BHA should separate guidance from enforcement.
5. BHA should require repository-local evidence for validation claims.
6. BHA should model multi-agent work explicitly instead of assuming coordination from conversation
   context.
7. BHA should treat unattended mode as a stricter posture than interactive mode.
8. BHA should use signed capabilities only for narrow high-risk actions, not as a general permission
   bypass.

### 15.4 BHA Non-Goals

BHA should be explicit about what it is not trying to become.

Non-goals:

- BHA does not replace Codex reasoning, planning, or code generation.
- BHA does not become a general-purpose task scheduler.
- BHA does not host, request, read, print, or store private signing keys.
- BHA does not bypass Codex sandboxing, approvals, rules, or hooks.
- BHA does not treat Codex prompts, AGENTS.md, hooks, or approvals as proof.
- BHA does not prove all external-world facts. It proves repository-local evidence and policy
  consistency.
- BHA does not make remote actions safe by default. Remote actions remain separately gated.
- BHA does not guarantee perfect autonomy. It gives Codex clearer boundaries, better evidence, and
  stronger stop conditions.
- BHA does not make every action auditable at the operating-system level. It records the BHA-relevant
  action contract and verifier evidence.
- BHA does not hide uncertainty. It should surface unknowns as blocked, partial, or unvalidated
  states.

These non-goals keep the system small enough to build and honest enough to trust.

### 15.5 Architecture Questions Closed by Later Sections

The questions below were used to drive the core architecture pass. They should no longer be treated
as unbounded open research questions. They are closed enough for v1 design, with deeper versions
deferred until implementation or multi-agent expansion requires them.

| Original question | Answer location | V1 status |
| --- | --- | --- |
| What is the minimal BHA core object model? | Sections 16 and 17 | closed for v1 |
| What events must be written to the ledger? | Sections 16.6, 17.8, 18.2, 20.5 | closed for v1 |
| What state can be derived, and what state must be stored? | Sections 16.7, 17.9, 20.8 | closed for v1 |
| What actions require capability versus human confirmation versus normal policy allow? | Sections 19.5 through 19.9 | closed for v1 |
| What is the exact tool risk taxonomy? | Sections 16.5, 17.6, 17.7, 19.5 | closed enough for v1 |
| How should actors and roles be represented for single-window CLI work? | Sections 16.4 and 17.5 | closed for v1 |
| How should the same model extend to subagents and worktrees? | Sections 8, 9, 16.4, 21.1 | deferred beyond v1 |
| What must `verify` prove before any high-risk action? | Sections 16.10, 17.12, 20.8 | closed for v1 |

Any new Codex source exploration should now be tied to one of these design areas or to a concrete
implementation ambiguity.

## 16. BHA Core Architecture

BHA core is the project-local layer that turns Codex activity into bounded, resumable, and verifiable
progress. It should stay small: policy, evidence, state, gates, and verification.

### 16.1 Core Principles

1. Repository reality outranks conversation memory.
2. Guidance and enforcement are separate.
3. Tool actions are the unit of risk.
4. High-risk actions require explicit authority.
5. Every material claim should have evidence.
6. State should be derivable where possible and stored only when useful.
7. Resume must work without trusting the previous conversation.
8. Interactive and unattended runs need different safety postures.
9. Multi-agent work needs explicit actor identity and write ownership.
10. Verification must be deterministic and explain failures with reason codes.

### 16.2 Core Object Model

The minimal core object model is:

- `Policy`: the repository-local rulebook.
- `Run`: one bounded execution attempt.
- `Actor`: the entity performing or authorizing work.
- `ToolAction`: a normalized description of an intended or observed action.
- `ToolRisk`: the risk classification attached to a tool action.
- `LedgerEvent`: append-only evidence of material facts.
- `StateSnapshot`: current resumable state derived from repository reality and ledger events.
- `Checkpoint`: human-readable and machine-checkable handoff state.
- `Capability`: scoped authorization for a high-risk action.
- `VerifierResult`: deterministic pass, fail, or blocked outcome.
- `Adapter`: bridge between BHA core and Codex surfaces.

These objects should be stable before runtime behavior grows. Commands should be thin wrappers around
these objects, not separate sources of truth.

### 16.3 Policy Model

`Policy` defines what BHA considers allowed, denied, gated, or review-required.

Policy should include:

- allowed paths
- denied paths
- protected paths
- action classes
- tool risk rules
- actor permissions
- required validation by action class
- capability-required actions
- human-confirmation-required actions
- unattended-mode restrictions
- stop conditions
- trusted public signing keys

Policy should not include:

- private keys
- raw secrets
- temporary task state
- raw command output
- conversation summaries

Policy is the source of intent. The verifier decides whether recorded evidence satisfies that
intent.

### 16.4 Run and Actor Model

`Run` represents one bounded attempt to move the project forward.

A run should record:

- `run_id`
- workspace path
- repository root
- branch or detached HEAD
- head commit when relevant
- mode: interactive, unattended, hook, validation, or closeout
- actor id
- parent run id when spawned or resumed
- start time and optional expiry
- policy version or policy hash
- ledger head at start

`Actor` should distinguish:

- human
- Codex main agent
- Codex subagent
- automation
- hook
- verifier
- external signer

The actor model matters because the same action has different risk depending on who initiated it,
whether a human was present, and whether the run was interactive.

### 16.5 Tool Action and Risk Model

BHA should normalize tool activity into semantic action classes before deciding risk.

Initial action classes:

- `read_repo`
- `read_private_runtime`
- `write_repo`
- `write_protected_path`
- `execute_local`
- `network_read`
- `network_write`
- `remote_write`
- `provider_call`
- `memory_write`
- `package_install`
- `dependency_change`
- `secret_access`
- `private_key_access`
- `git_commit`
- `git_push`
- `tag`
- `release`
- `deploy`
- `destructive_fs`

Initial risk levels:

- `low`: safe local read or documentation-only change
- `medium`: reversible local repo write with validation
- `high`: shared runtime, policy, capability, external, or multi-agent effect
- `critical`: private key, secret, destructive, production, deploy, release, tag, push, or remote
  write

Risk classification should combine:

- tool family
- action class
- path
- network behavior
- actor
- mode
- branch and HEAD
- policy rules
- user instruction
- current repository state

This prevents BHA from treating `git push`, GitHub connector writes, MCP writes, and provider calls
as unrelated safety problems.

### 16.6 Ledger Model

`Ledger` is BHA's append-only evidence chain. It should record material events, not every tiny
observation.

Ledger events should cover:

- run start and run closeout
- policy load or policy hash
- checkpoint creation
- validation command result
- verifier result
- capability issue
- capability consume
- high-risk action decision
- blocked action
- denied action
- resume reality check
- actor handoff

Each event should include:

- event id
- timestamp
- run id
- actor id
- event type
- subject
- normalized payload
- previous ledger hash
- event hash

The ledger should avoid secrets, private key material, raw env values, and oversized raw command
output. It should record enough evidence for another session to verify the claim.

### 16.7 State Model

`StateSnapshot` is the current operational view. It should be derived from ledger and repository
reality where practical.

State should include:

- current run id
- current phase
- last checkpoint id
- last validation status
- last verifier status
- current ledger head hash
- active capability ids
- consumed capability ids
- known blockers
- current safety posture
- current workspace identity

State must not become an unchecked alternative truth. On resume, BHA should revalidate state against:

- git branch
- HEAD
- worktree status
- policy
- ledger hash chain
- capability records
- validation freshness

### 16.8 Checkpoint Model

`Checkpoint` is the handoff object for humans, future Codex sessions, and subagents.

A checkpoint should include:

- original goal
- current phase
- completed work
- changed files
- validation run
- validation not run
- ledger head
- verifier status
- active blockers
- risks
- next safe action
- stop conditions

Checkpoint should be compact, readable, and revalidatable. It should not carry private key material,
secrets, raw environment values, or stale claims that cannot be checked.

### 16.9 Capability Lifecycle

`Capability` is a narrow authorization for a high-risk action. It should not be a general bypass.

Lifecycle:

1. `make-payload`: produce unsigned canonical payload from current repository reality.
2. `sign-offline`: human signs outside the repository.
3. `verify-signed`: BHA verifies signature and payload shape without writing.
4. `issue`: BHA records valid capability in the action's configured evidence store.
5. `consume`: BHA marks one-use capability consumed for exact action context in that store.
6. `execute`: adapter may proceed only if the action still matches consumed capability.
7. `closeout`: verifier records final tracked state; local-only capability state is reported as local gate evidence.

Capability payload must bind:

- capability id
- run id
- action type
- command or semantic action
- branch
- HEAD
- ledger head
- expiry
- one-use flag
- signing key id
- denied actions that remain denied

Expired, replayed, mismatched, malformed, or unsigned capabilities must fail closed.

### 16.10 Verifier Contract

`Verifier` is the hard boundary for BHA truth claims.

Verifier should prove:

- policy is parseable
- trusted public keys are valid public keys
- ledger hash chain is intact
- state references the current ledger head
- consumed capabilities were issued and not replayed
- active capabilities are not expired
- validation evidence is fresh enough for the claimed phase
- denied actions are not recorded as allowed
- closeout matches current repository reality

Verifier should return:

- `PASS`
- `FAIL`
- `BLOCKED`

Every non-pass result should include stable reason codes and enough context for a human or automation
wrapper to decide the next safe action.

### 16.11 Adapter Boundary

Adapters connect BHA core to Codex surfaces.

Initial adapters:

- CLI adapter
- Codex hooks adapter
- Codex rules template adapter
- Codex App/worktree adapter
- automation adapter

Adapter rules:

- adapters may collect facts and call core decisions
- adapters must not create independent policy semantics
- adapters must not weaken verifier results
- adapters should be replaceable without changing core object meanings
- adapters should fail closed for critical actions when core verification is unavailable

This lets BHA support CLI first while keeping the design compatible with Codex App, subagents,
worktrees, and unattended automation.

### 16.12 Runtime Phases

BHA runtime should move through explicit phases:

1. `inspect`: identify workspace, branch, worktree state, policy, and relevant files.
2. `classify`: classify goal, action risk, actor, and mode.
3. `plan`: choose bounded next actions and stop conditions.
4. `act`: perform allowed local work.
5. `validate`: run relevant validation.
6. `verify`: check policy, ledger, state, and capability consistency.
7. `checkpoint`: write or update handoff state when useful.
8. `gate`: require human confirmation or signed capability for high-risk action.
9. `closeout`: summarize changed files, validation, risks, and next action.

Phase transitions should be explicit enough that another session can resume without trusting the
previous conversation.

### 16.13 Failure and Stop States

BHA should prefer clear stop states over ambiguous continuation.

Stop states:

- `blocked_user_approval_required`
- `blocked_capability_required`
- `blocked_policy_denied`
- `blocked_verifier_failed`
- `blocked_validation_failed`
- `blocked_dirty_worktree_unclear`
- `blocked_secret_or_private_key_risk`
- `blocked_network_required`
- `blocked_remote_action_required`
- `blocked_unattended_not_allowed`
- `partial_unvalidated`
- `failed_runtime_error`

Stop states should be machine-readable and human-readable. They are not failures of autonomy; they
are how autonomy stays bounded.

### 16.14 Minimal V1 Scope

Minimal BHA v1 is the local runtime kernel, not a broad governance platform.

The v1 kernel name is:

```text
BHA v1 Kernel: Local Evidence + Push Gate
```

The v1 goal is deliberately narrow:

```text
A single local Codex session can produce a verifiable repository state,
and cannot pass the BHA prepush gate without a valid signed consumed git_push capability.
```

In scope:

- canonical policy file
- mission / task contract file
- policy hash and mission hash
- ledger hash chain
- state consistency
- validation evidence
- read-only verifier
- generated closeout evidence
- canonical git_push capability payload generation
- signed git_push capability verification
- one-use git_push capability issue and consume
- read-only fail-closed prepush check
- unverified worktree change detection

Out of scope for v1:

- Codex App adapter
- Codex rules and hooks templates beyond the small Git pre-push hook
- full multi-worktree ledger merge
- full subagent scheduler
- provider-call governance
- memory-write governance
- private key custody
- deploy, release, or tag capability
- production deployment control plane
- generic CI platform
- proof of all external side effects

V1 capability authority is:

```text
capability_possible_v1:
- git_push

always_denied_v1:
- provider_call
- memory_write
- private_key_access
- secret_access
- deploy
- release
- tag
- force_push
- destructive_fs
- production_write
- package_publish
```

BHA v1 is tamper-evident, not tamper-proof. A local user or agent with filesystem write access can
edit files directly. The verifier detects stale, mismatched, or unverified state; it does not
physically prevent filesystem tampering.

Unrecorded or unverifiable direct changes are treated as `UNVERIFIED_WORKTREE_CHANGE`. Such state
cannot produce trusted closeout and cannot pass `prepush-check`.

## 17. BHA Core Data Schemas

This section defines the first version of BHA's core data shapes. The goal is not to freeze final
JSON Schema syntax yet. The goal is to make every core object concrete enough that runtime commands,
verifier rules, and adapters can be designed against the same model.

### 17.1 Schema Principles

BHA schemas should follow these principles:

1. Be explicit about identity.
2. Be explicit about authority.
3. Be explicit about current repository reality.
4. Separate durable facts from derived views.
5. Keep secrets and private keys out of every schema.
6. Prefer stable enums and reason codes over free-form prose for verifier decisions.
7. Make every high-risk action bind to branch, HEAD, ledger head, actor, and policy.
8. Allow human-readable summaries without making summaries authoritative.
9. Keep v1 fields small enough to implement and verify.
10. Add optional fields only when they support resume, audit, or validation.

### 17.2 Shared Field Conventions

Common field conventions:

- `schema`: stable schema id, such as `bha.policy.v1`.
- `id`: object-local id.
- `run_id`: bounded execution id.
- `actor_id`: actor identity responsible for the event or decision.
- `created_at`: UTC timestamp in ISO 8601 format.
- `updated_at`: UTC timestamp in ISO 8601 format when mutable state changes.
- `repo_root`: normalized repository root path when local context matters.
- `branch`: current branch name when available.
- `head`: full Git HEAD SHA when available.
- `ledger_head_hash`: current ledger hash when the object binds to evidence state.
- `policy_hash`: hash of the policy content used for the decision.
- `status`: stable machine-readable status.
- `reason_code`: stable machine-readable reason.
- `summary`: short human-readable explanation.

Hash fields should be raw lowercase hex unless a specific schema says otherwise. Private key
material, raw secrets, tokens, passwords, and raw environment values are never valid fields.

### 17.3 Policy Schema

`Policy` is the repository-local rulebook.

V1 must use one canonical layout. Do not support both top-level `allowed_paths` and nested
`paths.allowed` forms.

Canonical shape:

```json
{
  "schema": "bha.policy.v1",
  "metadata": {
    "policy_id": "...",
    "version": "...",
    "created_at": "...",
    "mode": "dry-run"
  },
  "paths": {
    "allowed": [],
    "denied": [],
    "protected": []
  },
  "actors": {},
  "trusted_public_keys": [],
  "action_rules": {},
  "validation_rules": {},
  "capability_rules": {
    "capability_possible_v1": ["git_push"],
    "always_denied_v1": []
  },
  "unattended_rules": {},
  "stop_conditions": []
}
```

Required fields:

- `schema`
- `metadata`
- `paths`
- `actors`
- `trusted_public_keys`
- `action_rules`
- `validation_rules`
- `capability_rules`
- `unattended_rules`
- `stop_conditions`

Important field meanings:

- `paths.protected`: paths BHA treats as sensitive even if the filesystem allows writes.
- `paths.allowed`: paths that may be written for normal local work.
- `paths.denied`: paths that should not be read or written without explicit authority.
- `trusted_public_keys`: public signing keys and key ids; never private keys.
- `action_rules`: mapping from action class to required authority.
- `validation_rules`: validation required before closeout or high-risk gates.
- `capability_rules`: capability-possible and always-denied action classes.
- `unattended_rules`: stricter policy for non-interactive runs.
- `stop_conditions`: conditions that force blocked status.

V1 policy should be easy to inspect by humans and easy for the verifier to parse.

### 17.3.1 Mission / TaskContract Schema

`Mission` is the per-task contract. It is separate from long-lived policy and from runtime state.

Required fields:

- `schema`
- `version`
- `mission_id`
- `run_id`
- `objective`
- `allowed_paths`
- `denied_paths`
- `allowed_action_classes`
- `denied_action_classes`
- `required_validation`
- `success_criteria`
- `hard_stop_conditions`
- `created_by_actor_id`
- `mission_hash`

Canonical shape:

```json
{
  "schema": "bha.mission.v1",
  "mission_id": "...",
  "run_id": "...",
  "objective": "...",
  "allowed_paths": [],
  "denied_paths": [],
  "allowed_action_classes": [],
  "denied_action_classes": [],
  "required_validation": [],
  "success_criteria": [],
  "hard_stop_conditions": [],
  "created_by_actor_id": "...",
  "mission_hash": "..."
}
```

`mission_hash` is computed from the canonical mission object with the `mission_hash` field excluded.

The following evidence must bind `mission_hash`:

- `Run`
- `LedgerEvent`
- `Capability`
- `ValidationEvidence`
- `VerifierResult`
- `Checkpoint`
- `Closeout`

This prevents long-lived policy permission from being mistaken for authorization inside the current
task scope.

### 17.4 Run Schema

`Run` describes one bounded BHA execution attempt.

Required fields:

- `schema`
- `run_id`
- `parent_run_id`
- `mode`
- `actor_id`
- `repo_root`
- `workspace_id`
- `branch`
- `head`
- `started_at`
- `ended_at`
- `policy_hash`
- `ledger_head_start`
- `ledger_head_end`
- `status`

Allowed `mode` values:

- `interactive`
- `unattended`
- `hook`
- `validation`
- `verification`
- `closeout`
- `automation`

Allowed `status` values:

- `running`
- `completed`
- `completed_unvalidated`
- `blocked`
- `failed`
- `aborted`

A run should be cheap to create and clear to close. Long work can have multiple runs connected by
parent run ids and checkpoints.

### 17.5 Actor Schema

`Actor` identifies who or what performed, requested, reviewed, or authorized an action.

Required fields:

- `schema`
- `actor_id`
- `actor_type`
- `display_name`
- `authority_level`
- `created_at`

Allowed `actor_type` values:

- `human`
- `codex_main`
- `codex_subagent`
- `automation`
- `hook`
- `verifier`
- `external_signer`
- `system`

Allowed `authority_level` values:

- `observe`
- `local_write`
- `validate`
- `gate`
- `sign`
- `admin`

Actor identity should be stable enough for ledger events and checkpoints. It does not need to expose
personal secrets or external account tokens.

### 17.6 ToolAction Schema

`ToolAction` normalizes an intended or observed effect.

Required fields:

- `schema`
- `action_id`
- `run_id`
- `actor_id`
- `tool_family`
- `action_class`
- `target`
- `command`
- `paths`
- `remote`
- `network`
- `mode`
- `branch`
- `head`

Allowed `tool_family` values:

- `shell`
- `file_edit`
- `apply_patch`
- `mcp`
- `browser`
- `github`
- `memory`
- `provider`
- `image`
- `document`
- `spreadsheet`
- `presentation`
- `unknown`

`command` may be null for non-command tools. `target` should carry the semantic target, such as a
file path, remote name, branch, provider action, connector name, or external object.

`ToolAction` should not contain final risk or decision fields. Risk belongs in `ToolRisk`; allow,
deny, block, or gate decisions belong in `DecisionRecord`.

### 17.7 ToolRisk Schema

`ToolRisk` explains why a tool action is low, medium, high, or critical risk.

Required fields:

- `schema`
- `risk_id`
- `action_id`
- `risk_level`
- `action_class`
- `risk_factors`
- `required_authority`
- `allowed_by_policy`
- `requires_capability`
- `requires_human_confirmation`
- `reason_code`

Allowed `risk_level` values:

- `low`
- `medium`
- `high`
- `critical`

Common `risk_factors`:

- `protected_path`
- `denied_path`
- `network`
- `remote_write`
- `provider_call`
- `memory_write`
- `private_key`
- `secret`
- `package_install`
- `dependency_change`
- `git_history`
- `release`
- `deploy`
- `unattended`
- `dirty_worktree`
- `unknown_tool`

Risk classification should be deterministic where possible. When classification is uncertain, BHA
should choose the higher safe risk level.

### 17.8 LedgerEvent Schema

`LedgerEvent` is append-only evidence.

Required fields:

- `schema`
- `event_id`
- `event_type`
- `created_at`
- `run_id`
- `actor_id`
- `subject`
- `payload`
- `prev_hash`
- `event_hash`

Important event types:

- `run_started`
- `run_closed`
- `policy_loaded`
- `checkpoint_written`
- `validation_completed`
- `verification_completed`
- `capability_payload_created`
- `capability_verified`
- `capability_issued`
- `capability_consumed`
- `action_allowed`
- `action_blocked`
- `action_denied`
- `resume_checked`
- `closeout_completed`

Ledger payloads should be normalized JSON. They should avoid raw secrets, private key material, raw
environment values, and oversized command output.

### 17.9 StateSnapshot Schema

`StateSnapshot` is the current operational view.

Required fields:

- `schema`
- `state_id`
- `updated_at`
- `current_run_id`
- `phase`
- `repo_root`
- `workspace_id`
- `branch`
- `head`
- `policy_hash`
- `ledger_head_hash`
- `last_checkpoint_id`
- `last_validation`
- `last_verifier`
- `active_capabilities`
- `consumed_capabilities`
- `blockers`
- `safety_posture`

Allowed `phase` values:

- `idle`
- `inspect`
- `classify`
- `plan`
- `act`
- `validate`
- `verify`
- `checkpoint`
- `gate`
- `closeout`
- `blocked`

State is mutable, but it must remain verifiable against repository reality and the ledger.

### 17.10 Checkpoint Schema

`Checkpoint` is the resumable handoff record.

Required fields:

- `schema`
- `checkpoint_id`
- `created_at`
- `run_id`
- `actor_id`
- `goal`
- `phase`
- `workspace`
- `branch`
- `head`
- `ledger_head_hash`
- `policy_hash`
- `completed`
- `changed_files`
- `validation_run`
- `validation_not_run`
- `verifier_status`
- `blockers`
- `risks`
- `next_safe_action`
- `stop_conditions`

Checkpoint text may be readable prose, but key fields should remain structured. A resumed session
should verify checkpoint facts before acting.

### 17.11 Capability Schema

`Capability` is a signed, scoped, one-use authority object for high-risk actions.

Unsigned payload fields:

- `schema`
- `capability_id`
- `run_id`
- `type`
- `action_class`
- `command`
- `remote`
- `branch`
- `head`
- `ledger_head_hash`
- `policy_hash`
- `one_use`
- `expires_at`
- `signing_key_id`
- `algorithm`
- `signature_encoding`
- `payload_hash_format`
- `denied_actions_remain_denied`

Fields added after offline signing:

- `payload_hash`
- `signature`

Issue record fields:

- `capability_id`
- `issued_at`
- `issued_by_actor_id`
- `verified_by`
- `payload_hash`
- `ledger_head_hash`

Consume record fields:

- `capability_id`
- `consumed_at`
- `consumed_by_actor_id`
- `run_id`
- `action_class`
- `branch`
- `head`
- `ledger_head_hash`
- `status`

Capability schema should stay canonical. Field aliases such as `head_sha` should be rejected for the
runtime issue path unless a migration explicitly supports them.

### 17.12 VerifierResult Schema

`VerifierResult` records what the verifier checked and decided.

Required fields:

- `schema`
- `verifier_id`
- `created_at`
- `run_id`
- `status`
- `reason_code`
- `reasons`
- `checks`
- `evidence`
- `ledger_head_hash`
- `policy_hash`
- `head`
- `summary`

Allowed `status` values:

- `PASS`
- `FAIL`
- `BLOCKED`

Common `checks` entries:

- `policy_parse`
- `trusted_public_keys`
- `ledger_hash_chain`
- `state_consistency`
- `capability_integrity`
- `validation_freshness`
- `denied_actions`
- `repository_reality`
- `closeout_consistency`

`VerifierResult` should be suitable for both humans and automation wrappers. It should not depend on
conversation context.

### 17.13 Closeout Schema

`Closeout` is the final human and machine-readable report for a run.

Required fields:

- `schema`
- `closeout_id`
- `created_at`
- `run_id`
- `status`
- `changed_files`
- `validation`
- `verifier`
- `capabilities`
- `blockers`
- `risks`
- `not_validated`
- `next`

Closeout should not claim more than was verified. If validation was not run, the closeout must say so
explicitly.

### 17.14 V1 Schema Cut

The first implementation should prioritize these schemas:

1. `Policy`
2. `LedgerEvent`
3. `StateSnapshot`
4. `Capability`
5. `VerifierResult`
6. `Closeout`

`Run`, `Actor`, `ToolAction`, `ToolRisk`, and `Checkpoint` can start as embedded structures if that
keeps v1 smaller. They should still follow the field names above so they can become standalone
objects later without migration pain.

`DecisionRecord` can also start embedded in ledger events or action records for v1. Even when
embedded, it should use the field names from Section 18.4 so it can become a standalone object later
without changing semantics.

## 18. Schema Canonicalization and Decision Records

This section resolves the implementation-sensitive parts of the schema design. BHA should not allow
each command to invent its own hashing, signing, or decision format.

### 18.1 Canonical JSON Rule

BHA should use one canonical JSON rule for hashes, signatures, ledger events, and verifier evidence.

Canonical JSON rules:

- UTF-8 encoding
- no byte order mark
- object keys sorted lexicographically
- arrays preserve order
- no insignificant whitespace
- strings use JSON escaping rules
- numbers should be avoided in signed or hashed payloads unless representation is strictly defined
- timestamps are UTC ISO 8601 strings
- hashes are raw lowercase hex
- absent optional fields and explicit `null` are not interchangeable unless the schema says so

For v1, BHA should prefer strings, booleans, arrays, and objects over numeric values in canonical
payloads. If numeric fields become necessary, the schema must define exact representation before
they are hashed or signed.

### 18.2 Ledger Hash Rule

Ledger hash integrity depends on every implementation hashing the same bytes.

Ledger event hash input should be:

- the canonical JSON serialization of the ledger event
- excluding `event_hash`
- including `prev_hash`
- including `schema`, `event_id`, `event_type`, `created_at`, `run_id`, `actor_id`, `subject`, and
  `payload`

Ledger order should be file order for JSONL ledgers. Each line should contain exactly one canonical
ledger event object. The verifier should not reorder events by timestamp.

Ledger event hash output should be:

- SHA-256
- raw lowercase hex

The first ledger event should use a fixed genesis `prev_hash` value:

- `0000000000000000000000000000000000000000000000000000000000000000`

Ledger verification should fail if:

- a required field is missing
- canonical serialization differs from the stored hash
- `prev_hash` does not match the previous event hash
- event order is ambiguous
- duplicate `event_id` values exist
- an event contains forbidden private key or secret material

### 18.3 Capability Hash and Signature Rule

Capability signing must use the same canonical payload shape every time.

Capability payload hash input should be:

- the canonical JSON serialization of the flat capability object
- excluding `payload_hash`
- excluding `signature`
- excluding any envelope fields

Capability payload hash output should be:

- SHA-256
- raw lowercase hex
- no `sha256:` prefix

Capability signature input should be:

- the same canonical JSON bytes used to compute `payload_hash`

Capability signature fields should include:

- `payload_hash`
- `signature`
- `algorithm`
- `signature_encoding`
- `payload_hash_format`

For v1, `algorithm`, `signature_encoding`, and `payload_hash_format` are not envelope fields. They
are top-level canonical object fields and are included in the hash and signature input. Only
`payload_hash` and `signature` are removed before hashing and signing.

Required values for v1:

- `algorithm`: `ed25519`
- `signature_encoding`: `base64`
- `payload_hash_format`: `raw_lowercase_hex_sha256`

Unsupported forms should fail with explicit reason codes:

- nested payload/signature envelope: `CAPABILITY_ENVELOPE_UNSUPPORTED_EXPECT_FLAT`
- `head_sha` instead of `head`: `CAPABILITY_FIELD_HEAD_REQUIRED_NOT_HEAD_SHA`
- `sha256:<hex>` hash prefix: `CAPABILITY_PAYLOAD_HASH_FORMAT_INVALID_EXPECT_RAW_HEX`
- missing algorithm: `CAPABILITY_SIGNATURE_ALGORITHM_REQUIRED`
- unsupported algorithm: `CAPABILITY_SIGNATURE_ALGORITHM_UNSUPPORTED`

### 18.4 Decision Record Schema

BHA should separate action description, risk analysis, and decision.

`ToolAction` answers:

- what is being attempted or observed?

`ToolRisk` answers:

- why is this risky?

`DecisionRecord` answers:

- what did BHA decide, under which authority, and with what evidence?

Required `DecisionRecord` fields:

- `schema`
- `decision_id`
- `created_at`
- `run_id`
- `actor_id`
- `action_id`
- `risk_id`
- `decision`
- `authority`
- `reason_code`
- `reasons`
- `evidence`
- `policy_hash`
- `ledger_head_hash`
- `expires_at`

Allowed `decision` values:

- `allow`
- `deny`
- `block`
- `require_human_confirmation`
- `require_capability`
- `allow_after_capability`
- `allow_after_validation`

Allowed `authority` values:

- `policy`
- `human`
- `signed_capability`
- `verifier`
- `hook`
- `runtime`

`ToolAction` should not carry final decision fields. For v1, a ledger payload may record
`ToolAction`, `ToolRisk`, and `DecisionRecord` together, but they should remain separate structured
objects with separate meanings.

### 18.5 Verifier Multi-Reason Output

Verifier output should support more than one failure.

`VerifierResult` should include:

- `status`: overall status
- `reason_code`: primary reason
- `reasons`: ordered list of reason records
- `checks`: ordered list of check records
- `evidence`: supporting facts

Reason record fields:

- `reason_code`
- `severity`
- `message`
- `subject`
- `evidence_ref`

Allowed `severity` values:

- `info`
- `warning`
- `error`
- `blocked`

Check record fields:

- `check_id`
- `name`
- `status`
- `reason_code`
- `evidence_ref`

Allowed check `status` values:

- `PASS`
- `FAIL`
- `BLOCKED`
- `SKIPPED`

Overall status rule:

- any `BLOCKED` check makes overall status `BLOCKED`
- otherwise any `FAIL` check makes overall status `FAIL`
- otherwise all required checks passing makes overall status `PASS`
- optional skipped checks may still allow `PASS` only when policy permits them

### 18.6 Optional and Nullable Field Rule

BHA should distinguish missing fields from explicitly unavailable values.

Rules:

- required fields must exist
- fields that are not yet known should use `null` only when the schema permits it
- fields that do not apply should be omitted only when the schema permits omission
- mutable lifecycle fields such as `ended_at` may be `null` while a run is active
- parent fields such as `parent_run_id` may be `null` for root runs

This avoids forcing fake values into schemas while still keeping validation strict.

### 18.7 V1 Implementation Constraint

For v1, BHA should implement canonicalization before expanding automation scope.

Required v1 canonicalization support:

- canonical JSON serializer
- ledger event hash function
- capability payload hash function
- capability signature verification input builder
- decision record reason codes
- verifier multi-reason result shape

Without these rules, BHA may appear to work locally while producing payloads or ledger entries that
cannot be verified consistently by another session.

## 19. Policy Model and Rule Semantics

Policy is the rulebook BHA uses to turn repository facts and tool actions into decisions. This
section defines policy structure and rule precedence before runtime implementation starts.

### 19.1 Policy File Sections

The v1 policy file should be organized into clear sections:

- `metadata`
- `paths`
- `actors`
- `trusted_public_keys`
- `action_rules`
- `validation_rules`
- `capability_rules`
- `unattended_rules`
- `stop_conditions`

Each section should be readable by humans and deterministic for the verifier.

### 19.2 Metadata

`metadata` identifies the policy itself.

Fields:

- `policy_id`
- `version`
- `created_at`
- `updated_at`
- `description`

Policy metadata should not include transient task state. Policy version should change when rule
semantics change, not for every ledger or runtime event.

### 19.3 Path Rule Semantics

Path rules decide whether BHA may read or write a path.

Path sections:

- `paths.allowed`
- `paths.denied`
- `paths.protected`

Semantics:

- `paths.allowed` describes normal write or read/write scope for local work.
- `paths.denied` describes paths BHA should not read or write without explicit authority.
- `paths.protected` describes paths that require extra caution even if technically writable.

Precedence:

1. `paths.denied`
2. `paths.protected`
3. `paths.allowed`

If a path matches both allowed and denied, denied wins. If a path matches protected and allowed, the
action is not automatically allowed; policy must decide whether human confirmation, validation, or a
capability is required.

Default rule:

- unknown write path defaults to blocked
- unknown read path defaults to allowed only if it is inside the repository and not denied or
  protected
- secret-like or private-key-like paths default to denied

### 19.4 Protected Path Defaults

BHA v1 should treat these as protected or denied by default:

Denied by default:

- `.env`
- `.env.*`
- `**/.env`
- `**/.env.*`
- private key files
- credential files
- token dumps

Protected by default:

- `.git/**`
- `.codex/**`
- `.agents/**`
- `.agent_board/**`
- dependency lockfiles
- package manifests
- release configuration
- deployment configuration
- BHA policy, ledger, state, and capability files

Policy may narrow these defaults, but it should not silently weaken them.

### 19.5 Action Rule Semantics

`action_rules` map action classes to required authority.

Action rule fields:

- `action_class`
- `default_decision`
- `required_authority`
- `allowed_modes`
- `denied_modes`
- `required_validation`
- `reason_code`

Allowed `default_decision` values:

- `allow`
- `deny`
- `block`
- `require_validation`
- `require_human_confirmation`
- `require_capability`

Action classes should use the taxonomy from Section 16.5 and Section 17.6. A rule should match a
semantic action, not only a command string.

### 19.6 Rule Precedence

When multiple rules match, BHA should choose the safest result.

Precedence:

1. `deny`
2. `block`
3. `require_capability`
4. `require_human_confirmation`
5. `require_validation`
6. `allow`

This means:

- any deny rule denies the action
- any block rule blocks until conditions change
- capability requirement outranks human confirmation
- human confirmation outranks validation-only
- validation requirement outranks plain allow

Codex approval does not override BHA policy. A signed capability does not override denied actions
that the capability explicitly says remain denied.

### 19.7 Trusted Public Key Schema

`trusted_public_keys` defines public keys BHA may use to verify signed capabilities.

Fields:

- `key_id`
- `algorithm`
- `public_key_pem`
- `purpose`
- `status`
- `created_at`
- `expires_at`
- `supersedes`
- `notes`

Allowed `algorithm` values for v1:

- `ed25519`

Allowed `purpose` values:

- `owner_signing`
- `selftest_only`
- `automation_signing`

Allowed `status` values:

- `active`
- `legacy`
- `superseded`
- `revoked`
- `selftest_only`

Rules:

- private keys are never stored in policy
- revoked keys must not verify new capabilities
- legacy or superseded keys may verify historical ledger evidence only if policy explicitly permits
  it
- selftest keys must not authorize real high-risk actions

### 19.8 Capability Rules

`capability_rules` define which actions can ever be authorized by signed, scoped capability and
which actions are always denied in v1.

V1 must separate capability-possible from always-denied:

```text
capability_possible_v1:
- git_push

always_denied_v1:
- provider_call
- memory_write
- private_key_access
- secret_access
- deploy
- release
- tag
- force_push
- destructive_fs
- production_write
- package_publish
```

`remote_write` is not a generic v1 capability. `git_push` is the only v1 remote write that can be
capability-gated. GitHub connector writes, MCP writes, Slack/Notion writes, provider calls, memory
writes, deployments, releases, and tags are denied in v1.

Capability rules should bind:

- action class
- command or semantic action
- branch
- HEAD
- ledger head
- expiry
- one-use flag
- signing key id
- denied actions that remain denied

Capability must never grant private key custody. It may authorize a bounded action; it must not
authorize BHA to request, read, print, or store private key material.

### 19.9 Human Confirmation Rules

Some actions should require explicit human confirmation even when no cryptographic capability is
needed.

Human-confirmation examples:

- broad refactor
- dependency change
- editing package manifests
- editing lockfiles
- modifying policy files
- modifying verifier logic
- destructive local cleanup
- touching protected path with reversible local change

Human confirmation should be recorded as a `DecisionRecord` and, when material, as a ledger event.
It should not be treated as a reusable capability unless a separate capability is issued.

### 19.10 Validation Rules

`validation_rules` define what evidence is required before closeout or high-risk gates.

Validation rule fields:

- `action_class`
- `required_commands`
- `optional_commands`
- `freshness`
- `pass_required`
- `reason_code`

Freshness can be defined by:

- matching HEAD
- matching policy hash
- matching ledger head
- command completed after relevant file changes
- command completed during current run

Validation evidence is stale when:

- HEAD changed after validation
- policy changed after validation
- relevant files changed after validation
- verifier found ledger or state mismatch
- the validation command failed
- validation output is missing or ambiguous

### 19.11 Unattended Rules

`unattended_rules` override normal interactive behavior with stricter defaults.

Unattended defaults:

- no remote writes
- no provider calls
- no memory writes
- no private key or secret access
- no package install
- no dependency change
- no destructive filesystem action
- no capability issue or consume unless explicitly preauthorized
- no broad refactor

Unattended mode should prefer:

- read-only inspection
- deterministic validation
- verifier runs
- report generation
- unsigned payload generation

When unsure, unattended mode should return `BLOCKED`, not prompt.

### 19.12 Stop Conditions

`stop_conditions` define states where BHA must stop instead of continuing.

Required stop conditions:

- policy parse failure
- verifier failure
- ledger hash mismatch
- state and repository reality mismatch
- denied path access required
- private key or secret access required
- network required but not allowed
- remote write required but not authorized
- capability missing, expired, malformed, replayed, or mismatched
- validation required but failed
- dirty worktree with unclear ownership
- user instruction conflicts with safety policy

Stop conditions should produce stable reason codes and a next safe action when possible.

### 19.13 Policy Hash

`policy_hash` binds decisions to the policy used at decision time.

Policy hash input should be:

- canonical JSON serialization of the policy
- excluding non-semantic comments if the policy format supports comments
- excluding runtime state
- excluding generated verifier output

Policy hash output should be:

- SHA-256
- raw lowercase hex

Policy hash should be recorded in:

- run records
- decision records
- ledger events when policy matters
- verifier results
- capability payloads when action authority depends on policy
- closeout reports

If policy changes after a validation or capability payload is created, BHA should treat previous
validation or capability evidence as stale unless policy explicitly allows it.

### 19.14 Policy Decision Algorithm

For each proposed action, BHA should evaluate:

1. Normalize the action into `ToolAction`.
2. Match path rules.
3. Match action rules.
4. Apply unattended overrides if relevant.
5. Compute `ToolRisk`.
6. Apply rule precedence.
7. Determine required authority.
8. Check validation freshness if required.
9. Check capability validity if required.
10. Produce `DecisionRecord`.
11. Record material decisions in the ledger.

The algorithm should be deterministic. If two implementations evaluate the same action, policy, and
repository state, they should produce the same decision and reason code.

### 19.15 Minimal V1 Policy Scope

V1 policy should implement only the minimum needed for safe local autonomy:

- path allow/deny/protected rules
- trusted public keys
- action class to authority mapping
- capability-possible and always-denied action lists
- validation freshness basics
- unattended fail-closed defaults
- stop condition reason codes
- policy hash

More advanced rule matching can wait until BHA has stable verifier behavior.

## 20. Runtime State Machine and Command Semantics

This section defines how BHA runtime commands move through phases, read and write files, and produce
verifiable evidence. The goal is to prevent each command from inventing its own lifecycle.

### 20.1 Runtime State Machine

BHA runtime should use these phases:

1. `idle`
2. `inspect`
3. `classify`
4. `plan`
5. `act`
6. `validate`
7. `verify`
8. `checkpoint`
9. `gate`
10. `closeout`
11. `blocked`

Normal flow:

```text
idle -> inspect -> classify -> plan -> act -> validate -> verify -> checkpoint -> closeout
```

High-risk flow:

```text
idle -> inspect -> classify -> gate -> verify -> closeout
```

Blocked flow:

```text
any phase -> blocked -> inspect -> verify -> next safe phase
```

The runtime should not rely on conversation state to decide the current phase. It should derive phase
from state, ledger, policy, and current repository reality.

### 20.2 Command Classes

BHA commands should be grouped by side effect:

- read-only commands
- local evidence write commands
- gate commands
- action adapter commands

Read-only commands must not write ledger, state, capability store, or repository files.

Local evidence write commands may write BHA-controlled files such as ledger, state, checkpoint, or
closeout.

Gate commands may issue or consume capabilities, but only after verification succeeds.

Action adapter commands may prepare or check external action readiness, but v1 should keep real
remote writes outside BHA runtime unless explicitly authorized.

### 20.3 Command Table

| Command | Phase | Read-only | Writes ledger | Writes state | Purpose |
| --- | --- | --- | --- | --- | --- |
| `inspect` | `inspect` | yes | no | no | read repository, policy, branch, HEAD, and worktree facts |
| `risk-classify` | `classify` | yes | no | no | normalize a proposed action and compute risk |
| `make-push-payload` | `gate` | yes | no | no | generate unsigned canonical git push capability payload |
| `git-push-capability-flow` | `gate` | yes | no | no | explain the read-only git_push capability path from unsigned payload to prepush gate |
| `verify-signed-capability` | `gate` | yes | no | no | verify signed capability shape, hash, and signature |
| `issue-capability` | `gate` | no | no for `git_push` | no for `git_push` | record a verified `git_push` capability as local-only gate evidence |
| `consume-capability` | `gate` | no | no for `git_push` | no for `git_push` | consume one-use `git_push` capability as local-only gate evidence |
| `prepush-check` | `gate` | yes with `--preflight`; real hook may write local-only USED session | no | no | fail closed unless a valid consumed capability exists |
| `rollback-drill` | `recover` | yes | no | no | verify that rollback guidance is local, non-destructive, and evidence-based |
| `validate` | `validate` | no | yes | yes | run configured validation and record result |
| `verify` | `verify` | yes by default; no with `--record` | no by default; yes with `--record` | no by default; yes with `--record` | verify policy, ledger, state, validation, and capability consistency |
| `evidence-ux-status` | `recover` | yes | no | no | report whether validation can be reused or full validation is required |
| `repair-evidence --fast` | `recover` | no | yes | yes | reuse fresh validation and record only checkpoint/closeout binding |
| `checkpoint` | `checkpoint` | no | yes | yes | write resumable handoff state |
| `closeout` | `closeout` | yes by default; no with `--record` | no by default; yes with `--record` | no by default; yes with `--record` | preview final state or record closeout evidence |

`prepush-check --preflight` should remain read-only and unrecorded because operator preflight needs
predictable, low-side-effect behavior. The real Git hook path may write exactly one local-only USED
session under `.bha/local/capability-sessions.jsonl` to reserve the one-use `git_push` capability.
It should fail closed unless verifier, ledger/state alignment, fresh validation, rollback drill
evidence, checkpoint evidence, current closeout evidence, clean or authorized-runtime-dirty worktree
state, and a consumed `git_push` capability all pass.

`verify` should remain read-only by default. `verify --record` may append `verifier_completed` and
update state, but it must record the ledger head it actually checked separately from the new
verifier event hash so the verifier result does not claim to have verified itself.

`git-push-capability-flow` should remain read-only. It may generate an unsigned canonical payload
and operator steps, but it must not request, read, print, store, or write private key material.

`rollback-drill` should remain read-only. It verifies that `.bha/rollback.md` documents local
dry-run scope, known-good evidence recovery, hook recovery, destructive-command boundaries, remote
effect boundaries, and secret/private-key boundaries. It must not perform recovery actions.

`closeout` should preview by default. `closeout --record --format json` may append a
`closeout_completed` ledger event only after verifier and validation evidence pass.

`checkpoint` should not have optional evidence in v1. If checkpoint participates in resume or
verification, it must append a `checkpoint_written` ledger event. If it is only a human note, it
should stay outside verifier logic.

### 20.4 Read-Only Command Contract

A read-only command must not:

- write repository files
- write BHA ledger
- write BHA state
- write capability store
- write checkpoints
- modify `.git/**`
- create commits
- run network calls
- request or read private keys
- install packages

Read-only commands may:

- read policy
- read ledger
- read state
- read git branch and HEAD
- inspect worktree status
- compute hashes
- output JSON to stdout

If a read-only command cannot complete without writing, it should return `BLOCKED` with
`READ_ONLY_WRITE_REQUIRED`.

### 20.5 Evidence Write Contract

Evidence write commands must:

- write only BHA-controlled files
- append ledger events rather than rewriting evidence
- update state only after ledger append succeeds
- include run id and actor id
- include policy hash when policy affected the decision
- include ledger head before and after material writes
- avoid secrets, private key material, and raw environment values

If ledger append succeeds but state update fails, verifier should detect mismatch and return
`FAIL` or `BLOCKED` with a state consistency reason.

### 20.6 Gate Command Contract

Gate commands control high-risk action authority.

Gate command rules:

- `make-push-payload` is read-only and unsigned.
- `verify-signed-capability` is read-only and must reject non-canonical payloads.
- `issue-capability` verifies before writing local-only `git_push` authorization evidence.
- `consume-capability` requires issued, unexpired, unconsumed capability.
- consumed capability must match exact action context.
- `git_push` capability consume should not record tracked ledger or update tracked state; it should
  update only local gate evidence.
- replay must fail closed.

Gate commands must not execute the high-risk action. They only prepare or record authority.

### 20.7 Validation Command Contract

`validate` should run configured local validation commands and record structured evidence.

Validation record should include:

- command
- exit code
- started_at
- ended_at
- duration when available
- head
- policy_hash
- ledger_head_hash before validation
- status
- reason_code
- summary

Validation output should be summarized. Raw output may be truncated or stored only if it contains no
secrets and is useful for debugging.

Validation should not be rerun merely because `git commit` changed HEAD. If the validation input
hash, policy hash, mission hash, and recorded validation ledger event still match current repository
content, ordinary post-commit repair should use the fast path:

```bash
node scripts/bha-run.js evidence-ux-status --remote origin --branch master --format json
node scripts/bha-run.js repair-evidence --fast --remote origin --branch master --format json
```

The fast path must fail closed when validation evidence is missing, failed, or stale. It may record
checkpoint and closeout evidence, but it must not hide validation drift or claim that validation
commands were rerun.

When the fast repair output is committed, the resulting commit should be treated as an evidence
carrier if it changes only tracked runtime evidence files and its parent is the subject commit named
by checkpoint/closeout. `evidence-ux-status`, `gate-status`, and `prepush-check` should expose this
as `EVIDENCE_CARRIER_COMMIT` and must not ask for another fast repair solely because the carrier
HEAD differs from the subject HEAD.

`repair-evidence --fast` must respect that same decision. If `evidence-ux-status` does not report
`fast_repair_available:true`, fast repair is a read-only no-op and must not write another
checkpoint/closeout pair for an accepted evidence carrier commit.

Validation failure should not automatically trigger broad repair. BHA should mark validation failed,
record evidence, and let the agent decide whether a narrow local fix is safe.

### 20.8 Verify Command Contract

`verify` should be deterministic and read-only.

It should check:

- policy parse and policy hash
- trusted public key validity
- ledger hash chain
- state consistency with ledger
- current branch and HEAD
- capability issue and consume records
- validation freshness
- denied action evidence
- closeout consistency when closeout exists

`verify` should output a `VerifierResult` and should not change repository state. If verification
needs to record a result, that should be done by a separate command or by `closeout`, not by
`verify` itself.

### 20.9 Checkpoint Command Contract

`checkpoint` writes resumable handoff state.

Checkpoint command should:

- read current repository reality
- include current ledger head
- include current verifier status if available
- list changed files
- list validation run and validation not run
- list blockers and risks
- list next safe action
- avoid secrets and private key material

Checkpoint updates state only after appending a ledger event. Optional checkpoint evidence is not a
v1 behavior because it creates verifier ambiguity.

### 20.10 Closeout Command Contract

`closeout` records the final state of a run.

Closeout should include:

- changed files
- validation results
- verifier result
- capability issue and consume status
- blockers
- not validated items
- risks
- next safe action
- explicit statement about forbidden side effects when relevant

Closeout must avoid the ledger-head self-reference problem by separating:

```json
{
  "verified_ledger_head_hash": "...",
  "closeout_event_hash": "...",
  "final_ledger_head_hash": "..."
}
```

`verifier_status` applies to `verified_ledger_head_hash`, not to the post-closeout ledger head. If
closeout runs as a read-only preview, `closeout_event_hash` and `final_ledger_head_hash` must
explicitly say that no closeout event was recorded.

Closeout should not claim full success unless relevant validation and verification passed. If
verification fails, closeout should return `BLOCKED` or `FAIL` and explain why.

### 20.11 Command Output Contract

Every command should support machine-readable JSON output.

Common output fields:

- `ok`
- `status`
- `command`
- `run_id`
- `phase`
- `reason_code`
- `reasons`
- `head`
- `policy_hash`
- `ledger_head_hash`
- `read_only`
- `recorded`
- `summary`

Human-readable output may exist, but JSON output should be the stable integration surface for hooks,
automation, and future adapters.

### 20.12 Stable Exit Codes

BHA commands should use stable exit codes:

- `0`: success or expected pass
- `1`: expected policy, validation, verifier, or gate failure
- `2`: invalid command usage or malformed input
- `3`: blocked by safety policy
- `4`: repository reality mismatch
- `5`: internal runtime error

`prepush-check` without valid capability should exit `1`, not `0`, and should report
`read_only:true` and `recorded:false`.

### 20.13 Reason Code Families

Reason codes should be stable and grouped by family:

- `POLICY_*`
- `PATH_*`
- `ACTION_*`
- `RISK_*`
- `CAPABILITY_*`
- `VALIDATION_*`
- `VERIFIER_*`
- `LEDGER_*`
- `STATE_*`
- `CHECKPOINT_*`
- `CLOSEOUT_*`
- `RUNTIME_*`

Examples:

- `POLICY_PARSE_FAILED`
- `PATH_DENIED`
- `ACTION_REQUIRES_CAPABILITY`
- `CAPABILITY_EXPIRED`
- `CAPABILITY_REPLAYED`
- `VALIDATION_FAILED`
- `VERIFIER_LEDGER_HASH_MISMATCH`
- `STATE_LEDGER_HEAD_MISMATCH`
- `RUNTIME_READ_ONLY_WRITE_REQUIRED`

Reason codes should be specific enough for automation but stable enough not to churn with wording.

### 20.14 Minimal V1 Command Set

The minimal v1 command set should be:

- `inspect`
- `risk-classify`
- `validate`
- `verify`
- `checkpoint`
- `closeout`
- `rollback-drill`
- `make-push-payload`
- `git-push-capability-flow`
- `verify-signed-capability`
- `issue-capability`
- `consume-capability`
- `prepush-check`

Commands outside this set should wait unless they remove immediate implementation friction or reduce
risk without expanding scope.

### 20.15 Implementation Order

Recommended implementation order:

1. canonical JSON and hash helpers
2. policy parser and policy hash
3. ledger append and ledger verify
4. state load and state consistency check
5. verifier result shape
6. validation evidence records
7. capability payload generation and verification
8. capability issue and consume
9. prepush-check
10. checkpoint and closeout
11. Codex hooks and rules templates

This order builds the proof layer before expanding automation behavior.

## 21. V1 Implementation Blueprint

This section turns the architecture into a practical v1 build plan. It should guide implementation
before changing runtime code.

### 21.1 V1 Goal

V1 should make one local Codex project session safer and more verifiable.

V1 should prove:

- policy can be parsed and hashed deterministically
- ledger hash chain can be appended and verified
- state can be checked against ledger and repository reality
- validation evidence can be recorded
- capability payloads can be generated, verified, issued, and consumed
- the git_push capability flow can be inspected without handling private key material
- `prepush-check` fails closed without a consumed capability
- closeout can report verified and unverified facts without overclaiming
- closeout can record `closeout_completed` ledger evidence after verifier and validation pass

V1 should not implement:

- multi-worktree ledger merge
- subagent scheduler
- remote orchestration
- production deploy control
- private key custody
- generic CI platform

### 21.2 V1 File Layout

V1 should use the existing `.bha` directory.

Core files:

- `.bha/policy.yaml`
- `.bha/ledger.jsonl`
- `.bha/state.json`
- `.bha/capabilities.jsonl`
- `.bha/validation.yaml`

Optional generated files:

- `.bha/checkpoint.json`
- `.bha/closeout.json`

Runtime script:

- `scripts/bha-run.js`
- `scripts/bha-verify.js`

V1 should not introduce new packages, services, databases, or background daemons.

### 21.3 Data Format Strategy

V1 may keep human-authored policy and validation config with `.yaml` filenames:

- `.bha/policy.yaml`
- `.bha/validation.yaml`

For v1, these files should use a JSON-compatible YAML subset rather than full YAML. The supported
subset is plain maps, arrays, strings, numbers, booleans, and null values that can be parsed into the
same data model as JSON without custom tags or implicit execution behavior.

V1 should use JSON or JSONL for machine-written artifacts:

- `.bha/ledger.jsonl`
- `.bha/state.json`
- `.bha/capabilities.jsonl`
- `.bha/checkpoint.json`
- `.bha/closeout.json`

Hashing rule:

- supported policy and validation files are parsed into plain data
- Parsed data is normalized into canonical JSON.
- Canonical JSON bytes are hashed.
- formatting and field order do not affect the hash.

V1 should reject YAML features that make deterministic parsing unclear:

- comments if the v1 parser cannot ignore them deterministically
- anchors
- aliases
- duplicate keys
- custom tags
- executable tags

V1 should not introduce a full YAML parser unless that parser can be adopted without violating the
dependency policy. If a full parser is not available, the runtime should explicitly enforce the
JSON-compatible subset and fail closed when unsupported forms are detected.

### 21.4 Path Normalization and Glob Rules

All policy path rules should be evaluated against repository-relative normalized paths.

Path normalization rules:

- convert backslashes to `/`
- remove `.` segments
- resolve `..` segments without allowing escape above repo root
- strip leading `./`
- reject absolute paths in policy unless a schema explicitly allows them
- treat paths as case-sensitive in policy matching unless a platform adapter explicitly documents
  otherwise

Glob rules:

- `*` matches within one path segment
- `**` matches zero or more path segments
- trailing `/**` matches all descendants
- path rules are matched after normalization

Symlink and junction rule:

- V1 should fail closed when a write target resolves outside the repository root.
- V1 should treat symlink or junction traversal into denied or protected paths as denied.

These rules matter because BHA must behave predictably on Windows while staying portable.

### 21.5 Policy Hash Implementation

`policy_hash` should be computed from the supported policy data model.

Implementation steps:

1. Read `.bha/policy.yaml`.
2. Parse supported YAML subset.
3. Reject unsupported YAML features.
4. Normalize object keys and values.
5. Serialize canonical JSON.
6. Compute SHA-256.
7. Return raw lowercase hex.

Policy hash should be recorded in:

- state
- verifier result
- decision records
- validation records
- capability payloads
- closeout

If policy changes, existing validation and unsigned capability payloads should be treated as stale.

### 21.6 Capability Payload Binding

V1 capability payloads should always bind policy hash.

Unsigned capability payload fields should include:

- `schema`
- `capability_id`
- `run_id`
- `type`
- `action_class`
- `command`
- `remote`
- `branch`
- `head`
- `ledger_head_hash`
- `policy_hash`
- `one_use`
- `expires_at`
- `signing_key_id`
- `algorithm`
- `signature_encoding`
- `payload_hash_format`
- `denied_actions_remain_denied`

For v1 `git_push`, payload must bind:

- `type=git_push`
- `command=git push <remote> <branch>`
- exact `remote`
- exact `branch`
- exact `head`
- exact `ledger_head_hash`
- exact `policy_hash`
- `one_use=true`
- expiry
- trusted active owner signing key

If any bound field changes before consume, capability must fail closed.

### 21.7 Closeout Binding

V1 closeout should bind the final report to repository and BHA evidence.

Closeout required binding fields:

- `head`
- `branch`
- `policy_hash`
- `ledger_head_hash`
- `verifier_status`
- `validation_status`
- `changed_files`
- `capabilities`
- `not_validated`
- `blockers`
- `risks`

Closeout should clearly distinguish:

- verified facts
- user-visible summaries
- skipped validation
- blocked actions
- unverified claims

Closeout should never be used as proof unless it references verifier and ledger evidence.

### 21.8 Nullable V1 Fields

V1 should explicitly allow these required-but-nullable fields:

- `Run.parent_run_id`
- `Run.ended_at`
- `Run.ledger_head_end`
- `StateSnapshot.last_checkpoint_id`

Rules:

- `parent_run_id=null` means root run.
- `ended_at=null` means run is active.
- `ledger_head_end=null` means run has not closed.
- `last_checkpoint_id=null` means no checkpoint exists yet.

Required-but-nullable fields must still be present. Missing and null are different.

### 21.9 Command to Schema Mapping

Command mapping:

- `inspect`: reads `Policy`, `StateSnapshot`, ledger head, git reality; outputs repository facts.
- `risk-classify`: creates `ToolAction`, `ToolRisk`, and optional `DecisionRecord` preview.
- `validate`: writes `LedgerEvent`, updates `StateSnapshot`, creates validation evidence.
- `verify`: outputs `VerifierResult`; writes nothing.
- `checkpoint`: writes `Checkpoint`, appends `LedgerEvent`, updates `StateSnapshot`.
- `closeout`: writes `Closeout`, `LedgerEvent`, and final `StateSnapshot`.
- `make-push-payload`: outputs unsigned `Capability` payload; writes nothing.
- `git-push-capability-flow`: outputs unsigned payload plus operator steps; writes nothing.
- `verify-signed-capability`: outputs `VerifierResult`-like capability verification; writes nothing.
- `issue-capability`: for v1 `git_push`, appends a local-only capability issue record under `.bha/local/`.
- `consume-capability`: for v1 `git_push`, appends a local-only consume record under `.bha/local/`.
- `prepush-check`: reads capability consume state and repository facts; writes nothing by default.

`closeout` may also run as a read-only preview. Recording requires explicit `--record`.

This mapping should be used to prevent accidental file writes in read-only commands.

### 21.10 First Implementation Slice

The first implementation slice should be:

1. canonical JSON helper
2. policy YAML supported-subset parser
3. policy hash
4. path normalization and glob matching
5. ledger event hash and verification
6. state load and consistency check
7. verifier result with multi-reason checks

This slice should pass before capability work expands.

### 21.11 Second Implementation Slice

The second implementation slice should be:

1. capability canonical payload builder
2. capability payload hash
3. Ed25519 SPKI public key verification
4. signed capability verifier
5. capability issue record
6. capability consume record
7. replay, expiry, branch, HEAD, ledger, and policy hash checks
8. read-only `git-push-capability-flow`
9. read-only `prepush-check`

This slice proves the high-risk gate model.

### 21.12 Third Implementation Slice

The third implementation slice should be:

1. validation evidence records
2. checkpoint output
3. closeout output
4. closeout binding to HEAD, policy hash, ledger head, validation, and verifier
5. Codex AGENTS template
6. Codex rules template
7. Codex hooks template

This slice improves usability after the proof layer is stable.

### 21.13 Implementation Stop Conditions

Implementation should stop if:

- policy hash cannot be deterministic
- path matching is ambiguous
- ledger hash chain cannot be preserved
- verifier cannot remain read-only
- private key material is needed
- network is needed
- package installation is needed
- implementation requires writing outside allowed project files
- existing dirty runtime files make the intended change unsafe
- verifier cannot explain failure with reason codes

Stopping at these conditions is part of the safety design.

### 21.14 Runtime Implementation Entry Criteria

Runtime implementation should begin only after this design document is internally consistent.

Implementation entry criteria:

- sections 16 through 22 are reviewed as one coherent design
- v1 scope is clear and intentionally small
- deferred features are explicitly separated from v1
- command read/write behavior is clear
- policy, state, ledger, capability, verifier, checkpoint, and closeout responsibilities do not
  overlap accidentally
- schema canonicalization rules are sufficient for deterministic hashes
- capability payload fields are fixed before signing UX is built
- stop conditions are clear enough for Codex to halt without guessing
- current runtime files are inspected before edits so existing user-owned dirty changes are not
  overwritten

Only after these criteria are met should implementation preflight begin.

## 22. Design Readiness Review

This section checks whether the current BHA design is ready to guide implementation.

### 22.1 Design Thesis

BHA should make Codex more autonomous by making autonomy more bounded, observable, and reversible.

The design does not try to make Codex omniscient. It gives Codex a smaller operating box with better
evidence:

- policy defines boundaries
- risk classification explains why an action is safe or gated
- ledger records material evidence
- state supports resume
- checkpoints survive compaction and interruption
- capabilities gate narrow high-risk actions
- verifier proves consistency before trust is extended
- closeout separates verified facts from unverified claims

### 22.2 Coherence Check

The main design chain is coherent:

```text
Codex boundary -> BHA requirement -> core object -> schema -> policy rule -> command behavior -> v1 slice
```

The document now has a direct path from Codex findings to implementation:

- Codex controls are useful but partial.
- BHA adds repository-local proof and gates.
- BHA objects define what evidence exists.
- Schemas define what must be recorded.
- Canonicalization defines how evidence is hashed.
- Policy semantics define decisions.
- Runtime commands define read/write behavior.
- V1 blueprint defines implementation order.

### 22.3 V1 Boundary

V1 should stay intentionally narrow.

In scope:

- local repository policy
- local ledger and state
- local validation evidence
- deterministic verifier
- canonical capability payloads
- signed capability verification
- one-use capability issue and consume
- read-only fail-closed `prepush-check --preflight`
- local-only USED session reservation in the real `prepush-check` hook path
- authorized runtime evidence dirtiness for `.bha/ledger.jsonl`, `.bha/state.json`, and
  `.bha/checkpoint.json`
- closeout with explicit verified and unverified facts

Out of scope:

- multi-worktree ledger merge
- autonomous remote pushing
- provider calls
- production deployment
- private key custody
- dependency changes
- general task scheduling
- CI or GitHub automation as a required dependency for local V1
- remote branch protection as a required dependency for local V1 verification

This boundary is important. BHA earns more autonomy by proving the small loop first.

### 22.4 Remaining Design Risks

The V1 local implementation is ready for freeze review, but these risks remain:

- YAML support must be deliberately limited or replaced with JSON-compatible parsing.
- Ledger history should not be rewritten casually.
- Local hooks remain bypassable locally; protected `master` plus required checks mitigate the remote
  merge path but do not remove admin, token, workflow, or UI bypass risks.
- V2 preview artifacts must not be treated as runtime authority.
- `bha-run.js` has accumulated many responsibilities and should be modularized only after V1 freeze.
- Policy hash rules must be implemented before capability signing UX expands.
- Closeout must not become a substitute for verifier proof.
- Capabilities must stay narrow and one-use.
- Human confirmation and cryptographic capability must not be treated as the same authority.
- Codex hooks and approvals must remain advisory unless BHA independently verifies the action.

These are implementation risks, not reasons to reopen the whole architecture.

### 22.5 Design Freeze Candidate

The current document is a design-freeze candidate for v1 if these statements hold:

- BHA's purpose is clear.
- Codex-native controls are understood as useful but insufficient.
- BHA's core objects are named and scoped.
- The data schemas are stable enough for first implementation.
- Canonicalization and policy hash rules are explicit.
- Command read/write contracts are explicit.
- Capability format and lifecycle are explicit.
- V1 scope is small enough to build without broad refactor.
- Deferred work is clearly separated from v1.

If a future change violates one of these statements, it should be recorded as a design decision
instead of silently changing the architecture.

### 22.6 Next Safe Step

The next safe step after this document pass is a document review, not runtime editing.

The review should check:

- section numbering
- duplicate or contradictory claims
- whether every v1 object has an owner
- whether every command has a read/write contract
- whether every high-risk action has a gate
- whether every proof claim points to verifier, ledger, validation, or closeout evidence
- whether implementation slices are ordered from proof layer to automation layer

Runtime implementation should start only after that review is accepted.

## 23. BHA System Overview

BHA is a project-local control layer around Codex work. It does not replace Codex. It gives Codex a
bounded way to plan, act, validate, stop, and resume with evidence.

System path:

```text
User intent
  -> Codex reasoning
  -> BHA adapter
  -> Policy and risk classification
  -> Runtime command contract
  -> Ledger and state evidence
  -> Verifier
  -> Capability gate when needed
  -> Checkpoint or closeout
```

Core responsibility split:

- Codex decides what work appears useful.
- BHA policy defines what work is allowed, denied, or gated.
- BHA risk classification explains why an action is low, medium, high, or critical risk.
- BHA ledger records material evidence.
- BHA state provides resumable current status.
- BHA verifier determines whether evidence is internally consistent.
- BHA capability gate authorizes narrow high-risk actions without broad permission.
- BHA closeout reports what was verified, what was not verified, and what remains blocked.

The important design point is that BHA is not another source of model judgment. It is the evidence
and boundary layer that lets model judgment move farther without silently crossing safety lines.

## 24. BHA Core Invariants

These invariants must hold across v1. If an implementation violates one of them, it should be
treated as a design break, not a minor bug.

Core invariants:

- The verifier is read-only.
- The ledger is append-only.
- State is resumable status, not primary truth.
- Repository reality outranks conversation memory.
- Policy decisions are bound to `policy_hash`.
- Capability payloads are canonical flat JSON objects.
- Capability hashes are raw lowercase SHA-256 hex values.
- Capabilities are scoped, expiring, and one-use.
- A consumed capability must match exact action context.
- A signed capability does not override denied actions that remain denied.
- Private signing keys never enter the repository.
- Private signing keys are never requested, printed, logged, or stored by BHA.
- Read-only commands never write ledger, state, capability store, checkpoints, repository files, or
  `.git/**`.
- High-risk actions are gated before execution, not explained after execution.
- Closeout is not proof unless it references verifier and ledger evidence.
- Validation claims must identify what was run and what was not run.
- Human confirmation and signed capability are different authorities.
- Codex approvals, hooks, rules, and AGENTS.md are useful controls but not sufficient proof.

When invariants conflict with convenience, the invariant wins.

## 25. V1 Acceptance Criteria

V1 is accepted only when the small local safety loop works end to end.

Required v1 acceptance criteria:

- `policy_hash` is deterministic for the supported policy format.
- `mission_hash` is deterministic and bound to validation, capability, verifier, and closeout evidence.
- Unsupported policy syntax fails closed with a stable reason code.
- Ledger events are hashed canonically and verified in order.
- State ledger head matches the verified ledger head.
- Unrecorded dirty worktree changes return `BLOCKED` with `UNVERIFIED_WORKTREE_CHANGE`.
- `verify` is read-only and returns machine-readable `PASS`, `FAIL`, or `BLOCKED`.
- `verify --record` writes `verifier_completed`, distinguishes `checked_ledger_head_hash` from
  `verifier_event_hash`, and fails closed when the ledger head changes before recording.
- `validate` records local validation evidence without hiding failures.
- `check -- <cmd>` returns nonzero on `DENY`; `assert-deny -- <cmd>` returns zero only when the
  command is denied.
- `exec -- <cmd>` records git status before and after execution, reports changed files, enforces the
  policy path allowlist, and fails closed when either git status cannot be established.
- `make-push-payload` is read-only and outputs canonical unsigned flat JSON.
- `git-push-capability-flow` is read-only and outputs the unsigned payload, exact operator steps,
  and hard boundaries before signing.
- Capability payload uses `head`, not `head_sha`.
- Capability payload includes `policy_hash`, `mission_hash`, `ledger_head_hash`, `head`, `branch`,
  `remote`, `run_id`, `one_use`, expiry, command, and signing key id.
- Capability payload includes `algorithm`, `signature_encoding`, and `payload_hash_format` as
  canonical top-level fields.
- Capability `payload_hash` is raw lowercase hex with no `sha256:` prefix.
- V1 capability type is only `git_push`.
- Provider, memory, private-key, secret, deploy, release, tag, force-push, destructive filesystem,
  production-write, and package-publish action classes are always denied in v1.
- `verify-signed-capability` rejects nested payload/signature envelopes.
- `verify-signed-capability` rejects malformed hash, missing algorithm, unsupported algorithm,
  expired capability, wrong branch, wrong HEAD, wrong ledger head, wrong policy hash, and wrong
  mission hash.
- `issue-capability` verifies before writing an issued capability record.
- `consume-capability` accepts only valid, issued, unexpired, unconsumed capability records.
- Local capability issue, consume, and USED session writes are protected by a local capability lock.
- One-use replay is rejected.
- `prepush-check` without a valid consumed capability fails closed with `read_only:true` and
  `recorded:false`.
- `prepush-check --preflight` is read-only; the real hook path may reserve the one-use capability by
  writing local-only USED session evidence.
- `prepush-check` reports machine-readable `evidence_gates` for verifier, ledger/state alignment,
  validation freshness, rollback evidence, checkpoint evidence, and current closeout evidence.
- `prepush-check` accepts clean worktree or authorized runtime evidence dirtiness only; dirty runtime
  code, policy, validation config, hooks, or documentation still blocks.
- `prepush-check` does not perform a real push.
- `git-push-capability-flow` does not issue, consume, or authorize a capability by itself.
- `rollback-drill --format json` is read-only and confirms rollback guidance is local,
  non-destructive, evidence-based, and explicitly denies remote effects plus secret/private-key
  access.
- `checkpoint --format json` writes `.bha/checkpoint.json`, appends `checkpoint_written`, updates
  `StateSnapshot.last_checkpoint`, and binds the checkpoint file to the ledger event.
- Closeout lists changed files, validation status, verifier status, capabilities, blockers, risks,
  and not-validated items.
- Closeout separates `verified_ledger_head_hash`, `closeout_event_hash`, and
  `final_ledger_head_hash`.
- `closeout --record --format json` writes a `closeout_completed` event only after verifier and
  validation pass.
- Repeated closeouts are allowed, but `StateSnapshot.closeout` must reference the newest
  `closeout_completed` event.
- If ledger events are appended after the newest closeout, verifier may warn that the closeout is no
  longer the current ledger head.
- Closeout distinguishes verified facts from summaries and claims.
- No private key material is read, printed, stored, logged, or written to the repository.
- No network, package installation, provider call, push, tag, release, deploy, or `.git/**` write is
  required for v1 validation.
- Package install, package publish, release, tag, SSH, deploy, provider, memory, force-push,
  destructive, and production-write risks are denied with specific reason codes where policy can
  classify them.
- Ledger writer lock reports or recovers stale local locks without silently proceeding through an
  ambiguous writer state.

Negative acceptance criteria:

- malformed policy is rejected
- duplicate or modified ledger events are rejected
- manually appended unsigned capability is rejected
- stale validation is rejected
- changed HEAD after capability payload is rejected
- changed policy hash after capability payload is rejected
- changed mission hash after capability payload is rejected
- prepush without consumed capability is rejected
- replaying a used local `git_push` capability is rejected
- dirty code or policy changes are not accepted as authorized runtime evidence dirtiness
- closeout unsupported claims are rejected

V1 should be considered incomplete if any of these criteria require manual interpretation instead of
machine-readable output.

## 26. External Prior Art and Borrowed Patterns

This section records mature external patterns BHA should learn from. The goal is not to copy a large
system into BHA v1. The goal is to avoid inventing weak local versions of problems that already have
well-tested design traditions.

### 26.1 Review Principles

External prior art should be evaluated with five questions:

- What problem does it solve?
- Which pattern should BHA borrow?
- What should BHA avoid copying?
- What does it change for BHA v1?
- How stable is the reference?

Borrowing a pattern does not mean adopting a dependency. For v1, BHA should prefer small local
implementations of stable patterns over large dependency or service adoption.

### 26.2 Prior Art Matrix

| Area | Reference | Mature pattern | BHA should borrow | BHA should not copy in v1 | Stability |
| --- | --- | --- | --- | --- | --- |
| Policy as code | OPA | externalized policy decisions over structured input | deterministic policy evaluation, clear allow/deny answers, policy/data separation | Rego engine, server mode, broad integration surface | mature |
| Config policy tests | Conftest | tests over structured configuration files | validation as policy checks with explicit failure messages | Rego dependency and multi-format parser surface | mature |
| Supply-chain integrity | in-toto | planned steps, authorized actors, signed evidence links | layout/link thinking, step evidence, actor authority | full supply-chain layout engine | mature |
| Attestation format | in-toto Attestation | verifiable claims about software production | structured predicate-like evidence records | broad predicate ecosystem and multi-language bindings | emerging-to-mature |
| Provenance generation | SLSA GitHub Generator | non-forgeable provenance generated by isolated workflows | bind output to source, workflow, identity, and verification | GitHub Actions dependency for local v1 | mature for CI, out of scope for local v1 |
| Signing and verification | Sigstore cosign | sign by digest, verify identity/key, detached payloads | sign exact canonical payloads and verify against expected identity/key | transparency log, keyless OIDC, OCI registry storage | mature |
| Git local gates | Git hooks | local pre-action checks such as pre-commit and pre-push | fail-closed `prepush-check`, low-side-effect local guardrails | treating hooks as complete enforcement | mature but bypassable locally |
| GitHub remote gates | Protected branches | required reviews, status checks, signed commits, push restrictions | treat remote protection as a second gate after local BHA | depending on GitHub branch rules for local proof | mature |
| Commit identity | GitHub signed commits | signed local commits with GPG, SSH, or S/MIME | distinguish commit identity from capability authority | using commit signatures as BHA action capabilities | mature |
| Build provenance | GitHub artifact attestations | generated and verifiable build provenance | future closeout or CI artifact provenance pattern | requiring online GitHub attestation for v1 | mature but platform-bound |
| Security health checks | OpenSSF Scorecard | automated checks with scores, risks, and remediation | machine-readable checks, reasoned findings, remediation hints | aggregate numeric score as the main BHA result | mature |

### 26.3 Borrowed Design Patterns

BHA should borrow these patterns directly:

- policy decisions should evaluate structured input, not prose
- policy output should be machine-readable and stable
- evidence should bind actor, action, input, output, time, and hash
- signed authority should cover exact bytes, not an informal summary
- verification should be a separate read-only operation
- gates should fail closed when evidence is missing or stale
- hooks are useful workflow triggers but not final proof
- remote protections are defense-in-depth, not a substitute for local evidence
- health checks should include reason codes and remediation guidance

These borrowed patterns reinforce the existing BHA architecture rather than changing it.

### 26.4 Non-Adoption Decisions for V1

V1 should not adopt these systems wholesale:

- Do not embed OPA/Rego in v1.
- Do not require Conftest to validate policy.
- Do not implement full in-toto layouts.
- Do not require SLSA or GitHub Actions provenance.
- Do not require Sigstore, Fulcio, Rekor, or keyless signing.
- Do not rely on Git hooks as the only enforcement layer.
- Do not require GitHub protected branches for local verification.
- Do not reduce BHA health to a single numeric score.

The reason is scope. These systems are valuable, but BHA v1 needs a smaller local loop first:
policy, canonical evidence, verifier, capability gate, checkpoint, and closeout.

### 26.5 V1 Impact

External prior art changes BHA v1 in concrete ways:

- Policy should stay structured and deterministic, even if v1 does not use OPA.
- Validation should produce explicit failure reasons, similar to policy test output.
- Ledger events should be treated like local attestations.
- Capability payloads should be signed by exact canonical bytes.
- Payloads should bind hashes and identities, not mutable names alone.
- `verify` should be read-only and separate from evidence-producing commands.
- `prepush-check` should be a local fail-closed gate, not proof by itself.
- Closeout should resemble an attestation summary but remain backed by verifier and ledger evidence.
- Future CI integration can map BHA closeout or verifier output into GitHub artifact attestations or
  required status checks.

### 26.6 Reference Links

Primary references:

- OPA: https://github.com/open-policy-agent/opa
- Conftest: https://github.com/open-policy-agent/conftest
- in-toto: https://github.com/in-toto/in-toto
- in-toto Attestation: https://github.com/in-toto/attestation
- SLSA GitHub Generator: https://github.com/slsa-framework/slsa-github-generator
- Sigstore cosign: https://github.com/sigstore/cosign
- Git hooks: https://git-scm.com/docs/githooks
- GitHub protected branches: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- GitHub signed commits: https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits
- GitHub artifact attestations: https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations
- OpenSSF Scorecard: https://github.com/ossf/scorecard

### 26.7 Design Conclusion

BHA is not an isolated invention. It is a local-agent adaptation of mature ideas:

- Policy as Code for decisions
- attestation for evidence
- signing for authority
- hooks and branch protection for gates
- scorecard-style checks for health

The correct v1 move is to borrow the patterns, not the full platforms.

## 27. Agent-Native Prior Art and Watchlist

Section 26 covers mature DevSecOps and supply-chain patterns. This section covers newer
agent-native references. These references are more directly relevant to BHA's long-term direction,
but many are newer and less stable than OPA, in-toto, SLSA, Sigstore, Git, or OpenSSF Scorecard.

The goal is to avoid two mistakes:

- treating traditional DevSecOps as enough for autonomous agents
- adopting immature agent governance systems before their abstractions settle

### 27.1 Adopt Now

These patterns are mature enough, or strategically important enough, to influence BHA v1 design now.

| Area | Reference | BHA impact | Stability |
| --- | --- | --- | --- |
| Agent threat taxonomy | OWASP Agentic AI Top 10 | use as the threat checklist for tool misuse, goal drift, identity abuse, memory poisoning, cascading failure, and rogue-agent behavior | emerging but important |
| External tool authorization | MCP authorization | model external tool access around identity, scopes, authorization challenges, and short-lived credentials | active standard |
| Agent observability vocabulary | OpenTelemetry GenAI semantic conventions | keep BHA ledger and closeout compatible with future spans for agents, tools, MCP calls, and model activity | developing |

V1 does not need to implement these systems fully, but it should avoid choices that make them hard to
add later.

Concrete v1 implications:

- `ToolRisk` should include agent-specific risk categories, not only shell-command risk.
- `Actor` should be explicit enough to distinguish user, main agent, subagent, hook, verifier, and
  external tool identity.
- `LedgerEvent` should preserve enough structured metadata to map later into traces or audit graphs.
- Capability and policy decisions should include action class, actor, target, scope, and reason code.
- External tool access should be modeled as scoped authority, not just command execution.

### 27.2 Borrow Carefully

These systems are promising but too broad or too new to copy into BHA v1.

| Area | Reference pattern | What BHA can borrow | What BHA should avoid in v1 |
| --- | --- | --- | --- |
| Runtime governance toolkit | action interception, policy providers, plugin interfaces | pre-action enforcement, policy provider abstraction, plugin signing ideas | large framework, many packages, service-like runtime |
| Agent identity mesh | DIDs, Ed25519 identities, trust scores | explicit actor identity and public-key trust roots | dynamic trust scoring before local evidence is stable |
| Execution rings | privilege levels and emergency kill switch | risk tiers and hard stop states | OS-like runtime complexity |
| Compliance mapping | OWASP/EU AI Act/SOC2 evidence mapping | reason-code families and audit-ready closeout | regulatory compliance engine |
| Agent SRE | SLOs, circuit breakers, error budgets | future unattended-run circuit breakers | production reliability layer in v1 |
| Plugin supply chain | signed plugin manifests | future Skill/MCP/plugin allowlists | marketplace or plugin lifecycle manager |

BHA should treat these as design pressure, not implementation requirements.

### 27.3 Watchlist Only

These areas are moving quickly and should be tracked, but not used as v1 dependencies or fixed
architecture commitments.

Watchlist:

- emerging agent governance protocols
- agent audit graph proposals
- multi-agent trace standards
- memory lineage and memory poisoning defenses
- human approval quorum systems
- budget and rate-limit governance for autonomous agents
- policy-enforced reinforcement learning runners
- marketplace trust models for agent skills and plugins
- remote agent-to-agent communication protocols

The reason to watch them is clear: BHA's future scope includes subagents, worktrees, MCP tools,
provider calls, memory, scheduled automation, and eventually remote action governance. But v1 should
not depend on unsettled standards.

### 27.4 BHA Positioning Against Agent-Native Systems

BHA should position itself as a local-first agent governance layer for coding projects.

Compared with broad agent governance platforms, BHA should be:

- smaller
- repository-local
- file-based
- deterministic
- easy to inspect
- offline-capable
- private-key-minimizing
- designed around Codex workflows

Compared with traditional DevSecOps tools, BHA should be:

- agent-aware
- tool-call-aware
- resume-aware
- compaction-aware
- multi-actor-aware
- capability-gated before high-risk action

The distinction matters. BHA is neither a generic policy engine nor a full agent operating system.
It is the bounded autonomy layer for software project advancement.

### 27.5 Future Compatibility Requirements

To stay compatible with agent-native evolution, BHA should preserve these extension points:

- stable `actor_id` and `actor_type`
- stable `action_class`
- structured `ToolAction` input
- structured `ToolRisk` output
- stable reason codes
- ledger event ids and parent ids
- capability ids and payload hashes
- policy hash
- trace-compatible timestamps
- optional correlation ids for future spans
- external tool identity fields
- checkpoint and closeout artifacts that can be converted into attestations

These fields cost little in v1 and protect the future shape of the system.

### 27.6 Advanced Reference Links

Primary advanced references:

- Microsoft Agent Governance Toolkit announcement: https://opensource.microsoft.com/blog/2026/04/02/introducing-the-agent-governance-toolkit-open-source-runtime-security-for-ai-agents/
- OWASP Top 10 for Agentic Applications 2026: https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/
- MCP authorization specification: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- OpenTelemetry GenAI semantic conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- OWASP Top 10 for LLM Applications 2025: https://owasp.org/www-project-top-10-for-large-language-model-applications/

Emerging references should be rechecked before adoption because agent governance is still changing
quickly.

### 27.7 Design Conclusion

The mature references in Section 26 keep BHA grounded. The agent-native references in this section
keep BHA from becoming outdated.

The correct strategy is:

- adopt stable concepts now
- preserve extension points for agent-native standards
- avoid large or immature dependencies in v1
- revisit the watchlist after the local verifier and capability gate are proven
