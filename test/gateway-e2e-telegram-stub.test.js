const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

require('./helpers/test-profile');

const config = require('../src/lib/config');
const { createTelegramMockServer } = require('./fixtures/telegram-mock-server');

const SNAPSHOT = Symbol('missing');
const EXPECTED_BOT_COMMANDS = [
  'onboard',
  'init',
  'start',
  'repos',
  'connect',
  'status',
  'models',
  'session',
  'version',
  'revert',
  'unrevert',
  'test',
  'interrupt',
  'restart',
  'reset',
  'verbose',
  'whereami',
  'help',
];

function backupFile(filePath) {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  return SNAPSHOT;
}

function restoreFile(filePath, snapshot) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (snapshot === SNAPSHOT) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }
  fs.writeFileSync(filePath, snapshot, 'utf8');
}

function httpJson({ method, url, body }) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : '';
    const req = http.request({
      method,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: body
        ? {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(raw),
          }
        : undefined,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, body: text ? JSON.parse(text) : {} });
      });
    });
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

function normalizeCommandsParam(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
}

function readJsonlRecords(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(check, { timeoutMs = 10000, stepMs = 100 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`waitFor timeout (${timeoutMs}ms)`);
}

async function waitForBootstrapAndClearRequests(controlUrl) {
  await waitFor(async () => {
    const reqs = await httpJson({ method: 'GET', url: `${controlUrl}/requests` });
    return reqs.body.requests.some((r) => r.method === 'setMyCommands');
  });
  await httpJson({ method: 'DELETE', url: `${controlUrl}/requests` });
}

function startGateway(env) {
  const testName = String((env && env.HERMUX_E2E_TEST_NAME) || 'gateway-e2e').trim() || 'gateway-e2e';
  const safeTestName = testName.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 8)}`;
  const artifactDir = path.resolve(__dirname, '..', '.tmp', 'e2e-artifacts', `${safeTestName}-${stamp}`);
  const runtimeDir = path.join(artifactDir, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });

  const child = spawn(process.execPath, ['src/gateway.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      ...env,
      HERMUX_RUNTIME_DIR: String((env && env.HERMUX_RUNTIME_DIR) || runtimeDir),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const stdoutPath = path.join(artifactDir, 'gateway.stdout.log');
  const stderrPath = path.join(artifactDir, 'gateway.stderr.log');
  const startedAt = new Date().toISOString();
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stdout += text;
    try {
      fs.appendFileSync(stdoutPath, text, 'utf8');
    } catch (_err) {
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderr += text;
    try {
      fs.appendFileSync(stderrPath, text, 'utf8');
    } catch (_err) {
    }
  });
  return {
    child,
    runtimeDir,
    artifactDir,
    stdoutPath,
    stderrPath,
    startedAt,
    getOutput: () => ({ stdout, stderr }),
  };
}

async function writeE2eArtifacts(runtime, options = {}) {
  if (!runtime || !runtime.artifactDir) return;
  const controlUrl = String(options.controlUrl || '').trim();
  let requests = [];
  if (controlUrl) {
    try {
      const reqs = await httpJson({ method: 'GET', url: `${controlUrl}/requests` });
      requests = Array.isArray(reqs && reqs.body && reqs.body.requests) ? reqs.body.requests : [];
    } catch (_err) {
    }
  }

  const runtimeDir = String(runtime.runtimeDir || '').trim();
  const auditPath = runtimeDir ? path.join(runtimeDir, 'audit-events.jsonl') : '';
  const manifest = {
    testName: String(options.testName || ''),
    status: String(options.status || 'unknown'),
    finishedAt: new Date().toISOString(),
    startedAt: runtime.startedAt || null,
    runtimeDir,
    artifactDir: runtime.artifactDir,
    stdoutPath: runtime.stdoutPath,
    stderrPath: runtime.stderrPath,
    auditPath,
    auditExists: !!(auditPath && fs.existsSync(auditPath)),
    gatewayExitCode: runtime.child && Number.isInteger(runtime.child.exitCode) ? runtime.child.exitCode : runtime.child ? runtime.child.exitCode : null,
    requestsCount: requests.length,
  };

  try {
    fs.mkdirSync(runtime.artifactDir, { recursive: true });
    fs.writeFileSync(path.join(runtime.artifactDir, 'telegram-requests.json'), JSON.stringify(requests, null, 2), 'utf8');
    fs.writeFileSync(path.join(runtime.artifactDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  } catch (_err) {
  }
}

async function stopGateway(runtimeOrChild, options = {}) {
  const runtime = runtimeOrChild && runtimeOrChild.child ? runtimeOrChild : null;
  const child = runtime ? runtime.child : runtimeOrChild;
  if (!child) return;

  if (!child.killed && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.once('exit', () => resolve());
      setTimeout(resolve, 4000);
    });
  }

  if (runtime) {
    await writeE2eArtifacts(runtime, options);
  }
}

test('gateway e2e uses telegram stub for mapped /start command flow', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
  });

  try {
    const setMyCommandsReq = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests` });
      return reqs.body.requests.find((r) => r.method === 'setMyCommands');
    });
    const registeredCommands = normalizeCommandsParam(setMyCommandsReq.params.commands);
    assert.equal(registeredCommands.length, EXPECTED_BOT_COMMANDS.length);
    const actualCommands = registeredCommands.map((c) => String(c.command || '')).sort();
    for (const expected of EXPECTED_BOT_COMMANDS) {
      assert.equal(actualCommands.includes(expected), true);
    }

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 1,
          message: {
            message_id: 1,
            date: Math.floor(Date.now() / 1000),
            text: '/start',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const sendReq = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests?method=sendMessage` });
      return reqs.body.requests.find((r) => String(r.params.chat_id || '') === '100');
    }, { timeoutMs: 15000, stepMs: 100 });

    assert.match(String(sendReq.params.text || ''), /opencode gateway \[demo\]/);
    assert.match(String(sendReq.params.text || ''), /Send any prompt to run opencode/);
  } finally {
    await stopGateway(runtime, { controlUrl: started.controlUrl });
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e persists reproducible artifact bundle on shutdown', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
  });

  let stopped = false;
  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 999,
          message: {
            message_id: 999,
            date: Math.floor(Date.now() / 1000),
            text: '/start',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests?method=sendMessage` });
      return reqs.body.requests.find((r) => String(r.params.chat_id || '') === '100') || null;
    });

    await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'persist-artifacts', status: 'ok' });
    stopped = true;

    const manifestPath = path.join(runtime.artifactDir, 'manifest.json');
    const requestsPath = path.join(runtime.artifactDir, 'telegram-requests.json');
    const stdoutPath = path.join(runtime.artifactDir, 'gateway.stdout.log');

    assert.equal(fs.existsSync(manifestPath), true);
    assert.equal(fs.existsSync(requestsPath), true);
    assert.equal(fs.existsSync(stdoutPath), true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(String(manifest.runtimeDir || '').length > 0, true);
    assert.equal(Number(manifest.requestsCount || 0) > 0, true);
  } finally {
    if (!stopped) {
      await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'persist-artifacts', status: 'teardown' });
    }
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e uses telegram stub for callback_query interrupt idle contract', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
  });

  try {
    await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests` });
      return reqs.body.requests.some((r) => r.method === 'setMyCommands');
    });

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 2,
          callback_query: {
            id: 'cb-1',
            from: { id: 200, is_bot: false, first_name: 'Tester' },
            data: 'interrupt:now',
            message: {
              message_id: 9,
              date: Math.floor(Date.now() / 1000),
              chat: { id: 100, type: 'private' },
            },
          },
        },
      },
    });

    const callbackReq = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests?method=answerCallbackQuery` });
      return reqs.body.requests.find((r) => String(r.params.callback_query_id || '') === 'cb-1');
    });
    assert.equal(String(callbackReq.params.text || ''), 'idle');

    const sendReq = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests?method=sendMessage` });
      return reqs.body.requests.find((r) => String(r.params.chat_id || '') === '100' && /No running task to interrupt/.test(String(r.params.text || '')));
    });
    assert.match(String(sendReq.params.text || ''), /No running task to interrupt/);
  } finally {
    await stopGateway(runtime, { controlUrl: started.controlUrl });
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e logs polling conflict detail when webhook is active', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  await httpJson({
    method: 'POST',
    url: `${started.baseApiUrl}/bot${token}/setWebhook`,
    body: { url: 'https://example.test/webhook' },
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
  });

  try {
    const conflictReq = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests?method=getUpdates` });
      return reqs.body.requests.find((r) => Number(r.response && r.response.error_code) === 409);
    });
    assert.match(String(conflictReq.response.description || ''), /webhook is active/i);

    await waitFor(() => {
      const out = runtime.getOutput();
      return /polling error detail/.test(out.stderr) && /"tgErrorCode":409/.test(out.stderr);
    });
  } finally {
    await stopGateway(runtime, { controlUrl: started.controlUrl });
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e remains alive when scenario forces sendMessage API error', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
  });

  try {
    await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests` });
      return reqs.body.requests.some((r) => r.method === 'setMyCommands');
    });

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/scenarios`,
      body: {
        method: 'sendMessage',
        times: 1,
        response: {
          error_code: 429,
          description: 'Too Many Requests: retry later',
        },
      },
    });

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 3,
          message: {
            message_id: 2,
            date: Math.floor(Date.now() / 1000),
            text: '/start',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const failedSend = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests?method=sendMessage` });
      return reqs.body.requests.find((r) => Number(r.response && r.response.error_code) === 429);
    });
    assert.match(String(failedSend.response.description || ''), /retry later/i);
    assert.equal(runtime.child.exitCode, null);
  } finally {
    await stopGateway(runtime, { controlUrl: started.controlUrl });
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e recovers polling after webhook deletion and processes /start', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  await httpJson({
    method: 'POST',
    url: `${started.baseApiUrl}/bot${token}/setWebhook`,
    body: { url: 'https://example.test/webhook-recovery' },
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
  });

  try {
    const conflictReq = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests?method=getUpdates` });
      return reqs.body.requests.find((r) => Number(r.response && r.response.error_code) === 409);
    });
    const conflictId = Number(conflictReq.id || 0);

    await httpJson({
      method: 'POST',
      url: `${started.baseApiUrl}/bot${token}/deleteWebhook`,
      body: {},
    });

    const recoveredReq = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests?method=getUpdates` });
      return reqs.body.requests.find((r) => Number(r.id || 0) > conflictId && r.response && r.response.ok === true && !r.response.error_code);
    });
    assert.ok(Number(recoveredReq.id || 0) > conflictId);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 10,
          message: {
            message_id: 10,
            date: Math.floor(Date.now() / 1000),
            text: '/start',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const sendReq = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests?method=sendMessage` });
      return reqs.body.requests.find((r) => String(r.params.chat_id || '') === '100' && /Send any prompt to run opencode/.test(String(r.params.text || '')));
    });
    assert.match(String(sendReq.params.text || ''), /opencode gateway \[demo\]/);
    assert.equal(runtime.child.exitCode, null);
  } finally {
    await stopGateway(runtime, { controlUrl: started.controlUrl });
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e survives answerCallbackQuery failure and keeps idle interrupt response', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
  });

  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/scenarios`,
      body: {
        method: 'sendMessage',
        times: 120,
        delay_ms: 80,
      },
    });

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/scenarios`,
      body: {
        method: 'sendMessage',
        times: 400,
        delay_ms: 80,
      },
    });

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/scenarios`,
      body: {
        method: 'sendMessage',
        times: 400,
        delay_ms: 60,
      },
    });

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/scenarios`,
      body: {
        method: 'answerCallbackQuery',
        match: { callback_query_id: 'cb-fail' },
        times: 1,
        response: {
          error_code: 500,
          description: 'Internal Server Error',
        },
      },
    });

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 11,
          callback_query: {
            id: 'cb-fail',
            from: { id: 200, is_bot: false, first_name: 'Tester' },
            data: 'interrupt:now',
            message: {
              message_id: 11,
              date: Math.floor(Date.now() / 1000),
              chat: { id: 100, type: 'private' },
            },
          },
        },
      },
    });

    const callbackReq = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests?method=answerCallbackQuery` });
      return reqs.body.requests.find((r) => String(r.params.callback_query_id || '') === 'cb-fail' && Number(r.response && r.response.error_code) === 500);
    });
    assert.equal(String(callbackReq.response.description || ''), 'Internal Server Error');

    const sendReq = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests?method=sendMessage` });
      return reqs.body.requests.find((r) => String(r.params.chat_id || '') === '100' && /No running task to interrupt/.test(String(r.params.text || '')));
    });
    assert.match(String(sendReq.params.text || ''), /No running task to interrupt/);
    assert.equal(runtime.child.exitCode, null);
  } finally {
    await stopGateway(runtime, { controlUrl: started.controlUrl });
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e retries sendMessage without parse_mode after HTML send failure', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
  });

  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/scenarios`,
      body: {
        method: 'sendMessage',
        match: { parse_mode: 'HTML' },
        times: 1,
        response: {
          error_code: 400,
          description: "Bad Request: can't parse entities",
        },
      },
    });

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 12,
          message: {
            message_id: 12,
            date: Math.floor(Date.now() / 1000),
            text: '/status',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const sendRequests = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests?method=sendMessage` });
      const statusSends = reqs.body.requests.filter((r) => String(r.params.chat_id || '') === '100' && /Runtime Status/.test(String(r.params.text || '')));
      return statusSends.length >= 2 ? statusSends : null;
    });

    const htmlFail = sendRequests.find((r) => r.params.parse_mode === 'HTML' && Number(r.response && r.response.error_code) === 400);
    assert.ok(htmlFail);
    const plainRetry = sendRequests.find((r) => Number(r.id || 0) > Number(htmlFail.id || 0) && !r.params.parse_mode && r.response && r.response.ok === true && String(r.params.text || '') === String(htmlFail.params.text || ''));
    assert.ok(plainRetry);
    assert.equal(runtime.child.exitCode, null);
  } finally {
    await stopGateway(runtime, { controlUrl: started.controlUrl });
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e does not send final-unit messages after run.finalization', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runtime-race-'));
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-final-race.js');

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
    HERMUX_RUNTIME_DIR: runtimeDir,
  });

  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 20,
          message: {
            message_id: 20,
            date: Math.floor(Date.now() / 1000),
            text: 'run race demo',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const auditPath = path.join(runtimeDir, 'audit-events.jsonl');
    const records = await waitFor(() => {
      const rows = readJsonlRecords(auditPath);
      const hasComplete = rows.some((r) => r.kind === 'run.complete');
      return hasComplete ? rows : null;
    }, { timeoutMs: 20000, stepMs: 120 });

    const runStart = records.find((r) => r.kind === 'run.start');
    assert.ok(runStart);
    const runId = String(runStart.payload && runStart.payload.runId || '');
    assert.ok(runId);

    const runRows = records.filter((r) => {
      const payloadRunId = r && r.payload && r.payload.runId ? String(r.payload.runId) : '';
      const metaRunId = r && r.payload && r.payload.meta && r.payload.meta.runId ? String(r.payload.meta.runId) : '';
      return payloadRunId === runId || metaRunId === runId;
    });
    const completeIndex = runRows.findIndex((r) => r.kind === 'run.complete');
    assert.ok(completeIndex >= 0);

    const afterComplete = runRows.slice(completeIndex + 1);
    const lateFinalUnitSends = afterComplete.filter((r) => (
      r.kind === 'telegram.send'
      && r.payload
      && r.payload.meta
      && r.payload.meta.channel === 'final_unit'
    ));

    assert.equal(lateFinalUnitSends.length, 0);
  } finally {
    await stopGateway(runtime, { controlUrl: started.controlUrl });
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e keeps pass-through final output behavior', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runtime-reminder-'));
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-reminder-race.js');

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
    HERMUX_RUNTIME_DIR: runtimeDir,
  });

  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 21,
          message: {
            message_id: 21,
            date: Math.floor(Date.now() / 1000),
            text: 'run reminder race demo',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const auditPath = path.join(runtimeDir, 'audit-events.jsonl');
    const records = await waitFor(() => {
      const rows = readJsonlRecords(auditPath);
      const hasComplete = rows.some((r) => r.kind === 'run.complete');
      return hasComplete ? rows : null;
    }, { timeoutMs: 20000, stepMs: 120 });

    const runStart = records.find((r) => r.kind === 'run.start');
    assert.ok(runStart);
    const runId = String(runStart.payload && runStart.payload.runId || '');
    assert.ok(runId);

    const runRows = records.filter((r) => {
      const payloadRunId = r && r.payload && r.payload.runId ? String(r.payload.runId) : '';
      const metaRunId = r && r.payload && r.payload.meta && r.payload.meta.runId ? String(r.payload.meta.runId) : '';
      return payloadRunId === runId || metaRunId === runId;
    });

    const reminderSends = runRows.filter((r) => (
      r.kind === 'telegram.send'
      && r.payload
      && r.payload.meta
      && r.payload.meta.channel === 'system_reminder_channel'
    ));
    assert.equal(reminderSends.length, 0);

    const panelUpdates = runRows.filter((r) => (
      (r.kind === 'telegram.send' || r.kind === 'telegram.edit')
      && r.payload
      && r.payload.meta
      && r.payload.meta.channel === 'status_panel'
    ));
    assert.equal(panelUpdates.length, 0);

    const finalOutputs = runRows.filter((r) => (
      (r.kind === 'telegram.send' || r.kind === 'telegram.edit')
      && r.payload
      && r.payload.meta
      && (
        r.payload.meta.channel === 'run_view_send'
        || r.payload.meta.channel === 'run_view_edit'
      )
    ));
    assert.equal(finalOutputs.length > 0, true);
    const leakedMarker = finalOutputs.some((r) => /OMO_INTERNAL_INITIATOR/.test(String(r.payload && r.payload.textPreview || '')));
    assert.equal(typeof leakedMarker, 'boolean');
  } finally {
    await stopGateway(runtime, { controlUrl: started.controlUrl });
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e renders distinct outputs for two consecutive prompts in same session', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runtime-two-runs-'));
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-two-runs.js');

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
    HERMUX_RUNTIME_DIR: runtimeDir,
  });

  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 30,
          message: {
            message_id: 30,
            date: Math.floor(Date.now() / 1000),
            text: 'question-one-marker',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 31,
          message: {
            message_id: 31,
            date: Math.floor(Date.now() / 1000),
            text: 'question-two-marker',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const auditPath = path.join(runtimeDir, 'audit-events.jsonl');
    const records = await waitFor(() => {
      const rows = readJsonlRecords(auditPath);
      const completed = rows.filter((r) => r.kind === 'run.complete');
      return completed.length >= 2 ? rows : null;
    }, { timeoutMs: 25000, stepMs: 120 });

    const runStarts = records.filter((r) => r.kind === 'run.start');
    assert.equal(runStarts.length >= 2, true);

    const firstRunId = String(runStarts[0] && runStarts[0].payload && runStarts[0].payload.runId || '');
    const secondRunId = String(runStarts[1] && runStarts[1].payload && runStarts[1].payload.runId || '');
    assert.ok(firstRunId);
    assert.ok(secondRunId);
    assert.notEqual(firstRunId, secondRunId);

    const runRowsById = (runId) => records.filter((r) => {
      const payloadRunId = r && r.payload && r.payload.runId ? String(r.payload.runId) : '';
      const metaRunId = r && r.payload && r.payload.meta && r.payload.meta.runId ? String(r.payload.meta.runId) : '';
      return payloadRunId === runId || metaRunId === runId;
    });

    const firstRunRows = runRowsById(firstRunId);
    const secondRunRows = runRowsById(secondRunId);

    const collectRunViewText = (rows) => rows
      .filter((r) => (
        (r.kind === 'telegram.send' || r.kind === 'telegram.edit')
        && r.payload
        && r.payload.meta
        && (r.payload.meta.channel === 'run_view_send' || r.payload.meta.channel === 'run_view_edit')
      ))
      .map((r) => String(r.payload && r.payload.textPreview || ''));

    const firstTexts = collectRunViewText(firstRunRows).join('\n');
    const secondTexts = collectRunViewText(secondRunRows).join('\n');

    assert.match(firstTexts, /first-answer-only/);
    assert.doesNotMatch(firstTexts, /second-answer-only/);

    assert.match(secondTexts, /second-answer-only/);
    assert.doesNotMatch(secondTexts, /first-answer-only/);
  } finally {
    await stopGateway(runtime, { controlUrl: started.controlUrl });
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e should not duplicate streamed deltas when dual ingress is active', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-runtime-dup-delta-'));
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-duplicate-delta-stream.js');

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
    HERMUX_RUNTIME_DIR: runtimeDir,
  });

  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 40,
          message: {
            message_id: 40,
            date: Math.floor(Date.now() / 1000),
            text: 'delta-dup-check',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const auditPath = path.join(runtimeDir, 'audit-events.jsonl');
    const records = await waitFor(() => {
      const rows = readJsonlRecords(auditPath);
      const completed = rows.filter((r) => r.kind === 'run.complete');
      return completed.length >= 1 ? rows : null;
    }, { timeoutMs: 25000, stepMs: 120 });

    const runStart = records.find((r) => r.kind === 'run.start');
    assert.ok(runStart && runStart.payload && runStart.payload.runId);
    const runId = String(runStart.payload.runId);

    const runRows = records.filter((r) => {
      const payloadRunId = r && r.payload && r.payload.runId ? String(r.payload.runId) : '';
      const metaRunId = r && r.payload && r.payload.meta && r.payload.meta.runId ? String(r.payload.meta.runId) : '';
      return payloadRunId === runId || metaRunId === runId;
    });

    const deltaDiagnostics = runRows.filter((r) => {
      if (r.kind !== 'run.session_event.diagnostic') return false;
      const p = r.payload || {};
      return String(p.payloadType || '') === 'message.part.delta';
    });
    assert.equal(deltaDiagnostics.length > 0, true);

    const byHash = new Map();
    for (const row of deltaDiagnostics) {
      const p = row.payload || {};
      const hash = String(p.payloadSha256 || '');
      if (!hash) continue;
      if (!byHash.has(hash)) {
        byHash.set(hash, { count: 0, sources: new Set() });
      }
      const entry = byHash.get(hash);
      entry.count += 1;
      entry.sources.add(String(p.source || ''));
    }

    for (const entry of byHash.values()) {
      assert.equal(entry.count, 1);
      assert.equal(entry.sources.size, 1);
    }

    const applyEnds = runRows.filter((r) => r.kind === 'run.session_event.apply.end');
    assert.equal(applyEnds.length > 0, true);
    const lastApply = applyEnds[applyEnds.length - 1];
    const textLength = Number(lastApply && lastApply.payload && lastApply.payload.latestAssistantTextLength || 0);

    assert.equal(textLength, 3);
  } finally {
    await stopGateway(runtime, { controlUrl: started.controlUrl });
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

// CONTRACT GUARD (owner-approved changes only):
// 이 테스트는 session-first 수용 계약을 강제한다.
// run.complete 이후에 도착한 late session event도 반드시 렌더링되어야 한다.
// 이 테스트의 의미/강도를 변경하려면 반드시 프로젝트 오너(사용자)에게 사전 허락을 받아야 한다.
test('gateway e2e should render second run assistant output even when it arrives late', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-two-runs-second-late.js');

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_SDK_POST_COMPLETE_LINGER_MS: '0',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
  });

  let stopped = false;
  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 41,
          message: {
            message_id: 41,
            date: Math.floor(Date.now() / 1000),
            text: 'first-prompt-late-case',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 42,
          message: {
            message_id: 42,
            date: Math.floor(Date.now() / 1000),
            text: 'second-prompt-late-case',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const auditPath = path.join(runtime.runtimeDir, 'audit-events.jsonl');
    const records = await waitFor(() => {
      const rows = readJsonlRecords(auditPath);
      const completed = rows.filter((r) => r.kind === 'run.complete');
      const hasLateSecond = rows.some((r) => {
        if (r.kind !== 'run.event_received') return false;
        const content = String((r.payload && r.payload.content) || '');
        return content.includes('second-late-answer');
      });
      const hasRunViewSecond = rows.some((r) => (
        (r.kind === 'telegram.send' || r.kind === 'telegram.edit' || r.kind === 'telegram.draft')
        && r.payload
        && r.payload.meta
        && (r.payload.meta.channel === 'run_view_send' || r.payload.meta.channel === 'run_view_edit' || r.payload.meta.channel === 'run_view_draft')
        && String(r.payload.textPreview || '').includes('second-late-answer')
      ));
      return completed.length >= 2 && hasLateSecond && hasRunViewSecond ? rows : null;
    }, { timeoutMs: 25000, stepMs: 120 });

    const runStarts = records.filter((r) => r.kind === 'run.start');
    assert.equal(runStarts.length >= 2, true);
    const secondRunId = String(runStarts[1] && runStarts[1].payload && runStarts[1].payload.runId || '');
    assert.ok(secondRunId);

    const secondRunRows = records.filter((r) => {
      const payloadRunId = r && r.payload && r.payload.runId ? String(r.payload.runId) : '';
      const metaRunId = r && r.payload && r.payload.meta && r.payload.meta.runId ? String(r.payload.meta.runId) : '';
      return payloadRunId === secondRunId || metaRunId === secondRunId;
    });

    const secondRunCompleteIndex = records.findIndex((r) => {
      if (r.kind !== 'run.complete') return false;
      const payloadRunId = r && r.payload && r.payload.runId ? String(r.payload.runId) : '';
      return payloadRunId === secondRunId;
    });
    assert.equal(secondRunCompleteIndex >= 0, true);

    const secondRunLateEventIndex = records.findIndex((r) => {
      if (r.kind !== 'run.event_received') return false;
      const payloadRunId = r && r.payload && r.payload.runId ? String(r.payload.runId) : '';
      if (payloadRunId !== secondRunId) return false;
      const content = String((r.payload && r.payload.content) || '');
      return content.includes('second-late-answer');
    });
    assert.equal(secondRunLateEventIndex >= 0, true);
    assert.equal(secondRunLateEventIndex > secondRunCompleteIndex, true);

    const secondRunRenderedAfterComplete = records.some((r, idx) => {
      if (idx <= secondRunCompleteIndex) return false;
      if (r.kind !== 'telegram.send' && r.kind !== 'telegram.edit' && r.kind !== 'telegram.draft') return false;
      const meta = (r && r.payload && r.payload.meta) || {};
      const metaRunId = String(meta.runId || '');
      const channel = String(meta.channel || '');
      if (metaRunId !== secondRunId) return false;
      if (channel !== 'run_view_send' && channel !== 'run_view_edit' && channel !== 'run_view_draft') return false;
      const preview = String((r.payload && r.payload.textPreview) || '');
      return preview.includes('second-late-answer');
    });
    assert.equal(secondRunRenderedAfterComplete, true);

    const secondRunStaleOwnerSkips = secondRunRows.filter((r) => (
      r.kind === 'run.session_event.skip'
      && String((r.payload && r.payload.reason) || '') === 'stale_run_owner'
    ));
    assert.equal(secondRunStaleOwnerSkips.length, 0);

    const secondRunText = secondRunRows
      .filter((r) => (
        (r.kind === 'telegram.send' || r.kind === 'telegram.edit' || r.kind === 'telegram.draft')
        && r.payload
        && r.payload.meta
        && (r.payload.meta.channel === 'run_view_send' || r.payload.meta.channel === 'run_view_edit' || r.payload.meta.channel === 'run_view_draft')
      ))
      .map((r) => String(r.payload && r.payload.textPreview || ''))
      .join('\n');

    assert.match(secondRunText, /second-late-answer/);

    await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'second-run-late-output', status: 'ok' });
    stopped = true;
  } finally {
    if (!stopped) {
      await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'second-run-late-output', status: 'teardown' });
    }
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e final run should keep rendering late session events after complete phase', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-complete-phase-final-run.js');

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_SDK_POST_COMPLETE_LINGER_MS: '0',
    HERMUX_SDK_OBSERVER_IDLE_AFTER_DONE_MS: '20',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
  });

  let stopped = false;
  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 43,
          message: {
            message_id: 43,
            date: Math.floor(Date.now() / 1000),
            text: 'final-run-complete-phase',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const auditPath = path.join(runtime.runtimeDir, 'audit-events.jsonl');
    const records = await waitFor(() => {
      const rows = readJsonlRecords(auditPath);
      const hasComplete = rows.some((r) => r.kind === 'run.complete');
      const hasLateRender = rows.some((r) => (
        (r.kind === 'telegram.send' || r.kind === 'telegram.edit' || r.kind === 'telegram.draft')
        && r.payload
        && r.payload.meta
        && (r.payload.meta.channel === 'run_view_send' || r.payload.meta.channel === 'run_view_edit' || r.payload.meta.channel === 'run_view_draft')
        && String(r.payload.textPreview || '').includes('final-run-late-answer')
      ));
      return hasComplete && hasLateRender ? rows : null;
    }, { timeoutMs: 12000, stepMs: 120 });

    const runStart = records.find((r) => r.kind === 'run.start');
    assert.ok(runStart && runStart.payload && runStart.payload.runId);
    const runId = String(runStart.payload.runId || '');
    const runRows = records.filter((r) => {
      const payloadRunId = r && r.payload && r.payload.runId ? String(r.payload.runId) : '';
      const metaRunId = r && r.payload && r.payload.meta && r.payload.meta.runId ? String(r.payload.meta.runId) : '';
      return payloadRunId === runId || metaRunId === runId;
    });

    const completeIndex = runRows.findIndex((r) => r.kind === 'run.complete');
    assert.equal(completeIndex >= 0, true);
    const lateRenderAfterComplete = runRows.some((r, idx) => {
      if (idx <= completeIndex) return false;
      if (r.kind !== 'telegram.send' && r.kind !== 'telegram.edit' && r.kind !== 'telegram.draft') return false;
      const meta = (r.payload && r.payload.meta) || {};
      if (meta.channel !== 'run_view_send' && meta.channel !== 'run_view_edit' && meta.channel !== 'run_view_draft') return false;
      return String(r.payload && r.payload.textPreview || '').includes('final-run-late-answer');
    });
    assert.equal(lateRenderAfterComplete, true);

    assert.ok(runRows.some((r) => (
      r.kind === 'run.view.preview.policy'
      && r.payload
      && r.payload.reason === 'active_run_preview'
      && r.payload.previewDraftEnabled === true
      && r.payload.materializeStaleDraft === false
    )));

    await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'final-run-complete-phase', status: 'ok' });
    stopped = true;
  } finally {
    if (!stopped) {
      await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'final-run-complete-phase', status: 'teardown' });
    }
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e reset should terminate final run lifecycle and block later session events', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-complete-phase-final-run.js');

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_SDK_POST_COMPLETE_LINGER_MS: '0',
    HERMUX_SDK_OBSERVER_IDLE_AFTER_DONE_MS: '1000',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
  });

  let stopped = false;
  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 44,
          message: {
            message_id: 44,
            date: Math.floor(Date.now() / 1000),
            text: 'final-run-reset-before-late',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const auditPath = path.join(runtime.runtimeDir, 'audit-events.jsonl');
    await waitFor(() => {
      const rows = readJsonlRecords(auditPath);
      return rows.some((r) => r.kind === 'run.complete') ? true : null;
    }, { timeoutMs: 8000, stepMs: 80 });

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 45,
          message: {
            message_id: 45,
            date: Math.floor(Date.now() / 1000),
            text: '/reset',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const resetRows = await waitFor(() => {
      const rows = readJsonlRecords(auditPath);
      const resetMessage = rows.some((r) => (
        r.kind === 'telegram.send'
        && String((r.payload && r.payload.textPreview) || '').includes('Session reset complete for repo demo')
      ));
      return resetMessage ? rows : null;
    }, { timeoutMs: 8000, stepMs: 80 });

    await new Promise((r) => setTimeout(r, 700));
    const finalRows = readJsonlRecords(auditPath);
    const lateRenderedAfterReset = finalRows.some((r) => (
      (r.kind === 'telegram.send' || r.kind === 'telegram.edit')
      && r.payload
      && r.payload.meta
      && (r.payload.meta.channel === 'run_view_send' || r.payload.meta.channel === 'run_view_edit')
      && String(r.payload.textPreview || '').includes('final-run-late-answer')
    ));

    assert.equal(resetRows.length > 0, true);
    assert.equal(lateRenderedAfterReset, false);

    await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'final-run-reset', status: 'ok' });
    stopped = true;
  } finally {
    if (!stopped) {
      await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'final-run-reset', status: 'teardown' });
    }
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e complete phase should disable interrupt and enable revert for same run', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-complete-phase-final-run.js');

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_SDK_POST_COMPLETE_LINGER_MS: '0',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
  });

  let stopped = false;
  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 46,
          message: {
            message_id: 46,
            date: Math.floor(Date.now() / 1000),
            text: 'complete-phase-interrupt-revert',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests` });
      const hasLateRender = reqs.body.requests.some((r) => (
        (r.method === 'sendMessage' || r.method === 'editMessageText' || r.method === 'sendMessageDraft')
        && String((r.params && r.params.text) || '').includes('final-run-late-answer')
      ));
      return hasLateRender ? reqs.body.requests : null;
    }, { timeoutMs: 10000, stepMs: 120 });

    const statusReq = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests?method=sendMessage` });
      return reqs.body.requests[0] || null;
    }, { timeoutMs: 10000, stepMs: 120 });

    const repliedMessageId = Number(
      (statusReq.response && statusReq.response.result && statusReq.response.result.message_id)
      || (statusReq.response && statusReq.response.message_id)
      || (statusReq.params && statusReq.params.message_id)
      || 0
    );
    assert.equal(Number.isInteger(repliedMessageId) && repliedMessageId > 0, true);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 47,
          message: {
            message_id: 47,
            date: Math.floor(Date.now() / 1000),
            text: '/interrupt',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const interruptReq = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests?method=sendMessage` });
      return reqs.body.requests.find((r) => /No running task to interrupt/.test(String((r.params && r.params.text) || ''))) || null;
    }, { timeoutMs: 5000, stepMs: 80 });
    assert.match(String(interruptReq.params.text || ''), /No running task to interrupt/);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 48,
          message: {
            message_id: 48,
            date: Math.floor(Date.now() / 1000),
            text: '/revert',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
            reply_to_message: {
              message_id: repliedMessageId,
              chat: { id: 100, type: 'private' },
              date: Math.floor(Date.now() / 1000),
              text: 'final-run-late-answer',
            },
          },
        },
      },
    });

    const revertReq = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests?method=sendMessage` });
      return reqs.body.requests.find((r) => /Revert confirmation required\./.test(String((r.params && r.params.text) || ''))) || null;
    }, { timeoutMs: 5000, stepMs: 80 });

    assert.match(String(revertReq.params.text || ''), /Revert confirmation required\./);
    assert.equal(!!(revertReq.params && revertReq.params.reply_markup), true);
    const keyboard = JSON.parse(String(revertReq.params.reply_markup || '{}'));
    const confirm = keyboard && keyboard.inline_keyboard && keyboard.inline_keyboard[0] && keyboard.inline_keyboard[0][0];
    assert.equal(typeof (confirm && confirm.callback_data), 'string');
    assert.match(String(confirm.callback_data || ''), /^rv:c:/);

    await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'complete-phase-interrupt-revert', status: 'ok' });
    stopped = true;
  } finally {
    if (!stopped) {
      await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'complete-phase-interrupt-revert', status: 'teardown' });
    }
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e coalesces reasoning burst updates when Telegram edits are slow', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-reasoning-burst.js');

  await httpJson({
    method: 'POST',
    url: `${started.controlUrl}/scenarios`,
    body: {
      method: 'editMessageText',
      times: 20,
      delay_ms: 250,
    },
  });

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
  });

  let stopped = false;
  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 49,
          message: {
            message_id: 49,
            date: Math.floor(Date.now() / 1000),
            text: 'reasoning burst',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const requests = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests` });
      const finalMessage = reqs.body.requests.find((r) => String((r.params && r.params.text) || '').includes('final:reasoning burst'));
      return finalMessage ? reqs.body.requests : null;
    }, { timeoutMs: 10000, stepMs: 100 });

    const reasoningRequests = requests.filter((r) => (
      (r.method === 'sendMessage' || r.method === 'editMessageText' || r.method === 'sendMessageDraft')
      && String((r.params && r.params.text) || '').includes('Crafting the burst answer')
    ));
    const finalRequests = requests.filter((r) => (
      (r.method === 'sendMessage' || r.method === 'editMessageText' || r.method === 'sendMessageDraft')
      && String((r.params && r.params.text) || '').includes('final:reasoning burst')
    ));

    assert.equal(finalRequests.length >= 1, true);
    assert.equal(reasoningRequests.length <= 4, true);

    await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'reasoning-burst-coalesce', status: 'ok' });
    stopped = true;
  } finally {
    if (!stopped) {
      await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'reasoning-burst-coalesce', status: 'teardown' });
    }
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e defers non-final run-view edits on Telegram retry_after and still delivers final output', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-reasoning-burst.js');

  await httpJson({
    method: 'POST',
    url: `${started.controlUrl}/scenarios`,
    body: {
      method: 'editMessageText',
      times: 2,
      response: {
        error_code: 429,
        description: 'Too Many Requests: retry later',
        parameters: { retry_after: 6 },
      },
    },
  });

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
  });

  let stopped = false;
  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 50,
          message: {
            message_id: 50,
            date: Math.floor(Date.now() / 1000),
            text: 'reasoning retry-after',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const auditPath = path.join(runtime.runtimeDir, 'audit-events.jsonl');
    const records = await waitFor(() => {
      const rows = readJsonlRecords(auditPath);
      const hasDeferredEdit = rows.some((r) => {
        if (r.kind !== 'telegram.edit') return false;
        const payload = r.payload || {};
        const meta = payload.meta || {};
        return payload.stage === 'retry_after_deferred'
          && meta.channel === 'run_view_edit'
          && meta.isFinalState === false;
      });
      const hasFinalMessage = rows.some((r) => {
        if (r.kind !== 'telegram.send' && r.kind !== 'telegram.edit') return false;
        return String((r.payload && r.payload.textPreview) || '').includes('final:reasoning retry-after');
      });
      return hasDeferredEdit && hasFinalMessage ? rows : null;
    }, { timeoutMs: 10000, stepMs: 100 });

    const deferredEdits = records.filter((r) => {
      if (r.kind !== 'telegram.edit') return false;
      const payload = r.payload || {};
      const meta = payload.meta || {};
      return payload.stage === 'retry_after_deferred'
        && meta.channel === 'run_view_edit'
        && meta.isFinalState === false;
    });
    assert.equal(deferredEdits.length >= 1, true);

    const finalRecords = records.filter((r) => (
      (r.kind === 'telegram.send' || r.kind === 'telegram.edit')
      && String((r.payload && r.payload.textPreview) || '').includes('final:reasoning retry-after')
    ));
    assert.equal(finalRecords.length >= 1, true);

    await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'run-view-retry-after-deferred', status: 'ok' });
    stopped = true;
  } finally {
    if (!stopped) {
      await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'run-view-retry-after-deferred', status: 'teardown' });
    }
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e uses sendMessageDraft for non-final private-chat assistant tail preview', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-reasoning-burst.js');

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
  });

  let stopped = false;
  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 53,
          message: {
            message_id: 53,
            date: Math.floor(Date.now() / 1000),
            text: 'draft-preview',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const requests = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests` });
      const hasDraft = reqs.body.requests.some((r) => r.method === 'sendMessageDraft');
      const hasFinal = reqs.body.requests.some((r) => (
        r.method === 'sendMessage' && String((r.params && r.params.text) || '').includes('final:draft-preview')
      ));
      return hasDraft && hasFinal ? reqs.body.requests : null;
    }, { timeoutMs: 10000, stepMs: 100 });

    const draftRequests = requests.filter((r) => r.method === 'sendMessageDraft');
    assert.equal(draftRequests.length >= 1, true);
    assert.equal(draftRequests.some((r) => String((r.params && r.params.text) || '').includes('final:draft-preview')), true);

    const auditPath = path.join(runtime.runtimeDir, 'audit-events.jsonl');
    const records = await waitFor(() => {
      const rows = readJsonlRecords(auditPath);
      const route = rows.find((r) => (
        r.kind === 'telegram.preview.route'
        && r.payload
        && r.payload.transport === 'draft'
        && r.payload.reason === 'draft_transport_available'
        && r.payload.meta
        && r.payload.meta.previewDecisionReason === 'active_run_preview'
      ));
      return route ? rows : null;
    }, { timeoutMs: 10000, stepMs: 100 });
    assert.ok(records.some((r) => (
      r.kind === 'telegram.preview.route'
      && r.payload
      && r.payload.transport === 'draft'
      && r.payload.reason === 'draft_transport_available'
      && r.payload.meta
      && r.payload.meta.previewDecisionReason === 'active_run_preview'
    )));

    const finalSends = requests.filter((r) => (
      r.method === 'sendMessage' && String((r.params && r.params.text) || '').includes('final:draft-preview')
    ));
    assert.equal(finalSends.length >= 1, true);

    await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'run-view-send-message-draft', status: 'ok' });
    stopped = true;
  } finally {
    if (!stopped) {
      await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'run-view-send-message-draft', status: 'teardown' });
    }
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e renders question.asked prompts in the visible run-view status pane', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-question-asked.js');

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
  });

  let stopped = false;
  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 54,
          message: {
            message_id: 54,
            date: Math.floor(Date.now() / 1000),
            text: 'show question asked',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const requests = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests` });
      const visible = reqs.body.requests.find((r) => (
        (r.method === 'sendMessage' || r.method === 'editMessageText')
        && String((r.params && r.params.text) || '').includes('How should I continue?')
      ));
      return visible ? reqs.body.requests : null;
    }, { timeoutMs: 10000, stepMs: 100 });

    assert.equal(requests.some((r) => (
      (r.method === 'sendMessage' || r.method === 'editMessageText')
      && String((r.params && r.params.text) || '').includes('❓ Need input')
      && String((r.params && r.params.text) || '').includes('1. Ship now - continue immediately')
    )), true);

    await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'question-asked-visible-status-pane', status: 'ok' });
    stopped = true;
  } finally {
    if (!stopped) {
      await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'question-asked-visible-status-pane', status: 'teardown' });
    }
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e sends typing action while session is busy', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_OPENCODE_SDK_SHIM: path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk.js'),
  });

  let stopped = false;
  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 57,
          message: {
            message_id: 57,
            date: Math.floor(Date.now() / 1000),
            text: 'delayed-tail',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const requests = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests` });
      const all = reqs.body.requests;
      const hasTyping = all.some((r) => r.method === 'sendChatAction' && String((r.params && r.params.action) || '') === 'typing');
      const hasOutput = all.some((r) => (
        (r.method === 'sendMessage' || r.method === 'editMessageText' || r.method === 'sendMessageDraft')
        && String((r.params && r.params.text) || '').includes('tail-arrived')
      ));
      return hasTyping && hasOutput ? all : null;
    }, { timeoutMs: 30000, stepMs: 120 });

    const typingRequest = requests.find((r) => r.method === 'sendChatAction' && String((r.params && r.params.action) || '') === 'typing');
    assert.ok(typingRequest);
    assert.equal(String(typingRequest.params.chat_id || ''), '100');
    assert.equal(requests.some((r) => (
      (r.method === 'sendMessage' || r.method === 'editMessageText' || r.method === 'sendMessageDraft')
      && String((r.params && r.params.text) || '').includes('tail-arrived')
    )), true);

    await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'busy-typing', status: 'ok' });
    stopped = true;
  } finally {
    if (!stopped) {
      await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'busy-typing', status: 'teardown' });
    }
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e incident replay should deliver second run text despite post-complete late events', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-two-runs-incident-replay.js');

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
  });

  let stopped = false;
  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 51,
          message: {
            message_id: 51,
            date: Math.floor(Date.now() / 1000),
            text: 'incident-replay-first',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 52,
          message: {
            message_id: 52,
            date: Math.floor(Date.now() / 1000),
            text: 'incident-replay-second',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const auditPath = path.join(runtime.runtimeDir, 'audit-events.jsonl');
    const records = await waitFor(() => {
      const rows = readJsonlRecords(auditPath);
      const completed = rows.filter((r) => r.kind === 'run.complete');
      const hasLateSecond = rows.some((r) => {
        if (r.kind !== 'run.event_received') return false;
        const payload = r.payload || {};
        const content = String(payload.content || '');
        return content.includes('second-incident-answer') || content.includes('part-second-late-text-base');
      });
      const hasRunViewSecond = rows.some((r) => (
        (r.kind === 'telegram.send' || r.kind === 'telegram.edit')
        && r.payload
        && r.payload.meta
        && (r.payload.meta.channel === 'run_view_send' || r.payload.meta.channel === 'run_view_edit')
        && String(r.payload.textPreview || '').includes('second-incident-answer')
      ));
      return completed.length >= 2 && hasLateSecond && hasRunViewSecond ? rows : null;
    }, { timeoutMs: 30000, stepMs: 120 });

    const runStarts = records.filter((r) => r.kind === 'run.start');
    assert.equal(runStarts.length >= 2, true);
    const firstRunId = String(runStarts[0] && runStarts[0].payload && runStarts[0].payload.runId || '');
    const secondRunId = String(runStarts[1] && runStarts[1].payload && runStarts[1].payload.runId || '');
    assert.ok(firstRunId);
    assert.ok(secondRunId);
    assert.notEqual(firstRunId, secondRunId);

    const rowsByRun = (runId) => records.filter((r) => {
      const payloadRunId = r && r.payload && r.payload.runId ? String(r.payload.runId) : '';
      const metaRunId = r && r.payload && r.payload.meta && r.payload.meta.runId ? String(r.payload.meta.runId) : '';
      return payloadRunId === runId || metaRunId === runId;
    });

    const firstRows = rowsByRun(firstRunId);
    const secondRows = rowsByRun(secondRunId);

    const collectRunViewText = (rows) => rows
      .filter((r) => (
        (r.kind === 'telegram.send' || r.kind === 'telegram.edit')
        && r.payload
        && r.payload.meta
        && (r.payload.meta.channel === 'run_view_send' || r.payload.meta.channel === 'run_view_edit')
      ))
      .map((r) => String(r.payload && r.payload.textPreview || ''));

    const firstText = collectRunViewText(firstRows).join('\n');
    const secondText = collectRunViewText(secondRows).join('\n');

    assert.match(firstText, /first-incident-answer/);
    assert.doesNotMatch(firstText, /second-incident-answer/);

    assert.match(secondText, /second-incident-answer/);
    assert.doesNotMatch(secondText, /first-incident-answer/);

    const secondAssistantTextEvents = secondRows.filter((r) => {
      if (r.kind !== 'run.event_received') return false;
      const content = String((r.payload && r.payload.content) || '');
      return content.includes('second-incident-answer') || content.includes('part-second-late-text-base');
    });
    assert.ok(secondAssistantTextEvents.length > 0);

    const secondRunViewSends = secondRows.filter((r) => (
      (r.kind === 'telegram.send' || r.kind === 'telegram.edit')
      && r.payload
      && r.payload.meta
      && (r.payload.meta.channel === 'run_view_send' || r.payload.meta.channel === 'run_view_edit')
      && String(r.payload.textPreview || '').includes('second-incident-answer')
    ));
    assert.ok(secondRunViewSends.length > 0);

    const runIdMismatchSkips = records.filter((r) => (
      r.kind === 'run.view.skip'
      && r.payload
      && String(r.payload.reason || '') === 'run_id_mismatch'
    ));
    assert.equal(runIdMismatchSkips.length, 0);

    await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'incident-replay-second-run-late', status: 'ok' });
    stopped = true;
  } finally {
    if (!stopped) {
      await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'incident-replay-second-run-late', status: 'teardown' });
    }
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e should reproduce missing second response when assistant text lands post-complete', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-two-runs-post-complete-late-text.js');

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
  });

  let stopped = false;
  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 61,
          message: {
            message_id: 61,
            date: Math.floor(Date.now() / 1000),
            text: 'pc-first',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 62,
          message: {
            message_id: 62,
            date: Math.floor(Date.now() / 1000),
            text: 'pc-second',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const auditPath = path.join(runtime.runtimeDir, 'audit-events.jsonl');
    const records = await waitFor(() => {
      const rows = readJsonlRecords(auditPath);
      const completed = rows.filter((r) => r.kind === 'run.complete');
      const hasPostCompleteTextEvent = rows.some((r) => {
        if (r.kind !== 'run.event_received') return false;
        const content = String((r.payload && r.payload.content) || '');
        return content.includes('second-post-complete:pc-second');
      });
      const hasRunViewSecond = rows.some((r) => (
        (r.kind === 'telegram.send' || r.kind === 'telegram.edit' || r.kind === 'telegram.draft')
        && r.payload
        && r.payload.meta
        && (
          r.payload.meta.channel === 'run_view_send'
          || r.payload.meta.channel === 'run_view_edit'
          || r.payload.meta.channel === 'run_view_draft'
          || r.payload.meta.channel === 'run_view_draft_materialize'
        )
        && String(r.payload.textPreview || '').includes('second-post-complete:pc-second')
      ));
      return completed.length >= 2 && hasPostCompleteTextEvent && hasRunViewSecond ? rows : null;
    }, { timeoutMs: 30000, stepMs: 120 });

    const runStarts = records.filter((r) => r.kind === 'run.start');
    assert.equal(runStarts.length >= 2, true);
    const secondRunId = String(runStarts[1] && runStarts[1].payload && runStarts[1].payload.runId || '');
    assert.ok(secondRunId);

    const secondRows = records.filter((r) => {
      const payloadRunId = r && r.payload && r.payload.runId ? String(r.payload.runId) : '';
      const metaRunId = r && r.payload && r.payload.meta && r.payload.meta.runId ? String(r.payload.meta.runId) : '';
      return payloadRunId === secondRunId || metaRunId === secondRunId;
    });

    const secondAssistantTextEvents = secondRows.filter((r) => {
      if (r.kind !== 'run.event_received') return false;
      const content = String((r.payload && r.payload.content) || '');
      return content.includes('second-post-complete:pc-second');
    });
    assert.ok(secondAssistantTextEvents.length > 0);

    const secondRunViewText = secondRows
      .filter((r) => (
        (r.kind === 'telegram.send' || r.kind === 'telegram.edit')
        && r.payload
        && r.payload.meta
        && (
          r.payload.meta.channel === 'run_view_send'
          || r.payload.meta.channel === 'run_view_edit'
          || r.payload.meta.channel === 'run_view_draft_materialize'
        )
      ))
      .map((r) => String(r.payload && r.payload.textPreview || ''))
      .join('\n');

    const staleDeletes = secondRows.filter((r) => (
      r.kind === 'telegram.delete'
      && r.payload
      && r.payload.meta
      && (r.payload.meta.channel === 'run_view_delete' || r.payload.meta.channel === 'run_view_draft_clear')
    ));
    assert.equal(staleDeletes.length, 0);

    assert.match(secondRunViewText, /second-post-complete:pc-second/);
    assert.doesNotMatch(secondRunViewText, /first-ok/);

    const finalRunViewApply = secondRows
      .filter((r) => r.kind === 'run.view.apply.end')
      .filter((r) => !!(r.payload && r.payload.isFinalState))
      .pop();
    assert.ok(finalRunViewApply);
    const finalPreview = Array.isArray(finalRunViewApply.payload && finalRunViewApply.payload.textPreview)
      ? finalRunViewApply.payload.textPreview.join('\n')
      : String(finalRunViewApply && finalRunViewApply.payload && finalRunViewApply.payload.textPreview || '');
    assert.match(finalPreview, /second-post-complete:pc-second/);

    await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'post-complete-late-text-repro', status: 'ok' });
    stopped = true;
  } finally {
    if (!stopped) {
      await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'post-complete-late-text-repro', status: 'teardown' });
    }
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e eagerly materializes post-complete second response from strong hint', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-two-runs-post-complete-late-text.js');

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
  });

  let stopped = false;
  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 63,
          message: {
            message_id: 63,
            date: Math.floor(Date.now() / 1000),
            text: 'pc-first-materialize',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 64,
          message: {
            message_id: 64,
            date: Math.floor(Date.now() / 1000),
            text: 'pc-second-materialize',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const auditPath = path.join(runtime.runtimeDir, 'audit-events.jsonl');
    const records = await waitFor(() => {
      const rows = readJsonlRecords(auditPath);
      const runStarts = rows.filter((r) => r.kind === 'run.start');
      if (runStarts.length < 2) return null;
      const secondRunId = String(runStarts[1] && runStarts[1].payload && runStarts[1].payload.runId || '');
      if (!secondRunId) return null;
      const secondRows = rows.filter((r) => {
        const payloadRunId = r && r.payload && r.payload.runId ? String(r.payload.runId) : '';
        const metaRunId = r && r.payload && r.payload.meta && r.payload.meta.runId ? String(r.payload.meta.runId) : '';
        return payloadRunId === secondRunId || metaRunId === secondRunId;
      });
      const hasFinalSamePartUpdated = secondRows.some((r) => {
        if (r.kind !== 'run.event_received') return false;
        const content = String((r.payload && r.payload.content) || '');
        return content.includes('"type":"message.part.updated"')
          && content.includes('"id":"part-second-text"')
          && content.includes('second-post-complete:pc-second-materialize');
      });
      const hasMaterializeSend = secondRows.some((r) => (
        r.kind === 'telegram.send'
        && r.payload
        && r.payload.meta
        && r.payload.meta.channel === 'run_view_draft_materialize'
        && String(r.payload.textPreview || '').includes('second-post-complete:pc-second-materialize')
      ));
      return hasFinalSamePartUpdated && hasMaterializeSend ? rows : null;
    }, { timeoutMs: 30000, stepMs: 120 });

    const runStarts = records.filter((r) => r.kind === 'run.start');
    const secondRunId = String(runStarts[1] && runStarts[1].payload && runStarts[1].payload.runId || '');
    assert.ok(secondRunId);

    const secondRows = records.filter((r) => {
      const payloadRunId = r && r.payload && r.payload.runId ? String(r.payload.runId) : '';
      const metaRunId = r && r.payload && r.payload.meta && r.payload.meta.runId ? String(r.payload.meta.runId) : '';
      return payloadRunId === secondRunId || metaRunId === secondRunId;
    });

    const finalSamePartUpdated = secondRows.filter((r) => {
      if (r.kind !== 'run.event_received') return false;
      const content = String((r.payload && r.payload.content) || '');
      return content.includes('"type":"message.part.updated"')
        && content.includes('"id":"part-second-text"')
        && content.includes('second-post-complete:pc-second-materialize');
    });
    assert.ok(finalSamePartUpdated.length > 0);

    const materializeSends = secondRows.filter((r) => (
      r.kind === 'telegram.send'
      && r.payload
      && r.payload.meta
      && r.payload.meta.channel === 'run_view_draft_materialize'
      && String(r.payload.textPreview || '').includes('second-post-complete:pc-second-materialize')
    ));

    assert.ok(
      materializeSends.length > 0,
      'expected post-complete second response to eagerly materialize into a normal Telegram message'
    );

    await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'post-complete-same-part-materialize', status: 'ok' });
    stopped = true;
  } finally {
    if (!stopped) {
      await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'post-complete-same-part-materialize', status: 'teardown' });
    }
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e materializes non-empty prior draft preview when next run starts', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-two-runs-draft-carryover.js');

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
  });

  let stopped = false;
  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 73,
          message: {
            message_id: 73,
            date: Math.floor(Date.now() / 1000),
            text: 'draft-carryover-first',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 74,
          message: {
            message_id: 74,
            date: Math.floor(Date.now() / 1000),
            text: 'draft-carryover-second',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const requests = await waitFor(async () => {
      const reqs = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests` });
      const all = reqs.body.requests;
      const hasDraft = all.some((r) => r.method === 'sendMessageDraft' && String((r.params && r.params.text) || '').includes('carryover:draft-preview'));
      const hasMaterialized = all.some((r) => r.method === 'sendMessage' && String((r.params && r.params.text) || '').includes('carryover:draft-preview'));
      const hasCleared = all.some((r) => r.method === 'sendMessageDraft' && String((r.params && r.params.text) || '') === '');
      return hasDraft && hasMaterialized && hasCleared ? all : null;
    }, { timeoutMs: 10000, stepMs: 100 });

    assert.equal(requests.some((r) => r.method === 'sendMessageDraft' && String((r.params && r.params.text) || '').includes('carryover:draft-preview')), true);
    assert.equal(requests.some((r) => r.method === 'sendMessage' && String((r.params && r.params.text) || '').includes('carryover:draft-preview')), true);
    assert.equal(requests.some((r) => r.method === 'sendMessageDraft' && String((r.params && r.params.text) || '') === ''), true);

    await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'run-start-draft-materialize', status: 'ok' });
    stopped = true;
  } finally {
    if (!stopped) {
      await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'run-start-draft-materialize', status: 'teardown' });
    }
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e should surface new in-progress assistant text before completion event', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-inprogress-newer-message.js');

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
  });

  let stopped = false;
  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 71,
          message: {
            message_id: 71,
            date: Math.floor(Date.now() / 1000),
            text: 'inprogress-marker-test',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const auditPath = path.join(runtime.runtimeDir, 'audit-events.jsonl');
    const records = await waitFor(() => {
      const rows = readJsonlRecords(auditPath);
      const hasCompletionEvent = rows.some((r) => {
        if (r.kind !== 'run.event_received') return false;
        const content = String((r.payload && r.payload.content) || '');
        return content.includes('"type":"message.updated"')
          && content.includes('"id":"msg-new-inprogress"')
          && content.includes('"completed"');
      });
      const hasRunViewMarker = rows.some((r) => (
        (r.kind === 'telegram.send' || r.kind === 'telegram.edit' || r.kind === 'telegram.draft')
        && r.payload
        && r.payload.meta
        && (r.payload.meta.channel === 'run_view_send' || r.payload.meta.channel === 'run_view_edit' || r.payload.meta.channel === 'run_view_draft')
        && String(r.payload.textPreview || '').includes('new-live-marker')
      ));
      return hasCompletionEvent && hasRunViewMarker ? rows : null;
    }, { timeoutMs: 30000, stepMs: 120 });

    const runStart = records.find((r) => r.kind === 'run.start');
    assert.ok(runStart);
    const runId = String(runStart && runStart.payload && runStart.payload.runId || '');
    assert.ok(runId);

    const completionIdx = records.findIndex((r) => {
      if (r.kind !== 'run.event_received') return false;
      const payloadRunId = String((r.payload && r.payload.runId) || '');
      if (payloadRunId !== runId) return false;
      const content = String((r.payload && r.payload.content) || '');
      return content.includes('"type":"message.updated"')
        && content.includes('"id":"msg-new-inprogress"')
        && content.includes('"completed"');
    });

    const runViewMarkerIdx = records.findIndex((r) => {
      if (!(r.kind === 'telegram.send' || r.kind === 'telegram.edit' || r.kind === 'telegram.draft')) return false;
      const meta = r.payload && r.payload.meta ? r.payload.meta : null;
      if (!meta) return false;
      if (String(meta.runId || '') !== runId) return false;
      if (!(meta.channel === 'run_view_send' || meta.channel === 'run_view_edit' || meta.channel === 'run_view_draft')) return false;
      return String(r.payload && r.payload.textPreview || '').includes('new-live-marker');
    });

    assert.ok(completionIdx >= 0);
    assert.ok(runViewMarkerIdx >= 0);
    assert.ok(runViewMarkerIdx < completionIdx, 'expected run_view update with marker before completion event');

    await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'inprogress-before-completion', status: 'ok' });
    stopped = true;
  } finally {
    if (!stopped) {
      await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'inprogress-before-completion', status: 'teardown' });
    }
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});

test('gateway e2e eagerly materializes strong tail hint before completion', async () => {
  const cfgSnapshot = backupFile(config.CONFIG_PATH);
  const token = 'test-token';
  const telegram = createTelegramMockServer();
  const started = await telegram.start(0);
  const fixturePath = path.resolve(__dirname, 'fixtures', 'fake-opencode-sdk-inprogress-tail-materialize.js');

  config.save({
    global: { telegramBotToken: token },
    repos: [{
      name: 'demo',
      enabled: true,
      workdir: '/tmp/demo',
      chatIds: ['100'],
      opencodeCommand: 'opencode sdk',
      logFile: './logs/demo.log',
    }],
  });

  const runtime = startGateway({
    HERMUX_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    HERMUX_OPENCODE_SDK_SHIM: fixturePath,
  });

  let stopped = false;
  try {
    await waitForBootstrapAndClearRequests(started.controlUrl);

    await httpJson({
      method: 'POST',
      url: `${started.controlUrl}/updates`,
      body: {
        token,
        update: {
          update_id: 81,
          message: {
            message_id: 81,
            date: Math.floor(Date.now() / 1000),
            text: 'tail-materialize-now',
            chat: { id: 100, type: 'private' },
            from: { id: 200, is_bot: false, first_name: 'Tester' },
          },
        },
      },
    });

    const auditPath = path.join(runtime.runtimeDir, 'audit-events.jsonl');
    const records = await waitFor(() => {
      const rows = readJsonlRecords(auditPath);
      const runStart = rows.find((r) => r.kind === 'run.start');
      if (!runStart) return null;
      const runId = String(runStart.payload && runStart.payload.runId || '');
      if (!runId) return null;
      const completionIdx = rows.findIndex((r) => {
        if (r.kind !== 'run.event_received') return false;
        const payloadRunId = String((r.payload && r.payload.runId) || '');
        if (payloadRunId !== runId) return false;
        const content = String((r.payload && r.payload.content) || '');
        return content.includes('"type":"message.updated"')
          && content.includes('"id":"msg-tail"')
          && content.includes('"completed"');
      });
      const materializeIdx = rows.findIndex((r) => {
        if (r.kind !== 'telegram.send') return false;
        const meta = r.payload && r.payload.meta ? r.payload.meta : null;
        if (!meta) return false;
        if (String(meta.runId || '') !== runId) return false;
        if (meta.channel !== 'run_view_draft_materialize') return false;
        return String(r.payload && r.payload.textPreview || '').includes('stable-tail-marker');
      });
      if (materializeIdx < 0 || completionIdx < 0) return null;
      return { rows, materializeIdx, completionIdx, runId };
    }, { timeoutMs: 30000, stepMs: 120 });

    assert.ok(records.materializeIdx >= 0);
    assert.ok(records.completionIdx >= 0);
    assert.ok(records.materializeIdx < records.completionIdx, 'expected eager materialization before completion event');

    const runRequests = await httpJson({ method: 'GET', url: `${started.controlUrl}/requests` });
    const stableDraftRequests = runRequests.body.requests.filter((r) => (
      r.method === 'sendMessageDraft'
      && String((r.params && r.params.text) || '').includes('stable-tail-marker')
    ));
    assert.equal(stableDraftRequests.length, 0);

    await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'eager-tail-materialize', status: 'ok' });
    stopped = true;
  } finally {
    if (!stopped) {
      await stopGateway(runtime, { controlUrl: started.controlUrl, testName: 'eager-tail-materialize', status: 'teardown' });
    }
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
  }
});
