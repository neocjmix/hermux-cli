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
