'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRenderState, applyEvent } = require('../src/providers/upstream/opencode/render-state');
const { buildRunViewFromRenderState } = require('../src/providers/upstream/opencode/view-builder');

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

  const view = buildRunViewFromRenderState(state, { runId: 'run-123', repoName: 'my-repo' });
  assert.equal(view.length >= 2, true);
  // Normal mode format: emoji-based compact status
  const statusLines = String(view[0]).split('\n');
  assert.match(statusLines[0], /📂\s+my-repo\s+🔴\s+busy\s+👣\s+0\s+🛠️\s+0/);
  assert.equal(statusLines[1], '`ses-a`');
  assert.equal(view[1], 'hello');
});

test('opencode view builder shows queued prompt count in status pane when queue is non-empty', () => {
  let state = createRenderState('ses-q');

  state = applyEvent(state, {
    type: 'session.status',
    properties: { sessionID: 'ses-q', status: { type: 'busy' } },
  }, 1);

  const normalView = buildRunViewFromRenderState(state, {
    repoName: 'my-repo',
    queueLength: 3,
  });
  const normalLines = String(normalView[0]).split('\n');
  assert.match(normalLines[0], /📂\s+my-repo\s+🔴\s+busy\s+👣\s+0\s+🛠️\s+0\s+🔜 3/);
  assert.equal(normalLines[1], '`ses-q`');

  const verboseView = buildRunViewFromRenderState(state, {
    runId: 'run-q',
    viewMode: 'verbose',
    queueLength: 3,
  });
  assert.match(verboseView[0], /🔜\s*`3`/);
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

  const view = buildRunViewFromRenderState(state);
  assert.equal(view[1], 'old answer');
  assert.equal(view[2], 'latest answer');
  assert.equal(view.includes('user prompt'), false);
});

test('opencode view builder filters older assistant body while keeping status pane for newer run start', () => {
  let state = createRenderState('ses-filter');

  state = applyEvent(state, {
    type: 'session.status',
    properties: { sessionID: 'ses-filter', status: { type: 'busy' } },
  }, 1);

  state = applyEvent(state, {
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-old',
        sessionID: 'ses-filter',
        role: 'assistant',
        time: { created: 10, completed: 11 },
      },
    },
  }, 2);

  state = applyEvent(state, {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-old',
        sessionID: 'ses-filter',
        messageID: 'msg-old',
        type: 'text',
        text: 'old answer should be hidden',
      },
    },
  }, 3);

  const view = buildRunViewFromRenderState(state, {
    runId: 'run-new',
    repoName: 'demo',
    minMessageTimeMs: 100,
  });

  assert.equal(view.length, 1);
  const statusLines = String(view[0]).split('\n');
  assert.match(statusLines[0], /📂\s+demo\s+🔴\s+busy\s+👣\s+0\s+🛠️\s+0/);
  assert.equal(statusLines[1], '`ses-filter`');
  assert.doesNotMatch(String(view[0]), /old answer should be hidden/);
});

test('opencode view builder shows continuity warning for reused session runs', () => {
  let state = createRenderState('ses-reuse');

  state = applyEvent(state, {
    type: 'session.status',
    properties: { sessionID: 'ses-reuse', status: { type: 'busy' } },
  }, 1);

  const view = buildRunViewFromRenderState(state, {
    repoName: 'demo',
    continuityWarning: {
      kind: 'reused_session',
      priorSessionId: 'ses-reuse',
      sessionId: 'ses-reuse',
    },
  });

  const statusLines = String(view[0]).split('\n');
  assert.equal(statusLines[2], '⚠️ continuing an earlier session: hidden prior context may still affect this answer');
});

test('opencode view builder shows compaction warning from render state', () => {
  let state = createRenderState('ses-compact');

  state = applyEvent(state, {
    type: 'session.status',
    properties: { sessionID: 'ses-compact', status: { type: 'busy' } },
  }, 1);
  state = applyEvent(state, {
    type: 'session.compacted',
    properties: { sessionID: 'ses-compact' },
  }, 2);

  const view = buildRunViewFromRenderState(state, {
    repoName: 'demo',
  });

  const statusLines = String(view[0]).split('\n');
  assert.equal(statusLines[2], '⚠️ earlier turns were compacted: the model may remember a summary that is not shown verbatim here');
});

test('opencode view builder strips internal orchestration artifacts from assistant transcript blocks', () => {
  let state = createRenderState('ses-internal');

  state = applyEvent(state, {
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-internal',
        sessionID: 'ses-internal',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }, 1);

  state = applyEvent(state, {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-internal',
        sessionID: 'ses-internal',
        messageID: 'msg-internal',
        type: 'text',
        text: [
          '<!-- OMO_INTERNAL_INITIATOR -->',
          '',
          '[BACKGROUND TASK COMPLETED]',
          '',
          'The current immediate goal at the time of compaction was to fix the chart.',
          '',
          '## Discoveries',
          '- first',
          '',
          'next agent should check git status',
        ].join('\n'),
      },
    },
  }, 2);

  const view = buildRunViewFromRenderState(state, { repoName: 'demo' });
  assert.equal(view.length, 1);
  assert.equal(String(view[0]).includes('BACKGROUND TASK COMPLETED'), false);
  assert.equal(String(view[0]).includes('The current immediate goal at the time of compaction'), false);
});

