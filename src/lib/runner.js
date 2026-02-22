'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { createHash, randomUUID } = require('crypto');

const MAX_PROCESS_SEC = parseInt(process.env.OMG_MAX_PROCESS_SECONDS || '3600', 10);
const SERVE_READY_TIMEOUT_MS = parseInt(process.env.OMG_SERVE_READY_TIMEOUT_MS || '15000', 10);
const SERVE_PORT_RANGE_MIN = parseInt(process.env.OMG_SERVE_PORT_RANGE_MIN || '43100', 10);
const SERVE_PORT_RANGE_MAX = parseInt(process.env.OMG_SERVE_PORT_RANGE_MAX || '43999', 10);
const SERVE_PORT_PICK_ATTEMPTS = parseInt(process.env.OMG_SERVE_PORT_PICK_ATTEMPTS || '60', 10);
const SERVE_LOCK_WAIT_TIMEOUT_MS = parseInt(process.env.OMG_SERVE_LOCK_WAIT_TIMEOUT_MS || '12000', 10);
const SERVE_LOCK_STALE_MS = parseInt(process.env.OMG_SERVE_LOCK_STALE_MS || '30000', 10);
const SERVE_LOCK_LEASE_RENEW_MS = parseInt(process.env.OMG_SERVE_LOCK_LEASE_RENEW_MS || '2500', 10);
const SERVE_LOCK_RETRY_MIN_MS = parseInt(process.env.OMG_SERVE_LOCK_RETRY_MIN_MS || '80', 10);
const SERVE_LOCK_RETRY_MAX_MS = parseInt(process.env.OMG_SERVE_LOCK_RETRY_MAX_MS || '220', 10);

const RUNTIME_DIR = path.join(__dirname, '..', '..', 'runtime');
const SERVE_LOCK_DIR = path.join(RUNTIME_DIR, 'serve-locks');

const serveDaemons = new Map();
const daemonOps = new Map();
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

function shouldUseServe(instance) {
  const forced = String(process.env.OMG_EXECUTION_TRANSPORT || '').trim().toLowerCase();
  if (forced === 'run') return false;
  if (forced === 'serve') return true;

  const cmd = String(instance.opencodeCommand || '').trim();
  if (!cmd) return false;
  const parts = cmd.split(/\s+/);
  const bin = parts[0];
  if (!bin) return false;
  if (/^(.+\/)?opencode$/.test(bin)) {
    const mode = String(parts[1] || '').trim().toLowerCase();
    if (!mode || mode === 'run' || mode === 'serve') return true;
  }
  return false;
}

