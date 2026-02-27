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

function parseJson(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

function extractSessionIdsFromRawEvent(rawEvent) {
  const evt = rawEvent && typeof rawEvent === 'object' ? rawEvent : null;
  if (!evt) return [];
  const props = evt.properties && typeof evt.properties === 'object' ? evt.properties : {};
  const ids = [];
  ids.push(toSessionId(props.sessionID));
  ids.push(toSessionId(props.part && props.part.sessionID));
  ids.push(toSessionId(props.info && props.info.sessionID));
  return ids.filter(Boolean);
}

function routeEventBySession({ event, activeSessionId }) {
  const currentSessionId = toSessionId(activeSessionId);
  const eventSessionId = toSessionId(event && event.sessionId);
  const parsed = parseJson(event && event.content);
  const payloadSessionIds = extractSessionIdsFromRawEvent(parsed);

  if (eventSessionId && payloadSessionIds.length > 0) {
    const hasConflict = payloadSessionIds.some((sid) => sid !== eventSessionId);
    if (hasConflict) {
      return {
        deliver: false,
        sessionId: eventSessionId,
        payload: '',
        reason: 'conflicting_session_identity',
      };
    }
  }

  const resolvedSessionId = eventSessionId || currentSessionId;

  if (!resolvedSessionId) {
    return {
      deliver: false,
      sessionId: '',
      payload: '',
      reason: 'missing_session_identity',
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
