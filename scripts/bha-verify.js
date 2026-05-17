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
const CLOSEOUT_PATH = path.join(BHA_DIR, 'closeout.json');
const ROLLBACK_PATH = path.join(BHA_DIR, 'rollback.md');
const ROADMAP_PATH = path.join(BHA_DIR, 'roadmap.md');
const CHECKPOINT_PATH = path.join(BHA_DIR, 'checkpoint.json');
const RUN_SCRIPT = path.join(ROOT, 'scripts', 'bha-run.js');
const VERIFY_SCRIPT = path.join(ROOT, 'scripts', 'bha-verify.js');
const PRE_PUSH_PATH = path.join(ROOT, '.githooks', 'pre-push');
const DESIGN_PATH = path.join(ROOT, 'BHA_DESIGN.md');
const LONG_TERM_GOAL_AUDIT_PATH = path.join(ROOT, 'BHA_LONG_TERM_GOAL_AUDIT.md');
const STABILITY_PATH = path.join(ROOT, 'BHA_V1_STABILITY.md');
const CAPABILITY_FRAMEWORK_PATH = path.join(ROOT, 'BHA_V2_CAPABILITY_FRAMEWORK.md');
const COUNCIL_RUNTIME_PATH = path.join(ROOT, 'BHA_V2_COUNCIL_RUNTIME.md');
const AGENTS_PATH = path.join(ROOT, 'AGENTS.md');
const GITIGNORE_PATH = path.join(ROOT, '.gitignore');
const ROOT_REAL = fs.realpathSync.native(ROOT);

