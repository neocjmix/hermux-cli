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
  const promptCountsBySession = new Map();

  function schedule(delayMs, fn) {
    setTimeout(fn, delayMs);
  }

  function emitFirstRun(sessionId, promptText) {
    queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
    queue.push({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-first',
          sessionID: sessionId,
          role: 'assistant',
          time: { created: Date.now(), completed: Date.now() + 1 },
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
          text: `first-incident-answer\nprompt:${promptText}`,
        },
      },
    });

    schedule(30, () => {
      queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
      queue.push({ type: 'session.idle', properties: { sessionID: sessionId } });
      queue.push({ type: 'session.diff', properties: { sessionID: sessionId, diff: [] } });
    });

    schedule(1400, () => {
      queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
      queue.push({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-first-late-step-start',
            sessionID: sessionId,
            messageID: 'msg-first',
            type: 'step-start',
          },
        },
      });
      queue.push({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-first-late-text',
            sessionID: sessionId,
            messageID: 'msg-first',
            type: 'text',
            text: 'first-run-late-tail',
          },
        },
      });
      queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
      queue.push({ type: 'session.idle', properties: { sessionID: sessionId } });
      queue.push({ type: 'session.diff', properties: { sessionID: sessionId, diff: [] } });
    });
  }

  function emitSecondRunIncidentReplay(sessionId, promptText) {
    queue.push({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-second',
          sessionID: sessionId,
          role: 'assistant',
          time: { created: Date.now(), completed: Date.now() + 1 },
        },
      },
    });
    queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });

    schedule(35, () => {
      queue.push({ type: 'session.diff', properties: { sessionID: sessionId, diff: [] } });
      queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
      queue.push({ type: 'session.idle', properties: { sessionID: sessionId } });
    });

    schedule(850, () => {
      queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
      queue.push({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-second-late-text-base',
            sessionID: sessionId,
            messageID: 'msg-second',
            type: 'text',
            text: 'second-incident-answer: ',
          },
        },
      });
      queue.push({
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          messageID: 'msg-second',
          partID: 'part-second-late-text-base',
          field: 'text',
          delta: `prompt:${promptText}`,
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
          const id = String((options && options.sessionID) || (((options || {}).path || {}).id) || '');
          if (!sessions.has(id)) return { data: undefined, error: { message: 'not found' } };
          return { data: { id }, error: undefined };
        },
        async create(options) {
          const body = (options || {}).body || {};
          const parts = Array.isArray(options && options.parts) ? options.parts : body.parts;
          const parent = String((options && options.parentID) || body.parentID || '').trim();
          const id = parent || 'sdk-two-runs-incident-replay';
          sessions.add(id);
          return { data: { id }, error: undefined };
        },
        async promptAsync(options) {
                    const body = (options || {}).body || {};
          const parts = Array.isArray(options && options.parts) ? options.parts : body.parts;
          const id = String((options && options.sessionID) || (((options || {}).path || {}).id) || 'sdk-two-runs-incident-replay');
          const textPart = Array.isArray(parts)
            ? parts.find((x) => x && x.type === 'text')
            : null;
          const promptText = String((textPart && textPart.text) || '');

          const count = Number(promptCountsBySession.get(id) || 0) + 1;
          promptCountsBySession.set(id, count);

          if (count === 1) {
            emitFirstRun(id, promptText);
          } else {
            emitSecondRunIncidentReplay(id, promptText);
          }

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
