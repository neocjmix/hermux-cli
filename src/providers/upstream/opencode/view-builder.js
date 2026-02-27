'use strict';

function clamp(text, maxLen) {
  const value = String(text == null ? '' : text);
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 3))}...`;
}

function toText(value) {
  return String(value == null ? '' : value);
}

function formatInlineCode(value) {
  const raw = toText(value);
  const escaped = raw.replace(/`/g, '\\`');
  return `\`${escaped}\``;
}

function formatStatusPane(renderState, maxLen, options) {
  const sessionId = toText(renderState.sessionId || (renderState.session && renderState.session.id)).trim();
  const status = toText(renderState.session && renderState.session.status).trim() || 'unknown';
  const isIdle = !!(renderState.session && renderState.session.isIdle);
  const runId = toText(options && options.runId).trim();
  const latestAssistantMessageId = toText(
    renderState.render && renderState.render.latestAssistantMessageId
  ).trim();
  const lines = [
    'Status Pane',
    `run_id: ${formatInlineCode(runId || '-')}`,
    `session: ${formatInlineCode(sessionId || '-')}`,
    `status: ${formatInlineCode(status)}`,
    `idle: ${formatInlineCode(isIdle ? 'yes' : 'no')}`,
  ];
  if (latestAssistantMessageId) lines.push(`assistant_message: ${formatInlineCode(latestAssistantMessageId)}`);
  return clamp(lines.join('\n'), maxLen);
}

function messageTimeMs(message) {
  const created = Number(message && message.time && message.time.created ? message.time.created : 0);
  const completed = Number(message && message.time && message.time.completed ? message.time.completed : 0);
  return Math.max(created, completed, 0);
}

function pickLatestAssistantMessage(renderState, options) {
  const messages = renderState.messages && renderState.messages.byId ? renderState.messages.byId : {};
  const minMessageTimeMs = Number(options && options.minMessageTimeMs ? options.minMessageTimeMs : 0) || 0;
  const latestId = toText(renderState.render && renderState.render.latestAssistantMessageId).trim();
  if (latestId && messages[latestId]) {
    const latestMessage = messages[latestId];
    if (messageTimeMs(latestMessage) >= minMessageTimeMs) return latestMessage;
  }

  const order = Array.isArray(renderState.messages && renderState.messages.order)
    ? renderState.messages.order
    : Object.keys(messages);
  for (let i = order.length - 1; i >= 0; i--) {
    const message = messages[order[i]];
    if (!message || message.role !== 'assistant') continue;
    if (messageTimeMs(message) < minMessageTimeMs) continue;
    return message;
  }
  return null;
}

function buildRunViewFromRenderState(renderState, splitByLimit, maxLen, options) {
  if (!renderState || typeof renderState !== 'object') return [];
  if (typeof splitByLimit !== 'function') return [];
  const safeMaxLen = Number(maxLen || 0) > 0 ? Number(maxLen) : 4000;
  const out = [];
  out.push(formatStatusPane(renderState, safeMaxLen, options));

  const message = pickLatestAssistantMessage(renderState, options);
  if (!message) return out;
  const parts = message.parts && message.parts.byId ? message.parts.byId : {};
  const partOrder = Array.isArray(message.parts && message.parts.order)
    ? message.parts.order
    : Object.keys(parts);
  for (const partId of partOrder) {
    const part = parts[partId];
    if (!part || part.type !== 'text') continue;
    const text = toText(part.text);
    if (!text) continue;
    const chunks = splitByLimit(text, safeMaxLen);
    for (let i = 0; i < chunks.length; i++) {
      out.push(clamp(chunks[i], safeMaxLen));
    }
  }
  return out;
}

module.exports = {
  buildRunViewFromRenderState,
};
