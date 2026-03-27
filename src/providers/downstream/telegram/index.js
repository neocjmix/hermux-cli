'use strict';

const TelegramBot = require('node-telegram-bot-api');
const { createMessageHandler } = require('./gateway-message-handler');
const { createRepoMessageHandler, dispatchPreparedPromptRunItem } = require('./gateway-repo-message-handler');
const { createCallbackQueryHandler } = require('./gateway-callback-query-handler');
const { reconcileRunViewForTelegram } = require('./view-reconciler');
const { createTelegramBotEffects } = require('./bot-effects');
const { createTelegramTransport } = require('./transport');
const { splitTelegramHtml } = require('./html-chunker');

module.exports = {
  ...require('./adapter'),
  TelegramBot,
  createMessageHandler,
  createRepoMessageHandler,
  dispatchPreparedPromptRunItem,
  createCallbackQueryHandler,
  reconcileRunViewForTelegram,
  createTelegramBotEffects,
  createTelegramTransport,
  splitTelegramHtml,
};
