#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BHA_DIR = path.join(ROOT, '.bha');
const MISSION_PATH = path.join(BHA_DIR, 'mission.yaml');
const POLICY_PATH = path.join(BHA_DIR, 'policy.yaml');
const STATE_PATH = path.join(BHA_DIR, 'state.json');
const LEDGER_PATH = path.join(BHA_DIR, 'ledger.jsonl');
const CAPABILITIES_PATH = path.join(BHA_DIR, 'capabilities.jsonl');
const VALIDATION_PATH = path.join(BHA_DIR, 'validation.yaml');
const ROLLBACK_PATH = path.join(BHA_DIR, 'rollback.md');
const RUN_SCRIPT = path.join(ROOT, 'scripts', 'bha-run.js');
const VERIFY_SCRIPT = path.join(ROOT, 'scripts', 'bha-verify.js');
const PRE_PUSH_PATH = path.join(ROOT, '.githooks', 'pre-push');
const ROOT_REAL = fs.realpathSync.native(ROOT);

const VALIDATION_INPUTS = [
  MISSION_PATH,
  POLICY_PATH,
  VALIDATION_PATH,
  ROLLBACK_PATH,
  RUN_SCRIPT,
  VERIFY_SCRIPT,
  PRE_PUSH_PATH
];

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

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

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function readJsonStrict(file) {
  return JSON.parse(readText(file));
}

function readJsonl(file, issues, code) {
  if (!fs.existsSync(file)) {
    issues.push({ code, severity: 'FAIL', message: `${rel(file)} is missing` });
    return [];
  }
  const text = readText(file);
  const events = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') {
      return;
    }
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      issues.push({ code: `${code}_INVALID_JSONL`, severity: 'FAIL', message: `${rel(file)}:${index + 1}: ${error.message}` });
    }
  });
  return events;
}

function eventHash(event) {
  const copy = Object.assign({}, event);
  delete copy.event_hash;
  return sha256(stable(copy));
}

function capabilityHash(event) {
  const copy = Object.assign({}, event);
  delete copy.event_hash;
  return sha256(stable(copy));
}

function trustedSigningKeys(policy) {
  return ((((policy || {}).capabilities || {}).trusted_signing_keys) || []).map((item) => {
    if (item && typeof item === 'object') {
      return {
        id: String(item.id || item.key_id || ''),
        public_key_pem: item.public_key_pem || item.publicKeyPem || null
      };
    }
    return { id: String(item), public_key_pem: null };
  }).filter((item) => item.id);
}