function setupLogStream(instance, prompt) {
  const logDir = path.dirname(path.resolve(instance.logFile || './logs/default.log'));
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.resolve(instance.logFile || './logs/default.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n--- ${new Date().toISOString()} | prompt: ${prompt} ---\n`);
  return { logStream, logPath };
}

function nowIso() {
  return new Date().toISOString();
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

function scopeSlugFromKey(key) {
  const hash = createHash('sha1').update(String(key || '')).digest('hex').slice(0, 16);
  const label = String(key || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 48)
    .replace(/^_+|_+$/g, '') || 'scope';
  return `${label}__${hash}`;
}

function getServeScopePathsFromKey(key) {
  const slug = scopeSlugFromKey(key);
  const scopeDir = path.join(SERVE_LOCK_DIR, slug);
  const lockDir = path.join(scopeDir, 'lock');
  return {
    slug,
    scopeDir,
    lockDir,
    ownerPath: path.join(lockDir, 'owner.json'),
    daemonPath: path.join(scopeDir, 'daemon.json'),
  };
}

function getServeScopePathsForInstance(instance) {
  return getServeScopePathsFromKey(getServeScopeKey(instance));
}

async function ensureServeScopeDir(paths) {
  await fsp.mkdir(paths.scopeDir, { recursive: true });
}

async function writeJsonAtomic(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, filePath);
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

async function removeDirSafe(dirPath) {
  try {
    await fsp.rm(dirPath, { recursive: true, force: true });
  } catch (_err) {
  }
}

async function removeFileSafe(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (_err) {
  }
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterMs(min, max) {
  const lo = Number.isFinite(min) ? min : 80;
  const hi = Number.isFinite(max) ? max : 220;
  const safeHi = hi < lo ? lo : hi;
  return randomInt(lo, safeHi);
}

function makeOwnerRecord(key, reason, ownerId, leaseUntil) {
  return {
    key,
    ownerId,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: nowIso(),
    leaseUntil,
    reason: String(reason || 'unknown'),
  };
}

function parseTsMs(v) {
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? t : 0;
}

async function acquireScopeLock(key, reason) {
  const paths = getServeScopePathsFromKey(key);
  await ensureServeScopeDir(paths);
  const ownerId = randomUUID();
  const deadline = Date.now() + Math.max(1000, SERVE_LOCK_WAIT_TIMEOUT_MS);
  let renewTimer = null;
  let released = false;
  let acquired = false;

  const writeOwner = async () => {
    const leaseUntil = new Date(Date.now() + Math.max(1500, SERVE_LOCK_STALE_MS)).toISOString();
    const owner = makeOwnerRecord(key, reason, ownerId, leaseUntil);
    await writeJsonAtomic(paths.ownerPath, owner);
  };

  while (Date.now() < deadline) {
    try {
      await fsp.mkdir(paths.lockDir);
      await writeOwner();
      renewTimer = setInterval(() => {
        writeOwner().catch(() => {});
      }, Math.max(500, SERVE_LOCK_LEASE_RENEW_MS));
      acquired = true;
      break;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      const owner = await readJsonSafe(paths.ownerPath);
      const leaseUntilMs = owner ? parseTsMs(owner.leaseUntil) : 0;
      const stale = !leaseUntilMs || Date.now() > leaseUntilMs;
      const ownerPidAlive = owner && isPidAlive(owner.pid);

      if (stale && !ownerPidAlive) {
        const ownerCheck = await readJsonSafe(paths.ownerPath);
        const sameOwner = (!owner && !ownerCheck)
          || (owner && ownerCheck && String(owner.ownerId || '') === String(ownerCheck.ownerId || ''));
        if (sameOwner) {
          await removeDirSafe(paths.lockDir);
          continue;
        }
      }

      await waitMs(jitterMs(SERVE_LOCK_RETRY_MIN_MS, SERVE_LOCK_RETRY_MAX_MS));
    }
  }

  if (!acquired) {
    throw new Error(`timeout waiting for lock ${key}`);
  }

  const release = async () => {
    if (released) return;
    released = true;
    if (renewTimer) clearInterval(renewTimer);
    const owner = await readJsonSafe(paths.ownerPath);
    if (!owner || String(owner.ownerId || '') !== ownerId) {
      return;
    }
    await removeFileSafe(paths.ownerPath);
    try {
      await fsp.rmdir(paths.lockDir);
    } catch (_err) {
      await removeDirSafe(paths.lockDir);
    }
  };

  return {
    key,
    ownerId,
    paths,
    release,
  };
}

function runDaemonOpExclusive(key, task) {
  const prev = daemonOps.get(key) || Promise.resolve();
  const run = prev.then(task, task);
  const marker = run.catch(() => {});
  daemonOps.set(key, marker);
  return run.finally(() => {
    if (daemonOps.get(key) === marker) {
      daemonOps.delete(key);
    }
  });
}

async function checkDaemonHealth(baseUrl, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/doc`, { signal: controller.signal });
    return !!res.ok;
  } catch (_err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function readDaemonRecordByKey(key) {
  const paths = getServeScopePathsFromKey(key);
  return readJsonSafe(paths.daemonPath);
}

async function writeDaemonRecordByKey(key, record) {
  const paths = getServeScopePathsFromKey(key);
  await ensureServeScopeDir(paths);
  await writeJsonAtomic(paths.daemonPath, record);
}

async function clearDaemonRecordByKey(key) {
  const paths = getServeScopePathsFromKey(key);
  await removeFileSafe(paths.daemonPath);
}

async function killPidHard(pid) {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (_err) {
  }
  await waitMs(400);
  if (!isPidAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (_err) {
  }
}

async function isRecordHealthy(record) {
  if (!record || !Number.isInteger(Number(record.pid)) || !record.baseUrl) return false;
  if (!isPidAlive(Number(record.pid))) return false;
  return checkDaemonHealth(String(record.baseUrl), 900);
}

async function adoptDaemonRecord(key, record) {
  const entry = {
    key,
    proc: null,
    port: Number(record.port),
    pid: Number(record.pid),
    baseUrl: String(record.baseUrl),
    readyPromise: null,
    ready: true,
    stderrTail: [],
    external: true,
  };
  entry.readyPromise = Promise.resolve(entry);
  serveDaemons.set(key, entry);
  return entry;
}

function runViaCommand(instance, prompt, { onEvent, onDone, onError, sessionId }) {
  const cmdParts = instance.opencodeCommand.split(/\s+/);
  const cmd = cmdParts[0];
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
        if (text.trim()) latestFinalText = text;
        onEvent({ type: 'text', content: text, textKind: 'final', sessionId: latestSessionId });
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

function toValidPortRange() {
  const min = Number.isInteger(SERVE_PORT_RANGE_MIN) ? SERVE_PORT_RANGE_MIN : 43100;
  const max = Number.isInteger(SERVE_PORT_RANGE_MAX) ? SERVE_PORT_RANGE_MAX : 43999;
  if (min > 0 && max > 0 && min <= max && max <= 65535) {
    return { min, max };
  }
  return { min: 43100, max: 43999 };
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
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
  const attempts = Number.isInteger(SERVE_PORT_PICK_ATTEMPTS) && SERVE_PORT_PICK_ATTEMPTS > 0
    ? SERVE_PORT_PICK_ATTEMPTS
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

function getServeScopeKey(instance) {
  const repoName = String(instance && instance.name ? instance.name : '').trim();
  const workdir = path.resolve(String(instance && instance.workdir ? instance.workdir : '.'));
  if (repoName) return `${repoName}::${workdir}`;
  return `workdir::${workdir}`;
}

function killServeProcess(entry) {
  if (!entry || !entry.proc || entry.proc.killed) return;
  try {
    entry.proc.kill('SIGTERM');
  } catch (_err) {
  }
  setTimeout(() => {
    if (!entry.proc || entry.proc.killed) return;
    try {
      entry.proc.kill('SIGKILL');
    } catch (_err) {
    }
  }, 1500);
}

async function stopEntryProcess(entry) {
  if (!entry || !entry.proc) return;
  await new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      resolve();
    };

    entry.proc.once('exit', done);
    try {
      entry.proc.kill('SIGTERM');
    } catch (_err) {
      done();
      return;
    }

    setTimeout(() => {
      if (finished) return;
      try {
        entry.proc.kill('SIGKILL');
      } catch (_err) {
      }
      done();
    }, 1200);
  });
}

async function spawnServeDaemon(instance, key) {
  const cmdParts = String(instance.opencodeCommand || '').trim().split(/\s+/).filter(Boolean);
  const bin = cmdParts[0] || 'opencode';
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await pickRandomAvailablePortInRange();
    const baseUrl = `http://127.0.0.1:${port}`;

    const proc = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: instance.workdir,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const entry = {
      key,
      proc,
      port,
      pid: Number(proc.pid || 0),
      baseUrl,
      readyPromise: null,
      ready: false,
      stderrTail: [],
      external: false,
    };

    proc.stderr.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').map((v) => v.trim()).filter(Boolean);
      for (const line of lines) {
        entry.stderrTail.push(line);
        if (entry.stderrTail.length > 8) entry.stderrTail.shift();
      }
    });

    const failedBeforeReady = new Promise((_, reject) => {
      proc.once('error', (err) => reject(err));
      proc.once('exit', (code, signal) => reject(new Error(`serve exited before ready (code=${code}, signal=${signal || 'none'})`)));
    });

    try {
      await Promise.race([waitForServeReady(baseUrl), failedBeforeReady]);
      entry.ready = true;
      proc.on('exit', () => {
        const current = serveDaemons.get(key);
        if (current && current.proc === proc) {
          serveDaemons.delete(key);
        }
      });
      return entry;
    } catch (err) {
      lastError = err;
      killServeProcess(entry);
      if (attempt < 2) {
        continue;
      }
      const tail = entry.stderrTail.join(' | ');
      const detail = tail ? ` | stderr: ${tail}` : '';
      throw new Error(`failed to start serve daemon for ${key}: ${err.message}${detail}`);
    }
  }

  throw lastError || new Error(`failed to start serve daemon for ${key}`);
}

