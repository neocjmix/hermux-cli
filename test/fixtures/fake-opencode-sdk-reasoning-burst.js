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

  return {
    server: {
      url: 'http://127.0.0.1:43107',
      close() { queue.close(); },
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
          const id = parent || 'sdk-reasoning-burst';
          sessions.add(id);
          return { data: { id }, error: undefined };
        },
        async promptAsync(options) {
          const path = (options || {}).path || {};
          const body = (options || {}).body || {};
          const id = String(path.id || 'sdk-reasoning-burst');
          const textPart = Array.isArray(body.parts) ? body.parts.find((x) => x && x.type === 'text') : null;
          const promptText = String((textPart && textPart.text) || '');

          queue.push({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
          queue.push({
            type: 'message.updated',
            properties: {
              info: {
                id: 'msg-burst',
                sessionID: id,
                role: 'assistant',
                time: { created: Date.now(), completed: Date.now() + 1 },
              },
            },
          });

          let accumulated = '';
          const chunks = ['thin', 'king', ' ', 'through', ' ', 'the', ' ', 'burst', ' ', 'answer'];
          chunks.forEach((chunk, index) => {
            setTimeout(() => {
              accumulated += chunk;
              queue.push({
                type: 'message.part.updated',
                properties: {
                  part: {
                    id: 'reasoning-burst',
                    sessionID: id,
                    messageID: 'msg-burst',
                    type: 'reasoning',
                    text: accumulated,
                    index: 0,
                  },
                },
              });
            }, index * 15);
          });

          setTimeout(() => {
            queue.push({
              type: 'message.part.updated',
              properties: {
                part: {
                  id: 'text-burst',
                  sessionID: id,
                  messageID: 'msg-burst',
                  type: 'text',
                  text: `final:${promptText}`,
                  index: 1,
                },
              },
            });
            queue.push({ type: 'session.idle', properties: { sessionID: id } });
          }, 220);

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
