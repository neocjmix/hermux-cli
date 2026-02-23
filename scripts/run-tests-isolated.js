'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const testRoot = path.join(repoRoot, '.tmp', 'test-profile');
const configDir = path.join(testRoot, 'config');
const stateDir = path.join(testRoot, 'state');
const runtimeDir = path.join(testRoot, 'runtime');

function cleanProfileRoot() {
  fs.rmSync(testRoot, { recursive: true, force: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
}

function main() {
  cleanProfileRoot();

  const cmd = process.argv.slice(2).join(' ').trim()
    || 'node --test --test-concurrency=1 test/*.test.js';

  const env = {
    ...process.env,
    OMG_CONFIG_DIR: configDir,
    OMG_CONFIG_PATH: path.join(configDir, 'instances.json'),
    OMG_STATE_DIR: stateDir,
    OMG_SESSION_MAP_PATH: path.join(stateDir, 'session-map.json'),
    OMG_RUNTIME_DIR: runtimeDir,
  };

  const result = spawnSync(cmd, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: true,
  });

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }
  process.exit(1);
}

main();
