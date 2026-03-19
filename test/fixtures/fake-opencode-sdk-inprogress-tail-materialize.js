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

  return {
    push,
    close,
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (values.length > 0) return Promise.resolve({ value: values.shift(), done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    },
  };
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
          id: 'msg-tail',
          sessionID: sessionId,
          role: 'assistant',
          time: { created: now + 10 },
        },
      },
    });
    queue.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-tail',
          sessionID: sessionId,
          messageID: 'msg-tail',
          type: 'text',
          text: '',
        },
      },
    });

    schedule(80, () => {
      queue.push({
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          messageID: 'msg-tail',
          partID: 'part-tail',
          field: 'text',
          delta: 'stable-tail-marker',
        },
      });
      queue.push({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-tail',
            sessionID: sessionId,
            messageID: 'msg-tail',
            type: 'text',
            text: 'stable-tail-marker',
          },
        },
      });
    });

    schedule(700, () => {
      queue.push({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-tail',
            sessionID: sessionId,
            role: 'assistant',
            time: { created: now + 10, completed: Date.now() },
            finish: 'stop',
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
          const id = parent || 'sdk-inprogress-tail-materialize';
          sessions.add(id);
          return { data: { id }, error: undefined };
        },
        async promptAsync(options) {
          const path = (options || {}).path || {};
          const id = String(path.id || 'sdk-inprogress-tail-materialize');
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
