const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/test-profile');

const {
  readBusySignalFromSessionPayload,
  parsePayloadMeta,
} = require('../src/providers/upstream/opencode/payload-introspection');

test('opencode payload introspection extracts busy and idle signals from payloads', () => {
  assert.equal(readBusySignalFromSessionPayload(JSON.stringify({
    type: 'session.status',
    properties: { status: { type: 'busy' } },
  })), true);
  assert.equal(readBusySignalFromSessionPayload({
    type: 'session.status',
    properties: { status: { type: 'idle' } },
  }), false);
  assert.equal(readBusySignalFromSessionPayload(JSON.stringify({ type: 'session.idle', properties: {} })), false);
  assert.equal(readBusySignalFromSessionPayload('not-json'), null);
});

test('opencode payload introspection extracts session and message metadata deterministically', () => {
  const meta = parsePayloadMeta(JSON.stringify({
    type: 'message.part.delta',
    properties: {
      sessionID: 'ses-1',
      messageID: 'msg-1',
      partID: 'part-1',
      field: 'text',
      delta: 'hello',
    },
  }));

  assert.equal(meta.payloadType, 'message.part.delta');
  assert.equal(meta.payloadSessionId, 'ses-1');
  assert.equal(meta.messageId, 'msg-1');
  assert.equal(meta.partId, 'part-1');
  assert.equal(meta.field, 'text');
  assert.equal(meta.deltaLength, 5);
  assert.equal(typeof meta.payloadSha256, 'string');
  assert.equal(meta.payloadSha256.length > 0, true);
});
