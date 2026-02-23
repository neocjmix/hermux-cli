'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STATE_DIR = path.join(__dirname, '..', '..', 'state');
const STATE_DIR = path.resolve(process.env.OMG_STATE_DIR || DEFAULT_STATE_DIR);
const SESSION_MAP_PATH = path.resolve(process.env.OMG_SESSION_MAP_PATH || path.join(STATE_DIR, 'session-map.json'));

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
  map.sessions[key] = {
    sessionId: String(sessionId || '').trim(),
    updatedAt: new Date().toISOString(),
    repoName: String(repoName || '').trim(),
    chatId: String(chatId || '').trim(),
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
  clearAllSessions,
};
