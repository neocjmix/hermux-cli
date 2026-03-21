'use strict';

// Skeleton: upstream opencode payload introspection
// See docs/COMPONENT_CONTRACTS.md § payload-introspection
// BOUNDARY: This is provider-specific. Core/gateway MUST NOT call directly (BOUNDARY_AUDIT #5).
//   Use EventNormalizer for canonical event types.

function parsePayloadMeta(payload) {
  throw new Error('NOT_IMPLEMENTED: parsePayloadMeta');
}

function readBusySignalFromSessionPayload(payload) {
  throw new Error('NOT_IMPLEMENTED: readBusySignalFromSessionPayload');
}

module.exports = {
  parsePayloadMeta,
  readBusySignalFromSessionPayload,
};