function trustedSigningKey(policy, id) {
  return trustedSigningKeys(policy).find((item) => item.id === String(id));
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

function capabilitySignatureValid(payload, key) {
  if (!payload || !payload.signature || !key || !key.public_key_pem) {
    return false;
  }
  try {
    return crypto.verify(
      null,
      Buffer.from(stable(capabilitySignablePayload(payload))),
      key.public_key_pem,
      Buffer.from(String(payload.signature), 'base64')
    );
  } catch (_error) {
    return false;
  }
}

function isExpired(expiresAt, now) {
  const millis = Date.parse(String(expiresAt || ''));
  return Number.isNaN(millis) || millis <= (now || Date.now());
}

function capabilityRevoked(capabilities, id) {
  return capabilities.some((event) => {
    return event.type === 'capability_revoke' &&
      event.payload &&
      event.payload.capability_id === id &&
      event.payload.valid !== false;
  });
}

function capabilityTypeFromRequest(requested) {
  return String((requested || {}).type || (requested || {}).for || (requested || {}).capability || '').trim();
}

function commandName(command) {
  return path.basename(String(command || '')).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

function normalizeRepoPath(value) {
  let text = String(value || '').trim().replace(/^"|"$/g, '').replace(/\\/g, '/');
  while (text.startsWith('./')) {
    text = text.slice(2);
  }
  const parentEscape = text === '..' || text.startsWith('../') || text.includes('/../') || text.endsWith('/..');
  if (process.platform === 'win32') {
    text = text.toLowerCase();
  }
  return { path: text, parentEscape };
}

function deniedPathPatterns(mission, policy) {
  const missionPatterns = Array.isArray((mission || {}).denied_paths) ? mission.denied_paths : [];
  const policyPatterns = policy && policy.deny && Array.isArray(policy.deny.path_patterns) ? policy.deny.path_patterns : [];
  return missionPatterns.concat(policyPatterns);
}

function deniedPathMatch(pathText, mission, policy) {
  const normalized = normalizeRepoPath(pathText);
  if (normalized.parentEscape) {
    return { denied: true, pattern: '..', code: 'PATH_PARENT_ESCAPE', path: normalized.path };
  }
  for (const pattern of deniedPathPatterns(mission, policy)) {
    const normalizedPattern = normalizeRepoPath(pattern);
    let item = normalizedPattern.path;
    if (item.endsWith('/**')) {
      item = item.slice(0, -3);
    }
    if (item.endsWith('.*')) {
      const prefix = item.slice(0, -2);
      if (normalized.path === prefix || normalized.path.startsWith(prefix + '.')) {
        return { denied: true, pattern: normalizedPattern.path, code: 'DENIED_PATH_TOUCHED', path: normalized.path };
      }
    } else if (normalized.path === item || normalized.path.startsWith(item + '/')) {
      return { denied: true, pattern: normalizedPattern.path, code: 'DENIED_PATH_TOUCHED', path: normalized.path };
    }
  }
  return { denied: false, path: normalized.path };
}

function isInsideRoot(file) {
  const relative = path.relative(ROOT_REAL, file);
  if (process.platform === 'win32') {
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function verifyCanonicalPathTarget(pathText, mission, policy, issues) {
  const normalized = normalizeRepoPath(pathText);
  if (normalized.parentEscape) {
    issues.push({ code: 'PATH_PARENT_ESCAPE', severity: 'FAIL', message: `${pathText} contains a parent path escape` });
    return;
  }
  const cleanPath = String(pathText || '').trim().replace(/^"|"$/g, '').replace(/[\\/]+$/g, '');
  if (!cleanPath) {
    return;
  }
  const absolute = path.resolve(ROOT, cleanPath);
  if (!isInsideRoot(absolute)) {
    issues.push({ code: 'PATH_OUTSIDE_REPO', severity: 'FAIL', message: `${pathText} resolves outside the repository` });
    return;
  }
  if (!fs.existsSync(absolute)) {
    return;
  }
  let real;
  try {
    real = fs.realpathSync.native(absolute);
  } catch (_error) {
    return;
  }
  if (!isInsideRoot(real)) {
    issues.push({ code: 'PATH_OUTSIDE_REPO', severity: 'FAIL', message: `${pathText} realpath resolves outside the repository` });
    return;
  }
  const realRelative = path.relative(ROOT_REAL, real).replace(/\\/g, '/');
  const deniedTarget = deniedPathMatch(realRelative, mission, policy);
  if (deniedTarget.denied) {
    issues.push({ code: 'DENIED_PATH_TOUCHED', severity: 'FAIL', message: `${pathText} realpath matches denied path ${deniedTarget.pattern}` });
  }
}

function listFromPolicy(policy, section, fallback) {
  return (policy && policy.deny && Array.isArray(policy.deny[section])) ? policy.deny[section] : fallback;
}

function classifyForbidden(argv, policy) {
  const cmd = commandName(argv[0]);
  const args = (argv || []).slice(1).map(String);
  const first = (args[0] || '').toLowerCase();
  const network = listFromPolicy(policy, 'network_commands', ['curl', 'wget']);
  const providers = listFromPolicy(policy, 'provider_commands', ['openai', 'anthropic', 'gemini']);
  const memory = listFromPolicy(policy, 'memory_commands', ['codex-memory', 'dailynote']);
  const gitRemote = listFromPolicy(policy, 'git_remote_subcommands', ['push', 'pull', 'fetch', 'clone', 'ls-remote', 'submodule']);
  const destructive = listFromPolicy(policy, 'destructive_commands', ['rm', 'rmdir', 'del']);

  if (network.map(commandName).includes(cmd)) {
    return { category: 'network', rule: 'DENY_NETWORK_COMMAND' };
  }
  if (providers.map(commandName).includes(cmd)) {
    return { category: 'provider_call', rule: 'DENY_PROVIDER_COMMAND' };
  }
  if (memory.map(commandName).includes(cmd)) {
    return { category: 'memory_write', rule: 'DENY_MEMORY_COMMAND' };
  }
  if (destructive.map(commandName).includes(cmd)) {
    return { category: 'destructive', rule: 'DENY_DESTRUCTIVE_COMMAND' };
  }
  if (cmd === 'git' && gitRemote.map((item) => String(item).toLowerCase()).includes(first)) {
    if (first === 'push' && args.some((arg) => /^--force($|-|=)/.test(arg))) {
      return { category: 'force_push', rule: 'DENY_FORCE_PUSH' };
    }
    return { category: 'git_remote', rule: 'DENY_GIT_REMOTE' };
  }
  return null;
}

function shouldScrubEnvKey(key) {
  const upper = String(key).toUpperCase();
  return upper.endsWith('_API_KEY') ||
    upper.endsWith('_TOKEN') ||
    upper.endsWith('_SECRET') ||
    upper.startsWith('OPENAI_') ||
    upper.startsWith('ANTHROPIC_') ||
    upper.startsWith('GEMINI_') ||
    upper === 'GOOGLE_API_KEY' ||
    upper.startsWith('AZURE_OPENAI_') ||
    upper.startsWith('AWS_') ||
    upper === 'GITHUB_TOKEN' ||
    upper === 'GH_TOKEN' ||
    upper === 'HTTP_PROXY' ||
    upper === 'HTTPS_PROXY' ||
    upper === 'ALL_PROXY' ||
    upper === 'NO_PROXY';
}

function scrubbedEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!shouldScrubEnvKey(key)) {
      env[key] = value;
    }
  }
  return env;
}

function runCommand(argv) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: ROOT,
        env: scrubbedEnv(),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ exit_code: null, stdout: '', stderr: '', error: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolve({ exit_code: null, stdout, stderr, error: error.message });
    });
    child.on('close', (code, signal) => {
      resolve({ exit_code: code, signal, stdout, stderr, error: null });
    });
  });
}