async function ensureServeDaemon(instance) {
  const key = getServeScopeKey(instance);
  if (stopAllInProgress) {
    throw new Error('serve lifecycle is stopping; retry after restart completes');
  }

  return runDaemonOpExclusive(key, async () => {
    const existing = serveDaemons.get(key);
    if (existing && existing.readyPromise) {
      const resolved = await existing.readyPromise;
      if (resolved && resolved.baseUrl && await checkDaemonHealth(resolved.baseUrl, 900)) {
        return resolved;
      }
      serveDaemons.delete(key);
    }

    const lock = await acquireScopeLock(key, 'ensure');
    try {
      const record = await readDaemonRecordByKey(key);
      if (record && await isRecordHealthy(record)) {
        return adoptDaemonRecord(key, record);
      }

      if (record && isPidAlive(Number(record.pid))) {
        await killPidHard(Number(record.pid));
      }
      await clearDaemonRecordByKey(key);

      const existingAfterLock = serveDaemons.get(key);
      if (existingAfterLock) {
        await stopEntryProcess(existingAfterLock);
        serveDaemons.delete(key);
      }

      const entry = await spawnServeDaemon(instance, key);
      entry.readyPromise = Promise.resolve(entry);
      serveDaemons.set(key, entry);
      await writeDaemonRecordByKey(key, {
        key,
        pid: entry.pid,
        port: entry.port,
        baseUrl: entry.baseUrl,
        startedAt: nowIso(),
        ownerPid: process.pid,
        ownerHostname: os.hostname(),
        status: 'ready',
      });
      return entry;
    } finally {
      await lock.release();
    }
  });
}

