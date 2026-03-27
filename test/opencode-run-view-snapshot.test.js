'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRunViewSnapshotState,
  applyPayloadToRunViewSnapshot,
  inspectRunViewSnapshotState,
} = require('../src/providers/upstream/opencode/run-view-snapshot');

test('run view snapshot materializer converts raw payload to provider-agnostic snapshot', () => {
  let state = createRunViewSnapshotState('ses-a');

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-a',
        sessionID: 'ses-a',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }), 1, {
    runId: 'run-1',
    minMessageTimeMs: 0,
    isFinal: false,
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-a',
        sessionID: 'ses-a',
        messageID: 'msg-a',
        type: 'text',
        text: 'hello snapshot',
      },
    },
  }), 2, {
    runId: 'run-1',
    minMessageTimeMs: 0,
    isFinal: false,
  });

  assert.equal(state.snapshot.runId, 'run-1');
  assert.equal(state.snapshot.sessionId, 'ses-a');
  assert.equal(Array.isArray(state.snapshot.messages), true);
  // Normal mode format: emoji-based compact status
  const statusLines = String(state.snapshot.messages[0]).split('\n');
  assert.match(statusLines[0], /📂\s+repo\s+🟢\s+idle\s+👣\s+0\s+🛠️\s+0/);
  assert.equal(statusLines[1], '`ses-a`');
  assert.equal(state.snapshot.messages[1], 'hello snapshot');
  assert.equal(state.snapshot.isFinal, false);
});

test('run view snapshot materializer keeps state and applies trailing payload as latest snapshot', () => {
  let state = createRunViewSnapshotState('ses-b');

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-b',
        sessionID: 'ses-b',
        role: 'assistant',
        time: { created: 10, completed: 11 },
      },
    },
  }), 1, {
    runId: 'run-2',
    minMessageTimeMs: 0,
    isFinal: false,
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-b',
        sessionID: 'ses-b',
        messageID: 'msg-b',
        type: 'text',
        text: 'first text',
      },
    },
  }), 2, {
    runId: 'run-2',
    minMessageTimeMs: 0,
    isFinal: false,
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.delta',
    properties: {
      sessionID: 'ses-b',
      messageID: 'msg-b',
      partID: 'part-b',
      field: 'text',
      delta: ' +delta',
    },
  }), 3, {
    runId: 'run-2',
    minMessageTimeMs: 0,
    isFinal: true,
  });

  assert.equal(state.snapshot.isFinal, true);
  assert.equal(state.snapshot.messages[1], 'first text +delta');
});

test('run view snapshot materializer includes queued prompt count in status pane', () => {
  let state = createRunViewSnapshotState('ses-q');

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'session.status',
    properties: {
      sessionID: 'ses-q',
      status: { type: 'busy' },
    },
  }), 1, {
    runId: 'run-q',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-q',
    queueLength: 2,
  });

  const queueLines = String(state.snapshot.messages[0]).split('\n');
  assert.match(queueLines[0], /📂\s+repo-q\s+🔴\s+busy\s+👣\s+0\s+🛠️\s+0\s+🔜 2/);
  assert.equal(queueLines[1], '`ses-q`');
});

test('run view snapshot materializer passes continuity warning into status pane', () => {
  let state = createRunViewSnapshotState('ses-warn');

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'session.status',
    properties: {
      sessionID: 'ses-warn',
      status: { type: 'busy' },
    },
  }), 1, {
    runId: 'run-warn',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-warn',
    continuityWarning: {
      kind: 'forked_session',
      priorSessionId: 'ses-old',
      sessionId: 'ses-warn',
    },
  });

  const statusLines = String(state.snapshot.messages[0]).split('\n');
  assert.equal(statusLines[2], '⚠️ forked session: model context may include earlier turns hidden from this run view');
});

test('run view snapshot materializer keeps logical blocks even when maxLen is smaller than content', () => {
  let state = createRunViewSnapshotState('ses-long');

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-long',
        sessionID: 'ses-long',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }), 1, {
    runId: 'run-long',
    minMessageTimeMs: 0,
    isFinal: false,
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-long',
        sessionID: 'ses-long',
        messageID: 'msg-long',
        type: 'text',
        text: 'abcdefghij',
      },
    },
  }), 2, {
    runId: 'run-long',
    minMessageTimeMs: 0,
    isFinal: false,
  });

  assert.equal(state.snapshot.messages.length, 2);
  assert.equal(state.snapshot.messages[1], 'abcdefghij');
});

