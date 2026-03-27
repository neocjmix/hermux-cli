'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { createHash } = require('crypto');
const { pathToFileURL } = require('url');
const { HERMUX_VERSION } = require('../../../lib/hermux-version');

const MAX_PROCESS_SEC = parseInt(process.env.HERMUX_MAX_PROCESS_SECONDS || '3600', 10);
const SDK_SERVER_START_TIMEOUT_MS = parseInt(process.env.HERMUX_SDK_SERVER_START_TIMEOUT_MS || '15000', 10);
const SDK_PORT_RANGE_MIN = parseInt(process.env.HERMUX_SDK_PORT_RANGE_MIN || '43100', 10);
const SDK_PORT_RANGE_MAX = parseInt(process.env.HERMUX_SDK_PORT_RANGE_MAX || '43999', 10);
const SDK_PORT_PICK_ATTEMPTS = parseInt(process.env.HERMUX_SDK_PORT_PICK_ATTEMPTS || '60', 10);
const SDK_IDLE_DRAIN_MS = parseInt(process.env.HERMUX_SDK_IDLE_DRAIN_MS || '220', 10);
const SDK_POST_COMPLETE_LINGER_MS = parseInt(process.env.HERMUX_SDK_POST_COMPLETE_LINGER_MS || '2200', 10);
const SDK_RAW_PASSTHROUGH = true;

const activeRuns = new Set();
const runtimeStats = new Map();
const sdkRuntimes = new Map();
const sdkRuntimeOps = new Map();
let stopAllInProgress = false;
const SESSION_EVENT_BUFFER_LIMIT = parseInt(process.env.HERMUX_SESSION_EVENT_BUFFER_LIMIT || '200', 10);

function parseRetryAfterSeconds(text) {
  const src = String(text || '');
  const secMatch = src.match(/retry(?:_|\s+)after[^0-9]{0,8}(\d{1,6})\s*s/i);
  if (secMatch) return Number(secMatch[1]);
  const bareMatch = src.match(/retry(?:_|\s+)after[^0-9]{0,8}(\d{1,6})/i);
  if (bareMatch) return Number(bareMatch[1]);
  return null;
}

function maybeCaptureRateLimit(state, line) {
  const src = String(line || '');
  if (!src) return;
  if (!/(rate\s*limit|too\s*many\s*requests|quota\s*exceeded|\b429\b)/i.test(src)) return;
  state.rateLimit = {
    detected: true,
    line: src,
    retryAfterSeconds: parseRetryAfterSeconds(src),
  };
}

