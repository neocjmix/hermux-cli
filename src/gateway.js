#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const fsp = require('fs/promises');
const { pipeline } = require('stream/promises');
const { spawn, spawnSync } = require('child_process');
const TelegramBot = require('node-telegram-bot-api');
const { load, getEnabledRepos, addChatIdToRepo, addOrUpdateRepo, setGlobalBotToken, resetConfig, CONFIG_PATH } = require('./lib/config');
const { runOpencode } = require('./lib/runner');
const { md2html, escapeHtml } = require('./lib/md2html');
const { getSessionId, setSessionId, clearSessionId, getSessionInfo, clearAllSessions, SESSION_MAP_PATH } = require('./lib/session-map');
const { version: HERMUX_VERSION } = require('../package.json');

const TG_MAX_LEN = 4000;
const IMAGE_UPLOAD_DIR = '.opencode_mobile_gateway/uploads';
const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const PID_PATH = path.join(RUNTIME_DIR, 'gateway.pid');
const LOG_PATH = path.join(RUNTIME_DIR, 'gateway.log');
const RESTART_NOTICE_PATH = path.join(RUNTIME_DIR, 'restart-notice.json');
const MERMAID_RENDER_DIR = '.opencode_mobile_gateway/mermaid';
const STREAM_EDIT_MIN_INTERVAL_COMPACT_MS = 1200;
const STREAM_EDIT_MIN_INTERVAL_VERBOSE_MS = 350;
let connectMutationQueue = Promise.resolve();
let restartMutationQueue = Promise.resolve();
let restartInProgress = false;

function withConnectMutationLock(task) {
  const run = connectMutationQueue.then(task, task);
  connectMutationQueue = run.catch(() => {});
  return run;
}

function withRestartMutationLock(task) {
  const run = restartMutationQueue.then(task, task);
  restartMutationQueue = run.catch(() => {});
  return run;
}

function withStateDispatchLock(state, task) {
  if (!state.dispatchQueue) state.dispatchQueue = Promise.resolve();
  const run = state.dispatchQueue.then(task, task);
  state.dispatchQueue = run.catch(() => {});
  return run;
}

function clearInterruptEscalationTimer(state) {
  if (!state || !state.interruptEscalationTimer) return;
  clearTimeout(state.interruptEscalationTimer);
  state.interruptEscalationTimer = null;
}

function sendInterruptSignal(proc, signal) {
  if (!proc) return;
  const pid = Number(proc.pid || 0);
  if (process.platform !== 'win32' && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (_err) {
    }
  }
  proc.kill(signal);
}

function requestInterrupt(state, { forceAfterMs = 5000, sendSignal = sendInterruptSignal } = {}) {
  if (!state || !state.running || !state.currentProc) {
    return { ok: false, reason: 'no_running_task' };
  }

  if (state.interruptRequested) {
    return { ok: true, alreadyRequested: true };
  }

  state.interruptRequested = true;
  clearInterruptEscalationTimer(state);
  state.interruptTrace = {
    requestedAt: Date.now(),
    termSentAt: null,
    killSentAt: null,
    forceAfterMs,
    status: 'requested',
  };

  try {
    sendSignal(state.currentProc, 'SIGTERM');
    state.interruptTrace.termSentAt = Date.now();
    state.interruptTrace.status = 'term_sent';
  } catch (err) {
    state.interruptRequested = false;
    if (state.interruptTrace) state.interruptTrace.status = 'term_failed';
    return { ok: false, reason: 'term_failed', error: err };
  }

  state.interruptEscalationTimer = setTimeout(() => {
    const proc = state.currentProc;
    if (!state.running || !proc) return;
    try {
      sendSignal(proc, 'SIGKILL');
      if (state.interruptTrace) {
        state.interruptTrace.killSentAt = Date.now();
        state.interruptTrace.status = 'kill_sent';
      }
    } catch (_err) {
    }
    // Force-destroy stdio streams so the child 'close' event fires
    // immediately instead of waiting for grandchild processes to exit.
    try {
      if (proc.stdout && !proc.stdout.destroyed) proc.stdout.destroy();
      if (proc.stderr && !proc.stderr.destroyed) proc.stderr.destroy();
    } catch (_err) {
    }
  }, forceAfterMs);

  return { ok: true, alreadyRequested: false };
}

function serializePollingError(err) {
  const response = err && err.response ? err.response : {};
  const body = response && response.body ? response.body : {};
  const result = body && body.result ? body.result : {};
  return {
    code: String((err && err.code) || ''),
    message: String((err && err.message) || ''),
    httpStatus: Number(response.statusCode || 0) || null,
    tgErrorCode: Number(body.error_code || 0) || null,
    description: String(body.description || ''),
    parameters: body.parameters || null,
    migrateToChatId: result && result.migrate_to_chat_id ? String(result.migrate_to_chat_id) : '',
    retryAfter: result && result.retry_after ? Number(result.retry_after) : null,
  };
}

function getHelpText() {
  return [
    'Commands:',
    '/onboard - chat-based repo onboarding wizard',
    '/onboard cancel - cancel onboarding wizard',
    '/init - clear repos/chat mappings/sessions (safe reset)',
    '/init confirm - run reset',
    '/start - show repo mapping info',
    '/repos - list connectable repos',
    '/connect <repo> - bind this chat to a repo',
    '/status - show runtime state',
    '/session - show current opencode session id',
    '/version - show opencode output + hermux version',
    '/interrupt - stop current running task',
    '/restart - restart daemon process',
    '/reset - reset current chat session',
    '/verbose on - enable tool/step stream',
    '/verbose off - final output only',
    '/whereami - show current chat ID and repo mapping',
    '',
    'Agent quick flow (copy to your coding agent):',
    '1) Ask me for token/repo/workdir/opencode command',
    '2) Tell me to run /onboard in Telegram and answer prompts',
    '3) After setup, run /whereami and /status',
    '',
    'Group setup:',
    '1) Run /onboard and answer prompts',
    '2) Create repo group and invite this bot',
    '3) In that group, run /repos',
    '4) In that group, run /connect <repo>',
    'Tip: /connect and /verbose support button selections too.',
    '',
    'Note: if group messages are not visible, check Telegram bot privacy mode.',
  ].join('\n');
}

function parseYesNo(input) {
  const v = String(input || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'y' || v === 'yes') return true;
  if (v === 'n' || v === 'no') return false;
  return null;
}

function formatOnboardingQuestion(session) {
  if (session.step === 'token_mode') {
    return [
      'Onboarding step 1/5',
      'Global Telegram bot token already exists.',
      'Type: reuse or replace',
      'cancel anytime: /onboard cancel',
    ].join('\n');
  }

  if (session.step === 'token_input') {
    return [
      'Onboarding step 1/5',
      'Send global Telegram bot token (format: 123456789:ABC-DEF...)',
      'cancel anytime: /onboard cancel',
    ].join('\n');
  }

  if (session.step === 'repo_name') {
    return [
      'Onboarding step 2/5',
      'Send repo name (letters, numbers, -, _)',
      'example: my-project',
    ].join('\n');
  }

  if (session.step === 'workdir') {
    return [
      'Onboarding step 3/5',
      'Send absolute repo workdir path',
      'example: /Users/name/work/my-project',
    ].join('\n');
  }

  if (session.step === 'opencode_command') {
    return [
      'Onboarding step 4/5',
      'Send opencode command, or type default',
      'default: opencode run',
    ].join('\n');
  }

  if (session.step === 'attach_chat') {
    return [
      'Onboarding step 5/5',
      'Connect this chat to the new repo now? (yes/no)',
      'If no, you can connect later with /connect <repo>',
    ].join('\n');
  }

  return 'Onboarding state error. Run /onboard again.';
}

