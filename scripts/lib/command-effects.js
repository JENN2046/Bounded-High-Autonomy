'use strict';

const EFFECT_READ_ONLY = 'read_only';
const EFFECT_LEDGER_WRITE = 'ledger_write';
const EFFECT_LOCAL_ONLY_WRITE = 'local_only_write';
const EFFECT_EXTERNAL_GUARDED = 'external_guarded';

const STATIC_COMMAND_EFFECTS = Object.freeze({
  'check': EFFECT_LEDGER_WRITE,
  'assert-deny': EFFECT_LEDGER_WRITE,
  'exec': EFFECT_LEDGER_WRITE,
  'inspect': EFFECT_READ_ONLY,
  'validate': EFFECT_LEDGER_WRITE,
  'verify': EFFECT_LEDGER_WRITE,
  'checkpoint': EFFECT_LEDGER_WRITE,
  'push-prep': EFFECT_LOCAL_ONLY_WRITE,
  'signed-payload-status': EFFECT_READ_ONLY,
  'operator-signer-preflight': EFFECT_READ_ONLY,
  'recover-status': EFFECT_READ_ONLY,
  'evidence-ux-status': EFFECT_READ_ONLY,
  'repair-evidence': EFFECT_LEDGER_WRITE,
  'git-push-capability-flow': EFFECT_READ_ONLY,
  'rollback-drill': EFFECT_READ_ONLY,
  'verify-signed-capability': EFFECT_READ_ONLY,
  'capability-selftest': EFFECT_LEDGER_WRITE,
  'hook-status': EFFECT_READ_ONLY,
  'gate-status': EFFECT_READ_ONLY,
  'capability-framework-status': EFFECT_READ_ONLY,
  'council-status': EFFECT_READ_ONLY,
  'proof-vocabulary-status': EFFECT_READ_ONLY,
  'bootstrap-status': EFFECT_READ_ONLY,
  'proof-negative-matrix-status': EFFECT_READ_ONLY,
  'stable-exit-status': EFFECT_READ_ONLY,
  'stable-exit-review': EFFECT_READ_ONLY,
  'next-local-plan-status': EFFECT_READ_ONLY,
  'long-term-goal-status': EFFECT_READ_ONLY,
  'audit-v2-preview': EFFECT_READ_ONLY,
  'audit-v1-stable': EFFECT_READ_ONLY,
  'audit-v12': EFFECT_READ_ONLY,
  'regression-selftest': EFFECT_LOCAL_ONLY_WRITE
});

function hasFlag(args, name) {
  return Array.isArray(args) && args.includes(name);
}

function hasOption(args, name) {
  if (!Array.isArray(args)) {
    return false;
  }
  const index = args.indexOf(name);
  return index !== -1 && index < args.length - 1;
}

function getOptionValue(args, name) {
  if (!Array.isArray(args)) {
    return null;
  }
  const index = args.indexOf(name);
  if (index === -1 || index >= args.length - 1) {
    return null;
  }
  return args[index + 1];
}

function capabilityTypeFromJsonArg(args) {
  const text = getOptionValue(args, '--json');
  if (!text) {
    return null;
  }
  try {
    const payload = JSON.parse(text);
    return String(payload.capability_type || payload.type || '');
  } catch (error) {
    return null;
  }
}

function issueCapabilityEffect(args) {
  if (hasOption(args, '--file')) {
    return EFFECT_LOCAL_ONLY_WRITE;
  }
  return capabilityTypeFromJsonArg(args) === 'git_push'
    ? EFFECT_LOCAL_ONLY_WRITE
    : EFFECT_LEDGER_WRITE;
}

function consumeCapabilityEffect(args) {
  return getOptionValue(args, '--for') === 'git_push'
    ? EFFECT_LOCAL_ONLY_WRITE
    : EFFECT_LEDGER_WRITE;
}

function commandEffect(command, args) {
  const normalized = String(command || '');
  if (normalized === 'closeout') {
    return hasFlag(args, '--record') ? EFFECT_LEDGER_WRITE : EFFECT_READ_ONLY;
  }
  if (normalized === 'make-push-payload') {
    return hasOption(args, '--out') ? EFFECT_LOCAL_ONLY_WRITE : EFFECT_READ_ONLY;
  }
  if (normalized === 'prepush-check') {
    return hasFlag(args, '--preflight') ? EFFECT_READ_ONLY : EFFECT_EXTERNAL_GUARDED;
  }
  if (normalized === 'issue-capability') {
    return issueCapabilityEffect(args);
  }
  if (normalized === 'consume-capability') {
    return consumeCapabilityEffect(args);
  }
  return STATIC_COMMAND_EFFECTS[normalized] || EFFECT_READ_ONLY;
}

function effectAllowsTrackedWrite(effect) {
  return effect === EFFECT_LEDGER_WRITE;
}

function effectAllowsLocalWrite(effect) {
  return effect === EFFECT_LEDGER_WRITE ||
    effect === EFFECT_LOCAL_ONLY_WRITE ||
    effect === EFFECT_EXTERNAL_GUARDED;
}

function effectIsReadOnly(effect) {
  return effect === EFFECT_READ_ONLY;
}

module.exports = {
  EFFECT_READ_ONLY,
  EFFECT_LEDGER_WRITE,
  EFFECT_LOCAL_ONLY_WRITE,
  EFFECT_EXTERNAL_GUARDED,
  commandEffect,
  effectAllowsTrackedWrite,
  effectAllowsLocalWrite,
  effectIsReadOnly
};
