const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/test-profile');

const { createTelegramBotEffects } = require('../src/providers/downstream/telegram/bot-effects');

test('telegram bot effects sends typing action and reports success', async () => {
  const auditRows = [];
  const calls = [];
  const effects = createTelegramBotEffects({
    audit: (kind, payload) => auditRows.push({ kind, payload }),
    sleep: async () => {},
    getTelegramRetryAfterSeconds: () => 0,
  });
  const bot = {
    sendChatAction: async (chatId, action) => {
      calls.push({ chatId, action });
      return true;
    },
  };

  const ok = await effects.safeSendChatAction(bot, '100', 'typing', { runId: 'r1' });

  assert.equal(ok, true);
  assert.deepEqual(calls, [{ chatId: '100', action: 'typing' }]);
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].kind, 'telegram.chat_action');
  assert.equal(auditRows[0].payload.ok, true);
  assert.equal(auditRows[0].payload.action, 'typing');
});

test('telegram bot effects falls back to _request when sendChatAction helper is missing', async () => {
  const calls = [];
  const effects = createTelegramBotEffects({
    audit: () => {},
    sleep: async () => {},
    getTelegramRetryAfterSeconds: () => 0,
  });
  const bot = {
    _request: async (method, options) => {
      calls.push({ method, options });
      return true;
    },
  };

  const ok = await effects.safeSendChatAction(bot, '100', 'typing', { runId: 'r2' });

  assert.equal(ok, true);
  assert.deepEqual(calls, [{
    method: 'sendChatAction',
    options: {
      form: {
        chat_id: '100',
        action: 'typing',
      },
    },
  }]);
});