test('run view snapshot materializer shows latest reasoning from newer reasoning-only assistant message', () => {
  let state = createRunViewSnapshotState('ses-reasoning');

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-text',
        sessionID: 'ses-reasoning',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }), 1, {
    runId: 'run-reasoning',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-r',
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-text',
        sessionID: 'ses-reasoning',
        messageID: 'msg-text',
        type: 'text',
        text: 'visible answer',
      },
    },
  }), 2, {
    runId: 'run-reasoning',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-r',
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-reasoning',
        sessionID: 'ses-reasoning',
        role: 'assistant',
        time: { created: 11 },
      },
    },
  }), 3, {
    runId: 'run-reasoning',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-r',
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-reasoning',
        sessionID: 'ses-reasoning',
        messageID: 'msg-reasoning',
        type: 'reasoning',
        text: 'new reasoning preview',
      },
    },
  }), 4, {
    runId: 'run-reasoning',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-r',
  });

  const statusLines = String(state.snapshot.messages[0]).split('\n');
  assert.equal(statusLines[2], '🤔 new reasoning preview');
  assert.equal(state.snapshot.messages[1], 'visible answer');
});

test('run view snapshot materializer refreshes status pane when reasoning text changes', () => {
  let state = createRunViewSnapshotState('ses-reasoning-refresh');

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-r',
        sessionID: 'ses-reasoning-refresh',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }), 1, {
    runId: 'run-reasoning-refresh',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-r',
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-r',
        sessionID: 'ses-reasoning-refresh',
        messageID: 'msg-r',
        type: 'reasoning',
        text: 'first reasoning',
      },
    },
  }), 2, {
    runId: 'run-reasoning-refresh',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-r',
  });

  assert.equal(String(state.snapshot.messages[0]).split('\n')[2], '🤔 first reasoning');

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-r',
        sessionID: 'ses-reasoning-refresh',
        messageID: 'msg-r',
        type: 'reasoning',
        text: 'second reasoning',
      },
    },
  }), 3, {
    runId: 'run-reasoning-refresh',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-r',
  });

  assert.equal(String(state.snapshot.messages[0]).split('\n')[2], '🤔 second reasoning');
});

test('run view snapshot materializer promotes text deltas even when part started as empty reasoning', () => {
  let state = createRunViewSnapshotState('ses-retyped');

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-retyped',
        sessionID: 'ses-retyped',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }), 1, {
    runId: 'run-retyped',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-r',
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-retyped',
        sessionID: 'ses-retyped',
        messageID: 'msg-retyped',
        type: 'reasoning',
        text: '',
        metadata: {
          openai: {
            reasoningEncryptedContent: 'enc',
          },
        },
      },
    },
  }), 2, {
    runId: 'run-retyped',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-r',
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.delta',
    properties: {
      sessionID: 'ses-retyped',
      messageID: 'msg-retyped',
      partID: 'part-retyped',
      type: 'text',
      field: 'text',
      delta: 'final text survives',
    },
  }), 3, {
    runId: 'run-retyped',
    minMessageTimeMs: 0,
    isFinal: true,
    repoName: 'repo-r',
  });

  assert.equal(state.snapshot.messages[1], 'final text survives');
});

test('run view snapshot materializer keeps reasoning deltas in status pane when delta type is not text', () => {
  let state = createRunViewSnapshotState('ses-reasoning-delta');

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-reasoning-delta',
        sessionID: 'ses-reasoning-delta',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }), 1, {
    runId: 'run-reasoning-delta',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-r',
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-reasoning-delta',
        sessionID: 'ses-reasoning-delta',
        messageID: 'msg-reasoning-delta',
        type: 'reasoning',
        text: '',
      },
    },
  }), 2, {
    runId: 'run-reasoning-delta',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-r',
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.delta',
    properties: {
      sessionID: 'ses-reasoning-delta',
      messageID: 'msg-reasoning-delta',
      partID: 'part-reasoning-delta',
      field: 'text',
      delta: 'draft reasoning only',
    },
  }), 3, {
    runId: 'run-reasoning-delta',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-r',
  });

  assert.equal(state.snapshot.messages.length, 1);
  assert.equal(String(state.snapshot.messages[0]).split('\n')[2], '🤔 draft reasoning only');
});

