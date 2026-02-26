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
    },
    messages: {
      order: [],
      byId: {},
    },
    render: {
      latestAssistantMessageId: '',
      latestAssistantText: '',
      busy: false,
    },
  };
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
      renderReasoningEncrypted: null,
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
    };
  }
  return message.parts.byId[pid];
}

function updateMessageRender(message) {
  const textParts = [];
  let reasoningEncrypted = null;
  for (const pid of message.parts.order) {
    const part = message.parts.byId[pid];
    if (!part) continue;
    if (part.type === 'text' && toText(part.text)) textParts.push(toText(part.text));
    if (part.type === 'reasoning') {
      const encrypted = part.metadata
        && part.metadata.openai
        && toText(part.metadata.openai.reasoningEncryptedContent).trim();
      if (encrypted) reasoningEncrypted = encrypted;
    }
  }
  message.renderText = textParts.join('\n\n');
  message.renderReasoningEncrypted = reasoningEncrypted;
}

function updateGlobalRender(state) {
  let best = null;
  for (const mid of state.messages.order) {
    const msg = state.messages.byId[mid];
    if (!msg || msg.role !== 'assistant') continue;
    if (!best) {
      best = msg;
      continue;
    }
    const bestCompleted = Number(best.time && best.time.completed ? best.time.completed : 0);
    const currCompleted = Number(msg.time && msg.time.completed ? msg.time.completed : 0);
    if (currCompleted > bestCompleted) {
      best = msg;
      continue;
    }
    if (currCompleted === bestCompleted) {
      const bestCreated = Number(best.time && best.time.created ? best.time.created : 0);
      const currCreated = Number(msg.time && msg.time.created ? msg.time.created : 0);
      if (currCreated > bestCreated) best = msg;
    }
  }

  state.render.latestAssistantMessageId = best ? best.id : '';
  state.render.latestAssistantText = best ? toText(best.renderText) : '';
  state.render.busy = state.session.status === 'busy';
}

function mergeMessageUpdated(state, event) {
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

  updateMessageRender(message);
}

function mergePartUpdated(state, event) {
  const part = event && event.properties && event.properties.part;
  if (!part) return;
  const message = ensureMessage(state, part.messageID);
  if (!message) return;
  const entry = ensurePart(message, part.id, part.sessionID);
  if (!entry) return;

  entry.type = toText(part.type || entry.type);
  if (Object.prototype.hasOwnProperty.call(part, 'text')) entry.text = toText(part.text);
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

  updateMessageRender(message);
}

function mergePartDelta(state, event) {
  const props = event && event.properties;
  if (!props) return;
  const field = toText(props.field).trim();
  const message = ensureMessage(state, props.messageID);
  if (!message) return;
  const entry = ensurePart(message, props.partID, props.sessionID);
  if (!entry) return;

  if (field === 'text') {
    entry.type = entry.type || 'text';
    entry.text = `${toText(entry.text)}${toText(props.delta)}`;
  } else if (field) {
    const prev = toText(entry[field]);
    entry[field] = `${prev}${toText(props.delta)}`;
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
  if (kind === 'message.updated') mergeMessageUpdated(state, evt);
  else if (kind === 'message.part.updated') mergePartUpdated(state, evt);
  else if (kind === 'message.part.delta') mergePartDelta(state, evt);
  else if (kind === 'session.updated') mergeSessionUpdated(state, evt);
  else if (kind === 'session.status') mergeSessionStatus(state, evt);
  else if (kind === 'session.idle') mergeSessionIdle(state, evt);
  else if (kind === 'session.diff') mergeSessionDiff(state, evt);

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
