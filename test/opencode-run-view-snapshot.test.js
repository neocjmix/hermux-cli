'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRunViewSnapshotState,
  applyPayloadToRunViewSnapshot,
} = require('../src/providers/upstream/opencode/run-view-snapshot');

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
    splitByLimit,
    maxLen: 4000,
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
    splitByLimit,
    maxLen: 4000,
    runId: 'run-1',
    minMessageTimeMs: 0,
    isFinal: false,
  });

  assert.equal(state.snapshot.runId, 'run-1');
  assert.equal(state.snapshot.sessionId, 'ses-a');
  assert.equal(Array.isArray(state.snapshot.messages), true);
  assert.match(state.snapshot.messages[0], /Status Pane/);
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
    splitByLimit,
    maxLen: 4000,
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
    splitByLimit,
    maxLen: 4000,
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
    splitByLimit,
    maxLen: 4000,
    runId: 'run-2',
    minMessageTimeMs: 0,
    isFinal: true,
  });

  assert.equal(state.snapshot.isFinal, true);
  assert.equal(state.snapshot.messages[1], 'first text +delta');
});
