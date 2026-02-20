const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/lib/config');

const SNAPSHOT = Symbol('config-snapshot');

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

test('config addOrUpdateRepo upserts and deduplicates chat ids', () => {
  const snapshot = backupFile(config.CONFIG_PATH);
  try {
    config.save({ global: { telegramBotToken: '1:abc' }, repos: [] });

    config.addOrUpdateRepo({
      name: 'repo-a',
      enabled: true,
      workdir: '/tmp/repo-a',
      chatIds: ['1', '1', '2'],
      opencodeCommand: 'opencode run',
      logFile: './logs/repo-a.log',
    });

    config.addOrUpdateRepo({
      name: 'repo-a',
      enabled: true,
      workdir: '/tmp/repo-a-next',
      chatIds: ['2', '3'],
      opencodeCommand: 'opencode run --fast',
      logFile: './logs/repo-a-next.log',
    });

    const loaded = config.load();
    assert.equal(loaded.repos.length, 1);
    assert.equal(loaded.repos[0].workdir, '/tmp/repo-a-next');
    assert.deepEqual(loaded.repos[0].chatIds, ['2', '3']);
  } finally {
    restoreFile(config.CONFIG_PATH, snapshot);
  }
});

test('config addChatIdToRepo rejects cross-repo duplicate mapping', () => {
  const snapshot = backupFile(config.CONFIG_PATH);
  try {
    config.save({
      global: { telegramBotToken: '1:abc' },
      repos: [
        {
          name: 'repo-a', enabled: true, workdir: '/tmp/a', chatIds: ['100'], opencodeCommand: 'opencode run', logFile: './logs/a.log',
        },
        {
          name: 'repo-b', enabled: true, workdir: '/tmp/b', chatIds: [], opencodeCommand: 'opencode run', logFile: './logs/b.log',
        },
      ],
    });

    const result = config.addChatIdToRepo('repo-b', '100');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'chat_already_mapped');
    assert.equal(result.existingRepo, 'repo-a');
  } finally {
    restoreFile(config.CONFIG_PATH, snapshot);
  }
});
