'use strict';

function powerShellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function protectedBaseBranch(branch) {
  return String(branch || '') === 'master';
}

function capabilityRequiredForBranch(branch) {
  return protectedBaseBranch(branch);
}

function standardProtectedBranchFlow(remote, branch) {
  const targetRemote = remote || 'origin';
  const targetBranch = branch || 'master';
  const remoteArg = powerShellSingleQuote(targetRemote);
  const branchArg = powerShellSingleQuote(targetBranch);
  return [
    'git switch -c codex/<topic-branch>',
    `node scripts/bha-run.js gate-status --remote ${remoteArg} --branch 'codex/<topic-branch>' --format json`,
    "push the topic branch without a signed capability when local evidence gates pass",
    `git push ${remoteArg} HEAD`,
    `open a pull request targeting ${branchArg} and wait for required check: BHA read-only gate`
  ];
}

function nextGateCommands(action, remote, branch) {
  const targetRemote = remote || 'origin';
  const targetBranch = branch || 'master';
  const payloadPath = '.bha/local/push-payload.json';
  const signedPath = '.bha/local/signed-push-capability.json';
  const remoteArg = powerShellSingleQuote(targetRemote);
  const branchArg = powerShellSingleQuote(targetBranch);
  const payloadArg = powerShellSingleQuote(payloadPath);
  const signedArg = powerShellSingleQuote(signedPath);
  const commands = {
    RUN_VERIFIER_AND_FIX_ISSUES: ['node scripts/bha-verify.js'],
    RESOLVE_VERIFIER_WARNINGS_OR_RECORD_CLOSEOUT: ['node scripts/bha-run.js closeout --record --format json'],
    RUN_VALIDATE_CHECKPOINT_CLOSEOUT: [
      'node scripts/bha-run.js validate',
      'node scripts/bha-run.js checkpoint --format json',
      'node scripts/bha-run.js closeout --record --format json'
    ],
    RUN_ROLLBACK_DRILL_OR_VALIDATE: ['node scripts/bha-run.js rollback-drill --format json', 'node scripts/bha-run.js validate'],
    RUN_CHECKPOINT: ['node scripts/bha-run.js checkpoint --format json'],
    RUN_CLOSEOUT_RECORD: ['node scripts/bha-run.js closeout --record --format json'],
    COMMIT_OR_RESOLVE_UNVERIFIED_WORKTREE_CHANGES: ['git status --short'],
    MAKE_SIGN_ISSUE_AND_CONSUME_GIT_PUSH_CAPABILITY: [
      `node scripts/bha-run.js make-push-payload --remote ${remoteArg} --branch ${branchArg} --expires-minutes 20 --key-id owner-main-pkcs8 --out ${payloadArg}`,
      `operator signs ${payloadPath} outside BHA and writes ${signedPath}`,
      `node scripts/bha-run.js verify-signed-capability --file ${signedArg}`,
      `node scripts/bha-run.js issue-capability --file ${signedArg}`,
      `node scripts/bha-run.js consume-capability --id <capability_id> --for git_push --remote ${remoteArg} --branch ${branchArg}`,
      `node scripts/bha-run.js prepush-check --preflight --internal-git-hook ${remoteArg}`
    ],
    ISSUE_AND_CONSUME_A_NEW_SIGNED_GIT_PUSH_CAPABILITY: [
      `node scripts/bha-run.js make-push-payload --remote ${remoteArg} --branch ${branchArg} --expires-minutes 20 --key-id owner-main-pkcs8 --out ${payloadArg}`,
      `operator signs ${payloadPath} outside BHA and writes ${signedPath}`,
      `node scripts/bha-run.js verify-signed-capability --file ${signedArg}`,
      `node scripts/bha-run.js issue-capability --file ${signedArg}`,
      `node scripts/bha-run.js consume-capability --id <capability_id> --for git_push --remote ${remoteArg} --branch ${branchArg}`
    ],
    READY_FOR_PREPUSH_PREFLIGHT_OR_PUSH: [
      `node scripts/bha-run.js prepush-check --preflight --internal-git-hook ${remoteArg}`,
      ...(protectedBaseBranch(targetBranch)
        ? [
          `protected ${branchArg} standard flow: push a topic branch, open a PR to ${branchArg}, and wait for BHA read-only gate`,
          `emergency-only direct push, if explicitly authorized and permitted by GitHub protection: git push ${remoteArg} ${branchArg}`
        ]
        : [`git push ${remoteArg} ${branchArg}`])
    ]
  };
  return commands[action] || [];
}