function validationInputsHash() {
  const entries = VALIDATION_INPUTS.map((file) => {
    if (!fs.existsSync(file)) {
      return { path: rel(file), status: 'MISSING', sha256: null };
    }
    return { path: rel(file), status: 'PRESENT', sha256: sha256(readText(file)) };
  });
  return sha256(stable(entries));
}

function loadRequiredFiles(issues) {
  const out = {};
  for (const [name, file] of Object.entries({
    mission: MISSION_PATH,
    policy: POLICY_PATH,
    state: STATE_PATH,
    validation: VALIDATION_PATH
  })) {
    if (!fs.existsSync(file)) {
      issues.push({ code: `${name.toUpperCase()}_MISSING`, severity: 'FAIL', message: `${rel(file)} is missing` });
      out[name] = null;
      continue;
    }
    try {
      out[name] = readJsonStrict(file);
    } catch (error) {
      issues.push({ code: `${name.toUpperCase()}_INVALID_JSON`, severity: 'FAIL', message: `${rel(file)} must be strict JSON: ${error.message}` });
      out[name] = null;
    }
  }
  return out;
}

function verifyLedger(events, state, issues) {
  let previous = null;
  events.forEach((event, index) => {
    const expectedPrev = previous || 'GENESIS';
    if (event.prev_hash !== expectedPrev) {
      issues.push({ code: 'LEDGER_PREV_HASH_MISMATCH', severity: 'FAIL', message: `ledger event ${index + 1} prev_hash mismatch` });
    }
    const computed = eventHash(event);
    if (event.event_hash !== computed) {
      issues.push({ code: 'LEDGER_EVENT_HASH_MISMATCH', severity: 'FAIL', message: `ledger event ${index + 1} event_hash mismatch` });
    }
    previous = event.event_hash || computed;
  });
  const head = events.length ? events[events.length - 1].event_hash : null;
  if (state && state.ledger_head_hash !== head) {
    issues.push({ code: 'STATE_LEDGER_HEAD_MISMATCH', severity: 'FAIL', message: 'state.ledger_head_hash does not match ledger head' });
  }
  if (state && state.ledger_event_count !== events.length) {
    issues.push({ code: 'STATE_LEDGER_COUNT_MISMATCH', severity: 'FAIL', message: 'state.ledger_event_count does not match ledger length' });
  }
  return head;
}

