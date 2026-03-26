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

  function emitRun(sessionId) {
    const messageId = 'msg-delta-dup';
    const partId = 'part-delta-dup';

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
          text: '',
          index: 1,
        },
      },
    });

    for (const delta of ['a', 'b', 'c']) {
      queue.push({
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          messageID: messageId,
          partID: partId,
          field: 'text',
          delta,
        },
      });
    }

    queue.push({ type: 'session.idle', properties: { sessionID: sessionId } });
  }

  return {
    server: {
      url: 'http://127.0.0.1:43112',
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
          const parent = String((options && options.parentID) || body.parentID || '').trim();
          const id = parent || 'sdk-duplicate-delta-session';
          sessions.add(id);
          return { data: { id }, error: undefined };
        },
        async promptAsync(options) {
                    const id = String((options && options.sessionID) || (((options || {}).path || {}).id) || 'sdk-duplicate-delta-session');
          emitRun(id);
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