test('run view snapshot materializer preserves latest assistant text without message timestamps', () => {
  let state = createRunViewSnapshotState('ses-no-time');

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-no-time',
        sessionID: 'ses-no-time',
        messageID: 'msg-no-time',
        type: 'text',
        text: '',
      },
    },
  }), 1, {
    runId: 'run-no-time',
    minMessageTimeMs: Date.now(),
    isFinal: false,
    repoName: 'repo-r',
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.delta',
    properties: {
      sessionID: 'ses-no-time',
      messageID: 'msg-no-time',
      partID: 'part-no-time',
      field: 'text',
      delta: 'late but valid final text',
    },
  }), 2, {
    runId: 'run-no-time',
    minMessageTimeMs: Date.now(),
    isFinal: true,
    repoName: 'repo-r',
  });

  assert.equal(state.snapshot.messages[1], 'late but valid final text');
});

test('run view snapshot materializer propagates tail materialize hint', () => {
  let state = createRunViewSnapshotState('ses-hint');

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-hint',
        sessionID: 'ses-hint',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }), 1, {
    runId: 'run-hint',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-r',
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-hint',
        sessionID: 'ses-hint',
        messageID: 'msg-hint',
        type: 'text',
        text: '',
      },
    },
  }), 2, {
    runId: 'run-hint',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-r',
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.delta',
    properties: {
      sessionID: 'ses-hint',
      messageID: 'msg-hint',
      partID: 'part-hint',
      field: 'text',
      delta: 'hinted text',
    },
  }), 3, {
    runId: 'run-hint',
    minMessageTimeMs: 0,
    isFinal: true,
    repoName: 'repo-r',
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-hint',
        sessionID: 'ses-hint',
        messageID: 'msg-hint',
        type: 'text',
        text: 'hinted text final',
      },
    },
  }), 4, {
    runId: 'run-hint',
    minMessageTimeMs: 0,
    isFinal: true,
    repoName: 'repo-r',
  });

  assert.deepEqual(state.snapshot.tailMaterializeHint, {
    messageId: 'msg-hint',
    partId: 'part-hint',
    reason: 'text_part_updated_after_delta',
  });
});

test('run view snapshot materializer does not truncate reasoning preview', () => {
  let state = createRunViewSnapshotState('ses-reasoning-full');
  const longReasoning = 'long-reasoning-'.repeat(12);

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-r',
        sessionID: 'ses-reasoning-full',
        role: 'assistant',
        time: { created: 10 },
      },
    },
  }), 1, {
    runId: 'run-reasoning-full',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-r',
  });

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-r',
        sessionID: 'ses-reasoning-full',
        messageID: 'msg-r',
        type: 'reasoning',
        text: longReasoning,
      },
    },
  }), 2, {
    runId: 'run-reasoning-full',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-r',
  });

  const statusLines = String(state.snapshot.messages[0]).split('\n');
  assert.equal(statusLines[2], `🤔 ${longReasoning}`);
  assert.equal(state.snapshot.messages[0].includes('...'), false);
});

test('run view snapshot materializer renders active question prompts in the status pane', () => {
  let state = createRunViewSnapshotState('ses-question');

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'question.asked',
    properties: {
      id: 'req-question',
      sessionID: 'ses-question',
      questions: [{
        header: 'Need input',
        question: 'How should I continue?',
        options: [
          { label: 'Ship now', description: 'continue immediately' },
          { label: 'Wait', description: 'pause for review' },
        ],
      }],
    },
  }), 1, {
    runId: 'run-question',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-q',
  });

  const statusLines = String(state.snapshot.messages[0]).split('\n');
  assert.equal(statusLines[2], '❓ Need input');
  assert.equal(statusLines[3], 'How should I continue?');
  assert.equal(statusLines[4], '1. Ship now - continue immediately');
  assert.equal(statusLines[5], '2. Wait - pause for review');
  assert.equal(state.snapshot.messages.length, 1);
});

test('run view snapshot materializer renders active permission prompts in the status pane', () => {
  let state = createRunViewSnapshotState('ses-perm');

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'permission.asked',
    properties: {
      id: 'perm-1',
      sessionID: 'ses-perm',
      permission: 'bash',
      patterns: ['*'],
      always: ['skill_mcp'],
    },
  }), 1, {
    runId: 'run-perm',
    minMessageTimeMs: 0,
    isFinal: false,
    repoName: 'repo-p',
  });

  const statusLines = String(state.snapshot.messages[0]).split('\n');
  assert.equal(statusLines[2], '🔐 bash');
  assert.equal(statusLines[3], 'patterns: *');
  assert.equal(statusLines[4], 'always: skill_mcp');
  assert.equal(state.snapshot.messages.length, 1);
});

