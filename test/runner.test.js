const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const runnerPath = require.resolve('../src/lib/runner');

function loadRunnerWithEnv(vars) {
  for (const [k, v] of Object.entries(vars || {})) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  delete require.cache[runnerPath];
  return require('../src/lib/runner');
}

test('runOpencode sdk mode streams events and builds final text', async () => {
  global.__FAKE_OPENCODE_SDK_PROMPTS__ = [];
  const { runOpencode } = loadRunnerWithEnv({
    HERMUX_MAX_PROCESS_SECONDS: 10,
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-sdk-'));
  const events = [];

  const done = await new Promise((resolve, reject) => {
    runOpencode(
      {
        opencodeCommand: 'opencode sdk',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner-sdk.log'),
      },
      'sdk-hello',
      {
        onEvent: (evt) => events.push(evt),
        onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
        onError: reject,
        sessionId: '',
      }
    );
  });

  assert.equal(done.exitCode, 0);
  assert.equal(done.timeoutMsg, null);
  assert.equal(done.meta.sessionId, 'sdk-session');
  assert.equal(done.meta.finalText, '');
  assert.equal(events.some((e) => e.type === 'raw' && /final:sdk-hello/.test(String(e.content))), true);
  assert.deepEqual(global.__FAKE_OPENCODE_SDK_PROMPTS__, [{
    sessionID: 'sdk-session',
    directory: process.cwd(),
    parts: [{ type: 'text', text: 'sdk-hello' }],
  }]);
});

test('runOpencode sdk mode drains async onEvent work before onDone', async () => {
  const { runOpencode } = loadRunnerWithEnv({
    HERMUX_MAX_PROCESS_SECONDS: 10,
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-sdk-drain-'));
  const eventsAfterDone = [];
  let completed = false;

  const done = await new Promise((resolve, reject) => {
    runOpencode(
      {
        opencodeCommand: 'opencode sdk',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner-sdk-drain.log'),
      },
      'sdk-drain',
      {
        onEvent: async (evt) => {
          if (evt.type === 'text') {
            await new Promise((r) => setTimeout(r, 80));
          }
          if (completed) eventsAfterDone.push(evt.type);
        },
        onDone: (exitCode, timeoutMsg, meta) => {
          completed = true;
          resolve({ exitCode, timeoutMsg, meta });
        },
        onError: reject,
        sessionId: '',
      }
    );
  });

  await new Promise((r) => setTimeout(r, 180));
  assert.equal(done.exitCode, 0);
  assert.equal(done.timeoutMsg, null);
  assert.deepEqual(eventsAfterDone, []);
});

test('runOpencode sdk mode delays completion while raw activity continues', async () => {
  const { runOpencode } = loadRunnerWithEnv({
    HERMUX_MAX_PROCESS_SECONDS: 10,
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
    HERMUX_SDK_POST_COMPLETE_LINGER_MS: 2200,
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-sdk-late-tail-'));
  const eventsAfterDone = [];
  const seenRaw = [];
  let completed = false;
  const startedAt = Date.now();

  const done = await new Promise((resolve, reject) => {
    runOpencode(
      {
        opencodeCommand: 'opencode sdk',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner-sdk-late-tail.log'),
      },
      'delayed-tail',
      {
        onEvent: (evt) => {
          if (evt.type === 'raw') {
            const content = String(evt.content || '');
            if (content.includes('warming-up') || content.includes('tail-arrived')) {
              seenRaw.push(content);
            }
          }
          if (completed) eventsAfterDone.push(evt.type);
        },
        onDone: (exitCode, timeoutMsg, meta) => {
          completed = true;
          resolve({ exitCode, timeoutMsg, meta, elapsedMs: Date.now() - startedAt });
        },
        onError: reject,
        sessionId: '',
      }
    );
  });

  await new Promise((r) => setTimeout(r, 200));

  assert.equal(done.exitCode, 0);
  assert.equal(done.timeoutMsg, null);
  assert.equal(done.elapsedMs >= 4500, true);
  assert.equal(seenRaw.some((content) => content.includes('tail-arrived')), true);
  assert.deepEqual(eventsAfterDone, []);
});

test('runOpencode sdk mode should keep accepting late session events after complete phase', async () => {
  const { runOpencode } = loadRunnerWithEnv({
    HERMUX_MAX_PROCESS_SECONDS: 10,
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
    HERMUX_SDK_IDLE_DRAIN_MS: 0,
    HERMUX_SDK_POST_COMPLETE_LINGER_MS: 0,
    HERMUX_SDK_OBSERVER_IDLE_AFTER_DONE_MS: 20,
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-sdk-phase-complete-'));
  const seenRaw = [];
  let doneAt = 0;

  await new Promise((resolve, reject) => {
    runOpencode(
      {
        opencodeCommand: 'opencode sdk',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner-sdk-phase-complete.log'),
      },
      'phase-complete-late',
      {
        onEvent: (evt) => {
          if (evt.type === 'raw') {
            const content = String(evt.content || '');
            if (content.includes('phase-late-tail')) {
              seenRaw.push({ content, at: Date.now() });
            }
          }
        },
        onDone: () => {
          doneAt = Date.now();
          resolve();
        },
        onError: reject,
        sessionId: '',
      }
    );
  });

  await new Promise((r) => setTimeout(r, 600));

  assert.equal(doneAt > 0, true);
  assert.equal(seenRaw.length > 0, true);
  assert.equal(seenRaw.some((evt) => evt.at > doneAt), true);
});

test('runOpencode sdk mode stays interruptible while delegated task is still running', async () => {
  const { runOpencode } = loadRunnerWithEnv({
    HERMUX_MAX_PROCESS_SECONDS: 10,
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
    HERMUX_SDK_IDLE_DRAIN_MS: 0,
    HERMUX_SDK_POST_COMPLETE_LINGER_MS: 0,
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-sdk-subagent-interrupt-'));
  const startedAt = Date.now();
  const done = await new Promise((resolve, reject) => {
    const handle = runOpencode(
      {
        opencodeCommand: 'opencode sdk',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner-sdk-subagent-interrupt.log'),
      },
      'subagent-handoff',
      {
        onEvent: () => {},
        onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta, elapsedMs: Date.now() - startedAt }),
        onError: reject,
        sessionId: '',
      }
    );

    setTimeout(() => {
      handle.kill('SIGTERM');
    }, 700);
  });

  assert.equal(done.exitCode, 143);
  assert.equal(done.timeoutMsg, null);
  assert.equal(done.elapsedMs < 2200, true);
});

test('runOpencode sdk mode does not auto-complete while delegated task is still running', async () => {
  const { runOpencode } = loadRunnerWithEnv({
    HERMUX_MAX_PROCESS_SECONDS: 10,
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
    HERMUX_SDK_IDLE_DRAIN_MS: 0,
    HERMUX_SDK_POST_COMPLETE_LINGER_MS: 0,
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-sdk-subagent-wait-'));
  const startedAt = Date.now();
  const done = await new Promise((resolve, reject) => {
    runOpencode(
      {
        opencodeCommand: 'opencode sdk',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner-sdk-subagent-wait.log'),
      },
      'subagent-handoff',
      {
        onEvent: () => {},
        onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta, elapsedMs: Date.now() - startedAt }),
        onError: reject,
        sessionId: '',
      }
    );
  });

  assert.equal(done.exitCode, 0);
  assert.equal(done.timeoutMsg, null);
  assert.equal(done.elapsedMs >= 3000, true);
});

test('runOpencode sdk mode should stop accepting late session events after explicit session end', async () => {
  const { runOpencode, endSessionLifecycle } = loadRunnerWithEnv({
    HERMUX_MAX_PROCESS_SECONDS: 10,
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
    HERMUX_SDK_IDLE_DRAIN_MS: 0,
    HERMUX_SDK_POST_COMPLETE_LINGER_MS: 0,
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-sdk-session-end-'));
  const seenRaw = [];

  const done = await new Promise((resolve, reject) => {
    runOpencode(
      {
        opencodeCommand: 'opencode sdk',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner-sdk-session-end.log'),
      },
      'phase-complete-late',
      {
        onEvent: (evt) => {
          if (evt.type === 'raw' && String(evt.content || '').includes('phase-late-tail')) {
            seenRaw.push(evt);
          }
        },
        onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
        onError: reject,
        sessionId: '',
      }
    );
  });

  assert.equal(done.exitCode, 0);
  assert.equal(typeof endSessionLifecycle, 'function');
  await endSessionLifecycle({
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(tmpDir, 'runner-sdk-session-end.log'),
  }, done.meta.sessionId, 'test_session_end');
  await new Promise((r) => setTimeout(r, 600));

  assert.deepEqual(seenRaw, []);
});

test('runOpencode sdk mode reuses provided session id when valid', async () => {
  const { runOpencode } = loadRunnerWithEnv({
    HERMUX_MAX_PROCESS_SECONDS: 10,
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-sdk-reuse-'));

  const done = await new Promise((resolve, reject) => {
    runOpencode(
      {
        opencodeCommand: 'opencode sdk',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner-sdk-reuse.log'),
      },
      'sdk-reuse',
      {
        onEvent: () => {},
        onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
        onError: reject,
        sessionId: 'sdk-session',
      }
    );
  });

  assert.equal(done.exitCode, 0);
  assert.equal(done.timeoutMsg, null);
  assert.equal(done.meta.sessionId, 'sdk-session');
});

test('runOpencode sdk mode reuses persistent sdk runtime for same scope', async () => {
  global.__FAKE_OPENCODE_SDK_STARTS__ = 0;
  global.__FAKE_OPENCODE_SDK_SUBSCRIBES__ = 0;
  const { runOpencode, stopAllRuntimeExecutors } = loadRunnerWithEnv({
    HERMUX_MAX_PROCESS_SECONDS: 10,
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-sdk-reuse-runtime-'));
  const instance = {
    name: 'demo-runtime-reuse',
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(tmpDir, 'runner-sdk-reuse-runtime.log'),
  };

  const runOnce = (prompt) => new Promise((resolve, reject) => {
    runOpencode(instance, prompt, {
      onEvent: () => {},
      onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
      onError: reject,
      sessionId: '',
    });
  });

  const first = await runOnce('reuse-1');
  const second = await runOnce('reuse-2');
  await stopAllRuntimeExecutors();

  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(Number(global.__FAKE_OPENCODE_SDK_STARTS__ || 0), 1);
  assert.equal(Number(global.__FAKE_OPENCODE_SDK_SUBSCRIBES__ || 0), 1);
});

test('subscribeSessionEvents replays session events after run completion', async () => {
  const { runOpencode, subscribeSessionEvents, stopAllRuntimeExecutors } = loadRunnerWithEnv({
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
    HERMUX_SDK_IDLE_DRAIN_MS: 10,
    HERMUX_SDK_POST_COMPLETE_LINGER_MS: 20,
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-session-sub-'));
  const instance = {
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(tmpDir, 'runner-session-sub.log'),
  };

  const done = await new Promise((resolve, reject) => {
    runOpencode(instance, 'sub-check', {
      onEvent: () => {},
      onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
      onError: reject,
      sessionId: '',
    });
  });

  assert.equal(done.exitCode, 0);
  assert.equal(done.timeoutMsg, null);
  assert.equal(String(done.meta.sessionId || '').length > 0, true);

  let replayCount = 0;
  const sub = await subscribeSessionEvents(instance, done.meta.sessionId, {
    onEvent: () => {
      replayCount += 1;
    },
  });
  assert.equal(sub.mode, 'sdk');

  await new Promise((resolve) => setTimeout(resolve, 80));
  await sub.unsubscribe();
  await stopAllRuntimeExecutors();

  assert.equal(replayCount > 0, true);
});

test('subscribeSessionEvents skips buffered replay when requested', async () => {
  const { runOpencode, subscribeSessionEvents, stopAllRuntimeExecutors } = loadRunnerWithEnv({
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
    HERMUX_SDK_IDLE_DRAIN_MS: 10,
    HERMUX_SDK_POST_COMPLETE_LINGER_MS: 20,
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-session-sub-no-replay-'));
  const instance = {
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(tmpDir, 'runner-session-sub-no-replay.log'),
  };

  const done = await new Promise((resolve, reject) => {
    runOpencode(instance, 'sub-check-no-replay', {
      onEvent: () => {},
      onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
      onError: reject,
      sessionId: '',
    });
  });

  assert.equal(done.exitCode, 0);
  assert.equal(done.timeoutMsg, null);
  assert.equal(String(done.meta.sessionId || '').length > 0, true);

  let replayCount = 0;
  const sub = await subscribeSessionEvents(instance, done.meta.sessionId, {
    replayBuffered: false,
    onEvent: () => {
      replayCount += 1;
    },
  });
  assert.equal(sub.mode, 'sdk');

  await new Promise((resolve) => setTimeout(resolve, 80));
  await sub.unsubscribe();
  await stopAllRuntimeExecutors();

  assert.equal(replayCount, 0);
});

test('stopAllRuntimeExecutors closes sdk runtime and next run recreates it', async () => {
  global.__FAKE_OPENCODE_SDK_STARTS__ = 0;
  const { runOpencode, stopAllRuntimeExecutors } = loadRunnerWithEnv({
    HERMUX_MAX_PROCESS_SECONDS: 10,
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-sdk-recreate-runtime-'));
  const instance = {
    name: 'demo-runtime-recreate',
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(tmpDir, 'runner-sdk-recreate-runtime.log'),
  };

  const runOnce = (prompt) => new Promise((resolve, reject) => {
    runOpencode(instance, prompt, {
      onEvent: () => {},
      onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
      onError: reject,
      sessionId: '',
    });
  });

  const first = await runOnce('recreate-1');
  await stopAllRuntimeExecutors();
  const second = await runOnce('recreate-2');
  await stopAllRuntimeExecutors();

  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(Number(global.__FAKE_OPENCODE_SDK_STARTS__ || 0), 2);
});

test('runSessionRevert calls sdk revert with message and part ids', async () => {
  const { runSessionRevert } = loadRunnerWithEnv({
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });

  const repo = {
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(os.tmpdir(), 'runner-revert.log'),
  };

  const bootstrap = loadRunnerWithEnv({
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });
  await new Promise((resolve, reject) => {
    bootstrap.runOpencode(
      repo,
      'bootstrap',
      {
        onEvent: () => {},
        onDone: () => resolve(),
        onError: reject,
        sessionId: '',
      }
    );
  });

  const out = await runSessionRevert(repo, {
    sessionId: 'sdk-session',
    messageId: 'msg-1',
    partId: 'part-9',
  });

  assert.equal(out.ok, true);
  assert.equal(out.sessionId, 'sdk-session');
  assert.equal(out.canUnrevert, true);
});

test('runSessionRevert reports no-op when target id cannot be resolved', async () => {
  const { runSessionRevert } = loadRunnerWithEnv({
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });

  const repo = {
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(os.tmpdir(), 'runner-revert-noop.log'),
  };

  const freshSessionId = 'sdk-session-noop-target';
  const bootstrap = loadRunnerWithEnv({
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });
  await new Promise((resolve, reject) => {
    bootstrap.runOpencode(
      repo,
      'bootstrap',
      {
        onEvent: () => {},
        onDone: () => resolve(),
        onError: reject,
        sessionId: freshSessionId,
      }
    );
  });

  const out = await runSessionRevert(repo, {
    sessionId: freshSessionId,
    messageId: 'invalid-target',
  });

  assert.equal(out.ok, true);
  assert.equal(out.canUnrevert, false);
});

test('runSessionUnrevert reports noop when no revert state exists', async () => {
  const { runSessionUnrevert } = loadRunnerWithEnv({
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });

  const repo = {
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(os.tmpdir(), 'runner-unrevert.log'),
  };

  const freshSessionId = 'sdk-session-no-revert';
  const bootstrap = loadRunnerWithEnv({
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });
  await new Promise((resolve, reject) => {
    bootstrap.runOpencode(
      repo,
      'bootstrap',
      {
        onEvent: () => {},
        onDone: () => resolve(),
        onError: reject,
        sessionId: freshSessionId,
      }
    );
  });

  const out = await runSessionUnrevert(repo, {
    sessionId: freshSessionId,
  });

  assert.equal(out.ok, true);
  assert.equal(out.noop, true);
  assert.equal(out.hadRevert, false);
});

test('runQuestionReply calls sdk question reply with answers payload', async () => {
  global.__FAKE_OPENCODE_SDK_QUESTION_REPLIES__ = [];
  const { runQuestionReply } = loadRunnerWithEnv({
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });

  const repo = {
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(os.tmpdir(), 'runner-question-reply.log'),
  };

  const out = await runQuestionReply(repo, {
    requestId: 'req-1',
    answers: [['Ship now'], ['Use Telegram callback']],
  });

  assert.deepEqual(out, { ok: true });
  assert.deepEqual(global.__FAKE_OPENCODE_SDK_QUESTION_REPLIES__, [{
    requestID: 'req-1',
    directory: process.cwd(),
    answers: [['Ship now'], ['Use Telegram callback']],
  }]);
});

test('runPermissionReply calls sdk permission reply with approval payload', async () => {
  global.__FAKE_OPENCODE_SDK_PERMISSION_REPLIES__ = [];
  const { runPermissionReply } = loadRunnerWithEnv({
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });

  const repo = {
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(os.tmpdir(), 'runner-permission-reply.log'),
  };

  const out = await runPermissionReply(repo, {
    requestId: 'perm-1',
    reply: 'always',
  });

  assert.deepEqual(out, { ok: true });
  assert.deepEqual(global.__FAKE_OPENCODE_SDK_PERMISSION_REPLIES__, [{
    requestID: 'perm-1',
    directory: process.cwd(),
    reply: 'always',
    message: '',
  }]);
});

test('runQuestionReject calls sdk question reject with request id', async () => {
  global.__FAKE_OPENCODE_SDK_QUESTION_REJECTS__ = [];
  const { runQuestionReject } = loadRunnerWithEnv({
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });

  const repo = {
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(os.tmpdir(), 'runner-question-reject.log'),
  };

  const out = await runQuestionReject(repo, {
    requestId: 'req-2',
  });

  assert.deepEqual(out, { ok: true });
  assert.deepEqual(global.__FAKE_OPENCODE_SDK_QUESTION_REJECTS__, [{
    requestID: 'req-2',
    directory: process.cwd(),
  }]);
});

test('runQuestionReply reports unsupported question api clearly', async () => {
  const { runQuestionReply } = loadRunnerWithEnv({
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
    HERMUX_FAKE_SDK_DISABLE_QUESTION_API: '1',
  });

  const repo = {
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(os.tmpdir(), 'runner-question-reply-unsupported.log'),
  };

  await assert.rejects(
    () => runQuestionReply(repo, { requestId: 'req-unsupported', answers: [['Ship now']] }),
    /does not support question\.reply/
  );
});

test('runOpencode sdk mode captures late text that arrives after idle', async () => {
  const { runOpencode } = loadRunnerWithEnv({
    HERMUX_MAX_PROCESS_SECONDS: 10,
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk-idle-tail.js'),
    HERMUX_SDK_IDLE_DRAIN_MS: 220,
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-sdk-idle-tail-'));

  const done = await new Promise((resolve, reject) => {
    runOpencode(
      {
        opencodeCommand: 'opencode sdk',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner-sdk-idle-tail.log'),
      },
      'sdk-idle-tail',
      {
        onEvent: () => {},
        onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
        onError: reject,
        sessionId: '',
      }
    );
  });

  assert.equal(done.exitCode, 0);
  assert.equal(done.timeoutMsg, null);
  assert.equal(done.meta.sessionId, 'sdk-idle-tail');
  assert.equal(String(done.meta.finalText || ''), '');
});

test('runOpencode sdk mode keeps handling late deltas after completion signal', async () => {
  const { runOpencode } = loadRunnerWithEnv({
    HERMUX_MAX_PROCESS_SECONDS: 10,
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk-idle-late-delta.js'),
    HERMUX_SDK_IDLE_DRAIN_MS: 220,
    HERMUX_SDK_POST_COMPLETE_LINGER_MS: 1200,
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-sdk-idle-late-delta-'));
  const events = [];

  const done = await new Promise((resolve, reject) => {
    runOpencode(
      {
        opencodeCommand: 'opencode sdk',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner-sdk-idle-late-delta.log'),
      },
      'sdk-idle-late-delta',
      {
        onEvent: (evt) => events.push(evt),
        onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
        onError: reject,
        sessionId: '',
      }
    );
  });

  assert.equal(done.exitCode, 0);
  assert.equal(done.timeoutMsg, null);
  assert.equal(String(done.meta.finalText || ''), '');
  assert.equal(events.some((evt) => evt.type === 'raw' && /chunk-2-late-delta/.test(String(evt.content || ''))), true);
});

test('runOpencode sdk mode ignores stale buffered idle before new run activity', async () => {
  const { runOpencode } = loadRunnerWithEnv({
    HERMUX_MAX_PROCESS_SECONDS: 10,
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk-stale-buffer.js'),
    HERMUX_SDK_IDLE_DRAIN_MS: 60,
    HERMUX_SDK_POST_COMPLETE_LINGER_MS: 120,
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-sdk-stale-buffer-'));

  const done = await new Promise((resolve, reject) => {
    runOpencode(
      {
        opencodeCommand: 'opencode sdk',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner-sdk-stale-buffer.log'),
      },
      'sdk-stale-buffer',
      {
        onEvent: () => {},
        onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
        onError: reject,
        sessionId: 'sdk-stale',
      }
    );
  });

  assert.equal(done.exitCode, 0);
  assert.equal(done.timeoutMsg, null);
  assert.equal(String(done.meta.finalText || ''), '');
});

test('runtime status reflects active sdk run and resets after completion', async () => {
  const { runOpencode, getRuntimeStatusForInstance } = loadRunnerWithEnv({
    HERMUX_MAX_PROCESS_SECONDS: 10,
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-status-'));
  const instance = {
    name: 'demo-status',
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(tmpDir, 'runner-status.log'),
  };

  const promise = new Promise((resolve, reject) => {
    runOpencode(instance, 'status-check', {
      onEvent: () => {},
      onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
      onError: reject,
      sessionId: '',
    });
  });

  const during = getRuntimeStatusForInstance(instance);
  assert.equal(during.active, true);
  assert.equal(during.transport, 'sdk');
  assert.equal(during.activeRuns >= 1, true);

  const done = await promise;
  assert.equal(done.exitCode, 0);

  const after = getRuntimeStatusForInstance(instance);
  assert.equal(after.active, false);
  assert.equal(after.activeRuns, 0);
});

test('runner internal toValidPortRange falls back for invalid env values', () => {
  const { _internal } = loadRunnerWithEnv({
    HERMUX_SDK_PORT_RANGE_MIN: 45000,
    HERMUX_SDK_PORT_RANGE_MAX: 44999,
  });
  const bad = _internal.toValidPortRange();
  assert.deepEqual(bad, { min: 43100, max: 43999 });

  const { _internal: internal2 } = loadRunnerWithEnv({
    HERMUX_SDK_PORT_RANGE_MIN: 43111,
    HERMUX_SDK_PORT_RANGE_MAX: 43119,
  });
  const good = internal2.toValidPortRange();
  assert.deepEqual(good, { min: 43111, max: 43119 });
});

test('runner internal pickRandomAvailablePortInRange fails for occupied fixed range', async () => {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const addr = socket.address();
  const occupied = addr && typeof addr === 'object' ? addr.port : 0;

  const { _internal } = loadRunnerWithEnv({
    HERMUX_SDK_PORT_RANGE_MIN: occupied,
    HERMUX_SDK_PORT_RANGE_MAX: occupied,
    HERMUX_SDK_PORT_PICK_ATTEMPTS: 3,
  });

  try {
    await assert.rejects(() => _internal.pickRandomAvailablePortInRange(), /failed to find available port/i);
  } finally {
    await new Promise((resolve) => socket.close(() => resolve()));
  }
});

test('stopAllRuntimeExecutors interrupts active sdk runs', async () => {
  const { runOpencode, stopAllRuntimeExecutors } = loadRunnerWithEnv({
    HERMUX_MAX_PROCESS_SECONDS: 20,
    HERMUX_EXECUTION_TRANSPORT: 'sdk',
    HERMUX_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-stopall-'));

  const runPromise = new Promise((resolve, reject) => {
    runOpencode(
      {
        name: 'repo-stop-all',
        opencodeCommand: 'opencode sdk',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner-stop-all.log'),
      },
      'stop-all-ready',
      {
        onEvent: () => {},
        onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
        onError: reject,
        sessionId: '',
      }
    );
  });

  await stopAllRuntimeExecutors();
  const done = await runPromise;
  assert.equal([0, 143].includes(Number(done.exitCode)), true);
});
