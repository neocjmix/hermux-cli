'use strict';

function toText(value) {
  return String(value == null ? '' : value);
}

function parsePayload(payload) {
  if (payload && typeof payload === 'object') return payload;
  const raw = toText(payload).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

function deepMerge(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return target;
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function appendUnique(arr, value) {
  if (!Array.isArray(arr)) arr = [];
  if (!arr.includes(value)) arr.push(value);
  return arr;
}

function normalizeQuestionOption(option) {
  const raw = option && typeof option === 'object' ? option : {};
  const label = toText(raw.label).trim();
  const description = toText(raw.description).trim();
  if (!label && !description) return null;
  return { label, description };
}

function normalizeQuestion(question) {
  const raw = question && typeof question === 'object' ? question : {};
  const header = toText(raw.header).trim();
  const prompt = toText(raw.question).trim();
  const options = Array.isArray(raw.options)
    ? raw.options.map(normalizeQuestionOption).filter(Boolean)
    : [];
  if (!header && !prompt && options.length === 0) return null;
  return {
    header,
    question: prompt,
    options,
    multiple: !!raw.multiple,
    custom: raw.custom !== false,
  };
}

function createRenderState(sessionId) {
  return {
    schemaVersion: 'opencode-render-state.v1',
    sessionId: toText(sessionId).trim(),
    updatedAt: 0,
    session: {
      id: toText(sessionId).trim(),
      slug: '',
      projectID: '',
      directory: '',
      title: '',
      version: '',
      summary: { additions: 0, deletions: 0, files: 0 },
      status: '',
      isIdle: false,
      diff: null,
      stepCount: 0,
      toolCount: 0,
      question: null,
      permission: null,
      compactedAt: 0,
      deletedAt: 0,
    },
    messages: {
      order: [],
      byId: {},
    },
    render: {
      latestAssistantMessageId: '',
      latestAssistantPartId: '',
      latestAssistantTailMaterializeHint: null,
      latestAssistantText: '',
      latestReasoningText: '',
      busy: false,
    },
  };
}

function removeMessage(state, messageId) {
  const mid = toText(messageId).trim();
  if (!mid) return;
  state.messages.order = state.messages.order.filter((id) => id !== mid);
  delete state.messages.byId[mid];
}

function removePart(state, messageId, partId) {
  const mid = toText(messageId).trim();
  const pid = toText(partId).trim();
  if (!mid || !pid) return;
  const message = state.messages.byId[mid];
  if (!message || !message.parts) return;
  message.parts.order = message.parts.order.filter((id) => id !== pid);
  delete message.parts.byId[pid];
  updateMessageRender(message);
}

function summarizePart(part) {
  if (!part || typeof part !== 'object') return '';
  const type = toText(part.type).trim();
  if (type === 'subtask') {
    const desc = toText(part.description).trim() || toText(part.prompt).trim();
    const agent = toText(part.agent).trim();
    return agent ? `Subtask (${agent}): ${desc}`.trim() : `Subtask: ${desc}`.trim();
  }
  if (type === 'agent') return `Agent: ${toText(part.name).trim()}`.trim();
  if (type === 'retry') {
    const attempt = Number(part.attempt || 0) || 0;
    const message = toText(part.error && part.error.message).trim();
    return `Retry #${attempt}${message ? `: ${message}` : ''}`.trim();
  }
  if (type === 'compaction') {
    return `Compaction${part.auto ? ' (auto)' : ''}${part.overflow ? ' overflow' : ''}`.trim();
  }
  if (type === 'snapshot') return 'Snapshot updated';
  if (type === 'patch') {
    const files = Array.isArray(part.files) ? part.files.length : 0;
    return files > 0 ? `Patch updated (${files} files)` : 'Patch updated';
  }
  return '';
}

function ensureMessage(state, messageId) {
  const mid = toText(messageId).trim();
  if (!mid) return null;
  state.messages.order = appendUnique(state.messages.order, mid);
  if (!state.messages.byId[mid]) {
    state.messages.byId[mid] = {
      id: mid,
      sessionID: state.sessionId,
      role: '',
      parentID: null,
      agent: '',
      providerID: '',
      modelID: '',
      model: null,
      mode: '',
      path: null,
      time: { created: 0, completed: null },
      finish: null,
      cost: null,
      tokens: null,
      summary: null,
      parts: { order: [], byId: {} },
      renderText: '',
      renderReasoningText: '',
      renderReasoningEncrypted: null,
      lastEventSeq: 0,
      lastTextSeq: 0,
    };
  }
  return state.messages.byId[mid];
}

function ensurePart(message, partId, sessionId) {
  const pid = toText(partId).trim();
  if (!pid || !message) return null;
  message.parts.order = appendUnique(message.parts.order, pid);
  if (!message.parts.byId[pid]) {
    message.parts.byId[pid] = {
      id: pid,
      type: '',
      text: '',
      reason: null,
      cost: null,
      tokens: null,
      time: null,
      metadata: null,
      sessionID: sessionId || message.sessionID,
      messageID: message.id,
      sawTextDelta: false,
      sawNonEmptyTextUpdate: false,
      textUpdatedAfterDelta: false,
    };
  }
  return message.parts.byId[pid];
}

function updateMessageRender(message) {
  const textParts = [];
  const reasoningParts = [];
  let reasoningEncrypted = null;
  for (const pid of message.parts.order) {
    const part = message.parts.byId[pid];
    if (!part) continue;
    if (part.type === 'text' && toText(part.text)) textParts.push(toText(part.text));
    if (part.type === 'reasoning' && toText(part.text)) reasoningParts.push(toText(part.text));
    const summary = summarizePart(part);
    if (summary) textParts.push(summary);
    if (part.type === 'reasoning') {
      const encrypted = part.metadata
        && part.metadata.openai
        && toText(part.metadata.openai.reasoningEncryptedContent).trim();
      if (encrypted) reasoningEncrypted = encrypted;
    }
  }
  message.renderText = textParts.join('\n\n');
  message.renderReasoningText = reasoningParts.join('\n\n');
  message.renderReasoningEncrypted = reasoningEncrypted;
}

function mergePermissionAsked(state, event) {
  const props = event && event.properties && typeof event.properties === 'object'
    ? event.properties
    : null;
  if (!props) return;
  const requestId = toText(props.id || props.requestID).trim();
  const permission = toText(props.permission).trim();
  if (!requestId || !permission) return;
  const tool = props.tool && typeof props.tool === 'object'
    ? {
        messageId: toText(props.tool.messageId || props.tool.messageID).trim(),
        callId: toText(props.tool.callId || props.tool.callID).trim(),
      }
    : null;
  state.session.permission = {
    requestId,
    permission,
    patterns: Array.isArray(props.patterns) ? props.patterns.map((v) => toText(v).trim()).filter(Boolean) : [],
    always: Array.isArray(props.always) ? props.always.map((v) => toText(v).trim()).filter(Boolean) : [],
    metadata: props.metadata && typeof props.metadata === 'object' ? { ...props.metadata } : {},
    tool,
  };
}

function mergePermissionResolved(state, event) {
  const active = state && state.session ? state.session.permission : null;
  if (!active) return;
  const props = event && event.properties && typeof event.properties === 'object'
    ? event.properties
    : null;
  const requestId = toText(props && (props.requestID || props.id)).trim();
  const activeRequestId = toText(active.requestId).trim();
  if (!requestId || !activeRequestId || requestId === activeRequestId) {
    state.session.permission = null;
  }
}

function updateGlobalRender(state) {
  const isBetterMessage = (candidate, best, candidateIndex, bestIndex) => {
    const candidateHasText = String(candidate && candidate.renderText || '').trim().length > 0 ? 1 : 0;
    const bestHasText = String(best && best.renderText || '').trim().length > 0 ? 1 : 0;
    if (candidateHasText !== bestHasText) return candidateHasText > bestHasText;

    const candidateTextSeq = Number(candidate && candidate.lastTextSeq ? candidate.lastTextSeq : 0);
    const bestTextSeq = Number(best && best.lastTextSeq ? best.lastTextSeq : 0);
    if (candidateTextSeq !== bestTextSeq) return candidateTextSeq > bestTextSeq;

    const candidateEventSeq = Number(candidate && candidate.lastEventSeq ? candidate.lastEventSeq : 0);
    const bestEventSeq = Number(best && best.lastEventSeq ? best.lastEventSeq : 0);
    if (candidateEventSeq !== bestEventSeq) return candidateEventSeq > bestEventSeq;

    const candidateCompleted = Number(candidate && candidate.time && candidate.time.completed ? candidate.time.completed : 0);
    const bestCompleted = Number(best && best.time && best.time.completed ? best.time.completed : 0);
    const candidateCreated = Number(candidate && candidate.time && candidate.time.created ? candidate.time.created : 0);
    const bestCreated = Number(best && best.time && best.time.created ? best.time.created : 0);
    const candidateActivityTime = Math.max(candidateCreated, candidateCompleted, 0);
    const bestActivityTime = Math.max(bestCreated, bestCompleted, 0);
    if (candidateActivityTime !== bestActivityTime) return candidateActivityTime > bestActivityTime;
    if (candidateCompleted !== bestCompleted) return candidateCompleted > bestCompleted;
    if (candidateCreated !== bestCreated) return candidateCreated > bestCreated;

    return candidateIndex > bestIndex;
  };

  const isBetterReasoningMessage = (candidate, best, candidateIndex, bestIndex) => {
    const candidateHasReasoning = String(candidate && candidate.renderReasoningText || '').trim().length > 0 ? 1 : 0;
    const bestHasReasoning = String(best && best.renderReasoningText || '').trim().length > 0 ? 1 : 0;
    if (candidateHasReasoning !== bestHasReasoning) return candidateHasReasoning > bestHasReasoning;

    const candidateEventSeq = Number(candidate && candidate.lastEventSeq ? candidate.lastEventSeq : 0);
    const bestEventSeq = Number(best && best.lastEventSeq ? best.lastEventSeq : 0);
    if (candidateEventSeq !== bestEventSeq) return candidateEventSeq > bestEventSeq;

    const candidateCompleted = Number(candidate && candidate.time && candidate.time.completed ? candidate.time.completed : 0);
    const bestCompleted = Number(best && best.time && best.time.completed ? best.time.completed : 0);
    const candidateCreated = Number(candidate && candidate.time && candidate.time.created ? candidate.time.created : 0);
    const bestCreated = Number(best && best.time && best.time.created ? best.time.created : 0);
    const candidateActivityTime = Math.max(candidateCreated, candidateCompleted, 0);
    const bestActivityTime = Math.max(bestCreated, bestCompleted, 0);
    if (candidateActivityTime !== bestActivityTime) return candidateActivityTime > bestActivityTime;
    if (candidateCompleted !== bestCompleted) return candidateCompleted > bestCompleted;
    if (candidateCreated !== bestCreated) return candidateCreated > bestCreated;

    return candidateIndex > bestIndex;
  };

  let best = null;
  let bestIndex = -1;
  let bestReasoning = null;
  let bestReasoningIndex = -1;
  for (let i = 0; i < state.messages.order.length; i += 1) {
    const mid = state.messages.order[i];
    const msg = state.messages.byId[mid];
    if (!msg || msg.role !== 'assistant') continue;
    if (!bestReasoning) {
      bestReasoning = msg;
      bestReasoningIndex = i;
    } else if (isBetterReasoningMessage(msg, bestReasoning, i, bestReasoningIndex)) {
      bestReasoning = msg;
      bestReasoningIndex = i;
    }
    if (!best) {
      best = msg;
      bestIndex = i;
      continue;
    }
    if (isBetterMessage(msg, best, i, bestIndex)) {
      best = msg;
      bestIndex = i;
    }
  }

  state.render.latestAssistantMessageId = best ? best.id : '';
  state.render.latestAssistantPartId = '';
  state.render.latestAssistantTailMaterializeHint = null;
  state.render.latestAssistantText = best ? toText(best.renderText) : '';
  state.render.latestReasoningText = bestReasoning ? toText(bestReasoning.renderReasoningText) : '';
  if (best) {
    for (let i = best.parts.order.length - 1; i >= 0; i -= 1) {
      const pid = best.parts.order[i];
      const part = best.parts.byId[pid];
      if (!part || part.type !== 'text' || !toText(part.text).trim()) continue;
      state.render.latestAssistantPartId = toText(part.id).trim();
      if (part.sawNonEmptyTextUpdate) {
        state.render.latestAssistantTailMaterializeHint = {
          messageId: toText(best.id).trim(),
          partId: toText(part.id).trim(),
          reason: part.textUpdatedAfterDelta
            ? 'text_part_updated_after_delta'
            : 'text_part_non_empty_updated',
        };
      }
      break;
    }
  }
  state.render.busy = state.session.status === 'busy';
}

function mergeMessageUpdated(state, event, seq) {
  const info = event && event.properties && event.properties.info;
  if (!info) return;
  const message = ensureMessage(state, info.id);
  if (!message) return;

  message.sessionID = toText(info.sessionID || message.sessionID || state.sessionId);
  message.role = toText(info.role || message.role);
  message.parentID = info.parentID || message.parentID || null;
  message.agent = toText(info.agent || message.agent);
  message.mode = toText(info.mode || message.mode);
  message.path = info.path ? deepMerge(message.path, info.path) : message.path;

  if (info.model && typeof info.model === 'object') {
    message.model = deepMerge(message.model, info.model);
    message.providerID = toText(info.model.providerID || message.providerID);
    message.modelID = toText(info.model.modelID || message.modelID);
  }
  message.providerID = toText(info.providerID || message.providerID);
  message.modelID = toText(info.modelID || message.modelID);

  if (info.time && typeof info.time === 'object') {
    const created = Number(info.time.created || 0);
    const completed = Number(info.time.completed || 0);
    if (created > 0 && (!message.time.created || created < message.time.created)) {
      message.time.created = created;
    }
    if (completed > 0) {
      const prev = Number(message.time.completed || 0);
      if (completed >= prev) message.time.completed = completed;
    }
  }

  if (Object.prototype.hasOwnProperty.call(info, 'cost')) message.cost = info.cost;
  if (info.tokens && typeof info.tokens === 'object') message.tokens = deepMerge(message.tokens, info.tokens);
  if (Object.prototype.hasOwnProperty.call(info, 'finish')) message.finish = info.finish;
  if (info.summary && typeof info.summary === 'object') message.summary = deepMerge(message.summary, info.summary);

  const eventSeq = Number(seq || 0) || 0;
  if (eventSeq > 0) {
    message.lastEventSeq = Math.max(Number(message.lastEventSeq || 0), eventSeq);
  }

  updateMessageRender(message);
}

function mergePartUpdated(state, event, seq) {
  const part = event && event.properties && event.properties.part;
  if (!part) return;
  const message = ensureMessage(state, part.messageID);
  if (!message) return;
  if (!String(message.role || '').trim()) {
    message.role = 'assistant';
  }
  const entry = ensurePart(message, part.id, part.sessionID);
  if (!entry) return;

  Object.assign(entry, deepMerge(entry, part));

  entry.type = toText(part.type || entry.type);
  if (Object.prototype.hasOwnProperty.call(part, 'text')) {
    entry.text = toText(part.text);
    if (entry.type === 'text') {
      const hasNonEmptyText = entry.text.trim().length > 0;
      entry.sawNonEmptyTextUpdate = entry.sawNonEmptyTextUpdate || hasNonEmptyText;
      if (hasNonEmptyText && entry.sawTextDelta) {
        entry.textUpdatedAfterDelta = true;
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(part, 'reason')) entry.reason = part.reason;
  if (Object.prototype.hasOwnProperty.call(part, 'cost')) entry.cost = part.cost;
  if (part.tokens && typeof part.tokens === 'object') entry.tokens = deepMerge(entry.tokens, part.tokens);
  if (part.time && typeof part.time === 'object') entry.time = deepMerge(entry.time, part.time);
  if (part.metadata && typeof part.metadata === 'object') entry.metadata = deepMerge(entry.metadata, part.metadata);

  if (entry.type === 'step-finish' && entry.reason) {
    message.finish = entry.reason;
  }
  if (entry.type === 'step-finish' && entry.tokens) {
    message.tokens = deepMerge(message.tokens, entry.tokens);
  }
  if (entry.type === 'step-finish' && Object.prototype.hasOwnProperty.call(entry, 'cost')) {
    message.cost = entry.cost;
  }

  // Update session-level counters
  if (entry.type === 'step-start') {
    state.session.stepCount = Number(state.session.stepCount || 0) + 1;
  }
  if (entry.type === 'tool') {
    state.session.toolCount = Number(state.session.toolCount || 0) + 1;
  }

  const eventSeq = Number(seq || 0) || 0;
  if (eventSeq > 0) {
    message.lastEventSeq = Math.max(Number(message.lastEventSeq || 0), eventSeq);
    if (entry.type === 'text' && Object.prototype.hasOwnProperty.call(part, 'text')) {
      message.lastTextSeq = Math.max(Number(message.lastTextSeq || 0), eventSeq);
    }
  }

  updateMessageRender(message);
}

function mergePartDelta(state, event, seq) {
  const props = event && event.properties;
  if (!props) return;
  const field = toText(props.field).trim();
  const deltaType = toText(props.type).trim().toLowerCase();
  const message = ensureMessage(state, props.messageID);
  if (!message) return;
  if (!String(message.role || '').trim()) {
    message.role = 'assistant';
  }
  const entry = ensurePart(message, props.partID, props.sessionID);
  if (!entry) return;

  // Skip if already processed this event by seq
  const eventSeq = Number(seq || 0) || 0;
  if (eventSeq > 0 && eventSeq <= (message.lastEventSeq || 0)) {
    return;
  }

  if (field === 'text') {
    if (!entry.type) {
      entry.type = deltaType || 'text';
    } else if (entry.type === 'reasoning' && deltaType === 'text' && !entry.sawNonEmptyTextUpdate) {
      entry.type = 'text';
    }
    entry.text = `${toText(entry.text)}${toText(props.delta)}`;
    entry.sawTextDelta = true;
    const textSeq = Number(seq || 0) || 0;
    if (textSeq > 0) {
      message.lastTextSeq = Math.max(Number(message.lastTextSeq || 0), textSeq);
    }
  } else if (field) {
    const prev = toText(entry[field]);
    entry[field] = `${prev}${toText(props.delta)}`;
  }

  if (eventSeq > 0) {
    message.lastEventSeq = Math.max(Number(message.lastEventSeq || 0), eventSeq);
  }

  updateMessageRender(message);
}
function mergeSessionUpdated(state, event) {
  const info = event && event.properties && event.properties.info;
  if (!info) return;
  state.session = deepMerge(state.session, info);
  state.session.id = toText(state.session.id || state.sessionId);
}

function mergeSessionStatus(state, event) {
  const status = event && event.properties && event.properties.status;
  const type = toText(status && status.type).trim();
  if (!type) return;
  state.session.status = type;
  state.session.isIdle = type === 'idle';
}

function mergeSessionIdle(state) {
  state.session.status = 'idle';
  state.session.isIdle = true;
}

function mergeSessionDiff(state, event) {
  const diff = event && event.properties && event.properties.diff;
  if (typeof diff === 'undefined') return;
  state.session.diff = diff;
}

function mergeSessionCompacted(state) {
  state.session.compactedAt = Date.now();
}

function mergeSessionDeleted(state, event) {
  const info = event && event.properties && event.properties.info;
  if (info) {
    state.session = deepMerge(state.session, info);
  }
  state.session.deletedAt = Date.now();
  state.session.status = 'deleted';
  state.session.isIdle = true;
  state.session.question = null;
  state.session.permission = null;
}

function mergeMessageRemoved(state, event) {
  const props = event && event.properties && typeof event.properties === 'object'
    ? event.properties
    : null;
  if (!props) return;
  removeMessage(state, props.messageID);
}

function mergePartRemoved(state, event) {
  const props = event && event.properties && typeof event.properties === 'object'
    ? event.properties
    : null;
  if (!props) return;
  removePart(state, props.messageID, props.partID);
}

function mergeQuestionAsked(state, event, seq) {
  const props = event && event.properties && typeof event.properties === 'object'
    ? event.properties
    : null;
  if (!props) return;
  const questions = Array.isArray(props.questions)
    ? props.questions.map(normalizeQuestion).filter(Boolean)
    : [];
  if (questions.length === 0) return;
  state.session.question = {
    requestId: toText(props.id || props.requestID).trim(),
    askedSeq: Number(seq || 0) || 0,
    questions,
  };
}

function mergeQuestionResolved(state, event) {
  const active = state && state.session ? state.session.question : null;
  if (!active) return;
  const props = event && event.properties && typeof event.properties === 'object'
    ? event.properties
    : null;
  const requestId = toText(props && (props.requestID || props.id)).trim();
  const activeRequestId = toText(active.requestId).trim();
  if (!requestId || !activeRequestId || requestId === activeRequestId) {
    state.session.question = null;
  }
}

function applyEvent(renderState, event, seq) {
  const state = renderState || createRenderState('');
  const evt = event && typeof event === 'object' ? event : null;
  if (!evt || !evt.type) return state;

  const sessionFromEvent = toText(
    (evt.properties && evt.properties.sessionID)
    || (evt.properties && evt.properties.info && evt.properties.info.sessionID)
    || (evt.properties && evt.properties.part && evt.properties.part.sessionID)
    || state.sessionId
  ).trim();
  if (sessionFromEvent && !state.sessionId) {
    state.sessionId = sessionFromEvent;
    state.session.id = sessionFromEvent;
  }

  const kind = toText(evt.type).trim();
  if (kind === 'message.updated') mergeMessageUpdated(state, evt, seq);
  else if (kind === 'message.removed') mergeMessageRemoved(state, evt);
  else if (kind === 'message.part.updated') mergePartUpdated(state, evt, seq);
  else if (kind === 'message.part.delta') mergePartDelta(state, evt, seq);
  else if (kind === 'message.part.removed') mergePartRemoved(state, evt);
  else if (kind === 'session.created' || kind === 'session.updated') mergeSessionUpdated(state, evt);
  else if (kind === 'session.deleted') mergeSessionDeleted(state, evt);
  else if (kind === 'session.status') mergeSessionStatus(state, evt);
  else if (kind === 'session.idle') mergeSessionIdle(state, evt);
  else if (kind === 'session.diff') mergeSessionDiff(state, evt);
  else if (kind === 'session.compacted') mergeSessionCompacted(state, evt);
  else if (kind === 'permission.asked') mergePermissionAsked(state, evt);
  else if (kind === 'permission.replied') mergePermissionResolved(state, evt);
  else if (kind === 'question.asked') mergeQuestionAsked(state, evt, seq);
  else if (kind === 'question.replied' || kind === 'question.rejected') mergeQuestionResolved(state, evt);

  const now = Number(seq || 0) || Date.now();
  state.updatedAt = now;
  updateGlobalRender(state);
  return state;
}

function applyPayload(renderState, payload, seq) {
  const evt = parsePayload(payload);
  if (!evt) return renderState || createRenderState('');
  return applyEvent(renderState, evt, seq);
}

module.exports = {
  createRenderState,
  applyEvent,
  applyPayload,
  _internal: {
    parsePayload,
    deepMerge,
  },
};
