#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const fsp = require('fs/promises');
const { pipeline } = require('stream/promises');
const { spawn, spawnSync } = require('child_process');
const { createHash } = require('crypto');
const {
  selection: providerSelection,
  resolveUpstreamProvider,
  resolveDownstreamProvider,
} = require('./providers');
const { load, getEnabledRepos, addChatIdToRepo, moveChatIdToRepo, addOrUpdateRepo, setGlobalBotToken, resetConfig, CONFIG_PATH } = require('./lib/config');
const { md2html, escapeHtml } = require('./lib/md2html');
const { getSessionId, setSessionId, clearSessionId, getSessionInfo, clearAllSessions, SESSION_MAP_PATH } = require('./lib/session-map');
const { makeAuditLogger } = require('./lib/audit-log');
const {
  splitByOmoInitiatorMarker,
  extractLatestSystemReminder,
  sanitizeCanonicalOutputText,
  sanitizeDisplayOutputText,
  sanitizeWithoutPromptEchoStrip,
  sanitizeFinalOutputText,
} = require('./lib/output-sanitizer');
const { createSessionEventHandler } = require('./lib/session-event-handler');
const { HERMUX_VERSION } = require('./lib/hermux-version');

const upstreamProvider = resolveUpstreamProvider(providerSelection.upstream);
const downstreamProvider = resolveDownstreamProvider(providerSelection.downstream);

const {
  runOpencode,
  subscribeSessionEvents,
  endSessionLifecycle,
  runSessionRevert,
  runSessionUnrevert,
  stopAllRuntimeExecutors,
  getRuntimeStatusForInstance,
  createRunViewSnapshotState,
  applyPayloadToRunViewSnapshot,
  parsePayloadMeta,
  readBusySignalFromSessionPayload,
} = upstreamProvider;

const {
  TelegramBot,
  createRepoMessageHandler,
  createMessageHandler,
  createCallbackQueryHandler,
  reconcileRunViewForTelegram,
  createTelegramBotEffects,
  createTelegramTransport,
} = downstreamProvider;
const { splitTelegramHtml } = require('./providers/downstream/telegram/html-chunker');
const { createChatRoutingService } = require('./app/chat-routing-service');
const { createModelControlService } = require('./app/model-control-service');
const { createModelCommandService } = require('./app/model-command-service');

const TG_MAX_LEN = 4000;
const IMAGE_UPLOAD_DIR = '.hermux/uploads';
const TEST_PROFILE_ENABLED = String(process.env.HERMUX_TEST_PROFILE || '').trim() === '1';
const TEST_PROFILE_ROOT = path.resolve(
  process.env.HERMUX_TEST_PROFILE_ROOT
    || path.join(__dirname, '..', '.tmp', 'test-profile', `p-${process.pid}`)
);
const DEFAULT_RUNTIME_DIR = TEST_PROFILE_ENABLED
  ? path.join(TEST_PROFILE_ROOT, 'runtime')
  : path.join(__dirname, '..', 'runtime');
const RUNTIME_DIR = path.resolve(process.env.HERMUX_RUNTIME_DIR || DEFAULT_RUNTIME_DIR);
const PID_PATH = path.join(RUNTIME_DIR, 'gateway.pid');
const LOG_PATH = path.join(RUNTIME_DIR, 'gateway.log');
const RESTART_NOTICE_PATH = path.join(RUNTIME_DIR, 'restart-notice.json');
const REVERT_TARGETS_PATH = path.join(RUNTIME_DIR, 'revert-targets.json');
const MERMAID_RENDER_DIR = '.hermux/mermaid';
const STREAM_HEARTBEAT_MS = 1500;
const REVERT_CONFIRM_TTL_MS = 10 * 60 * 1000;
const REVERT_TARGET_LIMIT_PER_CHAT = 240;
const OPENCODE_CONFIG_PATH = process.env.HERMUX_OPENCODE_CONFIG_PATH || path.join(process.env.HOME || '', '.config', 'opencode', 'opencode.json');
const OMO_CONFIG_PATH = process.env.HERMUX_OMO_CONFIG_PATH || path.join(process.env.HOME || '', '.config', 'opencode', 'oh-my-opencode.json');
const AUDIT_STRING_MAX = parseInt(process.env.HERMUX_AUDIT_STRING_MAX || '16000', 10);
const APPLY_PAYLOAD_THROTTLE_MS = parseInt(process.env.HERMUX_APPLY_PAYLOAD_THROTTLE_MS || '500', 10);
const RUN_VIEW_RETRY_AFTER_DEFER_MS = parseInt(process.env.HERMUX_RUN_VIEW_RETRY_AFTER_DEFER_MS || '5000', 10);
const TRACE_RUNVIEW_DIAGNOSTICS = true;
const TRACE_SESSION_ID = String(process.env.HERMUX_TRACE_SESSION_ID || '').trim();
const auditLogger = makeAuditLogger(RUNTIME_DIR);
let connectMutationQueue = Promise.resolve();
let restartMutationQueue = Promise.resolve();
let restartInProgress = false;
const revertTargetsByChat = new Map();
const revertConfirmByToken = new Map();
let revertTargetsLoaded = false;

function ensureRevertTargetsLoaded() {
  if (revertTargetsLoaded) return;
  revertTargetsLoaded = true;

  const raw = readJsonOrDefault(REVERT_TARGETS_PATH, null);
  if (!raw || typeof raw !== 'object') return;
  const chats = raw.chats && typeof raw.chats === 'object' ? raw.chats : {};

  for (const [chatId, entries] of Object.entries(chats)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const chatKey = String(chatId);
    const map = new Map();

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const messageId = Number(entry.telegramMessageId);
      if (!Number.isInteger(messageId) || messageId <= 0) continue;
      map.set(messageId, {
        chatId: chatKey,
        telegramMessageId: messageId,
        repoName: entry.repoName ? String(entry.repoName) : '',
        sessionId: entry.sessionId ? String(entry.sessionId) : '',
        messageId: entry.messageId ? String(entry.messageId) : '',
        partId: entry.partId ? String(entry.partId) : '',
        createdAt: Number(entry.createdAt) > 0 ? Number(entry.createdAt) : Date.now(),
      });
    }

    if (map.size === 0) continue;
    if (map.size > REVERT_TARGET_LIMIT_PER_CHAT) {
      const staleCount = map.size - REVERT_TARGET_LIMIT_PER_CHAT;
      const keys = Array.from(map.keys()).slice(0, staleCount);
      for (const key of keys) map.delete(key);
    }
    revertTargetsByChat.set(chatKey, map);
  }
}

function persistRevertTargets() {
  const chats = {};
  for (const [chatId, map] of revertTargetsByChat.entries()) {
    if (!(map instanceof Map) || map.size === 0) continue;
    chats[chatId] = Array.from(map.values()).map((entry) => ({
      chatId: String(entry.chatId || chatId),
      telegramMessageId: Number(entry.telegramMessageId || 0),
      repoName: String(entry.repoName || ''),
      sessionId: String(entry.sessionId || ''),
      messageId: String(entry.messageId || ''),
      partId: String(entry.partId || ''),
      createdAt: Number(entry.createdAt || Date.now()),
    }));
  }
  writeJsonAtomic(REVERT_TARGETS_PATH, {
    version: 1,
    chats,
  });
}

function summarizeAuditText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > 500 ? `${value.slice(0, 500)}...(truncated)` : value;
}

function buildAuditContentMeta(text) {
  const value = String(text || '');
  const length = value.length;
  const hash = createHash('sha256').update(value).digest('hex');
  return {
    contentSha256: hash,
    contentRawLength: length,
    auditStringMax: AUDIT_STRING_MAX,
    willAuditTruncate: length > AUDIT_STRING_MAX,
  };
}

function shouldTraceSessionDiagnostic(...sessionCandidates) {
  if (!TRACE_RUNVIEW_DIAGNOSTICS) return false;
  if (!TRACE_SESSION_ID) return true;
  for (const candidate of sessionCandidates) {
    const sid = String(candidate || '').trim();
    if (sid && sid === TRACE_SESSION_ID) return true;
  }
  return false;
}

function audit(kind, payload) {
  auditLogger.write(kind, payload);
}

const telegramBotEffects = createTelegramBotEffects({
  audit,
  sleep,
  getTelegramRetryAfterSeconds,
});
const { safeSendChatAction } = telegramBotEffects;
const telegramTransport = createTelegramTransport({
  audit,
  sleep,
  getTelegramRetryAfterSeconds,
  summarizeAuditText,
  shouldDeferRunViewRetryAfter,
  splitTelegramHtml,
  md2html,
  maxLen: TG_MAX_LEN,
});
const {
  resolveSendMessageDraftApi,
  updateTelegramDraftPreview,
  clearTelegramDraftPreview,
  materializeTelegramDraftPreview,
  maybeMaterializeRunStartDraftPreview,
  safeSend,
  sendHtml,
  sendMarkdownAsHtml,
  editHtml,
  safeDeleteMessage,
  safeSendPhoto,
  safeSendDocument,
} = telegramTransport;
const chatRoutingService = createChatRoutingService({
  addChatIdToRepo,
  moveChatIdToRepo,
  refreshRuntimeRouting,
  getSessionId,
  endSessionLifecycle,
  clearSessionId,
});

function withConnectMutationLock(task) {
  const run = connectMutationQueue.then(task, task);
  connectMutationQueue = run.catch((err) => {
    console.error('[gateway] connect mutation failed:', String(err && err.message ? err.message : err || ''));
  });
  return run;
}

function withRestartMutationLock(task) {
  const run = restartMutationQueue.then(task, task);
  restartMutationQueue = run.catch((err) => {
    console.error('[gateway] restart mutation failed:', String(err && err.message ? err.message : err || ''));
  });
  return run;
}

function withStateDispatchLock(state, task) {
  if (!state.dispatchQueue) state.dispatchQueue = Promise.resolve();
  const run = state.dispatchQueue.then(task, task);
  state.dispatchQueue = run.catch(() => {});
  return run;
}