function setupLogStream(instance, prompt) {
  const logDir = path.dirname(path.resolve(instance.logFile || './logs/default.log'));
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.resolve(instance.logFile || './logs/default.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n--- ${new Date().toISOString()} | prompt: ${prompt} ---\n`);
  return { logStream };
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function toValidPortRange() {
  const min = Number.isInteger(SDK_PORT_RANGE_MIN) ? SDK_PORT_RANGE_MIN : 43100;
  const max = Number.isInteger(SDK_PORT_RANGE_MAX) ? SDK_PORT_RANGE_MAX : 43999;
  if (min > 0 && max > 0 && min <= max && max <= 65535) {
    return { min, max };
  }
  return { min: 43100, max: 43999 };
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => {
      resolve(false);
    });
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

async function pickRandomAvailablePortInRange() {
  const range = toValidPortRange();
  const attempts = Number.isInteger(SDK_PORT_PICK_ATTEMPTS) && SDK_PORT_PICK_ATTEMPTS > 0
    ? SDK_PORT_PICK_ATTEMPTS
    : 60;

  for (let i = 0; i < attempts; i++) {
    const candidate = randomInt(range.min, range.max);
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }

  throw new Error(`failed to find available port in ${range.min}-${range.max} after ${attempts} attempts`);
}

function getRuntimeScopeKey(instance) {
  const repoName = String(instance && instance.name ? instance.name : '').trim();
  const workdir = path.resolve(String(instance && instance.workdir ? instance.workdir : '.'));
  if (repoName) return `${repoName}::${workdir}`;
  return `workdir::${workdir}`;
}

function getRuntimeStat(instance) {
  const key = getRuntimeScopeKey(instance);
  if (!runtimeStats.has(key)) {
    runtimeStats.set(key, {
      key,
      activeRuns: 0,
      transport: 'idle',
      lastStartedAt: 0,
    });
  }
  return runtimeStats.get(key);
}

function beginRuntimeRun(instance, transport, handle) {
  const stat = getRuntimeStat(instance);
  stat.activeRuns += 1;
  stat.transport = transport;
  stat.lastStartedAt = Date.now();
  activeRuns.add(handle);
}

function endRuntimeRun(instance, handle) {
  const stat = getRuntimeStat(instance);
  stat.activeRuns = Math.max(0, stat.activeRuns - 1);
  if (stat.activeRuns === 0) stat.transport = 'idle';
  activeRuns.delete(handle);
}

function getRuntimeStatusForInstance(instance) {
  const key = getRuntimeScopeKey(instance);
  const stat = runtimeStats.get(key);
  if (!stat) {
    return {
      active: false,
      key,
      transport: 'idle',
      activeRuns: 0,
      lastStartedAt: null,
    };
  }

  return {
    active: stat.activeRuns > 0,
    key,
    transport: stat.transport,
    activeRuns: stat.activeRuns,
    lastStartedAt: stat.lastStartedAt || null,
  };
}

async function stopAllRuntimeExecutors() {
  stopAllInProgress = true;
  try {
    for (const handle of Array.from(activeRuns)) {
      try {
        handle.kill('SIGTERM');
        handle.kill('SIGKILL');
      } catch (_err) {
      }
    }
    for (const [scopeKey, entry] of Array.from(sdkRuntimes.entries())) {
      sdkRuntimes.delete(scopeKey);
      // eslint-disable-next-line no-await-in-loop
      await closeSdkRuntimeEntry(entry);
    }
  } finally {
    stopAllInProgress = false;
  }
}

function shouldUseSdk(instance) {
  const forced = String(process.env.HERMUX_EXECUTION_TRANSPORT || '').trim().toLowerCase();
  if (forced === 'command') {
    throw new Error('command transport was removed; use sdk transport only');
  }
  return true;
}

let sdkModulePromise = null;

async function loadSdkModule() {
  if (!sdkModulePromise) {
    const shim = String(process.env.HERMUX_OPENCODE_SDK_SHIM || '').trim();
    if (shim) {
      sdkModulePromise = import(pathToFileURL(path.resolve(shim)).href)
        .then((mod) => (mod && mod.default && mod.default.createOpencode ? mod.default : mod));
    } else {
      sdkModulePromise = import('@opencode-ai/sdk/v2');
    }
  }
  return sdkModulePromise;
}

function runSdkRuntimeOpExclusive(scopeKey, task) {
  const prev = sdkRuntimeOps.get(scopeKey) || Promise.resolve();
  const run = prev.then(task, task);
  const marker = run.catch(() => {});
  sdkRuntimeOps.set(scopeKey, marker);
  return run.finally(() => {
    if (sdkRuntimeOps.get(scopeKey) === marker) sdkRuntimeOps.delete(scopeKey);
  });
}

async function createSdkRuntimeForScope(scopeKey) {
  const sdk = await loadSdkModule();
  if (!sdk || typeof sdk.createOpencode !== 'function') {
    throw new Error('failed to load sdk createOpencode');
  }

  const sdkPort = await pickRandomAvailablePortInRange();
  const runtime = await sdk.createOpencode({
    hostname: '127.0.0.1',
    port: sdkPort,
    timeout: SDK_SERVER_START_TIMEOUT_MS,
  });
  const client = runtime && runtime.client ? runtime.client : null;
  if (!client) {
    if (runtime && runtime.server && typeof runtime.server.close === 'function') {
      try {
        runtime.server.close();
      } catch (_err) {
      }
    }
    throw new Error('sdk runtime missing client');
  }

  return {
    scopeKey,
    runtime,
    client,
    port: sdkPort,
    startedAt: Date.now(),
    eventCursor: 0,
    subscriptionEpoch: 0,
    serverEpoch: 1,
    pumpPromise: null,
    pumpReadyPromise: null,
    eventStream: null,
    observersBySession: new Map(),
    sessionBuffers: new Map(),
    runLifecycleBySession: new Map(),
    auditPath: '',
    auditQueue: Promise.resolve(),
  };
}

async function closeSdkRuntimeEntry(entry) {
  if (!entry) return;
  entry.pumpPromise = null;
  entry.pumpReadyPromise = null;
  entry.eventStream = null;
  entry.observersBySession = new Map();
  entry.sessionBuffers = new Map();
  entry.runLifecycleBySession = new Map();
  const runtime = entry.runtime;
  if (runtime && runtime.server && typeof runtime.server.close === 'function') {
    try {
      await Promise.resolve(runtime.server.close());
    } catch (_err) {
    }
  }
}

function resolveAuditPath(instance) {
  const logFile = String((instance && instance.logFile) || '').trim();
  if (!logFile) return '';
  return path.resolve(logFile);
}

function queueScopeAudit(entry, instance, kind, payload) {
  const auditPath = resolveAuditPath(instance) || entry.auditPath || '';
  if (!auditPath) return;
  entry.auditPath = auditPath;
  const dir = path.dirname(auditPath);
  const line = `[router] ${JSON.stringify({
    ts: new Date().toISOString(),
    hermuxVersion: HERMUX_VERSION,
    kind,
    scopeKey: entry.scopeKey,
    serverEpoch: entry.serverEpoch,
    subscriptionEpoch: entry.subscriptionEpoch,
    eventCursor: entry.eventCursor,
    payload: payload || {},
  })}\n`;
  entry.auditQueue = entry.auditQueue
    .then(() => fs.promises.mkdir(dir, { recursive: true }))
    .then(() => fs.promises.appendFile(auditPath, line))
    .catch(() => {});
}

function resolveSessionIdentity(evt) {
  const type = String((evt && evt.type) || '');
  const props = (evt && evt.properties) || {};
  const part = props.part || {};
  const info = props.info || {};
  const candidates = [
    String(props.sessionID || '').trim(),
    String(part.sessionID || '').trim(),
    String(info.sessionID || '').trim(),
  ].filter(Boolean);
  if (type.startsWith('session.') && String(info.id || '').trim()) {
    candidates.push(String(info.id || '').trim());
  }
  const sessionId = candidates[0] || '';
  return {
    type,
    sessionId,
    messageId: String(props.messageID || part.messageID || '').trim(),
    partId: String(props.partID || part.id || '').trim(),
    lane: sessionId ? 'session' : 'global',
  };
}

function pushBufferedSessionEvent(entry, sessionId, framedEvent) {
  if (!sessionId) return;
  const current = entry.sessionBuffers.get(sessionId) || [];
  current.push(framedEvent);
  const max = Number.isInteger(SESSION_EVENT_BUFFER_LIMIT) && SESSION_EVENT_BUFFER_LIMIT > 0
    ? SESSION_EVENT_BUFFER_LIMIT
    : 200;
  if (current.length > max) {
    current.splice(0, current.length - max);
  }
  entry.sessionBuffers.set(sessionId, current);
}

function addSessionObserver(entry, sessionId, observer, instance, options) {
  const sid = String(sessionId || '').trim();
  if (!sid) {
    throw new Error('cannot add session observer without session id');
  }
  const replayBuffered = !options || options.replayBuffered !== false;
  const dropBufferedOnDetach = !!(options && options.dropBufferedOnDetach);
  let set = entry.observersBySession.get(sid);
  if (!set) {
    set = new Set();
    entry.observersBySession.set(sid, set);
  }
  set.add(observer);
  queueScopeAudit(entry, instance, 'router.observer.attach', {
    lane: 'session',
    sessionId: sid,
    observerCount: set.size,
  });

  if (replayBuffered) {
    const buffered = entry.sessionBuffers.get(sid) || [];
    for (const framed of buffered) {
      observer.onEvent(framed).catch(() => {});
    }
  }

  return () => {
    const cur = entry.observersBySession.get(sid);
    if (!cur) return;
    cur.delete(observer);
    let droppedBuffered = 0;
    if (cur.size === 0) {
      entry.observersBySession.delete(sid);
      if (dropBufferedOnDetach) {
        const buffered = entry.sessionBuffers.get(sid);
        droppedBuffered = Array.isArray(buffered) ? buffered.length : 0;
        entry.sessionBuffers.delete(sid);
      }
    }
    queueScopeAudit(entry, instance, 'router.observer.detach', {
      lane: 'session',
      sessionId: sid,
      observerCount: cur.size,
      droppedBuffered,
    });
  };
}

function replaceRunLifecycleObserver(entry, sessionId, controller, instance) {
  const sid = String(sessionId || '').trim();
  if (!sid || !entry || typeof controller !== 'object' || controller === null) return;
  const existing = entry.runLifecycleBySession.get(sid);
  if (existing && existing !== controller && typeof existing.close === 'function') {
    existing.close('next_run_start');
  }
  entry.runLifecycleBySession.set(sid, controller);
}

async function endSessionLifecycle(instance, sessionId, reason) {
  const sid = String(sessionId || '').trim();
  if (!sid) return false;
  shouldUseSdk(instance);
  const runtimeEntry = sdkRuntimes.get(getRuntimeScopeKey(instance));
  if (!runtimeEntry) return false;
  const controller = runtimeEntry.runLifecycleBySession.get(sid);
  runtimeEntry.runLifecycleBySession.delete(sid);
  if (controller && typeof controller.close === 'function') {
    controller.close(String(reason || 'session_end'));
  }
  runtimeEntry.sessionBuffers.delete(sid);
  return !!controller;
}

async function ensureSdkEventPump(instance, entry) {
  if (entry.pumpReadyPromise) return entry.pumpReadyPromise;

  let readyResolve;
  let readyReject;
  entry.pumpReadyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  entry.pumpPromise = (async () => {
    entry.subscriptionEpoch += 1;
    const query = { directory: instance.workdir };
    const subscription = await entry.client.event.subscribe({
      directory: query.directory,
    });
    const stream = subscription && subscription.stream;
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new Error('sdk event stream unavailable');
    }
    entry.eventStream = stream;
    if (typeof readyResolve === 'function') readyResolve();
    queueScopeAudit(entry, instance, 'router.subscription.started', { lane: 'global' });

    for await (const evt of stream) {
      entry.eventCursor += 1;
      const resolved = resolveSessionIdentity(evt);
      const framed = {
        evt,
        resolved,
        cursor: entry.eventCursor,
        serverEpoch: entry.serverEpoch,
        subscriptionEpoch: entry.subscriptionEpoch,
      };

      queueScopeAudit(entry, instance, 'router.event.ingress', {
        lane: resolved.lane,
        sessionId: resolved.sessionId || null,
        type: resolved.type,
      });

      if (!resolved.sessionId) {
        queueScopeAudit(entry, instance, 'router.event.global_lane', {
          lane: 'global',
          type: resolved.type,
        });
        continue;
      }

      pushBufferedSessionEvent(entry, resolved.sessionId, framed);
      const observers = entry.observersBySession.get(resolved.sessionId);
      if (!observers || observers.size === 0) {
        queueScopeAudit(entry, instance, 'router.event.buffered', {
          lane: 'session',
          sessionId: resolved.sessionId,
          type: resolved.type,
        });
        continue;
      }

      for (const observer of observers) {
        observer.onEvent(framed).catch(() => {});
      }
      queueScopeAudit(entry, instance, 'router.event.routed', {
        lane: 'session',
        sessionId: resolved.sessionId,
        observerCount: observers.size,
        type: resolved.type,
      });
    }
  })().catch((err) => {
    queueScopeAudit(entry, instance, 'router.subscription.error', {
      lane: 'global',
      message: String(err && err.message ? err.message : err || ''),
    });
    entry.pumpPromise = null;
    entry.pumpReadyPromise = null;
    entry.eventStream = null;
    if (typeof readyReject === 'function') readyReject(err);
    throw err;
  });

  return entry.pumpReadyPromise;
}

async function getOrCreateSdkRuntime(instance) {
  const scopeKey = getRuntimeScopeKey(instance);
  if (stopAllInProgress) {
    throw new Error('runtime lifecycle is stopping; retry after restart completes');
  }

  return runSdkRuntimeOpExclusive(scopeKey, async () => {
    const existing = sdkRuntimes.get(scopeKey);
    if (existing && existing.client && existing.runtime) {
      return existing;
    }
    const created = await createSdkRuntimeForScope(scopeKey);
    sdkRuntimes.set(scopeKey, created);
    return created;
  });
}

async function resetSdkRuntime(instance) {
  const scopeKey = getRuntimeScopeKey(instance);
  return runSdkRuntimeOpExclusive(scopeKey, async () => {
    const existing = sdkRuntimes.get(scopeKey);
    sdkRuntimes.delete(scopeKey);
    if (existing) await closeSdkRuntimeEntry(existing);
  });
}

function isRecoverableSdkTransportError(err) {
  const msg = String(err && err.message ? err.message : err || '').toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('fetch failed')
    || msg.includes('econnrefused')
    || msg.includes('socket hang up')
    || msg.includes('connection reset')
    || msg.includes('event stream unavailable')
    || msg.includes('network')
  );
}

