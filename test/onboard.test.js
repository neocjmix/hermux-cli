const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

test('onboard CLI fails fast on invalid token format', () => {
  const snapshot = backupFile(config.CONFIG_PATH);
  const tempWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermux-onboard-fail-'));

  try {
    config.save({ global: { telegramBotToken: '' }, repos: [] });

    const input = [
      'bad-token',
      'repo_test',
      '',
      tempWorkdir,
      'opencode run',
      '',
    ].join('\n');

    const out = spawnSync(process.execPath, ['src/onboard.js'], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      input,
    });

    assert.equal(out.status, 1);
    assert.match(out.stderr, /bot token: expected format/i);
    const loaded = config.load();
    assert.equal(loaded.repos.length, 0);
  } finally {
    restoreFile(config.CONFIG_PATH, snapshot);
    fs.rmSync(tempWorkdir, { recursive: true, force: true });
  }
});
