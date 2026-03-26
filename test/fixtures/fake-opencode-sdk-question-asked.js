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
  let activeSessionId = 'sdk-question-asked';
  global.__FAKE_QUESTION_ASKED_REPLIES__ = Array.isArray(global.__FAKE_QUESTION_ASKED_REPLIES__)
    ? global.__FAKE_QUESTION_ASKED_REPLIES__
    : [];
  global.__FAKE_QUESTION_ASKED_REJECTS__ = Array.isArray(global.__FAKE_QUESTION_ASKED_REJECTS__)
    ? global.__FAKE_QUESTION_ASKED_REJECTS__
    : [];

  function emitQuestionRun(sessionId) {
    queue.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
    queue.push({
      type: 'question.asked',
      properties: {
        id: 'req-1',
        sessionID: sessionId,
        questions: [{
          header: 'Need input',
          question: 'How should I continue?',
          options: [
            { label: 'Ship now', description: 'continue immediately' },
            { label: 'Wait', description: 'pause for review' },
          ],
        }],
      },
    });
    queue.push({ type: 'session.idle', properties: { sessionID: sessionId } });
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
          const id = parent || 'sdk-question-asked';
          activeSessionId = id;
          sessions.add(id);
          return { data: { id }, error: undefined };
        },
        async promptAsync(options) {
          const id = String((options && options.sessionID) || (((options || {}).path || {}).id) || 'sdk-question-asked');
          activeSessionId = id;
          emitQuestionRun(id);
          return { data: undefined, error: undefined };
        },
        async abort() {
          return { data: true, error: undefined };
        },
      },
      question: {
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
          global.__FAKE_QUESTION_ASKED_REPLIES__.push({
            requestID,
            answers,
          });
          queue.push({
            type: 'question.replied',
            properties: {
              sessionID: activeSessionId,
              requestID,
              answers,
            },
          });
          return { data: { ok: true }, error: undefined };
        },
        async reject(options) {
          const requestID = String(
            (options && options.requestID)
            || (options && options.path && options.path.requestID)
            || ''
          );
          global.__FAKE_QUESTION_ASKED_REJECTS__.push({
            requestID,
          });
          queue.push({
            type: 'question.rejected',
            properties: {
              sessionID: activeSessionId,
              requestID,
            },
          });
          return { data: { ok: true }, error: undefined };
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