async function withSdkClient(instance, fn) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const entry = await getOrCreateSdkRuntime(instance);
    try {
      return await fn(entry.client, { directory: instance.workdir });
    } catch (err) {
      lastErr = err;
      if (!isRecoverableSdkTransportError(err) || attempt > 0) {
        throw err;
      }
      await resetSdkRuntime(instance);
    }
  }
  throw lastErr || new Error('sdk client call failed');
}

async function runSessionRevert(instance, input) {
  if (!shouldUseSdk(instance)) {
    throw new Error('session revert requires sdk transport');
  }
  const sessionId = String((input && input.sessionId) || '').trim();
  const messageId = String((input && input.messageId) || '').trim();
  const partId = String((input && input.partId) || '').trim();
  if (!sessionId) throw new Error('missing sessionId for revert');
  if (!messageId && !partId) throw new Error('missing messageId/partId for revert');

  return withSdkClient(instance, async (client, query) => {
    await unwrapData(await client.session.get({
      sessionID: sessionId,
      directory: query.directory,
    }));

    const body = partId
      ? { messageID: messageId || partId, partID: partId }
      : { messageID: messageId };

    const result = await unwrapData(await client.session.revert({
      sessionID: sessionId,
      directory: query.directory,
      ...body,
    }));

    return {
      ok: true,
      sessionId,
      result,
      canUnrevert: !!(result && result.revert),
    };
  });
}

