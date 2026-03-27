const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/test-profile');

const {
  formatPayloadPreview,
  readBusySignalFromSessionPayload,
  parsePayloadMeta,
  rankPayloadPriority,
  readAssistantLifecycleEvent,
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

test('opencode payload introspection ranks payload priority and detects assistant lifecycle events', () => {
  assert.equal(rankPayloadPriority(JSON.stringify({ type: 'message.part.delta', properties: {} })), 4);
  assert.equal(rankPayloadPriority(JSON.stringify({ type: 'message.updated', properties: {} })), 3);
  assert.equal(rankPayloadPriority(JSON.stringify({ type: 'session.status', properties: {} })), 1);
  assert.equal(rankPayloadPriority('not-json'), 0);

  assert.deepEqual(readAssistantLifecycleEvent(JSON.stringify({
    type: 'message.updated',
    properties: { info: { role: 'assistant', id: 'msg-1', parentID: 'msg-0' } },
  })), {
    kind: 'assistant_message',
    payloadType: 'message.updated',
    messageId: 'msg-1',
    parentId: 'msg-0',
    partId: '',
    field: '',
  });

  assert.deepEqual(readAssistantLifecycleEvent(JSON.stringify({
    type: 'message.part.updated',
    properties: { part: { messageID: 'msg-1', id: 'part-9', field: 'text' } },
  })), {
    kind: 'assistant_text',
    payloadType: 'message.part.updated',
    messageId: 'msg-1',
    parentId: '',
    partId: 'part-9',
    field: 'text',
  });
});

test('opencode payload introspection formats payload previews without gateway-owned schema logic', () => {
  const summarizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  assert.deepEqual(formatPayloadPreview(JSON.stringify({
    type: 'tui.toast.show',
    properties: { title: '• Working', message: 'done' },
  }), { summarizeText, rawText: '{...}' }), {
    show: true,
    preview: 'toast: Working - done',
    category: 'toast',
    sample: '{...}',
  });

  assert.deepEqual(formatPayloadPreview(JSON.stringify({
    type: 'message.part.delta',
    properties: { delta: 'hello' },
  }), { summarizeText, rawText: '{...}' }), {
    show: true,
    preview: 'stream delta: hello',
    category: 'message_delta',
    sample: '{...}',
  });
});
