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

  function emitRun(sessionId, promptText, count) {
    const messageId = `msg-${count}`;
    const partId = `part-${count}`;
    const responseText = count === 1
      ? `first-answer-only\nprompt:${promptText}`
      : `second-answer-only\nprompt:${promptText}`;

    queue.push({
      type: 'session.status',
      properties: { sessionID: sessionId, status: { type: 'busy' } },
    });

    queue.push({
      type: 'message.updated',
      properties: {
        info: {
          id: messageId,
          sessionID: sessionId,
          role: 'assistant',
          time: { created: Date.now(), completed: Date.now() + 10 },
        },
      },
    });

    queue.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: partId,
          sessionID: sessionId,
          messageID: messageId,
          type: 'text',
          text: responseText,
          index: 1,
        },
      },
    });

    queue.push({ type: 'session.idle', properties: { sessionID: sessionId } });
  }

  return {
    server: {
      url: 'http://127.0.0.1:43102',
      close() {
        queue.close();
      },
    },
    client: {
      session: {
        async get(options) {
          const id = String((options && options.sessionID) || (((options || {}).path || {}).id) || '');
          if (!sessions.has(id)) return { data: undefined, error: { message: 'not found' } };
          return { data: { id }, error: undefined };
        },
        async create(options) {
          const body = (options || {}).body || {};
          const parts = Array.isArray(options && options.parts) ? options.parts : body.parts;
          const parent = String((options && options.parentID) || body.parentID || '').trim();
          const id = parent || 'sdk-two-runs-session';
          sessions.add(id);
          return { data: { id }, error: undefined };
        },
        async promptAsync(options) {
                    const body = (options || {}).body || {};
          const parts = Array.isArray(options && options.parts) ? options.parts : body.parts;
          const id = String((options && options.sessionID) || (((options || {}).path || {}).id) || 'sdk-two-runs-session');
          const textPart = Array.isArray(parts)
            ? parts.find((x) => x && x.type === 'text')
            : null;
          const promptText = String((textPart && textPart.text) || '');

          const current = Number(promptCountsBySession.get(id) || 0) + 1;
          promptCountsBySession.set(id, current);

          emitRun(id, promptText, current);

          if (current === 1) {
            await new Promise((resolve) => setTimeout(resolve, 150));
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