test('opencode view builder shows processing status while delegated tool work remains active', () => {
  let state = createRenderState('ses-tool-busy');

  state = applyEvent(state, {
    type: 'session.idle',
    properties: { sessionID: 'ses-tool-busy' },
  }, 1);
  state = applyEvent(state, {
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-tool-busy',
        sessionID: 'ses-tool-busy',
        role: 'assistant',
        time: { created: 2 },
      },
    },
  }, 2);
  state = applyEvent(state, {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-tool-busy',
        sessionID: 'ses-tool-busy',
        messageID: 'msg-tool-busy',
        type: 'tool',
        tool: 'task',
        state: { status: 'running' },
      },
    },
  }, 3);

  const view = buildRunViewFromRenderState(state, {
    repoName: 'demo',
  });

  const statusLines = String(view[0]).split('\n');
  assert.match(statusLines[0], /📂\s+demo\s+🟡\s+processing/);
  assert.match(statusLines[0], /🧩 1/);
});

test('opencode view builder verbose mode shows detailed status', () => {
  let state = createRenderState('ses-a');

  state = applyEvent(state, {
    type: 'session.status',
    properties: { sessionID: 'ses-a', status: { type: 'busy' } },
  }, 1);

  const view = buildRunViewFromRenderState(state, {
    runId: 'run-123',
    viewMode: 'verbose',
  });

  assert.equal(view.length >= 1, true);
  // Verbose mode format: detailed text status
  assert.match(view[0], /run_id:\s*`run-123`/i);
  assert.match(view[0], /session:\s*`ses-a`/i);
  assert.match(view[0], /status:\s*`busy`/i);
});

test('opencode view builder shows reasoning at the bottom of the status pane', () => {
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

  const normalView = buildRunViewFromRenderState(state, { repoName: 'my-repo' });
  const normalLines = String(normalView[0]).split('\n');
  assert.equal(normalLines[2], '🤔 thinking through edge cases');

  const verboseView = buildRunViewFromRenderState(state, {
    runId: 'run-123',
    viewMode: 'verbose',
  });
  const verboseLines = String(verboseView[0]).split('\n');
  assert.equal(verboseLines[verboseLines.length - 1], '🤔 reasoning: `thinking through edge cases`');
});

test('opencode view builder verbose mode does not truncate reasoning preview', () => {
  let state = createRenderState('ses-a');
  const longReasoning = 'long-reasoning-'.repeat(12);

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
        id: 'prt-r-long',
        sessionID: 'ses-a',
        messageID: 'msg-a',
        type: 'reasoning',
        text: longReasoning,
      },
    },
  }, 3);

  const verboseView = buildRunViewFromRenderState(state, {
    runId: 'run-123',
    viewMode: 'verbose',
  });

  assert.match(verboseView[0], new RegExp(`reasoning:\\s*\`${longReasoning}\``));
  assert.equal(verboseView[0].includes('...'), false);
});

test('opencode view builder updates normal status pane when reasoning changes', () => {
  let state = createRenderState('ses-r-change');

  state = applyEvent(state, {
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-a',
        sessionID: 'ses-r-change',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }, 1);

  state = applyEvent(state, {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-r',
        sessionID: 'ses-r-change',
        messageID: 'msg-a',
        type: 'reasoning',
        text: 'first reasoning',
      },
    },
  }, 2);

  const firstView = buildRunViewFromRenderState(state, { repoName: 'my-repo' });
  assert.equal(String(firstView[0]).split('\n')[2], '🤔 first reasoning');

  state = applyEvent(state, {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-r',
        sessionID: 'ses-r-change',
        messageID: 'msg-a',
        type: 'reasoning',
        text: 'second reasoning',
      },
    },
  }, 3);

  const secondView = buildRunViewFromRenderState(state, { repoName: 'my-repo' });
  assert.equal(String(secondView[0]).split('\n')[2], '🤔 second reasoning');
});

test('opencode view builder normal mode does not truncate reasoning preview', () => {
  let state = createRenderState('ses-r-full');
  const longReasoning = 'long-reasoning-'.repeat(12);

  state = applyEvent(state, {
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-a',
        sessionID: 'ses-r-full',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }, 1);

  state = applyEvent(state, {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-r-long-normal',
        sessionID: 'ses-r-full',
        messageID: 'msg-a',
        type: 'reasoning',
        text: longReasoning,
      },
    },
  }, 2);

  const normalView = buildRunViewFromRenderState(state, { repoName: 'my-repo' });
  const normalLines = String(normalView[0]).split('\n');
  assert.equal(normalLines[2], `🤔 ${longReasoning}`);
  assert.equal(normalView[0].includes('...'), false);
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

  const view = buildRunViewFromRenderState(state, { repoName: 'test-repo' });
  assert.equal(view.length >= 1, true);
  // Check counters are shown
  assert.match(view[0], /👣\s+1/); // 1 step
  assert.match(view[0], /🛠️\s+1/); // 1 tool
});

test('opencode view builder keeps assistant content as logical blocks without upstream size chunking', () => {
  let state = createRenderState('ses-long');

  state = applyEvent(state, {
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-long',
        sessionID: 'ses-long',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }, 1);

  state = applyEvent(state, {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-long',
        sessionID: 'ses-long',
        messageID: 'msg-long',
        type: 'text',
        text: 'abcdefghij',
      },
    },
  }, 2);

  const view = buildRunViewFromRenderState(state, { repoName: 'my-repo' });
  assert.equal(view.length, 2);
  assert.equal(view[1], 'abcdefghij');
});
