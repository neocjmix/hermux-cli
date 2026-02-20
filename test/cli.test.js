const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const cliPath = path.resolve(__dirname, '..', 'src', 'cli.js');

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
