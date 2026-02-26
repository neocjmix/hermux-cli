'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionEventHandler } = require('../src/lib/session-event-handler');

test('session event handler routes by session and forwards unwrapped payload', async () => {
  const sent = [];
  const handler = createSessionEventHandler({
    sendRawTelegram: async (payload, channel) => {
      sent.push({ payload, channel });
    },
  });

  const out = await handler({
    activeSessionId: 'ses-a',
    event: {
      sessionId: 'ses-a',
      type: 'raw',
      content: '{"type":"message.updated","value":1}',
    },
  });

  assert.equal(out.handled, true);
  assert.equal(out.nextSessionId, 'ses-a');
  assert.deepEqual(sent, [{ payload: '{"type":"message.updated","value":1}', channel: 'raw_event' }]);
});

test('session event handler drops mismatched session events', async () => {
  const sent = [];
  const handler = createSessionEventHandler({
    sendRawTelegram: async (payload, channel) => {
      sent.push({ payload, channel });
    },
  });

  const out = await handler({
    activeSessionId: 'ses-a',
    event: {
      sessionId: 'ses-b',
      type: 'raw',
      content: '{"type":"message.updated"}',
    },
  });

  assert.equal(out.handled, true);
  assert.equal(out.nextSessionId, 'ses-a');
  assert.equal(sent.length, 0);
});

test('session event handler invokes onDeliver for routed payload', async () => {
  const delivered = [];
  const handler = createSessionEventHandler({
    sendRawTelegram: async () => {},
    onDeliver: async (ctx) => {
      delivered.push(ctx);
    },
  });

  await handler({
    activeSessionId: 'ses-a',
    event: {
      sessionId: 'ses-a',
      type: 'raw',
      content: '{"type":"session.status","properties":{"status":{"type":"busy"}}}',
    },
  });

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].sessionId, 'ses-a');
  assert.match(String(delivered[0].payload || ''), /session\.status/);
});
