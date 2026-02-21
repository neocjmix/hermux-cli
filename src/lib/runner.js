'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_PROCESS_SEC = parseInt(process.env.OMG_MAX_PROCESS_SECONDS || '3600', 10);

function runOpencode(instance, prompt, { onEvent, onDone, onError, sessionId }) {
  const cmdParts = instance.opencodeCommand.split(/\s+/);
  const cmd = cmdParts[0];
  const cmdArgs = [...cmdParts.slice(1), '--format', 'json'];

  if (sessionId) {
    cmdArgs.push('--session', sessionId);
  }

  cmdArgs.push(prompt);

  const logDir = path.dirname(path.resolve(instance.logFile || './logs/default.log'));
  fs.mkdirSync(logDir, { recursive: true });

  const logStream = fs.createWriteStream(
    path.resolve(instance.logFile || './logs/default.log'),
    { flags: 'a' }
  );
  logStream.write(`\n--- ${new Date().toISOString()} | prompt: ${prompt} ---\n`);

  const proc = spawn(cmd, cmdArgs, {
    cwd: instance.workdir,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let lineBuf = '';
  let killed = false;
  let latestSessionId = sessionId || '';

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
        onEvent({ type: 'text', content: part.text || '', sessionId: latestSessionId });
        return;
      }

      if (evt.type === 'tool_use') {
        const state = part.state || {};
        onEvent({
          type: 'tool_use',
          name: part.tool || 'tool',
          input: state.input || {},
          output: state.output || '',
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
    logStream.write(data.toString());
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
          } catch (_err) {}
        }
      }, 5000);
    }
  }, MAX_PROCESS_SEC * 1000);

  proc.on('close', (code) => {
    clearTimeout(timeout);
    if (lineBuf.trim()) parseLine(lineBuf);
    logStream.end();
    if (killed) {
      onDone(null, `Process timed out after ${MAX_PROCESS_SEC}s`, { sessionId: latestSessionId });
    } else {
      onDone(code, null, { sessionId: latestSessionId });
    }
  });

  proc.on('error', (err) => {
    clearTimeout(timeout);
    logStream.end();
    onError(err);
  });

  return proc;
}

module.exports = { runOpencode };
