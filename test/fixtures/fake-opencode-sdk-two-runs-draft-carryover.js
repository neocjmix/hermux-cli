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
  const promptCountsBySession = new Map();

  function emitFirstRun(sessionId) {
    queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
    queue.push({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-first',
          sessionID: sessionId,
          role: 'assistant',
          time: { created: Date.now() },
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
          text: 'carryover:draft-preview',
        },
      },
    });
    queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
    queue.push({ type: 'session.idle', properties: { sessionID: sessionId } });
    queue.push({ type: 'session.diff', properties: { sessionID: sessionId, diff: [] } });
  }

  function emitSecondRun(sessionId) {
    queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
    queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
    queue.push({ type: 'session.idle', properties: { sessionID: sessionId } });
    queue.push({ type: 'session.diff', properties: { sessionID: sessionId, diff: [] } });
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
          const id = parent || 'sdk-two-runs-draft-carryover';
          sessions.add(id);
          return { data: { id }, error: undefined };
        },
        async promptAsync(options) {
                    const id = String((options && options.sessionID) || (((options || {}).path || {}).id) || 'sdk-two-runs-draft-carryover');
          const count = Number(promptCountsBySession.get(id) || 0) + 1;
          promptCountsBySession.set(id, count);
          if (count === 1) emitFirstRun(id);
          else emitSecondRun(id);
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
