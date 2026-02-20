'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'instances.json');

function asUniqueStringArray(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const val of values) {
    const s = String(val || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function normalizeRepo(repo) {
  return {
    name: String(repo.name || '').trim(),
    enabled: repo.enabled !== false,
    workdir: String(repo.workdir || '').trim(),
    chatIds: asUniqueStringArray(repo.chatIds),
    opencodeCommand: String(repo.opencodeCommand || 'opencode run').trim() || 'opencode run',
    logFile: String(repo.logFile || '').trim(),
  };
}

function normalizeFromLegacy(raw) {
  const instances = Array.isArray(raw.instances) ? raw.instances : [];
  const legacyToken = instances
    .map(i => String(i.telegramBotToken || '').trim())
    .find(Boolean) || '';

  const repos = instances.map((instance) => {
    const legacyChat = String(instance.allowedChatId || '').trim();
    const normalized = normalizeRepo({
      name: instance.name,
      enabled: instance.enabled,
      workdir: instance.workdir,
      chatIds: legacyChat ? [legacyChat] : [],
      opencodeCommand: instance.opencodeCommand,
      logFile: instance.logFile,
    });

    if (!normalized.logFile && normalized.name) {
      normalized.logFile = `./logs/${normalized.name}.log`;
    }
    return normalized;
  });

  return {
    global: {
      telegramBotToken: legacyToken,
    },
    repos,
  };
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') {
    return { global: { telegramBotToken: '' }, repos: [] };
  }

  if (Array.isArray(raw.repos)) {
    const globalToken = raw.global && typeof raw.global === 'object'
      ? String(raw.global.telegramBotToken || '').trim()
      : '';
    const repos = raw.repos.map(normalizeRepo).filter(repo => repo.name);
    return {
      global: { telegramBotToken: globalToken },
      repos,
    };
  }

  return normalizeFromLegacy(raw);
}

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { global: { telegramBotToken: '' }, repos: [] };
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return normalize(raw);
}

function save(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const normalized = normalize(config);
  const tempPath = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  fs.renameSync(tempPath, CONFIG_PATH);
}

function setGlobalBotToken(token) {
  const config = load();
  config.global.telegramBotToken = String(token || '').trim();
  save(config);
  return config;
}

function addOrUpdateRepo(repo) {
  const config = load();
  const normalized = normalizeRepo(repo);
  const idx = config.repos.findIndex(i => i.name === normalized.name);
  if (idx >= 0) {
    config.repos[idx] = normalized;
  } else {
    config.repos.push(normalized);
  }
  save(config);
  return config;
}

function addChatIdToRepo(repoName, chatId) {
  const config = load();
  const targetName = String(repoName || '').trim();
  const targetChatId = String(chatId || '').trim();

  if (!targetName) {
    return { ok: false, reason: 'invalid_repo' };
  }

  if (!/^-?\d+$/.test(targetChatId)) {
    return { ok: false, reason: 'invalid_chat_id' };
  }

  const repo = config.repos.find((r) => r.name === targetName);
  if (!repo) {
    return { ok: false, reason: 'repo_not_found' };
  }

  const existingRepo = config.repos.find((r) => {
    return Array.isArray(r.chatIds) && r.chatIds.includes(targetChatId);
  });

  if (existingRepo && existingRepo.name !== repo.name) {
    return { ok: false, reason: 'chat_already_mapped', existingRepo: existingRepo.name };
  }

  if (!Array.isArray(repo.chatIds)) {
    repo.chatIds = [];
  }

  if (!repo.chatIds.includes(targetChatId)) {
    repo.chatIds.push(targetChatId);
    save(config);
    return { ok: true, changed: true, repo: normalizeRepo(repo) };
  }

  return { ok: true, changed: false, repo: normalizeRepo(repo) };
}

function getEnabledRepos() {
  return load().repos.filter(i => i.enabled);
}

function resetConfig(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const keepToken = opts.keepToken !== false;
  const current = load();
  const next = {
    global: {
      telegramBotToken: keepToken ? String((current.global || {}).telegramBotToken || '').trim() : '',
    },
    repos: [],
  };
  save(next);
  return {
    keepToken,
    hadToken: !!String((current.global || {}).telegramBotToken || '').trim(),
    clearedRepos: Array.isArray(current.repos) ? current.repos.length : 0,
  };
}

module.exports = {
  load,
  save,
  setGlobalBotToken,
  addOrUpdateRepo,
  addChatIdToRepo,
  getEnabledRepos,
  resetConfig,
  CONFIG_PATH,
};