test('run view snapshot materializer removes deleted messages from visible output', () => {
  let state = createRunViewSnapshotState('ses-remove');

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.updated',
    properties: { info: { id: 'msg-rm', sessionID: 'ses-remove', role: 'assistant', time: { created: 1 } } },
  }), 1, { runId: 'run-remove', minMessageTimeMs: 0, isFinal: false, repoName: 'repo-rm' });
  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: { part: { id: 'prt-rm', sessionID: 'ses-remove', messageID: 'msg-rm', type: 'text', text: 'to be removed' } },
  }), 2, { runId: 'run-remove', minMessageTimeMs: 0, isFinal: false, repoName: 'repo-rm' });
  assert.equal(state.snapshot.messages[1], 'to be removed');

  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.removed',
    properties: { sessionID: 'ses-remove', messageID: 'msg-rm' },
  }), 3, { runId: 'run-remove', minMessageTimeMs: 0, isFinal: false, repoName: 'repo-rm' });

  assert.equal(state.snapshot.messages.length, 1);
});

test('run view snapshot materializer reflects deleted session status', () => {
  let state = createRunViewSnapshotState('ses-del');
  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'session.deleted',
    properties: { info: { id: 'ses-del', title: 'gone' } },
  }), 1, { runId: 'run-del', minMessageTimeMs: 0, isFinal: false, repoName: 'repo-del' });

  const statusLines = String(state.snapshot.messages[0]).split('\n');
  assert.match(statusLines[0], /deleted/);
});

test('run view snapshot inspector exposes provider-agnostic metadata for gateway', () => {
  let state = createRunViewSnapshotState('ses-meta');
  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'permission.asked',
    properties: { id: 'perm-1', sessionID: 'ses-meta', permission: 'bash', patterns: ['src/**'] },
  }), 1, { runId: 'run-meta', minMessageTimeMs: 0, isFinal: false, repoName: 'repo-meta' });
  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.updated',
    properties: { info: { id: 'msg-meta', sessionID: 'ses-meta', role: 'assistant', time: { created: 1 } } },
  }), 2, { runId: 'run-meta', minMessageTimeMs: 0, isFinal: false, repoName: 'repo-meta' });
  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: { part: { id: 'prt-meta', sessionID: 'ses-meta', messageID: 'msg-meta', type: 'text', text: 'hello' } },
  }), 3, { runId: 'run-meta', minMessageTimeMs: 0, isFinal: false, repoName: 'repo-meta' });

  const meta = inspectRunViewSnapshotState(state);
  assert.equal(meta.latestAssistantMessageId, 'msg-meta');
  assert.equal(meta.latestAssistantPartId, 'prt-meta');
  assert.equal(meta.latestAssistantText, 'hello');
  assert.equal(meta.activePermission.permission, 'bash');
  assert.deepEqual(meta.snapshotMessages, state.snapshot.messages);
});

test('run view snapshot inspector counts active background tool parts', () => {
  let state = createRunViewSnapshotState('ses-bg');
  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.updated',
    properties: { info: { id: 'msg-bg', sessionID: 'ses-bg', role: 'assistant', time: { created: 1 } } },
  }), 1, { runId: 'run-bg', minMessageTimeMs: 0, isFinal: false, repoName: 'repo-bg' });
  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-bg-1',
        sessionID: 'ses-bg',
        messageID: 'msg-bg',
        type: 'tool',
        tool: 'task',
        state: { status: 'running' },
      },
    },
  }), 2, { runId: 'run-bg', minMessageTimeMs: 0, isFinal: false, repoName: 'repo-bg' });
  state = applyPayloadToRunViewSnapshot(state, JSON.stringify({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-bg-2',
        sessionID: 'ses-bg',
        messageID: 'msg-bg',
        type: 'tool',
        tool: 'task',
        state: { status: 'queued' },
      },
    },
  }), 3, { runId: 'run-bg', minMessageTimeMs: 0, isFinal: false, repoName: 'repo-bg' });

  const meta = inspectRunViewSnapshotState(state);
  assert.equal(meta.backgroundAttached, true);
  assert.equal(meta.backgroundTaskCount, 2);
});
