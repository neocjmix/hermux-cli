'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRenderState,
  applyPayload,
} = require('../src/providers/upstream/opencode/render-state');

test('opencode render state accumulates latest session/message/part projection', () => {
  let state = createRenderState('ses-a');

  state = applyPayload(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-a',
        sessionID: 'ses-a',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }), 1);

  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-a',
        sessionID: 'ses-a',
        messageID: 'msg-a',
        type: 'text',
        text: '',
      },
    },
  }), 2);

  state = applyPayload(state, JSON.stringify({
    type: 'message.part.delta',
    properties: {
      sessionID: 'ses-a',
      messageID: 'msg-a',
      partID: 'prt-a',
      field: 'text',
      delta: '안녕',
    },
  }), 3);

  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-a',
        sessionID: 'ses-a',
        messageID: 'msg-a',
        type: 'text',
        text: '안녕!',
      },
    },
  }), 4);

  state = applyPayload(state, JSON.stringify({
    type: 'session.status',
    properties: { sessionID: 'ses-a', status: { type: 'busy' } },
  }), 5);

  state = applyPayload(state, JSON.stringify({
    type: 'session.idle',
    properties: { sessionID: 'ses-a' },
  }), 6);

  assert.equal(state.session.status, 'idle');
  assert.equal(state.session.isIdle, true);
  assert.equal(state.messages.byId['msg-a'].parts.byId['prt-a'].text, '안녕!');
  assert.equal(state.messages.byId['msg-a'].renderText, '안녕!');
  assert.equal(state.render.latestAssistantMessageId, 'msg-a');
  assert.equal(state.render.latestAssistantText, '안녕!');
  assert.equal(state.render.busy, false);
});

test('opencode render state preserves repeated identical deltas for same part', () => {
  let state = createRenderState('ses-repeat');

  state = applyPayload(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-repeat',
        sessionID: 'ses-repeat',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }), 1);

  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-repeat',
        sessionID: 'ses-repeat',
        messageID: 'msg-repeat',
        type: 'text',
        text: '',
      },
    },
  }), 2);

  state = applyPayload(state, JSON.stringify({
    type: 'message.part.delta',
    properties: {
      sessionID: 'ses-repeat',
      messageID: 'msg-repeat',
      partID: 'prt-repeat',
      field: 'text',
      delta: '하',
    },
  }), 3);

  state = applyPayload(state, JSON.stringify({
    type: 'message.part.delta',
    properties: {
      sessionID: 'ses-repeat',
      messageID: 'msg-repeat',
      partID: 'prt-repeat',
      field: 'text',
      delta: '하',
    },
  }), 4);

  assert.equal(state.messages.byId['msg-repeat'].parts.byId['prt-repeat'].text, '하하');
  assert.equal(state.messages.byId['msg-repeat'].renderText, '하하');
});

test('opencode render state tracks latest reasoning text for status pane', () => {
  let state = createRenderState('ses-r');

  state = applyPayload(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-r',
        sessionID: 'ses-r',
        role: 'assistant',
        time: { created: 1 },
      },
    },
  }), 1);

  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-r',
        sessionID: 'ses-r',
        messageID: 'msg-r',
        type: 'reasoning',
        text: 'reasoning snippet',
      },
    },
  }), 2);

  assert.equal(state.messages.byId['msg-r'].renderReasoningText, 'reasoning snippet');
  assert.equal(state.render.latestReasoningText, 'reasoning snippet');
});
