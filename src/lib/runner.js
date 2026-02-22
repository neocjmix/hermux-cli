'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const MAX_PROCESS_SEC = parseInt(process.env.OMG_MAX_PROCESS_SECONDS || '3600', 10);
const SERVE_READY_TIMEOUT_MS = parseInt(process.env.OMG_SERVE_READY_TIMEOUT_MS || '15000', 10);

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

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
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
  const cmdParts = String(instance.opencodeCommand || '').trim().split(/\s+/).filter(Boolean);
  const bin = cmdParts[0] || 'opencode';
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
  let sse = null;
  let port = 0;

  function finish(exitCode, timeoutMsg) {
    if (state.done) return;
    state.done = true;
    clearTimeout(timeout);
    if (sse) sse.close();
    if (serveProc && !serveProc.killed) {
      try {
        serveProc.kill('SIGKILL');
      } catch (_err) {
      }
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
    if (serveProc && !serveProc.killed) {
      try {
        serveProc.kill('SIGKILL');
      } catch (_err) {
      }
    }
    logStream.end();
    onError(err);
  }

  async function abortSession() {
    if (!port || !state.sessionId) return;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await jsonRequest(baseUrl, `/session/${state.sessionId}/abort`, { method: 'POST' });
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
      if (sig === 'SIGKILL' && serveProc && !serveProc.killed) {
        try {
          serveProc.kill('SIGKILL');
        } catch (_err) {
        }
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
      port = await getFreePort();
      const baseUrl = `http://127.0.0.1:${port}`;

      serveProc = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: instance.workdir,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      procHandle.stdout = serveProc.stdout;
      procHandle.stderr = serveProc.stderr;

      serveProc.stdout.on('data', (chunk) => {
        logStream.write(chunk.toString());
      });
      serveProc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        logStream.write(text);
        const lines = text.split('\n').map((v) => v.trim()).filter(Boolean);
        for (const line of lines) {
          state.stderrSamples.push(line);
          if (state.stderrSamples.length > 5) state.stderrSamples.shift();
          maybeCaptureRateLimit(state, line);
        }
      });

      serveProc.on('error', (err) => {
        clearTimeout(timeout);
        fail(err);
      });

      await waitForServeReady(baseUrl);

      if (state.sessionId) {
        try {
          await jsonRequest(baseUrl, `/session/${state.sessionId}`, { method: 'GET' });
        } catch (_err) {
          try {
            const resumed = await jsonRequest(baseUrl, '/session', {
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
        const session = await jsonRequest(baseUrl, '/session', {
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
        baseUrl,
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

      await jsonRequest(baseUrl, `/session/${state.sessionId}/prompt_async`, {
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

module.exports = { runOpencode };
