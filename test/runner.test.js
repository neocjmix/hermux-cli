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
  const { runOpencode, _internal } = loadRunnerWithEnv(10);
  const tmpDir = os.tmpdir();
  const logDir = fs.mkdtempSync(path.join(tmpDir, 'hermux-runner-serve-'));
  const previousTransport = process.env.OMG_EXECUTION_TRANSPORT;
  process.env.OMG_EXECUTION_TRANSPORT = 'serve';
  const instance = {
    opencodeCommand: 'test/fixtures/fake-opencode-serve.js',
    workdir: process.cwd(),
    logFile: require('node:path').join(logDir, 'runner-serve.log'),
  };

  try {
    const events = [];
    const done = await new Promise((resolve, reject) => {
      runOpencode(
        instance,
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
    await _internal.stopServeDaemonForInstance(instance);
    if (previousTransport === undefined) {
      delete process.env.OMG_EXECUTION_TRANSPORT;
    } else {
      process.env.OMG_EXECUTION_TRANSPORT = previousTransport;
    }
  }
});

test('runOpencode serve mode reuses daemon across sequential prompts', async () => {
  const { runOpencode, _internal } = loadRunnerWithEnv(10);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-serve-reuse-'));
  const previousTransport = process.env.OMG_EXECUTION_TRANSPORT;
  const previousStartFile = process.env.FAKE_SERVE_START_COUNT_FILE;
  process.env.OMG_EXECUTION_TRANSPORT = 'serve';
  const startCountFile = path.join(tmpDir, 'starts.log');
  process.env.FAKE_SERVE_START_COUNT_FILE = startCountFile;

  const instance = {
    opencodeCommand: 'test/fixtures/fake-opencode-serve.js',
    workdir: process.cwd(),
    logFile: path.join(tmpDir, 'runner-serve-reuse.log'),
  };

  try {
    const first = await new Promise((resolve, reject) => {
      runOpencode(instance, 'serve-reuse-1', {
        onEvent: () => {},
        onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
        onError: reject,
        sessionId: '',
      });
    });

    assert.equal(first.exitCode, 0);
    assert.equal(first.timeoutMsg, null);
    assert.equal(first.meta.sessionId, 'serve-session');

    const second = await new Promise((resolve, reject) => {
      runOpencode(instance, 'serve-reuse-2', {
        onEvent: () => {},
        onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
        onError: reject,
        sessionId: first.meta.sessionId,
      });
    });

    assert.equal(second.exitCode, 0);
    assert.equal(second.timeoutMsg, null);
    assert.equal(second.meta.sessionId, 'serve-session');

    const lines = fs.existsSync(startCountFile)
      ? fs.readFileSync(startCountFile, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    assert.equal(lines.length, 1);
  } finally {
    await _internal.stopServeDaemonForInstance(instance);
    if (previousTransport === undefined) {
      delete process.env.OMG_EXECUTION_TRANSPORT;
    } else {
      process.env.OMG_EXECUTION_TRANSPORT = previousTransport;
    }
    if (previousStartFile === undefined) {
      delete process.env.FAKE_SERVE_START_COUNT_FILE;
    } else {
      process.env.FAKE_SERVE_START_COUNT_FILE = previousStartFile;
    }
  }
});

test('runOpencode serve mode deduplicates concurrent starts for same repo scope', async () => {
  const { runOpencode, _internal } = loadRunnerWithEnv(10);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-serve-concurrent-'));
  const previousTransport = process.env.OMG_EXECUTION_TRANSPORT;
  const previousStartFile = process.env.FAKE_SERVE_START_COUNT_FILE;
  process.env.OMG_EXECUTION_TRANSPORT = 'serve';
  const startCountFile = path.join(tmpDir, 'starts.log');
  process.env.FAKE_SERVE_START_COUNT_FILE = startCountFile;

  const instance = {
    name: 'repo-concurrent',
    opencodeCommand: 'test/fixtures/fake-opencode-serve.js',
    workdir: process.cwd(),
    logFile: path.join(tmpDir, 'runner-serve-concurrent.log'),
  };

  try {
    const [a, b] = await Promise.all([
      new Promise((resolve, reject) => {
        runOpencode(instance, 'serve-concurrent-a', {
          onEvent: () => {},
          onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
          onError: reject,
          sessionId: '',
        });
      }),
      new Promise((resolve, reject) => {
        runOpencode(instance, 'serve-concurrent-b', {
          onEvent: () => {},
          onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
          onError: reject,
          sessionId: '',
        });
      }),
    ]);

    assert.equal(a.exitCode, 0);
    assert.equal(b.exitCode, 0);

    const lines = fs.existsSync(startCountFile)
      ? fs.readFileSync(startCountFile, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    assert.equal(lines.length, 1);
  } finally {
    await _internal.stopServeDaemonForInstance(instance);
    if (previousTransport === undefined) {
      delete process.env.OMG_EXECUTION_TRANSPORT;
    } else {
      process.env.OMG_EXECUTION_TRANSPORT = previousTransport;
    }
    if (previousStartFile === undefined) {
      delete process.env.FAKE_SERVE_START_COUNT_FILE;
    } else {
      process.env.FAKE_SERVE_START_COUNT_FILE = previousStartFile;
    }
  }
});

test('runOpencode serve mode recovers from stale lock directory', async () => {
  const { runOpencode, _internal } = loadRunnerWithEnv(10);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-serve-stale-lock-'));
  const previousTransport = process.env.OMG_EXECUTION_TRANSPORT;
  const previousStartFile = process.env.FAKE_SERVE_START_COUNT_FILE;
  process.env.OMG_EXECUTION_TRANSPORT = 'serve';
  const startCountFile = path.join(tmpDir, 'starts.log');
  process.env.FAKE_SERVE_START_COUNT_FILE = startCountFile;

  const instance = {
    name: 'repo-stale-lock',
    opencodeCommand: 'test/fixtures/fake-opencode-serve.js',
    workdir: process.cwd(),
    logFile: path.join(tmpDir, 'runner-serve-stale-lock.log'),
  };

  try {
    const paths = _internal.getServeScopePathsForInstance(instance);
    fs.mkdirSync(paths.lockDir, { recursive: true });
    fs.writeFileSync(paths.ownerPath, JSON.stringify({
      key: _internal.getServeScopeKey(instance),
      ownerId: 'stale-owner',
      pid: 999999,
      leaseUntil: new Date(Date.now() - 60000).toISOString(),
    }) + '\n', 'utf8');

    const done = await new Promise((resolve, reject) => {
      runOpencode(instance, 'serve-stale-lock', {
        onEvent: () => {},
        onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
        onError: reject,
        sessionId: '',
      });
    });

    assert.equal(done.exitCode, 0);
    assert.equal(done.timeoutMsg, null);

    const lines = fs.existsSync(startCountFile)
      ? fs.readFileSync(startCountFile, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    assert.equal(lines.length, 1);
    assert.equal(fs.existsSync(paths.lockDir), false);
  } finally {
    await _internal.stopServeDaemonForInstance(instance);
    if (previousTransport === undefined) {
      delete process.env.OMG_EXECUTION_TRANSPORT;
    } else {
      process.env.OMG_EXECUTION_TRANSPORT = previousTransport;
    }
    if (previousStartFile === undefined) {
      delete process.env.FAKE_SERVE_START_COUNT_FILE;
    } else {
      process.env.FAKE_SERVE_START_COUNT_FILE = previousStartFile;
    }
  }
});