function gateNextActionContext(action, branch) {
  const conditionalPushActions = new Set([
    'MAKE_SIGN_ISSUE_AND_CONSUME_GIT_PUSH_CAPABILITY',
    'ISSUE_AND_CONSUME_A_NEW_SIGNED_GIT_PUSH_CAPABILITY',
    'READY_FOR_PREPUSH_PREFLIGHT_OR_PUSH'
  ]);
  if (conditionalPushActions.has(action)) {
    if (protectedBaseBranch(branch)) {
      return {
        next_action_required_now: false,
        next_action_condition: 'Only required if the operator chooses an emergency direct push to protected master. The standard remote flow is topic branch, pull request to master, and required check: BHA read-only gate.',
        next_action_scope: 'emergency_direct_push_to_protected_branch'
      };
    }
    return {
      next_action_required_now: false,
      next_action_condition: 'Only required if the operator chooses to perform a real git push.',
      next_action_scope: 'operator_chosen_git_push'
    };
  }
  return {
    next_action_required_now: true,
    next_action_condition: 'Required to restore local BHA evidence or gate readiness before any real git push.',
    next_action_scope: 'local_trust_repair'
  };
}

function pushRequirement(branch, action) {
  return {
    required_now: false,
    operator_controlled: true,
    reason: protectedBaseBranch(branch)
      ? 'BHA never requires an immediate push to protected master. Standard remote work uses a topic branch, pull request, and required check: BHA read-only gate; a master git_push capability is emergency-only.'
      : 'BHA allows ordinary topic branch push without a signed git_push capability when local evidence gates pass; PR required checks remain the remote trust gate.',
    capability_required_for_real_push: capabilityRequiredForBranch(branch),
    current_gate_action_if_operator_pushes: action
  };
}

function remoteBranchPolicy(branch) {
  if (protectedBaseBranch(branch)) {
    return {
      branch: branch || 'master',
      protected: true,
      standard_flow: 'topic branch -> pull request -> required check: BHA read-only gate',
      direct_push: 'emergency_only',
      required_check: 'BHA read-only gate',
      proof_boundary: 'This field documents the configured protected master workflow; current GitHub settings must be verified from GitHub for remote enforcement claims.'
    };
  }
  return {
    branch: branch || 'UNKNOWN',
    protected: false,
    standard_flow: 'topic branch push after local BHA evidence gate; PR required check validates remotely',
    direct_push: 'topic_branch_allowed_without_signed_capability'
  };
}

function protectedBranchPolicy(branch) {
  if (!protectedBaseBranch(branch)) {
    return null;
  }
  return {
    branch: branch || 'master',
    standard_flow: 'topic branch -> pull request -> required check: BHA read-only gate',
    direct_push: 'emergency_only',
    local_capability_meaning: 'local gate for an explicitly authorized emergency direct push, not the normal protected-branch workflow'
  };
}

