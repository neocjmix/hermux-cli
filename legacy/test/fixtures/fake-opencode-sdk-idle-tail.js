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

  return {
    server: {
      url: 'http://127.0.0.1:43100',
      close() {
        queue.close();
      },
    },
    client: {
      session: {
        async get() {
          return { data: undefined, error: { message: 'not found' } };
        },
        async create() {
          return { data: { id: 'sdk-idle-tail' }, error: undefined };
        },
        async promptAsync(options) {
          const id = String((((options || {}).path || {}).id) || 'sdk-idle-tail');
          const parts = (((options || {}).body || {}).parts) || [];
          const promptText = String(((parts.find((x) => x && x.type === 'text') || {}).text) || '');

          queue.push({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
          queue.push({
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'text-main',
                sessionID: id,
                messageID: 'msg-tail',
                type: 'text',
                index: 1,
                text: `${promptText}\n\nchunk-1`,
              },
            },
          });

          queue.push({ type: 'session.idle', properties: { sessionID: id } });

          setTimeout(() => {
            queue.push({
              type: 'message.part.updated',
              properties: {
                part: {
                  id: 'text-main',
                  sessionID: id,
                  messageID: 'msg-tail',
                  type: 'text',
                  index: 1,
                  text: `${promptText}\n\nchunk-2`,
                },
              },
            });
          }, 30);

          setTimeout(() => {
            queue.push({
              type: 'message.part.updated',
              properties: {
                part: {
                  id: 'text-main',
                  sessionID: id,
                  messageID: 'msg-tail',
                  type: 'text',
                  index: 1,
                  text: `${promptText}\n\nchunk-3-tail`,
                },
              },
            });
          }, 80);

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
