'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { routeEventBySession } = require('../src/lib/event-router');

test('routeEventBySession prefers event session id over active session id', () => {
  const out = routeEventBySession({
    activeSessionId: 'ses-active',
    event: {
      sessionId: 'ses-other',
      type: 'raw',
      content: '{"type":"message.updated"}',
    },
  });

  assert.equal(out.deliver, true);
  assert.equal(out.sessionId, 'ses-other');
  assert.equal(out.payload, '{"type":"message.updated"}');
});

test('routeEventBySession drops when payload session conflicts with event session', () => {
  const out = routeEventBySession({
    activeSessionId: 'ses-a',
    event: {
      sessionId: 'ses-a',
      type: 'raw',
      content: '{"type":"session.status","properties":{"sessionID":"ses-b","status":{"type":"busy"}}}',
    },
  });

  assert.equal(out.deliver, false);
  assert.equal(out.reason, 'conflicting_session_identity');
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
