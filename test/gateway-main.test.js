const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

require('./helpers/test-profile');

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

test('gateway main function is exported and callable', () => {
  const { main } = require('../src/gateway');
  assert.equal(typeof main, 'function');
});

test('gateway main exports _internal with essential contract functions', () => {
  const { _internal: gi } = require('../src/gateway');

  // Concurrency contracts
  assert.equal(typeof gi.withStateDispatchLock, 'function');
  assert.equal(typeof gi.withRunViewDispatchLock, 'function');
  assert.equal(typeof gi.withRestartMutationLock, 'function');

  // Interrupt contract
  assert.equal(typeof gi.requestInterrupt, 'function');

  // Output pipeline contracts
  assert.equal(typeof gi.reconcileOutputSnapshot, 'function');
  assert.equal(typeof gi.selectFinalOutputText, 'function');
  assert.equal(typeof gi.resolveFinalizationOutput, 'function');

  // Session/render lifecycle
  assert.equal(typeof gi.clearRunRenderStateAtRunStart, 'function');
  assert.equal(typeof gi.clearRunRenderStateForAttachedSession, 'function');

  // Routing
  assert.equal(typeof gi.parseCommand, 'function');
  assert.equal(typeof gi.handleConnectCommand, 'function');
});
