#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BHA_DIR = path.join(ROOT, '.bha');
const BHA_LOCAL_DIR = path.join(BHA_DIR, 'local');
const MISSION_PATH = path.join(BHA_DIR, 'mission.yaml');
const POLICY_PATH = path.join(BHA_DIR, 'policy.yaml');
const STATE_PATH = path.join(BHA_DIR, 'state.json');
const LEDGER_PATH = path.join(BHA_DIR, 'ledger.jsonl');
const CAPABILITIES_PATH = path.join(BHA_DIR, 'capabilities.jsonl');
const LOCAL_CAPABILITIES_PATH = path.join(BHA_LOCAL_DIR, 'capabilities.jsonl');
const LOCAL_CAPABILITY_SESSIONS_PATH = path.join(BHA_LOCAL_DIR, 'capability-sessions.jsonl');
const LEDGER_LOCK_PATH = path.join(BHA_LOCAL_DIR, 'ledger.lock');
const LEDGER_LOCK_TIMEOUT_MS = 2000;
const VALIDATION_PATH = path.join(BHA_DIR, 'validation.yaml');
const ROLLBACK_PATH = path.join(BHA_DIR, 'rollback.md');
const ROADMAP_PATH = path.join(BHA_DIR, 'roadmap.md');
const CHECKPOINT_PATH = path.join(BHA_DIR, 'checkpoint.json');
const RUN_SCRIPT = path.join(ROOT, 'scripts', 'bha-run.js');
const VERIFY_SCRIPT = path.join(ROOT, 'scripts', 'bha-verify.js');
const PRE_PUSH_PATH = path.join(ROOT, '.githooks', 'pre-push');
const DESIGN_PATH = path.join(ROOT, 'BHA_DESIGN.md');
const STABILITY_PATH = path.join(ROOT, 'BHA_V1_STABILITY.md');
const CAPABILITY_FRAMEWORK_PATH = path.join(ROOT, 'BHA_V2_CAPABILITY_FRAMEWORK.md');
const COUNCIL_RUNTIME_PATH = path.join(ROOT, 'BHA_V2_COUNCIL_RUNTIME.md');
const AGENTS_PATH = path.join(ROOT, 'AGENTS.md');
const GITIGNORE_PATH = path.join(ROOT, '.gitignore');

