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
const LOCAL_CAPABILITY_SESSIONS_PATH = path.join(BHA_LOCAL_DIR, 'capability-sessions.jsonl');
const VALIDATION_PATH = path.join(BHA_DIR, 'validation.yaml');
const ROLLBACK_PATH = path.join(BHA_DIR, 'rollback.md');
const ROADMAP_PATH = path.join(BHA_DIR, 'roadmap.md');
const CHECKPOINT_PATH = path.join(BHA_DIR, 'checkpoint.json');
const RUN_SCRIPT = path.join(ROOT, 'scripts', 'bha-run.js');
const VERIFY_SCRIPT = path.join(ROOT, 'scripts', 'bha-verify.js');
const PRE_PUSH_PATH = path.join(ROOT, '.githooks', 'pre-push');
const DESIGN_PATH = path.join(ROOT, 'BHA_DESIGN.md');
const AGENTS_PATH = path.join(ROOT, 'AGENTS.md');
const GITIGNORE_PATH = path.join(ROOT, '.gitignore');

const VALIDATION_INPUTS = [
  DESIGN_PATH,
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
  return sha256(stable(withoutHashFields(policy || loadPolicy())));
}

function missionHash(mission) {
  return sha256(stable(withoutHashFields(mission || loadMission())));
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
  return callback();
}

function appendLedger(type, payload, mutateState) {
  return withLedgerLock(() => {
    fs.mkdirSync(BHA_DIR, { recursive: true });
    const mission = loadMission();
    const policy = loadPolicy();
    const state = loadState();
    const head = ledgerHead();
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
      payload
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

function capabilityType(payload) {
  return String(payload.type || payload.for || payload.capability || '').trim();
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
  if (disallowedCapabilityType(type)) {
    return capabilityResult(payload, false, 'DISALLOWED_CAPABILITY_TYPE');
  }
  if (type !== 'git_push') {
    return capabilityResult(payload, false, 'CAPABILITY_TYPE_NOT_SUPPORTED');
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
  if (disallowedCapabilityType(type)) {
    return { valid: false, reason: 'DISALLOWED_CAPABILITY_TYPE' };
  }
  if (type !== 'git_push') {
    return { valid: false, reason: 'CAPABILITY_TYPE_NOT_SUPPORTED' };
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

function appendCapabilityEvent(type, payload) {
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

function appendLocalCapabilitySession(payload) {
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
    type: 'capability_session',
    local_only: true,
    payload
  };
  event.event_hash = capabilityHash(event);
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

function readCapabilityEventsWithLocalSessions() {
  return readCapabilityEvents().concat(readLocalCapabilitySessions());
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
      capability_store: '.bha/capabilities.jsonl'
    }));
    process.exitCode = 2;
    return;
  }
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
  const existingSerials = readCapabilityEvents()
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
        argv_prefix: ['node', 'scripts/bha-run.js', 'issue-capability', '--json']
      },
      {
        id: 'consume_capability',
        status: 'WAITING_FOR_ISSUED_CAPABILITY',
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
  const events = readCapabilityEvents();
  const eventsWithLocalSessions = events.concat(readLocalCapabilitySessions());
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
    if (validCapabilitySessions(eventsWithLocalSessions, id).length > 0) {
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
    clean_git_status: status.ok === true && (status.clean === true || authorizedRuntimeDirty(status.stdout))
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
    return 'COMMIT_OR_REMOVE_UNVERIFIED_WORKTREE_CHANGES';
  }
  if (!checks.valid_consumed_capability || !checks.matching_run_id_remote_branch_head) {
    return capability && capability.reason === 'CAPABILITY_REPLAY_DETECTED'
      ? 'ISSUE_AND_CONSUME_A_NEW_SIGNED_GIT_PUSH_CAPABILITY'
      : 'MAKE_SIGN_ISSUE_AND_CONSUME_GIT_PUSH_CAPABILITY';
  }
  return 'READY_FOR_PREPUSH_PREFLIGHT_OR_PUSH';
}

async function gateStatus(remote, branch) {
  const head = await currentHead();
  const status = await gitStatusShort();
  const verify = await verifierResult();
  const state = loadState();
  const ledger = readJsonl(LEDGER_PATH);
  const evidence = prepushEvidenceGates(state, ledger, verify);
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
    clean_git_status: status.ok === true && (status.clean === true || authorizedRuntimeDirty(status.stdout))
  };
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
    hook: await hookPathStatus(),
    git_status: {
      ok: status.ok,
      clean: status.clean,
      authorized_runtime_dirty: status.ok === true && status.clean !== true ? authorizedRuntimeDirty(status.stdout) : false,
      short: status.stdout.trim() || 'CLEAN'
    },
    post_push_evidence_strategy: {
      tracked_evidence: ['.bha/capabilities.jsonl issue/consume events', '.bha/ledger.jsonl', '.bha/state.json'],
      local_only_evidence: ['.bha/local/capability-sessions.jsonl push hook USED sessions'],
      reason: 'push hook replay guard sessions are local-only to avoid recursive evidence commits'
    },
    next_action: nextGateAction(checks, capability)
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
    ledger_head_hash: head.hash || 'GENESIS',
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
    stop_conditions: mission.hard_stop_conditions || [],
    checkpoint_binding: {
      verified_ledger_head_hash: head.hash || 'GENESIS',
      checkpoint_event_hash: 'SELF_EVENT_HASH',
      final_ledger_head_hash: 'SELF_EVENT_HASH'
    }
  };
  const event = appendLedger('checkpoint_written', checkpoint, (nextState, checkpointEvent) => {
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
  const gitStatus = await gitStatusShort();
  const verify = await verifierResult();
  const validationStatus = state && state.validation ? state.validation.status : 'NOT_RECORDED';
  const capabilitySummary = capabilityCloseoutSummary(capabilities, state);
  const changedFiles = gitStatus.ok ? changedFilesFromStatus(gitStatus.stdout) : [];
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
      capability_summary: capabilitySummary
    };
    const event = appendLedger('closeout_completed', closeoutPayload, (nextState, closeoutEvent) => {
      nextState.closeout = {
        status: 'PASS',
        completed_at: closeoutEvent.ts,
        ledger_event_hash: closeoutEvent.event_hash,
        verified_ledger_head_hash: verifiedLedgerHeadHash,
        closeout_event_hash: closeoutEvent.event_hash,
        final_ledger_head_hash: closeoutEvent.event_hash,
        validation_ledger_event_hash: closeoutPayload.validation_ledger_event_hash,
        policy_hash: closeoutEvent.policy_hash,
        mission_hash: closeoutEvent.mission_hash
      };
    });

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
    } else if (command === 'gate-status') {
      await handleGateStatus(args);
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
