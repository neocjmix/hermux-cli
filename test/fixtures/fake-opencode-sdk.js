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
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };

  return { push, close, stream };
}

async function createOpencode() {
  const queue = createQueue();
  if (!global.__FAKE_OPENCODE_SDK_SESSIONS__) {
    global.__FAKE_OPENCODE_SDK_SESSIONS__ = new Map();
  }
  const sessions = global.__FAKE_OPENCODE_SDK_SESSIONS__;

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
          const id = parent || 'sdk-session';
          const existing = sessions.get(id) || {};
          const next = { id, ...existing, revert: existing.revert || undefined };
          sessions.set(id, next);
          return { data: next, error: undefined };
        },
        async promptAsync(options) {
          const path = (options || {}).path || {};
          const body = (options || {}).body || {};
          const id = String(path.id || 'sdk-session');
          if (!sessions.has(id)) sessions.set(id, { id });
          const textPart = Array.isArray(body.parts)
            ? body.parts.find((x) => x && x.type === 'text')
            : null;
          const promptText = String((textPart && textPart.text) || '');

          queue.push({
            type: 'session.status',
            properties: {
              sessionID: id,
              status: { type: 'busy' },
            },
          });
          queue.push({
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'step-1',
                sessionID: id,
                messageID: 'msg-1',
                type: 'step-start',
                index: 0,
              },
            },
          });
          queue.push({
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'tool-1',
                sessionID: id,
                messageID: 'msg-1',
                type: 'tool',
                tool: 'bash',
                state: {
                  status: 'completed',
                  input: { command: 'ls' },
                  output: 'ok',
                },
                index: 1,
              },
            },
          });
          queue.push({
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'text-1',
                sessionID: id,
                messageID: 'msg-1',
                type: 'text',
                text: `final:${promptText}`,
                index: 2,
              },
            },
          });
          queue.push({
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'step-2',
                sessionID: id,
                messageID: 'msg-1',
                type: 'step-finish',
                reason: 'done',
                index: 3,
              },
            },
          });
          queue.push({
            type: 'session.idle',
            properties: { sessionID: id },
          });
          return { data: undefined, error: undefined };
        },
        async abort() {
          return { data: true, error: undefined };
        },
        async revert(options) {
          const id = String(((options || {}).path || {}).id || '');
          const body = (options || {}).body || {};
          if (!sessions.has(id)) {
            return { data: undefined, error: { message: 'not found' } };
          }
          const existing = sessions.get(id) || { id };
          const messageID = String(body.messageID || '');
          const partID = String(body.partID || '');
          const hasValidMessageID = messageID.startsWith('msg_') || messageID.startsWith('msg-');
          const hasValidPartID = partID.startsWith('prt_') || partID.startsWith('prt-');
          if (!hasValidMessageID && !hasValidPartID) {
            return { data: existing, error: undefined };
          }
          const next = {
            ...existing,
            revert: {
              messageID,
              partID,
              snapshot: 'fake-snapshot',
            },
          };
          sessions.set(id, next);
          return { data: next, error: undefined };
        },
        async unrevert(options) {
          const id = String(((options || {}).path || {}).id || '');
          if (!sessions.has(id)) {
            return { data: undefined, error: { message: 'not found' } };
          }
          const existing = sessions.get(id) || { id };
          const next = { ...existing, revert: undefined };
          sessions.set(id, next);
          return { data: next, error: undefined };
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
