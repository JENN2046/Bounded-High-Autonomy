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

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  const text = readText(file);
  return text.split(/\r?\n/).filter((line) => line.trim() !== '').map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${rel(file)}:${index + 1}: invalid JSONL: ${error.message}`);
    }
  });
}

function eventHash(event) {
  const copy = Object.assign({}, event);
  delete copy.event_hash;
  return sha256(stable(copy));
}

function loadMission() {
  return readJsonStrict(MISSION_PATH);
}

function loadPolicy() {
  return readJsonStrict(POLICY_PATH);
}

function loadState() {
  return readJsonStrict(STATE_PATH);
}

function ledgerHead() {
  const events = readJsonl(LEDGER_PATH);
  if (events.length === 0) {
    return { hash: null, count: 0 };
  }
  return { hash: events[events.length - 1].event_hash || null, count: events.length };
}

function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLedgerLock(callback) {
  return callback();
}

function appendLedger(type, payload, mutateState) {
  return withLedgerLock(() => {
    fs.mkdirSync(BHA_DIR, { recursive: true });
    const mission = loadMission();
    const state = loadState();
    const head = ledgerHead();
    const event = {
      schema: 'bha.ledger.event.v1',
      run_id: state.run_id || mission.run_id,
      event_id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      type,
      actor: 'bha-run',
      prev_hash: head.hash || 'GENESIS',
      payload
    };
    event.event_hash = eventHash(event);
    fs.appendFileSync(LEDGER_PATH, stable(event) + '\n', 'utf8');
    state.ledger_head_hash = event.event_hash;
    state.ledger_event_count = head.count + 1;
    state.updated_at = event.ts;
    if (typeof mutateState === 'function') {
      mutateState(state, event);
    }
    writeJson(STATE_PATH, state);
    return event;
  });
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
  const missionPatterns = Array.isArray(mission.denied_paths) ? mission.denied_paths : [];
  const policyPatterns = policy.deny && Array.isArray(policy.deny.path_patterns) ? policy.deny.path_patterns : [];
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
        return { denied: true, pattern: normalizedPattern.path, code: 'DENY_PATH', path: normalized.path };
      }
    } else if (normalized.path === item || normalized.path.startsWith(item + '/')) {
      return { denied: true, pattern: normalizedPattern.path, code: 'DENY_PATH', path: normalized.path };
    }
  }
  return { denied: false, path: normalized.path };
}

function classifyDeniedPathArgs(argv, mission, policy) {
  for (const arg of argv.slice(1)) {
    if (String(arg).startsWith('-')) {
      continue;
    }
    const match = deniedPathMatch(arg, mission, policy);
    if (match.denied) {
      return {
        category: 'denied_path',
        rule: match.code,
        reason: match.code === 'PATH_PARENT_ESCAPE' ? 'parent path escapes are forbidden' : 'denied path argument is forbidden',
        path: match.path,
        pattern: match.pattern
      };
    }
  }
  return null;
}

function scrubArg(value) {
  const text = String(value);
  if (/(api[_-]?key|token|secret|password)=/i.test(text)) {
    return text.replace(/=.*/, '=[REDACTED]');
  }
  return text;
}

function scrubArgv(argv) {
  return argv.map(scrubArg);
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

function listFromPolicy(policy, section, fallback) {
  return (policy.deny && Array.isArray(policy.deny[section])) ? policy.deny[section] : fallback;
}

function classifyForbidden(argv, policy) {
  const cmd = commandName(argv[0]);
  const args = argv.slice(1).map(String);
  const first = (args[0] || '').toLowerCase();
  const network = listFromPolicy(policy, 'network_commands', ['curl', 'wget']);
  const providers = listFromPolicy(policy, 'provider_commands', ['openai', 'anthropic', 'gemini']);
  const memory = listFromPolicy(policy, 'memory_commands', ['codex-memory', 'dailynote']);
  const gitRemote = listFromPolicy(policy, 'git_remote_subcommands', ['push', 'pull', 'fetch', 'clone', 'ls-remote', 'submodule']);
  const destructive = listFromPolicy(policy, 'destructive_commands', ['rm', 'rmdir', 'del']);

  if (network.map(commandName).includes(cmd)) {
    return { category: 'network', rule: 'DENY_NETWORK_COMMAND', reason: 'network commands are forbidden in dry-run' };
  }
  if (providers.map(commandName).includes(cmd)) {
    return { category: 'provider_call', rule: 'DENY_PROVIDER_COMMAND', reason: 'provider API commands are forbidden' };
  }
  if (memory.map(commandName).includes(cmd)) {
    return { category: 'memory_write', rule: 'DENY_MEMORY_COMMAND', reason: 'memory writes are forbidden' };
  }
  if (destructive.map(commandName).includes(cmd)) {
    return { category: 'destructive', rule: 'DENY_DESTRUCTIVE_COMMAND', reason: 'destructive commands are forbidden' };
  }
  if (cmd === 'git' && gitRemote.map((item) => String(item).toLowerCase()).includes(first)) {
    if (first === 'push' && args.some((arg) => /^--force($|-|=)/.test(arg))) {
      return { category: 'force_push', rule: 'DENY_FORCE_PUSH', reason: 'force push is forbidden' };
    }
    return { category: 'git_remote', rule: 'DENY_GIT_REMOTE', reason: 'git remote operations are forbidden in dry-run' };
  }
  return null;
}

function argsMatch(actual, expected) {
  if (!Array.isArray(expected) || actual.length !== expected.length) {
    return false;
  }
  return expected.every((value, index) => String(actual[index]) === String(value));
}

function argsPrefixMatch(actual, expected) {
  if (!Array.isArray(expected) || actual.length < expected.length) {
    return false;
  }
  return expected.every((value, index) => String(actual[index]) === String(value));
}

function classifyAllowed(argv, policy) {
  const cmd = commandName(argv[0]);
  const args = argv.slice(1).map(String);
  for (const rule of policy.allow || []) {
    if (commandName(rule.command) !== cmd) {
      continue;
    }
    if (rule.args && argsMatch(args, rule.args)) {
      return { rule: 'ALLOW_EXACT', reason: rule.reason || 'allow rule matched' };
    }
    if (rule.args_prefix && argsPrefixMatch(args, rule.args_prefix)) {
      return { rule: 'ALLOW_PREFIX', reason: rule.reason || 'allow prefix matched' };
    }
  }
  return null;
}

function evaluatePolicy(argv) {
  const policy = loadPolicy();
  const mission = loadMission();
  if (!Array.isArray(argv) || argv.length === 0) {
    return {
      decision: 'DENY',
      allowed: false,
      rule: 'DENY_EMPTY_COMMAND',
      reason: 'no command was provided',
      category: 'invalid'
    };
  }
  const deniedPath = classifyDeniedPathArgs(argv, mission, policy);
  if (deniedPath) {
    return Object.assign({ decision: 'DENY', allowed: false }, deniedPath);
  }
  const denied = classifyForbidden(argv, policy);
  if (denied) {
    return Object.assign({ decision: 'DENY', allowed: false }, denied);
  }
  const allowed = classifyAllowed(argv, policy);
  if (allowed) {
    return Object.assign({ decision: 'ALLOW', allowed: true, category: 'local' }, allowed);
  }
  return {
    decision: 'DENY',
    allowed: false,
    rule: 'DENY_NOT_ALLOWLISTED',
    reason: 'command is not in the dry-run allowlist',
    category: 'not_allowlisted'
  };
}

function splitAfterDashDash(args) {
  const marker = args.indexOf('--');
  return marker === -1 ? args : args.slice(marker + 1);
}

function runCommand(argv, options) {
  const opts = options || {};
  return new Promise((resolve) => {
    const started = new Date().toISOString();
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: ROOT,
        env: scrubbedEnv(),
        shell: false,
        stdio: opts.inherit ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({
        argv: scrubArgv(argv),
        started_at: started,
        finished_at: new Date().toISOString(),
        exit_code: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: error.message
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    if (!opts.inherit) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.stdin.end(opts.input || '');
    }
    child.on('error', (error) => {
      resolve({
        argv: scrubArgv(argv),
        started_at: started,
        finished_at: new Date().toISOString(),
        exit_code: null,
        signal: null,
        stdout,
        stderr,
        error: error.message
      });
    });
    child.on('close', (code, signal) => {
      resolve({
        argv: scrubArgv(argv),
        started_at: started,
        finished_at: new Date().toISOString(),
        exit_code: code,
        signal,
        stdout,
        stderr,
        error: null
      });
    });
  });
}

function truncate(text) {
  const value = String(text || '');
  return value.length > 4000 ? value.slice(0, 4000) + '\n[TRUNCATED]' : value;
}

function parseJsonLine(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch (_error) {
      continue;
    }
  }
  return null;
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

async function handleCheck(args) {
  const argv = splitAfterDashDash(args);
  const decision = evaluatePolicy(argv);
  const payload = {
    command: scrubArgv(argv),
    decision: decision.decision,
    allowed: decision.allowed,
    rule: decision.rule,
    category: decision.category,
    reason: decision.reason,
    spawned: false
  };
  appendLedger('policy_check', payload, (state) => {
    state.last_policy_decision = payload;
  });
  console.log(JSON.stringify({ ok: true, command: payload.command, decision: decision.decision, allowed: decision.allowed, spawned: false, reason: decision.reason, rule: decision.rule }));
}

async function handleExec(args) {
  const argv = splitAfterDashDash(args);
  const decision = evaluatePolicy(argv);
  appendLedger('policy_check', {
    command: scrubArgv(argv),
    decision: decision.decision,
    allowed: decision.allowed,
    rule: decision.rule,
    category: decision.category,
    reason: decision.reason,
    spawned: false
  }, (state) => {
    state.last_policy_decision = {
      command: scrubArgv(argv),
      decision: decision.decision,
      allowed: decision.allowed,
      rule: decision.rule,
      category: decision.category,
      reason: decision.reason,
      spawned: false
    };
  });
  if (!decision.allowed) {
    console.log(JSON.stringify({ ok: false, decision: 'DENY', allowed: false, spawned: false, reason: decision.reason, rule: decision.rule }));
    process.exitCode = 2;
    return;
  }
  const result = await runCommand(argv, { inherit: true });
  appendLedger('command_execution', {
    command: scrubArgv(argv),
    spawned: true,
    shell: false,
    exit_code: result.exit_code,
    signal: result.signal,
    error: result.error
  });
  if (result.exit_code !== 0 || result.error) {
    process.exitCode = result.exit_code || 1;
  }
}

function commandExpectationPassed(result, expect) {
  const problems = [];
  if (Object.prototype.hasOwnProperty.call(expect, 'exit_code') && result.exit_code !== expect.exit_code) {
    problems.push(`exit_code expected ${expect.exit_code} got ${result.exit_code}`);
  }
  if (Object.prototype.hasOwnProperty.call(expect, 'decision') || Object.prototype.hasOwnProperty.call(expect, 'spawned')) {
    const parsed = parseJsonLine(result.stdout);
    if (!parsed) {
      problems.push('expected JSON policy output was not found');
    } else {
      if (Object.prototype.hasOwnProperty.call(expect, 'decision') && parsed.decision !== expect.decision) {
        problems.push(`decision expected ${expect.decision} got ${parsed.decision}`);
      }
      if (Object.prototype.hasOwnProperty.call(expect, 'spawned') && parsed.spawned !== expect.spawned) {
        problems.push(`spawned expected ${expect.spawned} got ${parsed.spawned}`);
      }
    }
  }
  if (result.error) {
    problems.push(result.error);
  }
  return problems;
}

async function handleValidate() {
  const validation = readJsonStrict(VALIDATION_PATH);
  const required = validation.required_commands || [];
  const inputsHash = validationInputsHash();
  appendLedger('validation_started', {
    required_command_count: required.length,
    inputs_hash: inputsHash
  });

  const commandResults = [];
  for (const command of required) {
    const result = await runCommand(command.argv, {});
    const problems = commandExpectationPassed(result, command.expect || {});
    const status = problems.length === 0 ? 'PASS' : 'FAIL';
    const record = {
      id: command.id,
      argv: scrubArgv(command.argv),
      expect: command.expect || {},
      status,
      problems,
      exit_code: result.exit_code,
      signal: result.signal,
      error: result.error,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      started_at: result.started_at,
      finished_at: result.finished_at
    };
    commandResults.push(record);
    appendLedger('validation_step', {
      id: record.id,
      argv: record.argv,
      status: record.status,
      problems: record.problems,
      exit_code: record.exit_code,
      signal: record.signal,
      error: record.error
    });
  }

  const status = commandResults.every((result) => result.status === 'PASS') ? 'PASS' : 'FAIL';
  const completedAt = new Date().toISOString();
  const summary = {
    status,
    completed_at: completedAt,
    inputs_hash: inputsHash,
    commands: commandResults.map((result) => ({
      id: result.id,
      argv: result.argv,
      expect: result.expect,
      status: result.status,
      problems: result.problems,
      exit_code: result.exit_code,
      signal: result.signal,
      error: result.error
    }))
  };
  appendLedger('validation_completed', summary, (state, event) => {
    state.validation = {
      status,
      completed_at: completedAt,
      inputs_hash: inputsHash,
      ledger_event_hash: event.event_hash,
      commands: summary.commands
    };
  });
  console.log(JSON.stringify({
    ok: status === 'PASS',
    status,
    commands: summary.commands
  }));
  if (status !== 'PASS') {
    process.exitCode = 1;
  }
}

async function handleVerify() {
  const result = await runCommand(['node', 'scripts/bha-verify.js'], {});
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.error) {
    console.error(result.error);
  }
  process.exitCode = result.exit_code || (result.error ? 1 : 0);
}

function capabilityType(payload) {
  return String(payload.type || payload.for || payload.capability || '').trim();
}

function disallowedCapabilityType(type) {
  const policy = loadPolicy();
  const disallowed = (((policy.capabilities || {}).disallowed_types) || []).map((item) => String(item));
  return disallowed.includes(String(type));
}

function trustedSigningKeys() {
  const policy = loadPolicy();
  return (((policy.capabilities || {}).trusted_signing_keys) || []).map((item) => {
    if (item && typeof item === 'object') {
      return {
        id: String(item.id || item.key_id || ''),
        public_key_pem: item.public_key_pem || item.publicKeyPem || null
      };
    }
    return { id: String(item), public_key_pem: null };
  }).filter((item) => item.id);
}

function findTrustedSigningKey(id) {
  return trustedSigningKeys().find((item) => item.id === String(id));
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

function signCapabilityPayload(payload, privateKey) {
  payload.payload_hash = capabilityPayloadHash(payload);
  payload.signature = crypto.sign(
    null,
    Buffer.from(stable(capabilitySignablePayload(payload))),
    privateKey
  ).toString('base64');
  return payload;
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

function capabilityRevoked(events, id) {
  return events.some((event) => {
    return event.type === 'capability_revoke' &&
      event.payload &&
      event.payload.capability_id === id &&
      event.payload.valid !== false;
  });
}

function validateCapabilityRequest(payload, type, state, events, options) {
  const checkLedgerHead = !options || options.checkLedgerHead !== false;
  const id = String(payload.id || payload.capability_id || '');
  if (!id) {
    return { valid: false, reason: 'CAPABILITY_ID_MISSING' };
  }
  if (disallowedCapabilityType(type)) {
    return { valid: false, reason: 'DISALLOWED_CAPABILITY_TYPE' };
  }
  if (type !== 'git_push') {
    return { valid: false, reason: 'CAPABILITY_TYPE_NOT_SUPPORTED' };
  }
  if (!payload.signature || !payload.signing_key_id) {
    return { valid: false, reason: 'UNSIGNED_CAPABILITY_INVALID' };
  }
  const key = findTrustedSigningKey(payload.signing_key_id);
  if (!key) {
    return { valid: false, reason: 'UNKNOWN_SIGNING_KEY' };
  }
  if (!key.public_key_pem) {
    return { valid: false, reason: 'SIGNING_KEY_HAS_NO_PUBLIC_KEY' };
  }
  if (payload.payload_hash && payload.payload_hash !== capabilityPayloadHash(payload)) {
    return { valid: false, reason: 'CAPABILITY_PAYLOAD_HASH_MISMATCH' };
  }
  if (!capabilitySignatureValid(payload, key)) {
    return { valid: false, reason: 'CAPABILITY_SIGNATURE_INVALID' };
  }
  if (payload.run_id !== state.run_id) {
    return { valid: false, reason: 'CAPABILITY_RUN_ID_MISMATCH' };
  }
  if (!payload.remote || !payload.branch || !payload.head) {
    return { valid: false, reason: 'CAPABILITY_BINDING_MISSING' };
  }
  if (checkLedgerHead && payload.ledger_head_hash !== state.ledger_head_hash) {
    return { valid: false, reason: 'CAPABILITY_LEDGER_HEAD_MISMATCH' };
  }
  if (payload.one_use !== true) {
    return { valid: false, reason: 'CAPABILITY_ONE_USE_REQUIRED' };
  }
  if (isExpired(payload.expires_at)) {
    return { valid: false, reason: 'CAPABILITY_EXPIRED' };
  }
  if (capabilityRevoked(events || [], id)) {
    return { valid: false, reason: 'CAPABILITY_REVOKED' };
  }
  return { valid: true, reason: 'CAPABILITY_SIGNATURE_VALID' };
}

function capabilityHash(event) {
  const copy = Object.assign({}, event);
  delete copy.event_hash;
  return sha256(stable(copy));
}

function appendCapabilityEvent(type, payload) {
  const event = {
    schema: 'bha.capability.event.v1',
    run_id: loadState().run_id,
    event_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    type,
    payload
  };
  event.event_hash = capabilityHash(event);
  fs.appendFileSync(CAPABILITIES_PATH, stable(event) + '\n', 'utf8');
  appendLedger(`capability_${type}`, {
    capability_event_hash: event.event_hash,
    capability_id: payload.capability_id || payload.id || null,
    status: payload.status,
    valid: payload.valid === true,
    reason: payload.reason || null
  });
  return event;
}

function readCapabilityEvents() {
  return readJsonl(CAPABILITIES_PATH);
}

function findCapabilityIssue(events, id) {
  return events.find((event) => event.type === 'capability_issue' &&
    event.payload &&
    event.payload.capability_id === id &&
    event.payload.valid === true);
}

function ensureTrustedSigningKey(keyId, publicKeyPem) {
  const policy = loadPolicy();
  policy.capabilities = policy.capabilities || {};
  const keys = Array.isArray(policy.capabilities.trusted_signing_keys)
    ? policy.capabilities.trusted_signing_keys
    : [];
  if (!keys.some((item) => String(item.id || item.key_id || '') === String(keyId))) {
    keys.push({ id: keyId, public_key_pem: publicKeyPem });
  }
  policy.capabilities.trusted_signing_keys = keys;
  writeJson(POLICY_PATH, policy);
}

function validCapabilityConsumes(events, id) {
  return events.filter((event) => event.type === 'capability_consume' &&
    event.payload &&
    event.payload.capability_id === id &&
    event.payload.valid === true);
}

function validCapabilitySessions(events, id) {
  return events.filter((event) => event.type === 'capability_session' &&
    event.payload &&
    event.payload.capability_id === id &&
    event.payload.valid === true);
}

async function handleIssueCapability(args) {
  const jsonIndex = args.indexOf('--json');
  if (jsonIndex === -1 || !args[jsonIndex + 1]) {
    console.log(JSON.stringify({ ok: false, error: 'missing --json payload' }));
    process.exitCode = 2;
    return;
  }
  let payload;
  try {
    payload = JSON.parse(args[jsonIndex + 1]);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: `invalid JSON payload: ${error.message}` }));
    process.exitCode = 2;
    return;
  }
  const type = capabilityType(payload);
  const id = String(payload.id || payload.capability_id || crypto.randomUUID());
  payload.capability_id = id;
  const state = loadState();
  const validation = validateCapabilityRequest(payload, type, state, readCapabilityEvents());
  const valid = validation.valid === true;
  const status = valid ? 'VALID' : 'INVALID';
  const reason = validation.reason;
  const event = appendCapabilityEvent('capability_issue', {
    capability_id: id,
    requested: payload,
    capability_type: type || 'UNKNOWN',
    valid,
    status,
    reason
  });
  console.log(JSON.stringify({
    ok: valid,
    capability_id: id,
    valid,
    status,
    reason,
    capability_store: '.bha/capabilities.jsonl',
    event_hash: event.event_hash
  }));
  if (!valid) {
    process.exitCode = 2;
  }
}

function getOption(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
}

async function currentHead() {
  const result = await runCommand(['git', 'rev-parse', 'HEAD'], {});
  if (result.exit_code !== 0) {
    return null;
  }
  return result.stdout.trim();
}

async function handleConsumeCapability(args) {
  const id = getOption(args, '--id');
  const forAction = getOption(args, '--for');
  const remote = getOption(args, '--remote');
  const branch = getOption(args, '--branch');
  if (!id || !forAction || !remote || !branch) {
    console.log(JSON.stringify({ ok: false, error: 'missing --id, --for, --remote, or --branch' }));
    process.exitCode = 2;
    return;
  }
  const events = readCapabilityEvents();
  const issue = findCapabilityIssue(events, id);
  let valid = false;
  let status = 'DENIED';
  let reason = issue ? issue.payload.reason || 'CAPABILITY_INVALID' : 'CAPABILITY_NOT_FOUND';
  const state = loadState();
  const head = await currentHead();
  if (issue) {
    const requested = issue.payload.requested || {};
    const existingConsumed = validCapabilityConsumes(events, id);
    const existingSessions = validCapabilitySessions(events, id);
    const validation = validateCapabilityRequest(requested, issue.payload.capability_type, state, events, { checkLedgerHead: false });
    if (issue.payload.valid !== true || validation.valid !== true) {
      reason = validation.reason || issue.payload.reason || 'CAPABILITY_INVALID';
    } else if (capabilityRevoked(events, id)) {
      reason = 'CAPABILITY_REVOKED';
    } else if (existingConsumed.length > 0 || existingSessions.length > 0) {
      reason = 'CAPABILITY_ALREADY_CONSUMED';
    } else if (issue.payload.capability_type !== forAction || forAction !== 'git_push' || disallowedCapabilityType(forAction)) {
      reason = 'CAPABILITY_ACTION_MISMATCH';
    } else if (requested.run_id !== state.run_id) {
      reason = 'CAPABILITY_RUN_ID_MISMATCH';
    } else if (requested.remote !== remote) {
      reason = 'CAPABILITY_REMOTE_MISMATCH';
    } else if (requested.branch !== branch) {
      reason = 'CAPABILITY_BRANCH_MISMATCH';
    } else if (requested.head !== head) {
      reason = 'CAPABILITY_HEAD_MISMATCH';
    } else if (requested.one_use !== true) {
      reason = 'CAPABILITY_ONE_USE_REQUIRED';
    } else if (isExpired(requested.expires_at)) {
      reason = 'CAPABILITY_EXPIRED';
    } else {
      valid = true;
      status = 'CONSUMED';
      reason = 'CAPABILITY_CONSUMED';
    }
  }
  const event = appendCapabilityEvent('capability_consume', {
    capability_id: id,
    for: forAction,
    remote,
    branch,
    head,
    issue_event_hash: issue ? issue.event_hash : null,
    one_use: true,
    valid,
    status,
    reason
  });
  console.log(JSON.stringify({
    ok: valid,
    capability_id: id,
    valid,
    status,
    reason,
    capability_store: '.bha/capabilities.jsonl',
    event_hash: event.event_hash
  }));
  if (!valid) {
    process.exitCode = 2;
  }
}

async function gitStatusShort() {
  const result = await runCommand(['git', 'status', '--short'], {});
  return {
    ok: result.exit_code === 0 && !result.error,
    clean: result.exit_code === 0 && result.stdout.trim() === '',
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    exit_code: result.exit_code
  };
}

function authorizedRuntimeDirty(stdout) {
  const allowed = new Set(['.bha/capabilities.jsonl', '.bha/ledger.jsonl', '.bha/state.json']);
  const lines = String(stdout || '').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    return true;
  }
  return lines.every((line) => {
    const touched = line.slice(3).trim().replace(/.* -> /, '').replace(/\\/g, '/');
    return allowed.has(touched);
  });
}

async function currentBranch() {
  const result = await runCommand(['git', 'branch', '--show-current'], {});
  if (result.exit_code !== 0 || result.error) {
    return null;
  }
  return result.stdout.trim();
}

async function verifierResult() {
  const result = await runCommand(['node', 'scripts/bha-verify.js'], {});
  const parsed = parseJsonLine(result.stdout);
  return {
    ok: result.exit_code === 0 && parsed && parsed.ok === true,
    exit_code: result.exit_code,
    error: result.error,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed
  };
}

async function matchingConsumedCapability(remote, branch, head, options) {
  const reserve = options && options.reserve === true;
  const state = loadState();
  const events = readCapabilityEvents();
  const issues = new Map();
  for (const event of events) {
    if (event.type === 'capability_issue' && event.payload && event.payload.valid === true) {
      issues.set(event.payload.capability_id, event);
    }
  }
  for (const event of events) {
    if (event.type !== 'capability_consume' || !event.payload || event.payload.valid !== true) {
      continue;
    }
    const marker = event.payload;
    const id = marker.capability_id;
    const issue = issues.get(id);
    const requested = issue && issue.payload ? issue.payload.requested || {} : {};
    const markerMatches = marker.for === 'git_push' &&
      marker.remote === remote &&
      marker.branch === branch &&
      marker.head === head &&
      (!requested.remote || requested.remote === remote) &&
      (!requested.branch || requested.branch === branch) &&
      (!requested.head || requested.head === head);
    if (!markerMatches) {
      continue;
    }
    const consumes = validCapabilityConsumes(events, id);
    if (consumes.length !== 1) {
      return { ok: false, reason: 'CAPABILITY_REPLAY_DETECTED', capability_id: id };
    }
    if (validCapabilitySessions(events, id).length > 0) {
      return { ok: false, reason: 'CAPABILITY_REPLAY_DETECTED', capability_id: id };
    }
    if (!issue) {
      return { ok: false, reason: 'CAPABILITY_TICKET_MISSING', capability_id: id };
    }
    const validation = validateCapabilityRequest(requested, issue.payload.capability_type, state, events, { checkLedgerHead: false });
    if (validation.valid !== true) {
      return { ok: false, reason: validation.reason, capability_id: id };
    }
    if (capabilityRevoked(events, id)) {
      return { ok: false, reason: 'CAPABILITY_REVOKED', capability_id: id };
    }
    if (marker.issue_event_hash !== issue.event_hash) {
      return { ok: false, reason: 'CAPABILITY_ISSUE_EVENT_MISMATCH', capability_id: id };
    }
    if (marker.for === 'git_push' &&
        marker.remote === remote &&
        marker.branch === branch &&
        marker.head === head &&
        event.run_id === state.run_id &&
        requested.run_id === state.run_id &&
        requested.remote === remote &&
        requested.branch === branch &&
        requested.head === head &&
        requested.one_use === true &&
        !isExpired(requested.expires_at)) {
      if (reserve) {
        const session = appendCapabilityEvent('capability_session', {
          capability_id: id,
          remote,
          branch,
          head,
          valid: true,
          status: 'USED',
          reason: 'CAPABILITY_USED'
        });
        return { ok: true, event_hash: session.event_hash, capability_id: id };
      }
      return { ok: true, event_hash: event.event_hash, capability_id: id };
    }
  }
  return { ok: false, reason: 'NO_VALID_CONSUMED_GIT_PUSH_CAPABILITY' };
}

function readStdin() {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.on('data', (chunk) => {
      text += chunk.toString();
    });
    process.stdin.on('end', () => resolve(text));
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

function branchFromPrepushInput(stdinText) {
  const line = String(stdinText || '').split(/\r?\n/).find((item) => item.trim() !== '');
  if (!line) {
    return null;
  }
  const parts = line.trim().split(/\s+/);
  const remoteRef = parts[2] || '';
  const match = remoteRef.match(/^refs\/heads\/(.+)$/);
  return match ? match[1] : null;
}

async function handlePrepushCheck(args) {
  if (args[0] !== '--internal-git-hook') {
    console.log(JSON.stringify({ ok: false, status: 'FAIL_CLOSED', reason: 'missing internal hook marker' }));
    process.exitCode = 1;
    return;
  }
  const remote = args[1] || null;
  const stdinText = await readStdin();
  const branch = branchFromPrepushInput(stdinText) || await currentBranch();
  const head = await currentHead();
  const status = await gitStatusShort();
  const verify = await verifierResult();
  let capability = remote && branch && head ? await matchingConsumedCapability(remote, branch, head, { reserve: false }) : { ok: false, reason: 'MISSING_REMOTE_BRANCH_OR_HEAD' };
  const checks = {
    verifier_pass: verify.ok === true,
    clean_ledger: verify.parsed ? verify.parsed.ok === true : false,
    valid_consumed_capability: capability.ok === true,
    matching_run_id_remote_branch_head: capability.ok === true,
    clean_git_status: status.ok === true && (status.clean === true || authorizedRuntimeDirty(status.stdout))
  };
  let ok = Object.values(checks).every(Boolean);
  if (ok) {
    capability = await matchingConsumedCapability(remote, branch, head, { reserve: true });
    checks.valid_consumed_capability = capability.ok === true;
    checks.matching_run_id_remote_branch_head = capability.ok === true;
    ok = Object.values(checks).every(Boolean);
  }
  appendLedger('prepush_check', {
    status: ok ? 'ALLOW' : 'FAIL_CLOSED',
    remote: remote || 'UNKNOWN',
    branch: branch || 'UNKNOWN',
    head: head || 'UNKNOWN',
    checks,
    capability: {
      ok: capability.ok === true,
      reason: capability.reason || null,
      capability_id: capability.capability_id || null
    }
  });
  console.log(JSON.stringify({
    ok,
    status: ok ? 'ALLOW' : 'FAIL_CLOSED',
    remote: remote || 'UNKNOWN',
    branch: branch || 'UNKNOWN',
    head: head || 'UNKNOWN',
    checks,
    capability,
    git_status: {
      ok: status.ok,
      clean: status.clean,
      authorized_runtime_dirty: status.ok === true && status.clean !== true ? authorizedRuntimeDirty(status.stdout) : false,
      exit_code: status.exit_code,
      error: status.error,
      stderr: truncate(status.stderr)
    }
  }));
  if (!ok) {
    process.exitCode = 1;
  }
}

async function runCapabilityIssue(payload) {
  const result = await runCommand(['node', 'scripts/bha-run.js', 'issue-capability', '--json', JSON.stringify(payload)], {});
  return {
    ok: result.exit_code === 0,
    exit_code: result.exit_code,
    parsed: parseJsonLine(result.stdout),
    stderr: truncate(result.stderr),
    error: result.error
  };
}

async function runCapabilityConsume(id, remote, branch) {
  const result = await runCommand([
    'node',
    'scripts/bha-run.js',
    'consume-capability',
    '--id',
    id,
    '--for',
    'git_push',
    '--remote',
    remote,
    '--branch',
    branch
  ], {});
  return {
    ok: result.exit_code === 0,
    exit_code: result.exit_code,
    parsed: parseJsonLine(result.stdout),
    stderr: truncate(result.stderr),
    error: result.error
  };
}

async function recordPrepushSimulation(remote, branch, head, label) {
  let capability = await matchingConsumedCapability(remote, branch, head, { reserve: false });
  let ok = capability.ok === true;
  if (ok) {
    capability = await matchingConsumedCapability(remote, branch, head, { reserve: true });
    ok = capability.ok === true;
  }
  appendLedger('prepush_check', {
    status: ok ? 'ALLOW' : 'FAIL_CLOSED',
    simulation: true,
    label,
    remote,
    branch,
    head,
    checks: {
      capability_replay: capability.ok === true,
      matching_run_id_remote_branch_head: capability.ok === true,
      real_git_push_executed: false
    },
    capability: {
      ok: capability.ok === true,
      reason: capability.reason || null,
      capability_id: capability.capability_id || null
    }
  });
  return {
    status: ok ? 'PASS' : 'FAIL_CLOSED',
    ok,
    reason: capability.reason || null,
    capability_id: capability.capability_id || null
  };
}

function selftestCapabilityPayload(id, keyId, privateKey, bindings, overrides) {
  const payload = Object.assign({
    id,
    capability_id: id,
    type: 'git_push',
    run_id: bindings.run_id,
    remote: bindings.remote,
    branch: bindings.branch,
    head: bindings.head,
    ledger_head_hash: loadState().ledger_head_hash,
    one_use: true,
    expires_at: bindings.expires_at,
    signing_key_id: keyId
  }, overrides || {});
  return signCapabilityPayload(payload, privateKey);
}

async function handleCapabilitySelftest(args) {
  if (!args.includes('--record')) {
    console.log(JSON.stringify({ ok: false, error: 'capability-selftest requires --record' }));
    process.exitCode = 2;
    return;
  }
  const branch = await currentBranch();
  const head = await currentHead();
  if (!branch || !head) {
    console.log(JSON.stringify({ ok: false, status: 'FAIL', reason: 'GIT_BRANCH_OR_HEAD_UNKNOWN' }));
    process.exitCode = 1;
    return;
  }

  const keyId = `canonical-selftest-${Date.now()}-${crypto.randomUUID()}`;
  const keypair = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = keypair.publicKey.export({ type: 'spki', format: 'pem' });
  ensureTrustedSigningKey(keyId, publicKeyPem);

  const bindings = {
    run_id: loadState().run_id,
    remote: 'origin',
    branch,
    head,
    expires_at: '9999-12-31T23:59:59.000Z'
  };

  const results = {
    unsigned_capability: { status: 'NOT_RECORDED' },
    expired_capability: { status: 'NOT_RECORDED' },
    mismatched_remote: { status: 'NOT_RECORDED' },
    mismatched_branch: { status: 'NOT_RECORDED' },
    mismatched_head: { status: 'NOT_RECORDED' },
    reused_capability: { status: 'NOT_RECORDED' }
  };

  const unsignedId = `${keyId}-unsigned`;
  const unsignedPayload = selftestCapabilityPayload(unsignedId, keyId, keypair.privateKey, bindings);
  delete unsignedPayload.signature;
  const unsignedIssue = await runCapabilityIssue(unsignedPayload);
  results.unsigned_capability = {
    status: unsignedIssue.ok ? 'UNEXPECTED_PASS' : 'FAIL_CLOSED',
    reason: unsignedIssue.parsed ? unsignedIssue.parsed.reason : 'UNKNOWN'
  };

  const expiredId = `${keyId}-expired`;
  const expiredPayload = selftestCapabilityPayload(expiredId, keyId, keypair.privateKey, bindings, {
    expires_at: '2000-01-01T00:00:00.000Z'
  });
  const expiredIssue = await runCapabilityIssue(expiredPayload);
  results.expired_capability = {
    status: expiredIssue.ok ? 'UNEXPECTED_PASS' : 'FAIL_CLOSED',
    reason: expiredIssue.parsed ? expiredIssue.parsed.reason : 'UNKNOWN'
  };

  const remoteId = `${keyId}-remote`;
  const remoteIssue = await runCapabilityIssue(selftestCapabilityPayload(remoteId, keyId, keypair.privateKey, bindings, {
    remote: 'upstream'
  }));
  const remoteConsume = await runCapabilityConsume(remoteId, 'upstream', bindings.branch);
  if (remoteConsume.ok) {
    appendCapabilityEvent('capability_session', {
      capability_id: remoteId,
      remote: 'upstream',
      branch: bindings.branch,
      head: bindings.head,
      valid: true,
      status: 'USED',
      reason: 'CAPABILITY_USED_BY_SELFTEST'
    });
  }
  const remoteSimulation = await recordPrepushSimulation(bindings.remote, bindings.branch, bindings.head, 'mismatched_remote');
  results.mismatched_remote = {
    status: !remoteSimulation.ok ? 'FAIL_CLOSED' : 'UNEXPECTED_PASS',
    reason: remoteSimulation.reason || 'NO_VALID_CONSUMED_GIT_PUSH_CAPABILITY',
    issue_ok: remoteIssue.ok,
    consume_ok: remoteConsume.ok
  };

  const branchId = `${keyId}-branch`;
  const mismatchedBranch = `${bindings.branch}-mismatch`;
  const branchIssue = await runCapabilityIssue(selftestCapabilityPayload(branchId, keyId, keypair.privateKey, bindings, {
    branch: mismatchedBranch
  }));
  const branchConsume = await runCapabilityConsume(branchId, bindings.remote, mismatchedBranch);
  if (branchConsume.ok) {
    appendCapabilityEvent('capability_session', {
      capability_id: branchId,
      remote: bindings.remote,
      branch: mismatchedBranch,
      head: bindings.head,
      valid: true,
      status: 'USED',
      reason: 'CAPABILITY_USED_BY_SELFTEST'
    });
  }
  const branchSimulation = await recordPrepushSimulation(bindings.remote, bindings.branch, bindings.head, 'mismatched_branch');
  results.mismatched_branch = {
    status: !branchSimulation.ok ? 'FAIL_CLOSED' : 'UNEXPECTED_PASS',
    reason: branchSimulation.reason || 'NO_VALID_CONSUMED_GIT_PUSH_CAPABILITY',
    issue_ok: branchIssue.ok,
    consume_ok: branchConsume.ok
  };

  const headId = `${keyId}-head`;
  const headIssue = await runCapabilityIssue(selftestCapabilityPayload(headId, keyId, keypair.privateKey, bindings, {
    head: '0000000000000000000000000000000000000000'
  }));
  const headSimulation = await recordPrepushSimulation(bindings.remote, bindings.branch, '0000000000000000000000000000000000000000', 'mismatched_head');
  results.mismatched_head = {
    status: !headSimulation.ok ? 'FAIL_CLOSED' : 'UNEXPECTED_PASS',
    reason: headSimulation.reason || 'NO_VALID_CONSUMED_GIT_PUSH_CAPABILITY',
    issue_ok: headIssue.ok,
    consume_ok: false
  };

  const positiveId = `${keyId}-positive`;
  const positiveIssue = await runCapabilityIssue(selftestCapabilityPayload(positiveId, keyId, keypair.privateKey, bindings));
  const positiveConsume = await runCapabilityConsume(positiveId, bindings.remote, bindings.branch);
  const positiveSimulation = await recordPrepushSimulation(bindings.remote, bindings.branch, bindings.head, 'positive_authorized');
  const replaySimulation = await recordPrepushSimulation(bindings.remote, bindings.branch, bindings.head, 'reused_capability');
  results.reused_capability = {
    status: !replaySimulation.ok ? 'FAIL_CLOSED' : 'UNEXPECTED_PASS',
    reason: replaySimulation.reason || 'UNKNOWN'
  };

  const positive = {
    status: positiveIssue.ok && positiveConsume.ok && positiveSimulation.ok ? 'PASS' : 'FAIL',
    capability_id: positiveId,
    issue_ok: positiveIssue.ok,
    consume_ok: positiveConsume.ok,
    simulation_ok: positiveSimulation.ok,
    reason: positiveSimulation.reason || null
  };
  const negativePass = Object.values(results).every((result) => result.status === 'FAIL_CLOSED');
  const summary = {
    status: positive.status === 'PASS' && negativePass ? 'PASS' : 'FAIL',
    completed_at: new Date().toISOString(),
    mode: 'canonical_capabilities_jsonl_selftest',
    key_id: keyId,
    public_key_recorded: true,
    private_key_repo_write: false,
    capability_positive_path: positive,
    prepush_authorized_simulation: {
      status: positiveSimulation.ok ? 'PASS' : 'FAIL',
      mode: 'internal_prepush_replay_simulation',
      real_git_push_executed: false,
      capability_id: positiveSimulation.capability_id || null
    },
    negative_capability_tests: results,
    external_effects: {
      real_git_push_executed: false,
      git_tag_executed: false,
      release_executed: false,
      deploy_executed: false,
      provider_call_executed: false,
      memory_write_executed: false,
      network_call_executed: false,
      package_install_executed: false,
      git_directory_write: false,
      private_key_repo_write: false
    }
  };

  const event = appendLedger('capability_selftest_completed', summary, (state) => {
    state.capability_selftest = summary;
  });
  console.log(JSON.stringify(Object.assign({ ok: summary.status === 'PASS', ledger_event_hash: event.event_hash }, summary)));
  if (summary.status !== 'PASS') {
    process.exitCode = 1;
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

function forbiddenLedgerEffects(ledger, policy) {
  const effects = {
    forbidden_spawned: false,
    forbidden_spawned_events: [],
    denied_before_spawn_events: 0
  };
  for (const event of ledger) {
    const payload = event.payload || {};
    const argv = Array.isArray(payload.argv) ? payload.argv : Array.isArray(payload.command) ? payload.command : null;
    const denied = argv ? classifyForbidden(argv, policy || loadPolicy()) : null;
    if (payload.decision === 'DENY' && payload.spawned === false) {
      effects.denied_before_spawn_events += 1;
    }
    if (payload.spawned === true && (payload.decision === 'DENY' || denied)) {
      effects.forbidden_spawned = true;
      effects.forbidden_spawned_events.push({
        event_hash: event.event_hash || 'UNKNOWN',
        type: event.type || 'UNKNOWN',
        category: denied ? denied.category : payload.category || 'UNKNOWN'
      });
    }
  }
  return effects;
}

function capabilityCloseoutSummary(capabilities, state) {
  const validEvents = capabilities.filter((event) => event.payload && event.payload.valid === true);
  const selftest = state && state.capability_selftest ? state.capability_selftest : null;
  return {
    events: capabilities.length,
    valid_events: validEvents.length,
    issue_events: capabilities.filter((event) => event.type === 'capability_issue').length,
    consume_events: capabilities.filter((event) => event.type === 'capability_consume').length,
    session_events: capabilities.filter((event) => event.type === 'capability_session').length,
    capability_positive_path: selftest ? selftest.capability_positive_path : 'NOT_RECORDED',
    prepush_authorized_simulation: selftest ? selftest.prepush_authorized_simulation : 'NOT_RECORDED',
    negative_capability_tests: selftest ? selftest.negative_capability_tests : 'NOT_RECORDED'
  };
}

async function handleCloseout(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const mission = fs.existsSync(MISSION_PATH) ? readJsonStrict(MISSION_PATH) : null;
  const policy = fs.existsSync(POLICY_PATH) ? readJsonStrict(POLICY_PATH) : null;
  const state = fs.existsSync(STATE_PATH) ? readJsonStrict(STATE_PATH) : null;
  const validation = fs.existsSync(VALIDATION_PATH) ? readJsonStrict(VALIDATION_PATH) : null;
  const ledger = fs.existsSync(LEDGER_PATH) ? readJsonl(LEDGER_PATH) : [];
  const capabilities = fs.existsSync(CAPABILITIES_PATH) ? readCapabilityEvents() : [];
  const gitStatus = await gitStatusShort();
  const verify = await verifierResult();
  const validationStatus = state && state.validation ? state.validation.status : 'NOT_RECORDED';
  const capabilitySummary = capabilityCloseoutSummary(capabilities, state);
  const changedFiles = gitStatus.ok ? changedFilesFromStatus(gitStatus.stdout) : [];
  const effects = forbiddenLedgerEffects(ledger, policy);
  const selftest = state && state.capability_selftest ? state.capability_selftest : null;
  const unknowns = [];
  if (!selftest) {
    unknowns.push('capability_selftest');
  }
  if (!state || !state.validation) {
    unknowns.push('validation');
  }
  console.log(JSON.stringify({
    ok: true,
    status: 'CLOSEOUT_GENERATED',
    mission: mission ? { run_id: mission.run_id, mode: mission.mode, name: mission.name } : 'UNKNOWN',
    policy: policy ? { version: policy.version, mode: policy.mode, deny_before_allow: policy.deny_rules_run_before_allow_rules === true } : 'UNKNOWN',
    state: state ? {
      run_id: state.run_id,
      ledger_head_hash: state.ledger_head_hash || 'NOT_RECORDED',
      ledger_event_count: state.ledger_event_count,
      validation_status: validationStatus || 'NOT_RECORDED'
    } : 'UNKNOWN',
    ledger: {
      events: ledger.length,
      head_hash: ledger.length ? ledger[ledger.length - 1].event_hash : 'NOT_RECORDED'
    },
    capabilities: capabilitySummary,
    validation: validation ? {
      required_commands: (validation.required_commands || []).map((command) => command.id),
      recorded_status: validationStatus || 'NOT_RECORDED',
      ledger_event_hash: state && state.validation ? state.validation.ledger_event_hash || 'NOT_RECORDED' : 'NOT_RECORDED',
      commands: state && state.validation && Array.isArray(state.validation.commands)
        ? state.validation.commands.map((command) => ({
          id: command.id,
          status: command.status,
          exit_code: command.exit_code,
          problems: command.problems || []
        }))
        : 'NOT_RECORDED'
    } : 'UNKNOWN',
    capability_positive_path: capabilitySummary.capability_positive_path,
    prepush_authorized_simulation: capabilitySummary.prepush_authorized_simulation,
    negative_capability_tests: capabilitySummary.negative_capability_tests,
    external_effects: {
      source: 'ledger_and_capability_selftest',
      forbidden_spawned: effects.forbidden_spawned,
      denied_before_spawn_events: effects.denied_before_spawn_events,
      forbidden_spawned_events: effects.forbidden_spawned_events,
      selftest: selftest ? selftest.external_effects : 'NOT_RECORDED'
    },
    changed_files: changedFiles,
    git_status: gitStatus.ok ? {
      clean: gitStatus.clean,
      short: gitStatus.stdout.trim() || 'CLEAN'
    } : {
      clean: 'UNKNOWN',
      error: gitStatus.error || truncate(gitStatus.stderr) || 'UNKNOWN'
    },
    verifier: verify.parsed || {
      ok: false,
      status: 'UNKNOWN',
      error: verify.error || truncate(verify.stderr) || 'UNKNOWN'
    },
    unknowns,
    unsupported_claims: verify.parsed && Array.isArray(verify.parsed.issues)
      ? verify.parsed.issues.filter((issue) => issue.code === 'UNSUPPORTED_CLOSEOUT_CLAIM')
      : [],
    next_gate: selftest && selftest.status === 'PASS'
      ? 'READ_ONLY_VERIFIER_AND_MANUAL_AUTHORIZATION_FOR_ANY_REAL_PUSH'
      : 'CAPABILITY_SELFTEST_REQUIRED'
  }));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'check') {
      await handleCheck(args);
    } else if (command === 'exec') {
      await handleExec(args);
    } else if (command === 'validate') {
      await handleValidate();
    } else if (command === 'verify') {
      await handleVerify();
    } else if (command === 'closeout') {
      await handleCloseout(args);
    } else if (command === 'issue-capability') {
      await handleIssueCapability(args);
    } else if (command === 'consume-capability') {
      await handleConsumeCapability(args);
    } else if (command === 'capability-selftest') {
      await handleCapabilitySelftest(args);
    } else if (command === 'prepush-check') {
      await handlePrepushCheck(args);
    } else {
      console.log(JSON.stringify({ ok: false, error: `unknown subcommand: ${command || 'NONE'}` }));
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}

main();