function createOnboardingSession(chatId) {
  const config = load();
  const existingToken = String((config.global || {}).telegramBotToken || '').trim();
  return {
    chatId,
    step: existingToken ? 'token_mode' : 'token_input',
    data: {
      botToken: existingToken || '',
      name: '',
      workdir: '',
      opencodeCommand: 'opencode run',
      attachChat: true,
    },
  };
}

function finalizeOnboarding(session, chatId) {
  const repo = {
    name: session.data.name,
    enabled: true,
    workdir: session.data.workdir,
    chatIds: [],
    opencodeCommand: session.data.opencodeCommand,
    logFile: `./logs/${session.data.name}.log`,
  };

  setGlobalBotToken(session.data.botToken);
  addOrUpdateRepo(repo);

  if (!session.data.attachChat) {
    return { ok: true, attached: false };
  }

  const attach = addChatIdToRepo(session.data.name, chatId);
  if (!attach.ok && attach.reason !== 'chat_already_mapped') {
    return { ok: false, reason: attach.reason };
  }

  return {
    ok: true,
    attached: attach.ok,
    changed: !!attach.changed,
    reason: attach.reason || '',
    existingRepo: attach.existingRepo || '',
  };
}

async function handleOnboardCommand(bot, chatId, parsed, chatRouter, states, onboardingSessions) {
  const arg = String((parsed && parsed.args && parsed.args[0]) || '').trim().toLowerCase();
  if (arg === 'cancel') {
    if (onboardingSessions.delete(chatId)) {
      await safeSend(bot, chatId, 'Onboarding cancelled. Run /onboard to start again.');
      return true;
    }
    await safeSend(bot, chatId, 'No onboarding session in progress. Run /onboard to start.');
    return true;
  }

  let session = onboardingSessions.get(chatId);
  if (!session) {
    session = createOnboardingSession(chatId);
    onboardingSessions.set(chatId, session);
    await safeSend(
      bot,
      chatId,
      [
        'Starting chat onboarding wizard.',
        `Config file: ${CONFIG_PATH}`,
        '',
        formatOnboardingQuestion(session),
      ].join('\n')
    );
    return true;
  }

  await safeSend(bot, chatId, formatOnboardingQuestion(session));
  return true;
}

async function handleInitCommand(bot, chatId, parsed, states, onboardingSessions, initSessions, chatRouter) {
  const arg = String((parsed && parsed.args && parsed.args[0]) || '').trim().toLowerCase();

  if (arg !== 'confirm') {
    initSessions.set(chatId, { createdAt: Date.now() });
    await safeSend(
      bot,
      chatId,
      [
        'Initialize mode (safe reset).',
        '- clears all repos/chat mappings',
        '- clears all saved opencode sessions',
        '- keeps global Telegram bot token',
        '',
        'Run /init confirm to proceed.',
        'Run /onboard after reset to add repo again.',
      ].join('\n')
    );
    return true;
  }

  if (!initSessions.has(chatId)) {
    await safeSend(bot, chatId, 'Run /init first, then /init confirm.');
    return true;
  }

  const running = Array.from(states.values()).some(s => s && s.running);
  if (running) {
    await safeSend(bot, chatId, 'Cannot initialize while a task is running. Wait and retry.');
    return true;
  }

  try {
    const configResult = resetConfig({ keepToken: true });
    const clearedSessions = clearAllSessions();
    onboardingSessions.clear();
    initSessions.clear();
    refreshRuntimeRouting(chatRouter, states);

    await safeSend(
      bot,
      chatId,
      [
        'Initialization complete.',
        `cleared repos: ${configResult.clearedRepos}`,
        `cleared sessions: ${clearedSessions}`,
        `token kept: ${configResult.hadToken ? 'yes' : 'no (no token existed)'}`,
        '',
        'Next: run /onboard to add repo again.',
      ].join('\n')
    );
    return true;
  } catch (err) {
    await safeSend(bot, chatId, `Initialization failed: ${err.message}`);
    return true;
  }
}

async function handleOnboardingInput(bot, chatId, text, chatRouter, states, onboardingSessions) {
  const session = onboardingSessions.get(chatId);
  if (!session) return false;

  const value = String(text || '').trim();

  if (session.step === 'token_mode') {
    const mode = value.toLowerCase();
    if (mode !== 'reuse' && mode !== 'replace') {
      await safeSend(bot, chatId, 'Please reply with: reuse or replace');
      return true;
    }
    session.step = mode === 'reuse' ? 'repo_name' : 'token_input';
    await safeSend(bot, chatId, formatOnboardingQuestion(session));
    return true;
  }

  if (session.step === 'token_input') {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(value)) {
      await safeSend(bot, chatId, 'Invalid token format. Expected: 123456789:ABC-DEF...');
      return true;
    }
    session.data.botToken = value;
    session.step = 'repo_name';
    await safeSend(bot, chatId, formatOnboardingQuestion(session));
    return true;
  }

  if (session.step === 'repo_name') {
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
      await safeSend(bot, chatId, 'Invalid repo name. Use letters, numbers, dash, underscore only.');
      return true;
    }
    session.data.name = value;
    session.step = 'workdir';
    await safeSend(bot, chatId, formatOnboardingQuestion(session));
    return true;
  }

  if (session.step === 'workdir') {
    if (!path.isAbsolute(value)) {
      await safeSend(bot, chatId, 'Workdir must be an absolute path.');
      return true;
    }
    if (!fs.existsSync(value) || !fs.statSync(value).isDirectory()) {
      await safeSend(bot, chatId, 'Workdir directory does not exist. Send another path.');
      return true;
    }
    session.data.workdir = value;
    session.step = 'opencode_command';
    await safeSend(bot, chatId, formatOnboardingQuestion(session));
    return true;
  }

  if (session.step === 'opencode_command') {
    if (value.toLowerCase() === 'default' || !value) {
      session.data.opencodeCommand = 'opencode run';
    } else {
      session.data.opencodeCommand = value;
    }
    session.step = 'attach_chat';
    await safeSend(bot, chatId, formatOnboardingQuestion(session));
    return true;
  }

  if (session.step === 'attach_chat') {
    const yesNo = parseYesNo(value);
    if (yesNo === null) {
      await safeSend(bot, chatId, 'Please answer yes or no.');
      return true;
    }
    session.data.attachChat = yesNo;

    try {
      const result = finalizeOnboarding(session, chatId);
      refreshRuntimeRouting(chatRouter, states);
      onboardingSessions.delete(chatId);

      if (!result.ok) {
        await safeSend(
          bot,
          chatId,
          [
            `Saved repo ${session.data.name}, but chat attach failed (${result.reason}).`,
            'You can retry later with: /connect <repo>',
          ].join('\n')
        );
        return true;
      }

      if (result.reason === 'chat_already_mapped') {
        await safeSend(
          bot,
          chatId,
          [
            `Repo saved: ${session.data.name}`,
            `This chat is already connected to: ${result.existingRepo}`,
            `To connect new repo later, use: /connect ${session.data.name}`,
          ].join('\n')
        );
        return true;
      }

      const attachLine = session.data.attachChat
        ? (result.changed ? `Connected this chat to ${session.data.name}.` : `This chat is already connected to ${session.data.name}.`)
        : `Chat was not connected. Use /connect ${session.data.name} when ready.`;

      await safeSend(
        bot,
        chatId,
        [
          'Onboarding complete.',
          `repo: ${session.data.name}`,
          `workdir: ${session.data.workdir}`,
          attachLine,
          '',
          'Next: /whereami, /status, then send your prompt.',
        ].join('\n')
      );
      return true;
    } catch (err) {
      onboardingSessions.delete(chatId);
      await safeSend(bot, chatId, `Onboarding failed: ${err.message}\nRun /onboard to retry.`);
      return true;
    }
  }

  await safeSend(bot, chatId, 'Onboarding state error. Run /onboard to restart.');
  onboardingSessions.delete(chatId);
  return true;
}

function parseCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  const head = parts[0].split('@')[0].toLowerCase();
  return {
    command: head,
    args: parts.slice(1),
  };
}

function splitByLimit(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const out = [];
  let rest = text;
  while (rest.length > 0) {
    let cut = maxLen;
    const nl = rest.lastIndexOf('\n', maxLen);
    if (nl > maxLen * 0.3) cut = nl + 1;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return out;
}

async function safeSend(bot, chatId, text, opts) {
  try {
    return await bot.sendMessage(chatId, text, opts);
  } catch (err) {
    console.error('send failed:', err.code || err.message, '| chat:', chatId, '| parse_mode:', opts && opts.parse_mode ? opts.parse_mode : 'none');
    if (opts && opts.parse_mode) {
      try {
        return await bot.sendMessage(chatId, text);
      } catch (e) {
        console.error('plain send also failed:', e.code || e.message, '| chat:', chatId);
      }
    }
  }
  return null;
}

async function sendHtml(bot, chatId, html) {
  const chunks = splitByLimit(html, TG_MAX_LEN);
  let lastMsg = null;
  for (const c of chunks) {
    lastMsg = await safeSend(bot, chatId, c, { parse_mode: 'HTML' });
  }
  return lastMsg;
}

async function editHtml(bot, chatId, messageId, html) {
  const truncated = html.length > TG_MAX_LEN ? html.slice(0, TG_MAX_LEN - 3) + '...' : html;
  try {
    await bot.editMessageText(truncated, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
  } catch (err) {
    if (!err.message.includes('message is not modified')) {
      console.error('edit failed:', err.code || err.message, '| chat:', chatId, '| message_id:', messageId);
      try {
        await bot.editMessageText(truncated, { chat_id: chatId, message_id: messageId });
      } catch (e) {
        console.error('plain edit also failed:', e.code || e.message, '| chat:', chatId, '| message_id:', messageId);
      }
    }
  }
}

async function safeSendPhoto(bot, chatId, filePath, caption) {
  try {
    const stream = fs.createReadStream(filePath);
    return await bot.sendPhoto(chatId, stream, caption ? { caption } : undefined);
  } catch (err) {
    console.error('send photo failed:', err.message);
    return null;
  }
}

async function safeSendDocument(bot, chatId, filePath, caption) {
  try {
    const stream = fs.createReadStream(filePath);
    return await bot.sendDocument(chatId, stream, caption ? { caption } : undefined);
  } catch (err) {
    console.error('send document failed:', err.message);
    return null;
  }
}

function extractMermaidBlocks(text) {
  const src = String(text || '');
  const out = [];
  const re = /```mermaid\s*([\s\S]*?)```/gi;
  let m = null;
  while ((m = re.exec(src)) !== null) {
    const body = String(m[1] || '').trim();
    if (body) out.push(body);
  }
  return out;
}

function hasMermaidRenderer() {
  try {
    const found = spawnSync('which', ['mmdc'], { stdio: 'ignore' });
    return found.status === 0;
  } catch (_err) {
    return false;
  }
}

function renderMermaidArtifacts(instance, chatId, blocks) {
  const capped = blocks.slice(0, 3);
  const artifacts = [];
  const dir = path.resolve(instance.workdir, MERMAID_RENDER_DIR);
  fs.mkdirSync(dir, { recursive: true });

  for (let i = 0; i < capped.length; i++) {
    const now = new Date().toISOString().replace(/[.:]/g, '-');
    const base = `tg_${String(chatId).replace(/[^0-9-]/g, '_')}_${now}_${i + 1}`;
    const inPath = path.join(dir, `${base}.mmd`);
    const outSvgPath = path.join(dir, `${base}.svg`);
    const outPngPath = path.join(dir, `${base}.png`);
    fs.writeFileSync(inPath, capped[i] + '\n', 'utf8');

    const renderedSvg = spawnSync('mmdc', ['-i', inPath, '-o', outSvgPath, '-b', 'transparent'], {
      cwd: instance.workdir,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: 'pipe',
      encoding: 'utf8',
    });

    if (renderedSvg.status === 0 && fs.existsSync(outSvgPath)) {
      artifacts.push({ kind: 'svg', path: outSvgPath });
      continue;
    }

    const renderedPng = spawnSync('mmdc', ['-i', inPath, '-o', outPngPath, '-b', 'transparent'], {
      cwd: instance.workdir,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: 'pipe',
      encoding: 'utf8',
    });

    if (renderedPng.status === 0 && fs.existsSync(outPngPath)) {
      artifacts.push({ kind: 'png', path: outPngPath });
    } else {
      const stderrSvg = String(renderedSvg.stderr || '').trim();
      const stderrPng = String(renderedPng.stderr || '').trim();
      console.error(`[mermaid] render failed (${i + 1}) svg=${stderrSvg || 'n/a'} png=${stderrPng || 'n/a'}`);
    }
  }

  return artifacts;
}

function formatToolBrief(evt) {
  const name = evt.name || 'tool';
  const input = evt.input || {};
  let title = name;
  if (input.command) title = `${name}: ${input.command.slice(0, 60)}`;
  else if (input.filePath) title = `${name}: ${input.filePath.split('/').pop()}`;
  else if (input.pattern) title = `${name}: ${input.pattern.slice(0, 40)}`;
  return title;
}

function buildNoOutputMessage({ exitCode, stepCount, toolCount, toolNames, stepReason, rawSamples, logFile }) {
  const status = exitCode === 0 ? 'done (no final text)' : `exit ${exitCode}`;
  const lines = [
    'No final answer text was produced by opencode.',
    `status: ${status}`,
    `steps: ${stepCount}, tools: ${toolCount}`,
  ];

  const recentTools = toolNames.slice(-5);
  if (recentTools.length > 0) {
    lines.push(`recent tools: ${recentTools.join(' | ')}`);
  }

  if (stepReason) {
    lines.push(`last step reason: ${stepReason}`);
  }

  if (rawSamples.length > 0) {
    lines.push('recent raw events:');
    rawSamples.forEach((raw, idx) => {
      lines.push(`${idx + 1}. ${raw}`);
    });
  }

  if (logFile) {
    lines.push(`log: ${logFile}`);
  }

  lines.push('Tip: use /verbose on and retry to see intermediate events.');
  return lines.join('\n');
}

function appendHermuxVersion(text, version) {
  const base = String(text || '').trimEnd();
  const tag = `hermux version: ${version}`;
  if (!base) return tag;
  return `${base}\n\n${tag}`;
}

function buildStreamingStatusHtml(text, verbose) {
  const raw = String(text || '');
  if (verbose) {
    const tailVerbose = raw.length > 1800 ? '...' + raw.slice(-1800) : raw;
    return `<b>Streaming response...</b>\n\n<pre>${escapeHtml(tailVerbose)}</pre>`;
  }

  const compact = raw.replace(/\s+/g, ' ').trim();
  const tailCompact = compact.length > 240 ? '...' + compact.slice(-240) : compact;
  const chars = compact.length;
  return `<b>Streaming response...</b>\n<code>mode: compact | chars: ${chars}</code>\n\n${escapeHtml(tailCompact || '(waiting for content)')}`;
}

function buildLiveStatusPanelHtml({
  repoName,
  verbose,
  phase,
  stepCount,
  toolCount,
  queueLength,
  sessionId,
  lastTool,
  lastRaw,
  lastStepReason,
}) {
  const phaseIcon = phase === 'running'
    ? '🏃'
    : phase === 'done'
      ? '✅'
      : phase === 'interrupted'
        ? '🛑'
        : phase === 'timeout'
          ? '⏱️'
          : '❌';

  const lines = [];
  lines.push(`<b>${phaseIcon} ${escapeHtml(repoName)} · ${escapeHtml(phase)}</b>`);
  if (verbose) {
    lines.push('<code>🧠 verbose</code>');
  }
  lines.push(`<code>🔁 ${stepCount} · 🧰 ${toolCount}</code>`);
  if ((queueLength || 0) > 0) {
    lines.push(`<code>📥 queue: ${queueLength}</code>`);
  }

  const shortSession = String(sessionId || '').trim();
  if (shortSession) {
    lines.push(`<code>🪪 ${escapeHtml(shortSession.slice(0, 20))}</code>`);
  }


  if (lastTool) {
    const t = String(lastTool).trim();
    const tt = t.length > 110 ? t.slice(0, 110) + '...' : t;
    lines.push(`🔧 <code>${escapeHtml(tt)}</code>`);
  }

  if (lastStepReason) {
    const r = String(lastStepReason).trim();
    if (r) lines.push(`📍 <code>${escapeHtml(r)}</code>`);
  }

  if (lastRaw && verbose) {
    const raw = String(lastRaw).trim();
    const rawTail = raw.length > 160 ? raw.slice(0, 160) + '...' : raw;
    lines.push(`🧾 <code>${escapeHtml(rawTail)}</code>`);
  }

  const out = lines.join('\n');
  return out.length > 3800 ? out.slice(0, 3797) + '...' : out;
}

function getImagePayloadFromMessage(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const bestPhoto = msg.photo[msg.photo.length - 1];
    return {
      fileId: bestPhoto.file_id,
      ext: '.jpg',
      source: 'photo',
    };
  }

  if (msg.document && typeof msg.document.mime_type === 'string' && msg.document.mime_type.startsWith('image/')) {
    const byName = path.extname(msg.document.file_name || '');
    let ext = byName;
    if (!ext) {
      const subtype = msg.document.mime_type.split('/')[1] || 'jpg';
      ext = '.' + subtype.toLowerCase();
    }
    return {
      fileId: msg.document.file_id,
      ext,
      source: 'document',
    };
  }

  return null;
}

function normalizeImageExt(ext) {
  if (!ext || typeof ext !== 'string') return '.jpg';
  const cleaned = ext.toLowerCase();
  if (!/^\.[a-z0-9]{2,8}$/.test(cleaned)) return '.jpg';
  return cleaned;
}

function getReplyContext(msg) {
  const replied = msg && msg.reply_to_message;
  if (!replied) return '';

  const candidate = String(replied.text || replied.caption || '').trim();
  if (!candidate) return '';

  return candidate.length > 1200 ? candidate.slice(0, 1200) + '...' : candidate;
}

async function downloadTelegramImage(bot, instance, fileId, ext, msg) {
  const dir = path.resolve(instance.workdir, IMAGE_UPLOAD_DIR);
  await fsp.mkdir(dir, { recursive: true });

  const now = new Date().toISOString().replace(/[.:]/g, '-');
  const chatId = String(msg.chat.id).replace(/[^0-9-]/g, '_');
  const messageId = String(msg.message_id || '0').replace(/[^0-9]/g, '_');
  const fileName = `tg_${chatId}_${messageId}_${now}${normalizeImageExt(ext)}`;
  const outputPath = path.join(dir, fileName);

  const inStream = bot.getFileStream(fileId);
  await pipeline(inStream, fs.createWriteStream(outputPath));

  return outputPath;
}

async function buildPromptFromMessage(bot, instance, msg) {
  const text = (msg.text || '').trim();
  const replyContext = getReplyContext(msg);
  const imagePayload = getImagePayloadFromMessage(msg);

  if (!imagePayload) {
    if (!text && !replyContext) return null;

    if (text && !replyContext) {
      return { prompt: text, preview: text };
    }

    if (!text && replyContext) {
      const prompt = [
        'Continue based on this replied Telegram message context:',
        '',
        '[Reply context]',
        replyContext,
      ].join('\n');
      return { prompt, preview: '[reply context]' };
    }

    const prompt = [
      text,
      '',
      '[Reply context]',
      replyContext,
    ].join('\n');
    return { prompt, preview: text };
  }

  const imagePath = await downloadTelegramImage(bot, instance, imagePayload.fileId, imagePayload.ext, msg);
  const caption = (msg.caption || '').trim();
  const userText = caption || text;

  const promptLines = [];
  if (userText) {
    promptLines.push(userText);
  } else {
    promptLines.push('Use the attached Telegram image to complete my request.');
  }

  if (replyContext) {
    promptLines.push('');
    promptLines.push('[Reply context]');
    promptLines.push(replyContext);
  }

  promptLines.push('');
  promptLines.push('[Telegram image attachment]');
  promptLines.push(`source: ${imagePayload.source}`);
  promptLines.push(`file_path: ${imagePath}`);
  promptLines.push('Treat this file as the image input for your analysis.');

  return {
    prompt: promptLines.join('\n'),
    preview: userText || '[image attached]',
  };
}

function buildChatRouter(repos) {
  const map = new Map();
  for (const repo of repos) {
    for (const chatId of repo.chatIds || []) {
      if (map.has(chatId)) {
        const existing = map.get(chatId);
        throw new Error(`Duplicate chat id ${chatId} in repos '${existing.name}' and '${repo.name}'`);
      }
      map.set(chatId, repo);
    }
  }
  return map;
}

function refreshRuntimeRouting(chatRouter, states) {
  const repos = getEnabledRepos();
  const rebuilt = buildChatRouter(repos);

  chatRouter.clear();
  for (const [chatId, repo] of rebuilt.entries()) {
    chatRouter.set(chatId, repo);
  }

  const enabledNames = new Set(repos.map(r => r.name));
  for (const repo of repos) {
    if (!states.has(repo.name)) {
      states.set(repo.name, {
        running: false,
        verbose: false,
        currentProc: null,
        interruptRequested: false,
        interruptEscalationTimer: null,
        interruptTrace: null,
        queue: [],
        panelRefresh: null,
        dispatchQueue: Promise.resolve(),
      });
    }
  }
  for (const name of states.keys()) {
    if (!enabledNames.has(name)) {
      states.delete(name);
    }
  }

  return repos;
}

function formatRepoList(repos, mappedRepoName) {
  const enabled = repos
    .filter(repo => repo.enabled !== false)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (enabled.length === 0) {
    return [
      'No enabled repos are configured yet.',
      `Run: hermux onboard`,
    ].join('\n');
  }

  const lines = [`Available repos (${enabled.length}):`];
  for (const repo of enabled) {
    const marker = mappedRepoName === repo.name ? ' (connected here)' : '';
    const mappedChats = Array.isArray(repo.chatIds) ? repo.chatIds.length : 0;
    lines.push(`- ${repo.name}${marker} [mapped chats: ${mappedChats}]`);
  }
  lines.push('');
  lines.push('Connect this chat: /connect <repo>');
  lines.push('Or tap a repo button below.');
  lines.push('Example: /connect my-repo');
  return lines.join('\n');
}

function buildConnectKeyboard(repos) {
  const enabled = repos
    .filter(repo => repo.enabled !== false)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (enabled.length === 0) return null;

  return {
    inline_keyboard: enabled.map((repo) => ([
      { text: repo.name, callback_data: `connect:${repo.name}` },
    ])),
  };
}

function buildVerboseKeyboard() {
  return {
    inline_keyboard: [[
      { text: 'Verbose On', callback_data: 'verbose:on' },
      { text: 'Verbose Off', callback_data: 'verbose:off' },
    ]],
  };
}

async function sendRepoList(bot, chatId, chatRouter) {
  const repos = getEnabledRepos();
  const mappedRepo = chatRouter.get(chatId);
  const text = formatRepoList(repos, mappedRepo ? mappedRepo.name : '');
  const keyboard = buildConnectKeyboard(repos);
  const opts = keyboard ? { reply_markup: keyboard } : undefined;
  await safeSend(bot, chatId, text, opts);
}

async function handleConnectCommand(bot, chatId, args, chatRouter, states) {
  const availableRepos = getEnabledRepos();
  if (availableRepos.length === 0) {
    await safeSend(bot, chatId, `No enabled repos found in ${CONFIG_PATH}\nRun: hermux onboard`);
    return;
  }

  const requestedRepo = String(args[0] || '').trim();
  if (!requestedRepo) {
    const keyboard = buildConnectKeyboard(availableRepos);
    await safeSend(
      bot,
      chatId,
      [
        `chat_id: ${chatId}`,
        'No repo name provided.',
        '',
        formatRepoList(availableRepos, chatRouter.get(chatId)?.name || ''),
        '',
        'Resume anytime by sending: /connect <repo>',
      ].join('\n'),
      keyboard ? { reply_markup: keyboard } : undefined
    );
    return;
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(requestedRepo)) {
    await safeSend(
      bot,
      chatId,
      [
        `Invalid repo name: ${requestedRepo}`,
        'Expected: letters, numbers, dash, underscore.',
        'Retry: /connect <repo>',
      ].join('\n')
    );
    return;
  }

  try {
    const result = await withConnectMutationLock(async () => {
      const update = addChatIdToRepo(requestedRepo, chatId);
      if (update.ok) {
        refreshRuntimeRouting(chatRouter, states);
      }
      return update;
    });

    if (!result.ok) {
      if (result.reason === 'repo_not_found') {
        const keyboard = buildConnectKeyboard(availableRepos);
        await safeSend(
          bot,
          chatId,
          [
            `Unknown repo: ${requestedRepo}`,
            '',
            formatRepoList(availableRepos, chatRouter.get(chatId)?.name || ''),
            '',
            'Resume by retrying with an exact repo name: /connect <repo>',
          ].join('\n'),
          keyboard ? { reply_markup: keyboard } : undefined
        );
        return;
      }

      if (result.reason === 'chat_already_mapped') {
        await safeSend(
          bot,
          chatId,
          [
            `This chat is already connected to repo: ${result.existingRepo}`,
            `Requested repo: ${requestedRepo}`,
            '',
            'Use /whereami to verify current mapping.',
            'If you want to move this chat, edit config and restart runtime.',
          ].join('\n')
        );
        return;
      }

      await safeSend(bot, chatId, `Connect failed (${result.reason}). Retry: /connect ${requestedRepo}`);
      return;
    }

    if (result.changed) {
      await safeSend(
        bot,
        chatId,
        [
          `Connected: chat ${chatId} -> repo ${requestedRepo}`,
          'You can now send prompts in this chat.',
          'Tip: /status, /verbose on, /whereami',
        ].join('\n')
      );
      return;
    }

    await safeSend(
      bot,
      chatId,
      [
        `Already connected: chat ${chatId} -> repo ${requestedRepo}`,
        'No change needed. You can continue using this chat.',
      ].join('\n')
    );
  } catch (err) {
    console.error('[connect] failed:', err.message);
    await safeSend(
      bot,
      chatId,
      [
        `Connect failed due to a temporary error: ${err.message}`,
        `Resume by retrying the same command: /connect ${requestedRepo}`,
      ].join('\n')
    );
  }
}

async function handleVerboseAction(bot, chatId, state, action) {
  if (action === 'status') {
    await safeSend(bot, chatId, `verbose is ${state.verbose ? 'on' : 'off'}`, { reply_markup: buildVerboseKeyboard() });
    return;
  }

  if (action === 'on') {
    state.verbose = true;
    await safeSend(bot, chatId, 'verbose on - tool calls and intermediate steps will be shown', { reply_markup: buildVerboseKeyboard() });
    return;
  }

  if (action === 'off') {
    state.verbose = false;
    await safeSend(bot, chatId, 'verbose off - only final output will be sent', { reply_markup: buildVerboseKeyboard() });
  }
}

function writePidAtomic(pid) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const tmp = PID_PATH + '.tmp';
  fs.writeFileSync(tmp, String(pid) + '\n', 'utf8');
  fs.renameSync(tmp, PID_PATH);
}

