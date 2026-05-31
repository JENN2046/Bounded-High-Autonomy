'use strict';

const fs = require('fs');
const crypto = require('crypto');

function createCapabilityStore(deps) {
  function capabilityHash(event) {
    const copy = Object.assign({}, event);
    delete copy.event_hash;
    return deps.sha256(deps.stable(copy));
  }

  function buildCapabilityEvent(type, payload, localOnly) {
    const mission = deps.loadMission();
    const policy = deps.loadPolicy();
    const event = {
      schema: 'bha.capability.event.v1',
      run_id: deps.loadState().run_id,
      mission_id: mission.mission_id || null,
      policy_hash: deps.policyHash(policy),
      mission_hash: deps.missionHash(mission),
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
    deps.ensureTrackedWriteAllowed(`append capability event ${type}`);
    const event = buildCapabilityEvent(type, payload, false);
    fs.appendFileSync(deps.capabilitiesPath, deps.stable(event) + '\n', 'utf8');
    deps.appendLedger(`capability_${type}`, {
      capability_event_hash: event.event_hash,
      capability_id: payload.capability_id || payload.id || null,
      status: payload.status,
      valid: payload.valid === true,
      reason: payload.reason || null
    });
    return event;
  }

  function appendLocalCapabilityEventUnlocked(type, payload) {
    deps.ensureLocalWriteAllowed(`append local capability event ${type}`);
    const event = buildCapabilityEvent(type, payload, true);
    fs.mkdirSync(deps.bhaLocalDir, { recursive: true });
    fs.appendFileSync(deps.resolveLocalFile(deps.localCapabilitiesPath), deps.stable(event) + '\n', 'utf8');
    return event;
  }

  function appendLocalCapabilityEvent(type, payload) {
    deps.ensureLocalWriteAllowed(`append local capability event ${type}`);
    return deps.withCapabilityLock(() => appendLocalCapabilityEventUnlocked(type, payload));
  }

  function appendLocalCapabilitySessionUnlocked(payload) {
    deps.ensureLocalWriteAllowed('append local capability session');
    const event = buildCapabilityEvent('capability_session', payload, true);
    fs.mkdirSync(deps.bhaLocalDir, { recursive: true });
    fs.appendFileSync(deps.resolveLocalFile(deps.localCapabilitySessionsPath), deps.stable(event) + '\n', 'utf8');
    return event;
  }

  function appendLocalCapabilitySession(payload) {
    deps.ensureLocalWriteAllowed('append local capability session');
    return deps.withCapabilityLock(() => appendLocalCapabilitySessionUnlocked(payload));
  }

  function readCapabilityEvents() {
    return deps.readJsonl(deps.capabilitiesPath);
  }

  function readLocalCapabilitySessions() {
    return deps.readJsonl(deps.resolveLocalFile(deps.localCapabilitySessionsPath));
  }

  function readLocalCapabilityEvents() {
    return deps.readJsonl(deps.resolveLocalFile(deps.localCapabilitiesPath));
  }

  function readCapabilityEventsWithLocalSessions() {
    return readCapabilityEvents().concat(readLocalCapabilityEvents()).concat(readLocalCapabilitySessions());
  }

  return {
    capabilityHash,
    buildCapabilityEvent,
    appendCapabilityEvent,
    appendLocalCapabilityEventUnlocked,
    appendLocalCapabilityEvent,
    appendLocalCapabilitySessionUnlocked,
    appendLocalCapabilitySession,
    readCapabilityEvents,
    readLocalCapabilitySessions,
    readLocalCapabilityEvents,
    readCapabilityEventsWithLocalSessions
  };
}

module.exports = {
  createCapabilityStore
};
