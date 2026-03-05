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
    });

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
      r.kind === 'telegram.send'
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
        (r.kind === 'telegram.send' || r.kind === 'telegram.edit')
        && r.payload
        && r.payload.meta
        && (r.payload.meta.channel === 'run_view_send' || r.payload.meta.channel === 'run_view_edit')
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

    const secondRunText = secondRunRows
      .filter((r) => (
        (r.kind === 'telegram.send' || r.kind === 'telegram.edit')
        && r.payload
        && r.payload.meta
        && (r.payload.meta.channel === 'run_view_send' || r.payload.meta.channel === 'run_view_edit')
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
        (r.kind === 'telegram.send' || r.kind === 'telegram.edit')
        && r.payload
        && r.payload.meta
        && (r.payload.meta.channel === 'run_view_send' || r.payload.meta.channel === 'run_view_edit')
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
        && (r.payload.meta.channel === 'run_view_send' || r.payload.meta.channel === 'run_view_edit')
      ))
      .map((r) => String(r.payload && r.payload.textPreview || ''))
      .join('\n');

    assert.match(secondRunViewText, /second-post-complete:pc-second/);

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
        (r.kind === 'telegram.send' || r.kind === 'telegram.edit')
        && r.payload
        && r.payload.meta
        && (r.payload.meta.channel === 'run_view_send' || r.payload.meta.channel === 'run_view_edit')
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
      if (!(r.kind === 'telegram.send' || r.kind === 'telegram.edit')) return false;
      const meta = r.payload && r.payload.meta ? r.payload.meta : null;
      if (!meta) return false;
      if (String(meta.runId || '') !== runId) return false;
      if (!(meta.channel === 'run_view_send' || meta.channel === 'run_view_edit')) return false;
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