async function runSessionUnrevert(instance, input) {
  if (!shouldUseSdk(instance)) {
    throw new Error('session unrevert requires sdk transport');
  }
  const sessionId = String((input && input.sessionId) || '').trim();
  if (!sessionId) throw new Error('missing sessionId for unrevert');

  return withSdkClient(instance, async (client, query) => {
    const before = await unwrapData(await client.session.get({
      sessionID: sessionId,
      directory: query.directory,
    }));
    const hadRevert = !!(before && before.revert);
    if (!hadRevert) {
      return {
        ok: true,
        sessionId,
        hadRevert: false,
        noop: true,
      };
    }

    const result = await unwrapData(await client.session.unrevert({
      sessionID: sessionId,
      directory: query.directory,
    }));

    return {
      ok: true,
      sessionId,
      hadRevert: true,
      noop: false,
      result,
    };
  });
}

async function runQuestionReply(instance, input) {
  if (!shouldUseSdk(instance)) {
    throw new Error('question reply requires sdk transport');
  }
  const requestID = String((input && (input.requestID || input.requestId)) || '').trim();
  const answers = Array.isArray(input && input.answers) ? input.answers : null;
  if (!requestID) throw new Error('missing requestID for question reply');
  if (!answers) throw new Error('missing answers for question reply');
  return withSdkClient(instance, async (client, query) => {
    const questionApi = client && client.question ? client.question : null;
    if (!questionApi || typeof questionApi.reply !== 'function') {
      throw new Error('installed opencode sdk runtime does not support question.reply');
    }
    return unwrapData(await questionApi.reply({
      requestID,
      directory: query.directory,
      answers,
    }));
  });
}

async function runQuestionReject(instance, input) {
  if (!shouldUseSdk(instance)) {
    throw new Error('question reject requires sdk transport');
  }
  const requestID = String((input && (input.requestID || input.requestId)) || '').trim();
  if (!requestID) throw new Error('missing requestID for question reject');
  return withSdkClient(instance, async (client, query) => {
    const questionApi = client && client.question ? client.question : null;
    if (!questionApi || typeof questionApi.reject !== 'function') {
      throw new Error('installed opencode sdk runtime does not support question.reject');
    }
    return unwrapData(await questionApi.reject({
      requestID,
      directory: query.directory,
    }));
  });
}

async function runPermissionReply(instance, input) {
  const requestId = String(input && input.requestId ? input.requestId : '').trim();
  const reply = String(input && input.reply ? input.reply : '').trim();
  const message = String(input && input.message ? input.message : '').trim();
  if (!requestId) throw new Error('permission requestId is required');
  if (!reply) throw new Error('permission reply is required');
  return withSdkClient(instance, async (client, query) => {
    const permissionApi = client && client.permission ? client.permission : null;
    if (!permissionApi || typeof permissionApi.reply !== 'function') {
      throw new Error('installed opencode sdk runtime does not support permission.reply');
    }
    return unwrapData(await permissionApi.reply({
      requestID: requestId,
      directory: query.directory,
      reply,
      ...(message ? { message } : {}),
    }));
  });
}

function unwrapData(result) {
  if (!result || typeof result !== 'object') return result;
  if (result.error) {
    const err = new Error(String(result.error.message || result.error.code || 'sdk request failed'));
    err.details = result.error;
    throw err;
  }
  if (Object.prototype.hasOwnProperty.call(result, 'data')) return result.data;
  return result;
}

