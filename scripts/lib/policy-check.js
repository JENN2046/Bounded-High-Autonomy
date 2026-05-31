'use strict';

const path = require('path');

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
  for (const pattern of deniedPathPatterns(mission, policy || {})) {
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
  for (const arg of (argv || []).slice(1)) {
    if (String(arg).startsWith('-')) {
      continue;
    }
    const match = deniedPathMatch(arg, mission || {}, policy || {});
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

function listFromPolicy(policy, section, fallback) {
  const denyCommands = policy && policy.action_rules && policy.action_rules.deny_commands;
  return (denyCommands && Array.isArray(denyCommands[section])) ? denyCommands[section] : fallback;
}

function argvMatchesPattern(argv, pattern) {
  const expected = String(pattern || '').trim().split(/\s+/).filter(Boolean).map((part, index) => {
    return index === 0 ? commandName(part) : part.toLowerCase();
  });
  if (expected.length === 0 || !Array.isArray(argv) || argv.length < expected.length) {
    return false;
  }
  const actual = [commandName(argv[0])].concat(argv.slice(1).map((arg) => String(arg).toLowerCase()));
  return expected.every((part, index) => actual[index] === part);
}

function argvMatchesAnyPattern(argv, patterns) {
  return (patterns || []).some((pattern) => argvMatchesPattern(argv, pattern));
}

function classifyForbidden(argv, policy) {
  const cmd = commandName((argv || [])[0]);
  const args = (argv || []).slice(1).map(String);
  const first = (args[0] || '').toLowerCase();
  const network = listFromPolicy(policy, 'network_commands', ['curl', 'wget']);
  const providers = listFromPolicy(policy, 'provider_commands', ['openai', 'anthropic', 'gemini']);
  const memory = listFromPolicy(policy, 'memory_commands', ['codex-memory', 'dailynote']);
  const gitRemote = listFromPolicy(policy, 'git_remote_subcommands', ['push', 'pull', 'fetch', 'clone', 'ls-remote', 'submodule']);
  const destructive = listFromPolicy(policy, 'destructive_commands', ['rm', 'rmdir', 'del']);
  const packageInstall = listFromPolicy(policy, 'package_install_commands', ['npm install', 'npm ci', 'pnpm install', 'yarn install']);
  const packagePublish = listFromPolicy(policy, 'package_publish_commands', ['npm publish', 'pnpm publish']);
  const release = listFromPolicy(policy, 'release_commands', ['gh release', 'git tag', 'npm version']);
  const ssh = listFromPolicy(policy, 'ssh_commands', ['ssh', 'scp', 'rsync']);
  const deploy = listFromPolicy(policy, 'deploy_commands', ['vercel', 'netlify', 'firebase', 'kubectl', 'docker push']);

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
  if (argvMatchesAnyPattern(argv, packageInstall)) {
    return { category: 'package_install', rule: 'DENY_PACKAGE_INSTALL', reason: 'package installation commands are forbidden' };
  }
  if (argvMatchesAnyPattern(argv, packagePublish)) {
    return { category: 'package_publish', rule: 'DENY_PACKAGE_PUBLISH', reason: 'package publishing commands are forbidden' };
  }
  if (argvMatchesAnyPattern(argv, release)) {
    return { category: 'release', rule: 'DENY_RELEASE_COMMAND', reason: 'release and tag commands are forbidden' };
  }
  if (argvMatchesAnyPattern(argv, ssh)) {
    return { category: 'ssh', rule: 'DENY_SSH_COMMAND', reason: 'ssh/scp/rsync commands are forbidden' };
  }
  if (argvMatchesAnyPattern(argv, deploy)) {
    return { category: 'deploy', rule: 'DENY_DEPLOY_COMMAND', reason: 'deploy commands are forbidden' };
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
  const cmd = commandName((argv || [])[0]);
  const args = (argv || []).slice(1).map(String);
  const allowRules = policy && policy.action_rules && Array.isArray(policy.action_rules.allow) ? policy.action_rules.allow : [];
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

function evaluatePolicy(argv, policy, mission) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return {
      decision: 'DENY',
      allowed: false,
      rule: 'DENY_EMPTY_COMMAND',
      reason: 'no command was provided',
      category: 'invalid'
    };
  }
  const deniedPath = classifyDeniedPathArgs(argv, mission || {}, policy || {});
  if (deniedPath) {
    return Object.assign({ decision: 'DENY', allowed: false }, deniedPath);
  }
  const denied = classifyForbidden(argv, policy || {});
  if (denied) {
    return Object.assign({ decision: 'DENY', allowed: false }, denied);
  }
  const allowed = classifyAllowed(argv, policy || {});
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

function evaluateValidationCommandPolicy(argv, policy, mission) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  if (commandName(args[0]) === 'node' &&
      args[1] === 'scripts/bha-run.js' &&
      (args[2] === 'check' || args[2] === 'assert-deny') &&
      args[3] === '--') {
    return evaluatePolicy(args.slice(0, 4), policy, mission);
  }
  return evaluatePolicy(args, policy, mission);
}

function normalizedAllowedPathPatterns(policy) {
  return (((policy || {}).paths || {}).allowed || []).map((item) => normalizeRepoPath(item).path);
}

function normalizedProtectedPathPatterns(policy) {
  return (((policy || {}).paths || {}).protected || []).map((item) => normalizeRepoPath(item).path);
}

function pathMatchesPolicyPattern(filePath, pattern, allowImplicitDescendants) {
  const normalized = normalizeRepoPath(filePath).path;
  let item = String(pattern || '');
  const explicitDescendants = item.endsWith('/**') || item.endsWith('/');
  if (item.endsWith('/**')) {
    item = item.slice(0, -3);
  }
  if (item.endsWith('/')) {
    item = item.slice(0, -1);
  }
  return normalized === item || ((explicitDescendants || allowImplicitDescendants) && normalized.startsWith(item + '/'));
}

function fileAllowedByPolicy(filePath, policy) {
  return normalizedAllowedPathPatterns(policy).some((pattern) => pathMatchesPolicyPattern(filePath, pattern, false));
}

function fileProtectedByPolicy(filePath, policy) {
  return normalizedProtectedPathPatterns(policy).some((pattern) => pathMatchesPolicyPattern(filePath, pattern, true));
}

function policyAllowsArgv(policy, argv) {
  const commandArgv = Array.isArray(argv) ? argv : [];
  const allowRules = policy && policy.action_rules && Array.isArray(policy.action_rules.allow)
    ? policy.action_rules.allow
    : [];
  const args = commandArgv.slice(1);
  return allowRules.some((rule) => {
    return commandName(rule.command) === commandName(commandArgv[0]) &&
      ((rule.args && argsMatch(args, rule.args)) ||
      (rule.args_prefix && argsPrefixMatch(args, rule.args_prefix)));
  });
}

module.exports = {
  commandName,
  normalizeRepoPath,
  deniedPathMatch,
  classifyDeniedPathArgs,
  listFromPolicy,
  argvMatchesPattern,
  argvMatchesAnyPattern,
  classifyForbidden,
  argsMatch,
  argsPrefixMatch,
  classifyAllowed,
  evaluatePolicy,
  evaluateValidationCommandPolicy,
  normalizedAllowedPathPatterns,
  normalizedProtectedPathPatterns,
  pathMatchesPolicyPattern,
  fileAllowedByPolicy,
  fileProtectedByPolicy,
  policyAllowsArgv
};
