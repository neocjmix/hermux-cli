'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { pathToFileURL } = require('url');

const MAX_PROCESS_SEC = parseInt(process.env.OMG_MAX_PROCESS_SECONDS || '3600', 10);
const SDK_SERVER_START_TIMEOUT_MS = parseInt(process.env.OMG_SDK_SERVER_START_TIMEOUT_MS || '15000', 10);
const SDK_PORT_RANGE_MIN = parseInt(process.env.OMG_SDK_PORT_RANGE_MIN || '43100', 10);
const SDK_PORT_RANGE_MAX = parseInt(process.env.OMG_SDK_PORT_RANGE_MAX || '43999', 10);
const SDK_PORT_PICK_ATTEMPTS = parseInt(process.env.OMG_SDK_PORT_PICK_ATTEMPTS || '60', 10);

const activeRuns = new Set();
const runtimeStats = new Map();
let stopAllInProgress = false;

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
  } finally {
    stopAllInProgress = false;
  }
}

function shouldUseSdk(instance) {
  const forced = String(process.env.OMG_EXECUTION_TRANSPORT || '').trim().toLowerCase();
  if (forced === 'command') return false;
  if (forced === 'sdk') return true;

  const cmd = String(instance.opencodeCommand || '').trim();
  if (!cmd) return true;
  const parts = cmd.split(/\s+/).filter(Boolean);
  const bin = String(parts[0] || '');
  return /^(.+\/)?opencode$/.test(bin);
}

let sdkModulePromise = null;

async function loadSdkModule() {
  if (!sdkModulePromise) {
    const shim = String(process.env.OMG_OPENCODE_SDK_SHIM || '').trim();
    if (shim) {
      sdkModulePromise = import(pathToFileURL(path.resolve(shim)).href)
        .then((mod) => (mod && mod.default && mod.default.createOpencode ? mod.default : mod));
    } else {
      sdkModulePromise = import('@opencode-ai/sdk');
    }
  }
  return sdkModulePromise;
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

function runViaCommand(instance, prompt, { onEvent, onDone, onError, sessionId }) {
  const cmdParts = String(instance.opencodeCommand || '').trim().split(/\s+/).filter(Boolean);
  const cmd = cmdParts[0] || 'opencode';
  const cmdArgs = [...cmdParts.slice(1), '--format', 'json'];
  if (sessionId) cmdArgs.push('--session', sessionId);
  cmdArgs.push(prompt);

  const { logStream } = setupLogStream(instance, prompt);

  const proc = spawn(cmd, cmdArgs, {
    cwd: instance.workdir,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let lineBuf = '';
  let stderrBuf = '';
  let killed = false;
  let latestSessionId = sessionId || '';
  let latestFinalText = '';
  const stderrSamples = [];
  const state = { rateLimit: null };

  function mergeTextChunks(prev, next) {
    const a = String(prev || '');
    const b = String(next || '');
    if (!a) return b;
    if (!b) return a;
    if (b.includes(a)) return b;
    if (a.includes(b)) return a;
    return `${a}\n${b}`;
  }

  function parseStderrChunk(chunk) {
    stderrBuf += chunk;
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    lines.forEach((line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed) return;
      stderrSamples.push(trimmed);
      if (stderrSamples.length > 5) stderrSamples.shift();
      maybeCaptureRateLimit(state, trimmed);
    });
  }

  function parseLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const evt = JSON.parse(trimmed);
      const part = evt.part || {};
      const evtSessionId = String(evt.sessionID || part.sessionID || '').trim();
      if (evtSessionId) latestSessionId = evtSessionId;

      if (evt.type === 'step_start') {
        onEvent({ type: 'step_start', sessionId: latestSessionId });
        return;
      }
      if (evt.type === 'step_finish') {
        onEvent({ type: 'step_finish', reason: part.reason || null, sessionId: latestSessionId });
        return;
      }
      if (evt.type === 'text') {
        const text = String(part.text || '');
        if (text.trim()) latestFinalText = mergeTextChunks(latestFinalText, text);
        onEvent({ type: 'text', content: text, textKind: 'stream', sessionId: latestSessionId });
        return;
      }
      if (evt.type === 'tool_use') {
        const toolState = part.state || {};
        onEvent({
          type: 'tool_use',
          name: part.tool || 'tool',
          input: toolState.input || {},
          output: toolState.output || '',
          sessionId: latestSessionId,
        });
        return;
      }
      onEvent({ type: 'raw', content: trimmed, sessionId: latestSessionId });
    } catch {
      onEvent({ type: 'raw', content: trimmed, sessionId: latestSessionId });
    }
  }

  proc.stdout.on('data', (data) => {
    const str = data.toString();
    logStream.write(str);
    lineBuf += str;
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop();
    lines.forEach(parseLine);
  });

  proc.stderr.on('data', (data) => {
    const str = data.toString();
    logStream.write(str);
    parseStderrChunk(str);
  });

  const timeout = setTimeout(() => {
    if (!proc.killed) {
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
          try {
            if (proc.stdout && !proc.stdout.destroyed) proc.stdout.destroy();
            if (proc.stderr && !proc.stderr.destroyed) proc.stderr.destroy();
          } catch (_err) {
          }
        }
      }, 5000);
    }
  }, MAX_PROCESS_SEC * 1000);

  proc.on('close', (code) => {
    clearTimeout(timeout);
    if (lineBuf.trim()) parseLine(lineBuf);
    if (stderrBuf.trim()) {
      const tail = stderrBuf.trim();
      stderrSamples.push(tail);
      if (stderrSamples.length > 5) stderrSamples.shift();
      maybeCaptureRateLimit(state, tail);
    }
    logStream.end();

    const meta = {
      sessionId: latestSessionId,
      rateLimit: state.rateLimit,
      stderrSamples: stderrSamples.slice(),
      finalText: latestFinalText,
    };
    if (killed) {
      onDone(null, `Process timed out after ${MAX_PROCESS_SEC}s`, meta);
    } else {
      onDone(code, null, meta);
    }
  });

  proc.on('error', (err) => {
    clearTimeout(timeout);
    logStream.end();
    onError(err);
  });

  return proc;
}