async function stopServeDaemonByKey(key) {
  await runDaemonOpExclusive(key, async () => {
    const lock = await acquireScopeLock(key, 'stop');
    try {
      const entry = serveDaemons.get(key);
      serveDaemons.delete(key);
      if (entry) {
        await stopEntryProcess(entry);
      }

      const record = await readDaemonRecordByKey(key);
      if (record && isPidAlive(Number(record.pid))) {
        await killPidHard(Number(record.pid));
      }
      await clearDaemonRecordByKey(key);
    } finally {
      await lock.release();
    }
  });
}

async function stopServeDaemonForInstance(instance) {
  const key = getServeScopeKey(instance);
  await stopServeDaemonByKey(key);
}

async function stopAllServeDaemons() {
  stopAllInProgress = true;
  try {
    const keys = new Set(Array.from(serveDaemons.keys()));
    try {
      await fsp.mkdir(SERVE_LOCK_DIR, { recursive: true });
      const dirs = await fsp.readdir(SERVE_LOCK_DIR, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const daemonPath = path.join(SERVE_LOCK_DIR, dir.name, 'daemon.json');
        const record = await readJsonSafe(daemonPath);
        if (record && record.key) keys.add(String(record.key));
      }
    } catch (_err) {
    }

    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      await stopServeDaemonByKey(key);
    }
  } finally {
    stopAllInProgress = false;
  }
}

function getServeDaemonStatusForInstance(instance) {
  const key = getServeScopeKey(instance);
  const entry = serveDaemons.get(key);
  if (entry) {
    return {
      active: true,
      key,
      ready: !!entry.ready,
      port: Number.isFinite(entry.port) ? entry.port : null,
      source: entry.external ? 'state-file' : 'memory',
    };
  }

  const paths = getServeScopePathsFromKey(key);
  let record = null;
  try {
    if (fs.existsSync(paths.daemonPath)) {
      record = JSON.parse(fs.readFileSync(paths.daemonPath, 'utf8'));
    }
  } catch (_err) {
  }

  if (!record || !isPidAlive(Number(record.pid))) {
    return { active: false, key, ready: false, port: null, source: 'none' };
  }

  return {
    active: true,
    key,
    ready: true,
    port: Number.isFinite(Number(record.port)) ? Number(record.port) : null,
    source: 'state-file',
  };
}

async function waitForServeReady(baseUrl) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < SERVE_READY_TIMEOUT_MS) {
    try {
      const res = await fetch(`${baseUrl}/doc`);
      if (res.ok) return;
    } catch (_err) {
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`opencode serve did not become ready within ${SERVE_READY_TIMEOUT_MS}ms`);
}

async function jsonRequest(baseUrl, route, options) {
  const res = await fetch(`${baseUrl}${route}`, options);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`serve ${route} failed (${res.status}): ${text.slice(0, 240)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_err) {
    return text;
  }
}

function openSSE(baseUrl, onPacket, onError) {
  const aborter = new AbortController();
  let closed = false;

  (async () => {
    try {
      const res = await fetch(`${baseUrl}/event`, {
        headers: { accept: 'text/event-stream' },
        signal: aborter.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`event stream unavailable (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const packets = buf.split('\n\n');
        buf = packets.pop() || '';

        for (const packet of packets) {
          const lines = packet.split('\n');
          const data = lines
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n');
          if (!data) continue;
          onPacket(data);
        }
      }
    } catch (err) {
      if (!closed) onError(err);
    }
  })();

  return {
    close() {
      closed = true;
      aborter.abort();
    },
  };
}

