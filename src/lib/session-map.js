'use strict';

const fs = require('fs');
const path = require('path');

const TEST_PROFILE_ENABLED = String(process.env.HERMUX_TEST_PROFILE || '').trim() === '1'
  || process.argv.includes('--test');
const TEST_PROFILE_ROOT = path.resolve(
  process.env.HERMUX_TEST_PROFILE_ROOT
    || path.join(__dirname, '..', '..', '.tmp', 'test-profile', `p-${process.pid}`)
);
const DEFAULT_STATE_DIR = TEST_PROFILE_ENABLED
  ? path.join(TEST_PROFILE_ROOT, 'state')
  : path.join(__dirname, '..', '..', 'state');
const STATE_DIR = path.resolve(process.env.HERMUX_STATE_DIR || DEFAULT_STATE_DIR);
const SESSION_MAP_PATH = path.resolve(process.env.HERMUX_SESSION_MAP_PATH || path.join(STATE_DIR, 'session-map.json'));

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return { sessions: {} };
  const sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
  return { sessions };
}

function loadSessionMap() {
  if (!fs.existsSync(SESSION_MAP_PATH)) return { sessions: {} };
  const raw = JSON.parse(fs.readFileSync(SESSION_MAP_PATH, 'utf8'));
  return normalize(raw);
}

function saveSessionMap(data) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const normalized = normalize(data);
  const tempPath = SESSION_MAP_PATH + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  fs.renameSync(tempPath, SESSION_MAP_PATH);
}

function makeSessionKey(repoName, chatId) {
  return `${String(repoName || '').trim()}::${String(chatId || '').trim()}`;
}

function getSessionId(repoName, chatId) {
  const key = makeSessionKey(repoName, chatId);
  const map = loadSessionMap();
  const row = map.sessions[key];
  return row && row.sessionId ? String(row.sessionId) : '';
}

function setSessionId(repoName, chatId, sessionId) {
  const key = makeSessionKey(repoName, chatId);
  const map = loadSessionMap();
  const sid = String(sessionId || '').trim();
  const current = map.sessions[key] && typeof map.sessions[key] === 'object'
    ? map.sessions[key]
    : null;
  const currentWarnedSessionId = String((current && current.continuityWarningSessionId) || '').trim();
  map.sessions[key] = {
    sessionId: sid,
    updatedAt: new Date().toISOString(),
    repoName: String(repoName || '').trim(),
    chatId: String(chatId || '').trim(),
    continuityWarningSessionId: currentWarnedSessionId === sid ? sid : '',
    continuityWarningShownAt: currentWarnedSessionId === sid
      ? String((current && current.continuityWarningShownAt) || '').trim()
      : '',
  };
  saveSessionMap(map);
  return map.sessions[key];
}

function clearSessionId(repoName, chatId) {
  const key = makeSessionKey(repoName, chatId);
  const map = loadSessionMap();
  if (map.sessions[key]) {
    delete map.sessions[key];
    saveSessionMap(map);
    return true;
  }
  return false;
}

function getSessionInfo(repoName, chatId) {
  const key = makeSessionKey(repoName, chatId);
  const map = loadSessionMap();
  return map.sessions[key] || null;
}

function hasShownContinuityWarning(repoName, chatId, sessionId) {
  const info = getSessionInfo(repoName, chatId);
  const sid = String(sessionId || '').trim();
  if (!info || !sid) return false;
  return String(info.continuityWarningSessionId || '').trim() === sid;
}

function markContinuityWarningShown(repoName, chatId, sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  const key = makeSessionKey(repoName, chatId);
  const map = loadSessionMap();
  const current = map.sessions[key] && typeof map.sessions[key] === 'object'
    ? map.sessions[key]
    : {};
  map.sessions[key] = {
    ...current,
    sessionId: String(current.sessionId || '').trim() || sid,
    updatedAt: new Date().toISOString(),
    repoName: String(repoName || '').trim(),
    chatId: String(chatId || '').trim(),
    continuityWarningSessionId: sid,
    continuityWarningShownAt: new Date().toISOString(),
  };
  saveSessionMap(map);
  return map.sessions[key];
}

function clearAllSessions() {
  const current = loadSessionMap();
  const count = Object.keys(current.sessions || {}).length;
  saveSessionMap({ sessions: {} });
  return count;
}

module.exports = {
  SESSION_MAP_PATH,
  makeSessionKey,
  loadSessionMap,
  saveSessionMap,
  getSessionId,
  setSessionId,
  clearSessionId,
  getSessionInfo,
  hasShownContinuityWarning,
  markContinuityWarningShown,
  clearAllSessions,
};
