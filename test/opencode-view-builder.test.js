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

test('opencode view builder emits status pane first and text vectors after', () => {
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

  const view = buildRunViewFromRenderState(state, splitByLimit, 4000);
  assert.equal(view.length >= 2, true);

  const first = JSON.parse(view[0]);
  assert.equal(first.kind, 'status-pane');

  const second = JSON.parse(view[1]);
  assert.equal(second.kind, 'text-vector');
  assert.equal(second.partId, 'prt-text');
  assert.equal(second.textChunk, 'hello');

  const hasStepPart = view.some((line) => {
    const parsed = JSON.parse(line);
    return parsed.partId === 'prt-step';
  });
  assert.equal(hasStepPart, false);
});
