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
      tailMaterializeHint: null,
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
  const continuityWarning = safeOptions.continuityWarning && typeof safeOptions.continuityWarning === 'object'
    ? { ...safeOptions.continuityWarning }
    : null;

  const messages = buildRunViewFromRenderState(nextRenderState, {
    runId,
    minMessageTimeMs,
    viewMode,
    repoName,
    queueLength,
    continuityWarning,
  });

  return {
    renderState: nextRenderState,
    snapshot: {
      runId,
      sessionId: toText(nextRenderState.sessionId || (nextRenderState.session && nextRenderState.session.id)).trim(),
      messages: Array.isArray(messages) ? messages : [],
      tailMaterializeHint: nextRenderState
        && nextRenderState.render
        && nextRenderState.render.latestAssistantTailMaterializeHint
        && typeof nextRenderState.render.latestAssistantTailMaterializeHint === 'object'
        ? { ...nextRenderState.render.latestAssistantTailMaterializeHint }
        : null,
      isFinal,
      updatedAtMs: Date.now(),
    },
  };
}

function inspectRunViewSnapshotState(state) {
  const renderState = state && state.renderState && typeof state.renderState === 'object'
    ? state.renderState
    : null;
  const snapshot = state && state.snapshot && typeof state.snapshot === 'object'
    ? state.snapshot
    : null;
  const render = renderState && renderState.render && typeof renderState.render === 'object'
    ? renderState.render
    : {};
  const session = renderState && renderState.session && typeof renderState.session === 'object'
    ? renderState.session
    : {};
  const messages = renderState && renderState.messages && renderState.messages.byId && typeof renderState.messages.byId === 'object'
    ? renderState.messages.byId
    : {};
  const latestAssistantMessageId = String(render.latestAssistantMessageId || '').trim();
  const latestAssistantMessage = latestAssistantMessageId ? messages[latestAssistantMessageId] || null : null;
  const latestAssistantParts = latestAssistantMessage
    && latestAssistantMessage.parts
    && Array.isArray(latestAssistantMessage.parts.order)
    && latestAssistantMessage.parts.byId
    ? latestAssistantMessage.parts.order
      .map((id) => latestAssistantMessage.parts.byId[id])
      .filter(Boolean)
    : [];
  const lastPart = latestAssistantParts.length > 0 ? latestAssistantParts[latestAssistantParts.length - 1] : null;
  return {
    busy: !!render.busy,
    messageCount: Array.isArray(renderState && renderState.messages && renderState.messages.order)
      ? renderState.messages.order.length
      : 0,
    latestAssistantMessageId,
    latestAssistantText: String(render.latestAssistantText || ''),
    latestAssistantTextLength: String(render.latestAssistantText || '').length,
    latestAssistantPartId: lastPart && lastPart.id ? String(lastPart.id) : '',
    activeQuestion: session.question && typeof session.question === 'object' ? { ...session.question } : null,
    activePermission: session.permission && typeof session.permission === 'object' ? { ...session.permission } : null,
    tailMaterializeHint: snapshot && snapshot.tailMaterializeHint && typeof snapshot.tailMaterializeHint === 'object'
      ? { ...snapshot.tailMaterializeHint }
      : null,
    snapshotMessages: snapshot && Array.isArray(snapshot.messages) ? snapshot.messages.slice() : [],
  };
}

module.exports = {
  createRunViewSnapshotState,
  applyPayloadToRunViewSnapshot,
  inspectRunViewSnapshotState,
};