function verifyForbiddenExecution(events, policy, issues) {
  for (const event of events) {
    const payload = event.payload || {};
    const command = payload.command || payload.argv;
    if (!Array.isArray(command)) {
      continue;
    }
    const forbidden = classifyForbidden(command, policy);
    if (payload.spawned === true && forbidden) {
      issues.push({
        code: 'FORBIDDEN_COMMAND_EXECUTED',
        severity: 'FAIL',
        message: `forbidden ${forbidden.category} command was spawned`,
        event_hash: event.event_hash
      });
    }
    if (payload.decision === 'DENY' && payload.spawned === true) {
      issues.push({
        code: 'DENIED_COMMAND_SPAWNED',
        severity: 'FAIL',
        message: 'a denied command was marked as spawned',
        event_hash: event.event_hash
      });
    }
  }
}

async function verifyDeniedPathTouched(mission, policy, issues, warnings) {
  const result = await runCommand(['git', 'status', '--short', '--untracked-files=all']);
  if (result.exit_code !== 0 || result.error) {
    warnings.push({ code: 'GIT_STATUS_UNKNOWN', severity: 'UNKNOWN', message: result.error || result.stderr.trim() || 'git status unavailable' });
    return;
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const status = line.slice(0, 2);
    const touched = line.slice(3).trim().replace(/.* -> /, '');
    const denied = deniedPathMatch(touched, mission, policy);
    if (denied.denied) {
      const code = status === '??' ? 'UNTRACKED_DENIED_PATH' : 'DENIED_PATH_TOUCHED';
      issues.push({ code, severity: 'FAIL', message: `${touched} matches denied path ${denied.pattern}` });
    }
    verifyCanonicalPathTarget(touched, mission, policy, issues);
  }
}

async function verifyTrackedDeniedPaths(mission, policy, issues, warnings) {
  const result = await runCommand(['git', 'ls-files', '-z']);
  if (result.exit_code !== 0 || result.error) {
    warnings.push({ code: 'GIT_LS_FILES_UNKNOWN', severity: 'UNKNOWN', message: result.error || result.stderr.trim() || 'git ls-files unavailable' });
    return;
  }
  for (const tracked of result.stdout.split('\0')) {
    if (!tracked) {
      continue;
    }
    const denied = deniedPathMatch(tracked, mission, policy);
    if (denied.denied) {
      issues.push({ code: 'DENIED_PATH_TOUCHED', severity: 'FAIL', message: `${tracked} matches denied path ${denied.pattern}` });
    }
    verifyCanonicalPathTarget(tracked, mission, policy, issues);
  }
}

function verifyValidation(state, validation, events, issues) {
  if (!state || !state.validation || state.validation.status === 'NOT_RECORDED') {
    issues.push({ code: 'VALIDATION_MISSING', severity: 'FAIL', message: 'validation has not been recorded' });
    return;
  }
  if (state.validation.status !== 'PASS') {
    issues.push({ code: 'VALIDATION_NOT_PASSING', severity: 'FAIL', message: `recorded validation status is ${state.validation.status}` });
  }
  if (state.validation.inputs_hash !== validationInputsHash()) {
    issues.push({ code: 'VALIDATION_STALE_INPUTS', severity: 'FAIL', message: 'validation inputs changed after validation was recorded' });
  }
  const required = validation && Array.isArray(validation.required_commands) ? validation.required_commands : [];
  const recorded = Array.isArray(state.validation.commands) ? state.validation.commands : [];
  if (recorded.length !== required.length) {
    issues.push({ code: 'VALIDATION_COMMAND_COUNT_MISMATCH', severity: 'FAIL', message: 'recorded validation command count does not match validation.yaml' });
  }
  for (const command of required) {
    const record = recorded.find((item) => item.id === command.id);
    if (!record) {
      issues.push({ code: 'VALIDATION_COMMAND_MISSING', severity: 'FAIL', message: `${command.id} is missing from recorded validation` });
      continue;
    }
    if (stable(record.argv) !== stable(command.argv)) {
      issues.push({ code: 'VALIDATION_COMMAND_STALE', severity: 'FAIL', message: `${command.id} argv differs from validation.yaml` });
    }
    if (stable(record.expect || {}) !== stable(command.expect || {})) {
      issues.push({ code: 'VALIDATION_EXPECTATION_STALE', severity: 'FAIL', message: `${command.id} expectation differs from validation.yaml` });
    }
    if (record.status !== 'PASS') {
      issues.push({ code: 'VALIDATION_COMMAND_FAILED', severity: 'FAIL', message: `${command.id} recorded status is ${record.status}` });
    }
  }
  const completion = events.find((event) => event.event_hash === state.validation.ledger_event_hash);
  if (!completion || completion.type !== 'validation_completed') {
    issues.push({ code: 'VALIDATION_LEDGER_EVENT_MISSING', severity: 'FAIL', message: 'state validation ledger event is missing' });
  }
}