function writeRestartNotice(payload) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const tmp = RESTART_NOTICE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, RESTART_NOTICE_PATH);
}

function readAndClearRestartNotice() {
  try {
    if (!fs.existsSync(RESTART_NOTICE_PATH)) return null;
    const raw = fs.readFileSync(RESTART_NOTICE_PATH, 'utf8');
    fs.unlinkSync(RESTART_NOTICE_PATH);
    const parsed = JSON.parse(raw);
    const chatId = String((parsed && parsed.chatId) || '').trim();
    if (!chatId) return null;
    return {
      chatId,
      repoName: String((parsed && parsed.repoName) || '').trim(),
      requestedAt: String((parsed && parsed.requestedAt) || '').trim(),
    };
  } catch (_err) {
    try {
      if (fs.existsSync(RESTART_NOTICE_PATH)) fs.unlinkSync(RESTART_NOTICE_PATH);
    } catch (_e) {
    }
    return null;
  }
}

function spawnReplacementDaemon() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const outFd = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'cli.js'), 'start', '--foreground'], {
    detached: true,
    stdio: ['ignore', outFd, outFd],
    env: { ...process.env, OMG_DAEMON_CHILD: '1' },
  });
  child.unref();
  fs.closeSync(outFd);
  writePidAtomic(child.pid);
  return child.pid;
}