function runViaSdk(instance, prompt, { onEvent, onDone, onError, sessionId }) {
  const { logStream } = setupLogStream(instance, prompt);
  const state = {
    done: false,
    sessionId: String(sessionId || '').trim(),
    rateLimit: null,
    stderrSamples: [],
    finalText: '',
  };

  const partMap = new Map();
  let partSeq = 0;
  let closeServer = null;
  let abortSession = null;

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
    if (state.done) return;
    state.done = true;
    clearTimeout(timeout);
    if (typeof closeServer === 'function') {
      try { closeServer(); } catch (_err) {}
    }
    logStream.end();
    onDone(exitCode, timeoutMsg, {
      sessionId: state.sessionId,
      rateLimit: state.rateLimit,
      stderrSamples: state.stderrSamples.slice(-5),
      finalText: state.finalText,
    });
  }

  function fail(err) {
    if (state.done) return;
    state.done = true;
    clearTimeout(timeout);
    if (typeof closeServer === 'function') {
      try { closeServer(); } catch (_err) {}
    }
    const msg = String(err && err.message ? err.message : err || 'sdk runtime failed');
    state.stderrSamples.push(msg);
    if (state.stderrSamples.length > 5) state.stderrSamples.shift();
    maybeCaptureRateLimit(state, msg);
    logStream.end();
    onError(err instanceof Error ? err : new Error(msg));
  }

  const handle = {
    killed: false,
    kill(_signal) {
      handle.killed = true;
      if (typeof abortSession === 'function') {
        abortSession().catch(() => {});
      }
      if (!state.done) {
        finish(143, null);
      }
      return true;
    },
  };

  const timeout = setTimeout(() => {
    if (state.done) return;
    handle.kill('SIGTERM');
    finish(null, `Process timed out after ${MAX_PROCESS_SEC}s`);
  }, MAX_PROCESS_SEC * 1000);

  (async () => {
    try {
      if (stopAllInProgress) {
        throw new Error('runtime lifecycle is stopping; retry after restart completes');
      }

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
      const client = runtime.client;
      closeServer = runtime && runtime.server && typeof runtime.server.close === 'function'
        ? () => runtime.server.close()
        : null;

      const query = { directory: instance.workdir };
      if (state.sessionId) {
        try {
          await unwrapData(await client.session.get({
            url: '/session/{id}',
            path: { id: state.sessionId },
            query,
          }));
        } catch (_err) {
          const resumed = await unwrapData(await client.session.create({
            url: '/session',
            query,
            body: {
              parentID: state.sessionId,
              title: `hermux ${new Date().toISOString()}`,
            },
          }));
          state.sessionId = String((resumed && resumed.id) || '').trim();
        }
      }

      if (!state.sessionId) {
        const created = await unwrapData(await client.session.create({
          url: '/session',
          query,
          body: {
            title: `hermux ${new Date().toISOString()}`,
          },
        }));
        state.sessionId = String((created && created.id) || '').trim();
      }

      if (!state.sessionId) {
        throw new Error('failed to establish sdk session id');
      }

      abortSession = async () => {
        await client.session.abort({
          url: '/session/{id}/abort',
          path: { id: state.sessionId },
          query,
        });
      };

      const subscription = await client.event.subscribe({
        url: '/event',
        query,
      });

      const stream = subscription && subscription.stream;
      if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
        throw new Error('sdk event stream unavailable');
      }

      const readerPromise = (async () => {
        for await (const evt of stream) {
          if (state.done) break;
          const type = String((evt && evt.type) || '');
          const props = (evt && evt.properties) || {};
          logStream.write(`${JSON.stringify(evt)}\n`);

          if (type === 'session.error') {
            const errText = JSON.stringify(props.error || props);
            maybeCaptureRateLimit(state, errText);
            state.stderrSamples.push(errText);
            if (state.stderrSamples.length > 5) state.stderrSamples.shift();
            onEvent({ type: 'raw', content: errText, sessionId: state.sessionId });
            continue;
          }

          if (type === 'session.status' && String(props.sessionID || '') === state.sessionId) {
            const status = String((props.status && props.status.type) || '').toLowerCase();
            if (status === 'busy') {
              onEvent({ type: 'step_start', sessionId: state.sessionId });
            } else if (status === 'retry') {
              const nextTs = Number((props.status && props.status.next) || 0);
              const retryAfterSeconds = Number.isFinite(nextTs) && nextTs > 0
                ? Math.max(0, Math.ceil((nextTs - Date.now()) / 1000))
                : null;
              onEvent({ type: 'wait', status: 'retry', retryAfterSeconds, sessionId: state.sessionId });
            }
            continue;
          }

          if (type === 'session.idle' && String(props.sessionID || '') === state.sessionId) {
            state.finalText = sortedFinalText();
            finish(0, null);
            break;
          }

          if (type !== 'message.part.updated') {
            onEvent({ type: 'raw', content: JSON.stringify(evt), sessionId: state.sessionId });
            continue;
          }

          const part = props.part || {};
          if (String(part.sessionID || '') !== state.sessionId) continue;
          const ptype = String(part.type || '');

          if (ptype === 'step-start') {
            onEvent({ type: 'step_start', sessionId: state.sessionId });
            continue;
          }
          if (ptype === 'step-finish') {
            onEvent({ type: 'step_finish', reason: part.reason || null, sessionId: state.sessionId });
            continue;
          }
          if (ptype === 'tool') {
            const toolState = part.state || {};
            onEvent({
              type: 'tool_use',
              name: part.tool || 'tool',
              input: toolState.input || {},
              output: toolState.output || toolState.error || '',
              sessionId: state.sessionId,
            });
            continue;
          }
          if (ptype === 'reasoning') {
            const reasoningText = String(part.text || props.delta || '');
            if (reasoningText) {
              onEvent({ type: 'text', content: reasoningText, textKind: 'reasoning', sessionId: state.sessionId });
            }
            continue;
          }
          if (ptype === 'text') {
            updatePart(part);
            state.finalText = sortedFinalText();
            onEvent({ type: 'text', content: state.finalText || String(part.text || ''), textKind: 'final', sessionId: state.sessionId });
            continue;
          }

          onEvent({ type: 'raw', content: JSON.stringify(evt), sessionId: state.sessionId });
        }
      })();

      await unwrapData(await client.session.promptAsync({
        url: '/session/{id}/prompt_async',
        path: { id: state.sessionId },
        query,
        body: {
          parts: [{ type: 'text', text: prompt }],
        },
      }));

      await readerPromise;
      if (!state.done) {
        state.finalText = sortedFinalText();
        finish(0, null);
      }
    } catch (err) {
      fail(err);
    }
  })();

  return handle;
}

function runOpencode(instance, prompt, handlers) {
  if (shouldUseSdk(instance)) {
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

  const handle = runViaCommand(instance, prompt, {
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
  beginRuntimeRun(instance, 'command', handle);
  return handle;
}

module.exports = {
  runOpencode,
  stopAllRuntimeExecutors,
  getRuntimeStatusForInstance,
  _internal: {
    toValidPortRange,
    pickRandomAvailablePortInRange,
    getRuntimeScopeKey,
    shouldUseSdk,
  },
};
