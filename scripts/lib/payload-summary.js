'use strict';

function currentPayloadContext(remote, branch, head, ledgerHeadHash, policyHashValue, missionHashValue) {
  return {
    remote,
    branch,
    head,
    ledger_head_hash: ledgerHeadHash || null,
    policy_hash: policyHashValue,
    mission_hash: missionHashValue
  };
}

function defaultReasonDetails(reasons) {
  return Array.from(new Set(reasons || [])).map((code) => ({ code }));
}

function capabilityFileSummary(file, signed, context, options) {
  const opts = options || {};
  const currentContext = context || currentPayloadContext(null, null, null, null, opts.policyHash || null, opts.missionHash || null);
  const reasonDetails = typeof opts.reasonDetails === 'function' ? opts.reasonDetails : defaultReasonDetails;
  const nowMs = Number(opts.nowMs);
  const payload = file && file.value && typeof file.value === 'object' && !Array.isArray(file.value)
    ? file.value
    : null;
  const summary = {
    path: file ? file.path : null,
    exists: file ? file.exists : false,
    json_valid: file ? file.json_valid : false
  };
  if (file && file.error) {
    summary.error = file.error;
  }
  if (!payload) {
    return summary;
  }
  summary.capability_id = payload.capability_id || payload.id || null;
  summary.remote = payload.remote || null;
  summary.branch = payload.branch || null;
  summary.head = payload.head || null;
  summary.ledger_head_hash = payload.ledger_head_hash || null;
  summary.expires_at = payload.expires_at || null;
  if (payload.expires_at) {
    const expiresAtMs = Date.parse(payload.expires_at);
    summary.expiry = Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) ? {
      valid: true,
      expired: nowMs >= expiresAtMs,
      seconds_until_expiry: Math.floor((expiresAtMs - nowMs) / 1000)
    } : {
      valid: Number.isFinite(expiresAtMs),
      expired: null,
      seconds_until_expiry: null
    };
  }
  summary.signing_key_id = payload.signing_key_id || null;
  summary.signature_present = Boolean(payload.signature);
  summary.payload_hash_present = Boolean(payload.payload_hash);
  const contextMismatchReasons = [];
  if (payload.remote !== currentContext.remote) {
    contextMismatchReasons.push('REMOTE_MISMATCH');
  }
  if (payload.branch !== currentContext.branch) {
    contextMismatchReasons.push('BRANCH_MISMATCH');
  }
  if (payload.head !== currentContext.head) {
    contextMismatchReasons.push('HEAD_MISMATCH');
  }
  if (currentContext.ledger_head_hash && payload.ledger_head_hash !== currentContext.ledger_head_hash) {
    contextMismatchReasons.push('LEDGER_HEAD_MISMATCH');
  }
  if (currentContext.policy_hash && payload.policy_hash !== currentContext.policy_hash) {
    contextMismatchReasons.push('POLICY_HASH_MISMATCH');
  }
  if (currentContext.mission_hash && payload.mission_hash !== currentContext.mission_hash) {
    contextMismatchReasons.push('MISSION_HASH_MISMATCH');
  }
  summary.current_context = currentContext;
  summary.matches_current_context = contextMismatchReasons.length === 0;
  if (contextMismatchReasons.length) {
    summary.context_mismatch_reasons = contextMismatchReasons;
    summary.context_mismatch_details = reasonDetails(contextMismatchReasons);
  }
  if (signed === true) {
    summary.safe_to_print = 'signature and private key material are not included in this summary';
  }
  return summary;
}

module.exports = {
  currentPayloadContext,
  capabilityFileSummary
};