function withRunViewDispatchLock(state, task) {
  if (!state.runViewDispatchQueue) state.runViewDispatchQueue = Promise.resolve();
  const run = state.runViewDispatchQueue.then(task, task);
  state.runViewDispatchQueue = run.catch(() => {});
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
    audit('interrupt.send_signal', { signal: 'SIGTERM', hasProc: !!state.currentProc, hasKill: typeof state.currentProc?.kill === 'function' });
    sendSignal(state.currentProc, 'SIGTERM');
    if (state.interruptTrace) {
      state.interruptTrace.termSentAt = Date.now();
      state.interruptTrace.status = 'term_sent';
    }
  } catch (err) {
    audit('interrupt.send_signal_failed', { error: err.message });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTelegramRetryAfterSeconds(err) {
  const body = err && err.response && err.response.body && typeof err.response.body === 'object'
    ? err.response.body
    : null;
  const params = body && body.parameters && typeof body.parameters === 'object'
    ? body.parameters
    : null;
  const raw = params && params.retry_after != null ? Number(params.retry_after) : NaN;
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function shouldDeferRunViewRetryAfter(auditMeta, waitMs) {
  const meta = auditMeta && typeof auditMeta === 'object' ? auditMeta : null;
  const channel = String(meta && meta.channel ? meta.channel : '').trim();
  if (channel !== 'run_view_edit' && channel !== 'run_view_send') return false;
  if (meta && meta.isFinalState) return false;
  if (!Number.isFinite(waitMs) || waitMs <= 0) return false;
  return RUN_VIEW_RETRY_AFTER_DEFER_MS > 0 && waitMs >= RUN_VIEW_RETRY_AFTER_DEFER_MS;
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
    '/models - show/update opencode vs oh-my-opencode model layers',
    '/session - show current opencode session id',
    '/version - show opencode output + hermux version',
    '/revert - reply to output and request revert (with confirm)',
    '/unrevert - restore from current revert state if still available',
    '/test - send Telegram formatting showcase (no opencode run)',
    '/interrupt - stop current running task',
    '/restart - restart daemon process',
    '/reset - reset current chat session',
    '/verbose on - enable tool/step stream',
    '/verbose off - final output only',
    '/whereami - show current chat ID and repo mapping',
    '',
    'Agent quick flow (copy to your coding agent):',
    '1) Ask me for token/repo/workdir',
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

function buildTelegramFormattingShowcase() {
  const markdown = [
    '<b>Telegram Formatting Showcase</b>',
    '',
    'Inline code: `alpha` `x < y & z` `npm run test`',
    '',
    'Fenced code:',
    '```text',
    'hello from fenced code block',
    'special chars: <tag> & value',
    '```',
    '',
    'Bold + italic: **bold** _italic_',
    '',
    'Nested style sample: **bold and `inline_code` together**',
  ].join('\n');

  const html = [
    '<b>Extended HTML Formatting</b>',
    '',
    '<i>italic</i> · <u>underline</u> · <s>strikethrough</s> · <tg-spoiler>spoiler</tg-spoiler>',
    '',
    '<blockquote>Blockquote sample: this line should render as a quote.</blockquote>',
    '',
    '<a href="https://core.telegram.org/bots/api#formatting-options">Telegram formatting reference</a>',
  ].join('\n');

  return { markdown, html };
}

async function sendTelegramFormattingShowcase(bot, chatId) {
  const sample = buildTelegramFormattingShowcase();
  await sendMarkdownAsHtml(bot, chatId, sample.markdown);
  await safeSend(bot, chatId, sample.html, { parse_mode: 'HTML' });
}

function parseYesNo(input) {
  const v = String(input || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'y' || v === 'yes') return true;
  if (v === 'n' || v === 'no') return false;
  return null;
}

function isValidModelRef(input) {
  const v = String(input || '').trim();
  return /^[^/\s]+\/[^/\s]+$/.test(v);
}

function readJsonOrDefault(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_err) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tempPath, filePath);
}

function getOmoAgentEntry(config, agent) {
  if (!config.agents || typeof config.agents !== 'object') config.agents = {};
  if (!config.agents[agent] || typeof config.agents[agent] !== 'object') config.agents[agent] = {};
  return config.agents[agent];
}

function getAvailableModelRefs() {
  const cfg = readJsonOrDefault(OPENCODE_CONFIG_PATH, {});
  const providers = cfg.provider && typeof cfg.provider === 'object' ? cfg.provider : {};
  const refs = [];
  for (const providerId of Object.keys(providers)) {
    const models = providers[providerId] && providers[providerId].models && typeof providers[providerId].models === 'object'
      ? providers[providerId].models
      : {};
    for (const modelId of Object.keys(models)) {
      refs.push(`${providerId}/${modelId}`);
    }
  }
  refs.sort();
  return refs;
}

function getProviderModelChoices() {
  const cfg = readJsonOrDefault(OPENCODE_CONFIG_PATH, {});
  const providers = cfg.provider && typeof cfg.provider === 'object' ? cfg.provider : {};
  const ids = Object.keys(providers).filter((id) => {
    const models = providers[id] && providers[id].models && typeof providers[id].models === 'object' ? providers[id].models : null;
    return models && Object.keys(models).length > 0;
  });

  ids.sort((a, b) => {
    if (a === 'anthropic' && b !== 'anthropic') return -1;
    if (b === 'anthropic' && a !== 'anthropic') return 1;
    return a.localeCompare(b);
  });

  return ids.map((providerId) => {
    const models = Object.keys(providers[providerId].models || {})
      .sort()
      .map((modelId) => `${providerId}/${modelId}`);
    return { providerId, models };
  });
}

function buildModelApplyMessage({
  layer,
  scope,
  before,
  after,
  restartRequired,
  applyStatus,
  sessionImpact,
  note,
}) {
  const lines = [
    `layer: ${layer}`,
    `scope: ${scope}`,
    `change: ${before} -> ${after}`,
    `restart_required: ${restartRequired ? 'yes' : 'no'}`,
    `apply_status: ${applyStatus}`,
    `session_impact: ${sessionImpact}`,
  ];
  if (note) lines.push(`note: ${note}`);
  return lines.join('\n');
}

function getModelsSnapshot() {
  const opencodeCfg = readJsonOrDefault(OPENCODE_CONFIG_PATH, {});
  const omoCfg = readJsonOrDefault(OMO_CONFIG_PATH, {});
  const opencodeModel = String(opencodeCfg.model || '').trim() || '(unset: provider default)';
  const agents = omoCfg.agents && typeof omoCfg.agents === 'object' ? omoCfg.agents : {};
  const agentNames = Object.keys(agents).sort();
  const preview = agentNames.slice(0, 6).map((name) => {
    const entry = agents[name] || {};
    const model = String(entry.model || '').trim() || '(unset)';
    const fallback = Array.isArray(entry.fallback_models)
      ? entry.fallback_models.join(', ')
      : String(entry.fallback_models || '').trim() || 'off';
    return `- ${name}: model=${model}, fallback=${fallback}`;
  });
  return { opencodeModel, agentNames, preview };
}

function buildModelsSummaryHtml(repoName) {
  const snap = getModelsSnapshot();
  const preferred = [];
  if (snap.agentNames.includes('sisyphus')) preferred.push('sisyphus');
  for (const name of snap.agentNames) {
    if (preferred.includes(name)) continue;
    preferred.push(name);
    if (preferred.length >= 8) break;
  }
  const layer2Rows = preferred.map((name) => {
    const omoCfg = readJsonOrDefault(OMO_CONFIG_PATH, {});
    const entry = (omoCfg.agents && omoCfg.agents[name]) || {};
    const model = String(entry.model || '').trim() || '(unset)';
    return `${escapeHtml(name)}:${escapeHtml(model)}`;
  });
  const lines = [
    `<b>🧩 Model Layers · ${escapeHtml(repoName)}</b>`,
    '',
    '<pre>① opencode',
    `opencode:${escapeHtml(snap.opencodeModel)}`,
    '</pre>',
    '',
    '<pre>② oh-my-opencode',
    ...(layer2Rows.length > 0 ? layer2Rows : ['(no agent overrides configured)']),
    '</pre>',
  ];
  return { html: lines.join('\n'), agentNames: snap.agentNames };
}

function buildModelsRootKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'OpenCode 모델 변경', callback_data: 'm:l:op' },
      ],
      [
        { text: 'Agent 모델 변경', callback_data: 'm:l:omo' },
      ],
      [
        { text: '새로고침', callback_data: 'm:r' },
      ],
    ],
  };
}

function buildAgentPickerKeyboard(agentNames) {
  const rows = agentNames.slice(0, 10).map((agent, idx) => ([
    { text: agent, callback_data: `m:a:${idx}` },
  ]));
  rows.push([{ text: '뒤로', callback_data: 'm:r' }]);
  return { inline_keyboard: rows };
}

function buildProviderPickerKeyboard(providerChoices, mode) {
  const rows = providerChoices.slice(0, 10).map((item, idx) => ([
    { text: item.providerId, callback_data: `m:p:${idx}` },
  ]));
  rows.push([{ text: '뒤로', callback_data: mode === 'op' ? 'm:r' : 'm:l:omo' }]);
  return { inline_keyboard: rows };
}

function buildModelPickerKeyboard(models, mode, page = 0) {
  const pageSize = 10;
  const start = Math.max(0, page) * pageSize;
  const end = Math.min(models.length, start + pageSize);
  const prefix = mode === 'op' ? 'm:o:' : 'm:s:';
  const rows = models.slice(start, end).map((model, idx) => ([
    { text: model.length > 38 ? model.slice(0, 38) + '...' : model, callback_data: `${prefix}${start + idx}` },
  ]));

  const nav = [];
  if (start > 0) nav.push({ text: '이전', callback_data: 'm:mp:prev' });
  if (end < models.length) nav.push({ text: '다음', callback_data: 'm:mp:next' });
  if (nav.length > 0) rows.push(nav);

  rows.push([{ text: '뒤로', callback_data: 'm:bp' }]);
  return { inline_keyboard: rows };
}

function buildRevertConfirmKeyboard(token) {
  return {
    inline_keyboard: [[
      { text: 'Confirm revert', callback_data: `rv:c:${token}` },
      { text: 'Cancel', callback_data: `rv:x:${token}` },
    ]],
  };
}

function generateRevertToken() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function rememberRevertTarget(chatId, telegramMessageId, target) {
  ensureRevertTargetsLoaded();
  const key = String(chatId);
  const messageId = Number(telegramMessageId);
  if (!Number.isInteger(messageId) || messageId <= 0) return;

  let map = revertTargetsByChat.get(key);
  if (!map) {
    map = new Map();
    revertTargetsByChat.set(key, map);
  }
  const previous = map.get(messageId) || null;
  const next = {
    ...(target || {}),
    chatId: key,
    telegramMessageId: messageId,
    createdAt: previous && Number(previous.createdAt) > 0
      ? Number(previous.createdAt)
      : Date.now(),
  };

  const unchanged = previous
    && previous.repoName === next.repoName
    && previous.sessionId === next.sessionId
    && previous.messageId === next.messageId
    && previous.partId === next.partId;
  if (unchanged) return;

  map.set(messageId, next);

  audit('revert.target.remember', {
    chatId: key,
    telegramMessageId: messageId,
    mapSize: map.size,
    repoName: target && target.repoName ? String(target.repoName) : '',
    sessionId: target && target.sessionId ? String(target.sessionId) : '',
    messageId: target && target.messageId ? String(target.messageId) : '',
    partId: target && target.partId ? String(target.partId) : '',
  });

  if (map.size > REVERT_TARGET_LIMIT_PER_CHAT) {
    const staleCount = map.size - REVERT_TARGET_LIMIT_PER_CHAT;
    const keys = Array.from(map.keys()).slice(0, staleCount);
    for (const k of keys) map.delete(k);
  }

  persistRevertTargets();
}

function registerRevertTargetFromSentMessage(chatId, sentMessage, target) {
  if (!sentMessage || !target) return;
  const messageId = Number(sentMessage && sentMessage.message_id);
  if (!Number.isInteger(messageId) || messageId <= 0) return;
  rememberRevertTarget(chatId, messageId, target);
}

function resolveRevertReplyTarget(chatId, replyMessageId) {
  ensureRevertTargetsLoaded();
  const key = String(chatId);
  const messageId = Number(replyMessageId);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    audit('revert.target.resolve', {
      chatId: key,
      replyMessageId: messageId,
      found: false,
      reason: 'invalid_reply_message_id',
      mapSize: 0,
    });
    return null;
  }
  const map = revertTargetsByChat.get(key);
  if (!map) {
    audit('revert.target.resolve', {
      chatId: key,
      replyMessageId: messageId,
      found: false,
      reason: 'chat_map_missing',
      mapSize: 0,
    });
    return null;
  }
  const target = map.get(messageId) || null;
  audit('revert.target.resolve', {
    chatId: key,
    replyMessageId: messageId,
    found: !!target,
    mapSize: map.size,
    repoName: target && target.repoName ? String(target.repoName) : '',
    sessionId: target && target.sessionId ? String(target.sessionId) : '',
    messageId: target && target.messageId ? String(target.messageId) : '',
    partId: target && target.partId ? String(target.partId) : '',
  });
  return target;
}

function resetRevertTargetStoreForTest(options = {}) {
  const removePersisted = !!(options && options.removePersisted);
  revertTargetsByChat.clear();
  revertTargetsLoaded = false;
  if (removePersisted && fs.existsSync(REVERT_TARGETS_PATH)) {
    fs.unlinkSync(REVERT_TARGETS_PATH);
  }
}

function createPendingRevertConfirmation(payload) {
  const token = generateRevertToken();
  revertConfirmByToken.set(token, {
    ...payload,
    createdAt: Date.now(),
    consumed: false,
  });
  return token;
}

function getPendingRevertConfirmation(token) {
  const key = String(token || '').trim();
  if (!key) return null;
  const data = revertConfirmByToken.get(key);
  if (!data) return null;
  if (Date.now() - Number(data.createdAt || 0) > REVERT_CONFIRM_TTL_MS) {
    revertConfirmByToken.delete(key);
    return null;
  }
  return data;
}

function consumePendingRevertConfirmation(token) {
  const key = String(token || '').trim();
  if (!key) return null;
  const data = getPendingRevertConfirmation(key);
  if (!data || data.consumed) return null;
  data.consumed = true;
  revertConfirmByToken.set(key, data);
  return data;
}

function clearPendingRevertConfirmation(token) {
  const key = String(token || '').trim();
  if (!key) return;
  revertConfirmByToken.delete(key);
}

async function handleModelsCommand(bot, chatId, repo, state, parsed) {
  const result = modelCommandService.execute({
    repoName: repo.name,
    running: !!state.running,
    args: parsed && Array.isArray(parsed.args) ? parsed.args : [],
  });
  await safeSend(bot, chatId, result.text, result.opts);
}

function formatOnboardingQuestion(session) {
  if (session.step === 'token_mode') {
    return [
      'Onboarding step 1/4',
      'Global Telegram bot token already exists.',
      'Type: reuse or replace',
      'cancel anytime: /onboard cancel',
    ].join('\n');
  }

  if (session.step === 'token_input') {
    return [
      'Onboarding step 1/4',
      'Send global Telegram bot token (format: 123456789:ABC-DEF...)',
      'cancel anytime: /onboard cancel',
    ].join('\n');
  }

  if (session.step === 'repo_name') {
    return [
      'Onboarding step 2/4',
      'Send repo name (letters, numbers, -, _)',
      'example: my-project',
    ].join('\n');
  }

  if (session.step === 'workdir') {
    return [
      'Onboarding step 3/4',
      'Send absolute repo workdir path',
      'example: /Users/name/work/my-project',
    ].join('\n');
  }

  if (session.step === 'attach_chat') {
    return [
      'Onboarding step 4/4',
      'Connect this chat to the new repo now? (yes/no)',
      'If no, you can connect later with /connect <repo>',
    ].join('\n');
  }

  return 'Onboarding state error. Run /onboard again.';
}

function normalizeOnboardingWorkdirInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const quoted = raw.match(/^(["'])(.*)\1$/);
  const unquoted = quoted ? String(quoted[2] || '').trim() : raw;
  if (unquoted.startsWith('~/')) {
    const home = String(process.env.HOME || '').trim();
    if (!home) return unquoted;
    return path.join(home, unquoted.slice(2));
  }
  return unquoted;
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
      opencodeCommand: 'opencode sdk',
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
    const normalizedWorkdir = normalizeOnboardingWorkdirInput(value);
    if (!path.isAbsolute(normalizedWorkdir)) {
      await safeSend(bot, chatId, 'Workdir must be an absolute path.');
      return true;
    }
    if (!fs.existsSync(normalizedWorkdir) || !fs.statSync(normalizedWorkdir).isDirectory()) {
      await safeSend(bot, chatId, 'Workdir directory does not exist. Send another path.');
      return true;
    }
    session.data.workdir = normalizedWorkdir;
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


function clearTypingIndicatorTimer(state) {
  if (!state || !state.typingIndicator || !state.typingIndicator.timer) return;
  clearTimeout(state.typingIndicator.timer);
  state.typingIndicator.timer = null;
}

function shouldRenewTypingIndicator(now, lastSentAt, intervalMs) {
  const current = Number(now || 0) || 0;
  const last = Number(lastSentAt || 0) || 0;
  const interval = Number(intervalMs || 0) || 0;
  if (current <= 0) return false;
  if (last <= 0) return true;
  return (current - last) >= interval;
}

function extractMermaidBlocks(text) {
  const src = String(text || '');
  const out = [];
  const re = /```mermaid\s*([\s\S]*?)```/gi;
  let m = re.exec(src);
  while (m !== null) {
    const body = String(m[1] || '').trim();
    if (body) out.push(body);
    m = re.exec(src);
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

  function normalizeMermaidSource(src) {
    const normalized = String(src || '').replace(/\r\n/g, '\n');
    const lines = normalized.split('\n').map((line) => line.replace(/\s+$/g, ''));
    const merged = [];
    for (const line of lines) {
      if (!line) {
        merged.push('');
        continue;
      }
      const semiSplit = line.split(';').map((x) => x.trim()).filter(Boolean);
      if (semiSplit.length > 1) {
        merged.push(...semiSplit);
        continue;
      }
      const splitByInlineEdge = line.replace(/([\]\)\}])\s{2,}(?=[A-Za-z0-9_]+\s*(?:-->|==>|-.->))/g, '$1\n');
      merged.push(...splitByInlineEdge.split('\n'));
    }
    return merged.join('\n').trim() + '\n';
  }

  for (let i = 0; i < capped.length; i++) {
    const now = new Date().toISOString().replace(/[.:]/g, '-');
    const base = `tg_${String(chatId).replace(/[^0-9-]/g, '_')}_${now}_${i + 1}`;
    const inPath = path.join(dir, `${base}.mmd`);
    const outSvgPath = path.join(dir, `${base}.svg`);
    const outPngPath = path.join(dir, `${base}.png`);
    fs.writeFileSync(inPath, normalizeMermaidSource(capped[i]), 'utf8');

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
      artifacts.push({ kind: 'mmd', path: inPath, error: stderrSvg || stderrPng || 'render failed' });
    }
  }

  return artifacts;
}

function collectMermaidBlocksFromTextSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const merged = segments
    .map((segment) => String(segment || '').trim())
    .filter(Boolean)
    .join('\n\n');
  if (!merged) return [];
  return extractMermaidBlocks(merged);
}

async function sendMermaidArtifactsForRun({ bot, repo, chatId, textSegments, runAuditMeta, revertTarget }) {
  const mermaidBlocks = collectMermaidBlocksFromTextSegments(textSegments);
  if (mermaidBlocks.length === 0) return false;

  if (!hasMermaidRenderer()) {
    await safeSend(
      bot,
      chatId,
      'Mermaid blocks detected, but renderer is unavailable. Install mermaid-cli (`mmdc`) to receive rendered diagrams.',
      undefined,
      {
        ...(runAuditMeta || {}),
        channel: 'mermaid',
        reason: 'renderer_unavailable',
      }
    );
    return true;
  }

  const artifacts = renderMermaidArtifacts(repo, chatId, mermaidBlocks);
  for (let i = 0; i < artifacts.length; i += 1) {
    const artifact = artifacts[i];
    const caption = artifacts.length > 1 ? `Mermaid diagram ${i + 1}/${artifacts.length}` : 'Mermaid diagram';
    if (artifact.kind === 'svg') {
      const sent = await safeSendDocument(bot, chatId, artifact.path, caption, {
        ...(runAuditMeta || {}),
        channel: 'mermaid',
      });
      registerRevertTargetFromSentMessage(chatId, sent, revertTarget);
      continue;
    }
    if (artifact.kind === 'png') {
      const sent = await safeSendPhoto(bot, chatId, artifact.path, caption, {
        ...(runAuditMeta || {}),
        channel: 'mermaid',
      });
      registerRevertTargetFromSentMessage(chatId, sent, revertTarget);
      continue;
    }
    if (artifact.kind === 'mmd') {
      const sent = await safeSendDocument(bot, chatId, artifact.path, `${caption} (source, render failed)`, {
        ...(runAuditMeta || {}),
        channel: 'mermaid',
      });
      registerRevertTargetFromSentMessage(chatId, sent, revertTarget);
      await safeSend(
        bot,
        chatId,
        `Mermaid render failed; sent source file instead.\nreason: ${String(artifact.error || '').slice(0, 300)}`,
        undefined,
        {
          ...(runAuditMeta || {}),
          channel: 'mermaid',
          reason: 'render_failed',
        }
      );
    }
  }
  return true;
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

function parseRawEventContent(raw) {
  const text = String(raw || '').trim();
  if (!text) return { kind: 'empty', text: '' };
  if (!(text.startsWith('{') || text.startsWith('['))) return { kind: 'text', text };
  try {
    const json = JSON.parse(text);
    if (json && typeof json === 'object') return { kind: 'json', text, json };
    return { kind: 'text', text };
  } catch (_err) {
    return { kind: 'text', text };
  }
}

function formatRawEventPreview(raw) {
  const parsed = parseRawEventContent(raw);
  if (parsed.kind === 'empty') return { show: false, preview: '', category: 'empty', sample: '' };
  if (parsed.kind === 'text') {
    const preview = summarizeAuditText(parsed.text);
    return { show: !!preview, preview, category: 'plain_text', sample: preview };
  }

  const evt = parsed.json;
  const type = String(evt.type || '').trim();
  const props = evt.properties && typeof evt.properties === 'object' ? evt.properties : {};

  if (type === 'tui.toast.show') {
    const title = String(props.title || '').replace(/[\u25cf\u25cb\u25cc\u25e6\u2022\u00b7]/g, '').trim();
    const message = String(props.message || '').trim();
    const merged = [title, message].filter(Boolean).join(' - ');
    const preview = summarizeAuditText(merged ? `toast: ${merged}` : 'toast event');
    return { show: !!preview, preview, category: 'toast', sample: summarizeAuditText(parsed.text) };
  }

  if (type === 'session.updated') {
    const info = props.info && typeof props.info === 'object' ? props.info : {};
    const sid = String(info.id || '').trim();
    const dir = String(info.directory || '').trim();
    const preview = summarizeAuditText(`session updated${sid ? `: ${sid.slice(0, 16)}` : ''}${dir ? ` (${dir})` : ''}`);
    return { show: !!preview, preview, category: 'session', sample: summarizeAuditText(parsed.text) };
  }

  if (type === 'message.part.delta') {
    const delta = String(props.delta || '').trim();
    const field = String(props.field || '').trim();
    const body = delta || field || 'delta';
    const preview = summarizeAuditText(`stream delta: ${body}`);
    return { show: !!preview, preview, category: 'message_delta', sample: summarizeAuditText(parsed.text) };
  }

  if (type === 'server.connected') {
    return { show: true, preview: 'event stream connected', category: 'server', sample: summarizeAuditText(parsed.text) };
  }

  if (type === 'session.diff') {
    return { show: true, preview: 'session diff updated', category: 'session_diff', sample: summarizeAuditText(parsed.text) };
  }

  if (type === 'message.updated') {
    const info = props.info && typeof props.info === 'object' ? props.info : {};
    const role = String(info.role || '').trim();
    const preview = summarizeAuditText(`message updated${role ? `: ${role}` : ''}`);
    return { show: !!preview, preview, category: 'message', sample: summarizeAuditText(parsed.text) };
  }

  const fallback = summarizeAuditText(`${type || 'json'} event`);
  return { show: !!fallback, preview: fallback, category: 'json_other', sample: summarizeAuditText(parsed.text) };
}

function resolveRawDeliveryPlan(rawInfo, verbose) {
  const category = rawInfo && rawInfo.category ? String(rawInfo.category) : 'unknown';
  if (!rawInfo || !rawInfo.show || !rawInfo.preview) {
    return { updateStream: false, sendVerboseDirect: false };
  }

  if (category === 'plain_text' || category === 'message_delta') {
    return { updateStream: true, sendVerboseDirect: false };
  }

  if (category === 'toast') {
    return { updateStream: !!verbose, sendVerboseDirect: false };
  }

  if (category === 'session' || category === 'session_diff' || category === 'server' || category === 'message' || category === 'json_other') {
    return { updateStream: false, sendVerboseDirect: !!verbose };
  }

  return { updateStream: !!verbose, sendVerboseDirect: !!verbose };
}

function buildNoOutputMessage({
  exitCode,
  stepCount,
  toolCount,
  toolNames,
  stepReason,
  rawSamples,
  logFile,
  rateLimit,
  stderrSamples,
  includeRawDiagnostics,
  noOutputReason,
}) {
  const status = exitCode === 0 ? 'done (no final text)' : `exit ${exitCode}`;
  let headline = 'No final answer text was produced by opencode.';
  if (noOutputReason === 'sanitized_prompt_echo') {
    headline = 'Opencode returned output, but it was sanitized as prompt/control echo.';
  } else if (noOutputReason === 'sanitized_control_only') {
    headline = 'Opencode returned control output only (no user-facing final answer body).';
  }
  const lines = [
    headline,
    `status: ${status}`,
    `steps: ${stepCount}, tools: ${toolCount}`,
  ];

  if (rateLimit && rateLimit.detected) {
    lines.push('Detected model/API rate limit from opencode output.');
    if (Number.isFinite(rateLimit.retryAfterSeconds) && rateLimit.retryAfterSeconds > 0) {
      lines.push(`recommended wait: ${rateLimit.retryAfterSeconds}s before retry`);
    } else {
      lines.push('recommended wait: 30-60s before retry');
    }
  }

  const recentTools = toolNames.slice(-5);
  if (recentTools.length > 0) {
    lines.push(`recent tools: ${recentTools.join(' | ')}`);
  }

  if (stepReason) {
    lines.push(`last step reason: ${stepReason}`);
  }

  if (includeRawDiagnostics && rawSamples.length > 0) {
    lines.push('recent raw events:');
    rawSamples.forEach((raw, idx) => {
      lines.push(`${idx + 1}. ${raw}`);
    });
  }

  if (Array.isArray(stderrSamples) && stderrSamples.length > 0) {
    lines.push('recent stderr lines:');
    stderrSamples.slice(-3).forEach((raw, idx) => {
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


function formatSystemReminderForDisplay(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  let lines = normalized.split('\n');
  if (String(lines[0] || '').trim().toLowerCase() === 'system-reminder:') {
    lines = lines.slice(1);
  }

  while (lines.length > 0 && !String(lines[0] || '').trim()) {
    lines.shift();
  }

  const first = String(lines[0] || '').trim();
  if (/^\[[^\]]+\]$/.test(first)) {
    lines.shift();
    while (lines.length > 0 && !String(lines[0] || '').trim()) {
      lines.shift();
    }
  }

  const completedAt = lines.findIndex((line) => /^\*\*?Completed:\*\*?$|^Completed:$/.test(String(line || '').trim()));
  if (completedAt < 0) {
    const body = lines.join('\n').trim();
    if (!body) return '';
    return ['```text', 'system-reminder:', body, '```'].join('\n');
  }

  const compact = ['Completed:'];
  for (let i = completedAt + 1; i < lines.length; i++) {
    const trimmed = String(lines[i] || '').trim();
    if (!trimmed) {
      if (compact.length > 1) break;
      continue;
    }
    if (/background_output\s*\(\s*task_id\s*=\s*/i.test(trimmed)) break;
    if (trimmed.startsWith('- ')) {
      compact.push(trimmed);
      continue;
    }
    if (compact.length > 1) break;
  }

  if (compact.length <= 1) {
    const body = lines.join('\n').trim();
    if (!body) return '';
    return ['```text', 'system-reminder:', body, '```'].join('\n');
  }

  return ['```text', ...compact, '```'].join('\n');
}

function stripPromptEchoSuffix(text, promptText) {
  let out = String(text || '');
  const prompt = String(promptText || '').trim();
  if (!out || !prompt) return out;
  const variants = [prompt, prompt.replace(/^\[/, '')]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  for (const v of variants) {
    if (!v) continue;
    if (out.endsWith(v)) {
      out = out.slice(0, out.length - v.length).trimEnd();
      return out;
    }
  }
  return out;
}

function isControlLikeOutput(text) {
  const src = String(text || '').toLowerCase();
  if (!src) return false;
  const markers = [
    '<ultrawork-mode>',
    '</ultrawork-mode>',
    '[code red]',
    'mandatory certainty protocol',
    'you must say "ultrawork mode enabled!"',
    'plan agent invocation',
    'zero tolerance failures',
  ];
  return markers.some((m) => src.includes(m));
}

function normalizeLooseText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .trim();
}

function isPromptEchoLike(text, promptText) {
  const body = normalizeLooseText(text);
  const prompt = normalizeLooseText(promptText);
  if (!body || !prompt) return false;
  if (body === prompt) return true;
  if (body.startsWith(prompt) || body.endsWith(prompt)) {
    return body.length <= prompt.length + 120;
  }
  return false;
}

function tryRecoverFromPromptEcho({
  metaFinalText,
  streamFinalText,
  promptText,
}) {
  const rawMeta = sanitizeWithoutPromptEchoStrip(metaFinalText);
  const rawStream = sanitizeWithoutPromptEchoStrip(streamFinalText);
  const ordered = [rawMeta, rawStream].filter((v) => String(v || '').trim());
  for (const candidate of ordered) {
    const suffixStripped = stripPromptEchoSuffix(candidate, promptText);
    const cleaned = sanitizeDisplayOutputText(suffixStripped);
    if (!cleaned) continue;
    if (isControlLikeOutput(cleaned)) continue;
    if (isPromptEchoLike(cleaned, promptText)) continue;
    return cleaned;
  }
  return '';
}

function mergeTextForFinalization(prev, next) {
  const a = String(prev || '').trim();
  const b = String(next || '').trim();
  if (!a) return b;
  if (!b) return a;
  if (b.includes(a)) return b;
  if (a.includes(b)) return a;
  return `${a}\n${b}`;
}

function createOutputSnapshot() {
  return {
    seq: 0,
    rawFinalSnapshot: '',
    canonicalFinal: '',
    finalText: '',
    finalSeen: '',
    finalCandidate: '',
    reminderTexts: [],
    streamText: '',
  };
}

function rebuildFinalCandidateSnapshot(snapshot, {
  rawText,
  promptText,
  seq,
}) {
  const nextSeq = Number.isFinite(Number(seq)) ? Number(seq) : (snapshot.seq + 1);
  if (nextSeq < snapshot.seq) {
    return {
      updated: false,
      cleaned: snapshot.canonicalFinal,
      reminderTexts: snapshot.reminderTexts.slice(),
      seq: snapshot.seq,
    };
  }

  const cleaned = sanitizeCanonicalOutputText(rawText || '', promptText);
  const nextReminders = [];
  const remindersChanged = nextReminders.length !== snapshot.reminderTexts.length
    || nextReminders.some((v, i) => v !== snapshot.reminderTexts[i]);
  const finalChanged = cleaned !== snapshot.canonicalFinal;

  snapshot.seq = nextSeq;
  snapshot.rawFinalSnapshot = String(rawText || '');
  snapshot.canonicalFinal = cleaned;
  snapshot.finalText = cleaned;
  snapshot.finalSeen = cleaned;
  snapshot.finalCandidate = cleaned;
  snapshot.reminderTexts = nextReminders;

  return {
    updated: finalChanged || remindersChanged,
    cleaned,
    reminderTexts: nextReminders,
    seq: snapshot.seq,
  };
}

function reconcileOutputSnapshot(snapshot, {
  rawText,
  textKind,
  promptText,
  authoritativeFinal,
  seq,
}) {
  const kind = String(textKind || 'stream');
  let reasoningText = '';
  let nextRaw = String(rawText || '');
  if (!authoritativeFinal) {
    if (kind === 'final') {
      nextRaw = String(rawText || '');
    } else if (kind === 'stream') {
      nextRaw = mergeTextForFinalization(snapshot.rawFinalSnapshot, rawText || '');
    } else {
      nextRaw = snapshot.rawFinalSnapshot;
    }
  }

  const rebuilt = rebuildFinalCandidateSnapshot(snapshot, {
    rawText: nextRaw,
    promptText,
    seq,
  });

  if (kind === 'reasoning') {
    snapshot.streamText = sanitizeFinalOutputText(rawText || '', promptText);
    reasoningText = snapshot.streamText;
  } else if (kind === 'stream' && rebuilt.cleaned.trim()) {
    snapshot.streamText = rebuilt.cleaned;
  }

  const latestReminderText = rebuilt.reminderTexts.length > 0
    ? rebuilt.reminderTexts[rebuilt.reminderTexts.length - 1]
    : '';

  return {
    updated: rebuilt.updated,
    cleaned: rebuilt.cleaned,
    reminderText: latestReminderText,
    reminderTexts: rebuilt.reminderTexts,
    reasoningText,
    classifiedKind: authoritativeFinal ? 'final' : kind,
  };
}

function selectFinalOutputText(metaFinalText, streamFinalText) {
  const metaText = String(metaFinalText || '').trim();
  const streamText = String(streamFinalText || '').trim();
  if (metaText) return metaText;
  return streamText;
}

function resolveFinalizationOutput({
  metaFinalText,
  streamFinalText,
  promptText,
  isVersionPrompt,
  hermuxVersion,
}) {
  const cleanMeta = sanitizeCanonicalOutputText(metaFinalText, promptText);
  const cleanStream = sanitizeCanonicalOutputText(streamFinalText, promptText);
  let canonicalText = selectFinalOutputText(cleanMeta, cleanStream);
  const rawMeta = String(metaFinalText || '').trim();
  const rawStream = String(streamFinalText || '').trim();
  const hadRawFinal = !!(rawMeta || rawStream);
  let emptyReason = 'no_raw_output';
  if (!canonicalText && hadRawFinal) {
    const unstrippedMeta = sanitizeWithoutPromptEchoStrip(metaFinalText);
    const unstrippedStream = sanitizeWithoutPromptEchoStrip(streamFinalText);
    const unstripped = selectFinalOutputText(unstrippedMeta, unstrippedStream);
    emptyReason = unstripped ? 'sanitized_prompt_echo' : 'sanitized_control_only';
    if (emptyReason === 'sanitized_prompt_echo') {
      const recovered = tryRecoverFromPromptEcho({
        metaFinalText,
        streamFinalText,
        promptText,
      });
      if (recovered) {
        canonicalText = recovered;
        emptyReason = 'recovered_prompt_echo';
      }
    }
  }
  const displayText = sanitizeDisplayOutputText(canonicalText);
  const outgoingText = isVersionPrompt ? appendHermuxVersion(displayText, hermuxVersion) : displayText;
  const shouldSendFinal = !!String(outgoingText || '').trim();
  let streamCompletionText = 'completed (no final answer produced).';
  if (shouldSendFinal) {
    streamCompletionText = 'completed. final answer sent below.';
  } else if (hadRawFinal) {
    streamCompletionText = 'completed (output was sanitized to empty).';
  }
  return {
    mergedFinal: canonicalText,
    outgoingText,
    shouldSendFinal,
    streamCompletionText,
    hadRawFinal,
    emptyReason,
  };
}

function buildStreamingStatusHtml(text, verbose) {
  const raw = String(text || '');
  const limit = verbose ? 2600 : 1800;
  const tail = raw.length > limit ? '...' + raw.slice(-limit) : raw;
  const body = tail || '(working...)';
  return md2html(body);
}

function buildLiveStatusPanelHtml({
  repoName,
  runId,
  verbose,
  phase,
  stepCount,
  toolCount,
  queueLength,
  sessionId,
  waitInfo,
  lastTool,
  lastReasoning,
  lastReminder,
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
            : phase === 'waiting'
              ? '⌛'
            : '❌';

  const lines = [`<b>${phaseIcon} ${escapeHtml(repoName)} · ${escapeHtml(phase)}</b>`, `<code>🔁 ${stepCount} · 🧰 ${toolCount}${verbose ? ' · 🧠 v' : ''}</code>`];
  if ((queueLength || 0) > 0) {
    lines.push(`<code>📥 queue: ${queueLength}</code>`);
  }

  const shortRunId = String(runId || '').trim();
  if (shortRunId) {
    lines.push(`<code>🧷 ${escapeHtml(shortRunId.slice(0, 20))}</code>`);
  }

  if (waitInfo && waitInfo.status === 'retry') {
    const retryAfter = Number(waitInfo.retryAfterSeconds || 0);
    if (retryAfter > 0) {
      lines.push(`<code>⌛ waiting for model quota (${retryAfter}s)</code>`);
    } else {
      lines.push('<code>⌛ waiting for model quota</code>');
    }
  }

  const reasoningPreview = String(lastReasoning || '').trim();
  if (reasoningPreview) {
    const clipped = reasoningPreview.length > 240 ? `${reasoningPreview.slice(0, 237)}...` : reasoningPreview;
    lines.push(md2html(`💭 ${clipped}`));
  }

  const reminderPreview = String(lastReminder || '').trim();
  if (reminderPreview) {
    lines.push(md2html(reminderPreview));
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
        waitingInfo: null,
        queue: [],
        deferredRunStartTasks: [],
        panelRefresh: null,
        dispatchQueue: Promise.resolve(),
        runViewDispatchQueue: Promise.resolve(),
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

function buildStatusKeyboard() {
  return {
    inline_keyboard: [[
      { text: 'Models', callback_data: 'm:r' },
      { text: 'Verbose', callback_data: 'verbose:status' },
      { text: 'Interrupt', callback_data: 'interrupt:now' },
    ]],
  };
}

function buildRuntimeStatusHtml({ repo, state, chatId }) {
  const info = getSessionInfo(repo.name, chatId);
  const sid = info && info.sessionId ? String(info.sessionId) : '';
  const shortSid = sid ? sid.slice(0, 24) : '(none)';
  const queueLen = Array.isArray(state.queue) ? state.queue.length : 0;
  const waiting = state.waitingInfo ? 'yes' : 'no';
  const lifecycle = state.running ? (state.waitingInfo ? 'waiting' : 'running') : 'ready';
  const waitDetail = state.waitingInfo && state.waitingInfo.status === 'retry'
    ? `retry${state.waitingInfo.retryAfterSeconds ? ` (${state.waitingInfo.retryAfterSeconds}s)` : ''}`
    : '-';
  const runtimeStatus = getRuntimeStatusForInstance(repo);
  const runtimeState = runtimeStatus.active ? 'active' : 'idle';
  const runtimeTransport = String(runtimeStatus.transport || 'unknown');
  return [
    `<b>📊 Runtime Status · ${escapeHtml(repo.name)}</b>`,
    `<code>chat: ${escapeHtml(chatId)}</code>`,
    `<code>workdir: ${escapeHtml(repo.workdir)}</code>`,
    '',
    `<code>state: ${lifecycle} | busy: ${state.running ? 'yes' : 'no'} | waiting: ${waiting} | queue: ${queueLen}</code>`,
    `<code>runtime: ${runtimeState} | transport: ${runtimeTransport} | runs: ${Number(runtimeStatus.activeRuns || 0)}</code>`,
    `<code>verbose: ${state.verbose ? 'on' : 'off'}</code>`,
    `<code>session: ${escapeHtml(shortSid)}</code>`,
    `<code>wait detail: ${escapeHtml(waitDetail)}</code>`,
  ].join('\n');
}

async function sendRepoList(bot, chatId, chatRouter) {
  const repos = getEnabledRepos();
  const mappedRepo = chatRouter.get(chatId);
  const text = formatRepoList(repos, mappedRepo ? mappedRepo.name : '');
  const keyboard = buildConnectKeyboard(repos);
  const opts = keyboard ? { reply_markup: keyboard } : undefined;
  await safeSend(bot, chatId, text, opts);
}

function isLikelyGroupChatId(chatId) {
  return String(chatId || '').trim().startsWith('-');
}

async function handleConnectCommand(bot, chatId, args, chatRouter, states) {
  const availableRepos = getEnabledRepos();
  if (availableRepos.length === 0) {
    await safeSend(bot, chatId, `No enabled repos found in ${CONFIG_PATH}\nRun: hermux onboard`);
    return;
  }

  const requestedRepo = String(args[0] || '').trim();
  const remapConfirm = Array.isArray(args) && args.slice(1).some((arg) => {
    const token = String(arg || '').trim().toLowerCase();
    return token === 'move' || token === '--move' || token === 'confirm' || token === '--confirm';
  });
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
    const knownRepo = availableRepos.some((repo) => repo && repo.name === requestedRepo);
    if (!knownRepo) {
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

    const result = await withConnectMutationLock(() => chatRoutingService.connectChat({
      requestedRepo,
      chatId,
      availableRepos,
      remapConfirm,
      chatRouter,
      states,
    }));

    if (result.kind === 'connected' && result.includeGroupHint) {
      await safeSend(bot, chatId, [
        result.text,
        '',
        'Group chat note:',
        '- If normal text prompts are not received, disable BotFather privacy mode (/setprivacy -> Disable).',
        '- With privacy mode ON, use @bot mention or reply-to-bot message.',
      ].join('\n'));
      return;
    }

    await safeSend(bot, chatId, result.text);
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

async function createRevertConfirmation(_bot, chatId, repo, _state, input) {
  const target = input && input.target ? input.target : null;
  const replyMessageId = Number(input && input.replyMessageId);
  const userId = String((input && input.userId) || '').trim();
  if (!target) {
    throw new Error('missing revert target');
  }

  const token = createPendingRevertConfirmation({
    chatId: String(chatId),
    repoName: String(repo && repo.name || ''),
    replyMessageId,
    sessionId: String(target.sessionId || ''),
    messageId: String(target.messageId || ''),
    partId: String(target.partId || ''),
    userId,
  });

  const targetLine = target.partId
    ? `target: message=${target.messageId}, part=${target.partId}`
    : `target: message=${target.messageId}`;
  return {
    text: [
      'Revert confirmation required.',
      `repo: ${repo.name}`,
      `session: ${target.sessionId}`,
      `reply_message_id: ${replyMessageId}`,
      targetLine,
      '',
      'This will restore files/history from that point. Continue?',
    ].join('\n'),
    opts: {
      reply_markup: buildRevertConfirmKeyboard(token),
    },
  };
}

async function executeSessionUnrevert(repo, chatId) {
  const sessionId = getSessionId(repo.name, chatId);
  if (!sessionId) {
    return { text: 'No active session for this chat. Nothing to unrevert.' };
  }

  try {
    const result = await runSessionUnrevert(repo, { sessionId });
    if (!result.hadRevert || result.noop) {
      return {
        text: [
          'No active revert state found.',
          'Unrevert is only possible while session.revert still exists (before cleanup).',
        ].join('\n'),
      };
    }
    return {
      text: [
        'Unrevert applied.',
        `repo: ${repo.name}`,
        `session: ${sessionId}`,
      ].join('\n'),
    };
  } catch (err) {
    return {
      text: `Unrevert failed: ${String(err && err.message ? err.message : err || '')}`,
    };
  }
}

async function handleRevertConfirmCallback(bot, query, chatRouter, states, token) {
  const chat = query && query.message && query.message.chat;
  const chatId = chat ? String(chat.id) : '';
  const record = consumePendingRevertConfirmation(token);
  if (!record) {
    return { answerText: 'expired' };
  }

  if (record.chatId !== chatId) {
    return { answerText: 'not allowed' };
  }
  if (record.userId) {
    const fromId = String((query && query.from && query.from.id) || '').trim();
    if (fromId && fromId !== record.userId) {
      return { answerText: 'author only' };
    }
  }

  const repo = chatRouter.get(chatId);
  if (!repo || repo.name !== record.repoName) {
    return { answerText: 'stale target' };
  }

  const state = states.get(repo.name);
  if (!state) {
    return { answerText: 'state missing' };
  }

  return withStateDispatchLock(state, async () => {
    if (state.running) {
      await safeSend(bot, chatId, 'Cannot revert while running. Wait for current task to finish.');
      return { answerText: 'busy' };
    }

    const activeSessionId = getSessionId(repo.name, chatId);
    if (!activeSessionId || activeSessionId !== record.sessionId) {
      await safeSend(
        bot,
        chatId,
        'Revert target is stale because current session changed. Reply to a recent output and run /revert again.'
      );
      return { answerText: 'stale session' };
    }

    try {
      const revertResult = await runSessionRevert(repo, {
        sessionId: record.sessionId,
        messageId: record.messageId,
      });
      if (!revertResult || !revertResult.canUnrevert) {
        await safeSend(bot, chatId, [
          'Revert target was not found in current session timeline.',
          'No changes were applied.',
          'Reply to a more recent bot output and run /revert again.',
        ].join('\n'));
        return { answerText: 'no target' };
      }
      await safeSend(bot, chatId, [
        'Revert applied.',
        `repo: ${repo.name}`,
        `session: ${record.sessionId}`,
        `target_message: ${record.messageId}`,
        'Tip: /unrevert is available until next cleanup-triggering action.',
      ].join('\n'));
      return { answerText: 'reverted' };
    } catch (err) {
      await safeSend(bot, chatId, `Revert failed: ${String(err && err.message ? err.message : err || '')}`);
      return { answerText: 'failed' };
    }
  });
}

function handleRevertCancelCallback(token) {
  clearPendingRevertConfirmation(token);
  return { answerText: 'cancelled' };
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
    env: { ...process.env, HERMUX_DAEMON_CHILD: '1' },
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

    if (process.env.HERMUX_DAEMON_CHILD !== '1') {
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
    if (state.running && state.currentProc) {
      requestInterrupt(state, { forceAfterMs: 800 });
      try {
        sendInterruptSignal(state.currentProc, 'SIGKILL');
        if (state.currentProc.stdout && !state.currentProc.stdout.destroyed) state.currentProc.stdout.destroy();
        if (state.currentProc.stderr && !state.currentProc.stderr.destroyed) state.currentProc.stderr.destroy();
      } catch (_err) {
      }
      await safeSend(bot, chatId, `Restarting daemon for repo ${repo.name}. Current task is being interrupted now.`);
    } else {
      await safeSend(bot, chatId, `Restarting daemon for repo ${repo.name}...`);
    }

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
      await stopAllRuntimeExecutors();
    } catch (err) {
      console.error('[restart] failed to stop runtime executors:', err.message);
    }

    try {
      spawnReplacementDaemon();
    } catch (err) {
      console.error('[restart] failed to spawn replacement daemon:', err.message);
    }

    setTimeout(() => process.exit(0), 50);
  });
}

async function clearSessionDelivery(state, chatId) {
  if (!state || !state.sessionDelivery) return;
  const current = state.sessionDelivery;
  if (chatId && String(current.chatId || '') !== String(chatId)) return;
  state.sessionDelivery = null;
  if (typeof current.unsubscribe === 'function') {
    try {
      await current.unsubscribe();
    } catch (_err) {
    }
  }
}

function clearRunRenderStateAtRunStart(state, sessionId) {
  if (!state || typeof state !== 'object') return;
  if (!(state.sessionRenderStates instanceof Map)) {
    state.sessionRenderStates = new Map();
  }
  if (!(state.sessionProjectedTexts instanceof Map)) {
    state.sessionProjectedTexts = new Map();
  }

  const sid = String(sessionId || '').trim();
  if (!sid) return;

  state.sessionRenderStates.delete(sid);
  state.sessionProjectedTexts.delete(sid);

  const latest = state.latestSessionRenderState;
  const latestSid = String(
    (latest && latest.snapshot && latest.snapshot.sessionId)
    || (latest && latest.renderState && latest.renderState.sessionId)
    || (latest && latest.sessionId)
    || ''
  ).trim();
  if (latestSid === sid) {
    state.latestSessionRenderState = null;
  }
}

function clearRunRenderStateForAttachedSession(state, tracker, sessionId) {
  if (!state || typeof state !== 'object') return '';
  const sid = String(sessionId || '').trim();
  if (!sid) return String(tracker || '').trim();
  const tracked = String(tracker || '').trim();
  if (tracked === sid) return tracked;
  clearRunRenderStateAtRunStart(state, sid);
  return sid;
}

function enqueueDeferredRunStartTask(state, task) {
  if (!state || typeof state !== 'object') return;
  if (typeof task !== 'function') return;
  if (!Array.isArray(state.deferredRunStartTasks)) {
    state.deferredRunStartTasks = [];
  }
  state.deferredRunStartTasks.push(task);
}

async function runDeferredRunStartTasks(state) {
  if (!state || typeof state !== 'object') return;
  const tasks = Array.isArray(state.deferredRunStartTasks) ? state.deferredRunStartTasks.slice() : [];
  state.deferredRunStartTasks = [];
  for (const task of tasks) {
    try {
      await Promise.resolve(task());
    } catch (err) {
      console.error('[deferred-run-start] task failed:', String(err && err.message ? err.message : err || ''));
    }
  }
}

function createTrailingThrottleProcessor({ intervalMs, handler, selectPending }) {
  const waitMs = Number(intervalMs || 0);
  if (typeof handler !== 'function') throw new Error('handler is required');

  let timer = null;
  let inFlight = false;
  let hasPending = false;
  let pendingValue;
  let lastStartAt = 0;

  const schedule = (ms, invoke) => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!hasPending) return;
      const value = pendingValue;
      hasPending = false;
      pendingValue = undefined;
      void invoke(value);
    }, Math.max(1, Number(ms || 0)));
  };

  const invoke = async (value) => {
    inFlight = true;
    lastStartAt = Date.now();
    try {
      await Promise.resolve(handler(value));
    } finally {
      inFlight = false;
      if (hasPending && waitMs > 0) {
        const now = Date.now();
        const nextAllowedAt = lastStartAt + waitMs;
        const delay = Math.max(0, nextAllowedAt - now);
        if (delay <= 0) {
          const nextValue = pendingValue;
          hasPending = false;
          pendingValue = undefined;
          void invoke(nextValue);
        } else {
          schedule(delay, invoke);
        }
      }
    }
  };

  return async function enqueue(value) {
    if (waitMs <= 0) {
      await invoke(value);
      return;
    }

    const now = Date.now();
    const elapsed = lastStartAt > 0 ? now - lastStartAt : Number.MAX_SAFE_INTEGER;
    const canLead = !inFlight && !timer && elapsed >= waitMs;
    if (canLead) {
      await invoke(value);
      return;
    }

    hasPending = true;
    pendingValue = typeof selectPending === 'function'
      ? selectPending(pendingValue, value)
      : value;
    if (inFlight) return;
    if (timer) return;
    const delay = lastStartAt > 0 ? (waitMs - elapsed) : waitMs;
    schedule(delay, invoke);
  };
}

async function startPromptRun(bot, repo, state, runItem) {
  const chatId = runItem.chatId;
  const promptText = runItem.promptText;
  const isVersionPrompt = !!runItem.isVersionPrompt;

  await runDeferredRunStartTasks(state);
  const previousRunView = state.runView && typeof state.runView === 'object'
    ? {
      ...state.runView,
      draftPreview: state.runView.draftPreview && typeof state.runView.draftPreview === 'object'
        ? { ...state.runView.draftPreview }
        : null,
    }
    : null;

  state.running = true;
  clearTypingIndicatorTimer(state);
  if (!state.typingIndicator || typeof state.typingIndicator !== 'object') {
    state.typingIndicator = {
      timer: null,
      lastSentAt: 0,
      busy: false,
      runId: '',
      chatId: '',
    };
  }
  state.interruptRequested = false;
  state.interruptTrace = null;
  state.waitingInfo = null;
  clearInterruptEscalationTimer(state);
  state.currentProc = null;

  const outputSnapshot = createOutputSnapshot();
  let toolCount = 0;
  let stepCount = 0;
  const toolNames = [];
  const rawSamples = [];
  let lastStepReason = null;
  let activeSessionId = getSessionId(repo.name, chatId);
  state.activeSessionId = activeSessionId;
  await maybeMaterializeRunStartDraftPreview(bot, previousRunView, {
    repo: repo.name,
    runId: 'pending',
    sessionId: String(activeSessionId || '').trim(),
    nextChatId: String(chatId),
  });
  clearRunRenderStateAtRunStart(state, activeSessionId);
  let clearedRunRenderSessionId = String(activeSessionId || '').trim();
  const hermuxVersion = String(HERMUX_VERSION || '').trim() || '0.0.0';
  let lastPanelHeartbeatAt = 0;
  let lastStreamSnapshot = '';
  let lastToolBrief = '';
  let lastRawBrief = '';
  let lastReasoningBrief = '';
  let lastReminderBrief = '';
  let lastPanelHtml = '';
  let waitInfo = null;
  let heartbeatTimer = null;
  let completionHandled = false;
  let mermaidAttachmentDelivered = false;
  let lastRawPreviewSent = '';
  let lastRawPreviewSentAt = 0;
  let finalUnitMessageIds = [];
  let lastFinalUnitChunks = [];
  let lastFinalMessageRef = {
    messageId: '',
    partId: '',
  };
  let textEventSeq = 0;
  let eventOrdinal = 0;
  const runStartedAt = Date.now();
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const runStartedAtMs = Date.now();
  state.currentRunContext = {
    runId,
    chatId: String(chatId),
    startedAtMs: runStartedAtMs,
    sessionId: String(activeSessionId || '').trim(),
  };
  state.typingIndicator.runId = runId;
  state.typingIndicator.chatId = String(chatId);
  state.typingIndicator.lastSentAt = 0;
  state.typingIndicator.busy = false;
  state.runView = {
    runId,
    sessionId: String(activeSessionId || '').trim(),
    chatId: String(chatId),
    messageIds: [],
    texts: [],
    draftPreview: null,
    materializedTail: null,
  };
  const runAuditMeta = {
    runId,
    sessionId: String(activeSessionId || '').trim(),
    repo: repo.name,
    chatId: String(chatId),
  };
  const TYPING_RENEW_MS = 4000;
  const isCurrentRunOwner = () => {
    const currentContext = state.currentRunContext && typeof state.currentRunContext === 'object'
      ? state.currentRunContext
      : null;
    return !!(currentContext && String(currentContext.runId || '').trim() === String(runId));
  };
  const scheduleTypingIndicatorRenewal = () => {
    clearTypingIndicatorTimer(state);
    if (!state.typingIndicator || !state.typingIndicator.busy || !isCurrentRunOwner()) return;
    const now = Date.now();
    const lastSentAt = Number(state.typingIndicator.lastSentAt || 0) || 0;
    const waitMs = Math.max(250, TYPING_RENEW_MS - Math.max(0, now - lastSentAt));
    state.typingIndicator.timer = setTimeout(() => {
      if (state.typingIndicator) state.typingIndicator.timer = null;
      void maybeSendTypingIndicator('renew');
    }, waitMs);
  };
  const maybeSendTypingIndicator = async (source) => {
    if (!state.typingIndicator || !state.typingIndicator.busy || !isCurrentRunOwner()) {
      clearTypingIndicatorTimer(state);
      return;
    }
    const now = Date.now();
    if (!shouldRenewTypingIndicator(now, state.typingIndicator.lastSentAt, TYPING_RENEW_MS)) {
      scheduleTypingIndicatorRenewal();
      return;
    }
    const sent = await safeSendChatAction(bot, String(chatId), 'typing', {
      ...runAuditMeta,
      channel: 'run_typing',
      source: String(source || 'session_busy'),
    });
    if (sent && state.typingIndicator) {
      state.typingIndicator.lastSentAt = Date.now();
    }
    scheduleTypingIndicatorRenewal();
  };
  const syncTypingIndicator = (busy, source) => {
    if (!state.typingIndicator) return;
    state.typingIndicator.busy = !!busy;
    if (!state.typingIndicator.busy) {
      clearTypingIndicatorTimer(state);
      return;
    }
    void maybeSendTypingIndicator(source || 'session_busy');
  };
  const getActiveSessionOwner = () => String(state.activeSessionId || activeSessionId || '').trim();
  const runMetrics = {
    upstreamEventCount: 0,
    upstreamFirstEventAtMs: null,
    upstreamLastEventAtMs: null,
    downstreamApplyRequested: 0,
    downstreamApplyExecuted: 0,
    downstreamFirstApplyAtMs: null,
    downstreamLastApplyAtMs: null,
    downstreamCommandCount: 0,
    downstreamSendCount: 0,
    downstreamEditCount: 0,
    downstreamDeleteCount: 0,
    downstreamDraftCount: 0,
  };

  const auditRun = (kind, payload) => {
    audit(kind, {
      ...runAuditMeta,
      tMs: Date.now() - runStartedAt,
      ...(payload || {}),
    });
  };

  const refreshFinalUnitChannel = async (force, explicitText) => {
    const hasExplicit = typeof explicitText === 'string';
    const candidate = hasExplicit
      ? String(explicitText || '').trim()
      : String(outputSnapshot.canonicalFinal || outputSnapshot.finalSeen || outputSnapshot.finalText || outputSnapshot.finalCandidate || '').trim();

    const chunks = candidate ? splitTelegramHtml(md2html(candidate), TG_MAX_LEN) : [];
    auditRun('run.ui.final_unit.plan', {
      force: !!force,
      candidateLength: candidate.length,
      candidate,
      chunkCount: chunks.length,
      prevChunkCount: lastFinalUnitChunks.length,
    });
    const sameChunks = chunks.length === lastFinalUnitChunks.length
      && chunks.every((chunk, idx) => chunk === lastFinalUnitChunks[idx]);
    if (!force && sameChunks) return;
    if (sameChunks) return;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const messageId = finalUnitMessageIds[i] || null;
      const prevChunk = lastFinalUnitChunks[i] || '';
      if (messageId) {
        if (chunk !== prevChunk) {
          auditRun('run.ui.final_unit.edit', {
            force: !!force,
            chunkIndex: i,
            chunkCount: chunks.length,
            messageId,
            chunk,
          });
          await editHtml(bot, chatId, messageId, chunk, {
            ...runAuditMeta,
            channel: 'final_unit',
            phase: force ? 'completion' : 'running',
            chunkIndex: i,
            chunkCount: chunks.length,
          });
        }
        if (activeSessionId && lastFinalMessageRef.messageId) {
          registerRevertTargetFromSentMessage(chatId, { message_id: messageId }, {
            repoName: repo.name,
            sessionId: activeSessionId,
            messageId: lastFinalMessageRef.messageId,
            partId: lastFinalMessageRef.partId,
          });
        }
        continue;
      }

      const sent = await safeSend(bot, chatId, chunk, { parse_mode: 'HTML' }, {
        ...runAuditMeta,
        channel: 'final_unit',
        phase: force ? 'completion' : 'running',
        chunkIndex: i,
        chunkCount: chunks.length,
      });
      finalUnitMessageIds[i] = sent && sent.message_id ? sent.message_id : null;
      if (activeSessionId && lastFinalMessageRef.messageId && finalUnitMessageIds[i]) {
        registerRevertTargetFromSentMessage(chatId, { message_id: finalUnitMessageIds[i] }, {
          repoName: repo.name,
          sessionId: activeSessionId,
          messageId: lastFinalMessageRef.messageId,
          partId: lastFinalMessageRef.partId,
        });
      }
      auditRun('run.ui.final_unit.send', {
        force: !!force,
        chunkIndex: i,
        chunkCount: chunks.length,
        messageId: finalUnitMessageIds[i],
        chunk,
      });
    }

    if (finalUnitMessageIds.length > chunks.length) {
      for (let i = chunks.length; i < finalUnitMessageIds.length; i++) {
        const messageId = finalUnitMessageIds[i];
        if (!messageId) continue;
        await safeDeleteMessage(bot, chatId, messageId, {
          ...runAuditMeta,
          channel: 'final_unit',
          phase: force ? 'completion' : 'running',
          chunkIndex: i,
          reason: 'final_unit_chunk_shrink',
        });
        auditRun('run.ui.final_unit.delete', {
          force: !!force,
          chunkIndex: i,
          messageId,
          reason: 'final_unit_chunk_shrink',
        });
      }
      finalUnitMessageIds = finalUnitMessageIds.slice(0, chunks.length);
    }

    auditRun('run.ui.final_unit.applied', {
      force: !!force,
      chunkCount: chunks.length,
      messageIds: finalUnitMessageIds.slice(),
    });
    lastFinalUnitChunks = chunks;
  };

  auditRun('run.start', {
    sessionId: activeSessionId || null,
    isVersionPrompt,
    promptText,
    promptPreview: summarizeAuditText(promptText),
  });

  const RAW_EVENT_PASSTHROUGH = true;
  const sendRawTelegram = async () => {};

  let renderSeq = Number(state.sessionRenderSeq || 0) || 0;
  const applyRunViewSnapshot = async (nextTexts, options) => {
    if (!state.runView) {
      auditRun('run.view.skip', {
        reason: 'missing_run_view_state',
        isFinalState: !!(options && options.isFinalState),
        expectedRunId: runId,
      });
      return;
    }
    const isFinalState = !!(options && options.isFinalState);
    const view = state.runView;
    const targetRunId = String(view.runId || runId);
    const targetChatId = String(view.chatId || chatId);
    const currentContext = state.currentRunContext && typeof state.currentRunContext === 'object'
      ? state.currentRunContext
      : null;
    const targetAuditMeta = {
      ...runAuditMeta,
      runId: targetRunId,
      chatId: targetChatId,
      previewDecisionReason: isFinalState ? 'final_state' : 'active_run_preview',
      materializeReason: 'final_state_materialize',
    };
    const safeNextTexts = Array.isArray(nextTexts) ? nextTexts : [];
    
    // Use provided currentView or fall back to state.runView
    const providedCurrentView = options && options.currentView;
    const currentViewTexts = providedCurrentView && Array.isArray(providedCurrentView.texts) 
      ? providedCurrentView.texts
      : (Array.isArray(view.texts) ? view.texts : []);
    const currentViewMessageIds = providedCurrentView && Array.isArray(providedCurrentView.messageIds)
      ? providedCurrentView.messageIds
      : (Array.isArray(view.messageIds) ? view.messageIds : []);
    const currentDraftPreview = providedCurrentView && providedCurrentView.draftPreview && typeof providedCurrentView.draftPreview === 'object'
      ? providedCurrentView.draftPreview
      : (view && view.draftPreview && typeof view.draftPreview === 'object' ? view.draftPreview : null);
    const currentMaterializedTail = providedCurrentView && providedCurrentView.materializedTail && typeof providedCurrentView.materializedTail === 'object'
      ? providedCurrentView.materializedTail
      : (view && view.materializedTail && typeof view.materializedTail === 'object' ? view.materializedTail : null);
    const previewDraftEnabled = !isFinalState;
    const materializeStaleDraft = !!isFinalState;
    const tailMaterializeHint = options && options.tailMaterializeHint && typeof options.tailMaterializeHint === 'object'
      ? options.tailMaterializeHint
      : null;

    auditRun('run.view.preview.policy', {
      reason: targetAuditMeta.previewDecisionReason,
      isFinalState,
      previewDraftEnabled,
      materializeStaleDraft,
      completionHandled: !!completionHandled,
      hasCurrentDraftPreview: !!currentDraftPreview,
      hasCurrentMaterializedTail: !!currentMaterializedTail,
      currentTextCount: currentViewTexts.length,
      nextTextCount: safeNextTexts.length,
      currentPreviewTransport: currentDraftPreview && currentDraftPreview.transport
        ? String(currentDraftPreview.transport)
        : '',
      tailMaterializeHint,
    });
    
    runMetrics.downstreamApplyExecuted += 1;
    const applyStartAtMs = Date.now() - runStartedAt;
    if (runMetrics.downstreamFirstApplyAtMs === null) {
      runMetrics.downstreamFirstApplyAtMs = applyStartAtMs;
    }
    auditRun('run.view.apply.begin', {
      isFinalState,
      expectedRunId: targetRunId,
      currentRunId: view.runId,
      runViewLockWaitMs: Number(options && options.runViewLockWaitMs ? options.runViewLockWaitMs : 0) || 0,
      currentTextCount: Array.isArray(view.texts) ? view.texts.length : 0,
      nextTextCount: safeNextTexts.length,
      nextPreview: safeNextTexts.slice(0, 2),
    });
    const nextView = await reconcileRunViewForTelegram({
      bot,
      chatId: targetChatId,
      runAuditMeta: targetAuditMeta,
      currentView: {
        texts: currentViewTexts,
        messageIds: currentViewMessageIds,
        draftPreview: currentDraftPreview,
        materializedTail: currentMaterializedTail,
      },
      nextTexts: safeNextTexts,
      tailMaterializeHint,
      maxLen: TG_MAX_LEN,
      isFinalState,
      sendText: safeSend,
      editText: editHtml,
      previewDraft: previewDraftEnabled ? updateTelegramDraftPreview : null,
      materializeDraft: materializeTelegramDraftPreview,
      materializeStaleDraft,
      clearDraft: clearTelegramDraftPreview,
      deleteMessage: safeDeleteMessage,
      onMessagePersist: async ({ messageId }) => {
        if (!activeSessionId || !lastFinalMessageRef.messageId || !messageId) return;
        registerRevertTargetFromSentMessage(chatId, { message_id: messageId }, {
          repoName: repo.name,
          sessionId: activeSessionId,
          messageId: lastFinalMessageRef.messageId,
          partId: lastFinalMessageRef.partId,
        });
      },
    });
    const nextMessageIds = Array.isArray(nextView && nextView.messageIds) ? nextView.messageIds : [];
    const nextStoredTexts = Array.isArray(nextView && nextView.texts) ? nextView.texts : [];
    const stats = nextView && nextView.stats ? nextView.stats : null;
    if (stats) {
      runMetrics.downstreamCommandCount += Number(stats.commandCount || 0) || 0;
      runMetrics.downstreamSendCount += Number(stats.sendCount || 0) || 0;
      runMetrics.downstreamEditCount += Number(stats.editCount || 0) || 0;
      runMetrics.downstreamDeleteCount += Number(stats.deleteCount || 0) || 0;
      runMetrics.downstreamDraftCount += Number(stats.draftCount || 0) || 0;
    }
    const applyEndAtMs = Date.now() - runStartedAt;
    runMetrics.downstreamLastApplyAtMs = applyEndAtMs;
    auditRun('run.view.apply.end', {
      isFinalState,
      expectedRunId: targetRunId,
      currentRunId: view.runId,
      runViewLockWaitMs: Number(options && options.runViewLockWaitMs ? options.runViewLockWaitMs : 0) || 0,
      messageIdCount: nextMessageIds.length,
      textCount: nextStoredTexts.length,
      messageIds: nextMessageIds.slice(),
      textPreview: nextStoredTexts.slice(0, 2),
      contextRunId: currentContext && currentContext.runId ? String(currentContext.runId) : '',
      commandCount: stats ? Number(stats.commandCount || 0) || 0 : 0,
      sendCount: stats ? Number(stats.sendCount || 0) || 0 : 0,
      editCount: stats ? Number(stats.editCount || 0) || 0 : 0,
      deleteCount: stats ? Number(stats.deleteCount || 0) || 0 : 0,
      draftCount: stats ? Number(stats.draftCount || 0) || 0 : 0,
    });
    view.messageIds = Array.isArray(nextView && nextView.messageIds) ? nextView.messageIds : [];
    view.texts = Array.isArray(nextView && nextView.texts) ? nextView.texts : [];
    view.draftPreview = nextView && nextView.draftPreview && typeof nextView.draftPreview === 'object'
      ? nextView.draftPreview
      : null;
    view.materializedTail = nextView && nextView.materializedTail && typeof nextView.materializedTail === 'object'
      ? nextView.materializedTail
      : null;

    if (!mermaidAttachmentDelivered) {
      const delivered = await sendMermaidArtifactsForRun({
        bot,
        repo,
        chatId,
        textSegments: safeNextTexts,
        runAuditMeta,
        revertTarget: activeSessionId && lastFinalMessageRef.messageId
          ? {
            repoName: repo.name,
            sessionId: activeSessionId,
            messageId: lastFinalMessageRef.messageId,
            partId: lastFinalMessageRef.partId,
          }
          : null,
      });
      if (delivered) {
        mermaidAttachmentDelivered = true;
        auditRun('run.mermaid.attachment_sent', {
          textCount: safeNextTexts.length,
          completionHandled,
        });
      }
    }
  };

  const areTextArraysEqual = (a, b) => {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (String(a[i] || '') !== String(b[i] || '')) return false;
    }
    return true;
  };
  const hasTailMaterializeHint = (hint) => !!(
    hint
    && typeof hint === 'object'
    && String(hint.messageId || '').trim()
    && String(hint.partId || '').trim()
  );
  const reconcileRunView = async (nextTexts, options) => {
    const normalizedNextTexts = Array.isArray(nextTexts) ? nextTexts.slice() : [];
    const requestedFinalState = !!(options && options.isFinalState);
    const requestedTailMaterializeHint = options && options.tailMaterializeHint && typeof options.tailMaterializeHint === 'object'
      ? options.tailMaterializeHint
      : null;
    const lockRequestedAt = Date.now();

    return withRunViewDispatchLock(state, async () => {
      const runViewLockWaitMs = Math.max(0, Date.now() - lockRequestedAt);
      const baseView = state.runView || null;
      const currentViewTexts = baseView && Array.isArray(baseView.texts) ? baseView.texts : [];
      const currentDraftPreview = baseView && baseView.draftPreview && typeof baseView.draftPreview === 'object'
        ? baseView.draftPreview
        : null;
      const currentProjectedTexts = currentViewTexts.slice();
      if (currentDraftPreview && currentDraftPreview.text) {
        currentProjectedTexts.push(String(currentDraftPreview.text));
      }

      if (
        !requestedFinalState
        && areTextArraysEqual(currentProjectedTexts, normalizedNextTexts)
        && !hasTailMaterializeHint(requestedTailMaterializeHint)
      ) {
        return;
      }

      const currentView = {
        texts: currentViewTexts,
        messageIds: baseView && Array.isArray(baseView.messageIds) ? baseView.messageIds : [],
        draftPreview: currentDraftPreview,
        materializedTail: baseView && baseView.materializedTail && typeof baseView.materializedTail === 'object'
          ? baseView.materializedTail
          : null,
      };

      runMetrics.downstreamApplyRequested += 1;
      await applyRunViewSnapshot(normalizedNextTexts, {
        isFinalState: requestedFinalState,
        currentView,
        tailMaterializeHint: requestedTailMaterializeHint,
        runViewLockWaitMs,
      });
    });
  };

  const sessionApplyProcessors = new Map();
  const payloadThrottleRank = (payload) => {
    const raw = String(payload || '').trim();
    if (!raw) return 0;
    try {
      const parsed = JSON.parse(raw);
      const type = String(parsed && parsed.type ? parsed.type : '');
      if (type === 'message.part.delta' || type === 'message.part.updated') return 4;
      if (type === 'message.updated') return 3;
      if (type === 'session.status' || type === 'session.idle' || type === 'session.diff') return 1;
      return 2;
    } catch (_err) {
      return 2;
    }
  };
  const getSessionApplyProcessor = (sid) => {
    const key = String(sid || '').trim();
    if (!key) return null;
    const current = sessionApplyProcessors.get(key);
    if (typeof current === 'function') return current;
    const created = createTrailingThrottleProcessor({
      intervalMs: APPLY_PAYLOAD_THROTTLE_MS,
      selectPending: (prev, next) => {
        const batch = Array.isArray(prev) ? prev.slice() : (typeof prev === 'undefined' ? [] : [prev]);
        batch.push(next);
        return batch;
      },
      handler: async (payloadBatch) => {
        if (!isCurrentRunOwner()) {
          auditRun('run.session_event.apply.skip', {
            sid: key,
            reason: 'stale_run_owner',
            ownerRunId: String((state.currentRunContext && state.currentRunContext.runId) || ''),
          });
          return;
        }
        if (!(state.sessionRenderStates instanceof Map)) {
          state.sessionRenderStates = new Map();
        }
        if (!(state.sessionProjectedTexts instanceof Map)) {
          state.sessionProjectedTexts = new Map();
        }
        const batchEntries = Array.isArray(payloadBatch) ? payloadBatch : [payloadBatch];
        const oldestPendingEnqueuedAt = batchEntries.reduce((min, entry) => {
          const candidate = Number(entry && entry.enqueuedAt ? entry.enqueuedAt : 0) || 0;
          if (candidate <= 0) return min;
          if (min <= 0) return candidate;
          return Math.min(min, candidate);
        }, 0);
        const oldestPendingAgeMs = oldestPendingEnqueuedAt > 0
          ? Math.max(0, Date.now() - oldestPendingEnqueuedAt)
          : 0;
        const payloads = batchEntries.map((entry) => (entry && Object.prototype.hasOwnProperty.call(entry, 'payload')
          ? entry.payload
          : entry));
        for (const payload of payloads) {
          const busySignal = readBusySignalFromSessionPayload(payload);
          if (busySignal === null) continue;
          syncTypingIndicator(busySignal, busySignal ? 'session_status_event' : 'session_idle_event');
        }
        let snapshotState = state.sessionRenderStates.get(key) || createRunViewSnapshotState(key);
        auditRun('run.session_event.apply.batch.begin', {
          sid: key,
          batchSize: payloads.length,
          oldestPendingAgeMs,
          throttleIntervalMs: APPLY_PAYLOAD_THROTTLE_MS,
        });
        for (const payload of payloads) {
          renderSeq += 1;
          state.sessionRenderSeq = renderSeq;
          const currentContext = state.currentRunContext && typeof state.currentRunContext === 'object'
            ? state.currentRunContext
            : null;
          const runViewRunId = state.runView && state.runView.runId ? String(state.runView.runId) : String(runId);
          const minMessageTimeMs = Number(currentContext && currentContext.startedAtMs ? currentContext.startedAtMs : 0) || 0;
          snapshotState = applyPayloadToRunViewSnapshot(snapshotState, payload, renderSeq, {
            splitByLimit,
            maxLen: TG_MAX_LEN,
            runId: runViewRunId,
            minMessageTimeMs,
            isFinal: false,
            viewMode: state.verbose ? 'verbose' : 'normal',
            repoName: repo.name,
            queueLength: Array.isArray(state.queue) ? state.queue.length : 0,
          });
        }
        const next = snapshotState && snapshotState.renderState ? snapshotState.renderState : null;
        state.sessionRenderStates.set(key, snapshotState);
        state.latestSessionRenderState = snapshotState;
        syncTypingIndicator(!!(next && next.render && next.render.busy), 'session_snapshot');
        auditRun('run.session_event.apply.begin', {
          sid: key,
          renderSeq,
          hasExistingState: true,
          payloadType: payloads.length > 1 ? 'batch' : typeof payloads[0],
        });
        auditRun('run.session_event.apply.end', {
          sid: key,
          renderSeq,
          messageCount: Array.isArray(next && next.messages && next.messages.order) ? next.messages.order.length : 0,
          latestAssistantMessageId: next && next.render && next.render.latestAssistantMessageId
            ? next.render.latestAssistantMessageId
            : '',
          latestAssistantTextLength: String(next && next.render && next.render.latestAssistantText || '').length,
        });

        // Update lastFinalMessageRef for revert functionality
        if (next && next.render && next.render.latestAssistantMessageId) {
          lastFinalMessageRef.messageId = next.render.latestAssistantMessageId;
          // Try to get partId from the latest assistant message if available
          const messages = next.messages && next.messages.byId ? next.messages.byId : {};
          const latestId = next.render.latestAssistantMessageId;
          const latestMessage = messages[latestId];
          if (latestMessage && latestMessage.parts && latestMessage.parts.length > 0) {
            const lastPart = latestMessage.parts[latestMessage.parts.length - 1];
            if (lastPart && lastPart.id) {
              lastFinalMessageRef.partId = lastPart.id;
            }
          }
        }

        auditRun('run.session_event.apply.batch.end', {
          sid: key,
          batchSize: payloads.length,
          highestPriority: payloads.reduce((acc, item) => Math.max(acc, payloadThrottleRank(item)), 0),
        });
        const ownerSessionId = getActiveSessionOwner();
        if (!ownerSessionId || ownerSessionId !== key) {
          auditRun('run.session_event.apply.skip', {
            sid: key,
            ownerSessionId,
            reason: ownerSessionId ? 'stale_session_owner' : 'missing_active_session_owner',
            batchSize: payloads.length,
          });
          return;
        }
        const snapshot = snapshotState && snapshotState.snapshot ? snapshotState.snapshot : null;
        const snapshotMessages = snapshot && Array.isArray(snapshot.messages) ? snapshot.messages : [];
        const tailMaterializeHint = snapshot && snapshot.tailMaterializeHint && typeof snapshot.tailMaterializeHint === 'object'
          ? snapshot.tailMaterializeHint
          : null;
        await reconcileRunView(
          snapshotMessages,
          { isFinalState: false, tailMaterializeHint }
        );
        state.sessionProjectedTexts.set(key, snapshotMessages.slice());
      },
    });
    sessionApplyProcessors.set(key, created);
    return created;
  };

  const onDeliverSessionEvent = async ({ payload, sessionId, event }) => {
    if (!isCurrentRunOwner()) {
      auditRun('run.session_event.skip', {
        reason: 'stale_run_owner',
        sid: String(sessionId || ''),
        activeSessionId: getActiveSessionOwner(),
        ownerRunId: String((state.currentRunContext && state.currentRunContext.runId) || ''),
      });
      return;
    }
    const sid = String(sessionId || state.activeSessionId || activeSessionId || '').trim();
    if (!sid) {
      auditRun('run.session_event.skip', {
        reason: 'missing_session_id',
        activeSessionId: String(activeSessionId || ''),
      });
      return;
    }
    const source = String(event && event._gatewaySource ? event._gatewaySource : 'unknown');
    const eventType = String(event && event.type ? event.type : '');
    const eventCursor = Number(event && event.cursor ? event.cursor : 0) || 0;
    const eventSessionId = String(event && event.sessionId ? event.sessionId : '').trim();
    if (shouldTraceSessionDiagnostic(sid, eventSessionId, state.activeSessionId, activeSessionId)) {
      const payloadMeta = parsePayloadMeta(payload);
      auditRun('run.session_event.diagnostic', {
        sid,
        source,
        eventType,
        eventCursor,
        eventSessionId,
        activeSessionId: String(state.activeSessionId || activeSessionId || '').trim(),
        ...payloadMeta,
      });
    }
    const processor = getSessionApplyProcessor(sid);
    if (!processor) return;
    Promise.resolve(processor({ payload, enqueuedAt: Date.now() })).catch((err) => {
      auditRun('run.session_event.apply.error', {
        sid,
        reason: 'processor_enqueue_failed',
        error: String(err && (err.stack || err.message || err) || ''),
      });
    });
  };
  const handleSessionEvent = createSessionEventHandler({
    deliverPayload: sendRawTelegram,
    onDeliver: onDeliverSessionEvent,
  });

  const ensureSessionDelivery = async (candidateSessionId) => {
    const sid = String(candidateSessionId || '').trim();
    if (!sid || !RAW_EVENT_PASSTHROUGH) return;
    const current = state.sessionDelivery || null;
    if (
      current
      && String(current.chatId || '') === String(chatId)
      && String(current.sessionId || '') === sid
      && String(current.ownerRunId || '') === String(runId)
    ) {
      auditRun('run.session_delivery.reused', {
        sessionId: sid,
        chatId: String(chatId),
      });
      return;
    }

    await clearSessionDelivery(state);

    const sub = await subscribeSessionEvents(repo, sid, {
      replayBuffered: false,
      onEvent: async (evt) => {
        if (!isCurrentRunOwner()) {
          auditRun('run.session_event.skip', {
            reason: 'stale_run_owner',
            activeSessionId: getActiveSessionOwner(),
            eventSessionId: String((evt && evt.sessionId) || ''),
          });
          return;
        }
        const eventForRouter = {
          ...(evt && typeof evt === 'object' ? evt : {}),
          _gatewaySource: 'session_delivery',
        };
        if (shouldTraceSessionDiagnostic(
          eventForRouter.sessionId,
          state.activeSessionId,
          activeSessionId,
          sid
        )) {
          auditRun('run.session_event.ingress', {
            source: 'session_delivery',
            eventType: String(eventForRouter.type || ''),
            eventCursor: Number(eventForRouter.cursor || 0) || 0,
            eventSessionId: String(eventForRouter.sessionId || ''),
            activeSessionId: String(state.activeSessionId || activeSessionId || ''),
          });
        }
        const routedResult = await handleSessionEvent({
          event: eventForRouter,
          activeSessionId: String(state.activeSessionId || activeSessionId || ''),
        });
        if (!routedResult.delivered) {
          auditRun('run.session_event.skip', {
            reason: routedResult.dropReason || 'router_rejected',
            activeSessionId: String(state.activeSessionId || activeSessionId || ''),
            eventSessionId: String((evt && evt.sessionId) || ''),
          });
        }
        if (routedResult.nextSessionId && routedResult.nextSessionId !== activeSessionId) {
          activeSessionId = routedResult.nextSessionId;
          state.activeSessionId = activeSessionId;
          if (state.runView && typeof state.runView === 'object') {
            state.runView.sessionId = String(activeSessionId || '').trim();
          }
          clearedRunRenderSessionId = clearRunRenderStateForAttachedSession(
            state,
            clearedRunRenderSessionId,
            activeSessionId
          );
          await ensureSessionDelivery(activeSessionId);
        }
      },
    });
    state.sessionDelivery = {
      chatId: String(chatId),
      sessionId: sid,
      ownerRunId: String(runId),
      unsubscribe: typeof sub.unsubscribe === 'function' ? sub.unsubscribe : async () => {},
    };
    auditRun('run.session_delivery.attached', {
      sessionId: sid,
      chatId: String(chatId),
    });
  };

  if (activeSessionId) {
    await ensureSessionDelivery(activeSessionId);
  }

  const proc = runOpencode(repo, promptText, {
    sessionId: activeSessionId,
    onEvent: async (evt) => {
      if (!isCurrentRunOwner()) {
        auditRun('run.event_ignored', {
          reason: 'stale_run_owner',
          eventSessionId: evt && evt.sessionId ? String(evt.sessionId) : null,
          ownerRunId: String((state.currentRunContext && state.currentRunContext.runId) || ''),
        });
        return;
      }
      eventOrdinal += 1;
      auditRun('run.event_received', {
        eventOrdinal,
        type: evt.type,
        textKind: evt.textKind || null,
        sessionId: evt.sessionId || activeSessionId || null,
        content: String(evt.content || ''),
        contentLength: String(evt.content || '').length,
        contentPreview: summarizeAuditText(evt.content || evt.name || ''),
        ...buildAuditContentMeta(evt.content || ''),
      });
      const upstreamBusySignal = readBusySignalFromSessionPayload(evt.content || '');
      if (upstreamBusySignal !== null) {
        syncTypingIndicator(upstreamBusySignal, upstreamBusySignal ? 'upstream_session_status' : 'upstream_session_idle');
      }
      runMetrics.upstreamEventCount += 1;
      const eventAtMs = Date.now() - runStartedAt;
      if (runMetrics.upstreamFirstEventAtMs === null) {
        runMetrics.upstreamFirstEventAtMs = eventAtMs;
      }
      runMetrics.upstreamLastEventAtMs = eventAtMs;

      if (RAW_EVENT_PASSTHROUGH) {
        if (evt.sessionId && String(evt.sessionId).trim() && String(evt.sessionId).trim() !== activeSessionId) {
          activeSessionId = String(evt.sessionId).trim();
          state.activeSessionId = activeSessionId;
          if (state.runView && typeof state.runView === 'object') {
            state.runView.sessionId = String(activeSessionId || '').trim();
          }
          clearedRunRenderSessionId = clearRunRenderStateForAttachedSession(
            state,
            clearedRunRenderSessionId,
            activeSessionId
          );
          if (state.currentRunContext && typeof state.currentRunContext === 'object') {
            state.currentRunContext.sessionId = activeSessionId;
          }
          await ensureSessionDelivery(activeSessionId);
        }
        const eventForRouter = {
          ...(evt && typeof evt === 'object' ? evt : {}),
          _gatewaySource: 'run_callback',
        };
        if (shouldTraceSessionDiagnostic(
          eventForRouter.sessionId,
          state.activeSessionId,
          activeSessionId
        )) {
          auditRun('run.session_event.ingress', {
            source: 'run_callback',
            eventType: String(eventForRouter.type || ''),
            eventCursor: Number(eventForRouter.cursor || 0) || 0,
            eventSessionId: String(eventForRouter.sessionId || ''),
            activeSessionId: String(state.activeSessionId || activeSessionId || ''),
          });
        }
        auditRun('run.session_event.skip', {
          reason: 'run_callback_passthrough_shadowed_by_session_delivery',
          activeSessionId: String(state.activeSessionId || activeSessionId || ''),
          eventSessionId: String((evt && evt.sessionId) || ''),
        });
        return;
      }
    },

    onDone: async (exitCode, timeoutMsg, meta) => {
      if (!isCurrentRunOwner()) {
        auditRun('run.completion.skip', {
          reason: 'stale_run_owner',
          exitCode,
          timeout: timeoutMsg || null,
        });
        return;
      }
      if (completionHandled) return;
      completionHandled = true;
      auditRun('run.completion.begin', {
        pendingReminder: true,
        pendingReasoning: true,
        outputSnapshot,
      });
      state.running = false;
      if (state.typingIndicator) state.typingIndicator.busy = false;
      clearTypingIndicatorTimer(state);
      clearInterruptEscalationTimer(state);
      state.interruptRequested = false;
      state.interruptTrace = null;
      state.waitingInfo = null;
      state.currentProc = null;
      state.panelRefresh = null;
      if (meta && meta.sessionId) activeSessionId = meta.sessionId;
      state.activeSessionId = activeSessionId;
      if (state.runView && typeof state.runView === 'object') {
        state.runView.sessionId = String(activeSessionId || '').trim();
      }
      clearedRunRenderSessionId = clearRunRenderStateForAttachedSession(
        state,
        clearedRunRenderSessionId,
        activeSessionId
      );
      if (state.currentRunContext && typeof state.currentRunContext === 'object') {
        state.currentRunContext.sessionId = String(activeSessionId || '').trim();
      }
      if (activeSessionId) {
        const deferredSessionId = String(activeSessionId || '').trim();
        enqueueDeferredRunStartTask(state, async () => {
          await ensureSessionDelivery(deferredSessionId);
        });
        enqueueDeferredRunStartTask(state, async () => {
          try {
            setSessionId(repo.name, chatId, deferredSessionId);
          } catch (e) {
            console.error(`[${repo.name}] failed to persist session id:`, e.message);
          }
        });
      }

      if (RAW_EVENT_PASSTHROUGH) {
        const finalSnapshotState = activeSessionId
          && state.sessionRenderStates instanceof Map
          ? state.sessionRenderStates.get(activeSessionId)
          : state.latestSessionRenderState;
        let finalSnapshotMessages = [];
        if (finalSnapshotState) {
          const finalSnapshot = finalSnapshotState.snapshot && typeof finalSnapshotState.snapshot === 'object'
            ? finalSnapshotState.snapshot
            : null;
          finalSnapshotMessages = finalSnapshot && Array.isArray(finalSnapshot.messages)
            ? finalSnapshot.messages
            : [];
          const deferredFinalSnapshotMessages = finalSnapshotMessages.slice();
          enqueueDeferredRunStartTask(state, async () => {
            await reconcileRunView(
              deferredFinalSnapshotMessages,
              { isFinalState: true }
            );
          });
        }
        if (!timeoutMsg && exitCode === 0 && !mermaidAttachmentDelivered) {
          const fallbackFinalText = String(
            outputSnapshot.canonicalFinal
            || outputSnapshot.finalSeen
            || outputSnapshot.finalText
            || outputSnapshot.finalCandidate
            || ''
          ).trim();
          const mermaidSourceSegments = finalSnapshotMessages.length > 0
            ? finalSnapshotMessages
            : (fallbackFinalText ? [fallbackFinalText] : []);
          const deferredMermaidSourceSegments = mermaidSourceSegments.slice();
          enqueueDeferredRunStartTask(state, async () => {
            const delivered = await sendMermaidArtifactsForRun({
              bot,
              repo,
              chatId,
              textSegments: deferredMermaidSourceSegments,
              runAuditMeta,
              revertTarget: activeSessionId && lastFinalMessageRef.messageId
                ? {
                  repoName: repo.name,
                  sessionId: activeSessionId,
                  messageId: lastFinalMessageRef.messageId,
                  partId: lastFinalMessageRef.partId,
                }
                : null,
            });
            if (delivered) {
              mermaidAttachmentDelivered = true;
            }
          });
        }
        await runDeferredRunStartTasks(state);
        auditRun('run.complete', {
          status: timeoutMsg ? 'timeout' : (exitCode === 0 ? 'done' : `exit ${exitCode}`),
          exitCode,
          timeout: timeoutMsg || null,
          queueRemaining: Array.isArray(state.queue) ? state.queue.length : 0,
          passthrough: true,
        });
        const completedAtMs = Date.now() - runStartedAt;
        const upstreamLastAtMs = runMetrics.upstreamLastEventAtMs;
        const downstreamLastAtMs = runMetrics.downstreamLastApplyAtMs;
        auditRun('run.metrics.summary', {
          runStartedAtMs,
          runCompletedAtMs: Date.now(),
          runDurationMs: completedAtMs,
          upstreamEventCount: runMetrics.upstreamEventCount,
          upstreamFirstEventAtMs: runMetrics.upstreamFirstEventAtMs,
          upstreamLastEventAtMs: upstreamLastAtMs,
          downstreamApplyRequested: runMetrics.downstreamApplyRequested,
          downstreamApplyExecuted: runMetrics.downstreamApplyExecuted,
          downstreamFirstApplyAtMs: runMetrics.downstreamFirstApplyAtMs,
          downstreamLastApplyAtMs: downstreamLastAtMs,
          downstreamCommandCount: runMetrics.downstreamCommandCount,
          downstreamSendCount: runMetrics.downstreamSendCount,
          downstreamEditCount: runMetrics.downstreamEditCount,
          downstreamDeleteCount: runMetrics.downstreamDeleteCount,
          upstreamToDownstreamFirstMs: runMetrics.upstreamFirstEventAtMs === null || runMetrics.downstreamFirstApplyAtMs === null
            ? null
            : runMetrics.downstreamFirstApplyAtMs - runMetrics.upstreamFirstEventAtMs,
          upstreamToDownstreamLastMs: upstreamLastAtMs === null || downstreamLastAtMs === null
            ? null
            : downstreamLastAtMs - upstreamLastAtMs,
          downstreamWindowMs: runMetrics.downstreamFirstApplyAtMs === null || downstreamLastAtMs === null
            ? null
            : downstreamLastAtMs - runMetrics.downstreamFirstApplyAtMs,
        });
        if (Array.isArray(state.queue) && state.queue.length > 0) {
          const nextItem = state.queue.shift();
          await startPromptRun(bot, repo, state, nextItem);
        }
        return;
      }
    },

    onError: async (err) => {
      if (!isCurrentRunOwner()) {
        auditRun('run.error.skip', {
          reason: 'stale_run_owner',
          message: String(err && err.message ? err.message : err || ''),
        });
        return;
      }
      if (completionHandled) return;
      completionHandled = true;
      state.running = false;
      if (state.typingIndicator) state.typingIndicator.busy = false;
      clearTypingIndicatorTimer(state);
      clearInterruptEscalationTimer(state);
      state.interruptRequested = false;
      state.interruptTrace = null;
      state.waitingInfo = null;
      state.currentProc = null;
      state.panelRefresh = null;

      if (RAW_EVENT_PASSTHROUGH) {
        auditRun('run.error', {
          message: String(err && err.message ? err.message : err || ''),
          passthrough: true,
        });
        if (Array.isArray(state.queue) && state.queue.length > 0) {
          const nextItem = state.queue.shift();
          await startPromptRun(bot, repo, state, nextItem);
        }
        return;
      }
    },
  });

  state.currentProc = proc;
}

const handleRepoMessage = createRepoMessageHandler({
  parseCommand,
  safeSend,
  buildRuntimeStatusHtml,
  buildStatusKeyboard,
  handleModelsCommand,
  getSessionInfo,
  SESSION_MAP_PATH,
  clearSessionId,
  clearSessionDelivery,
  endSessionLifecycle,
  handleRestartCommand,
  getHelpText,
  sendTelegramFormattingShowcase,
  sendRepoList,
  handleVerboseAction,
  requestInterrupt,
  buildPromptFromMessage,
  startPromptRun,
  resolveRevertReplyTarget,
  createRevertConfirmation,
  executeSessionUnrevert,
});

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
    waitingInfo: null,
    queue: [],
    deferredRunStartTasks: [],
    panelRefresh: null,
    sessionDelivery: null,
    sessionRenderStates: new Map(),
    sessionRenderSeq: 0,
    latestSessionRenderState: null,
    activeSessionId: '',
    currentRunContext: null,
    runView: null,
    typingIndicator: null,
    sessionProjectedTexts: new Map(),
    dispatchQueue: Promise.resolve(),
    runViewDispatchQueue: Promise.resolve(),
  }]));
  const onboardingSessions = new Map();
  const initSessions = new Map();
  const modelUiState = new Map();
  const modelControlService = createModelControlService({
    modelUiState,
    buildModelsSummaryHtml,
    buildModelsRootKeyboard,
    getProviderModelChoices,
    getModelsSnapshot,
    buildProviderPickerKeyboard,
    buildAgentPickerKeyboard,
    buildModelPickerKeyboard,
    escapeHtml,
    readJsonOrDefault,
    writeJsonAtomic,
    OPENCODE_CONFIG_PATH,
    OMO_CONFIG_PATH,
    getOmoAgentEntry,
  });
  const modelCommandService = createModelCommandService({
    buildModelsSummaryHtml,
    buildModelsRootKeyboard,
    buildModelApplyMessage,
    readJsonOrDefault,
    writeJsonAtomic,
    isValidModelRef,
    getOmoAgentEntry,
    OPENCODE_CONFIG_PATH,
    OMO_CONFIG_PATH,
  });
  const telegramBaseApiUrl = String(process.env.HERMUX_TELEGRAM_BASE_API_URL || '').trim();
  const telegramPollingTimeout = Number(process.env.HERMUX_TELEGRAM_POLLING_TIMEOUT_SECONDS || 0) || 0;
  const bot = new TelegramBot(botToken, {
    polling: {
      timeout: telegramPollingTimeout,
    },
    ...(telegramBaseApiUrl ? { baseApiUrl: telegramBaseApiUrl } : {}),
  });
  const restartNotice = readAndClearRestartNotice();
  const handleMessage = createMessageHandler({
    bot,
    chatRouter,
    states,
    onboardingSessions,
    initSessions,
    parseCommand,
    handleOnboardCommand,
    handleInitCommand,
    handleOnboardingInput,
    safeSend,
    getHelpText,
    sendTelegramFormattingShowcase,
    sendRepoList,
    handleConnectCommand,
    withStateDispatchLock,
    handleRepoMessage,
  });
  const handleCallbackQuery = createCallbackQueryHandler({
    bot,
    chatRouter,
    states,
    modelUiState,
    modelControlService,
    safeSend,
    handleConnectCommand,
    handleVerboseAction,
    requestInterrupt,
    handleRevertConfirmCallback,
    handleRevertCancelCallback,
  });

  console.log(`polling with 1 bot for ${repos.length} repo(s), ${chatRouter.size} chat id(s)`);

  bot.setMyCommands([
    { command: 'onboard', description: 'Run chat onboarding wizard' },
    { command: 'init', description: 'Initialize by clearing mappings/sessions' },
    { command: 'start', description: 'Show mapped repo info' },
    { command: 'repos', description: 'List repos and how to connect' },
    { command: 'connect', description: 'Connect this chat to a repo' },
    { command: 'status', description: 'Show current runtime status' },
    { command: 'models', description: 'Manage opencode/omo model layers' },
    { command: 'session', description: 'Show current opencode session' },
    { command: 'version', description: 'Show opencode and hermux version' },
    { command: 'revert', description: 'Reply to output and revert (confirm)' },
    { command: 'unrevert', description: 'Undo latest revert if still available' },
    { command: 'test', description: 'Send Telegram formatting showcase' },
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

  const processedMessageIds = new Map();
  const MAX_PROCESSED_IDS = 1000;
  const MESSAGE_DEDUP_TTL_MS = 5 * 60 * 1000;

  setInterval(() => {
    processedMessageIds.clear();
  }, MESSAGE_DEDUP_TTL_MS);

  bot.on('message', async (msg) => {
    const chatId = msg && msg.chat && msg.chat.id ? String(msg.chat.id) : null;
    const messageId = msg && msg.message_id;
    if (messageId && chatId) {
      if (!processedMessageIds.has(chatId)) {
        processedMessageIds.set(chatId, new Set());
      }
      const chatProcessedIds = processedMessageIds.get(chatId);
      if (chatProcessedIds.has(messageId)) {
        audit('telegram.message.duplicate', {
          chatId,
          messageId,
          textPreview: summarizeAuditText(msg && msg.text ? msg.text : ''),
        });
        return;
      }
      chatProcessedIds.add(messageId);
      if (chatProcessedIds.size > MAX_PROCESSED_IDS) {
        const firstId = chatProcessedIds.values().next().value;
        chatProcessedIds.delete(firstId);
      }
    }
    audit('telegram.update', {
      updateType: 'message',
      chatId: msg && msg.chat && msg.chat.id ? String(msg.chat.id) : '',
      messageId: msg && msg.message_id ? msg.message_id : null,
      replyMessageId: msg && msg.reply_to_message && msg.reply_to_message.message_id
        ? msg.reply_to_message.message_id
        : null,
      textPreview: summarizeAuditText(msg && msg.text ? msg.text : ''),
    });
    await handleMessage(msg);
  });
  bot.on('callback_query', async (cq) => {
    audit('telegram.update', {
      updateType: 'callback_query',
      chatId: cq && cq.message && cq.message.chat && cq.message.chat.id ? String(cq.message.chat.id) : '',
      callbackData: summarizeAuditText(cq && cq.data ? cq.data : ''),
      callbackId: cq && cq.id ? String(cq.id) : '',
    });
    await handleCallbackQuery(cq);
  });

  bot.on('polling_error', (err) => {
    const detail = serializePollingError(err);
    console.error('[bot] polling error detail:', JSON.stringify(detail));
  });

  const shutdown = async () => {
    console.log('\nshutting down...');
    try {
      await bot.stopPolling();
    } catch (_err) {
    }
    try {
      await stopAllRuntimeExecutors();
    } catch (err) {
      console.error('[shutdown] failed to stop runtime executors:', err.message);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown();
  });
  process.on('SIGTERM', () => {
    shutdown();
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  _internal: {
    parseCommand,
    normalizeOnboardingWorkdirInput,
    splitByLimit,
    buildNoOutputMessage,
    appendHermuxVersion,
    extractLatestSystemReminder,
    splitByOmoInitiatorMarker,
    formatSystemReminderForDisplay,
    sanitizeFinalOutputText,
    createOutputSnapshot,
    reconcileOutputSnapshot,
    selectFinalOutputText,
    resolveFinalizationOutput,
    buildStreamingStatusHtml,
    buildLiveStatusPanelHtml,
    extractMermaidBlocks,
    collectMermaidBlocksFromTextSegments,
    withRestartMutationLock,
    withStateDispatchLock,
    withRunViewDispatchLock,
    sendInterruptSignal,
    requestInterrupt,
    clearInterruptEscalationTimer,
    serializePollingError,
    isValidModelRef,
    buildModelApplyMessage,
    buildTelegramFormattingShowcase,
    buildConnectKeyboard,
    buildVerboseKeyboard,
    buildModelsRootKeyboard,
    buildAgentPickerKeyboard,
    buildProviderPickerKeyboard,
    buildModelPickerKeyboard,
    buildStatusKeyboard,
    buildRuntimeStatusHtml,
    buildModelsSummaryHtml,
    getReplyContext,
    normalizeImageExt,
    getImagePayloadFromMessage,
    formatRepoList,
    handleConnectCommand,
    registerRevertTargetFromSentMessage,
    resolveRevertReplyTarget,
    resetRevertTargetStoreForTest,
    REVERT_TARGETS_PATH,
    parseRawEventContent,
    formatRawEventPreview,
    resolveRawDeliveryPlan,
    clearRunRenderStateAtRunStart,
    clearRunRenderStateForAttachedSession,
    createTrailingThrottleProcessor,
    buildAuditContentMeta,
    shouldDeferRunViewRetryAfter,
    clearTypingIndicatorTimer,
    shouldRenewTypingIndicator,
    readBusySignalFromSessionPayload,
  },
};
