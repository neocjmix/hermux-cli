'use strict';

const { createHash } = require('crypto');

function parsePayloadObject(payload) {
  if (payload && typeof payload === 'object') return payload;
  const raw = String(payload || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_err) {
    return null;
  }
}

function parsePayloadMeta(payload) {
  const raw = typeof payload === 'string' ? String(payload).trim() : '';
  const parsed = parsePayloadObject(payload);
  if (!parsed) {
    return {
      payloadType: '',
      payloadSessionId: '',
      messageId: '',
      partId: '',
      field: '',
      deltaLength: 0,
      payloadSha256: createHash('sha256').update('').digest('hex'),
    };
  }
  const sourceText = raw || JSON.stringify(parsed);
  const payloadSha256 = createHash('sha256').update(sourceText).digest('hex');
  const props = parsed && typeof parsed.properties === 'object' ? parsed.properties : {};
  const payloadSessionId = String(
    props.sessionID
    || (props.part && props.part.sessionID)
    || (props.info && props.info.sessionID)
    || ''
  ).trim();
  const deltaText = String(props.delta || '');
  return {
    payloadType: String(parsed && parsed.type ? parsed.type : ''),
    payloadSessionId,
    messageId: String(props.messageID || (props.part && props.part.messageID) || (props.info && props.info.id) || ''),
    partId: String(props.partID || (props.part && props.part.id) || ''),
    field: String(props.field || ''),
    deltaLength: deltaText.length,
    payloadSha256,
  };
}

function readBusySignalFromSessionPayload(payload) {
  const parsed = parsePayloadObject(payload);
  if (!parsed) return null;
  const type = String(parsed && parsed.type ? parsed.type : '').trim();
  if (type === 'session.idle') return false;
  if (type !== 'session.status') return null;
  const statusType = String(parsed && parsed.properties && parsed.properties.status && parsed.properties.status.type ? parsed.properties.status.type : '').trim();
  if (statusType === 'busy') return true;
  if (statusType === 'idle') return false;
  return null;
}

function rankPayloadPriority(payload) {
  const parsed = parsePayloadObject(payload);
  const type = String(parsed && parsed.type ? parsed.type : '').trim();
  if (!type) return 0;
  if (type === 'message.part.delta' || type === 'message.part.updated') return 4;
  if (type === 'message.updated') return 3;
  if (type === 'session.status' || type === 'session.idle' || type === 'session.diff') return 1;
  return 2;
}

function readAssistantLifecycleEvent(payload) {
  const parsed = parsePayloadObject(payload);
  if (!parsed) return null;
  const type = String(parsed && parsed.type ? parsed.type : '').trim();
  const props = parsed && typeof parsed.properties === 'object' ? parsed.properties : {};

  if (type === 'message.updated') {
    const info = props.info && typeof props.info === 'object' ? props.info : {};
    const role = String(info.role || '').trim().toLowerCase();
    const messageId = String(info.id || '').trim();
    if (role === 'assistant' && messageId) {
      return {
        kind: 'assistant_message',
        payloadType: type,
        messageId,
        parentId: String(info.parentID || '').trim(),
        partId: '',
        field: '',
      };
    }
    return null;
  }

  if (type === 'message.part.updated' || type === 'message.part.delta') {
    const part = props.part && typeof props.part === 'object' ? props.part : props;
    const messageId = String(part.messageID || '').trim();
    if (!messageId) return null;
    return {
      kind: 'assistant_text',
      payloadType: type,
      messageId,
      parentId: '',
      partId: String(part.partID || part.id || '').trim(),
      field: String(part.field || '').trim(),
    };
  }

  return null;
}

function formatPayloadPreview(payload, options) {
  const summarizeText = options && typeof options.summarizeText === 'function'
    ? options.summarizeText
    : (value) => String(value || '').trim();
  const rawText = options && typeof options.rawText === 'string'
    ? options.rawText
    : '';
  const parsed = parsePayloadObject(payload);
  if (!parsed) {
    const preview = summarizeText(rawText);
    return { show: !!preview, preview, category: 'plain_text', sample: preview };
  }

  const type = String(parsed.type || '').trim();
  const props = parsed.properties && typeof parsed.properties === 'object' ? parsed.properties : {};
  const sample = summarizeText(rawText || JSON.stringify(parsed));

  if (type === 'tui.toast.show') {
    const title = String(props.title || '').replace(/[\u25cf\u25cb\u25cc\u25e6\u2022\u00b7]/g, '').trim();
    const message = String(props.message || '').trim();
    const merged = [title, message].filter(Boolean).join(' - ');
    const preview = summarizeText(merged ? `toast: ${merged}` : 'toast event');
    return { show: !!preview, preview, category: 'toast', sample };
  }

  if (type === 'session.updated') {
    const info = props.info && typeof props.info === 'object' ? props.info : {};
    const sid = String(info.id || '').trim();
    const dir = String(info.directory || '').trim();
    const preview = summarizeText(`session updated${sid ? `: ${sid.slice(0, 16)}` : ''}${dir ? ` (${dir})` : ''}`);
    return { show: !!preview, preview, category: 'session', sample };
  }

  if (type === 'message.part.delta') {
    const delta = String(props.delta || '').trim();
    const field = String(props.field || '').trim();
    const body = delta || field || 'delta';
    const preview = summarizeText(`stream delta: ${body}`);
    return { show: !!preview, preview, category: 'message_delta', sample };
  }

  if (type === 'server.connected') {
    return { show: true, preview: 'event stream connected', category: 'server', sample };
  }

  if (type === 'session.diff') {
    return { show: true, preview: 'session diff updated', category: 'session_diff', sample };
  }

  if (type === 'message.updated') {
    const info = props.info && typeof props.info === 'object' ? props.info : {};
    const role = String(info.role || '').trim();
    const preview = summarizeText(`message updated${role ? `: ${role}` : ''}`);
    return { show: !!preview, preview, category: 'message', sample };
  }

  const fallback = summarizeText(`${type || 'json'} event`);
  return { show: !!fallback, preview: fallback, category: type || 'json', sample };
}

module.exports = {
  formatPayloadPreview,
  parsePayloadMeta,
  rankPayloadPriority,
  readAssistantLifecycleEvent,
  readBusySignalFromSessionPayload,
};
