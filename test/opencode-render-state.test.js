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
  assert.equal(state.render.latestAssistantPartId, 'prt-a');
  assert.deepEqual(state.render.latestAssistantTailMaterializeHint, {
    messageId: 'msg-a',
    partId: 'prt-a',
    reason: 'text_part_updated_after_delta',
  });
  assert.equal(state.render.latestAssistantText, '안녕!');
  assert.equal(state.render.busy, false);
});

test('opencode render state infers weaker materialize hint from non-empty updated without prior delta', () => {
  let state = createRenderState('ses-no-delta');

  state = applyPayload(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-no-delta',
        sessionID: 'ses-no-delta',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }), 1);

  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-no-delta',
        sessionID: 'ses-no-delta',
        messageID: 'msg-no-delta',
        type: 'text',
        text: 'whole text at once',
      },
    },
  }), 2);

  assert.equal(state.render.latestAssistantPartId, 'prt-no-delta');
  assert.deepEqual(state.render.latestAssistantTailMaterializeHint, {
    messageId: 'msg-no-delta',
    partId: 'prt-no-delta',
    reason: 'text_part_non_empty_updated',
  });
});

test('opencode render state infers assistant role from late part events when message.updated was missed', () => {
  let state = createRenderState('ses-late');

  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-late',
        sessionID: 'ses-late',
        messageID: 'msg-late',
        type: 'text',
        text: '',
      },
    },
  }), 1);

  state = applyPayload(state, JSON.stringify({
    type: 'message.part.delta',
    properties: {
      sessionID: 'ses-late',
      messageID: 'msg-late',
      partID: 'prt-late',
      field: 'text',
      delta: 'late text',
    },
  }), 2);

  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-late',
        sessionID: 'ses-late',
        messageID: 'msg-late',
        type: 'text',
        text: 'late text final',
      },
    },
  }), 3);

  assert.equal(state.messages.byId['msg-late'].role, 'assistant');
  assert.equal(state.render.latestAssistantMessageId, 'msg-late');
  assert.equal(state.render.latestAssistantPartId, 'prt-late');
  assert.deepEqual(state.render.latestAssistantTailMaterializeHint, {
    messageId: 'msg-late',
    partId: 'prt-late',
    reason: 'text_part_updated_after_delta',
  });
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

test('opencode render state keeps latest reasoning from newer reasoning-only assistant message', () => {
  let state = createRenderState('ses-r2');

  state = applyPayload(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-text',
        sessionID: 'ses-r2',
        role: 'assistant',
        time: { created: 1 },
      },
    },
  }), 1);

  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-text',
        sessionID: 'ses-r2',
        messageID: 'msg-text',
        type: 'text',
        text: 'visible answer',
      },
    },
  }), 2);

  state = applyPayload(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-reasoning',
        sessionID: 'ses-r2',
        role: 'assistant',
        time: { created: 3 },
      },
    },
  }), 3);

  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-reasoning',
        sessionID: 'ses-r2',
        messageID: 'msg-reasoning',
        type: 'reasoning',
        text: 'new reasoning preview',
      },
    },
  }), 4);

  assert.equal(state.render.latestAssistantMessageId, 'msg-text');
  assert.equal(state.render.latestAssistantText, 'visible answer');
  assert.equal(state.render.latestReasoningText, 'new reasoning preview');
});

test('opencode render state tracks active question prompt and clears it on reply', () => {
  let state = createRenderState('ses-question');

  state = applyPayload(state, JSON.stringify({
    type: 'question.asked',
    properties: {
      id: 'req-question',
      sessionID: 'ses-question',
      questions: [{
        header: 'Need input',
        question: 'Pick the rollout shape',
        options: [
          { label: 'Ship now', description: 'continue immediately' },
          { label: 'Wait', description: 'pause for review' },
        ],
      }],
    },
  }), 1);

  assert.deepEqual(state.session.question, {
    requestId: 'req-question',
    askedSeq: 1,
    questions: [{
      custom: true,
      header: 'Need input',
      question: 'Pick the rollout shape',
      options: [
        { label: 'Ship now', description: 'continue immediately' },
        { label: 'Wait', description: 'pause for review' },
      ],
      multiple: false,
    }],
  });

  state = applyPayload(state, JSON.stringify({
    type: 'question.replied',
    properties: {
      requestID: 'req-question',
      sessionID: 'ses-question',
    },
  }), 2);

  assert.equal(state.session.question, null);
});
