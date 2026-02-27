'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRenderState, applyEvent } = require('../src/providers/upstream/opencode/render-state');
const { buildRunViewFromRenderState } = require('../src/providers/upstream/opencode/view-builder');

function splitByLimit(text, maxLen) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > maxLen) {
    out.push(rest.slice(0, maxLen));
    rest = rest.slice(maxLen);
  }
  out.push(rest);
  return out;
}

test('opencode view builder emits status pane first and assistant text after', () => {
  let state = createRenderState('ses-a');

  state = applyEvent(state, {
    type: 'session.status',
    properties: { sessionID: 'ses-a', status: { type: 'busy' } },
  }, 1);

  state = applyEvent(state, {
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-a',
        sessionID: 'ses-a',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }, 2);

  state = applyEvent(state, {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-text',
        sessionID: 'ses-a',
        messageID: 'msg-a',
        type: 'text',
        text: 'hello',
      },
    },
  }, 3);

  state = applyEvent(state, {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-step',
        sessionID: 'ses-a',
        messageID: 'msg-a',
        type: 'step-finish',
        reason: 'stop',
      },
    },
  }, 4);

  const view = buildRunViewFromRenderState(state, splitByLimit, 4000, { runId: 'run-123' });
  assert.equal(view.length >= 2, true);
  assert.match(view[0], /Status Pane/);
  assert.match(view[0], /run_id:\s*`run-123`/i);
  assert.match(view[0], /session:\s*`ses-a`/i);
  assert.match(view[0], /status:\s*`busy`/i);
  assert.match(view[0], /idle:\s*`no`/i);
  assert.match(view[0], /assistant_message:\s*`msg-a`/i);
  assert.equal(view[1], 'hello');
});

test('opencode view builder only includes latest assistant message text', () => {
  let state = createRenderState('ses-a');

  state = applyEvent(state, {
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-user',
        sessionID: 'ses-a',
        role: 'user',
        time: { created: 1 },
      },
    },
  }, 1);

  state = applyEvent(state, {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-user',
        sessionID: 'ses-a',
        messageID: 'msg-user',
        type: 'text',
        text: 'user prompt',
      },
    },
  }, 2);

  state = applyEvent(state, {
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-assistant-1',
        sessionID: 'ses-a',
        role: 'assistant',
        time: { created: 3, completed: 4 },
      },
    },
  }, 3);

  state = applyEvent(state, {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-a1',
        sessionID: 'ses-a',
        messageID: 'msg-assistant-1',
        type: 'text',
        text: 'old answer',
      },
    },
  }, 4);

  state = applyEvent(state, {
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-assistant-2',
        sessionID: 'ses-a',
        role: 'assistant',
        time: { created: 5, completed: 6 },
      },
    },
  }, 5);

  state = applyEvent(state, {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-a2',
        sessionID: 'ses-a',
        messageID: 'msg-assistant-2',
        type: 'text',
        text: 'latest answer',
      },
    },
  }, 6);

  const view = buildRunViewFromRenderState(state, splitByLimit, 4000);
  assert.equal(view[1], 'latest answer');
  assert.equal(view.includes('old answer'), false);
  assert.equal(view.includes('user prompt'), false);
});
