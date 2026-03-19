'use strict';

const { createHash } = require('crypto');

function parsePayloadMeta(payload) {
  const raw = String(payload || '').trim();
  if (!raw) {
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
  const payloadSha256 = createHash('sha256').update(raw).digest('hex');
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_err) {
    return {
      payloadType: '',
      payloadSessionId: '',
      messageId: '',
      partId: '',
      field: '',
      deltaLength: 0,
      payloadSha256,
    };
  }
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
  const source = payload && typeof payload === 'object' ? payload : null;
  const raw = source ? '' : String(payload || '').trim();
  if (!source && !raw) return null;
  try {
    const parsed = source || JSON.parse(raw);
    const type = String(parsed && parsed.type ? parsed.type : '').trim();
    if (type === 'session.idle') return false;
    if (type !== 'session.status') return null;
    const statusType = String(parsed && parsed.properties && parsed.properties.status && parsed.properties.status.type ? parsed.properties.status.type : '').trim();
    if (statusType === 'busy') return true;
    if (statusType === 'idle') return false;
    return null;
  } catch (_err) {
    return null;
  }
}

module.exports = {
  parsePayloadMeta,
  readBusySignalFromSessionPayload,
};
