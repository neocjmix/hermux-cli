// @ts-check
'use strict';

// Skeleton: see docs/COMPONENT_CONTRACTS.md § config
// BOUNDARY: config field names MUST be channel/provider-agnostic (BOUNDARY_AUDIT #10)

const path = require('path');

const CONFIG_PATH = path.join(
  process.env.HERMUX_DATA_DIR || path.join(require('os').homedir(), '.hermux'),
  'config.json',
);

/** @returns {HermuxConfig} */
function load() { throw new Error('NOT_IMPLEMENTED: config.load'); }

/** @param {HermuxConfig} config */
function save(config) { throw new Error('NOT_IMPLEMENTED: config.save'); }

/** @param {string} token */
function setGlobalBotToken(token) { throw new Error('NOT_IMPLEMENTED: config.setGlobalBotToken'); }

/** @param {object} repo */
function addOrUpdateRepo(repo) { throw new Error('NOT_IMPLEMENTED: config.addOrUpdateRepo'); }

/** @param {string} repoName @param {string} chatId */
function addChatIdToRepo(repoName, chatId) { throw new Error('NOT_IMPLEMENTED: config.addChatIdToRepo'); }

/** @param {string} repoName @param {string} chatId */
function moveChatIdToRepo(repoName, chatId) { throw new Error('NOT_IMPLEMENTED: config.moveChatIdToRepo'); }

/** @returns {RepoConfig[]} */
function getEnabledRepos() { throw new Error('NOT_IMPLEMENTED: config.getEnabledRepos'); }

/** @param {object} [options] */
function resetConfig(options) { throw new Error('NOT_IMPLEMENTED: config.resetConfig'); }

module.exports = {
  load,
  save,
  setGlobalBotToken,
  addOrUpdateRepo,
  addChatIdToRepo,
  moveChatIdToRepo,
  getEnabledRepos,
  resetConfig,
  CONFIG_PATH,
};
