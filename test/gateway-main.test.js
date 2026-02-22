const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const config = require('../src/lib/config');

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

test('gateway main exits early with setup guidance when global token is missing', () => {
  const snapshot = backupFile(config.CONFIG_PATH);
  try {
    config.save({ global: { telegramBotToken: '' }, repos: [] });

    const out = spawnSync(process.execPath, ['src/gateway.js'], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    });

    assert.equal(out.status, 0);
    assert.match(out.stdout, /No global telegramBotToken configured/);
    assert.match(out.stdout, /Run: hermux onboard/);
  } finally {
    restoreFile(config.CONFIG_PATH, snapshot);
  }
});
