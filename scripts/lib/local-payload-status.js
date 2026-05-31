'use strict';

function reasonMessage(code) {
  const messages = {
    REMOTE_MISMATCH: 'Payload is bound to a different git remote; regenerate it for the target remote before signing or using it.',
    BRANCH_MISMATCH: 'Payload is bound to a different git branch; regenerate it for the target branch before signing or using it.',
    HEAD_MISMATCH: 'Payload is bound to a different git HEAD; regenerate it for the current commit before signing or using it.',
    LEDGER_HEAD_MISMATCH: 'Payload is bound to an older ledger head; regenerate it after current validation/checkpoint/closeout evidence is recorded.',
    POLICY_HASH_MISMATCH: 'Payload is bound to a different policy hash; regenerate it under the current tracked policy.',
    MISSION_HASH_MISMATCH: 'Payload is bound to a different mission hash; regenerate it under the current tracked mission.',
    CAPABILITY_POLICY_HASH_MISMATCH: 'Signed capability verification failed because the payload policy hash does not match current policy.',
    CAPABILITY_MISSION_HASH_MISMATCH: 'Signed capability verification failed because the payload mission hash does not match current mission.',
    CAPABILITY_EXPIRED: 'Signed capability has expired; generate and sign a fresh payload if the operator chooses a real push.',
    PAYLOAD_EXPIRED: 'Local payload has expired; generate a fresh unsigned payload if the operator chooses a real push.',
    SIGNED_CAPABILITY_INVALID: 'Signed capability is not valid for the current gate context.'
  };
  return messages[code] || 'Payload is not usable for the current gate context; regenerate and sign a current payload if a real push is chosen.';
}

function reasonDetails(reasons) {
  return Array.from(new Set(reasons || [])).map((code) => ({
    code,
    message: reasonMessage(code)
  }));
}

function defaultPowerShellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function recoveryGitPushNextCommands(payloadStatus, targetRemote, targetBranch, quote) {
  const quoteValue = typeof quote === 'function' ? quote : defaultPowerShellSingleQuote;
  const remoteArg = quoteValue(targetRemote || 'origin');
  const branchArg = quoteValue(targetBranch || 'master');
  const currentUnsignedReady = payloadStatus &&
    payloadStatus.unsigned_matches_current_context === true &&
    (payloadStatus.next_payload_action === 'SIGN_CURRENT_UNSIGNED_PAYLOAD_OUTSIDE_BHA' ||
      payloadStatus.next_payload_action === 'SIGN_CURRENT_UNSIGNED_PAYLOAD_OUTSIDE_BHA_REPLACING_STALE_SIGNED_PAYLOAD');
  return [
    ...(currentUnsignedReady ? [] : [
      `node scripts/bha-run.js push-prep --remote ${remoteArg} --branch ${branchArg} --expires-minutes 20 --key-id owner-main-pkcs8 --format json --write-handoff`
    ]),
    `node scripts/bha-run.js operator-signer-preflight --remote ${remoteArg} --branch ${branchArg} --format json`,
    currentUnsignedReady
      ? 'operator signs existing .bha/local/push-payload.json outside BHA and writes .bha/local/signed-push-capability.json'
      : 'operator signs .bha/local/push-payload.json outside BHA and writes .bha/local/signed-push-capability.json',
    `node scripts/bha-run.js signed-payload-status --remote ${remoteArg} --branch ${branchArg} --format json`,
    `node scripts/bha-run.js gate-status --remote ${remoteArg} --branch ${branchArg} --format json`
  ];
}

function localPayloadIssue(kind, summary) {
  if (!summary || summary.exists !== true || summary.json_valid !== true) {
    return null;
  }
  const reasons = [];
  if (Array.isArray(summary.context_mismatch_reasons)) {
    reasons.push(...summary.context_mismatch_reasons);
  }
  if (summary.expiry && summary.expiry.expired === true) {
    reasons.push('PAYLOAD_EXPIRED');
  }
  if (summary.verification && summary.verification.ok !== true) {
    reasons.push(summary.verification.reason || 'SIGNED_CAPABILITY_INVALID');
  }
  if (!reasons.length) {
    return null;
  }
  return {
    kind,
    path: summary.path,
    capability_id: summary.capability_id || null,
    reasons: Array.from(new Set(reasons)),
    reason_details: reasonDetails(reasons),
    action: 'regenerate payload for current head and sign outside BHA'
  };
}

function localPayloadStatus(unsigned, signed) {
  const issues = [
    localPayloadIssue('unsigned_payload', unsigned),
    localPayloadIssue('signed_payload', signed)
  ].filter(Boolean);
  const unsignedPresent = Boolean(unsigned && unsigned.exists === true && unsigned.json_valid === true);
  const signedPresent = Boolean(signed && signed.exists === true && signed.json_valid === true);
  let nextPayloadAction = 'GENERATE_UNSIGNED_PAYLOAD_FOR_CURRENT_CONTEXT';
  if (issues.length) {
    const unsignedHasIssue = issues.some((issue) => issue.kind === 'unsigned_payload');
    nextPayloadAction = !unsignedHasIssue && unsignedPresent && unsigned.matches_current_context === true
      ? 'SIGN_CURRENT_UNSIGNED_PAYLOAD_OUTSIDE_BHA_REPLACING_STALE_SIGNED_PAYLOAD'
      : 'REGENERATE_UNSIGNED_PAYLOAD_AND_SIGN_CURRENT_CONTEXT';
  } else if (signedPresent && signed.verification && signed.verification.ok === true) {
    nextPayloadAction = 'USE_CURRENT_SIGNED_PAYLOAD_IF_GATE_CHECKS_PASS';
  } else if (unsignedPresent && unsigned.matches_current_context === true) {
    nextPayloadAction = 'SIGN_CURRENT_UNSIGNED_PAYLOAD_OUTSIDE_BHA';
  }
  const reasonCodes = Array.from(new Set(issues.flatMap((issue) => issue.reasons || [])));
  return {
    unsigned_present: unsignedPresent,
    signed_present: signedPresent,
    unsigned_matches_current_context: unsignedPresent
      ? unsigned.matches_current_context === true
      : null,
    signed_matches_current_context: signedPresent
      ? signed.matches_current_context === true
      : null,
    signed_verification_ok: signed && signed.verification
      ? signed.verification.ok === true
      : null,
    not_usable_local_files: issues,
    reason_codes: reasonCodes,
    reason_details: reasonDetails(reasonCodes),
    human_summary: issues.length
      ? 'One or more local payload files are stale, expired, mismatched, or invalid for the current gate context.'
      : 'No stale, expired, mismatched, or invalid local payload files were detected.',
    next_payload_action: nextPayloadAction
  };
}

module.exports = {
  reasonMessage,
  reasonDetails,
  recoveryGitPushNextCommands,
  localPayloadIssue,
  localPayloadStatus
};