function postPushStatusSummary(options) {
  const capability = options.capability || null;
  const checks = options.checks || null;
  const usedSession = options.usedSession || null;
  const remoteTracking = options.remoteTracking || {};
  const protectedBranch = protectedBaseBranch(options.branch);
  const replayBlocked = capability && capability.reason === 'CAPABILITY_REPLAY_DETECTED';
  const prePushReady = checks && Object.values(checks).every(Boolean);
  let phase = 'NEEDS_GIT_PUSH_CAPABILITY';
  if (prePushReady) {
    phase = 'PRE_PUSH_READY';
  } else if (replayBlocked && usedSession) {
    phase = 'PUSHED_CAPABILITY_USED_REPLAY_BLOCKED';
  } else if (replayBlocked) {
    phase = 'REPLAY_BLOCKED';
  }
  return {
    phase,
    pre_push_ready: prePushReady,
    pushed_capability_used: Boolean(usedSession),
    replay_blocked: Boolean(replayBlocked),
    remote_tracking_state_observed: Boolean(remoteTracking.observed),
    remote_tracking_matches_current_head: Boolean(remoteTracking.matches_current_head),
    capability_id: capability && capability.capability_id ? capability.capability_id : null,
    used_session_event_hash: usedSession ? usedSession.event_hash : null,
    remote_tracking: remoteTracking,
    next_operator_meaning: protectedBranch
      ? (replayBlocked
        ? 'The previous one-use git_push capability has been used. Protected master standard flow is topic branch, PR, and BHA read-only gate; generate a fresh master capability only for an explicitly authorized emergency direct push.'
        : (prePushReady
          ? 'A valid consumed git_push capability is ready for emergency direct push to protected master. Standard remote flow is topic branch, PR, and BHA read-only gate.'
          : 'No push to protected master is required now. Standard remote flow is topic branch, PR, and BHA read-only gate; generate a master capability only for an explicitly authorized emergency direct push.'))
      : (replayBlocked
        ? 'The previous one-use git_push capability has been used; if the operator chooses another real push, generate and sign a new capability first.'
        : (prePushReady ? 'Topic branch evidence gates are ready for ordinary push; signed capability is not required for this branch.' : 'No push is required now; ordinary topic branch push may proceed after local evidence gates pass.'))
  };
}

function authorizedRuntimeDirty(stdout) {
  const allowed = new Set([
    '.bha/capabilities.jsonl',
    '.bha/checkpoint.json',
    '.bha/ledger.jsonl',
    '.bha/state.json'
  ]);
  const lines = String(stdout || '').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    return true;
  }
  return lines.every((line) => {
    const touched = line.slice(3).trim().replace(/.* -> /, '').replace(/\\/g, '/');
    return allowed.has(touched);
  });
}

function validatedOrRuntimeDirty(stdout, validationInputs) {
  const allowed = new Set(validationInputs || []);
  [
    '.bha/capabilities.jsonl',
    '.bha/checkpoint.json',
    '.bha/ledger.jsonl',
    '.bha/state.json'
  ].forEach((file) => allowed.add(file));
  const lines = String(stdout || '').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    return true;
  }
  return lines.every((line) => {
    const touched = line.slice(3).trim().replace(/.* -> /, '').replace(/\\/g, '/');
    return allowed.has(touched);
  });
}

function gitStatusAllowedForLocalTrustRepair(status) {
  return status && status.ok === true &&
    (status.clean === true || authorizedRuntimeDirty(status.stdout));
}

function validationCommandPassed(state, id) {
  const commands = state && state.validation && Array.isArray(state.validation.commands)
    ? state.validation.commands
    : [];
  return commands.some((command) => command.id === id && command.status === 'PASS');
}

