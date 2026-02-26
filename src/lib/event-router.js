'use strict';

function toSessionId(value) {
  return String(value || '').trim();
}

function normalizeJsonString(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch (_err) {
    return raw;
  }
}

function unwrapRawContent(evt) {
  if (evt && typeof evt.content === 'string') {
    return normalizeJsonString(evt.content);
  }
  if (evt && evt.content && typeof evt.content === 'object') {
    try {
      return JSON.stringify(evt.content);
    } catch (_err) {
      return String(evt.content);
    }
  }
  return normalizeJsonString(JSON.stringify(evt || {}));
}

function routeEventBySession({ event, activeSessionId }) {
  const currentSessionId = toSessionId(activeSessionId);
  const eventSessionId = toSessionId(event && event.sessionId);
  const resolvedSessionId = currentSessionId || eventSessionId;

  if (currentSessionId && eventSessionId && currentSessionId !== eventSessionId) {
    return {
      deliver: false,
      sessionId: currentSessionId,
      payload: '',
    };
  }

  return {
    deliver: true,
    sessionId: resolvedSessionId,
    payload: unwrapRawContent(event || {}),
  };
}

module.exports = {
  routeEventBySession,
  _internal: {
    normalizeJsonString,
    unwrapRawContent,
  },
};
