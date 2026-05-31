'use strict';

function getJsonPathValue(object, dottedPath) {
  const parts = String(dottedPath || '').split('.').filter(Boolean);
  let current = object;
  for (const part of parts) {
    if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
      return { found: false, value: undefined };
    }
    current = current[part];
  }
  return { found: true, value: current };
}

function commandExpectationPassed(result, expect, parseJsonLine) {
  const problems = [];
  if (Object.prototype.hasOwnProperty.call(expect, 'exit_code') && result.exit_code !== expect.exit_code) {
    problems.push(`exit_code expected ${expect.exit_code} got ${result.exit_code}`);
  }
  const expectsJson = ['decision', 'spawned', 'read_only', 'recorded', 'ok', 'status', 'reason', 'json', 'json_paths', 'has_keys', 'missing_keys'].some((key) => {
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
      for (const [jsonPath, expectedValue] of Object.entries(expect.json_paths || {})) {
        const observed = getJsonPathValue(parsed, jsonPath);
        if (!observed.found) {
          problems.push(`expected JSON path ${jsonPath} was missing`);
        } else if (observed.value !== expectedValue) {
          problems.push(`${jsonPath} expected ${expectedValue} got ${observed.value}`);
        }
      }
    }
  }
  if (result.error) {
    problems.push(result.error);
  }
  return problems;
}

async function runValidationCommands(required, deps) {
  const commandResults = [];
  for (const command of required || []) {
    const decision = deps.evaluateValidationCommandPolicy(command.argv);
    let result;
    let spawned = false;
    let policyProblems = [];
    if (decision.allowed) {
      spawned = true;
      result = await deps.runCommand(command.argv, {});
    } else {
      result = {
        argv: deps.scrubArgv(command.argv),
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
    const problems = commandExpectationPassed(result, command.expect || {}, deps.parseJsonLine);
    problems.push(...policyProblems);
    const status = problems.length === 0 ? 'PASS' : 'FAIL';
    const record = {
      id: command.id,
      argv: deps.scrubArgv(command.argv),
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
      stdout: deps.truncate(result.stdout),
      stderr: deps.truncate(result.stderr),
      started_at: result.started_at,
      finished_at: result.finished_at
    };
    commandResults.push(record);
    if (typeof deps.appendValidationStep === 'function') {
      deps.appendValidationStep(record);
    }
  }
  return commandResults;
}

module.exports = {
  getJsonPathValue,
  commandExpectationPassed,
  runValidationCommands
};