const VALIDATION_INPUTS = [
  DESIGN_PATH,
  LONG_TERM_GOAL_AUDIT_PATH,
  STABILITY_PATH,
  CAPABILITY_FRAMEWORK_PATH,
  COUNCIL_RUNTIME_PATH,
  AGENTS_PATH,
  GITIGNORE_PATH,
  MISSION_PATH,
  POLICY_PATH,
  VALIDATION_PATH,
  ROLLBACK_PATH,
  ROADMAP_PATH,
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

function withoutHashFields(value) {
  const copy = JSON.parse(JSON.stringify(value || {}));
  delete copy.policy_hash;
  delete copy.mission_hash;
  if (copy.metadata && typeof copy.metadata === 'object') {
    delete copy.metadata.policy_hash;
    delete copy.metadata.mission_hash;
  }
  return copy;
}

function policyHash(policy) {
  return sha256(stable(withoutHashFields(policy || readJsonStrict(POLICY_PATH))));
}

function missionHash(mission) {
  return sha256(stable(withoutHashFields(mission || readJsonStrict(MISSION_PATH))));
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function canonicalValidationText(file) {
  return readText(file).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
  return (((policy || {}).trusted_public_keys) || []).map((item) => {
    if (item && typeof item === 'object') {
      return {
        id: String(item.id || item.key_id || ''),
        purpose: item.purpose ? String(item.purpose) : null,
        public_key_pem: item.public_key_pem || item.publicKeyPem || null
      };
    }
    return { id: String(item), purpose: null, public_key_pem: null };
  }).filter((item) => item.id);
}

function trustedSigningKey(policy, id) {
  return trustedSigningKeys(policy).find((item) => item.id === String(id));
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

function legacyCanonicalSelftestCapabilityIssue(event, key, requested) {
  const timestamp = Date.parse(String((event || {}).ts || ''));
  const cutoff = Date.parse('2026-05-15T00:00:00.000Z');
  const signingKeyId = String((requested || {}).signing_key_id || '');
  const capabilityId = String((requested || {}).capability_id || (requested || {}).id || '');
  return key &&
    key.purpose === 'selftest-only' &&
    signingKeyId.startsWith('canonical-selftest-') &&
    capabilityId.startsWith(`${signingKeyId}-`) &&
    !Number.isNaN(timestamp) &&
    timestamp < cutoff;
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

function capabilityConsumed(capabilities, id) {
  return capabilities.some((event) => {
    return event.type === 'capability_consume' &&
      event.payload &&
      event.payload.capability_id === id &&
      event.payload.valid === true;
  });
}

function capabilityUsed(capabilities, id) {
  return capabilities.some((event) => {
    return event.type === 'capability_session' &&
      event.payload &&
      event.payload.capability_id === id &&
      event.payload.valid === true &&
      event.payload.status === 'USED';
  });
}

function capabilityHistorical(capabilities, id) {
  return capabilityConsumed(capabilities, id) || capabilityUsed(capabilities, id);
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
  const policyPatterns = policy && policy.paths && Array.isArray(policy.paths.denied) ? policy.paths.denied : [];
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
  const denyCommands = policy && policy.action_rules && policy.action_rules.deny_commands;
  return (denyCommands && Array.isArray(denyCommands[section])) ? denyCommands[section] : fallback;
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
    return { path: rel(file), status: 'PRESENT', sha256: sha256(canonicalValidationText(file)) };
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
  const eventIds = new Map();
  events.forEach((event, index) => {
    if (event.event_id) {
      if (eventIds.has(event.event_id)) {
        issues.push({
          code: 'LEDGER_DUPLICATE_EVENT_ID',
          severity: 'FAIL',
          message: `ledger event ${index + 1} duplicates event_id from event ${eventIds.get(event.event_id) + 1}`,
          event_id: event.event_id
        });
      } else {
        eventIds.set(event.event_id, index);
      }
    }
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
  if (state.validation.policy_hash && state.validation.policy_hash !== policyHash()) {
    issues.push({ code: 'VALIDATION_POLICY_HASH_MISMATCH', severity: 'FAIL', message: 'policy changed after validation was recorded' });
  }
  if (state.validation.mission_hash && state.validation.mission_hash !== missionHash()) {
    issues.push({ code: 'VALIDATION_MISSION_HASH_MISMATCH', severity: 'FAIL', message: 'mission changed after validation was recorded' });
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
    if (record.decision !== 'ALLOW' || record.allowed !== true) {
      issues.push({ code: 'VALIDATION_COMMAND_NOT_ALLOWED', severity: 'FAIL', message: `${command.id} was not allowed by policy before validation execution` });
    }
    if (record.spawned !== true) {
      issues.push({ code: 'VALIDATION_COMMAND_NOT_SPAWNED', severity: 'FAIL', message: `${command.id} did not record spawned:true validation evidence` });
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

function verifyPolicyMissionHashes(files, issues) {
  if (files.policy && files.policy.schema !== 'bha.policy.v1') {
    issues.push({ code: 'POLICY_SCHEMA_UNSUPPORTED', severity: 'FAIL', message: 'policy schema must be bha.policy.v1' });
  }
  if (files.policy && (!files.policy.metadata || !files.policy.paths || !files.policy.action_rules || !files.policy.capability_rules)) {
    issues.push({ code: 'POLICY_CANONICAL_LAYOUT_REQUIRED', severity: 'FAIL', message: 'policy must use the canonical metadata/paths/action_rules/capability_rules layout' });
  }
  if (files.mission && files.mission.schema !== 'bha.mission.v1') {
    issues.push({ code: 'MISSION_SCHEMA_UNSUPPORTED', severity: 'FAIL', message: 'mission schema must be bha.mission.v1' });
  }
  if (files.mission && files.mission.mission_hash && files.mission.mission_hash !== 'SELF_HASH_EXCLUDED' && files.mission.mission_hash !== missionHash(files.mission)) {
    issues.push({ code: 'MISSION_HASH_MISMATCH', severity: 'FAIL', message: 'mission_hash does not match canonical mission hash' });
  }
  if (files.state && files.state.policy_hash && files.policy && files.state.policy_hash !== policyHash(files.policy)) {
    issues.push({ code: 'STATE_POLICY_HASH_MISMATCH', severity: 'FAIL', message: 'state.policy_hash does not match current policy' });
  }
  if (files.state && files.state.mission_hash && files.mission && files.state.mission_hash !== missionHash(files.mission)) {
    issues.push({ code: 'STATE_MISSION_HASH_MISMATCH', severity: 'FAIL', message: 'state.mission_hash does not match current mission' });
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
  const disallowed = new Set((((policy || {}).capability_rules || {}).always_denied_v1 || []).map((item) => String(item)));
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
  const historical = capabilityHistorical(capabilities, payload.capability_id);
  if (requested.signing_key_id && !trusted.has(String(requested.signing_key_id))) {
    issues.push({ code: 'UNKNOWN_SIGNING_KEY_MARKED_VALID', severity: 'FAIL', message: 'capability used an untrusted signing key', event_hash: event.event_hash });
  }
  if (requested.signing_key_id && trusted.has(String(requested.signing_key_id)) && !key.public_key_pem) {
    issues.push({ code: 'TRUSTED_SIGNING_KEY_HAS_NO_PUBLIC_KEY', severity: 'FAIL', message: 'trusted signing key has no public key', event_hash: event.event_hash });
  }
  if (!historical &&
      key &&
      !signingKeyPurposeAllowedForCapability(key, type) &&
      !legacyCanonicalSelftestCapabilityIssue(event, key, requested)) {
    issues.push({ code: 'CAPABILITY_SIGNING_KEY_PURPOSE_DENIED', severity: 'FAIL', message: `${key.purpose || 'UNSPECIFIED'} signing key cannot authorize ${type}`, event_hash: event.event_hash });
  }
  if (requested.payload_hash && requested.payload_hash !== capabilityPayloadHash(requested)) {
    issues.push({ code: 'CAPABILITY_PAYLOAD_HASH_MISMATCH', severity: 'FAIL', message: 'capability payload_hash mismatch', event_hash: event.event_hash });
  }
  if (key && key.public_key_pem && !capabilitySignatureValid(requested, key)) {
    issues.push({ code: 'CAPABILITY_SIGNATURE_INVALID', severity: 'FAIL', message: 'capability signature is invalid', event_hash: event.event_hash });
  }
  if (!historical && state && requested.run_id !== state.run_id) {
    issues.push({ code: 'CAPABILITY_RUN_ID_MISMATCH', severity: 'FAIL', message: 'valid capability run_id does not match state', event_hash: event.event_hash });
  }
  if (requested.schema === 'bha.capability.v1') {
    if (!historical && requested.policy_hash !== policyHash(policy)) {
      issues.push({ code: 'CAPABILITY_POLICY_HASH_MISMATCH', severity: 'FAIL', message: 'valid capability policy_hash does not match current policy', event_hash: event.event_hash });
    }
    if (!historical && requested.mission_hash !== missionHash()) {
      issues.push({ code: 'CAPABILITY_MISSION_HASH_MISMATCH', severity: 'FAIL', message: 'valid capability mission_hash does not match current mission', event_hash: event.event_hash });
    }
    if (requested.algorithm !== 'ed25519') {
      issues.push({ code: 'CAPABILITY_ALGORITHM_UNSUPPORTED', severity: 'FAIL', message: 'valid capability algorithm must be ed25519', event_hash: event.event_hash });
    }
    if (requested.signature_encoding !== 'base64') {
      issues.push({ code: 'CAPABILITY_SIGNATURE_ENCODING_UNSUPPORTED', severity: 'FAIL', message: 'valid capability signature_encoding must be base64', event_hash: event.event_hash });
    }
    if (requested.payload_hash_format !== 'sha256-hex') {
      issues.push({ code: 'CAPABILITY_PAYLOAD_HASH_FORMAT_UNSUPPORTED', severity: 'FAIL', message: 'valid capability payload_hash_format must be sha256-hex', event_hash: event.event_hash });
    }
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
  if (isExpired(requested.expires_at) && !historical) {
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
  const lower = text.toLowerCase();
  if (!text || !/rollback/i.test(text)) {
    issues.push({ code: 'ROLLBACK_INCOMPLETE', severity: 'FAIL', message: '.bha/rollback.md does not contain rollback guidance' });
  }
  const required = [
    {
      code: 'ROLLBACK_SCOPE_INCOMPLETE',
      ok: /local/i.test(text) && /dry-run/i.test(text),
      message: '.bha/rollback.md must scope rollback to local dry-run recovery'
    },
    {
      code: 'ROLLBACK_HOOK_RECOVERY_MISSING',
      ok: /hooks?\s*path|core\.hookspath|pre-push/i.test(text),
      message: '.bha/rollback.md must describe how to stop relying on the local pre-push hook'
    },
    {
      code: 'ROLLBACK_EVIDENCE_RECOVERY_MISSING',
      ok: /\.bha\/state\.json/i.test(text) && /\.bha\/ledger\.jsonl/i.test(text) && /\.bha\/capabilities\.jsonl/i.test(text),
      message: '.bha/rollback.md must describe state, ledger, and capability evidence recovery'
    },
    {
      code: 'ROLLBACK_SOURCE_MISSING',
      ok: /known-good|known good|version control|git restore/i.test(text),
      message: '.bha/rollback.md must identify version control or a known-good local copy as the recovery source'
    },
    {
      code: 'ROLLBACK_DESTRUCTIVE_BOUNDARY_MISSING',
      ok: /do not run `git reset --hard`/i.test(text) && /do not run `git clean/i.test(text) && /remove-item -recurse/i.test(lower),
      message: '.bha/rollback.md must explicitly forbid destructive cleanup commands'
    },
    {
      code: 'ROLLBACK_REMOTE_BOUNDARY_MISSING',
      ok: /do not push/i.test(text) && /do not tag/i.test(text) && /do not release/i.test(text) && /do not deploy/i.test(text) && /do not publish/i.test(text),
      message: '.bha/rollback.md must explicitly forbid remote and external side effects'
    },
    {
      code: 'ROLLBACK_SECRET_BOUNDARY_MISSING',
      ok: /private key/i.test(text) && /secret/i.test(text),
      message: '.bha/rollback.md must explicitly forbid secret and private key access'
    }
  ];
  for (const item of required) {
    if (!item.ok) {
      issues.push({ code: item.code, severity: 'FAIL', message: item.message });
    }
  }
}

function verifyCheckpointFile(events, state, issues) {
  if (!fs.existsSync(CHECKPOINT_PATH)) {
    if (state && (state.last_checkpoint || state.last_checkpoint_id)) {
      issues.push({ code: 'CHECKPOINT_FILE_MISSING', severity: 'FAIL', message: 'state references a checkpoint but .bha/checkpoint.json is missing' });
    }
    return;
  }
  let checkpoint;
  try {
    checkpoint = readJsonStrict(CHECKPOINT_PATH);
  } catch (error) {
    issues.push({ code: 'CHECKPOINT_INVALID_JSON', severity: 'FAIL', message: `.bha/checkpoint.json must be strict JSON: ${error.message}` });
    return;
  }
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    issues.push({ code: 'CHECKPOINT_INVALID_JSON', severity: 'FAIL', message: '.bha/checkpoint.json must be a JSON object' });
    return;
  }
  if (checkpoint.schema !== 'bha.checkpoint.v1') {
    issues.push({ code: 'CHECKPOINT_SCHEMA_UNSUPPORTED', severity: 'FAIL', message: 'checkpoint schema must be bha.checkpoint.v1' });
  }
  const required = [
    'checkpoint_id',
    'created_at',
    'run_id',
    'actor_id',
    'goal',
    'phase',
    'workspace',
    'branch',
    'head',
    'ledger_head_hash',
    'policy_hash',
    'mission_hash',
    'completed',
    'changed_files',
    'validation_run',
    'validation_not_run',
    'verifier_status',
    'blockers',
    'risks',
    'next_safe_action',
    'stop_conditions',
    'checkpoint_binding',
    'ledger_event_hash'
  ];
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(checkpoint, key)) {
      issues.push({ code: 'CHECKPOINT_FIELD_MISSING', severity: 'FAIL', message: `.bha/checkpoint.json missing ${key}` });
    }
  }
  if (checkpoint.policy_hash !== policyHash()) {
    issues.push({ code: 'CHECKPOINT_POLICY_HASH_MISMATCH', severity: 'FAIL', message: 'checkpoint policy_hash does not match current policy' });
  }
  if (checkpoint.mission_hash !== missionHash()) {
    issues.push({ code: 'CHECKPOINT_MISSION_HASH_MISMATCH', severity: 'FAIL', message: 'checkpoint mission_hash does not match current mission' });
  }
  const checkpointEvents = (events || []).filter((event) => event.type === 'checkpoint_written');
  const event = checkpointEvents.find((item) => item.event_hash === checkpoint.ledger_event_hash);
  if (!event) {
    issues.push({ code: 'CHECKPOINT_LEDGER_EVENT_MISSING', severity: 'FAIL', message: 'checkpoint references a missing checkpoint_written ledger event' });
    return;
  }
  const newestCheckpoint = checkpointEvents.length ? checkpointEvents[checkpointEvents.length - 1] : null;
  if (newestCheckpoint && event.event_hash !== newestCheckpoint.event_hash) {
    issues.push({ code: 'CHECKPOINT_NOT_LATEST', severity: 'FAIL', message: '.bha/checkpoint.json must reference the newest checkpoint_written event', event_hash: event.event_hash });
  }
  if (!state || !state.last_checkpoint || state.last_checkpoint.ledger_event_hash !== event.event_hash || state.last_checkpoint_id !== checkpoint.checkpoint_id) {
    issues.push({ code: 'CHECKPOINT_STATE_MISMATCH', severity: 'FAIL', message: 'state.last_checkpoint must reference .bha/checkpoint.json and its ledger event' });
  }
  const payload = event.payload || {};
  const payloadBinding = payload.checkpoint_binding || {};
  const fileBinding = checkpoint.checkpoint_binding || {};
  if (payload.schema !== 'bha.checkpoint.v1' || payload.checkpoint_id !== checkpoint.checkpoint_id) {
    issues.push({ code: 'CHECKPOINT_LEDGER_PAYLOAD_MISMATCH', severity: 'FAIL', message: 'checkpoint ledger payload does not match checkpoint file', event_hash: event.event_hash });
  }
  if (payloadBinding.verified_ledger_head_hash !== event.prev_hash) {
    issues.push({ code: 'CHECKPOINT_BINDING_MISMATCH', severity: 'FAIL', message: 'checkpoint payload verified_ledger_head_hash must equal checkpoint event prev_hash', event_hash: event.event_hash });
  }
  if (payloadBinding.checkpoint_event_hash !== 'SELF_EVENT_HASH' && payloadBinding.checkpoint_event_hash !== event.event_hash) {
    issues.push({ code: 'CHECKPOINT_BINDING_MISMATCH', severity: 'FAIL', message: 'checkpoint payload checkpoint_event_hash must bind to the checkpoint event hash', event_hash: event.event_hash });
  }
  if (payloadBinding.final_ledger_head_hash !== 'SELF_EVENT_HASH' && payloadBinding.final_ledger_head_hash !== event.event_hash) {
    issues.push({ code: 'CHECKPOINT_BINDING_MISMATCH', severity: 'FAIL', message: 'checkpoint payload final_ledger_head_hash must bind to the checkpoint event hash', event_hash: event.event_hash });
  }
  if (fileBinding.verified_ledger_head_hash !== event.prev_hash ||
      fileBinding.checkpoint_event_hash !== event.event_hash ||
      fileBinding.final_ledger_head_hash !== event.event_hash) {
    issues.push({ code: 'CHECKPOINT_BINDING_MISMATCH', severity: 'FAIL', message: 'checkpoint file binding does not match the referenced checkpoint ledger event', event_hash: event.event_hash });
  }
}

function verifyCloseoutClaims(closeout, issues) {
  if (!closeout || typeof closeout !== 'object' || Array.isArray(closeout)) {
    issues.push({ code: 'CLOSEOUT_INVALID_JSON', severity: 'FAIL', message: 'closeout must be a JSON object' });
    return;
  }
  const claimSources = [];
  if (closeout.claims && typeof closeout.claims === 'object' && !Array.isArray(closeout.claims)) {
    claimSources.push(closeout.claims);
  }
  claimSources.push(closeout);
  for (const claims of claimSources) {
    for (const key of ['no_external_effects', 'tamper_proof', 'network_proof', 'provider_proof', 'memory_proof', 'ready_to_push']) {
      if (claims[key] === true) {
        issues.push({ code: 'CLOSEOUT_UNSUPPORTED_CLAIM', severity: 'FAIL', message: `closeout claim ${key}=true is not supported by BHA v1 local evidence` });
      }
    }
  }
  const explicitPass = closeout.passed === true || closeout.status === 'PASS' || closeout.closeout_status === 'PASS';
  if (!explicitPass) {
    return;
  }
  const binding = closeout.closeout_binding || {};
  const verifier = closeout.verifier || {};
  const validationStatus = closeout.validation && closeout.validation.recorded_status
    ? closeout.validation.recorded_status
    : (closeout.state && closeout.state.validation_status);
  if (verifier.status !== 'PASS' ||
      validationStatus !== 'PASS' ||
      !binding.verified_ledger_head_hash ||
      binding.verified_ledger_head_hash === 'NOT_RECORDED' ||
      !binding.final_ledger_head_hash ||
      binding.final_ledger_head_hash === 'NOT_RECORDED') {
    issues.push({
      code: 'CLOSEOUT_UNSUPPORTED_CLAIM',
      severity: 'FAIL',
      message: 'closeout pass claim requires PASS verifier, PASS validation, verified_ledger_head_hash, and final_ledger_head_hash'
    });
  }
}

function verifyCloseoutFile(issues) {
  if (!fs.existsSync(CLOSEOUT_PATH)) {
    return;
  }
  let closeout;
  try {
    closeout = readJsonStrict(CLOSEOUT_PATH);
  } catch (error) {
    issues.push({ code: 'CLOSEOUT_INVALID_JSON', severity: 'FAIL', message: `.bha/closeout.json must be strict JSON: ${error.message}` });
    return;
  }
  verifyCloseoutClaims(closeout, issues);
}

function verifyCloseoutEvents(events, state, issues, warnings) {
  const closeoutEvents = (events || []).filter((event) => event.type === 'closeout_completed');
  for (const event of closeoutEvents) {
    const payload = event.payload || {};
    const binding = payload.closeout_binding || {};
    if (payload.schema !== 'bha.closeout.v1') {
      issues.push({ code: 'CLOSEOUT_SCHEMA_UNSUPPORTED', severity: 'FAIL', message: 'closeout_completed payload schema must be bha.closeout.v1', event_hash: event.event_hash });
    }
    if (payload.status !== 'PASS') {
      issues.push({ code: 'CLOSEOUT_STATUS_UNSUPPORTED', severity: 'FAIL', message: 'recorded closeout status must be PASS', event_hash: event.event_hash });
    }
    if (payload.verifier_status !== 'PASS' || payload.validation_status !== 'PASS') {
      issues.push({ code: 'CLOSEOUT_UNSUPPORTED_CLAIM', severity: 'FAIL', message: 'recorded closeout requires PASS verifier and PASS validation evidence', event_hash: event.event_hash });
    }
    if (Array.isArray(payload.unsupported_claims) && payload.unsupported_claims.length > 0) {
      issues.push({ code: 'CLOSEOUT_UNSUPPORTED_CLAIM', severity: 'FAIL', message: 'recorded closeout contains unsupported claims', event_hash: event.event_hash });
    }
    if (payload.policy_hash !== event.policy_hash) {
      issues.push({ code: 'CLOSEOUT_POLICY_HASH_MISMATCH', severity: 'FAIL', message: 'recorded closeout policy_hash does not match ledger event policy_hash', event_hash: event.event_hash });
    }
    if (payload.mission_hash !== event.mission_hash) {
      issues.push({ code: 'CLOSEOUT_MISSION_HASH_MISMATCH', severity: 'FAIL', message: 'recorded closeout mission_hash does not match ledger event mission_hash', event_hash: event.event_hash });
    }
    if (binding.verified_ledger_head_hash !== event.prev_hash) {
      issues.push({ code: 'CLOSEOUT_BINDING_MISMATCH', severity: 'FAIL', message: 'recorded closeout verified_ledger_head_hash must equal the closeout event prev_hash', event_hash: event.event_hash });
    }
    if (binding.closeout_event_hash !== 'SELF_EVENT_HASH' && binding.closeout_event_hash !== event.event_hash) {
      issues.push({ code: 'CLOSEOUT_BINDING_MISMATCH', severity: 'FAIL', message: 'recorded closeout closeout_event_hash must bind to the closeout event hash', event_hash: event.event_hash });
    }
    if (binding.final_ledger_head_hash !== 'SELF_EVENT_HASH' && binding.final_ledger_head_hash !== event.event_hash) {
      issues.push({ code: 'CLOSEOUT_BINDING_MISMATCH', severity: 'FAIL', message: 'recorded closeout final_ledger_head_hash must bind to the closeout event hash', event_hash: event.event_hash });
    }
  }

  const newestCloseout = closeoutEvents.length ? closeoutEvents[closeoutEvents.length - 1] : null;
  if (state && state.closeout && state.closeout.ledger_event_hash) {
    const event = closeoutEvents.find((item) => item.event_hash === state.closeout.ledger_event_hash);
    if (!event) {
      issues.push({ code: 'CLOSEOUT_LEDGER_EVENT_MISSING', severity: 'FAIL', message: 'state.closeout references a missing closeout ledger event' });
      return;
    }
    if (newestCloseout && state.closeout.ledger_event_hash !== newestCloseout.event_hash) {
      issues.push({ code: 'CLOSEOUT_NOT_LATEST', severity: 'FAIL', message: 'state.closeout must reference the newest recorded closeout event', event_hash: state.closeout.ledger_event_hash });
    }
    if (state.closeout.closeout_event_hash !== event.event_hash ||
        state.closeout.final_ledger_head_hash !== event.event_hash ||
        state.closeout.verified_ledger_head_hash !== event.prev_hash) {
      issues.push({ code: 'CLOSEOUT_BINDING_MISMATCH', severity: 'FAIL', message: 'state.closeout binding does not match the referenced closeout ledger event', event_hash: event.event_hash });
    }
  }
  if (newestCloseout && state && state.ledger_head_hash && state.ledger_head_hash !== newestCloseout.event_hash) {
    warnings.push({
      code: 'CLOSEOUT_NOT_CURRENT_LEDGER_HEAD',
      severity: 'WARN',
      message: 'new ledger events exist after the newest recorded closeout',
      closeout_event_hash: newestCloseout.event_hash,
      ledger_head_hash: state.ledger_head_hash
    });
  }
}

function changedFilesFromStatus(stdout) {
  return String(stdout || '').split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => {
    const status = line.slice(0, 2).trim() || 'UNKNOWN';
    const rawPath = line.slice(3).trim();
    const filePath = rawPath.replace(/.* -> /, '').replace(/\\/g, '/');
    return { status, path: filePath || rawPath };
  });
}

function validationInputRelPaths() {
  return new Set(VALIDATION_INPUTS.map((file) => rel(file)));
}

async function verifyUnverifiedWorktree(files, issues, warnings) {
  const result = await runCommand(['git', 'status', '--short', '--untracked-files=all']);
  if (result.exit_code !== 0 || result.error) {
    warnings.push({ code: 'GIT_STATUS_UNKNOWN', severity: 'UNKNOWN', message: result.error || result.stderr.trim() || 'git status unavailable' });
    return;
  }
  const validationFresh = files.state &&
    files.state.validation &&
    files.state.validation.status === 'PASS' &&
    files.state.validation.inputs_hash === validationInputsHash();
  const validationInputs = validationInputRelPaths();
  const evidenceFiles = new Set([
    '.bha/ledger.jsonl',
    '.bha/state.json',
    '.bha/capabilities.jsonl',
    '.bha/checkpoint.json'
  ]);
  for (const changed of changedFilesFromStatus(result.stdout)) {
    if (evidenceFiles.has(changed.path)) {
      continue;
    }
    if (validationFresh && validationInputs.has(changed.path)) {
      continue;
    }
    issues.push({
      code: 'UNVERIFIED_WORKTREE_CHANGE',
      severity: 'BLOCKED',
      message: `${changed.path} is dirty and not covered by the latest validation evidence`,
      path: changed.path,
      status: changed.status
    });
  }
}

function verifyV2PreviewContractsFromText(runSource, frameworkDoc, councilDoc, issues) {
  const requiredRunTokens = [
    'machine_readable_draft',
    'bha.capability_schema.v2.preview',
    'deny_replay_test_matrix',
    'verifier_evidence_contract',
    'verifier_must_reject_incomplete_preview_schema',
    'dry_run_model',
    'bha.council_dry_run.v2.preview',
    'role_boundary_matrix',
    'activation_regression_matrix',
    'audit-v2-preview'
  ];
  const missingRunTokens = requiredRunTokens.filter((token) => !String(runSource || '').includes(token));
  if (missingRunTokens.length > 0) {
    issues.push({
      code: 'V2_CAPABILITY_PREVIEW_SCHEMA_INCOMPLETE',
      severity: 'FAIL',
      message: `V2 preview machine-readable contract is missing ${missingRunTokens.join(', ')}`
    });
  }
  const requiredFrameworkTokens = [
    'Machine-Readable Preview Contract',
    'schema draft',
    'binding model',
    'deny/replay matrix',
    'verifier evidence contract',
    'non-enabling'
  ];
  const missingFrameworkTokens = requiredFrameworkTokens.filter((token) => !String(frameworkDoc || '').includes(token));
  if (missingFrameworkTokens.length > 0) {
    issues.push({
      code: 'V2_CAPABILITY_PREVIEW_DOC_INCOMPLETE',
      severity: 'FAIL',
      message: `V2 capability framework doc is missing ${missingFrameworkTokens.join(', ')}`
    });
  }
  const requiredCouncilTokens = [
    'Machine-Readable Dry-Run Contract',
    'dry-run trace',
    'role boundary matrix',
    'activation regression matrix',
    'non-activating'
  ];
  const missingCouncilTokens = requiredCouncilTokens.filter((token) => !String(councilDoc || '').includes(token));
  if (missingCouncilTokens.length > 0) {
    issues.push({
      code: 'V2_COUNCIL_PREVIEW_DOC_INCOMPLETE',
      severity: 'FAIL',
      message: `V2 council runtime doc is missing ${missingCouncilTokens.join(', ')}`
    });
  }
}

function verifyV2PreviewContracts(issues) {
  verifyV2PreviewContractsFromText(
    fs.existsSync(RUN_SCRIPT) ? readText(RUN_SCRIPT) : '',
    fs.existsSync(CAPABILITY_FRAMEWORK_PATH) ? readText(CAPABILITY_FRAMEWORK_PATH) : '',
    fs.existsSync(COUNCIL_RUNTIME_PATH) ? readText(COUNCIL_RUNTIME_PATH) : '',
    issues
  );
}

function selfTestLedgerDuplicateEventId() {
  const first = {
    schema: 'bha.ledger.event.v1',
    run_id: 'self-test',
    event_id: 'duplicate-event-id',
    ts: '2026-01-01T00:00:00.000Z',
    type: 'self_test',
    prev_hash: 'GENESIS',
    payload: { n: 1 }
  };
  first.event_hash = eventHash(first);
  const second = {
    schema: 'bha.ledger.event.v1',
    run_id: 'self-test',
    event_id: 'duplicate-event-id',
    ts: '2026-01-01T00:00:01.000Z',
    type: 'self_test',
    prev_hash: first.event_hash,
    payload: { n: 2 }
  };
  second.event_hash = eventHash(second);
  const issues = [];
  verifyLedger([first, second], {
    ledger_head_hash: second.event_hash,
    ledger_event_count: 2
  }, issues);
  return issues;
}

function selfTestMalformedPolicy() {
  const issues = [];
  verifyPolicyMissionHashes({
    policy: { schema: 'bha.policy.v1' },
    mission: { schema: 'bha.mission.v1' },
    state: {}
  }, issues);
  return issues;
}

function selfTestUnsignedCapability() {
  const issues = [];
  verifyClaims([], [{
    type: 'capability_issue',
    event_hash: 'self-test-capability-unsigned',
    payload: {
      valid: true,
      capability_type: 'git_push',
      requested: { schema: 'bha.capability.v1', type: 'git_push' }
    }
  }], issues);
  return issues;
}

function selfTestStaleValidation() {
  const issues = [];
  verifyValidation({
    validation: {
      status: 'PASS',
      inputs_hash: '0000000000000000000000000000000000000000000000000000000000000000',
      commands: [],
      ledger_event_hash: 'missing-self-test-event'
    }
  }, { required_commands: [] }, [], issues);
  return issues;
}

function selfTestValidationPolicyEvidenceMissing() {
  const issues = [];
  const completion = {
    type: 'validation_completed',
    event_hash: 'self-test-validation-policy-evidence'
  };
  verifyValidation({
    validation: {
      status: 'PASS',
      inputs_hash: validationInputsHash(),
      commands: [{
        id: 'self_test_validation_policy_gate',
        argv: ['git', 'diff', '--check'],
        expect: { exit_code: 0 },
        status: 'PASS',
        problems: [],
        exit_code: 0
      }],
      ledger_event_hash: completion.event_hash
    }
  }, {
    required_commands: [{
      id: 'self_test_validation_policy_gate',
      argv: ['git', 'diff', '--check'],
      expect: { exit_code: 0 }
    }]
  }, [completion], issues);
  return issues;
}

function selfTestCapabilityHashMismatch() {
  const issues = [];
  const policy = {
    schema: 'bha.policy.v1',
    metadata: {},
    paths: {},
    action_rules: {},
    capability_rules: { always_denied_v1: [] },
    trusted_public_keys: []
  };
  verifyCapabilityIssue({
    type: 'capability_issue',
    event_hash: 'self-test-capability-hash-mismatch',
    payload: {
      valid: true,
      capability_id: 'self-test-capability-hash-mismatch',
      capability_type: 'git_push',
      requested: {
        schema: 'bha.capability.v1',
        type: 'git_push',
        run_id: 'self-test-run',
        policy_hash: 'wrong-policy-hash',
        mission_hash: 'wrong-mission-hash',
        remote: 'origin',
        branch: 'master',
        head: 'self-test-head',
        ledger_head_hash: 'self-test-ledger-head',
        one_use: true,
        expires_at: '9999-12-31T23:59:59.000Z',
        signing_key_id: 'missing-key',
        signature: 'AA==',
        algorithm: 'ed25519',
        signature_encoding: 'base64',
        payload_hash_format: 'sha256-hex'
      }
    }
  }, policy, { run_id: 'self-test-run' }, [], [], issues);
  return issues;
}

function selfTestCapabilityPolicy() {
  return {
    schema: 'bha.policy.v1',
    metadata: {},
    paths: {},
    action_rules: {},
    capability_rules: { always_denied_v1: [] },
    trusted_public_keys: []
  };
}

function selfTestCapabilityEvent(type, payload, id) {
  const event = {
    schema: 'bha.capability.event.v1',
    run_id: 'self-test-run',
    policy_hash: 'self-test-policy-hash',
    mission_hash: 'self-test-mission-hash',
    event_id: `self-test-${id}`,
    ts: '2026-01-01T00:00:00.000Z',
    type,
    payload
  };
  event.event_hash = capabilityHash(event);
  return event;
}

function selfTestCapabilityIssuePayload(id, requestedOverrides) {
  return {
    valid: true,
    capability_id: id,
    capability_type: 'git_push',
    requested: Object.assign({
      schema: 'bha.capability.v1',
      type: 'git_push',
      run_id: 'self-test-run',
      policy_hash: 'self-test-policy-hash',
      mission_hash: missionHash(),
      remote: 'origin',
      branch: 'master',
      head: 'self-test-head',
      ledger_head_hash: 'self-test-ledger-head',
      one_use: true,
      expires_at: '9999-12-31T23:59:59.000Z',
      signing_key_id: 'missing-key',
      signature: 'AA==',
      algorithm: 'ed25519',
      signature_encoding: 'base64',
      payload_hash_format: 'sha256-hex'
    }, requestedOverrides || {})
  };
}

function selfTestExpiredCapability() {
  const issues = [];
  const event = selfTestCapabilityEvent('capability_issue', selfTestCapabilityIssuePayload('self-test-expired', {
    expires_at: '2000-01-01T00:00:00.000Z'
  }), 'expired');
  verifyCapabilityIssue(event, selfTestCapabilityPolicy(), { run_id: 'self-test-run' }, [], [], issues);
  return issues;
}

function selfTestCapabilityKeyPurposeDenied() {
  const issues = [];
  const keypair = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = keypair.publicKey.export({ type: 'spki', format: 'pem' });
  const policy = selfTestCapabilityPolicy();
  policy.trusted_public_keys = [{
    id: 'selftest-only-key',
    purpose: 'selftest-only',
    public_key_pem: publicKeyPem
  }];
  const payload = selfTestCapabilityIssuePayload('self-test-key-purpose');
  payload.requested.signing_key_id = 'selftest-only-key';
  payload.requested.policy_hash = policyHash(policy);
  delete payload.requested.signature;
  delete payload.requested.payload_hash;
  payload.requested.payload_hash = capabilityPayloadHash(payload.requested);
  payload.requested.signature = crypto.sign(
    null,
    Buffer.from(stable(capabilitySignablePayload(payload.requested))),
    keypair.privateKey
  ).toString('base64');
  const event = selfTestCapabilityEvent('capability_issue', payload, 'key-purpose');
  verifyCapabilityIssue(event, policy, { run_id: 'self-test-run' }, [], [], issues);
  return issues;
}

function selfTestUnsupportedCapabilityType() {
  const issues = [];
  const payload = selfTestCapabilityIssuePayload('self-test-unsupported-type', {
    type: 'unknown_local_capability'
  });
  payload.capability_type = 'unknown_local_capability';
  const event = selfTestCapabilityEvent('capability_issue', payload, 'unsupported-type');
  verifyCapabilityIssue(event, selfTestCapabilityPolicy(), { run_id: 'self-test-run' }, [], [], issues);
  return issues;
}

function selfTestDisallowedCapabilityType() {
  const issues = [];
  const policy = selfTestCapabilityPolicy();
  policy.capability_rules.always_denied_v1 = ['provider_call'];
  const payload = selfTestCapabilityIssuePayload('self-test-disallowed-type', {
    type: 'provider_call',
    command: 'openai models list'
  });
  payload.capability_type = 'provider_call';
  const event = selfTestCapabilityEvent('capability_issue', payload, 'disallowed-type');
  verifyCapabilityIssue(event, policy, { run_id: 'self-test-run' }, [], [], issues);
  return issues;
}

function selfTestIncompleteCapabilityBinding() {
  const issues = [];
  const payload = selfTestCapabilityIssuePayload('self-test-incomplete-binding');
  delete payload.requested.remote;
  const event = selfTestCapabilityEvent('capability_issue', payload, 'incomplete-binding');
  verifyCapabilityIssue(event, selfTestCapabilityPolicy(), { run_id: 'self-test-run' }, [], [], issues);
  return issues;
}

function selfTestCapabilityReplay() {
  const issues = [];
  const issue = selfTestCapabilityEvent('capability_issue', selfTestCapabilityIssuePayload('self-test-replay'), 'replay-issue');
  const consumePayload = {
    valid: true,
    capability_id: 'self-test-replay',
    issue_event_hash: issue.event_hash,
    for: 'git_push',
    remote: 'origin',
    branch: 'master',
    head: 'self-test-head'
  };
  const firstConsume = selfTestCapabilityEvent('capability_consume', consumePayload, 'replay-consume-1');
  const secondConsume = selfTestCapabilityEvent('capability_consume', consumePayload, 'replay-consume-2');
  verifyCapabilities([issue, firstConsume, secondConsume], selfTestCapabilityPolicy(), { run_id: 'self-test-run' }, [], issues);
  return issues;
}

function selfTestCapabilityContextMismatch() {
  const issues = [];
  const issue = selfTestCapabilityEvent('capability_issue', selfTestCapabilityIssuePayload('self-test-context'), 'context-issue');
  const consume = selfTestCapabilityEvent('capability_consume', {
    valid: true,
    capability_id: 'self-test-context',
    issue_event_hash: issue.event_hash,
    for: 'git_push',
    remote: 'upstream',
    branch: 'release',
    head: 'wrong-head'
  }, 'context-consume');
  verifyCapabilities([issue, consume], selfTestCapabilityPolicy(), { run_id: 'self-test-run' }, [], issues);
  return issues;
}

function selfTestUnsupportedCloseoutClaim() {
  const issues = [];
  verifyCloseoutClaims({
    status: 'PASS',
    passed: true,
    claims: {
      no_external_effects: true
    },
    verifier: {
      status: 'FAIL'
    },
    validation: {
      recorded_status: 'PASS'
    },
    closeout_binding: {
      verified_ledger_head_hash: 'NOT_RECORDED',
      final_ledger_head_hash: 'NOT_RECORDED'
    }
  }, issues);
  return issues;
}

function selfTestCloseoutEventBinding() {
  const event = {
    schema: 'bha.ledger.event.v1',
    run_id: 'self-test',
    policy_hash: 'self-test-policy-hash',
    mission_hash: 'self-test-mission-hash',
    event_id: 'self-test-closeout',
    ts: '2026-01-01T00:00:00.000Z',
    type: 'closeout_completed',
    actor: 'bha-run',
    prev_hash: 'self-test-previous-head',
    payload: {
      schema: 'bha.closeout.v1',
      status: 'PASS',
      policy_hash: 'self-test-policy-hash',
      mission_hash: 'self-test-mission-hash',
      verifier_status: 'PASS',
      validation_status: 'PASS',
      unsupported_claims: [],
      closeout_binding: {
        verified_ledger_head_hash: 'wrong-verified-head',
        closeout_event_hash: 'wrong-closeout-hash',
        final_ledger_head_hash: 'wrong-final-head'
      }
    }
  };
  event.event_hash = eventHash(event);
  const issues = [];
  verifyCloseoutEvents([event], {}, issues, []);
  return issues;
}

function selfTestCloseoutStateNotLatest() {
  const first = {
    schema: 'bha.ledger.event.v1',
    run_id: 'self-test',
    policy_hash: 'self-test-policy-hash',
    mission_hash: 'self-test-mission-hash',
    event_id: 'self-test-closeout-first',
    ts: '2026-01-01T00:00:00.000Z',
    type: 'closeout_completed',
    actor: 'bha-run',
    prev_hash: 'self-test-previous-head',
    payload: {
      schema: 'bha.closeout.v1',
      status: 'PASS',
      policy_hash: 'self-test-policy-hash',
      mission_hash: 'self-test-mission-hash',
      verifier_status: 'PASS',
      validation_status: 'PASS',
      unsupported_claims: [],
      closeout_binding: {
        verified_ledger_head_hash: 'self-test-previous-head',
        closeout_event_hash: 'SELF_EVENT_HASH',
        final_ledger_head_hash: 'SELF_EVENT_HASH'
      }
    }
  };
  first.event_hash = eventHash(first);
  const second = {
    schema: 'bha.ledger.event.v1',
    run_id: 'self-test',
    policy_hash: 'self-test-policy-hash',
    mission_hash: 'self-test-mission-hash',
    event_id: 'self-test-closeout-second',
    ts: '2026-01-01T00:00:01.000Z',
    type: 'closeout_completed',
    actor: 'bha-run',
    prev_hash: first.event_hash,
    payload: {
      schema: 'bha.closeout.v1',
      status: 'PASS',
      policy_hash: 'self-test-policy-hash',
      mission_hash: 'self-test-mission-hash',
      verifier_status: 'PASS',
      validation_status: 'PASS',
      unsupported_claims: [],
      closeout_binding: {
        verified_ledger_head_hash: first.event_hash,
        closeout_event_hash: 'SELF_EVENT_HASH',
        final_ledger_head_hash: 'SELF_EVENT_HASH'
      }
    }
  };
  second.event_hash = eventHash(second);
  const issues = [];
  verifyCloseoutEvents([first, second], {
    ledger_head_hash: second.event_hash,
    closeout: {
      ledger_event_hash: first.event_hash,
      verified_ledger_head_hash: first.prev_hash,
      closeout_event_hash: first.event_hash,
      final_ledger_head_hash: first.event_hash
    }
  }, issues, []);
  return issues;
}

function selfTestIncompleteV2PreviewContract() {
  const issues = [];
  verifyV2PreviewContractsFromText(
    'function capabilityFramework() { return {}; }',
    'Default deny only',
    'Status: preview contract only',
    issues
  );
  return issues;
}

function checkExpectedCodes(id, issues, expectedCodes) {
  const observed = Array.from(new Set(issues.map((issue) => issue.code))).sort();
  const missing = expectedCodes.filter((code) => !observed.includes(code));
  return {
    id,
    status: missing.length === 0 ? 'PASS' : 'FAIL',
    expected_codes: expectedCodes,
    observed_codes: observed,
    missing_codes: missing
  };
}

function handleSelfTest() {
  const checks = [
    checkExpectedCodes('malformed_policy_rejected', selfTestMalformedPolicy(), ['POLICY_CANONICAL_LAYOUT_REQUIRED']),
    checkExpectedCodes('duplicate_ledger_event_id_rejected', selfTestLedgerDuplicateEventId(), ['LEDGER_DUPLICATE_EVENT_ID']),
    checkExpectedCodes('manual_unsigned_capability_append_rejected', selfTestUnsignedCapability(), ['UNSIGNED_CAPABILITY_MARKED_VALID']),
    checkExpectedCodes('stale_validation_rejected', selfTestStaleValidation(), ['VALIDATION_STALE_INPUTS']),
    checkExpectedCodes('validation_policy_evidence_required', selfTestValidationPolicyEvidenceMissing(), [
      'VALIDATION_COMMAND_NOT_ALLOWED',
      'VALIDATION_COMMAND_NOT_SPAWNED'
    ]),
    checkExpectedCodes('capability_policy_and_mission_hash_mismatch_rejected', selfTestCapabilityHashMismatch(), [
      'CAPABILITY_POLICY_HASH_MISMATCH',
      'CAPABILITY_MISSION_HASH_MISMATCH'
    ]),
    checkExpectedCodes('capability_signing_key_purpose_rejected', selfTestCapabilityKeyPurposeDenied(), ['CAPABILITY_SIGNING_KEY_PURPOSE_DENIED']),
    checkExpectedCodes('unsupported_capability_type_rejected', selfTestUnsupportedCapabilityType(), ['UNSUPPORTED_CAPABILITY_MARKED_VALID']),
    checkExpectedCodes('disallowed_capability_type_rejected', selfTestDisallowedCapabilityType(), ['DISALLOWED_CAPABILITY_VALID']),
    checkExpectedCodes('incomplete_capability_binding_rejected', selfTestIncompleteCapabilityBinding(), ['CAPABILITY_BINDING_MISSING']),
    checkExpectedCodes('expired_capability_rejected', selfTestExpiredCapability(), ['CAPABILITY_EXPIRED']),
    checkExpectedCodes('capability_replay_rejected', selfTestCapabilityReplay(), ['CAPABILITY_REPLAY_DETECTED']),
    checkExpectedCodes('capability_context_mismatch_rejected', selfTestCapabilityContextMismatch(), [
      'CAPABILITY_REMOTE_MISMATCH',
      'CAPABILITY_BRANCH_MISMATCH',
      'CAPABILITY_HEAD_MISMATCH'
    ]),
    checkExpectedCodes('closeout_unsupported_claim_rejected', selfTestUnsupportedCloseoutClaim(), ['CLOSEOUT_UNSUPPORTED_CLAIM']),
    checkExpectedCodes('closeout_binding_mismatch_rejected', selfTestCloseoutEventBinding(), ['CLOSEOUT_BINDING_MISMATCH']),
    checkExpectedCodes('closeout_state_not_latest_rejected', selfTestCloseoutStateNotLatest(), ['CLOSEOUT_NOT_LATEST']),
    checkExpectedCodes('incomplete_v2_preview_contract_rejected', selfTestIncompleteV2PreviewContract(), [
      'V2_CAPABILITY_PREVIEW_SCHEMA_INCOMPLETE',
      'V2_CAPABILITY_PREVIEW_DOC_INCOMPLETE',
      'V2_COUNCIL_PREVIEW_DOC_INCOMPLETE'
    ])
  ];
  const ok = checks.every((check) => check.status === 'PASS');
  console.log(JSON.stringify({
    ok,
    status: ok ? 'PASS' : 'FAIL',
    mode: 'read_only_negative_matrix',
    checks
  }));
  process.exitCode = ok ? 0 : 1;
}

async function main() {
  if (process.argv.includes('--self-test')) {
    handleSelfTest();
    return;
  }
  const issues = [];
  const warnings = [];
  const files = loadRequiredFiles(issues);
  const ledger = readJsonl(LEDGER_PATH, issues, 'LEDGER');
  const capabilities = readJsonl(CAPABILITIES_PATH, issues, 'CAPABILITIES');
  verifyPolicyMissionHashes(files, issues);
  const head = verifyLedger(ledger, files.state, issues);
  verifyForbiddenExecution(ledger, files.policy, issues);
  verifyValidation(files.state, files.validation, ledger, issues);
  verifyClaims(ledger, capabilities, issues);
  verifyCapabilities(capabilities, files.policy, files.state, ledger, issues);
  verifyRollback(issues);
  verifyCheckpointFile(ledger, files.state, issues);
  verifyCloseoutFile(issues);
  verifyCloseoutEvents(ledger, files.state, issues, warnings);
  verifyV2PreviewContracts(issues);
  await verifyDeniedPathTouched(files.mission, files.policy, issues, warnings);
  await verifyTrackedDeniedPaths(files.mission, files.policy, issues, warnings);
  await verifyUnverifiedWorktree(files, issues, warnings);

  const ok = issues.length === 0;
  const hasFail = issues.some((issue) => issue.severity === 'FAIL');
  const status = ok ? 'PASS' : (hasFail ? 'FAIL' : 'BLOCKED');
  console.log(JSON.stringify({
    ok,
    status,
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