function verifyClaims(events, capabilities, issues) {
  const disallowed = new Set(['provider_call', 'memory_write', 'deploy', 'release', 'tag', 'force_push', 'production_write', 'secret_read', 'mass_delete']);
  for (const event of events) {
    const payload = event.payload || {};
    const category = payload.category || payload.claim || payload.type;
    if (payload.spawned === true && disallowed.has(String(category))) {
      issues.push({ code: 'FORBIDDEN_CLAIM_EXECUTED', severity: 'FAIL', message: `${category} was claimed as executed`, event_hash: event.event_hash });
    }
  }
  for (const event of capabilities) {
    const payload = event.payload || {};
    const type = payload.capability_type || (payload.requested && (payload.requested.type || payload.requested.for));
    if (payload.valid === true && disallowed.has(String(type))) {
      issues.push({ code: 'DISALLOWED_CAPABILITY_VALID', severity: 'FAIL', message: `${type} capability was marked valid`, event_hash: event.event_hash });
    }
    if (event.type === 'capability_issue' && payload.valid === true) {
      const requested = payload.requested || {};
      if (!requested.signature || !requested.signing_key_id) {
        issues.push({ code: 'UNSIGNED_CAPABILITY_MARKED_VALID', severity: 'FAIL', message: 'unsigned capability_issue was marked valid', event_hash: event.event_hash });
      }
    }
  }
}