const VALIDATION_INPUTS = [
  DESIGN_PATH,
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

function relFromRoot(root, file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function validationInputsForRoot(root) {
  return [
    path.join(root, 'BHA_DESIGN.md'),
    path.join(root, 'BHA_V1_STABILITY.md'),
    path.join(root, 'BHA_V2_CAPABILITY_FRAMEWORK.md'),
    path.join(root, 'BHA_V2_COUNCIL_RUNTIME.md'),
    path.join(root, 'AGENTS.md'),
    path.join(root, '.gitignore'),
    path.join(root, '.bha', 'mission.yaml'),
    path.join(root, '.bha', 'policy.yaml'),
    path.join(root, '.bha', 'validation.yaml'),
    path.join(root, '.bha', 'rollback.md'),
    path.join(root, '.bha', 'roadmap.md'),
    path.join(root, 'scripts', 'bha-run.js'),
    path.join(root, 'scripts', 'bha-verify.js'),
    path.join(root, '.githooks', 'pre-push')
  ];
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

function canonicalText(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
  return sha256(stable(withoutHashFields(policy || loadPolicy())));
}

function missionHash(mission) {
  return sha256(stable(withoutHashFields(mission || loadMission())));
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function canonicalValidationText(file) {
  return canonicalText(readText(file));
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

function isInsideDir(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveLocalFile(filePath) {
  const resolved = path.resolve(ROOT, filePath || '');
  if (!isInsideDir(BHA_LOCAL_DIR, resolved)) {
    throw new Error('file path must be inside .bha/local');
  }
  return resolved;
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
  fs.mkdirSync(BHA_LOCAL_DIR, { recursive: true });
  const deadline = Date.now() + LEDGER_LOCK_TIMEOUT_MS;
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(LEDGER_LOCK_PATH, 'wx');
      fs.writeFileSync(fd, stable({
        pid: process.pid,
        acquired_at: new Date().toISOString()
      }) + '\n', 'utf8');
    } catch (error) {
      if (error && error.code === 'EEXIST' && Date.now() < deadline) {
        syncSleep(25);
        continue;
      }
      if (error && error.code === 'EEXIST') {
        throw new Error('ledger lock is held by another local BHA writer');
      }
      throw error;
    }
  }
  try {
    return callback();
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        // Best effort close; unlink below is still attempted.
      }
    }
    try {
      fs.unlinkSync(LEDGER_LOCK_PATH);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function appendLedger(type, payload, mutateState) {
  return withLedgerLock(() => {
    fs.mkdirSync(BHA_DIR, { recursive: true });
    const mission = loadMission();
    const policy = loadPolicy();
    const state = loadState();
    const head = ledgerHead();
    const resolvedPayload = typeof payload === 'function'
      ? payload({ mission, policy, state, head })
      : payload;
    const event = {
      schema: 'bha.ledger.event.v1',
      run_id: state.run_id || mission.run_id,
      mission_id: mission.mission_id || null,
      policy_hash: policyHash(policy),
      mission_hash: missionHash(mission),
      event_id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      type,
      actor: 'bha-run',
      prev_hash: head.hash || 'GENESIS',
      payload: resolvedPayload
    };
    event.event_hash = eventHash(event);
    fs.appendFileSync(LEDGER_PATH, stable(event) + '\n', 'utf8');
    state.ledger_head_hash = event.event_hash;
    state.ledger_event_count = head.count + 1;
    state.policy_hash = event.policy_hash;
    state.mission_hash = event.mission_hash;
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
  const policyPatterns = policy.paths && Array.isArray(policy.paths.denied) ? policy.paths.denied : [];
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
  const denyCommands = policy.action_rules && policy.action_rules.deny_commands;
  return (denyCommands && Array.isArray(denyCommands[section])) ? denyCommands[section] : fallback;
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
  const allowRules = policy.action_rules && Array.isArray(policy.action_rules.allow) ? policy.action_rules.allow : [];
  for (const rule of allowRules) {
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

function evaluateValidationCommandPolicy(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  if (commandName(args[0]) === 'node' &&
      args[1] === 'scripts/bha-run.js' &&
      args[2] === 'check' &&
      args[3] === '--') {
    return evaluatePolicy(args.slice(0, 4));
  }
  return evaluatePolicy(args);
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
        cwd: opts.cwd || ROOT,
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

function validationInputsHashForRoot(root) {
  const entries = validationInputsForRoot(root).map((file) => {
    if (!fs.existsSync(file)) {
      return { path: relFromRoot(root, file), status: 'MISSING', sha256: null };
    }
    return { path: relFromRoot(root, file), status: 'PRESENT', sha256: sha256(canonicalValidationText(file)) };
  });
  return sha256(stable(entries));
}

function validationInputsHash() {
  return validationInputsHashForRoot(ROOT);
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
  const expectsJson = ['decision', 'spawned', 'read_only', 'recorded', 'ok', 'status', 'reason', 'json', 'has_keys', 'missing_keys'].some((key) => {
    return Object.prototype.hasOwnProperty.call(expect, key);
  });
  if (expectsJson) {
    const parsed = parseJsonLine(result.stdout);
    if (!parsed) {
      problems.push('expected JSON output was not found');
    } else {
      if (Object.prototype.hasOwnProperty.call(expect, 'decision') && parsed.decision !== expect.decision) {
        problems.push(`decision expected ${expect.decision} got ${parsed.decision}`);
      }
      if (Object.prototype.hasOwnProperty.call(expect, 'spawned') && parsed.spawned !== expect.spawned) {
        problems.push(`spawned expected ${expect.spawned} got ${parsed.spawned}`);
      }
      if (Object.prototype.hasOwnProperty.call(expect, 'read_only') && parsed.read_only !== expect.read_only) {
        problems.push(`read_only expected ${expect.read_only} got ${parsed.read_only}`);
      }
      if (Object.prototype.hasOwnProperty.call(expect, 'recorded') && parsed.recorded !== expect.recorded) {
        problems.push(`recorded expected ${expect.recorded} got ${parsed.recorded}`);
      }
      if (Object.prototype.hasOwnProperty.call(expect, 'ok') && parsed.ok !== expect.ok) {
        problems.push(`ok expected ${expect.ok} got ${parsed.ok}`);
      }
      if (Object.prototype.hasOwnProperty.call(expect, 'status') && parsed.status !== expect.status) {
        problems.push(`status expected ${expect.status} got ${parsed.status}`);
      }
      if (Object.prototype.hasOwnProperty.call(expect, 'reason') && parsed.reason !== expect.reason) {
        problems.push(`reason expected ${expect.reason} got ${parsed.reason}`);
      }
      for (const key of expect.has_keys || []) {
        if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
          problems.push(`expected JSON key ${key} was missing`);
        }
      }
      for (const key of expect.missing_keys || []) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) {
          problems.push(`unexpected JSON key ${key} was present`);
        }
      }
      for (const [key, expectedValue] of Object.entries(expect.json || {})) {
        if (parsed[key] !== expectedValue) {
          problems.push(`${key} expected ${expectedValue} got ${parsed[key]}`);
        }
      }
    }
  }
  if (result.error) {
    problems.push(result.error);
  }
  return problems;
}

function rollbackDrillChecks() {
  const checks = [];
  const addCheck = (id, pass, evidence, requirement) => {
    checks.push({
      id,
      status: pass ? 'PASS' : 'FAIL',
      evidence,
      requirement
    });
  };
  if (!fs.existsSync(ROLLBACK_PATH)) {
    addCheck('rollback_file_exists', false, rel(ROLLBACK_PATH), '.bha/rollback.md must exist');
    return checks;
  }
  const text = readText(ROLLBACK_PATH);
  const lower = text.toLowerCase();
  addCheck('rollback_file_exists', true, rel(ROLLBACK_PATH), '.bha/rollback.md must exist');
  addCheck('explicit_local_dry_run_scope', /local/i.test(text) && /dry-run/i.test(text), rel(ROLLBACK_PATH), 'rollback must be scoped to local dry-run recovery');
  addCheck('stop_using_hook_path', /hooks?\s*path|core\.hookspath|pre-push/i.test(text), rel(ROLLBACK_PATH), 'rollback must explain how to stop relying on the local pre-push hook');
  addCheck('restore_evidence_files', /\.bha\/state\.json/i.test(text) && /\.bha\/ledger\.jsonl/i.test(text) && /\.bha\/capabilities\.jsonl/i.test(text), rel(ROLLBACK_PATH), 'rollback must cover state, ledger, and capability evidence recovery');
  addCheck('recover_from_known_good_copy', /known-good|known good|version control|git restore/i.test(text), rel(ROLLBACK_PATH), 'rollback must use version control or a known-good local copy as the recovery source');
  addCheck('non_destructive_boundary', /do not run `git reset --hard`/i.test(text) && /do not run `git clean/i.test(text) && /remove-item -recurse/i.test(lower), rel(ROLLBACK_PATH), 'rollback drill must explicitly forbid destructive cleanup commands');
  addCheck('no_remote_or_external_effects', /do not push/i.test(text) && /do not tag/i.test(text) && /do not release/i.test(text) && /do not deploy/i.test(text) && /do not publish/i.test(text), rel(ROLLBACK_PATH), 'rollback drill must forbid remote and external side effects');
  addCheck('no_secret_or_private_key_access', /private key/i.test(text) && /secret/i.test(text), rel(ROLLBACK_PATH), 'rollback drill must forbid secret and private key access');
  return checks;
}

async function handleRollbackDrill(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const checks = rollbackDrillChecks();
  const failed = checks.filter((check) => check.status !== 'PASS');
  const report = {
    ok: failed.length === 0,
    status: failed.length === 0 ? 'PASS' : 'BLOCKED',
    schema: 'bha.rollback_drill.v1',
    recorded: false,
    read_only: true,
    executed_recovery_actions: false,
    rollback_path: rel(ROLLBACK_PATH),
    evidence_sources: [
      rel(ROLLBACK_PATH),
      rel(MISSION_PATH),
      rel(POLICY_PATH),
      rel(VALIDATION_PATH)
    ],
    checks,
    hard_boundaries: [
      'rollback-drill reads local repository files only',
      'rollback-drill does not modify git config, hooks, ledger, state, or repository files',
      'rollback-drill does not run git reset, git clean, Remove-Item -Recurse, push, tag, release, deploy, publish, provider calls, memory writes, or secret/private-key access'
    ]
  };
  console.log(JSON.stringify(report));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

async function handleValidate() {
  const validation = readJsonStrict(VALIDATION_PATH);
  const policy = loadPolicy();
  const mission = loadMission();
  const required = validation.required_commands || [];
  const inputsHash = validationInputsHash();
  appendLedger('validation_started', {
    required_command_count: required.length,
    inputs_hash: inputsHash,
    policy_hash: policyHash(policy),
    mission_hash: missionHash(mission)
  });

  const commandResults = [];
  for (const command of required) {
    const decision = evaluateValidationCommandPolicy(command.argv);
    let result;
    let spawned = false;
    let policyProblems = [];
    if (decision.allowed) {
      spawned = true;
      result = await runCommand(command.argv, {});
    } else {
      result = {
        argv: scrubArgv(command.argv),
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        exit_code: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: `policy denied validation command: ${decision.reason || decision.rule || 'DENY'}`
      };
      policyProblems = [result.error];
    }
    const problems = commandExpectationPassed(result, command.expect || {});
    problems.push(...policyProblems);
    const status = problems.length === 0 ? 'PASS' : 'FAIL';
    const record = {
      id: command.id,
      argv: scrubArgv(command.argv),
      expect: command.expect || {},
      decision: decision.decision,
      allowed: decision.allowed,
      rule: decision.rule,
      category: decision.category,
      reason: decision.reason,
      spawned,
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
      decision: record.decision,
      allowed: record.allowed,
      rule: record.rule,
      category: record.category,
      reason: record.reason,
      spawned: record.spawned,
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
    policy_hash: policyHash(policy),
    mission_hash: missionHash(mission),
    commands: commandResults.map((result) => ({
      id: result.id,
      argv: result.argv,
      expect: result.expect,
      decision: result.decision,
      allowed: result.allowed,
      rule: result.rule,
      category: result.category,
      reason: result.reason,
      spawned: result.spawned,
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
      policy_hash: summary.policy_hash,
      mission_hash: summary.mission_hash,
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

async function handleInspect(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const state = loadState();
  const mission = loadMission();
  const policy = loadPolicy();
  const head = ledgerHead();
  const branch = await currentBranch();
  const current = await currentHead();
  const gitStatus = await gitStatusShort();
  const verify = await verifierResult();
  console.log(JSON.stringify({
    ok: true,
    status: 'INSPECTED',
    recorded: false,
    read_only: true,
    workspace: rel(ROOT) || '.',
    branch: branch || 'UNKNOWN',
    head: current || 'UNKNOWN',
    mission: {
      mission_id: mission.mission_id || 'UNKNOWN',
      run_id: state.run_id || mission.run_id || 'UNKNOWN',
      mission_hash: missionHash(mission)
    },
    policy: {
      policy_id: policy.metadata ? policy.metadata.policy_id : 'UNKNOWN',
      mode: policy.metadata ? policy.metadata.mode : 'UNKNOWN',
      policy_hash: policyHash(policy)
    },
    ledger: {
      events: head.count,
      head_hash: head.hash || 'GENESIS',
      state_matches_head: state.ledger_head_hash === head.hash
    },
    validation: state.validation ? {
      status: state.validation.status,
      inputs_fresh: state.validation.inputs_hash === validationInputsHash(),
      ledger_event_hash: state.validation.ledger_event_hash || 'NOT_RECORDED'
    } : 'NOT_RECORDED',
    verifier: verify.parsed || {
      ok: false,
      status: 'UNKNOWN',
      error: verify.error || truncate(verify.stderr) || 'UNKNOWN'
    },
    git_status: gitStatus.ok ? {
      clean: gitStatus.clean,
      short: gitStatus.stdout.trim() || 'CLEAN'
    } : {
      clean: 'UNKNOWN',
      error: gitStatus.error || truncate(gitStatus.stderr) || 'UNKNOWN'
    },
    shell_commands: {
      validate: 'node scripts/bha-run.js validate',
      verify: 'node scripts/bha-verify.js',
      checkpoint: 'node scripts/bha-run.js checkpoint --format json',
      closeout_preview: 'node scripts/bha-run.js closeout --format json',
      gate_status: `node scripts/bha-run.js gate-status --remote origin --branch ${branch || 'master'} --format json`
    },
    proof_boundary: 'AGENTS.md, prompts, approvals, hooks, and closeout prose are behavior guidance, not proof.'
  }));
}

function capabilityType(payload) {
  return String(payload.type || payload.for || payload.capability || '').trim();
}

function capabilityFramework() {
  const policy = loadPolicy();
  const rules = policy.capability_rules || {};
  const productionTypes = (rules.capability_possible_v1 || []).map((item) => String(item));
  const alwaysDenied = (rules.always_denied_v1 || []).map((item) => String(item));
  return {
    schema: 'bha.capability_framework.v2.preview',
    recorded: false,
    read_only: true,
    default_decision: 'DENY',
    production_capability_types: productionTypes,
    always_denied_capability_types: alwaysDenied,
    unknown_capability_policy: 'DENY',
    extension_policy: {
      default_open: false,
      required_before_enablement: ['schema', 'binding', 'allowed_command', 'one_use_or_session_policy', 'local_or_tracked_evidence_policy', 'deny_tests', 'replay_tests'],
      provider_deploy_release_default: 'DENY'
    },
    test_requirements: {
      deny_tests_required_before_allow: true,
      replay_tests_required_before_allow: true,
      current_coverage: {
        runtime_regression_cases: [
          'unknown_capability_type_rejected',
          'disallowed_provider_capability_type_rejected',
          'incomplete_git_push_capability_rejected',
          'replayed_local_capability_rejected',
          'local_git_push_replay_fail_closed_after_used_session'
        ],
        verifier_selftest_cases: [
          'unsupported_capability_type_rejected',
          'disallowed_capability_type_rejected',
          'incomplete_capability_binding_rejected',
          'capability_replay_rejected'
        ],
        validation_commands: [
          'v12_regression_selftest',
          'verifier_selftest_negative_matrix',
          'capability_framework_status_readonly'
        ]
      }
    },
    types: {
      git_push: {
        status: productionTypes.includes('git_push') ? 'PRODUCTION' : 'DISABLED',
        schema: 'bha.capability.v1',
        binding_required: ['run_id', 'remote', 'branch', 'head', 'ledger_head_hash', 'policy_hash', 'mission_hash', 'expires_at'],
        allowed_command: 'git push <remote> <branch>',
        signing_key_purpose: 'owner',
        one_use_required: true,
        replay_policy: 'BLOCK',
        evidence_policy: {
          issue_store: '.bha/local/capabilities.jsonl',
          consume_store: '.bha/local/capabilities.jsonl',
          session_store: '.bha/local/capability-sessions.jsonl',
          tracked: false,
          reason: 'git_push authorization is local-only and must not dirty tracked evidence before push'
        }
      }
    },
    proof_boundary: 'Framework status describes local policy and schema only; real trust still comes from repository reality, ledger/state evidence, verifier, policy/mission hash, local-only capability evidence when needed, and git reality.'
  };
}

function capabilityTypePolicy(type) {
  const normalized = String(type || '').trim();
  const framework = capabilityFramework();
  if (!normalized) {
    return { allowed: false, reason: 'CAPABILITY_TYPE_MISSING', type: normalized };
  }
  if (framework.always_denied_capability_types.includes(normalized)) {
    return { allowed: false, reason: 'DISALLOWED_CAPABILITY_TYPE', type: normalized };
  }
  if (!framework.production_capability_types.includes(normalized)) {
    return { allowed: false, reason: 'CAPABILITY_TYPE_NOT_SUPPORTED', type: normalized };
  }
  return { allowed: true, reason: 'CAPABILITY_TYPE_SUPPORTED', type: normalized };
}

function councilRuntimeStatus() {
  return {
    schema: 'bha.council_runtime.v2.preview',
    recorded: false,
    read_only: true,
    status: 'COUNCIL_RUNTIME_STATUS',
    runtime_state: 'PREVIEW_CONTRACT_ONLY',
    default_decision: 'NO_AUTOMATED_DELEGATION',
    local_only: true,
    external_side_effects_allowed: false,
    automated_agent_spawn_allowed: false,
    provider_calls_allowed: false,
    memory_writes_allowed: false,
    roles: [
      {
        id: 'commander',
        responsibility: 'define task boundary, risk level, stop conditions, and next safe local step',
        may_create_proof: false
      },
      {
        id: 'domain_leads',
        responsibility: 'split the local queue into bounded work items with clear ownership',
        may_create_proof: false
      },
      {
        id: 'worker',
        responsibility: 'make the smallest local reversible change inside the accepted queue item',
        may_create_proof: false
      },
      {
        id: 'verifier',
        responsibility: 'review diff, run local validation, and report pass, fail, or blocker',
        may_create_proof: false
      }
    ],
    loop: [
      'commander_sets_boundary',
      'domain_leads_split_queue',
      'worker_executes_local_change',
      'verifier_reviews_and_validates',
      'commander_decides_continue_or_stop'
    ],
    stop_conditions: [
      'completion',
      'validation_failure_requiring_design_decision',
      'missing_context',
      'remote_or_side_effectful_boundary',
      'credential_or_private_key_boundary',
      'user_owned_work_risk'
    ],
    proof_boundary: 'Council role outputs, AGENTS.md, prompts, approvals, and closeout prose are not proof; proof still comes from repository reality, ledger/state evidence, verifier, policy/mission hash, local-only capability evidence when needed, and git reality.',
    validation_contract: {
      command: 'node scripts/bha-run.js council-status --format json',
      expected: {
        recorded: false,
        read_only: true,
        external_side_effects_allowed: false,
        automated_agent_spawn_allowed: false,
        provider_calls_allowed: false,
        memory_writes_allowed: false
      }
    },
    implementation_boundary: 'This command describes a local workflow contract only. It does not spawn sub-agents, call providers, write memory, push, deploy, release, tag, or publish packages.'
  };
}

function disallowedCapabilityType(type) {
  const policy = loadPolicy();
  const disallowed = (((policy.capability_rules || {}).always_denied_v1) || []).map((item) => String(item));
  return disallowed.includes(String(type));
}

function trustedSigningKeys() {
  const policy = loadPolicy();
  return ((policy.trusted_public_keys || [])).map((item) => {
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

function findTrustedSigningKey(id) {
  return trustedSigningKeys().find((item) => item.id === String(id));
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

function capabilityResult(payload, valid, reason, extra) {
  return Object.assign({
    ok: valid === true,
    status: valid === true ? 'VALID' : 'INVALID',
    valid: valid === true,
    capability_id: payload && (payload.capability_id || payload.id) ? String(payload.capability_id || payload.id) : null,
    reason,
    key_id: payload && payload.signing_key_id ? String(payload.signing_key_id) : null,
    payload_hash: payload && payload.payload_hash ? String(payload.payload_hash) : null,
    head: payload && payload.head ? String(payload.head) : null,
    ledger_head_hash: payload && payload.ledger_head_hash ? String(payload.ledger_head_hash) : null
  }, extra || {});
}

function canonicalPayloadHashFormat(value) {
  return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function validateCanonicalSignedCapability(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return capabilityResult(payload, false, 'CAPABILITY_JSON_OBJECT_REQUIRED');
  }
  if ((payload.payload && typeof payload.payload === 'object') ||
      (payload.signature && typeof payload.signature === 'object')) {
    return capabilityResult(payload, false, 'CAPABILITY_ENVELOPE_UNSUPPORTED_EXPECT_FLAT');
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'head_sha')) {
    return capabilityResult(payload, false, 'CAPABILITY_FIELD_HEAD_REQUIRED_NOT_HEAD_SHA');
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'payload_hash') &&
      !canonicalPayloadHashFormat(payload.payload_hash)) {
    return capabilityResult(payload, false, 'CAPABILITY_PAYLOAD_HASH_FORMAT_INVALID_EXPECT_RAW_HEX');
  }
  if (payload.algorithm !== 'ed25519') {
    return capabilityResult(payload, false, 'CAPABILITY_ALGORITHM_UNSUPPORTED');
  }
  if (payload.signature_encoding !== 'base64') {
    return capabilityResult(payload, false, 'CAPABILITY_SIGNATURE_ENCODING_UNSUPPORTED');
  }
  if (payload.payload_hash_format !== 'sha256-hex') {
    return capabilityResult(payload, false, 'CAPABILITY_PAYLOAD_HASH_FORMAT_UNSUPPORTED');
  }
  if (!payload.signature || typeof payload.signature !== 'string' || !payload.signing_key_id) {
    return capabilityResult(payload, false, 'UNSIGNED_CAPABILITY_INVALID');
  }
  const key = findTrustedSigningKey(payload.signing_key_id);
  if (!key) {
    return capabilityResult(payload, false, 'UNKNOWN_SIGNING_KEY');
  }
  if (!key.public_key_pem) {
    return capabilityResult(payload, false, 'SIGNING_KEY_HAS_NO_PUBLIC_KEY');
  }
  const type = capabilityType(payload);
  const typePolicy = capabilityTypePolicy(type);
  if (typePolicy.allowed !== true) {
    return capabilityResult(payload, false, typePolicy.reason);
  }
  if (!signingKeyPurposeAllowedForCapability(key, type)) {
    return capabilityResult(payload, false, 'CAPABILITY_SIGNING_KEY_PURPOSE_DENIED', signingKeyPurposeResult(key, type));
  }
  const computedHash = capabilityPayloadHash(payload);
  if (payload.payload_hash !== computedHash) {
    return capabilityResult(payload, false, 'CAPABILITY_PAYLOAD_HASH_MISMATCH', {
      computed_payload_hash: computedHash
    });
  }
  if (!capabilitySignatureValid(payload, key)) {
    return capabilityResult(payload, false, 'CAPABILITY_SIGNATURE_INVALID');
  }
  return capabilityResult(payload, true, 'CAPABILITY_SIGNATURE_VALID');
}

async function remoteExists(remote) {
  const result = await runCommand(['git', 'remote', 'get-url', remote], {});
  return result.exit_code === 0 && !result.error;
}

async function verifySignedCapability(payload) {
  const canonical = validateCanonicalSignedCapability(payload);
  if (canonical.valid !== true) {
    return canonical;
  }
  const state = loadState();
  const type = capabilityType(payload);
  if (payload.schema !== 'bha.capability.v1') {
    return capabilityResult(payload, false, 'CAPABILITY_SCHEMA_UNSUPPORTED');
  }
  if (!payload.capability_id && !payload.id) {
    return capabilityResult(payload, false, 'CAPABILITY_ID_MISSING');
  }
  const typePolicy = capabilityTypePolicy(type);
  if (typePolicy.allowed !== true) {
    return capabilityResult(payload, false, typePolicy.reason);
  }
  if (payload.run_id !== state.run_id) {
    return capabilityResult(payload, false, 'CAPABILITY_RUN_ID_MISMATCH');
  }
  if (payload.policy_hash !== policyHash()) {
    return capabilityResult(payload, false, 'CAPABILITY_POLICY_HASH_MISMATCH');
  }
  if (payload.mission_hash !== missionHash()) {
    return capabilityResult(payload, false, 'CAPABILITY_MISSION_HASH_MISMATCH');
  }
  if (!payload.remote || !payload.branch || !payload.head) {
    return capabilityResult(payload, false, 'CAPABILITY_BINDING_MISSING');
  }
  if (!await remoteExists(String(payload.remote))) {
    return capabilityResult(payload, false, 'CAPABILITY_REMOTE_UNKNOWN');
  }
  const branch = await currentBranch();
  if (payload.branch !== branch) {
    return capabilityResult(payload, false, 'CAPABILITY_BRANCH_MISMATCH');
  }
  const head = await currentHead();
  if (payload.head !== head) {
    return capabilityResult(payload, false, 'CAPABILITY_HEAD_MISMATCH');
  }
  const verifier = await verifierResult();
  if (!verifier.ok || !verifier.parsed) {
    return capabilityResult(payload, false, 'CAPABILITY_VERIFIER_NOT_PASSING');
  }
  if (payload.ledger_head_hash !== verifier.parsed.ledger_head_hash) {
    return capabilityResult(payload, false, 'CAPABILITY_LEDGER_HEAD_MISMATCH');
  }
  if (payload.one_use !== true) {
    return capabilityResult(payload, false, 'CAPABILITY_ONE_USE_REQUIRED');
  }
  if (isExpired(payload.expires_at)) {
    return capabilityResult(payload, false, 'CAPABILITY_EXPIRED');
  }
  if (payload.command !== `git push ${payload.remote} ${payload.branch}`) {
    return capabilityResult(payload, false, 'CAPABILITY_COMMAND_MISMATCH');
  }
  return capabilityResult(payload, true, 'CAPABILITY_SIGNATURE_VALID');
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
  const canonical = validateCanonicalSignedCapability(payload);
  if (canonical.valid !== true) {
    return { valid: false, reason: canonical.reason };
  }
  const typePolicy = capabilityTypePolicy(type);
  if (typePolicy.allowed !== true) {
    return { valid: false, reason: typePolicy.reason };
  }
  if (payload.run_id !== state.run_id) {
    return { valid: false, reason: 'CAPABILITY_RUN_ID_MISMATCH' };
  }
  if (payload.policy_hash !== policyHash()) {
    return { valid: false, reason: 'CAPABILITY_POLICY_HASH_MISMATCH' };
  }
  if (payload.mission_hash !== missionHash()) {
    return { valid: false, reason: 'CAPABILITY_MISSION_HASH_MISMATCH' };
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

function buildCapabilityEvent(type, payload, localOnly) {
  const mission = loadMission();
  const policy = loadPolicy();
  const event = {
    schema: 'bha.capability.event.v1',
    run_id: loadState().run_id,
    mission_id: mission.mission_id || null,
    policy_hash: policyHash(policy),
    mission_hash: missionHash(mission),
    event_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    type,
    payload
  };
  if (localOnly) {
    event.local_only = true;
  }
  event.event_hash = capabilityHash(event);
  return event;
}

function appendCapabilityEvent(type, payload) {
  const event = buildCapabilityEvent(type, payload, false);
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

function appendLocalCapabilityEvent(type, payload) {
  const event = buildCapabilityEvent(type, payload, true);
  fs.mkdirSync(BHA_LOCAL_DIR, { recursive: true });
  fs.appendFileSync(LOCAL_CAPABILITIES_PATH, stable(event) + '\n', 'utf8');
  return event;
}

function appendLocalCapabilitySession(payload) {
  const event = buildCapabilityEvent('capability_session', payload, true);
  fs.mkdirSync(BHA_LOCAL_DIR, { recursive: true });
  fs.appendFileSync(LOCAL_CAPABILITY_SESSIONS_PATH, stable(event) + '\n', 'utf8');
  return event;
}

function readCapabilityEvents() {
  return readJsonl(CAPABILITIES_PATH);
}

function readLocalCapabilitySessions() {
  return readJsonl(LOCAL_CAPABILITY_SESSIONS_PATH);
}

function readLocalCapabilityEvents() {
  return readJsonl(LOCAL_CAPABILITIES_PATH);
}

function readCapabilityEventsWithLocalSessions() {
  return readCapabilityEvents().concat(readLocalCapabilityEvents()).concat(readLocalCapabilitySessions());
}

function findCapabilityIssue(events, id) {
  return events.find((event) => event.type === 'capability_issue' &&
    event.payload &&
    event.payload.capability_id === id &&
    event.payload.valid === true);
}

function ensureTrustedSigningKey(keyId, publicKeyPem) {
  const policy = loadPolicy();
  const keys = Array.isArray(policy.trusted_public_keys)
    ? policy.trusted_public_keys
    : [];
  if (!keys.some((item) => String(item.id || item.key_id || '') === String(keyId))) {
    keys.push({ id: keyId, public_key_pem: publicKeyPem });
  }
  policy.trusted_public_keys = keys;
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

function readCapabilityPayloadArg(args) {
  const jsonIndex = args.indexOf('--json');
  const filePath = getOption(args, '--file');
  if (jsonIndex !== -1 && args[jsonIndex + 1]) {
    return { ok: true, source: 'json', text: args[jsonIndex + 1] };
  }
  if (filePath) {
    try {
      const resolved = resolveLocalFile(filePath);
      if (!fs.existsSync(resolved)) {
        return { ok: false, reason: 'capability file does not exist' };
      }
      return { ok: true, source: 'file', text: readText(resolved), file: rel(resolved) };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }
  return { ok: false, reason: 'missing --json payload or --file path' };
}

async function handleIssueCapability(args) {
  const input = readCapabilityPayloadArg(args);
  if (!input.ok) {
    console.log(JSON.stringify({ ok: false, error: input.reason }));
    process.exitCode = 2;
    return;
  }
  let payload;
  try {
    payload = JSON.parse(input.text);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: `invalid JSON payload: ${error.message}` }));
    process.exitCode = 2;
    return;
  }
  const type = capabilityType(payload);
  const id = String(payload.id || payload.capability_id || crypto.randomUUID());
  payload.capability_id = id;
  const validation = await verifySignedCapability(payload);
  const valid = validation.valid === true;
  const status = valid ? 'VALID' : 'INVALID';
  const reason = validation.reason;
  const localOnly = type === 'git_push';
  const capabilityStore = localOnly ? '.bha/local/capabilities.jsonl' : '.bha/capabilities.jsonl';
  if (!valid) {
    console.log(JSON.stringify({
      ok: false,
      capability_id: id,
      valid: false,
      status,
      reason,
      key_id: validation.key_id,
      payload_hash: validation.payload_hash,
      head: validation.head,
      ledger_head_hash: validation.ledger_head_hash,
      recorded: false,
      capability_store: capabilityStore,
      local_only: localOnly
    }));
    process.exitCode = 2;
    return;
  }
  const event = localOnly ? appendLocalCapabilityEvent('capability_issue', {
    capability_id: id,
    requested: payload,
    capability_type: type || 'UNKNOWN',
    valid,
    status,
    reason
  }) : appendCapabilityEvent('capability_issue', {
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
    capability_store: capabilityStore,
    local_only: localOnly,
    event_hash: event.event_hash
  }));
  if (!valid) {
    process.exitCode = 2;
  }
}

async function handleVerifySignedCapability(args) {
  const input = readCapabilityPayloadArg(args);
  if (!input.ok) {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', reason: input.reason }));
    process.exitCode = 2;
    return;
  }
  let payload;
  try {
    payload = JSON.parse(input.text);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', reason: `invalid JSON payload: ${error.message}` }));
    process.exitCode = 2;
    return;
  }
  const result = await verifySignedCapability(payload);
  console.log(JSON.stringify({
    ok: result.ok,
    status: result.status,
    capability_id: result.capability_id,
    reason: result.reason,
    key_id: result.key_id,
    payload_hash: result.payload_hash,
    head: result.head,
    ledger_head_hash: result.ledger_head_hash
  }));
  if (result.ok !== true) {
    process.exitCode = 2;
  }
}

function getOption(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function getOptionalPathArg(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = args[index + 1];
  return !value || String(value).startsWith('--') ? fallback : value;
}

async function currentHead() {
  const result = await runCommand(['git', 'rev-parse', 'HEAD'], {});
  if (result.exit_code !== 0) {
    return null;
  }
  return result.stdout.trim();
}

async function buildPushPayload(remote, branch, keyId, expiresMinutes) {
  if (!remote || !branch || !keyId || !Number.isFinite(expiresMinutes) || expiresMinutes <= 0) {
    return { ok: false, error: 'missing --remote, --branch, --expires-minutes, or --key-id' };
  }
  const key = findTrustedSigningKey(keyId);
  if (!key || !key.public_key_pem) {
    return { ok: false, error: 'unknown trusted signing key' };
  }
  if (!signingKeyPurposeAllowedForCapability(key, 'git_push')) {
    return Object.assign({
      ok: false,
      status: 'BLOCKED',
      error: 'signing key purpose is not allowed for git_push',
      reason: 'CAPABILITY_SIGNING_KEY_PURPOSE_DENIED'
    }, signingKeyPurposeResult(key, 'git_push'));
  }
  if (!await remoteExists(remote)) {
    return { ok: false, error: 'unknown remote' };
  }
  const current = await currentBranch();
  if (current !== branch) {
    return { ok: false, error: 'branch mismatch', current_branch: current, requested_branch: branch };
  }
  const head = await currentHead();
  if (!head) {
    return { ok: false, error: 'unable to read HEAD' };
  }
  const verifier = await verifierResult();
  if (!verifier.parsed || !verifier.parsed.ledger_head_hash) {
    return { ok: false, error: 'unable to read verifier ledger head' };
  }
  const state = loadState();
  const policy = loadPolicy();
  const mission = loadMission();
  const capabilityPrefix = `push-${remote}-${branch}-${head.slice(0, 7)}`;
  const existingSerials = readCapabilityEventsWithLocalSessions()
    .map((event) => event && event.payload ? String(event.payload.capability_id || '') : '')
    .filter((id) => id.startsWith(`${capabilityPrefix}-`))
    .map((id) => Number(id.slice(capabilityPrefix.length + 1)))
    .filter((serial) => Number.isInteger(serial) && serial > 0);
  const nextSerial = existingSerials.length ? Math.max(...existingSerials) + 1 : 1;
  const payload = {
    schema: 'bha.capability.v1',
    capability_id: `${capabilityPrefix}-${String(nextSerial).padStart(3, '0')}`,
    run_id: state.run_id,
    type: 'git_push',
    policy_hash: policyHash(policy),
    mission_hash: missionHash(mission),
    remote,
    branch,
    head,
    ledger_head_hash: verifier.parsed.ledger_head_hash,
    one_use: true,
    expires_at: new Date(Date.now() + expiresMinutes * 60 * 1000).toISOString(),
    signing_key_id: keyId,
    algorithm: 'ed25519',
    signature_encoding: 'base64',
    payload_hash_format: 'sha256-hex',
    command: `git push ${remote} ${branch}`,
    denied_actions_remain_denied: [
      'force_push',
      'tag',
      'release',
      'deploy',
      'provider_call',
      'memory_write',
      'package_install',
      'private_key_repo_write'
    ]
  };
  return {
    ok: true,
    payload,
    verifier: verifier.parsed,
    current_branch: current,
    current_head: head
  };
}

async function handleMakePushPayload(args) {
  const remote = getOption(args, '--remote');
  const branch = getOption(args, '--branch');
  const keyId = getOption(args, '--key-id');
  const outPath = getOption(args, '--out');
  const expiresMinutesRaw = getOption(args, '--expires-minutes');
  const expiresMinutes = Number(expiresMinutesRaw);
  const built = await buildPushPayload(remote, branch, keyId, expiresMinutes);
  if (built.ok !== true) {
    console.log(JSON.stringify(built));
    process.exitCode = 2;
    return;
  }
  if (outPath) {
    let resolved;
    try {
      resolved = resolveLocalFile(outPath);
    } catch (error) {
      console.log(JSON.stringify({ ok: false, status: 'INVALID', error: error.message }));
      process.exitCode = 2;
      return;
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify(built.payload) + '\n', 'utf8');
    console.log(JSON.stringify({
      ok: true,
      status: 'PAYLOAD_WRITTEN',
      read_only: false,
      payload_path: rel(resolved),
      capability_id: built.payload.capability_id,
      head: built.payload.head,
      ledger_head_hash: built.payload.ledger_head_hash,
      private_key_required: false
    }));
    return;
  }
  console.log(JSON.stringify(built.payload));
}

function powerShellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function postSignerPowerShellCommand(capabilityId, remote, branch, signedPath) {
  const targetRemote = remote || 'origin';
  const targetBranch = branch || 'master';
  const signed = signedPath || '.bha/local/signed-push-capability.json';
  const remoteArg = powerShellSingleQuote(targetRemote);
  const branchArg = powerShellSingleQuote(targetBranch);
  return [
    `$cap = ${powerShellSingleQuote(signed)}`,
    `$id = ${powerShellSingleQuote(capabilityId || '<capability_id from push-payload>')}`,
    'node scripts/bha-run.js verify-signed-capability --file $cap',
    'node scripts/bha-run.js issue-capability --file $cap',
    `node scripts/bha-run.js consume-capability --id $id --for git_push --remote ${remoteArg} --branch ${branchArg}`,
    `node scripts/bha-run.js prepush-check --preflight --internal-git-hook ${remoteArg}`
  ].join('; ');
}

function unsignedPayloadHash(payload) {
  const requestPayload = Object.assign({}, payload);
  delete requestPayload.signature;
  delete requestPayload.payload_hash;
  return sha256(stable(requestPayload));
}

function pushHandoffPayload(built, payloadPath, signedPath) {
  const command = postSignerPowerShellCommand(built.payload.capability_id, built.payload.remote, built.payload.branch, signedPath);
  return {
    schema: 'bha.push_handoff.v1',
    capability_id: built.payload.capability_id,
    payload_path: payloadPath,
    signed_payload_path: signedPath,
    remote: built.payload.remote,
    branch: built.payload.branch,
    head: built.payload.head,
    ledger_head_hash: built.payload.ledger_head_hash,
    policy_hash: built.payload.policy_hash,
    mission_hash: built.payload.mission_hash,
    expires_at: built.payload.expires_at,
    expected_unsigned_payload_hash: unsignedPayloadHash(built.payload),
    signer_boundary: {
      operator_controls_signer: true,
      bha_private_key_access: false,
      bha_handles_only: ['unsigned payload file under .bha/local/', 'signed payload file under .bha/local/']
    },
    operator_signer_requirements: [
      'BHA_PRIVATE_KEY_PATH must point to an existing private key controlled by the operator.',
      'BHA_PRIVATE_KEY_PATH must not point inside this repository.',
      'Before signing, confirm capability_id, head, ledger_head_hash, policy_hash, mission_hash, expires_at, and expected_unsigned_payload_hash.'
    ],
    next_powershell_command: command,
    powershell_safety: 'This is a single line; do not split paths, --flags, or arguments.',
    hard_boundaries: [
      'BHA does not read, print, record, store, or write private key material',
      'BHA only handles unsigned and signed payload files under .bha/local/',
      'the signer is controlled by the operator outside BHA'
    ]
  };
}

async function handlePushPrep(args) {
  const format = getOption(args, '--format') || 'json';
  const printNextCommand = hasFlag(args, '--print-next-command');
  const handoffPath = getOptionalPathArg(args, '--write-handoff', '.bha/local/push-handoff.json');
  if (format !== 'json' && !printNextCommand) {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const remote = getOption(args, '--remote');
  const branch = getOption(args, '--branch');
  const keyId = getOption(args, '--key-id');
  const expiresMinutesRaw = getOption(args, '--expires-minutes');
  const expiresMinutes = Number(expiresMinutesRaw);
  const payloadPath = '.bha/local/push-payload.json';
  const signedPath = '.bha/local/signed-push-capability.json';
  const head = await currentHead();
  const verifier = await verifierResult();
  const contextBefore = currentPayloadContext(remote, branch, head, verifier.parsed ? verifier.parsed.ledger_head_hash : null);
  const unsignedBefore = capabilityFileSummary(payloadPath, remote, branch, head, false, contextBefore);
  const signedBefore = await signedCapabilityFileSummary(signedPath, remote, branch, head, contextBefore);
  const localPayloadStatusBefore = localPayloadStatus(unsignedBefore, signedBefore);
  const built = await buildPushPayload(remote, branch, keyId, expiresMinutes);
  if (built.ok !== true) {
    console.log(JSON.stringify(Object.assign({
      status: 'BLOCKED',
      recorded: false,
      read_only: false,
      local_only_write_attempted: false,
      local_payload_status_before: localPayloadStatusBefore
    }, built)));
    process.exitCode = 2;
    return;
  }
  let resolved;
  let resolvedHandoff = null;
  try {
    resolved = resolveLocalFile(payloadPath);
    if (handoffPath) {
      resolvedHandoff = resolveLocalFile(handoffPath);
    }
  } catch (error) {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: error.message }));
    process.exitCode = 2;
    return;
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(built.payload) + '\n', 'utf8');
  const contextAfter = currentPayloadContext(remote, branch, built.payload.head, built.payload.ledger_head_hash);
  const unsignedAfter = capabilityFileSummary(payloadPath, remote, branch, built.payload.head, false, contextAfter);
  const signedAfter = await signedCapabilityFileSummary(signedPath, remote, branch, built.payload.head, contextAfter);
  const handoff = pushHandoffPayload(built, rel(resolved), signedPath);
  let writtenHandoffPath = null;
  if (resolvedHandoff) {
    fs.mkdirSync(path.dirname(resolvedHandoff), { recursive: true });
    fs.writeFileSync(resolvedHandoff, JSON.stringify(handoff) + '\n', 'utf8');
    writtenHandoffPath = rel(resolvedHandoff);
  }
  if (printNextCommand) {
    console.log(handoff.next_powershell_command);
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    status: 'PUSH_PREP_READY_FOR_OPERATOR_SIGNER',
    recorded: false,
    read_only: false,
    local_only: true,
    schema: 'bha.push_prep.v1',
    payload_path: rel(resolved),
    signed_payload_path: signedPath,
    capability_id: built.payload.capability_id,
    head: built.payload.head,
    current_head: built.current_head,
    head_bound: built.payload.head === built.current_head,
    ledger_head_hash: built.payload.ledger_head_hash,
    expected_unsigned_payload_hash: handoff.expected_unsigned_payload_hash,
    private_key_required: false,
    signer_boundary: {
      operator_controls_signer: true,
      bha_private_key_access: false,
      bha_handles_only: ['unsigned payload file under .bha/local/', 'signed payload file under .bha/local/']
    },
    local_payload_status_before: localPayloadStatusBefore,
    local_payload_status_after: localPayloadStatus(unsignedAfter, signedAfter),
    handoff_path: writtenHandoffPath,
    handoff,
    operator_next_step: {
      signer: `Operator signs ${payloadPath} outside BHA and writes ${signedPath}.`,
      powershell_after_signing: handoff.next_powershell_command,
      safety: 'PowerShell command is emitted as one line; do not split paths, --flags, or arguments.'
    },
    hard_boundaries: [
      'BHA does not read, print, record, store, or write private key material',
      'BHA only writes the unsigned payload file under .bha/local/ during push-prep',
      'the signed payload file is produced by an operator-controlled signer outside BHA',
      'push-prep does not issue, consume, reserve, push, deploy, release, tag, publish, call providers, or write memory'
    ]
  }));
}

async function handleGitPushCapabilityFlow(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const remote = getOption(args, '--remote');
  const branch = getOption(args, '--branch');
  const keyId = getOption(args, '--key-id');
  const expiresMinutesRaw = getOption(args, '--expires-minutes');
  const expiresMinutes = Number(expiresMinutesRaw);
  const built = await buildPushPayload(remote, branch, keyId, expiresMinutes);
  if (built.ok !== true) {
    console.log(JSON.stringify(Object.assign({ status: 'BLOCKED', recorded: false, read_only: true }, built)));
    process.exitCode = 2;
    return;
  }
  const payloadJson = JSON.stringify(built.payload);
  console.log(JSON.stringify({
    ok: true,
    status: 'READY_TO_SIGN',
    recorded: false,
    read_only: true,
    schema: 'bha.git_push_capability_flow.v1',
    payload: built.payload,
    steps: [
      {
        id: 'make_unsigned_payload',
        status: 'READY',
        argv: ['node', 'scripts/bha-run.js', 'make-push-payload', '--remote', remote, '--branch', branch, '--expires-minutes', String(expiresMinutes), '--key-id', keyId]
      },
      {
        id: 'sign_externally',
        status: 'HUMAN_OR_EXTERNAL_SIGNER_REQUIRED',
        input: 'canonical flat JSON payload',
        output: 'same JSON object plus payload_hash and signature',
        private_key_handling: 'DO_NOT_READ_PRINT_STORE_OR_WRITE_PRIVATE_KEY_MATERIAL_IN_BHA'
      },
      {
        id: 'verify_signed_payload',
        status: 'WAITING_FOR_SIGNED_PAYLOAD',
        argv_prefix: ['node', 'scripts/bha-run.js', 'verify-signed-capability', '--json']
      },
      {
        id: 'issue_capability',
        status: 'WAITING_FOR_SIGNED_PAYLOAD',
        evidence_store: '.bha/local/capabilities.jsonl',
        argv_prefix: ['node', 'scripts/bha-run.js', 'issue-capability', '--json']
      },
      {
        id: 'consume_capability',
        status: 'WAITING_FOR_ISSUED_CAPABILITY',
        evidence_store: '.bha/local/capabilities.jsonl',
        argv: ['node', 'scripts/bha-run.js', 'consume-capability', '--id', built.payload.capability_id, '--for', 'git_push', '--remote', remote, '--branch', branch]
      },
      {
        id: 'prepush_check',
        status: 'GATED_UNTIL_CONSUMED_CAPABILITY_EXISTS',
        argv: ['node', 'scripts/bha-run.js', 'prepush-check', '--internal-git-hook', remote]
      }
    ],
    hard_boundaries: [
      'private key material is never read, printed, stored, or written by BHA',
      'capability authorizes only git_push for the exact remote, branch, head, policy_hash, mission_hash, and ledger_head_hash',
      'git_push issue, consume, and USED evidence are local-only so push does not dirty tracked repository files',
      'prepush-check remains fail-closed without a valid consumed capability',
      'force_push, tag, release, deploy, provider_call, memory_write, and package_publish remain denied'
    ],
    unsigned_payload_json: payloadJson
  }));
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
  const events = readCapabilityEventsWithLocalSessions();
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
  const localOnly = forAction === 'git_push';
  const capabilityStore = localOnly ? '.bha/local/capabilities.jsonl' : '.bha/capabilities.jsonl';
  const event = localOnly ? appendLocalCapabilityEvent('capability_consume', {
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
  }) : appendCapabilityEvent('capability_consume', {
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
    capability_store: capabilityStore,
    local_only: localOnly,
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
  const events = readCapabilityEventsWithLocalSessions();
  for (const event of events) {
    if (!event || event.event_hash !== capabilityHash(event)) {
      return { ok: false, reason: 'CAPABILITY_EVENT_HASH_MISMATCH', capability_id: event && event.payload ? event.payload.capability_id : null };
    }
  }
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
        const session = appendLocalCapabilitySession({
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

function latestUsedGitPushSession(remote, branch, head, capabilityId) {
  const sessions = readLocalCapabilitySessions().filter((event) => {
    const payload = event && event.payload ? event.payload : {};
    return event.type === 'capability_session' &&
      payload.valid === true &&
      payload.status === 'USED' &&
      payload.remote === remote &&
      payload.branch === branch &&
      payload.head === head &&
      (!capabilityId || payload.capability_id === capabilityId);
  });
  return sessions.length ? sessions[sessions.length - 1] : null;
}

async function remoteTrackingStatus(remote, branch, head) {
  const ref = `refs/remotes/${remote}/${branch}`;
  const result = await runCommand(['git', 'rev-parse', '--verify', ref], {});
  const observedHead = result.exit_code === 0 && !result.error ? result.stdout.trim() : null;
  return {
    observed: Boolean(observedHead),
    ref,
    head: observedHead || 'NOT_OBSERVED',
    matches_current_head: Boolean(observedHead && head && observedHead === head),
    proof_boundary: 'Remote tracking refs are local git observations after fetch/push; they are useful evidence but not remote proof by themselves.'
  };
}

async function postPushStatus(remote, branch, head, capability, checks) {
  const usedSession = latestUsedGitPushSession(remote, branch, head, capability ? capability.capability_id : null);
  const remoteTracking = await remoteTrackingStatus(remote, branch, head);
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
    remote_tracking_state_observed: remoteTracking.observed,
    remote_tracking_matches_current_head: remoteTracking.matches_current_head,
    capability_id: capability && capability.capability_id ? capability.capability_id : null,
    used_session_event_hash: usedSession ? usedSession.event_hash : null,
    remote_tracking: remoteTracking,
    next_operator_meaning: replayBlocked
      ? 'The previous one-use git_push capability has been used; if the operator chooses another real push, generate and sign a new capability first.'
      : (prePushReady ? 'A valid consumed git_push capability is ready if the operator chooses to push once.' : 'No push is required now; if the operator chooses a real push, generate, sign, issue, and consume a git_push capability first.')
  };
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

function validationCommandPassed(state, id) {
  const commands = state && state.validation && Array.isArray(state.validation.commands)
    ? state.validation.commands
    : [];
  return commands.some((command) => command.id === id && command.status === 'PASS');
}

function readCheckpointFile() {
  if (!fs.existsSync(CHECKPOINT_PATH)) {
    return null;
  }
  try {
    return readJsonStrict(CHECKPOINT_PATH);
  } catch (_error) {
    return null;
  }
}

function ledgerEventByHash(events, hash, type) {
  return (events || []).find((event) => event.event_hash === hash && (!type || event.type === type));
}

function newestLedgerEventOfType(events, type) {
  const matches = (events || []).filter((event) => event.type === type);
  return matches.length ? matches[matches.length - 1] : null;
}

function prepushEvidenceGates(state, ledger, verify) {
  const head = ledger.length ? ledger[ledger.length - 1].event_hash : null;
  const validation = state && state.validation ? state.validation : null;
  const checkpoint = readCheckpointFile();
  const checkpointEvent = checkpoint ? ledgerEventByHash(ledger, checkpoint.ledger_event_hash, 'checkpoint_written') : null;
  const newestCheckpoint = newestLedgerEventOfType(ledger, 'checkpoint_written');
  const closeoutEvent = state && state.closeout ? ledgerEventByHash(ledger, state.closeout.ledger_event_hash, 'closeout_completed') : null;
  const newestCloseout = newestLedgerEventOfType(ledger, 'closeout_completed');
  const rollbackChecks = rollbackDrillChecks();
  const gates = {
    verifier_pass: verify.ok === true && verify.parsed && verify.parsed.status === 'PASS',
    verifier_no_warnings: verify.parsed && Array.isArray(verify.parsed.warnings) && verify.parsed.warnings.length === 0,
    ledger_state_match: Boolean(state && head && state.ledger_head_hash === head && verify.parsed && verify.parsed.ledger_head_hash === head),
    validation_fresh: Boolean(validation &&
      validation.status === 'PASS' &&
      validation.inputs_hash === validationInputsHash() &&
      validation.policy_hash === policyHash() &&
      validation.mission_hash === missionHash() &&
      ledgerEventByHash(ledger, validation.ledger_event_hash, 'validation_completed')),
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

function trackedGitRealityBindingFromHeads(currentHeadValue, checkpointHeadValue, closeoutHeadValue) {
  const checkpointHead = checkpointHeadValue ? String(checkpointHeadValue) : null;
  const closeoutHead = closeoutHeadValue ? String(closeoutHeadValue) : null;
  return {
    current_head: currentHeadValue || 'UNKNOWN',
    checkpoint_head: checkpointHead || 'NOT_RECORDED',
    checkpoint_matches_current_head: Boolean(checkpointHead && currentHeadValue && checkpointHead === currentHeadValue),
    closeout_git_reality_head: closeoutHead || 'NOT_RECORDED',
    closeout_matches_current_head: Boolean(closeoutHead && currentHeadValue && closeoutHead === currentHeadValue),
    proof_boundary: 'Checkpoint and closeout git heads are evidence-time facts; current commit identity must come from git reality and any signed capability head binding.'
  };
}

function trackedGitRealityBinding(currentHeadValue, checkpoint, closeoutEvent) {
  const closeoutGitReality = closeoutEvent &&
    closeoutEvent.payload &&
    closeoutEvent.payload.fact_groups &&
    closeoutEvent.payload.fact_groups.git_reality &&
    typeof closeoutEvent.payload.fact_groups.git_reality === 'object'
    ? closeoutEvent.payload.fact_groups.git_reality
    : null;
  const checkpointHead = checkpoint && checkpoint.head ? checkpoint.head : null;
  const closeoutHead = closeoutGitReality && closeoutGitReality.head ? closeoutGitReality.head : null;
  return trackedGitRealityBindingFromHeads(currentHeadValue, checkpointHead, closeoutHead);
}

function firstFailedGate(checks) {
  for (const [key, value] of Object.entries(checks)) {
    if (value !== true) {
      return key.toUpperCase();
    }
  }
  return null;
}

async function handlePrepushCheck(args) {
  const record = args.includes('--record');
  const preflight = args.includes('--preflight');
  const hookArgs = args.filter((arg) => arg !== '--record' && arg !== '--preflight');
  if (hookArgs[0] !== '--internal-git-hook') {
    console.log(JSON.stringify({ ok: false, status: 'FAIL_CLOSED', reason: 'missing internal hook marker' }));
    process.exitCode = 1;
    return;
  }
  const remote = hookArgs[1] || null;
  const stdinText = await readStdin();
  const branch = branchFromPrepushInput(stdinText) || await currentBranch();
  const head = await currentHead();
  const status = await gitStatusShort();
  const verify = await verifierResult();
  const state = loadState();
  const ledger = readJsonl(LEDGER_PATH);
  const evidence = prepushEvidenceGates(state, ledger, verify);
  let capability = remote && branch && head ? await matchingConsumedCapability(remote, branch, head, { reserve: false }) : { ok: false, reason: 'MISSING_REMOTE_BRANCH_OR_HEAD' };
  const checks = {
    verifier_pass: evidence.gates.verifier_pass,
    verifier_no_warnings: evidence.gates.verifier_no_warnings,
    clean_ledger: evidence.gates.ledger_state_match,
    validation_fresh: evidence.gates.validation_fresh,
    rollback_recorded: evidence.gates.rollback_recorded,
    checkpoint_recorded: evidence.gates.checkpoint_recorded,
    closeout_current: evidence.gates.closeout_current,
    valid_consumed_capability: capability.ok === true,
    matching_run_id_remote_branch_head: capability.ok === true,
    clean_git_status: status.ok === true && status.clean === true
  };
  let ok = Object.values(checks).every(Boolean);
  if (ok && !preflight) {
    capability = await matchingConsumedCapability(remote, branch, head, { reserve: true });
    checks.valid_consumed_capability = capability.ok === true;
    checks.matching_run_id_remote_branch_head = capability.ok === true;
    ok = Object.values(checks).every(Boolean);
  }
  if (record) {
    appendLedger('prepush_check', {
      status: ok ? 'ALLOW' : 'FAIL_CLOSED',
      remote: remote || 'UNKNOWN',
      branch: branch || 'UNKNOWN',
      head: head || 'UNKNOWN',
      checks,
      reason: ok ? 'ALLOW' : (capability.reason || firstFailedGate(checks) || 'PREPUSH_GATE_FAILED'),
      capability: {
        ok: capability.ok === true,
        reason: capability.reason || null,
        capability_id: capability.capability_id || null
      }
    });
  }
  console.log(JSON.stringify({
    ok,
    status: ok ? 'ALLOW' : 'FAIL_CLOSED',
    reason: ok ? 'ALLOW' : (capability.reason || firstFailedGate(checks) || 'PREPUSH_GATE_FAILED'),
    read_only: !record && (preflight || !ok),
    recorded: record,
    preflight,
    remote: remote || 'UNKNOWN',
    branch: branch || 'UNKNOWN',
    head: head || 'UNKNOWN',
    checks,
    evidence_gates: evidence.gates,
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

async function hookPathStatus() {
  const result = await runCommand(['git', 'config', '--get', 'core.hooksPath'], {});
  const value = result.exit_code === 0 && !result.error ? result.stdout.trim() : null;
  return {
    configured: value || null,
    expected: '.githooks',
    ok: value === '.githooks',
    pre_push_exists: fs.existsSync(PRE_PUSH_PATH)
  };
}

async function handleHookStatus(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const hook = await hookPathStatus();
  const checks = {
    hooks_path_configured: hook.configured === hook.expected,
    pre_push_exists: hook.pre_push_exists === true
  };
  const ok = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({
    ok,
    status: ok ? 'PASS' : 'BLOCKED',
    read_only: true,
    recorded: false,
    hook,
    checks,
    next_action: ok ? 'NONE' : 'SET_LOCAL_HOOKS_PATH',
    next_commands: ok ? [] : ['git config core.hooksPath .githooks'],
    proof_boundary: 'Hook configuration is local setup evidence, not proof of trusted work; verifier, validation, ledger, policy, mission, and git reality remain the proof sources.'
  }));
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

function nextGateCommands(action, remote, branch) {
  const targetRemote = remote || 'origin';
  const targetBranch = branch || 'master';
  const payloadPath = '.bha/local/push-payload.json';
  const signedPath = '.bha/local/signed-push-capability.json';
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
      `node scripts/bha-run.js make-push-payload --remote ${targetRemote} --branch ${targetBranch} --expires-minutes 20 --key-id owner-main-pkcs8 --out ${payloadPath}`,
      `operator signs ${payloadPath} outside BHA and writes ${signedPath}`,
      `node scripts/bha-run.js verify-signed-capability --file ${signedPath}`,
      `node scripts/bha-run.js issue-capability --file ${signedPath}`,
      `node scripts/bha-run.js consume-capability --id <capability_id> --for git_push --remote ${targetRemote} --branch ${targetBranch}`,
      `node scripts/bha-run.js prepush-check --preflight --internal-git-hook ${targetRemote}`
    ],
    ISSUE_AND_CONSUME_A_NEW_SIGNED_GIT_PUSH_CAPABILITY: [
      `node scripts/bha-run.js make-push-payload --remote ${targetRemote} --branch ${targetBranch} --expires-minutes 20 --key-id owner-main-pkcs8 --out ${payloadPath}`,
      `operator signs ${payloadPath} outside BHA and writes ${signedPath}`,
      `node scripts/bha-run.js verify-signed-capability --file ${signedPath}`,
      `node scripts/bha-run.js issue-capability --file ${signedPath}`,
      `node scripts/bha-run.js consume-capability --id <capability_id> --for git_push --remote ${targetRemote} --branch ${targetBranch}`
    ],
    READY_FOR_PREPUSH_PREFLIGHT_OR_PUSH: [
      `node scripts/bha-run.js prepush-check --preflight --internal-git-hook ${targetRemote}`,
      `git push ${targetRemote} ${targetBranch}`
    ]
  };
  return commands[action] || [];
}

function gateNextActionContext(action) {
  const conditionalPushActions = new Set([
    'MAKE_SIGN_ISSUE_AND_CONSUME_GIT_PUSH_CAPABILITY',
    'ISSUE_AND_CONSUME_A_NEW_SIGNED_GIT_PUSH_CAPABILITY',
    'READY_FOR_PREPUSH_PREFLIGHT_OR_PUSH'
  ]);
  if (conditionalPushActions.has(action)) {
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

function readLocalJsonFileSummary(localPath) {
  let resolved;
  try {
    resolved = resolveLocalFile(localPath);
  } catch (error) {
    return {
      path: localPath,
      exists: false,
      json_valid: false,
      error: error.message
    };
  }
  if (!fs.existsSync(resolved)) {
    return {
      path: localPath,
      exists: false,
      json_valid: false
    };
  }
  try {
    return {
      path: rel(resolved),
      exists: true,
      json_valid: true,
      value: JSON.parse(readText(resolved))
    };
  } catch (error) {
    return {
      path: rel(resolved),
      exists: true,
      json_valid: false,
      error: error.message
    };
  }
}

function currentPayloadContext(remote, branch, head, ledgerHeadHash) {
  return {
    remote,
    branch,
    head,
    ledger_head_hash: ledgerHeadHash || null,
    policy_hash: policyHash(),
    mission_hash: missionHash()
  };
}

function capabilityFileSummary(localPath, remote, branch, head, signed, context) {
  const file = readLocalJsonFileSummary(localPath);
  const currentContext = context || currentPayloadContext(remote, branch, head, null);
  const payload = file.value && typeof file.value === 'object' && !Array.isArray(file.value)
    ? file.value
    : null;
  const summary = {
    path: file.path,
    exists: file.exists,
    json_valid: file.json_valid
  };
  if (file.error) {
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
    summary.expiry = Number.isFinite(expiresAtMs) ? {
      valid: true,
      expired: Date.now() >= expiresAtMs,
      seconds_until_expiry: Math.floor((expiresAtMs - Date.now()) / 1000)
    } : {
      valid: false,
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
  }
  if (signed === true) {
    summary.safe_to_print = 'signature and private key material are not included in this summary';
  }
  return summary;
}

async function handleSignedPayloadStatus(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const remote = getOption(args, '--remote') || 'origin';
  const branch = getOption(args, '--branch') || await currentBranch();
  const signedPath = getOption(args, '--file') || '.bha/local/signed-push-capability.json';
  const head = await currentHead();
  const verifier = await verifierResult();
  const currentContext = currentPayloadContext(remote, branch, head, verifier.parsed ? verifier.parsed.ledger_head_hash : null);
  const signed = await signedCapabilityFileSummary(signedPath, remote, branch, head, currentContext);
  const payloadStatus = localPayloadStatus(null, signed);
  let status = 'SIGNED_PAYLOAD_MISSING';
  let nextAction = 'RUN_PUSH_PREP_AND_OPERATOR_SIGNER';
  if (signed.exists && signed.json_valid !== true) {
    status = 'SIGNED_PAYLOAD_INVALID_JSON';
    nextAction = 'REPLACE_SIGNED_PAYLOAD_WITH_OPERATOR_SIGNED_CURRENT_PAYLOAD';
  } else if (signed.exists && signed.usable_for_current_gate === true) {
    status = 'SIGNED_PAYLOAD_READY';
    nextAction = 'VERIFY_ISSUE_CONSUME_AND_PREFLIGHT';
  } else if (signed.exists) {
    status = signed.expiry && signed.expiry.expired === true
      ? 'SIGNED_PAYLOAD_EXPIRED'
      : 'SIGNED_PAYLOAD_STALE_OR_INVALID';
    nextAction = 'REGENERATE_UNSIGNED_PAYLOAD_AND_SIGN_CURRENT_CONTEXT';
  }
  console.log(JSON.stringify({
    ok: signed.usable_for_current_gate === true,
    status,
    recorded: false,
    read_only: true,
    schema: 'bha.signed_payload_status.v1',
    remote,
    branch,
    head,
    current_context: currentContext,
    signed_payload: signed,
    local_payload_status: payloadStatus,
    next_action: nextAction,
    next_powershell_command: signed.usable_for_current_gate === true
      ? postSignerPowerShellCommand(signed.capability_id, remote, branch, signedPath)
      : null,
    signer_boundary: {
      operator_controls_signer: true,
      bha_private_key_access: false,
      bha_handles_only: ['signed payload file under .bha/local/']
    },
    proof_boundary: 'signed-payload-status is read-only local payload inspection; it does not issue, consume, reserve, push, or prove remote state.'
  }));
}

async function handleOperatorSignerPreflight(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const remote = getOption(args, '--remote') || 'origin';
  const branch = getOption(args, '--branch') || await currentBranch();
  const payloadPath = getOption(args, '--payload') || '.bha/local/push-payload.json';
  const keyPath = process.env.BHA_PRIVATE_KEY_PATH || '';
  const keyResolved = keyPath ? path.resolve(ROOT, keyPath) : null;
  const keyPathInsideRepo = Boolean(keyResolved && isInsideDir(ROOT, keyResolved));
  const keyFileExists = Boolean(keyResolved && fs.existsSync(keyResolved));
  const head = await currentHead();
  const verifier = await verifierResult();
  const currentContext = currentPayloadContext(remote, branch, head, verifier.parsed ? verifier.parsed.ledger_head_hash : null);
  const unsigned = capabilityFileSummary(payloadPath, remote, branch, head, false, currentContext);
  const payloadFile = readLocalJsonFileSummary(payloadPath);
  const payload = payloadFile.value && typeof payloadFile.value === 'object' && !Array.isArray(payloadFile.value)
    ? payloadFile.value
    : null;
  const expectedHash = payload ? unsignedPayloadHash(payload) : null;
  const blockers = [];
  if (!keyPath) {
    blockers.push('BHA_PRIVATE_KEY_PATH_NOT_SET');
  }
  if (keyPath && !keyFileExists) {
    blockers.push('BHA_PRIVATE_KEY_PATH_NOT_FOUND');
  }
  if (keyPathInsideRepo) {
    blockers.push('BHA_PRIVATE_KEY_PATH_INSIDE_REPOSITORY');
  }
  if (unsigned.exists !== true || unsigned.json_valid !== true) {
    blockers.push('UNSIGNED_PAYLOAD_MISSING_OR_INVALID');
  } else if (unsigned.matches_current_context !== true) {
    blockers.push('UNSIGNED_PAYLOAD_STALE_OR_CONTEXT_MISMATCH');
  }
  if (payload && (payload.signature || payload.payload_hash)) {
    blockers.push('UNSIGNED_PAYLOAD_ALREADY_CONTAINS_SIGNATURE_FIELDS');
  }
  const ok = blockers.length === 0;
  console.log(JSON.stringify({
    ok,
    status: ok ? 'OPERATOR_SIGNER_PREFLIGHT_READY' : 'OPERATOR_SIGNER_PREFLIGHT_BLOCKED',
    recorded: false,
    read_only: true,
    schema: 'bha.operator_signer_preflight.v1',
    remote,
    branch,
    head,
    payload_path: payloadPath,
    unsigned_payload: unsigned,
    expected_unsigned_payload_hash: expectedHash,
    private_key_path: {
      env_var: 'BHA_PRIVATE_KEY_PATH',
      set: Boolean(keyPath),
      file_exists: keyFileExists,
      inside_repository: keyPathInsideRepo,
      value_printed: false,
      file_read: false
    },
    operator_confirmation: payload ? {
      capability_id: payload.capability_id || null,
      head: payload.head || null,
      ledger_head_hash: payload.ledger_head_hash || null,
      policy_hash: payload.policy_hash || null,
      mission_hash: payload.mission_hash || null,
      expires_at: payload.expires_at || null,
      expected_unsigned_payload_hash: expectedHash
    } : null,
    blockers,
    next_action: ok
      ? 'SIGN_PAYLOAD_OUTSIDE_BHA_AND_WRITE_SIGNED_PAYLOAD'
      : 'FIX_SIGNER_ENV_AND_REGENERATE_CURRENT_UNSIGNED_PAYLOAD_IF_NEEDED',
    signer_boundary: {
      operator_controls_signer: true,
      bha_private_key_access: false,
      private_key_material_read: false,
      private_key_path_value_printed: false,
      bha_handles_only: ['unsigned payload file under .bha/local/', 'signed payload file under .bha/local/']
    },
    proof_boundary: 'operator-signer-preflight checks local signer readiness without reading private key material and does not sign, issue, consume, reserve, push, or prove remote state.'
  }));
}

async function recoverStatus(remote, branch) {
  const targetRemote = remote || 'origin';
  const targetBranch = branch || await currentBranch();
  const head = await currentHead();
  const verify = await verifierResult();
  const gitStatus = await gitStatusShort();
  const localDirExists = fs.existsSync(BHA_LOCAL_DIR);
  const unsignedPath = path.join(BHA_LOCAL_DIR, 'push-payload.json');
  const signedPath = path.join(BHA_LOCAL_DIR, 'signed-push-capability.json');
  const localCapabilitiesPath = path.join(BHA_LOCAL_DIR, 'capabilities.jsonl');
  const localSessionsPath = path.join(BHA_LOCAL_DIR, 'capability-sessions.jsonl');
  const verifierPass = Boolean(verify.parsed && verify.parsed.ok === true && verify.parsed.status === 'PASS');
  const hasUsableCapability = head && targetRemote && targetBranch
    ? await matchingConsumedCapability(targetRemote, targetBranch, head, { reserve: false })
    : { ok: false, reason: 'MISSING_REMOTE_BRANCH_OR_HEAD' };
  const needsLocalGitPushCapability = hasUsableCapability.ok !== true;
  return {
    ok: verifierPass,
    status: verifierPass ? 'RECOVER_STATUS_READY' : 'RECOVER_STATUS_BLOCKED',
    recorded: false,
    read_only: true,
    schema: 'bha.recover_status.v1',
    branch: targetBranch || 'UNKNOWN',
    remote: targetRemote,
    head: head || 'UNKNOWN',
    tracked_trust: {
      verifier_pass: verifierPass,
      verifier_status: verify.parsed ? verify.parsed.status : 'UNKNOWN',
      verifier_ledger_head_hash: verify.parsed ? verify.parsed.ledger_head_hash : null,
      validation_status: verify.parsed ? verify.parsed.validation_status : null,
      proof_sources: ['.bha/ledger.jsonl', '.bha/state.json', '.bha/policy.yaml', '.bha/mission.yaml', '.bha/validation.yaml', 'scripts/bha-verify.js']
    },
    local_state: {
      bha_local_exists: localDirExists,
      unsigned_payload_exists: fs.existsSync(unsignedPath),
      signed_payload_exists: fs.existsSync(signedPath),
      local_capability_store_exists: fs.existsSync(localCapabilitiesPath),
      local_session_store_exists: fs.existsSync(localSessionsPath),
      required_for_tracked_verifier_pass: false
    },
    git_reality: {
      clean: gitStatus.clean,
      short: gitStatus.stdout.trim() || 'CLEAN'
    },
    git_push_recovery: {
      requires_new_local_capability: needsLocalGitPushCapability,
      required_now: false,
      condition: 'Only required before an operator-chosen real git push.',
      current_capability_status: hasUsableCapability.ok === true ? 'READY' : 'MISSING_OR_NOT_USABLE',
      reason: hasUsableCapability.ok === true ? null : hasUsableCapability.reason,
      local_only: true,
      next_commands: [
        `node scripts/bha-run.js push-prep --remote ${targetRemote} --branch ${targetBranch || 'master'} --expires-minutes 20 --key-id owner-main-pkcs8 --format json --write-handoff`,
        `node scripts/bha-run.js operator-signer-preflight --remote ${targetRemote} --branch ${targetBranch || 'master'} --format json`,
        'operator signs .bha/local/push-payload.json outside BHA and writes .bha/local/signed-push-capability.json',
        `node scripts/bha-run.js signed-payload-status --remote ${targetRemote} --branch ${targetBranch || 'master'} --format json`,
        `node scripts/bha-run.js gate-status --remote ${targetRemote} --branch ${targetBranch || 'master'} --format json`
      ]
    },
    proof_boundary: '.bha/local/ is local-only capability evidence and is not required for tracked verifier trust; fresh clones must regenerate local git_push capability evidence before pushing.'
  };
}

async function handleRecoverStatus(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const remote = getOption(args, '--remote') || 'origin';
  const branch = getOption(args, '--branch') || await currentBranch();
  console.log(JSON.stringify(await recoverStatus(remote, branch)));
}

async function signedCapabilityFileSummary(localPath, remote, branch, head, context) {
  const summary = capabilityFileSummary(localPath, remote, branch, head, true, context);
  if (!summary.exists || !summary.json_valid) {
    return summary;
  }
  const file = readLocalJsonFileSummary(localPath);
  const result = await verifySignedCapability(file.value);
  summary.verification = {
    ok: result.ok === true,
    status: result.status,
    reason: result.reason,
    capability_id: result.capability_id,
    key_id: result.key_id,
    head: result.head,
    ledger_head_hash: result.ledger_head_hash
  };
  summary.usable_for_current_gate = summary.matches_current_context === true && result.ok === true;
  if (summary.usable_for_current_gate !== true) {
    const notUsableReasons = [];
    if (Array.isArray(summary.context_mismatch_reasons)) {
      notUsableReasons.push(...summary.context_mismatch_reasons);
    }
    if (result.ok !== true) {
      notUsableReasons.push(result.reason || 'SIGNED_CAPABILITY_INVALID');
    }
    summary.not_usable_reasons = Array.from(new Set(notUsableReasons));
  }
  return summary;
}

function localPayloadIssue(kind, summary) {
  if (!summary || summary.exists !== true || summary.json_valid !== true) {
    return null;
  }
  const reasons = [];
  if (Array.isArray(summary.context_mismatch_reasons)) {
    reasons.push(...summary.context_mismatch_reasons);
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
    nextPayloadAction = unsignedPresent && unsigned.matches_current_context === true
      ? 'SIGN_CURRENT_UNSIGNED_PAYLOAD_OUTSIDE_BHA_REPLACING_STALE_SIGNED_PAYLOAD'
      : 'REGENERATE_UNSIGNED_PAYLOAD_AND_SIGN_CURRENT_CONTEXT';
  } else if (signedPresent && signed.verification && signed.verification.ok === true) {
    nextPayloadAction = 'USE_CURRENT_SIGNED_PAYLOAD_IF_GATE_CHECKS_PASS';
  } else if (unsignedPresent && unsigned.matches_current_context === true) {
    nextPayloadAction = 'SIGN_CURRENT_UNSIGNED_PAYLOAD_OUTSIDE_BHA';
  }
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
    next_payload_action: nextPayloadAction
  };
}

async function operatorPushHandoff(action, remote, branch, head, capability, immediateCommands, context) {
  const payloadPath = '.bha/local/push-payload.json';
  const signedPath = '.bha/local/signed-push-capability.json';
  const currentContext = context || currentPayloadContext(remote, branch, head, null);
  const unsigned = capabilityFileSummary(payloadPath, remote, branch, head, false, currentContext);
  const signed = await signedCapabilityFileSummary(signedPath, remote, branch, head, currentContext);
  const payloadStatus = localPayloadStatus(unsigned, signed);
  const canUseExistingPayload = action === 'MAKE_SIGN_ISSUE_AND_CONSUME_GIT_PUSH_CAPABILITY' &&
    unsigned.matches_current_context &&
    unsigned.capability_id;
  const capabilityId = canUseExistingPayload
    ? unsigned.capability_id
    : (action === 'READY_FOR_PREPUSH_PREFLIGHT_OR_PUSH' && capability && capability.capability_id
      ? capability.capability_id
      : '<capability_id from make-push-payload output>');
  const capabilityActions = new Set([
    'MAKE_SIGN_ISSUE_AND_CONSUME_GIT_PUSH_CAPABILITY',
    'ISSUE_AND_CONSUME_A_NEW_SIGNED_GIT_PUSH_CAPABILITY',
    'READY_FOR_PREPUSH_PREFLIGHT_OR_PUSH'
  ]);
  const capabilityCommands = [
    `node scripts/bha-run.js make-push-payload --remote ${remote || 'origin'} --branch ${branch || 'master'} --expires-minutes 20 --key-id owner-main-pkcs8 --out ${payloadPath}`,
    `operator signs ${payloadPath} outside BHA and writes ${signedPath}`,
    `$cap = "${signedPath}"`,
    `$id = "${capabilityId}"`,
    'node scripts/bha-run.js verify-signed-capability --file $cap',
    'node scripts/bha-run.js issue-capability --file $cap',
    `node scripts/bha-run.js consume-capability --id $id --for git_push --remote ${remote || 'origin'} --branch ${branch || 'master'}`,
    `node scripts/bha-run.js prepush-check --preflight --internal-git-hook ${remote || 'origin'}`
  ];
  const blockedBeforeCapability = !capabilityActions.has(action);
  const singleLineCommands = blockedBeforeCapability ? immediateCommands : capabilityCommands;
  return {
    purpose: 'Prepare a git_push capability without BHA reading private key material.',
    action,
    capability_flow_required_now: false,
    capability_flow_condition: 'Only required if the operator chooses to perform a real git push.',
    blocked_before_capability: blockedBeforeCapability,
    signer_boundary: {
      operator_controls_signer: true,
      bha_private_key_access: false,
      bha_handles_only: ['unsigned payload file under .bha/local/', 'signed payload file under .bha/local/']
    },
    local_files: {
      unsigned_payload: unsigned,
      signed_payload: signed
    },
    local_payload_status: payloadStatus,
    powershell_safety: 'Run each command as one complete line; do not split paths, --flags, or arguments across prompts.',
    command_variables: {
      cap: signedPath,
      id: capabilityId
    },
    next_powershell_command: postSignerPowerShellCommand(capabilityId, remote, branch, signedPath),
    single_line_commands: singleLineCommands,
    capability_commands_when_unblocked: capabilityCommands,
    notes: [
      'Do not paste private key material into BHA commands.',
      'The signed capability file may contain a signature, but gate-status never prints the signature value.',
      'Existing .bha/local payload files are local-only and may be stale; regenerate before signing when matches_current_context is false.',
      'A capability already marked USED must not be replayed; generate and sign a fresh payload for the next push.'
    ]
  };
}

async function gateStatus(remote, branch) {
  const head = await currentHead();
  const status = await gitStatusShort();
  const verify = await verifierResult();
  const state = loadState();
  const ledger = readJsonl(LEDGER_PATH);
  const evidence = prepushEvidenceGates(state, ledger, verify);
  const checkpoint = readCheckpointFile();
  const closeoutEvent = state && state.closeout ? ledgerEventByHash(ledger, state.closeout.ledger_event_hash, 'closeout_completed') : null;
  const gitRealityBinding = trackedGitRealityBinding(head, checkpoint, closeoutEvent);
  const capability = remote && branch && head
    ? await matchingConsumedCapability(remote, branch, head, { reserve: false })
    : { ok: false, reason: 'MISSING_REMOTE_BRANCH_OR_HEAD' };
  const checks = {
    verifier_pass: evidence.gates.verifier_pass,
    verifier_no_warnings: evidence.gates.verifier_no_warnings,
    clean_ledger: evidence.gates.ledger_state_match,
    validation_fresh: evidence.gates.validation_fresh,
    rollback_recorded: evidence.gates.rollback_recorded,
    checkpoint_recorded: evidence.gates.checkpoint_recorded,
    closeout_current: evidence.gates.closeout_current,
    valid_consumed_capability: capability.ok === true,
    matching_run_id_remote_branch_head: capability.ok === true,
    clean_git_status: status.ok === true && status.clean === true
  };
  const action = nextGateAction(checks, capability);
  const actionContext = gateNextActionContext(action);
  const nextCommands = nextGateCommands(action, remote, branch);
  const currentContext = currentPayloadContext(remote, branch, head, verify.parsed ? verify.parsed.ledger_head_hash : null);
  const pushStatus = await postPushStatus(remote, branch, head, capability, checks);
  return {
    ok: Object.values(checks).every(Boolean),
    status: Object.values(checks).every(Boolean) ? 'READY' : 'BLOCKED',
    read_only: true,
    remote: remote || 'UNKNOWN',
    branch: branch || 'UNKNOWN',
    head: head || 'UNKNOWN',
    checks,
    evidence_gates: evidence.gates,
    capability,
    post_push_status: pushStatus,
    hook: await hookPathStatus(),
    git_status: {
      ok: status.ok,
      clean: status.clean,
      authorized_runtime_dirty: status.ok === true && status.clean !== true ? authorizedRuntimeDirty(status.stdout) : false,
      short: status.stdout.trim() || 'CLEAN'
    },
    post_push_evidence_strategy: {
      tracked_evidence: ['validation, checkpoint, closeout, policy, mission, ledger, and state before push'],
      local_only_evidence: ['.bha/local/capabilities.jsonl git_push issue/consume events', '.bha/local/capability-sessions.jsonl push hook USED sessions'],
      reason: 'git_push authorization is local-only so push does not create tracked evidence commits'
    },
    push_requirement: {
      required_now: false,
      operator_controlled: true,
      reason: 'BHA never requires an immediate git push; generate and consume a git_push capability only when the operator chooses to perform a real push.',
      capability_required_for_real_push: true,
      current_gate_action_if_operator_pushes: action
    },
    signer_boundary: {
      operator_controls_signer: true,
      bha_private_key_access: false,
      bha_handles_only: ['unsigned payload file under .bha/local/', 'signed payload file under .bha/local/']
    },
    tracked_git_reality: gitRealityBinding,
    next_action: action,
    next_action_required_now: actionContext.next_action_required_now,
    next_action_condition: actionContext.next_action_condition,
    next_action_scope: actionContext.next_action_scope,
    next_commands: nextCommands,
    operator_handoff: await operatorPushHandoff(action, remote, branch, head, capability, nextCommands, currentContext)
  };
}

async function handleGateStatus(args) {
  if (getOption(args, '--format') !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const remote = getOption(args, '--remote') || 'origin';
  const branch = getOption(args, '--branch') || await currentBranch();
  console.log(JSON.stringify(await gateStatus(remote, branch)));
}

function fileContains(file, pattern) {
  if (!fs.existsSync(file)) {
    return false;
  }
  const text = readText(file);
  if (pattern instanceof RegExp) {
    return pattern.test(text);
  }
  return text.includes(String(pattern));
}

function validationCommandById(validation, id) {
  const commands = validation && Array.isArray(validation.required_commands)
    ? validation.required_commands
    : [];
  return commands.find((command) => command.id === id) || null;
}

function recordedValidationCommand(state, id) {
  const commands = state && state.validation && Array.isArray(state.validation.commands)
    ? state.validation.commands
    : [];
  return commands.find((command) => command.id === id) || null;
}

function policyAllowsArgv(policy, argv) {
  const allowRules = policy && policy.action_rules && Array.isArray(policy.action_rules.allow)
    ? policy.action_rules.allow
    : [];
  const args = argv.slice(1);
  return allowRules.some((rule) => {
    return commandName(rule.command) === commandName(argv[0]) &&
      ((rule.args && argsMatch(args, rule.args)) ||
      (rule.args_prefix && argsPrefixMatch(args, rule.args_prefix)));
  });
}

function auditCheck(id, requirement, pass, evidence, files) {
  return {
    id,
    requirement,
    status: pass ? 'PASS' : 'FAIL',
    evidence: evidence || {},
    files: files || []
  };
}

async function handleCapabilityFrameworkStatus(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const framework = capabilityFramework();
  console.log(JSON.stringify(Object.assign({
    ok: true,
    status: 'CAPABILITY_FRAMEWORK_STATUS'
  }, framework)));
}

async function handleCouncilStatus(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(Object.assign({
    ok: true
  }, councilRuntimeStatus())));
}

async function handleAuditV1Stable(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const policy = loadPolicy();
  const validation = readJsonStrict(VALIDATION_PATH);
  const verify = await verifierResult();
  const alwaysDenied = ((policy.capability_rules || {}).always_denied_v1 || []);
  const capabilityPossible = ((policy.capability_rules || {}).capability_possible_v1 || []);
  const denyCommands = ((policy.action_rules || {}).deny_commands || {});
  const auditArgv = ['node', 'scripts/bha-run.js', 'audit-v1-stable', '--format', 'json'];
  const validationCommand = validationCommandById(validation, 'v1_stable_audit_readonly');
  const gateStatusCommand = validationCommandById(validation, 'gate_status_readonly');
  const recoverStatusCommand = validationCommandById(validation, 'recover_status_readonly');
  const regressionCommand = validationCommandById(validation, 'v12_regression_selftest');
  const requiredDenied = [
    'provider_call',
    'memory_write',
    'private_key_access',
    'secret_access',
    'deploy',
    'release',
    'tag',
    'force_push',
    'destructive_fs',
    'production_write',
    'package_publish'
  ];
  const checks = [];
  checks.push(auditCheck(
    'stability_doc_present',
    'V1 stability document exists and defines the local-first proof boundary.',
    fs.existsSync(STABILITY_PATH) &&
      fileContains(STABILITY_PATH, 'BHA V1 Stability') &&
      fileContains(STABILITY_PATH, 'Proof Sources') &&
      fileContains(STABILITY_PATH, 'Not Proof') &&
      fileContains(STABILITY_PATH, 'Hard Boundaries'),
    { path: rel(STABILITY_PATH) },
    ['BHA_V1_STABILITY.md']
  ));
  checks.push(auditCheck(
    'hard_boundaries_documented_and_policy_denied',
    'V1 hard boundaries are documented and denied by policy capability rules.',
    requiredDenied.every((item) => alwaysDenied.includes(item)) &&
      (denyCommands.provider_commands || []).length > 0 &&
      (denyCommands.memory_commands || []).length > 0 &&
      (denyCommands.git_remote_subcommands || []).includes('push') &&
      (denyCommands.destructive_commands || []).length > 0 &&
      fileContains(STABILITY_PATH, 'no provider calls') &&
      fileContains(STABILITY_PATH, 'no deploy, release, tag, or package publish') &&
      fileContains(STABILITY_PATH, 'no private key access'),
    { always_denied_v1: alwaysDenied },
    ['.bha/policy.yaml', 'BHA_V1_STABILITY.md']
  ));
  checks.push(auditCheck(
    'proof_and_non_proof_sources_separated',
    'V1 distinguishes trusted proof sources from prose, prompts, hooks, approvals, and closeout prose.',
    fileContains(STABILITY_PATH, 'repository reality') &&
      fileContains(STABILITY_PATH, 'ledger/state evidence') &&
      fileContains(STABILITY_PATH, 'verifier output') &&
      fileContains(STABILITY_PATH, 'policy hash') &&
      fileContains(STABILITY_PATH, 'mission hash') &&
      fileContains(STABILITY_PATH, 'local-only capability evidence') &&
      fileContains(STABILITY_PATH, 'git reality') &&
      fileContains(STABILITY_PATH, 'AGENTS.md') &&
      fileContains(STABILITY_PATH, 'prompt') &&
      fileContains(STABILITY_PATH, 'hook') &&
      fileContains(STABILITY_PATH, 'approval') &&
      fileContains(STABILITY_PATH, 'closeout prose'),
    {},
    ['BHA_V1_STABILITY.md']
  ));
  checks.push(auditCheck(
    'v1_capability_scope_default_deny',
    'V1 allows only git_push as the possible capability family and keeps other capabilities denied by default.',
    capabilityPossible.length === 1 &&
      capabilityPossible[0] === 'git_push' &&
      requiredDenied.every((item) => alwaysDenied.includes(item)),
    { capability_possible_v1: capabilityPossible, always_denied_v1: alwaysDenied },
    ['.bha/policy.yaml']
  ));
  checks.push(auditCheck(
    'v2_capability_framework_preview_default_deny',
    'V2 capability framework preview exists but keeps unknown, provider, deploy, release, and non-git_push capability types denied.',
    fs.existsSync(CAPABILITY_FRAMEWORK_PATH) &&
      fileContains(CAPABILITY_FRAMEWORK_PATH, 'Default deny') &&
      fileContains(CAPABILITY_FRAMEWORK_PATH, 'git_push') &&
      fileContains(CAPABILITY_FRAMEWORK_PATH, 'provider') &&
      capabilityFramework().default_decision === 'DENY' &&
      capabilityFramework().unknown_capability_policy === 'DENY' &&
      capabilityFramework().production_capability_types.length === 1 &&
      capabilityFramework().production_capability_types[0] === 'git_push' &&
      capabilityFramework().test_requirements &&
      capabilityFramework().test_requirements.deny_tests_required_before_allow === true &&
      capabilityFramework().test_requirements.replay_tests_required_before_allow === true,
    {
      framework_status_command: 'node scripts/bha-run.js capability-framework-status --format json',
      production_capability_types: capabilityFramework().production_capability_types,
      test_requirements: capabilityFramework().test_requirements
    },
    ['BHA_V2_CAPABILITY_FRAMEWORK.md', 'scripts/bha-run.js', '.bha/policy.yaml']
  ));
  checks.push(auditCheck(
    'node_builtins_only_no_package_manifest',
    'V1 has no package manager dependency surface; runtime remains Node.js built-in modules only.',
    !fs.existsSync(path.join(ROOT, 'package.json')) &&
      !fs.existsSync(path.join(ROOT, 'package-lock.json')) &&
      !fs.existsSync(path.join(ROOT, 'pnpm-lock.yaml')) &&
      !fs.existsSync(path.join(ROOT, 'yarn.lock')) &&
      fileContains(STABILITY_PATH, 'Node.js built-in modules only'),
    {},
    ['scripts/bha-run.js', 'scripts/bha-verify.js', 'BHA_V1_STABILITY.md']
  ));
  checks.push(auditCheck(
    'audit_v1_stable_wired',
    'audit-v1-stable is read-only, policy-allowed, and wired into validation.',
    Boolean(validationCommand &&
      validationCommand.expect &&
      validationCommand.expect.read_only === true &&
      validationCommand.expect.recorded === false &&
      policyAllowsArgv(policy, auditArgv)),
    {
      validation_command_present: Boolean(validationCommand),
      policy_allowed: policyAllowsArgv(policy, auditArgv)
    },
    ['.bha/policy.yaml', '.bha/validation.yaml', 'scripts/bha-run.js']
  ));
  checks.push(auditCheck(
    'conditional_push_guidance_freeze_wired',
    'V1 push guidance is machine-readable and conditional: BHA may prepare local capability files, but push capability is required only when the operator chooses a real git push.',
    Boolean(gateStatusCommand &&
      recoverStatusCommand &&
      regressionCommand &&
      gateStatusCommand.expect &&
      Array.isArray(gateStatusCommand.expect.has_keys) &&
      gateStatusCommand.expect.has_keys.includes('next_action_required_now') &&
      gateStatusCommand.expect.has_keys.includes('next_action_condition') &&
      gateStatusCommand.expect.has_keys.includes('next_action_scope') &&
      gateStatusCommand.expect.has_keys.includes('push_requirement') &&
      gateStatusCommand.expect.has_keys.includes('operator_handoff') &&
      recoverStatusCommand.expect &&
      Array.isArray(recoverStatusCommand.expect.has_keys) &&
      recoverStatusCommand.expect.has_keys.includes('git_push_recovery') &&
      fileContains(RUN_SCRIPT, 'push_requirement: {') &&
      fileContains(RUN_SCRIPT, 'required_now: false') &&
      fileContains(RUN_SCRIPT, 'operator_chosen_git_push') &&
      fileContains(RUN_SCRIPT, 'capability_flow_required_now: false') &&
      fileContains(RUN_SCRIPT, 'capability_flow_condition') &&
      fileContains(RUN_SCRIPT, 'Only required before an operator-chosen real git push.') &&
      fileContains(RUN_SCRIPT, 'gate_status_next_action_context_is_conditional') &&
      fileContains(RUN_SCRIPT, 'operator_handoff_capability_flow_is_conditional') &&
      fileContains(RUN_SCRIPT, 'fresh_clone_recover_status_explains_missing_local_capability') &&
      fileContains(STABILITY_PATH, 'Push guidance is conditional')),
    {
      gate_status_validation_command_present: Boolean(gateStatusCommand),
      recover_status_validation_command_present: Boolean(recoverStatusCommand),
      regression_selftest_validation_command_present: Boolean(regressionCommand)
    },
    ['scripts/bha-run.js', '.bha/validation.yaml', 'BHA_V1_STABILITY.md']
  ));

  const failed = checks.filter((check) => check.status !== 'PASS');
  console.log(JSON.stringify({
    ok: failed.length === 0,
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    schema: 'bha.audit.v1_stable.v1',
    recorded: false,
    read_only: true,
    objective: 'BHA V1 stable local-first proof and boundary audit',
    proof_sources: [
      'BHA_V1_STABILITY.md',
      'BHA_V2_CAPABILITY_FRAMEWORK.md',
      'BHA_V2_COUNCIL_RUNTIME.md',
      '.bha/policy.yaml',
      '.bha/validation.yaml',
      '.bha/state.json',
      '.bha/ledger.jsonl',
      'scripts/bha-run.js',
      'scripts/bha-verify.js',
      'git status'
    ],
    checks,
    failed,
    verifier: verify.parsed || { ok: false, status: 'UNAVAILABLE' },
    limitations: [
      'audit-v1-stable is an artifact coverage audit and does not replace validate or verifier execution',
      'local-only git_push capability evidence remains outside tracked fresh-clone trust',
      'remote push still requires explicit operator authorization and a fresh signed consumed capability'
    ]
  }));
}

async function handleAuditV12(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const state = loadState();
  const policy = loadPolicy();
  const validation = readJsonStrict(VALIDATION_PATH);
  const verify = await verifierResult();
  const gitStatus = await gitStatusShort();
  const checks = [];
  const v12Command = validationCommandById(validation, 'v12_regression_selftest');
  const v12Recorded = recordedValidationCommand(state, 'v12_regression_selftest');
  const inspectCommand = validationCommandById(validation, 'inspect_readonly');
  const hookCommand = validationCommandById(validation, 'hook_status_readonly');
  const pushPrepCommand = validationCommandById(validation, 'push_prep_current_head_payload');
  const signedPayloadStatusCommand = validationCommandById(validation, 'signed_payload_status_readonly');
  const operatorSignerPreflightCommand = validationCommandById(validation, 'operator_signer_preflight_readonly');
  const recoverStatusCommand = validationCommandById(validation, 'recover_status_readonly');
  const capabilityFrameworkCommand = validationCommandById(validation, 'capability_framework_status_readonly');
  const councilStatusCommand = validationCommandById(validation, 'council_status_readonly');
  const auditArgv = ['node', 'scripts/bha-run.js', 'audit-v12', '--format', 'json'];

  const regressionIds = [
    'validation_input_hash_lf_crlf_stable',
    'ledger_writer_lock_blocks_parallel_append',
    'checkpoint_closeout_ledger_head_race_fail_closed',
    'missing_local_consumed_capability_fail_closed',
    'git_push_issue_consume_write_only_bha_local',
    'issue_consume_leave_tracked_worktree_unchanged',
    'preflight_read_only_does_not_consume_one_use_capability',
    'real_hook_reserve_writes_used_session',
    'replayed_local_capability_rejected',
    'fresh_clone_without_bha_local_verifier_passes',
    'provider_call_denied',
    'memory_write_denied',
    'deploy_denied',
    'release_denied',
    'tag_denied',
    'package_publish_denied',
    'production_write_denied',
    'force_push_denied',
    'destructive_external_action_denied',
    'hook_status_uninstalled_blocked_readonly',
    'hook_status_installed_pass_readonly',
    'hook_status_validation_allows_blocked_local_setup',
    'push_prep_writes_current_head_bound_payload',
    'push_prep_leaves_tracked_worktree_unchanged',
    'push_prep_powershell_command_quotes_arguments',
    'push_prep_invalid_handoff_path_does_not_write_payload',
    'push_prep_print_next_command_single_line',
    'push_prep_write_handoff_local_only',
    'signed_payload_status_readonly_reports_missing',
    'signed_payload_status_reports_stale_payload',
    'signed_payload_status_reports_ready_payload',
    'operator_signer_preflight_validation_wired',
    'operator_signer_preflight_blocks_missing_key_path',
    'operator_signer_preflight_blocks_repo_key_path',
    'operator_signer_preflight_accepts_external_key_path_without_reading_key',
    'recover_status_validation_wired',
    'capability_framework_status_validation_wired',
    'council_status_validation_wired',
    'unknown_capability_type_rejected',
    'disallowed_provider_capability_type_rejected',
    'incomplete_git_push_capability_rejected',
    'fresh_clone_recover_status_explains_missing_local_capability',
    'fresh_clone_gate_status_blocks_without_local_capability',
    'fresh_clone_push_prep_generates_local_handoff',
    'gate_status_flags_unsigned_payload_stale_after_local_evidence_advances',
    'push_prep_validation_wired',
    'signed_payload_status_validation_wired',
    'gate_status_reports_post_push_status',
    'gate_status_reports_push_requirement_boundary',
    'gate_status_operator_meaning_is_conditional',
    'operator_handoff_capability_flow_is_conditional',
    'gate_status_next_action_context_is_conditional',
    'local_git_push_replay_fail_closed_after_used_session',
    'gate_status_missing_local_payload_requests_generation',
    'gate_status_flags_stale_local_payload_files',
    'git_push_rejects_selftest_only_signing_key',
    'gate_status_reports_evidence_time_git_heads'
  ];
  const missingRegressionIds = regressionIds.filter((id) => !fileContains(RUN_SCRIPT, id));
  checks.push(auditCheck(
    'regression_selftest_cases_present',
    'V1.2 regression self-test contains each named V1.1 safety invariant.',
    missingRegressionIds.length === 0,
    { missing_case_ids: missingRegressionIds, case_count: regressionIds.length },
    ['scripts/bha-run.js']
  ));
  checks.push(auditCheck(
    'regression_selftest_validation_recorded',
    'Regression self-test is wired into validation and recorded validation evidence includes a passing matching command.',
    Boolean(v12Command &&
      v12Recorded &&
      v12Recorded.status === 'PASS' &&
      stable(v12Recorded.argv) === stable(v12Command.argv)),
    {
      validation_command_present: Boolean(v12Command),
      recorded_status: v12Recorded ? v12Recorded.status : 'MISSING',
      validation_status: state.validation ? state.validation.status : 'NOT_RECORDED',
      validation_inputs_fresh: state.validation ? state.validation.inputs_hash === validationInputsHash() : false
    },
    ['.bha/validation.yaml', '.bha/state.json']
  ));
  checks.push(auditCheck(
    'regression_selftest_policy_allowed',
    'Policy allowlist permits the local-only regression self-test command.',
    Boolean(v12Command && policyAllowsArgv(policy, v12Command.argv)),
    { argv: v12Command ? v12Command.argv : null },
    ['.bha/policy.yaml', '.bha/validation.yaml']
  ));
  checks.push(auditCheck(
    'validation_and_verifier_observable',
    'Audit captures current verifier and validation state for the operator; final trust still comes from validate plus verifier.',
    Boolean(verify.parsed &&
      state.validation &&
      state.validation.status &&
      state.validation.ledger_event_hash),
    {
      verifier_status: verify.parsed ? verify.parsed.status : 'UNKNOWN',
      issues: verify.parsed && Array.isArray(verify.parsed.issues) ? verify.parsed.issues.length : 'UNKNOWN',
      warnings: verify.parsed && Array.isArray(verify.parsed.warnings) ? verify.parsed.warnings.length : 'UNKNOWN',
      validation_inputs_fresh: state.validation ? state.validation.inputs_hash === validationInputsHash() : false,
      git_clean: gitStatus.ok ? gitStatus.clean : 'UNKNOWN'
    },
    ['.bha/state.json', '.bha/ledger.jsonl', 'scripts/bha-verify.js']
  ));
  checks.push(auditCheck(
    'current_trust_state_passes_when_fresh',
    'When the repository is not mid-change, verifier should pass with fresh validation and no warnings.',
    Boolean((gitStatus.ok && !gitStatus.clean) ||
      (state.validation && state.validation.inputs_hash !== validationInputsHash()) ||
      (verify.ok &&
      verify.parsed &&
      verify.parsed.status === 'PASS' &&
      Array.isArray(verify.parsed.issues) &&
      verify.parsed.issues.length === 0 &&
      Array.isArray(verify.parsed.warnings) &&
      verify.parsed.warnings.length === 0 &&
      state.validation &&
      state.validation.status === 'PASS' &&
      state.validation.inputs_hash === validationInputsHash())),
    {
      verifier_status: verify.parsed ? verify.parsed.status : 'UNKNOWN',
      issues: verify.parsed && Array.isArray(verify.parsed.issues) ? verify.parsed.issues.length : 'UNKNOWN',
      warnings: verify.parsed && Array.isArray(verify.parsed.warnings) ? verify.parsed.warnings.length : 'UNKNOWN',
      validation_inputs_fresh: state.validation ? state.validation.inputs_hash === validationInputsHash() : false
    },
    ['.bha/state.json', '.bha/ledger.jsonl', 'scripts/bha-verify.js']
  ));
  checks.push(auditCheck(
    'operator_ux_commands_present',
    'Codex shell UX exposes inspect, gate-status next commands, signer boundary, and file-based payload handling without private-key custody.',
    Boolean(inspectCommand &&
      hookCommand &&
      fileContains(RUN_SCRIPT, 'async function handleInspect') &&
      fileContains(RUN_SCRIPT, 'async function handleHookStatus') &&
      fileContains(RUN_SCRIPT, 'next_commands') &&
      fileContains(RUN_SCRIPT, 'operator_handoff') &&
      fileContains(RUN_SCRIPT, 'async function handlePushPrep') &&
      fileContains(RUN_SCRIPT, 'async function handleSignedPayloadStatus') &&
      fileContains(RUN_SCRIPT, 'postSignerPowerShellCommand') &&
      fileContains(RUN_SCRIPT, '--print-next-command') &&
      fileContains(RUN_SCRIPT, '--write-handoff') &&
      fileContains(RUN_SCRIPT, 'signed-payload-status') &&
      fileContains(RUN_SCRIPT, 'operator-signer-preflight') &&
      fileContains(RUN_SCRIPT, 'recover-status') &&
      fileContains(RUN_SCRIPT, 'council-status') &&
      fileContains(RUN_SCRIPT, 'BHA_PRIVATE_KEY_PATH') &&
      fileContains(RUN_SCRIPT, 'private_key_material_read: false') &&
      fileContains(RUN_SCRIPT, 'single_line_commands') &&
      fileContains(RUN_SCRIPT, 'next_powershell_command') &&
      fileContains(RUN_SCRIPT, 'local_payload_status') &&
      fileContains(RUN_SCRIPT, 'post_push_status') &&
      fileContains(RUN_SCRIPT, 'PUSHED_CAPABILITY_USED_REPLAY_BLOCKED') &&
      fileContains(RUN_SCRIPT, 'not_usable_local_files') &&
      fileContains(RUN_SCRIPT, 'do not split paths') &&
      fileContains(RUN_SCRIPT, 'operator_controls_signer') &&
      fileContains(RUN_SCRIPT, 'bha_private_key_access: false') &&
      fileContains(RUN_SCRIPT, 'CAPABILITY_SIGNING_KEY_PURPOSE_DENIED') &&
      fileContains(RUN_SCRIPT, 'private_key_required: false') &&
      fileContains(RUN_SCRIPT, 'resolveLocalFile(outPath)')),
    {
      inspect_validation_command_present: Boolean(inspectCommand),
      hook_status_validation_command_present: Boolean(hookCommand),
      push_prep_validation_command_present: Boolean(pushPrepCommand),
      signed_payload_status_validation_command_present: Boolean(signedPayloadStatusCommand),
      operator_signer_preflight_validation_command_present: Boolean(operatorSignerPreflightCommand),
      recover_status_validation_command_present: Boolean(recoverStatusCommand),
      capability_framework_status_validation_command_present: Boolean(capabilityFrameworkCommand),
      council_status_validation_command_present: Boolean(councilStatusCommand),
      inspect_recorded_status: recordedValidationCommand(state, 'inspect_readonly') ? recordedValidationCommand(state, 'inspect_readonly').status : 'MISSING'
    },
    ['scripts/bha-run.js', '.bha/validation.yaml', '.bha/state.json']
  ));
  checks.push(auditCheck(
    'capability_framework_status_validation_wired',
    'V2 capability framework status is read-only, default-deny, policy-allowed, and wired into validation.',
    Boolean(capabilityFrameworkCommand &&
      capabilityFrameworkCommand.expect &&
      capabilityFrameworkCommand.expect.exit_code === 0 &&
      capabilityFrameworkCommand.expect.read_only === true &&
      capabilityFrameworkCommand.expect.recorded === false &&
      policyAllowsArgv(policy, capabilityFrameworkCommand.argv) &&
      capabilityFramework().default_decision === 'DENY' &&
      capabilityFramework().unknown_capability_policy === 'DENY' &&
      capabilityFramework().test_requirements &&
      capabilityFramework().test_requirements.deny_tests_required_before_allow === true &&
      capabilityFramework().test_requirements.replay_tests_required_before_allow === true),
    {
      validation_command_present: Boolean(capabilityFrameworkCommand),
      policy_allowed: capabilityFrameworkCommand ? policyAllowsArgv(policy, capabilityFrameworkCommand.argv) : false,
      default_decision: capabilityFramework().default_decision,
      unknown_capability_policy: capabilityFramework().unknown_capability_policy,
      test_requirements: capabilityFramework().test_requirements
    },
    ['.bha/policy.yaml', '.bha/validation.yaml', 'scripts/bha-run.js']
  ));
  checks.push(auditCheck(
    'council_status_validation_wired',
    'V2+ council runtime status is read-only, local-only, side-effect-free, policy-allowed, and wired into validation.',
    Boolean(councilStatusCommand &&
      councilStatusCommand.expect &&
      councilStatusCommand.expect.exit_code === 0 &&
      councilStatusCommand.expect.read_only === true &&
      councilStatusCommand.expect.recorded === false &&
      policyAllowsArgv(policy, councilStatusCommand.argv) &&
      fs.existsSync(COUNCIL_RUNTIME_PATH) &&
      fileContains(COUNCIL_RUNTIME_PATH, 'Council Runtime') &&
      fileContains(COUNCIL_RUNTIME_PATH, 'not proof') &&
      councilRuntimeStatus().external_side_effects_allowed === false &&
      councilRuntimeStatus().automated_agent_spawn_allowed === false &&
      councilRuntimeStatus().provider_calls_allowed === false &&
      councilRuntimeStatus().memory_writes_allowed === false),
    {
      validation_command_present: Boolean(councilStatusCommand),
      policy_allowed: councilStatusCommand ? policyAllowsArgv(policy, councilStatusCommand.argv) : false,
      runtime_state: councilRuntimeStatus().runtime_state,
      automated_agent_spawn_allowed: councilRuntimeStatus().automated_agent_spawn_allowed,
      provider_calls_allowed: councilRuntimeStatus().provider_calls_allowed,
      memory_writes_allowed: councilRuntimeStatus().memory_writes_allowed
    },
    ['BHA_V2_COUNCIL_RUNTIME.md', '.bha/policy.yaml', '.bha/validation.yaml', 'scripts/bha-run.js']
  ));
  checks.push(auditCheck(
    'hook_status_validation_local_setup_not_proof',
    'hook-status is wired into validation as a read-only local setup report, but validation does not require local hook installation to be PASS.',
    Boolean(hookCommand &&
      hookCommand.expect &&
      hookCommand.expect.exit_code === 0 &&
      hookCommand.expect.read_only === true &&
      hookCommand.expect.recorded === false &&
      !Object.prototype.hasOwnProperty.call(hookCommand.expect, 'ok') &&
      !Object.prototype.hasOwnProperty.call(hookCommand.expect, 'status')),
    {
      validation_command_present: Boolean(hookCommand),
      requires_ok: Boolean(hookCommand && hookCommand.expect && Object.prototype.hasOwnProperty.call(hookCommand.expect, 'ok')),
      requires_status: Boolean(hookCommand && hookCommand.expect && Object.prototype.hasOwnProperty.call(hookCommand.expect, 'status'))
    },
    ['.bha/validation.yaml', 'scripts/bha-run.js']
  ));
  checks.push(auditCheck(
    'codex_shell_rules_documented',
    'AGENTS.md tells Codex to prefer BHA shell commands and states AGENTS/prompts are not proof.',
    fileContains(AGENTS_PATH, 'Codex Trusted Shell Flow') &&
      fileContains(AGENTS_PATH, 'inspect --format json') &&
      fileContains(AGENTS_PATH, 'gate-status') &&
      fileContains(AGENTS_PATH, 'behavior guidance, not proof'),
    {},
    ['AGENTS.md']
  ));
  checks.push(auditCheck(
    'resume_and_closeout_fact_boundaries_present',
    'Checkpoint and closeout expose resume commands, fresh-clone recovery, tracked verifier facts, local-only facts, git reality, skipped validation, risks, and next gates.',
    fileContains(CHECKPOINT_PATH, 'next_session_commands') &&
      fileContains(CHECKPOINT_PATH, 'fresh_clone_path') &&
      fileContains(RUN_SCRIPT, 'fact_groups') &&
      fileContains(RUN_SCRIPT, 'tracked_verifier_facts') &&
      fileContains(RUN_SCRIPT, 'local_only_capability_facts') &&
      fileContains(RUN_SCRIPT, 'git_reality') &&
      fileContains(RUN_SCRIPT, 'tracked_git_reality') &&
      fileContains(RUN_SCRIPT, 'git_reality_binding') &&
      fileContains(RUN_SCRIPT, 'skipped_validation') &&
      fileContains(RUN_SCRIPT, 'remaining_risks') &&
      fileContains(RUN_SCRIPT, 'fresh_clone_recovery'),
    {},
    ['scripts/bha-run.js', '.bha/checkpoint.json']
  ));
  checks.push(auditCheck(
    'hard_denied_capabilities_policy_present',
    'Policy continues to deny provider, memory, deploy, release, tag, package publish, production write, force push, and destructive classes.',
    ['provider_call', 'memory_write', 'deploy', 'release', 'tag', 'package_publish', 'production_write', 'force_push', 'destructive_fs']
      .every((item) => ((policy.capability_rules || {}).always_denied_v1 || []).includes(item)),
    { always_denied_v1: (policy.capability_rules || {}).always_denied_v1 || [] },
    ['.bha/policy.yaml']
  ));
  checks.push(auditCheck(
    'audit_command_policy_and_validation_wired',
    'The audit command is read-only, allowed by policy, and wired into validation.',
    Boolean(validationCommandById(validation, 'v12_audit_readonly') &&
      policyAllowsArgv(policy, auditArgv)),
    {
      validation_command_present: Boolean(validationCommandById(validation, 'v12_audit_readonly')),
      policy_allowed: policyAllowsArgv(policy, auditArgv)
    },
    ['.bha/policy.yaml', '.bha/validation.yaml']
  ));
  checks.push(auditCheck(
    'push_prep_policy_and_validation_wired',
    'push-prep writes only .bha/local/push-payload.json, is allowed by policy, and is wired into validation.',
    Boolean(pushPrepCommand && policyAllowsArgv(policy, pushPrepCommand.argv)),
    {
      validation_command_present: Boolean(pushPrepCommand),
      argv: pushPrepCommand ? pushPrepCommand.argv : null,
      policy_allowed: pushPrepCommand ? policyAllowsArgv(policy, pushPrepCommand.argv) : false
    },
    ['.bha/policy.yaml', '.bha/validation.yaml', 'scripts/bha-run.js']
  ));

  const failed = checks.filter((check) => check.status !== 'PASS');
  const report = {
    ok: failed.length === 0,
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    schema: 'bha.audit.v12.v1',
    recorded: false,
    read_only: true,
    objective: 'BHA V1.2 regression self-test and Codex trusted local shell integration',
    proof_sources: [
      '.bha/policy.yaml',
      '.bha/validation.yaml',
      '.bha/state.json',
      '.bha/ledger.jsonl',
      '.bha/checkpoint.json',
      'scripts/bha-run.js',
      'scripts/bha-verify.js',
      'AGENTS.md',
      'git status'
    ],
    checks,
    failed: failed.map((check) => check.id),
    verifier: verify.parsed || { status: 'UNKNOWN' },
    validation: state.validation ? {
      status: state.validation.status,
      inputs_fresh: state.validation.inputs_hash === validationInputsHash(),
      ledger_event_hash: state.validation.ledger_event_hash || 'NOT_RECORDED'
    } : 'NOT_RECORDED',
    git_status: gitStatus.ok ? {
      clean: gitStatus.clean,
      short: gitStatus.stdout.trim() || 'CLEAN'
    } : {
      clean: 'UNKNOWN',
      error: gitStatus.error || truncate(gitStatus.stderr) || 'UNKNOWN'
    },
    limitations: [
      'audit-v12 is a read-only evidence index; it does not replace validation or verifier execution',
      'local-only .bha/local/ push authorization evidence is intentionally not required for fresh-clone verifier trust',
      'real remote push remains blocked without explicit operator authorization and a fresh signed consumed git_push capability'
    ]
  };
  console.log(JSON.stringify(report));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

function writeTextFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function regressionMission() {
  return {
    schema: 'bha.mission.v1',
    version: '1.0.0',
    mission_id: 'bha-regression-selftest',
    run_id: 'bha-regression-selftest',
    mode: 'dry-run',
    name: 'BHA regression self-test fixture',
    objective: 'Verify V1.2 local trust and gate invariants in an isolated local fixture.',
    denied_paths: ['coverage'],
    hard_stop_conditions: [
      'no_remote_side_effects',
      'no_private_key_access',
      'no_secret_access'
    ]
  };
}

function regressionPolicy(keyId, publicKeyPem, extraTrustedKeys) {
  return {
    schema: 'bha.policy.v1',
    metadata: {
      policy_id: 'bha-regression-selftest-policy',
      version: '1.0.0',
      created_at: '2026-05-16T00:00:00.000Z',
      mode: 'dry-run',
      deny_rules_run_before_allow_rules: true
    },
    paths: {
      allowed: [
        'BHA_DESIGN.md',
        'BHA_V1_STABILITY.md',
        'BHA_V2_CAPABILITY_FRAMEWORK.md',
        'BHA_V2_COUNCIL_RUNTIME.md',
        'AGENTS.md',
        '.gitignore',
        '.bha/mission.yaml',
        '.bha/policy.yaml',
        '.bha/state.json',
        '.bha/capabilities.jsonl',
        '.bha/checkpoint.json',
        '.bha/ledger.jsonl',
        '.bha/validation.yaml',
        '.bha/rollback.md',
        '.bha/roadmap.md',
        'scripts/bha-run.js',
        'scripts/bha-verify.js',
        '.githooks/pre-push'
      ],
      denied: ['coverage'],
      protected: ['.git', '.codex', '.agents']
    },
    actors: {},
    trusted_public_keys: [{
      id: keyId,
      purpose: 'owner',
      public_key_pem: publicKeyPem
    }].concat(extraTrustedKeys || []),
    action_rules: {
      deny_commands: {
        network_commands: ['curl', 'wget', 'Invoke-WebRequest', 'Invoke-RestMethod'],
        provider_commands: ['openai', 'anthropic', 'gemini'],
        memory_commands: ['codex-memory', 'DailyNote'],
        git_remote_subcommands: ['push', 'pull', 'fetch', 'clone', 'ls-remote', 'submodule'],
        destructive_commands: ['rm', 'rmdir', 'del']
      },
      allow: [
        { command: 'git', args: ['diff', '--check'], reason: 'local whitespace validation' },
        { command: 'git', args: ['status'], reason: 'local repository status inspection' },
        { command: 'node', args: ['scripts/bha-run.js', 'rollback-drill', '--format', 'json'], reason: 'read-only rollback drill' },
        { command: 'node', args_prefix: ['scripts/bha-run.js', 'check', '--'], reason: 'nested dry-run policy check' }
      ]
    },
    validation_rules: {},
    capability_rules: {
      capability_possible_v1: ['git_push'],
      always_denied_v1: [
        'provider_call',
        'memory_write',
        'private_key_access',
        'secret_access',
        'deploy',
        'release',
        'tag',
        'force_push',
        'destructive_fs',
        'production_write',
        'package_publish'
      ]
    },
    unattended_rules: {},
    stop_conditions: [
      'unverified_worktree_change',
      'stale_validation',
      'invalid_capability',
      'denied_path_touched'
    ]
  };
}

function regressionRollbackText() {
  return [
    '# Regression Fixture Rollback',
    '',
    'This rollback guidance is for local dry-run recovery only.',
    'Use version control or a known-good local copy to restore .bha/state.json, .bha/ledger.jsonl, and .bha/capabilities.jsonl.',
    'To stop relying on the local pre-push hook, unset core.hooksPath or remove the pre-push hook path from local git config.',
    'Do not run `git reset --hard`.',
    'Do not run `git clean -fd` or `git clean -fdx`.',
    'Do not run `Remove-Item -Recurse`.',
    'Do not push, do not tag, do not release, do not deploy, and do not publish.',
    'Do not read private key material or secrets.'
  ].join('\n') + '\n';
}

function buildFixtureLedgerEvent(mission, policy, state, type, payload, prevHash) {
  const event = {
    schema: 'bha.ledger.event.v1',
    run_id: state.run_id || mission.run_id,
    mission_id: mission.mission_id || null,
    policy_hash: policyHash(policy),
    mission_hash: missionHash(mission),
    event_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    type,
    actor: 'bha-regression-selftest',
    prev_hash: prevHash || 'GENESIS',
    payload: JSON.parse(JSON.stringify(payload))
  };
  event.event_hash = eventHash(event);
  return event;
}

function falseExternalEffects() {
  return {
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
  };
}

function writeRegressionFixtureEvidence(fixtureRoot, keyId, publicKeyPem, extraTrustedKeys) {
  const mission = regressionMission();
  const policy = regressionPolicy(keyId, publicKeyPem, extraTrustedKeys);
  const validation = {
    schema: 'bha.validation.v1',
    version: '1.2.0-regression-fixture',
    required_commands: [{
      id: 'rollback_drill_readonly',
      argv: ['node', 'scripts/bha-run.js', 'rollback-drill', '--format', 'json'],
      expect: { exit_code: 0, ok: true, status: 'PASS' }
    }]
  };
  writeTextFile(path.join(fixtureRoot, '.gitignore'), '.bha/local/\n');
  writeTextFile(path.join(fixtureRoot, 'AGENTS.md'), '# Regression Fixture\n\nAGENTS.md guides behavior and is not proof.\n');
  writeTextFile(path.join(fixtureRoot, 'BHA_DESIGN.md'), '# Regression Fixture Design\n\nLocal deterministic evidence fixture.\n');
  writeTextFile(path.join(fixtureRoot, 'BHA_V1_STABILITY.md'), '# Regression Fixture Stability\n\nProof comes from repository reality, ledger/state evidence, verifier, policy/mission hash, local-only capability evidence, and git reality.\n');
  writeTextFile(path.join(fixtureRoot, 'BHA_V2_CAPABILITY_FRAMEWORK.md'), '# Regression Fixture Capability Framework\n\nDefault deny capability framework preview. git_push is the only enabled production capability.\n');
  writeTextFile(path.join(fixtureRoot, 'BHA_V2_COUNCIL_RUNTIME.md'), '# Regression Fixture Council Runtime\n\nCouncil Runtime role output is coordination context and not proof.\n');
  writeTextFile(path.join(fixtureRoot, '.bha', 'roadmap.md'), '# Regression Fixture Roadmap\n\nKeep proof local and deterministic.\n');
  writeTextFile(path.join(fixtureRoot, '.bha', 'rollback.md'), regressionRollbackText());
  writeTextFile(path.join(fixtureRoot, '.githooks', 'pre-push'), '#!/bin/sh\nnode scripts/bha-run.js prepush-check --internal-git-hook "$@"\n');
  fs.mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
  fs.copyFileSync(RUN_SCRIPT, path.join(fixtureRoot, 'scripts', 'bha-run.js'));
  fs.copyFileSync(VERIFY_SCRIPT, path.join(fixtureRoot, 'scripts', 'bha-verify.js'));
  writeJson(path.join(fixtureRoot, '.bha', 'mission.yaml'), mission);
  writeJson(path.join(fixtureRoot, '.bha', 'policy.yaml'), policy);
  writeJson(path.join(fixtureRoot, '.bha', 'validation.yaml'), validation);
  writeTextFile(path.join(fixtureRoot, '.bha', 'capabilities.jsonl'), '');

  const validationInputs = validationInputsHashForRoot(fixtureRoot);
  const commandRecord = {
    id: 'rollback_drill_readonly',
    argv: ['node', 'scripts/bha-run.js', 'rollback-drill', '--format', 'json'],
    expect: { exit_code: 0, ok: true, status: 'PASS' },
    decision: 'ALLOW',
    allowed: true,
    rule: 'ALLOW_EXACT',
    category: 'local',
    reason: 'read-only rollback drill',
    spawned: true,
    status: 'PASS',
    problems: [],
    exit_code: 0,
    signal: null,
    error: null
  };
  const state = {
    schema: 'bha.state.v1',
    version: '1.0.0',
    run_id: mission.run_id,
    updated_at: new Date().toISOString(),
    policy_hash: policyHash(policy),
    mission_hash: missionHash(mission),
    ledger_head_hash: 'GENESIS',
    ledger_event_count: 0,
    validation: {
      status: 'PASS',
      completed_at: new Date().toISOString(),
      inputs_hash: validationInputs,
      policy_hash: policyHash(policy),
      mission_hash: missionHash(mission),
      ledger_event_hash: 'PENDING',
      commands: [commandRecord]
    },
    capability_selftest: {
      status: 'PASS',
      completed_at: new Date().toISOString(),
      mode: 'regression-fixture',
      key_id: keyId,
      public_key_recorded: true,
      private_key_repo_write: false,
      capability_positive_path: { status: 'PASS' },
      prepush_authorized_simulation: { status: 'PASS', real_git_push_executed: false },
      negative_capability_tests: {},
      external_effects: falseExternalEffects()
    }
  };
  const validationEvent = buildFixtureLedgerEvent(mission, policy, state, 'validation_completed', {
    status: 'PASS',
    completed_at: state.validation.completed_at,
    inputs_hash: validationInputs,
    policy_hash: policyHash(policy),
    mission_hash: missionHash(mission),
    commands: [commandRecord]
  }, 'GENESIS');
  state.validation.ledger_event_hash = validationEvent.event_hash;

  const checkpoint = {
    schema: 'bha.checkpoint.v1',
    checkpoint_id: `checkpoint-${crypto.randomUUID()}`,
    created_at: new Date().toISOString(),
    run_id: state.run_id,
    actor_id: 'bha-regression-selftest',
    goal: {
      mission_id: mission.mission_id,
      name: mission.name,
      objective: mission.objective,
      mission_hash: missionHash(mission)
    },
    phase: 'checkpoint',
    workspace: '.',
    branch: 'UNKNOWN',
    head: 'UNKNOWN',
    ledger_head_hash: validationEvent.event_hash,
    policy_hash: policyHash(policy),
    mission_hash: missionHash(mission),
    completed: ['rollback_drill_readonly'],
    changed_files: [],
    validation_run: {
      status: 'PASS',
      completed_at: state.validation.completed_at,
      ledger_event_hash: validationEvent.event_hash,
      command_count: 1
    },
    validation_not_run: [],
    verifier_status: 'PASS',
    verifier_ledger_head_hash: validationEvent.event_hash,
    blockers: [],
    risks: ['regression fixture is local-only'],
    next_safe_action: 'Run verifier or gate-status in the fixture.',
    resume: {
      next_session_commands: ['node scripts/bha-run.js inspect --format json', 'node scripts/bha-verify.js'],
      fresh_clone_path: ['node scripts/bha-verify.js'],
      local_only_gate_evidence: '.bha/local/ is intentionally absent in fresh clones.'
    },
    stop_conditions: mission.hard_stop_conditions,
    checkpoint_binding: {
      verified_ledger_head_hash: validationEvent.event_hash,
      checkpoint_event_hash: 'SELF_EVENT_HASH',
      final_ledger_head_hash: 'SELF_EVENT_HASH'
    },
    ledger_event_hash: 'PENDING'
  };
  const checkpointEvent = buildFixtureLedgerEvent(mission, policy, state, 'checkpoint_written', checkpoint, validationEvent.event_hash);
  checkpoint.ledger_event_hash = checkpointEvent.event_hash;
  checkpoint.created_at = checkpointEvent.ts;
  checkpoint.checkpoint_binding.checkpoint_event_hash = checkpointEvent.event_hash;
  checkpoint.checkpoint_binding.final_ledger_head_hash = checkpointEvent.event_hash;

  const closeoutPayload = {
    schema: 'bha.closeout.v1',
    status: 'PASS',
    mode: 'recorded',
    run_id: state.run_id,
    policy_hash: policyHash(policy),
    mission_hash: missionHash(mission),
    verifier_status: 'PASS',
    validation_status: 'PASS',
    verifier_warnings: [],
    validation_ledger_event_hash: validationEvent.event_hash,
    unsupported_claims: [],
    unknowns: [],
    closeout_binding: {
      verified_ledger_head_hash: checkpointEvent.event_hash,
      closeout_event_hash: 'SELF_EVENT_HASH',
      final_ledger_head_hash: 'SELF_EVENT_HASH',
      verifier_status_applies_to: 'verified_ledger_head_hash'
    },
    changed_files: [],
    external_effects: { source: 'regression_fixture', forbidden_spawned: false, denied_before_spawn_events: 0, forbidden_spawned_events: [], selftest: falseExternalEffects() },
    capability_summary: { events: 0, local_only_events: 0 }
  };
  const closeoutEvent = buildFixtureLedgerEvent(mission, policy, state, 'closeout_completed', closeoutPayload, checkpointEvent.event_hash);
  state.ledger_head_hash = closeoutEvent.event_hash;
  state.ledger_event_count = 3;
  state.updated_at = closeoutEvent.ts;
  state.last_checkpoint = {
    checkpoint_id: checkpoint.checkpoint_id,
    created_at: checkpointEvent.ts,
    ledger_event_hash: checkpointEvent.event_hash,
    verified_ledger_head_hash: validationEvent.event_hash,
    checkpoint_event_hash: checkpointEvent.event_hash,
    final_ledger_head_hash: checkpointEvent.event_hash,
    path: '.bha/checkpoint.json',
    policy_hash: checkpointEvent.policy_hash,
    mission_hash: checkpointEvent.mission_hash
  };
  state.last_checkpoint_id = checkpoint.checkpoint_id;
  state.closeout = {
    status: 'PASS',
    completed_at: closeoutEvent.ts,
    ledger_event_hash: closeoutEvent.event_hash,
    verified_ledger_head_hash: checkpointEvent.event_hash,
    closeout_event_hash: closeoutEvent.event_hash,
    final_ledger_head_hash: closeoutEvent.event_hash,
    validation_ledger_event_hash: validationEvent.event_hash,
    policy_hash: closeoutEvent.policy_hash,
    mission_hash: closeoutEvent.mission_hash
  };

  writeTextFile(path.join(fixtureRoot, '.bha', 'ledger.jsonl'), [validationEvent, checkpointEvent, closeoutEvent].map(stable).join('\n') + '\n');
  writeJson(path.join(fixtureRoot, '.bha', 'state.json'), state);
  writeJson(path.join(fixtureRoot, '.bha', 'checkpoint.json'), checkpoint);
}

async function regressionGitStatus(root) {
  const result = await runCommand(['git', 'status', '--short', '--untracked-files=no'], { cwd: root });
  return result.exit_code === 0 && !result.error ? result.stdout.trim() : `ERROR:${result.error || result.stderr.trim()}`;
}

function localSessionEvents(root) {
  const file = path.join(root, '.bha', 'local', 'capability-sessions.jsonl');
  if (!fs.existsSync(file)) {
    return [];
  }
  return readText(file).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

async function runFixtureBha(root, args) {
  const result = await runCommand([process.execPath, 'scripts/bha-run.js'].concat(args), { cwd: root });
  return Object.assign({}, result, { parsed: parseJsonLine(result.stdout) });
}

function regressionCheck(id, pass, evidence) {
  return {
    id,
    status: pass ? 'PASS' : 'FAIL',
    evidence: evidence || {}
  };
}

async function handleRegressionSelftest(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const mainTrackedBefore = await regressionGitStatus(ROOT);
  const keyId = `regression-selftest-${crypto.randomUUID()}`;
  const keypair = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = keypair.publicKey.export({ type: 'spki', format: 'pem' });
  const selftestOnlyKeyId = `regression-selftest-only-${crypto.randomUUID()}`;
  const selftestOnlyKeypair = crypto.generateKeyPairSync('ed25519');
  const selftestOnlyPublicKeyPem = selftestOnlyKeypair.publicKey.export({ type: 'spki', format: 'pem' });
  const scratchParent = path.join(BHA_LOCAL_DIR, 'regression-selftest');
  const fixtureRoot = path.join(scratchParent, new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID());
  fs.mkdirSync(fixtureRoot, { recursive: true });
  writeRegressionFixtureEvidence(fixtureRoot, keyId, publicKeyPem, [{
    id: selftestOnlyKeyId,
    purpose: 'selftest-only',
    public_key_pem: selftestOnlyPublicKeyPem
  }]);

  const checks = [];
  const lf = 'alpha\nbeta\n';
  const crlf = 'alpha\r\nbeta\r\n';
  checks.push(regressionCheck('validation_input_hash_lf_crlf_stable', sha256(canonicalText(lf)) === sha256(canonicalText(crlf)), {
    lf_hash: sha256(canonicalText(lf)),
    crlf_hash: sha256(canonicalText(crlf))
  }));

  const gitInit = await runCommand(['git', 'init'], { cwd: fixtureRoot });
  const gitConfigEmail = await runCommand(['git', 'config', 'user.email', 'bha-regression@example.invalid'], { cwd: fixtureRoot });
  const gitConfigName = await runCommand(['git', 'config', 'user.name', 'BHA Regression'], { cwd: fixtureRoot });
  const gitAdd = await runCommand(['git', 'add', '.'], { cwd: fixtureRoot });
  const gitCommit = await runCommand(['git', 'commit', '-m', 'regression fixture'], { cwd: fixtureRoot });
  const gitRemote = await runCommand(['git', 'remote', 'add', 'origin', 'https://example.invalid/bha-regression.git'], { cwd: fixtureRoot });
  const bareRemoteRoot = path.join(scratchParent, `remote-${crypto.randomUUID()}.git`);
  const gitBareRemote = await runCommand(['git', 'init', '--bare', bareRemoteRoot], { cwd: scratchParent });
  const gitRemoteLocal = await runCommand(['git', 'remote', 'set-url', 'origin', bareRemoteRoot], { cwd: fixtureRoot });
  checks.push(regressionCheck('fixture_git_repository_ready', [gitInit, gitConfigEmail, gitConfigName, gitAdd, gitCommit, gitRemote, gitBareRemote, gitRemoteLocal].every((item) => item.exit_code === 0 && !item.error), {
    init: gitInit.exit_code,
    commit: gitCommit.exit_code,
    remote: gitRemote.exit_code,
    bare_remote: gitBareRemote.exit_code,
    remote_set_url: gitRemoteLocal.exit_code
  }));
  const fixtureLedgerLock = path.join(fixtureRoot, '.bha', 'local', 'ledger.lock');
  writeTextFile(fixtureLedgerLock, stable({ held_by: 'regression-selftest' }) + '\n');
  const checkpointWhileLocked = await runFixtureBha(fixtureRoot, ['checkpoint', '--format', 'json']);
  try {
    fs.unlinkSync(fixtureLedgerLock);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  }
  checks.push(regressionCheck('ledger_writer_lock_blocks_parallel_append', checkpointWhileLocked.exit_code === 1 &&
    ((checkpointWhileLocked.parsed &&
    String(checkpointWhileLocked.parsed.error || '').includes('ledger lock')) ||
    String(checkpointWhileLocked.stderr || '').includes('ledger lock')), {
    exit_code: checkpointWhileLocked.exit_code,
    error: checkpointWhileLocked.parsed ? checkpointWhileLocked.parsed.error : truncate(checkpointWhileLocked.stderr)
  }));
  checks.push(regressionCheck('checkpoint_closeout_ledger_head_race_fail_closed',
    fileContains(RUN_SCRIPT, 'CHECKPOINT_LEDGER_HEAD_CHANGED_BEFORE_APPEND') &&
    fileContains(RUN_SCRIPT, 'CLOSEOUT_LEDGER_HEAD_CHANGED_BEFORE_APPEND') &&
    fileContains(RUN_SCRIPT, "typeof payload === 'function'"), {
    checkpoint_guard: fileContains(RUN_SCRIPT, 'CHECKPOINT_LEDGER_HEAD_CHANGED_BEFORE_APPEND'),
    closeout_guard: fileContains(RUN_SCRIPT, 'CLOSEOUT_LEDGER_HEAD_CHANGED_BEFORE_APPEND'),
    locked_payload_factory: fileContains(RUN_SCRIPT, "typeof payload === 'function'")
  }));

  const trackedBeforeHookStatus = await regressionGitStatus(fixtureRoot);
  const hookStatusUninstalled = await runFixtureBha(fixtureRoot, ['hook-status', '--format', 'json']);
  const trackedAfterHookStatusUninstalled = await regressionGitStatus(fixtureRoot);
  checks.push(regressionCheck('hook_status_uninstalled_blocked_readonly', hookStatusUninstalled.exit_code === 0 &&
    hookStatusUninstalled.parsed &&
    hookStatusUninstalled.parsed.ok === false &&
    hookStatusUninstalled.parsed.status === 'BLOCKED' &&
    hookStatusUninstalled.parsed.read_only === true &&
    hookStatusUninstalled.parsed.recorded === false &&
    hookStatusUninstalled.parsed.checks &&
    hookStatusUninstalled.parsed.checks.hooks_path_configured === false &&
    hookStatusUninstalled.parsed.checks.pre_push_exists === true &&
    trackedBeforeHookStatus === trackedAfterHookStatusUninstalled, {
    status: hookStatusUninstalled.parsed ? hookStatusUninstalled.parsed.status : 'NO_JSON',
    hooks_path_configured: hookStatusUninstalled.parsed && hookStatusUninstalled.parsed.checks ? hookStatusUninstalled.parsed.checks.hooks_path_configured : 'NO_JSON',
    tracked_before: trackedBeforeHookStatus || 'CLEAN',
    tracked_after: trackedAfterHookStatusUninstalled || 'CLEAN'
  }));

  const gitHooksPath = await runCommand(['git', 'config', 'core.hooksPath', '.githooks'], { cwd: fixtureRoot });
  const trackedBeforeHookStatusInstalled = await regressionGitStatus(fixtureRoot);
  const hookStatusInstalled = await runFixtureBha(fixtureRoot, ['hook-status', '--format', 'json']);
  const trackedAfterHookStatusInstalled = await regressionGitStatus(fixtureRoot);
  checks.push(regressionCheck('hook_status_installed_pass_readonly', gitHooksPath.exit_code === 0 &&
    hookStatusInstalled.exit_code === 0 &&
    hookStatusInstalled.parsed &&
    hookStatusInstalled.parsed.ok === true &&
    hookStatusInstalled.parsed.status === 'PASS' &&
    hookStatusInstalled.parsed.read_only === true &&
    hookStatusInstalled.parsed.recorded === false &&
    hookStatusInstalled.parsed.hook &&
    hookStatusInstalled.parsed.hook.configured === '.githooks' &&
    trackedBeforeHookStatusInstalled === trackedAfterHookStatusInstalled, {
    status: hookStatusInstalled.parsed ? hookStatusInstalled.parsed.status : 'NO_JSON',
    configured: hookStatusInstalled.parsed && hookStatusInstalled.parsed.hook ? hookStatusInstalled.parsed.hook.configured : 'NO_JSON',
    tracked_before: trackedBeforeHookStatusInstalled || 'CLEAN',
    tracked_after: trackedAfterHookStatusInstalled || 'CLEAN'
  }));

  const rootValidation = readJsonStrict(VALIDATION_PATH);
  const rootHookCommand = validationCommandById(rootValidation, 'hook_status_readonly');
  const rootPushPrepCommand = validationCommandById(rootValidation, 'push_prep_current_head_payload');
  const rootSignedPayloadStatusCommand = validationCommandById(rootValidation, 'signed_payload_status_readonly');
  const rootOperatorSignerPreflightCommand = validationCommandById(rootValidation, 'operator_signer_preflight_readonly');
  const rootRecoverStatusCommand = validationCommandById(rootValidation, 'recover_status_readonly');
  const hookExpect = rootHookCommand && rootHookCommand.expect ? rootHookCommand.expect : {};
  checks.push(regressionCheck('hook_status_validation_allows_blocked_local_setup', Boolean(rootHookCommand &&
    hookExpect.exit_code === 0 &&
    hookExpect.read_only === true &&
    hookExpect.recorded === false &&
    !Object.prototype.hasOwnProperty.call(hookExpect, 'ok') &&
    !Object.prototype.hasOwnProperty.call(hookExpect, 'status')), {
    validation_command_present: Boolean(rootHookCommand),
    requires_ok: Object.prototype.hasOwnProperty.call(hookExpect, 'ok'),
    requires_status: Object.prototype.hasOwnProperty.call(hookExpect, 'status')
  }));
  checks.push(regressionCheck('push_prep_validation_wired', Boolean(rootPushPrepCommand &&
    rootPushPrepCommand.expect &&
    rootPushPrepCommand.expect.exit_code === 0 &&
    rootPushPrepCommand.expect.ok === true &&
    rootPushPrepCommand.expect.status === 'PUSH_PREP_READY_FOR_OPERATOR_SIGNER' &&
    rootPushPrepCommand.expect.read_only === false &&
    rootPushPrepCommand.expect.recorded === false), {
    validation_command_present: Boolean(rootPushPrepCommand),
    status: rootPushPrepCommand && rootPushPrepCommand.expect ? rootPushPrepCommand.expect.status : 'MISSING'
  }));
  checks.push(regressionCheck('signed_payload_status_validation_wired', Boolean(rootSignedPayloadStatusCommand &&
    rootSignedPayloadStatusCommand.expect &&
    rootSignedPayloadStatusCommand.expect.exit_code === 0 &&
    rootSignedPayloadStatusCommand.expect.read_only === true &&
    rootSignedPayloadStatusCommand.expect.recorded === false), {
    validation_command_present: Boolean(rootSignedPayloadStatusCommand),
    read_only: rootSignedPayloadStatusCommand && rootSignedPayloadStatusCommand.expect ? rootSignedPayloadStatusCommand.expect.read_only : 'MISSING'
  }));
  checks.push(regressionCheck('operator_signer_preflight_validation_wired', Boolean(rootOperatorSignerPreflightCommand &&
    rootOperatorSignerPreflightCommand.expect &&
    rootOperatorSignerPreflightCommand.expect.exit_code === 0 &&
    rootOperatorSignerPreflightCommand.expect.read_only === true &&
    rootOperatorSignerPreflightCommand.expect.recorded === false), {
    validation_command_present: Boolean(rootOperatorSignerPreflightCommand),
    read_only: rootOperatorSignerPreflightCommand && rootOperatorSignerPreflightCommand.expect ? rootOperatorSignerPreflightCommand.expect.read_only : 'MISSING'
  }));
  checks.push(regressionCheck('recover_status_validation_wired', Boolean(rootRecoverStatusCommand &&
    rootRecoverStatusCommand.expect &&
    rootRecoverStatusCommand.expect.exit_code === 0 &&
    rootRecoverStatusCommand.expect.read_only === true &&
    rootRecoverStatusCommand.expect.recorded === false), {
    validation_command_present: Boolean(rootRecoverStatusCommand),
    read_only: rootRecoverStatusCommand && rootRecoverStatusCommand.expect ? rootRecoverStatusCommand.expect.read_only : 'MISSING'
  }));

  const branchResult = await runCommand(['git', 'branch', '--show-current'], { cwd: fixtureRoot });
  const branch = branchResult.stdout.trim() || 'master';
  const missingPayloadGateStatus = await runFixtureBha(fixtureRoot, ['gate-status', '--remote', 'origin', '--branch', branch, '--format', 'json']);
  const missingSignedPayloadStatus = await runFixtureBha(fixtureRoot, ['signed-payload-status', '--remote', 'origin', '--branch', branch, '--format', 'json']);
  const originalPrivateKeyPath = process.env.BHA_PRIVATE_KEY_PATH;
  delete process.env.BHA_PRIVATE_KEY_PATH;
  const missingKeyPreflight = await runFixtureBha(fixtureRoot, ['operator-signer-preflight', '--remote', 'origin', '--branch', branch, '--format', 'json']);
  if (originalPrivateKeyPath) {
    process.env.BHA_PRIVATE_KEY_PATH = originalPrivateKeyPath;
  }
  const missingPayloadHandoff = missingPayloadGateStatus.parsed && missingPayloadGateStatus.parsed.operator_handoff
    ? missingPayloadGateStatus.parsed.operator_handoff
    : null;
  const missingPayloadStatus = missingPayloadHandoff ? missingPayloadHandoff.local_payload_status : null;
  checks.push(regressionCheck('gate_status_missing_local_payload_requests_generation', missingPayloadGateStatus.exit_code === 0 &&
    missingPayloadStatus &&
    missingPayloadStatus.unsigned_present === false &&
    missingPayloadStatus.signed_present === false &&
    missingPayloadStatus.next_payload_action === 'GENERATE_UNSIGNED_PAYLOAD_FOR_CURRENT_CONTEXT', {
    unsigned_present: missingPayloadStatus ? missingPayloadStatus.unsigned_present : 'NO_JSON',
    signed_present: missingPayloadStatus ? missingPayloadStatus.signed_present : 'NO_JSON',
    next_payload_action: missingPayloadStatus ? missingPayloadStatus.next_payload_action : 'NO_JSON'
  }));
  checks.push(regressionCheck('gate_status_reports_post_push_status', missingPayloadGateStatus.exit_code === 0 &&
    missingPayloadGateStatus.parsed &&
    missingPayloadGateStatus.parsed.post_push_status &&
    missingPayloadGateStatus.parsed.post_push_status.phase === 'NEEDS_GIT_PUSH_CAPABILITY' &&
    Object.prototype.hasOwnProperty.call(missingPayloadGateStatus.parsed.post_push_status, 'remote_tracking_state_observed') &&
    Object.prototype.hasOwnProperty.call(missingPayloadGateStatus.parsed.post_push_status, 'replay_blocked'), {
    phase: missingPayloadGateStatus.parsed && missingPayloadGateStatus.parsed.post_push_status ? missingPayloadGateStatus.parsed.post_push_status.phase : 'NO_JSON',
    remote_tracking_state_observed: missingPayloadGateStatus.parsed && missingPayloadGateStatus.parsed.post_push_status ? missingPayloadGateStatus.parsed.post_push_status.remote_tracking_state_observed : 'NO_JSON'
  }));
  checks.push(regressionCheck('gate_status_reports_push_requirement_boundary', missingPayloadGateStatus.exit_code === 0 &&
    missingPayloadGateStatus.parsed &&
    missingPayloadGateStatus.parsed.push_requirement &&
    missingPayloadGateStatus.parsed.push_requirement.required_now === false &&
    missingPayloadGateStatus.parsed.push_requirement.operator_controlled === true &&
    missingPayloadGateStatus.parsed.push_requirement.capability_required_for_real_push === true &&
    String(missingPayloadGateStatus.parsed.push_requirement.reason || '').includes('never requires'), {
    required_now: missingPayloadGateStatus.parsed && missingPayloadGateStatus.parsed.push_requirement ? missingPayloadGateStatus.parsed.push_requirement.required_now : 'NO_JSON',
    operator_controlled: missingPayloadGateStatus.parsed && missingPayloadGateStatus.parsed.push_requirement ? missingPayloadGateStatus.parsed.push_requirement.operator_controlled : 'NO_JSON'
  }));
  checks.push(regressionCheck('gate_status_operator_meaning_is_conditional', missingPayloadGateStatus.exit_code === 0 &&
    missingPayloadGateStatus.parsed &&
    missingPayloadGateStatus.parsed.post_push_status &&
    String(missingPayloadGateStatus.parsed.post_push_status.next_operator_meaning || '').includes('No push is required now') &&
    String(missingPayloadGateStatus.parsed.post_push_status.next_operator_meaning || '').includes('if the operator chooses a real push'), {
    next_operator_meaning: missingPayloadGateStatus.parsed && missingPayloadGateStatus.parsed.post_push_status
      ? missingPayloadGateStatus.parsed.post_push_status.next_operator_meaning
      : 'NO_JSON'
  }));
  checks.push(regressionCheck('operator_handoff_capability_flow_is_conditional', missingPayloadGateStatus.exit_code === 0 &&
    missingPayloadGateStatus.parsed &&
    missingPayloadGateStatus.parsed.operator_handoff &&
    missingPayloadGateStatus.parsed.operator_handoff.capability_flow_required_now === false &&
    String(missingPayloadGateStatus.parsed.operator_handoff.capability_flow_condition || '').includes('operator chooses'), {
    capability_flow_required_now: missingPayloadGateStatus.parsed && missingPayloadGateStatus.parsed.operator_handoff
      ? missingPayloadGateStatus.parsed.operator_handoff.capability_flow_required_now
      : 'NO_JSON',
    capability_flow_condition: missingPayloadGateStatus.parsed && missingPayloadGateStatus.parsed.operator_handoff
      ? missingPayloadGateStatus.parsed.operator_handoff.capability_flow_condition
      : 'NO_JSON'
  }));
  checks.push(regressionCheck('gate_status_next_action_context_is_conditional', missingPayloadGateStatus.exit_code === 0 &&
    missingPayloadGateStatus.parsed &&
    missingPayloadGateStatus.parsed.next_action === 'MAKE_SIGN_ISSUE_AND_CONSUME_GIT_PUSH_CAPABILITY' &&
    missingPayloadGateStatus.parsed.next_action_required_now === false &&
    missingPayloadGateStatus.parsed.next_action_scope === 'operator_chosen_git_push' &&
    String(missingPayloadGateStatus.parsed.next_action_condition || '').includes('operator chooses'), {
    next_action: missingPayloadGateStatus.parsed ? missingPayloadGateStatus.parsed.next_action : 'NO_JSON',
    next_action_required_now: missingPayloadGateStatus.parsed ? missingPayloadGateStatus.parsed.next_action_required_now : 'NO_JSON',
    next_action_scope: missingPayloadGateStatus.parsed ? missingPayloadGateStatus.parsed.next_action_scope : 'NO_JSON'
  }));
  checks.push(regressionCheck('signed_payload_status_readonly_reports_missing', missingSignedPayloadStatus.exit_code === 0 &&
    missingSignedPayloadStatus.parsed &&
    missingSignedPayloadStatus.parsed.read_only === true &&
    missingSignedPayloadStatus.parsed.recorded === false &&
    missingSignedPayloadStatus.parsed.status === 'SIGNED_PAYLOAD_MISSING' &&
    missingSignedPayloadStatus.parsed.signed_payload &&
    missingSignedPayloadStatus.parsed.signed_payload.exists === false, {
    status: missingSignedPayloadStatus.parsed ? missingSignedPayloadStatus.parsed.status : 'NO_JSON',
    exists: missingSignedPayloadStatus.parsed && missingSignedPayloadStatus.parsed.signed_payload ? missingSignedPayloadStatus.parsed.signed_payload.exists : 'NO_JSON'
  }));
  checks.push(regressionCheck('operator_signer_preflight_blocks_missing_key_path', missingKeyPreflight.exit_code === 0 &&
    missingKeyPreflight.parsed &&
    missingKeyPreflight.parsed.ok === false &&
    missingKeyPreflight.parsed.status === 'OPERATOR_SIGNER_PREFLIGHT_BLOCKED' &&
    missingKeyPreflight.parsed.private_key_path &&
    missingKeyPreflight.parsed.private_key_path.set === false &&
    missingKeyPreflight.parsed.private_key_path.value_printed === false &&
    missingKeyPreflight.parsed.private_key_path.file_read === false &&
    Array.isArray(missingKeyPreflight.parsed.blockers) &&
    missingKeyPreflight.parsed.blockers.includes('BHA_PRIVATE_KEY_PATH_NOT_SET'), {
    status: missingKeyPreflight.parsed ? missingKeyPreflight.parsed.status : 'NO_JSON',
    blockers: missingKeyPreflight.parsed ? missingKeyPreflight.parsed.blockers : 'NO_JSON'
  }));

  const pushPrepTrackedBefore = await regressionGitStatus(fixtureRoot);
  const invalidHandoffTrackedBefore = await regressionGitStatus(fixtureRoot);
  const invalidHandoff = await runFixtureBha(fixtureRoot, [
    'push-prep',
    '--remote',
    'origin',
    '--branch',
    branch,
    '--expires-minutes',
    '20',
    '--key-id',
    keyId,
    '--format',
    'json',
    '--write-handoff',
    '../outside-handoff.json'
  ]);
  const invalidHandoffTrackedAfter = await regressionGitStatus(fixtureRoot);
  const invalidPayloadPath = path.join(fixtureRoot, '.bha', 'local', 'push-payload.json');
  checks.push(regressionCheck('push_prep_invalid_handoff_path_does_not_write_payload', invalidHandoff.exit_code === 2 &&
    invalidHandoff.parsed &&
    invalidHandoff.parsed.status === 'INVALID' &&
    String(invalidHandoff.parsed.error || '').includes('.bha/local') &&
    !fs.existsSync(invalidPayloadPath) &&
    invalidHandoffTrackedBefore === invalidHandoffTrackedAfter, {
    status: invalidHandoff.parsed ? invalidHandoff.parsed.status : 'NO_JSON',
    payload_written: fs.existsSync(invalidPayloadPath),
    tracked_before: invalidHandoffTrackedBefore || 'CLEAN',
    tracked_after: invalidHandoffTrackedAfter || 'CLEAN'
  }));
  const pushPrep = await runFixtureBha(fixtureRoot, [
    'push-prep',
    '--remote',
    'origin',
    '--branch',
    branch,
    '--expires-minutes',
    '20',
    '--key-id',
    keyId,
    '--format',
    'json'
  ]);
  const pushPrepTrackedAfter = await regressionGitStatus(fixtureRoot);
  const pushPrepPayloadPath = path.join(fixtureRoot, '.bha', 'local', 'push-payload.json');
  const pushPrepPayload = fs.existsSync(pushPrepPayloadPath) ? readJsonStrict(pushPrepPayloadPath) : null;
  const pushPrepHead = await runCommand(['git', 'rev-parse', 'HEAD'], { cwd: fixtureRoot });
  checks.push(regressionCheck('push_prep_writes_current_head_bound_payload', pushPrep.exit_code === 0 &&
    pushPrep.parsed &&
    pushPrep.parsed.status === 'PUSH_PREP_READY_FOR_OPERATOR_SIGNER' &&
    pushPrep.parsed.payload_path === '.bha/local/push-payload.json' &&
    pushPrep.parsed.head_bound === true &&
    pushPrep.parsed.signer_boundary &&
    pushPrep.parsed.signer_boundary.operator_controls_signer === true &&
    pushPrep.parsed.signer_boundary.bha_private_key_access === false &&
    pushPrep.parsed.operator_next_step &&
    typeof pushPrep.parsed.operator_next_step.powershell_after_signing === 'string' &&
    !pushPrep.parsed.operator_next_step.powershell_after_signing.includes('\n') &&
    pushPrepPayload &&
    pushPrepPayload.head === pushPrepHead.stdout.trim(), {
    status: pushPrep.parsed ? pushPrep.parsed.status : 'NO_JSON',
    payload_path: pushPrep.parsed ? pushPrep.parsed.payload_path : 'NO_JSON',
    head_bound: pushPrep.parsed ? pushPrep.parsed.head_bound : 'NO_JSON',
    command_has_newline: pushPrep.parsed && pushPrep.parsed.operator_next_step
      ? pushPrep.parsed.operator_next_step.powershell_after_signing.includes('\n')
      : 'NO_JSON'
  }));
  const frameworkStatus = await runFixtureBha(fixtureRoot, ['capability-framework-status', '--format', 'json']);
  checks.push(regressionCheck('capability_framework_status_validation_wired', Boolean(rootValidation &&
    rootValidation.required_commands &&
    validationCommandById(rootValidation, 'capability_framework_status_readonly') &&
    frameworkStatus.exit_code === 0 &&
    frameworkStatus.parsed &&
    frameworkStatus.parsed.status === 'CAPABILITY_FRAMEWORK_STATUS' &&
    frameworkStatus.parsed.default_decision === 'DENY' &&
    frameworkStatus.parsed.unknown_capability_policy === 'DENY' &&
    frameworkStatus.parsed.test_requirements &&
    frameworkStatus.parsed.test_requirements.deny_tests_required_before_allow === true &&
    frameworkStatus.parsed.test_requirements.replay_tests_required_before_allow === true &&
    Array.isArray(frameworkStatus.parsed.production_capability_types) &&
    frameworkStatus.parsed.production_capability_types.length === 1 &&
    frameworkStatus.parsed.production_capability_types[0] === 'git_push'), {
    validation_command_present: Boolean(validationCommandById(rootValidation, 'capability_framework_status_readonly')),
    default_decision: frameworkStatus.parsed ? frameworkStatus.parsed.default_decision : 'NO_JSON',
    production_capability_types: frameworkStatus.parsed ? frameworkStatus.parsed.production_capability_types : 'NO_JSON',
    test_requirements: frameworkStatus.parsed ? frameworkStatus.parsed.test_requirements : 'NO_JSON'
  }));
  const councilStatus = await runFixtureBha(fixtureRoot, ['council-status', '--format', 'json']);
  checks.push(regressionCheck('council_status_validation_wired', Boolean(rootValidation &&
    rootValidation.required_commands &&
    validationCommandById(rootValidation, 'council_status_readonly') &&
    councilStatus.exit_code === 0 &&
    councilStatus.parsed &&
    councilStatus.parsed.status === 'COUNCIL_RUNTIME_STATUS' &&
    councilStatus.parsed.recorded === false &&
    councilStatus.parsed.read_only === true &&
    councilStatus.parsed.external_side_effects_allowed === false &&
    councilStatus.parsed.automated_agent_spawn_allowed === false &&
    councilStatus.parsed.provider_calls_allowed === false &&
    councilStatus.parsed.memory_writes_allowed === false &&
    String(councilStatus.parsed.proof_boundary || '').includes('not proof')), {
    validation_command_present: Boolean(validationCommandById(rootValidation, 'council_status_readonly')),
    runtime_state: councilStatus.parsed ? councilStatus.parsed.runtime_state : 'NO_JSON',
    automated_agent_spawn_allowed: councilStatus.parsed ? councilStatus.parsed.automated_agent_spawn_allowed : 'NO_JSON',
    provider_calls_allowed: councilStatus.parsed ? councilStatus.parsed.provider_calls_allowed : 'NO_JSON',
    memory_writes_allowed: councilStatus.parsed ? councilStatus.parsed.memory_writes_allowed : 'NO_JSON'
  }));
  const unknownCapabilityPayload = pushPrepPayload ? Object.assign({}, pushPrepPayload, {
    id: `unknown-${crypto.randomUUID()}`,
    capability_id: `unknown-${crypto.randomUUID()}`,
    type: 'unknown_local_capability'
  }) : null;
  if (unknownCapabilityPayload) {
    delete unknownCapabilityPayload.payload_hash;
    delete unknownCapabilityPayload.signature;
    signCapabilityPayload(unknownCapabilityPayload, keypair.privateKey);
  }
  const unknownCapability = unknownCapabilityPayload
    ? await runFixtureBha(fixtureRoot, ['verify-signed-capability', '--json', JSON.stringify(unknownCapabilityPayload)])
    : { exit_code: 2, parsed: null };
  checks.push(regressionCheck('unknown_capability_type_rejected', unknownCapability.exit_code === 2 &&
    unknownCapability.parsed &&
    unknownCapability.parsed.status === 'INVALID' &&
    unknownCapability.parsed.reason === 'CAPABILITY_TYPE_NOT_SUPPORTED', {
    reason: unknownCapability.parsed ? unknownCapability.parsed.reason : 'NO_JSON'
  }));
  const providerCapabilityPayload = pushPrepPayload ? Object.assign({}, pushPrepPayload, {
    id: `provider-${crypto.randomUUID()}`,
    capability_id: `provider-${crypto.randomUUID()}`,
    type: 'provider_call',
    command: 'openai models list'
  }) : null;
  if (providerCapabilityPayload) {
    delete providerCapabilityPayload.payload_hash;
    delete providerCapabilityPayload.signature;
    signCapabilityPayload(providerCapabilityPayload, keypair.privateKey);
  }
  const providerCapability = providerCapabilityPayload
    ? await runFixtureBha(fixtureRoot, ['verify-signed-capability', '--json', JSON.stringify(providerCapabilityPayload)])
    : { exit_code: 2, parsed: null };
  checks.push(regressionCheck('disallowed_provider_capability_type_rejected', providerCapability.exit_code === 2 &&
    providerCapability.parsed &&
    providerCapability.parsed.status === 'INVALID' &&
    providerCapability.parsed.reason === 'DISALLOWED_CAPABILITY_TYPE', {
    reason: providerCapability.parsed ? providerCapability.parsed.reason : 'NO_JSON'
  }));
  const incompleteGitPushPayload = pushPrepPayload ? Object.assign({}, pushPrepPayload, {
    id: `incomplete-${crypto.randomUUID()}`,
    capability_id: `incomplete-${crypto.randomUUID()}`
  }) : null;
  if (incompleteGitPushPayload) {
    delete incompleteGitPushPayload.remote;
    delete incompleteGitPushPayload.payload_hash;
    delete incompleteGitPushPayload.signature;
    signCapabilityPayload(incompleteGitPushPayload, keypair.privateKey);
  }
  const incompleteGitPushCapability = incompleteGitPushPayload
    ? await runFixtureBha(fixtureRoot, ['verify-signed-capability', '--json', JSON.stringify(incompleteGitPushPayload)])
    : { exit_code: 2, parsed: null };
  checks.push(regressionCheck('incomplete_git_push_capability_rejected', incompleteGitPushCapability.exit_code === 2 &&
    incompleteGitPushCapability.parsed &&
    incompleteGitPushCapability.parsed.status === 'INVALID' &&
    incompleteGitPushCapability.parsed.reason === 'CAPABILITY_BINDING_MISSING', {
    reason: incompleteGitPushCapability.parsed ? incompleteGitPushCapability.parsed.reason : 'NO_JSON'
  }));
  checks.push(regressionCheck('push_prep_leaves_tracked_worktree_unchanged', pushPrepTrackedBefore === pushPrepTrackedAfter, {
    before: pushPrepTrackedBefore || 'CLEAN',
    after: pushPrepTrackedAfter || 'CLEAN'
  }));
  const pushPrepPowerShellCommand = pushPrep.parsed && pushPrep.parsed.operator_next_step
    ? pushPrep.parsed.operator_next_step.powershell_after_signing
    : '';
  checks.push(regressionCheck('push_prep_powershell_command_quotes_arguments', typeof pushPrepPowerShellCommand === 'string' &&
    !pushPrepPowerShellCommand.includes('\n') &&
    pushPrepPowerShellCommand.includes("--remote 'origin'") &&
    pushPrepPowerShellCommand.includes(`--branch '${branch}'`) &&
    pushPrepPowerShellCommand.includes("$cap = '.bha/local/signed-push-capability.json'"), {
    command_has_newline: typeof pushPrepPowerShellCommand === 'string'
      ? pushPrepPowerShellCommand.includes('\n')
      : 'NO_JSON',
    quotes_remote: typeof pushPrepPowerShellCommand === 'string'
      ? pushPrepPowerShellCommand.includes("--remote 'origin'")
      : 'NO_JSON',
    quotes_branch: typeof pushPrepPowerShellCommand === 'string'
      ? pushPrepPowerShellCommand.includes(`--branch '${branch}'`)
      : 'NO_JSON'
  }));
  const repoKeyPath = path.join(fixtureRoot, '.bha', 'local', 'repo-private-key.pem');
  writeTextFile(repoKeyPath, 'not-a-real-private-key\n');
  process.env.BHA_PRIVATE_KEY_PATH = repoKeyPath;
  const repoKeyPreflight = await runFixtureBha(fixtureRoot, ['operator-signer-preflight', '--remote', 'origin', '--branch', branch, '--format', 'json']);
  const externalKeyPath = path.join(scratchParent, `operator-key-${crypto.randomUUID()}.pem`);
  writeTextFile(externalKeyPath, 'not-a-real-private-key\n');
  process.env.BHA_PRIVATE_KEY_PATH = externalKeyPath;
  const externalKeyPreflight = await runFixtureBha(fixtureRoot, ['operator-signer-preflight', '--remote', 'origin', '--branch', branch, '--format', 'json']);
  if (originalPrivateKeyPath) {
    process.env.BHA_PRIVATE_KEY_PATH = originalPrivateKeyPath;
  } else {
    delete process.env.BHA_PRIVATE_KEY_PATH;
  }
  checks.push(regressionCheck('operator_signer_preflight_blocks_repo_key_path', repoKeyPreflight.exit_code === 0 &&
    repoKeyPreflight.parsed &&
    repoKeyPreflight.parsed.ok === false &&
    repoKeyPreflight.parsed.private_key_path &&
    repoKeyPreflight.parsed.private_key_path.file_exists === true &&
    repoKeyPreflight.parsed.private_key_path.inside_repository === true &&
    repoKeyPreflight.parsed.private_key_path.value_printed === false &&
    repoKeyPreflight.parsed.private_key_path.file_read === false &&
    Array.isArray(repoKeyPreflight.parsed.blockers) &&
    repoKeyPreflight.parsed.blockers.includes('BHA_PRIVATE_KEY_PATH_INSIDE_REPOSITORY'), {
    blockers: repoKeyPreflight.parsed ? repoKeyPreflight.parsed.blockers : 'NO_JSON',
    value_printed: repoKeyPreflight.parsed && repoKeyPreflight.parsed.private_key_path ? repoKeyPreflight.parsed.private_key_path.value_printed : 'NO_JSON'
  }));
  checks.push(regressionCheck('operator_signer_preflight_accepts_external_key_path_without_reading_key', externalKeyPreflight.exit_code === 0 &&
    externalKeyPreflight.parsed &&
    externalKeyPreflight.parsed.ok === true &&
    externalKeyPreflight.parsed.private_key_path &&
    externalKeyPreflight.parsed.private_key_path.file_exists === true &&
    externalKeyPreflight.parsed.private_key_path.inside_repository === false &&
    externalKeyPreflight.parsed.private_key_path.value_printed === false &&
    externalKeyPreflight.parsed.private_key_path.file_read === false &&
    externalKeyPreflight.parsed.signer_boundary &&
    externalKeyPreflight.parsed.signer_boundary.private_key_material_read === false &&
    externalKeyPreflight.parsed.unsigned_payload &&
    externalKeyPreflight.parsed.unsigned_payload.matches_current_context === true &&
    externalKeyPreflight.parsed.operator_confirmation &&
    externalKeyPreflight.parsed.operator_confirmation.expected_unsigned_payload_hash === externalKeyPreflight.parsed.expected_unsigned_payload_hash, {
    status: externalKeyPreflight.parsed ? externalKeyPreflight.parsed.status : 'NO_JSON',
    inside_repository: externalKeyPreflight.parsed && externalKeyPreflight.parsed.private_key_path ? externalKeyPreflight.parsed.private_key_path.inside_repository : 'NO_JSON',
    file_read: externalKeyPreflight.parsed && externalKeyPreflight.parsed.private_key_path ? externalKeyPreflight.parsed.private_key_path.file_read : 'NO_JSON'
  }));
  const pushPrepPrint = await runFixtureBha(fixtureRoot, [
    'push-prep',
    '--remote',
    'origin',
    '--branch',
    branch,
    '--expires-minutes',
    '20',
    '--key-id',
    keyId,
    '--print-next-command'
  ]);
  const printedCommand = pushPrepPrint.stdout.trim();
  checks.push(regressionCheck('push_prep_print_next_command_single_line', pushPrepPrint.exit_code === 0 &&
    printedCommand &&
    !printedCommand.includes('\n') &&
    printedCommand.includes('verify-signed-capability') &&
    printedCommand.includes('issue-capability') &&
    printedCommand.includes('consume-capability') &&
    printedCommand.includes('prepush-check --preflight'), {
    command_has_newline: printedCommand.includes('\n'),
    contains_preflight: printedCommand.includes('prepush-check --preflight')
  }));
  const trackedBeforeHandoff = await regressionGitStatus(fixtureRoot);
  const pushPrepHandoff = await runFixtureBha(fixtureRoot, [
    'push-prep',
    '--remote',
    'origin',
    '--branch',
    branch,
    '--expires-minutes',
    '20',
    '--key-id',
    keyId,
    '--format',
    'json',
    '--write-handoff'
  ]);
  const trackedAfterHandoff = await regressionGitStatus(fixtureRoot);
  const handoffPath = path.join(fixtureRoot, '.bha', 'local', 'push-handoff.json');
  const handoff = fs.existsSync(handoffPath) ? readJsonStrict(handoffPath) : null;
  checks.push(regressionCheck('push_prep_write_handoff_local_only', pushPrepHandoff.exit_code === 0 &&
    pushPrepHandoff.parsed &&
    pushPrepHandoff.parsed.handoff_path === '.bha/local/push-handoff.json' &&
    handoff &&
    handoff.schema === 'bha.push_handoff.v1' &&
    typeof handoff.next_powershell_command === 'string' &&
    !handoff.next_powershell_command.includes('\n') &&
    Array.isArray(handoff.operator_signer_requirements) &&
    handoff.operator_signer_requirements.some((item) => item.includes('BHA_PRIVATE_KEY_PATH')) &&
    trackedBeforeHandoff === trackedAfterHandoff, {
    handoff_path: pushPrepHandoff.parsed ? pushPrepHandoff.parsed.handoff_path : 'NO_JSON',
    tracked_before: trackedBeforeHandoff || 'CLEAN',
    tracked_after: trackedAfterHandoff || 'CLEAN'
  }));

  const evidenceAdvanceCheckpoint = await runFixtureBha(fixtureRoot, ['checkpoint', '--format', 'json']);
  const evidenceAdvanceCloseout = await runFixtureBha(fixtureRoot, ['closeout', '--record', '--format', 'json']);
  const staleUnsignedGateStatus = await runFixtureBha(fixtureRoot, ['gate-status', '--remote', 'origin', '--branch', branch, '--format', 'json']);
  const staleUnsignedHandoff = staleUnsignedGateStatus.parsed && staleUnsignedGateStatus.parsed.operator_handoff
    ? staleUnsignedGateStatus.parsed.operator_handoff
    : null;
  const staleUnsignedStatus = staleUnsignedHandoff ? staleUnsignedHandoff.local_payload_status : null;
  const staleUnsignedIssues = staleUnsignedStatus && Array.isArray(staleUnsignedStatus.not_usable_local_files)
    ? staleUnsignedStatus.not_usable_local_files
    : [];
  checks.push(regressionCheck('gate_status_flags_unsigned_payload_stale_after_local_evidence_advances', evidenceAdvanceCheckpoint.exit_code === 0 &&
    evidenceAdvanceCloseout.exit_code === 0 &&
    staleUnsignedGateStatus.exit_code === 0 &&
    staleUnsignedStatus &&
    staleUnsignedStatus.unsigned_matches_current_context === false &&
    staleUnsignedIssues.some((issue) => issue.kind === 'unsigned_payload' && issue.reasons.includes('LEDGER_HEAD_MISMATCH')), {
    checkpoint_exit_code: evidenceAdvanceCheckpoint.exit_code,
    closeout_exit_code: evidenceAdvanceCloseout.exit_code,
    unsigned_matches_current_context: staleUnsignedStatus ? staleUnsignedStatus.unsigned_matches_current_context : 'NO_JSON',
    stale_issue_count: staleUnsignedIssues.length
  }));
  await runCommand(['git', 'add', '.bha/checkpoint.json', '.bha/ledger.jsonl', '.bha/state.json'], { cwd: fixtureRoot });
  await runCommand(['git', 'commit', '-m', 'record evidence advance for stale payload check'], { cwd: fixtureRoot });

  const stalePayload = await runFixtureBha(fixtureRoot, [
    'make-push-payload',
    '--remote',
    'origin',
    '--branch',
    branch,
    '--expires-minutes',
    '20',
    '--key-id',
    keyId,
    '--out',
    '.bha/local/push-payload.json'
  ]);
  const stalePayloadPath = path.join(fixtureRoot, '.bha', 'local', 'push-payload.json');
  const staleSignedPath = path.join(fixtureRoot, '.bha', 'local', 'signed-push-capability.json');
  let staleSignedPayload = null;
  if (stalePayload.exit_code === 0 && fs.existsSync(stalePayloadPath)) {
    staleSignedPayload = signCapabilityPayload(readJsonStrict(stalePayloadPath), keypair.privateKey);
    writeTextFile(staleSignedPath, JSON.stringify(staleSignedPayload) + '\n');
  }
  const selftestOnlyMakePayload = await runFixtureBha(fixtureRoot, [
    'make-push-payload',
    '--remote',
    'origin',
    '--branch',
    branch,
    '--expires-minutes',
    '20',
    '--key-id',
    selftestOnlyKeyId
  ]);
  const selftestOnlySignedPath = path.join(fixtureRoot, '.bha', 'local', 'selftest-only-signed-capability.json');
  let selftestOnlySignedPayload = null;
  let selftestOnlyVerify = { exit_code: 999, parsed: null };
  if (stalePayload.exit_code === 0 && fs.existsSync(stalePayloadPath)) {
    selftestOnlySignedPayload = Object.assign({}, readJsonStrict(stalePayloadPath), {
      capability_id: `selftest-only-${crypto.randomUUID()}`,
      signing_key_id: selftestOnlyKeyId
    });
    delete selftestOnlySignedPayload.signature;
    delete selftestOnlySignedPayload.payload_hash;
    selftestOnlySignedPayload = signCapabilityPayload(selftestOnlySignedPayload, selftestOnlyKeypair.privateKey);
    writeTextFile(selftestOnlySignedPath, JSON.stringify(selftestOnlySignedPayload) + '\n');
    selftestOnlyVerify = await runFixtureBha(fixtureRoot, ['verify-signed-capability', '--file', '.bha/local/selftest-only-signed-capability.json']);
  }
  checks.push(regressionCheck('git_push_rejects_selftest_only_signing_key', selftestOnlyMakePayload.exit_code === 2 &&
    selftestOnlyMakePayload.parsed &&
    selftestOnlyMakePayload.parsed.reason === 'CAPABILITY_SIGNING_KEY_PURPOSE_DENIED' &&
    Boolean(selftestOnlySignedPayload) &&
    selftestOnlyVerify.exit_code === 2 &&
    selftestOnlyVerify.parsed &&
    selftestOnlyVerify.parsed.reason === 'CAPABILITY_SIGNING_KEY_PURPOSE_DENIED', {
    make_reason: selftestOnlyMakePayload.parsed ? selftestOnlyMakePayload.parsed.reason : 'NO_JSON',
    verify_reason: selftestOnlyVerify.parsed ? selftestOnlyVerify.parsed.reason : 'NO_JSON',
    key_purpose: selftestOnlyMakePayload.parsed ? selftestOnlyMakePayload.parsed.key_purpose : 'NO_JSON'
  }));

  const advanceHead = await runCommand(['git', 'commit', '--allow-empty', '-m', 'advance head for stale payload check'], { cwd: fixtureRoot });
  const staleGateStatus = await runFixtureBha(fixtureRoot, ['gate-status', '--remote', 'origin', '--branch', branch, '--format', 'json']);
  const staleSignedPayloadStatus = await runFixtureBha(fixtureRoot, ['signed-payload-status', '--remote', 'origin', '--branch', branch, '--format', 'json']);
  const staleHandoff = staleGateStatus.parsed && staleGateStatus.parsed.operator_handoff
    ? staleGateStatus.parsed.operator_handoff
    : null;
  const staleStatus = staleHandoff ? staleHandoff.local_payload_status : null;
  const staleIssues = staleStatus && Array.isArray(staleStatus.not_usable_local_files)
    ? staleStatus.not_usable_local_files
    : [];
  checks.push(regressionCheck('gate_status_flags_stale_local_payload_files', stalePayload.exit_code === 0 &&
    Boolean(staleSignedPayload) &&
    advanceHead.exit_code === 0 &&
    staleGateStatus.exit_code === 0 &&
    staleStatus &&
    staleStatus.unsigned_matches_current_context === false &&
    staleStatus.signed_matches_current_context === false &&
    staleStatus.next_payload_action === 'REGENERATE_UNSIGNED_PAYLOAD_AND_SIGN_CURRENT_CONTEXT' &&
    staleIssues.some((issue) => issue.kind === 'unsigned_payload' && issue.reasons.includes('HEAD_MISMATCH')) &&
    staleIssues.some((issue) => issue.kind === 'signed_payload' && issue.reasons.includes('HEAD_MISMATCH')), {
    gate_action: staleGateStatus.parsed ? staleGateStatus.parsed.next_action : 'NO_JSON',
    unsigned_matches_current_context: staleStatus ? staleStatus.unsigned_matches_current_context : 'NO_JSON',
    signed_matches_current_context: staleStatus ? staleStatus.signed_matches_current_context : 'NO_JSON',
    stale_issue_count: staleIssues.length
  }));
  checks.push(regressionCheck('signed_payload_status_reports_stale_payload', staleSignedPayloadStatus.exit_code === 0 &&
    staleSignedPayloadStatus.parsed &&
    staleSignedPayloadStatus.parsed.read_only === true &&
    staleSignedPayloadStatus.parsed.status === 'SIGNED_PAYLOAD_STALE_OR_INVALID' &&
    staleSignedPayloadStatus.parsed.signed_payload &&
    staleSignedPayloadStatus.parsed.signed_payload.matches_current_context === false &&
    Array.isArray(staleSignedPayloadStatus.parsed.signed_payload.not_usable_reasons) &&
    staleSignedPayloadStatus.parsed.signed_payload.not_usable_reasons.includes('HEAD_MISMATCH'), {
    status: staleSignedPayloadStatus.parsed ? staleSignedPayloadStatus.parsed.status : 'NO_JSON',
    reasons: staleSignedPayloadStatus.parsed && staleSignedPayloadStatus.parsed.signed_payload ? staleSignedPayloadStatus.parsed.signed_payload.not_usable_reasons : 'NO_JSON'
  }));

  const trackedGitReality = staleGateStatus.parsed ? staleGateStatus.parsed.tracked_git_reality : null;
  checks.push(regressionCheck('gate_status_reports_evidence_time_git_heads', staleGateStatus.exit_code === 0 &&
    trackedGitReality &&
    trackedGitReality.current_head &&
    trackedGitReality.checkpoint_head &&
    trackedGitReality.proof_boundary &&
    trackedGitReality.proof_boundary.includes('evidence-time facts'), {
    current_head: trackedGitReality ? trackedGitReality.current_head : 'NO_JSON',
    checkpoint_head: trackedGitReality ? trackedGitReality.checkpoint_head : 'NO_JSON',
    checkpoint_matches_current_head: trackedGitReality ? trackedGitReality.checkpoint_matches_current_head : 'NO_JSON'
  }));

  const verifyFixture = await runCommand([process.execPath, 'scripts/bha-verify.js'], { cwd: fixtureRoot });
  const verifyParsed = parseJsonLine(verifyFixture.stdout);
  checks.push(regressionCheck('fixture_verifier_passes_before_gate_flow', verifyFixture.exit_code === 0 && verifyParsed && verifyParsed.status === 'PASS', {
    status: verifyParsed ? verifyParsed.status : 'NO_JSON',
    exit_code: verifyFixture.exit_code
  }));

  const missingCapabilityPreflight = await runFixtureBha(fixtureRoot, ['prepush-check', '--preflight', '--internal-git-hook', 'origin']);
  checks.push(regressionCheck('missing_local_consumed_capability_fail_closed', missingCapabilityPreflight.exit_code === 1 &&
    missingCapabilityPreflight.parsed &&
    missingCapabilityPreflight.parsed.status === 'FAIL_CLOSED' &&
    missingCapabilityPreflight.parsed.reason === 'NO_VALID_CONSUMED_GIT_PUSH_CAPABILITY', {
    reason: missingCapabilityPreflight.parsed ? missingCapabilityPreflight.parsed.reason : 'NO_JSON'
  }));

  const makePayload = await runFixtureBha(fixtureRoot, [
    'make-push-payload',
    '--remote',
    'origin',
    '--branch',
    branch,
    '--expires-minutes',
    '20',
    '--key-id',
    keyId,
    '--out',
    '.bha/local/push-payload.json'
  ]);
  const payloadPath = path.join(fixtureRoot, '.bha', 'local', 'push-payload.json');
  const unsignedPayload = readJsonStrict(payloadPath);
  const signedPayload = signCapabilityPayload(unsignedPayload, keypair.privateKey);
  const signedPath = path.join(fixtureRoot, '.bha', 'local', 'signed-push-capability.json');
  writeTextFile(signedPath, JSON.stringify(signedPayload) + '\n');
  const readySignedPayloadStatus = await runFixtureBha(fixtureRoot, ['signed-payload-status', '--remote', 'origin', '--branch', branch, '--format', 'json']);
  checks.push(regressionCheck('unsigned_payload_written_local_only', makePayload.exit_code === 0 &&
    makePayload.parsed &&
    makePayload.parsed.payload_path === '.bha/local/push-payload.json', {
    payload_path: makePayload.parsed ? makePayload.parsed.payload_path : 'NO_JSON'
  }));
  checks.push(regressionCheck('signed_payload_status_reports_ready_payload', readySignedPayloadStatus.exit_code === 0 &&
    readySignedPayloadStatus.parsed &&
    readySignedPayloadStatus.parsed.ok === true &&
    readySignedPayloadStatus.parsed.status === 'SIGNED_PAYLOAD_READY' &&
    readySignedPayloadStatus.parsed.signed_payload &&
    readySignedPayloadStatus.parsed.signed_payload.usable_for_current_gate === true &&
    typeof readySignedPayloadStatus.parsed.next_powershell_command === 'string' &&
    !readySignedPayloadStatus.parsed.next_powershell_command.includes('\n'), {
    status: readySignedPayloadStatus.parsed ? readySignedPayloadStatus.parsed.status : 'NO_JSON',
    command_has_newline: readySignedPayloadStatus.parsed && readySignedPayloadStatus.parsed.next_powershell_command
      ? readySignedPayloadStatus.parsed.next_powershell_command.includes('\n')
      : 'NO_JSON'
  }));

  const trackedBeforeIssue = await regressionGitStatus(fixtureRoot);
  const verifySigned = await runFixtureBha(fixtureRoot, ['verify-signed-capability', '--file', '.bha/local/signed-push-capability.json']);
  const issue = await runFixtureBha(fixtureRoot, ['issue-capability', '--file', '.bha/local/signed-push-capability.json']);
  const trackedAfterIssue = await regressionGitStatus(fixtureRoot);
  const consume = await runFixtureBha(fixtureRoot, [
    'consume-capability',
    '--id',
    signedPayload.capability_id,
    '--for',
    'git_push',
    '--remote',
    'origin',
    '--branch',
    branch
  ]);
  const trackedAfterConsume = await regressionGitStatus(fixtureRoot);
  checks.push(regressionCheck('git_push_issue_consume_write_only_bha_local', verifySigned.exit_code === 0 &&
    issue.exit_code === 0 &&
    consume.exit_code === 0 &&
    issue.parsed &&
    consume.parsed &&
    issue.parsed.local_only === true &&
    consume.parsed.local_only === true &&
    issue.parsed.capability_store === '.bha/local/capabilities.jsonl' &&
    consume.parsed.capability_store === '.bha/local/capabilities.jsonl', {
    issue_store: issue.parsed ? issue.parsed.capability_store : 'NO_JSON',
    consume_store: consume.parsed ? consume.parsed.capability_store : 'NO_JSON'
  }));
  checks.push(regressionCheck('issue_consume_leave_tracked_worktree_unchanged', trackedBeforeIssue === trackedAfterIssue && trackedAfterIssue === trackedAfterConsume, {
    before: trackedBeforeIssue || 'CLEAN',
    after_issue: trackedAfterIssue || 'CLEAN',
    after_consume: trackedAfterConsume || 'CLEAN'
  }));

  const sessionsBeforePreflight = localSessionEvents(fixtureRoot).length;
  const preflight = await runFixtureBha(fixtureRoot, ['prepush-check', '--preflight', '--internal-git-hook', 'origin']);
  const sessionsAfterPreflight = localSessionEvents(fixtureRoot).length;
  checks.push(regressionCheck('preflight_read_only_does_not_consume_one_use_capability', preflight.exit_code === 0 &&
    preflight.parsed &&
    preflight.parsed.status === 'ALLOW' &&
    preflight.parsed.preflight === true &&
    preflight.parsed.read_only === true &&
    sessionsBeforePreflight === sessionsAfterPreflight, {
    sessions_before: sessionsBeforePreflight,
    sessions_after: sessionsAfterPreflight
  }));

  const hookReserve = await runCommand(['git', 'push', 'origin', branch], { cwd: fixtureRoot });
  const sessionsAfterReserve = localSessionEvents(fixtureRoot);
  const usedSession = sessionsAfterReserve.find((event) => event.payload && event.payload.status === 'USED' && event.payload.capability_id === signedPayload.capability_id);
  const hookReserveParsed = parseJsonLine(hookReserve.stdout);
  checks.push(regressionCheck('real_hook_reserve_writes_used_session', hookReserve.exit_code === 0 &&
    hookReserveParsed &&
    hookReserveParsed.status === 'ALLOW' &&
    usedSession &&
    usedSession.local_only === true, {
    push_exit_code: hookReserve.exit_code,
    sessions_after: sessionsAfterReserve.length,
    used_capability_id: usedSession && usedSession.payload ? usedSession.payload.capability_id : null
  }));

  const replay = await runFixtureBha(fixtureRoot, ['prepush-check', '--preflight', '--internal-git-hook', 'origin']);
  const postPushGateStatus = await runFixtureBha(fixtureRoot, ['gate-status', '--remote', 'origin', '--branch', branch, '--format', 'json']);
  checks.push(regressionCheck('replayed_local_capability_rejected', replay.exit_code === 1 &&
    replay.parsed &&
    replay.parsed.status === 'FAIL_CLOSED' &&
    replay.parsed.reason === 'CAPABILITY_REPLAY_DETECTED', {
    reason: replay.parsed ? replay.parsed.reason : 'NO_JSON'
  }));

  const cloneRoot = path.join(scratchParent, `fresh-clone-${crypto.randomUUID()}`);
  const clone = await runCommand(['git', 'clone', fixtureRoot, cloneRoot], { cwd: scratchParent });
  const cloneVerify = await runCommand([process.execPath, 'scripts/bha-verify.js'], { cwd: cloneRoot });
  const cloneVerifyParsed = parseJsonLine(cloneVerify.stdout);
  const cloneRecoverStatus = await runCommand([process.execPath, 'scripts/bha-run.js', 'recover-status', '--remote', 'origin', '--branch', branch, '--format', 'json'], { cwd: cloneRoot });
  const cloneRecoverParsed = parseJsonLine(cloneRecoverStatus.stdout);
  const cloneGateStatus = await runFixtureBha(cloneRoot, ['gate-status', '--remote', 'origin', '--branch', branch, '--format', 'json']);
  checks.push(regressionCheck('fresh_clone_without_bha_local_verifier_passes', clone.exit_code === 0 &&
    cloneVerify.exit_code === 0 &&
    cloneVerifyParsed &&
    cloneVerifyParsed.status === 'PASS' &&
    !fs.existsSync(path.join(cloneRoot, '.bha', 'local')), {
    clone_exit_code: clone.exit_code,
    verifier_status: cloneVerifyParsed ? cloneVerifyParsed.status : 'NO_JSON',
    bha_local_exists: fs.existsSync(path.join(cloneRoot, '.bha', 'local'))
  }));
  checks.push(regressionCheck('fresh_clone_recover_status_explains_missing_local_capability', clone.exit_code === 0 &&
    cloneRecoverStatus.exit_code === 0 &&
    cloneRecoverParsed &&
    cloneRecoverParsed.read_only === true &&
    cloneRecoverParsed.tracked_trust &&
    cloneRecoverParsed.tracked_trust.verifier_pass === true &&
    cloneRecoverParsed.local_state &&
    cloneRecoverParsed.local_state.bha_local_exists === false &&
    cloneRecoverParsed.git_push_recovery &&
    cloneRecoverParsed.git_push_recovery.requires_new_local_capability === true &&
    cloneRecoverParsed.git_push_recovery.required_now === false &&
    String(cloneRecoverParsed.git_push_recovery.condition || '').includes('operator-chosen real git push') &&
    Array.isArray(cloneRecoverParsed.git_push_recovery.next_commands) &&
    cloneRecoverParsed.git_push_recovery.next_commands.some((commandText) => commandText.includes('push-prep')), {
    verifier_pass: cloneRecoverParsed && cloneRecoverParsed.tracked_trust ? cloneRecoverParsed.tracked_trust.verifier_pass : 'NO_JSON',
    bha_local_exists: cloneRecoverParsed && cloneRecoverParsed.local_state ? cloneRecoverParsed.local_state.bha_local_exists : 'NO_JSON',
    requires_new_local_capability: cloneRecoverParsed && cloneRecoverParsed.git_push_recovery ? cloneRecoverParsed.git_push_recovery.requires_new_local_capability : 'NO_JSON',
    required_now: cloneRecoverParsed && cloneRecoverParsed.git_push_recovery ? cloneRecoverParsed.git_push_recovery.required_now : 'NO_JSON',
    condition: cloneRecoverParsed && cloneRecoverParsed.git_push_recovery ? cloneRecoverParsed.git_push_recovery.condition : 'NO_JSON'
  }));
  checks.push(regressionCheck('fresh_clone_gate_status_blocks_without_local_capability', clone.exit_code === 0 &&
    cloneGateStatus.exit_code === 0 &&
    cloneGateStatus.parsed &&
    cloneGateStatus.parsed.status === 'BLOCKED' &&
    cloneGateStatus.parsed.read_only === true &&
    cloneGateStatus.parsed.checks &&
    cloneGateStatus.parsed.checks.valid_consumed_capability === false &&
    cloneGateStatus.parsed.capability &&
    cloneGateStatus.parsed.capability.ok === false &&
    !fs.existsSync(path.join(cloneRoot, '.bha', 'local')), {
    status: cloneGateStatus.parsed ? cloneGateStatus.parsed.status : 'NO_JSON',
    valid_consumed_capability: cloneGateStatus.parsed && cloneGateStatus.parsed.checks ? cloneGateStatus.parsed.checks.valid_consumed_capability : 'NO_JSON',
    capability_reason: cloneGateStatus.parsed && cloneGateStatus.parsed.capability ? cloneGateStatus.parsed.capability.reason : 'NO_JSON',
    bha_local_exists: fs.existsSync(path.join(cloneRoot, '.bha', 'local'))
  }));
  const clonePushPrepTrackedBefore = await regressionGitStatus(cloneRoot);
  const clonePushPrep = await runFixtureBha(cloneRoot, [
    'push-prep',
    '--remote',
    'origin',
    '--branch',
    branch,
    '--expires-minutes',
    '20',
    '--key-id',
    keyId,
    '--format',
    'json',
    '--write-handoff'
  ]);
  const clonePushPrepTrackedAfter = await regressionGitStatus(cloneRoot);
  const clonePayloadPath = path.join(cloneRoot, '.bha', 'local', 'push-payload.json');
  const cloneHandoffPath = path.join(cloneRoot, '.bha', 'local', 'push-handoff.json');
  const clonePayload = fs.existsSync(clonePayloadPath) ? readJsonStrict(clonePayloadPath) : null;
  const cloneHandoff = fs.existsSync(cloneHandoffPath) ? readJsonStrict(cloneHandoffPath) : null;
  const cloneHead = await runCommand(['git', 'rev-parse', 'HEAD'], { cwd: cloneRoot });
  checks.push(regressionCheck('fresh_clone_push_prep_generates_local_handoff', clonePushPrep.exit_code === 0 &&
    clonePushPrep.parsed &&
    clonePushPrep.parsed.status === 'PUSH_PREP_READY_FOR_OPERATOR_SIGNER' &&
    clonePushPrep.parsed.payload_path === '.bha/local/push-payload.json' &&
    clonePushPrep.parsed.handoff_path === '.bha/local/push-handoff.json' &&
    clonePushPrep.parsed.head_bound === true &&
    clonePayload &&
    clonePayload.head === cloneHead.stdout.trim() &&
    cloneHandoff &&
    cloneHandoff.schema === 'bha.push_handoff.v1' &&
    typeof cloneHandoff.next_powershell_command === 'string' &&
    !cloneHandoff.next_powershell_command.includes('\n') &&
    clonePushPrepTrackedBefore === clonePushPrepTrackedAfter, {
    status: clonePushPrep.parsed ? clonePushPrep.parsed.status : 'NO_JSON',
    payload_head: clonePayload ? clonePayload.head : 'MISSING',
    clone_head: cloneHead.stdout.trim() || 'UNKNOWN',
    handoff_path: clonePushPrep.parsed ? clonePushPrep.parsed.handoff_path : 'NO_JSON',
    tracked_before: clonePushPrepTrackedBefore || 'CLEAN',
    tracked_after: clonePushPrepTrackedAfter || 'CLEAN'
  }));
  checks.push(regressionCheck('local_git_push_replay_fail_closed_after_used_session', hookReserve.exit_code === 0 &&
    replay.exit_code === 1 &&
    replay.parsed &&
    replay.parsed.reason === 'CAPABILITY_REPLAY_DETECTED' &&
    postPushGateStatus.exit_code === 0 &&
    postPushGateStatus.parsed &&
    postPushGateStatus.parsed.post_push_status &&
    postPushGateStatus.parsed.post_push_status.phase === 'PUSHED_CAPABILITY_USED_REPLAY_BLOCKED' &&
    postPushGateStatus.parsed.post_push_status.pushed_capability_used === true &&
    postPushGateStatus.parsed.post_push_status.replay_blocked === true &&
    postPushGateStatus.parsed.post_push_status.remote_tracking_matches_current_head === true, {
    replay_reason: replay.parsed ? replay.parsed.reason : 'NO_JSON',
    phase: postPushGateStatus.parsed && postPushGateStatus.parsed.post_push_status ? postPushGateStatus.parsed.post_push_status.phase : 'NO_JSON',
    remote_tracking_matches_current_head: postPushGateStatus.parsed && postPushGateStatus.parsed.post_push_status ? postPushGateStatus.parsed.post_push_status.remote_tracking_matches_current_head : 'NO_JSON'
  }));

  const deniedCases = [
    ['provider_call_denied', ['openai', 'models', 'list']],
    ['memory_write_denied', ['codex-memory', 'write']],
    ['deploy_denied', ['kubectl', 'apply', '-f', 'production.yaml']],
    ['release_denied', ['gh', 'release', 'create']],
    ['tag_denied', ['git', 'tag', 'v0.0.0']],
    ['package_publish_denied', ['npm', 'publish']],
    ['production_write_denied', ['psql', 'production', '-c', 'update']],
    ['force_push_denied', ['git', 'push', '--force', 'origin', branch]],
    ['destructive_external_action_denied', ['rm', '-rf', 'external']]
  ];
  const deniedResults = [];
  for (const [id, argv] of deniedCases) {
    const result = await runFixtureBha(fixtureRoot, ['check', '--'].concat(argv));
    const pass = result.exit_code === 0 &&
      result.parsed &&
      result.parsed.decision === 'DENY' &&
      result.parsed.spawned === false;
    deniedResults.push({
      id,
      argv,
      status: pass ? 'PASS' : 'FAIL',
      decision: result.parsed ? result.parsed.decision : 'NO_JSON',
      rule: result.parsed ? result.parsed.rule : null
    });
    checks.push(regressionCheck(id, pass, deniedResults[deniedResults.length - 1]));
  }

  const mainTrackedAfter = await regressionGitStatus(ROOT);
  const ok = checks.every((check) => check.status === 'PASS');
  const report = {
    ok,
    status: ok ? 'PASS' : 'FAIL',
    schema: 'bha.regression_selftest.v1',
    recorded: false,
    read_only: false,
    local_only_writes: true,
    tracked_repo_write: mainTrackedBefore !== mainTrackedAfter,
    fixture: {
      root: rel(fixtureRoot),
      fresh_clone: rel(cloneRoot),
      private_key_repo_write: false,
      signer: 'ephemeral in-memory self-test keypair; BHA does not read operator private keys'
    },
    checks,
    denied_capabilities: deniedResults,
    hard_boundaries: [
      'regression-selftest writes only under .bha/local/ in the real repository',
      'fixture git operations are local-only and do not push, fetch, deploy, release, tag, publish, call providers, or write production',
      'private key material is generated in memory for the isolated fixture and is not printed, stored, or recorded'
    ]
  };
  console.log(JSON.stringify(report));
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
    schema: 'bha.capability.v1',
    id,
    capability_id: id,
    type: 'git_push',
    run_id: bindings.run_id,
    policy_hash: policyHash(),
    mission_hash: missionHash(),
    remote: bindings.remote,
    branch: bindings.branch,
    head: bindings.head,
    ledger_head_hash: loadState().ledger_head_hash,
    one_use: true,
    expires_at: bindings.expires_at,
    signing_key_id: keyId,
    algorithm: 'ed25519',
    signature_encoding: 'base64',
    payload_hash_format: 'sha256-hex'
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
    appendLocalCapabilitySession({
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
    appendLocalCapabilitySession({
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

function capabilityCloseoutSummary(capabilities, state, localCapabilities, localSessions) {
  const validEvents = capabilities.filter((event) => event.payload && event.payload.valid === true);
  const localEvents = (localCapabilities || []).concat(localSessions || []);
  const validLocalEvents = localEvents.filter((event) => event.payload && event.payload.valid === true);
  const usedPushSessions = (localSessions || []).filter((event) => {
    const payload = event && event.payload ? event.payload : {};
    return event.type === 'capability_session' &&
      payload.valid === true &&
      payload.status === 'USED' &&
      payload.remote &&
      payload.branch &&
      payload.head;
  });
  const lastUsedPushSession = usedPushSessions.length ? usedPushSessions[usedPushSessions.length - 1] : null;
  const selftest = state && state.capability_selftest ? state.capability_selftest : null;
  return {
    events: capabilities.length,
    valid_events: validEvents.length,
    issue_events: capabilities.filter((event) => event.type === 'capability_issue').length,
    consume_events: capabilities.filter((event) => event.type === 'capability_consume').length,
    session_events: capabilities.filter((event) => event.type === 'capability_session').length,
    local_only_events: localEvents.length,
    local_only_valid_events: validLocalEvents.length,
    local_only_issue_events: (localCapabilities || []).filter((event) => event.type === 'capability_issue').length,
    local_only_consume_events: (localCapabilities || []).filter((event) => event.type === 'capability_consume').length,
    local_only_session_events: (localSessions || []).filter((event) => event.type === 'capability_session').length,
    git_push_authorization_evidence: {
      store: '.bha/local/capabilities.jsonl',
      session_store: '.bha/local/capability-sessions.jsonl',
      tracked: false,
      reason: 'git_push authorization occurs after the signed HEAD exists and must not dirty tracked evidence before push'
    },
    last_local_git_push_used_session: lastUsedPushSession ? {
      capability_id: lastUsedPushSession.payload.capability_id || null,
      remote: lastUsedPushSession.payload.remote || null,
      branch: lastUsedPushSession.payload.branch || null,
      head: lastUsedPushSession.payload.head || null,
      event_hash: lastUsedPushSession.event_hash,
      tracked_remote_proof: false,
      proof_boundary: 'Local USED session proves this BHA gate consumed a one-use capability locally; it is not remote proof by itself.'
    } : 'NOT_RECORDED',
    capability_positive_path: selftest ? selftest.capability_positive_path : 'NOT_RECORDED',
    prepush_authorized_simulation: selftest ? selftest.prepush_authorized_simulation : 'NOT_RECORDED',
    negative_capability_tests: selftest ? selftest.negative_capability_tests : 'NOT_RECORDED'
  };
}

async function handleCheckpoint(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const mission = loadMission();
  const policy = loadPolicy();
  const state = loadState();
  const head = ledgerHead();
  const expectedLedgerHeadHash = head.hash || 'GENESIS';
  const branch = await currentBranch();
  const current = await currentHead();
  const gitStatus = await gitStatusShort();
  const verify = await verifierResult();
  const validation = state.validation || null;
  const validationCommands = validation && Array.isArray(validation.commands) ? validation.commands : [];
  const failedValidation = validationCommands.filter((command) => command.status !== 'PASS').map((command) => command.id);
  const changedFiles = gitStatus.ok ? changedFilesFromStatus(gitStatus.stdout) : [];
  const verifierIssues = verify.parsed && Array.isArray(verify.parsed.issues) ? verify.parsed.issues : [];
  const checkpointId = `checkpoint-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const checkpoint = {
    schema: 'bha.checkpoint.v1',
    checkpoint_id: checkpointId,
    created_at: new Date().toISOString(),
    run_id: state.run_id,
    actor_id: 'bha-run',
    goal: {
      mission_id: mission.mission_id,
      name: mission.name,
      objective: mission.objective,
      mission_hash: missionHash(mission)
    },
    phase: 'checkpoint',
    workspace: rel(ROOT) || '.',
    branch: branch || 'UNKNOWN',
    head: current || 'UNKNOWN',
    ledger_head_hash: expectedLedgerHeadHash,
    policy_hash: policyHash(policy),
    mission_hash: missionHash(mission),
    completed: validationCommands.filter((command) => command.status === 'PASS').map((command) => command.id),
    changed_files: changedFiles,
    validation_run: validation ? {
      status: validation.status,
      completed_at: validation.completed_at || 'UNKNOWN',
      ledger_event_hash: validation.ledger_event_hash || 'NOT_RECORDED',
      command_count: validationCommands.length
    } : 'NOT_RECORDED',
    validation_not_run: failedValidation,
    verifier_status: verify.parsed ? verify.parsed.status : 'UNKNOWN',
    verifier_ledger_head_hash: verify.parsed && verify.parsed.ledger_head_hash ? verify.parsed.ledger_head_hash : 'UNKNOWN',
    blockers: verifierIssues.map((issue) => issue.code),
    risks: [
      'worktree may be dirty by design during local v1 kernel development',
      'real git push remains blocked without signed consumed git_push capability',
      'checkpoint is resumable evidence, not proof of external-world side effects'
    ],
    next_safe_action: 'Continue local v1 kernel hardening; do not perform remote writes without explicit authorization and a valid consumed git_push capability.',
    resume: {
      next_session_commands: [
        'node scripts/bha-run.js inspect --format json',
        'node scripts/bha-verify.js',
        `node scripts/bha-run.js recover-status --remote origin --branch ${branch || 'master'} --format json`,
        `node scripts/bha-run.js gate-status --remote origin --branch ${branch || 'master'} --format json`
      ],
      fresh_clone_path: [
        'node scripts/bha-verify.js',
        'node scripts/bha-run.js recover-status --remote origin --branch master --format json',
        'if verifier is not PASS because tracked evidence is stale: node scripts/bha-run.js validate',
        'node scripts/bha-run.js checkpoint --format json',
        'node scripts/bha-run.js closeout --record --format json',
        'node scripts/bha-verify.js'
      ],
      local_only_gate_evidence: '.bha/local/ is intentionally not required for tracked verifier trust and is required only for a real git_push gate'
    },
    stop_conditions: mission.hard_stop_conditions || [],
    checkpoint_binding: {
      verified_ledger_head_hash: expectedLedgerHeadHash,
      checkpoint_event_hash: 'SELF_EVENT_HASH',
      final_ledger_head_hash: 'SELF_EVENT_HASH'
    }
  };
  let event;
  try {
    event = appendLedger('checkpoint_written', ({ head: lockedHead }) => {
      const lockedHeadHash = lockedHead.hash || 'GENESIS';
      if (lockedHeadHash !== expectedLedgerHeadHash) {
        throw new Error('CHECKPOINT_LEDGER_HEAD_CHANGED_BEFORE_APPEND');
      }
      checkpoint.ledger_head_hash = lockedHeadHash;
      checkpoint.checkpoint_binding.verified_ledger_head_hash = lockedHeadHash;
      return checkpoint;
    }, (nextState, checkpointEvent) => {
      nextState.last_checkpoint = {
        checkpoint_id: checkpoint.checkpoint_id,
        created_at: checkpointEvent.ts,
        ledger_event_hash: checkpointEvent.event_hash,
        verified_ledger_head_hash: checkpoint.ledger_head_hash,
        checkpoint_event_hash: checkpointEvent.event_hash,
        final_ledger_head_hash: checkpointEvent.event_hash,
        path: rel(CHECKPOINT_PATH),
        policy_hash: checkpointEvent.policy_hash,
        mission_hash: checkpointEvent.mission_hash
      };
      nextState.last_checkpoint_id = checkpoint.checkpoint_id;
    });
  } catch (error) {
    if (!error || error.message !== 'CHECKPOINT_LEDGER_HEAD_CHANGED_BEFORE_APPEND') {
      throw error;
    }
    console.log(JSON.stringify({
      ok: false,
      status: 'CHECKPOINT_BLOCKED',
      recorded: false,
      read_only: false,
      reason: error && error.message ? error.message : 'CHECKPOINT_RECORD_FAILED'
    }));
    process.exitCode = 3;
    return;
  }
  checkpoint.ledger_event_hash = event.event_hash;
  checkpoint.created_at = event.ts;
  checkpoint.checkpoint_binding.checkpoint_event_hash = event.event_hash;
  checkpoint.checkpoint_binding.final_ledger_head_hash = event.event_hash;
  writeJson(CHECKPOINT_PATH, checkpoint);
  console.log(JSON.stringify({
    ok: true,
    status: 'CHECKPOINT_RECORDED',
    recorded: true,
    read_only: false,
    checkpoint,
    checkpoint_binding: checkpoint.checkpoint_binding,
    event: {
      event_hash: event.event_hash,
      event_id: event.event_id,
      type: event.type
    }
  }));
}

async function handleCloseout(args) {
  const format = getOption(args, '--format') || 'json';
  const record = args.includes('--record');
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
  const localCapabilities = readLocalCapabilityEvents();
  const localSessions = readLocalCapabilitySessions();
  const gitStatus = await gitStatusShort();
  const verify = await verifierResult();
  const validationStatus = state && state.validation ? state.validation.status : 'NOT_RECORDED';
  const capabilitySummary = capabilityCloseoutSummary(capabilities, state, localCapabilities, localSessions);
  const changedFiles = gitStatus.ok ? changedFilesFromStatus(gitStatus.stdout) : [];
  const currentGitHead = await currentHead();
  const currentGitBranch = await currentBranch();
  const checkpoint = readCheckpointFile();
  const gitReality = gitStatus.ok ? {
    branch: currentGitBranch || 'UNKNOWN',
    head: currentGitHead || 'UNKNOWN',
    clean: gitStatus.clean,
    short: gitStatus.stdout.trim() || 'CLEAN'
  } : {
    branch: currentGitBranch || 'UNKNOWN',
    head: currentGitHead || 'UNKNOWN',
    clean: 'UNKNOWN'
  };
  const gitRealityBinding = trackedGitRealityBindingFromHeads(
    currentGitHead,
    checkpoint && checkpoint.head ? checkpoint.head : null,
    gitReality.head
  );
  const effects = forbiddenLedgerEffects(ledger, policy);
  const selftest = state && state.capability_selftest ? state.capability_selftest : null;
  const verifiedLedgerHeadHash = verify.parsed && verify.parsed.ledger_head_hash
    ? verify.parsed.ledger_head_hash
    : (ledger.length ? ledger[ledger.length - 1].event_hash : 'NOT_RECORDED');
  const finalLedgerHeadHash = ledger.length ? ledger[ledger.length - 1].event_hash : 'NOT_RECORDED';
  const unknowns = [];
  if (!selftest) {
    unknowns.push('capability_selftest');
  }
  if (!state || !state.validation) {
    unknowns.push('validation');
  }
  const unsupportedClaims = verify.parsed && Array.isArray(verify.parsed.issues)
    ? verify.parsed.issues.filter((issue) => issue.code === 'CLOSEOUT_UNSUPPORTED_CLAIM')
    : [];
  const verifierWarnings = verify.parsed && Array.isArray(verify.parsed.warnings)
    ? verify.parsed.warnings
    : [];
  const blockingVerifierWarnings = verifierWarnings.filter((warning) => {
    return warning && warning.code !== 'CLOSEOUT_NOT_CURRENT_LEDGER_HEAD';
  });
  const report = {
    ok: true,
    status: 'CLOSEOUT_GENERATED',
    closeout_status: verify.ok && validationStatus === 'PASS' && unsupportedClaims.length === 0 ? 'PASS' : 'BLOCKED',
    recorded: false,
    read_only: true,
    mission: mission ? { mission_id: mission.mission_id, run_id: mission.run_id, mode: mission.mode, name: mission.name, mission_hash: missionHash(mission) } : 'UNKNOWN',
    policy: policy ? {
      policy_id: policy.metadata ? policy.metadata.policy_id : 'UNKNOWN',
      version: policy.metadata ? policy.metadata.version : 'UNKNOWN',
      mode: policy.metadata ? policy.metadata.mode : 'UNKNOWN',
      deny_before_allow: policy.metadata ? policy.metadata.deny_rules_run_before_allow_rules === true : 'UNKNOWN',
      policy_hash: policyHash(policy)
    } : 'UNKNOWN',
    state: state ? {
      run_id: state.run_id,
      policy_hash: state.policy_hash || 'NOT_RECORDED',
      mission_hash: state.mission_hash || 'NOT_RECORDED',
      ledger_head_hash: state.ledger_head_hash || 'NOT_RECORDED',
      ledger_event_count: state.ledger_event_count,
      validation_status: validationStatus || 'NOT_RECORDED'
    } : 'UNKNOWN',
    ledger: {
      events: ledger.length,
      head_hash: ledger.length ? ledger[ledger.length - 1].event_hash : 'NOT_RECORDED'
    },
    closeout_binding: {
      verified_ledger_head_hash: verifiedLedgerHeadHash,
      closeout_event_hash: 'NOT_RECORDED_READ_ONLY_CLOSEOUT',
      final_ledger_head_hash: finalLedgerHeadHash,
      verifier_status_applies_to: 'verified_ledger_head_hash'
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
    fact_groups: {
      tracked_verifier_facts: {
        source: ['.bha/ledger.jsonl', '.bha/state.json', '.bha/policy.yaml', '.bha/mission.yaml', '.bha/validation.yaml', 'scripts/bha-verify.js'],
        verifier_status: verify.parsed ? verify.parsed.status : 'UNKNOWN',
        verifier_ledger_head_hash: verifiedLedgerHeadHash,
        validation_status: validationStatus || 'NOT_RECORDED'
      },
      local_only_capability_facts: {
        source: ['.bha/local/capabilities.jsonl', '.bha/local/capability-sessions.jsonl'],
        required_for_tracked_verifier_pass: false,
        summary: capabilitySummary
      },
      git_reality: gitReality,
      git_reality_binding: gitRealityBinding,
      skipped_validation: state && state.validation && Array.isArray(state.validation.commands)
        ? state.validation.commands.filter((command) => command.status !== 'PASS').map((command) => command.id)
        : ['VALIDATION_NOT_RECORDED'],
      remaining_risks: [
        'local-only git_push authorization evidence is not present in fresh clones',
        'remote push still requires explicit operator action and a valid one-use consumed capability',
        'BHA local evidence is not a remote attestation or OS-level sandbox'
      ],
      next_gates: [
        'node scripts/bha-run.js validate',
        'node scripts/bha-verify.js',
        'node scripts/bha-run.js recover-status --remote origin --branch master --format json',
        'node scripts/bha-run.js checkpoint --format json',
        'node scripts/bha-run.js closeout --record --format json',
        'node scripts/bha-run.js gate-status --remote origin --branch master --format json'
      ]
    },
    fresh_clone_recovery: {
      tracked_trust_without_local_gate_evidence: 'node scripts/bha-verify.js',
      recovery_status: 'node scripts/bha-run.js recover-status --remote origin --branch master --format json',
      if_tracked_evidence_is_stale: [
        'node scripts/bha-run.js validate',
        'node scripts/bha-run.js checkpoint --format json',
        'node scripts/bha-run.js closeout --record --format json',
        'node scripts/bha-verify.js'
      ],
      note: '.bha/local/ is intentionally absent in a fresh clone and is not required for verifier PASS.'
    },
    unknowns,
    unsupported_claims: unsupportedClaims,
    verifier_warnings: verifierWarnings,
    next_gate: selftest && selftest.status === 'PASS'
      ? 'READ_ONLY_VERIFIER_AND_MANUAL_AUTHORIZATION_FOR_ANY_REAL_PUSH'
      : 'CAPABILITY_SELFTEST_REQUIRED'
  };

  if (record) {
    const blockers = [];
    if (!verify.ok || !verify.parsed || verify.parsed.status !== 'PASS') {
      blockers.push('VERIFIER_NOT_PASSING');
    }
    if (blockingVerifierWarnings.length > 0) {
      blockers.push('VERIFIER_WARNINGS_PRESENT');
    }
    if (validationStatus !== 'PASS') {
      blockers.push('VALIDATION_NOT_PASSING');
    }
    if (unsupportedClaims.length > 0) {
      blockers.push('CLOSEOUT_UNSUPPORTED_CLAIM');
    }
    if (unknowns.length > 0) {
      blockers.push('CLOSEOUT_UNKNOWN_EVIDENCE');
    }
    if (effects.forbidden_spawned) {
      blockers.push('FORBIDDEN_COMMAND_EXECUTED');
    }
    if (blockers.length > 0) {
      report.ok = false;
      report.status = 'CLOSEOUT_BLOCKED';
      report.closeout_status = 'BLOCKED';
      report.blockers = blockers;
      console.log(JSON.stringify(report));
      process.exitCode = 3;
      return;
    }

    const closeoutPayload = {
      schema: 'bha.closeout.v1',
      status: 'PASS',
      mode: 'recorded',
      run_id: state.run_id,
      policy_hash: policyHash(policy),
      mission_hash: missionHash(mission),
      verifier_status: verify.parsed.status,
      validation_status: validationStatus,
      verifier_warnings: verifierWarnings,
      validation_ledger_event_hash: state.validation && state.validation.ledger_event_hash
        ? state.validation.ledger_event_hash
        : 'NOT_RECORDED',
      unsupported_claims: unsupportedClaims,
      unknowns,
      closeout_binding: {
        verified_ledger_head_hash: verifiedLedgerHeadHash,
        closeout_event_hash: 'SELF_EVENT_HASH',
        final_ledger_head_hash: 'SELF_EVENT_HASH',
        verifier_status_applies_to: 'verified_ledger_head_hash'
      },
      changed_files: changedFiles,
      external_effects: report.external_effects,
      capability_summary: capabilitySummary,
      fact_groups: report.fact_groups,
      fresh_clone_recovery: report.fresh_clone_recovery
    };
    let event;
    try {
      event = appendLedger('closeout_completed', ({ head: lockedHead }) => {
        const lockedHeadHash = lockedHead.hash || 'GENESIS';
        if (lockedHeadHash !== finalLedgerHeadHash || lockedHeadHash !== verifiedLedgerHeadHash) {
          throw new Error('CLOSEOUT_LEDGER_HEAD_CHANGED_BEFORE_APPEND');
        }
        closeoutPayload.closeout_binding.verified_ledger_head_hash = lockedHeadHash;
        return closeoutPayload;
      }, (nextState, closeoutEvent) => {
        nextState.closeout = {
          status: 'PASS',
          completed_at: closeoutEvent.ts,
          ledger_event_hash: closeoutEvent.event_hash,
          verified_ledger_head_hash: closeoutPayload.closeout_binding.verified_ledger_head_hash,
          closeout_event_hash: closeoutEvent.event_hash,
          final_ledger_head_hash: closeoutEvent.event_hash,
          validation_ledger_event_hash: closeoutPayload.validation_ledger_event_hash,
          policy_hash: closeoutEvent.policy_hash,
          mission_hash: closeoutEvent.mission_hash
        };
      });
    } catch (error) {
      if (!error || error.message !== 'CLOSEOUT_LEDGER_HEAD_CHANGED_BEFORE_APPEND') {
        throw error;
      }
      report.ok = false;
      report.status = 'CLOSEOUT_BLOCKED';
      report.closeout_status = 'BLOCKED';
      report.blockers = ['LEDGER_HEAD_CHANGED_BEFORE_APPEND'];
      report.reason = error && error.message ? error.message : 'CLOSEOUT_RECORD_FAILED';
      console.log(JSON.stringify(report));
      process.exitCode = 3;
      return;
    }

    report.status = 'CLOSEOUT_RECORDED';
    report.recorded = true;
    report.read_only = false;
    report.closeout_binding.closeout_event_hash = event.event_hash;
    report.closeout_binding.final_ledger_head_hash = event.event_hash;
    report.closeout_event = {
      event_hash: event.event_hash,
      event_id: event.event_id,
      type: event.type
    };
    report.ledger.events += 1;
    report.ledger.head_hash = event.event_hash;
    if (report.state && report.state !== 'UNKNOWN') {
      report.state.ledger_head_hash = event.event_hash;
      report.state.ledger_event_count += 1;
    }
  }

  console.log(JSON.stringify(report));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'check') {
      await handleCheck(args);
    } else if (command === 'exec') {
      await handleExec(args);
    } else if (command === 'inspect') {
      await handleInspect(args);
    } else if (command === 'validate') {
      await handleValidate();
    } else if (command === 'verify') {
      await handleVerify();
    } else if (command === 'checkpoint') {
      await handleCheckpoint(args);
    } else if (command === 'closeout') {
      await handleCloseout(args);
    } else if (command === 'make-push-payload') {
      await handleMakePushPayload(args);
    } else if (command === 'push-prep') {
      await handlePushPrep(args);
    } else if (command === 'signed-payload-status') {
      await handleSignedPayloadStatus(args);
    } else if (command === 'operator-signer-preflight') {
      await handleOperatorSignerPreflight(args);
    } else if (command === 'recover-status') {
      await handleRecoverStatus(args);
    } else if (command === 'git-push-capability-flow') {
      await handleGitPushCapabilityFlow(args);
    } else if (command === 'rollback-drill') {
      await handleRollbackDrill(args);
    } else if (command === 'verify-signed-capability') {
      await handleVerifySignedCapability(args);
    } else if (command === 'issue-capability') {
      await handleIssueCapability(args);
    } else if (command === 'consume-capability') {
      await handleConsumeCapability(args);
    } else if (command === 'capability-selftest') {
      await handleCapabilitySelftest(args);
    } else if (command === 'prepush-check') {
      await handlePrepushCheck(args);
    } else if (command === 'hook-status') {
      await handleHookStatus(args);
    } else if (command === 'gate-status') {
      await handleGateStatus(args);
    } else if (command === 'capability-framework-status') {
      await handleCapabilityFrameworkStatus(args);
    } else if (command === 'council-status') {
      await handleCouncilStatus(args);
    } else if (command === 'audit-v1-stable') {
      await handleAuditV1Stable(args);
    } else if (command === 'audit-v12') {
      await handleAuditV12(args);
    } else if (command === 'regression-selftest') {
      await handleRegressionSelftest(args);
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
