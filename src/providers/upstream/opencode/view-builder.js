'use strict';

function toText(value) {
  return String(value == null ? '' : value);
}

function formatInlineCode(value) {
  const raw = toText(value);
  const escaped = raw.replace(/`/g, '\\`');
  return `\`${escaped}\``;
}

function appendReasoningLine(lines, renderState, options) {
  const latestReasoningText = toText(renderState.render && renderState.render.latestReasoningText).trim();
  if (!latestReasoningText) return;

  const viewMode = toText(options && options.viewMode).trim().toLowerCase();
  if (viewMode === 'verbose') {
    lines.push(`🤔 reasoning: ${formatInlineCode(latestReasoningText)}`);
    return;
  }

  lines.push(`🤔 ${latestReasoningText}`);
}

function appendQuestionLines(lines, renderState, options) {
  const active = renderState && renderState.session && renderState.session.question;
  const questions = active && Array.isArray(active.questions) ? active.questions : [];
  if (questions.length === 0) return;

  const viewMode = toText(options && options.viewMode).trim().toLowerCase();
  const prefix = viewMode === 'verbose' ? 'question' : '❓';

  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i] || {};
    const header = toText(question.header).trim();
    const prompt = toText(question.question).trim();
    const title = header || prompt || `Question ${i + 1}`;
    lines.push(`${prefix} ${title}`);
    if (prompt && prompt !== title) lines.push(prompt);
    const opts = Array.isArray(question.options) ? question.options : [];
    for (let j = 0; j < opts.length; j += 1) {
      const option = opts[j] || {};
      const label = toText(option.label).trim();
      const description = toText(option.description).trim();
      if (!label && !description) continue;
      lines.push(`${j + 1}. ${label}${description ? ` - ${description}` : ''}`);
    }
    if (question.multiple) {
      lines.push(viewMode === 'verbose' ? 'multiple: true' : 'multiple selection allowed');
    }
  }
}

function formatStatusPaneVerbose(renderState, _maxLen, options) {
  const sessionId = toText(renderState.sessionId || (renderState.session && renderState.session.id)).trim();
  const status = toText(renderState.session && renderState.session.status).trim() || 'unknown';
  const isIdle = !!(renderState.session && renderState.session.isIdle);
  const runId = toText(options && options.runId).trim();
  const latestAssistantMessageId = toText(
    renderState.render && renderState.render.latestAssistantMessageId
  ).trim();
  const queueLength = Number(options && options.queueLength) || 0;
  const lines = [
    `run_id: ${formatInlineCode(runId || '-')}`,
    `session: ${formatInlineCode(sessionId || '-')}`,
    `status: ${formatInlineCode(status)}`,
    `idle: ${formatInlineCode(isIdle ? 'yes' : 'no')}`,
  ];
  if (queueLength > 0) lines.push(`🔜 ${formatInlineCode(String(queueLength))}`);
  if (latestAssistantMessageId) lines.push(`assistant_message: ${formatInlineCode(latestAssistantMessageId)}`);
  appendReasoningLine(lines, renderState, options);
  appendQuestionLines(lines, renderState, options);
  return lines.join('\n');
}

function formatStatusPaneNormal(renderState, _maxLen, options) {
  const sessionId = toText(renderState.sessionId || (renderState.session && renderState.session.id)).trim();
  const status = toText(renderState.session && renderState.session.status).trim() || 'idle';
  const repoName = toText(options && options.repoName).trim() || 'repo';
  const stepCount = Number(renderState.session && renderState.session.stepCount) || 0;
  const toolCount = Number(renderState.session && renderState.session.toolCount) || 0;
  const queueLength = Number(options && options.queueLength) || 0;

  const statusEmoji = status === 'busy' ? '🔴' : status === 'idle' ? '🟢' : '⚪';
  const lines = [
    `📂 ${repoName} ${statusEmoji} ${status} 👣 ${stepCount} 🛠️ ${toolCount}${queueLength > 0 ? ` 🔜 ${queueLength}` : ''}`,
    `${formatInlineCode(sessionId || '-')}`,
  ];

  appendReasoningLine(lines, renderState, options);
  appendQuestionLines(lines, renderState, options);

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
    if (messageTimeMs(latestMessage) === 0 && toText(latestMessage.renderText).trim()) return latestMessage;
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
  const latestId = toText(renderState.render && renderState.render.latestAssistantMessageId).trim();
  const order = Array.isArray(renderState.messages && renderState.messages.order)
    ? renderState.messages.order
    : Object.keys(messages);
  const out = [];
  for (let i = 0; i < order.length; i += 1) {
    const message = messages[order[i]];
    if (!message || message.role !== 'assistant') continue;
    const text = toText(message.renderText).trim();
    if (!text) continue;
    const msgTimeMs = messageTimeMs(message);
    const allowUntimedLatest = latestId && message.id === latestId && msgTimeMs === 0;
    if (!allowUntimedLatest && msgTimeMs < minMessageTimeMs) continue;
    out.push(message);
  }
  return out;
}

function buildRunViewFromRenderState(renderState, options) {
  if (!renderState || typeof renderState !== 'object') return [];
  const out = [];
  out.push(formatStatusPane(renderState, 0, options));

  const messages = collectAssistantMessages(renderState, options);
  if (messages.length === 0) {
    const latestOnly = pickLatestAssistantMessage(renderState, options);
    if (!latestOnly) return out;
    const text = toText(latestOnly.renderText).trim();
    if (!text) return out;
    out.push(text);
    return out;
  }

  for (let m = 0; m < messages.length; m += 1) {
    const text = toText(messages[m].renderText).trim();
    if (!text) continue;
    out.push(text);
  }

  return out;
}

module.exports = {
  buildRunViewFromRenderState,
};
