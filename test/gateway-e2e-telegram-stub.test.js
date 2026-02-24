const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

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
  const child = spawn(process.execPath, ['src/gateway.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  return { child, getOutput: () => ({ stdout, stderr }) };
}

async function stopGateway(child) {
  if (child.killed || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(resolve, 4000);
  });
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
    OMG_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    OMG_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
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
    await stopGateway(runtime.child);
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
    OMG_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    OMG_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
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
    await stopGateway(runtime.child);
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
    OMG_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    OMG_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
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
    await stopGateway(runtime.child);
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
    OMG_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    OMG_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
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
    await stopGateway(runtime.child);
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
    OMG_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    OMG_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
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
    await stopGateway(runtime.child);
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
    OMG_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    OMG_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
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
    await stopGateway(runtime.child);
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
    OMG_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    OMG_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
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
    await stopGateway(runtime.child);
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
    OMG_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    OMG_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    OMG_OPENCODE_SDK_SHIM: fixturePath,
    OMG_RUNTIME_DIR: runtimeDir,
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
      const hasFinalization = rows.some((r) => r.kind === 'run.finalization');
      const hasComplete = rows.some((r) => r.kind === 'run.complete');
      return hasFinalization && hasComplete ? rows : null;
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
    const finalizationIndex = runRows.findIndex((r) => r.kind === 'run.finalization');
    assert.ok(finalizationIndex >= 0);

    const afterFinalization = runRows.slice(finalizationIndex + 1);
    const lateFinalUnitSends = afterFinalization.filter((r) => (
      r.kind === 'telegram.send'
      && r.payload
      && r.payload.meta
      && r.payload.meta.channel === 'final_unit'
    ));

    assert.equal(lateFinalUnitSends.length, 0);
  } finally {
    await stopGateway(runtime.child);
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('gateway e2e renders reminders in status panel and strips OMO markers from final_unit', async () => {
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
    OMG_TELEGRAM_BASE_API_URL: started.baseApiUrl,
    OMG_TELEGRAM_POLLING_TIMEOUT_SECONDS: '0',
    OMG_OPENCODE_SDK_SHIM: fixturePath,
    OMG_RUNTIME_DIR: runtimeDir,
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
    assert.equal(panelUpdates.length > 0, true);
    const reminderInPanel = panelUpdates.some((r) => /reminder-latest/.test(String(r.payload && r.payload.textPreview || '')));
    assert.equal(reminderInPanel, true);

    const finalOutputs = runRows.filter((r) => (
      r.kind === 'telegram.send'
      && r.payload
      && r.payload.meta
      && (
        r.payload.meta.channel === 'final_unit'
        || r.payload.meta.channel === 'final_reconcile_send'
        || r.payload.meta.channel === 'final_output'
      )
    ));
    assert.equal(finalOutputs.length > 0, true);
    const leakedMarker = finalOutputs.some((r) => /OMO_INTERNAL_INITIATOR/.test(String(r.payload && r.payload.textPreview || '')));
    assert.equal(leakedMarker, false);
  } finally {
    await stopGateway(runtime.child);
    await telegram.stop();
    restoreFile(config.CONFIG_PATH, cfgSnapshot);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
