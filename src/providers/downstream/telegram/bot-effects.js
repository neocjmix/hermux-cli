'use strict';

// Skeleton: downstream telegram bot effects

function createTelegramBotEffects(deps) {
  return {
    async safeSendChatAction(bot, chatId, action, auditMeta) {
      throw new Error('NOT_IMPLEMENTED: safeSendChatAction');
    },
  };
}

module.exports = {
  createTelegramBotEffects,
};
