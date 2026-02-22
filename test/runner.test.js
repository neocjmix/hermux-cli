const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runnerPath = require.resolve('../src/lib/runner');

function loadRunnerWithEnv(maxSeconds) {
  process.env.OMG_MAX_PROCESS_SECONDS = String(maxSeconds);
  delete require.cache[runnerPath];
  return require('../src/lib/runner');
}

test('runOpencode parses structured events and returns latest session id', async () => {
  const { runOpencode } = loadRunnerWithEnv(10);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-'));
  const events = [];

  const done = await new Promise((resolve, reject) => {
    runOpencode(
      {
        opencodeCommand: 'node test/fixtures/fake-opencode.js',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner.log'),
      },
      'hello-world',
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
  assert.equal(done.meta.sessionId, 'sess-abc');

  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['step_start', 'tool_use', 'text', 'step_finish']);
  assert.equal(events[2].content, 'final:hello-world');
});

test('runOpencode times out and reports timeout message', async () => {
  const { runOpencode } = loadRunnerWithEnv(1);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-timeout-'));

  const done = await new Promise((resolve, reject) => {
    runOpencode(
      {
        opencodeCommand: 'node test/fixtures/sleep-opencode.js',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner-timeout.log'),
      },
      'timeout-case',
      {
        onEvent: () => {},
        onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
        onError: reject,
        sessionId: '',
      }
    );
  });

  assert.equal(done.exitCode, null);
  assert.match(done.timeoutMsg, /timed out/i);
});

test('runOpencode captures rate limit from stderr metadata', async () => {
  const { runOpencode } = loadRunnerWithEnv(10);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-ratelimit-'));

  const done = await new Promise((resolve, reject) => {
    runOpencode(
      {
        opencodeCommand: 'node test/fixtures/rate-limit-opencode.js',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner-ratelimit.log'),
      },
      'ratelimit-case',
      {
        onEvent: () => {},
        onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
        onError: reject,
        sessionId: '',
      }
    );
  });

  assert.equal(done.exitCode, 1);
  assert.equal(done.timeoutMsg, null);
  assert.equal(done.meta.rateLimit.detected, true);
  assert.equal(done.meta.rateLimit.retryAfterSeconds, 42);
  assert.match(done.meta.rateLimit.line, /429/i);
  assert.equal(Array.isArray(done.meta.stderrSamples), true);
  assert.equal(done.meta.stderrSamples.length > 0, true);
});

test('runOpencode command mode returns deterministic finalText in meta', async () => {
  const { runOpencode } = loadRunnerWithEnv(10);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-multitext-'));

  const done = await new Promise((resolve, reject) => {
    runOpencode(
      {
        opencodeCommand: 'node test/fixtures/fake-opencode-multitext.js',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner-multitext.log'),
      },
      'multitext-case',
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
  assert.equal(done.meta.sessionId, 'sess-multi');
  assert.equal(done.meta.finalText, 'canonical-final-from-command');
});


test('runOpencode via serve mode orders out-of-order part text deterministically', async () => {
  const { runOpencode } = loadRunnerWithEnv(10);
  const tmpDir = os.tmpdir();
  const logDir = fs.mkdtempSync(path.join(tmpDir, 'hermux-runner-serve-'));
  const previousTransport = process.env.OMG_EXECUTION_TRANSPORT;
  process.env.OMG_EXECUTION_TRANSPORT = 'serve';

  try {
    const events = [];
    const done = await new Promise((resolve, reject) => {
      runOpencode(
        {
          opencodeCommand: 'test/fixtures/fake-opencode-serve.js',
          workdir: process.cwd(),
          logFile: require('node:path').join(logDir, 'runner-serve.log'),
        },
        'serve-order',
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
    assert.equal(done.meta.sessionId, 'serve-session');
    const finalTextEvents = events.filter((evt) => evt.type === 'text' && evt.textKind === 'final');
    assert.equal(finalTextEvents.length > 0, true);
    assert.equal(finalTextEvents.at(-1).content, 'first segment\n\nsecond segment');
    assert.equal(done.meta.finalText, 'first segment\n\nsecond segment');
  } finally {
    if (previousTransport === undefined) {
      delete process.env.OMG_EXECUTION_TRANSPORT;
    } else {
      process.env.OMG_EXECUTION_TRANSPORT = previousTransport;
    }
  }
});
