'use strict';

const TelegramBot = require('node-telegram-bot-api');
const { createMessageHandler } = require('./gateway-message-handler');
const { createRepoMessageHandler } = require('./gateway-repo-message-handler');
const { createCallbackQueryHandler } = require('./gateway-callback-query-handler');
const { reconcileRunViewForTelegram } = require('./view-reconciler');
const { createTelegramBotEffects } = require('./bot-effects');
const { createTelegramTransport } = require('./transport');

module.exports = {
  TelegramBot,
  createMessageHandler,
  createRepoMessageHandler,
  createCallbackQueryHandler,
  reconcileRunViewForTelegram,
  createTelegramBotEffects,
  createTelegramTransport,
};
