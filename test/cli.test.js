const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/lib/config');
const sessionMap = require('../src/lib/session-map');

const cliPath = path.resolve(__dirname, '..', 'src', 'cli.js');
const runtimeDir = path.resolve(__dirname, '..', 'runtime');
const pidPath = path.join(runtimeDir, 'gateway.pid');

const SNAPSHOT = Symbol('missing');

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

test('cli help exits with code 0 and prints usage', () => {
  const out = spawnSync(process.execPath, [cliPath, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, OMG_DAEMON_CHILD: '' },
  });

  assert.equal(out.status, 0);
  assert.match(out.stdout, /Usage:/);
  assert.match(out.stdout, /hermux start/);
});

test('cli unknown command exits with code 1', () => {
  const out = spawnSync(process.execPath, [cliPath, 'unknown-command'], {
    encoding: 'utf8',
  });

  assert.equal(out.status, 1);
  assert.match(out.stderr, /Unknown command/);
});

test('cli init without --yes prints confirmation hint and keeps data', () => {
  const configSnapshot = backupFile(config.CONFIG_PATH);
  const sessionSnapshot = backupFile(sessionMap.SESSION_MAP_PATH);
  try {
    config.save({
      global: { telegramBotToken: '123:abc' },
      repos: [{ name: 'demo', enabled: true, workdir: '/tmp/demo', chatIds: ['1'], opencodeCommand: 'opencode sdk', logFile: './logs/demo.log' }],
    });
    sessionMap.setSessionId('demo', '1', 'sess-1');

    const out = spawnSync(process.execPath, [cliPath, 'init'], { encoding: 'utf8' });
    assert.equal(out.status, 0);
    assert.match(out.stdout, /Run with confirmation: hermux init --yes/);

    const loaded = config.load();
    assert.equal(loaded.repos.length, 1);
    assert.equal(sessionMap.getSessionId('demo', '1'), 'sess-1');
  } finally {
    restoreFile(config.CONFIG_PATH, configSnapshot);
    restoreFile(sessionMap.SESSION_MAP_PATH, sessionSnapshot);
  }
});

test('cli init --yes --full clears repos, sessions, and global token', () => {
  const configSnapshot = backupFile(config.CONFIG_PATH);
  const sessionSnapshot = backupFile(sessionMap.SESSION_MAP_PATH);
  try {
    config.save({
      global: { telegramBotToken: '123:abc' },
      repos: [{ name: 'demo', enabled: true, workdir: '/tmp/demo', chatIds: ['1'], opencodeCommand: 'opencode sdk', logFile: './logs/demo.log' }],
    });
    sessionMap.setSessionId('demo', '1', 'sess-1');

    const out = spawnSync(process.execPath, [cliPath, 'init', '--yes', '--full'], { encoding: 'utf8' });
    assert.equal(out.status, 0);
    assert.match(out.stdout, /Gateway initialization complete/);
    assert.match(out.stdout, /global telegram bot token cleared: yes/);

    const loaded = config.load();
    assert.equal(loaded.repos.length, 0);
    assert.equal(String((loaded.global || {}).telegramBotToken || ''), '');
    assert.equal(sessionMap.getSessionId('demo', '1'), '');
  } finally {
    restoreFile(config.CONFIG_PATH, configSnapshot);
    restoreFile(sessionMap.SESSION_MAP_PATH, sessionSnapshot);
  }
});

test('cli start --foreground runs gateway main path without daemonize', () => {
  const configSnapshot = backupFile(config.CONFIG_PATH);
  try {
    config.save({ global: { telegramBotToken: '' }, repos: [] });
    const out = spawnSync(process.execPath, [cliPath, 'start', '--foreground'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OMG_SKIP_DEP_BOOTSTRAP: '1',
      },
    });

    assert.equal(out.status, 0);
    assert.match(out.stdout, /No global telegramBotToken configured/);
  } finally {
    restoreFile(config.CONFIG_PATH, configSnapshot);
  }
});

test('cli start in daemon mode does not spawn when pid is already alive', () => {
  const pidSnapshot = backupFile(pidPath);
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(pidPath, `${process.pid}\n`, 'utf8');

    const out = spawnSync(process.execPath, [cliPath, 'start'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OMG_DAEMON_CHILD: '',
      },
    });
    assert.equal(out.status, 0);
    assert.match(out.stdout, /Gateway daemon already running/);
  } finally {
    restoreFile(pidPath, pidSnapshot);
  }
});
