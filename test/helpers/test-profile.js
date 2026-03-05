'use strict';

const fs = require('fs');
const path = require('path');

const testProfileRoot = path.resolve(
  process.env.HERMUX_TEST_PROFILE_ROOT
    || path.join(__dirname, '..', '..', '.tmp', 'test-profile', `p-${process.pid}`)
);

const configDir = path.join(testProfileRoot, 'config');
const stateDir = path.join(testProfileRoot, 'state');
const runtimeDir = path.join(testProfileRoot, 'runtime');

function setDefaultEnv(name, value) {
  if (String(process.env[name] || '').trim()) return;
  process.env[name] = value;
}

setDefaultEnv('HERMUX_TEST_PROFILE', '1');
setDefaultEnv('HERMUX_TEST_PROFILE_ROOT', testProfileRoot);
setDefaultEnv('HERMUX_CONFIG_DIR', configDir);
setDefaultEnv('HERMUX_CONFIG_PATH', path.join(configDir, 'instances.json'));
setDefaultEnv('HERMUX_STATE_DIR', stateDir);
setDefaultEnv('HERMUX_SESSION_MAP_PATH', path.join(stateDir, 'session-map.json'));
setDefaultEnv('HERMUX_RUNTIME_DIR', runtimeDir);

fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(runtimeDir, { recursive: true });
