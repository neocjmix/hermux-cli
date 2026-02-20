#!/usr/bin/env node
'use strict';

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const config = require('./lib/config');

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const LOCAL_BIN_DIR = path.join(HOME || '.', '.local', 'bin');
const LOCAL_HERMUX_PATH = path.join(LOCAL_BIN_DIR, 'hermux');

function ask(rl, question, defaultVal) {
  return new Promise(resolve => {
    const suffix = defaultVal ? ` [${defaultVal}]` : '';
    rl.question(`  ${question}${suffix}: `, answer => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

async function askYesNo(rl, question, defaultYes) {
  const defaultLabel = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await ask(rl, `${question} (${defaultLabel})`)).toLowerCase();
  if (!answer) return !!defaultYes;
  return answer === 'y' || answer === 'yes';
}

function ok(label)   { console.log(`    \u2713 ${label}`); }
function fail(label) { console.error(`    \u2717 ${label}`); }

function hasCommand(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch (_err) {
    return false;
  }
}

function preflightCheck() {
  console.log('  Step 0) Local prerequisites');

  if (!hasCommand('git')) {
    fail('git not found in PATH');
    process.exit(1);
  }
  ok('git found in PATH');

  if (!hasCommand('opencode')) {
    fail('opencode not found in PATH');
    process.exit(1);
  }
  ok('opencode found in PATH');
}

function maybeStartRuntime() {
  if (process.env.OMG_ONBOARD_SKIP_START === '1') {
    console.log('    ! runtime auto-start skipped by OMG_ONBOARD_SKIP_START=1');
    return;
  }

  const cliPath = path.join(__dirname, 'cli.js');
  const started = spawnSync(process.execPath, [cliPath, 'start'], { stdio: 'inherit' });
  if (started.status !== 0) {
    fail('runtime start failed during onboarding');
    process.exit(started.status || 1);
  }
}

function buildHermuxLauncherScript() {
  const cliPath = path.join(__dirname, 'cli.js');
  const nodePath = process.execPath;
  return [
    '#!/usr/bin/env bash',
    `exec "${nodePath}" "${cliPath}" "$@"`,
    '',
  ].join('\n');
}

function ensureHermuxCommand() {
  if (!HOME) {
    return { ok: false, reason: 'home_not_found' };
  }

  fs.mkdirSync(LOCAL_BIN_DIR, { recursive: true });
  fs.writeFileSync(LOCAL_HERMUX_PATH, buildHermuxLauncherScript(), { mode: 0o755 });
  fs.chmodSync(LOCAL_HERMUX_PATH, 0o755);

  const pathList = String(process.env.PATH || '').split(path.delimiter);
  const inPath = pathList.includes(LOCAL_BIN_DIR);
  return { ok: true, path: LOCAL_HERMUX_PATH, binDir: LOCAL_BIN_DIR, inPath };
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('');
  console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('\u2551  opencode_mobile_gateway  onboarding \u2551');
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');
  console.log('');

  preflightCheck();
  console.log('');
  console.log('  Step 1) Telegram bot prerequisite');
  console.log('    - Create a bot with @BotFather (Telegram)');
  console.log('    - Copy the bot token (format: 123456789:ABC-DEF...)');
  console.log('');

  const existing = config.load();
  const existingToken = String((existing.global || {}).telegramBotToken || '').trim();
  let botToken = existingToken;

  if (!existingToken) {
    botToken = await ask(rl, 'Global Telegram bot token');
  } else {
    const replaceToken = await askYesNo(rl, 'Global Telegram bot token already exists. Replace it?', false);
    if (replaceToken) {
      botToken = await ask(rl, 'New global Telegram bot token');
    }
  }

  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
    fail('bot token: expected format 123456789:ABC-DEF...');
    process.exit(1);
  }
  ok('global bot token format');

  const name = await ask(rl, 'Repo name (e.g. my-project)');
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    fail('name: alphanumeric, dash, underscore only');
    process.exit(1);
  }
  ok('repo name');

  const chatIdsRaw = await ask(rl, 'Allowed Telegram chat IDs (comma-separated, optional)', '');
  const chatIds = chatIdsRaw.split(',').map(s => s.trim()).filter(Boolean);
  const uniqueChatIds = [...new Set(chatIds)];
  if (uniqueChatIds.length > 0 && !uniqueChatIds.every(id => /^-?\d+$/.test(id))) {
    fail('chat ids: all values must be numeric');
    process.exit(1);
  }
  if (uniqueChatIds.length > 0) {
    ok(`chat ids (${uniqueChatIds.length})`);
  } else {
    console.log('    ! no initial chat IDs provided (you can connect chats later via /connect <repo>)');
  }

  const workdir = await ask(rl, 'Repo workdir (absolute path)');
  if (!path.isAbsolute(workdir)) {
    fail('workdir: must be absolute path');
    process.exit(1);
  }
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    fail('workdir: directory does not exist');
    process.exit(1);
  }
  ok('workdir exists');

  const opencodeCmd = await ask(rl, 'opencode command', 'opencode run');

  const repo = {
    name,
    enabled: true,
    workdir,
    chatIds: uniqueChatIds,
    opencodeCommand: opencodeCmd,
    logFile: `./logs/${name}.log`,
  };

  config.setGlobalBotToken(botToken);
  config.addOrUpdateRepo(repo);
  ok('configuration saved');

  const launcher = ensureHermuxCommand();
  if (launcher.ok) {
    ok(`local hermux command ready: ${launcher.path}`);
    if (!launcher.inPath) {
      console.log(`    ! add ${launcher.binDir} to PATH to run 'hermux' directly`);
    }
  } else {
    console.log('    ! could not prepare local hermux command launcher');
  }

  console.log('');
  console.log('  Step 4) Start runtime daemon');
  maybeStartRuntime();

  console.log('');
  console.log(`  Saved to ${config.CONFIG_PATH}`);
  console.log('');
  console.log('  Step 5) Telegram connection check (required)');
  console.log('    1) Open target Telegram chat/group where the bot is present');
  console.log('    2) Run /repos');
  console.log(`    3) Run /connect ${name}`);
  console.log('    4) Run /whereami');
  console.log('    5) Send a test prompt');
  console.log('');
  console.log('  Onboarding complete.');
  console.log('    - Re-run npx hermux onboard to add or update a repo');
  console.log('');

  rl.close();
}

if (require.main === module) {
  main().catch(err => {
    console.error('Onboarding failed:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