function prepushEvidenceGates(state, ledger, verify, deps) {
  const helpers = deps || {};
  const head = ledger.length ? ledger[ledger.length - 1].event_hash : null;
  const validation = state && state.validation ? state.validation : null;
  const checkpoint = helpers.readCheckpointFile();
  const checkpointEvent = checkpoint ? helpers.ledgerEventByHash(ledger, checkpoint.ledger_event_hash, 'checkpoint_written') : null;
  const newestCheckpoint = helpers.newestLedgerEventOfType(ledger, 'checkpoint_written');
  const closeoutEvent = state && state.closeout ? helpers.ledgerEventByHash(ledger, state.closeout.ledger_event_hash, 'closeout_completed') : null;
  const newestCloseout = helpers.newestLedgerEventOfType(ledger, 'closeout_completed');
  const rollbackChecks = helpers.rollbackDrillChecks();
  const gates = {
    verifier_pass: verify.ok === true && verify.parsed && verify.parsed.status === 'PASS',
    verifier_no_warnings: verify.parsed && Array.isArray(verify.parsed.warnings) && verify.parsed.warnings.length === 0,
    ledger_state_match: Boolean(state && head && state.ledger_head_hash === head && verify.parsed && verify.parsed.ledger_head_hash === head),
    validation_fresh: Boolean(validation &&
      validation.status === 'PASS' &&
      validation.inputs_hash === helpers.validationInputsHash() &&
      validation.policy_hash === helpers.policyHash() &&
      validation.mission_hash === helpers.missionHash() &&
      helpers.ledgerEventByHash(ledger, validation.ledger_event_hash, 'validation_completed')),
    rollback_recorded: rollbackChecks.every((check) => check.status === 'PASS') && validationCommandPassed(state, 'rollback_drill_readonly'),
    checkpoint_recorded: Boolean(checkpoint &&
      state &&
      state.last_checkpoint &&
      checkpointEvent &&
      newestCheckpoint &&
      newestCheckpoint.event_hash === checkpointEvent.event_hash &&
      state.last_checkpoint.ledger_event_hash === checkpointEvent.event_hash &&
      state.last_checkpoint_id === checkpoint.checkpoint_id &&
      checkpoint.verifier_status === 'PASS' &&
      checkpoint.checkpoint_binding &&
      checkpoint.checkpoint_binding.checkpoint_event_hash === checkpointEvent.event_hash),
    closeout_current: Boolean(state &&
      state.closeout &&
      closeoutEvent &&
      newestCloseout &&
      newestCloseout.event_hash === closeoutEvent.event_hash &&
      state.closeout.ledger_event_hash === closeoutEvent.event_hash &&
      state.closeout.final_ledger_head_hash === head &&
      closeoutEvent.event_hash === head)
  };
  return { gates, rollback_checks: rollbackChecks };
}

function firstFailedGate(checks) {
  for (const [key, value] of Object.entries(checks)) {
    if (value !== true) {
      return key.toUpperCase();
    }
  }
  return null;
}

function nextGateAction(checks, capability) {
  if (!checks.verifier_pass) {
    return 'RUN_VERIFIER_AND_FIX_ISSUES';
  }
  if (!checks.verifier_no_warnings) {
    return 'RESOLVE_VERIFIER_WARNINGS_OR_RECORD_CLOSEOUT';
  }
  if (!checks.clean_ledger || !checks.validation_fresh) {
    return 'RUN_VALIDATE_CHECKPOINT_CLOSEOUT';
  }
  if (!checks.rollback_recorded) {
    return 'RUN_ROLLBACK_DRILL_OR_VALIDATE';
  }
  if (!checks.checkpoint_recorded) {
    return 'RUN_CHECKPOINT';
  }
  if (!checks.closeout_current) {
    return 'RUN_CLOSEOUT_RECORD';
  }
  if (!checks.clean_git_status) {
    return 'COMMIT_OR_RESOLVE_UNVERIFIED_WORKTREE_CHANGES';
  }
  if (!checks.valid_consumed_capability || !checks.matching_run_id_remote_branch_head) {
    return capability && capability.reason === 'CAPABILITY_REPLAY_DETECTED'
      ? 'ISSUE_AND_CONSUME_A_NEW_SIGNED_GIT_PUSH_CAPABILITY'
      : 'MAKE_SIGN_ISSUE_AND_CONSUME_GIT_PUSH_CAPABILITY';
  }
  return 'READY_FOR_PREPUSH_PREFLIGHT_OR_PUSH';
}

module.exports = {
  powerShellSingleQuote,
  protectedBaseBranch,
  capabilityRequiredForBranch,
  standardProtectedBranchFlow,
  nextGateCommands,
  gateNextActionContext,
  pushRequirement,
  remoteBranchPolicy,
  protectedBranchPolicy,
  postPushStatusSummary,
  authorizedRuntimeDirty,
  validatedOrRuntimeDirty,
  gitStatusAllowedForLocalTrustRepair,
  validationCommandPassed,
  prepushEvidenceGates,
  firstFailedGate,
  nextGateAction
};
