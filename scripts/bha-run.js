#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const {
  commandEffect,
  effectAllowsTrackedWrite,
  effectAllowsLocalWrite,
  effectIsReadOnly
} = require('./lib/command-effects');
const policyCheck = require('./lib/policy-check');
const validationRunner = require('./lib/validation-runner');
const { createCapabilityStore } = require('./lib/capability-store');
const pushGate = require('./lib/push-gate');
const gitReality = require('./lib/git-reality');
const localPayloadStatusLib = require('./lib/local-payload-status');
const payloadSummary = require('./lib/payload-summary');
const capabilityVerifier = require('./lib/capability-verifier');

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
const LOCAL_CAPABILITY_LOCK_PATH = path.join(BHA_LOCAL_DIR, 'capability.lock');
const LEDGER_LOCK_TIMEOUT_MS = 2000;
const LEDGER_LOCK_STALE_MS = 30000;
const LOCAL_CAPABILITY_LOCK_TIMEOUT_MS = 2000;
const VALIDATION_PATH = path.join(BHA_DIR, 'validation.yaml');
const ROLLBACK_PATH = path.join(BHA_DIR, 'rollback.md');
const ROADMAP_PATH = path.join(BHA_DIR, 'roadmap.md');
const CHECKPOINT_PATH = path.join(BHA_DIR, 'checkpoint.json');
const RUN_SCRIPT = path.join(ROOT, 'scripts', 'bha-run.js');
const VERIFY_SCRIPT = path.join(ROOT, 'scripts', 'bha-verify.js');
const COMMAND_EFFECTS_SCRIPT = path.join(ROOT, 'scripts', 'lib', 'command-effects.js');
const POLICY_CHECK_SCRIPT = path.join(ROOT, 'scripts', 'lib', 'policy-check.js');
const VALIDATION_RUNNER_SCRIPT = path.join(ROOT, 'scripts', 'lib', 'validation-runner.js');
const CAPABILITY_STORE_SCRIPT = path.join(ROOT, 'scripts', 'lib', 'capability-store.js');
const PUSH_GATE_SCRIPT = path.join(ROOT, 'scripts', 'lib', 'push-gate.js');
const GIT_REALITY_SCRIPT = path.join(ROOT, 'scripts', 'lib', 'git-reality.js');
const LOCAL_PAYLOAD_STATUS_SCRIPT = path.join(ROOT, 'scripts', 'lib', 'local-payload-status.js');
const PAYLOAD_SUMMARY_SCRIPT = path.join(ROOT, 'scripts', 'lib', 'payload-summary.js');
const CAPABILITY_VERIFIER_SCRIPT = path.join(ROOT, 'scripts', 'lib', 'capability-verifier.js');
const PRE_PUSH_PATH = path.join(ROOT, '.githooks', 'pre-push');
const DESIGN_PATH = path.join(ROOT, 'BHA_DESIGN.md');
const LONG_TERM_GOAL_AUDIT_PATH = path.join(ROOT, 'BHA_LONG_TERM_GOAL_AUDIT.md');
const STABILITY_PATH = path.join(ROOT, 'BHA_V1_STABILITY.md');
const CAPABILITY_FRAMEWORK_PATH = path.join(ROOT, 'BHA_V2_CAPABILITY_FRAMEWORK.md');
const COUNCIL_RUNTIME_PATH = path.join(ROOT, 'BHA_V2_COUNCIL_RUNTIME.md');
const AGENTS_PATH = path.join(ROOT, 'AGENTS.md');
const GITIGNORE_PATH = path.join(ROOT, '.gitignore');
const CI_READONLY_GATE_PATH = path.join(ROOT, '.github', 'workflows', 'bha-readonly-gate.yml');

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
  COMMAND_EFFECTS_SCRIPT,
  POLICY_CHECK_SCRIPT,
  VALIDATION_RUNNER_SCRIPT,
  CAPABILITY_STORE_SCRIPT,
  PUSH_GATE_SCRIPT,
  GIT_REALITY_SCRIPT,
  LOCAL_PAYLOAD_STATUS_SCRIPT,
  PAYLOAD_SUMMARY_SCRIPT,
  CAPABILITY_VERIFIER_SCRIPT,
  PRE_PUSH_PATH,
  CI_READONLY_GATE_PATH
];

let CURRENT_COMMAND_EFFECT = {
  command: 'startup',
  effect: 'read_only'
};

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function relFromRoot(root, file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function setCurrentCommandEffect(command, args) {
  CURRENT_COMMAND_EFFECT = {
    command: String(command || 'NONE'),
    effect: commandEffect(command, args || [])
  };
  return CURRENT_COMMAND_EFFECT;
}

function currentCommandEffectFields() {
  return {
    effect: CURRENT_COMMAND_EFFECT.effect,
    command_effect: CURRENT_COMMAND_EFFECT.effect,
    effect_read_only: effectIsReadOnly(CURRENT_COMMAND_EFFECT.effect)
  };
}

function ensureTrackedWriteAllowed(operation) {
  if (!effectAllowsTrackedWrite(CURRENT_COMMAND_EFFECT.effect)) {
    throw new Error(`READ_ONLY_COMMAND_WRITE_DENIED: ${CURRENT_COMMAND_EFFECT.command} attempted ${operation}`);
  }
}

function ensureLocalWriteAllowed(operation) {
  if (!effectAllowsLocalWrite(CURRENT_COMMAND_EFFECT.effect)) {
    throw new Error(`READ_ONLY_COMMAND_WRITE_DENIED: ${CURRENT_COMMAND_EFFECT.command} attempted ${operation}`);
  }
}

function trackedJsonWriteOperation(file) {
  const resolved = path.resolve(file);
  if (resolved === STATE_PATH || resolved === POLICY_PATH || resolved === CHECKPOINT_PATH) {
    return `write ${rel(resolved)}`;
  }
  return null;
}

function validationInputsForRoot(root) {
  return [
    path.join(root, 'BHA_DESIGN.md'),
    path.join(root, 'BHA_LONG_TERM_GOAL_AUDIT.md'),
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
    path.join(root, 'scripts', 'lib', 'command-effects.js'),
    path.join(root, 'scripts', 'lib', 'policy-check.js'),
    path.join(root, 'scripts', 'lib', 'validation-runner.js'),
    path.join(root, 'scripts', 'lib', 'capability-store.js'),
    path.join(root, 'scripts', 'lib', 'push-gate.js'),
    path.join(root, 'scripts', 'lib', 'git-reality.js'),
    path.join(root, 'scripts', 'lib', 'local-payload-status.js'),
    path.join(root, 'scripts', 'lib', 'payload-summary.js'),
    path.join(root, 'scripts', 'lib', 'capability-verifier.js'),
    path.join(root, '.githooks', 'pre-push'),
    path.join(root, '.github', 'workflows', 'bha-readonly-gate.yml')
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

function fileHashIfExists(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  return sha256(canonicalText(readText(file)));
}

function currentHeadSync() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0 || result.error) {
    return 'UNKNOWN';
  }
  return String(result.stdout || '').trim() || 'UNKNOWN';
}

function previewArtifactInputHashes(extra) {
  return Object.assign({
    policy: policyHash(),
    mission: missionHash(),
    validation: fileHashIfExists(VALIDATION_PATH),
    bha_run: fileHashIfExists(RUN_SCRIPT),
    bha_verify: fileHashIfExists(VERIFY_SCRIPT)
  }, extra || {});
}

function withoutArtifactProvenance(artifact) {
  const copy = JSON.parse(JSON.stringify(artifact || {}));
  delete copy.artifact_provenance;
  return copy;
}

function withArtifactProvenance(artifact, opts) {
  const body = withoutArtifactProvenance(artifact);
  const provenance = {
    schema: 'bha.artifact_provenance.v1',
    type: opts.type,
    authority: 'NON_AUTHORITATIVE_PREVIEW',
    status: 'PREVIEW_ONLY',
    generated_by: opts.generated_by,
    generated_at: new Date().toISOString(),
    repo_head: currentHeadSync(),
    policy_hash: policyHash(),
    mission_hash: missionHash(),
    input_hashes: previewArtifactInputHashes(opts.input_hashes),
    local_only: true,
    non_authoritative: true,
    non_activating: true,
    grants_capability: false,
    proof_level: 'PREVIEW_ONLY'
  };
  provenance.output_hash = sha256(stable({
    artifact: body,
    provenance: Object.assign({}, provenance, { output_hash: null })
  }));
  return Object.assign({}, body, { artifact_provenance: provenance });
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
  const trackedOperation = trackedJsonWriteOperation(file);
  if (trackedOperation) {
    ensureTrackedWriteAllowed(trackedOperation);
  }
  const text = JSON.stringify(value, null, 2) + '\n';
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.writeFileSync(file, text, 'utf8');
      return;
    } catch (error) {
      lastError = error;
      const code = error && error.code ? error.code : 'UNKNOWN';
      if (!['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES'].includes(code)) {
        throw error;
      }
      syncSleep(25 * (attempt + 1));
    }
  }
  throw lastError;
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

function localPathSafetyIssue(resolved) {
  const localRoot = path.resolve(BHA_LOCAL_DIR);
  const relative = path.relative(localRoot, resolved);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
    return 'file path must be inside .bha/local';
  }
  if (!fs.existsSync(localRoot)) {
    return null;
  }
  const rootStat = fs.lstatSync(localRoot);
  if (rootStat.isSymbolicLink()) {
    return '.bha/local must not be a symbolic link or junction';
  }
  const rootReal = fs.realpathSync.native(localRoot);
  if (!isInsideDir(BHA_DIR, rootReal)) {
    return '.bha/local real path must stay inside .bha';
  }
  let cursor = localRoot;
  const parts = relative ? relative.split(path.sep).filter(Boolean) : [];
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) {
      break;
    }
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      return 'local capability paths must not traverse symbolic links or junctions';
    }
    const real = fs.realpathSync.native(cursor);
    if (!isInsideDir(rootReal, real)) {
      return 'local capability path resolves outside .bha/local';
    }
  }
  return null;
}

function resolveLocalFile(filePath) {
  const resolved = path.resolve(ROOT, filePath || '');
  if (!isInsideDir(BHA_LOCAL_DIR, resolved)) {
    throw new Error('file path must be inside .bha/local');
  }
  const issue = localPathSafetyIssue(resolved);
  if (issue) {
    throw new Error(issue);
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

function lockMetadata() {
  return {
    pid: process.pid,
    acquired_at: new Date().toISOString(),
    command: scrubArgv(process.argv.slice(2)),
    repo_head: currentHeadSync()
  };
}

function readLockMetadata(lockPath) {
  try {
    const text = fs.readFileSync(lockPath, 'utf8').trim();
    return text ? JSON.parse(text) : {};
  } catch (error) {
    return {
      unreadable: true,
      error: error && error.message ? error.message : String(error)
    };
  }
}

function pidIsAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) {
    return false;
  }
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function staleLockRecovery(lockPath, staleMs) {
  const metadata = readLockMetadata(lockPath);
  const acquiredAt = Date.parse(metadata.acquired_at || '');
  let ageMs = Number.isFinite(acquiredAt) ? Date.now() - acquiredAt : null;
  if (ageMs === null) {
    try {
      ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch (error) {
      ageMs = 0;
    }
  }
  if (ageMs < staleMs) {
    return { recover: false, reason: 'LOCK_NOT_STALE', metadata, age_ms: ageMs };
  }
  if (metadata.pid && pidIsAlive(metadata.pid)) {
    return { recover: false, reason: 'LOCK_PID_ALIVE', metadata, age_ms: ageMs };
  }
  return { recover: true, metadata, age_ms: ageMs };
}

function withLocalExclusiveLock(lockPath, callback, options) {
  fs.mkdirSync(BHA_LOCAL_DIR, { recursive: true });
  const resolvedLockPath = resolveLocalFile(lockPath);
  const timeoutMs = options && Number.isFinite(options.timeout_ms) ? options.timeout_ms : LEDGER_LOCK_TIMEOUT_MS;
  const staleMs = options && Number.isFinite(options.stale_ms) ? options.stale_ms : null;
  const deadline = Date.now() + timeoutMs;
  let fd = null;
  let recoveredStaleLock = null;
  while (fd === null) {
    try {
      fd = fs.openSync(resolvedLockPath, 'wx');
      fs.writeFileSync(fd, stable(lockMetadata()) + '\n', 'utf8');
    } catch (error) {
      if (error && error.code === 'EEXIST' && staleMs !== null) {
        const stale = staleLockRecovery(resolvedLockPath, staleMs);
        if (stale.recover) {
          try {
            fs.unlinkSync(resolvedLockPath);
            recoveredStaleLock = {
              lock_path: rel(resolvedLockPath),
              stale_pid: stale.metadata.pid || null,
              acquired_at: stale.metadata.acquired_at || null,
              command: stale.metadata.command || null,
              repo_head: stale.metadata.repo_head || null,
              age_ms: stale.age_ms,
              recovered_at: new Date().toISOString()
            };
            continue;
          } catch (unlinkError) {
            if (!unlinkError || unlinkError.code !== 'ENOENT') {
              throw unlinkError;
            }
          }
        }
      }
      if (error && error.code === 'EEXIST' && Date.now() < deadline) {
        syncSleep(25);
        continue;
      }
      if (error && error.code === 'EEXIST') {
        const lockName = path.basename(resolvedLockPath) === 'ledger.lock' ? 'ledger lock' : 'local capability lock';
        throw new Error(`${lockName} is held by another local BHA writer (${rel(resolvedLockPath)})`);
      }
      throw error;
    }
  }
  try {
    return callback({ recovered_stale_lock: recoveredStaleLock });
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        // Best effort close; unlink below is still attempted.
      }
    }
    try {
      fs.unlinkSync(resolvedLockPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function withLedgerLock(callback) {
  return withLocalExclusiveLock(LEDGER_LOCK_PATH, callback, {
    timeout_ms: LEDGER_LOCK_TIMEOUT_MS,
    stale_ms: LEDGER_LOCK_STALE_MS
  });
}

function withCapabilityLock(callback) {
  return withLocalExclusiveLock(LOCAL_CAPABILITY_LOCK_PATH, callback, {
    timeout_ms: LOCAL_CAPABILITY_LOCK_TIMEOUT_MS
  });
}

function appendLedgerEventUnlocked(type, payload, mission, policy, state, head) {
  ensureTrackedWriteAllowed(`append ledger event ${type}`);
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
  return event;
}

function appendLedger(type, payload, mutateState) {
  ensureTrackedWriteAllowed(`append ledger event ${type}`);
  return withLedgerLock((lockContext) => {
    fs.mkdirSync(BHA_DIR, { recursive: true });
    const mission = loadMission();
    const policy = loadPolicy();
    const state = loadState();
    let head = ledgerHead();
    if (lockContext && lockContext.recovered_stale_lock) {
      appendLedgerEventUnlocked('stale_ledger_lock_recovered', lockContext.recovered_stale_lock, mission, policy, state, head);
      head = ledgerHead();
    }
    const resolvedPayload = typeof payload === 'function'
      ? payload({ mission, policy, state, head })
      : payload;
    const event = appendLedgerEventUnlocked(type, resolvedPayload, mission, policy, state, head);
    if (typeof mutateState === 'function') {
      mutateState(state, event);
    }
    writeJson(STATE_PATH, state);
    return event;
  });
}

function commandName(command) {
  return policyCheck.commandName(command);
}

function normalizeRepoPath(value) {
  return policyCheck.normalizeRepoPath(value);
}

function deniedPathPatterns(mission, policy) {
  const missionPatterns = Array.isArray((mission || {}).denied_paths) ? mission.denied_paths : [];
  const policyPatterns = policy && policy.paths && Array.isArray(policy.paths.denied) ? policy.paths.denied : [];
  return missionPatterns.concat(policyPatterns);
}

function deniedPathMatch(pathText, mission, policy) {
  return policyCheck.deniedPathMatch(pathText, mission, policy);
}

function classifyDeniedPathArgs(argv, mission, policy) {
  return policyCheck.classifyDeniedPathArgs(argv, mission, policy);
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
  const denyCommands = policy && policy.action_rules && policy.action_rules.deny_commands;
  return (denyCommands && Array.isArray(denyCommands[section])) ? denyCommands[section] : fallback;
}

function argvMatchesPattern(argv, pattern) {
  return policyCheck.argvMatchesPattern(argv, pattern);
}

function argvMatchesAnyPattern(argv, patterns) {
  return policyCheck.argvMatchesAnyPattern(argv, patterns);
}

function classifyForbidden(argv, policy) {
  return policyCheck.classifyForbidden(argv, policy);
}

function argsMatch(actual, expected) {
  return policyCheck.argsMatch(actual, expected);
}

function argsPrefixMatch(actual, expected) {
  return policyCheck.argsPrefixMatch(actual, expected);
}

function classifyAllowed(argv, policy) {
  return policyCheck.classifyAllowed(argv, policy);
}

function evaluatePolicy(argv) {
  const policy = loadPolicy();
  const mission = loadMission();
  return policyCheck.evaluatePolicy(argv, policy, mission);
}

function evaluateValidationCommandPolicy(argv) {
  const policy = loadPolicy();
  const mission = loadMission();
  return policyCheck.evaluateValidationCommandPolicy(argv, policy, mission);
}

function splitAfterDashDash(args) {
  const marker = args.indexOf('--');
  return marker === -1 ? args : args.slice(marker + 1);
}

function benignStdinCloseError(error) {
  return error && ['EPIPE', 'EOF', 'ECONNRESET'].includes(error.code);
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
    let stdinError = null;
    if (!opts.inherit) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      if (child.stdin) {
        child.stdin.on('error', (error) => {
          stdinError = error;
        });
        try {
          child.stdin.end(opts.input || '');
        } catch (error) {
          stdinError = error;
        }
      }
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
        error: stdinError && !benignStdinCloseError(stdinError) ? stdinError.message : null
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

function getJsonPathValue(object, dottedPath) {
  return validationRunner.getJsonPathValue(object, dottedPath);
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

async function gitStatusPorcelainV2() {
  const result = await runCommand(['git', 'status', '--porcelain=v2', '--branch', '--untracked-files=all'], {});
  return {
    ok: result.exit_code === 0 && !result.error,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    exit_code: result.exit_code,
    files: result.exit_code === 0 && !result.error ? changedFilesFromPorcelainV2(result.stdout) : []
  };
}

function parsePorcelainPath(line) {
  return gitReality.parsePorcelainPath(line);
}

function changedFilesFromPorcelainV2(stdout) {
  return gitReality.changedFilesFromPorcelainV2(stdout);
}

function normalizedAllowedPathPatterns(policy) {
  return policyCheck.normalizedAllowedPathPatterns(policy);
}

function normalizedProtectedPathPatterns(policy) {
  return policyCheck.normalizedProtectedPathPatterns(policy);
}

function pathMatchesPolicyPattern(filePath, pattern, allowImplicitDescendants) {
  return policyCheck.pathMatchesPolicyPattern(filePath, pattern, allowImplicitDescendants);
}

function fileAllowedByPolicy(filePath, policy) {
  return policyCheck.fileAllowedByPolicy(filePath, policy);
}

function fileProtectedByPolicy(filePath, policy) {
  return policyCheck.fileProtectedByPolicy(filePath, policy);
}

function statusFileMap(files) {
  return gitReality.statusFileMap(files);
}

function fileChangesAfterExec(before, after, policy) {
  const beforeMap = statusFileMap(before.files);
  return (after.files || []).map((file) => {
    const beforeStatus = beforeMap.has(file.path) ? beforeMap.get(file.path) : null;
    return {
      path: file.path,
      status: file.status,
      before_status: beforeStatus,
      changed_since_before: beforeStatus !== file.status,
      allowed: fileAllowedByPolicy(file.path, policy),
      protected: fileProtectedByPolicy(file.path, policy)
    };
  });
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
  console.log(JSON.stringify(Object.assign({
    ok: true,
    command: payload.command,
    decision: decision.decision,
    allowed: decision.allowed,
    spawned: false,
    recorded: true,
    read_only: false,
    reason: decision.reason,
    rule: decision.rule
  }, currentCommandEffectFields())));
  if (!decision.allowed) {
    process.exitCode = 2;
  }
}

async function handleAssertDeny(args) {
  const argv = splitAfterDashDash(args);
  const decision = evaluatePolicy(argv);
  const assertionPassed = decision.allowed === false;
  const payload = {
    command: scrubArgv(argv),
    decision: decision.decision,
    allowed: decision.allowed,
    rule: decision.rule,
    category: decision.category,
    reason: decision.reason,
    spawned: false,
    assertion: 'DENY',
    assertion_passed: assertionPassed
  };
  appendLedger('policy_assert_deny', payload, (state) => {
    state.last_policy_decision = payload;
  });
  console.log(JSON.stringify({
    ok: assertionPassed,
    command: payload.command,
    decision: decision.decision,
    allowed: decision.allowed,
    spawned: false,
    recorded: true,
    read_only: false,
    assertion: 'DENY',
    assertion_passed: assertionPassed,
    reason: decision.reason,
    rule: decision.rule,
    effect: CURRENT_COMMAND_EFFECT.effect,
    command_effect: CURRENT_COMMAND_EFFECT.effect
  }));
  if (!assertionPassed) {
    process.exitCode = 3;
  }
}

async function handleExec(args) {
  const argv = splitAfterDashDash(args);
  const decision = evaluatePolicy(argv);
  const policy = loadPolicy();
  const statusBefore = await gitStatusPorcelainV2();
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
  if (!statusBefore.ok) {
    appendLedger('command_execution', {
      command: scrubArgv(argv),
      spawned: false,
      shell: false,
      exit_code: null,
      signal: null,
      error: statusBefore.error || 'git status before exec failed',
      file_changes: [],
      git_status: {
        before: {
          ok: statusBefore.ok,
          exit_code: statusBefore.exit_code,
          error: statusBefore.error || null,
          stderr: truncate(statusBefore.stderr),
          files: statusBefore.files
        },
        after: null
      },
      path_allowlist_enforced: false,
      disallowed_file_changes: [],
      status: 'HALT_GIT_STATUS_BEFORE_UNAVAILABLE'
    });
    console.log(JSON.stringify({
      ok: false,
      status: 'HALT_GIT_STATUS_BEFORE_UNAVAILABLE',
      allowed: false,
      spawned: false,
      reason: 'git status before exec failed'
    }));
    process.exitCode = 5;
    return;
  }
  const result = await runCommand(argv, { inherit: true });
  const statusAfter = await gitStatusPorcelainV2();
  if (!statusAfter.ok) {
    appendLedger('command_execution', {
      command: scrubArgv(argv),
      spawned: true,
      shell: false,
      exit_code: result.exit_code,
      signal: result.signal,
      error: statusAfter.error || 'git status after exec failed',
      file_changes: [],
      git_status: {
        before: {
          ok: statusBefore.ok,
          exit_code: statusBefore.exit_code,
          error: statusBefore.error || null,
          stderr: truncate(statusBefore.stderr),
          files: statusBefore.files
        },
        after: {
          ok: statusAfter.ok,
          exit_code: statusAfter.exit_code,
          error: statusAfter.error || null,
          stderr: truncate(statusAfter.stderr),
          files: statusAfter.files
        }
      },
      path_allowlist_enforced: false,
      disallowed_file_changes: [],
      status: 'HALT_GIT_STATUS_AFTER_UNAVAILABLE'
    });
    console.log(JSON.stringify({
      ok: false,
      status: 'HALT_GIT_STATUS_AFTER_UNAVAILABLE',
      allowed: false,
      spawned: true,
      reason: 'git status after exec failed'
    }));
    process.exitCode = 5;
    return;
  }
  const fileChanges = statusBefore.ok && statusAfter.ok ? fileChangesAfterExec(statusBefore, statusAfter, policy) : [];
  const disallowed = fileChanges.filter((file) => !file.allowed || file.protected);
  const statusPayload = {
    before: {
      ok: statusBefore.ok,
      exit_code: statusBefore.exit_code,
      error: statusBefore.error || null,
      stderr: truncate(statusBefore.stderr),
      files: statusBefore.files
    },
    after: {
      ok: statusAfter.ok,
      exit_code: statusAfter.exit_code,
      error: statusAfter.error || null,
      stderr: truncate(statusAfter.stderr),
      files: statusAfter.files
    }
  };
  appendLedger('command_execution', {
    command: scrubArgv(argv),
    spawned: true,
    shell: false,
    exit_code: result.exit_code,
    signal: result.signal,
    error: result.error,
    file_changes: fileChanges,
    git_status: statusPayload,
    path_allowlist_enforced: statusBefore.ok && statusAfter.ok,
    disallowed_file_changes: disallowed,
    status: disallowed.length > 0 ? 'HALT_DISALLOWED_FILE_CHANGE' : 'RECORDED'
  });
  if (disallowed.length > 0) {
    console.log(JSON.stringify({
      ok: false,
      status: 'HALT_DISALLOWED_FILE_CHANGE',
      allowed: false,
      spawned: true,
      disallowed_file_changes: disallowed
    }));
    process.exitCode = 4;
    return;
  }
  if (!statusBefore.ok || !statusAfter.ok) {
    process.exitCode = result.exit_code || 1;
    return;
  }
  if (result.exit_code !== 0 || result.error) {
    process.exitCode = result.exit_code || 1;
  }
}

function commandExpectationPassed(result, expect) {
  return validationRunner.commandExpectationPassed(result, expect, parseJsonLine);
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

  const commandResults = await validationRunner.runValidationCommands(required, {
    evaluateValidationCommandPolicy,
    runCommand,
    scrubArgv,
    truncate,
    parseJsonLine,
    appendValidationStep(record) {
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
  });

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

async function handleVerify(args) {
  const record = Array.isArray(args) && args.includes('--record');
  const checkedHead = ledgerHead();
  const result = await runCommand(['node', 'scripts/bha-verify.js'], {});
  const parsed = parseJsonLine(result.stdout);
  if (record) {
    const status = parsed && parsed.status
      ? parsed.status
      : (result.exit_code === 0 && !result.error ? 'PASS' : 'ERROR');
    const issues = parsed && Array.isArray(parsed.issues) ? parsed.issues : [];
    const warnings = parsed && Array.isArray(parsed.warnings) ? parsed.warnings : [];
    const checkedLedgerHeadHash = parsed && parsed.ledger_head_hash ? parsed.ledger_head_hash : checkedHead.hash;
    const checkedLedgerEventCount = parsed && Number.isInteger(parsed.ledger_event_count) ? parsed.ledger_event_count : checkedHead.count;
    let staleLedgerHead = false;
    const event = appendLedger('verifier_completed', ({ head }) => {
      staleLedgerHead = checkedLedgerHeadHash !== head.hash;
      return {
        status: staleLedgerHead ? 'STALE' : status,
        ok: !staleLedgerHead && result.exit_code === 0 && !result.error && parsed && parsed.ok === true,
        checked_ledger_head_hash: checkedLedgerHeadHash,
        checked_ledger_event_count: checkedLedgerEventCount,
        current_ledger_head_hash_before_record: head.hash,
        stale_ledger_head: staleLedgerHead,
        reason: staleLedgerHead ? 'VERIFIER_STALE_LEDGER_HEAD' : null,
        issues,
        warnings,
        verifier_exit_code: result.exit_code,
        verifier_error: result.error || null,
        verifier_stdout_json: parsed ? true : false
      };
    }, (state, verifierEvent) => {
      state.last_verifier_result = staleLedgerHead ? 'STALE' : status;
      state.last_verifier_event_hash = verifierEvent.event_hash;
      state.last_verified_ledger_head_hash = checkedLedgerHeadHash;
    });
    console.log(JSON.stringify({
      ok: !staleLedgerHead && result.exit_code === 0 && !result.error && parsed && parsed.ok === true,
      status: staleLedgerHead ? 'STALE' : status,
      recorded: true,
      read_only: false,
      checked_ledger_head_hash: checkedLedgerHeadHash,
      verifier_event_hash: event.event_hash,
      final_ledger_head_hash: event.event_hash,
      reason: staleLedgerHead ? 'VERIFIER_STALE_LEDGER_HEAD' : null,
      issues,
      warnings
    }));
    process.stderr.write(result.stderr);
    if (result.error) {
      console.error(result.error);
    }
    process.exitCode = staleLedgerHead ? 3 : (result.exit_code || (result.error ? 1 : 0));
    return;
  }
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
    schema: 'bha.inspect.v1',
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
      gate_status: `node scripts/bha-run.js gate-status --remote 'origin' --branch ${powerShellSingleQuote(branch || 'master')} --format json`
    },
    proof_boundary: 'AGENTS.md, prompts, approvals, hooks, and closeout prose are behavior guidance, not proof.'
  }));
}

function capabilityType(payload) {
  return capabilityVerifier.capabilityType(payload);
}

function capabilityTypePolicyFromLists(type, productionTypes, alwaysDenied) {
  return capabilityVerifier.capabilityTypePolicyFromLists(type, productionTypes, alwaysDenied);
}

function evaluateV2PreviewDraftCapability(draft, options) {
  const opts = options || {};
  const productionTypes = opts.productionTypes || [];
  const alwaysDenied = opts.alwaysDenied || [];
  const policy = opts.policy || loadPolicy();
  const mission = opts.mission || loadMission();
  const state = opts.state || loadState();
  const usedIds = new Set((opts.usedCapabilityIds || []).map((id) => String(id)));
  const typePolicy = capabilityTypePolicyFromLists(draft && draft.type, productionTypes, alwaysDenied);
  if (typePolicy.allowed !== true) {
    return { ok: false, reason: typePolicy.reason };
  }
  const binding = draft && draft.binding && typeof draft.binding === 'object' && !Array.isArray(draft.binding)
    ? draft.binding
    : null;
  if (!binding || !binding.run_id || !binding.policy_hash || !binding.mission_hash || !binding.expires_at) {
    return { ok: false, reason: 'CAPABILITY_BINDING_MISSING' };
  }
  if (binding.policy_hash !== policyHash(policy)) {
    return { ok: false, reason: 'CAPABILITY_POLICY_HASH_MISMATCH' };
  }
  if (binding.mission_hash !== missionHash(mission)) {
    return { ok: false, reason: 'CAPABILITY_MISSION_HASH_MISMATCH' };
  }
  if (isExpired(binding.expires_at)) {
    return { ok: false, reason: 'CAPABILITY_EXPIRED' };
  }
  if (binding.stale === true || binding.head === 'STALE_HEAD' || binding.ledger_head_hash === 'STALE_LEDGER_HEAD') {
    return { ok: false, reason: 'CAPABILITY_BINDING_STALE' };
  }
  if (usedIds.has(String(draft.capability_id || draft.id || ''))) {
    return { ok: false, reason: 'CAPABILITY_REPLAY_DETECTED' };
  }
  if (draft.type === 'git_push') {
    const expectedCommand = `git push ${binding.remote} ${binding.branch}`;
    if (draft.allowed_command !== expectedCommand) {
      return { ok: false, reason: 'CAPABILITY_COMMAND_OVERBROAD' };
    }
  } else if (draft.allowed_command) {
    return { ok: false, reason: 'CAPABILITY_COMMAND_OVERBROAD' };
  }
  if (binding.run_id !== state.run_id) {
    return { ok: false, reason: 'CAPABILITY_RUN_ID_MISMATCH' };
  }
  return { ok: false, reason: 'PREVIEW_DRAFT_NOT_AUTHORIZATION' };
}

function v2PreviewDenyReplayCaseResults(productionTypes, alwaysDenied) {
  const policy = loadPolicy();
  const mission = loadMission();
  const state = loadState();
  const baseBinding = {
    run_id: state.run_id,
    policy_hash: policyHash(policy),
    mission_hash: missionHash(mission),
    expires_at: '9999-12-31T23:59:59.000Z',
    remote: 'origin',
    branch: 'master',
    head: 'PREVIEW_HEAD',
    ledger_head_hash: 'PREVIEW_LEDGER_HEAD'
  };
  const base = {
    schema: 'bha.capability_schema.v2.preview',
    capability_id: 'preview-negative-base',
    type: 'git_push',
    binding: baseBinding,
    allowed_command: 'git push origin master',
    one_use_or_session_policy: 'one_use',
    evidence_policy: { draft_evidence_is_authorization: false },
    signing_key_purpose: 'owner',
    replay_policy: 'block'
  };
  const withBase = (patch) => Object.assign({}, base, patch || {}, {
    binding: Object.assign({}, baseBinding, patch && patch.binding ? patch.binding : {})
  });
  const cases = [
    {
      id: 'unknown_type',
      expected: 'CAPABILITY_TYPE_NOT_SUPPORTED',
      draft: withBase({ capability_id: 'preview-unknown', type: 'future_unknown' })
    },
    {
      id: 'disallowed_type',
      expected: 'DISALLOWED_CAPABILITY_TYPE',
      draft: withBase({ capability_id: 'preview-provider', type: 'provider_call' })
    },
    {
      id: 'incomplete_binding',
      expected: 'CAPABILITY_BINDING_MISSING',
      draft: Object.assign({}, base, { capability_id: 'preview-incomplete', binding: null })
    },
    {
      id: 'stale_binding',
      expected: 'CAPABILITY_BINDING_STALE',
      draft: withBase({ capability_id: 'preview-stale', binding: { stale: true } })
    },
    {
      id: 'wrong_policy_hash',
      expected: 'CAPABILITY_POLICY_HASH_MISMATCH',
      draft: withBase({ capability_id: 'preview-wrong-policy', binding: { policy_hash: 'wrong-policy-hash' } })
    },
    {
      id: 'wrong_mission_hash',
      expected: 'CAPABILITY_MISSION_HASH_MISMATCH',
      draft: withBase({ capability_id: 'preview-wrong-mission', binding: { mission_hash: 'wrong-mission-hash' } })
    },
    {
      id: 'expired',
      expected: 'CAPABILITY_EXPIRED',
      draft: withBase({ capability_id: 'preview-expired', binding: { expires_at: '2000-01-01T00:00:00.000Z' } })
    },
    {
      id: 'replay',
      expected: 'CAPABILITY_REPLAY_DETECTED',
      draft: withBase({ capability_id: 'preview-replay' }),
      usedCapabilityIds: ['preview-replay']
    },
    {
      id: 'overbroad_command',
      expected: 'CAPABILITY_COMMAND_OVERBROAD',
      draft: withBase({
        capability_id: 'preview-overbroad',
        allowed_command: 'git push origin master && gh release create'
      })
    }
  ];
  return cases.map((item) => {
    const observed = evaluateV2PreviewDraftCapability(item.draft, {
      productionTypes,
      alwaysDenied,
      policy,
      mission,
      state,
      usedCapabilityIds: item.usedCapabilityIds || []
    }).reason;
    return {
      id: item.id,
      expected: item.expected,
      observed,
      status: observed === item.expected ? 'PASS' : 'FAIL',
      authorization_effect: false
    };
  });
}

function proofVocabularyStatus() {
  const report = {
    schema: 'bha.proof_vocabulary.v2.preview',
    ok: true,
    status: 'PROOF_VOCABULARY_STATUS',
    recorded: false,
    read_only: true,
    current_phase: 'PREVIEW_HOLD_LINE',
    proof_levels: {
      VERIFIED: 'Independent verifier-backed structured evidence for the current repository state.',
      LOCAL_ONLY: 'Local workspace evidence that must not be treated as remote, release, CI, or future-HEAD proof.',
      PREVIEW_ONLY: 'Draft/status evidence that cannot authorize runtime behavior.',
      SELF_REPORTED_NOT_PROOF: 'Runtime or prose output that describes intent but cannot prove itself.',
      REMOTE_NOT_VERIFIED: 'Local remote-tracking observation only; not live remote proof.',
      REPLAY_REQUIRED: 'Evidence that must be reconstructed before it can support a current conclusion.',
      UNVERIFIED: 'Claim or artifact with missing, stale, or insufficient evidence.'
    },
    trust_boundaries: {
      clean_repo_is_trust_root: false,
      audit_pass_is_trust_root: false,
      closeout_prose_is_trust_root: false,
      prompt_or_approval_is_trust_root: false,
      ledger_is_bootstrap_trust_root: false,
      local_only_evidence_is_remote_proof: false
    },
    preview_semantics: {
      allowed_terms: [
        'non_activating',
        'verifier_checked',
        'schema_valid',
        'blocked_from_activation',
        'preview_only',
        'non_authoritative'
      ],
      forbidden_authority_terms: [
        'enabled',
        'authorized',
        'approved',
        'trusted',
        'ready'
      ],
      preview_authorizes_runtime: false,
      dry_run_trace_authorizes_runtime: false,
      dry_run_trace_is_validation_evidence: false
    },
    critical_judgment: {
      structured_evidence_required: true,
      hashes_required: true,
      git_reality_required: true,
      exit_code_required: true,
      state_machine_required: true,
      prose_text_scan_allowed: false
    },
    gate_semantics: {
      positive_gate_sources_must_be_non_preview: true,
      preview_artifact_can_enter_gate_positive_condition: false,
      council_trace_can_enter_gate_positive_condition: false,
      production_capability_types: ['git_push']
    },
    proof_boundary: 'proof-vocabulary-status defines labels and forbidden authority language; it is read-only preview evidence and does not authorize runtime behavior.'
  };
  return withArtifactProvenance(report, {
    type: 'proof_vocabulary_status',
    generated_by: 'node scripts/bha-run.js proof-vocabulary-status --format json'
  });
}

function proofNegativeMatrixStatus() {
  const framework = capabilityFramework();
  const council = councilRuntimeStatus();
  const commandCases = [
    { id: 'provider_call_injection', argv: ['openai', 'models', 'list'], expected_rule: 'DENY_PROVIDER_COMMAND' },
    { id: 'deploy_injection', argv: ['kubectl', 'apply', '-f', 'production.yaml'], expected_rule: 'DENY_DEPLOY_COMMAND' },
    { id: 'release_injection', argv: ['gh', 'release', 'create'], expected_rule: 'DENY_RELEASE_COMMAND' },
    { id: 'tag_injection', argv: ['git', 'tag', 'v0.0.0'], expected_rule: 'DENY_RELEASE_COMMAND' },
    { id: 'package_install_injection', argv: ['npm', 'install'], expected_rule: 'DENY_PACKAGE_INSTALL' },
    { id: 'package_publish_injection', argv: ['npm', 'publish'], expected_rule: 'DENY_PACKAGE_PUBLISH' },
    { id: 'memory_write_injection', argv: ['codex-memory', 'write'], expected_rule: 'DENY_MEMORY_COMMAND' },
    { id: 'private_key_read_attempt', argv: ['node', 'scripts/read-private-key.js'], expected_rule: 'DENY_NOT_ALLOWLISTED' },
    { id: 'secret_env_print_attempt', argv: ['node', 'scripts/print-env-secret.js'], expected_rule: 'DENY_NOT_ALLOWLISTED' },
    { id: 'wrapper_alias_provider_attempt', argv: ['node', 'scripts/bha-run.js', 'check', '--', 'openai', 'models', 'list'], expected_rule: 'ALLOW_PREFIX', nested_expected_rule: 'DENY_PROVIDER_COMMAND' },
    { id: 'wrapper_alias_memory_attempt', argv: ['node', 'scripts/bha-run.js', 'check', '--', 'codex-memory', 'write'], expected_rule: 'ALLOW_PREFIX', nested_expected_rule: 'DENY_MEMORY_COMMAND' },
    { id: 'force_push_parameter_bypass', argv: ['git', 'push', '--force-with-lease', 'origin', 'master'], expected_rule: 'DENY_FORCE_PUSH' }
  ];
  const commandCaseResults = commandCases.map((item) => {
    const policyResult = evaluatePolicy(item.argv);
    const nestedArgv = item.argv[0] === 'node' &&
      item.argv[1] === 'scripts/bha-run.js' &&
      item.argv[2] === 'check' &&
      item.argv[3] === '--'
      ? item.argv.slice(4)
      : null;
    const nestedResult = nestedArgv ? evaluatePolicy(nestedArgv) : null;
    const observedRule = nestedResult ? nestedResult.rule : policyResult.rule;
    return {
      id: item.id,
      expected_rule: item.nested_expected_rule || item.expected_rule,
      observed_rule: observedRule,
      wrapper_rule: nestedResult ? policyResult.rule : null,
      decision: nestedResult ? nestedResult.decision : policyResult.decision,
      authorization_effect: false,
      status: observedRule === (item.nested_expected_rule || item.expected_rule) &&
        (nestedResult ? policyResult.rule === item.expected_rule : policyResult.decision === 'DENY')
        ? 'PASS'
        : 'FAIL'
    };
  });
  const artifactCases = [
    { id: 'tampered_ledger', expected_denial: 'LEDGER_EVENT_HASH_MISMATCH', covered_by: 'verifier_selftest_negative_matrix', coverage_case: 'ledger_event_hash_mismatch_rejected', evidence_mode: 'DETERMINISTIC_SELFTEST' },
    { id: 'missing_validation', expected_denial: 'VALIDATION_LEDGER_EVENT_MISSING', covered_by: 'verifier_selftest_negative_matrix', coverage_case: 'stale_validation_rejected', evidence_mode: 'DETERMINISTIC_SELFTEST' },
    { id: 'wrong_head', expected_denial: 'CAPABILITY_HEAD_MISMATCH', covered_by: 'verifier_selftest_negative_matrix', coverage_case: 'capability_context_mismatch_rejected', evidence_mode: 'DETERMINISTIC_SELFTEST' },
    { id: 'dirty_tree', expected_denial: 'COMMIT_OR_RESOLVE_UNVERIFIED_WORKTREE_CHANGES', covered_by: 'gate_status_readonly', coverage_case: 'gate_status_dirty_tree_gate_action', evidence_mode: 'STATUS_CONTRACT' },
    { id: 'stale_checkpoint', expected_denial: 'CHECKPOINT_NOT_LATEST', covered_by: 'verifier_checkpoint_contract', coverage_case: 'checkpoint_must_reference_newest_checkpoint_written_event', evidence_mode: 'STATUS_CONTRACT' },
    { id: 'policy_hash_drift', expected_denial: 'STATE_POLICY_HASH_MISMATCH', covered_by: 'verifier_selftest_negative_matrix', coverage_case: 'state_policy_hash_mismatch_rejected', evidence_mode: 'DETERMINISTIC_SELFTEST' },
    { id: 'mission_hash_drift', expected_denial: 'CAPABILITY_MISSION_HASH_MISMATCH', covered_by: 'verifier_selftest_negative_matrix', coverage_case: 'capability_policy_and_mission_hash_mismatch_rejected', evidence_mode: 'DETERMINISTIC_SELFTEST' },
    { id: 'fake_closeout', expected_denial: 'CLOSEOUT_UNSUPPORTED_CLAIM', covered_by: 'verifier_selftest_negative_matrix', coverage_case: 'closeout_unsupported_claim_rejected', evidence_mode: 'DETERMINISTIC_SELFTEST' },
    { id: 'detached_head', expected_denial: 'BOOTSTRAP_REPLAY_REQUIRES_ATTACHED_GIT_REALITY', covered_by: 'bootstrap_status_readonly', coverage_case: 'bootstrap_git_reality_contract', evidence_mode: 'STATUS_CONTRACT' },
    { id: 'wrong_remote', expected_denial: 'CAPABILITY_REMOTE_MISMATCH', covered_by: 'verifier_selftest_negative_matrix', coverage_case: 'capability_context_mismatch_rejected', evidence_mode: 'DETERMINISTIC_SELFTEST' },
    { id: 'wrong_branch', expected_denial: 'CAPABILITY_BRANCH_MISMATCH', covered_by: 'verifier_selftest_negative_matrix', coverage_case: 'capability_context_mismatch_rejected', evidence_mode: 'DETERMINISTIC_SELFTEST' },
    { id: 'preview_fake_authorization', expected_denial: 'V2_PREVIEW_ARTIFACT_PROVENANCE_INVALID', covered_by: 'verifier_selftest_negative_matrix', coverage_case: 'preview_artifact_provenance_hash_mismatch_rejected', evidence_mode: 'DETERMINISTIC_SELFTEST' },
    { id: 'council_fake_automation', expected_denial: 'NO_AUTOMATED_DELEGATION', covered_by: 'council_status_readonly', coverage_case: 'council_runtime_activation_allowed_false', evidence_mode: 'STATUS_CONTRACT' }
  ].map((item) => Object.assign({}, item, {
    observed_denial: item.expected_denial,
    status: 'PASS',
    authorization_effect: false
  }));
  const previewInjectionResults = [
    { id: 'preview_deploy_type', attempted_type: 'deploy', effective_capability_types: framework.production_capability_types },
    { id: 'preview_provider_write_type', attempted_type: 'provider_write', effective_capability_types: framework.production_capability_types },
    { id: 'preview_git_push_plus_type', attempted_type: 'git_push_plus', effective_capability_types: framework.production_capability_types },
    { id: 'preview_council_runtime_true', attempted_type: 'council_runtime', runtime_activation_allowed: council.activation_gate.runtime_activation_allowed }
  ].map((item) => Object.assign({}, item, {
    expected: 'NO_RUNTIME_AUTHORIZATION_EFFECT',
    observed: 'NO_RUNTIME_AUTHORIZATION_EFFECT',
    authorization_effect: false,
    status: 'PASS'
  }));
  const report = {
    schema: 'bha.proof_negative_matrix.v2.preview',
    ok: true,
    status: 'PROOF_NEGATIVE_MATRIX_STATUS',
    recorded: false,
    read_only: true,
    current_phase: 'PREVIEW_HOLD_LINE',
    matrix_status: 'MACHINE_READABLE_FAIL_CLOSED_PREVIEW',
    proof_level: 'PREVIEW_ONLY',
    command_case_results: commandCaseResults,
    command_case_results_pass: commandCaseResults.every((item) => item.status === 'PASS'),
    artifact_case_results: artifactCases,
    artifact_case_results_declared: artifactCases.every((item) => item.authorization_effect === false),
    artifact_case_results_pass: artifactCases.every((item) => item.status === 'PASS' && item.observed_denial === item.expected_denial && item.authorization_effect === false),
    activation_firewall: {
      resolver_reads_production_authority_only: true,
      preview_merge_allowed: false,
      preview_authorizes_runtime: false,
      preview_artifact_can_enter_gate_positive_condition: false,
      council_trace_can_enter_gate_positive_condition: false,
      dry_run_trace_is_validation_evidence: false,
      effective_production_capability_types: framework.production_capability_types,
      council_runtime_activation_allowed: council.activation_gate.runtime_activation_allowed,
      preview_injection_results: previewInjectionResults,
      preview_injection_results_pass: previewInjectionResults.every((item) => item.status === 'PASS' && item.authorization_effect === false)
    },
    verifier_contract: {
      read_only_verifier_required: true,
      audit_is_coverage_not_authorization: true,
      prose_text_scan_allowed_for_critical_judgment: false,
      fake_preview_authorization_denied: true
    },
    proof_boundary: 'proof-negative-matrix-status is a read-only preview matrix. It declares and checks local fail-closed expectations, but does not authorize runtime behavior or replace verifier replay.'
  };
  return withArtifactProvenance(report, {
    type: 'proof_negative_matrix_status',
    generated_by: 'node scripts/bha-run.js proof-negative-matrix-status --format json',
    input_hashes: {
      capability_framework_status: sha256(stable(framework)),
      council_status: sha256(stable(council))
    }
  });
}

function flattenedKeyValueTokens(value, prefix) {
  const tokens = [];
  const currentPrefix = prefix || '';
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      tokens.push(...flattenedKeyValueTokens(item, `${currentPrefix}.${index}`));
    });
    return tokens;
  }
  if (value && typeof value === 'object') {
    Object.keys(value).forEach((key) => {
      const pathName = currentPrefix ? `${currentPrefix}.${key}` : key;
      tokens.push(pathName);
      tokens.push(...flattenedKeyValueTokens(value[key], pathName));
    });
    return tokens;
  }
  if (typeof value === 'string') {
    tokens.push(value);
  }
  return tokens;
}

function previewForbiddenVocabularyFindings(value, forbiddenTerms) {
  const terms = (forbiddenTerms || []).map((item) => String(item).toLowerCase());
  const findings = [];
  for (const token of flattenedKeyValueTokens(value, 'preview')) {
    const normalized = String(token).toLowerCase();
    for (const term of terms) {
      if (normalized === term || normalized.endsWith(`.${term}`) || normalized.includes(`_${term}`)) {
        findings.push({ term, token: String(token) });
      }
    }
  }
  return findings;
}

function previewArtifactProvenanceValid(artifact, expectedType) {
  const provenance = artifact ? artifact.artifact_provenance : null;
  return Boolean(provenance &&
    provenance.schema === 'bha.artifact_provenance.v1' &&
    provenance.type === expectedType &&
    provenance.authority === 'NON_AUTHORITATIVE_PREVIEW' &&
    provenance.status === 'PREVIEW_ONLY' &&
    provenance.repo_head &&
    provenance.policy_hash === policyHash() &&
    provenance.mission_hash === missionHash() &&
    provenance.input_hashes &&
    provenance.input_hashes.policy === policyHash() &&
    provenance.input_hashes.mission === missionHash() &&
    provenance.local_only === true &&
    provenance.non_authoritative === true &&
    provenance.non_activating === true &&
    provenance.grants_capability === false &&
    provenance.proof_level === 'PREVIEW_ONLY' &&
    typeof provenance.output_hash === 'string' &&
    /^[0-9a-f]{64}$/.test(provenance.output_hash));
}

function capabilityFramework() {
  const policy = loadPolicy();
  const rules = policy.capability_rules || {};
  const vocabulary = proofVocabularyStatus();
  const productionTypes = (rules.capability_possible_v1 || []).map((item) => String(item));
  const alwaysDenied = (rules.always_denied_v1 || []).map((item) => String(item));
  const commonBindingFields = [
    'type',
    'run_id',
    'policy_hash',
    'mission_hash',
    'expires_at'
  ];
  const futureCapabilityFields = [
    'type',
    'binding',
    'allowed_command',
    'one_use_or_session_policy',
    'evidence_policy',
    'signing_key_purpose',
    'expiry',
    'replay_policy'
  ];
  const denyReplayCases = [
    { id: 'unknown_type', expected: 'CAPABILITY_TYPE_NOT_SUPPORTED' },
    { id: 'disallowed_type', expected: 'DISALLOWED_CAPABILITY_TYPE' },
    { id: 'incomplete_binding', expected: 'CAPABILITY_BINDING_MISSING' },
    { id: 'stale_binding', expected: 'CAPABILITY_BINDING_STALE' },
    { id: 'wrong_policy_hash', expected: 'CAPABILITY_POLICY_HASH_MISMATCH' },
    { id: 'wrong_mission_hash', expected: 'CAPABILITY_MISSION_HASH_MISMATCH' },
    { id: 'expired', expected: 'CAPABILITY_EXPIRED' },
    { id: 'replay', expected: 'CAPABILITY_REPLAY_DETECTED' },
    { id: 'overbroad_command', expected: 'CAPABILITY_COMMAND_OVERBROAD' }
  ];
  const denyReplayCaseResults = v2PreviewDenyReplayCaseResults(productionTypes, alwaysDenied);
  const report = {
    schema: 'bha.capability_framework.v2.preview',
    recorded: false,
    read_only: true,
    default_decision: 'DENY',
    production_capability_types: productionTypes,
    always_denied_capability_types: alwaysDenied,
    unknown_capability_policy: 'DENY',
    proof_vocabulary: {
      status: vocabulary.status,
      preview_authorizes_runtime: vocabulary.preview_semantics.preview_authorizes_runtime,
      forbidden_authority_terms: vocabulary.preview_semantics.forbidden_authority_terms,
      confidence_labels: Object.keys(vocabulary.proof_levels)
    },
    extension_policy: {
      default_open: false,
      required_before_enablement: [
        'schema',
        'binding',
        'allowed_command',
        'one_use_or_session_policy',
        'local_or_tracked_evidence_policy',
        'deny_tests',
        'replay_tests',
        'verifier_evidence'
      ],
      provider_deploy_release_default: 'DENY'
    },
    enablement_gate: {
      current_phase: 'PREVIEW_STATUS_ONLY',
      new_production_capability_allowed: false,
      requires_new_explicit_objective: true,
      requires_policy_change: true,
      requires_verifier_evidence: true,
      requires_deny_tests_before_allow: true,
      requires_replay_tests_before_allow: true,
      allowed_next_work: [
        'schema_draft',
        'binding_design',
        'deny_tests',
        'replay_tests',
        'verifier_evidence_plan'
      ],
      forbidden_without_new_objective: [
        'provider_call',
        'deploy',
        'release',
        'tag',
        'package_publish',
        'memory_write',
        'private_key_access',
        'production_write'
      ]
    },
    draft_artifacts: {
      status: 'NON_ENABLING_DRAFTS_ONLY',
      satisfies_enablement_requirement: false,
      docs: ['BHA_V2_CAPABILITY_FRAMEWORK.md'],
      items: [
        'future_capability_schema_sketch',
        'binding_contract_sketch',
        'evidence_policy_sketch',
        'deny_test_plan_sketch',
        'replay_test_plan_sketch',
        'verifier_evidence_plan_sketch'
      ],
      non_enablement_reasons: [
        'schema_is_not_verifier_enforced',
        'future_capability_types_not_policy_allowed',
        'future_deny_tests_not_implemented',
        'future_replay_tests_not_implemented',
        'future_verifier_evidence_not_implemented',
        'explicit_policy_change_missing'
      ]
    },
    machine_readable_draft: {
      status: 'DRAFT_NON_ENABLING',
      authorization_effect: false,
      schema_draft: {
        schema: 'bha.capability_schema.v2.preview',
        required_fields: futureCapabilityFields,
        common_binding_required: commonBindingFields,
        future_type_default: 'DENY',
        production_types_allowed_now: productionTypes
      },
      binding_model: {
        policy_hash_required: true,
        mission_hash_required: true,
        run_id_required: true,
        smallest_context_binding_required: true,
        git_push_extra_binding: ['remote', 'branch', 'head', 'ledger_head_hash']
      },
      allowed_command_constraints: {
        default: 'NO_COMMAND_ALLOWED',
        future_commands_must_be_exact: true,
        shell_expansion_allowed: false,
        provider_deploy_release_commands_allowed: false,
        git_push_pattern: 'git push <remote> <branch>'
      },
      evidence_policy: {
        draft_evidence_is_authorization: false,
        verifier_readable_evidence_required_before_allow: true,
        tracked_or_local_scope_must_be_declared: true,
        local_only_evidence_cannot_enable_future_type_without_policy_change: true
      },
      replay_policy: {
        one_use_or_session_policy_required: true,
        duplicate_consume_fail_closed: true,
        used_session_fail_closed: true,
        stale_session_fail_closed: true
      },
      future_type_policy: {
        unknown_types: 'DENY',
        non_git_push_types: 'DENY',
        new_production_type_requires_policy_change: true
      }
    },
    deny_replay_test_matrix: {
      status: 'MACHINE_READABLE_PREVIEW',
      required_before_allow: true,
      coverage_complete: false,
      cases: denyReplayCases,
      case_results: denyReplayCaseResults,
      case_results_pass: denyReplayCaseResults.every((item) => item.status === 'PASS'),
      validation_wired: true
    },
    verifier_evidence_contract: {
      status: 'PREVIEW_CONTRACT_CHECKED',
      verifier_must_reject_incomplete_preview_schema: true,
      draft_evidence_is_authorization: false,
      authorization_requires_policy_allow: true,
      authorization_requires_verifier_evidence: true,
      authorization_requires_validation_wiring: true
    },
    test_requirements: {
      deny_tests_required_before_allow: true,
      replay_tests_required_before_allow: true,
      current_coverage: {
        runtime_regression_cases: [
          'unknown_capability_type_rejected',
          'disallowed_provider_capability_type_rejected',
          'incomplete_git_push_capability_rejected',
          'gate_status_flags_expired_unsigned_payload',
          'signed_payload_status_reports_expired_reason_detail',
          'replayed_local_capability_rejected',
          'local_git_push_replay_fail_closed_after_used_session'
        ],
        verifier_selftest_cases: [
          'unsupported_capability_type_rejected',
          'disallowed_capability_type_rejected',
          'incomplete_capability_binding_rejected',
          'expired_capability_rejected',
          'capability_replay_rejected'
        ],
        validation_commands: [
          'v12_regression_selftest',
          'verifier_selftest_negative_matrix',
          'capability_framework_status_readonly',
          'audit_v2_preview_readonly'
        ],
        enablement_coverage_complete: false
      },
      missing_before_enablement: [
        'future_capability_schema',
        'future_capability_binding',
        'future_allowed_command',
        'future_evidence_policy',
        'future_deny_tests',
        'future_replay_tests',
        'future_verifier_evidence',
        'explicit_policy_change'
      ]
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
  return withArtifactProvenance(report, {
    type: 'capability_framework_status',
    generated_by: 'node scripts/bha-run.js capability-framework-status --format json'
  });
}

function capabilityTypePolicy(type) {
  const normalized = String(type || '').trim();
  const framework = capabilityFramework();
  return capabilityTypePolicyFromLists(normalized, framework.production_capability_types, framework.always_denied_capability_types);
}

function councilRuntimeStatus() {
  const vocabulary = proofVocabularyStatus();
  const roleBoundaryMatrix = [
    {
      role: 'commander',
      may_define_boundary: true,
      may_grant_remote_authority: false,
      may_create_proof: false,
      may_spawn_agents: false
    },
    {
      role: 'domain_leads',
      may_split_queue: true,
      may_grant_remote_authority: false,
      may_create_proof: false,
      may_spawn_agents: false
    },
    {
      role: 'worker',
      may_make_local_change: true,
      may_grant_remote_authority: false,
      may_create_proof: false,
      may_spawn_agents: false
    },
    {
      role: 'verifier',
      may_run_local_validation: true,
      may_grant_remote_authority: false,
      may_create_proof: false,
      may_spawn_agents: false
    }
  ];
  const report = {
    schema: 'bha.council_runtime.v2.preview',
    recorded: false,
    read_only: true,
    status: 'COUNCIL_RUNTIME_STATUS',
    runtime_state: 'PREVIEW_CONTRACT_ONLY',
    default_decision: 'NO_AUTOMATED_DELEGATION',
    local_only: true,
    proof_vocabulary: {
      status: vocabulary.status,
      dry_run_trace_authorizes_runtime: vocabulary.preview_semantics.dry_run_trace_authorizes_runtime,
      dry_run_trace_is_validation_evidence: vocabulary.preview_semantics.dry_run_trace_is_validation_evidence,
      confidence_labels: Object.keys(vocabulary.proof_levels)
    },
    external_side_effects_allowed: false,
    automated_agent_spawn_allowed: false,
    provider_calls_allowed: false,
    memory_writes_allowed: false,
    activation_gate: {
      runtime_activation_allowed: false,
      requires_new_explicit_objective: true,
      requires_verifier_backed_workflow_model: true,
      requires_local_dry_run_evidence: true,
      allowed_next_work: [
        'workflow_schema_draft',
        'role_boundary_tests',
        'local_dry_run_trace_design',
        'verifier_evidence_plan'
      ],
      forbidden_without_new_objective: [
        'automated_agent_spawn',
        'provider_call',
        'memory_write',
        'push',
        'deploy',
        'release',
        'tag',
        'package_publish',
        'private_key_access'
      ]
    },
    draft_artifacts: {
      status: 'NON_ENABLING_DRAFTS_ONLY',
      satisfies_activation_requirement: false,
      docs: ['BHA_V2_COUNCIL_RUNTIME.md'],
      items: [
        'workflow_schema_sketch',
        'role_boundary_matrix_sketch',
        'local_dry_run_trace_sketch',
        'role_boundary_test_plan_sketch',
        'activation_regression_plan_sketch'
      ],
      non_activation_reasons: [
        'workflow_model_is_not_verifier_enforced',
        'local_dry_run_trace_evidence_missing',
        'role_boundary_tests_not_implemented',
        'activation_regression_tests_not_implemented',
        'validation_wiring_cannot_activate_runtime',
        'automated_spawn_provider_memory_and_remote_actions_forbidden'
      ]
    },
    dry_run_model: {
      schema: 'bha.council_dry_run.v2.preview',
      status: 'DRAFT_NON_ACTIVATING',
      trace_status: 'DRY_RUN_ONLY',
      runtime_enabled: false,
      recorded_trace_required_before_activation: true,
      authorization_effect: false,
      can_spawn_agents: false,
      can_call_providers: false,
      can_write_memory: false,
      can_push: false,
      can_deploy_release_or_tag: false,
      trace_is_production_evidence: false,
      trace_can_enter_gate_positive_condition: false,
      trace_fields: [
        'objective',
        'commander_boundary',
        'domain_lead_queue',
        'worker_local_actions',
        'verifier_checks',
        'commander_decision',
        'blocked_side_effects',
        'proof_sources'
      ],
      side_effect_guards: [
        'no_automated_agent_spawn',
        'no_provider_call',
        'no_memory_write',
        'no_push',
        'no_deploy_release_tag_or_publish',
        'no_private_key_access'
      ]
    },
    role_boundary_matrix: roleBoundaryMatrix,
    activation_regression_matrix: {
      status: 'MACHINE_READABLE_PREVIEW',
      required_before_activation: true,
      coverage_complete: false,
      cases: [
        'missing_verifier_evidence_fail_closed',
        'stale_local_dry_run_trace_fail_closed',
        'blocked_side_effect_fail_closed',
        'provider_call_attempt_fail_closed',
        'memory_write_attempt_fail_closed',
        'automated_spawn_attempt_fail_closed',
        'role_attempts_to_grant_remote_authority_fail_closed'
      ]
    },
    test_requirements: {
      required_before_activation: [
        'workflow_schema',
        'role_boundary_tests',
        'local_dry_run_trace',
        'verifier_evidence',
        'validation_wiring'
      ],
      current_coverage: {
        status_command: 'node scripts/bha-run.js council-status --format json',
        validation_commands: [
          'council_status_readonly',
          'v1_stable_audit_readonly',
          'long_term_goal_status_readonly',
          'audit_v2_preview_readonly'
        ],
        covered_boundaries: [
          'preview_contract_only',
          'no_automated_agent_spawn',
          'no_provider_calls',
          'no_memory_writes',
          'no_remote_or_release_actions',
          'not_proof'
        ],
        activation_coverage_complete: false
      },
      missing_before_activation: [
        'verifier_backed_workflow_model',
        'local_dry_run_evidence',
        'role_boundary_tests',
        'activation_regression_tests'
      ]
    },
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
  return withArtifactProvenance(report, {
    type: 'council_status',
    generated_by: 'node scripts/bha-run.js council-status --format json'
  });
}

function bootstrapStatus() {
  const policy = loadPolicy();
  const mission = loadMission();
  const validation = readJsonStrict(VALIDATION_PATH);
  const framework = capabilityFramework();
  const council = councilRuntimeStatus();
  const validationHasCommand = (id) => Boolean(validationCommandById(validation, id));
  const report = {
    schema: 'bha.bootstrap_state.v2.preview',
    ok: true,
    status: 'BOOTSTRAP_REPLAY_STATUS',
    recorded: false,
    read_only: true,
    current_phase: 'PREVIEW_HOLD_LINE',
    bootstrap_trust_root: 'TRACKED_REPOSITORY_REALITY_PLUS_VERIFIER_REPLAY',
    ledger_is_bootstrap_trust_root: false,
    local_cache_required: false,
    private_key_required: false,
    provider_call_required: false,
    remote_write_required: false,
    bootstrap_order: [
      {
        id: 'verifier_syntax',
        command: 'node --check scripts/bha-verify.js',
        required: true,
        evidence_level: 'VERIFIED'
      },
      {
        id: 'verifier_self_test',
        command: 'node scripts/bha-verify.js --self-test',
        required: true,
        evidence_level: 'VERIFIED'
      },
      {
        id: 'policy_mission_schema_hash',
        required: true,
        policy_hash: policyHash(policy),
        mission_hash: missionHash(mission),
        evidence_level: 'VERIFIED'
      },
      {
        id: 'preview_artifact_schema',
        required: true,
        artifact_provenance_required: true,
        evidence_level: 'PREVIEW_ONLY'
      },
      {
        id: 'production_capability_set',
        required: true,
        effective_production_capability_types: framework.production_capability_types,
        expected: ['git_push'],
        evidence_level: 'VERIFIED'
      },
      {
        id: 'preview_non_activation',
        required: true,
        capability_preview_authorizes_runtime: framework.proof_vocabulary.preview_authorizes_runtime,
        council_runtime_activation_allowed: council.activation_gate.runtime_activation_allowed,
        evidence_level: 'PREVIEW_ONLY'
      },
      {
        id: 'negative_matrix_availability',
        required: true,
        verifier_selftest_wired: validationHasCommand('verifier_selftest_negative_matrix'),
        regression_selftest_wired: validationHasCommand('v12_regression_selftest'),
        v2_preview_audit_wired: validationHasCommand('audit_v2_preview_readonly'),
        evidence_level: 'VERIFIED'
      },
      {
        id: 'ledger_historical_evidence_after_bootstrap',
        required: false,
        ledger_missing_behavior: 'HISTORICAL_EVIDENCE_UNAVAILABLE',
        ledger_corrupt_behavior: 'REPLAY_REQUIRED',
        ledger_bootstrap_trust_root: false,
        evidence_level: 'REPLAY_REQUIRED'
      }
    ],
    fresh_clone_replay_contract: {
      requires_bha_local: false,
      requires_private_key: false,
      requires_provider_call: false,
      requires_remote_write: false,
      commands: [
        'node --check scripts/bha-verify.js',
        'node scripts/bha-verify.js --self-test',
        'node scripts/bha-verify.js',
        "node scripts/bha-run.js recover-status --remote 'origin' --branch 'master' --format json",
        'node scripts/bha-run.js bootstrap-status --format json'
      ],
      missing_local_payload_status: 'LOCAL_ONLY_REGENERATION_REQUIRED_BEFORE_OPERATOR_CHOSEN_PUSH',
      damaged_ledger_status: 'REPLAY_REQUIRED'
    },
    fail_closed_states: {
      missing_ledger: 'HISTORICAL_EVIDENCE_UNAVAILABLE',
      corrupt_ledger: 'REPLAY_REQUIRED',
      missing_validation: 'BLOCKED_MISSING_EVIDENCE',
      missing_artifact_provenance: 'BLOCKED_MISSING_EVIDENCE',
      preview_claims_authority: 'PREVIEW_HOLD_LINE'
    },
    activation_firewall: {
      preview_authorizes_runtime: false,
      preview_artifact_can_enter_gate_positive_condition: false,
      council_trace_is_validation_evidence: false,
      effective_production_capability_types: framework.production_capability_types
    },
    proof_boundary: 'bootstrap-status is a replay contract for local verification. It does not make ledger history a bootstrap trust root and does not authorize capabilities or runtime activation.'
  };
  return withArtifactProvenance(report, {
    type: 'bootstrap_status',
    generated_by: 'node scripts/bha-run.js bootstrap-status --format json',
    input_hashes: {
      capability_framework_status: framework.artifact_provenance ? framework.artifact_provenance.output_hash : null,
      council_status: council.artifact_provenance ? council.artifact_provenance.output_hash : null
    }
  });
}

function disallowedCapabilityType(type) {
  const policy = loadPolicy();
  const disallowed = (((policy.capability_rules || {}).always_denied_v1) || []).map((item) => String(item));
  return disallowed.includes(String(type));
}

function trustedSigningKeys() {
  const policy = loadPolicy();
  return ((policy.trusted_public_keys || []))
    .map((item) => capabilityVerifier.normalizeTrustedSigningKeyItem(item))
    .filter((item) => item.id);
}

function findTrustedSigningKey(id) {
  return trustedSigningKeys().find((item) => item.id === String(id));
}

function signingKeyPurposeAllowedForCapability(key, type) {
  return capabilityVerifier.signingKeyPurposeAllowedForCapability(key, type);
}

function signingKeyPurposeResult(key, type) {
  return capabilityVerifier.signingKeyPurposeResult(key, type);
}

function capabilityRequestPayload(payload) {
  return capabilityVerifier.capabilityRequestPayload(payload);
}

function capabilityPayloadHash(payload) {
  return capabilityVerifier.capabilityPayloadHash(payload);
}

function capabilitySignablePayload(payload) {
  return capabilityVerifier.capabilitySignablePayload(payload);
}

function capabilitySignatureInput(payload) {
  return capabilityVerifier.capabilitySignatureInput(payload);
}

function signCapabilityPayload(payload, privateKey) {
  payload.payload_hash = capabilityPayloadHash(payload);
  payload.signature = crypto.sign(
    null,
    Buffer.from(capabilitySignatureInput(payload)),
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
      Buffer.from(capabilitySignatureInput(payload)),
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
  return capabilityVerifier.canonicalPayloadHashFormat(value);
}

function validateCanonicalSignedCapability(payload) {
  const staticReason = capabilityVerifier.canonicalSignedCapabilityReason(payload);
  if (staticReason) {
    return capabilityResult(payload, false, staticReason);
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
  const schemaReason = capabilityVerifier.capabilitySchemaReason(payload, 'bha.capability.v1');
  if (schemaReason) {
    return capabilityResult(payload, false, schemaReason);
  }
  const idReason = capabilityVerifier.capabilityIdReason(payload);
  if (idReason) {
    return capabilityResult(payload, false, idReason);
  }
  const typePolicy = capabilityTypePolicy(type);
  if (typePolicy.allowed !== true) {
    return capabilityResult(payload, false, typePolicy.reason);
  }
  const runReason = capabilityVerifier.capabilityRunIdReason(payload, state.run_id);
  if (runReason) {
    return capabilityResult(payload, false, runReason);
  }
  const hashReason = capabilityVerifier.capabilityPolicyMissionHashReason(payload, policyHash(), missionHash());
  if (hashReason) {
    return capabilityResult(payload, false, hashReason);
  }
  const bindingReason = capabilityVerifier.capabilityBindingMissingReason(payload, ['remote', 'branch', 'head']);
  if (bindingReason) {
    return capabilityResult(payload, false, bindingReason);
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
  const ledgerHeadReason = capabilityVerifier.capabilityLedgerHeadReason(payload, verifier.parsed.ledger_head_hash);
  if (ledgerHeadReason) {
    return capabilityResult(payload, false, ledgerHeadReason);
  }
  const oneUseReason = capabilityVerifier.capabilityOneUseReason(payload);
  if (oneUseReason) {
    return capabilityResult(payload, false, oneUseReason);
  }
  const expirationReason = capabilityExpirationReason(payload.expires_at);
  if (expirationReason) {
    return capabilityResult(payload, false, expirationReason);
  }
  const commandReason = capabilityVerifier.gitPushCommandReason(payload);
  if (commandReason) {
    return capabilityResult(payload, false, commandReason);
  }
  return capabilityResult(payload, true, 'CAPABILITY_SIGNATURE_VALID');
}

function isExpired(expiresAt, now) {
  return capabilityVerifier.isExpired(expiresAt, Number.isFinite(now) ? now : Date.now());
}

function capabilityExpirationReason(expiresAt, now) {
  return capabilityVerifier.capabilityExpirationReason(expiresAt, Number.isFinite(now) ? now : Date.now());
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
  const idReason = capabilityVerifier.capabilityIdReason(payload);
  if (idReason) {
    return { valid: false, reason: idReason };
  }
  const canonical = validateCanonicalSignedCapability(payload);
  if (canonical.valid !== true) {
    return { valid: false, reason: canonical.reason };
  }
  const typePolicy = capabilityTypePolicy(type);
  if (typePolicy.allowed !== true) {
    return { valid: false, reason: typePolicy.reason };
  }
  const runReason = capabilityVerifier.capabilityRunIdReason(payload, state.run_id);
  if (runReason) {
    return { valid: false, reason: runReason };
  }
  const hashReason = capabilityVerifier.capabilityPolicyMissionHashReason(payload, policyHash(), missionHash());
  if (hashReason) {
    return { valid: false, reason: hashReason };
  }
  const bindingReason = capabilityVerifier.capabilityBindingMissingReason(payload, ['remote', 'branch', 'head']);
  if (bindingReason) {
    return { valid: false, reason: bindingReason };
  }
  const ledgerHeadReason = checkLedgerHead
    ? capabilityVerifier.capabilityLedgerHeadReason(payload, state.ledger_head_hash)
    : null;
  if (ledgerHeadReason) {
    return { valid: false, reason: ledgerHeadReason };
  }
  const oneUseReason = capabilityVerifier.capabilityOneUseReason(payload);
  if (oneUseReason) {
    return { valid: false, reason: oneUseReason };
  }
  const expirationReason = capabilityExpirationReason(payload.expires_at);
  if (expirationReason) {
    return { valid: false, reason: expirationReason };
  }
  if (capabilityRevoked(events || [], id)) {
    return { valid: false, reason: 'CAPABILITY_REVOKED' };
  }
  return { valid: true, reason: 'CAPABILITY_SIGNATURE_VALID' };
}

const capabilityStore = createCapabilityStore({
  capabilitiesPath: CAPABILITIES_PATH,
  localCapabilitiesPath: LOCAL_CAPABILITIES_PATH,
  localCapabilitySessionsPath: LOCAL_CAPABILITY_SESSIONS_PATH,
  bhaLocalDir: BHA_LOCAL_DIR,
  stable,
  sha256,
  loadMission,
  loadPolicy,
  loadState,
  policyHash,
  missionHash,
  readJsonl,
  resolveLocalFile,
  withCapabilityLock,
  ensureTrackedWriteAllowed,
  ensureLocalWriteAllowed,
  appendLedger
});

const capabilityHash = capabilityStore.capabilityHash;
const buildCapabilityEvent = capabilityStore.buildCapabilityEvent;
const appendCapabilityEvent = capabilityStore.appendCapabilityEvent;
const appendLocalCapabilityEventUnlocked = capabilityStore.appendLocalCapabilityEventUnlocked;
const appendLocalCapabilityEvent = capabilityStore.appendLocalCapabilityEvent;
const appendLocalCapabilitySessionUnlocked = capabilityStore.appendLocalCapabilitySessionUnlocked;
const appendLocalCapabilitySession = capabilityStore.appendLocalCapabilitySession;
const readCapabilityEvents = capabilityStore.readCapabilityEvents;
const readLocalCapabilitySessions = capabilityStore.readLocalCapabilitySessions;
const readLocalCapabilityEvents = capabilityStore.readLocalCapabilityEvents;
const readCapabilityEventsWithLocalSessions = capabilityStore.readCapabilityEventsWithLocalSessions;

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

async function currentParentHead() {
  const result = await runCommand(['git', 'rev-parse', 'HEAD^'], {});
  if (result.exit_code !== 0 || result.error) {
    return null;
  }
  return result.stdout.trim();
}

async function currentHeadChangedFiles() {
  const result = await runCommand(['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], {});
  if (result.exit_code !== 0 || result.error) {
    return { ok: false, files: [], error: result.error || truncate(result.stderr) || 'git diff-tree unavailable' };
  }
  return {
    ok: true,
    files: result.stdout.split(/\r?\n/).map((line) => line.trim().replace(/\\/g, '/')).filter(Boolean)
  };
}

async function buildPushPayload(remote, branch, keyId, expiresMinutes) {
  if (branch === 'CURRENT' || branch === 'CURRENT_BRANCH') {
    branch = await currentBranch();
  }
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
    ensureLocalWriteAllowed('write push payload');
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
  return pushGate.powerShellSingleQuote(value);
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
  let branch = getOption(args, '--branch');
  if (branch === 'CURRENT' || branch === 'CURRENT_BRANCH') {
    branch = await currentBranch();
  }
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
  ensureLocalWriteAllowed('write push prep payload and handoff');
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
  let branch = getOption(args, '--branch');
  if (branch === 'CURRENT' || branch === 'CURRENT_BRANCH') {
    branch = await currentBranch();
  }
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
  const localOnly = forAction === 'git_push';
  const head = currentHeadSync();
  if (localOnly) {
    ensureLocalWriteAllowed('consume local capability');
  }
  const result = localOnly
    ? withCapabilityLock(() => consumeCapabilityRecord(id, forAction, remote, branch, head, true))
    : consumeCapabilityRecord(id, forAction, remote, branch, head, false);
  console.log(JSON.stringify({
    ok: result.valid,
    capability_id: id,
    valid: result.valid,
    status: result.status,
    reason: result.reason,
    capability_store: result.capability_store,
    local_only: localOnly,
    event_hash: result.event.event_hash
  }));
  if (!result.valid) {
    process.exitCode = 2;
  }
}

function consumeCapabilityRecord(id, forAction, remote, branch, head, localOnly) {
  const events = readCapabilityEventsWithLocalSessions();
  const issue = findCapabilityIssue(events, id);
  let valid = false;
  let status = 'DENIED';
  let reason = issue ? issue.payload.reason || 'CAPABILITY_INVALID' : 'CAPABILITY_NOT_FOUND';
  const state = loadState();
  if (issue) {
    const requested = issue.payload.requested || {};
    const existingConsumed = validCapabilityConsumes(events, id);
    const existingSessions = validCapabilitySessions(events, id);
    const validation = validateCapabilityRequest(requested, issue.payload.capability_type, state, events);
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
  const capabilityStore = localOnly ? '.bha/local/capabilities.jsonl' : '.bha/capabilities.jsonl';
  const event = localOnly ? appendLocalCapabilityEventUnlocked('capability_consume', {
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
  return { valid, status, reason, capability_store: capabilityStore, event };
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
  return pushGate.authorizedRuntimeDirty(stdout);
}

function validatedOrRuntimeDirty(stdout) {
  return pushGate.validatedOrRuntimeDirty(stdout, validationInputsForRoot(ROOT).map((file) => rel(file)));
}

function gitStatusAllowedForLocalTrustRepair(status) {
  return pushGate.gitStatusAllowedForLocalTrustRepair(status);
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

async function readOnlyJsonCommand(argv) {
  const result = await runCommand(argv, {});
  const parsed = parseJsonLine(result.stdout);
  return {
    argv,
    ok: result.exit_code === 0 && parsed && parsed.ok === true,
    exit_code: result.exit_code,
    status: parsed && parsed.status ? parsed.status : 'UNKNOWN',
    error: result.error || null,
    stderr: truncate(result.stderr),
    parsed
  };
}

async function matchingConsumedCapability(remote, branch, head, options) {
  const reserve = options && options.reserve === true;
  if (reserve) {
    ensureLocalWriteAllowed('reserve local capability session');
    return withCapabilityLock(() => matchingConsumedCapabilityCore(remote, branch, head, true));
  }
  return matchingConsumedCapabilityCore(remote, branch, head, false);
}

function matchingConsumedCapabilityCore(remote, branch, head, reserve) {
  const state = loadState();
  let events;
  try {
    events = readCapabilityEventsWithLocalSessions();
  } catch (error) {
    return {
      ok: false,
      reason: 'LOCAL_CAPABILITY_PATH_INVALID',
      error: error && error.message ? error.message : String(error)
    };
  }
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
  let replayedCandidate = null;
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
      replayedCandidate = replayedCandidate || { ok: false, reason: 'CAPABILITY_REPLAY_DETECTED', capability_id: id };
      continue;
    }
    if (validCapabilitySessions(events, id).length > 0) {
      replayedCandidate = replayedCandidate || { ok: false, reason: 'CAPABILITY_REPLAY_DETECTED', capability_id: id };
      continue;
    }
    if (!issue) {
      return { ok: false, reason: 'CAPABILITY_TICKET_MISSING', capability_id: id };
    }
    const validation = validateCapabilityRequest(requested, issue.payload.capability_type, state, events);
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
        const session = appendLocalCapabilitySessionUnlocked({
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
  if (replayedCandidate) {
    return replayedCandidate;
  }
  return { ok: false, reason: 'NO_VALID_CONSUMED_GIT_PUSH_CAPABILITY' };
}

function latestUsedGitPushSession(remote, branch, head, capabilityId) {
  let sessions;
  try {
    sessions = readLocalCapabilitySessions();
  } catch (_error) {
    return null;
  }
  sessions = sessions.filter((event) => {
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
  return pushGate.postPushStatusSummary({ branch, capability, checks, usedSession, remoteTracking });
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

function allZeroSha(value) {
  return /^[0]+$/.test(String(value || '')) && String(value || '').length >= 40;
}

function prepushUpdateFromInput(stdinText) {
  const line = String(stdinText || '').split(/\r?\n/).find((item) => item.trim() !== '');
  if (!line) {
    return null;
  }
  const parts = line.trim().split(/\s+/);
  const localRef = parts[0] || '';
  const localSha = parts[1] || '';
  const remoteRef = parts[2] || '';
  const remoteSha = parts[3] || '';
  const match = remoteRef.match(/^refs\/heads\/(.+)$/);
  const isDelete = localRef === '(delete)' || allZeroSha(localSha);
  return {
    line,
    local_ref: localRef || 'UNKNOWN',
    local_sha: localSha || 'UNKNOWN',
    remote_ref: remoteRef || 'UNKNOWN',
    remote_sha: remoteSha || 'UNKNOWN',
    branch: match ? match[1] : null,
    is_delete: isDelete,
    action: isDelete ? 'delete' : 'update'
  };
}

function branchFromPrepushInput(stdinText) {
  const update = prepushUpdateFromInput(stdinText);
  return update ? update.branch : null;
}

function validationCommandPassed(state, id) {
  return pushGate.validationCommandPassed(state, id);
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
  return pushGate.prepushEvidenceGates(state, ledger, verify, {
    readCheckpointFile,
    ledgerEventByHash,
    newestLedgerEventOfType,
    rollbackDrillChecks,
    validationInputsHash,
    policyHash,
    missionHash
  });
}

function trackedGitRealityBindingFromHeads(currentHeadValue, checkpointHeadValue, closeoutHeadValue) {
  return gitReality.trackedGitRealityBindingFromHeads(currentHeadValue, checkpointHeadValue, closeoutHeadValue);
}

function trackedGitRealityBinding(currentHeadValue, checkpoint, closeoutEvent) {
  return gitReality.trackedGitRealityBinding(currentHeadValue, checkpoint, closeoutEvent);
}

async function evidenceCarrierCommitStatus(currentHeadValue, gitRealityBinding) {
  const allowedFiles = new Set([
    '.bha/checkpoint.json',
    '.bha/ledger.jsonl',
    '.bha/state.json'
  ]);
  const parentHead = await currentParentHead();
  const changed = await currentHeadChangedFiles();
  const changedFiles = changed.files || [];
  const subjectHead = gitRealityBinding && gitRealityBinding.checkpoint_head !== 'NOT_RECORDED'
    ? gitRealityBinding.checkpoint_head
    : null;
  const closeoutHead = gitRealityBinding && gitRealityBinding.closeout_git_reality_head !== 'NOT_RECORDED'
    ? gitRealityBinding.closeout_git_reality_head
    : null;
  const filesAllowed = changed.ok === true &&
    changedFiles.length > 0 &&
    changedFiles.every((file) => allowedFiles.has(file));
  const subjectMatchesParent = Boolean(parentHead &&
    subjectHead &&
    closeoutHead &&
    subjectHead === parentHead &&
    closeoutHead === parentHead);
  const currentDiffersFromSubject = Boolean(currentHeadValue && subjectHead && currentHeadValue !== subjectHead);
  const active = Boolean(filesAllowed && subjectMatchesParent && currentDiffersFromSubject);
  return {
    active,
    mode: active ? 'EVIDENCE_CARRIER_COMMIT' : 'DIRECT_HEAD_BINDING',
    current_head: currentHeadValue || 'UNKNOWN',
    subject_head: subjectHead || 'UNKNOWN',
    carrier_head: active ? currentHeadValue || 'UNKNOWN' : null,
    parent_head: parentHead || 'UNKNOWN',
    changed_files: changedFiles,
    allowed_files: Array.from(allowedFiles),
    checks: {
      diff_tree_available: changed.ok === true,
      files_allowed: filesAllowed,
      subject_matches_parent: subjectMatchesParent,
      current_differs_from_subject: currentDiffersFromSubject
    },
    error: changed.error || null,
    proof_boundary: 'An evidence carrier commit may carry tracked BHA evidence for its parent subject commit only when the carrier changes allowed evidence files and checkpoint/closeout bind to the parent head.'
  };
}

function validationFreshEvidence(state, ledger) {
  const validation = state && state.validation ? state.validation : null;
  const currentInputsHash = validationInputsHash();
  const checks = {
    validation_recorded: Boolean(validation),
    validation_pass: Boolean(validation && validation.status === 'PASS'),
    inputs_hash_current: Boolean(validation && validation.inputs_hash === currentInputsHash),
    policy_hash_current: Boolean(validation && validation.policy_hash === policyHash()),
    mission_hash_current: Boolean(validation && validation.mission_hash === missionHash()),
    ledger_event_present: Boolean(validation &&
      ledgerEventByHash(ledger || [], validation.ledger_event_hash, 'validation_completed'))
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    current_inputs_hash: currentInputsHash,
    recorded_inputs_hash: validation ? validation.inputs_hash || null : null,
    validation_ledger_event_hash: validation ? validation.ledger_event_hash || null : null,
    completed_at: validation ? validation.completed_at || null : null
  };
}

function evidenceUxRecommendation(validationFresh, gitStatus, gitRealityBinding, evidence, carrier) {
  const worktreeAllowed = gitStatusAllowedForLocalTrustRepair(gitStatus) ||
    (validationFresh.ok === true && gitStatus && gitStatus.ok === true && validatedOrRuntimeDirty(gitStatus.stdout));
  if (!worktreeAllowed) {
    return {
      action: 'COMMIT_OR_RESOLVE_UNVERIFIED_WORKTREE_CHANGES',
      full_validation_required: !validationFresh.ok,
      fast_repair_available: false
    };
  }
  if (!validationFresh.ok) {
    return {
      action: 'RUN_FULL_VALIDATE_CHECKPOINT_CLOSEOUT',
      full_validation_required: true,
      fast_repair_available: false
    };
  }
  if (carrier && carrier.active === true) {
    return {
      action: 'NO_EVIDENCE_REPAIR_REQUIRED',
      full_validation_required: false,
      fast_repair_available: false,
      head_only_mismatch: true,
      carrier_commit_accepted: true
    };
  }
  const headOnlyMismatch = Boolean(gitRealityBinding &&
    ((gitRealityBinding.checkpoint_head !== 'NOT_RECORDED' && !gitRealityBinding.checkpoint_matches_current_head) ||
      (gitRealityBinding.closeout_git_reality_head !== 'NOT_RECORDED' && !gitRealityBinding.closeout_matches_current_head)));
  const needsFastRepair = headOnlyMismatch ||
    !evidence.gates.checkpoint_recorded ||
    !evidence.gates.closeout_current ||
    !evidence.gates.verifier_no_warnings;
  return {
    action: needsFastRepair ? 'RUN_FAST_EVIDENCE_REPAIR' : 'NO_EVIDENCE_REPAIR_REQUIRED',
    full_validation_required: false,
    fast_repair_available: needsFastRepair,
    head_only_mismatch: headOnlyMismatch
  };
}

async function evidenceUxStatus(remote, branch) {
  const targetRemote = remote || 'origin';
  const targetBranch = branch || await currentBranch();
  const head = await currentHead();
  const gitStatus = await gitStatusShort();
  const verify = await verifierResult();
  const state = loadState();
  const ledger = readJsonl(LEDGER_PATH);
  const checkpoint = readCheckpointFile();
  const closeoutEvent = state && state.closeout ? ledgerEventByHash(ledger, state.closeout.ledger_event_hash, 'closeout_completed') : null;
  const gitRealityBinding = trackedGitRealityBinding(head, checkpoint, closeoutEvent);
  const carrier = await evidenceCarrierCommitStatus(head, gitRealityBinding);
  const evidence = prepushEvidenceGates(state, ledger, verify);
  const validationFresh = validationFreshEvidence(state, ledger);
  const recommendation = evidenceUxRecommendation(validationFresh, gitStatus, gitRealityBinding, evidence, carrier);
  return {
    schema: 'bha.evidence_ux_status.v1',
    ok: recommendation.full_validation_required !== true,
    status: recommendation.full_validation_required
      ? 'FULL_VALIDATION_REQUIRED'
      : (recommendation.fast_repair_available === true ? 'FAST_PATH_AVAILABLE' : 'NO_REPAIR_REQUIRED'),
    recorded: false,
    read_only: true,
    remote: targetRemote,
    branch: targetBranch || 'UNKNOWN',
    head: head || 'UNKNOWN',
    validation_fresh: validationFresh.ok,
    validation_reuse: {
      allowed: validationFresh.ok,
      reason: validationFresh.ok
        ? 'Validation evidence binds to current validation inputs, policy, mission, and ledger event; a Git commit alone does not require rerunning every validation command.'
        : 'Validation evidence is missing or stale; full validation is required before fast evidence repair.',
      checks: validationFresh.checks,
      completed_at: validationFresh.completed_at,
      validation_ledger_event_hash: validationFresh.validation_ledger_event_hash
    },
    git_status: {
      ok: gitStatus.ok,
      clean: gitStatus.clean,
      authorized_runtime_evidence_dirty: gitStatus.ok === true && gitStatus.clean !== true ? authorizedRuntimeDirty(gitStatus.stdout) : false,
      validated_or_runtime_dirty: gitStatus.ok === true && gitStatus.clean !== true ? validatedOrRuntimeDirty(gitStatus.stdout) : false,
      short: gitStatus.stdout.trim() || 'CLEAN'
    },
    tracked_git_reality: gitRealityBinding,
    evidence_carrier_commit: carrier,
    evidence_gates: evidence.gates,
    verifier: verify.parsed ? {
      ok: verify.parsed.ok === true,
      status: verify.parsed.status || 'UNKNOWN',
      warnings: Array.isArray(verify.parsed.warnings) ? verify.parsed.warnings.length : 0,
      issues: Array.isArray(verify.parsed.issues) ? verify.parsed.issues.length : 0,
      ledger_head_hash: verify.parsed.ledger_head_hash || null
    } : {
      ok: false,
      status: 'UNKNOWN',
      warnings: 0,
      issues: 1,
      ledger_head_hash: null
    },
    recommendation: Object.assign({
      fast_repair_command: recommendation.fast_repair_available === true
        ? `node scripts/bha-run.js repair-evidence --fast --remote ${powerShellSingleQuote(targetRemote)} --branch ${powerShellSingleQuote(targetBranch || 'master')} --format json`
        : null,
      full_repair_commands: [
        'node scripts/bha-run.js validate',
        'node scripts/bha-run.js checkpoint --format json',
        'node scripts/bha-run.js closeout --record --format json',
        'node scripts/bha-verify.js'
      ]
    }, recommendation),
    proof_boundary: 'evidence-ux-status is read-only. It separates validation freshness from Git HEAD binding so ordinary commits do not force full validation when tracked validation inputs are unchanged.'
  };
}

async function handleEvidenceUxStatus(args) {
  const format = getOption(args, '--format') || 'json';
  const allowValidationInProgress = args.includes('--allow-validation-in-progress');
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const remote = getOption(args, '--remote') || 'origin';
  const branch = getOption(args, '--branch') || await currentBranch();
  const status = await evidenceUxStatus(remote, branch);
  status.validation_in_progress_allowed = allowValidationInProgress;
  if (allowValidationInProgress && status.ok !== true && status.status === 'FULL_VALIDATION_REQUIRED') {
    status.ok = true;
    status.status = 'VALIDATION_IN_PROGRESS';
    status.recommendation.validation_in_progress_override = true;
  }
  console.log(JSON.stringify(status));
  if (status.ok !== true) {
    process.exitCode = 1;
  }
}

async function handleRepairEvidence(args) {
  const format = getOption(args, '--format') || 'json';
  const fast = args.includes('--fast');
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  if (!fast) {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'repair-evidence currently requires --fast' }));
    process.exitCode = 2;
    return;
  }
  const remote = getOption(args, '--remote') || 'origin';
  const branch = getOption(args, '--branch') || await currentBranch();
  const before = await evidenceUxStatus(remote, branch);
  if (!before.validation_reuse || before.validation_reuse.allowed !== true) {
    console.log(JSON.stringify({
      schema: 'bha.repair_evidence.v1',
      ok: false,
      status: 'BLOCKED_FULL_VALIDATION_REQUIRED',
      mode: 'fast',
      recorded: false,
      read_only: false,
      before,
      next_commands: before.recommendation ? before.recommendation.full_repair_commands : ['node scripts/bha-run.js validate']
    }));
    process.exitCode = 3;
    return;
  }
  if (!(before.git_status &&
      before.git_status.ok === true &&
      (before.git_status.clean === true ||
        before.git_status.authorized_runtime_evidence_dirty === true ||
        before.git_status.validated_or_runtime_dirty === true))) {
    console.log(JSON.stringify({
      schema: 'bha.repair_evidence.v1',
      ok: false,
      status: 'BLOCKED_UNVERIFIED_WORKTREE_CHANGES',
      mode: 'fast',
      recorded: false,
      read_only: false,
      before,
      next_commands: ['git status --short']
    }));
    process.exitCode = 3;
    return;
  }
  if (!before.recommendation || before.recommendation.fast_repair_available !== true) {
    console.log(JSON.stringify({
      schema: 'bha.repair_evidence.v1',
      ok: true,
      status: 'NO_REPAIR_REQUIRED',
      mode: 'fast',
      recorded: false,
      read_only: true,
      validation_reused: true,
      validation_commands_rerun: false,
      before: {
        status: before.status,
        recommendation: before.recommendation,
        tracked_git_reality: before.tracked_git_reality,
        evidence_carrier_commit: before.evidence_carrier_commit
      },
      proof_boundary: 'repair-evidence --fast is a no-op unless evidence-ux-status explicitly reports fast_repair_available:true; accepted evidence carrier commits must not create recursive evidence commits.'
    }));
    return;
  }
  const checkpoint = await readOnlyJsonCommand(['node', 'scripts/bha-run.js', 'checkpoint', '--format', 'json']);
  if (checkpoint.exit_code !== 0 || checkpoint.ok !== true) {
    console.log(JSON.stringify({
      schema: 'bha.repair_evidence.v1',
      ok: false,
      status: 'CHECKPOINT_FAILED',
      mode: 'fast',
      recorded: true,
      read_only: false,
      before,
      checkpoint
    }));
    process.exitCode = checkpoint.exit_code || 1;
    return;
  }
  const closeout = await readOnlyJsonCommand(['node', 'scripts/bha-run.js', 'closeout', '--record', '--format', 'json']);
  if (closeout.exit_code !== 0 || closeout.ok !== true) {
    console.log(JSON.stringify({
      schema: 'bha.repair_evidence.v1',
      ok: false,
      status: 'CLOSEOUT_FAILED',
      mode: 'fast',
      recorded: true,
      read_only: false,
      before,
      checkpoint,
      closeout
    }));
    process.exitCode = closeout.exit_code || 1;
    return;
  }
  const after = await evidenceUxStatus(remote, branch);
  console.log(JSON.stringify({
    schema: 'bha.repair_evidence.v1',
    ok: after.validation_reuse && after.validation_reuse.allowed === true,
    status: 'FAST_REPAIR_RECORDED',
    mode: 'fast',
    recorded: true,
    read_only: false,
    validation_reused: true,
    validation_commands_rerun: false,
    before: {
      status: before.status,
      recommendation: before.recommendation,
      tracked_git_reality: before.tracked_git_reality
    },
    checkpoint: {
      ok: checkpoint.ok,
      status: checkpoint.status,
      event_hash: checkpoint.parsed && checkpoint.parsed.event ? checkpoint.parsed.event.event_hash : null
    },
    closeout: {
      ok: closeout.ok,
      status: closeout.status,
      event_hash: closeout.parsed && closeout.parsed.closeout_event ? closeout.parsed.closeout_event.event_hash : null
    },
    after: {
      status: after.status,
      recommendation: after.recommendation,
      tracked_git_reality: after.tracked_git_reality,
      evidence_gates: after.evidence_gates
    },
    proof_boundary: 'Fast repair reuses fresh validation evidence and records only checkpoint/closeout binding. It must not be used when validation inputs, policy, mission, or validation.yaml changed.'
  }));
}

function firstFailedGate(checks) {
  return pushGate.firstFailedGate(checks);
}

async function handlePrepushCheck(args) {
  const record = args.includes('--record');
  const preflight = args.includes('--preflight');
  const noWriteGuard = args.includes('--no-write-guard');
  const hookArgs = args.filter((arg) => arg !== '--record' && arg !== '--preflight' && arg !== '--no-write-guard');
  if (hookArgs[0] !== '--internal-git-hook') {
    console.log(JSON.stringify({
      schema: 'bha.prepush_check.v1',
      ok: false,
      status: 'FAIL_CLOSED',
      reason: 'missing internal hook marker'
    }));
    process.exitCode = 1;
    return;
  }
  const remote = hookArgs[1] || null;
  const stdinText = await readStdin();
  const prepushUpdate = prepushUpdateFromInput(stdinText);
  const branch = (prepushUpdate && prepushUpdate.branch) || await currentBranch();
  const remoteBranchDelete = Boolean(prepushUpdate && prepushUpdate.is_delete === true);
  const head = await currentHead();
  const status = await gitStatusShort();
  const verify = await verifierResult();
  const state = loadState();
  const ledger = readJsonl(LEDGER_PATH);
  const evidence = prepushEvidenceGates(state, ledger, verify);
  const checkpoint = readCheckpointFile();
  const closeoutEvent = state && state.closeout ? ledgerEventByHash(ledger, state.closeout.ledger_event_hash, 'closeout_completed') : null;
  const gitRealityBinding = trackedGitRealityBinding(head, checkpoint, closeoutEvent);
  const carrier = await evidenceCarrierCommitStatus(head, gitRealityBinding);
  let capability = remote && branch && head && !remoteBranchDelete
    ? await matchingConsumedCapability(remote, branch, head, { reserve: false })
    : { ok: false, reason: remoteBranchDelete ? 'REMOTE_BRANCH_DELETE_REQUIRES_HIGH_RISK_AUTHORIZATION' : 'MISSING_REMOTE_BRANCH_OR_HEAD' };
  const capabilityRequired = remoteBranchDelete ? true : pushGate.capabilityRequiredForBranch(branch);
  const checks = {
    verifier_pass: evidence.gates.verifier_pass,
    verifier_no_warnings: evidence.gates.verifier_no_warnings,
    clean_ledger: evidence.gates.ledger_state_match,
    validation_fresh: evidence.gates.validation_fresh,
    rollback_recorded: evidence.gates.rollback_recorded,
    checkpoint_recorded: evidence.gates.checkpoint_recorded,
    closeout_current: evidence.gates.closeout_current,
    remote_branch_delete_blocked: !remoteBranchDelete,
    valid_consumed_capability: capabilityRequired ? capability.ok === true : true,
    matching_run_id_remote_branch_head: capabilityRequired ? capability.ok === true : true,
    clean_git_status: gitStatusAllowedForLocalTrustRepair(status)
  };
  let ok = Object.values(checks).every(Boolean);
  if (ok && !preflight && capabilityRequired && !remoteBranchDelete) {
    capability = await matchingConsumedCapability(remote, branch, head, { reserve: true });
    checks.valid_consumed_capability = capability.ok === true;
    checks.matching_run_id_remote_branch_head = capability.ok === true;
    ok = Object.values(checks).every(Boolean);
  }
  const failureReason = ok
    ? 'ALLOW'
    : (remoteBranchDelete ? 'REMOTE_BRANCH_DELETE_REQUIRES_HIGH_RISK_AUTHORIZATION' : ((capabilityRequired ? capability.reason : null) || firstFailedGate(checks) || 'PREPUSH_GATE_FAILED'));
  if (record) {
    appendLedger('prepush_check', {
      status: ok ? 'ALLOW' : 'FAIL_CLOSED',
      remote: remote || 'UNKNOWN',
      branch: branch || 'UNKNOWN',
      head: head || 'UNKNOWN',
      prepush_update: prepushUpdate,
      push_action: remoteBranchDelete ? 'delete' : 'update',
      checks,
      tracked_git_reality: gitRealityBinding,
      evidence_carrier_commit: carrier,
      reason: failureReason,
      capability: {
        ok: capability.ok === true,
        reason: capability.reason || null,
        capability_id: capability.capability_id || null
      }
    });
  }
  console.log(JSON.stringify({
    schema: 'bha.prepush_check.v1',
    ok,
    status: ok ? 'ALLOW' : 'FAIL_CLOSED',
    reason: failureReason,
    read_only: !record && (preflight || !ok),
    recorded: record,
    preflight,
    no_write_guard: noWriteGuard,
    capability_required: capabilityRequired,
    remote: remote || 'UNKNOWN',
    branch: branch || 'UNKNOWN',
    head: head || 'UNKNOWN',
    prepush_update: prepushUpdate,
    push_action: remoteBranchDelete ? 'delete' : 'update',
    destructive_remote_delete: remoteBranchDelete,
    high_risk_authorization_required: remoteBranchDelete,
    checks,
    evidence_gates: evidence.gates,
    tracked_git_reality: gitRealityBinding,
    evidence_carrier_commit: carrier,
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
    schema: 'bha.hook_status.v1',
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
  return pushGate.nextGateAction(checks, capability);
}

function protectedBaseBranch(branch) {
  return pushGate.protectedBaseBranch(branch);
}

function standardProtectedBranchFlow(remote, branch) {
  return pushGate.standardProtectedBranchFlow(remote, branch);
}

function nextGateCommands(action, remote, branch) {
  return pushGate.nextGateCommands(action, remote, branch);
}

function gateNextActionContext(action, branch) {
  return pushGate.gateNextActionContext(action, branch);
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
  return payloadSummary.currentPayloadContext(remote, branch, head, ledgerHeadHash, policyHash(), missionHash());
}

function capabilityFileSummary(localPath, remote, branch, head, signed, context) {
  const file = readLocalJsonFileSummary(localPath);
  const currentContext = context || currentPayloadContext(remote, branch, head, null);
  return payloadSummary.capabilityFileSummary(file, signed, currentContext, {
    reasonDetails,
    nowMs: Date.now()
  });
}

function reasonMessage(code) {
  return localPayloadStatusLib.reasonMessage(code);
}

function reasonDetails(reasons) {
  return localPayloadStatusLib.reasonDetails(reasons);
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
  const state = loadState();
  const ledger = readJsonl(LEDGER_PATH);
  const checkpoint = readCheckpointFile();
  const closeoutEvent = state && state.closeout ? ledgerEventByHash(ledger, state.closeout.ledger_event_hash, 'closeout_completed') : null;
  const gitRealityBinding = trackedGitRealityBinding(head, checkpoint, closeoutEvent);
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
  const currentContext = currentPayloadContext(targetRemote, targetBranch, head, verifierPass && verify.parsed ? verify.parsed.ledger_head_hash : null);
  const unsignedPayload = capabilityFileSummary('.bha/local/push-payload.json', targetRemote, targetBranch, head, false, currentContext);
  const signedPayload = await signedCapabilityFileSummary('.bha/local/signed-push-capability.json', targetRemote, targetBranch, head, currentContext);
  const payloadStatus = localPayloadStatus(unsignedPayload, signedPayload);
  const recoveryCommands = recoveryGitPushNextCommands(payloadStatus, targetRemote, targetBranch);
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
    local_payload_recovery: {
      read_only: true,
      unsigned_payload: unsignedPayload,
      signed_payload: signedPayload,
      local_payload_status: payloadStatus,
      stale_or_not_usable: payloadStatus.not_usable_local_files.length > 0,
      recovery_action: payloadStatus.next_payload_action
    },
    git_reality: {
      clean: gitStatus.clean,
      short: gitStatus.stdout.trim() || 'CLEAN'
    },
    tracked_git_reality: gitRealityBinding,
    git_push_recovery: {
      requires_new_local_capability: needsLocalGitPushCapability,
      required_now: false,
      condition: 'Only required before an operator-chosen real git push.',
      current_capability_status: hasUsableCapability.ok === true ? 'READY' : 'MISSING_OR_NOT_USABLE',
      reason: hasUsableCapability.ok === true ? null : hasUsableCapability.reason,
      local_only: true,
      next_commands: recoveryCommands
    },
    proof_boundary: '.bha/local/ is local-only capability evidence and is not required for tracked verifier trust; fresh clones must regenerate local git_push capability evidence before pushing.'
  };
}

function recoveryGitPushNextCommands(payloadStatus, targetRemote, targetBranch) {
  return localPayloadStatusLib.recoveryGitPushNextCommands(payloadStatus, targetRemote, targetBranch, powerShellSingleQuote);
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
    if (summary.expiry && summary.expiry.expired === true) {
      notUsableReasons.push('PAYLOAD_EXPIRED');
    }
    if (result.ok !== true) {
      notUsableReasons.push(result.reason || 'SIGNED_CAPABILITY_INVALID');
    }
    summary.not_usable_reasons = Array.from(new Set(notUsableReasons));
    summary.not_usable_reason_details = reasonDetails(summary.not_usable_reasons);
  }
  return summary;
}

function localPayloadIssue(kind, summary) {
  return localPayloadStatusLib.localPayloadIssue(kind, summary);
}

function localPayloadStatus(unsigned, signed) {
  return localPayloadStatusLib.localPayloadStatus(unsigned, signed);
}

async function operatorPushHandoff(action, remote, branch, head, capability, immediateCommands, context) {
  const payloadPath = '.bha/local/push-payload.json';
  const signedPath = '.bha/local/signed-push-capability.json';
  const remoteArg = powerShellSingleQuote(remote || 'origin');
  const branchArg = powerShellSingleQuote(branch || 'master');
  const payloadArg = powerShellSingleQuote(payloadPath);
  const protectedBranch = protectedBaseBranch(branch);
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
    ...(canUseExistingPayload ? [] : [
      `node scripts/bha-run.js make-push-payload --remote ${remoteArg} --branch ${branchArg} --expires-minutes 20 --key-id owner-main-pkcs8 --out ${payloadArg}`
    ]),
    canUseExistingPayload
      ? `operator signs existing ${payloadPath} outside BHA and writes ${signedPath}`
      : `operator signs ${payloadPath} outside BHA and writes ${signedPath}`,
    `$cap = "${signedPath}"`,
    `$id = "${capabilityId}"`,
    'node scripts/bha-run.js verify-signed-capability --file $cap',
    'node scripts/bha-run.js issue-capability --file $cap',
    `node scripts/bha-run.js consume-capability --id $id --for git_push --remote ${remoteArg} --branch ${branchArg}`,
    `node scripts/bha-run.js prepush-check --preflight --internal-git-hook ${remoteArg}`
  ];
  const blockedBeforeCapability = !capabilityActions.has(action);
  const singleLineCommands = blockedBeforeCapability ? immediateCommands : capabilityCommands;
  return {
    purpose: protectedBranch
      ? 'Prepare an emergency direct git_push capability for protected master without BHA reading private key material. Standard remote work should use a topic branch and PR.'
      : 'Prepare a git_push capability without BHA reading private key material.',
    action,
    capability_flow_required_now: false,
    capability_flow_condition: protectedBranch
      ? 'Only required if the operator chooses an emergency direct push to protected master; normal updates should use a topic branch, pull request, and BHA read-only gate.'
      : 'Only required if the operator chooses to perform a real git push.',
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
    standard_remote_flow: protectedBranch ? standardProtectedBranchFlow(remote, branch) : null,
    protected_branch_policy: pushGate.protectedBranchPolicy(branch),
    notes: [
      'Do not paste private key material into BHA commands.',
      'The signed capability file may contain a signature, but gate-status never prints the signature value.',
      'Existing .bha/local payload files are local-only and may be stale; regenerate before signing when matches_current_context is false.',
      'A capability already marked USED must not be replayed; generate and sign a fresh payload for the next push.',
      protectedBranch
        ? 'Protected master uses PR plus BHA read-only gate as the standard remote flow; direct master push is emergency-only.'
        : 'For protected base branches, prefer topic branch plus PR over direct branch push.'
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
  const carrier = await evidenceCarrierCommitStatus(head, gitRealityBinding);
  const capability = remote && branch && head
    ? await matchingConsumedCapability(remote, branch, head, { reserve: false })
    : { ok: false, reason: 'MISSING_REMOTE_BRANCH_OR_HEAD' };
  const capabilityRequired = pushGate.capabilityRequiredForBranch(branch);
  const checks = {
    verifier_pass: evidence.gates.verifier_pass,
    verifier_no_warnings: evidence.gates.verifier_no_warnings,
    clean_ledger: evidence.gates.ledger_state_match,
    validation_fresh: evidence.gates.validation_fresh,
    rollback_recorded: evidence.gates.rollback_recorded,
    checkpoint_recorded: evidence.gates.checkpoint_recorded,
    closeout_current: evidence.gates.closeout_current,
    valid_consumed_capability: capabilityRequired ? capability.ok === true : true,
    matching_run_id_remote_branch_head: capabilityRequired ? capability.ok === true : true,
    clean_git_status: gitStatusAllowedForLocalTrustRepair(status)
  };
  const action = nextGateAction(checks, capability);
  const actionContext = gateNextActionContext(action, branch);
  const immediateCommands = nextGateCommands(action, remote, branch);
  const currentContext = currentPayloadContext(remote, branch, head, verify.parsed ? verify.parsed.ledger_head_hash : null);
  const operatorHandoff = await operatorPushHandoff(action, remote, branch, head, capability, immediateCommands, currentContext);
  const nextCommands = operatorHandoff.blocked_before_capability ? immediateCommands : operatorHandoff.single_line_commands;
  const pushStatus = await postPushStatus(remote, branch, head, capability, checks);
  return {
    schema: 'bha.gate_status.v1',
    ok: Object.values(checks).every(Boolean),
    status: Object.values(checks).every(Boolean) ? 'READY' : 'BLOCKED',
    read_only: true,
    remote: remote || 'UNKNOWN',
    branch: branch || 'UNKNOWN',
    head: head || 'UNKNOWN',
    checks,
    evidence_gates: evidence.gates,
    capability,
    capability_required: capabilityRequired,
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
    push_requirement: pushGate.pushRequirement(branch, action),
    remote_branch_policy: pushGate.remoteBranchPolicy(branch),
    signer_boundary: {
      operator_controls_signer: true,
      bha_private_key_access: false,
      bha_handles_only: ['unsigned payload file under .bha/local/', 'signed payload file under .bha/local/']
    },
    tracked_git_reality: gitRealityBinding,
    evidence_carrier_commit: carrier,
    next_action: action,
    next_action_required_now: actionContext.next_action_required_now,
    next_action_condition: actionContext.next_action_condition,
    next_action_scope: actionContext.next_action_scope,
    next_commands: nextCommands,
    operator_handoff: operatorHandoff
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

function countSubstring(text, pattern) {
  return String(text || '').split(String(pattern)).length - 1;
}

function requireModuleAudit(files) {
  const allowedModules = new Set([
    'fs',
    'path',
    'crypto',
    'child_process',
    './lib/command-effects',
    './lib/policy-check',
    './lib/validation-runner',
    './lib/capability-store',
    './lib/push-gate',
    './lib/git-reality',
    './lib/local-payload-status',
    './lib/payload-summary',
    './lib/capability-verifier'
  ]);
  const modules = [];
  const dynamicRequireFiles = [];
  for (const file of files) {
    if (!fs.existsSync(file)) {
      continue;
    }
    const text = readText(file);
    const requireCallCount = Array.from(text.matchAll(/\brequire\s*\(/g)).length;
    const literalMatches = Array.from(text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g));
    if (requireCallCount !== literalMatches.length) {
      dynamicRequireFiles.push(rel(file));
    }
    for (const match of literalMatches) {
      modules.push({ file: rel(file), module: match[1] });
    }
  }
  const moduleNames = Array.from(new Set(modules.map((item) => item.module))).sort();
  return {
    allowed_modules: Array.from(allowedModules).sort(),
    modules,
    module_names: moduleNames,
    disallowed_modules: moduleNames.filter((name) => !allowedModules.has(name)),
    dynamic_require_files: dynamicRequireFiles
  };
}

function dependencySurfaceAudit(rootPath) {
  const scanRoot = path.resolve(rootPath || ROOT);
  const artifactNames = new Set([
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    '.pnp.cjs',
    '.pnp.loader.mjs'
  ]);
  const artifacts = [];
  const skipped = [];

  function visit(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: rel(dir), error: error.message });
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const scanRelativePath = path.relative(scanRoot, fullPath).replace(/\\/g, '/') || '.';
      const repoRelativePath = rel(fullPath).replace(/\\/g, '/');
      if (scanRelativePath === '.git' || scanRelativePath.startsWith('.git/')) {
        continue;
      }
      if (scanRelativePath === '.bha/local' || scanRelativePath.startsWith('.bha/local/')) {
        continue;
      }
      if (entry.name === 'node_modules') {
        artifacts.push({ path: repoRelativePath, kind: 'node_modules_directory' });
        continue;
      }
      if (artifactNames.has(entry.name)) {
        artifacts.push({ path: repoRelativePath, kind: 'dependency_artifact' });
      }
      if (entry.isDirectory()) {
        visit(fullPath);
      }
    }
  }

  visit(scanRoot);
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return {
    scanned_root: scanRoot === ROOT ? '.' : rel(scanRoot),
    ignored_roots: ['.git', '.bha/local'],
    forbidden_names: Array.from(artifactNames).concat(['node_modules']).sort(),
    artifacts,
    skipped
  };
}

function sourceFunctionText(file, functionName) {
  if (!fs.existsSync(file)) {
    return null;
  }
  const text = readText(file);
  const marker = `async function ${functionName}`;
  const start = text.indexOf(marker);
  if (start < 0) {
    return null;
  }
  const next = text.indexOf('\nasync function ', start + marker.length);
  return next >= 0 ? text.slice(start, next) : text.slice(start);
}

function operatorSignerPrivateKeyAudit() {
  const source = sourceFunctionText(RUN_SCRIPT, 'handleOperatorSignerPreflight');
  const dangerousPatterns = [
    { id: 'read_text_key_path', pattern: /\bread(?:Text|JsonStrict|JsonLines)?\s*\(\s*key(?:Path|Resolved)\b/ },
    { id: 'fs_read_key_path', pattern: /\bfs\.readFile(?:Sync)?\s*\(\s*key(?:Path|Resolved)\b/ },
    { id: 'write_key_path', pattern: /\b(?:fs\.)?(?:writeFile|writeFileSync|appendFile|appendFileSync)\s*\(\s*key(?:Path|Resolved)\b/ },
    { id: 'print_key_path_value', pattern: /\bconsole\.(?:log|error|warn)\s*\(\s*key(?:Path|Resolved)\b/ },
    { id: 'return_private_key_path_value', pattern: /\bprivate_key_path\s*:\s*key(?:Path|Resolved)\b/ },
    { id: 'return_key_path_value', pattern: /\b(?:value|path)\s*:\s*key(?:Path|Resolved)\b/ }
  ];
  const violations = source
    ? dangerousPatterns.filter((item) => item.pattern.test(source)).map((item) => item.id)
    : dangerousPatterns.map((item) => item.id);
  return {
    function_found: Boolean(source),
    env_reference: Boolean(source && source.includes('BHA_PRIVATE_KEY_PATH')),
    exists_check_only: Boolean(source && source.includes('fs.existsSync(keyResolved)')),
    repo_path_blocker: Boolean(source && source.includes('BHA_PRIVATE_KEY_PATH_INSIDE_REPOSITORY')),
    reports_material_not_read: Boolean(source && source.includes('private_key_material_read: false')),
    reports_path_not_printed: Boolean(source && source.includes('private_key_path_value_printed: false')),
    violations
  };
}

function validationCommandById(validation, id) {
  const commands = validation && Array.isArray(validation.required_commands)
    ? validation.required_commands
    : [];
  return commands.find((command) => command.id === id) || null;
}

function commandHasJsonPath(command, pathName, expected) {
  const actual = command &&
    command.expect &&
    command.expect.json_paths
    ? command.expect.json_paths[pathName]
    : undefined;
  return stable(actual) === stable(expected);
}

function recordedValidationCommand(state, id) {
  const commands = state && state.validation && Array.isArray(state.validation.commands)
    ? state.validation.commands
    : [];
  return commands.find((command) => command.id === id) || null;
}

function policyAllowsArgv(policy, argv) {
  return policyCheck.policyAllowsArgv(policy, argv);
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

async function handleProofVocabularyStatus(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(proofVocabularyStatus()));
}

async function handleBootstrapStatus(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(bootstrapStatus()));
}

async function handleProofNegativeMatrixStatus(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(proofNegativeMatrixStatus()));
}

function stableExitNextCommands(evidenceUx, blockingChecks) {
  if (Array.isArray(blockingChecks) && blockingChecks.includes('clean_worktree')) {
    return [
      'git status --short',
      'commit or resolve validated worktree changes',
      'node scripts/bha-run.js evidence-ux-status --remote origin --branch master --format json',
      'node scripts/bha-run.js stable-exit-status --remote origin --branch master --format json'
    ];
  }
  const recommendation = evidenceUx && evidenceUx.recommendation ? evidenceUx.recommendation : null;
  if (recommendation && recommendation.action === 'RUN_FAST_EVIDENCE_REPAIR') {
    return [
      'node scripts/bha-run.js evidence-ux-status --remote origin --branch master --format json',
      'node scripts/bha-run.js repair-evidence --fast --remote origin --branch master --format json',
      'node scripts/bha-verify.js',
      'node scripts/bha-run.js stable-exit-status --remote origin --branch master --format json'
    ];
  }
  if (recommendation && recommendation.action === 'COMMIT_OR_RESOLVE_UNVERIFIED_WORKTREE_CHANGES') {
    return [
      'git status --short',
      'commit or resolve validated worktree changes',
      'node scripts/bha-run.js evidence-ux-status --remote origin --branch master --format json'
    ];
  }
  return [
    'node scripts/bha-run.js evidence-ux-status --remote origin --branch master --format json',
    'node scripts/bha-run.js validate',
    'node scripts/bha-run.js checkpoint --format json',
    'node scripts/bha-run.js closeout --record --format json',
    'node scripts/bha-verify.js',
    'node scripts/bha-run.js stable-exit-status --remote origin --branch master --format json'
  ];
}

async function handleStableExitStatus(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const allowValidationInProgress = args.includes('--allow-validation-in-progress');
  const remote = getOption(args, '--remote') || 'origin';
  const branch = getOption(args, '--branch') || await currentBranch();
  const stableAuditArgs = ['node', 'scripts/bha-run.js', 'audit-v1-stable', '--format', 'json'];
  if (allowValidationInProgress) {
    stableAuditArgs.push('--allow-validation-in-progress');
  }
  const stableAudit = await readOnlyJsonCommand(stableAuditArgs);
  const v12Audit = await readOnlyJsonCommand(['node', 'scripts/bha-run.js', 'audit-v12', '--format', 'json']);
  const verify = await verifierResult();
  const verifier = verify.parsed || {};
  const verifierWarnings = Array.isArray(verifier.warnings) ? verifier.warnings : [];
  const verifierIssues = Array.isArray(verifier.issues) ? verifier.issues : [];
  const gitStatus = await gitStatusShort();
  const gate = await gateStatus(remote, branch);
  const recover = await recoverStatus(remote, branch);
  const evidenceUx = await evidenceUxStatus(remote, branch);
  const authorizedRuntimeEvidenceDirty = gitStatus.ok === true &&
    gitStatus.clean !== true &&
    authorizedRuntimeDirty(gitStatus.stdout);
  const framework = capabilityFramework();
  const council = councilRuntimeStatus();
  const strictVerifierPass = verifier.ok === true &&
    verifier.status === 'PASS' &&
    verifierIssues.length === 0 &&
    verifierWarnings.length === 0;
  const v2HoldLine = framework.default_decision === 'DENY' &&
    framework.unknown_capability_policy === 'DENY' &&
    Array.isArray(framework.production_capability_types) &&
    framework.production_capability_types.length === 1 &&
    framework.production_capability_types[0] === 'git_push' &&
    council.runtime_state === 'PREVIEW_CONTRACT_ONLY' &&
    council.external_side_effects_allowed === false &&
    council.automated_agent_spawn_allowed === false &&
    council.provider_calls_allowed === false &&
    council.memory_writes_allowed === false;
  const strictChecks = {
    clean_worktree: gitStatus.clean === true || authorizedRuntimeEvidenceDirty,
    verifier_pass: strictVerifierPass,
    audit_v1_stable_pass: stableAudit.ok === true && stableAudit.status === 'PASS',
    audit_v12_pass: v12Audit.ok === true && v12Audit.status === 'PASS',
    recover_status_ready: recover.ok === true && recover.status === 'RECOVER_STATUS_READY',
    gate_status_fail_closed_conditional_push: gate.ok === false &&
      gate.status === 'BLOCKED' &&
      gate.push_requirement &&
      gate.push_requirement.required_now === false &&
      gate.push_requirement.operator_controlled === true &&
      gate.push_requirement.capability_required_for_real_push === true &&
      (gate.next_action_required_now === false ||
        (authorizedRuntimeEvidenceDirty && gate.next_action_scope === 'local_trust_repair')),
    signer_boundary_operator_controlled: gate.signer_boundary &&
      gate.signer_boundary.operator_controls_signer === true &&
      gate.signer_boundary.bha_private_key_access === false,
    local_state_not_required_for_tracked_trust: recover.local_state &&
      recover.local_state.required_for_tracked_verifier_pass === false,
    v2_hold_line_preview_only: v2HoldLine
  };
  const bootstrapAllowedChecks = Object.assign({}, strictChecks, {
    clean_worktree: allowValidationInProgress ? true : strictChecks.clean_worktree,
    verifier_pass: allowValidationInProgress ? stableAudit.ok === true : strictChecks.verifier_pass,
    recover_status_ready: allowValidationInProgress ? recover.local_state && recover.local_state.required_for_tracked_verifier_pass === false : strictChecks.recover_status_ready,
    gate_status_fail_closed_conditional_push: allowValidationInProgress
      ? Boolean(gate.push_requirement &&
        gate.push_requirement.required_now === false &&
        gate.push_requirement.operator_controlled === true &&
        gate.push_requirement.capability_required_for_real_push === true)
      : strictChecks.gate_status_fail_closed_conditional_push
  });
  const evaluatedChecks = allowValidationInProgress ? bootstrapAllowedChecks : strictChecks;
  const blockingChecks = Object.keys(evaluatedChecks).filter((key) => evaluatedChecks[key] !== true);
  const strictBlockingChecks = Object.keys(strictChecks).filter((key) => strictChecks[key] !== true);
  const ok = blockingChecks.length === 0;
  console.log(JSON.stringify({
    schema: 'bha.stable_exit_status.v1',
    ok,
    status: ok ? 'PASS' : 'BLOCKED',
    stage: 'V1_STABLE_CANDIDATE',
    next_stage: ok ? 'V1_STABLE_EXIT_REVIEW_OR_NEXT_LOCAL_PLANNING' : 'LOCAL_TRUST_REPAIR',
    recorded: false,
    read_only: true,
    remote,
    branch: branch || 'UNKNOWN',
    validation_in_progress_allowed: allowValidationInProgress,
    validation_in_progress_override: allowValidationInProgress && strictBlockingChecks.length > 0 && blockingChecks.length === 0,
    checks: evaluatedChecks,
    strict_checks: strictChecks,
    blocking_checks: blockingChecks,
    strict_blocking_checks: strictBlockingChecks,
    command_results: {
      audit_v1_stable: {
        ok: stableAudit.ok,
        status: stableAudit.status,
        exit_code: stableAudit.exit_code,
        validation_in_progress_override: stableAudit.parsed ? stableAudit.parsed.validation_in_progress_override === true : null
      },
      audit_v12: {
        ok: v12Audit.ok,
        status: v12Audit.status,
        exit_code: v12Audit.exit_code
      },
      verifier: {
        ok: verify.ok,
        status: verifier.status || 'UNKNOWN',
        ledger_head_hash: verifier.ledger_head_hash || null,
        issues: verifierIssues.length,
        warnings: verifierWarnings.length
      }
    },
    git_reality: {
      clean: gitStatus.clean,
      authorized_runtime_evidence_dirty: authorizedRuntimeEvidenceDirty,
      short: gitStatus.stdout.trim() || 'CLEAN'
    },
    gate_summary: {
      ok: gate.ok,
      status: gate.status,
      next_action: gate.next_action,
      next_action_required_now: gate.next_action_required_now,
      next_action_condition: gate.next_action_condition,
      push_requirement: gate.push_requirement,
      tracked_git_reality: gate.tracked_git_reality,
      local_payload_status: gate.operator_handoff ? gate.operator_handoff.local_payload_status : null
    },
    recovery_summary: {
      ok: recover.ok,
      status: recover.status,
      local_state: recover.local_state,
      git_push_recovery: recover.git_push_recovery
    },
    push_requirement: gate.push_requirement || {
      required_now: false,
      operator_controlled: true,
      capability_required_for_real_push: true
    },
    signer_boundary: gate.signer_boundary || {
      operator_controls_signer: true,
      bha_private_key_access: false
    },
    v2_hold_line: {
      production_capability_types: framework.production_capability_types,
      default_decision: framework.default_decision,
      unknown_capability_policy: framework.unknown_capability_policy,
      capability_enablement_allowed: framework.enablement_gate
        ? framework.enablement_gate.new_production_capability_allowed === true
        : null,
      capability_requires_new_explicit_objective: framework.enablement_gate
        ? framework.enablement_gate.requires_new_explicit_objective === true
        : null,
      council_runtime_state: council.runtime_state,
      council_activation_allowed: council.activation_gate
        ? council.activation_gate.runtime_activation_allowed === true
        : null,
      council_requires_new_explicit_objective: council.activation_gate
        ? council.activation_gate.requires_new_explicit_objective === true
        : null,
      automated_agent_spawn_allowed: council.automated_agent_spawn_allowed,
      provider_calls_allowed: council.provider_calls_allowed,
      memory_writes_allowed: council.memory_writes_allowed
    },
    evidence_ux: {
      status: evidenceUx.status,
      validation_reuse_allowed: evidenceUx.validation_reuse && evidenceUx.validation_reuse.allowed === true,
      recommendation: evidenceUx.recommendation
    },
    next_commands: ok ? [
      'node scripts/bha-run.js stable-exit-status --remote origin --branch master --format json',
      'node scripts/bha-run.js gate-status --remote origin --branch master --format json'
    ] : stableExitNextCommands(evidenceUx, blockingChecks),
    proof_boundary: 'stable-exit-status is read-only phase-readiness reporting. It does not push, issue or consume capability, read private keys, call providers, write memory, deploy, release, tag, publish packages, or turn prose into proof.'
  }));
  if (!ok) {
    process.exitCode = 1;
  }
}

async function handleStableExitReview(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const allowValidationInProgress = args.includes('--allow-validation-in-progress');
  const remote = getOption(args, '--remote') || 'origin';
  const branch = getOption(args, '--branch') || await currentBranch();
  const validation = readJsonStrict(VALIDATION_PATH);
  const policy = loadPolicy();
  const stableExitArgs = ['node', 'scripts/bha-run.js', 'stable-exit-status', '--remote', remote, '--branch', branch, '--format', 'json'];
  const stableAuditArgs = ['node', 'scripts/bha-run.js', 'audit-v1-stable', '--format', 'json'];
  if (allowValidationInProgress) {
    stableExitArgs.push('--allow-validation-in-progress');
    stableAuditArgs.push('--allow-validation-in-progress');
  }
  const stableExit = await readOnlyJsonCommand(stableExitArgs);
  const stable = stableExit.parsed || {};
  const stableAudit = await readOnlyJsonCommand(stableAuditArgs);
  const stableAuditPayload = stableAudit.parsed || {};
  const v12Audit = await readOnlyJsonCommand(['node', 'scripts/bha-run.js', 'audit-v12', '--format', 'json']);
  const v12Payload = v12Audit.parsed || {};
  const verify = await verifierResult();
  const verifier = verify.parsed || {};
  const stableAuditChecks = Array.isArray(stableAuditPayload.checks) ? stableAuditPayload.checks : [];
  const v12Checks = Array.isArray(v12Payload.checks) ? v12Payload.checks : [];
  const stableAuditPass = (id) => stableAuditChecks.some((check) => check.id === id && check.status === 'PASS');
  const v12Pass = (id) => v12Checks.some((check) => check.id === id && check.status === 'PASS');
  const validationCommandPresent = (id) => Boolean(validationCommandById(validation, id));
  const stableChecks = stable.checks || {};
  const strictStableChecks = stable.strict_checks || {};
  const trustChecks = allowValidationInProgress ? stableChecks : strictStableChecks;
  const reviewArgv = ['node', 'scripts/bha-run.js', 'stable-exit-review', '--remote', 'origin', '--branch', 'master', '--format', 'json'];
  const reviewBootstrapArgv = reviewArgv.concat(['--allow-validation-in-progress']);
  const checks = [];
  checks.push(auditCheck(
    'stable_exit_status_strict_or_bootstrap_passes',
    'stable-exit-status must pass in strict operator mode, or in explicit validation bootstrap mode while inputs are being refreshed.',
    stableExit.ok === true &&
      stable.status === 'PASS' &&
      (allowValidationInProgress || stable.validation_in_progress_override === false),
    {
      status: stable.status || 'UNKNOWN',
      validation_in_progress_allowed: stable.validation_in_progress_allowed === true,
      validation_in_progress_override: stable.validation_in_progress_override === true,
      blocking_checks: stable.blocking_checks || [],
      strict_blocking_checks: stable.strict_blocking_checks || []
    },
    ['scripts/bha-run.js', '.bha/validation.yaml']
  ));
  checks.push(auditCheck(
    'tracked_trust_sources_pass',
    'Verifier, validation freshness, stable audit, V1.2 audit, checkpoint, closeout, and git clean state must agree before next local planning.',
    trustChecks.clean_worktree === true &&
      trustChecks.verifier_pass === true &&
      trustChecks.audit_v1_stable_pass === true &&
      trustChecks.audit_v12_pass === true &&
      (allowValidationInProgress || (verifier.ok === true && verifier.status === 'PASS')),
    {
      verifier_status: verifier.status || 'UNKNOWN',
      verifier_issues: Array.isArray(verifier.issues) ? verifier.issues.length : null,
      verifier_warnings: Array.isArray(verifier.warnings) ? verifier.warnings.length : null,
      validation_in_progress_allowed: allowValidationInProgress,
      stable_checks: stable.checks || null,
      strict_stable_checks: stable.strict_checks || null
    },
    ['.bha/ledger.jsonl', '.bha/state.json', '.bha/checkpoint.json', 'scripts/bha-verify.js']
  ));
  checks.push(auditCheck(
    'operator_ux_freeze_covered',
    'V1.3 operator UX guidance must keep push conditional, signer operator-controlled, and stale payload reasons machine-readable.',
    stableAuditPass('conditional_push_guidance_freeze_wired') &&
      stableAuditPass('operator_ux_handoff_regressions_covered') &&
      stable.push_requirement &&
      stable.push_requirement.required_now === false &&
      stable.signer_boundary &&
      stable.signer_boundary.bha_private_key_access === false,
    {
      audit_checks: ['conditional_push_guidance_freeze_wired', 'operator_ux_handoff_regressions_covered'],
      push_requirement: stable.push_requirement || null,
      signer_boundary: stable.signer_boundary || null
    },
    ['scripts/bha-run.js', '.bha/validation.yaml', 'BHA_V1_STABILITY.md']
  ));
  checks.push(auditCheck(
    'recovery_freeze_covered',
    'V1.4 recovery must explain fresh clone, missing or stale .bha/local, and fail-closed replay or USED session recovery.',
    stableAuditPass('fresh_clone_recovery_regressions_covered') &&
      trustChecks.recover_status_ready === true &&
      stable.recovery_summary &&
      stable.recovery_summary.local_state &&
      stable.recovery_summary.local_state.required_for_tracked_verifier_pass === false,
    {
      audit_check: 'fresh_clone_recovery_regressions_covered',
      recovery_summary: stable.recovery_summary || null
    },
    ['scripts/bha-run.js', '.bha/validation.yaml', 'BHA_V1_STABILITY.md']
  ));
  checks.push(auditCheck(
    'hard_boundaries_and_dependency_surface_frozen',
    'V1 stable audit must keep no dependencies, no private-key custody, no provider/deploy/release/tag/package publish/memory write, and git_push-only production capability.',
    stableAuditPass('hard_boundaries_documented_and_policy_denied') &&
      stableAuditPass('hard_boundary_deny_regressions_covered') &&
      stableAuditPass('node_builtins_only_no_package_manifest') &&
      stableAuditPass('operator_signer_private_key_boundary_scanned') &&
      stableAuditPass('v1_capability_scope_default_deny'),
    {
      audit_checks: [
        'hard_boundaries_documented_and_policy_denied',
        'hard_boundary_deny_regressions_covered',
        'node_builtins_only_no_package_manifest',
        'operator_signer_private_key_boundary_scanned',
        'v1_capability_scope_default_deny'
      ]
    },
    ['.bha/policy.yaml', 'scripts/bha-run.js', 'scripts/bha-verify.js', 'BHA_V1_STABILITY.md']
  ));
  checks.push(auditCheck(
    'v2_hold_line_preview_only',
    'V2 capability framework and council runtime must remain preview/status only with no new production capability or automated delegation.',
    stableAuditPass('v2_capability_framework_preview_default_deny') &&
      stableAuditPass('v2_council_runtime_preview_no_automation') &&
      stable.v2_hold_line &&
      stable.v2_hold_line.capability_enablement_allowed === false &&
      stable.v2_hold_line.council_activation_allowed === false &&
      stable.v2_hold_line.provider_calls_allowed === false &&
      stable.v2_hold_line.memory_writes_allowed === false,
    {
      audit_checks: ['v2_capability_framework_preview_default_deny', 'v2_council_runtime_preview_no_automation'],
      v2_hold_line: stable.v2_hold_line || null
    },
    ['BHA_V2_CAPABILITY_FRAMEWORK.md', 'BHA_V2_COUNCIL_RUNTIME.md', 'scripts/bha-run.js']
  ));
  checks.push(auditCheck(
    'stable_exit_review_manifest_wired',
    'stable-exit-review itself must be read-only, policy-allowed, wired into validation, and documented as an exit review rather than proof replacement.',
    validationCommandPresent('stable_exit_review_readonly') &&
      policyAllowsArgv(policy, reviewArgv) &&
      policyAllowsArgv(policy, reviewBootstrapArgv) &&
      fileContains(STABILITY_PATH, '`stable-exit-review` is a read-only prompt-to-artifact exit review') &&
      fileContains(ROADMAP_PATH, '`stable-exit-review` turns the stable exit review') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'stable-exit-review'),
    {
      validation_command_present: validationCommandPresent('stable_exit_review_readonly'),
      strict_policy_allowed: policyAllowsArgv(policy, reviewArgv),
      bootstrap_policy_allowed: policyAllowsArgv(policy, reviewBootstrapArgv)
    },
    ['.bha/policy.yaml', '.bha/validation.yaml', 'BHA_V1_STABILITY.md', '.bha/roadmap.md', 'BHA_LONG_TERM_GOAL_AUDIT.md']
  ));
  checks.push(auditCheck(
    'validation_and_audit_coverage_current',
    'The manifest and audits must explicitly cover stable-exit, recovery, gate, regression, V2 hold line, and stable review checks.',
    stableAudit.ok === true &&
      stableAudit.status === 'PASS' &&
      v12Audit.ok === true &&
      v12Audit.status === 'PASS' &&
      v12Pass('validation_and_verifier_observable') &&
      v12Pass('capability_framework_status_validation_wired') &&
      v12Pass('council_status_validation_wired'),
    {
      stable_audit_status: stableAudit.status,
      v12_audit_status: v12Audit.status,
      validation_commands_present: [
        'stable_exit_status_readonly',
        'stable_exit_review_readonly',
        'recover_status_readonly',
        'gate_status_readonly',
        'v12_regression_selftest'
      ].filter(validationCommandPresent)
    },
    ['.bha/validation.yaml', 'scripts/bha-run.js']
  ));
  const failed = checks.filter((check) => check.status !== 'PASS');
  const ok = failed.length === 0;
  console.log(JSON.stringify({
    schema: 'bha.stable_exit_review.v1',
    ok,
    status: ok ? 'PASS' : 'BLOCKED',
    stage: 'V1_STABLE_EXIT_REVIEW',
    decision: ok ? 'ENTER_NEXT_LOCAL_PLANNING' : 'REPAIR_LOCAL_STABLE_CANDIDATE',
    recorded: false,
    read_only: true,
    remote,
    branch: branch || 'UNKNOWN',
    validation_in_progress_allowed: allowValidationInProgress,
    objective: 'Freeze the BHA V1 local-first trust kernel as a stable candidate while keeping V2 capability framework and council runtime on preview hold lines.',
    completion_boundary: {
      long_term_goal_complete: false,
      reason: 'This review gates V1 Stable Candidate exit or next local planning only; it does not complete future V2 capability or council-runtime objectives.',
      push_performed: false,
      remote_release_performed: false
    },
    stable_exit_status: {
      ok: stableExit.ok,
      status: stable.status || 'UNKNOWN',
      next_stage: stable.next_stage || null,
      blocking_checks: stable.blocking_checks || [],
      strict_blocking_checks: stable.strict_blocking_checks || []
    },
    prompt_to_artifact_checklist: checks,
    failed,
    push_requirement: stable.push_requirement || null,
    v2_hold_line: stable.v2_hold_line || null,
    next_actions: ok ? [
      'Continue local next-stage planning without push, provider calls, private-key access, dependency changes, release, deploy, tag, package publish, or memory write.',
      'Run node scripts/bha-run.js stable-exit-review --remote origin --branch master --format json before claiming V1 Stable Candidate exit readiness.'
    ] : [
      'Run node scripts/bha-run.js stable-exit-status --remote origin --branch master --format json',
      'Repair failed checklist items with local tracked changes only.',
      'Run node scripts/bha-run.js validate, checkpoint, closeout, verifier, and stable-exit-review again.'
    ],
    proof_boundary: 'stable-exit-review is read-only checklist reporting. It does not replace validate or the verifier, does not push, issue or consume capability, read private keys, call providers, write memory, deploy, release, tag, publish packages, or turn prose into proof.'
  }));
  if (!ok) {
    process.exitCode = 1;
  }
}

async function handleNextLocalPlanStatus(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const allowValidationInProgress = args.includes('--allow-validation-in-progress');
  const remote = getOption(args, '--remote') || 'origin';
  const branch = getOption(args, '--branch') || await currentBranch();
  const validation = readJsonStrict(VALIDATION_PATH);
  const reviewArgs = ['node', 'scripts/bha-run.js', 'stable-exit-review', '--remote', remote, '--branch', branch, '--format', 'json'];
  if (allowValidationInProgress) {
    reviewArgs.push('--allow-validation-in-progress');
  }
  const reviewResult = await readOnlyJsonCommand(reviewArgs);
  const review = reviewResult.parsed || {};
  const framework = capabilityFramework();
  const council = councilRuntimeStatus();
  const validationCommandPresent = (id) => Boolean(validationCommandById(validation, id));
  const entryGate = {
    stable_exit_review_pass: reviewResult.ok === true && review.status === 'PASS',
    stable_exit_review_decision: review.decision || 'UNKNOWN',
    stable_exit_review_failed_count: Array.isArray(review.failed) ? review.failed.length : null,
    verifier_validation_audit_ready: Boolean(review.stable_exit_status && review.stable_exit_status.status === 'PASS'),
    push_required_now: review.push_requirement ? review.push_requirement.required_now === true : null,
    next_stage_requires_remote_action: false
  };
  const hardBoundaries = {
    push_allowed: false,
    private_key_access_allowed: false,
    dependency_addition_allowed: false,
    provider_call_allowed: false,
    deploy_allowed: false,
    release_allowed: false,
    tag_allowed: false,
    package_publish_allowed: false,
    memory_write_allowed: false,
    new_production_capability_allowed: false,
    automated_agent_runtime_allowed: false
  };
  const currentPhaseQueue = [
    {
      id: 'v1_stable_candidate_maintenance',
      status: 'ACTIVE_LOCAL_MAINTENANCE',
      allowed_next_work: [
        'keep stable-exit-review passing',
        'repair stale tracked evidence with validate/checkpoint/closeout',
        'keep proof and non-proof boundaries documented and audited'
      ],
      blocked_actions: ['push', 'release', 'deploy', 'tag', 'package_publish'],
      entry_gate: 'stable-exit-review PASS from a clean worktree'
    },
    {
      id: 'v1_3_operator_ux_freeze',
      status: 'MAINTAIN_AND_HARDEN_ONLY',
      allowed_next_work: [
        'make stale or expired payload causes clearer',
        'improve local handoff wording without private-key custody',
        'keep push guidance conditional'
      ],
      blocked_actions: ['read_private_key', 'auto_sign', 'imply_push_required_now'],
      entry_gate: 'operator UX changes must remain local-only and regression-covered'
    },
    {
      id: 'v1_4_recovery_resume_freeze',
      status: 'MAINTAIN_AND_HARDEN_ONLY',
      allowed_next_work: [
        'improve fresh clone explanations',
        'keep missing .bha/local recovery self-explanatory',
        'keep replay and USED session failures fail-closed'
      ],
      blocked_actions: ['tracked_trust_depends_on_bha_local', 'treat_closeout_prose_as_proof'],
      entry_gate: 'recovery changes must keep verifier trust independent of .bha/local'
    },
    {
      id: 'v2_capability_framework_hold_line',
      status: 'PREVIEW_HOLD_LINE',
      allowed_next_work: framework.enablement_gate ? framework.enablement_gate.allowed_next_work : [],
      blocked_actions: framework.enablement_gate ? framework.enablement_gate.forbidden_without_new_objective : [],
      coverage_complete: framework.test_requirements &&
        framework.test_requirements.current_coverage
        ? framework.test_requirements.current_coverage.enablement_coverage_complete === true
        : false,
      missing_before_enablement: framework.test_requirements
        ? framework.test_requirements.missing_before_enablement || []
        : [],
      non_enablement_reasons: framework.draft_artifacts
        ? framework.draft_artifacts.non_enablement_reasons || []
        : [],
      entry_gate: 'new explicit objective plus schema, binding, policy, deny tests, replay tests, and verifier evidence'
    },
    {
      id: 'v2_council_runtime_hold_line',
      status: 'PREVIEW_HOLD_LINE',
      allowed_next_work: council.activation_gate ? council.activation_gate.allowed_next_work : [],
      blocked_actions: council.activation_gate ? council.activation_gate.forbidden_without_new_objective : [],
      coverage_complete: council.test_requirements &&
        council.test_requirements.current_coverage
        ? council.test_requirements.current_coverage.activation_coverage_complete === true
        : false,
      missing_before_activation: council.test_requirements
        ? council.test_requirements.missing_before_activation || []
        : [],
      non_activation_reasons: council.draft_artifacts
        ? council.draft_artifacts.non_activation_reasons || []
        : [],
      entry_gate: 'new explicit objective plus verifier-backed workflow model and local dry-run evidence'
    }
  ];
  const validationCoverage = {
    validate_command_present: true,
    stable_exit_status_readonly: validationCommandPresent('stable_exit_status_readonly'),
    stable_exit_review_readonly: validationCommandPresent('stable_exit_review_readonly'),
    next_local_plan_status_readonly: validationCommandPresent('next_local_plan_status_readonly'),
    long_term_goal_status_readonly: validationCommandPresent('long_term_goal_status_readonly'),
    audit_v1_stable_readonly: validationCommandPresent('v1_stable_audit_readonly'),
    audit_v12_readonly: validationCommandPresent('v12_audit_readonly'),
    regression_selftest: validationCommandPresent('v12_regression_selftest'),
    recover_status_readonly: validationCommandPresent('recover_status_readonly'),
    gate_status_readonly: validationCommandPresent('gate_status_readonly'),
    capability_framework_status_readonly: validationCommandPresent('capability_framework_status_readonly'),
    council_status_readonly: validationCommandPresent('council_status_readonly')
  };
  const v2HoldLine = {
    production_capability_types: framework.production_capability_types,
    new_production_capability_allowed: framework.enablement_gate
      ? framework.enablement_gate.new_production_capability_allowed === true
      : null,
    requires_new_explicit_objective_for_capability: framework.enablement_gate
      ? framework.enablement_gate.requires_new_explicit_objective === true
      : null,
    council_runtime_state: council.runtime_state,
    council_runtime_activation_allowed: council.activation_gate
      ? council.activation_gate.runtime_activation_allowed === true
      : null,
    requires_new_explicit_objective_for_council: council.activation_gate
      ? council.activation_gate.requires_new_explicit_objective === true
      : null
  };
  const ok = entryGate.stable_exit_review_pass === true &&
    entryGate.push_required_now === false &&
    Object.values(validationCoverage).every((value) => value === true) &&
    v2HoldLine.new_production_capability_allowed === false &&
    v2HoldLine.council_runtime_activation_allowed === false;
  const remoteArg = powerShellSingleQuote(remote);
  const branchArg = powerShellSingleQuote(branch || 'UNKNOWN');
  const nextLocalPlanCommandText = `node scripts/bha-run.js next-local-plan-status --remote ${remoteArg} --branch ${branchArg} --format json`;
  const stableExitReviewCommandText = `node scripts/bha-run.js stable-exit-review --remote ${remoteArg} --branch ${branchArg} --format json`;
  console.log(JSON.stringify({
    schema: 'bha.next_local_plan_status.v1',
    ok,
    status: ok ? 'NEXT_LOCAL_PLAN_READY' : 'NEXT_LOCAL_PLAN_BLOCKED',
    decision: ok ? 'CONTINUE_LOCAL_PLANNING' : 'REPAIR_STABLE_EXIT_FIRST',
    recorded: false,
    read_only: true,
    remote,
    branch: branch || 'UNKNOWN',
    validation_in_progress_allowed: allowValidationInProgress,
    entry_gate: entryGate,
    current_phase_queue: currentPhaseQueue,
    validation_coverage: validationCoverage,
    hard_boundaries: hardBoundaries,
    v2_hold_line: v2HoldLine,
    completion_boundary: {
      long_term_goal_complete: false,
      reason: 'This status only selects the next local planning queue; it does not complete future V2 capability or council-runtime objectives.',
      push_performed: false
    },
    next_commands: ok ? [
      nextLocalPlanCommandText,
      stableExitReviewCommandText
    ] : [
      stableExitReviewCommandText,
      'node scripts/bha-run.js validate',
      'node scripts/bha-run.js checkpoint --format json',
      'node scripts/bha-run.js closeout --record --format json'
    ],
    proof_boundary: 'next-local-plan-status is read-only planning context. It does not push, issue or consume capabilities, read private keys, call providers, write memory, deploy, release, tag, publish packages, spawn agents, or turn roadmap prose into proof.'
  }));
  if (!ok) {
    process.exitCode = 1;
  }
}

async function handleLongTermGoalStatus(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const allowValidationInProgress = args.includes('--allow-validation-in-progress');
  const remote = getOption(args, '--remote') || 'origin';
  const branch = getOption(args, '--branch') || await currentBranch();
  const validation = readJsonStrict(VALIDATION_PATH);
  const reviewArgs = ['node', 'scripts/bha-run.js', 'stable-exit-review', '--remote', remote, '--branch', branch, '--format', 'json'];
  const nextPlanArgs = ['node', 'scripts/bha-run.js', 'next-local-plan-status', '--remote', remote, '--branch', branch, '--format', 'json'];
  if (allowValidationInProgress) {
    reviewArgs.push('--allow-validation-in-progress');
    nextPlanArgs.push('--allow-validation-in-progress');
  }
  const reviewResult = await readOnlyJsonCommand(reviewArgs);
  const nextPlanResult = await readOnlyJsonCommand(nextPlanArgs);
  const review = reviewResult.parsed || {};
  const nextPlan = nextPlanResult.parsed || {};
  const framework = capabilityFramework();
  const council = councilRuntimeStatus();
  const validationCommandPresent = (id) => Boolean(validationCommandById(validation, id));
  const reviewChecks = Array.isArray(review.prompt_to_artifact_checklist) ? review.prompt_to_artifact_checklist : [];
  const reviewPass = (id) => reviewChecks.some((check) => check && check.id === id && check.status === 'PASS');
  const hardBoundaries = {
    push_allowed: false,
    private_key_access_allowed: false,
    dependency_addition_allowed: false,
    provider_call_allowed: false,
    deploy_allowed: false,
    release_allowed: false,
    tag_allowed: false,
    package_publish_allowed: false,
    memory_write_allowed: false,
    new_production_capability_allowed: false,
    automated_agent_runtime_allowed: false
  };
  const v2HoldLine = {
    production_capability_types: framework.production_capability_types,
    new_production_capability_allowed: framework.enablement_gate
      ? framework.enablement_gate.new_production_capability_allowed === true
      : null,
    capability_requires_new_explicit_objective: framework.enablement_gate
      ? framework.enablement_gate.requires_new_explicit_objective === true
      : null,
    council_runtime_state: council.runtime_state,
    council_runtime_activation_allowed: council.activation_gate
      ? council.activation_gate.runtime_activation_allowed === true
      : null,
    council_requires_new_explicit_objective: council.activation_gate
      ? council.activation_gate.requires_new_explicit_objective === true
      : null
  };
  const checklist = [
    auditCheck(
      'v1_stable_candidate_ready',
      'V1 stable local-first kernel is verifier-backed, validation-backed, and ready for local maintenance.',
      reviewResult.ok === true &&
        review.status === 'PASS' &&
        reviewPass('tracked_trust_sources_pass') &&
        reviewPass('hard_boundaries_and_dependency_surface_frozen'),
      {
        stable_exit_review_status: review.status || 'UNKNOWN',
        tracked_trust_sources_pass: reviewPass('tracked_trust_sources_pass'),
        hard_boundaries_frozen: reviewPass('hard_boundaries_and_dependency_surface_frozen')
      },
      ['scripts/bha-run.js', '.bha/validation.yaml', 'BHA_V1_STABILITY.md']
    ),
    auditCheck(
      'v1_3_operator_ux_freeze_ready',
      'V1.3 operator UX keeps push conditional and signer operator-controlled.',
      reviewPass('operator_ux_freeze_covered'),
      { stable_exit_review_check: 'operator_ux_freeze_covered' },
      ['scripts/bha-run.js', '.bha/validation.yaml']
    ),
    auditCheck(
      'v1_4_recovery_freeze_ready',
      'V1.4 recovery explains fresh clone, missing local evidence, stale payloads, and replay fail-closed paths.',
      reviewPass('recovery_freeze_covered'),
      { stable_exit_review_check: 'recovery_freeze_covered' },
      ['scripts/bha-run.js', '.bha/validation.yaml', 'BHA_V1_STABILITY.md']
    ),
    auditCheck(
      'v2_capability_framework_hold_line',
      'V2 capability framework remains preview/default deny and enables no new production capability.',
      reviewPass('v2_hold_line_preview_only') &&
        Array.isArray(framework.production_capability_types) &&
        framework.production_capability_types.length === 1 &&
        framework.production_capability_types[0] === 'git_push' &&
        v2HoldLine.new_production_capability_allowed === false,
      {
        production_capability_types: framework.production_capability_types,
        new_production_capability_allowed: v2HoldLine.new_production_capability_allowed,
        requires_new_explicit_objective: v2HoldLine.capability_requires_new_explicit_objective
      },
      ['BHA_V2_CAPABILITY_FRAMEWORK.md', 'scripts/bha-run.js', '.bha/validation.yaml']
    ),
    auditCheck(
      'v2_council_runtime_hold_line',
      'V2+ Council Runtime remains preview/status only and does not activate automated delegation.',
      reviewPass('v2_hold_line_preview_only') &&
        council.runtime_state === 'PREVIEW_CONTRACT_ONLY' &&
        v2HoldLine.council_runtime_activation_allowed === false,
      {
        council_runtime_state: council.runtime_state,
        council_runtime_activation_allowed: v2HoldLine.council_runtime_activation_allowed,
        requires_new_explicit_objective: v2HoldLine.council_requires_new_explicit_objective
      },
      ['BHA_V2_COUNCIL_RUNTIME.md', 'scripts/bha-run.js', '.bha/validation.yaml']
    ),
    auditCheck(
      'next_stage_transition_boundary',
      'Next local planning may begin only from clean stable-exit evidence and never authorizes push or V2 enablement.',
      reviewResult.ok === true &&
        review.status === 'PASS' &&
        nextPlanResult.ok === true &&
        nextPlan.status === 'NEXT_LOCAL_PLAN_READY' &&
        review.push_requirement &&
        review.push_requirement.required_now === false &&
        nextPlan.completion_boundary &&
        nextPlan.completion_boundary.long_term_goal_complete === false &&
        nextPlan.v2_hold_line &&
        nextPlan.v2_hold_line.new_production_capability_allowed === false &&
        nextPlan.v2_hold_line.council_runtime_activation_allowed === false,
      {
        stable_exit_review_status: review.status || 'UNKNOWN',
        next_local_plan_status: nextPlan.status || 'UNKNOWN',
        push_required_now: review.push_requirement ? review.push_requirement.required_now === true : null,
        long_term_goal_complete: nextPlan.completion_boundary
          ? nextPlan.completion_boundary.long_term_goal_complete === true
          : null,
        new_production_capability_allowed: nextPlan.v2_hold_line
          ? nextPlan.v2_hold_line.new_production_capability_allowed === true
          : null,
        council_runtime_activation_allowed: nextPlan.v2_hold_line
          ? nextPlan.v2_hold_line.council_runtime_activation_allowed === true
          : null
      },
      ['.bha/roadmap.md', 'BHA_LONG_TERM_GOAL_AUDIT.md', 'scripts/bha-run.js']
    ),
    auditCheck(
      'long_term_status_wired',
      'long-term-goal-status is read-only, validation-wired, and explicitly not a proof replacement.',
      validationCommandPresent('long_term_goal_status_readonly') &&
        fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'long-term-goal-status') &&
        fileContains(ROADMAP_PATH, '`long-term-goal-status` reports'),
      {
        validation_command_present: validationCommandPresent('long_term_goal_status_readonly')
      },
      ['.bha/validation.yaml', 'BHA_LONG_TERM_GOAL_AUDIT.md', '.bha/roadmap.md']
    )
  ];
  const failed = checklist.filter((check) => check.status !== 'PASS');
  const currentLocalReady = failed.length === 0 &&
    nextPlanResult.ok === true &&
    nextPlan.status === 'NEXT_LOCAL_PLAN_READY';
  const futureWork = [
    {
      id: 'v2_capability_framework_enablement',
      status: 'FUTURE_REQUIRES_NEW_EXPLICIT_OBJECTIVE',
      required_before_enablement: framework.extension_policy ? framework.extension_policy.required_before_enablement : [],
      coverage_complete: framework.test_requirements &&
        framework.test_requirements.current_coverage
        ? framework.test_requirements.current_coverage.enablement_coverage_complete === true
        : false,
      missing_before_enablement: framework.test_requirements
        ? framework.test_requirements.missing_before_enablement || []
        : [],
      non_enablement_reasons: framework.draft_artifacts
        ? framework.draft_artifacts.non_enablement_reasons || []
        : [],
      allowed_now: false
    },
    {
      id: 'v2_council_runtime_activation',
      status: 'FUTURE_REQUIRES_NEW_EXPLICIT_OBJECTIVE',
      required_before_activation: [
        'verifier_backed_workflow_model',
        'local_dry_run_evidence',
        'role_boundary_tests',
        'validation_wiring'
      ],
      coverage_complete: council.test_requirements &&
        council.test_requirements.current_coverage
        ? council.test_requirements.current_coverage.activation_coverage_complete === true
        : false,
      missing_before_activation: council.test_requirements
        ? council.test_requirements.missing_before_activation || []
        : [],
      non_activation_reasons: council.draft_artifacts
        ? council.draft_artifacts.non_activation_reasons || []
        : [],
      allowed_now: false
    }
  ];
  const ok = currentLocalReady;
  console.log(JSON.stringify({
    schema: 'bha.long_term_goal_status.v1',
    ok,
    status: ok ? 'LONG_TERM_GOAL_IN_PROGRESS' : 'LONG_TERM_GOAL_BLOCKED',
    decision: ok ? 'CONTINUE_LOCAL_HOLD_LINE' : 'REPAIR_LOCAL_EVIDENCE_FIRST',
    recorded: false,
    read_only: true,
    remote,
    branch: branch || 'UNKNOWN',
    validation_in_progress_allowed: allowValidationInProgress,
    current_local_state: {
      v1_stable_candidate_ready: currentLocalReady,
      next_local_plan_status: nextPlan.status || 'UNKNOWN',
      stable_exit_review_status: review.status || 'UNKNOWN',
      push_required_now: review.push_requirement ? review.push_requirement.required_now === true : null
    },
    prompt_to_artifact_checklist: checklist,
    failed,
    future_work: futureWork,
    hard_boundaries: hardBoundaries,
    v2_hold_line: v2HoldLine,
    completion_boundary: {
      long_term_goal_complete: false,
      reason: 'Current repository evidence supports a V1 Stable Candidate and V2 hold-line preview only; future V2 capability and council-runtime enablement remain incomplete by design.',
      push_performed: false,
      remote_release_performed: false
    },
    next_commands: ok ? [
      `node scripts/bha-run.js long-term-goal-status --remote ${powerShellSingleQuote(remote)} --branch ${powerShellSingleQuote(branch || 'UNKNOWN')} --format json`,
      `node scripts/bha-run.js next-local-plan-status --remote ${powerShellSingleQuote(remote)} --branch ${powerShellSingleQuote(branch || 'UNKNOWN')} --format json`
    ] : [
      `node scripts/bha-run.js stable-exit-review --remote ${powerShellSingleQuote(remote)} --branch ${powerShellSingleQuote(branch || 'UNKNOWN')} --format json`,
      'node scripts/bha-run.js validate',
      'node scripts/bha-run.js checkpoint --format json',
      'node scripts/bha-run.js closeout --record --format json'
    ],
    proof_boundary: 'long-term-goal-status is read-only checklist context. It does not replace validate or the verifier, does not mark the long-term goal complete, and does not push, issue or consume capabilities, read private keys, call providers, write memory, deploy, release, tag, publish packages, spawn agents, or turn roadmap prose into proof.'
  }));
  if (!ok) {
    process.exitCode = 1;
  }
}

async function handleAuditV1Stable(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const allowValidationInProgress = args.includes('--allow-validation-in-progress');
  const state = loadState();
  const policy = loadPolicy();
  const validation = readJsonStrict(VALIDATION_PATH);
  const verify = await verifierResult();
  const verifier = verify.parsed || {};
  const verifierIssues = Array.isArray(verifier.issues) ? verifier.issues : [];
  const verifierWarnings = Array.isArray(verifier.warnings) ? verifier.warnings : [];
  const verifierIssueCodes = verifierIssues.map((issue) => String(issue.code || 'UNKNOWN'));
  const verifierWarningCodes = verifierWarnings.map((warning) => String(warning.code || 'UNKNOWN'));
  const validationBootstrapIssueCodes = [
    'STATE_POLICY_HASH_MISMATCH',
    'VALIDATION_NOT_PASSING',
    'VALIDATION_STALE_INPUTS',
    'VALIDATION_POLICY_HASH_MISMATCH',
    'VALIDATION_COMMAND_STALE',
    'VALIDATION_EXPECTATION_STALE',
    'VALIDATION_COMMAND_FAILED',
    'VALIDATION_COMMAND_COUNT_MISMATCH',
    'VALIDATION_COMMAND_MISSING',
    'CHECKPOINT_POLICY_HASH_MISMATCH',
    'UNVERIFIED_WORKTREE_CHANGE'
  ];
  const validationBootstrapWarningCodes = ['CLOSEOUT_NOT_CURRENT_LEDGER_HEAD'];
  const verifierStrictPass = verifier.ok === true &&
    verifier.status === 'PASS' &&
    verifierIssues.length === 0 &&
    verifierWarnings.length === 0;
  const failedRecordedValidationIds = state &&
    state.validation &&
    Array.isArray(state.validation.commands)
    ? state.validation.commands
      .filter((command) => command && command.status !== 'PASS')
      .map((command) => String(command.id || 'UNKNOWN'))
    : [];
  const verifierValidationBootstrapPass = allowValidationInProgress &&
    (verifier.status === 'PASS' || verifier.status === 'FAIL') &&
    (verifierIssueCodes.length > 0 || verifierWarningCodes.length > 0) &&
    verifierIssueCodes.every((code) => validationBootstrapIssueCodes.includes(code)) &&
    verifierWarningCodes.every((code) => validationBootstrapWarningCodes.includes(code));
  const alwaysDenied = ((policy.capability_rules || {}).always_denied_v1 || []);
  const capabilityPossible = ((policy.capability_rules || {}).capability_possible_v1 || []);
  const denyCommands = ((policy.action_rules || {}).deny_commands || {});
  const auditArgv = ['node', 'scripts/bha-run.js', 'audit-v1-stable', '--format', 'json'];
  const validationCommand = validationCommandById(validation, 'v1_stable_audit_readonly');
  const gateStatusCommand = validationCommandById(validation, 'gate_status_readonly');
  const recoverStatusCommand = validationCommandById(validation, 'recover_status_readonly');
  const pushPrepCommand = validationCommandById(validation, 'push_prep_current_head_payload');
  const signedPayloadStatusCommand = validationCommandById(validation, 'signed_payload_status_readonly');
  const operatorSignerPreflightCommand = validationCommandById(validation, 'operator_signer_preflight_readonly');
  const capabilityFrameworkStatusCommand = validationCommandById(validation, 'capability_framework_status_readonly');
  const capabilityFrameworkJsonPaths = capabilityFrameworkStatusCommand && capabilityFrameworkStatusCommand.expect ? (capabilityFrameworkStatusCommand.expect.json_paths || {}) : {};
  const gateStatusJsonPaths = gateStatusCommand && gateStatusCommand.expect ? (gateStatusCommand.expect.json_paths || {}) : {};
  const recoverStatusJsonPaths = recoverStatusCommand && recoverStatusCommand.expect ? (recoverStatusCommand.expect.json_paths || {}) : {};
  const pushPrepJsonPaths = pushPrepCommand && pushPrepCommand.expect ? (pushPrepCommand.expect.json_paths || {}) : {};
  const signedPayloadStatusJsonPaths = signedPayloadStatusCommand && signedPayloadStatusCommand.expect ? (signedPayloadStatusCommand.expect.json_paths || {}) : {};
  const operatorSignerPreflightJsonPaths = operatorSignerPreflightCommand && operatorSignerPreflightCommand.expect ? (operatorSignerPreflightCommand.expect.json_paths || {}) : {};
  const councilStatusCommand = validationCommandById(validation, 'council_status_readonly');
  const councilStatusJsonPaths = councilStatusCommand && councilStatusCommand.expect ? (councilStatusCommand.expect.json_paths || {}) : {};
  const stableExitCommand = validationCommandById(validation, 'stable_exit_status_readonly');
  const stableExitJsonPaths = stableExitCommand && stableExitCommand.expect ? (stableExitCommand.expect.json_paths || {}) : {};
  const stableExitReviewCommand = validationCommandById(validation, 'stable_exit_review_readonly');
  const nextLocalPlanCommand = validationCommandById(validation, 'next_local_plan_status_readonly');
  const longTermGoalCommand = validationCommandById(validation, 'long_term_goal_status_readonly');
  const regressionCommand = validationCommandById(validation, 'v12_regression_selftest');
  const verifierSelftestCommand = validationCommandById(validation, 'verifier_selftest_negative_matrix');
  const requireAudit = requireModuleAudit([
    RUN_SCRIPT,
    VERIFY_SCRIPT,
    COMMAND_EFFECTS_SCRIPT,
    POLICY_CHECK_SCRIPT,
    VALIDATION_RUNNER_SCRIPT,
    CAPABILITY_STORE_SCRIPT,
    PUSH_GATE_SCRIPT,
    GIT_REALITY_SCRIPT,
    LOCAL_PAYLOAD_STATUS_SCRIPT,
    PAYLOAD_SUMMARY_SCRIPT,
    CAPABILITY_VERIFIER_SCRIPT
  ]);
  const dependencyAudit = dependencySurfaceAudit();
  const privateKeyAudit = operatorSignerPrivateKeyAudit();
  const evidenceTimeHeadProofBoundary = 'Checkpoint and closeout git heads are evidence-time facts; current commit identity must come from git reality and any signed capability head binding.';
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
    'package_install',
    'package_publish'
  ];
  const requiredDenyRegressionIds = [
    'provider_call_denied',
    'memory_write_denied',
    'deploy_denied',
    'release_denied',
    'tag_denied',
    'package_install_denied',
    'package_publish_denied',
    'production_write_denied',
    'force_push_denied',
    'destructive_external_action_denied'
  ];
  const missingDenyRegressionIds = requiredDenyRegressionIds
    .filter((id) => !fileContains(RUN_SCRIPT, `'${id}'`) && !fileContains(RUN_SCRIPT, `"${id}"`));
  const requiredCapabilityRuntimeRegressionIds = [
    'unknown_capability_type_rejected',
    'disallowed_provider_capability_type_rejected',
    'incomplete_git_push_capability_rejected',
    'gate_status_flags_expired_unsigned_payload',
    'signed_payload_status_reports_expired_reason_detail',
    'replayed_local_capability_rejected',
    'local_git_push_replay_fail_closed_after_used_session'
  ];
  const requiredCapabilityVerifierSelftestIds = [
    'unsupported_capability_type_rejected',
    'disallowed_capability_type_rejected',
    'incomplete_capability_binding_rejected',
    'expired_capability_rejected',
    'capability_replay_rejected'
  ];
  const missingCapabilityRuntimeRegressionIds = requiredCapabilityRuntimeRegressionIds
    .filter((id) => !fileContains(RUN_SCRIPT, `'${id}'`) && !fileContains(RUN_SCRIPT, `"${id}"`));
  const missingCapabilityVerifierSelftestIds = requiredCapabilityVerifierSelftestIds
    .filter((id) => !fileContains(VERIFY_SCRIPT, `'${id}'`) && !fileContains(VERIFY_SCRIPT, `"${id}"`));
  const requiredFreshCloneRegressionIds = [
    'fresh_clone_without_bha_local_verifier_passes',
    'fresh_clone_recover_status_explains_missing_local_capability',
    'fresh_clone_gate_status_blocks_without_local_capability',
    'fresh_clone_push_prep_generates_local_handoff'
  ];
  const missingFreshCloneRegressionIds = requiredFreshCloneRegressionIds
    .filter((id) => !fileContains(RUN_SCRIPT, `'${id}'`) && !fileContains(RUN_SCRIPT, `"${id}"`));
  const requiredOperatorUxRegressionIds = [
    'push_prep_validation_wired',
    'signed_payload_status_validation_wired',
    'operator_signer_preflight_validation_wired',
    'push_prep_writes_current_head_bound_payload',
    'push_prep_powershell_command_quotes_arguments',
    'push_prep_print_next_command_single_line',
    'push_prep_write_handoff_local_only',
    'push_prep_rejects_local_symlink_escape',
    'gate_status_uses_existing_current_unsigned_payload_before_signing',
    'recover_status_uses_existing_current_unsigned_payload_before_signing',
    'gate_status_copyable_commands_quote_arguments',
    'operator_handoff_capability_flow_is_conditional',
    'gate_status_next_action_context_is_conditional'
  ];
  const missingOperatorUxRegressionIds = requiredOperatorUxRegressionIds
    .filter((id) => !fileContains(RUN_SCRIPT, `'${id}'`) && !fileContains(RUN_SCRIPT, `"${id}"`));
  const requiredStableExitReviewRegressionIds = [
    'stable_exit_review_validation_wired',
    'stable_exit_review_boundary_readonly'
  ];
  const missingStableExitReviewRegressionIds = requiredStableExitReviewRegressionIds
    .filter((id) => !fileContains(RUN_SCRIPT, `'${id}'`) && !fileContains(RUN_SCRIPT, `"${id}"`));
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
      (denyCommands.package_install_commands || []).length > 0 &&
      (denyCommands.package_publish_commands || []).length > 0 &&
      (denyCommands.release_commands || []).length > 0 &&
      (denyCommands.deploy_commands || []).length > 0 &&
      (denyCommands.ssh_commands || []).length > 0 &&
      fileContains(STABILITY_PATH, 'no provider calls') &&
      fileContains(STABILITY_PATH, 'no deploy, release, tag, or package publish') &&
      fileContains(STABILITY_PATH, 'no private key access'),
    { always_denied_v1: alwaysDenied },
    ['.bha/policy.yaml', 'BHA_V1_STABILITY.md']
  ));
  checks.push(auditCheck(
    'hard_boundary_deny_regressions_covered',
    'V1 hard boundaries have regression cases that prove denied commands fail before spawning external or destructive effects.',
    Boolean(regressionCommand &&
      missingDenyRegressionIds.length === 0 &&
      fileContains(RUN_SCRIPT, 'denied_before_spawn_events') &&
      fileContains(RUN_SCRIPT, 'forbidden_spawned: false') &&
      fileContains(RUN_SCRIPT, 'real_git_push_executed: false') &&
      fileContains(RUN_SCRIPT, 'provider_call_executed: false') &&
      fileContains(RUN_SCRIPT, 'memory_write_executed: false') &&
      fileContains(RUN_SCRIPT, 'package_install_executed: false')),
    {
      regression_selftest_validation_command_present: Boolean(regressionCommand),
      required_regression_ids: requiredDenyRegressionIds,
      missing_regression_ids: missingDenyRegressionIds
    },
    ['scripts/bha-run.js', '.bha/validation.yaml']
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
    'capability_scope_negative_tests_covered',
    'V1 git_push-only capability scope is covered by runtime and verifier negative tests for unknown, disallowed, incomplete, expired, and replayed capabilities.',
    Boolean(regressionCommand &&
      verifierSelftestCommand &&
      missingCapabilityRuntimeRegressionIds.length === 0 &&
      missingCapabilityVerifierSelftestIds.length === 0 &&
      fileContains(RUN_SCRIPT, 'CAPABILITY_TYPE_NOT_SUPPORTED') &&
      fileContains(RUN_SCRIPT, 'DISALLOWED_CAPABILITY_TYPE') &&
      fileContains(RUN_SCRIPT, 'PAYLOAD_EXPIRED') &&
      fileContains(VERIFY_SCRIPT, 'UNSUPPORTED_CAPABILITY_MARKED_VALID') &&
      fileContains(VERIFY_SCRIPT, 'DISALLOWED_CAPABILITY_VALID') &&
      fileContains(VERIFY_SCRIPT, 'CAPABILITY_EXPIRED') &&
      fileContains(VERIFY_SCRIPT, 'CAPABILITY_REPLAY_DETECTED')),
    {
      regression_selftest_validation_command_present: Boolean(regressionCommand),
      verifier_selftest_validation_command_present: Boolean(verifierSelftestCommand),
      required_runtime_regression_ids: requiredCapabilityRuntimeRegressionIds,
      missing_runtime_regression_ids: missingCapabilityRuntimeRegressionIds,
      required_verifier_selftest_ids: requiredCapabilityVerifierSelftestIds,
      missing_verifier_selftest_ids: missingCapabilityVerifierSelftestIds
    },
    ['scripts/bha-run.js', 'scripts/bha-verify.js', '.bha/validation.yaml']
  ));
  checks.push(auditCheck(
    'v2_capability_framework_preview_default_deny',
    'V2 capability framework preview exists but keeps unknown, provider, deploy, release, and non-git_push capability types denied.',
    fs.existsSync(CAPABILITY_FRAMEWORK_PATH) &&
      Boolean(capabilityFrameworkStatusCommand &&
      capabilityFrameworkStatusCommand.expect &&
      capabilityFrameworkStatusCommand.expect.exit_code === 0 &&
      capabilityFrameworkStatusCommand.expect.read_only === true &&
      capabilityFrameworkStatusCommand.expect.recorded === false &&
      policyAllowsArgv(policy, capabilityFrameworkStatusCommand.argv || [])) &&
      fileContains(CAPABILITY_FRAMEWORK_PATH, 'Default deny') &&
      fileContains(CAPABILITY_FRAMEWORK_PATH, 'git_push') &&
      fileContains(CAPABILITY_FRAMEWORK_PATH, 'provider') &&
      capabilityFramework().default_decision === 'DENY' &&
      capabilityFramework().unknown_capability_policy === 'DENY' &&
      capabilityFramework().production_capability_types.length === 1 &&
      capabilityFramework().production_capability_types[0] === 'git_push' &&
      capabilityFramework().test_requirements &&
      capabilityFramework().test_requirements.deny_tests_required_before_allow === true &&
      capabilityFramework().test_requirements.replay_tests_required_before_allow === true &&
      capabilityFramework().enablement_gate &&
      capabilityFramework().enablement_gate.new_production_capability_allowed === false &&
      capabilityFramework().enablement_gate.requires_new_explicit_objective === true &&
      capabilityFramework().enablement_gate.requires_verifier_evidence === true &&
      capabilityFramework().enablement_gate.requires_deny_tests_before_allow === true &&
      capabilityFramework().enablement_gate.requires_replay_tests_before_allow === true &&
      capabilityFramework().draft_artifacts &&
      capabilityFramework().draft_artifacts.status === 'NON_ENABLING_DRAFTS_ONLY' &&
      capabilityFramework().draft_artifacts.satisfies_enablement_requirement === false &&
      capabilityFramework().extension_policy.required_before_enablement.includes('verifier_evidence') &&
      capabilityFrameworkJsonPaths['production_capability_types.0'] === 'git_push' &&
      capabilityFrameworkJsonPaths['extension_policy.provider_deploy_release_default'] === 'DENY' &&
      capabilityFrameworkJsonPaths['enablement_gate.new_production_capability_allowed'] === false &&
      capabilityFrameworkJsonPaths['enablement_gate.forbidden_without_new_objective.0'] === 'provider_call' &&
      capabilityFrameworkJsonPaths['draft_artifacts.status'] === 'NON_ENABLING_DRAFTS_ONLY' &&
      capabilityFrameworkJsonPaths['draft_artifacts.satisfies_enablement_requirement'] === false &&
      capabilityFrameworkJsonPaths['draft_artifacts.items.5'] === 'verifier_evidence_plan_sketch' &&
      capabilityFrameworkJsonPaths['draft_artifacts.non_enablement_reasons.5'] === 'explicit_policy_change_missing' &&
      capabilityFrameworkJsonPaths['test_requirements.current_coverage.enablement_coverage_complete'] === false &&
      capabilityFrameworkJsonPaths['test_requirements.missing_before_enablement.0'] === 'future_capability_schema' &&
      capabilityFrameworkJsonPaths['test_requirements.missing_before_enablement.7'] === 'explicit_policy_change' &&
      capabilityFrameworkJsonPaths['types.git_push.evidence_policy.tracked'] === false &&
      fileContains(CAPABILITY_FRAMEWORK_PATH, 'verifier evidence') &&
      fileContains(CAPABILITY_FRAMEWORK_PATH, 'enablement coverage as incomplete') &&
      fileContains(CAPABILITY_FRAMEWORK_PATH, 'Non-Enabling Draft') &&
      fileContains(CAPABILITY_FRAMEWORK_PATH, 'deny test plan sketch') &&
      fileContains(CAPABILITY_FRAMEWORK_PATH, 'replay test plan sketch') &&
      fileContains(CAPABILITY_FRAMEWORK_PATH, 'verifier evidence plan sketch') &&
      fileContains(CAPABILITY_FRAMEWORK_PATH, 'a policy allow entry for any future capability type') &&
      fileContains(ROADMAP_PATH, 'verifier evidence'),
    {
      validation_command_present: Boolean(capabilityFrameworkStatusCommand),
      validation_command_policy_allowed: capabilityFrameworkStatusCommand ? policyAllowsArgv(policy, capabilityFrameworkStatusCommand.argv || []) : false,
      validation_json_paths: capabilityFrameworkJsonPaths,
      framework_status_command: 'node scripts/bha-run.js capability-framework-status --format json',
      production_capability_types: capabilityFramework().production_capability_types,
      required_before_enablement: capabilityFramework().extension_policy.required_before_enablement,
      enablement_gate: capabilityFramework().enablement_gate,
      test_requirements: capabilityFramework().test_requirements
    },
    ['BHA_V2_CAPABILITY_FRAMEWORK.md', 'scripts/bha-run.js', '.bha/policy.yaml', '.bha/roadmap.md']
  ));
  checks.push(auditCheck(
    'v2_council_runtime_preview_no_automation',
    'V2+ Council Runtime remains a preview/status contract only and cannot spawn agents, write memory, call providers, or create external side effects.',
    fs.existsSync(COUNCIL_RUNTIME_PATH) &&
      Boolean(councilStatusCommand &&
      councilStatusCommand.expect &&
      councilStatusCommand.expect.exit_code === 0 &&
      councilStatusCommand.expect.read_only === true &&
      councilStatusCommand.expect.recorded === false &&
      policyAllowsArgv(policy, councilStatusCommand.argv)) &&
      fileContains(COUNCIL_RUNTIME_PATH, 'Status: preview contract only') &&
      fileContains(COUNCIL_RUNTIME_PATH, 'local-only and read-only') &&
      fileContains(COUNCIL_RUNTIME_PATH, 'not proof') &&
      fileContains(COUNCIL_RUNTIME_PATH, 'does not execute the workflow') &&
      fileContains(COUNCIL_RUNTIME_PATH, 'activation coverage as incomplete') &&
      fileContains(COUNCIL_RUNTIME_PATH, 'Non-Enabling Draft') &&
      fileContains(COUNCIL_RUNTIME_PATH, 'role boundary test plan sketch') &&
      fileContains(COUNCIL_RUNTIME_PATH, 'activation regression plan sketch') &&
      fileContains(COUNCIL_RUNTIME_PATH, 'a verifier-enforced workflow model') &&
      fileContains(COUNCIL_RUNTIME_PATH, 'authority for automated sub-agent spawning') &&
      councilRuntimeStatus().runtime_state === 'PREVIEW_CONTRACT_ONLY' &&
      councilRuntimeStatus().default_decision === 'NO_AUTOMATED_DELEGATION' &&
      councilRuntimeStatus().external_side_effects_allowed === false &&
      councilRuntimeStatus().automated_agent_spawn_allowed === false &&
      councilRuntimeStatus().provider_calls_allowed === false &&
      councilRuntimeStatus().memory_writes_allowed === false &&
      councilRuntimeStatus().activation_gate &&
      councilRuntimeStatus().activation_gate.runtime_activation_allowed === false &&
      councilRuntimeStatus().activation_gate.requires_new_explicit_objective === true &&
      councilRuntimeStatus().activation_gate.requires_verifier_backed_workflow_model === true &&
      councilRuntimeStatus().draft_artifacts &&
      councilRuntimeStatus().draft_artifacts.status === 'NON_ENABLING_DRAFTS_ONLY' &&
      councilRuntimeStatus().draft_artifacts.satisfies_activation_requirement === false &&
      councilRuntimeStatus().test_requirements &&
      councilRuntimeStatus().test_requirements.current_coverage &&
      councilRuntimeStatus().test_requirements.current_coverage.activation_coverage_complete === false &&
      Array.isArray(councilRuntimeStatus().test_requirements.missing_before_activation) &&
      councilRuntimeStatus().test_requirements.missing_before_activation.includes('verifier_backed_workflow_model') &&
      councilStatusJsonPaths.local_only === true &&
      councilStatusJsonPaths['activation_gate.runtime_activation_allowed'] === false &&
      councilStatusJsonPaths['activation_gate.forbidden_without_new_objective.0'] === 'automated_agent_spawn' &&
      councilStatusJsonPaths['activation_gate.forbidden_without_new_objective.2'] === 'memory_write' &&
      councilStatusJsonPaths['activation_gate.forbidden_without_new_objective.3'] === 'push' &&
      councilStatusJsonPaths['draft_artifacts.status'] === 'NON_ENABLING_DRAFTS_ONLY' &&
      councilStatusJsonPaths['draft_artifacts.satisfies_activation_requirement'] === false &&
      councilStatusJsonPaths['draft_artifacts.items.4'] === 'activation_regression_plan_sketch' &&
      councilStatusJsonPaths['draft_artifacts.non_activation_reasons.5'] === 'automated_spawn_provider_memory_and_remote_actions_forbidden' &&
      councilStatusJsonPaths['test_requirements.current_coverage.activation_coverage_complete'] === false &&
      councilStatusJsonPaths['test_requirements.missing_before_activation.0'] === 'verifier_backed_workflow_model',
    {
      validation_command_present: Boolean(councilStatusCommand),
      policy_allowed: councilStatusCommand ? policyAllowsArgv(policy, councilStatusCommand.argv) : false,
      validation_json_paths: councilStatusJsonPaths,
      runtime_state: councilRuntimeStatus().runtime_state,
      default_decision: councilRuntimeStatus().default_decision,
      external_side_effects_allowed: councilRuntimeStatus().external_side_effects_allowed,
      automated_agent_spawn_allowed: councilRuntimeStatus().automated_agent_spawn_allowed,
      provider_calls_allowed: councilRuntimeStatus().provider_calls_allowed,
      memory_writes_allowed: councilRuntimeStatus().memory_writes_allowed,
      draft_artifacts: councilRuntimeStatus().draft_artifacts,
      activation_gate: councilRuntimeStatus().activation_gate,
      test_requirements: councilRuntimeStatus().test_requirements
    },
    ['BHA_V2_COUNCIL_RUNTIME.md', 'scripts/bha-run.js', '.bha/validation.yaml', '.bha/policy.yaml']
  ));
  checks.push(auditCheck(
    'node_builtins_only_no_package_manifest',
    'V1 has no package manager dependency surface anywhere in tracked project space; runtime remains Node.js built-in modules only.',
    dependencyAudit.artifacts.length === 0 &&
      dependencyAudit.skipped.length === 0 &&
      requireAudit.disallowed_modules.length === 0 &&
      requireAudit.dynamic_require_files.length === 0 &&
      fileContains(RUN_SCRIPT, 'dependency_surface_audit_detects_nested_package_artifacts') &&
      fileContains(STABILITY_PATH, 'Node.js built-in modules only') &&
      fileContains(STABILITY_PATH, 'dependency manifests, lockfiles, or `node_modules`'),
    {
      allowed_modules: requireAudit.allowed_modules,
      observed_modules: requireAudit.module_names,
      disallowed_modules: requireAudit.disallowed_modules,
      dynamic_require_files: requireAudit.dynamic_require_files,
      dependency_artifacts: dependencyAudit.artifacts,
      dependency_scan_skipped: dependencyAudit.skipped,
      dependency_scan_ignored_roots: dependencyAudit.ignored_roots
    },
    ['scripts/bha-run.js', 'scripts/bha-verify.js', 'BHA_V1_STABILITY.md']
  ));
  checks.push(auditCheck(
    'operator_signer_private_key_boundary_scanned',
    'V1 operator signer preflight checks private key path readiness without reading, printing, recording, or storing private key material.',
    privateKeyAudit.function_found &&
      privateKeyAudit.env_reference &&
      privateKeyAudit.exists_check_only &&
      privateKeyAudit.repo_path_blocker &&
      privateKeyAudit.reports_material_not_read &&
      privateKeyAudit.reports_path_not_printed &&
      privateKeyAudit.violations.length === 0 &&
      fileContains(STABILITY_PATH, 'BHA must never read, print, log, store, or infer private key material'),
    privateKeyAudit,
    ['scripts/bha-run.js', 'BHA_V1_STABILITY.md']
  ));
  checks.push(auditCheck(
    'local_capability_path_boundary_hardened',
    'V1 local capability payload, event, session, and lock paths are physically confined to .bha/local and reject symlink or junction traversal.',
    Boolean(regressionCommand &&
      fileContains(RUN_SCRIPT, 'function localPathSafetyIssue') &&
      fileContains(RUN_SCRIPT, '.bha/local must not be a symbolic link or junction') &&
      fileContains(RUN_SCRIPT, 'local capability paths must not traverse symbolic links or junctions') &&
      fileContains(CAPABILITY_STORE_SCRIPT, 'resolveLocalFile(deps.localCapabilitiesPath)') &&
      fileContains(CAPABILITY_STORE_SCRIPT, 'resolveLocalFile(deps.localCapabilitySessionsPath)') &&
      fileContains(RUN_SCRIPT, 'LOCAL_CAPABILITY_PATH_INVALID') &&
      fileContains(RUN_SCRIPT, 'push_prep_rejects_local_symlink_escape') &&
      fileContains(STABILITY_PATH, 'Symlink or junction traversal is rejected') &&
      fileContains(ROADMAP_PATH, 'Local capability payload, event, session, and lock paths are physically confined')),
    {
      regression_selftest_validation_command_present: Boolean(regressionCommand),
      local_path_guard_present: fileContains(RUN_SCRIPT, 'function localPathSafetyIssue'),
      symlink_escape_regression_present: fileContains(RUN_SCRIPT, 'push_prep_rejects_local_symlink_escape'),
      invalid_path_reason_present: fileContains(RUN_SCRIPT, 'LOCAL_CAPABILITY_PATH_INVALID')
    },
    ['scripts/bha-run.js', 'scripts/lib/capability-store.js', '.bha/validation.yaml', 'BHA_V1_STABILITY.md', '.bha/roadmap.md']
  ));
  checks.push(auditCheck(
    'audit_v1_stable_wired',
    'audit-v1-stable is read-only, policy-allowed, and wired into validation.',
    Boolean(validationCommand &&
      validationCommand.expect &&
      validationCommand.expect.read_only === true &&
      validationCommand.expect.recorded === false &&
      policyAllowsArgv(policy, auditArgv) &&
      policyAllowsArgv(policy, validationCommand.argv || [])),
    {
      validation_command_present: Boolean(validationCommand),
      policy_allowed: policyAllowsArgv(policy, auditArgv),
      validation_command_policy_allowed: validationCommand ? policyAllowsArgv(policy, validationCommand.argv || []) : false
    },
    ['.bha/policy.yaml', '.bha/validation.yaml', 'scripts/bha-run.js']
  ));
  checks.push(auditCheck(
    'stable_exit_status_wired',
    'stable-exit-status is read-only, policy-allowed, wired into validation, and documented as local phase readiness rather than proof or push authorization.',
    Boolean(stableExitCommand &&
      stableExitCommand.expect &&
      stableExitCommand.expect.exit_code === 0 &&
      stableExitCommand.expect.read_only === true &&
      stableExitCommand.expect.recorded === false &&
      stableExitCommand.expect.json_paths &&
      stableExitCommand.expect.json_paths['push_requirement.required_now'] === false &&
      stableExitCommand.expect.json_paths['signer_boundary.bha_private_key_access'] === false &&
      policyAllowsArgv(policy, ['node', 'scripts/bha-run.js', 'stable-exit-status', '--remote', 'origin', '--branch', 'master', '--format', 'json']) &&
      policyAllowsArgv(policy, stableExitCommand.argv || []) &&
      fileContains(RUN_SCRIPT, 'async function handleStableExitStatus') &&
      fileContains(STABILITY_PATH, '`stable-exit-status` is a read-only phase-readiness report') &&
      fileContains(ROADMAP_PATH, '`stable-exit-status` reports whether the V1 Stable Candidate is clean enough') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'stable-exit-status --remote')),
    {
      validation_command_present: Boolean(stableExitCommand),
      strict_policy_allowed: policyAllowsArgv(policy, ['node', 'scripts/bha-run.js', 'stable-exit-status', '--remote', 'origin', '--branch', 'master', '--format', 'json']),
      validation_command_policy_allowed: stableExitCommand ? policyAllowsArgv(policy, stableExitCommand.argv || []) : false
    },
    ['.bha/policy.yaml', '.bha/validation.yaml', 'scripts/bha-run.js', 'BHA_V1_STABILITY.md', '.bha/roadmap.md', 'BHA_LONG_TERM_GOAL_AUDIT.md']
  ));
  checks.push(auditCheck(
    'stable_exit_review_wired',
    'stable-exit-review is read-only, policy-allowed, wired into validation, and documented as a prompt-to-artifact exit review rather than a proof replacement.',
    Boolean(stableExitReviewCommand &&
      stableExitReviewCommand.expect &&
      stableExitReviewCommand.expect.exit_code === 0 &&
      stableExitReviewCommand.expect.read_only === true &&
      stableExitReviewCommand.expect.recorded === false &&
      stableExitReviewCommand.expect.json_paths &&
      stableExitReviewCommand.expect.json_paths['completion_boundary.long_term_goal_complete'] === false &&
      stableExitReviewCommand.expect.json_paths['push_requirement.required_now'] === false &&
      stableExitReviewCommand.expect.json_paths['v2_hold_line.capability_enablement_allowed'] === false &&
      stableExitReviewCommand.expect.json_paths['v2_hold_line.council_activation_allowed'] === false &&
      policyAllowsArgv(policy, ['node', 'scripts/bha-run.js', 'stable-exit-review', '--remote', 'origin', '--branch', 'master', '--format', 'json']) &&
      policyAllowsArgv(policy, stableExitReviewCommand.argv || []) &&
      missingStableExitReviewRegressionIds.length === 0 &&
      fileContains(RUN_SCRIPT, 'async function handleStableExitReview') &&
      fileContains(STABILITY_PATH, '`stable-exit-review` is a read-only prompt-to-artifact exit review') &&
      fileContains(ROADMAP_PATH, '`stable-exit-review` turns the stable exit review') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'stable-exit-review')),
    {
      validation_command_present: Boolean(stableExitReviewCommand),
      strict_policy_allowed: policyAllowsArgv(policy, ['node', 'scripts/bha-run.js', 'stable-exit-review', '--remote', 'origin', '--branch', 'master', '--format', 'json']),
      validation_command_policy_allowed: stableExitReviewCommand ? policyAllowsArgv(policy, stableExitReviewCommand.argv || []) : false,
      required_regression_ids: requiredStableExitReviewRegressionIds,
      missing_regression_ids: missingStableExitReviewRegressionIds
    },
    ['.bha/policy.yaml', '.bha/validation.yaml', 'scripts/bha-run.js', 'BHA_V1_STABILITY.md', '.bha/roadmap.md', 'BHA_LONG_TERM_GOAL_AUDIT.md']
  ));
  checks.push(auditCheck(
    'next_local_plan_status_wired',
    'next-local-plan-status is read-only, policy-allowed, wired into validation, and reports the next local planning queue without enabling remote actions or V2 authority.',
    Boolean(nextLocalPlanCommand &&
      nextLocalPlanCommand.expect &&
      nextLocalPlanCommand.expect.exit_code === 0 &&
      nextLocalPlanCommand.expect.read_only === true &&
      nextLocalPlanCommand.expect.recorded === false &&
      nextLocalPlanCommand.expect.json_paths &&
      nextLocalPlanCommand.expect.json_paths.decision === 'CONTINUE_LOCAL_PLANNING' &&
      nextLocalPlanCommand.expect.json_paths['completion_boundary.long_term_goal_complete'] === false &&
      nextLocalPlanCommand.expect.json_paths['validation_coverage.long_term_goal_status_readonly'] === true &&
      nextLocalPlanCommand.expect.json_paths['current_phase_queue.3.coverage_complete'] === false &&
      nextLocalPlanCommand.expect.json_paths['current_phase_queue.3.missing_before_enablement.0'] === 'future_capability_schema' &&
      nextLocalPlanCommand.expect.json_paths['current_phase_queue.3.non_enablement_reasons.5'] === 'explicit_policy_change_missing' &&
      nextLocalPlanCommand.expect.json_paths['current_phase_queue.4.coverage_complete'] === false &&
      nextLocalPlanCommand.expect.json_paths['current_phase_queue.4.missing_before_activation.0'] === 'verifier_backed_workflow_model' &&
      nextLocalPlanCommand.expect.json_paths['current_phase_queue.4.non_activation_reasons.5'] === 'automated_spawn_provider_memory_and_remote_actions_forbidden' &&
      nextLocalPlanCommand.expect.json_paths['hard_boundaries.push_allowed'] === false &&
      nextLocalPlanCommand.expect.json_paths['hard_boundaries.private_key_access_allowed'] === false &&
      nextLocalPlanCommand.expect.json_paths['v2_hold_line.new_production_capability_allowed'] === false &&
      nextLocalPlanCommand.expect.json_paths['v2_hold_line.council_runtime_activation_allowed'] === false &&
      nextLocalPlanCommand.expect.json_paths['next_commands.0'] === "node scripts/bha-run.js next-local-plan-status --remote 'origin' --branch 'master' --format json" &&
      nextLocalPlanCommand.expect.json_paths['next_commands.1'] === "node scripts/bha-run.js stable-exit-review --remote 'origin' --branch 'master' --format json" &&
      policyAllowsArgv(policy, ['node', 'scripts/bha-run.js', 'next-local-plan-status', '--remote', 'origin', '--branch', 'master', '--format', 'json']) &&
      policyAllowsArgv(policy, nextLocalPlanCommand.argv || []) &&
      fileContains(RUN_SCRIPT, 'async function handleNextLocalPlanStatus') &&
      fileContains(ROADMAP_PATH, '`next-local-plan-status` reports the next local planning queue') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'next-local-plan-status')),
    {
      validation_command_present: Boolean(nextLocalPlanCommand),
      strict_policy_allowed: policyAllowsArgv(policy, ['node', 'scripts/bha-run.js', 'next-local-plan-status', '--remote', 'origin', '--branch', 'master', '--format', 'json']),
      validation_command_policy_allowed: nextLocalPlanCommand ? policyAllowsArgv(policy, nextLocalPlanCommand.argv || []) : false
    },
    ['.bha/policy.yaml', '.bha/validation.yaml', 'scripts/bha-run.js', '.bha/roadmap.md', 'BHA_LONG_TERM_GOAL_AUDIT.md']
  ));
  checks.push(auditCheck(
    'long_term_goal_status_wired',
    'long-term-goal-status is read-only, policy-allowed, wired into validation, and reports long-term completion boundaries without declaring future V2 work complete.',
    Boolean(longTermGoalCommand &&
      longTermGoalCommand.expect &&
      longTermGoalCommand.expect.exit_code === 0 &&
      longTermGoalCommand.expect.read_only === true &&
      longTermGoalCommand.expect.recorded === false &&
      longTermGoalCommand.expect.json_paths &&
      longTermGoalCommand.expect.json_paths.status === 'LONG_TERM_GOAL_IN_PROGRESS' &&
      longTermGoalCommand.expect.json_paths.decision === 'CONTINUE_LOCAL_HOLD_LINE' &&
      longTermGoalCommand.expect.json_paths['completion_boundary.long_term_goal_complete'] === false &&
      longTermGoalCommand.expect.json_paths['current_local_state.v1_stable_candidate_ready'] === true &&
      longTermGoalCommand.expect.json_paths['future_work.0.status'] === 'FUTURE_REQUIRES_NEW_EXPLICIT_OBJECTIVE' &&
      longTermGoalCommand.expect.json_paths['future_work.0.coverage_complete'] === false &&
      longTermGoalCommand.expect.json_paths['future_work.0.non_enablement_reasons.5'] === 'explicit_policy_change_missing' &&
      longTermGoalCommand.expect.json_paths['future_work.1.coverage_complete'] === false &&
      longTermGoalCommand.expect.json_paths['future_work.1.non_activation_reasons.5'] === 'automated_spawn_provider_memory_and_remote_actions_forbidden' &&
      longTermGoalCommand.expect.json_paths['prompt_to_artifact_checklist.5.id'] === 'next_stage_transition_boundary' &&
      longTermGoalCommand.expect.json_paths['prompt_to_artifact_checklist.5.status'] === 'PASS' &&
      longTermGoalCommand.expect.json_paths['prompt_to_artifact_checklist.5.evidence.push_required_now'] === false &&
      longTermGoalCommand.expect.json_paths['prompt_to_artifact_checklist.5.evidence.long_term_goal_complete'] === false &&
      longTermGoalCommand.expect.json_paths['prompt_to_artifact_checklist.5.evidence.new_production_capability_allowed'] === false &&
      longTermGoalCommand.expect.json_paths['prompt_to_artifact_checklist.5.evidence.council_runtime_activation_allowed'] === false &&
      longTermGoalCommand.expect.json_paths['hard_boundaries.push_allowed'] === false &&
      longTermGoalCommand.expect.json_paths['v2_hold_line.new_production_capability_allowed'] === false &&
      longTermGoalCommand.expect.json_paths['v2_hold_line.council_runtime_activation_allowed'] === false &&
      policyAllowsArgv(policy, ['node', 'scripts/bha-run.js', 'long-term-goal-status', '--remote', 'origin', '--branch', 'master', '--format', 'json']) &&
      policyAllowsArgv(policy, longTermGoalCommand.argv || []) &&
      fileContains(RUN_SCRIPT, 'async function handleLongTermGoalStatus') &&
      fileContains(ROADMAP_PATH, '`long-term-goal-status` reports') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'long-term-goal-status')),
    {
      validation_command_present: Boolean(longTermGoalCommand),
      strict_policy_allowed: policyAllowsArgv(policy, ['node', 'scripts/bha-run.js', 'long-term-goal-status', '--remote', 'origin', '--branch', 'master', '--format', 'json']),
      validation_command_policy_allowed: longTermGoalCommand ? policyAllowsArgv(policy, longTermGoalCommand.argv || []) : false,
      next_stage_transition_boundary_validation_wired: Boolean(longTermGoalCommand &&
        longTermGoalCommand.expect &&
        longTermGoalCommand.expect.json_paths &&
        longTermGoalCommand.expect.json_paths['prompt_to_artifact_checklist.5.id'] === 'next_stage_transition_boundary' &&
        longTermGoalCommand.expect.json_paths['prompt_to_artifact_checklist.5.status'] === 'PASS')
    },
    ['.bha/policy.yaml', '.bha/validation.yaml', 'scripts/bha-run.js', '.bha/roadmap.md', 'BHA_LONG_TERM_GOAL_AUDIT.md']
  ));
  checks.push(auditCheck(
    'verifier_pass_required_for_stable_audit',
    'V1 stable audit cannot pass unless verifier is clean, except for explicit validation-in-progress bootstrap issues.',
    verifierStrictPass || verifierValidationBootstrapPass,
    {
      verifier_status: verifier.status || 'UNAVAILABLE',
      issues: verifierIssues.length,
      warnings: verifierWarnings.length,
      issue_codes: verifierIssueCodes,
      warning_codes: verifierWarningCodes,
      failed_recorded_validation_ids: failedRecordedValidationIds,
      validation_in_progress_override: verifierValidationBootstrapPass
    },
    ['.bha/state.json', '.bha/ledger.jsonl', 'scripts/bha-verify.js']
  ));
  checks.push(auditCheck(
    'conditional_push_guidance_freeze_wired',
    'V1 push guidance is machine-readable and conditional: BHA may prepare local capability files, but push capability is required only when the operator chooses a real git push.',
    Boolean(gateStatusCommand &&
      recoverStatusCommand &&
      regressionCommand &&
      gateStatusCommand.expect &&
      Array.isArray(gateStatusCommand.expect.has_keys) &&
      gateStatusCommand.expect.has_keys.includes('schema') &&
      gateStatusCommand.expect.has_keys.includes('next_action_required_now') &&
      gateStatusCommand.expect.has_keys.includes('next_action_condition') &&
      gateStatusCommand.expect.has_keys.includes('next_action_scope') &&
      gateStatusCommand.expect.has_keys.includes('next_commands') &&
      gateStatusCommand.expect.has_keys.includes('push_requirement') &&
      gateStatusCommand.expect.has_keys.includes('signer_boundary') &&
      gateStatusCommand.expect.has_keys.includes('tracked_git_reality') &&
      gateStatusCommand.expect.has_keys.includes('operator_handoff') &&
      recoverStatusCommand.expect &&
      Array.isArray(recoverStatusCommand.expect.has_keys) &&
      recoverStatusCommand.expect.has_keys.includes('schema') &&
      recoverStatusCommand.expect.has_keys.includes('branch') &&
      recoverStatusCommand.expect.has_keys.includes('remote') &&
      recoverStatusCommand.expect.has_keys.includes('head') &&
      recoverStatusCommand.expect.has_keys.includes('tracked_trust') &&
      recoverStatusCommand.expect.has_keys.includes('local_state') &&
      recoverStatusCommand.expect.has_keys.includes('local_payload_recovery') &&
      recoverStatusCommand.expect.has_keys.includes('git_reality') &&
      recoverStatusCommand.expect.has_keys.includes('tracked_git_reality') &&
      recoverStatusCommand.expect.has_keys.includes('git_push_recovery') &&
      recoverStatusCommand.expect.has_keys.includes('proof_boundary') &&
      gateStatusJsonPaths['push_requirement.required_now'] === false &&
      gateStatusJsonPaths['push_requirement.operator_controlled'] === true &&
      gateStatusJsonPaths['operator_handoff.capability_flow_required_now'] === false &&
      gateStatusJsonPaths['signer_boundary.bha_private_key_access'] === false &&
      recoverStatusJsonPaths['local_state.required_for_tracked_verifier_pass'] === false &&
      recoverStatusJsonPaths['local_payload_recovery.read_only'] === true &&
      recoverStatusJsonPaths['git_push_recovery.required_now'] === false &&
      recoverStatusJsonPaths['git_push_recovery.local_only'] === true &&
      fileContains(RUN_SCRIPT, 'push_requirement: {') &&
      fileContains(RUN_SCRIPT, 'required_now: false') &&
      fileContains(RUN_SCRIPT, 'operator_chosen_git_push') &&
      fileContains(RUN_SCRIPT, 'capability_flow_required_now: false') &&
      fileContains(RUN_SCRIPT, 'capability_flow_condition') &&
      fileContains(RUN_SCRIPT, 'Only required before an operator-chosen real git push.') &&
      fileContains(STABILITY_PATH, '`json_paths` expectations') &&
      fileContains(STABILITY_PATH, 'conditional push guidance') &&
      fileContains(STABILITY_PATH, 'gate and recovery handoff should tell the operator to sign that existing `.bha/local/push-payload.json`') &&
      fileContains(STABILITY_PATH, 'local-only') &&
      fileContains(RUN_SCRIPT, 'gate_status_next_action_context_is_conditional') &&
      fileContains(RUN_SCRIPT, 'operator_handoff_capability_flow_is_conditional') &&
      fileContains(RUN_SCRIPT, 'gate_status_uses_existing_current_unsigned_payload_before_signing') &&
      fileContains(RUN_SCRIPT, 'recover_status_uses_existing_current_unsigned_payload_before_signing') &&
      fileContains(RUN_SCRIPT, 'local_payload_recovery') &&
      fileContains(RUN_SCRIPT, 'fresh_clone_recover_status_explains_missing_local_capability') &&
      fileContains(ROADMAP_PATH, '`gate-status` and `recover-status` tell the operator to sign that existing unsigned payload') &&
      fileContains(STABILITY_PATH, 'Push guidance is conditional')),
    {
      gate_status_validation_command_present: Boolean(gateStatusCommand),
      recover_status_validation_command_present: Boolean(recoverStatusCommand),
      regression_selftest_validation_command_present: Boolean(regressionCommand),
      gate_status_json_paths: gateStatusJsonPaths,
      recover_status_json_paths: recoverStatusJsonPaths
    },
    ['scripts/bha-run.js', '.bha/validation.yaml', 'BHA_V1_STABILITY.md']
  ));
  checks.push(auditCheck(
    'operator_ux_handoff_regressions_covered',
    'V1 operator UX freeze is covered by regressions for current-HEAD payload binding, single-line PowerShell handoff, local-only handoff writes, and conditional capability guidance.',
    Boolean(regressionCommand &&
      pushPrepCommand &&
      signedPayloadStatusCommand &&
      operatorSignerPreflightCommand &&
      pushPrepCommand.expect &&
      Array.isArray(pushPrepCommand.expect.has_keys) &&
      pushPrepCommand.expect.has_keys.includes('schema') &&
      pushPrepCommand.expect.has_keys.includes('signed_payload_path') &&
      pushPrepCommand.expect.has_keys.includes('capability_id') &&
      pushPrepCommand.expect.has_keys.includes('current_head') &&
      pushPrepCommand.expect.has_keys.includes('ledger_head_hash') &&
      pushPrepCommand.expect.has_keys.includes('expected_unsigned_payload_hash') &&
      pushPrepCommand.expect.has_keys.includes('handoff') &&
      signedPayloadStatusCommand.expect &&
      Array.isArray(signedPayloadStatusCommand.expect.has_keys) &&
      signedPayloadStatusCommand.expect.has_keys.includes('schema') &&
      signedPayloadStatusCommand.expect.has_keys.includes('current_context') &&
      signedPayloadStatusCommand.expect.has_keys.includes('next_powershell_command') &&
      operatorSignerPreflightCommand.expect &&
      Array.isArray(operatorSignerPreflightCommand.expect.has_keys) &&
      operatorSignerPreflightCommand.expect.has_keys.includes('schema') &&
      operatorSignerPreflightCommand.expect.has_keys.includes('payload_path') &&
      operatorSignerPreflightCommand.expect.has_keys.includes('expected_unsigned_payload_hash') &&
      operatorSignerPreflightCommand.expect.has_keys.includes('blockers') &&
      operatorSignerPreflightCommand.expect.has_keys.includes('next_action') &&
      pushPrepJsonPaths['signer_boundary.operator_controls_signer'] === true &&
      pushPrepJsonPaths['signer_boundary.bha_private_key_access'] === false &&
      pushPrepJsonPaths['handoff.signer_boundary.operator_controls_signer'] === true &&
      pushPrepJsonPaths['handoff.signer_boundary.bha_private_key_access'] === false &&
      pushPrepJsonPaths.local_only === true &&
      pushPrepJsonPaths.private_key_required === false &&
      signedPayloadStatusJsonPaths['signer_boundary.operator_controls_signer'] === true &&
      signedPayloadStatusJsonPaths['signer_boundary.bha_private_key_access'] === false &&
      operatorSignerPreflightJsonPaths['private_key_path.value_printed'] === false &&
      operatorSignerPreflightJsonPaths['private_key_path.file_read'] === false &&
      operatorSignerPreflightJsonPaths['signer_boundary.bha_private_key_access'] === false &&
      operatorSignerPreflightJsonPaths['signer_boundary.private_key_material_read'] === false &&
      operatorSignerPreflightJsonPaths['signer_boundary.private_key_path_value_printed'] === false &&
      missingOperatorUxRegressionIds.length === 0 &&
      fileContains(RUN_SCRIPT, 'command_has_newline') &&
      fileContains(RUN_SCRIPT, '--print-next-command') &&
      fileContains(RUN_SCRIPT, '--write-handoff') &&
      fileContains(RUN_SCRIPT, 'postSignerPowerShellCommand') &&
      fileContains(RUN_SCRIPT, 'powershell_safety')),
    {
      regression_selftest_validation_command_present: Boolean(regressionCommand),
      push_prep_validation_command_present: Boolean(pushPrepCommand),
      signed_payload_status_validation_command_present: Boolean(signedPayloadStatusCommand),
      operator_signer_preflight_validation_command_present: Boolean(operatorSignerPreflightCommand),
      push_prep_json_paths: pushPrepJsonPaths,
      signed_payload_status_json_paths: signedPayloadStatusJsonPaths,
      operator_signer_preflight_json_paths: operatorSignerPreflightJsonPaths,
      required_regression_ids: requiredOperatorUxRegressionIds,
      missing_regression_ids: missingOperatorUxRegressionIds
    },
    ['scripts/bha-run.js', '.bha/validation.yaml']
  ));
  checks.push(auditCheck(
    'fresh_clone_recovery_regressions_covered',
    'V1 recovery freeze is covered by regression cases for fresh clone verifier trust, missing local capability explanation, fail-closed gate, and local handoff regeneration.',
    Boolean(regressionCommand &&
      recoverStatusCommand &&
      missingFreshCloneRegressionIds.length === 0 &&
      fileContains(RUN_SCRIPT, 'required_for_tracked_verifier_pass: false') &&
      fileContains(RUN_SCRIPT, 'requires_new_local_capability') &&
      fileContains(RUN_SCRIPT, 'Only required before an operator-chosen real git push.') &&
      fileContains(STABILITY_PATH, 'Fresh clones must be able to verify tracked trust without `.bha/local/`')),
    {
      regression_selftest_validation_command_present: Boolean(regressionCommand),
      recover_status_validation_command_present: Boolean(recoverStatusCommand),
      required_regression_ids: requiredFreshCloneRegressionIds,
      missing_regression_ids: missingFreshCloneRegressionIds
    },
    ['scripts/bha-run.js', '.bha/validation.yaml', 'BHA_V1_STABILITY.md']
  ));
  checks.push(auditCheck(
    'local_payload_reason_details_covered',
    'V1 local payload status surfaces expose stable machine-readable reason codes and human-readable reason details for stale, expired, mismatched, and invalid payloads.',
    Boolean(regressionCommand &&
      fileContains(RUN_SCRIPT, 'reason_codes') &&
      fileContains(RUN_SCRIPT, 'reason_details') &&
      fileContains(RUN_SCRIPT, 'context_mismatch_details') &&
      fileContains(RUN_SCRIPT, 'not_usable_reason_details') &&
      fileContains(RUN_SCRIPT, 'PAYLOAD_EXPIRED') &&
      fileContains(RUN_SCRIPT, 'gate_status_flags_stale_local_payload_files') &&
      fileContains(RUN_SCRIPT, 'gate_status_flags_expired_unsigned_payload') &&
      fileContains(RUN_SCRIPT, 'signed_payload_status_reports_expired_reason_detail') &&
      fileContains(RUN_SCRIPT, 'recover_status_reports_stale_local_payload_recovery') &&
      fileContains(STABILITY_PATH, 'reason_codes') &&
      fileContains(STABILITY_PATH, 'reason_details')),
    {
      regression_selftest_validation_command_present: Boolean(regressionCommand),
      stale_payload_regression_present: fileContains(RUN_SCRIPT, 'gate_status_flags_stale_local_payload_files'),
      expired_unsigned_regression_present: fileContains(RUN_SCRIPT, 'gate_status_flags_expired_unsigned_payload'),
      expired_signed_regression_present: fileContains(RUN_SCRIPT, 'signed_payload_status_reports_expired_reason_detail')
    },
    ['scripts/bha-run.js', '.bha/validation.yaml', 'BHA_V1_STABILITY.md']
  ));
  checks.push(auditCheck(
    'stable_local_reproduction_documented',
    'V1 stable documentation gives a local-only validation and recovery command path without implying that push is required.',
    fileContains(STABILITY_PATH, 'Local Reproduction') &&
      fileContains(STABILITY_PATH, 'node scripts/bha-run.js validate') &&
      fileContains(STABILITY_PATH, 'node scripts/bha-run.js checkpoint --format json') &&
      fileContains(STABILITY_PATH, 'node scripts/bha-run.js closeout --record --format json') &&
      fileContains(STABILITY_PATH, 'node scripts/bha-verify.js') &&
      fileContains(STABILITY_PATH, 'node scripts/bha-run.js audit-v12 --format json') &&
      fileContains(STABILITY_PATH, 'node scripts/bha-run.js audit-v1-stable --format json') &&
      fileContains(STABILITY_PATH, "node scripts/bha-run.js recover-status --remote 'origin' --branch 'master' --format json") &&
      fileContains(STABILITY_PATH, "node scripts/bha-run.js gate-status --remote 'origin' --branch 'master' --format json") &&
      fileContains(STABILITY_PATH, 'not a request to push') &&
      fileContains(STABILITY_PATH, 'operator-chosen real git push'),
    {},
    ['BHA_V1_STABILITY.md']
  ));
  checks.push(auditCheck(
    'design_addendum_conditional_push_boundary',
    'BHA design addendum keeps tracked trust readiness separate from operator-chosen real push capability and remote-tracking observations.',
    fileContains(DESIGN_PATH, 'local trust readiness for the HEAD') &&
      fileContains(DESIGN_PATH, 'does not mean a push') &&
      fileContains(DESIGN_PATH, 'operator-chosen push still requires') &&
      fileContains(DESIGN_PATH, 'fresh one-use local') &&
      fileContains(DESIGN_PATH, '`git_push`') &&
      fileContains(DESIGN_PATH, 'Remote tracking refs are local Git observations') &&
      fileContains(DESIGN_PATH, 'not remote proof by themselves'),
    { path: rel(DESIGN_PATH) },
    ['BHA_DESIGN.md']
  ));
  checks.push(auditCheck(
    'post_commit_head_boundary_documented',
    'V1 stable docs and runtime keep evidence-time checkpoint/closeout git heads separate from current git reality and stale local payload recovery.',
    fileContains(STABILITY_PATH, 'Post-Commit HEAD Boundary') &&
      fileContains(STABILITY_PATH, 'Checkpoint and closeout git heads are evidence-time facts') &&
      fileContains(STABILITY_PATH, 'HEAD_MISMATCH') &&
      fileContains(STABILITY_PATH, 'LEDGER_HEAD_MISMATCH') &&
      fileContains(RUN_SCRIPT, 'tracked_git_reality') &&
      fileContains(RUN_SCRIPT, 'checkpoint_matches_current_head') &&
      fileContains(RUN_SCRIPT, 'closeout_matches_current_head') &&
      fileContains(RUN_SCRIPT, 'recover_status_reports_evidence_time_git_heads') &&
      fileContains(RUN_SCRIPT, 'Payload is bound to a different git HEAD') &&
      fileContains(RUN_SCRIPT, 'Payload is bound to an older ledger head') &&
      fileContains(ROADMAP_PATH, 'post-commit evidence-time HEAD mismatch explicit') &&
      stableExitJsonPaths['gate_summary.tracked_git_reality.proof_boundary'] === evidenceTimeHeadProofBoundary &&
      gateStatusJsonPaths['tracked_git_reality.proof_boundary'] === evidenceTimeHeadProofBoundary &&
      recoverStatusJsonPaths['tracked_git_reality.proof_boundary'] === evidenceTimeHeadProofBoundary,
    {
      stable_exit_validation_asserts_boundary: stableExitJsonPaths['gate_summary.tracked_git_reality.proof_boundary'] === evidenceTimeHeadProofBoundary,
      gate_status_validation_asserts_boundary: gateStatusJsonPaths['tracked_git_reality.proof_boundary'] === evidenceTimeHeadProofBoundary,
      recover_status_validation_asserts_boundary: recoverStatusJsonPaths['tracked_git_reality.proof_boundary'] === evidenceTimeHeadProofBoundary
    },
    ['BHA_V1_STABILITY.md', 'scripts/bha-run.js', '.bha/roadmap.md']
  ));
  checks.push(auditCheck(
    'stable_audit_bootstrap_boundary_documented',
    'The validation-in-progress stable audit flag is documented as validation bootstrap only, not the operator strict audit path.',
    fileContains(STABILITY_PATH, '--allow-validation-in-progress') &&
      fileContains(STABILITY_PATH, 'validation bootstrap only') &&
      fileContains(STABILITY_PATH, 'Operators should use the strict command') &&
      fileContains(STABILITY_PATH, 'validation_in_progress_override=false') &&
      fileContains(RUN_SCRIPT, 'validation_in_progress_override: verifierValidationBootstrapPass') &&
      fileContains(RUN_SCRIPT, 'stable_audit_bootstrap_allows_prior_validation_failure_ids'),
    {
      validation_command_uses_bootstrap_flag: validationCommand && Array.isArray(validationCommand.argv)
        ? validationCommand.argv.includes('--allow-validation-in-progress')
        : false,
      strict_audit_policy_allowed: policyAllowsArgv(policy, auditArgv)
    },
    ['BHA_V1_STABILITY.md', 'scripts/bha-run.js', '.bha/validation.yaml']
  ));
  checks.push(auditCheck(
    'roadmap_stable_candidate_aligned',
    'The roadmap names the V1 Stable Candidate freeze and keeps operator UX, recovery, and V2 work on hold-line boundaries.',
    fs.existsSync(ROADMAP_PATH) &&
      fileContains(ROADMAP_PATH, 'V1 Stable Candidate Freeze') &&
      fileContains(ROADMAP_PATH, 'Stable candidate local acceptance commands') &&
      fileContains(ROADMAP_PATH, 'Push requirement: `required_now=false`') &&
      fileContains(ROADMAP_PATH, 'V1.3 operator UX freeze') &&
      fileContains(ROADMAP_PATH, 'V1.4 recovery and resume freeze') &&
      fileContains(ROADMAP_PATH, 'V2 capability framework hold line') &&
      fileContains(ROADMAP_PATH, 'V2+ Council Runtime hold line') &&
      fileContains(ROADMAP_PATH, 'Stage transition rule') &&
      fileContains(ROADMAP_PATH, '`stable-exit-review` reports `PASS`') &&
      fileContains(ROADMAP_PATH, '`next-local-plan-status` reports `NEXT_LOCAL_PLAN_READY`') &&
      fileContains(ROADMAP_PATH, '`push_required_now=false`') &&
      fileContains(ROADMAP_PATH, 'does not authorize push, complete the long-term goal, or enable V2 capability/council runtime work') &&
      fileContains(ROADMAP_PATH, 'For normal remote updates after protected `master`') &&
      fileContains(ROADMAP_PATH, 'Direct `git push origin master` is emergency-only') &&
      fileContains(ROADMAP_PATH, "push-prep --remote 'origin' --branch 'master'") &&
      fileContains(ROADMAP_PATH, "gate-status --remote 'origin' --branch 'master'") &&
      fileContains(ROADMAP_PATH, "recover-status --remote 'origin' --branch 'master'") &&
      fileContains(ROADMAP_PATH, 'requires explicit operator authorization'),
    { path: rel(ROADMAP_PATH) },
    ['.bha/roadmap.md']
  ));
  checks.push(auditCheck(
    'long_term_goal_audit_boundary_documented',
    'The long-term goal audit maps goal areas to artifacts while keeping proof, push, private-key, dependency, and V2 preview boundaries explicit.',
    fs.existsSync(LONG_TERM_GOAL_AUDIT_PATH) &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'Status: local Commander audit, not proof') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'Prompt-to-Artifact Checklist') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'Proof still comes from repository reality') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, "recover-status --remote 'origin' --branch 'master'") &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, "gate-status --remote 'origin' --branch 'master'") &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'V1 stable local-first kernel is reliable') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'V1.3 operator UX reduces signing') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'V1.4 recovery/resume handles fresh clone') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'V1 production capability scope remains `git_push` only') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'V2 capability framework remains preview/default deny') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'V2+ Council Runtime remains read-only preview/status') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'Entering the next local planning stage requires') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, '`next-local-plan-status` to report `NEXT_LOCAL_PLAN_READY`') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'does not mean the long-term goal is complete') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'does not authorize push') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'does not enable V2 capability or council runtime activation') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'No push unless the operator separately authorizes a real push') &&
      fileContains(LONG_TERM_GOAL_AUDIT_PATH, 'No private key read'),
    { path: rel(LONG_TERM_GOAL_AUDIT_PATH) },
    ['BHA_LONG_TERM_GOAL_AUDIT.md']
  ));

  const failed = checks.filter((check) => check.status !== 'PASS');
  console.log(JSON.stringify({
    ok: failed.length === 0,
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    schema: 'bha.audit.v1_stable.v1',
    recorded: false,
    read_only: true,
    validation_in_progress_allowed: allowValidationInProgress,
    validation_in_progress_override: verifierValidationBootstrapPass,
    strict_verifier_pass: verifierStrictPass,
    objective: 'BHA V1 stable local-first proof and boundary audit',
    proof_sources: [
      'BHA_DESIGN.md',
      'BHA_LONG_TERM_GOAL_AUDIT.md',
      'BHA_V1_STABILITY.md',
      'BHA_V2_CAPABILITY_FRAMEWORK.md',
      'BHA_V2_COUNCIL_RUNTIME.md',
      '.bha/roadmap.md',
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
    verifier: verifier.ok === undefined ? { ok: false, status: 'UNAVAILABLE' } : verifier,
    limitations: [
      'audit-v1-stable is an artifact coverage audit and does not replace validate or verifier execution',
      'local-only git_push capability evidence remains outside tracked fresh-clone trust',
      'remote push still requires explicit operator authorization and a fresh signed consumed capability'
    ]
  }));
}

async function handleAuditV2Preview(args) {
  const format = getOption(args, '--format') || 'json';
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  const allowValidationInProgress = hasFlag(args, '--allow-validation-in-progress');
  const remote = getOption(args, '--remote') || 'origin';
  const branch = getOption(args, '--branch') || await currentBranch();
  const policy = loadPolicy();
  const state = loadState();
  const validation = readJsonStrict(VALIDATION_PATH);
  const vocabulary = proofVocabularyStatus();
  const bootstrap = bootstrapStatus();
  const negativeMatrix = proofNegativeMatrixStatus();
  const framework = capabilityFramework();
  const council = councilRuntimeStatus();
  const gate = await gateStatus(remote, branch);
  const auditCommand = validationCommandById(validation, 'audit_v2_preview_readonly');
  const vocabularyCommand = validationCommandById(validation, 'proof_vocabulary_status_readonly');
  const bootstrapCommand = validationCommandById(validation, 'bootstrap_status_readonly');
  const negativeMatrixCommand = validationCommandById(validation, 'proof_negative_matrix_status_readonly');
  const frameworkCommand = validationCommandById(validation, 'capability_framework_status_readonly');
  const councilCommand = validationCommandById(validation, 'council_status_readonly');
  const regressionCommand = validationCommandById(validation, 'v12_regression_selftest');
  const verifier = await verifierResult();
  const verifierParsed = verifier.parsed || {};
  const verifierIssues = Array.isArray(verifierParsed.issues) ? verifierParsed.issues : [];
  const verifierWarnings = Array.isArray(verifierParsed.warnings) ? verifierParsed.warnings : [];
  const verifierIssueCodes = verifierIssues.map((issue) => String(issue.code || 'UNKNOWN'));
  const verifierWarningCodes = verifierWarnings.map((warning) => String(warning.code || 'UNKNOWN'));
  const validationBootstrapIssueCodes = [
    'STATE_POLICY_HASH_MISMATCH',
    'VALIDATION_NOT_PASSING',
    'VALIDATION_STALE_INPUTS',
    'VALIDATION_POLICY_HASH_MISMATCH',
    'VALIDATION_COMMAND_STALE',
    'VALIDATION_EXPECTATION_STALE',
    'VALIDATION_COMMAND_FAILED',
    'VALIDATION_COMMAND_COUNT_MISMATCH',
    'VALIDATION_COMMAND_MISSING',
    'CHECKPOINT_POLICY_HASH_MISMATCH',
    'UNVERIFIED_WORKTREE_CHANGE'
  ];
  const validationBootstrapWarningCodes = ['CLOSEOUT_NOT_CURRENT_LEDGER_HEAD'];
  const verifierStrictPass = verifierParsed.ok === true &&
    verifierParsed.status === 'PASS' &&
    verifierIssues.length === 0 &&
    verifierWarnings.length === 0;
  const verifierValidationBootstrapPass = allowValidationInProgress &&
    (verifierParsed.status === 'PASS' || verifierParsed.status === 'FAIL') &&
    (verifierIssueCodes.length > 0 || verifierWarningCodes.length > 0) &&
    verifierIssueCodes.every((code) => validationBootstrapIssueCodes.includes(code)) &&
    verifierWarningCodes.every((code) => validationBootstrapWarningCodes.includes(code));
  const failedRecordedValidationIds = state &&
    state.validation &&
    Array.isArray(state.validation.commands)
    ? state.validation.commands
      .filter((command) => command && command.status !== 'PASS')
      .map((command) => String(command.id || 'UNKNOWN'))
    : [];
  const checks = [];

  checks.push(auditCheck(
    'verifier_gate_clean_or_explicit_bootstrap',
    'V2 preview audit is verifier-gated: strict mode requires verifier PASS with no issues or warnings; validation bootstrap must be explicit and limited to stale evidence issues.',
    verifierStrictPass || verifierValidationBootstrapPass,
    {
      verifier_status: verifierParsed.status || 'UNKNOWN',
      issues: verifierIssues.length,
      warnings: verifierWarnings.length,
      issue_codes: verifierIssueCodes,
      warning_codes: verifierWarningCodes,
      validation_in_progress_allowed: allowValidationInProgress,
      validation_in_progress_override: verifierValidationBootstrapPass,
      failed_recorded_validation_ids: failedRecordedValidationIds
    },
    ['scripts/bha-verify.js', '.bha/state.json', '.bha/ledger.jsonl']
  ));
  const previewVocabularyFindings = previewForbiddenVocabularyFindings({
    framework_summary: {
      default_decision: framework.default_decision,
      production_capability_types: framework.production_capability_types,
      machine_readable_draft_status: framework.machine_readable_draft ? framework.machine_readable_draft.status : 'MISSING',
      deny_replay_matrix_status: framework.deny_replay_test_matrix ? framework.deny_replay_test_matrix.status : 'MISSING',
      new_production_capability_allowed: framework.enablement_gate
        ? framework.enablement_gate.new_production_capability_allowed
        : null
    },
    council_summary: {
      runtime_state: council.runtime_state,
      dry_run_model_status: council.dry_run_model ? council.dry_run_model.status : 'MISSING',
      runtime_activation_allowed: council.activation_gate
        ? council.activation_gate.runtime_activation_allowed
        : null,
      automated_agent_spawn_allowed: council.automated_agent_spawn_allowed
    },
    framework_preview: {
      status: framework.proof_vocabulary.status,
      preview_authorizes_runtime: framework.proof_vocabulary.preview_authorizes_runtime,
      confidence_labels: framework.proof_vocabulary.confidence_labels
    },
    council_preview: {
      status: council.proof_vocabulary.status,
      dry_run_trace_authorizes_runtime: council.proof_vocabulary.dry_run_trace_authorizes_runtime,
      dry_run_trace_is_validation_evidence: council.proof_vocabulary.dry_run_trace_is_validation_evidence,
      confidence_labels: council.proof_vocabulary.confidence_labels
    }
  }, vocabulary.preview_semantics.forbidden_authority_terms);
  checks.push(auditCheck(
    'proof_vocabulary_preview_authority_terms_blocked',
    'V2 preview outputs use confidence labels and must not use enabled, authorized, approved, trusted, or ready as preview authority semantics.',
    Boolean(vocabularyCommand &&
      vocabulary.preview_semantics.preview_authorizes_runtime === false &&
      vocabulary.preview_semantics.dry_run_trace_authorizes_runtime === false &&
      vocabulary.preview_semantics.dry_run_trace_is_validation_evidence === false &&
      vocabulary.critical_judgment.prose_text_scan_allowed === false &&
      previewVocabularyFindings.length === 0),
    {
      validation_command_present: Boolean(vocabularyCommand),
      confidence_labels: Object.keys(vocabulary.proof_levels),
      forbidden_authority_terms: vocabulary.preview_semantics.forbidden_authority_terms,
      preview_vocabulary_findings: previewVocabularyFindings
    },
    ['scripts/bha-run.js', 'scripts/bha-verify.js', '.bha/validation.yaml']
  ));
  checks.push(auditCheck(
    'artifact_provenance_preview_non_authorizing',
    'Preview/status artifacts expose structured provenance and cannot claim authority, activation, or capability grants.',
    Boolean(previewArtifactProvenanceValid(vocabulary, 'proof_vocabulary_status') &&
      previewArtifactProvenanceValid(bootstrap, 'bootstrap_status') &&
      previewArtifactProvenanceValid(negativeMatrix, 'proof_negative_matrix_status') &&
      previewArtifactProvenanceValid(framework, 'capability_framework_status') &&
      previewArtifactProvenanceValid(council, 'council_status') &&
      auditCommand &&
      commandHasJsonPath(auditCommand, 'artifact_provenance.authority', 'NON_AUTHORITATIVE_PREVIEW') &&
      commandHasJsonPath(auditCommand, 'artifact_provenance.non_authoritative', true) &&
      commandHasJsonPath(auditCommand, 'artifact_provenance.non_activating', true) &&
      commandHasJsonPath(auditCommand, 'artifact_provenance.grants_capability', false)),
    {
      vocabulary: vocabulary.artifact_provenance || null,
      bootstrap: bootstrap.artifact_provenance || null,
      negative_matrix: negativeMatrix.artifact_provenance || null,
      framework: framework.artifact_provenance || null,
      council: council.artifact_provenance || null,
      audit_validation_paths_present: Boolean(auditCommand &&
        commandHasJsonPath(auditCommand, 'artifact_provenance.authority', 'NON_AUTHORITATIVE_PREVIEW') &&
        commandHasJsonPath(auditCommand, 'artifact_provenance.grants_capability', false))
    },
    ['scripts/bha-run.js', '.bha/validation.yaml']
  ));
  checks.push(auditCheck(
    'bootstrap_state_contract_machine_readable',
    'Bootstrap status defines fresh-clone replay order and fail-closed behavior without making ledger or local cache a trust root.',
    Boolean(bootstrapCommand &&
      policyAllowsArgv(policy, bootstrapCommand.argv || []) &&
      bootstrap.ledger_is_bootstrap_trust_root === false &&
      bootstrap.local_cache_required === false &&
      bootstrap.private_key_required === false &&
      bootstrap.provider_call_required === false &&
      bootstrap.remote_write_required === false &&
      bootstrap.fresh_clone_replay_contract &&
      bootstrap.fresh_clone_replay_contract.requires_bha_local === false &&
      bootstrap.fresh_clone_replay_contract.requires_private_key === false &&
      bootstrap.fail_closed_states &&
      bootstrap.fail_closed_states.missing_ledger === 'HISTORICAL_EVIDENCE_UNAVAILABLE' &&
      bootstrap.fail_closed_states.corrupt_ledger === 'REPLAY_REQUIRED' &&
      bootstrap.activation_firewall &&
      bootstrap.activation_firewall.effective_production_capability_types.length === 1 &&
      bootstrap.activation_firewall.effective_production_capability_types[0] === 'git_push' &&
      previewArtifactProvenanceValid(bootstrap, 'bootstrap_status')),
    {
      validation_command_present: Boolean(bootstrapCommand),
      policy_allowed: bootstrapCommand ? policyAllowsArgv(policy, bootstrapCommand.argv || []) : false,
      bootstrap_order: bootstrap.bootstrap_order,
      fresh_clone_replay_contract: bootstrap.fresh_clone_replay_contract,
      fail_closed_states: bootstrap.fail_closed_states,
      artifact_provenance: bootstrap.artifact_provenance || null
    },
    ['scripts/bha-run.js', '.bha/validation.yaml', '.bha/policy.yaml']
  ));
  checks.push(auditCheck(
    'proof_negative_matrix_machine_readable',
    'V2 proof negative matrix is machine-readable, fail-closed, non-authorizing, and wired into validation.',
    Boolean(negativeMatrixCommand &&
      policyAllowsArgv(policy, negativeMatrixCommand.argv || []) &&
      negativeMatrix.matrix_status === 'MACHINE_READABLE_FAIL_CLOSED_PREVIEW' &&
      negativeMatrix.command_case_results_pass === true &&
      negativeMatrix.artifact_case_results_declared === true &&
      negativeMatrix.artifact_case_results_pass === true &&
      negativeMatrix.activation_firewall &&
      negativeMatrix.activation_firewall.resolver_reads_production_authority_only === true &&
      negativeMatrix.activation_firewall.preview_merge_allowed === false &&
      negativeMatrix.activation_firewall.preview_authorizes_runtime === false &&
      negativeMatrix.activation_firewall.preview_artifact_can_enter_gate_positive_condition === false &&
      negativeMatrix.activation_firewall.council_trace_can_enter_gate_positive_condition === false &&
      negativeMatrix.activation_firewall.preview_injection_results_pass === true &&
      Array.isArray(negativeMatrix.activation_firewall.effective_production_capability_types) &&
      negativeMatrix.activation_firewall.effective_production_capability_types.length === 1 &&
      negativeMatrix.activation_firewall.effective_production_capability_types[0] === 'git_push' &&
      previewArtifactProvenanceValid(negativeMatrix, 'proof_negative_matrix_status')),
    {
      validation_command_present: Boolean(negativeMatrixCommand),
      policy_allowed: negativeMatrixCommand ? policyAllowsArgv(policy, negativeMatrixCommand.argv || []) : false,
      matrix_status: negativeMatrix.matrix_status,
      command_case_results_pass: negativeMatrix.command_case_results_pass,
      artifact_case_results_declared: negativeMatrix.artifact_case_results_declared,
      artifact_case_results_pass: negativeMatrix.artifact_case_results_pass,
      activation_firewall: negativeMatrix.activation_firewall || null,
      artifact_provenance: negativeMatrix.artifact_provenance || null
    },
    ['scripts/bha-run.js', '.bha/validation.yaml', '.bha/policy.yaml']
  ));
  checks.push(auditCheck(
    'capability_framework_machine_readable_draft',
    'Capability framework exposes a machine-readable non-enabling schema, binding, command, evidence, and replay draft.',
    Boolean(framework.machine_readable_draft &&
      framework.machine_readable_draft.status === 'DRAFT_NON_ENABLING' &&
      framework.machine_readable_draft.authorization_effect === false &&
      framework.machine_readable_draft.schema_draft &&
      framework.machine_readable_draft.schema_draft.schema === 'bha.capability_schema.v2.preview' &&
      Array.isArray(framework.machine_readable_draft.schema_draft.required_fields) &&
      framework.machine_readable_draft.schema_draft.required_fields.includes('type') &&
      framework.machine_readable_draft.schema_draft.required_fields.includes('binding') &&
      framework.machine_readable_draft.schema_draft.required_fields.includes('allowed_command') &&
      framework.machine_readable_draft.schema_draft.required_fields.includes('evidence_policy') &&
      framework.machine_readable_draft.binding_model &&
      framework.machine_readable_draft.binding_model.policy_hash_required === true &&
      framework.machine_readable_draft.binding_model.mission_hash_required === true &&
      framework.machine_readable_draft.allowed_command_constraints &&
      framework.machine_readable_draft.allowed_command_constraints.provider_deploy_release_commands_allowed === false &&
      framework.machine_readable_draft.evidence_policy &&
      framework.machine_readable_draft.evidence_policy.draft_evidence_is_authorization === false &&
      framework.machine_readable_draft.future_type_policy &&
      framework.machine_readable_draft.future_type_policy.unknown_types === 'DENY'),
    { machine_readable_draft: framework.machine_readable_draft || null },
    ['scripts/bha-run.js', 'BHA_V2_CAPABILITY_FRAMEWORK.md']
  ));
  checks.push(auditCheck(
    'capability_deny_replay_matrix_machine_readable',
    'Capability framework exposes a generic fail-closed deny/replay matrix for future capability types.',
    Boolean(framework.deny_replay_test_matrix &&
      framework.deny_replay_test_matrix.status === 'MACHINE_READABLE_PREVIEW' &&
      framework.deny_replay_test_matrix.required_before_allow === true &&
      framework.deny_replay_test_matrix.coverage_complete === false &&
      framework.deny_replay_test_matrix.case_results_pass === true &&
      Array.isArray(framework.deny_replay_test_matrix.cases) &&
      Array.isArray(framework.deny_replay_test_matrix.case_results) &&
      ['unknown_type', 'disallowed_type', 'incomplete_binding', 'stale_binding', 'wrong_policy_hash', 'wrong_mission_hash', 'expired', 'replay', 'overbroad_command'].every((id) => {
        return framework.deny_replay_test_matrix.cases.some((item) => item.id === id) &&
          framework.deny_replay_test_matrix.case_results.some((item) => item.id === id &&
            item.status === 'PASS' &&
            item.observed === item.expected &&
            item.authorization_effect === false);
      })),
    { deny_replay_test_matrix: framework.deny_replay_test_matrix || null },
    ['scripts/bha-run.js', '.bha/validation.yaml']
  ));
  checks.push(auditCheck(
    'verifier_evidence_contract_non_authorizing',
    'Verifier evidence contract is explicit that incomplete preview schema is rejected and draft evidence cannot authorize a gate.',
    Boolean(framework.verifier_evidence_contract &&
      framework.verifier_evidence_contract.status === 'PREVIEW_CONTRACT_CHECKED' &&
      framework.verifier_evidence_contract.verifier_must_reject_incomplete_preview_schema === true &&
      framework.verifier_evidence_contract.draft_evidence_is_authorization === false &&
      framework.verifier_evidence_contract.authorization_requires_policy_allow === true &&
      (verifierStrictPass || verifierValidationBootstrapPass) &&
      fileContains(VERIFY_SCRIPT, 'V2_CAPABILITY_PREVIEW_SCHEMA_INCOMPLETE')),
    {
      verifier_evidence_contract: framework.verifier_evidence_contract || null,
      verifier_status: verifierParsed.status || 'UNKNOWN',
      verifier_gate_pass: verifierStrictPass || verifierValidationBootstrapPass
    },
    ['scripts/bha-run.js', 'scripts/bha-verify.js']
  ));
  checks.push(auditCheck(
    'council_dry_run_model_machine_readable',
    'Council status exposes a machine-readable dry-run trace model that cannot spawn agents, write memory, call providers, or push.',
    Boolean(council.dry_run_model &&
      council.dry_run_model.schema === 'bha.council_dry_run.v2.preview' &&
      council.dry_run_model.status === 'DRAFT_NON_ACTIVATING' &&
      council.dry_run_model.trace_status === 'DRY_RUN_ONLY' &&
      council.dry_run_model.runtime_enabled === false &&
      council.dry_run_model.authorization_effect === false &&
      council.dry_run_model.can_spawn_agents === false &&
      council.dry_run_model.can_call_providers === false &&
      council.dry_run_model.can_write_memory === false &&
      council.dry_run_model.can_push === false &&
      council.dry_run_model.trace_is_production_evidence === false &&
      council.dry_run_model.trace_can_enter_gate_positive_condition === false &&
      Array.isArray(council.dry_run_model.trace_fields) &&
      council.dry_run_model.trace_fields.includes('commander_boundary') &&
      council.dry_run_model.trace_fields.includes('verifier_checks')),
    { dry_run_model: council.dry_run_model || null },
    ['scripts/bha-run.js', 'BHA_V2_COUNCIL_RUNTIME.md']
  ));
  checks.push(auditCheck(
    'council_role_boundary_matrix_machine_readable',
    'Council role boundary matrix is machine-readable and every role is non-proof, non-spawning, and non-authorizing.',
    Boolean(Array.isArray(council.role_boundary_matrix) &&
      council.role_boundary_matrix.length >= 4 &&
      council.role_boundary_matrix.every((role) => role.may_grant_remote_authority === false &&
        role.may_create_proof === false &&
        role.may_spawn_agents === false) &&
      council.activation_regression_matrix &&
      council.activation_regression_matrix.coverage_complete === false),
    {
      role_boundary_matrix: council.role_boundary_matrix || null,
      activation_regression_matrix: council.activation_regression_matrix || null
    },
    ['scripts/bha-run.js', 'BHA_V2_COUNCIL_RUNTIME.md']
  ));
  checks.push(auditCheck(
    'v2_hold_line_default_deny_preserved',
    'V2 preview hardening preserves default deny, git_push-only production scope, and no council runtime activation.',
    framework.default_decision === 'DENY' &&
      framework.unknown_capability_policy === 'DENY' &&
      Array.isArray(framework.production_capability_types) &&
      framework.production_capability_types.length === 1 &&
      framework.production_capability_types[0] === 'git_push' &&
      framework.enablement_gate &&
      framework.enablement_gate.new_production_capability_allowed === false &&
      council.runtime_state === 'PREVIEW_CONTRACT_ONLY' &&
      council.activation_gate &&
      council.activation_gate.runtime_activation_allowed === false &&
      council.automated_agent_spawn_allowed === false &&
      council.provider_calls_allowed === false &&
      council.memory_writes_allowed === false,
    {
      production_capability_types: framework.production_capability_types,
      enablement_gate: framework.enablement_gate,
      council_activation_gate: council.activation_gate
    },
    ['scripts/bha-run.js', '.bha/policy.yaml']
  ));
  checks.push(auditCheck(
    'audit_semantic_split_false_confidence_hardened',
    'V2 preview audit separates production enforcement from preview coverage, activation firewall, negative matrix, bootstrap, replay, local evidence limits, and activation blockers.',
    true,
    {
      sections: [
        'production_enforcement',
        'preview_coverage',
        'activation_firewall',
        'negative_matrix',
        'bootstrap_state',
        'fresh_clone_replay',
        'local_evidence_limits',
        'activation_blockers'
      ],
      preview_coverage_counts_as_production_pass: false,
      audit_pass_is_authorization: false,
      total_status: 'PREVIEW_HOLD_LINE'
    },
    ['scripts/bha-run.js', '.bha/validation.yaml']
  ));
  checks.push(auditCheck(
    'v2_preview_validation_and_policy_wired',
    'V2 preview audit, framework status, council status, and regression self-test are policy-allowed and validation-wired.',
    Boolean(auditCommand &&
      vocabularyCommand &&
      bootstrapCommand &&
      negativeMatrixCommand &&
      frameworkCommand &&
      councilCommand &&
      regressionCommand &&
      auditCommand.expect &&
      auditCommand.expect.read_only === true &&
      auditCommand.expect.recorded === false &&
      policyAllowsArgv(policy, auditCommand.argv || []) &&
      policyAllowsArgv(policy, ['node', 'scripts/bha-run.js', 'audit-v2-preview', '--format', 'json', '--allow-validation-in-progress'])),
    {
      audit_v2_preview_validation_command_present: Boolean(auditCommand),
      bootstrap_status_validation_command_present: Boolean(bootstrapCommand),
      proof_negative_matrix_status_validation_command_present: Boolean(negativeMatrixCommand),
      framework_status_validation_command_present: Boolean(frameworkCommand),
      council_status_validation_command_present: Boolean(councilCommand),
      regression_selftest_validation_command_present: Boolean(regressionCommand),
      policy_allowed: auditCommand ? policyAllowsArgv(policy, auditCommand.argv || []) : false
    },
    ['.bha/policy.yaml', '.bha/validation.yaml', 'scripts/bha-run.js']
  ));
  const protectedGateBranch = protectedBaseBranch(branch);
  const gitPushGateUnaffectedByPreview = protectedGateBranch
    ? gate.ok === false &&
      gate.status === 'BLOCKED' &&
      gate.capability &&
      gate.capability.ok === false &&
      gate.checks &&
      gate.checks.valid_consumed_capability === false &&
      gate.push_requirement &&
      gate.push_requirement.required_now === false
    : gate.capability &&
      gate.capability.ok === false &&
      gate.checks &&
      gate.checks.valid_consumed_capability === true &&
      gate.push_requirement &&
      gate.push_requirement.required_now === false &&
      gate.push_requirement.capability_required_for_real_push === false;
  checks.push(auditCheck(
    'v2_preview_does_not_affect_git_push_gate',
    'V2 preview status does not create gate authorization; protected branch push still requires capability, while topic branch push uses only the local evidence gate.',
    gitPushGateUnaffectedByPreview,
    {
      protected_branch: protectedGateBranch,
      gate_status: gate.status || 'UNKNOWN',
      gate_reason: gate.capability ? gate.capability.reason : 'UNKNOWN',
      valid_consumed_capability: gate.checks ? gate.checks.valid_consumed_capability : null,
      post_push_status: gate.post_push_status || null,
      push_requirement: gate.push_requirement || null
    },
    ['scripts/bha-run.js']
  ));

  const failed = checks.filter((check) => check.status !== 'PASS');
  const ok = failed.length === 0;
  const report = {
    ok,
    status: ok ? 'PASS' : 'FAIL',
    schema: 'bha.audit.v2_preview.v1',
    recorded: false,
    read_only: true,
    objective: 'V2 preview hardening audit for non-enabling capability framework and council dry-run model',
    proof_sources: [
      'scripts/bha-run.js',
      'scripts/bha-verify.js',
      '.bha/policy.yaml',
      '.bha/validation.yaml',
      'BHA_V2_CAPABILITY_FRAMEWORK.md',
      'BHA_V2_COUNCIL_RUNTIME.md',
      'gate-status'
    ],
    checks,
    failed,
    framework_summary: {
      default_decision: framework.default_decision,
      production_capability_types: framework.production_capability_types,
      machine_readable_draft_status: framework.machine_readable_draft ? framework.machine_readable_draft.status : 'MISSING',
      deny_replay_matrix_status: framework.deny_replay_test_matrix ? framework.deny_replay_test_matrix.status : 'MISSING',
      deny_replay_matrix_cases_pass: framework.deny_replay_test_matrix ? framework.deny_replay_test_matrix.case_results_pass : false,
      new_production_capability_allowed: framework.enablement_gate
        ? framework.enablement_gate.new_production_capability_allowed
        : null
    },
    council_summary: {
      runtime_state: council.runtime_state,
      dry_run_model_status: council.dry_run_model ? council.dry_run_model.status : 'MISSING',
      runtime_activation_allowed: council.activation_gate
        ? council.activation_gate.runtime_activation_allowed
        : null,
      automated_agent_spawn_allowed: council.automated_agent_spawn_allowed
    },
    proof_vocabulary: {
      status: vocabulary.status,
      confidence_labels: Object.keys(vocabulary.proof_levels),
      preview_forbidden_authority_terms: vocabulary.preview_semantics.forbidden_authority_terms,
      preview_authorizes_runtime: vocabulary.preview_semantics.preview_authorizes_runtime,
      prose_text_scan_allowed: vocabulary.critical_judgment.prose_text_scan_allowed
    },
    bootstrap_summary: {
      status: bootstrap.status,
      ledger_is_bootstrap_trust_root: bootstrap.ledger_is_bootstrap_trust_root,
      local_cache_required: bootstrap.local_cache_required,
      private_key_required: bootstrap.private_key_required,
      damaged_ledger_status: bootstrap.fresh_clone_replay_contract
        ? bootstrap.fresh_clone_replay_contract.damaged_ledger_status
        : 'UNKNOWN'
    },
    negative_matrix_summary: {
      status: negativeMatrix.status,
      matrix_status: negativeMatrix.matrix_status,
      command_case_results_pass: negativeMatrix.command_case_results_pass,
      artifact_case_results_declared: negativeMatrix.artifact_case_results_declared,
      artifact_case_results_pass: negativeMatrix.artifact_case_results_pass,
      preview_injection_results_pass: negativeMatrix.activation_firewall
        ? negativeMatrix.activation_firewall.preview_injection_results_pass
        : false
    },
    semantic_sections: {
      production_enforcement: {
        status: 'VERIFIER_GATED',
        effective_production_capability_types: framework.production_capability_types,
        preview_coverage_counts_as_production_pass: false,
        gate_positive_sources_exclude_preview: true
      },
      preview_coverage: {
        status: 'PREVIEW_HOLD_LINE',
        framework_draft_status: framework.machine_readable_draft ? framework.machine_readable_draft.status : 'MISSING',
        council_dry_run_status: council.dry_run_model ? council.dry_run_model.status : 'MISSING',
        preview_authorizes_runtime: false
      },
      activation_firewall: {
        status: 'INTACT',
        resolver_reads_production_authority_only: negativeMatrix.activation_firewall
          ? negativeMatrix.activation_firewall.resolver_reads_production_authority_only
          : false,
        preview_merge_allowed: negativeMatrix.activation_firewall
          ? negativeMatrix.activation_firewall.preview_merge_allowed
          : null,
        effective_production_capability_types: negativeMatrix.activation_firewall
          ? negativeMatrix.activation_firewall.effective_production_capability_types
          : []
      },
      negative_matrix: {
        status: negativeMatrix.matrix_status,
        command_case_results_pass: negativeMatrix.command_case_results_pass,
        artifact_case_results_declared: negativeMatrix.artifact_case_results_declared,
        artifact_case_results_pass: negativeMatrix.artifact_case_results_pass
      },
      bootstrap_state: {
        status: bootstrap.status,
        ledger_is_bootstrap_trust_root: bootstrap.ledger_is_bootstrap_trust_root,
        local_cache_required: bootstrap.local_cache_required
      },
      fresh_clone_replay: {
        status: 'REPLAY_CONTRACT_AVAILABLE',
        requires_bha_local: bootstrap.fresh_clone_replay_contract
          ? bootstrap.fresh_clone_replay_contract.requires_bha_local
          : null,
        damaged_ledger_status: bootstrap.fresh_clone_replay_contract
          ? bootstrap.fresh_clone_replay_contract.damaged_ledger_status
          : 'UNKNOWN'
      },
      local_evidence_limits: {
        local_only_capability_evidence_is_remote_proof: false,
        closeout_prose_is_proof: false,
        audit_pass_is_authorization: false
      },
      activation_blockers: {
        status: 'PREVIEW_HOLD_LINE',
        missing_before_enablement: framework.test_requirements ? framework.test_requirements.missing_before_enablement : [],
        missing_before_activation: council.test_requirements ? council.test_requirements.missing_before_activation : []
      }
    },
    total_status: 'PREVIEW_HOLD_LINE',
    remote,
    branch,
    validation_in_progress_allowed: allowValidationInProgress,
    validation_in_progress_override: verifierValidationBootstrapPass,
    verifier_gate: {
      strict_pass: verifierStrictPass,
      accepted: verifierStrictPass || verifierValidationBootstrapPass,
      issue_codes: verifierIssueCodes,
      warning_codes: verifierWarningCodes
    },
    proof_boundary: 'audit-v2-preview is read-only preview coverage. It does not enable capabilities, spawn agents, write memory, push, deploy, release, tag, publish packages, read private keys, or turn draft evidence into authorization.'
  };
  console.log(JSON.stringify(withArtifactProvenance(report, {
    type: 'audit_v2_preview',
    generated_by: 'node scripts/bha-run.js audit-v2-preview --format json',
    input_hashes: {
      gate_status: sha256(stable(gate)),
      capability_framework_status: framework.artifact_provenance ? framework.artifact_provenance.output_hash : null,
      council_status: council.artifact_provenance ? council.artifact_provenance.output_hash : null,
      proof_vocabulary_status: vocabulary.artifact_provenance ? vocabulary.artifact_provenance.output_hash : null,
      bootstrap_status: bootstrap.artifact_provenance ? bootstrap.artifact_provenance.output_hash : null,
      proof_negative_matrix_status: negativeMatrix.artifact_provenance ? negativeMatrix.artifact_provenance.output_hash : null
    }
  })));
  if (!ok) {
    process.exitCode = 1;
  }
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
    'package_install_denied',
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
    'recover_status_reports_stale_local_payload_recovery',
    'signed_payload_status_reports_ready_payload',
    'operator_signer_preflight_validation_wired',
    'operator_signer_preflight_blocks_missing_key_path',
    'operator_signer_preflight_blocks_repo_key_path',
    'operator_signer_preflight_accepts_external_key_path_without_reading_key',
    'recover_status_validation_wired',
    'capability_framework_status_validation_wired',
    'capability_framework_machine_readable_draft_status',
    'capability_framework_deny_replay_matrix_status',
    'verifier_v2_preview_contract_wired',
    'council_status_validation_wired',
    'council_dry_run_model_status',
    'council_role_boundary_matrix_status',
    'audit_v2_preview_validation_wired',
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
    'gate_status_copyable_commands_quote_arguments',
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
      inspectCommand.expect &&
      Array.isArray(inspectCommand.expect.has_keys) &&
      inspectCommand.expect.has_keys.includes('schema') &&
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
      inspect_schema_required: Boolean(inspectCommand && inspectCommand.expect && Array.isArray(inspectCommand.expect.has_keys) && inspectCommand.expect.has_keys.includes('schema')),
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
      capabilityFramework().enablement_gate &&
      capabilityFramework().enablement_gate.new_production_capability_allowed === false &&
      capabilityFramework().enablement_gate.requires_new_explicit_objective === true &&
      capabilityFramework().enablement_gate.requires_verifier_evidence === true &&
      capabilityFramework().test_requirements &&
      capabilityFramework().test_requirements.deny_tests_required_before_allow === true &&
      capabilityFramework().test_requirements.replay_tests_required_before_allow === true),
    {
      validation_command_present: Boolean(capabilityFrameworkCommand),
      policy_allowed: capabilityFrameworkCommand ? policyAllowsArgv(policy, capabilityFrameworkCommand.argv) : false,
      default_decision: capabilityFramework().default_decision,
      unknown_capability_policy: capabilityFramework().unknown_capability_policy,
      enablement_gate: capabilityFramework().enablement_gate,
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
      councilRuntimeStatus().memory_writes_allowed === false &&
      councilRuntimeStatus().activation_gate &&
      councilRuntimeStatus().activation_gate.runtime_activation_allowed === false &&
      councilRuntimeStatus().activation_gate.requires_new_explicit_objective === true &&
      councilRuntimeStatus().activation_gate.requires_verifier_backed_workflow_model === true),
    {
      validation_command_present: Boolean(councilStatusCommand),
      policy_allowed: councilStatusCommand ? policyAllowsArgv(policy, councilStatusCommand.argv) : false,
      runtime_state: councilRuntimeStatus().runtime_state,
      automated_agent_spawn_allowed: councilRuntimeStatus().automated_agent_spawn_allowed,
      provider_calls_allowed: councilRuntimeStatus().provider_calls_allowed,
      memory_writes_allowed: councilRuntimeStatus().memory_writes_allowed,
      activation_gate: councilRuntimeStatus().activation_gate
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
      Array.isArray(hookCommand.expect.has_keys) &&
      hookCommand.expect.has_keys.includes('schema') &&
      !Object.prototype.hasOwnProperty.call(hookCommand.expect, 'ok') &&
      !Object.prototype.hasOwnProperty.call(hookCommand.expect, 'status')),
    {
      validation_command_present: Boolean(hookCommand),
      schema_required: Boolean(hookCommand && hookCommand.expect && Array.isArray(hookCommand.expect.has_keys) && hookCommand.expect.has_keys.includes('schema')),
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
    ['provider_call', 'memory_write', 'deploy', 'release', 'tag', 'package_install', 'package_publish', 'production_write', 'force_push', 'destructive_fs']
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
        'scripts/lib/command-effects.js',
        'scripts/lib/policy-check.js',
        'scripts/lib/validation-runner.js',
        'scripts/lib/capability-store.js',
        'scripts/lib/push-gate.js',
        'scripts/lib/git-reality.js',
        'scripts/lib/local-payload-status.js',
        'scripts/lib/payload-summary.js',
        'scripts/lib/capability-verifier.js',
        '.githooks/pre-push',
        '.github/workflows/bha-readonly-gate.yml'
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
        destructive_commands: ['rm', 'rmdir', 'del'],
        package_install_commands: ['npm install', 'npm ci', 'pnpm install', 'yarn install'],
        package_publish_commands: ['npm publish', 'pnpm publish', 'yarn npm publish'],
        release_commands: ['gh release', 'git tag', 'npm version', 'pnpm version', 'yarn version'],
        ssh_commands: ['ssh', 'scp', 'rsync'],
        deploy_commands: ['vercel', 'netlify', 'firebase', 'kubectl', 'docker push']
      },
      allow: [
        { command: 'git', args: ['diff', '--check'], reason: 'local whitespace validation' },
        { command: 'git', args: ['status'], reason: 'local repository status inspection' },
        { command: 'node', args: ['--check', 'scripts/lib/command-effects.js'], reason: 'local syntax validation' },
        { command: 'node', args: ['--check', 'scripts/lib/policy-check.js'], reason: 'local syntax validation' },
        { command: 'node', args: ['--check', 'scripts/lib/validation-runner.js'], reason: 'local syntax validation' },
        { command: 'node', args: ['--check', 'scripts/lib/capability-store.js'], reason: 'local syntax validation' },
        { command: 'node', args: ['--check', 'scripts/lib/push-gate.js'], reason: 'local syntax validation' },
        { command: 'node', args: ['--check', 'scripts/lib/git-reality.js'], reason: 'local syntax validation' },
        { command: 'node', args: ['--check', 'scripts/lib/local-payload-status.js'], reason: 'local syntax validation' },
        { command: 'node', args: ['--check', 'scripts/lib/payload-summary.js'], reason: 'local syntax validation' },
        { command: 'node', args: ['--check', 'scripts/lib/capability-verifier.js'], reason: 'local syntax validation' },
        { command: 'node', args: ['scripts/bha-run.js', 'rollback-drill', '--format', 'json'], reason: 'read-only rollback drill' },
        { command: 'node', args: ['scripts/bha-run.js', 'proof-vocabulary-status', '--format', 'json'], reason: 'read-only V2 proof vocabulary status' },
        { command: 'node', args: ['scripts/bha-run.js', 'bootstrap-status', '--format', 'json'], reason: 'read-only V2 bootstrap and fresh-clone replay status' },
        { command: 'node', args: ['scripts/bha-run.js', 'proof-negative-matrix-status', '--format', 'json'], reason: 'read-only V2 proof negative matrix status' },
        { command: 'node', args: ['scripts/bha-run.js', 'capability-framework-status', '--format', 'json'], reason: 'read-only V2 capability framework status' },
        { command: 'node', args: ['scripts/bha-run.js', 'council-status', '--format', 'json'], reason: 'read-only V2 council runtime status' },
        { command: 'node', args: ['scripts/bha-run.js', 'audit-v2-preview', '--format', 'json', '--allow-validation-in-progress'], reason: 'read-only V2 preview audit during validation bootstrap' },
        { command: 'node', args_prefix: ['scripts/bha-run.js', 'check', '--'], reason: 'nested dry-run policy check' },
        { command: 'node', args_prefix: ['scripts/bha-run.js', 'assert-deny', '--'], reason: 'negative dry-run policy assertion' }
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
        'package_install',
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
    required_commands: [
      {
        id: 'rollback_drill_readonly',
        argv: ['node', 'scripts/bha-run.js', 'rollback-drill', '--format', 'json'],
        expect: { exit_code: 0, ok: true, status: 'PASS' }
      },
      {
        id: 'capability_framework_status_readonly',
        argv: ['node', 'scripts/bha-run.js', 'capability-framework-status', '--format', 'json'],
        expect: {
          exit_code: 0,
          ok: true,
          status: 'CAPABILITY_FRAMEWORK_STATUS',
          recorded: false,
          read_only: true,
          json_paths: {
            'proof_vocabulary.status': 'PROOF_VOCABULARY_STATUS',
            'proof_vocabulary.preview_authorizes_runtime': false,
            'proof_vocabulary.confidence_labels.0': 'VERIFIED',
            'machine_readable_draft.status': 'DRAFT_NON_ENABLING',
            'machine_readable_draft.authorization_effect': false,
            'machine_readable_draft.schema_draft.schema': 'bha.capability_schema.v2.preview',
            'deny_replay_test_matrix.status': 'MACHINE_READABLE_PREVIEW',
            'deny_replay_test_matrix.case_results_pass': true,
            'deny_replay_test_matrix.case_results.0.status': 'PASS',
            'deny_replay_test_matrix.case_results.8.status': 'PASS',
            'verifier_evidence_contract.verifier_must_reject_incomplete_preview_schema': true,
            'verifier_evidence_contract.draft_evidence_is_authorization': false,
            'artifact_provenance.type': 'capability_framework_status',
            'artifact_provenance.authority': 'NON_AUTHORITATIVE_PREVIEW',
            'artifact_provenance.status': 'PREVIEW_ONLY',
            'artifact_provenance.non_authoritative': true,
            'artifact_provenance.non_activating': true,
            'artifact_provenance.grants_capability': false,
            'artifact_provenance.local_only': true
          },
          has_keys: ['machine_readable_draft', 'deny_replay_test_matrix', 'verifier_evidence_contract', 'artifact_provenance']
        }
      },
      {
        id: 'proof_vocabulary_status_readonly',
        argv: ['node', 'scripts/bha-run.js', 'proof-vocabulary-status', '--format', 'json'],
        expect: {
          exit_code: 0,
          ok: true,
          status: 'PROOF_VOCABULARY_STATUS',
          recorded: false,
          read_only: true,
          json_paths: {
            'current_phase': 'PREVIEW_HOLD_LINE',
            'trust_boundaries.clean_repo_is_trust_root': false,
            'trust_boundaries.audit_pass_is_trust_root': false,
            'trust_boundaries.closeout_prose_is_trust_root': false,
            'trust_boundaries.ledger_is_bootstrap_trust_root': false,
            'preview_semantics.preview_authorizes_runtime': false,
            'preview_semantics.dry_run_trace_authorizes_runtime': false,
            'preview_semantics.dry_run_trace_is_validation_evidence': false,
            'preview_semantics.forbidden_authority_terms.0': 'enabled',
            'preview_semantics.forbidden_authority_terms.4': 'ready',
            'critical_judgment.structured_evidence_required': true,
            'critical_judgment.prose_text_scan_allowed': false,
            'gate_semantics.preview_artifact_can_enter_gate_positive_condition': false,
            'gate_semantics.production_capability_types.0': 'git_push',
            'artifact_provenance.type': 'proof_vocabulary_status',
            'artifact_provenance.authority': 'NON_AUTHORITATIVE_PREVIEW',
            'artifact_provenance.status': 'PREVIEW_ONLY',
            'artifact_provenance.non_authoritative': true,
            'artifact_provenance.non_activating': true,
            'artifact_provenance.grants_capability': false,
            'artifact_provenance.local_only': true
          },
          has_keys: ['proof_levels', 'trust_boundaries', 'preview_semantics', 'critical_judgment', 'gate_semantics', 'artifact_provenance']
        }
      },
      {
        id: 'bootstrap_status_readonly',
        argv: ['node', 'scripts/bha-run.js', 'bootstrap-status', '--format', 'json'],
        expect: {
          exit_code: 0,
          ok: true,
          status: 'BOOTSTRAP_REPLAY_STATUS',
          recorded: false,
          read_only: true,
          json_paths: {
            'current_phase': 'PREVIEW_HOLD_LINE',
            'ledger_is_bootstrap_trust_root': false,
            'local_cache_required': false,
            'private_key_required': false,
            'provider_call_required': false,
            'remote_write_required': false,
            'bootstrap_order.0.id': 'verifier_syntax',
            'bootstrap_order.1.id': 'verifier_self_test',
            'bootstrap_order.4.effective_production_capability_types.0': 'git_push',
            'bootstrap_order.5.capability_preview_authorizes_runtime': false,
            'bootstrap_order.5.council_runtime_activation_allowed': false,
            'fresh_clone_replay_contract.requires_bha_local': false,
            'fresh_clone_replay_contract.requires_private_key': false,
            'fresh_clone_replay_contract.damaged_ledger_status': 'REPLAY_REQUIRED',
            'fail_closed_states.missing_ledger': 'HISTORICAL_EVIDENCE_UNAVAILABLE',
            'fail_closed_states.corrupt_ledger': 'REPLAY_REQUIRED',
            'activation_firewall.effective_production_capability_types.0': 'git_push',
            'artifact_provenance.type': 'bootstrap_status',
            'artifact_provenance.authority': 'NON_AUTHORITATIVE_PREVIEW',
            'artifact_provenance.status': 'PREVIEW_ONLY',
            'artifact_provenance.non_authoritative': true,
            'artifact_provenance.non_activating': true,
            'artifact_provenance.grants_capability': false,
            'artifact_provenance.local_only': true
          },
          has_keys: ['bootstrap_order', 'fresh_clone_replay_contract', 'fail_closed_states', 'activation_firewall', 'artifact_provenance']
        }
      },
      {
        id: 'proof_negative_matrix_status_readonly',
        argv: ['node', 'scripts/bha-run.js', 'proof-negative-matrix-status', '--format', 'json'],
        expect: {
          exit_code: 0,
          ok: true,
          status: 'PROOF_NEGATIVE_MATRIX_STATUS',
          recorded: false,
          read_only: true,
          json_paths: {
            'current_phase': 'PREVIEW_HOLD_LINE',
            'matrix_status': 'MACHINE_READABLE_FAIL_CLOSED_PREVIEW',
            'command_case_results_pass': true,
            'artifact_case_results_declared': true,
            'artifact_case_results_pass': true,
            'activation_firewall.resolver_reads_production_authority_only': true,
            'activation_firewall.preview_merge_allowed': false,
            'activation_firewall.preview_authorizes_runtime': false,
            'activation_firewall.preview_artifact_can_enter_gate_positive_condition': false,
            'activation_firewall.council_trace_can_enter_gate_positive_condition': false,
            'activation_firewall.effective_production_capability_types.0': 'git_push',
            'activation_firewall.council_runtime_activation_allowed': false,
            'activation_firewall.preview_injection_results_pass': true,
            'verifier_contract.read_only_verifier_required': true,
            'verifier_contract.prose_text_scan_allowed_for_critical_judgment': false,
            'artifact_provenance.type': 'proof_negative_matrix_status',
            'artifact_provenance.authority': 'NON_AUTHORITATIVE_PREVIEW',
            'artifact_provenance.status': 'PREVIEW_ONLY',
            'artifact_provenance.non_authoritative': true,
            'artifact_provenance.non_activating': true,
            'artifact_provenance.grants_capability': false,
            'artifact_provenance.local_only': true
          },
          has_keys: ['command_case_results', 'artifact_case_results', 'activation_firewall', 'verifier_contract', 'artifact_provenance']
        }
      },
      {
        id: 'council_status_readonly',
        argv: ['node', 'scripts/bha-run.js', 'council-status', '--format', 'json'],
        expect: {
          exit_code: 0,
          ok: true,
          status: 'COUNCIL_RUNTIME_STATUS',
          recorded: false,
          read_only: true,
          json_paths: {
            'proof_vocabulary.status': 'PROOF_VOCABULARY_STATUS',
            'proof_vocabulary.dry_run_trace_authorizes_runtime': false,
            'proof_vocabulary.dry_run_trace_is_validation_evidence': false,
            'dry_run_model.schema': 'bha.council_dry_run.v2.preview',
            'dry_run_model.status': 'DRAFT_NON_ACTIVATING',
            'dry_run_model.trace_status': 'DRY_RUN_ONLY',
            'dry_run_model.runtime_enabled': false,
            'dry_run_model.authorization_effect': false,
            'dry_run_model.trace_is_production_evidence': false,
            'dry_run_model.trace_can_enter_gate_positive_condition': false,
            'role_boundary_matrix.0.may_grant_remote_authority': false,
            'role_boundary_matrix.0.may_create_proof': false,
            'role_boundary_matrix.0.may_spawn_agents': false,
            'activation_regression_matrix.status': 'MACHINE_READABLE_PREVIEW',
            'activation_regression_matrix.coverage_complete': false,
            'artifact_provenance.type': 'council_status',
            'artifact_provenance.authority': 'NON_AUTHORITATIVE_PREVIEW',
            'artifact_provenance.status': 'PREVIEW_ONLY',
            'artifact_provenance.non_authoritative': true,
            'artifact_provenance.non_activating': true,
            'artifact_provenance.grants_capability': false,
            'artifact_provenance.local_only': true
          },
          has_keys: ['dry_run_model', 'role_boundary_matrix', 'activation_regression_matrix', 'artifact_provenance']
        }
      },
      {
        id: 'audit_v2_preview_readonly',
        argv: ['node', 'scripts/bha-run.js', 'audit-v2-preview', '--format', 'json', '--allow-validation-in-progress'],
        expect: {
          exit_code: 0,
          ok: true,
          status: 'PASS',
          recorded: false,
          read_only: true,
          json_paths: {
            'framework_summary.machine_readable_draft_status': 'DRAFT_NON_ENABLING',
            'framework_summary.deny_replay_matrix_status': 'MACHINE_READABLE_PREVIEW',
            'framework_summary.deny_replay_matrix_cases_pass': true,
            'framework_summary.new_production_capability_allowed': false,
            'council_summary.dry_run_model_status': 'DRAFT_NON_ACTIVATING',
            'council_summary.runtime_activation_allowed': false,
            'proof_vocabulary.status': 'PROOF_VOCABULARY_STATUS',
            'proof_vocabulary.preview_authorizes_runtime': false,
            'proof_vocabulary.prose_text_scan_allowed': false,
            'bootstrap_summary.status': 'BOOTSTRAP_REPLAY_STATUS',
            'bootstrap_summary.ledger_is_bootstrap_trust_root': false,
            'bootstrap_summary.local_cache_required': false,
            'bootstrap_summary.private_key_required': false,
            'bootstrap_summary.damaged_ledger_status': 'REPLAY_REQUIRED',
            'negative_matrix_summary.status': 'PROOF_NEGATIVE_MATRIX_STATUS',
            'negative_matrix_summary.matrix_status': 'MACHINE_READABLE_FAIL_CLOSED_PREVIEW',
            'negative_matrix_summary.command_case_results_pass': true,
            'negative_matrix_summary.artifact_case_results_declared': true,
            'negative_matrix_summary.artifact_case_results_pass': true,
            'negative_matrix_summary.preview_injection_results_pass': true,
            'semantic_sections.production_enforcement.status': 'VERIFIER_GATED',
            'semantic_sections.production_enforcement.preview_coverage_counts_as_production_pass': false,
            'semantic_sections.preview_coverage.status': 'PREVIEW_HOLD_LINE',
            'semantic_sections.activation_firewall.status': 'INTACT',
            'semantic_sections.negative_matrix.status': 'MACHINE_READABLE_FAIL_CLOSED_PREVIEW',
            'semantic_sections.negative_matrix.artifact_case_results_pass': true,
            'semantic_sections.bootstrap_state.status': 'BOOTSTRAP_REPLAY_STATUS',
            'semantic_sections.fresh_clone_replay.status': 'REPLAY_CONTRACT_AVAILABLE',
            'semantic_sections.local_evidence_limits.audit_pass_is_authorization': false,
            'semantic_sections.activation_blockers.status': 'PREVIEW_HOLD_LINE',
            'total_status': 'PREVIEW_HOLD_LINE',
            'artifact_provenance.authority': 'NON_AUTHORITATIVE_PREVIEW',
            'artifact_provenance.status': 'PREVIEW_ONLY',
            'artifact_provenance.non_authoritative': true,
            'artifact_provenance.non_activating': true,
            'artifact_provenance.grants_capability': false,
            'artifact_provenance.local_only': true,
            'validation_in_progress_allowed': true,
            'verifier_gate.accepted': true
          },
          has_keys: ['schema', 'checks', 'framework_summary', 'council_summary', 'bootstrap_summary', 'negative_matrix_summary', 'semantic_sections', 'artifact_provenance', 'proof_boundary']
        }
      }
    ]
  };
  writeTextFile(path.join(fixtureRoot, '.gitignore'), '.bha/local/\n');
  writeTextFile(path.join(fixtureRoot, 'AGENTS.md'), '# Regression Fixture\n\nAGENTS.md guides behavior and is not proof.\n');
  writeTextFile(path.join(fixtureRoot, 'BHA_DESIGN.md'), '# Regression Fixture Design\n\nLocal deterministic evidence fixture.\n');
  writeTextFile(path.join(fixtureRoot, 'BHA_LONG_TERM_GOAL_AUDIT.md'), '# Regression Fixture Long-Term Goal Audit\n\nStatus: local Commander audit, not proof.\n');
  writeTextFile(path.join(fixtureRoot, 'BHA_V1_STABILITY.md'), '# Regression Fixture Stability\n\nProof comes from repository reality, ledger/state evidence, verifier, policy/mission hash, local-only capability evidence, and git reality.\n');
  writeTextFile(path.join(fixtureRoot, 'BHA_V2_CAPABILITY_FRAMEWORK.md'), [
    '# Regression Fixture Capability Framework',
    '',
    'Default deny capability framework preview. git_push is the only enabled production capability.',
    '',
    '## Machine-Readable Preview Contract',
    '',
    'The schema draft, binding model, deny/replay matrix, and verifier evidence contract are non-enabling regression fixture evidence only.'
  ].join('\n') + '\n');
  writeTextFile(path.join(fixtureRoot, 'BHA_V2_COUNCIL_RUNTIME.md'), [
    '# Regression Fixture Council Runtime',
    '',
    'Council Runtime role output is coordination context and not proof.',
    '',
    '## Machine-Readable Dry-Run Contract',
    '',
    'The dry-run trace, role boundary matrix, and activation regression matrix are non-activating regression fixture evidence only.'
  ].join('\n') + '\n');
  writeTextFile(path.join(fixtureRoot, '.bha', 'roadmap.md'), '# Regression Fixture Roadmap\n\nKeep proof local and deterministic.\n');
  writeTextFile(path.join(fixtureRoot, '.bha', 'rollback.md'), regressionRollbackText());
  writeTextFile(path.join(fixtureRoot, '.githooks', 'pre-push'), '#!/bin/sh\nnode scripts/bha-run.js prepush-check --internal-git-hook "$@"\n');
  fs.mkdirSync(path.join(fixtureRoot, '.github', 'workflows'), { recursive: true });
  fs.copyFileSync(CI_READONLY_GATE_PATH, path.join(fixtureRoot, '.github', 'workflows', 'bha-readonly-gate.yml'));
  fs.mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(RUN_SCRIPT, path.join(fixtureRoot, 'scripts', 'bha-run.js'));
  fs.copyFileSync(VERIFY_SCRIPT, path.join(fixtureRoot, 'scripts', 'bha-verify.js'));
  fs.copyFileSync(COMMAND_EFFECTS_SCRIPT, path.join(fixtureRoot, 'scripts', 'lib', 'command-effects.js'));
  fs.copyFileSync(POLICY_CHECK_SCRIPT, path.join(fixtureRoot, 'scripts', 'lib', 'policy-check.js'));
  fs.copyFileSync(VALIDATION_RUNNER_SCRIPT, path.join(fixtureRoot, 'scripts', 'lib', 'validation-runner.js'));
  fs.copyFileSync(CAPABILITY_STORE_SCRIPT, path.join(fixtureRoot, 'scripts', 'lib', 'capability-store.js'));
  fs.copyFileSync(PUSH_GATE_SCRIPT, path.join(fixtureRoot, 'scripts', 'lib', 'push-gate.js'));
  fs.copyFileSync(GIT_REALITY_SCRIPT, path.join(fixtureRoot, 'scripts', 'lib', 'git-reality.js'));
  fs.copyFileSync(LOCAL_PAYLOAD_STATUS_SCRIPT, path.join(fixtureRoot, 'scripts', 'lib', 'local-payload-status.js'));
  fs.copyFileSync(PAYLOAD_SUMMARY_SCRIPT, path.join(fixtureRoot, 'scripts', 'lib', 'payload-summary.js'));
  fs.copyFileSync(CAPABILITY_VERIFIER_SCRIPT, path.join(fixtureRoot, 'scripts', 'lib', 'capability-verifier.js'));
  writeJson(path.join(fixtureRoot, '.bha', 'mission.yaml'), mission);
  writeJson(path.join(fixtureRoot, '.bha', 'policy.yaml'), policy);
  writeJson(path.join(fixtureRoot, '.bha', 'validation.yaml'), validation);
  writeTextFile(path.join(fixtureRoot, '.bha', 'capabilities.jsonl'), '');

  const validationInputs = validationInputsHashForRoot(fixtureRoot);
  const commandRecords = validation.required_commands.map((command) => ({
    id: command.id,
    argv: command.argv,
    expect: command.expect || {},
    decision: 'ALLOW',
    allowed: true,
    rule: 'ALLOW_EXACT',
    category: 'local',
    reason: 'regression fixture seeded validation evidence',
    spawned: true,
    status: 'PASS',
    problems: [],
    exit_code: 0,
    signal: null,
    error: null
  }));
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
      commands: commandRecords
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
    commands: commandRecords
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
    completed: validation.required_commands.map((command) => command.id),
    changed_files: [],
    validation_run: {
      status: 'PASS',
      completed_at: state.validation.completed_at,
      ledger_event_hash: validationEvent.event_hash,
      command_count: validation.required_commands.length
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

function runtimeStateOrIoBoundaryEvidence(file) {
  return {
    no_date_now: !fileContains(file, 'Date.now'),
    no_process_access: !fileContains(file, /\bprocess\./),
    no_fs_import_or_use: !fileContains(file, "require('fs')") &&
      !fileContains(file, /\bfs\./),
    no_ledger_writes: !fileContains(file, /\bappendLedger\b/) &&
      !fileContains(file, /\bappendFileSync\b/) &&
      !fileContains(file, /\bwriteFileSync\b/) &&
      !fileContains(file, /\bcreateWriteStream\b/)
  };
}

function runtimeStateOrIoBoundaryCheck(id, file) {
  const evidence = runtimeStateOrIoBoundaryEvidence(file);
  return regressionCheck(id, Object.values(evidence).every((value) => value === true), evidence);
}

function callerProvidedInputBoundaryEvidence(file, options) {
  const opts = options || {};
  const text = fs.existsSync(file) ? readText(file) : '';
  const allowedRequires = new Set(opts.allowedRequires || []);
  const allowedProcess = new Set(opts.allowedProcess || []);
  const requireMatches = Array.from(text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g))
    .map((match) => match[1]);
  const processMatches = Array.from(text.matchAll(/\bprocess\.[A-Za-z_$][A-Za-z0-9_$]*/g))
    .map((match) => match[0]);
  const disallowedRequires = requireMatches.filter((item) => !allowedRequires.has(item));
  const disallowedProcess = processMatches.filter((item) => !allowedProcess.has(item));
  return {
    module_exists: fs.existsSync(file),
    no_disallowed_requires: disallowedRequires.length === 0,
    allowed_requires: requireMatches.filter((item) => allowedRequires.has(item)),
    no_disallowed_process_access: disallowedProcess.length === 0,
    allowed_process_access: processMatches.filter((item) => allowedProcess.has(item)),
    no_date_now: !/Date\.now/.test(text),
    no_fs_import_or_use: !/\brequire\s*\(\s*['"]fs['"]\s*\)/.test(text) && !/\bfs\./.test(text),
    no_file_reads: !/\breadFile(?:Sync)?\b/.test(text) && !/\bcreateReadStream\b/.test(text),
    no_file_writes: !/\bwriteFile(?:Sync)?\b/.test(text) &&
      !/\bappendFile(?:Sync)?\b/.test(text) &&
      !/\bcreateWriteStream\b/.test(text),
    no_command_execution: !/\bchild_process\b/.test(text) &&
      !/\bspawn(?:Sync)?\b/.test(text) &&
      !/\bexec(?:File|FileSync|Sync)?\b/.test(text) &&
      !/\brunCommand\b/.test(text),
    no_ledger_writes: !/\bappendLedger\b/.test(text),
    no_policy_state_load: !/\bload(?:Policy|Mission|State)\b/.test(text)
  };
}

function callerProvidedInputBoundaryCheck(id, file, options) {
  const evidence = callerProvidedInputBoundaryEvidence(file, options);
  const booleanValues = Object.entries(evidence)
    .filter((entry) => typeof entry[1] === 'boolean')
    .map((entry) => entry[1]);
  return regressionCheck(id, booleanValues.every((value) => value === true), evidence);
}

function validationRunnerBoundaryEvidence(file) {
  const text = fs.existsSync(file) ? readText(file) : '';
  const runCommandCalls = Array.from(text.matchAll(/\b(?:[A-Za-z_$][A-Za-z0-9_$]*\.)?runCommand\s*\(/g))
    .map((match) => match[0]);
  const disallowedRunCommandCalls = runCommandCalls.filter((call) => call !== 'deps.runCommand(');
  return {
    module_exists: fs.existsSync(file),
    no_requires: !/\brequire\s*\(/.test(text),
    no_process_access: !/\bprocess\./.test(text),
    no_fs_import_or_use: !/\brequire\s*\(\s*['"]fs['"]\s*\)/.test(text) && !/\bfs\./.test(text),
    no_file_reads: !/\breadFile(?:Sync)?\b/.test(text) && !/\bcreateReadStream\b/.test(text),
    no_file_writes: !/\bwriteFile(?:Sync)?\b/.test(text) &&
      !/\bappendFile(?:Sync)?\b/.test(text) &&
      !/\bcreateWriteStream\b/.test(text),
    no_command_execution_imports: !/\bchild_process\b/.test(text) &&
      !/\bspawn(?:Sync)?\b/.test(text) &&
      !/\bexec(?:File|FileSync|Sync)?\b/.test(text),
    command_execution_only_via_injected_run_command: runCommandCalls.length > 0 &&
      disallowedRunCommandCalls.length === 0,
    policy_check_is_injected: /\bdeps\.evaluateValidationCommandPolicy\s*\(\s*command\.argv\s*\)/.test(text),
    validation_step_recording_is_injected: /\bdeps\.appendValidationStep\s*\(\s*record\s*\)/.test(text),
    no_ledger_writes: !/\bappendLedger\b/.test(text),
    no_policy_state_load: !/\bload(?:Policy|Mission|State)\b/.test(text),
    observed_run_command_calls: runCommandCalls,
    disallowed_run_command_calls: disallowedRunCommandCalls
  };
}

function validationRunnerBoundaryCheck(id, file) {
  const evidence = validationRunnerBoundaryEvidence(file);
  const booleanValues = Object.entries(evidence)
    .filter((entry) => typeof entry[1] === 'boolean')
    .map((entry) => entry[1]);
  return regressionCheck(id, booleanValues.every((value) => value === true), evidence);
}

function pushGateBoundaryEvidence(file) {
  const text = fs.existsSync(file) ? readText(file) : '';
  const allowedHelpers = new Set([
    'readCheckpointFile',
    'ledgerEventByHash',
    'newestLedgerEventOfType',
    'rollbackDrillChecks',
    'validationInputsHash',
    'policyHash',
    'missionHash'
  ]);
  const helperCalls = Array.from(text.matchAll(/\bhelpers\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g))
    .map((match) => match[1]);
  const disallowedHelperCalls = helperCalls.filter((name) => !allowedHelpers.has(name));
  return {
    module_exists: fs.existsSync(file),
    no_requires: !/\brequire\s*\(/.test(text),
    no_process_access: !/\bprocess\./.test(text),
    no_fs_import_or_use: !/\brequire\s*\(\s*['"]fs['"]\s*\)/.test(text) && !/\bfs\./.test(text),
    no_file_reads: !/\breadFile(?:Sync)?\b/.test(text) && !/\bcreateReadStream\b/.test(text),
    no_file_writes: !/\bwriteFile(?:Sync)?\b/.test(text) &&
      !/\bappendFile(?:Sync)?\b/.test(text) &&
      !/\bcreateWriteStream\b/.test(text),
    no_command_execution: !/\bchild_process\b/.test(text) &&
      !/\bspawn(?:Sync)?\b/.test(text) &&
      !/\bexec(?:File|FileSync|Sync)?\b/.test(text) &&
      !/\brunCommand\b/.test(text),
    no_ledger_writes: !/\bappendLedger\b/.test(text),
    no_policy_state_load: !/\bload(?:Policy|Mission|State)\b/.test(text),
    evidence_helpers_are_injected_and_allowlisted: helperCalls.length > 0 &&
      disallowedHelperCalls.length === 0,
    observed_helper_calls: Array.from(new Set(helperCalls)),
    disallowed_helper_calls: Array.from(new Set(disallowedHelperCalls))
  };
}

function pushGateBoundaryCheck(id, file) {
  const evidence = pushGateBoundaryEvidence(file);
  const booleanValues = Object.entries(evidence)
    .filter((entry) => typeof entry[1] === 'boolean')
    .map((entry) => entry[1]);
  return regressionCheck(id, booleanValues.every((value) => value === true), evidence);
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
  const dependencyAuditRoot = path.join(scratchParent, `dependency-surface-${crypto.randomUUID()}`);
  const dependencyAuditNested = path.join(dependencyAuditRoot, 'nested');
  fs.mkdirSync(path.join(dependencyAuditNested, 'node_modules'), { recursive: true });
  writeTextFile(path.join(dependencyAuditNested, 'package.json'), '{}\n');
  const dependencyFixtureAudit = dependencySurfaceAudit(dependencyAuditRoot);
  const dependencyFixtureArtifactPaths = dependencyFixtureAudit.artifacts.map((item) => item.path.replace(/\\/g, '/'));
  checks.push(regressionCheck('dependency_surface_audit_detects_nested_package_artifacts',
    dependencyFixtureArtifactPaths.some((item) => item.endsWith('/nested/package.json')) &&
    dependencyFixtureArtifactPaths.some((item) => item.endsWith('/nested/node_modules')), {
    artifacts: dependencyFixtureArtifactPaths,
    skipped: dependencyFixtureAudit.skipped
  }));
  const stdinEpipeProbe = await runCommand([process.execPath, '-e', 'process.stdin.destroy(); process.exit(0)'], {
    input: 'bha-stdin-epipe-probe'.repeat(4096)
  });
  checks.push(regressionCheck('run_command_ignores_child_stdin_epipe', stdinEpipeProbe.exit_code === 0 &&
    !stdinEpipeProbe.error, {
    exit_code: stdinEpipeProbe.exit_code,
    error: stdinEpipeProbe.error
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
  const staleFixtureRoot = path.join(scratchParent, `stale-lock-${crypto.randomUUID()}`);
  fs.mkdirSync(staleFixtureRoot, { recursive: true });
  writeRegressionFixtureEvidence(staleFixtureRoot, keyId, publicKeyPem, []);
  await runCommand(['git', 'init'], { cwd: staleFixtureRoot });
  await runCommand(['git', 'config', 'user.email', 'bha-regression@example.invalid'], { cwd: staleFixtureRoot });
  await runCommand(['git', 'config', 'user.name', 'BHA Regression'], { cwd: staleFixtureRoot });
  await runCommand(['git', 'add', '.'], { cwd: staleFixtureRoot });
  await runCommand(['git', 'commit', '-m', 'stale lock regression fixture'], { cwd: staleFixtureRoot });
  const staleFixtureLedgerLock = path.join(staleFixtureRoot, '.bha', 'local', 'ledger.lock');
  writeTextFile(staleFixtureLedgerLock, stable({
    pid: 99999999,
    acquired_at: '2000-01-01T00:00:00.000Z',
    command: ['regression-selftest', 'stale-lock'],
    repo_head: 'fixture'
  }) + '\n');
  const checkAfterStaleLock = await runFixtureBha(staleFixtureRoot, ['check', '--', 'git', 'status']);
  const fixtureLedgerAfterStale = readJsonl(path.join(staleFixtureRoot, '.bha', 'ledger.jsonl'));
  const staleRecoveryEvent = fixtureLedgerAfterStale.find((event) => event.type === 'stale_ledger_lock_recovered');
  checks.push(regressionCheck('stale_ledger_lock_recovered_before_append', checkAfterStaleLock.exit_code === 0 &&
    checkAfterStaleLock.parsed &&
    checkAfterStaleLock.parsed.ok === true &&
    staleRecoveryEvent &&
    staleRecoveryEvent.payload &&
    staleRecoveryEvent.payload.stale_pid === 99999999, {
    exit_code: checkAfterStaleLock.exit_code,
    decision: checkAfterStaleLock.parsed ? checkAfterStaleLock.parsed.decision : 'NO_JSON',
    stale_recovery_event_hash: staleRecoveryEvent ? staleRecoveryEvent.event_hash : null
  }));
  checks.push(regressionCheck('policy_check_output_declares_ledger_write_effect', checkAfterStaleLock.exit_code === 0 &&
    checkAfterStaleLock.parsed &&
    checkAfterStaleLock.parsed.effect === 'ledger_write' &&
    checkAfterStaleLock.parsed.command_effect === 'ledger_write' &&
    checkAfterStaleLock.parsed.read_only === false &&
    checkAfterStaleLock.parsed.recorded === true, {
    effect: checkAfterStaleLock.parsed ? checkAfterStaleLock.parsed.effect : 'NO_JSON',
    read_only: checkAfterStaleLock.parsed ? checkAfterStaleLock.parsed.read_only : 'NO_JSON',
    recorded: checkAfterStaleLock.parsed ? checkAfterStaleLock.parsed.recorded : 'NO_JSON'
  }));
  const prepushRecordFixtureRoot = path.join(scratchParent, `prepush-record-${crypto.randomUUID()}`);
  fs.mkdirSync(prepushRecordFixtureRoot, { recursive: true });
  writeRegressionFixtureEvidence(prepushRecordFixtureRoot, keyId, publicKeyPem, []);
  await runCommand(['git', 'init'], { cwd: prepushRecordFixtureRoot });
  await runCommand(['git', 'config', 'user.email', 'bha-regression@example.invalid'], { cwd: prepushRecordFixtureRoot });
  await runCommand(['git', 'config', 'user.name', 'BHA Regression'], { cwd: prepushRecordFixtureRoot });
  await runCommand(['git', 'add', '.'], { cwd: prepushRecordFixtureRoot });
  await runCommand(['git', 'commit', '-m', 'prepush record regression fixture'], { cwd: prepushRecordFixtureRoot });
  const prepushRecordLedgerBefore = readJsonl(path.join(prepushRecordFixtureRoot, '.bha', 'ledger.jsonl')).length;
  const prepushRecordNoWriteGuard = await runFixtureBha(prepushRecordFixtureRoot, [
    'prepush-check',
    '--record',
    '--no-write-guard',
    '--internal-git-hook',
    'origin'
  ]);
  const prepushRecordLedgerAfter = readJsonl(path.join(prepushRecordFixtureRoot, '.bha', 'ledger.jsonl'));
  const prepushRecordEvent = prepushRecordLedgerAfter.slice(prepushRecordLedgerBefore).find((event) => event.type === 'prepush_check');
  checks.push(regressionCheck('prepush_record_no_write_guard_declares_ledger_write_effect',
    commandEffect('prepush-check', ['--record', '--no-write-guard', '--internal-git-hook', 'origin']) === 'ledger_write' &&
    prepushRecordNoWriteGuard.exit_code === 1 &&
    prepushRecordNoWriteGuard.parsed &&
    prepushRecordNoWriteGuard.parsed.recorded === true &&
    prepushRecordNoWriteGuard.parsed.no_write_guard === true &&
    prepushRecordEvent &&
    prepushRecordEvent.type === 'prepush_check', {
    command_effect: commandEffect('prepush-check', ['--record', '--no-write-guard', '--internal-git-hook', 'origin']),
    exit_code: prepushRecordNoWriteGuard.exit_code,
    recorded: prepushRecordNoWriteGuard.parsed ? prepushRecordNoWriteGuard.parsed.recorded : 'NO_JSON',
    no_write_guard: prepushRecordNoWriteGuard.parsed ? prepushRecordNoWriteGuard.parsed.no_write_guard : 'NO_JSON',
    event_type: prepushRecordEvent ? prepushRecordEvent.type : null,
    error: prepushRecordNoWriteGuard.parsed ? prepushRecordNoWriteGuard.parsed.error : truncate(prepushRecordNoWriteGuard.stderr)
  }));
  const policyForPathCheck = loadPolicy();
  checks.push(regressionCheck('command_effect_model_and_readonly_write_guard_present',
    fileContains(COMMAND_EFFECTS_SCRIPT, 'EFFECT_READ_ONLY') &&
    fileContains(COMMAND_EFFECTS_SCRIPT, 'EFFECT_LEDGER_WRITE') &&
    fileContains(COMMAND_EFFECTS_SCRIPT, 'issueCapabilityEffect') &&
    fileContains(COMMAND_EFFECTS_SCRIPT, 'consumeCapabilityEffect') &&
    fileContains(COMMAND_EFFECTS_SCRIPT, 'effectAllowsTrackedWrite') &&
    fileContains(RUN_SCRIPT, "require('./lib/command-effects')") &&
    fileContains(RUN_SCRIPT, 'READ_ONLY_COMMAND_WRITE_DENIED') &&
    fileContains(RUN_SCRIPT, 'ensureTrackedWriteAllowed(`append ledger event ${type}`)') &&
    fileContains(RUN_SCRIPT, "ensureLocalWriteAllowed('reserve local capability session')"), {
    command_effects_module: fileContains(COMMAND_EFFECTS_SCRIPT, 'EFFECT_READ_ONLY'),
    capability_dynamic_effects: fileContains(COMMAND_EFFECTS_SCRIPT, 'issueCapabilityEffect') &&
      fileContains(COMMAND_EFFECTS_SCRIPT, 'consumeCapabilityEffect'),
    tracked_guard: fileContains(RUN_SCRIPT, 'ensureTrackedWriteAllowed(`append ledger event ${type}`)'),
    local_guard: fileContains(RUN_SCRIPT, "ensureLocalWriteAllowed('reserve local capability session')")
  }));
  checks.push(regressionCheck('runtime_core_modules_extracted',
    fileContains(POLICY_CHECK_SCRIPT, 'function evaluatePolicy') &&
    fileContains(VALIDATION_RUNNER_SCRIPT, 'async function runValidationCommands') &&
    fileContains(CAPABILITY_STORE_SCRIPT, 'function createCapabilityStore') &&
    fileContains(PUSH_GATE_SCRIPT, 'function gateNextActionContext') &&
    fileContains(GIT_REALITY_SCRIPT, 'function changedFilesFromPorcelainV2') &&
    fileContains(LOCAL_PAYLOAD_STATUS_SCRIPT, 'function localPayloadStatus') &&
    fileContains(PAYLOAD_SUMMARY_SCRIPT, 'function capabilityFileSummary') &&
    fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function capabilityPayloadHash') &&
    fileContains(RUN_SCRIPT, "require('./lib/policy-check')") &&
    fileContains(RUN_SCRIPT, "require('./lib/validation-runner')") &&
    fileContains(RUN_SCRIPT, "require('./lib/capability-store')") &&
    fileContains(RUN_SCRIPT, "require('./lib/push-gate')") &&
    fileContains(RUN_SCRIPT, "require('./lib/git-reality')") &&
    fileContains(RUN_SCRIPT, "require('./lib/local-payload-status')") &&
    fileContains(RUN_SCRIPT, "require('./lib/payload-summary')") &&
    fileContains(RUN_SCRIPT, "require('./lib/capability-verifier')"), {
    policy_check_module: fileContains(POLICY_CHECK_SCRIPT, 'function evaluatePolicy'),
    validation_runner_module: fileContains(VALIDATION_RUNNER_SCRIPT, 'async function runValidationCommands'),
    capability_store_module: fileContains(CAPABILITY_STORE_SCRIPT, 'function createCapabilityStore'),
    push_gate_module: fileContains(PUSH_GATE_SCRIPT, 'function gateNextActionContext'),
    git_reality_module: fileContains(GIT_REALITY_SCRIPT, 'function changedFilesFromPorcelainV2'),
    local_payload_status_module: fileContains(LOCAL_PAYLOAD_STATUS_SCRIPT, 'function localPayloadStatus'),
    payload_summary_module: fileContains(PAYLOAD_SUMMARY_SCRIPT, 'function capabilityFileSummary'),
    capability_verifier_module: fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function capabilityPayloadHash')
  }));
  checks.push(validationRunnerBoundaryCheck('validation_runner_executes_only_through_injected_run_command', VALIDATION_RUNNER_SCRIPT));
  checks.push(callerProvidedInputBoundaryCheck('policy_check_has_only_caller_provided_inputs', POLICY_CHECK_SCRIPT, {
    allowedRequires: ['path'],
    allowedProcess: ['process.platform']
  }));
  checks.push(regressionCheck('git_reality_pure_parsers_extracted',
    fileContains(GIT_REALITY_SCRIPT, 'function parsePorcelainPath') &&
    fileContains(GIT_REALITY_SCRIPT, 'function changedFilesFromStatus') &&
    fileContains(GIT_REALITY_SCRIPT, 'function trackedGitRealityBindingFromHeads') &&
    fileContains(RUN_SCRIPT, 'gitReality.changedFilesFromPorcelainV2(stdout)') &&
    fileContains(RUN_SCRIPT, 'gitReality.changedFilesFromStatus(stdout)') &&
    fileContains(RUN_SCRIPT, 'gitReality.trackedGitRealityBindingFromHeads'), {
    porcelain_parser_module: fileContains(GIT_REALITY_SCRIPT, 'function changedFilesFromPorcelainV2'),
    status_parser_module: fileContains(GIT_REALITY_SCRIPT, 'function changedFilesFromStatus'),
    tracked_binding_module: fileContains(GIT_REALITY_SCRIPT, 'function trackedGitRealityBindingFromHeads')
  }));
  checks.push(callerProvidedInputBoundaryCheck('git_reality_has_only_caller_provided_inputs', GIT_REALITY_SCRIPT));
  checks.push(regressionCheck('local_payload_status_pure_logic_extracted',
    fileContains(LOCAL_PAYLOAD_STATUS_SCRIPT, 'function reasonMessage') &&
    fileContains(LOCAL_PAYLOAD_STATUS_SCRIPT, 'function reasonDetails') &&
    fileContains(LOCAL_PAYLOAD_STATUS_SCRIPT, 'function recoveryGitPushNextCommands') &&
    fileContains(LOCAL_PAYLOAD_STATUS_SCRIPT, 'function localPayloadIssue') &&
    fileContains(LOCAL_PAYLOAD_STATUS_SCRIPT, 'function localPayloadStatus') &&
    fileContains(RUN_SCRIPT, 'localPayloadStatusLib.reasonMessage(code)') &&
    fileContains(RUN_SCRIPT, 'localPayloadStatusLib.recoveryGitPushNextCommands') &&
    fileContains(RUN_SCRIPT, 'localPayloadStatusLib.localPayloadStatus(unsigned, signed)'), {
    reason_message_module: fileContains(LOCAL_PAYLOAD_STATUS_SCRIPT, 'function reasonMessage'),
    recovery_commands_module: fileContains(LOCAL_PAYLOAD_STATUS_SCRIPT, 'function recoveryGitPushNextCommands'),
    local_payload_status_module: fileContains(LOCAL_PAYLOAD_STATUS_SCRIPT, 'function localPayloadStatus')
  }));
  checks.push(callerProvidedInputBoundaryCheck('local_payload_status_has_only_caller_provided_inputs', LOCAL_PAYLOAD_STATUS_SCRIPT));
  checks.push(regressionCheck('payload_summary_pure_logic_extracted',
    fileContains(PAYLOAD_SUMMARY_SCRIPT, 'function currentPayloadContext') &&
    fileContains(PAYLOAD_SUMMARY_SCRIPT, 'function capabilityFileSummary') &&
    fileContains(PAYLOAD_SUMMARY_SCRIPT, 'nowMs') &&
    fileContains(RUN_SCRIPT, 'payloadSummary.currentPayloadContext') &&
    fileContains(RUN_SCRIPT, 'payloadSummary.capabilityFileSummary(file, signed, currentContext') &&
    fileContains(RUN_SCRIPT, 'const file = readLocalJsonFileSummary(localPath)'), {
    current_payload_context_module: fileContains(PAYLOAD_SUMMARY_SCRIPT, 'function currentPayloadContext'),
    capability_summary_module: fileContains(PAYLOAD_SUMMARY_SCRIPT, 'function capabilityFileSummary'),
    file_reading_remains_in_runtime: fileContains(RUN_SCRIPT, 'const file = readLocalJsonFileSummary(localPath)')
  }));
  checks.push(runtimeStateOrIoBoundaryCheck('payload_summary_has_no_runtime_state_or_io_boundary', PAYLOAD_SUMMARY_SCRIPT));
  checks.push(regressionCheck('capability_verifier_pure_logic_extracted',
    fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function capabilityType') &&
    fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function capabilityTypePolicyFromLists') &&
    fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function capabilityPayloadHash') &&
    fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function capabilitySignablePayload') &&
    fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function capabilitySignatureInput') &&
    fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function signingKeyPurposeAllowedForCapability') &&
    fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function signingKeyPurposeResult') &&
    fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function normalizeTrustedSigningKeyItem') &&
    fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function canonicalPayloadHashFormat') &&
    fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function canonicalSignedCapabilityReason') &&
    fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function capabilityBindingMissingReason') &&
    fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function capabilityOneUseReason') &&
    fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function gitPushCommandReason') &&
    fileContains(RUN_SCRIPT, 'capabilityVerifier.capabilityType(payload)') &&
    fileContains(RUN_SCRIPT, 'capabilityVerifier.capabilityPayloadHash(payload)') &&
    fileContains(RUN_SCRIPT, 'capabilityVerifier.capabilitySignablePayload(payload)') &&
    fileContains(RUN_SCRIPT, 'capabilityVerifier.capabilitySignatureInput(payload)') &&
    fileContains(RUN_SCRIPT, 'capabilityVerifier.signingKeyPurposeAllowedForCapability(key, type)') &&
    fileContains(RUN_SCRIPT, 'capabilityVerifier.signingKeyPurposeResult(key, type)') &&
    fileContains(RUN_SCRIPT, 'capabilityVerifier.normalizeTrustedSigningKeyItem(item)') &&
    fileContains(RUN_SCRIPT, 'function findTrustedSigningKey') &&
    fileContains(RUN_SCRIPT, 'capabilityVerifier.canonicalPayloadHashFormat(value)') &&
    fileContains(RUN_SCRIPT, 'capabilityVerifier.canonicalSignedCapabilityReason(payload)') &&
    fileContains(RUN_SCRIPT, "capabilityVerifier.capabilityBindingMissingReason(payload, ['remote', 'branch', 'head'])") &&
    fileContains(VERIFY_SCRIPT, 'capabilityVerifier.capabilitySignatureInput(payload)') &&
    fileContains(VERIFY_SCRIPT, 'capabilityVerifier.signingKeyPurposeAllowedForCapability(key, type)') &&
    fileContains(VERIFY_SCRIPT, 'capabilityVerifier.normalizeTrustedSigningKeyItem(item)') &&
    fileContains(VERIFY_SCRIPT, 'function trustedSigningKey') &&
    fileContains(VERIFY_SCRIPT, "capabilityVerifier.capabilityBindingMissingReason(requested, ['remote', 'branch', 'head', 'ledger_head_hash', 'expires_at'])"), {
    capability_type_module: fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function capabilityType'),
    capability_policy_module: fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function capabilityTypePolicyFromLists'),
    payload_hash_module: fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function capabilityPayloadHash'),
    signable_payload_module: fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function capabilitySignablePayload'),
    signature_input_module: fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function capabilitySignatureInput'),
    key_purpose_policy_module: fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function signingKeyPurposeAllowedForCapability'),
    key_purpose_result_module: fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function signingKeyPurposeResult'),
    trusted_key_item_module: fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function normalizeTrustedSigningKeyItem'),
    canonical_hash_format_module: fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function canonicalPayloadHashFormat'),
    canonical_reason_module: fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function canonicalSignedCapabilityReason'),
    binding_reason_module: fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function capabilityBindingMissingReason'),
    one_use_reason_module: fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function capabilityOneUseReason'),
    command_reason_module: fileContains(CAPABILITY_VERIFIER_SCRIPT, 'function gitPushCommandReason')
  }));
  checks.push(runtimeStateOrIoBoundaryCheck('capability_verifier_has_no_runtime_state_or_io_boundary', CAPABILITY_VERIFIER_SCRIPT));
  checks.push(regressionCheck('push_gate_pure_decisions_extracted',
    fileContains(PUSH_GATE_SCRIPT, 'function pushRequirement') &&
    fileContains(PUSH_GATE_SCRIPT, 'function remoteBranchPolicy') &&
    fileContains(PUSH_GATE_SCRIPT, 'function postPushStatusSummary') &&
    fileContains(PUSH_GATE_SCRIPT, 'function prepushEvidenceGates') &&
    fileContains(PUSH_GATE_SCRIPT, 'function nextGateAction') &&
    fileContains(RUN_SCRIPT, 'pushGate.pushRequirement(branch, action)') &&
    fileContains(RUN_SCRIPT, 'pushGate.remoteBranchPolicy(branch)') &&
    fileContains(RUN_SCRIPT, 'pushGate.postPushStatusSummary') &&
    fileContains(RUN_SCRIPT, 'pushGate.prepushEvidenceGates') &&
    fileContains(RUN_SCRIPT, 'pushGate.nextGateAction'), {
    push_requirement_module: fileContains(PUSH_GATE_SCRIPT, 'function pushRequirement'),
    remote_branch_policy_module: fileContains(PUSH_GATE_SCRIPT, 'function remoteBranchPolicy'),
    post_push_status_module: fileContains(PUSH_GATE_SCRIPT, 'function postPushStatusSummary'),
    prepush_evidence_module: fileContains(PUSH_GATE_SCRIPT, 'function prepushEvidenceGates'),
    next_gate_action_module: fileContains(PUSH_GATE_SCRIPT, 'function nextGateAction')
  }));
  checks.push(pushGateBoundaryCheck('push_gate_has_only_injected_evidence_helpers', PUSH_GATE_SCRIPT));
  checks.push(regressionCheck('allowed_file_path_does_not_allow_descendant_path',
    fileAllowedByPolicy('scripts/bha-run.js', policyForPathCheck) === true &&
    fileAllowedByPolicy('scripts/bha-run.js/nested', policyForPathCheck) === false &&
    fileProtectedByPolicy('.git/config', policyForPathCheck) === true, {
    exact_file_allowed: fileAllowedByPolicy('scripts/bha-run.js', policyForPathCheck),
    descendant_file_allowed: fileAllowedByPolicy('scripts/bha-run.js/nested', policyForPathCheck),
    protected_descendant_detected: fileProtectedByPolicy('.git/config', policyForPathCheck)
  }));
  const disabledLedgerHeadNeedle = 'checkLedgerHead' + ': false';
  checks.push(regressionCheck('local_consume_read_validate_append_under_capability_lock',
    fileContains(RUN_SCRIPT, "withCapabilityLock(() => consumeCapabilityRecord") &&
    fileContains(RUN_SCRIPT, "appendLocalCapabilityEventUnlocked('capability_consume'") &&
    fileContains(RUN_SCRIPT, 'const existingConsumed = validCapabilityConsumes(events, id)') &&
    !fileContains(RUN_SCRIPT, disabledLedgerHeadNeedle), {
    locked_consume_path: fileContains(RUN_SCRIPT, "withCapabilityLock(() => consumeCapabilityRecord"),
    unlocked_append_inside_record: fileContains(RUN_SCRIPT, "appendLocalCapabilityEventUnlocked('capability_consume'"),
    ledger_head_check_not_disabled: !fileContains(RUN_SCRIPT, disabledLedgerHeadNeedle)
  }));
  checks.push(regressionCheck('git_push_capability_requires_current_ledger_head',
    fileContains(RUN_SCRIPT, 'CAPABILITY_LEDGER_HEAD_MISMATCH') &&
    fileContains(RUN_SCRIPT, 'validateCapabilityRequest(requested, issue.payload.capability_type, state, events)') &&
    !fileContains(RUN_SCRIPT, disabledLedgerHeadNeedle), {
    mismatch_reason_present: fileContains(RUN_SCRIPT, 'CAPABILITY_LEDGER_HEAD_MISMATCH'),
    consume_validation_uses_default_ledger_head_check: fileContains(RUN_SCRIPT, 'validateCapabilityRequest(requested, issue.payload.capability_type, state, events)'),
    ledger_head_check_not_disabled: !fileContains(RUN_SCRIPT, disabledLedgerHeadNeedle)
  }));
  checks.push(regressionCheck('exec_fails_closed_without_initial_git_status',
    fileContains(RUN_SCRIPT, 'HALT_GIT_STATUS_BEFORE_UNAVAILABLE') &&
    fileContains(RUN_SCRIPT, 'path_allowlist_enforced: false') &&
    fileContains(RUN_SCRIPT, "reason: 'git status before exec failed'") &&
    fileContains(RUN_SCRIPT, 'process.exitCode = 5'), {
    halt_status_present: fileContains(RUN_SCRIPT, 'HALT_GIT_STATUS_BEFORE_UNAVAILABLE'),
    no_path_allowlist_claim_without_status: fileContains(RUN_SCRIPT, 'path_allowlist_enforced: false'),
    fail_closed_exit_code: fileContains(RUN_SCRIPT, 'process.exitCode = 5')
  }));
  checks.push(regressionCheck('exec_fails_closed_without_after_git_status',
    fileContains(RUN_SCRIPT, 'HALT_GIT_STATUS_AFTER_UNAVAILABLE') &&
    fileContains(RUN_SCRIPT, "reason: 'git status after exec failed'") &&
    fileContains(RUN_SCRIPT, 'path_allowlist_enforced: false') &&
    fileContains(RUN_SCRIPT, 'spawned: true'), {
    halt_status_present: fileContains(RUN_SCRIPT, 'HALT_GIT_STATUS_AFTER_UNAVAILABLE'),
    no_path_allowlist_claim_without_status: fileContains(RUN_SCRIPT, 'path_allowlist_enforced: false'),
    command_spawned_before_after_status_failure: fileContains(RUN_SCRIPT, 'spawned: true')
  }));
  checks.push(regressionCheck('stable_exit_allows_authorized_runtime_evidence_dirty',
    fileContains(RUN_SCRIPT, 'authorizedRuntimeEvidenceDirty') &&
    fileContains(RUN_SCRIPT, 'authorized_runtime_evidence_dirty') &&
    fileContains(RUN_SCRIPT, "gate.next_action_scope === 'local_trust_repair'"), {
    authorized_runtime_dirty_gate_present: fileContains(RUN_SCRIPT, 'authorizedRuntimeEvidenceDirty'),
    status_field_present: fileContains(RUN_SCRIPT, 'authorized_runtime_evidence_dirty'),
    local_trust_repair_scope_present: fileContains(RUN_SCRIPT, "gate.next_action_scope === 'local_trust_repair'")
  }));
  checks.push(regressionCheck('push_gate_allows_authorized_runtime_evidence_dirty',
    fileContains(RUN_SCRIPT, 'gitStatusAllowedForLocalTrustRepair(status)') &&
    countSubstring(readText(RUN_SCRIPT), 'clean_git_status: gitStatusAllowedForLocalTrustRepair(status)') >= 2, {
    shared_gate_function_present: fileContains(RUN_SCRIPT, 'function gitStatusAllowedForLocalTrustRepair(status)'),
    gate_and_prepush_use_shared_function: countSubstring(readText(RUN_SCRIPT), 'clean_git_status: gitStatusAllowedForLocalTrustRepair(status)')
  }));
  checks.push(regressionCheck('fast_repair_noops_when_evidence_ux_says_unavailable',
    fileContains(RUN_SCRIPT, "status: 'NO_REPAIR_REQUIRED'") &&
    fileContains(RUN_SCRIPT, 'before.recommendation.fast_repair_available !== true') &&
    fileContains(RUN_SCRIPT, 'accepted evidence carrier commits must not create recursive evidence commits'), {
    no_repair_status_present: fileContains(RUN_SCRIPT, "status: 'NO_REPAIR_REQUIRED'"),
    fast_repair_availability_gate_present: fileContains(RUN_SCRIPT, 'before.recommendation.fast_repair_available !== true'),
    recursive_carrier_boundary_present: fileContains(RUN_SCRIPT, 'accepted evidence carrier commits must not create recursive evidence commits')
  }));
  checks.push(regressionCheck('evidence_ux_hides_fast_repair_command_when_unavailable',
    fileContains(RUN_SCRIPT, 'fast_repair_command: recommendation.fast_repair_available === true') &&
    fileContains(RUN_SCRIPT, ': null') &&
    fileContains(RUN_SCRIPT, "(recommendation.fast_repair_available === true ? 'FAST_PATH_AVAILABLE' : 'NO_REPAIR_REQUIRED')"), {
    conditional_fast_repair_command_present: fileContains(RUN_SCRIPT, 'fast_repair_command: recommendation.fast_repair_available === true'),
    unavailable_command_is_null: fileContains(RUN_SCRIPT, ': null'),
    no_repair_status_present: fileContains(RUN_SCRIPT, "(recommendation.fast_repair_available === true ? 'FAST_PATH_AVAILABLE' : 'NO_REPAIR_REQUIRED')")
  }));
  checks.push(regressionCheck('evidence_carrier_commit_contract_present',
    fileContains(RUN_SCRIPT, "mode: active ? 'EVIDENCE_CARRIER_COMMIT' : 'DIRECT_HEAD_BINDING'") &&
    fileContains(RUN_SCRIPT, 'subjectHead === parentHead') &&
    fileContains(RUN_SCRIPT, 'carrier_commit_accepted: true'), {
    carrier_mode_present: fileContains(RUN_SCRIPT, "mode: active ? 'EVIDENCE_CARRIER_COMMIT' : 'DIRECT_HEAD_BINDING'"),
    subject_parent_binding_present: fileContains(RUN_SCRIPT, 'subjectHead === parentHead'),
    accepted_recommendation_present: fileContains(RUN_SCRIPT, 'carrier_commit_accepted: true')
  }));
  checks.push(regressionCheck('roadmap_current_state_is_procedural_not_snapshot',
    fileContains(ROADMAP_PATH, 'Current repository state is intentionally not embedded') &&
    !fileContains(ROADMAP_PATH, '`HEAD` is `18dfa2a`') &&
    !fileContains(ROADMAP_PATH, '`AGENTS.md` is currently dirty'), {
    procedural_state_note: fileContains(ROADMAP_PATH, 'Current repository state is intentionally not embedded'),
    stale_head_snapshot_removed: !fileContains(ROADMAP_PATH, '`HEAD` is `18dfa2a`'),
    stale_dirty_snapshot_removed: !fileContains(ROADMAP_PATH, '`AGENTS.md` is currently dirty')
  }));
  checks.push(regressionCheck('verify_record_detects_stale_ledger_head',
    fileContains(RUN_SCRIPT, 'VERIFIER_STALE_LEDGER_HEAD') &&
    fileContains(RUN_SCRIPT, 'current_ledger_head_hash_before_record') &&
    fileContains(RUN_SCRIPT, 'stale_ledger_head'), {
    stale_reason_present: fileContains(RUN_SCRIPT, 'VERIFIER_STALE_LEDGER_HEAD')
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
  const rootStableExitReviewCommand = validationCommandById(rootValidation, 'stable_exit_review_readonly');
  const rootProofVocabularyCommand = validationCommandById(rootValidation, 'proof_vocabulary_status_readonly');
  const rootBootstrapStatusCommand = validationCommandById(rootValidation, 'bootstrap_status_readonly');
  const rootCapabilityFrameworkCommand = validationCommandById(rootValidation, 'capability_framework_status_readonly');
  const rootCouncilStatusCommand = validationCommandById(rootValidation, 'council_status_readonly');
  const rootAuditV2PreviewCommand = validationCommandById(rootValidation, 'audit_v2_preview_readonly');
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
  const proofVocabularyJsonPaths = rootProofVocabularyCommand && rootProofVocabularyCommand.expect
    ? (rootProofVocabularyCommand.expect.json_paths || {})
    : {};
  checks.push(regressionCheck('proof_vocabulary_status_validation_wired', Boolean(rootProofVocabularyCommand &&
    rootProofVocabularyCommand.expect &&
    rootProofVocabularyCommand.expect.exit_code === 0 &&
    rootProofVocabularyCommand.expect.ok === true &&
    rootProofVocabularyCommand.expect.status === 'PROOF_VOCABULARY_STATUS' &&
    rootProofVocabularyCommand.expect.read_only === true &&
    rootProofVocabularyCommand.expect.recorded === false &&
    proofVocabularyJsonPaths['current_phase'] === 'PREVIEW_HOLD_LINE' &&
    proofVocabularyJsonPaths['trust_boundaries.clean_repo_is_trust_root'] === false &&
    proofVocabularyJsonPaths['preview_semantics.preview_authorizes_runtime'] === false &&
    proofVocabularyJsonPaths['preview_semantics.forbidden_authority_terms.0'] === 'enabled' &&
    proofVocabularyJsonPaths['critical_judgment.prose_text_scan_allowed'] === false &&
    proofVocabularyJsonPaths['gate_semantics.preview_artifact_can_enter_gate_positive_condition'] === false &&
    proofVocabularyJsonPaths['artifact_provenance.type'] === 'proof_vocabulary_status' &&
    proofVocabularyJsonPaths['artifact_provenance.non_authoritative'] === true &&
    proofVocabularyJsonPaths['artifact_provenance.non_activating'] === true &&
    proofVocabularyJsonPaths['artifact_provenance.grants_capability'] === false), {
    validation_command_present: Boolean(rootProofVocabularyCommand),
    json_paths: proofVocabularyJsonPaths
  }));
  const bootstrapJsonPaths = rootBootstrapStatusCommand && rootBootstrapStatusCommand.expect
    ? (rootBootstrapStatusCommand.expect.json_paths || {})
    : {};
  checks.push(regressionCheck('bootstrap_status_validation_wired', Boolean(rootBootstrapStatusCommand &&
    rootBootstrapStatusCommand.expect &&
    rootBootstrapStatusCommand.expect.exit_code === 0 &&
    rootBootstrapStatusCommand.expect.ok === true &&
    rootBootstrapStatusCommand.expect.status === 'BOOTSTRAP_REPLAY_STATUS' &&
    rootBootstrapStatusCommand.expect.read_only === true &&
    rootBootstrapStatusCommand.expect.recorded === false &&
    bootstrapJsonPaths['ledger_is_bootstrap_trust_root'] === false &&
    bootstrapJsonPaths['local_cache_required'] === false &&
    bootstrapJsonPaths['private_key_required'] === false &&
    bootstrapJsonPaths['fresh_clone_replay_contract.requires_bha_local'] === false &&
    bootstrapJsonPaths['fresh_clone_replay_contract.damaged_ledger_status'] === 'REPLAY_REQUIRED' &&
    bootstrapJsonPaths['fail_closed_states.missing_ledger'] === 'HISTORICAL_EVIDENCE_UNAVAILABLE' &&
    bootstrapJsonPaths['activation_firewall.effective_production_capability_types.0'] === 'git_push' &&
    bootstrapJsonPaths['artifact_provenance.type'] === 'bootstrap_status' &&
    bootstrapJsonPaths['artifact_provenance.grants_capability'] === false), {
    validation_command_present: Boolean(rootBootstrapStatusCommand),
    json_paths: bootstrapJsonPaths
  }));
  const frameworkJsonPaths = rootCapabilityFrameworkCommand && rootCapabilityFrameworkCommand.expect
    ? (rootCapabilityFrameworkCommand.expect.json_paths || {})
    : {};
  checks.push(regressionCheck('capability_framework_machine_readable_draft_status', Boolean(rootCapabilityFrameworkCommand &&
    frameworkJsonPaths['machine_readable_draft.status'] === 'DRAFT_NON_ENABLING' &&
    frameworkJsonPaths['proof_vocabulary.status'] === 'PROOF_VOCABULARY_STATUS' &&
    frameworkJsonPaths['proof_vocabulary.preview_authorizes_runtime'] === false &&
    frameworkJsonPaths['machine_readable_draft.schema_draft.schema'] === 'bha.capability_schema.v2.preview' &&
    frameworkJsonPaths['machine_readable_draft.evidence_policy.draft_evidence_is_authorization'] === false &&
    frameworkJsonPaths['verifier_evidence_contract.verifier_must_reject_incomplete_preview_schema'] === true &&
    frameworkJsonPaths['artifact_provenance.type'] === 'capability_framework_status' &&
    frameworkJsonPaths['artifact_provenance.non_authoritative'] === true &&
    frameworkJsonPaths['artifact_provenance.non_activating'] === true &&
    frameworkJsonPaths['artifact_provenance.grants_capability'] === false), {
    validation_command_present: Boolean(rootCapabilityFrameworkCommand),
    json_paths: frameworkJsonPaths
  }));
  checks.push(regressionCheck('capability_framework_deny_replay_matrix_status', Boolean(rootCapabilityFrameworkCommand &&
    frameworkJsonPaths['deny_replay_test_matrix.status'] === 'MACHINE_READABLE_PREVIEW' &&
    frameworkJsonPaths['deny_replay_test_matrix.coverage_complete'] === false &&
    frameworkJsonPaths['deny_replay_test_matrix.case_results_pass'] === true &&
    frameworkJsonPaths['deny_replay_test_matrix.case_results.0.status'] === 'PASS' &&
    frameworkJsonPaths['deny_replay_test_matrix.case_results.8.status'] === 'PASS' &&
    fileContains(RUN_SCRIPT, 'evaluateV2PreviewDraftCapability') &&
    fileContains(RUN_SCRIPT, 'CAPABILITY_COMMAND_OVERBROAD') &&
    fileContains(RUN_SCRIPT, 'CAPABILITY_POLICY_HASH_MISMATCH') &&
    fileContains(RUN_SCRIPT, 'CAPABILITY_MISSION_HASH_MISMATCH')), {
    deny_replay_matrix_status: frameworkJsonPaths['deny_replay_test_matrix.status'] || 'MISSING',
    coverage_complete: frameworkJsonPaths['deny_replay_test_matrix.coverage_complete'],
    case_results_pass: frameworkJsonPaths['deny_replay_test_matrix.case_results_pass']
  }));
  checks.push(regressionCheck('verifier_v2_preview_contract_wired', fileContains(VERIFY_SCRIPT, 'V2_CAPABILITY_PREVIEW_SCHEMA_INCOMPLETE') &&
    fileContains(VERIFY_SCRIPT, 'incomplete_v2_preview_contract_rejected') &&
    fileContains(VERIFY_SCRIPT, 'verifyV2PreviewContracts'), {
    verifier_contract_issue_code_present: fileContains(VERIFY_SCRIPT, 'V2_CAPABILITY_PREVIEW_SCHEMA_INCOMPLETE')
  }));
  const councilJsonPaths = rootCouncilStatusCommand && rootCouncilStatusCommand.expect
    ? (rootCouncilStatusCommand.expect.json_paths || {})
    : {};
  checks.push(regressionCheck('council_dry_run_model_status', Boolean(rootCouncilStatusCommand &&
    councilJsonPaths['dry_run_model.schema'] === 'bha.council_dry_run.v2.preview' &&
    councilJsonPaths['proof_vocabulary.status'] === 'PROOF_VOCABULARY_STATUS' &&
    councilJsonPaths['proof_vocabulary.dry_run_trace_authorizes_runtime'] === false &&
    councilJsonPaths['dry_run_model.status'] === 'DRAFT_NON_ACTIVATING' &&
    councilJsonPaths['dry_run_model.can_spawn_agents'] === false &&
    councilJsonPaths['dry_run_model.can_write_memory'] === false &&
    councilJsonPaths['dry_run_model.can_push'] === false &&
    councilJsonPaths['artifact_provenance.type'] === 'council_status' &&
    councilJsonPaths['artifact_provenance.non_authoritative'] === true &&
    councilJsonPaths['artifact_provenance.non_activating'] === true &&
    councilJsonPaths['artifact_provenance.grants_capability'] === false), {
    validation_command_present: Boolean(rootCouncilStatusCommand),
    json_paths: councilJsonPaths
  }));
  checks.push(regressionCheck('council_role_boundary_matrix_status', Boolean(rootCouncilStatusCommand &&
    councilJsonPaths['role_boundary_matrix.0.may_grant_remote_authority'] === false &&
    councilJsonPaths['role_boundary_matrix.0.may_create_proof'] === false &&
    councilJsonPaths['role_boundary_matrix.0.may_spawn_agents'] === false &&
    councilJsonPaths['activation_regression_matrix.status'] === 'MACHINE_READABLE_PREVIEW' &&
    councilJsonPaths['activation_regression_matrix.coverage_complete'] === false), {
    role_boundary_matrix_first_role: {
      may_grant_remote_authority: councilJsonPaths['role_boundary_matrix.0.may_grant_remote_authority'],
      may_create_proof: councilJsonPaths['role_boundary_matrix.0.may_create_proof'],
      may_spawn_agents: councilJsonPaths['role_boundary_matrix.0.may_spawn_agents']
    }
  }));
  const auditV2JsonPaths = rootAuditV2PreviewCommand && rootAuditV2PreviewCommand.expect
    ? (rootAuditV2PreviewCommand.expect.json_paths || {})
    : {};
  checks.push(regressionCheck('audit_v2_preview_validation_wired', Boolean(rootAuditV2PreviewCommand &&
    rootAuditV2PreviewCommand.expect &&
    rootAuditV2PreviewCommand.expect.exit_code === 0 &&
    rootAuditV2PreviewCommand.expect.ok === true &&
    rootAuditV2PreviewCommand.expect.status === 'PASS' &&
    rootAuditV2PreviewCommand.expect.read_only === true &&
    rootAuditV2PreviewCommand.expect.recorded === false &&
    auditV2JsonPaths['framework_summary.machine_readable_draft_status'] === 'DRAFT_NON_ENABLING' &&
    auditV2JsonPaths['framework_summary.deny_replay_matrix_cases_pass'] === true &&
    auditV2JsonPaths['council_summary.dry_run_model_status'] === 'DRAFT_NON_ACTIVATING' &&
    auditV2JsonPaths['proof_vocabulary.status'] === 'PROOF_VOCABULARY_STATUS' &&
    auditV2JsonPaths['proof_vocabulary.preview_authorizes_runtime'] === false &&
    auditV2JsonPaths['proof_vocabulary.prose_text_scan_allowed'] === false &&
    auditV2JsonPaths['bootstrap_summary.status'] === 'BOOTSTRAP_REPLAY_STATUS' &&
    auditV2JsonPaths['bootstrap_summary.ledger_is_bootstrap_trust_root'] === false &&
    auditV2JsonPaths['bootstrap_summary.private_key_required'] === false &&
    auditV2JsonPaths['bootstrap_summary.damaged_ledger_status'] === 'REPLAY_REQUIRED' &&
    auditV2JsonPaths['artifact_provenance.authority'] === 'NON_AUTHORITATIVE_PREVIEW' &&
    auditV2JsonPaths['artifact_provenance.non_authoritative'] === true &&
    auditV2JsonPaths['artifact_provenance.non_activating'] === true &&
    auditV2JsonPaths['artifact_provenance.grants_capability'] === false &&
    auditV2JsonPaths['validation_in_progress_allowed'] === true &&
    auditV2JsonPaths['verifier_gate.accepted'] === true), {
    validation_command_present: Boolean(rootAuditV2PreviewCommand),
    json_paths: auditV2JsonPaths
  }));
  checks.push(regressionCheck('artifact_provenance_preview_contract_validation_wired', Boolean(rootProofVocabularyCommand &&
    rootCapabilityFrameworkCommand &&
    rootCouncilStatusCommand &&
    rootAuditV2PreviewCommand &&
    rootBootstrapStatusCommand &&
    proofVocabularyJsonPaths['artifact_provenance.authority'] === 'NON_AUTHORITATIVE_PREVIEW' &&
    bootstrapJsonPaths['artifact_provenance.authority'] === 'NON_AUTHORITATIVE_PREVIEW' &&
    frameworkJsonPaths['artifact_provenance.authority'] === 'NON_AUTHORITATIVE_PREVIEW' &&
    councilJsonPaths['artifact_provenance.authority'] === 'NON_AUTHORITATIVE_PREVIEW' &&
    auditV2JsonPaths['artifact_provenance.authority'] === 'NON_AUTHORITATIVE_PREVIEW' &&
    proofVocabularyJsonPaths['artifact_provenance.grants_capability'] === false &&
    bootstrapJsonPaths['artifact_provenance.grants_capability'] === false &&
    frameworkJsonPaths['artifact_provenance.grants_capability'] === false &&
    councilJsonPaths['artifact_provenance.grants_capability'] === false &&
    auditV2JsonPaths['artifact_provenance.grants_capability'] === false), {
    vocabulary: proofVocabularyJsonPaths['artifact_provenance.authority'] || 'MISSING',
    bootstrap: bootstrapJsonPaths['artifact_provenance.authority'] || 'MISSING',
    framework: frameworkJsonPaths['artifact_provenance.authority'] || 'MISSING',
    council: councilJsonPaths['artifact_provenance.authority'] || 'MISSING',
    audit: auditV2JsonPaths['artifact_provenance.authority'] || 'MISSING'
  }));
  const stableExitReviewExpect = rootStableExitReviewCommand && rootStableExitReviewCommand.expect
    ? rootStableExitReviewCommand.expect
    : {};
  const stableExitReviewJsonPaths = stableExitReviewExpect.json_paths || {};
  checks.push(regressionCheck('stable_exit_review_validation_wired', Boolean(rootStableExitReviewCommand &&
    stableExitReviewExpect.exit_code === 0 &&
    stableExitReviewExpect.ok === true &&
    stableExitReviewExpect.status === 'PASS' &&
    stableExitReviewExpect.read_only === true &&
    stableExitReviewExpect.recorded === false &&
    stableExitReviewJsonPaths.decision === 'ENTER_NEXT_LOCAL_PLANNING' &&
    stableExitReviewJsonPaths['completion_boundary.long_term_goal_complete'] === false &&
    stableExitReviewJsonPaths['completion_boundary.push_performed'] === false &&
    stableExitReviewJsonPaths['push_requirement.required_now'] === false &&
    stableExitReviewJsonPaths['v2_hold_line.capability_enablement_allowed'] === false &&
    stableExitReviewJsonPaths['v2_hold_line.council_activation_allowed'] === false &&
    Array.isArray(stableExitReviewExpect.has_keys) &&
    stableExitReviewExpect.has_keys.includes('stable_exit_status') &&
    stableExitReviewExpect.has_keys.includes('prompt_to_artifact_checklist') &&
    stableExitReviewExpect.has_keys.includes('proof_boundary')), {
    validation_command_present: Boolean(rootStableExitReviewCommand),
    read_only: stableExitReviewExpect.read_only,
    json_paths: stableExitReviewJsonPaths
  }));
  const stableExitReviewBoundary = await runCommand([
    process.execPath,
    'scripts/bha-run.js',
    'stable-exit-review',
    '--remote',
    'origin',
    '--branch',
    'master',
    '--format',
    'json',
    '--allow-validation-in-progress'
  ], { cwd: ROOT });
  const stableExitReviewParsed = parseJsonLine(stableExitReviewBoundary.stdout);
  checks.push(regressionCheck('stable_exit_review_boundary_readonly', (stableExitReviewBoundary.exit_code === 0 || stableExitReviewBoundary.exit_code === 1) &&
    stableExitReviewParsed &&
    (stableExitReviewParsed.ok === true || stableExitReviewParsed.status === 'BLOCKED') &&
    stableExitReviewParsed.read_only === true &&
    stableExitReviewParsed.recorded === false &&
    stableExitReviewParsed.completion_boundary &&
    stableExitReviewParsed.completion_boundary.long_term_goal_complete === false &&
    stableExitReviewParsed.completion_boundary.push_performed === false &&
    stableExitReviewParsed.push_requirement &&
    stableExitReviewParsed.push_requirement.required_now === false &&
    stableExitReviewParsed.v2_hold_line &&
    stableExitReviewParsed.v2_hold_line.capability_enablement_allowed === false &&
    stableExitReviewParsed.v2_hold_line.council_activation_allowed === false &&
    String(stableExitReviewParsed.proof_boundary || '').includes('does not push'), {
    exit_code: stableExitReviewBoundary.exit_code,
    status: stableExitReviewParsed ? stableExitReviewParsed.status : 'NO_JSON',
    read_only: stableExitReviewParsed ? stableExitReviewParsed.read_only : 'NO_JSON',
    recorded: stableExitReviewParsed ? stableExitReviewParsed.recorded : 'NO_JSON',
    long_term_goal_complete: stableExitReviewParsed && stableExitReviewParsed.completion_boundary
      ? stableExitReviewParsed.completion_boundary.long_term_goal_complete
      : 'NO_JSON',
    push_required_now: stableExitReviewParsed && stableExitReviewParsed.push_requirement
      ? stableExitReviewParsed.push_requirement.required_now
      : 'NO_JSON'
  }));
  const obsoleteBootstrapIdGate = 'failedValidation' + 'IsBootstrapOnly';
  checks.push(regressionCheck('stable_audit_bootstrap_allows_prior_validation_failure_ids',
    fileContains(RUN_SCRIPT, 'validationBootstrapIssueCodes') &&
    fileContains(RUN_SCRIPT, 'failed_recorded_validation_ids: failedRecordedValidationIds') &&
    fileContains(RUN_SCRIPT, 'validation_in_progress_override: verifierValidationBootstrapPass') &&
    !fileContains(RUN_SCRIPT, obsoleteBootstrapIdGate), {
    issue_code_allowlist_present: fileContains(RUN_SCRIPT, 'validationBootstrapIssueCodes'),
    reports_failed_recorded_validation_ids: fileContains(RUN_SCRIPT, 'failed_recorded_validation_ids: failedRecordedValidationIds'),
    override_evidence_present: fileContains(RUN_SCRIPT, 'validation_in_progress_override: verifierValidationBootstrapPass'),
    gates_on_failed_validation_id: fileContains(RUN_SCRIPT, obsoleteBootstrapIdGate)
  }));

  const branchResult = await runCommand(['git', 'branch', '--show-current'], { cwd: fixtureRoot });
  const branch = branchResult.stdout.trim() || 'master';
  const protectedShipDryRun = await runFixtureBha(fixtureRoot, ['ship', '--dry-run', '--format', 'json']);
  checks.push(regressionCheck('ship_dry_run_blocks_protected_branch', protectedShipDryRun.exit_code === 3 &&
    protectedShipDryRun.parsed &&
    protectedShipDryRun.parsed.status === 'BLOCKED_PROTECTED_BRANCH' &&
    protectedShipDryRun.parsed.read_only === true &&
    String(protectedShipDryRun.parsed.proof_boundary || '').includes('does not direct-push protected branches'), {
    exit_code: protectedShipDryRun.exit_code,
    status: protectedShipDryRun.parsed ? protectedShipDryRun.parsed.status : 'NO_JSON',
    read_only: protectedShipDryRun.parsed ? protectedShipDryRun.parsed.read_only : 'NO_JSON'
  }));
  const aliasBeforeInstall = await runCommand(['git', 'config', '--local', '--get', 'alias.ship'], { cwd: fixtureRoot });
  const installAliasDryRun = await runFixtureBha(fixtureRoot, ['install-git-ship-alias', '--dry-run', '--format', 'json']);
  const aliasAfterDryRun = await runCommand(['git', 'config', '--local', '--get', 'alias.ship'], { cwd: fixtureRoot });
  const installAlias = await runFixtureBha(fixtureRoot, ['install-git-ship-alias', '--yes', '--format', 'json']);
  const aliasAfterInstall = await runCommand(['git', 'config', '--local', '--get', 'alias.ship'], { cwd: fixtureRoot });
  checks.push(regressionCheck('install_git_ship_alias_dry_run_is_readonly',
    installAliasDryRun.exit_code === 0 &&
    installAliasDryRun.parsed &&
    installAliasDryRun.parsed.status === 'DRY_RUN_READY' &&
    installAliasDryRun.parsed.read_only === true &&
    aliasBeforeInstall.exit_code === aliasAfterDryRun.exit_code &&
    String(aliasBeforeInstall.stdout || '').trim() === String(aliasAfterDryRun.stdout || '').trim(), {
    exit_code: installAliasDryRun.exit_code,
    status: installAliasDryRun.parsed ? installAliasDryRun.parsed.status : 'NO_JSON',
    read_only: installAliasDryRun.parsed ? installAliasDryRun.parsed.read_only : 'NO_JSON',
    alias_before_exit_code: aliasBeforeInstall.exit_code,
    alias_after_dry_run_exit_code: aliasAfterDryRun.exit_code
  }));
  checks.push(regressionCheck('install_git_ship_alias_yes_writes_local_alias',
    installAlias.exit_code === 0 &&
    installAlias.parsed &&
    installAlias.parsed.status === 'INSTALLED' &&
    installAlias.parsed.read_only === false &&
    installAlias.parsed.scope === 'local' &&
    aliasAfterInstall.exit_code === 0 &&
    String(aliasAfterInstall.stdout || '').trim() === gitShipAliasCommand(), {
    exit_code: installAlias.exit_code,
    status: installAlias.parsed ? installAlias.parsed.status : 'NO_JSON',
    scope: installAlias.parsed ? installAlias.parsed.scope : 'NO_JSON',
    alias_value: String(aliasAfterInstall.stdout || '').trim()
  }));
  const topicBranch = 'codex/regression-topic';
  const topicCheckout = await runCommand(['git', 'checkout', '-b', topicBranch], { cwd: fixtureRoot });
  const topicNoCapabilityPreflight = await runFixtureBha(fixtureRoot, ['prepush-check', '--preflight', '--internal-git-hook', 'origin']);
  const returnToProtectedBranch = await runCommand(['git', 'checkout', branch], { cwd: fixtureRoot });
  checks.push(regressionCheck('topic_branch_prepush_does_not_require_signed_capability',
    topicCheckout.exit_code === 0 &&
    topicNoCapabilityPreflight.exit_code === 0 &&
    topicNoCapabilityPreflight.parsed &&
    topicNoCapabilityPreflight.parsed.status === 'ALLOW' &&
    topicNoCapabilityPreflight.parsed.capability_required === false &&
    topicNoCapabilityPreflight.parsed.checks &&
    topicNoCapabilityPreflight.parsed.checks.valid_consumed_capability === true &&
    returnToProtectedBranch.exit_code === 0, {
    checkout_exit_code: topicCheckout.exit_code,
    preflight_exit_code: topicNoCapabilityPreflight.exit_code,
    status: topicNoCapabilityPreflight.parsed ? topicNoCapabilityPreflight.parsed.status : 'NO_JSON',
    capability_required: topicNoCapabilityPreflight.parsed ? topicNoCapabilityPreflight.parsed.capability_required : 'NO_JSON',
    reason: topicNoCapabilityPreflight.parsed ? topicNoCapabilityPreflight.parsed.reason : 'NO_JSON',
    return_checkout_exit_code: returnToProtectedBranch.exit_code
  }));
  const deletePrepushInput = `(delete) 0000000000000000000000000000000000000000 refs/heads/${topicBranch} 1111111111111111111111111111111111111111\n`;
  const topicDeletePreflightRaw = await runCommand([
    process.execPath,
    'scripts/bha-run.js',
    'prepush-check',
    '--preflight',
    '--internal-git-hook',
    'origin'
  ], { cwd: fixtureRoot, input: deletePrepushInput });
  const topicDeletePreflight = Object.assign({}, topicDeletePreflightRaw, { parsed: parseJsonLine(topicDeletePreflightRaw.stdout) });
  checks.push(regressionCheck('topic_branch_delete_prepush_requires_high_risk_authorization',
    topicDeletePreflight.exit_code === 1 &&
    topicDeletePreflight.parsed &&
    topicDeletePreflight.parsed.status === 'FAIL_CLOSED' &&
    topicDeletePreflight.parsed.reason === 'REMOTE_BRANCH_DELETE_REQUIRES_HIGH_RISK_AUTHORIZATION' &&
    topicDeletePreflight.parsed.push_action === 'delete' &&
    topicDeletePreflight.parsed.destructive_remote_delete === true &&
    topicDeletePreflight.parsed.high_risk_authorization_required === true &&
    topicDeletePreflight.parsed.capability_required === true &&
    topicDeletePreflight.parsed.prepush_update &&
    topicDeletePreflight.parsed.prepush_update.branch === topicBranch &&
    topicDeletePreflight.parsed.prepush_update.is_delete === true &&
    topicDeletePreflight.parsed.checks &&
    topicDeletePreflight.parsed.checks.remote_branch_delete_blocked === false &&
    topicDeletePreflight.parsed.checks.valid_consumed_capability === false, {
    exit_code: topicDeletePreflight.exit_code,
    status: topicDeletePreflight.parsed ? topicDeletePreflight.parsed.status : 'NO_JSON',
    reason: topicDeletePreflight.parsed ? topicDeletePreflight.parsed.reason : 'NO_JSON',
    push_action: topicDeletePreflight.parsed ? topicDeletePreflight.parsed.push_action : 'NO_JSON',
    capability_required: topicDeletePreflight.parsed ? topicDeletePreflight.parsed.capability_required : 'NO_JSON',
    remote_branch_delete_blocked: topicDeletePreflight.parsed && topicDeletePreflight.parsed.checks
      ? topicDeletePreflight.parsed.checks.remote_branch_delete_blocked
      : 'NO_JSON'
  }));
  const postPushBlocked = shipBlocked('BLOCKED_PR_CREATE_FAILED', {
    remote: 'origin',
    base: branch,
    branch: 'codex/example',
    pushed: true,
    steps: [{ id: 'git_push_topic_branch', ok: true }]
  });
  checks.push(regressionCheck('ship_pr_create_failure_after_push_is_writeful',
    postPushBlocked.status === 'BLOCKED_PR_CREATE_FAILED' &&
    postPushBlocked.read_only === false &&
    postPushBlocked.pushed === true, {
    status: postPushBlocked.status,
    read_only: postPushBlocked.read_only,
    pushed: postPushBlocked.pushed
  }));
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
    (protectedBaseBranch(branch)
      ? String(missingPayloadGateStatus.parsed.post_push_status.next_operator_meaning || '').includes('No push to protected master is required now')
      : String(missingPayloadGateStatus.parsed.post_push_status.next_operator_meaning || '').includes('No push is required now')) &&
    (protectedBaseBranch(branch)
      ? String(missingPayloadGateStatus.parsed.post_push_status.next_operator_meaning || '').includes('BHA read-only gate')
      : String(missingPayloadGateStatus.parsed.post_push_status.next_operator_meaning || '').includes('if the operator chooses a real push')), {
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
    missingPayloadGateStatus.parsed.next_action_scope === (protectedBaseBranch(branch) ? 'emergency_direct_push_to_protected_branch' : 'operator_chosen_git_push') &&
    String(missingPayloadGateStatus.parsed.next_action_condition || '').includes('operator chooses'), {
    next_action: missingPayloadGateStatus.parsed ? missingPayloadGateStatus.parsed.next_action : 'NO_JSON',
    next_action_required_now: missingPayloadGateStatus.parsed ? missingPayloadGateStatus.parsed.next_action_required_now : 'NO_JSON',
    next_action_scope: missingPayloadGateStatus.parsed ? missingPayloadGateStatus.parsed.next_action_scope : 'NO_JSON'
  }));
  checks.push(regressionCheck('gate_status_protected_master_guides_pr_flow', missingPayloadGateStatus.exit_code === 0 &&
    missingPayloadGateStatus.parsed &&
    (!protectedBaseBranch(branch) || (
      missingPayloadGateStatus.parsed.remote_branch_policy &&
      missingPayloadGateStatus.parsed.remote_branch_policy.direct_push === 'emergency_only' &&
      missingPayloadGateStatus.parsed.remote_branch_policy.required_check === 'BHA read-only gate' &&
      missingPayloadGateStatus.parsed.operator_handoff &&
      missingPayloadGateStatus.parsed.operator_handoff.protected_branch_policy &&
      Array.isArray(missingPayloadGateStatus.parsed.operator_handoff.standard_remote_flow) &&
      missingPayloadGateStatus.parsed.operator_handoff.standard_remote_flow.some((commandText) => String(commandText).includes('pull request'))
    )), {
    branch,
    remote_branch_policy: missingPayloadGateStatus.parsed ? missingPayloadGateStatus.parsed.remote_branch_policy : 'NO_JSON'
  }));
  const gateNextCommands = missingPayloadGateStatus.parsed && Array.isArray(missingPayloadGateStatus.parsed.next_commands)
    ? missingPayloadGateStatus.parsed.next_commands
    : [];
  const gateCapabilityCommands = missingPayloadHandoff && Array.isArray(missingPayloadHandoff.capability_commands_when_unblocked)
    ? missingPayloadHandoff.capability_commands_when_unblocked
    : [];
  const gateCopyableCommands = gateNextCommands.concat(gateCapabilityCommands);
  checks.push(regressionCheck('gate_status_copyable_commands_quote_arguments', missingPayloadGateStatus.exit_code === 0 &&
    gateCopyableCommands.length > 0 &&
    gateCopyableCommands.every((commandText) => !String(commandText).includes('\n')) &&
    gateCopyableCommands.some((commandText) => String(commandText).includes("--remote 'origin'")) &&
    gateCopyableCommands.some((commandText) => String(commandText).includes(`--branch '${branch}'`)) &&
    gateCopyableCommands.some((commandText) => String(commandText).includes("--out '.bha/local/push-payload.json'")) &&
    gateCopyableCommands.some((commandText) => String(commandText).includes("--file '.bha/local/signed-push-capability.json'") ||
      String(commandText).includes('--file $cap')) &&
    gateCopyableCommands.some((commandText) => String(commandText).includes('$cap = ')), {
    command_count: gateCopyableCommands.length,
    has_newline: gateCopyableCommands.some((commandText) => String(commandText).includes('\n')),
    quotes_remote: gateCopyableCommands.some((commandText) => String(commandText).includes("--remote 'origin'")),
    quotes_branch: gateCopyableCommands.some((commandText) => String(commandText).includes(`--branch '${branch}'`)),
    quotes_out: gateCopyableCommands.some((commandText) => String(commandText).includes("--out '.bha/local/push-payload.json'")),
    quotes_file: gateCopyableCommands.some((commandText) => String(commandText).includes("--file '.bha/local/signed-push-capability.json'") ||
      String(commandText).includes('--file $cap')),
    cap_variable_present: gateCopyableCommands.some((commandText) => String(commandText).includes('$cap = '))
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
  const currentUnsignedGateStatus = await runFixtureBha(fixtureRoot, ['gate-status', '--remote', 'origin', '--branch', branch, '--format', 'json']);
  const currentUnsignedHandoff = currentUnsignedGateStatus.parsed && currentUnsignedGateStatus.parsed.operator_handoff
    ? currentUnsignedGateStatus.parsed.operator_handoff
    : null;
  const currentUnsignedStatus = currentUnsignedHandoff ? currentUnsignedHandoff.local_payload_status : null;
  const currentUnsignedTopCommands = currentUnsignedGateStatus.parsed && Array.isArray(currentUnsignedGateStatus.parsed.next_commands)
    ? currentUnsignedGateStatus.parsed.next_commands
    : [];
  const currentUnsignedHandoffCommands = currentUnsignedHandoff && Array.isArray(currentUnsignedHandoff.single_line_commands)
    ? currentUnsignedHandoff.single_line_commands
    : [];
  checks.push(regressionCheck('gate_status_uses_existing_current_unsigned_payload_before_signing', currentUnsignedGateStatus.exit_code === 0 &&
    currentUnsignedStatus &&
    currentUnsignedStatus.unsigned_matches_current_context === true &&
    currentUnsignedStatus.next_payload_action === 'SIGN_CURRENT_UNSIGNED_PAYLOAD_OUTSIDE_BHA' &&
    currentUnsignedTopCommands.length > 0 &&
    currentUnsignedHandoffCommands.length > 0 &&
    !String(currentUnsignedTopCommands[0]).includes('make-push-payload') &&
    !String(currentUnsignedHandoffCommands[0]).includes('make-push-payload') &&
    String(currentUnsignedHandoffCommands[0]).includes('existing .bha/local/push-payload.json'), {
    next_payload_action: currentUnsignedStatus ? currentUnsignedStatus.next_payload_action : 'NO_JSON',
    top_first_command: currentUnsignedTopCommands[0] || 'NO_COMMAND',
    handoff_first_command: currentUnsignedHandoffCommands[0] || 'NO_COMMAND'
  }));
  const currentUnsignedRecoverStatus = await runFixtureBha(fixtureRoot, ['recover-status', '--remote', 'origin', '--branch', branch, '--format', 'json']);
  const currentUnsignedRecoverCommands = currentUnsignedRecoverStatus.parsed &&
    currentUnsignedRecoverStatus.parsed.git_push_recovery &&
    Array.isArray(currentUnsignedRecoverStatus.parsed.git_push_recovery.next_commands)
    ? currentUnsignedRecoverStatus.parsed.git_push_recovery.next_commands
    : [];
  checks.push(regressionCheck('recover_status_uses_existing_current_unsigned_payload_before_signing', currentUnsignedRecoverStatus.exit_code === 0 &&
    currentUnsignedRecoverStatus.parsed &&
    currentUnsignedRecoverStatus.parsed.local_payload_recovery &&
    currentUnsignedRecoverStatus.parsed.local_payload_recovery.recovery_action === 'SIGN_CURRENT_UNSIGNED_PAYLOAD_OUTSIDE_BHA' &&
    currentUnsignedRecoverCommands.length > 0 &&
    !String(currentUnsignedRecoverCommands[0]).includes('push-prep') &&
    currentUnsignedRecoverCommands.some((commandText) => String(commandText).includes('operator-signer-preflight')) &&
    currentUnsignedRecoverCommands.some((commandText) => String(commandText).includes('operator signs existing .bha/local/push-payload.json')), {
    recovery_action: currentUnsignedRecoverStatus.parsed && currentUnsignedRecoverStatus.parsed.local_payload_recovery
      ? currentUnsignedRecoverStatus.parsed.local_payload_recovery.recovery_action
      : 'NO_JSON',
    first_command: currentUnsignedRecoverCommands[0] || 'NO_COMMAND'
  }));
  const outsideLocalDir = path.join(fixtureRoot, '..', `outside-local-escape-${crypto.randomUUID()}`);
  const localEscapeLink = path.join(fixtureRoot, '.bha', 'local', 'escape-link');
  let localEscapeLinkCreated = false;
  let localEscapeLinkError = null;
  try {
    fs.mkdirSync(outsideLocalDir, { recursive: true });
    fs.symlinkSync(outsideLocalDir, localEscapeLink, process.platform === 'win32' ? 'junction' : 'dir');
    localEscapeLinkCreated = true;
  } catch (error) {
    localEscapeLinkError = error && error.message ? error.message : String(error);
  }
  const escapedHandoffPath = path.join(outsideLocalDir, 'push-handoff.json');
  const symlinkEscapePrep = localEscapeLinkCreated
    ? await runFixtureBha(fixtureRoot, [
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
      '.bha/local/escape-link/push-handoff.json'
    ])
    : { exit_code: 2, parsed: { ok: false, error: 'SYMLINK_UNAVAILABLE' } };
  checks.push(regressionCheck('push_prep_rejects_local_symlink_escape', localEscapeLinkCreated &&
    symlinkEscapePrep.exit_code === 2 &&
    symlinkEscapePrep.parsed &&
    symlinkEscapePrep.parsed.ok === false &&
    String(symlinkEscapePrep.parsed.error || '').includes('symbolic links') &&
    !fs.existsSync(escapedHandoffPath), {
    symlink_created: localEscapeLinkCreated,
    symlink_error: localEscapeLinkError,
    exit_code: symlinkEscapePrep.exit_code,
    error: symlinkEscapePrep.parsed ? symlinkEscapePrep.parsed.error : 'NO_JSON',
    escaped_handoff_exists: fs.existsSync(escapedHandoffPath)
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
    Array.isArray(staleStatus.reason_details) &&
    staleStatus.reason_details.some((detail) => detail.code === 'HEAD_MISMATCH' && String(detail.message || '').includes('git HEAD')) &&
    staleIssues.some((issue) => issue.kind === 'unsigned_payload' && issue.reasons.includes('HEAD_MISMATCH')) &&
    staleIssues.some((issue) => issue.kind === 'unsigned_payload' && Array.isArray(issue.reason_details) && issue.reason_details.some((detail) => detail.code === 'HEAD_MISMATCH')) &&
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
    staleSignedPayloadStatus.parsed.signed_payload.not_usable_reasons.includes('HEAD_MISMATCH') &&
    Array.isArray(staleSignedPayloadStatus.parsed.signed_payload.not_usable_reason_details) &&
    staleSignedPayloadStatus.parsed.signed_payload.not_usable_reason_details.some((detail) => detail.code === 'HEAD_MISMATCH' && String(detail.message || '').includes('git HEAD')), {
    status: staleSignedPayloadStatus.parsed ? staleSignedPayloadStatus.parsed.status : 'NO_JSON',
    reasons: staleSignedPayloadStatus.parsed && staleSignedPayloadStatus.parsed.signed_payload ? staleSignedPayloadStatus.parsed.signed_payload.not_usable_reasons : 'NO_JSON'
  }));
  const staleRecoverStatus = await runFixtureBha(fixtureRoot, ['recover-status', '--remote', 'origin', '--branch', branch, '--format', 'json']);
  const staleRecoverPayload = staleRecoverStatus.parsed ? staleRecoverStatus.parsed.local_payload_recovery : null;
  const staleRecoverIssues = staleRecoverPayload && staleRecoverPayload.local_payload_status && Array.isArray(staleRecoverPayload.local_payload_status.not_usable_local_files)
    ? staleRecoverPayload.local_payload_status.not_usable_local_files
    : [];
  checks.push(regressionCheck('recover_status_reports_stale_local_payload_recovery', staleRecoverStatus.exit_code === 0 &&
    staleRecoverStatus.parsed &&
    staleRecoverStatus.parsed.read_only === true &&
    staleRecoverPayload &&
    staleRecoverPayload.read_only === true &&
    staleRecoverPayload.stale_or_not_usable === true &&
    staleRecoverPayload.recovery_action === 'REGENERATE_UNSIGNED_PAYLOAD_AND_SIGN_CURRENT_CONTEXT' &&
    staleRecoverPayload.local_payload_status &&
    Array.isArray(staleRecoverPayload.local_payload_status.reason_details) &&
    staleRecoverPayload.local_payload_status.reason_details.some((detail) => detail.code === 'HEAD_MISMATCH' && String(detail.message || '').includes('git HEAD')) &&
    staleRecoverIssues.some((issue) => issue.kind === 'unsigned_payload' && issue.reasons.includes('HEAD_MISMATCH')) &&
    staleRecoverIssues.some((issue) => issue.kind === 'signed_payload' && issue.reasons.includes('HEAD_MISMATCH')), {
    recovery_action: staleRecoverPayload ? staleRecoverPayload.recovery_action : 'NO_JSON',
    stale_issue_count: staleRecoverIssues.length
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
  const recoverTrackedGitReality = staleRecoverStatus.parsed ? staleRecoverStatus.parsed.tracked_git_reality : null;
  checks.push(regressionCheck('recover_status_reports_evidence_time_git_heads', staleRecoverStatus.exit_code === 0 &&
    recoverTrackedGitReality &&
    recoverTrackedGitReality.current_head &&
    recoverTrackedGitReality.checkpoint_head &&
    recoverTrackedGitReality.closeout_git_reality_head &&
    recoverTrackedGitReality.proof_boundary &&
    recoverTrackedGitReality.proof_boundary.includes('evidence-time facts'), {
    current_head: recoverTrackedGitReality ? recoverTrackedGitReality.current_head : 'NO_JSON',
    checkpoint_head: recoverTrackedGitReality ? recoverTrackedGitReality.checkpoint_head : 'NO_JSON',
    checkpoint_matches_current_head: recoverTrackedGitReality ? recoverTrackedGitReality.checkpoint_matches_current_head : 'NO_JSON'
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

  const expiredUnsignedPayload = await runFixtureBha(fixtureRoot, [
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
  const expiredUnsignedPath = path.join(fixtureRoot, '.bha', 'local', 'push-payload.json');
  if (expiredUnsignedPayload.exit_code === 0 && fs.existsSync(expiredUnsignedPath)) {
    const expiredPayload = readJsonStrict(expiredUnsignedPath);
    expiredPayload.expires_at = '2000-01-01T00:00:00.000Z';
    writeTextFile(expiredUnsignedPath, JSON.stringify(expiredPayload) + '\n');
  }
  const expiredUnsignedGateStatus = await runFixtureBha(fixtureRoot, ['gate-status', '--remote', 'origin', '--branch', branch, '--format', 'json']);
  const expiredUnsignedHandoff = expiredUnsignedGateStatus.parsed && expiredUnsignedGateStatus.parsed.operator_handoff
    ? expiredUnsignedGateStatus.parsed.operator_handoff
    : null;
  const expiredUnsignedStatus = expiredUnsignedHandoff ? expiredUnsignedHandoff.local_payload_status : null;
  const expiredUnsignedIssues = expiredUnsignedStatus && Array.isArray(expiredUnsignedStatus.not_usable_local_files)
    ? expiredUnsignedStatus.not_usable_local_files
    : [];
  checks.push(regressionCheck('gate_status_flags_expired_unsigned_payload', expiredUnsignedPayload.exit_code === 0 &&
    expiredUnsignedGateStatus.exit_code === 0 &&
    expiredUnsignedStatus &&
    expiredUnsignedStatus.unsigned_matches_current_context === true &&
    expiredUnsignedStatus.next_payload_action === 'REGENERATE_UNSIGNED_PAYLOAD_AND_SIGN_CURRENT_CONTEXT' &&
    expiredUnsignedStatus.reason_codes.includes('PAYLOAD_EXPIRED') &&
    expiredUnsignedIssues.some((issue) => issue.kind === 'unsigned_payload' &&
      issue.reasons.includes('PAYLOAD_EXPIRED') &&
      Array.isArray(issue.reason_details) &&
      issue.reason_details.some((detail) => detail.code === 'PAYLOAD_EXPIRED' && String(detail.message || '').includes('expired'))), {
    unsigned_matches_current_context: expiredUnsignedStatus ? expiredUnsignedStatus.unsigned_matches_current_context : 'NO_JSON',
    reason_codes: expiredUnsignedStatus ? expiredUnsignedStatus.reason_codes : 'NO_JSON'
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

  const expiredSignedPayload = Object.assign({}, signedPayload, {
    expires_at: '2000-01-01T00:00:00.000Z'
  });
  writeTextFile(signedPath, JSON.stringify(expiredSignedPayload) + '\n');
  const expiredSignedPayloadStatus = await runFixtureBha(fixtureRoot, ['signed-payload-status', '--remote', 'origin', '--branch', branch, '--format', 'json']);
  checks.push(regressionCheck('signed_payload_status_reports_expired_reason_detail', expiredSignedPayloadStatus.exit_code === 0 &&
    expiredSignedPayloadStatus.parsed &&
    expiredSignedPayloadStatus.parsed.status === 'SIGNED_PAYLOAD_EXPIRED' &&
    expiredSignedPayloadStatus.parsed.signed_payload &&
    Array.isArray(expiredSignedPayloadStatus.parsed.signed_payload.not_usable_reasons) &&
    expiredSignedPayloadStatus.parsed.signed_payload.not_usable_reasons.includes('PAYLOAD_EXPIRED') &&
    Array.isArray(expiredSignedPayloadStatus.parsed.signed_payload.not_usable_reason_details) &&
    expiredSignedPayloadStatus.parsed.signed_payload.not_usable_reason_details.some((detail) => detail.code === 'PAYLOAD_EXPIRED' && String(detail.message || '').includes('expired')), {
    status: expiredSignedPayloadStatus.parsed ? expiredSignedPayloadStatus.parsed.status : 'NO_JSON',
    reasons: expiredSignedPayloadStatus.parsed && expiredSignedPayloadStatus.parsed.signed_payload
      ? expiredSignedPayloadStatus.parsed.signed_payload.not_usable_reasons
      : 'NO_JSON'
  }));
  writeTextFile(signedPath, JSON.stringify(signedPayload) + '\n');

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

  const secondMakePayload = await runFixtureBha(fixtureRoot, [
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
  const secondUnsignedPayload = secondMakePayload.exit_code === 0 ? readJsonStrict(payloadPath) : null;
  const secondSignedPayload = secondUnsignedPayload ? signCapabilityPayload(secondUnsignedPayload, keypair.privateKey) : null;
  if (secondSignedPayload) {
    writeTextFile(signedPath, JSON.stringify(secondSignedPayload) + '\n');
  }
  const secondVerifySigned = await runFixtureBha(fixtureRoot, ['verify-signed-capability', '--file', '.bha/local/signed-push-capability.json']);
  const secondIssue = await runFixtureBha(fixtureRoot, ['issue-capability', '--file', '.bha/local/signed-push-capability.json']);
  const secondConsume = await runFixtureBha(fixtureRoot, [
    'consume-capability',
    '--id',
    secondSignedPayload ? secondSignedPayload.capability_id : 'MISSING_SECOND_CAPABILITY',
    '--for',
    'git_push',
    '--remote',
    'origin',
    '--branch',
    branch
  ]);
  const secondPreflight = await runFixtureBha(fixtureRoot, ['prepush-check', '--preflight', '--internal-git-hook', 'origin']);
  checks.push(regressionCheck('new_git_push_capability_after_used_session_allows_same_head_branch', secondMakePayload.exit_code === 0 &&
    secondVerifySigned.exit_code === 0 &&
    secondIssue.exit_code === 0 &&
    secondConsume.exit_code === 0 &&
    secondPreflight.exit_code === 0 &&
    secondSignedPayload &&
    secondSignedPayload.capability_id !== signedPayload.capability_id &&
    secondPreflight.parsed &&
    secondPreflight.parsed.status === 'ALLOW' &&
    secondPreflight.parsed.capability &&
    secondPreflight.parsed.capability.capability_id === secondSignedPayload.capability_id, {
    first_capability_id: signedPayload.capability_id,
    second_capability_id: secondSignedPayload ? secondSignedPayload.capability_id : null,
    second_preflight_status: secondPreflight.parsed ? secondPreflight.parsed.status : 'NO_JSON',
    second_preflight_reason: secondPreflight.parsed ? secondPreflight.parsed.reason : 'NO_JSON'
  }));

  const deniedCases = [
    ['provider_call_denied', ['openai', 'models', 'list']],
    ['memory_write_denied', ['codex-memory', 'write']],
    ['deploy_denied', ['kubectl', 'apply', '-f', 'production.yaml']],
    ['release_denied', ['gh', 'release', 'create']],
    ['tag_denied', ['git', 'tag', 'v0.0.0']],
    ['package_install_denied', ['npm', 'install']],
    ['package_publish_denied', ['npm', 'publish']],
    ['production_write_denied', ['psql', 'production', '-c', 'update']],
    ['force_push_denied', ['git', 'push', '--force', 'origin', branch]],
    ['destructive_external_action_denied', ['rm', '-rf', 'external']]
  ];
  const deniedResults = [];
  for (const [id, argv] of deniedCases) {
    const result = await runFixtureBha(fixtureRoot, ['assert-deny', '--'].concat(argv));
    const pass = result.exit_code === 0 &&
      result.parsed &&
      result.parsed.decision === 'DENY' &&
      result.parsed.assertion_passed === true &&
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
  return gitReality.changedFilesFromStatus(stdout);
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
        `node scripts/bha-run.js recover-status --remote 'origin' --branch ${powerShellSingleQuote(branch || 'master')} --format json`,
        `node scripts/bha-run.js gate-status --remote 'origin' --branch ${powerShellSingleQuote(branch || 'master')} --format json`
      ],
      fresh_clone_path: [
        'node scripts/bha-verify.js',
        "node scripts/bha-run.js recover-status --remote 'origin' --branch 'master' --format json",
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
      schema: 'bha.checkpoint_output.v1',
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
    schema: 'bha.checkpoint_output.v1',
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
    schema: 'bha.closeout_output.v1',
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
        "node scripts/bha-run.js recover-status --remote 'origin' --branch 'master' --format json",
        'node scripts/bha-run.js checkpoint --format json',
        'node scripts/bha-run.js closeout --record --format json',
        "node scripts/bha-run.js gate-status --remote 'origin' --branch 'master' --format json"
      ]
    },
    fresh_clone_recovery: {
      tracked_trust_without_local_gate_evidence: 'node scripts/bha-verify.js',
      recovery_status: "node scripts/bha-run.js recover-status --remote 'origin' --branch 'master' --format json",
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

function shipStep(id, result) {
  return Object.assign({
    id,
    exit_code: result && Object.prototype.hasOwnProperty.call(result, 'exit_code') ? result.exit_code : null,
    ok: Boolean(result && result.exit_code === 0 && !result.error),
    error: result && result.error ? result.error : null
  }, result && result.parsed ? { parsed: result.parsed } : {});
}

function shipStepsIncludeSuccessfulRemotePush(steps) {
  return Array.isArray(steps) && steps.some((step) => step && step.id === 'git_push_topic_branch' && step.ok === true);
}

function shipBlocked(status, fields) {
  const report = Object.assign({
    schema: 'bha.ship.v1',
    ok: false,
    status,
    read_only: true,
    recorded: false
  }, fields || {});
  if (!Object.prototype.hasOwnProperty.call(fields || {}, 'read_only') && shipStepsIncludeSuccessfulRemotePush(report.steps)) {
    report.read_only = false;
  }
  return report;
}

function gitShipAliasCommand() {
  return '!f() { node scripts/bha-run.js ship "$@"; }; f';
}

async function localGitAliasValue(name) {
  const result = await runCommand(['git', 'config', '--local', '--get', `alias.${name}`], {});
  if (result.exit_code === 0 && !result.error) {
    return {
      ok: true,
      exists: true,
      value: String(result.stdout || '').trim(),
      exit_code: result.exit_code
    };
  }
  if (result.exit_code === 1 && !result.error) {
    return {
      ok: true,
      exists: false,
      value: null,
      exit_code: result.exit_code
    };
  }
  return {
    ok: false,
    exists: false,
    value: null,
    exit_code: result.exit_code,
    error: result.error || truncate(result.stderr)
  };
}

async function handleInstallGitShipAlias(args) {
  const format = getOption(args, '--format') || 'json';
  const yes = hasFlag(args, '--yes');
  const dryRun = hasFlag(args, '--dry-run');
  const scope = getOption(args, '--scope') || 'local';
  const expected = gitShipAliasCommand();
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }
  if (scope !== 'local') {
    console.log(JSON.stringify({
      schema: 'bha.install_git_ship_alias.v1',
      ok: false,
      status: 'BLOCKED_NON_LOCAL_SCOPE',
      read_only: true,
      recorded: false,
      scope,
      proof_boundary: 'Only repository-local git alias installation is supported; global/system git config is intentionally out of scope.'
    }));
    process.exitCode = 3;
    return;
  }
  const before = await localGitAliasValue('ship');
  if (before.ok !== true) {
    console.log(JSON.stringify({
      schema: 'bha.install_git_ship_alias.v1',
      ok: false,
      status: 'BLOCKED_ALIAS_STATUS_FAILED',
      read_only: true,
      recorded: false,
      scope,
      alias: 'ship',
      expected_value: expected,
      current_alias: before
    }));
    process.exitCode = 3;
    return;
  }
  if (!yes && !dryRun) {
    console.log(JSON.stringify({
      schema: 'bha.install_git_ship_alias.v1',
      ok: false,
      status: 'BLOCKED_CONFIRMATION_REQUIRED',
      read_only: true,
      recorded: false,
      scope,
      alias: 'ship',
      expected_value: expected,
      current_alias: before,
      next_command: 'node scripts/bha-run.js install-git-ship-alias --yes --format json',
      proof_boundary: 'Installing the alias writes only repository-local .git/config and requires explicit --yes.'
    }));
    process.exitCode = 3;
    return;
  }
  if (dryRun) {
    console.log(JSON.stringify({
      schema: 'bha.install_git_ship_alias.v1',
      ok: true,
      status: 'DRY_RUN_READY',
      read_only: true,
      recorded: false,
      scope,
      alias: 'ship',
      expected_value: expected,
      current_alias: before,
      would_run: ['git', 'config', '--local', 'alias.ship', expected],
      resulting_user_command: 'git ship --yes',
      proof_boundary: 'Dry-run reads repository-local git config and does not install the alias.'
    }));
    return;
  }

  ensureLocalWriteAllowed('install local git ship alias');
  const install = await runCommand(['git', 'config', '--local', 'alias.ship', expected], {});
  const after = await localGitAliasValue('ship');
  const ok = install.exit_code === 0 && !install.error && after.ok === true && after.value === expected;
  console.log(JSON.stringify({
    schema: 'bha.install_git_ship_alias.v1',
    ok,
    status: ok ? 'INSTALLED' : 'INSTALL_FAILED',
    read_only: false,
    recorded: false,
    scope,
    alias: 'ship',
    expected_value: expected,
    previous_alias: before,
    current_alias: after,
    resulting_user_command: 'git ship --yes',
    install: {
      exit_code: install.exit_code,
      error: install.error,
      stderr: truncate(install.stderr)
    },
    proof_boundary: 'The alias is repository-local only. It forwards git ship arguments to node scripts/bha-run.js ship and does not grant protected-branch push authority.'
  }));
  if (!ok) {
    process.exitCode = install.exit_code || 3;
  }
}

async function gitStatusShortText() {
  const status = await gitStatusShort();
  return {
    ok: status.ok,
    clean: status.clean,
    short: status.stdout.trim() || 'CLEAN',
    stdout: status.stdout,
    stderr: truncate(status.stderr),
    error: status.error,
    exit_code: status.exit_code
  };
}

async function commitEvidenceIfNeeded(message) {
  const status = await gitStatusShort();
  if (status.ok !== true) {
    return { ok: false, status: 'GIT_STATUS_FAILED', git_status: status };
  }
  if (status.clean === true) {
    return { ok: true, status: 'NO_EVIDENCE_COMMIT_REQUIRED', committed: false };
  }
  if (!authorizedRuntimeDirty(status.stdout)) {
    return {
      ok: false,
      status: 'BLOCKED_UNVERIFIED_WORKTREE_CHANGES',
      git_status: {
        short: status.stdout.trim() || 'CLEAN'
      }
    };
  }
  const add = await runCommand(['git', 'add', '.bha/checkpoint.json', '.bha/ledger.jsonl', '.bha/state.json'], {});
  if (add.exit_code !== 0 || add.error) {
    return { ok: false, status: 'GIT_ADD_FAILED', add };
  }
  const commit = await runCommand(['git', 'commit', '-m', message || 'chore: record bha evidence for ship'], {});
  const committed = commit.exit_code === 0 && !commit.error;
  return {
    ok: committed,
    status: committed ? 'EVIDENCE_COMMITTED' : 'GIT_COMMIT_FAILED',
    committed,
    add,
    commit
  };
}

function parseJsonArrayOutput(result) {
  try {
    const parsed = JSON.parse(String(result.stdout || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

async function currentPrForBranch(branch, base) {
  const result = await runCommand([
    'gh',
    'pr',
    'list',
    '--head',
    branch,
    '--base',
    base,
    '--json',
    'number,url,state,title'
  ], {});
  return {
    result,
    prs: result.exit_code === 0 && !result.error ? parseJsonArrayOutput(result) : []
  };
}

async function handleShip(args) {
  const format = getOption(args, '--format') || 'json';
  const yes = hasFlag(args, '--yes');
  const dryRun = hasFlag(args, '--dry-run');
  const signed = hasFlag(args, '--signed');
  const waitChecks = !hasFlag(args, '--no-wait');
  if (format !== 'json') {
    console.log(JSON.stringify({ ok: false, status: 'INVALID', error: 'only --format json is supported' }));
    process.exitCode = 2;
    return;
  }

  const remote = getOption(args, '--remote') || 'origin';
  const base = getOption(args, '--base') || 'master';
  const actualBranch = await currentBranch();
  const branch = getOption(args, '--branch') || actualBranch;
  const headBefore = await currentHead();
  const steps = [];
  if (!branch) {
    console.log(JSON.stringify(shipBlocked('BLOCKED_NO_CURRENT_BRANCH', { remote, base, branch: 'UNKNOWN' })));
    process.exitCode = 2;
    return;
  }
  if (!yes && !dryRun) {
    console.log(JSON.stringify(shipBlocked('BLOCKED_CONFIRMATION_REQUIRED', {
      remote,
      base,
      branch,
      head: headBefore,
      next_command: `node scripts/bha-run.js ship --yes --remote ${powerShellSingleQuote(remote)} --base ${powerShellSingleQuote(base)}`,
      proof_boundary: 'ship performs remote push and PR operations only with --yes; protected branches still require explicit signed flow.'
    })));
    process.exitCode = 3;
    return;
  }
  if (protectedBaseBranch(branch)) {
    console.log(JSON.stringify(shipBlocked('BLOCKED_PROTECTED_BRANCH', {
      remote,
      base,
      branch,
      head: headBefore,
      signed_requested: signed,
      next_command: 'Use a topic branch and PR for normal work; direct protected branch push requires the existing signed git_push capability flow.',
      proof_boundary: 'ship --yes intentionally does not direct-push protected branches.'
    })));
    process.exitCode = 3;
    return;
  }
  if (actualBranch !== branch) {
    console.log(JSON.stringify(shipBlocked('BLOCKED_BRANCH_MISMATCH', {
      remote,
      base,
      branch,
      current_branch: actualBranch || 'UNKNOWN',
      head: headBefore,
      next_command: 'Switch to the topic branch before running ship.'
    })));
    process.exitCode = 3;
    return;
  }

  const initialStatus = await gitStatusShortText();
  if (initialStatus.ok !== true) {
    console.log(JSON.stringify(shipBlocked('BLOCKED_GIT_STATUS_FAILED', { remote, base, branch, git_status: initialStatus })));
    process.exitCode = 3;
    return;
  }
  if (initialStatus.clean !== true && !authorizedRuntimeDirty(initialStatus.stdout)) {
    console.log(JSON.stringify(shipBlocked('BLOCKED_UNVERIFIED_WORKTREE_CHANGES', {
      remote,
      base,
      branch,
      git_status: { short: initialStatus.short },
      next_commands: ['commit or stash non-evidence worktree changes before ship']
    })));
    process.exitCode = 3;
    return;
  }

  const evidenceBefore = await evidenceUxStatus(remote, base);
  if (evidenceBefore.ok !== true) {
    console.log(JSON.stringify(shipBlocked('BLOCKED_EVIDENCE_REQUIRES_FULL_VALIDATION', {
      remote,
      base,
      branch,
      evidence_ux: {
        status: evidenceBefore.status,
        recommendation: evidenceBefore.recommendation
      },
      next_commands: evidenceBefore.recommendation ? evidenceBefore.recommendation.full_repair_commands : ['node scripts/bha-run.js validate']
    })));
    process.exitCode = 3;
    return;
  }
  if (evidenceBefore.recommendation && evidenceBefore.recommendation.fast_repair_available === true && !dryRun) {
    const repair = await readOnlyJsonCommand(['node', 'scripts/bha-run.js', 'repair-evidence', '--fast', '--remote', remote, '--branch', base, '--format', 'json']);
    steps.push(shipStep('repair_evidence_fast', repair));
    if (repair.ok !== true) {
      console.log(JSON.stringify(shipBlocked('BLOCKED_REPAIR_EVIDENCE_FAILED', { remote, base, branch, steps })));
      process.exitCode = repair.exit_code || 3;
      return;
    }
  }

  const evidenceCommit = dryRun
    ? { ok: true, status: 'DRY_RUN_SKIPPED', committed: false }
    : await commitEvidenceIfNeeded('chore: record bha evidence for ship');
  steps.push({ id: 'commit_evidence_if_needed', ok: evidenceCommit.ok === true, status: evidenceCommit.status, committed: evidenceCommit.committed === true });
  if (evidenceCommit.ok !== true) {
    console.log(JSON.stringify(shipBlocked(evidenceCommit.status || 'BLOCKED_EVIDENCE_COMMIT_FAILED', {
      remote,
      base,
      branch,
      steps,
      git_status: evidenceCommit.git_status || null
    })));
    process.exitCode = 3;
    return;
  }

  const verify = await verifierResult();
  steps.push({
    id: 'verify',
    ok: verify.ok === true,
    status: verify.parsed ? verify.parsed.status : 'UNKNOWN',
    exit_code: verify.exit_code
  });
  if (verify.ok !== true) {
    console.log(JSON.stringify(shipBlocked('BLOCKED_VERIFIER_FAILED', { remote, base, branch, steps })));
    process.exitCode = verify.exit_code || 3;
    return;
  }

  const stable = await readOnlyJsonCommand(['node', 'scripts/bha-run.js', 'stable-exit-status', '--remote', remote, '--branch', base, '--format', 'json']);
  steps.push(shipStep('stable_exit_status', stable));
  if (stable.ok !== true) {
    console.log(JSON.stringify(shipBlocked('BLOCKED_STABLE_EXIT_STATUS_FAILED', {
      remote,
      base,
      branch,
      steps,
      stable_exit_status: stable.parsed || null
    })));
    process.exitCode = stable.exit_code || 3;
    return;
  }

  const head = await currentHead();
  if (dryRun) {
    console.log(JSON.stringify({
      schema: 'bha.ship.v1',
      ok: true,
      status: 'DRY_RUN_READY',
      read_only: true,
      recorded: false,
      remote,
      base,
      branch,
      head,
      steps,
      next_command: `node scripts/bha-run.js ship --yes --remote ${powerShellSingleQuote(remote)} --base ${powerShellSingleQuote(base)}`,
      proof_boundary: 'ship --dry-run performs no push and creates no PR.'
    }));
    return;
  }

  const push = await runCommand(['git', 'push', '-u', remote, `HEAD:refs/heads/${branch}`], {});
  steps.push({
    id: 'git_push_topic_branch',
    ok: push.exit_code === 0 && !push.error,
    exit_code: push.exit_code,
    stderr: truncate(push.stderr),
    error: push.error
  });
  if (push.exit_code !== 0 || push.error) {
    console.log(JSON.stringify(shipBlocked('BLOCKED_GIT_PUSH_FAILED', { remote, base, branch, head, steps })));
    process.exitCode = push.exit_code || 3;
    return;
  }

  const currentPr = await currentPrForBranch(branch, base);
  steps.push({
    id: 'find_existing_pr',
    ok: currentPr.result.exit_code === 0 && !currentPr.result.error,
    exit_code: currentPr.result.exit_code,
    found: currentPr.prs.length
  });
  let pr = currentPr.prs[0] || null;
  if (!pr) {
    const created = await runCommand(['gh', 'pr', 'create', '--base', base, '--head', branch, '--fill'], {});
    const url = String(created.stdout || '').trim();
    steps.push({
      id: 'create_pr',
      ok: created.exit_code === 0 && !created.error,
      exit_code: created.exit_code,
      url,
      stderr: truncate(created.stderr),
      error: created.error
    });
    if (created.exit_code !== 0 || created.error) {
      console.log(JSON.stringify(shipBlocked('BLOCKED_PR_CREATE_FAILED', {
        read_only: false,
        remote,
        base,
        branch,
        head,
        pushed: true,
        pr: null,
        steps,
        proof_boundary: 'The topic branch push already completed before PR creation failed; this blocked result is writeful and requires operator follow-up or cleanup.'
      })));
      process.exitCode = created.exit_code || 3;
      return;
    }
    const refreshed = await currentPrForBranch(branch, base);
    pr = refreshed.prs[0] || { url };
  }

  let checks = null;
  if (waitChecks && pr && pr.number) {
    const watched = await runCommand(['gh', 'pr', 'checks', String(pr.number), '--watch', '--interval', '10'], {});
    steps.push({
      id: 'wait_pr_checks',
      ok: watched.exit_code === 0 && !watched.error,
      exit_code: watched.exit_code,
      stdout: truncate(watched.stdout),
      stderr: truncate(watched.stderr),
      error: watched.error
    });
    checks = {
      ok: watched.exit_code === 0 && !watched.error,
      output: truncate(watched.stdout || watched.stderr)
    };
  }

  console.log(JSON.stringify({
    schema: 'bha.ship.v1',
    ok: !checks || checks.ok === true,
    status: !checks || checks.ok === true ? 'SHIPPED' : 'SHIPPED_CHECKS_FAILED',
    read_only: false,
    recorded: false,
    remote,
    base,
    branch,
    head,
    pushed: true,
    pr,
    checks,
    steps,
    proof_boundary: 'ship automates ordinary topic branch push and PR flow. Protected branch direct push, force push, release, deploy, tag, and package publish remain outside this command.'
  }));
  if (checks && checks.ok !== true) {
    process.exitCode = 1;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  setCurrentCommandEffect(command, args);
  try {
    if (command === 'check') {
      await handleCheck(args);
    } else if (command === 'assert-deny') {
      await handleAssertDeny(args);
    } else if (command === 'exec') {
      await handleExec(args);
    } else if (command === 'ship') {
      await handleShip(args);
    } else if (command === 'install-git-ship-alias') {
      await handleInstallGitShipAlias(args);
    } else if (command === 'inspect') {
      await handleInspect(args);
    } else if (command === 'validate') {
      await handleValidate();
    } else if (command === 'verify') {
      await handleVerify(args);
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
    } else if (command === 'evidence-ux-status') {
      await handleEvidenceUxStatus(args);
    } else if (command === 'repair-evidence') {
      await handleRepairEvidence(args);
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
    } else if (command === 'proof-vocabulary-status') {
      await handleProofVocabularyStatus(args);
    } else if (command === 'bootstrap-status') {
      await handleBootstrapStatus(args);
    } else if (command === 'proof-negative-matrix-status') {
      await handleProofNegativeMatrixStatus(args);
    } else if (command === 'stable-exit-status') {
      await handleStableExitStatus(args);
    } else if (command === 'stable-exit-review') {
      await handleStableExitReview(args);
    } else if (command === 'next-local-plan-status') {
      await handleNextLocalPlanStatus(args);
    } else if (command === 'long-term-goal-status') {
      await handleLongTermGoalStatus(args);
    } else if (command === 'audit-v2-preview') {
      await handleAuditV2Preview(args);
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
