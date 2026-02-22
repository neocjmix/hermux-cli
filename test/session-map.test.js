const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sessions = require('../src/lib/session-map');

const SNAPSHOT = Symbol('session-snapshot');

function backupFile(filePath) {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  return SNAPSHOT;
}

function restoreFile(filePath, snapshot) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (snapshot === SNAPSHOT) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }
  fs.writeFileSync(filePath, snapshot, 'utf8');
}

test('session map set/get/clear lifecycle', () => {
  const snapshot = backupFile(sessions.SESSION_MAP_PATH);
  try {
    sessions.saveSessionMap({ sessions: {} });
    const row = sessions.setSessionId('repo-a', '100', 'sess-1');
    assert.equal(row.sessionId, 'sess-1');
    assert.equal(sessions.getSessionId('repo-a', '100'), 'sess-1');

    const info = sessions.getSessionInfo('repo-a', '100');
    assert.equal(info.repoName, 'repo-a');
    assert.equal(info.chatId, '100');

    assert.equal(sessions.clearSessionId('repo-a', '100'), true);
    assert.equal(sessions.getSessionId('repo-a', '100'), '');
  } finally {
    restoreFile(sessions.SESSION_MAP_PATH, snapshot);
  }
});

test('session map clearSessionId is idempotent for missing key', () => {
  const snapshot = backupFile(sessions.SESSION_MAP_PATH);
  try {
    sessions.saveSessionMap({ sessions: {} });

    assert.equal(sessions.clearSessionId('repo-missing', '404'), false);
    assert.equal(sessions.getSessionId('repo-missing', '404'), '');
  } finally {
    restoreFile(sessions.SESSION_MAP_PATH, snapshot);
  }
});

test('session map clearAllSessions returns count and keeps empty map stable', () => {
  const snapshot = backupFile(sessions.SESSION_MAP_PATH);
  try {
    sessions.saveSessionMap({ sessions: {} });
    assert.equal(sessions.clearAllSessions(), 0);

    sessions.setSessionId('repo-a', '100', 'sess-1');
    sessions.setSessionId('repo-b', '200', 'sess-2');
    assert.equal(sessions.clearAllSessions(), 2);
    assert.equal(sessions.getSessionId('repo-a', '100'), '');
    assert.equal(sessions.getSessionId('repo-b', '200'), '');

    assert.equal(sessions.clearAllSessions(), 0);
  } finally {
    restoreFile(sessions.SESSION_MAP_PATH, snapshot);
  }
});
