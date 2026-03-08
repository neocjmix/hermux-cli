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

function formatStatusPaneVerbose(renderState, _maxLen, options) {
  const sessionId = toText(renderState.sessionId || (renderState.session && renderState.session.id)).trim();
  const status = toText(renderState.session && renderState.session.status).trim() || 'unknown';
  const isIdle = !!(renderState.session && renderState.session.isIdle);
  const runId = toText(options && options.runId).trim();
  const latestAssistantMessageId = toText(
    renderState.render && renderState.render.latestAssistantMessageId
  ).trim();
  const latestReasoningText = toText(renderState.render && renderState.render.latestReasoningText).trim();
  const queueLength = Number(options && options.queueLength) || 0;
  const lines = [
    `run_id: ${formatInlineCode(runId || '-')}`,
    `session: ${formatInlineCode(sessionId || '-')}`,
    `status: ${formatInlineCode(status)}`,
    `idle: ${formatInlineCode(isIdle ? 'yes' : 'no')}`,
  ];
  if (queueLength > 0) lines.push(`🔜 ${formatInlineCode(String(queueLength))}`);
  if (latestAssistantMessageId) lines.push(`assistant_message: ${formatInlineCode(latestAssistantMessageId)}`);
  if (latestReasoningText) lines.push(`reasoning: ${formatInlineCode(clamp(latestReasoningText, 120))}`);
  return lines.join('\n');
}

function formatStatusPaneNormal(renderState, _maxLen, options) {
  const sessionId = toText(renderState.sessionId || (renderState.session && renderState.session.id)).trim();
  const status = toText(renderState.session && renderState.session.status).trim() || 'idle';
  const repoName = toText(options && options.repoName).trim() || 'repo';
  const stepCount = Number(renderState.session && renderState.session.stepCount) || 0;
  const toolCount = Number(renderState.session && renderState.session.toolCount) || 0;
  const latestReasoningText = toText(renderState.render && renderState.render.latestReasoningText).trim();
  const queueLength = Number(options && options.queueLength) || 0;

  const statusEmoji = status === 'busy' ? '🔴' : status === 'idle' ? '🟢' : '⚪';
  const lines = [
    `📂 ${repoName}`,
    `💬 ${formatInlineCode(sessionId || '-')}`,
    `${statusEmoji} ${status} 👣${stepCount} 🛠️${toolCount}`,
  ];
  if (queueLength > 0) lines.push(`🔜 ${queueLength}`);
  if (latestReasoningText) lines.push(`🤔 ${clamp(latestReasoningText, 120)}`);

  return lines.join('\n');
}

function formatStatusPane(renderState, maxLen, options) {
  const viewMode = toText(options && options.viewMode).trim().toLowerCase();
  if (viewMode === 'verbose') {
    return formatStatusPaneVerbose(renderState, maxLen, options);
  }
  return formatStatusPaneNormal(renderState, maxLen, options);
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

function collectAssistantMessages(renderState, options) {
  const messages = renderState.messages && renderState.messages.byId ? renderState.messages.byId : {};
  const minMessageTimeMs = Number(options && options.minMessageTimeMs ? options.minMessageTimeMs : 0) || 0;
  const order = Array.isArray(renderState.messages && renderState.messages.order)
    ? renderState.messages.order
    : Object.keys(messages);
  const out = [];
  for (let i = 0; i < order.length; i += 1) {
    const message = messages[order[i]];
    if (!message || message.role !== 'assistant') continue;
    if (messageTimeMs(message) < minMessageTimeMs) continue;
    const text = toText(message.renderText).trim();
    if (!text) continue;
    out.push(message);
  }
  return out;
}

function buildRunViewFromRenderState(renderState, splitByLimit, maxLen, options) {
  if (!renderState || typeof renderState !== 'object') return [];
  if (typeof splitByLimit !== 'function') return [];
  const safeMaxLen = Number(maxLen || 0) > 0 ? Number(maxLen) : 4000;
  const out = [];
  out.push(formatStatusPane(renderState, safeMaxLen, options));

  const messages = collectAssistantMessages(renderState, options);
  if (messages.length === 0) {
    const latestOnly = pickLatestAssistantMessage(renderState, options);
    if (!latestOnly) return out;
    const text = toText(latestOnly.renderText).trim();
    if (!text) return out;
    const chunks = splitByLimit(text, safeMaxLen);
    for (let i = 0; i < chunks.length; i++) {
      out.push(clamp(chunks[i], safeMaxLen));
    }
    return out;
  }

  for (let m = 0; m < messages.length; m += 1) {
    const text = toText(messages[m].renderText).trim();
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
