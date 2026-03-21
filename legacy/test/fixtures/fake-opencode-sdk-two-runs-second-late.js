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
          id: 'part-first',
          sessionID: sessionId,
          messageID: 'msg-first',
          type: 'text',
          text: `first-immediate-answer\nprompt:${promptText}`,
        },
      },
    });
    queue.push({ type: 'session.idle', properties: { sessionID: sessionId } });
  }

  function emitSecondRunLate(sessionId, promptText) {
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
    queue.push({ type: 'session.idle', properties: { sessionID: sessionId } });

    setTimeout(() => {
      queue.push({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-second',
            sessionID: sessionId,
            messageID: 'msg-second',
            type: 'text',
            text: `second-late-answer\nprompt:${promptText}`,
          },
        },
      });
    }, 900);
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
          const id = parent || 'sdk-two-runs-second-late';
          sessions.add(id);
          return { data: { id }, error: undefined };
        },
        async promptAsync(options) {
          const path = (options || {}).path || {};
          const body = (options || {}).body || {};
          const id = String(path.id || 'sdk-two-runs-second-late');
          const textPart = Array.isArray(body.parts)
            ? body.parts.find((x) => x && x.type === 'text')
            : null;
          const promptText = String((textPart && textPart.text) || '');

          const count = Number(promptCountsBySession.get(id) || 0) + 1;
          promptCountsBySession.set(id, count);

          if (count === 1) {
            emitFirstRun(id, promptText);
          } else {
            emitSecondRunLate(id, promptText);
          }

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
