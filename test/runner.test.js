const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const runnerPath = require.resolve('../src/lib/runner');

function loadRunnerWithEnv(maxSeconds) {
  process.env.OMG_MAX_PROCESS_SECONDS = String(maxSeconds);
  delete require.cache[runnerPath];
  return require('../src/lib/runner');
}

function loadRunnerWithOverrides(overrides) {
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v === undefined || v === null) {
      delete process.env[k];
    } else {
      process.env[k] = String(v);
    }
  }
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

test('runOpencode serve mode fails fast when live lock cannot be acquired', async () => {
  const previousTransport = process.env.OMG_EXECUTION_TRANSPORT;
  const previousLockTimeout = process.env.OMG_SERVE_LOCK_WAIT_TIMEOUT_MS;
  process.env.OMG_EXECUTION_TRANSPORT = 'serve';

  const { runOpencode, _internal } = loadRunnerWithOverrides({
    OMG_MAX_PROCESS_SECONDS: 10,
    OMG_SERVE_LOCK_WAIT_TIMEOUT_MS: 220,
  });

  const instance = {
    name: 'repo-live-lock-timeout',
    opencodeCommand: 'test/fixtures/fake-opencode-serve.js',
    workdir: process.cwd(),
    logFile: path.join(os.tmpdir(), `runner-live-lock-${Date.now()}.log`),
  };

  const paths = _internal.getServeScopePathsForInstance(instance);
  try {
    fs.mkdirSync(paths.lockDir, { recursive: true });
    fs.writeFileSync(paths.ownerPath, JSON.stringify({
      key: _internal.getServeScopeKey(instance),
      ownerId: 'live-owner',
      pid: process.pid,
      leaseUntil: new Date(Date.now() + 120000).toISOString(),
    }) + '\n', 'utf8');

    const err = await new Promise((resolve, reject) => {
      runOpencode(instance, 'lock-timeout', {
        onEvent: () => {},
        onDone: () => reject(new Error('expected lock failure, got onDone')),
        onError: resolve,
        sessionId: '',
      });
    });

    assert.match(String(err && err.message ? err.message : err), /timeout waiting for lock/i);
  } finally {
    try {
      fs.rmSync(paths.lockDir, { recursive: true, force: true });
    } catch (_err) {
    }
    if (previousTransport === undefined) {
      delete process.env.OMG_EXECUTION_TRANSPORT;
    } else {
      process.env.OMG_EXECUTION_TRANSPORT = previousTransport;
    }
    if (previousLockTimeout === undefined) {
      delete process.env.OMG_SERVE_LOCK_WAIT_TIMEOUT_MS;
    } else {
      process.env.OMG_SERVE_LOCK_WAIT_TIMEOUT_MS = previousLockTimeout;
    }
  }
});