function verifyCapabilityIssue(event, policy, state, capabilities, ledger, issues) {
  const payload = event.payload || {};
  const requested = payload.requested || {};
  const trusted = new Set(trustedSigningKeys(policy).map((item) => item.id));
  const type = payload.capability_type || capabilityTypeFromRequest(requested);
  const disallowed = new Set((((policy || {}).capabilities || {}).disallowed_types || []).map((item) => String(item)));
  if (payload.valid !== true) {
    return;
  }
  if (disallowed.has(String(type))) {
    issues.push({ code: 'DISALLOWED_CAPABILITY_VALID', severity: 'FAIL', message: `${type} capability was marked valid`, event_hash: event.event_hash });
  }
  if (type !== 'git_push') {
    issues.push({ code: 'UNSUPPORTED_CAPABILITY_MARKED_VALID', severity: 'FAIL', message: `${type} capability was marked valid`, event_hash: event.event_hash });
  }
  if (!requested.signature || !requested.signing_key_id) {
    issues.push({ code: 'UNSIGNED_CAPABILITY_MARKED_VALID', severity: 'FAIL', message: 'unsigned capability_issue was marked valid', event_hash: event.event_hash });
  }
  if (trusted.size === 0) {
    issues.push({ code: 'CAPABILITY_VALID_WITHOUT_TRUSTED_KEYS', severity: 'FAIL', message: 'dry-run v1 has no trusted signing keys but a capability was marked valid', event_hash: event.event_hash });
  }
  const key = trustedSigningKey(policy, requested.signing_key_id);
  if (requested.signing_key_id && !trusted.has(String(requested.signing_key_id))) {
    issues.push({ code: 'UNKNOWN_SIGNING_KEY_MARKED_VALID', severity: 'FAIL', message: 'capability used an untrusted signing key', event_hash: event.event_hash });
  }
  if (requested.signing_key_id && trusted.has(String(requested.signing_key_id)) && !key.public_key_pem) {
    issues.push({ code: 'TRUSTED_SIGNING_KEY_HAS_NO_PUBLIC_KEY', severity: 'FAIL', message: 'trusted signing key has no public key', event_hash: event.event_hash });
  }
  if (requested.payload_hash && requested.payload_hash !== capabilityPayloadHash(requested)) {
    issues.push({ code: 'CAPABILITY_PAYLOAD_HASH_MISMATCH', severity: 'FAIL', message: 'capability payload_hash mismatch', event_hash: event.event_hash });
  }
  if (key && key.public_key_pem && !capabilitySignatureValid(requested, key)) {
    issues.push({ code: 'CAPABILITY_SIGNATURE_INVALID', severity: 'FAIL', message: 'capability signature is invalid', event_hash: event.event_hash });
  }
  if (state && requested.run_id !== state.run_id) {
    issues.push({ code: 'CAPABILITY_RUN_ID_MISMATCH', severity: 'FAIL', message: 'valid capability run_id does not match state', event_hash: event.event_hash });
  }
  if (!requested.remote || !requested.branch || !requested.head || !requested.ledger_head_hash || !requested.expires_at) {
    issues.push({ code: 'CAPABILITY_BINDING_MISSING', severity: 'FAIL', message: 'valid capability is missing required bindings', event_hash: event.event_hash });
  }
  const ledgerEvent = (ledger || []).find((item) => item.type === 'capability_capability_issue' &&
    item.payload &&
    item.payload.capability_event_hash === event.event_hash);
  if (!ledgerEvent) {
    issues.push({ code: 'CAPABILITY_LEDGER_EVENT_MISSING', severity: 'FAIL', message: 'valid capability has no linked ledger event', event_hash: event.event_hash });
  } else if (requested.ledger_head_hash !== ledgerEvent.prev_hash) {
    issues.push({ code: 'CAPABILITY_LEDGER_HEAD_MISMATCH', severity: 'FAIL', message: 'valid capability ledger_head_hash does not match issue-time ledger head', event_hash: event.event_hash });
  }
  if (requested.one_use !== true) {
    issues.push({ code: 'CAPABILITY_ONE_USE_REQUIRED', severity: 'FAIL', message: 'valid capability is not one_use', event_hash: event.event_hash });
  }
  if (isExpired(requested.expires_at)) {
    issues.push({ code: 'CAPABILITY_EXPIRED', severity: 'FAIL', message: 'valid capability is expired', event_hash: event.event_hash });
  }
  if (capabilityRevoked(capabilities, payload.capability_id)) {
    issues.push({ code: 'CAPABILITY_REVOKED', severity: 'FAIL', message: 'valid capability has been revoked', event_hash: event.event_hash });
  }
}

