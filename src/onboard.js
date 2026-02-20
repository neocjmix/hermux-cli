#!/usr/bin/env node
'use strict';

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('./lib/config');

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

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('');
  console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('\u2551  opencode_mobile_gateway  onboarding \u2551');
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');
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

  try {
    execSync('which opencode', { stdio: 'ignore' });
    ok('opencode found in PATH');
  } catch {
    console.log('    ! opencode not found in PATH (may still work if installed elsewhere)');
  }

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

  console.log('');
  console.log(`  Saved to ${config.CONFIG_PATH}`);
  console.log('');
  console.log('  Next steps:');
  console.log('    npx hermux start      # start the gateway');
  console.log('    npx hermux onboard    # add another repo/chat mapping');
  console.log('');
  console.log('  Telegram group onboarding (no manual chat ID required):');
  console.log('    1) Create a group for this repo');
  console.log('    2) Invite your bot to the group');
  console.log('    3) In that group, run /repos');
  console.log('    4) In that group, run /connect <repo-name>');
  console.log('    5) Retry your prompt in the same group');
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
