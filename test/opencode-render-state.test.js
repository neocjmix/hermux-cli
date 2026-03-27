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

test('opencode render state stays busy while delegated task tool is still running', () => {
  let state = createRenderState('ses-task');

  state = applyPayload(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-task',
        sessionID: 'ses-task',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }), 1);

  state = applyPayload(state, JSON.stringify({
    type: 'session.idle',
    properties: { sessionID: 'ses-task' },
  }), 2);

  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-task',
        sessionID: 'ses-task',
        messageID: 'msg-task',
        type: 'tool',
        tool: 'task',
        state: {
          status: 'running',
          input: { description: 'delegated task' },
        },
      },
    },
  }), 3);

  assert.equal(state.session.status, 'idle');
  assert.equal(state.render.busy, true);

  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-task',
        sessionID: 'ses-task',
        messageID: 'msg-task',
        type: 'tool',
        tool: 'task',
        state: {
          status: 'starting',
        },
      },
    },
  }), 4);

  assert.equal(state.render.busy, true);

  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-task',
        sessionID: 'ses-task',
        messageID: 'msg-task',
        type: 'tool',
        tool: 'task',
        state: {
          status: 'completed',
          output: 'done',
        },
      },
    },
  }), 5);

  assert.equal(state.render.busy, false);
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

test('opencode render state tracks permission prompt and clears it on reply', () => {
  let state = createRenderState('ses-perm');

  state = applyPayload(state, JSON.stringify({
    type: 'permission.asked',
    properties: {
      id: 'perm-1',
      sessionID: 'ses-perm',
      permission: 'bash',
      patterns: ['*'],
      always: ['skill_mcp'],
      tool: { messageID: 'msg-tool', callID: 'call-tool' },
    },
  }), 1);

  assert.deepEqual(state.session.permission, {
    requestId: 'perm-1',
    permission: 'bash',
    patterns: ['*'],
    always: ['skill_mcp'],
    metadata: {},
    tool: { messageId: 'msg-tool', callId: 'call-tool' },
  });

  state = applyPayload(state, JSON.stringify({
    type: 'permission.replied',
    properties: {
      sessionID: 'ses-perm',
      requestID: 'perm-1',
      reply: 'once',
    },
  }), 2);

  assert.equal(state.session.permission, null);
});

test('opencode render state removes messages and parts', () => {
  let state = createRenderState('ses-rm');
  state = applyPayload(state, JSON.stringify({
    type: 'message.updated',
    properties: { info: { id: 'msg-rm', sessionID: 'ses-rm', role: 'assistant', time: { created: 1 } } },
  }), 1);
  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: { part: { id: 'prt-rm', sessionID: 'ses-rm', messageID: 'msg-rm', type: 'text', text: 'hello' } },
  }), 2);
  state = applyPayload(state, JSON.stringify({
    type: 'message.part.removed',
    properties: { sessionID: 'ses-rm', messageID: 'msg-rm', partID: 'prt-rm' },
  }), 3);
  assert.equal(state.messages.byId['msg-rm'].renderText, '');

  state = applyPayload(state, JSON.stringify({
    type: 'message.removed',
    properties: { sessionID: 'ses-rm', messageID: 'msg-rm' },
  }), 4);
  assert.equal(state.messages.byId['msg-rm'], undefined);
  assert.deepEqual(state.messages.order, []);
});

test('opencode render state handles session lifecycle and extra part subtypes', () => {
  let state = createRenderState('ses-life');
  state = applyPayload(state, JSON.stringify({
    type: 'session.created',
    properties: { info: { id: 'ses-life', title: 'demo', directory: '/tmp/demo' } },
  }), 1);
  state = applyPayload(state, JSON.stringify({
    type: 'message.updated',
    properties: { info: { id: 'msg-life', sessionID: 'ses-life', role: 'assistant', time: { created: 2 } } },
  }), 2);
  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: { part: { id: 'prt-sub', sessionID: 'ses-life', messageID: 'msg-life', type: 'subtask', description: 'Inspect state', prompt: 'inspect', agent: 'metis' } },
  }), 3);
  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: { part: { id: 'prt-patch', sessionID: 'ses-life', messageID: 'msg-life', type: 'patch', hash: 'abc', files: ['a.js', 'b.js'] } },
  }), 4);
  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: { part: { id: 'prt-agent', sessionID: 'ses-life', messageID: 'msg-life', type: 'agent', name: 'oracle', source: { value: 'handoff.md', start: 4, end: 12 } } },
  }), 4.1);
  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: { part: { id: 'prt-retry', sessionID: 'ses-life', messageID: 'msg-life', type: 'retry', attempt: 2, error: { name: 'ApiError', message: 'rate limited' }, time: { created: 123 } } },
  }), 4.2);
  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: { part: { id: 'prt-compact', sessionID: 'ses-life', messageID: 'msg-life', type: 'compaction', auto: false, overflow: true } },
  }), 4.3);
  state = applyPayload(state, JSON.stringify({
    type: 'message.part.updated',
    properties: { part: { id: 'prt-snap', sessionID: 'ses-life', messageID: 'msg-life', type: 'snapshot', snapshot: 'snap-123' } },
  }), 4.4);
  state = applyPayload(state, JSON.stringify({
    type: 'session.compacted',
    properties: { sessionID: 'ses-life' },
  }), 5);
  state = applyPayload(state, JSON.stringify({
    type: 'session.deleted',
    properties: { info: { id: 'ses-life', title: 'demo' } },
  }), 6);

  assert.match(state.messages.byId['msg-life'].renderText, /🧩 Subtask: Inspect state · `metis`/);
  assert.match(state.messages.byId['msg-life'].renderText, /🩹 Patch: 2 files/);
  assert.match(state.messages.byId['msg-life'].renderText, /- `a\.js`/);
  assert.match(state.messages.byId['msg-life'].renderText, /- `b\.js`/);
  assert.match(state.messages.byId['msg-life'].renderText, /🤖 Agent: `oracle` — `handoff\.md` \[4:12\]/);
  assert.match(state.messages.byId['msg-life'].renderText, /🔁 Retry 2: `ApiError` · rate limited · `123`/);
  assert.match(state.messages.byId['msg-life'].renderText, /🗜️ Compaction: `manual` · overflow/);
  assert.match(state.messages.byId['msg-life'].renderText, /📸 Snapshot: `snap-123`/);
  assert.ok(state.session.compactedAt > 0);
  assert.ok(state.session.deletedAt > 0);
  assert.equal(state.session.status, 'deleted');
});
