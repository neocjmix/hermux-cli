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

  function schedule(delayMs, fn) {
    setTimeout(fn, delayMs);
  }

  function emitRun(sessionId) {
    const now = Date.now();
    queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });

    queue.push({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-old-completed',
          sessionID: sessionId,
          role: 'assistant',
          time: { created: now + 10, completed: now + 20 },
          finish: 'stop',
        },
      },
    });
    queue.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-old-text',
          sessionID: sessionId,
          messageID: 'msg-old-completed',
          type: 'text',
          text: 'old-completed-answer',
        },
      },
    });

    queue.push({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-new-inprogress',
          sessionID: sessionId,
          role: 'assistant',
          time: { created: now + 100 },
        },
      },
    });
    queue.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-new-text',
          sessionID: sessionId,
          messageID: 'msg-new-inprogress',
          type: 'text',
          text: '',
        },
      },
    });

    schedule(150, () => {
      queue.push({
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          messageID: 'msg-new-inprogress',
          partID: 'part-new-text',
          field: 'text',
          delta: 'new-live-marker',
        },
      });
    });

    schedule(500, () => {
      queue.push({
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          messageID: 'msg-new-inprogress',
          partID: 'part-new-text',
          field: 'text',
          delta: ' plus-tail',
        },
      });
    });

    schedule(1200, () => {
      queue.push({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-new-inprogress',
            sessionID: sessionId,
            role: 'assistant',
            time: { created: now + 100, completed: Date.now() },
            finish: 'stop',
          },
        },
      });
    });

    schedule(1300, () => {
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
          const id = String((options && options.sessionID) || (((options || {}).path || {}).id) || '');
          if (!sessions.has(id)) return { data: undefined, error: { message: 'not found' } };
          return { data: { id }, error: undefined };
        },
        async create(options) {
          const body = (options || {}).body || {};
          const parent = String((options && options.parentID) || body.parentID || '').trim();
          const id = parent || 'sdk-inprogress-newer-message';
          sessions.add(id);
          return { data: { id }, error: undefined };
        },
        async promptAsync(options) {
                    const id = String((options && options.sessionID) || (((options || {}).path || {}).id) || 'sdk-inprogress-newer-message');
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
