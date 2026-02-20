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
