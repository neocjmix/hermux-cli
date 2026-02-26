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
