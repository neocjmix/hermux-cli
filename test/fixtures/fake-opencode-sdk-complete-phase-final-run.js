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
              return Promise.resolve({ value: values.shift(), done: false });
            }
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
      url: 'http://127.0.0.1:43104',
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
          const id = parent || 'sdk-complete-phase-final-run';
          sessions.add(id);
          return { data: { id }, error: undefined };
        },
        async promptAsync(options) {
                    const body = (options || {}).body || {};
          const parts = Array.isArray(options && options.parts) ? options.parts : body.parts;
          const id = String((options && options.sessionID) || (((options || {}).path || {}).id) || 'sdk-complete-phase-final-run');
          const textPart = Array.isArray(parts)
            ? parts.find((x) => x && x.type === 'text')
            : null;
          const promptText = String((textPart && textPart.text) || '');

          queue.push({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
          queue.push({
            type: 'message.updated',
            properties: {
              info: {
                id: 'msg-final-run',
                sessionID: id,
                role: 'assistant',
                time: { created: Date.now(), completed: Date.now() + 1 },
              },
            },
          });
          queue.push({ type: 'session.idle', properties: { sessionID: id } });

          setTimeout(() => {
            queue.push({
              type: 'message.part.updated',
              properties: {
                part: {
                  id: 'part-final-run-late',
                  sessionID: id,
                  messageID: 'msg-final-run',
                  type: 'text',
                  text: `final-run-late-answer\nprompt:${promptText}`,
                  index: 0,
                },
              },
            });
          }, 300);

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
