'use strict';

function clamp(text, maxLen) {
  const value = String(text == null ? '' : text);
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 3))}...`;
}

function buildRunViewFromRenderState(renderState, splitByLimit, maxLen) {
  if (!renderState || typeof renderState !== 'object') return [];
  if (typeof splitByLimit !== 'function') return [];
  const safeMaxLen = Number(maxLen || 0) > 0 ? Number(maxLen) : 4000;
  const out = [];

  const statusPane = {
    kind: 'status-pane',
    sessionId: renderState.sessionId || (renderState.session && renderState.session.id) || '',
    status: renderState.session && renderState.session.status ? renderState.session.status : '',
    isIdle: !!(renderState.session && renderState.session.isIdle),
    updatedAt: renderState.updatedAt || 0,
    latestAssistantMessageId: renderState.render && renderState.render.latestAssistantMessageId
      ? renderState.render.latestAssistantMessageId
      : '',
    latestAssistantText: renderState.render && renderState.render.latestAssistantText
      ? renderState.render.latestAssistantText
      : '',
  };
  out.push(clamp(JSON.stringify(statusPane), safeMaxLen));

  const messages = renderState.messages && renderState.messages.byId ? renderState.messages.byId : {};
  const order = Array.isArray(renderState.messages && renderState.messages.order)
    ? renderState.messages.order
    : Object.keys(messages);
  for (const messageId of order) {
    const message = messages[messageId];
    if (!message) continue;
    const parts = message.parts && message.parts.byId ? message.parts.byId : {};
    const partOrder = Array.isArray(message.parts && message.parts.order)
      ? message.parts.order
      : Object.keys(parts);
    for (const partId of partOrder) {
      const part = parts[partId];
      if (!part || part.type !== 'text') continue;
      const text = String(part.text || '');
      if (!text) continue;
      const chunks = splitByLimit(text, safeMaxLen);
      const chunkCount = chunks.length;
      for (let i = 0; i < chunkCount; i++) {
        out.push(JSON.stringify({
          kind: 'text-vector',
          messageId,
          partId,
          role: message.role || '',
          chunkIndex: i,
          chunkCount,
          textChunk: chunks[i],
          textLength: text.length,
        }));
      }
    }
  }
  return out;
}

module.exports = {
  buildRunViewFromRenderState,
};
