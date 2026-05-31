'use strict';

const crypto = require('crypto');

function stable(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stable).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => {
      return JSON.stringify(key) + ':' + stable(value[key]);
    }).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function capabilityType(payload) {
  return String(payload.type || payload.for || payload.capability || '').trim();
}

function capabilityTypePolicyFromLists(type, productionTypes, alwaysDenied) {
  const normalized = String(type || '').trim();
  if (!normalized) {
    return { allowed: false, reason: 'CAPABILITY_TYPE_MISSING', type: normalized };
  }
  if ((alwaysDenied || []).includes(normalized)) {
    return { allowed: false, reason: 'DISALLOWED_CAPABILITY_TYPE', type: normalized };
  }
  if (!(productionTypes || []).includes(normalized)) {
    return { allowed: false, reason: 'CAPABILITY_TYPE_NOT_SUPPORTED', type: normalized };
  }
  return { allowed: true, reason: 'CAPABILITY_TYPE_SUPPORTED', type: normalized };
}

function capabilityRequestPayload(payload) {
  const copy = Object.assign({}, payload || {});
  delete copy.signature;
  delete copy.payload_hash;
  return copy;
}

function capabilityPayloadHash(payload) {
  return sha256(stable(capabilityRequestPayload(payload)));
}

function capabilitySignablePayload(payload) {
  const copy = Object.assign({}, payload || {});
  delete copy.signature;
  return copy;
}

function capabilitySignatureInput(payload) {
  return stable(capabilitySignablePayload(payload));
}

function signingKeyPurposeAllowedForCapability(key, type) {
  if (!key) {
    return false;
  }
  if (String(type) === 'git_push') {
    return key.purpose === 'owner';
  }
  return false;
}

function signingKeyPurposeResult(key, type) {
  return {
    key_purpose: key && key.purpose ? key.purpose : 'UNSPECIFIED',
    required_key_purpose: String(type) === 'git_push' ? 'owner' : 'UNSUPPORTED_CAPABILITY_TYPE'
  };
}

function normalizeTrustedSigningKeyItem(item) {
  if (item && typeof item === 'object') {
    return {
      id: String(item.id || item.key_id || ''),
      purpose: item.purpose ? String(item.purpose) : null,
      public_key_pem: item.public_key_pem || item.publicKeyPem || null
    };
  }
  return { id: String(item), purpose: null, public_key_pem: null };
}

function canonicalPayloadHashFormat(value) {
  return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function canonicalSignedCapabilityReason(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'CAPABILITY_JSON_OBJECT_REQUIRED';
  }
  if ((payload.payload && typeof payload.payload === 'object') ||
      (payload.signature && typeof payload.signature === 'object')) {
    return 'CAPABILITY_ENVELOPE_UNSUPPORTED_EXPECT_FLAT';
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'head_sha')) {
    return 'CAPABILITY_FIELD_HEAD_REQUIRED_NOT_HEAD_SHA';
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'payload_hash') &&
      !canonicalPayloadHashFormat(payload.payload_hash)) {
    return 'CAPABILITY_PAYLOAD_HASH_FORMAT_INVALID_EXPECT_RAW_HEX';
  }
  if (payload.algorithm !== 'ed25519') {
    return 'CAPABILITY_ALGORITHM_UNSUPPORTED';
  }
  if (payload.signature_encoding !== 'base64') {
    return 'CAPABILITY_SIGNATURE_ENCODING_UNSUPPORTED';
  }
  if (payload.payload_hash_format !== 'sha256-hex') {
    return 'CAPABILITY_PAYLOAD_HASH_FORMAT_UNSUPPORTED';
  }
  if (!payload.signature || typeof payload.signature !== 'string' || !payload.signing_key_id) {
    return 'UNSIGNED_CAPABILITY_INVALID';
  }
  return null;
}

function capabilitySchemaReason(payload, expectedSchema) {
  if (!payload || payload.schema !== expectedSchema) {
    return 'CAPABILITY_SCHEMA_UNSUPPORTED';
  }
  return null;
}

function capabilityIdReason(payload) {
  if (!payload || (!payload.capability_id && !payload.id)) {
    return 'CAPABILITY_ID_MISSING';
  }
  return null;
}

function capabilityRunIdReason(payload, expectedRunId) {
  if (!payload || payload.run_id !== expectedRunId) {
    return 'CAPABILITY_RUN_ID_MISMATCH';
  }
  return null;
}

function capabilityPolicyMissionHashReason(payload, expectedPolicyHash, expectedMissionHash) {
  if (!payload || payload.policy_hash !== expectedPolicyHash) {
    return 'CAPABILITY_POLICY_HASH_MISMATCH';
  }
  if (payload.mission_hash !== expectedMissionHash) {
    return 'CAPABILITY_MISSION_HASH_MISMATCH';
  }
  return null;
}

function missingBindingFields(payload, requiredFields) {
  return (requiredFields || []).filter((field) => {
    return !payload || !payload[field];
  });
}

function capabilityBindingMissingReason(payload, requiredFields) {
  return missingBindingFields(payload, requiredFields).length > 0
    ? 'CAPABILITY_BINDING_MISSING'
    : null;
}

function capabilityLedgerHeadReason(payload, expectedLedgerHeadHash) {
  if (!payload || payload.ledger_head_hash !== expectedLedgerHeadHash) {
    return 'CAPABILITY_LEDGER_HEAD_MISMATCH';
  }
  return null;
}

function capabilityOneUseReason(payload) {
  if (!payload || payload.one_use !== true) {
    return 'CAPABILITY_ONE_USE_REQUIRED';
  }
  return null;
}

function isExpired(expiresAt, now) {
  const millis = Date.parse(String(expiresAt || ''));
  const nowMillis = Number(now);
  return Number.isNaN(millis) || !Number.isFinite(nowMillis) || millis <= nowMillis;
}

function capabilityExpirationReason(expiresAt, now) {
  return isExpired(expiresAt, now) ? 'CAPABILITY_EXPIRED' : null;
}

function gitPushCommandReason(payload) {
  if (!payload || payload.command !== `git push ${payload.remote} ${payload.branch}`) {
    return 'CAPABILITY_COMMAND_MISMATCH';
  }
  return null;
}

module.exports = {
  capabilityType,
  capabilityTypePolicyFromLists,
  capabilityRequestPayload,
  capabilityPayloadHash,
  capabilitySignablePayload,
  capabilitySignatureInput,
  signingKeyPurposeAllowedForCapability,
  signingKeyPurposeResult,
  normalizeTrustedSigningKeyItem,
  canonicalPayloadHashFormat,
  canonicalSignedCapabilityReason,
  capabilitySchemaReason,
  capabilityIdReason,
  capabilityRunIdReason,
  capabilityPolicyMissionHashReason,
  missingBindingFields,
  capabilityBindingMissingReason,
  capabilityLedgerHeadReason,
  capabilityOneUseReason,
  isExpired,
  capabilityExpirationReason,
  gitPushCommandReason
};
