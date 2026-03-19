'use strict';

function createTelegramBotEffects(deps) {
  const {
    audit,
    sleep,
    getTelegramRetryAfterSeconds,
  } = deps || {};

  async function safeSendChatAction(bot, chatId, action, auditMeta) {
    const normalizedAction = String(action || '').trim();
    if (!normalizedAction) return false;
    const invokeChatAction = async () => {
      if (bot && typeof bot.sendChatAction === 'function') {
        return bot.sendChatAction(chatId, normalizedAction);
      }
      if (bot && typeof bot._request === 'function') {
        return bot._request('sendChatAction', {
          form: {
            chat_id: String(chatId),
            action: normalizedAction,
          },
        });
      }
      throw new Error('sendChatAction_unavailable');
    };
    try {
      await invokeChatAction();
      if (typeof audit === 'function') {
        audit('telegram.chat_action', {
          ok: true,
          chatId: String(chatId),
          action: normalizedAction,
          meta: auditMeta || null,
        });
      }
      return true;
    } catch (err) {
      let primaryErr = err;
      const retryAfterSeconds = typeof getTelegramRetryAfterSeconds === 'function'
        ? getTelegramRetryAfterSeconds(primaryErr)
        : 0;
      if (retryAfterSeconds > 0 && typeof sleep === 'function') {
        const waitMs = (retryAfterSeconds * 1000) + Math.floor(Math.random() * 250);
        if (typeof audit === 'function') {
          audit('telegram.chat_action', {
            ok: false,
            stage: 'retry_after_pending',
            chatId: String(chatId),
            action: normalizedAction,
            error: String(primaryErr && (primaryErr.code || primaryErr.message || primaryErr) || ''),
            retryAfterSeconds,
            waitMs,
            meta: auditMeta || null,
          });
        }
        await sleep(waitMs);
        try {
          await invokeChatAction();
          if (typeof audit === 'function') {
            audit('telegram.chat_action', {
              ok: true,
              stage: 'retry_after',
              chatId: String(chatId),
              action: normalizedAction,
              meta: auditMeta || null,
            });
          }
          return true;
        } catch (retryErr) {
          primaryErr = retryErr;
        }
      }
      if (typeof audit === 'function') {
        audit('telegram.chat_action', {
          ok: false,
          stage: 'primary',
          chatId: String(chatId),
          action: normalizedAction,
          error: String(primaryErr && (primaryErr.code || primaryErr.message || primaryErr) || ''),
          meta: auditMeta || null,
        });
      }
    }
    return false;
  }

  return {
    safeSendChatAction,
  };
}

module.exports = {
  createTelegramBotEffects,
};