function runViaSdk(instance, prompt, { onEvent, onDone, onError, sessionId }) {
  const { logStream } = setupLogStream(instance, prompt);
  const startedAt = Date.now();
  let eventSeq = 0;
  let logClosed = false;
  logStream.on('error', () => {});

  function trace(kind, payload) {
    const rec = {
      ts: new Date().toISOString(),
      tMs: Date.now() - startedAt,
      transport: 'sdk',
      kind,
      eventSeq,
      payload: payload || {},
    };
    try {
      if (logClosed || logStream.destroyed || logStream.writableEnded) return;
      logStream.write(`[trace] ${JSON.stringify(rec)}\n`);
    } catch (_err) {
    }
  }
  const state = {
    done: false,
    completed: false,
    sessionId: String(sessionId || '').trim(),
    rateLimit: null,
    stderrSamples: [],
    finalText: '',
    attachCursor: 0,
    hasCurrentRunActivity: false,
    sawAssistantMessageUpdate: false,
    sawAssistantTextEvent: false,
    firstRawTypes: [],
  };

  const partMap = new Map();
  const assistantMessageIds = new Set();
  const processedDeltas = new Set(); // Track processed deltas to prevent text duplication
  const pendingToolParts = new Set();
  let partSeq = 0;
  let abortSession = null;
  let detachObserver = null;
  let boundRuntimeEntry = null;
  let lifecycleSessionId = '';
  let eventQueue = Promise.resolve();
  let idleFinalizeTimer = null;
  let postCompleteTimer = null;
  let idlePending = false;
  let settlePromiseResolve = null;
  const settlePromise = new Promise((resolve) => {
    settlePromiseResolve = resolve;
  });

  function dispatchEvent(event) {
    eventSeq += 1;
    trace('dispatch.enqueue', {
      type: event && event.type ? event.type : 'unknown',
      textKind: event && event.textKind ? event.textKind : null,
      sessionId: event && event.sessionId ? event.sessionId : null,
      content: event && typeof event.content === 'string' ? event.content : '',
      contentLength: event && typeof event.content === 'string' ? event.content.length : 0,
    });
    eventQueue = eventQueue.then(() => Promise.resolve(onEvent(event)));
    return eventQueue;
  }

  async function drainEventQueue() {
    while (true) {
      const queued = eventQueue;
      await queued;
      if (eventQueue === queued) return;
    }
  }

  function clearIdleFinalizeTimer() {
    if (idleFinalizeTimer) {
      clearTimeout(idleFinalizeTimer);
      idleFinalizeTimer = null;
    }
  }

  function clearPostCompleteTimer() {
    if (postCompleteTimer) {
      clearTimeout(postCompleteTimer);
      postCompleteTimer = null;
    }
  }

  function shouldKeepRunOpenForPendingDelegation() {
    return pendingToolParts.size > 0;
  }

  function updatePendingDelegationState(evt) {
    const type = String((evt && evt.type) || '');
    const props = (evt && evt.properties) || {};
    if (type === 'message.part.removed') {
      const partId = String(props.partID || '').trim();
      if (partId) pendingToolParts.delete(partId);
      return;
    }
    if (type !== 'message.part.updated') return;
    const part = props.part || {};
    const partId = String(part.id || '').trim();
    if (!partId || String(part.type || '').trim() !== 'tool') return;
    const toolState = part.state && typeof part.state === 'object' ? part.state : {};
    const status = String(toolState.status || '').trim().toLowerCase();
    if (
      status === 'running'
      || status === 'pending'
      || status === 'in_progress'
      || status === 'queued'
      || status === 'starting'
    ) {
      pendingToolParts.add(partId);
      return;
    }
    if (status) {
      pendingToolParts.delete(partId);
    }
  }

  function closeRunObserver(reason) {
    if (state.done) return;
    state.done = true;
    clearIdleFinalizeTimer();
    clearPostCompleteTimer();
    clearTimeout(timeout);
    if (typeof detachObserver === 'function') {
      try { detachObserver(); } catch (_err) {}
      detachObserver = null;
    }
    if (boundRuntimeEntry) {
      if (lifecycleSessionId && boundRuntimeEntry.runLifecycleBySession.get(lifecycleSessionId)) {
        const current = boundRuntimeEntry.runLifecycleBySession.get(lifecycleSessionId);
        if (current && current.close === closeRunObserver) {
          boundRuntimeEntry.runLifecycleBySession.delete(lifecycleSessionId);
        }
      }
      queueScopeAudit(boundRuntimeEntry, instance, 'router.run.observer_detach', {
        lane: 'run-observer',
        sessionId: state.sessionId,
        reason: String(reason || 'unknown'),
      });
    }
    if (!logClosed) {
      logStream.end();
      logClosed = true;
    }
  }

  function schedulePostCompleteFinalize() {
    clearPostCompleteTimer();
    const delayMs = Math.max(0, Number(SDK_POST_COMPLETE_LINGER_MS) || 0);
    postCompleteTimer = setTimeout(async () => {
      if (state.done || state.completed) return;
      if (shouldKeepRunOpenForPendingDelegation()) {
        trace('post_complete.finalize.deferred_for_pending_tool', {
          pendingToolCount: pendingToolParts.size,
        });
        schedulePostCompleteFinalize();
        return;
      }
      state.finalText = sortedFinalText();
      trace('post_complete.finalize.firing', {
        lingerMs: Math.max(0, SDK_POST_COMPLETE_LINGER_MS),
        finalTextLength: state.finalText.length,
        finalText: state.finalText,
      });
      try {
        trace('post_complete.finalize.await_event_queue', {});
        await drainEventQueue();
        trace('post_complete.finalize.event_queue_drained', {});
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err || 'event dispatch failed')));
        return;
      }
      finish(0, null);
    }, shouldKeepRunOpenForPendingDelegation() ? Math.max(delayMs, 250) : delayMs);
  }

  function scheduleIdleFinalize() {
    clearIdleFinalizeTimer();
    clearPostCompleteTimer();
    trace('idle.finalize.scheduled', {
      delayMs: Math.max(0, SDK_IDLE_DRAIN_MS),
      currentFinalLength: String(state.finalText || '').length,
    });
    const delayMs = Math.max(0, Number(SDK_IDLE_DRAIN_MS) || 0);
    idleFinalizeTimer = setTimeout(async () => {
      if (state.done || state.completed) return;
      if (shouldKeepRunOpenForPendingDelegation()) {
        trace('idle.finalize.deferred_for_pending_tool', {
          pendingToolCount: pendingToolParts.size,
        });
        scheduleIdleFinalize();
        return;
      }
      state.finalText = sortedFinalText();
      trace('idle.finalize.firing', {
        finalTextLength: state.finalText.length,
        finalText: state.finalText,
      });
      try {
        trace('idle.finalize.await_event_queue', {});
        await drainEventQueue();
        trace('idle.finalize.event_queue_drained', {});
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err || 'event dispatch failed')));
        return;
      }
      schedulePostCompleteFinalize();
    }, shouldKeepRunOpenForPendingDelegation() ? Math.max(delayMs, 250) : delayMs);
  }

  function sortedFinalText() {
    const parts = Array.from(partMap.values());
    parts.sort((a, b) => {
      if (a.index !== null && b.index !== null && a.index !== b.index) return a.index - b.index;
      if (a.index !== null && b.index === null) return -1;
      if (a.index === null && b.index !== null) return 1;
      return a.seq - b.seq;
    });
    return parts
      .filter((p) => p.type === 'text')
      .map((p) => String(p.text || '').trim())
      .filter(Boolean)
      .join('\n\n');
  }

  function updatePart(part) {
    const id = String(part && part.id ? part.id : '').trim();
    if (!id) return null;
    let entry = partMap.get(id);
    if (!entry) {
      entry = {
        id,
        seq: partSeq++,
        index: Number.isInteger(Number(part.index)) ? Number(part.index) : null,
        type: String(part.type || ''),
        text: '',
      };
      partMap.set(id, entry);
    }
    const idx = Number(part.index);
    if (Number.isInteger(idx) && (entry.index === null || idx < entry.index)) {
      entry.index = idx;
    }
    entry.type = String(part.type || entry.type || '');
    if (entry.type === 'text') {
      entry.text = String(part.text || '');
    }
    return entry;
  }

  function finish(exitCode, timeoutMsg) {
    if (state.done || state.completed) return;
    state.completed = true;
    clearIdleFinalizeTimer();
    clearPostCompleteTimer();
    clearTimeout(timeout);
    trace('settle.done', {
      exitCode,
      timeoutMsg,
      finalTextLength: String(state.finalText || '').length,
      finalText: state.finalText,
    });
    if (boundRuntimeEntry) {
      queueScopeAudit(boundRuntimeEntry, instance, 'router.run.complete', {
        lane: 'run-observer',
        sessionId: state.sessionId,
        exitCode,
        timeoutMsg,
      });
    }
    onDone(exitCode, timeoutMsg, {
      sessionId: state.sessionId,
      rateLimit: state.rateLimit,
      stderrSamples: state.stderrSamples.slice(-5),
      finalText: state.finalText,
    });
    if (typeof settlePromiseResolve === 'function') {
      settlePromiseResolve();
      settlePromiseResolve = null;
    }
  }

  function fail(err) {
    if (state.done) return;
    state.completed = true;
    closeRunObserver('run_error');
    if (isRecoverableSdkTransportError(err)) {
      resetSdkRuntime(instance).catch(() => {});
    }
    const msg = String(err && err.message ? err.message : err || 'sdk runtime failed');
    state.stderrSamples.push(msg);
    if (state.stderrSamples.length > 5) state.stderrSamples.shift();
    maybeCaptureRateLimit(state, msg);
    trace('settle.error', {
      message: String(err && err.message ? err.message : err || ''),
    });
    if (boundRuntimeEntry) {
      queueScopeAudit(boundRuntimeEntry, instance, 'router.run.error', {
        lane: 'run-observer',
        sessionId: state.sessionId,
        message: String(err && err.message ? err.message : err || ''),
      });
    }
    onError(err instanceof Error ? err : new Error(msg));
    if (typeof settlePromiseResolve === 'function') {
      settlePromiseResolve();
      settlePromiseResolve = null;
    }
  }

  const handle = {
    killed: false,
    _abortSession: null,
    kill(_signal) {
      console.log('[DEBUG] handle.kill called with signal:', _signal);
      console.log('[DEBUG] handle._abortSession type:', typeof handle._abortSession);
      console.log('[DEBUG] closure abortSession type:', typeof abortSession);
      handle.killed = true;
      // Use the stored abortSession reference or fall back to closure
      const abortFn = handle._abortSession || abortSession;
      if (typeof abortFn === 'function') {
        console.log('[DEBUG] Calling abort function');
        abortFn().catch(() => {});
      } else {
        console.log('[DEBUG] No abort function available');
      }
      if (!state.completed) {
        finish(143, null);
      } else if (!state.done) {
        closeRunObserver('killed_after_completion');
      }
      return true;
    },
  };

  const timeout = setTimeout(() => {
    if (state.done) return;
    handle.kill('SIGTERM');
    finish(null, `Process timed out after ${MAX_PROCESS_SEC}s`);
  }, MAX_PROCESS_SEC * 1000);

  async function processFramedEvent(framed) {
    if (state.done) return;
    const cursor = Number((framed && framed.cursor) || 0);
    if (Number.isFinite(cursor) && cursor > 0 && state.attachCursor > 0 && cursor <= state.attachCursor) {
      trace('sdk.event.drop.stale_cursor', {
        cursor,
        attachCursor: state.attachCursor,
        sessionId: state.sessionId,
      });
      return;
    }
    const evt = framed && framed.evt ? framed.evt : {};
    const resolved = framed && framed.resolved ? framed.resolved : resolveSessionIdentity(evt);
    const type = String((resolved && resolved.type) || evt.type || '');
    const props = (evt && evt.properties) || {};
    updatePendingDelegationState(evt);
    if (type && state.firstRawTypes.length < 8) {
      state.firstRawTypes.push(type);
    }

    logStream.write(`${JSON.stringify(evt)}\n`);
    trace('sdk.event.raw', {
      type,
      lane: String((resolved && resolved.lane) || ''),
      sessionId: String((resolved && resolved.sessionId) || ''),
      event: evt,
    });

    await dispatchEvent({
      type: 'raw',
      content: JSON.stringify(evt),
      sessionId: String((resolved && resolved.sessionId) || state.sessionId || ''),
    });

    if (SDK_RAW_PASSTHROUGH) {
      state.hasCurrentRunActivity = true;
      if (!state.completed && !state.done) {
        schedulePostCompleteFinalize();
      }
      if (idlePending) scheduleIdleFinalize();
      return;
    }

    if (type === 'session.error') {
      const errText = JSON.stringify(props.error || props);
      maybeCaptureRateLimit(state, errText);
      state.stderrSamples.push(errText);
      if (state.stderrSamples.length > 5) state.stderrSamples.shift();
      await dispatchEvent({ type: 'raw', content: errText, sessionId: state.sessionId });
      return;
    }

    if (type === 'session.status') {
      const status = String((props.status && props.status.type) || '').toLowerCase();
      if (status === 'busy') {
        state.hasCurrentRunActivity = true;
        await dispatchEvent({ type: 'step_start', sessionId: state.sessionId });
      } else if (status === 'retry') {
        const nextTs = Number((props.status && props.status.next) || 0);
        const retryAfterSeconds = Number.isFinite(nextTs) && nextTs > 0
          ? Math.max(0, Math.ceil((nextTs - Date.now()) / 1000))
          : null;
        await dispatchEvent({ type: 'wait', status: 'retry', retryAfterSeconds, sessionId: state.sessionId });
      }
      return;
    }

    if (type === 'message.updated') {
      const info = props.info || {};
      const role = String(info.role || '').toLowerCase();
      const messageId = String(info.id || '').trim();
      if (role === 'assistant' && messageId) {
        assistantMessageIds.add(messageId);
        if (!state.sawAssistantMessageUpdate) {
          state.sawAssistantMessageUpdate = true;
          trace('sdk.assistant.first_message_updated', {
            messageId,
            parentId: String(info.parentID || '').trim(),
          });
        }
      }
      await dispatchEvent({ type: 'raw', content: JSON.stringify(evt), sessionId: state.sessionId });
      return;
    }

    if (type === 'session.idle') {
      if (!state.hasCurrentRunActivity) {
        trace('sdk.session.idle.ignored.pre_activity', {
          sessionId: state.sessionId,
        });
        if (boundRuntimeEntry) {
          queueScopeAudit(boundRuntimeEntry, instance, 'router.run.idle_ignored', {
            lane: 'run-observer',
            sessionId: state.sessionId,
            reason: 'pre-activity',
          });
        }
        return;
      }
      idlePending = true;
      trace('sdk.session.idle', {
        sessionId: state.sessionId,
        finalTextLength: String(state.finalText || '').length,
        sortedFinalLength: sortedFinalText().length,
      });
      scheduleIdleFinalize();
      return;
    }

    if (type === 'message.part.delta') {
      state.hasCurrentRunActivity = true;
      if (idlePending) scheduleIdleFinalize();
      const messageId = String(props.messageID || '').trim();
      if (messageId && assistantMessageIds.has(messageId) && !state.sawAssistantTextEvent) {
        state.sawAssistantTextEvent = true;
        trace('sdk.assistant.first_text_event', {
          type,
          messageId,
          partId: String(props.partID || '').trim(),
        });
      }
      const partId = String(props.partID || '').trim();
      const field = String(props.field || '');
      const delta = String(props.delta || '');
      if (!partId || field !== 'text' || !delta) return;
      
      // Create unique key for this delta event to prevent duplication
      const deltaKey = `${partId}:${field}:${delta}:${props.messageID || ''}`;
      if (processedDeltas.has(deltaKey)) {
        return; // Skip already processed delta
      }
      processedDeltas.add(deltaKey);
      
      const ptype = String(props.type || '').trim().toLowerCase();
      if (ptype === 'reasoning') {
        await dispatchEvent({
          type: 'text',
          content: delta,
          textKind: 'reasoning',
          sessionId: state.sessionId,
          messageId: String(props.messageID || ''),
          partId,
        });
        return;
      }
      const entry = updatePart({
        id: partId,
        index: Number.isFinite(Number(props.partIndex)) ? Number(props.partIndex) : undefined,
        type: 'text',
        text: '',
      });
      if (!entry) return;
      entry.text = String(entry.text || '') + delta;
      state.finalText = sortedFinalText();
      await dispatchEvent({
        type: 'text',
        content: state.finalText || delta,
        textKind: 'final',
        sessionId: state.sessionId,
        messageId: String(props.messageID || ''),
        partId,
      });
      return;
    }

    if (type !== 'message.part.updated') {
      await dispatchEvent({ type: 'raw', content: JSON.stringify(evt), sessionId: state.sessionId });
      return;
    }

    const part = props.part || {};
    state.hasCurrentRunActivity = true;
    if (idlePending) scheduleIdleFinalize();
    const ptype = String(part.type || '');

    if (ptype === 'step-start') {
      await dispatchEvent({ type: 'step_start', sessionId: state.sessionId });
      return;
    }
    if (ptype === 'step-finish') {
      await dispatchEvent({ type: 'step_finish', reason: part.reason || null, sessionId: state.sessionId });
      return;
    }
    if (ptype === 'tool') {
      const toolState = part.state || {};
      await dispatchEvent({
        type: 'tool_use',
        name: part.tool || 'tool',
        input: toolState.input || {},
        output: toolState.output || toolState.error || '',
        sessionId: state.sessionId,
      });
      return;
    }
    if (ptype === 'reasoning') {
      if (String(part.messageID || '').trim() && assistantMessageIds.has(String(part.messageID || '').trim()) && !state.sawAssistantTextEvent) {
        state.sawAssistantTextEvent = true;
        trace('sdk.assistant.first_text_event', {
          type,
          messageId: String(part.messageID || '').trim(),
          partId: String(part.id || '').trim(),
          textKind: 'reasoning',
        });
      }
      const reasoningText = String(part.text || props.delta || '');
      if (reasoningText) {
        trace('sdk.reasoning.part', {
          partId: String(part.id || ''),
          index: Number.isFinite(Number(part.index)) ? Number(part.index) : null,
          text: reasoningText,
          textLength: reasoningText.length,
        });
        await dispatchEvent({
          type: 'text',
          content: reasoningText,
          textKind: 'reasoning',
          sessionId: state.sessionId,
          messageId: String(part.messageID || ''),
          partId: String(part.id || ''),
        });
      }
      return;
    }
    if (ptype === 'text') {
      if (String(part.messageID || '').trim() && assistantMessageIds.has(String(part.messageID || '').trim()) && !state.sawAssistantTextEvent) {
        state.sawAssistantTextEvent = true;
        trace('sdk.assistant.first_text_event', {
          type,
          messageId: String(part.messageID || '').trim(),
          partId: String(part.id || '').trim(),
          textKind: 'final',
        });
      }
      updatePart(part);
      state.finalText = sortedFinalText();
      trace('sdk.text.part', {
        partId: String(part.id || ''),
        index: Number.isFinite(Number(part.index)) ? Number(part.index) : null,
        partText: String(part.text || ''),
        partTextLength: String(part.text || '').length,
        sortedFinalLength: state.finalText.length,
        sortedFinalText: state.finalText,
      });
      await dispatchEvent({
        type: 'text',
        content: state.finalText || String(part.text || ''),
        textKind: 'final',
        sessionId: state.sessionId,
        messageId: String(part.messageID || ''),
        partId: String(part.id || ''),
      });
      return;
    }

    await dispatchEvent({ type: 'raw', content: JSON.stringify(evt), sessionId: state.sessionId });
  }

  (async () => {
    try {
      if (stopAllInProgress) {
        throw new Error('runtime lifecycle is stopping; retry after restart completes');
      }

      const runtimeEntry = await getOrCreateSdkRuntime(instance);
      boundRuntimeEntry = runtimeEntry;
      const client = runtimeEntry.client;

      const query = { directory: instance.workdir };
      if (state.sessionId) {
        try {
          await unwrapData(await client.session.get({
            sessionID: state.sessionId,
            directory: query.directory,
          }));
        } catch (_err) {
          const resumed = await unwrapData(await client.session.create({
            directory: query.directory,
            parentID: state.sessionId,
            title: `hermux ${new Date().toISOString()}`,
          }));
          state.sessionId = String((resumed && resumed.id) || '').trim();
        }
      }

      if (!state.sessionId) {
        const created = await unwrapData(await client.session.create({
          directory: query.directory,
          title: `hermux ${new Date().toISOString()}`,
        }));
        state.sessionId = String((created && created.id) || '').trim();
      }

      if (!state.sessionId) {
        throw new Error('failed to establish sdk session id');
      }

      abortSession = async () => {
        console.log('[DEBUG] abortSession called for session:', state.sessionId);
        await client.session.abort({
          sessionID: state.sessionId,
          directory: query.directory,
        });
      };
      // Store reference in handle
      handle._abortSession = abortSession;
      // Store reference in handle so it's available even after async setup
      handle._abortSession = abortSession;
      await ensureSdkEventPump(instance, runtimeEntry);
      let observerQueue = Promise.resolve();
      state.attachCursor = Number(runtimeEntry.eventCursor || 0);
      lifecycleSessionId = String(state.sessionId || '').trim();
      replaceRunLifecycleObserver(runtimeEntry, lifecycleSessionId, {
        close: closeRunObserver,
      }, instance);
      detachObserver = addSessionObserver(runtimeEntry, state.sessionId, {
        onEvent: (framed) => {
          observerQueue = observerQueue.then(() => processFramedEvent(framed));
          return observerQueue;
        },
      }, instance, { replayBuffered: false, dropBufferedOnDetach: false });
      queueScopeAudit(runtimeEntry, instance, 'router.run.attach', {
        lane: 'run-observer',
        sessionId: state.sessionId,
        attachCursor: state.attachCursor,
      });
      queueScopeAudit(runtimeEntry, instance, 'router.observer.run_attach', {
        lane: 'run-observer',
        sessionId: state.sessionId,
      });

      await unwrapData(await client.session.promptAsync({
        sessionID: state.sessionId,
        directory: query.directory,
        parts: [{ type: 'text', text: prompt }],
      }));
      trace('sdk.prompt.submitted', {
        sessionId: state.sessionId,
        directory: query.directory,
        promptLength: String(prompt || '').length,
        promptSha256: createHash('sha256').update(String(prompt || '')).digest('hex'),
        attachCursor: state.attachCursor,
        runtimeEventCursor: Number(runtimeEntry.eventCursor || 0) || 0,
      });
      queueScopeAudit(runtimeEntry, instance, 'router.run.prompt_submitted', {
        lane: 'run-observer',
        sessionId: state.sessionId,
        attachCursor: state.attachCursor,
        runtimeEventCursor: Number(runtimeEntry.eventCursor || 0) || 0,
        promptLength: String(prompt || '').length,
        promptSha256: createHash('sha256').update(String(prompt || '')).digest('hex'),
      });

      if (!idlePending && !state.done) {
        schedulePostCompleteFinalize();
      }

      await settlePromise;
    } catch (err) {
      fail(err);
    }
  })();

  return handle;
}

