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

  const view = buildRunViewFromRenderState(state, splitByLimit, 4000, { runId: 'run-123', repoName: 'my-repo' });
  assert.equal(view.length >= 2, true);
  // Normal mode format: emoji-based compact status
  assert.match(view[0], /✅\s+my-repo/);
  assert.match(view[0], /💬\s*`ses-a`/);
  assert.match(view[0], /🔴.*busy/);
  assert.equal(view[1], 'hello');
});

test('opencode view builder includes all assistant messages in order', () => {
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
  assert.equal(view[1], 'old answer');
  assert.equal(view[2], 'latest answer');
  assert.equal(view.includes('user prompt'), false);
});

test('opencode view builder verbose mode shows detailed status', () => {
  let state = createRenderState('ses-a');

  state = applyEvent(state, {
    type: 'session.status',
    properties: { sessionID: 'ses-a', status: { type: 'busy' } },
  }, 1);

  const view = buildRunViewFromRenderState(state, splitByLimit, 4000, {
    runId: 'run-123',
    viewMode: 'verbose',
  });

  assert.equal(view.length >= 1, true);
  // Verbose mode format: detailed text status
  assert.match(view[0], /run_id:\s*`run-123`/i);
  assert.match(view[0], /session:\s*`ses-a`/i);
  assert.match(view[0], /status:\s*`busy`/i);
});

test('opencode view builder includes latest reasoning in status pane', () => {
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
        id: 'prt-r',
        sessionID: 'ses-a',
        messageID: 'msg-a',
        type: 'reasoning',
        text: 'thinking through edge cases',
      },
    },
  }, 3);

  const normalView = buildRunViewFromRenderState(state, splitByLimit, 4000, { repoName: 'my-repo' });
  assert.match(normalView[0], /🤔\s+thinking through edge cases/);

  const verboseView = buildRunViewFromRenderState(state, splitByLimit, 4000, {
    runId: 'run-123',
    viewMode: 'verbose',
  });
  assert.match(verboseView[0], /reasoning:\s*`thinking through edge cases`/i);
});

test('opencode view builder step and tool counters', () => {
  let state = createRenderState('ses-a');

  // Simulate step-start
  state = applyEvent(state, {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-step-start',
        sessionID: 'ses-a',
        messageID: 'msg-1',
        type: 'step-start',
      },
    },
  }, 1);

  // Simulate tool call
  state = applyEvent(state, {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-tool',
        sessionID: 'ses-a',
        messageID: 'msg-1',
        type: 'tool',
        tool: 'test_tool',
      },
    },
  }, 2);

  const view = buildRunViewFromRenderState(state, splitByLimit, 4000, { repoName: 'test-repo' });
  assert.equal(view.length >= 1, true);
  // Check counters are shown
  assert.match(view[0], /👣1/); // 1 step
  assert.match(view[0], /🛠️1/); // 1 tool
});
