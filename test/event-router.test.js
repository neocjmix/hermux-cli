'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { routeEventBySession } = require('../src/lib/event-router');

test('routeEventBySession routes by active session id', () => {
  const out = routeEventBySession({
    activeSessionId: 'ses-active',
    event: {
      sessionId: 'ses-other',
      type: 'raw',
      content: '{"type":"message.updated"}',
    },
  });

  assert.equal(out.deliver, false);
  assert.equal(out.sessionId, 'ses-active');
  assert.equal(out.payload, '');
});

test('routeEventBySession unwraps content json as-is payload', () => {
  const out = routeEventBySession({
    activeSessionId: '',
    event: {
      sessionId: 'ses-a',
      type: 'raw',
      content: '{ "type": "message.part.updated", "x": 1 }',
    },
  });

  assert.equal(out.deliver, true);
  assert.equal(out.sessionId, 'ses-a');
  assert.equal(out.payload, '{"type":"message.part.updated","x":1}');
});