function runOpencode(instance, prompt, handlers) {
  shouldUseSdk(instance);
  const handle = runViaSdk(instance, prompt, {
    onEvent: handlers.onEvent,
    onDone: (...args) => {
      endRuntimeRun(instance, handle);
      handlers.onDone(...args);
    },
    onError: (err) => {
      endRuntimeRun(instance, handle);
      handlers.onError(err);
    },
    sessionId: handlers.sessionId,
  });
  beginRuntimeRun(instance, 'sdk', handle);
  return handle;
}

async function subscribeSessionEvents(instance, sessionId, handlers) {
  const sid = String(sessionId || '').trim();
  if (!sid) throw new Error('sessionId is required');
  if (typeof handlers !== 'object' || handlers === null || typeof handlers.onEvent !== 'function') {
    throw new Error('handlers.onEvent is required');
  }

  shouldUseSdk(instance);

  const runtimeEntry = await getOrCreateSdkRuntime(instance);
  await ensureSdkEventPump(instance, runtimeEntry);

  let observerQueue = Promise.resolve();
  const replayBuffered = !handlers || handlers.replayBuffered !== false;
  const detach = addSessionObserver(runtimeEntry, sid, {
    onEvent: (framed) => {
      observerQueue = observerQueue.then(() => {
        const resolved = framed && framed.resolved ? framed.resolved : {};
        const evt = framed && framed.evt ? framed.evt : {};
        let content = '';
        try {
          content = JSON.stringify(evt);
        } catch (_err) {
          content = String(evt || '');
        }
        return Promise.resolve(handlers.onEvent({
          type: 'raw',
          content,
          sessionId: String((resolved && resolved.sessionId) || sid || ''),
          cursor: Number(framed && framed.cursor ? framed.cursor : 0) || 0,
        }));
      });
      return observerQueue;
    },
  }, instance, { replayBuffered });

  queueScopeAudit(runtimeEntry, instance, 'router.session_delivery.attach', {
    lane: 'session-delivery',
    sessionId: sid,
  });

  return {
    sessionId: sid,
    mode: 'sdk',
    unsubscribe: async () => {
      try {
        detach();
      } finally {
        queueScopeAudit(runtimeEntry, instance, 'router.session_delivery.detach', {
          lane: 'session-delivery',
          sessionId: sid,
        });
      }
    },
  };
}

module.exports = {
  runOpencode,
  subscribeSessionEvents,
  endSessionLifecycle,
  runSessionRevert,
  runSessionUnrevert,
  runPermissionReply,
  runQuestionReply,
  runQuestionReject,
  stopAllRuntimeExecutors,
  getRuntimeStatusForInstance,
  _internal: {
    toValidPortRange,
    pickRandomAvailablePortInRange,
    getRuntimeScopeKey,
    shouldUseSdk,
  },
};
