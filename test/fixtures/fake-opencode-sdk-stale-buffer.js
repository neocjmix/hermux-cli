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
            if (values.length > 0) {
              const value = values.shift();
              return Promise.resolve({ value, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    },
  };
}

async function createOpencode() {
  const queue = createQueue();
  const sessions = new Map();

  return {
    server: {
      url: 'http://127.0.0.1:43100',
      close() {
        queue.close();
      },
    },
    client: {
      session: {
        async get(options) {
          const id = String(((options || {}).path || {}).id || '');
          if (!sessions.has(id)) {
            return { data: undefined, error: { message: 'not found' } };
          }
          return { data: sessions.get(id), error: undefined };
        },
        async create(options) {
          const body = (options || {}).body || {};
          const parent = String(body.parentID || '').trim();
          const id = parent || 'sdk-stale';
          const next = sessions.get(id) || { id };
          sessions.set(id, next);
          return { data: next, error: undefined };
        },
        async promptAsync(options) {
          const id = String((((options || {}).path || {}).id) || 'sdk-stale');
          if (!sessions.has(id)) sessions.set(id, { id });
          queue.push({
            type: 'session.status',
            properties: {
              sessionID: id,
              status: { type: 'busy' },
            },
          });
          setTimeout(() => {
            queue.push({
              type: 'message.part.updated',
              properties: {
                part: {
                  id: 'fresh-text',
                  sessionID: id,
                  messageID: 'msg-fresh',
                  type: 'text',
                  text: 'fresh-final-output',
                  index: 0,
                },
              },
            });
            queue.push({
              type: 'session.idle',
              properties: { sessionID: id },
            });
          }, 180);
          return { data: undefined, error: undefined };
        },
        async abort() {
          return { data: true, error: undefined };
        },
      },
      event: {
        async subscribe() {
          setTimeout(() => {
            queue.push({
              type: 'session.idle',
              properties: { sessionID: 'sdk-stale' },
            });
          }, 0);
          return { stream: queue.stream };
        },
      },
    },
  };
}

module.exports = {
  createOpencode,
};
