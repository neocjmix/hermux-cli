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

test('runOpencode parses structured command events and returns latest session id', async () => {
  const { runOpencode } = loadRunnerWithEnv({
    OMG_MAX_PROCESS_SECONDS: 10,
    OMG_EXECUTION_TRANSPORT: 'command',
  });
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
  assert.deepEqual(events.map((e) => e.type), ['step_start', 'tool_use', 'text', 'step_finish']);
  assert.equal(events[2].content, 'final:hello-world');
});

test('runOpencode times out and reports timeout message', async () => {
  const { runOpencode } = loadRunnerWithEnv({
    OMG_MAX_PROCESS_SECONDS: 1,
    OMG_EXECUTION_TRANSPORT: 'command',
  });
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
  const { runOpencode } = loadRunnerWithEnv({
    OMG_MAX_PROCESS_SECONDS: 10,
    OMG_EXECUTION_TRANSPORT: 'command',
  });
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
});

test('runOpencode command mode preserves multi-chunk text in meta finalText', async () => {
  const { runOpencode } = loadRunnerWithEnv({
    OMG_MAX_PROCESS_SECONDS: 10,
    OMG_EXECUTION_TRANSPORT: 'command',
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-multitext-'));
  const events = [];

  const done = await new Promise((resolve, reject) => {
    runOpencode(
      {
        opencodeCommand: 'node test/fixtures/fake-opencode-multitext.js',
        workdir: process.cwd(),
        logFile: path.join(tmpDir, 'runner-multitext.log'),
      },
      'multi-text',
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
  assert.equal(done.meta.sessionId, 'sess-multi');
  assert.match(done.meta.finalText, /internal preface/);
  assert.match(done.meta.finalText, /canonical-final-from-command/);
  const textEvents = events.filter((evt) => evt.type === 'text');
  assert.equal(textEvents.length >= 2, true);
  assert.equal(textEvents.every((evt) => evt.textKind === 'stream'), true);
});

test('runOpencode sdk mode streams events and builds final text', async () => {
  const { runOpencode } = loadRunnerWithEnv({
    OMG_MAX_PROCESS_SECONDS: 10,
    OMG_EXECUTION_TRANSPORT: 'sdk',
    OMG_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
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
  assert.equal(done.meta.finalText, 'final:sdk-hello');
  assert.equal(events.some((e) => e.type === 'tool_use'), true);
  assert.equal(events.some((e) => e.type === 'text' && /final:sdk-hello/.test(String(e.content))), true);
});

test('runOpencode sdk mode drains async onEvent work before onDone', async () => {
  const { runOpencode } = loadRunnerWithEnv({
    OMG_MAX_PROCESS_SECONDS: 10,
    OMG_EXECUTION_TRANSPORT: 'sdk',
    OMG_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
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

test('runOpencode sdk mode reuses provided session id when valid', async () => {
  const { runOpencode } = loadRunnerWithEnv({
    OMG_MAX_PROCESS_SECONDS: 10,
    OMG_EXECUTION_TRANSPORT: 'sdk',
    OMG_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
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
  const { runOpencode, stopAllRuntimeExecutors } = loadRunnerWithEnv({
    OMG_MAX_PROCESS_SECONDS: 10,
    OMG_EXECUTION_TRANSPORT: 'sdk',
    OMG_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
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
});

test('stopAllRuntimeExecutors closes sdk runtime and next run recreates it', async () => {
  global.__FAKE_OPENCODE_SDK_STARTS__ = 0;
  const { runOpencode, stopAllRuntimeExecutors } = loadRunnerWithEnv({
    OMG_MAX_PROCESS_SECONDS: 10,
    OMG_EXECUTION_TRANSPORT: 'sdk',
    OMG_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
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
    OMG_EXECUTION_TRANSPORT: 'sdk',
    OMG_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });

  const repo = {
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(os.tmpdir(), 'runner-revert.log'),
  };

  const bootstrap = loadRunnerWithEnv({
    OMG_EXECUTION_TRANSPORT: 'sdk',
    OMG_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
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
    OMG_EXECUTION_TRANSPORT: 'sdk',
    OMG_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });

  const repo = {
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(os.tmpdir(), 'runner-revert-noop.log'),
  };

  const freshSessionId = 'sdk-session-noop-target';
  const bootstrap = loadRunnerWithEnv({
    OMG_EXECUTION_TRANSPORT: 'sdk',
    OMG_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
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
    OMG_EXECUTION_TRANSPORT: 'sdk',
    OMG_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
  });

  const repo = {
    opencodeCommand: 'opencode sdk',
    workdir: process.cwd(),
    logFile: path.join(os.tmpdir(), 'runner-unrevert.log'),
  };

  const freshSessionId = 'sdk-session-no-revert';
  const bootstrap = loadRunnerWithEnv({
    OMG_EXECUTION_TRANSPORT: 'sdk',
    OMG_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
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

test('runOpencode sdk mode captures late text that arrives after idle', async () => {
  const { runOpencode } = loadRunnerWithEnv({
    OMG_MAX_PROCESS_SECONDS: 10,
    OMG_EXECUTION_TRANSPORT: 'sdk',
    OMG_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk-idle-tail.js'),
    OMG_SDK_IDLE_DRAIN_MS: 220,
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
  assert.match(String(done.meta.finalText || ''), /chunk-3-tail/);
});

test('runtime status reflects active sdk run and resets after completion', async () => {
  const { runOpencode, getRuntimeStatusForInstance } = loadRunnerWithEnv({
    OMG_MAX_PROCESS_SECONDS: 10,
    OMG_EXECUTION_TRANSPORT: 'sdk',
    OMG_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
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
    OMG_SDK_PORT_RANGE_MIN: 45000,
    OMG_SDK_PORT_RANGE_MAX: 44999,
  });
  const bad = _internal.toValidPortRange();
  assert.deepEqual(bad, { min: 43100, max: 43999 });

  const { _internal: internal2 } = loadRunnerWithEnv({
    OMG_SDK_PORT_RANGE_MIN: 43111,
    OMG_SDK_PORT_RANGE_MAX: 43119,
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
    OMG_SDK_PORT_RANGE_MIN: occupied,
    OMG_SDK_PORT_RANGE_MAX: occupied,
    OMG_SDK_PORT_PICK_ATTEMPTS: 3,
  });

  try {
    await assert.rejects(() => _internal.pickRandomAvailablePortInRange(), /failed to find available port/i);
  } finally {
    await new Promise((resolve) => socket.close(() => resolve()));
  }
});

test('stopAllRuntimeExecutors interrupts active sdk runs', async () => {
  const { runOpencode, stopAllRuntimeExecutors } = loadRunnerWithEnv({
    OMG_MAX_PROCESS_SECONDS: 20,
    OMG_EXECUTION_TRANSPORT: 'sdk',
    OMG_OPENCODE_SDK_SHIM: path.join(process.cwd(), 'test/fixtures/fake-opencode-sdk.js'),
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
