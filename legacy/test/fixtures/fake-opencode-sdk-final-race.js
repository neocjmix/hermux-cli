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
          if (!sessions.has(id)) return { data: undefined, error: { message: 'not found' } };
          return { data: { id }, error: undefined };
        },
        async create(options) {
          const body = (options || {}).body || {};
          const parent = String(body.parentID || '').trim();
          const id = parent || 'sdk-race-session';
          sessions.add(id);
          return { data: { id }, error: undefined };
        },
        async promptAsync(options) {
          const path = (options || {}).path || {};
          const body = (options || {}).body || {};
          const id = String(path.id || 'sdk-race-session');
          const textPart = Array.isArray(body.parts)
            ? body.parts.find((x) => x && x.type === 'text')
            : null;
          const promptText = String((textPart && textPart.text) || '');

          queue.push({
            type: 'session.status',
            properties: { sessionID: id, status: { type: 'busy' } },
          });

          queue.push({
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'step-start',
                sessionID: id,
                messageID: 'msg-race',
                type: 'step-start',
                index: 0,
              },
            },
          });

          for (let i = 0; i < 14; i++) {
            const payload = `${promptText}\n\n${'R'.repeat(2600)}\n\nunit-${i}`;
            queue.push({
              type: 'message.part.updated',
              properties: {
                part: {
                  id: 'text-main',
                  sessionID: id,
                  messageID: 'msg-race',
                  type: 'text',
                  text: payload,
                  index: 1,
                },
              },
            });
          }

          queue.push({
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'step-end',
                sessionID: id,
                messageID: 'msg-race',
                type: 'step-finish',
                reason: 'done',
                index: 2,
              },
            },
          });

          queue.push({ type: 'session.idle', properties: { sessionID: id } });
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
