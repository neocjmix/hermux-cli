#!/usr/bin/env node
'use strict';

function createQueue() {
  const values = [];
  const waiters = [];
  let closed = false;

  function push(value) {
    if (closed) return;
    if (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve({ value, done: false });
      return;
    }
    values.push(value);
  }

  function close() {
    closed = true;
    while (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve({ value: undefined, done: true });
    }
  }

  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (values.length > 0) {
            const value = values.shift();
            return Promise.resolve({ value, done: false });
          }
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };

  return { push, close, stream };
}

async function createOpencode() {
  const queue = createQueue();
  const sessions = new Set();
  const promptCountsBySession = new Map();

  function schedule(delayMs, fn) {
    setTimeout(fn, delayMs);
  }

  function emitFirstRun(sessionId, promptText) {
    queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
    queue.push({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-first',
          sessionID: sessionId,
          role: 'assistant',
          time: { created: Date.now(), completed: Date.now() + 1 },
        },
      },
    });
    queue.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-first-text',
          sessionID: sessionId,
          messageID: 'msg-first',
          type: 'text',
          text: `first-ok\nprompt:${promptText}`,
        },
      },
    });
    queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
    queue.push({ type: 'session.idle', properties: { sessionID: sessionId } });
  }

  function emitSecondRunPostCompleteLateText(sessionId, promptText) {
    queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
    queue.push({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-second',
          sessionID: sessionId,
          role: 'assistant',
          time: { created: Date.now(), completed: Date.now() + 1 },
        },
      },
    });
    queue.push({ type: 'session.diff', properties: { sessionID: sessionId, diff: [] } });
    queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
    queue.push({ type: 'session.idle', properties: { sessionID: sessionId } });

    schedule(1900, () => {
      queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
      queue.push({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-second-step-start',
            sessionID: sessionId,
            messageID: 'msg-second',
            type: 'step-start',
          },
        },
      });
      queue.push({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-second-text',
            sessionID: sessionId,
            messageID: 'msg-second',
            type: 'text',
            text: '',
          },
        },
      });
      queue.push({
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          messageID: 'msg-second',
          partID: 'part-second-text',
          field: 'text',
          delta: `second-post-complete:${promptText}`,
        },
      });
      queue.push({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-second-text',
            sessionID: sessionId,
            messageID: 'msg-second',
            type: 'text',
            text: `second-post-complete:${promptText}`,
          },
        },
      });
      queue.push({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-second-step-finish',
            sessionID: sessionId,
            messageID: 'msg-second',
            type: 'step-finish',
            reason: 'stop',
          },
        },
      });
      queue.push({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-second',
            sessionID: sessionId,
            role: 'assistant',
            finish: 'stop',
            time: { created: Date.now() - 500, completed: Date.now() },
          },
        },
      });
      queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
      queue.push({ type: 'session.idle', properties: { sessionID: sessionId } });
      queue.push({ type: 'session.diff', properties: { sessionID: sessionId, diff: [] } });
    });
  }

  return {
    server: {
      url: 'http://127.0.0.1:43103',
      close() {
        queue.close();
      },
    },
    client: {
      session: {
        async get(options) {
          const id = String(((options || {}).path || {}).id || '');
          if (!sessions.has(id)) return { data: undefined, error: { message: 'not found' } };
          return { data: { id }, error: undefined };
        },
        async create(options) {
          const body = (options || {}).body || {};
          const parent = String(body.parentID || '').trim();
          const id = parent || 'sdk-two-runs-post-complete-late-text';
          sessions.add(id);
          return { data: { id }, error: undefined };
        },
        async promptAsync(options) {
          const path = (options || {}).path || {};
          const body = (options || {}).body || {};
          const id = String(path.id || 'sdk-two-runs-post-complete-late-text');
          const textPart = Array.isArray(body.parts)
            ? body.parts.find((x) => x && x.type === 'text')
            : null;
          const promptText = String((textPart && textPart.text) || '');

          const count = Number(promptCountsBySession.get(id) || 0) + 1;
          promptCountsBySession.set(id, count);

          if (count === 1) emitFirstRun(id, promptText);
          else emitSecondRunPostCompleteLateText(id, promptText);

          return { data: undefined, error: undefined };
        },
        async abort() {
          return { data: true, error: undefined };
        },
      },
      event: {
        async subscribe() {
          return { stream: queue.stream };
        },
      },
    },
  };
}

module.exports = {
  createOpencode,
};
