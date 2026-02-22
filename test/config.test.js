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

test('config addChatIdToRepo validates input and repo existence', () => {
  const snapshot = backupFile(config.CONFIG_PATH);
  try {
    config.save({
      global: { telegramBotToken: '1:abc' },
      repos: [{ name: 'repo-a', enabled: true, workdir: '/tmp/a', chatIds: [], opencodeCommand: 'opencode serve', logFile: './logs/a.log' }],
    });

    const badRepo = config.addChatIdToRepo('', '100');
    assert.equal(badRepo.ok, false);
    assert.equal(badRepo.reason, 'invalid_repo');

    const badChat = config.addChatIdToRepo('repo-a', 'not-number');
    assert.equal(badChat.ok, false);
    assert.equal(badChat.reason, 'invalid_chat_id');

    const missingRepo = config.addChatIdToRepo('repo-missing', '100');
    assert.equal(missingRepo.ok, false);
    assert.equal(missingRepo.reason, 'repo_not_found');
  } finally {
    restoreFile(config.CONFIG_PATH, snapshot);
  }
});

test('config addChatIdToRepo returns changed false when mapping already exists in same repo', () => {
  const snapshot = backupFile(config.CONFIG_PATH);
  try {
    config.save({
      global: { telegramBotToken: '1:abc' },
      repos: [{ name: 'repo-a', enabled: true, workdir: '/tmp/a', chatIds: ['100'], opencodeCommand: 'opencode serve', logFile: './logs/a.log' }],
    });

    const result = config.addChatIdToRepo('repo-a', '100');
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(result.repo.name, 'repo-a');
  } finally {
    restoreFile(config.CONFIG_PATH, snapshot);
  }
});

test('config getEnabledRepos returns only enabled repos', () => {
  const snapshot = backupFile(config.CONFIG_PATH);
  try {
    config.save({
      global: { telegramBotToken: '1:abc' },
      repos: [
        { name: 'repo-on', enabled: true, workdir: '/tmp/on', chatIds: [], opencodeCommand: 'opencode serve', logFile: './logs/on.log' },
        { name: 'repo-off', enabled: false, workdir: '/tmp/off', chatIds: [], opencodeCommand: 'opencode serve', logFile: './logs/off.log' },
      ],
    });

    const enabled = config.getEnabledRepos();
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0].name, 'repo-on');
  } finally {
    restoreFile(config.CONFIG_PATH, snapshot);
  }
});

test('config resetConfig respects keepToken option', () => {
  const snapshot = backupFile(config.CONFIG_PATH);
  try {
    config.save({
      global: { telegramBotToken: '1:abc' },
      repos: [{ name: 'repo-a', enabled: true, workdir: '/tmp/a', chatIds: [], opencodeCommand: 'opencode serve', logFile: './logs/a.log' }],
    });

    const kept = config.resetConfig({ keepToken: true });
    assert.equal(kept.keepToken, true);
    assert.equal(kept.hadToken, true);
    assert.equal(kept.clearedRepos, 1);
    assert.equal(config.load().global.telegramBotToken, '1:abc');

    config.save({
      global: { telegramBotToken: '1:abc' },
      repos: [{ name: 'repo-b', enabled: true, workdir: '/tmp/b', chatIds: [], opencodeCommand: 'opencode serve', logFile: './logs/b.log' }],
    });
    const cleared = config.resetConfig({ keepToken: false });
    assert.equal(cleared.keepToken, false);
    assert.equal(cleared.hadToken, true);
    assert.equal(cleared.clearedRepos, 1);
    assert.equal(config.load().global.telegramBotToken, '');
  } finally {
    restoreFile(config.CONFIG_PATH, snapshot);
  }
});