async function handleRestartCommand(bot, chatId, repo, state) {
  return withRestartMutationLock(async () => {
    if (restartInProgress) {
      await safeSend(bot, chatId, 'Restart already in progress. Please wait a moment.');
      return;
    }

    if (state.running) {
      await safeSend(bot, chatId, 'Cannot restart while running. Wait for current task to finish.');
      return;
    }

    if (process.env.OMG_DAEMON_CHILD !== '1') {
      await safeSend(
        bot,
        chatId,
        [
          'Restart is available only in daemon mode.',
          'If you run foreground manually, stop and start again: hermux start --foreground',
        ].join('\n')
      );
      return;
    }

    restartInProgress = true;
    await safeSend(bot, chatId, `Restarting daemon for repo ${repo.name}...`);

    try {
      writeRestartNotice({
        chatId,
        repoName: repo.name,
        requestedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[restart] failed to write restart notice:', err.message);
    }

    try {
      await bot.stopPolling();
    } catch (_err) {
    }

    try {
      const nextPid = spawnReplacementDaemon();
      console.log(`[restart] spawned replacement daemon pid: ${nextPid}`);
    } catch (err) {
      console.error('[restart] failed to spawn replacement daemon:', err.message);
    }

    setTimeout(() => process.exit(0), 50);
  });
}

async function startPromptRun(bot, repo, state, runItem) {
  const chatId = runItem.chatId;
  const promptText = runItem.promptText;
  const promptPreview = runItem.promptPreview;
  const isVersionPrompt = !!runItem.isVersionPrompt;

  state.running = true;
  state.interruptRequested = false;
  state.interruptTrace = null;
  clearInterruptEscalationTimer(state);
  state.currentProc = null;

  console.log(`[${repo.name}] run: ${promptPreview.slice(0, 80)}`);

  let finalText = '';
  let toolCount = 0;
  let stepCount = 0;
  const toolNames = [];
  const rawSamples = [];
  let lastStepReason = null;
  let activeSessionId = getSessionId(repo.name, chatId);
  const hermuxVersion = String(HERMUX_VERSION || '').trim() || '0.0.0';
  let lastStreamEditAt = 0;
  let lastStreamSnapshot = '';
  let lastToolBrief = '';
  let lastRawBrief = '';
  let lastPanelHtml = '';

  const buildPanel = (phase) => buildLiveStatusPanelHtml({
    repoName: repo.name,
    verbose: !!state.verbose,
    phase,
    stepCount,
    toolCount,
    queueLength: Array.isArray(state.queue) ? state.queue.length : 0,
    sessionId: activeSessionId,
    lastTool: lastToolBrief,
    lastRaw: lastRawBrief,
    lastStepReason,
  });

  const statusMsg = await safeSend(bot, chatId, buildPanel('running'), { parse_mode: 'HTML' });
  const statusMsgId = statusMsg ? statusMsg.message_id : null;

  const refreshPanel = async (phase, force) => {
    if (!statusMsgId) return;
    const now = Date.now();
    const minInterval = state.verbose ? STREAM_EDIT_MIN_INTERVAL_VERBOSE_MS : STREAM_EDIT_MIN_INTERVAL_COMPACT_MS;
    if (!force && now - lastStreamEditAt < minInterval) return;
    const html = buildPanel(phase);
    if (!force && html === lastPanelHtml) return;
    lastStreamEditAt = now;
    lastPanelHtml = html;
    await editHtml(bot, chatId, statusMsgId, html);
  };
  state.panelRefresh = async (force) => refreshPanel('running', !!force);

  const proc = runOpencode(repo, promptText, {
    sessionId: activeSessionId,
    onEvent: async (evt) => {
      const type = evt.type;
      if (evt.sessionId) activeSessionId = evt.sessionId;

      if (type === 'step_start') {
        stepCount++;
        await refreshPanel('running', false);
        return;
      }

      if (type === 'text') {
        if ((evt.content || '').trim()) {
          finalText = evt.content;
          if (statusMsgId && evt.content !== lastStreamSnapshot) {
            lastStreamSnapshot = evt.content;
            await refreshPanel('running', false);
          }
        }
        return;
      }

      if (type === 'tool_use') {
        toolCount++;
        const brief = formatToolBrief(evt);
        lastToolBrief = brief;
        toolNames.push(brief);
        await refreshPanel('running', false);
        if (state.verbose && !statusMsgId) {
          const toolMsg = `<code>${escapeHtml(brief)}</code>`;
          await safeSend(bot, chatId, toolMsg, { parse_mode: 'HTML' });
        }
        return;
      }

      if (type === 'step_finish') {
        lastStepReason = evt.reason || lastStepReason;
        await refreshPanel('running', false);
        return;
      }

      if (type === 'raw') {
        const trimmed = (evt.content || '').trim().slice(0, 200);
        if (trimmed) {
          rawSamples.push(trimmed);
          if (rawSamples.length > 3) rawSamples.shift();
          lastRawBrief = trimmed;
          await refreshPanel('running', false);
          if (state.verbose && !statusMsgId) {
            await safeSend(bot, chatId, `<pre>${escapeHtml(trimmed)}</pre>`, { parse_mode: 'HTML' });
          }
        }
      }
    },

    onDone: async (exitCode, timeoutMsg, meta) => {
      state.running = false;
      clearInterruptEscalationTimer(state);
      const interruptTrace = state.interruptTrace ? { ...state.interruptTrace } : null;
      const interrupted = !!state.interruptRequested;
      state.interruptRequested = false;
      state.interruptTrace = null;
      state.currentProc = null;
      state.panelRefresh = null;
      if (meta && meta.sessionId) activeSessionId = meta.sessionId;
      if (activeSessionId) {
        try {
          setSessionId(repo.name, chatId, activeSessionId);
        } catch (e) {
          console.error(`[${repo.name}] failed to persist session id:`, e.message);
        }
      }
      const status = interrupted ? 'interrupted' : (timeoutMsg ? 'timeout' : (exitCode === 0 ? 'done' : `exit ${exitCode}`));

      if (interrupted) {
        await safeSend(bot, chatId, 'Interrupted current task.');
      } else if (timeoutMsg) {
        await safeSend(bot, chatId, `Timed out: ${timeoutMsg}`);
      } else if (finalText.trim()) {
        const outgoingText = isVersionPrompt ? appendHermuxVersion(finalText, hermuxVersion) : finalText;
        const html = md2html(outgoingText);
        await sendHtml(bot, chatId, html);

        const mermaidBlocks = extractMermaidBlocks(finalText);
        if (mermaidBlocks.length > 0) {
          if (!hasMermaidRenderer()) {
            await safeSend(
              bot,
              chatId,
              'Mermaid blocks detected, but renderer is unavailable. Install mermaid-cli (`mmdc`) to receive rendered diagrams.'
            );
          } else {
            const artifacts = renderMermaidArtifacts(repo, chatId, mermaidBlocks);
            for (let i = 0; i < artifacts.length; i++) {
              const a = artifacts[i];
              const caption = artifacts.length > 1 ? `Mermaid diagram ${i + 1}/${artifacts.length}` : 'Mermaid diagram';
              if (a.kind === 'svg') {
                await safeSendDocument(bot, chatId, a.path, caption);
              } else {
                await safeSendPhoto(bot, chatId, a.path, caption);
              }
            }
          }
        }
      } else {
        const fallbackBase = buildNoOutputMessage({
          exitCode,
          stepCount,
          toolCount,
          toolNames,
          stepReason: lastStepReason,
          rawSamples,
          logFile: repo.logFile,
        });
        const fallback = isVersionPrompt ? appendHermuxVersion(fallbackBase, hermuxVersion) : fallbackBase;
        await safeSend(bot, chatId, fallback);
      }

      const summary = `[${status}] ${stepCount} step(s), ${toolCount} tool(s)`;
      console.log(`[${repo.name}] ${summary}`);
      if (interruptTrace) {
        const completedAt = Date.now();
        const termLatencyMs = interruptTrace.termSentAt ? completedAt - interruptTrace.termSentAt : null;
        const reqLatencyMs = interruptTrace.requestedAt ? completedAt - interruptTrace.requestedAt : null;
        console.log(`[${repo.name}] interrupt trace: ${JSON.stringify({
          ...interruptTrace,
          completedAt,
          reqLatencyMs,
          termLatencyMs,
          exitCode,
          timeout: !!timeoutMsg,
          status,
        })}`);
      }

      if (statusMsgId) {
        await refreshPanel(status, true);
      }

      if (Array.isArray(state.queue) && state.queue.length > 0) {
        const nextItem = state.queue.shift();
        await startPromptRun(bot, repo, state, nextItem);
      }
    },

    onError: async (err) => {
      state.running = false;
      clearInterruptEscalationTimer(state);
      const interruptTrace = state.interruptTrace ? { ...state.interruptTrace } : null;
      state.interruptRequested = false;
      state.interruptTrace = null;
      state.currentProc = null;
      state.panelRefresh = null;
      console.error(`[${repo.name}] error:`, err.message);
      if (interruptTrace) {
        const completedAt = Date.now();
        const termLatencyMs = interruptTrace.termSentAt ? completedAt - interruptTrace.termSentAt : null;
        const reqLatencyMs = interruptTrace.requestedAt ? completedAt - interruptTrace.requestedAt : null;
        console.error(`[${repo.name}] interrupt trace on error: ${JSON.stringify({
          ...interruptTrace,
          completedAt,
          reqLatencyMs,
          termLatencyMs,
          error: err.message,
        })}`);
      }
      await safeSend(
        bot,
        chatId,
        `Error: ${err.message}\n\nCheck that opencode is installed and workdir is accessible.`
      );

      if (Array.isArray(state.queue) && state.queue.length > 0) {
        const nextItem = state.queue.shift();
        await startPromptRun(bot, repo, state, nextItem);
      }
    },
  });

  state.currentProc = proc;
}

async function handleRepoMessage(bot, repo, state, msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const parsed = parseCommand(text);
  const command = parsed ? parsed.command : '';
  const isVersionPrompt = command === '/version' || text.toLowerCase() === '\\version';

  if (command === '/start') {
    await safeSend(
      bot,
      chatId,
      [
        `opencode gateway [${repo.name}]`,
        `workdir: ${repo.workdir}`,
        '',
        `mode: ${state.verbose ? 'verbose (stream events)' : 'compact (final output only)'}`,
        'commands: /repos, /status, /session, /version, /interrupt, /restart, /reset, /init, /verbose on, /verbose off, /whereami',
        '',
        'Send any prompt to run opencode.',
      ].join('\n')
    );
    return;
  }

  if (command === '/status') {
    await safeSend(
      bot,
      chatId,
      `${repo.name}\nworkdir: ${repo.workdir}\nbusy: ${state.running ? 'yes' : 'no'}\nverbose: ${state.verbose ? 'on' : 'off'}\nqueue: ${Array.isArray(state.queue) ? state.queue.length : 0}`
    );
    return;
  }

  if (command === '/session') {
    const info = getSessionInfo(repo.name, chatId);
    if (!info || !info.sessionId) {
      await safeSend(bot, chatId, `No active session for this chat yet.\nrepo: ${repo.name}\nchat_id: ${chatId}`);
      return;
    }
    await safeSend(
      bot,
      chatId,
      `repo: ${repo.name}\nchat_id: ${chatId}\nsession_id: ${info.sessionId}\nupdated_at: ${info.updatedAt || 'unknown'}\nstate_file: ${SESSION_MAP_PATH}`
    );
    return;
  }

  if (command === '/reset') {
    if (state.running) {
      await safeSend(bot, chatId, 'Cannot reset while running. Wait for current task to finish.');
      return;
    }
    const cleared = clearSessionId(repo.name, chatId);
    if (cleared) {
      await safeSend(bot, chatId, `Session reset complete for repo ${repo.name}.\nNext prompt will start a new opencode session.`);
    } else {
      await safeSend(bot, chatId, `No stored session found for repo ${repo.name}.`);
    }
    return;
  }

  if (command === '/restart') {
    await handleRestartCommand(bot, chatId, repo, state);
    return;
  }

  if (command === '/help') {
    await safeSend(bot, chatId, getHelpText());
    return;
  }

  if (command === '/repos') {
    await sendRepoList(bot, chatId, new Map([[chatId, repo]]));
    return;
  }

  if (command === '/whereami') {
    await safeSend(
      bot,
      chatId,
      `chat_id: ${chatId}\nrepo: ${repo.name}`
    );
    return;
  }

  if (command === '/verbose' && (!parsed || parsed.args.length === 0 || parsed.args[0] === 'status')) {
    await handleVerboseAction(bot, chatId, state, 'status');
    return;
  }

  if (command === '/verbose' && parsed && parsed.args[0] === 'on') {
    await handleVerboseAction(bot, chatId, state, 'on');
    return;
  }

  if (command === '/verbose' && parsed && parsed.args[0] === 'off') {
    await handleVerboseAction(bot, chatId, state, 'off');
    return;
  }

  if (command === '/interrupt') {
    if (!state.running || !state.currentProc) {
      await safeSend(bot, chatId, 'No running task to interrupt.');
      return;
    }
    const req = requestInterrupt(state, { forceAfterMs: 5000 });
    if (!req.ok) {
      const msg = req.error ? req.error.message : req.reason;
      await safeSend(bot, chatId, `Failed to interrupt current task: ${msg}`);
      return;
    }
    console.log(`[${repo.name}] interrupt requested | chat=${chatId} | alreadyRequested=${req.alreadyRequested ? 'yes' : 'no'}`);
    await safeSend(bot, chatId, req.alreadyRequested ? 'Interrupt already requested. Waiting for task shutdown...' : 'Interrupt requested. Stopping current task...');
    return;
  }

  let preparedPrompt;
  try {
    preparedPrompt = await buildPromptFromMessage(bot, repo, msg);
  } catch (err) {
    console.error(`[${repo.name}] failed to prepare prompt:`, err.message);
    await safeSend(bot, chatId, `Failed to read image attachment: ${err.message}`);
    return;
  }

  if (!preparedPrompt) return;

  if (!Array.isArray(state.queue)) state.queue = [];

  const promptText = preparedPrompt.prompt;
  const promptPreviewRaw = preparedPrompt.preview || '';
  const promptPreview = promptPreviewRaw.length > 200 ? promptPreviewRaw.slice(0, 200) + '...' : promptPreviewRaw;
  const queuedItem = {
    chatId,
    promptText,
    promptPreview,
    isVersionPrompt,
  };

  if (state.running) {
    state.queue.push(queuedItem);
    if (typeof state.panelRefresh === 'function') {
      await state.panelRefresh(true);
    }
    return;
  }

  await startPromptRun(bot, repo, state, queuedItem);
}

function main() {
  const config = load();
  const botToken = String(config.global.telegramBotToken || '').trim();
  if (!botToken) {
    console.log(`No global telegramBotToken configured in ${CONFIG_PATH}`);
    console.log('Run: hermux onboard');
    return;
  }

  const repos = getEnabledRepos();
  if (repos.length === 0) {
    console.log(`No enabled repos found in ${CONFIG_PATH}`);
    console.log('Runtime will stay online for /onboard setup.');
  }

  if (!hasMermaidRenderer()) {
    console.log('[warn] mmdc not found. Mermaid blocks will remain text-only until renderer is installed.');
    console.log('[hint] Run: npm install -g @mermaid-js/mermaid-cli');
  }

  const chatRouter = buildChatRouter(repos);
  const states = new Map(repos.map(repo => [repo.name, {
    running: false,
    verbose: false,
    currentProc: null,
    interruptRequested: false,
    interruptEscalationTimer: null,
    interruptTrace: null,
    queue: [],
    panelRefresh: null,
    dispatchQueue: Promise.resolve(),
  }]));
  const onboardingSessions = new Map();
  const initSessions = new Map();
  const bot = new TelegramBot(botToken, { polling: true });
  const restartNotice = readAndClearRestartNotice();

  console.log(`polling with 1 bot for ${repos.length} repo(s), ${chatRouter.size} chat id(s)`);

  bot.setMyCommands([
    { command: 'onboard', description: 'Run chat onboarding wizard' },
    { command: 'init', description: 'Initialize by clearing mappings/sessions' },
    { command: 'start', description: 'Show mapped repo info' },
    { command: 'repos', description: 'List repos and how to connect' },
    { command: 'connect', description: 'Connect this chat to a repo' },
    { command: 'status', description: 'Show current runtime status' },
    { command: 'session', description: 'Show current opencode session' },
    { command: 'version', description: 'Show opencode and hermux version' },
    { command: 'interrupt', description: 'Stop current running task' },
    { command: 'restart', description: 'Restart daemon process' },
    { command: 'reset', description: 'Reset current chat session' },
    { command: 'verbose', description: 'Show or toggle verbose mode' },
    { command: 'whereami', description: 'Show current chat ID and mapping' },
    { command: 'help', description: 'Show onboarding and command help' },
  ]).catch((err) => {
    console.error('[bot] setMyCommands failed:', err.message);
  });

  if (restartNotice && restartNotice.chatId) {
    setTimeout(async () => {
      const repoHint = restartNotice.repoName ? ` for ${restartNotice.repoName}` : '';
      await safeSend(
        bot,
        restartNotice.chatId,
        `✅ Restart complete${repoHint}. Runtime is back online.`
      );
    }, 1200);
  }

  bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text = (msg.text || '').trim();
    const parsed = parseCommand(text);
    const command = parsed ? parsed.command : '';

    if (command === '/onboard') {
      await handleOnboardCommand(bot, chatId, parsed, chatRouter, states, onboardingSessions);
      return;
    }

    if (command === '/init') {
      await handleInitCommand(bot, chatId, parsed, states, onboardingSessions, initSessions, chatRouter);
      return;
    }

    if (onboardingSessions.has(chatId)) {
      if (command && command !== '/onboard') {
        await safeSend(bot, chatId, 'Onboarding in progress. Reply to the current question or run /onboard cancel.');
        return;
      }
      await handleOnboardingInput(bot, chatId, text, chatRouter, states, onboardingSessions);
      return;
    }

    if (command === '/help') {
      await safeSend(bot, chatId, getHelpText());
      return;
    }

    if (command === '/repos') {
      await sendRepoList(bot, chatId, chatRouter);
      return;
    }

    if (command === '/connect') {
      await handleConnectCommand(bot, chatId, parsed ? parsed.args : [], chatRouter, states);
      return;
    }

    const repo = chatRouter.get(chatId);

    if (!repo) {
      if (command === '/start' || command === '/whereami' || command === '/restart' || command === '/interrupt') {
        await safeSend(
          bot,
          chatId,
          [
            `chat_id: ${chatId}`,
            'This chat is not mapped to any repo yet.',
            '',
            'To onboard this chat in-place:',
            '1) Run /onboard (setup wizard)',
            '2) Run /repos',
            '3) Run /connect <repo>',
            '4) Retry your prompt in this chat',
            '',
            'Tip: use /help for full command and onboarding guide.',
          ].join('\n')
        );
      }

      if (!command && text) {
        await safeSend(
          bot,
          chatId,
          [
            `chat_id: ${chatId}`,
            'This chat is not mapped yet.',
            'Start setup with /onboard and answer the prompts.',
          ].join('\n')
        );
      }
      return;
    }

    const state = states.get(repo.name);
    await withStateDispatchLock(state, async () => {
      await handleRepoMessage(bot, repo, state, msg);
    });
  });

  bot.on('callback_query', async (query) => {
    const data = String((query && query.data) || '').trim();
    const chat = query && query.message && query.message.chat;
    const chatId = chat ? String(chat.id) : '';

    if (!data || !chatId) {
      if (query && query.id) {
        await bot.answerCallbackQuery(query.id).catch(() => {});
      }
      return;
    }

    try {
      if (data.startsWith('connect:')) {
        const repoName = data.slice('connect:'.length).trim();
        await handleConnectCommand(bot, chatId, [repoName], chatRouter, states);
        if (query.id) {
          await bot.answerCallbackQuery(query.id, { text: `connect: ${repoName}` }).catch(() => {});
        }
        return;
      }

      if (data.startsWith('verbose:')) {
        const action = data.slice('verbose:'.length).trim();
        const repo = chatRouter.get(chatId);
        if (!repo) {
          await safeSend(bot, chatId, 'This chat is not mapped to a repo. Run /repos then /connect <repo>.');
          if (query.id) {
            await bot.answerCallbackQuery(query.id, { text: 'not mapped' }).catch(() => {});
          }
          return;
        }

        const state = states.get(repo.name);
        await handleVerboseAction(bot, chatId, state, action === 'on' || action === 'off' ? action : 'status');
        if (query.id) {
          await bot.answerCallbackQuery(query.id, { text: `verbose: ${action}` }).catch(() => {});
        }
        return;
      }
    } catch (err) {
      console.error('[callback_query] failed:', err.message);
    }

    if (query.id) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
    }
  });

  bot.on('polling_error', (err) => {
    const detail = serializePollingError(err);
    console.error('[bot] polling error detail:', JSON.stringify(detail));
  });

  const shutdown = () => {
    console.log('\nshutting down...');
    bot.stopPolling();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  _internal: {
    parseCommand,
    splitByLimit,
    buildNoOutputMessage,
    appendHermuxVersion,
    buildStreamingStatusHtml,
    buildLiveStatusPanelHtml,
    extractMermaidBlocks,
    withRestartMutationLock,
    withStateDispatchLock,
    sendInterruptSignal,
    requestInterrupt,
    clearInterruptEscalationTimer,
    serializePollingError,
    buildConnectKeyboard,
    buildVerboseKeyboard,
    getReplyContext,
    normalizeImageExt,
    getImagePayloadFromMessage,
    formatRepoList,
  },
};
