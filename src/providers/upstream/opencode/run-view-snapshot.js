'use strict';

// Skeleton: upstream opencode run-view snapshot
// See docs/REBUILD_CONTRACTS.md § 3 (RunViewSnapshot boundary)
// BOUNDARY: Upstream produces RunViewSnapshot. Downstream MUST NOT parse raw events.
//   snapshot MUST NOT contain transport-specific limits (BOUNDARY_AUDIT #4)

function createRunViewSnapshotState(sessionId) {
  throw new Error('NOT_IMPLEMENTED: createRunViewSnapshotState');
}

function applyPayloadToRunViewSnapshot(state, payload, renderSeq, options) {
  throw new Error('NOT_IMPLEMENTED: applyPayloadToRunViewSnapshot');
}

module.exports = {
  createRunViewSnapshotState,
  applyPayloadToRunViewSnapshot,
};