function verifyCapabilities(capabilities, policy, state, ledger, issues) {
  const issuesById = new Map();
  for (const event of capabilities) {
    if (event.event_hash !== capabilityHash(event)) {
      issues.push({ code: 'CAPABILITY_EVENT_HASH_MISMATCH', severity: 'FAIL', message: 'capability event_hash mismatch', event_hash: event.event_hash || 'UNKNOWN' });
    }
    if (event.type === 'capability_issue' && event.payload) {
      issuesById.set(event.payload.capability_id, { event_hash: event.event_hash, payload: event.payload });
      verifyCapabilityIssue(event, policy, state, capabilities, ledger, issues);
    }
  }
  const validConsumesById = new Map();
  for (const event of capabilities) {
    if (event.type === 'capability_consume' && event.payload && event.payload.valid === true) {
      const list = validConsumesById.get(event.payload.capability_id) || [];
      list.push(event);
      validConsumesById.set(event.payload.capability_id, list);
    }
  }
  for (const event of capabilities) {
    if (event.type !== 'capability_consume' || !event.payload || event.payload.valid !== true) {
      continue;
    }
    const issueRecord = issuesById.get(event.payload.capability_id);
    if (!issueRecord || issueRecord.payload.valid !== true) {
      issues.push({ code: 'CAPABILITY_CONSUMED_WITHOUT_VALID_ISSUE', severity: 'FAIL', message: 'capability consume was marked valid without a valid issue event', event_hash: event.event_hash });
      continue;
    }
    const issue = issueRecord.payload;
    const requested = issue.requested || {};
    const consumes = validConsumesById.get(event.payload.capability_id) || [];
    if (consumes.length !== 1) {
      issues.push({ code: 'CAPABILITY_REPLAY_DETECTED', severity: 'FAIL', message: 'capability has multiple valid consumes', event_hash: event.event_hash });
    }
    if (event.payload.issue_event_hash !== issueRecord.event_hash) {
      issues.push({ code: 'CAPABILITY_ISSUE_EVENT_MISMATCH', severity: 'FAIL', message: 'capability consume references the wrong issue event', event_hash: event.event_hash });
    }
    if (event.payload.for !== 'git_push' || issue.capability_type !== 'git_push') {
      issues.push({ code: 'CAPABILITY_ACTION_MISMATCH', severity: 'FAIL', message: 'capability consume action mismatch', event_hash: event.event_hash });
    }
    if (event.run_id !== (state && state.run_id) || requested.run_id !== (state && state.run_id)) {
      issues.push({ code: 'CAPABILITY_RUN_ID_MISMATCH', severity: 'FAIL', message: 'capability consume run_id mismatch', event_hash: event.event_hash });
    }
    if (event.payload.remote !== requested.remote) {
      issues.push({ code: 'CAPABILITY_REMOTE_MISMATCH', severity: 'FAIL', message: 'capability consume remote mismatch', event_hash: event.event_hash });
    }
    if (event.payload.branch !== requested.branch) {
      issues.push({ code: 'CAPABILITY_BRANCH_MISMATCH', severity: 'FAIL', message: 'capability consume branch mismatch', event_hash: event.event_hash });
    }
    if (event.payload.head !== requested.head) {
      issues.push({ code: 'CAPABILITY_HEAD_MISMATCH', severity: 'FAIL', message: 'capability consume HEAD mismatch', event_hash: event.event_hash });
    }
    if (capabilityRevoked(capabilities, event.payload.capability_id)) {
      issues.push({ code: 'CAPABILITY_REVOKED', severity: 'FAIL', message: 'consumed capability has been revoked', event_hash: event.event_hash });
    }
  }
}

function verifyRollback(issues) {
  if (!fs.existsSync(ROLLBACK_PATH)) {
    issues.push({ code: 'ROLLBACK_MISSING', severity: 'FAIL', message: '.bha/rollback.md is missing' });
    return;
  }
  const text = readText(ROLLBACK_PATH).trim();
  if (!text || !/rollback/i.test(text)) {
    issues.push({ code: 'ROLLBACK_INCOMPLETE', severity: 'FAIL', message: '.bha/rollback.md does not contain rollback guidance' });
  }
}

async function main() {
  const issues = [];
  const warnings = [];
  const files = loadRequiredFiles(issues);
  const ledger = readJsonl(LEDGER_PATH, issues, 'LEDGER');
  const capabilities = readJsonl(CAPABILITIES_PATH, issues, 'CAPABILITIES');
  const head = verifyLedger(ledger, files.state, issues);
  verifyForbiddenExecution(ledger, files.policy, issues);
  verifyValidation(files.state, files.validation, ledger, issues);
  verifyClaims(ledger, capabilities, issues);
  verifyCapabilities(capabilities, files.policy, files.state, ledger, issues);
  verifyRollback(issues);
  await verifyDeniedPathTouched(files.mission, files.policy, issues, warnings);
  await verifyTrackedDeniedPaths(files.mission, files.policy, issues, warnings);

  const ok = issues.length === 0;
  console.log(JSON.stringify({
    ok,
    status: ok ? 'PASS' : 'FAIL',
    ledger_head_hash: head || 'NOT_RECORDED',
    ledger_events: ledger.length,
    validation_status: files.state && files.state.validation ? files.state.validation.status : 'NOT_RECORDED',
    issues,
    warnings
  }));
  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    status: 'FAIL',
    issues: [{ code: 'VERIFY_EXCEPTION', severity: 'FAIL', message: error.message }],
    warnings: []
  }));
  process.exitCode = 1;
});