test('runOpencode serve mode adopts healthy daemon record without spawning new serve process', async () => {
  const previousTransport = process.env.OMG_EXECUTION_TRANSPORT;
  const previousStartFile = process.env.FAKE_SERVE_START_COUNT_FILE;
  process.env.OMG_EXECUTION_TRANSPORT = 'serve';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-adopt-record-'));
  const startCountFile = path.join(tmpDir, 'starts.log');
  process.env.FAKE_SERVE_START_COUNT_FILE = startCountFile;

  const { runOpencode, getServeDaemonStatusForInstance, _internal } = loadRunnerWithOverrides({
    OMG_MAX_PROCESS_SECONDS: 10,
  });

  const instance = {
    name: 'repo-adopt-record',
    opencodeCommand: 'test/fixtures/fake-opencode-serve.js',
    workdir: process.cwd(),
    logFile: path.join(tmpDir, 'runner-adopt.log'),
  };

  const sessions = new Map();
  const sseClients = [];
  const server = http.createServer((req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';
    if (url === '/doc' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (url === '/event' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      sseClients.push(res);
      req.on('close', () => {
        const idx = sseClients.indexOf(res);
        if (idx >= 0) sseClients.splice(idx, 1);
      });
      return;
    }
    if (url === '/session' && method === 'POST') {
      const id = 'adopt-session';
      sessions.set(id, true);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id }));
      return;
    }
    if (/^\/session\/[^/]+$/.test(url) && method === 'GET') {
      const sid = url.split('/')[2];
      if (!sessions.has(sid)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: sid }));
      return;
    }
    if (/^\/session\/[^/]+\/prompt_async$/.test(url) && method === 'POST') {
      const sid = url.split('/')[2];
      const packet = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
      for (const client of sseClients) {
        client.write(packet({ type: 'session.status', properties: { sessionID: sid, status: { type: 'busy' } } }));
        client.write(packet({ type: 'message.part.updated', properties: { part: { sessionID: sid, id: 's1', type: 'step-start', index: 0 } } }));
        client.write(packet({ type: 'message.part.updated', properties: { part: { sessionID: sid, id: 't1', type: 'text', index: 1, text: 'adopted-daemon-final' } } }));
        client.write(packet({ type: 'session.idle', properties: { sessionID: sid } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (/^\/session\/[^/]+\/abort$/.test(url) && method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    const paths = _internal.getServeScopePathsForInstance(instance);

    fs.mkdirSync(path.dirname(paths.daemonPath), { recursive: true });
    fs.writeFileSync(paths.daemonPath, JSON.stringify({
      key: _internal.getServeScopeKey(instance),
      pid: process.pid,
      port,
      baseUrl,
      startedAt: new Date().toISOString(),
      status: 'ready',
    }) + '\n', 'utf8');

    const done = await new Promise((resolve, reject) => {
      runOpencode(instance, 'adopt-daemon', {
        onEvent: () => {},
        onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
        onError: reject,
        sessionId: '',
      });
    });

    assert.equal(done.exitCode, 0);
    assert.equal(done.timeoutMsg, null);
    assert.equal(done.meta.finalText, 'adopted-daemon-final');

    const started = fs.existsSync(startCountFile)
      ? fs.readFileSync(startCountFile, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    assert.equal(started.length, 0);

    const status = getServeDaemonStatusForInstance(instance);
    assert.equal(status.active, true);
    assert.equal(status.source, 'state-file');
    assert.equal(status.port, port);

    fs.writeFileSync(paths.daemonPath, JSON.stringify({
      key: _internal.getServeScopeKey(instance),
      pid: 999999,
      port,
      baseUrl,
      startedAt: new Date().toISOString(),
      status: 'ready',
    }) + '\n', 'utf8');

    await _internal.stopServeDaemonForInstance(instance);
  } finally {
    for (const client of sseClients) {
      try {
        client.end();
      } catch (_err) {
      }
    }
    await new Promise((resolve) => server.close(() => resolve()));
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

test('getServeDaemonStatusForInstance ignores dead persisted daemon records', async () => {
  const { getServeDaemonStatusForInstance, _internal } = loadRunnerWithOverrides({ OMG_MAX_PROCESS_SECONDS: 10 });
  const instance = {
    name: `repo-dead-record-${Date.now()}`,
    opencodeCommand: 'test/fixtures/fake-opencode-serve.js',
    workdir: process.cwd(),
    logFile: path.join(os.tmpdir(), `runner-dead-record-${Date.now()}.log`),
  };

  const paths = _internal.getServeScopePathsForInstance(instance);
  fs.mkdirSync(path.dirname(paths.daemonPath), { recursive: true });
  fs.writeFileSync(paths.daemonPath, JSON.stringify({
    key: _internal.getServeScopeKey(instance),
    pid: 999999,
    port: 43123,
    baseUrl: 'http://127.0.0.1:43123',
    startedAt: new Date().toISOString(),
    status: 'ready',
  }) + '\n', 'utf8');

  const status = getServeDaemonStatusForInstance(instance);
  assert.equal(status.active, false);
  assert.equal(status.port, null);
});

test('runner internal toValidPortRange falls back for invalid env values', () => {
  const { _internal } = loadRunnerWithOverrides({
    OMG_SERVE_PORT_RANGE_MIN: 45000,
    OMG_SERVE_PORT_RANGE_MAX: 44999,
  });
  const bad = _internal.toValidPortRange();
  assert.deepEqual(bad, { min: 43100, max: 43999 });

  const { _internal: internal2 } = loadRunnerWithOverrides({
    OMG_SERVE_PORT_RANGE_MIN: 43111,
    OMG_SERVE_PORT_RANGE_MAX: 43119,
  });
  const good = internal2.toValidPortRange();
  assert.deepEqual(good, { min: 43111, max: 43119 });
});

test('runner internal pickRandomAvailablePortInRange fails for occupied fixed range', async () => {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const addr = socket.address();
  const occupied = addr && typeof addr === 'object' ? addr.port : 0;

  const { _internal } = loadRunnerWithOverrides({
    OMG_SERVE_PORT_RANGE_MIN: occupied,
    OMG_SERVE_PORT_RANGE_MAX: occupied,
    OMG_SERVE_PORT_PICK_ATTEMPTS: 3,
  });

  try {
    await assert.rejects(
      () => _internal.pickRandomAvailablePortInRange(),
      /failed to find available port/i
    );
  } finally {
    await new Promise((resolve) => socket.close(() => resolve()));
  }
});

test('runner stopAllServeDaemons shuts down active daemon and clears status', async () => {
  const { runOpencode, stopAllServeDaemons, getServeDaemonStatusForInstance, _internal } = loadRunnerWithEnv(10);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runner-stopall-'));
  const previousTransport = process.env.OMG_EXECUTION_TRANSPORT;
  process.env.OMG_EXECUTION_TRANSPORT = 'serve';

  const instance = {
    name: 'repo-stop-all',
    opencodeCommand: 'test/fixtures/fake-opencode-serve.js',
    workdir: process.cwd(),
    logFile: path.join(tmpDir, 'runner-stop-all.log'),
  };

  try {
    const done = await new Promise((resolve, reject) => {
      runOpencode(instance, 'stop-all-ready', {
        onEvent: () => {},
        onDone: (exitCode, timeoutMsg, meta) => resolve({ exitCode, timeoutMsg, meta }),
        onError: reject,
        sessionId: '',
      });
    });

    assert.equal(done.exitCode, 0);
    const before = getServeDaemonStatusForInstance(instance);
    assert.equal(before.active, true);

    await stopAllServeDaemons();

    const after = getServeDaemonStatusForInstance(instance);
    assert.equal(after.active, false);

    const scopePaths = _internal.getServeScopePathsForInstance(instance);
    assert.equal(fs.existsSync(scopePaths.daemonPath), false);
  } finally {
    await _internal.stopServeDaemonForInstance(instance);
    if (previousTransport === undefined) {
      delete process.env.OMG_EXECUTION_TRANSPORT;
    } else {
      process.env.OMG_EXECUTION_TRANSPORT = previousTransport;
    }
  }
});
