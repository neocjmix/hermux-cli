// @ts-check
'use strict';

// Skeleton: see docs/COMPONENT_CONTRACTS.md § session-map

const path = require('path');

const SESSION_MAP_PATH = path.join(
  process.env.HERMUX_DATA_DIR || path.join(require('os').homedir(), '.hermux'),
  'sessions.json',
);

function makeSessionKey(repoName, chatId) { throw new Error('NOT_IMPLEMENTED: makeSessionKey'); }
function loadSessionMap() { throw new Error('NOT_IMPLEMENTED: loadSessionMap'); }
function saveSessionMap(data) { throw new Error('NOT_IMPLEMENTED: saveSessionMap'); }
function getSessionId(repoName, chatId) { throw new Error('NOT_IMPLEMENTED: getSessionId'); }
function setSessionId(repoName, chatId, sessionId) { throw new Error('NOT_IMPLEMENTED: setSessionId'); }
function clearSessionId(repoName, chatId) { throw new Error('NOT_IMPLEMENTED: clearSessionId'); }
function getSessionInfo(repoName, chatId) { throw new Error('NOT_IMPLEMENTED: getSessionInfo'); }
function clearAllSessions() { throw new Error('NOT_IMPLEMENTED: clearAllSessions'); }

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
