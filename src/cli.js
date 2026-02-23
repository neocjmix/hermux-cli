#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const RUNTIME_DIR = path.resolve(process.env.OMG_RUNTIME_DIR || DEFAULT_RUNTIME_DIR);
const PID_PATH = path.join(RUNTIME_DIR, 'gateway.pid');
const LOG_PATH = path.join(RUNTIME_DIR, 'gateway.log');

function hasCommand(cmd) {
  const probe = spawnSync('sh', ['-lc', `command -v ${cmd}`], { stdio: 'ignore' });
  return probe.status === 0;
}

function ensureRuntimeDependencies() {
  if (process.env.OMG_SKIP_DEP_BOOTSTRAP === '1') return;

  if (hasCommand('mmdc')) return;
  if (!hasCommand('npm')) {
    console.log('[warn] npm not found; cannot auto-install Mermaid renderer (mmdc).');
    return;
  }

  console.log('[deps] mmdc not found. Installing @mermaid-js/mermaid-cli...');
  const install = spawnSync('npm', ['install', '-g', '@mermaid-js/mermaid-cli'], { stdio: 'inherit' });
  if (install.status === 0 && hasCommand('mmdc')) {
    console.log('[deps] mmdc installed successfully.');
    return;
  }

  console.log('[warn] Mermaid renderer install failed. Mermaid output will stay text-only.');
}

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function readPid() {
  if (!fs.existsSync(PID_PATH)) return null;
  const raw = String(fs.readFileSync(PID_PATH, 'utf8') || '').trim();
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_err) {
    return false;
  }
}

function writePid(pid) {
  ensureRuntimeDir();
  const tmp = PID_PATH + '.tmp';
  fs.writeFileSync(tmp, String(pid) + '\n', 'utf8');
  fs.renameSync(tmp, PID_PATH);
}

function clearStalePid() {
  const pid = readPid();
  if (!pid) return;
  if (isAlive(pid)) return;
  try {
    fs.unlinkSync(PID_PATH);
  } catch (_err) {
  }
}

function startAsDaemon() {
  clearStalePid();
  const existing = readPid();
  if (existing && isAlive(existing)) {
    console.log(`Gateway daemon already running (pid: ${existing})`);
    console.log(`log: ${LOG_PATH}`);
    return;
  }

  ensureRuntimeDir();
  const outFd = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [__filename, 'start', '--foreground'], {
    detached: true,
    stdio: ['ignore', outFd, outFd],
    env: { ...process.env, OMG_DAEMON_CHILD: '1' },
  });
  child.unref();
  fs.closeSync(outFd);

  writePid(child.pid);
  console.log(`Gateway daemon started (pid: ${child.pid})`);
  console.log(`log: ${LOG_PATH}`);
}

async function main() {
  const cmd = process.argv[2] || 'start';
  const foreground = process.argv.includes('--foreground') || process.env.OMG_DAEMON_CHILD === '1';
  const yes = process.argv.includes('--yes') || process.argv.includes('-y');
  const full = process.argv.includes('--full');

  if (cmd === 'start') {
    if (!foreground) {
      startAsDaemon();
      return;
    }
    ensureRuntimeDependencies();
    const { main: startGateway } = require('./gateway');
    startGateway();
    return;
  }

  if (cmd === 'onboard') {
    const { main: runOnboarding } = require('./onboard');
    await runOnboarding();
    return;
  }

  if (cmd === 'init') {
    if (!yes) {
      console.log('This clears saved repos/chat mappings and sessions.');
      console.log('Run with confirmation: hermux init --yes');
      console.log('Optional: add --full to also clear global telegram bot token.');
      return;
    }

    const { resetConfig } = require('./lib/config');
    const { clearAllSessions } = require('./lib/session-map');
    const cfg = resetConfig({ keepToken: !full });
    const sessionCount = clearAllSessions();
    console.log('Gateway initialization complete.');
    console.log(`cleared repos: ${cfg.clearedRepos}`);
    console.log(`cleared sessions: ${sessionCount}`);
    if (full) {
      console.log('global telegram bot token cleared: yes');
      console.log('Next: npx hermux onboard');
    } else {
      console.log('global telegram bot token cleared: no');
      console.log('Next: npx hermux start');
    }
    return;
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('hermux');
    console.log('');
    console.log('Usage:');
    console.log('  hermux start');
    console.log('  hermux start --foreground');
    console.log('  hermux onboard');
    console.log('  hermux init --yes [--full]');
    console.log('');
    console.log('Examples:');
    console.log('  npx hermux start');
    console.log('  npx hermux start --foreground');
    console.log('  npx hermux onboard');
    console.log('  npx hermux init --yes');
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  console.error('Run: hermux --help');
  process.exit(1);
}

main().catch((err) => {
  console.error('CLI failed:', err.message);
  process.exit(1);
});