function runViaServe(instance, prompt, { onEvent, onDone, onError, sessionId }) {
  const { logStream } = setupLogStream(instance, prompt);
  const state = {
    done: false,
    killed: false,
    sessionId: sessionId || '',
    rateLimit: null,
    stderrSamples: [],
    partState: new Map(),
    partOrderSeq: 0,
    partDeltas: new Map(),
    waiting: null,
  };

  function partIndexValue(raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && Number.isInteger(n)) return n;
    return null;
  }

  function getPartState(partId, props = {}) {
    const id = String(partId || '').trim();
    if (!id) return null;

    let entry = state.partState.get(id);
    if (!entry) {
      entry = {
        id,
        type: '',
        text: '',
        preview: '',
        index: partIndexValue(props.index),
        seq: state.partOrderSeq++,
      };
      state.partState.set(id, entry);
    }

    const nextIndex = partIndexValue(props.index);
    if (nextIndex !== null) {
      if (entry.index === null || nextIndex < entry.index) {
        entry.index = nextIndex;
      }
    }

    if (props.type && !entry.type) entry.type = props.type;
    return entry;
  }

  function getPendingDeltas(partId) {
    return state.partDeltas.get(String(partId || '')) || { text: '', reasoning: '' };
  }

  function setPendingDeltas(partId, next) {
    if (!partId) return;
    const id = String(partId);
    if (!next.text && !next.reasoning) {
      state.partDeltas.delete(id);
      return;
    }
    state.partDeltas.set(id, next);
  }

  function mergePendingText(partId, targetType, baseText, existingText = '') {
    const pending = getPendingDeltas(partId);
    if (targetType !== 'text' && targetType !== 'reasoning') {
      return String(baseText || '');
    }

    const pendingText = targetType === 'reasoning' ? pending.reasoning : pending.text;
    const base = String(baseText || '');
    const existing = String(existingText || '');

    let merged = base;

    if (!merged) {
      merged = existing || '';
    } else if (!merged.includes(existing) && !existing.includes(merged)) {
      const needsJoin = existing.endsWith('\n') || merged.startsWith('\n');
      merged = existing + (needsJoin ? '' : '\n') + merged;
    } else if (existing) {
      merged = merged.includes(existing) ? merged : existing;
    }

    if (!pendingText) {
      if (targetType === 'reasoning') {
        pending.reasoning = '';
      } else {
        pending.text = '';
      }
      return merged;
    }

    if (merged.includes(pendingText)) {
      if (targetType === 'reasoning') {
        pending.reasoning = '';
      } else {
        pending.text = '';
      }
      return merged;
    }

    const needsJoin = merged.endsWith('\n') || pendingText.startsWith('\n');
    merged = merged + (needsJoin ? '' : '\n') + pendingText;

    if (targetType === 'reasoning') {
      pending.reasoning = '';
    } else {
      pending.text = '';
    }
    setPendingDeltas(partId, pending);
    return merged;
  }

  function getCombinedText() {
    const entries = Array.from(state.partState.entries()).map(([, entry]) => entry);
    entries.sort((a, b) => {
      const aHasIndex = a.index !== null;
      const bHasIndex = b.index !== null;
      if (aHasIndex && bHasIndex && a.index !== b.index) return a.index - b.index;
      if (aHasIndex !== bHasIndex) return aHasIndex ? -1 : 1;
      if (a.seq !== b.seq) return a.seq - b.seq;
      return String(a.id).localeCompare(String(b.id));
    });

    return entries
      .map((entry) => entry.text)
      .map((value) => String(value || '').trim())
      .filter((value) => value.length > 0)
      .join('\n\n');
  }

  let serveProc = null;
  let serveBaseUrl = '';
  let sse = null;
  let stdoutListener = null;
  let stderrListener = null;

  function finish(exitCode, timeoutMsg) {
    if (state.done) return;
    state.done = true;
    clearTimeout(timeout);
    if (sse) sse.close();
    if (serveProc && stdoutListener && serveProc.stdout) {
      serveProc.stdout.off('data', stdoutListener);
    }
    if (serveProc && stderrListener && serveProc.stderr) {
      serveProc.stderr.off('data', stderrListener);
    }
    logStream.end();
    onDone(exitCode, timeoutMsg, {
      sessionId: state.sessionId,
      rateLimit: state.rateLimit,
      stderrSamples: state.stderrSamples.slice(-5),
      finalText: getCombinedText(),
    });
  }

  function fail(err) {
    if (state.done) return;
    state.done = true;
    clearTimeout(timeout);
    if (sse) sse.close();
    if (serveProc && stdoutListener && serveProc.stdout) {
      serveProc.stdout.off('data', stdoutListener);
    }
    if (serveProc && stderrListener && serveProc.stderr) {
      serveProc.stderr.off('data', stderrListener);
    }
    logStream.end();
    onError(err);
  }

  async function abortSession() {
    if (!serveBaseUrl || !state.sessionId) return;
    try {
      await jsonRequest(serveBaseUrl, `/session/${state.sessionId}/abort`, { method: 'POST' });
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      maybeCaptureRateLimit(state, msg);
      state.stderrSamples.push(msg);
      if (state.stderrSamples.length > 5) state.stderrSamples.shift();
    }
  }

  const procHandle = {
    killed: false,
    stdout: null,
    stderr: null,
    kill(signal) {
      procHandle.killed = true;
      state.killed = true;
      const sig = String(signal || 'SIGTERM').toUpperCase();
      abortSession().catch(() => {});
      if (sig === 'SIGKILL') {
        setTimeout(() => {
          if (!state.done) {
            finish(143, null);
          }
        }, 120);
      }
      return true;
    },
  };

  const timeout = setTimeout(() => {
    if (state.done) return;
    state.killed = true;
    procHandle.kill('SIGTERM');
    setTimeout(() => {
      if (!state.done) procHandle.kill('SIGKILL');
    }, 5000);
    finish(null, `Process timed out after ${MAX_PROCESS_SEC}s`);
  }, MAX_PROCESS_SEC * 1000);

  (async () => {
    try {
      const daemon = await ensureServeDaemon(instance);
      serveProc = daemon.proc;
      serveBaseUrl = daemon.baseUrl;

      procHandle.stdout = serveProc ? serveProc.stdout : null;
      procHandle.stderr = serveProc ? serveProc.stderr : null;

      stdoutListener = (chunk) => {
        logStream.write(chunk.toString());
      };
      stderrListener = (chunk) => {
        const text = chunk.toString();
        logStream.write(text);
        const lines = text.split('\n').map((v) => v.trim()).filter(Boolean);
        for (const line of lines) {
          state.stderrSamples.push(line);
          if (state.stderrSamples.length > 5) state.stderrSamples.shift();
          maybeCaptureRateLimit(state, line);
        }
      };
      if (serveProc && serveProc.stdout && serveProc.stderr) {
        serveProc.stdout.on('data', stdoutListener);
        serveProc.stderr.on('data', stderrListener);
      }

      if (state.sessionId) {
        try {
          await jsonRequest(serveBaseUrl, `/session/${state.sessionId}`, { method: 'GET' });
        } catch (_err) {
          try {
            const resumed = await jsonRequest(serveBaseUrl, '/session', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                parentID: state.sessionId,
                title: `hermux ${new Date().toISOString()}`,
              }),
            });
            state.sessionId = String(resumed && resumed.id ? resumed.id : '').trim();
          } catch (_e2) {
            state.sessionId = '';
          }
        }
      }

      if (!state.sessionId) {
        const session = await jsonRequest(serveBaseUrl, '/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: `hermux ${new Date().toISOString()}` }),
        });
        state.sessionId = String(session && session.id ? session.id : '').trim();
      }

      if (!state.sessionId) {
        throw new Error('failed to establish serve session id');
      }

      sse = openSSE(
        serveBaseUrl,
        (packet) => {
          if (state.done) return;
          logStream.write(packet + '\n');
          maybeCaptureRateLimit(state, packet);
          let evt = null;
          try {
            evt = JSON.parse(packet);
          } catch (_err) {
            onEvent({ type: 'raw', content: packet, sessionId: state.sessionId });
            return;
          }

          const type = String(evt.type || '');
          const props = evt.properties || {};

          if (type === 'session.status' && String(props.sessionID || '') === state.sessionId) {
            const statusType = String((props.status || {}).type || '').trim().toLowerCase();
            if (statusType === 'retry') {
              state.waiting = { kind: 'retry' };
              onEvent({ type: 'wait', status: 'retry', sessionId: state.sessionId });
            }
            if (statusType === 'busy') {
              onEvent({ type: 'step_start', sessionId: state.sessionId });
            }
            return;
          }

          if (type === 'session.idle' && String(props.sessionID || '') === state.sessionId) {
            clearTimeout(timeout);
            finish(0, null);
            return;
          }

          if (type === 'message.part.delta') {
            const sid = String(props.sessionID || '');
            if (sid !== state.sessionId) return;
            const partId = String(props.partID || '');
            const field = String(props.field || '');
            if (field !== 'text') return;
            if (!partId) return;
            const delta = String(props.delta || '');
            if (!delta) return;

            const partState = getPartState(partId, { index: props.partIndex, type: props.type });
            if (partState.type === 'text') {
              partState.text = String(partState.text || '') + delta;
              onEvent({ type: 'text', content: getCombinedText(), textKind: 'final', sessionId: state.sessionId });
              return;
            }

            if (partState.type === 'reasoning') {
              partState.preview = String(partState.preview || '') + delta;
              onEvent({ type: 'text', content: partState.preview, textKind: 'reasoning', sessionId: state.sessionId });
              return;
            }

            const pending = getPendingDeltas(partId);
            if (field === 'text') {
              pending.text += delta;
              setPendingDeltas(partId, pending);
            }
            return;
          }

          if (type === 'message.part.updated') {
            const part = props.part || {};
            const sid = String(part.sessionID || '');
            if (sid !== state.sessionId) return;
            const ptype = String(part.type || '');
            const partId = String(part.id || '');
            const partState = partId ? getPartState(partId, { index: part.index, type: ptype }) : null;

            if (ptype === 'step-start') {
              onEvent({ type: 'step_start', sessionId: state.sessionId });
              return;
            }
            if (ptype === 'step-finish') {
              onEvent({ type: 'step_finish', reason: part.reason || null, sessionId: state.sessionId });
              return;
            }

            if (partState) {
              partState.type = ptype;
            }

            if (ptype === 'text') {
              const baseText = String(part.text || '');
              const mergedText = partId
                ? mergePendingText(partId, 'text', baseText, partState ? partState.text : '')
                : baseText;
              if (partState && partId) {
                partState.text = mergedText;
                onEvent({ type: 'text', content: getCombinedText(), textKind: 'final', sessionId: state.sessionId });
              } else {
                onEvent({ type: 'text', content: mergedText, textKind: 'final', sessionId: state.sessionId });
              }
              return;
            }

            if (ptype === 'reasoning') {
              const baseText = String(part.text || '');
              const mergedText = partId
                ? mergePendingText(partId, 'reasoning', baseText, partState ? partState.preview : '')
                : baseText;
              if (partState && partId) {
                partState.preview = mergedText;
              }
              if (mergedText) {
                onEvent({ type: 'text', content: mergedText, textKind: 'reasoning', sessionId: state.sessionId });
              }
              return;
            }

            if (ptype === 'tool') {
              const toolState = part.state || {};
              onEvent({
                type: 'tool_use',
                name: part.tool || 'tool',
                input: toolState.input || {},
                output: toolState.output || '',
                sessionId: state.sessionId,
              });
              return;
            }

            if (partState && partId) {
              partState.type = ptype;
            }
            onEvent({ type: 'raw', content: packet, sessionId: state.sessionId });
          }
        },
        (err) => {
          if (!state.done) {
            clearTimeout(timeout);
            fail(err);
          }
        }
      );

      await jsonRequest(serveBaseUrl, `/session/${state.sessionId}/prompt_async`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: prompt }],
        }),
      });
    } catch (err) {
      clearTimeout(timeout);
      fail(err);
    }
  })();

  return procHandle;
}

function runOpencode(instance, prompt, handlers) {
  if (shouldUseServe(instance)) {
    return runViaServe(instance, prompt, handlers);
  }
  return runViaCommand(instance, prompt, handlers);
}

module.exports = {
  runOpencode,
  stopAllServeDaemons,
  getServeDaemonStatusForInstance,
  _internal: {
    toValidPortRange,
    pickRandomAvailablePortInRange,
    getServeScopeKey,
    getServeScopePathsForInstance,
    stopServeDaemonForInstance,
  },
};
