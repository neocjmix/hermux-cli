'use strict';

// Skeleton: upstream opencode render state
// See docs/COMPONENT_CONTRACTS.md § render-state

function createRenderState(sessionId) {
  throw new Error('NOT_IMPLEMENTED: createRenderState');
}

function applyEvent(renderState, event, seq) {
  throw new Error('NOT_IMPLEMENTED: applyEvent');
}

function applyPayload(renderState, payload, seq) {
  throw new Error('NOT_IMPLEMENTED: applyPayload');
}

function parsePayload(raw) { throw new Error('NOT_IMPLEMENTED: parsePayload'); }
function deepMerge(target, source) { throw new Error('NOT_IMPLEMENTED: deepMerge'); }

module.exports = {
  createRenderState,
  applyEvent,
  applyPayload,
  _internal: {
    parsePayload,
    deepMerge,
  },
};
