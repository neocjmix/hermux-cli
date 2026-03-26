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
  global.__FAKE_OPENCODE_SDK_STARTS__ = Number(global.__FAKE_OPENCODE_SDK_STARTS__ || 0) + 1;
  global.__FAKE_OPENCODE_SDK_SUBSCRIBES__ = Number(global.__FAKE_OPENCODE_SDK_SUBSCRIBES__ || 0);
  global.__FAKE_OPENCODE_SDK_QUESTION_REPLIES__ = Array.isArray(global.__FAKE_OPENCODE_SDK_QUESTION_REPLIES__)
    ? global.__FAKE_OPENCODE_SDK_QUESTION_REPLIES__
    : [];
  global.__FAKE_OPENCODE_SDK_QUESTION_REJECTS__ = Array.isArray(global.__FAKE_OPENCODE_SDK_QUESTION_REJECTS__)
    ? global.__FAKE_OPENCODE_SDK_QUESTION_REJECTS__
    : [];
  global.__FAKE_OPENCODE_SDK_PERMISSION_REPLIES__ = Array.isArray(global.__FAKE_OPENCODE_SDK_PERMISSION_REPLIES__)
    ? global.__FAKE_OPENCODE_SDK_PERMISSION_REPLIES__
    : [];
  global.__FAKE_OPENCODE_SDK_PROMPTS__ = Array.isArray(global.__FAKE_OPENCODE_SDK_PROMPTS__)
    ? global.__FAKE_OPENCODE_SDK_PROMPTS__
    : [];
  const queue = createQueue();
  const disableQuestionApi = String(process.env.HERMUX_FAKE_SDK_DISABLE_QUESTION_API || '').trim() === '1';
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
          const id = String((options && options.sessionID) || (((options || {}).path || {}).id) || '');
          if (!sessions.has(id)) {
            return { data: undefined, error: { message: 'not found' } };
          }
          return { data: sessions.get(id), error: undefined };
        },
        async create(options) {
          const body = (options || {}).body || {};
          const parent = String((options && options.parentID) || body.parentID || '').trim();
          const id = parent || 'sdk-session';
          const existing = sessions.get(id) || {};
          const next = { id, ...existing, revert: existing.revert || undefined };
          sessions.set(id, next);
          return { data: next, error: undefined };
        },
        async promptAsync(options) {
          const body = (options || {}).body || {};
          const parts = Array.isArray(options && options.parts)
            ? options.parts
            : body.parts;
          const id = String((options && options.sessionID) || (((options || {}).path || {}).id) || 'sdk-session');
          if (!sessions.has(id)) sessions.set(id, { id });
          global.__FAKE_OPENCODE_SDK_PROMPTS__.push({
            sessionID: id,
            directory: String((options && options.directory) || (((options || {}).query || {}).directory) || ''),
            parts,
          });
          const textPart = Array.isArray(parts)
            ? parts.find((x) => x && x.type === 'text')
            : null;
          const promptText = String((textPart && textPart.text) || '');

          if (promptText === 'delayed-tail') {
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
                    id: 'text-delayed-step',
                    sessionID: id,
                    messageID: 'msg-delayed',
                    type: 'text',
                    text: 'warming-up',
                    index: 0,
                  },
                },
              });
            }, 1000);
            setTimeout(() => {
              queue.push({
                type: 'message.part.updated',
                properties: {
                  part: {
                    id: 'text-delayed-final',
                    sessionID: id,
                    messageID: 'msg-delayed',
                    type: 'text',
                    text: 'tail-arrived',
                    index: 1,
                  },
                },
              });
            }, 2500);
            return { data: undefined, error: undefined };
          }

          if (promptText === 'phase-complete-late') {
            queue.push({
              type: 'session.status',
              properties: {
                sessionID: id,
                status: { type: 'busy' },
              },
            });
            queue.push({
              type: 'session.idle',
              properties: {
                sessionID: id,
              },
            });
            setTimeout(() => {
              queue.push({
                type: 'message.part.updated',
                properties: {
                  part: {
                    id: 'phase-late-text',
                    sessionID: id,
                    messageID: 'msg-phase-late',
                    type: 'text',
                    text: 'phase-late-tail',
                    index: 0,
                  },
                },
              });
            }, 250);
            return { data: undefined, error: undefined };
          }

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
          const id = String((options && options.sessionID) || (((options || {}).path || {}).id) || '');
          const body = (options || {}).body || {};
          if (!sessions.has(id)) {
            return { data: undefined, error: { message: 'not found' } };
          }
          const existing = sessions.get(id) || { id };
          const messageID = String((options && options.messageID) || body.messageID || '');
          const partID = String((options && options.partID) || body.partID || '');
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
          const id = String((options && options.sessionID) || (((options || {}).path || {}).id) || '');
          if (!sessions.has(id)) {
            return { data: undefined, error: { message: 'not found' } };
          }
          const existing = sessions.get(id) || { id };
          const next = { ...existing, revert: undefined };
          sessions.set(id, next);
          return { data: next, error: undefined };
        },
      },
      permission: {
        async reply(options) {
          global.__FAKE_OPENCODE_SDK_PERMISSION_REPLIES__.push({
            requestID: String((options && options.requestID) || ''),
            directory: String((options && options.directory) || (options && options.query && options.query.directory) || ''),
            reply: String((options && options.reply) || ''),
            message: String((options && options.message) || ''),
          });
          return { data: { ok: true }, error: undefined };
        },
      },
      ...(disableQuestionApi ? {} : { question: {
        async reply(options) {
          const requestID = String(
            (options && options.requestID)
            || (options && options.path && options.path.requestID)
            || ''
          );
          const answers = Array.isArray(options && options.answers)
            ? options.answers
            : (Array.isArray(options && options.body && options.body.answers)
              ? options.body.answers
              : []);
          const directory = String(
            (options && options.directory)
            || (options && options.query && options.query.directory)
            || ''
          );
          global.__FAKE_OPENCODE_SDK_QUESTION_REPLIES__.push({
            requestID,
            directory,
            answers,
          });
          return { data: { ok: true }, error: undefined };
        },
        async reject(options) {
          const requestID = String(
            (options && options.requestID)
            || (options && options.path && options.path.requestID)
            || ''
          );
          const directory = String(
            (options && options.directory)
            || (options && options.query && options.query.directory)
            || ''
          );
          global.__FAKE_OPENCODE_SDK_QUESTION_REJECTS__.push({
            requestID,
            directory,
          });
          return { data: { ok: true }, error: undefined };
        },
      } }),
      event: {
        async subscribe() {
          global.__FAKE_OPENCODE_SDK_SUBSCRIBES__ = Number(global.__FAKE_OPENCODE_SDK_SUBSCRIBES__ || 0) + 1;
          return { stream: queue.stream };
        },
      },
    },
  };
}

module.exports = {
  createOpencode,
};
