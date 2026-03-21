'use strict';

// Skeleton: upstream opencode runner
// See docs/specs/ADAPTER_STRATEGY_DI_SPEC.md § AgentRuntimeAdapter
// BOUNDARY: This module is provider-specific (opencode). Core MUST NOT import directly.
//   Core uses AgentRuntimeAdapter interface via provider resolution.

async function runOpencode(instance, prompt, handlers) {
  throw new Error('NOT_IMPLEMENTED: runOpencode');
}

async function subscribeSessionEvents(instance, sessionId, handlers) {
  throw new Error('NOT_IMPLEMENTED: subscribeSessionEvents');
}

async function endSessionLifecycle(instance, sessionId) {
  throw new Error('NOT_IMPLEMENTED: endSessionLifecycle');
}

async function runSessionRevert(instance, sessionId) {
  throw new Error('NOT_IMPLEMENTED: runSessionRevert');
}

async function runSessionUnrevert(instance, sessionId) {
  throw new Error('NOT_IMPLEMENTED: runSessionUnrevert');
}

function stopAllRuntimeExecutors() {
  throw new Error('NOT_IMPLEMENTED: stopAllRuntimeExecutors');
}

function getRuntimeStatusForInstance(instance) {
  throw new Error('NOT_IMPLEMENTED: getRuntimeStatusForInstance');
}

function toValidPortRange(v) { throw new Error('NOT_IMPLEMENTED: toValidPortRange'); }
function pickRandomAvailablePortInRange(min, max) { throw new Error('NOT_IMPLEMENTED: pickRandomAvailablePortInRange'); }
function getRuntimeScopeKey(instance) { throw new Error('NOT_IMPLEMENTED: getRuntimeScopeKey'); }
function shouldUseSdk(instance) { throw new Error('NOT_IMPLEMENTED: shouldUseSdk'); }

module.exports = {
  runOpencode,
  subscribeSessionEvents,
  endSessionLifecycle,
  runSessionRevert,
  runSessionUnrevert,
  stopAllRuntimeExecutors,
  getRuntimeStatusForInstance,
  _internal: {
    toValidPortRange,
    pickRandomAvailablePortInRange,
    getRuntimeScopeKey,
    shouldUseSdk,
  },
};
