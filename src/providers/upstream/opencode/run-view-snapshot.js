'use strict';

const { createRenderState, applyPayload } = require('./render-state');
const { buildRunViewFromRenderState } = require('./view-builder');

function toText(value) {
  return String(value == null ? '' : value);
}

function createRunViewSnapshotState(sessionId) {
  const sid = toText(sessionId).trim();
  return {
    renderState: createRenderState(sid),
    snapshot: {
      runId: '',
      sessionId: sid,
      messages: [],
      isFinal: false,
      updatedAtMs: 0,
    },
  };
}

function applyPayloadToRunViewSnapshot(state, payload, renderSeq, options) {
  const current = state && typeof state === 'object'
    ? state
    : createRunViewSnapshotState('');
  const currentRenderState = current.renderState && typeof current.renderState === 'object'
    ? current.renderState
    : createRenderState('');

  const nextRenderState = applyPayload(currentRenderState, payload, renderSeq);
  const safeOptions = options && typeof options === 'object' ? options : {};
  const runId = toText(safeOptions.runId).trim();
  const minMessageTimeMs = Number(safeOptions.minMessageTimeMs || 0) || 0;
  const isFinal = !!safeOptions.isFinal;
  const viewMode = toText(safeOptions.viewMode).trim().toLowerCase() || 'normal';
  const repoName = toText(safeOptions.repoName).trim();
  const queueLength = Number(safeOptions.queueLength || 0) || 0;

  const messages = buildRunViewFromRenderState(nextRenderState, {
    runId,
    minMessageTimeMs,
    viewMode,
    repoName,
    queueLength,
  });

  return {
    renderState: nextRenderState,
    snapshot: {
      runId,
      sessionId: toText(nextRenderState.sessionId || (nextRenderState.session && nextRenderState.session.id)).trim(),
      messages: Array.isArray(messages) ? messages : [],
      isFinal,
      updatedAtMs: Date.now(),
    },
  };
}

module.exports = {
  createRunViewSnapshotState,
  applyPayloadToRunViewSnapshot,
};
